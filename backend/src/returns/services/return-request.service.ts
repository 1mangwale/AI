/**
 * Return Request Service
 *
 * Handles the full lifecycle of return requests:
 *
 * 1. Customer submits return request
 * 2. Check eligibility (time window, policy)
 * 3. Auto-approve if below threshold, else mark as pending
 * 4. Admin reviews (approve/reject)
 * 5. On approval, initiate refund
 * 6. Refund processor completes the refund
 *
 * Status flow:
 *   pending -> under_review -> approved -> refund_initiated -> refund_completed
 *                           -> rejected
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ReturnPolicyService } from './return-policy.service';
import {
  ReturnRequest,
  CreateReturnRequestInput,
  ReturnRequestFilters,
  ReturnStats,
} from '../interfaces/return.interfaces';

@Injectable()
export class ReturnRequestService implements OnModuleInit {
  private readonly logger = new Logger(ReturnRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly returnPolicyService: ReturnPolicyService,
    @InjectQueue('refund-processing') private readonly refundQueue: Queue,
  ) {}

  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS return_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id BIGINT NOT NULL,
          user_id VARCHAR(255),
          reason TEXT NOT NULL,
          status VARCHAR(30) DEFAULT 'pending',
          refund_amount DECIMAL(12,2),
          refund_method VARCHAR(20) DEFAULT 'original',
          evidence_urls JSONB DEFAULT '[]',
          admin_notes TEXT,
          reviewed_by VARCHAR(255),
          reviewed_at TIMESTAMP,
          refund_reference VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_return_requests_order ON return_requests(order_id)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_return_requests_user ON return_requests(user_id)
      `;

      this.logger.log('ReturnRequestService tables initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize return request tables: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Create a new return request.
   *
   * Steps:
   * 1. Check for duplicate request on same order
   * 2. Look up applicable return policy
   * 3. Check time-window eligibility (requires order delivery time)
   * 4. If amount is below auto-approve threshold, auto-approve and queue refund
   * 5. Otherwise create as pending for admin review
   */
  async createReturnRequest(
    input: CreateReturnRequestInput,
    moduleId = 4,
    orderDeliveredAt?: Date,
  ): Promise<{
    request: ReturnRequest;
    autoApproved: boolean;
    message: string;
  }> {
    try {
      // Check for existing non-rejected request on same order
      const existing = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM return_requests
        WHERE order_id = ${input.orderId}
          AND status NOT IN ('rejected', 'refund_completed')
        LIMIT 1
      `;

      if (existing.length > 0) {
        this.logger.warn(
          `Duplicate return request for order #${input.orderId}: ${existing[0].id}`,
        );
        const existingRequest = await this.getReturnRequestById(existing[0].id);
        return {
          request: existingRequest!,
          autoApproved: false,
          message: 'A return request already exists for this order',
        };
      }

      // Look up applicable policy
      const policy =
        await this.returnPolicyService.getApplicablePolicy(moduleId);

      // Check time window eligibility if delivery date is provided
      if (policy && orderDeliveredAt) {
        const eligible = this.returnPolicyService.isReturnEligible(
          orderDeliveredAt,
          policy,
        );
        if (!eligible) {
          // Create the request but mark it as rejected immediately
          const request = await this.insertReturnRequest({
            ...input,
            status: 'rejected',
            adminNotes: `Return window expired. Policy allows ${policy.returnWindowHours} hours after delivery.`,
          });
          return {
            request,
            autoApproved: false,
            message: `Return window of ${policy.returnWindowHours} hours has expired`,
          };
        }
      }

      // Check evidence requirement
      if (
        policy?.evidenceRequired &&
        (!input.evidenceUrls || input.evidenceUrls.length === 0)
      ) {
        this.logger.debug(
          `Evidence required but not provided for order #${input.orderId}`,
        );
        // Still allow creation but log the warning; admin can follow up
      }

      // Determine if auto-approve applies
      const refundAmount = input.refundAmount ?? 0;
      const shouldAutoApprove =
        policy && refundAmount > 0
          ? this.returnPolicyService.shouldAutoApprove(refundAmount, policy)
          : false;

      const status = shouldAutoApprove ? 'approved' : 'pending';

      const request = await this.insertReturnRequest({
        ...input,
        status,
        adminNotes: shouldAutoApprove
          ? `Auto-approved: amount ${refundAmount} below threshold ${policy?.autoApproveThreshold}`
          : undefined,
      });

      // If auto-approved, queue the refund immediately
      if (shouldAutoApprove && request) {
        await this.queueRefund(request.id);
        this.logger.log(
          `Return request ${request.id} auto-approved for order #${input.orderId}`,
        );
        return {
          request: { ...request, status: 'refund_initiated' },
          autoApproved: true,
          message: 'Return auto-approved. Refund will be processed shortly.',
        };
      }

      this.logger.log(
        `Return request created: ${request.id} for order #${input.orderId}, status=${status}`,
      );

      return {
        request,
        autoApproved: false,
        message:
          status === 'pending'
            ? 'Return request submitted. It will be reviewed by our team.'
            : 'Return request created.',
      };
    } catch (error) {
      this.logger.error(
        `Failed to create return request for order #${input.orderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Admin reviews a return request (approve or reject).
   */
  async reviewRequest(
    requestId: string,
    action: 'approve' | 'reject',
    adminId: string,
    notes?: string,
  ): Promise<ReturnRequest | null> {
    try {
      const newStatus = action === 'approve' ? 'approved' : 'rejected';

      const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
        UPDATE return_requests
        SET
          status = ${newStatus},
          reviewed_by = ${adminId},
          reviewed_at = NOW(),
          admin_notes = COALESCE(${notes ?? null}, admin_notes),
          updated_at = NOW()
        WHERE id = ${requestId}::uuid
          AND status IN ('pending', 'under_review')
        RETURNING
          id, order_id AS "orderId", user_id AS "userId",
          reason, status, refund_amount AS "refundAmount",
          refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
          admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
          reviewed_at AS "reviewedAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(
          `Return request ${requestId} not found or not in reviewable status`,
        );
        return null;
      }

      const request = rows[0];
      this.logger.log(
        `Return request ${requestId} ${action}d by admin ${adminId}`,
      );

      // If approved, queue refund processing
      if (action === 'approve') {
        await this.queueRefund(requestId);
      }

      return request;
    } catch (error) {
      this.logger.error(
        `Failed to review return request ${requestId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get paginated return requests with filters.
   */
  async getReturnRequests(
    filters: ReturnRequestFilters,
    page = 1,
    limit = 20,
  ): Promise<{ data: ReturnRequest[]; total: number }> {
    try {
      const offset = (page - 1) * limit;

      let data: ReturnRequest[];
      let countResult: { count: number }[];

      if (filters.orderId) {
        data = await this.prisma.$queryRaw<ReturnRequest[]>`
          SELECT
            id, order_id AS "orderId", user_id AS "userId",
            reason, status, refund_amount AS "refundAmount",
            refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
            admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
            reviewed_at AS "reviewedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_requests
          WHERE order_id = ${filters.orderId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM return_requests
          WHERE order_id = ${filters.orderId}
        `;
      } else if (filters.status && filters.userId) {
        data = await this.prisma.$queryRaw<ReturnRequest[]>`
          SELECT
            id, order_id AS "orderId", user_id AS "userId",
            reason, status, refund_amount AS "refundAmount",
            refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
            admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
            reviewed_at AS "reviewedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_requests
          WHERE status = ${filters.status} AND user_id = ${filters.userId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM return_requests
          WHERE status = ${filters.status} AND user_id = ${filters.userId}
        `;
      } else if (filters.status) {
        data = await this.prisma.$queryRaw<ReturnRequest[]>`
          SELECT
            id, order_id AS "orderId", user_id AS "userId",
            reason, status, refund_amount AS "refundAmount",
            refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
            admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
            reviewed_at AS "reviewedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_requests
          WHERE status = ${filters.status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM return_requests
          WHERE status = ${filters.status}
        `;
      } else if (filters.userId) {
        data = await this.prisma.$queryRaw<ReturnRequest[]>`
          SELECT
            id, order_id AS "orderId", user_id AS "userId",
            reason, status, refund_amount AS "refundAmount",
            refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
            admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
            reviewed_at AS "reviewedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_requests
          WHERE user_id = ${filters.userId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM return_requests
          WHERE user_id = ${filters.userId}
        `;
      } else {
        data = await this.prisma.$queryRaw<ReturnRequest[]>`
          SELECT
            id, order_id AS "orderId", user_id AS "userId",
            reason, status, refund_amount AS "refundAmount",
            refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
            admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
            reviewed_at AS "reviewedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_requests
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM return_requests
        `;
      }

      return {
        data,
        total: countResult[0]?.count ?? 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get return requests: ${error.message}`,
        error.stack,
      );
      return { data: [], total: 0 };
    }
  }

  /**
   * Get a single return request by ID.
   */
  async getReturnRequestById(requestId: string): Promise<ReturnRequest | null> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
        SELECT
          id, order_id AS "orderId", user_id AS "userId",
          reason, status, refund_amount AS "refundAmount",
          refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
          admin_notes AS "adminNotes", reviewed_by AS "reviewedBy",
          reviewed_at AS "reviewedAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM return_requests
        WHERE id = ${requestId}::uuid
      `;
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to get return request ${requestId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Update return request status to 'refund_initiated'.
   */
  async initiateRefund(requestId: string): Promise<ReturnRequest | null> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
        UPDATE return_requests
        SET status = 'refund_initiated', updated_at = NOW()
        WHERE id = ${requestId}::uuid AND status = 'approved'
        RETURNING
          id, order_id AS "orderId", user_id AS "userId",
          reason, status, refund_amount AS "refundAmount",
          refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
          admin_notes AS "adminNotes",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(
          `Return request ${requestId} not found or not in approved status`,
        );
        return null;
      }

      // Queue the refund processing job
      await this.queueRefund(requestId);

      this.logger.log(`Refund initiated for return request ${requestId}`);
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to initiate refund for ${requestId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Mark a return request as refund completed.
   */
  async completeRefund(
    requestId: string,
    reference: string,
  ): Promise<ReturnRequest | null> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
        UPDATE return_requests
        SET
          status = 'refund_completed',
          refund_reference = ${reference},
          updated_at = NOW()
        WHERE id = ${requestId}::uuid AND status = 'refund_initiated'
        RETURNING
          id, order_id AS "orderId", user_id AS "userId",
          reason, status, refund_amount AS "refundAmount",
          refund_method AS "refundMethod",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(
          `Return request ${requestId} not found or not in refund_initiated status`,
        );
        return null;
      }

      this.logger.log(
        `Refund completed for return request ${requestId}, ref=${reference}`,
      );
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to complete refund for ${requestId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Get return request statistics.
   */
  async getReturnStats(): Promise<ReturnStats> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnStats[]>`
        SELECT
          COUNT(*)::INT AS "totalRequests",
          COUNT(*) FILTER (WHERE status = 'pending')::INT AS "pendingCount",
          COUNT(*) FILTER (WHERE status = 'approved')::INT AS "approvedCount",
          COUNT(*) FILTER (WHERE status = 'rejected')::INT AS "rejectedCount",
          COUNT(*) FILTER (WHERE status = 'refund_initiated')::INT AS "refundInitiatedCount",
          COUNT(*) FILTER (WHERE status = 'refund_completed')::INT AS "refundCompletedCount",
          COALESCE(SUM(refund_amount) FILTER (WHERE status = 'refund_completed'), 0)::DECIMAL AS "totalRefundAmount"
        FROM return_requests
      `;

      return (
        rows[0] ?? {
          totalRequests: 0,
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          refundInitiatedCount: 0,
          refundCompletedCount: 0,
          totalRefundAmount: 0,
        }
      );
    } catch (error) {
      this.logger.error(
        `Failed to get return stats: ${error.message}`,
        error.stack,
      );
      return {
        totalRequests: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        refundInitiatedCount: 0,
        refundCompletedCount: 0,
        totalRefundAmount: 0,
      };
    }
  }

  /**
   * Insert a return request record into the database.
   */
  private async insertReturnRequest(
    input: CreateReturnRequestInput & {
      status?: string;
      adminNotes?: string;
    },
  ): Promise<ReturnRequest> {
    const evidenceJson = JSON.stringify(input.evidenceUrls ?? []);

    const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
      INSERT INTO return_requests (
        order_id, user_id, reason, status,
        refund_amount, refund_method, evidence_urls, admin_notes
      ) VALUES (
        ${input.orderId}, ${input.userId ?? null}, ${input.reason},
        ${input.status ?? 'pending'}, ${input.refundAmount ?? null},
        ${input.refundMethod ?? 'original'}, ${evidenceJson}::jsonb,
        ${input.adminNotes ?? null}
      )
      RETURNING
        id, order_id AS "orderId", user_id AS "userId",
        reason, status, refund_amount AS "refundAmount",
        refund_method AS "refundMethod", evidence_urls AS "evidenceUrls",
        admin_notes AS "adminNotes",
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;

    return rows[0];
  }

  /**
   * Queue a refund processing job.
   */
  private async queueRefund(returnRequestId: string): Promise<void> {
    try {
      await this.refundQueue.add(
        'process-refund',
        { returnRequestId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
      this.logger.debug(
        `Refund job queued for return request ${returnRequestId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to queue refund for ${returnRequestId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
