/**
 * Settlement Service
 *
 * Generates and manages vendor settlement batches by aggregating
 * commissions over a period. Settlement lifecycle:
 *
 *   draft -> confirmed -> processing -> paid
 *                                   -> failed
 *
 * Each settlement contains:
 * - Sum of all active commissions for a store in the period
 * - Total deductions (commission + GST + TDS)
 * - Net payout amount to vendor
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CommissionService } from './commission.service';
import { SettlementBatch } from '../interfaces/finance.interfaces';

@Injectable()
export class SettlementService implements OnModuleInit {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commissionService: CommissionService,
  ) {}

  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS settlements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id BIGINT NOT NULL,
          period_start TIMESTAMP NOT NULL,
          period_end TIMESTAMP NOT NULL,
          status VARCHAR(20) DEFAULT 'draft',
          total_orders INT DEFAULT 0,
          total_order_amount DECIMAL(12,2) DEFAULT 0,
          total_commission DECIMAL(12,2) DEFAULT 0,
          total_gst DECIMAL(10,2) DEFAULT 0,
          total_tds DECIMAL(10,2) DEFAULT 0,
          total_deductions DECIMAL(12,2) DEFAULT 0,
          net_payout_amount DECIMAL(12,2) DEFAULT 0,
          payment_reference VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          confirmed_at TIMESTAMP,
          paid_at TIMESTAMP
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_settlements_store ON settlements(store_id, status)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_settlements_period ON settlements(period_start, period_end)
      `;

      this.logger.log('SettlementService tables initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize settlement tables: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Generate a settlement for a store by aggregating all active commissions
   * in the given period.
   */
  async generateSettlement(
    storeId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SettlementBatch | null> {
    try {
      // Check for existing settlement overlapping this period
      const existing = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM settlements
        WHERE store_id = ${storeId}
          AND period_start = ${periodStart}
          AND period_end = ${periodEnd}
          AND status != 'failed'
        LIMIT 1
      `;

      if (existing.length > 0) {
        this.logger.warn(
          `Settlement already exists for store=${storeId}, period=${periodStart.toISOString()}-${periodEnd.toISOString()}: ${existing[0].id}`,
        );
        return this.getSettlementById(existing[0].id);
      }

      // Aggregate commissions for the period
      const aggregation = await this.prisma.$queryRaw<
        {
          totalOrders: number;
          totalOrderAmount: number;
          totalCommission: number;
          totalGst: number;
          totalTds: number;
          totalVendorPayout: number;
        }[]
      >`
        SELECT
          COUNT(*)::INT AS "totalOrders",
          COALESCE(SUM(order_amount), 0)::DECIMAL AS "totalOrderAmount",
          COALESCE(SUM(platform_fee), 0)::DECIMAL AS "totalCommission",
          COALESCE(SUM(gst_on_commission), 0)::DECIMAL AS "totalGst",
          COALESCE(SUM(tds_amount), 0)::DECIMAL AS "totalTds",
          COALESCE(SUM(net_vendor_payout), 0)::DECIMAL AS "totalVendorPayout"
        FROM commissions
        WHERE store_id = ${storeId}
          AND status = 'active'
          AND created_at >= ${periodStart}
          AND created_at <= ${periodEnd}
      `;

      const agg = aggregation[0];
      if (!agg || agg.totalOrders === 0) {
        this.logger.debug(
          `No commissions found for store=${storeId} in period`,
        );
        return null;
      }

      const totalDeductions =
        Number(agg.totalCommission) +
        Number(agg.totalGst) +
        Number(agg.totalTds);
      const netPayoutAmount = Number(agg.totalVendorPayout);

      // Create settlement record
      const rows = await this.prisma.$queryRaw<SettlementBatch[]>`
        INSERT INTO settlements (
          store_id, period_start, period_end, status,
          total_orders, total_order_amount, total_commission,
          total_gst, total_tds, total_deductions, net_payout_amount
        ) VALUES (
          ${storeId}, ${periodStart}, ${periodEnd}, 'draft',
          ${agg.totalOrders}, ${Number(agg.totalOrderAmount)},
          ${Number(agg.totalCommission)}, ${Number(agg.totalGst)},
          ${Number(agg.totalTds)}, ${totalDeductions}, ${netPayoutAmount}
        )
        RETURNING
          id, store_id AS "storeId", period_start AS "periodStart",
          period_end AS "periodEnd", status,
          total_orders AS "totalOrders",
          total_order_amount AS "totalOrderAmount",
          total_commission AS "totalCommission",
          total_deductions AS "totalDeductions",
          net_payout_amount AS "netPayoutAmount",
          created_at AS "createdAt"
      `;

      this.logger.log(
        `Settlement generated: ${rows[0]?.id} for store=${storeId}, ` +
          `orders=${agg.totalOrders}, payout=${netPayoutAmount}`,
      );

      return rows[0] ?? null;
    } catch (error) {
      this.logger.error(
        `Failed to generate settlement for store=${storeId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Confirm a draft settlement (mark as ready for payout).
   */
  async confirmSettlement(settlementId: string): Promise<SettlementBatch | null> {
    try {
      const rows = await this.prisma.$queryRaw<SettlementBatch[]>`
        UPDATE settlements
        SET status = 'confirmed', confirmed_at = NOW()
        WHERE id = ${settlementId}::uuid AND status = 'draft'
        RETURNING
          id, store_id AS "storeId", period_start AS "periodStart",
          period_end AS "periodEnd", status,
          total_orders AS "totalOrders",
          total_order_amount AS "totalOrderAmount",
          total_commission AS "totalCommission",
          total_deductions AS "totalDeductions",
          net_payout_amount AS "netPayoutAmount",
          created_at AS "createdAt", confirmed_at AS "confirmedAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(
          `Settlement ${settlementId} not found or not in draft status`,
        );
        return null;
      }

      this.logger.log(`Settlement confirmed: ${settlementId}`);
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to confirm settlement ${settlementId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Mark a settlement as paid with a payment reference.
   */
  async markAsPaid(
    settlementId: string,
    paymentReference: string,
  ): Promise<SettlementBatch | null> {
    try {
      const rows = await this.prisma.$queryRaw<SettlementBatch[]>`
        UPDATE settlements
        SET status = 'paid', paid_at = NOW(), payment_reference = ${paymentReference}
        WHERE id = ${settlementId}::uuid AND status IN ('confirmed', 'processing')
        RETURNING
          id, store_id AS "storeId", period_start AS "periodStart",
          period_end AS "periodEnd", status,
          total_orders AS "totalOrders",
          total_order_amount AS "totalOrderAmount",
          total_commission AS "totalCommission",
          total_deductions AS "totalDeductions",
          net_payout_amount AS "netPayoutAmount",
          created_at AS "createdAt", confirmed_at AS "confirmedAt",
          paid_at AS "paidAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(
          `Settlement ${settlementId} not found or not in confirmed/processing status`,
        );
        return null;
      }

      this.logger.log(
        `Settlement marked as paid: ${settlementId}, ref=${paymentReference}`,
      );
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to mark settlement ${settlementId} as paid: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * List settlements with pagination and filters.
   */
  async getSettlements(
    storeId?: number,
    status?: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: SettlementBatch[]; total: number }> {
    try {
      const offset = (page - 1) * limit;

      let data: SettlementBatch[];
      let countResult: { count: number }[];

      if (storeId && status) {
        data = await this.prisma.$queryRaw<SettlementBatch[]>`
          SELECT
            id, store_id AS "storeId", period_start AS "periodStart",
            period_end AS "periodEnd", status,
            total_orders AS "totalOrders",
            total_order_amount AS "totalOrderAmount",
            total_commission AS "totalCommission",
            total_deductions AS "totalDeductions",
            net_payout_amount AS "netPayoutAmount",
            created_at AS "createdAt", confirmed_at AS "confirmedAt",
            paid_at AS "paidAt"
          FROM settlements
          WHERE store_id = ${storeId} AND status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM settlements
          WHERE store_id = ${storeId} AND status = ${status}
        `;
      } else if (storeId) {
        data = await this.prisma.$queryRaw<SettlementBatch[]>`
          SELECT
            id, store_id AS "storeId", period_start AS "periodStart",
            period_end AS "periodEnd", status,
            total_orders AS "totalOrders",
            total_order_amount AS "totalOrderAmount",
            total_commission AS "totalCommission",
            total_deductions AS "totalDeductions",
            net_payout_amount AS "netPayoutAmount",
            created_at AS "createdAt", confirmed_at AS "confirmedAt",
            paid_at AS "paidAt"
          FROM settlements
          WHERE store_id = ${storeId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM settlements
          WHERE store_id = ${storeId}
        `;
      } else if (status) {
        data = await this.prisma.$queryRaw<SettlementBatch[]>`
          SELECT
            id, store_id AS "storeId", period_start AS "periodStart",
            period_end AS "periodEnd", status,
            total_orders AS "totalOrders",
            total_order_amount AS "totalOrderAmount",
            total_commission AS "totalCommission",
            total_deductions AS "totalDeductions",
            net_payout_amount AS "netPayoutAmount",
            created_at AS "createdAt", confirmed_at AS "confirmedAt",
            paid_at AS "paidAt"
          FROM settlements
          WHERE status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM settlements
          WHERE status = ${status}
        `;
      } else {
        data = await this.prisma.$queryRaw<SettlementBatch[]>`
          SELECT
            id, store_id AS "storeId", period_start AS "periodStart",
            period_end AS "periodEnd", status,
            total_orders AS "totalOrders",
            total_order_amount AS "totalOrderAmount",
            total_commission AS "totalCommission",
            total_deductions AS "totalDeductions",
            net_payout_amount AS "netPayoutAmount",
            created_at AS "createdAt", confirmed_at AS "confirmedAt",
            paid_at AS "paidAt"
          FROM settlements
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM settlements
        `;
      }

      return {
        data,
        total: countResult[0]?.count ?? 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to list settlements: ${error.message}`,
        error.stack,
      );
      return { data: [], total: 0 };
    }
  }

  /**
   * Get full settlement details including commission breakdown.
   */
  async getSettlementDetails(
    settlementId: string,
  ): Promise<{ settlement: SettlementBatch; commissions: any[] } | null> {
    try {
      const settlement = await this.getSettlementById(settlementId);
      if (!settlement) return null;

      // Get all commissions that fall within this settlement's period
      const commissions = await this.prisma.$queryRaw<any[]>`
        SELECT
          id, order_id AS "orderId", order_amount AS "orderAmount",
          commission_rate AS "commissionRate", platform_fee AS "platformFee",
          gst_on_commission AS "gstOnCommission", tds_amount AS "tdsAmount",
          net_vendor_payout AS "netVendorPayout", payment_method AS "paymentMethod",
          status, created_at AS "createdAt"
        FROM commissions
        WHERE store_id = ${settlement.storeId}
          AND status = 'active'
          AND created_at >= ${settlement.periodStart}
          AND created_at <= ${settlement.periodEnd}
        ORDER BY created_at ASC
      `;

      return { settlement, commissions };
    } catch (error) {
      this.logger.error(
        `Failed to get settlement details for ${settlementId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Get a single settlement by ID.
   */
  async getSettlementById(settlementId: string): Promise<SettlementBatch | null> {
    try {
      const rows = await this.prisma.$queryRaw<SettlementBatch[]>`
        SELECT
          id, store_id AS "storeId", period_start AS "periodStart",
          period_end AS "periodEnd", status,
          total_orders AS "totalOrders",
          total_order_amount AS "totalOrderAmount",
          total_commission AS "totalCommission",
          total_deductions AS "totalDeductions",
          net_payout_amount AS "netPayoutAmount",
          created_at AS "createdAt", confirmed_at AS "confirmedAt",
          paid_at AS "paidAt"
        FROM settlements
        WHERE id = ${settlementId}::uuid
      `;

      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to get settlement ${settlementId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Get all unique store IDs that have active commissions in a period.
   * Used by batch settlement generation.
   */
  async getStoresWithCommissions(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number[]> {
    try {
      const rows = await this.prisma.$queryRaw<{ storeId: number }[]>`
        SELECT DISTINCT store_id::INT AS "storeId"
        FROM commissions
        WHERE status = 'active'
          AND created_at >= ${periodStart}
          AND created_at <= ${periodEnd}
      `;
      return rows.map((r) => r.storeId);
    } catch (error) {
      this.logger.error(
        `Failed to get stores with commissions: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }
}
