/**
 * Refund Processor Service
 *
 * Handles the actual refund execution for approved return requests.
 *
 * Two refund methods:
 * 1. Original payment: Call PHP backend Razorpay refund API
 * 2. Wallet credit: Call PHP backend wallet credit API
 *
 * On successful refund, optionally voids the associated commission
 * via FinanceModule's CommissionService.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { CommissionService } from '../../finance/services/commission.service';
import { ReturnRequest } from '../interfaces/return.interfaces';

@Injectable()
export class RefundProcessorService {
  private readonly logger = new Logger(RefundProcessorService.name);
  private readonly phpBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly commissionService: CommissionService,
  ) {
    this.phpBaseUrl = this.configService.get<string>(
      'PHP_BASE_URL',
      'https://new.mangwale.com',
    );
  }

  /**
   * Process a refund for a return request.
   *
   * Steps:
   * 1. Load the return request
   * 2. Determine refund method (original or wallet)
   * 3. Execute refund via PHP backend
   * 4. Update return request status
   * 5. Void the associated commission
   */
  async processRefund(returnRequestId: string): Promise<{
    success: boolean;
    reference?: string;
    error?: string;
  }> {
    try {
      // Load the return request
      const rows = await this.prisma.$queryRaw<ReturnRequest[]>`
        SELECT
          id, order_id AS "orderId", user_id AS "userId",
          reason, status, refund_amount AS "refundAmount",
          refund_method AS "refundMethod"
        FROM return_requests
        WHERE id = ${returnRequestId}::uuid
      `;

      if (rows.length === 0) {
        this.logger.error(`Return request ${returnRequestId} not found`);
        return { success: false, error: 'Return request not found' };
      }

      const request = rows[0];

      if (
        request.status !== 'approved' &&
        request.status !== 'refund_initiated'
      ) {
        this.logger.warn(
          `Return request ${returnRequestId} is in status ${request.status}, cannot process refund`,
        );
        return {
          success: false,
          error: `Invalid status: ${request.status}`,
        };
      }

      const refundAmount = Number(request.refundAmount ?? 0);
      if (refundAmount <= 0) {
        this.logger.error(
          `Return request ${returnRequestId} has no refund amount`,
        );
        return { success: false, error: 'No refund amount specified' };
      }

      // Mark as refund_initiated
      await this.prisma.$executeRaw`
        UPDATE return_requests
        SET status = 'refund_initiated', updated_at = NOW()
        WHERE id = ${returnRequestId}::uuid
      `;

      // Process based on refund method
      let result: { success: boolean; reference?: string; error?: string };

      if (request.refundMethod === 'wallet') {
        result = await this.creditToWallet(
          request.userId ?? '',
          refundAmount,
          `Refund for order #${request.orderId}: ${request.reason}`,
        );
      } else {
        result = await this.refundToOriginalPayment(
          Number(request.orderId),
          refundAmount,
        );
      }

      if (result.success) {
        // Mark as refund_completed
        await this.prisma.$executeRaw`
          UPDATE return_requests
          SET
            status = 'refund_completed',
            refund_reference = ${result.reference ?? null},
            updated_at = NOW()
          WHERE id = ${returnRequestId}::uuid
        `;

        // Void the associated commission
        try {
          await this.commissionService.voidCommission(
            Number(request.orderId),
            `Refund processed: ${request.reason}`,
          );
        } catch (voidError) {
          this.logger.warn(
            `Failed to void commission for order #${request.orderId}: ${voidError.message}. ` +
              `Refund was still processed successfully.`,
          );
        }

        this.logger.log(
          `Refund completed for return request ${returnRequestId}: ` +
            `amount=${refundAmount}, method=${request.refundMethod}, ref=${result.reference}`,
        );
      } else {
        this.logger.error(
          `Refund failed for return request ${returnRequestId}: ${result.error}`,
        );

        // Revert status to approved so it can be retried
        await this.prisma.$executeRaw`
          UPDATE return_requests
          SET
            status = 'approved',
            admin_notes = CONCAT(COALESCE(admin_notes, ''), E'\nRefund failed: ' || ${result.error ?? 'Unknown error'}),
            updated_at = NOW()
          WHERE id = ${returnRequestId}::uuid
        `;
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to process refund for ${returnRequestId}: ${error.message}`,
        error.stack,
      );

      // Revert status
      try {
        await this.prisma.$executeRaw`
          UPDATE return_requests
          SET status = 'approved', updated_at = NOW()
          WHERE id = ${returnRequestId}::uuid AND status = 'refund_initiated'
        `;
      } catch (_) {
        // Ignore revert error
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Refund to the original payment method via PHP backend Razorpay refund API.
   */
  async refundToOriginalPayment(
    orderId: number,
    amount: number,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    try {
      const url = `${this.phpBaseUrl}/api/v1/customer/order/refund`;

      this.logger.debug(
        `Calling PHP refund API: POST ${url}, orderId=${orderId}, amount=${amount}`,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            order_id: orderId,
            amount,
            reason: 'Customer return request',
          },
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        ),
      );

      const data = response.data;

      if (data?.success || data?.status === 'success') {
        const reference =
          data?.refund_id || data?.data?.refund_id || `REFUND_${orderId}_${Date.now()}`;
        this.logger.log(
          `PHP refund success for order #${orderId}: ref=${reference}`,
        );
        return { success: true, reference };
      }

      const errorMsg = data?.message || data?.error || 'PHP refund API returned failure';
      this.logger.error(
        `PHP refund failed for order #${orderId}: ${errorMsg}`,
      );
      return { success: false, error: errorMsg };
    } catch (error) {
      const status = error?.response?.status;
      const errorData = error?.response?.data;

      this.logger.error(
        `PHP refund API error for order #${orderId}: ` +
          `status=${status}, error=${JSON.stringify(errorData) || error.message}`,
      );

      return {
        success: false,
        error: `PHP API error: ${errorData?.message || error.message}`,
      };
    }
  }

  /**
   * Credit refund amount to user's wallet via PHP backend.
   */
  async creditToWallet(
    userId: string,
    amount: number,
    reason: string,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    try {
      if (!userId) {
        return { success: false, error: 'No userId provided for wallet credit' };
      }

      const url = `${this.phpBaseUrl}/api/v1/customer/wallet/credit`;

      this.logger.debug(
        `Calling PHP wallet credit: POST ${url}, userId=${userId}, amount=${amount}`,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            user_id: userId,
            amount,
            reason,
            type: 'refund',
          },
          {
            timeout: 15000,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        ),
      );

      const data = response.data;

      if (data?.success || data?.status === 'success') {
        const reference =
          data?.transaction_id ||
          data?.data?.transaction_id ||
          `WALLET_${userId}_${Date.now()}`;
        this.logger.log(
          `Wallet credit success for user ${userId}: amount=${amount}, ref=${reference}`,
        );
        return { success: true, reference };
      }

      const errorMsg = data?.message || 'Wallet credit failed';
      this.logger.error(
        `Wallet credit failed for user ${userId}: ${errorMsg}`,
      );
      return { success: false, error: errorMsg };
    } catch (error) {
      this.logger.error(
        `Wallet credit error for user ${userId}: ${error.message}`,
      );
      return {
        success: false,
        error: `Wallet API error: ${error.message}`,
      };
    }
  }

  /**
   * Get the current refund status for a return request.
   */
  async getRefundStatus(
    returnRequestId: string,
  ): Promise<{
    status: string;
    refundAmount?: number;
    refundMethod?: string;
    reference?: string;
  } | null> {
    try {
      const rows = await this.prisma.$queryRaw<
        {
          status: string;
          refundAmount: number;
          refundMethod: string;
          refundReference: string;
        }[]
      >`
        SELECT
          status,
          refund_amount AS "refundAmount",
          refund_method AS "refundMethod",
          refund_reference AS "refundReference"
        FROM return_requests
        WHERE id = ${returnRequestId}::uuid
      `;

      if (rows.length === 0) return null;

      return {
        status: rows[0].status,
        refundAmount: Number(rows[0].refundAmount),
        refundMethod: rows[0].refundMethod,
        reference: rows[0].refundReference,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get refund status for ${returnRequestId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }
}
