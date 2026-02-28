/**
 * Payout Service
 *
 * Manages vendor payout records linked to settlements.
 * Actual bank transfer is stubbed — will integrate with
 * payment gateway (Razorpay Route / Cashfree Payouts) later.
 *
 * Payout lifecycle:
 *   pending -> processing -> completed
 *                         -> failed
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PayoutRecord } from '../interfaces/finance.interfaces';

@Injectable()
export class PayoutService implements OnModuleInit {
  private readonly logger = new Logger(PayoutService.name);
  private readonly phpBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.phpBaseUrl = this.configService.get<string>(
      'PHP_BASE_URL',
      'https://new.mangwale.com',
    );
  }

  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS payouts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          settlement_id UUID NOT NULL,
          store_id BIGINT NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          payment_reference VARCHAR(255),
          failure_reason TEXT,
          processed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_payouts_settlement ON payouts(settlement_id)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_payouts_store ON payouts(store_id, status)
      `;

      this.logger.log('PayoutService tables initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize payout tables: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Create a payout record for a confirmed settlement.
   */
  async createPayout(
    settlementId: string,
    storeId: number,
    amount: number,
  ): Promise<PayoutRecord | null> {
    try {
      // Check for duplicate payout
      const existing = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM payouts
        WHERE settlement_id = ${settlementId}::uuid
          AND status NOT IN ('failed')
        LIMIT 1
      `;

      if (existing.length > 0) {
        this.logger.warn(
          `Payout already exists for settlement ${settlementId}: ${existing[0].id}`,
        );
        return this.getPayoutById(existing[0].id);
      }

      const rows = await this.prisma.$queryRaw<PayoutRecord[]>`
        INSERT INTO payouts (settlement_id, store_id, amount, status)
        VALUES (${settlementId}::uuid, ${storeId}, ${amount}, 'pending')
        RETURNING
          id, settlement_id AS "settlementId", store_id AS "storeId",
          amount, status, payment_reference AS "paymentReference",
          processed_at AS "processedAt"
      `;

      this.logger.log(
        `Payout created: ${rows[0]?.id} for settlement=${settlementId}, amount=${amount}`,
      );
      return rows[0] ?? null;
    } catch (error) {
      this.logger.error(
        `Failed to create payout for settlement ${settlementId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Process a payout (stub: logs payout, actual bank transfer TBD).
   *
   * In production, this would:
   * 1. Look up vendor bank details
   * 2. Call Razorpay Route / Cashfree Payouts API
   * 3. Record the UTR/reference number
   * 4. Update status to completed/failed
   */
  async processPayout(payoutId: string): Promise<PayoutRecord | null> {
    try {
      // Mark as processing
      await this.prisma.$executeRaw`
        UPDATE payouts SET status = 'processing' WHERE id = ${payoutId}::uuid
      `;

      const payout = await this.getPayoutById(payoutId);
      if (!payout) {
        this.logger.error(`Payout ${payoutId} not found`);
        return null;
      }

      // STUB: In production, call payment gateway here
      // For now, generate a mock reference and mark as completed
      const mockReference = `PAY_${Date.now()}_${payout.storeId}`;

      this.logger.log(
        `[STUB] Processing payout ${payoutId}: amount=${payout.amount}, ` +
          `store=${payout.storeId}, ref=${mockReference}. ` +
          `Bank transfer integration pending.`,
      );

      // Mark as completed with mock reference
      const updated = await this.updatePayoutStatus(
        payoutId,
        'completed',
        mockReference,
      );

      return updated;
    } catch (error) {
      this.logger.error(
        `Failed to process payout ${payoutId}: ${error.message}`,
        error.stack,
      );

      // Mark as failed
      await this.prisma.$executeRaw`
        UPDATE payouts
        SET status = 'failed', failure_reason = ${error.message}
        WHERE id = ${payoutId}::uuid
      `;

      return null;
    }
  }

  /**
   * List payouts with optional filters.
   */
  async getPayouts(
    storeId?: number,
    status?: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: PayoutRecord[]; total: number }> {
    try {
      const offset = (page - 1) * limit;

      let data: PayoutRecord[];
      let countResult: { count: number }[];

      if (storeId && status) {
        data = await this.prisma.$queryRaw<PayoutRecord[]>`
          SELECT
            id, settlement_id AS "settlementId", store_id AS "storeId",
            amount, status, payment_reference AS "paymentReference",
            processed_at AS "processedAt"
          FROM payouts
          WHERE store_id = ${storeId} AND status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM payouts
          WHERE store_id = ${storeId} AND status = ${status}
        `;
      } else if (storeId) {
        data = await this.prisma.$queryRaw<PayoutRecord[]>`
          SELECT
            id, settlement_id AS "settlementId", store_id AS "storeId",
            amount, status, payment_reference AS "paymentReference",
            processed_at AS "processedAt"
          FROM payouts
          WHERE store_id = ${storeId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM payouts
          WHERE store_id = ${storeId}
        `;
      } else if (status) {
        data = await this.prisma.$queryRaw<PayoutRecord[]>`
          SELECT
            id, settlement_id AS "settlementId", store_id AS "storeId",
            amount, status, payment_reference AS "paymentReference",
            processed_at AS "processedAt"
          FROM payouts
          WHERE status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM payouts WHERE status = ${status}
        `;
      } else {
        data = await this.prisma.$queryRaw<PayoutRecord[]>`
          SELECT
            id, settlement_id AS "settlementId", store_id AS "storeId",
            amount, status, payment_reference AS "paymentReference",
            processed_at AS "processedAt"
          FROM payouts
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM payouts
        `;
      }

      return {
        data,
        total: countResult[0]?.count ?? 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to list payouts: ${error.message}`,
        error.stack,
      );
      return { data: [], total: 0 };
    }
  }

  /**
   * Update payout status and optionally set payment reference.
   */
  async updatePayoutStatus(
    payoutId: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    reference?: string,
  ): Promise<PayoutRecord | null> {
    try {
      const rows = await this.prisma.$queryRaw<PayoutRecord[]>`
        UPDATE payouts
        SET
          status = ${status},
          payment_reference = COALESCE(${reference ?? null}, payment_reference),
          processed_at = CASE WHEN ${status} IN ('completed', 'failed') THEN NOW() ELSE processed_at END
        WHERE id = ${payoutId}::uuid
        RETURNING
          id, settlement_id AS "settlementId", store_id AS "storeId",
          amount, status, payment_reference AS "paymentReference",
          processed_at AS "processedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(`Payout ${payoutId} not found for status update`);
        return null;
      }

      this.logger.log(`Payout ${payoutId} status updated to ${status}`);
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to update payout status ${payoutId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Get a single payout by ID.
   */
  private async getPayoutById(payoutId: string): Promise<PayoutRecord | null> {
    try {
      const rows = await this.prisma.$queryRaw<PayoutRecord[]>`
        SELECT
          id, settlement_id AS "settlementId", store_id AS "storeId",
          amount, status, payment_reference AS "paymentReference",
          processed_at AS "processedAt"
        FROM payouts
        WHERE id = ${payoutId}::uuid
      `;
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to get payout ${payoutId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }
}
