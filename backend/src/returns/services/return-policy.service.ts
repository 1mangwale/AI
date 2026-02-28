/**
 * Return Policy Service
 *
 * Manages return policies that define:
 * - Return window (hours after delivery)
 * - Auto-approve threshold (amount below which returns are auto-approved)
 * - Evidence requirements (photos, etc.)
 * - Max refund cap
 *
 * Policies are looked up by module + category, with category-specific
 * policies taking priority over module-level defaults.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ReturnPolicy } from '../interfaces/return.interfaces';

@Injectable()
export class ReturnPolicyService implements OnModuleInit {
  private readonly logger = new Logger(ReturnPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS return_policies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          module_id INT NOT NULL,
          category_id INT,
          return_window_hours INT NOT NULL DEFAULT 48,
          auto_approve_threshold DECIMAL(10,2) NOT NULL DEFAULT 100,
          evidence_required BOOLEAN DEFAULT false,
          max_refund_amount DECIMAL(12,2),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_return_policies_lookup
          ON return_policies(module_id, is_active)
      `;

      // Seed default policies if none exist
      await this.seedDefaultPolicies();

      this.logger.log('ReturnPolicyService tables initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize return policy tables: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Seed default return policies for each module if no policies exist.
   */
  private async seedDefaultPolicies(): Promise<void> {
    try {
      const existing = await this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::INT AS count FROM return_policies
      `;

      if (existing[0]?.count > 0) return;

      // Food (moduleId=4): 2-hour window, auto-approve under Rs 200, no evidence needed
      await this.prisma.$executeRaw`
        INSERT INTO return_policies (module_id, return_window_hours, auto_approve_threshold, evidence_required)
        VALUES (4, 2, 200, false)
      `;

      // E-commerce (moduleId=5): 7-day window, auto-approve under Rs 500, evidence required
      await this.prisma.$executeRaw`
        INSERT INTO return_policies (module_id, return_window_hours, auto_approve_threshold, evidence_required)
        VALUES (5, 168, 500, true)
      `;

      // Parcel (moduleId=3): 24-hour window, auto-approve under Rs 100, evidence required
      await this.prisma.$executeRaw`
        INSERT INTO return_policies (module_id, return_window_hours, auto_approve_threshold, evidence_required)
        VALUES (3, 24, 100, true)
      `;

      this.logger.log('Default return policies seeded');
    } catch (error) {
      this.logger.error(
        `Failed to seed default policies: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Get the applicable return policy for a module and optional category.
   *
   * Priority:
   *   1. Category-specific policy (module_id + category_id match)
   *   2. Module-level default (module_id match, category_id IS NULL)
   */
  async getApplicablePolicy(
    moduleId: number,
    categoryId?: number,
  ): Promise<ReturnPolicy | null> {
    try {
      const policies = await this.prisma.$queryRaw<ReturnPolicy[]>`
        SELECT
          id, module_id AS "moduleId", category_id AS "categoryId",
          return_window_hours AS "returnWindowHours",
          auto_approve_threshold AS "autoApproveThreshold",
          evidence_required AS "evidenceRequired",
          max_refund_amount AS "maxRefundAmount",
          is_active AS "isActive",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM return_policies
        WHERE module_id = ${moduleId}
          AND is_active = true
          AND (category_id IS NULL OR category_id = ${categoryId ?? null})
        ORDER BY
          CASE WHEN category_id IS NOT NULL THEN 0 ELSE 1 END ASC
        LIMIT 1
      `;

      return policies.length > 0 ? policies[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to get applicable policy for module=${moduleId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Check if an order is eligible for return based on the time window.
   *
   * @param orderDeliveredAt - When the order was delivered
   * @param policy - The applicable return policy
   * @returns true if within return window
   */
  isReturnEligible(orderDeliveredAt: Date, policy: ReturnPolicy): boolean {
    try {
      const now = new Date();
      const windowMs = policy.returnWindowHours * 60 * 60 * 1000;
      const deadline = new Date(orderDeliveredAt.getTime() + windowMs);

      const eligible = now <= deadline;

      if (!eligible) {
        this.logger.debug(
          `Return not eligible: delivered=${orderDeliveredAt.toISOString()}, ` +
            `window=${policy.returnWindowHours}h, deadline=${deadline.toISOString()}`,
        );
      }

      return eligible;
    } catch (error) {
      this.logger.error(
        `Failed to check return eligibility: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Check if a return request should be auto-approved based on amount.
   */
  shouldAutoApprove(amount: number, policy: ReturnPolicy): boolean {
    try {
      const threshold = Number(policy.autoApproveThreshold);

      // If max refund is set, check against it
      if (policy.maxRefundAmount && amount > Number(policy.maxRefundAmount)) {
        return false;
      }

      return amount <= threshold;
    } catch (error) {
      this.logger.error(
        `Failed to check auto-approve: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * List return policies with optional module filter.
   */
  async getPolicies(moduleId?: number): Promise<ReturnPolicy[]> {
    try {
      if (moduleId) {
        return await this.prisma.$queryRaw<ReturnPolicy[]>`
          SELECT
            id, module_id AS "moduleId", category_id AS "categoryId",
            return_window_hours AS "returnWindowHours",
            auto_approve_threshold AS "autoApproveThreshold",
            evidence_required AS "evidenceRequired",
            max_refund_amount AS "maxRefundAmount",
            is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM return_policies
          WHERE module_id = ${moduleId}
          ORDER BY created_at DESC
        `;
      }

      return await this.prisma.$queryRaw<ReturnPolicy[]>`
        SELECT
          id, module_id AS "moduleId", category_id AS "categoryId",
          return_window_hours AS "returnWindowHours",
          auto_approve_threshold AS "autoApproveThreshold",
          evidence_required AS "evidenceRequired",
          max_refund_amount AS "maxRefundAmount",
          is_active AS "isActive",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM return_policies
        ORDER BY module_id, created_at DESC
      `;
    } catch (error) {
      this.logger.error(
        `Failed to get policies: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }

  /**
   * Create a new return policy.
   */
  async createPolicy(data: {
    moduleId: number;
    categoryId?: number;
    returnWindowHours: number;
    autoApproveThreshold: number;
    evidenceRequired?: boolean;
    maxRefundAmount?: number;
  }): Promise<ReturnPolicy> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnPolicy[]>`
        INSERT INTO return_policies (
          module_id, category_id, return_window_hours,
          auto_approve_threshold, evidence_required, max_refund_amount
        ) VALUES (
          ${data.moduleId}, ${data.categoryId ?? null},
          ${data.returnWindowHours}, ${data.autoApproveThreshold},
          ${data.evidenceRequired ?? false}, ${data.maxRefundAmount ?? null}
        )
        RETURNING
          id, module_id AS "moduleId", category_id AS "categoryId",
          return_window_hours AS "returnWindowHours",
          auto_approve_threshold AS "autoApproveThreshold",
          evidence_required AS "evidenceRequired",
          max_refund_amount AS "maxRefundAmount",
          is_active AS "isActive",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      this.logger.log(
        `Return policy created: ${rows[0]?.id} for module=${data.moduleId}`,
      );
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to create return policy: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Update an existing return policy.
   */
  async updatePolicy(
    policyId: string,
    data: {
      returnWindowHours?: number;
      autoApproveThreshold?: number;
      evidenceRequired?: boolean;
      maxRefundAmount?: number;
      isActive?: boolean;
    },
  ): Promise<ReturnPolicy | null> {
    try {
      const rows = await this.prisma.$queryRaw<ReturnPolicy[]>`
        UPDATE return_policies
        SET
          return_window_hours = COALESCE(${data.returnWindowHours ?? null}, return_window_hours),
          auto_approve_threshold = COALESCE(${data.autoApproveThreshold ?? null}, auto_approve_threshold),
          evidence_required = COALESCE(${data.evidenceRequired ?? null}, evidence_required),
          max_refund_amount = COALESCE(${data.maxRefundAmount ?? null}, max_refund_amount),
          is_active = COALESCE(${data.isActive ?? null}, is_active),
          updated_at = NOW()
        WHERE id = ${policyId}::uuid
        RETURNING
          id, module_id AS "moduleId", category_id AS "categoryId",
          return_window_hours AS "returnWindowHours",
          auto_approve_threshold AS "autoApproveThreshold",
          evidence_required AS "evidenceRequired",
          max_refund_amount AS "maxRefundAmount",
          is_active AS "isActive",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(`Return policy ${policyId} not found`);
        return null;
      }

      this.logger.log(`Return policy updated: ${policyId}`);
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to update return policy ${policyId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
