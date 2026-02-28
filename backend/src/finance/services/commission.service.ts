/**
 * Commission Service
 *
 * Manages commission calculation, recording, and rule lookup for vendor orders.
 *
 * Commission rules are prioritized:
 *   1. Store-specific + zone-specific (highest priority)
 *   2. Store-specific (no zone)
 *   3. Module-specific + zone-specific
 *   4. Module-specific default (lowest priority)
 *
 * Each commission record captures:
 * - Platform fee, GST (CGST+SGST), TDS (Section 194-O)
 * - Net vendor payout after all deductions
 * - Payment method for reconciliation
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FeeCalculatorService } from './fee-calculator.service';
import {
  CommissionResult,
  CommissionRule,
  CommissionStatsResult,
  StoreCommissionSummary,
} from '../interfaces/finance.interfaces';

@Injectable()
export class CommissionService implements OnModuleInit {
  private readonly logger = new Logger(CommissionService.name);

  // Default commission rates by module
  private readonly DEFAULT_RATES: Record<number, number> = {
    3: 0.10, // Parcel: 10%
    4: 0.15, // Food: 15%
    5: 0.12, // E-commerce: 12%
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly feeCalculator: FeeCalculatorService,
  ) {}

  async onModuleInit() {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS commissions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id BIGINT NOT NULL,
          store_id BIGINT NOT NULL,
          module_id INT NOT NULL,
          order_amount DECIMAL(12,2) NOT NULL,
          delivery_charge DECIMAL(10,2) DEFAULT 0,
          commission_rate DECIMAL(5,4) NOT NULL,
          platform_fee DECIMAL(10,2) NOT NULL,
          gst_on_commission DECIMAL(10,2) DEFAULT 0,
          tds_amount DECIMAL(10,2) DEFAULT 0,
          net_vendor_payout DECIMAL(12,2) NOT NULL,
          payment_method VARCHAR(50),
          status VARCHAR(20) DEFAULT 'active',
          voided_at TIMESTAMP,
          void_reason TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_commissions_store ON commissions(store_id)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_commissions_order ON commissions(order_id)
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status)
      `;

      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS commission_rules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id BIGINT,
          module_id INT NOT NULL,
          zone_id INT,
          commission_rate DECIMAL(5,4) NOT NULL,
          min_order_amount DECIMAL(10,2),
          max_commission DECIMAL(10,2),
          priority INT DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_commission_rules_lookup
          ON commission_rules(module_id, is_active, priority DESC)
      `;

      this.logger.log('CommissionService tables initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize commission tables: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Calculate commission for an order using applicable rules and fee calculator.
   */
  async calculateCommission(
    orderId: number,
    storeId: number,
    moduleId: number,
    orderAmount: number,
    deliveryCharge: number,
    paymentMethod: string,
    zoneId?: number,
  ): Promise<CommissionResult> {
    try {
      const rule = await this.getApplicableRule(storeId, moduleId, zoneId);
      const commissionRate = rule
        ? Number(rule.commissionRate)
        : this.DEFAULT_RATES[moduleId] ?? 0.15;

      const breakdown = this.feeCalculator.calculateFeesWithRate(
        orderAmount,
        deliveryCharge,
        moduleId,
        commissionRate,
        paymentMethod,
      );

      // Apply max commission cap if rule specifies it
      let platformFee = breakdown.platformFee;
      if (rule?.maxCommission && platformFee > Number(rule.maxCommission)) {
        platformFee = Number(rule.maxCommission);
        // Recalculate with capped fee
        const gst = this.feeCalculator.calculateGst(platformFee, moduleId);
        const vendorBeforeTds = orderAmount - platformFee - gst.totalGst;
        const tds = this.feeCalculator.calculateTds(vendorBeforeTds);
        breakdown.platformFee = platformFee;
        breakdown.gstAmount = gst.totalGst;
        breakdown.cgst = gst.cgst;
        breakdown.sgst = gst.sgst;
        breakdown.tdsAmount = tds;
        breakdown.vendorReceives = Math.max(0, vendorBeforeTds - tds);
      }

      // Apply min order amount check
      if (rule?.minOrderAmount && orderAmount < Number(rule.minOrderAmount)) {
        this.logger.debug(
          `Order ${orderId} amount ${orderAmount} below min ${rule.minOrderAmount} for rule ${rule.id}`,
        );
      }

      const result: CommissionResult = {
        orderId,
        orderAmount,
        commissionRate,
        platformFee: breakdown.platformFee,
        gstOnCommission: breakdown.gstAmount,
        tdsAmount: breakdown.tdsAmount,
        netVendorPayout: breakdown.vendorReceives,
        breakdown,
      };

      this.logger.debug(
        `Commission calculated for order #${orderId}: rate=${commissionRate}, ` +
          `fee=${result.platformFee}, vendor=${result.netVendorPayout}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to calculate commission for order #${orderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Record a calculated commission into the database.
   */
  async recordCommission(
    result: CommissionResult,
    storeId: number,
    moduleId: number,
    deliveryCharge: number,
    paymentMethod: string,
  ): Promise<string> {
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO commissions (
          order_id, store_id, module_id, order_amount, delivery_charge,
          commission_rate, platform_fee, gst_on_commission, tds_amount,
          net_vendor_payout, payment_method, status, created_at
        ) VALUES (
          ${result.orderId}, ${storeId}, ${moduleId}, ${result.orderAmount},
          ${deliveryCharge}, ${result.commissionRate}, ${result.platformFee},
          ${result.gstOnCommission}, ${result.tdsAmount}, ${result.netVendorPayout},
          ${paymentMethod}, 'active', NOW()
        )
        RETURNING id
      `;

      const commissionId = rows[0]?.id;
      this.logger.log(
        `Commission recorded: ${commissionId} for order #${result.orderId}`,
      );
      return commissionId;
    } catch (error) {
      this.logger.error(
        `Failed to record commission for order #${result.orderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get the applicable commission rule for a store/module/zone.
   *
   * Priority order:
   *   1. Store-specific + zone-specific
   *   2. Store-specific (any zone)
   *   3. Module + zone-specific
   *   4. Module default
   */
  async getApplicableRule(
    storeId: number,
    moduleId: number,
    zoneId?: number,
  ): Promise<CommissionRule | null> {
    try {
      const rules = await this.prisma.$queryRaw<CommissionRule[]>`
        SELECT
          id, store_id AS "storeId", module_id AS "moduleId",
          zone_id AS "zoneId", commission_rate AS "commissionRate",
          min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
          priority, is_active AS "isActive", created_at AS "createdAt"
        FROM commission_rules
        WHERE is_active = true
          AND module_id = ${moduleId}
          AND (store_id IS NULL OR store_id = ${storeId})
          AND (zone_id IS NULL OR zone_id = ${zoneId ?? null})
        ORDER BY
          CASE WHEN store_id IS NOT NULL AND zone_id IS NOT NULL THEN 0
               WHEN store_id IS NOT NULL THEN 1
               WHEN zone_id IS NOT NULL THEN 2
               ELSE 3
          END ASC,
          priority DESC
        LIMIT 1
      `;

      return rules.length > 0 ? rules[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to get applicable rule for store=${storeId}, module=${moduleId}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Void a commission (e.g., on order cancellation or refund).
   */
  async voidCommission(orderId: number, reason: string): Promise<boolean> {
    try {
      const result = await this.prisma.$executeRaw`
        UPDATE commissions
        SET status = 'voided', voided_at = NOW(), void_reason = ${reason}
        WHERE order_id = ${orderId} AND status = 'active'
      `;

      if (result > 0) {
        this.logger.log(
          `Commission voided for order #${orderId}: ${reason}`,
        );
        return true;
      }

      this.logger.warn(
        `No active commission found to void for order #${orderId}`,
      );
      return false;
    } catch (error) {
      this.logger.error(
        `Failed to void commission for order #${orderId}: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Get commission summary for a store in a date range.
   */
  async getStoreCommissions(
    storeId: number,
    startDate: Date,
    endDate: Date,
  ): Promise<StoreCommissionSummary> {
    try {
      const rows = await this.prisma.$queryRaw<StoreCommissionSummary[]>`
        SELECT
          ${storeId}::BIGINT AS "storeId",
          COUNT(*)::INT AS "totalOrders",
          COALESCE(SUM(order_amount), 0)::DECIMAL AS "totalOrderAmount",
          COALESCE(SUM(platform_fee), 0)::DECIMAL AS "totalCommission",
          COALESCE(SUM(gst_on_commission), 0)::DECIMAL AS "totalGst",
          COALESCE(SUM(tds_amount), 0)::DECIMAL AS "totalTds",
          COALESCE(SUM(net_vendor_payout), 0)::DECIMAL AS "totalVendorPayout"
        FROM commissions
        WHERE store_id = ${storeId}
          AND status = 'active'
          AND created_at >= ${startDate}
          AND created_at <= ${endDate}
      `;

      return (
        rows[0] ?? {
          storeId,
          totalOrders: 0,
          totalOrderAmount: 0,
          totalCommission: 0,
          totalGst: 0,
          totalTds: 0,
          totalVendorPayout: 0,
        }
      );
    } catch (error) {
      this.logger.error(
        `Failed to get store commissions for store=${storeId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get aggregate commission statistics across all stores.
   */
  async getCommissionStats(
    startDate?: Date,
    endDate?: Date,
  ): Promise<CommissionStatsResult> {
    try {
      const now = new Date();
      const defaultStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ); // first of month
      const start = startDate ?? defaultStart;
      const end = endDate ?? now;

      const rows = await this.prisma.$queryRaw<CommissionStatsResult[]>`
        SELECT
          COUNT(*)::INT AS "totalCommissions",
          COALESCE(SUM(platform_fee), 0)::DECIMAL AS "totalPlatformFee",
          COALESCE(SUM(gst_on_commission), 0)::DECIMAL AS "totalGst",
          COALESCE(SUM(tds_amount), 0)::DECIMAL AS "totalTds",
          COALESCE(SUM(net_vendor_payout), 0)::DECIMAL AS "totalVendorPayout",
          COUNT(DISTINCT order_id)::INT AS "orderCount"
        FROM commissions
        WHERE status = 'active'
          AND created_at >= ${start}
          AND created_at <= ${end}
      `;

      return (
        rows[0] ?? {
          totalCommissions: 0,
          totalPlatformFee: 0,
          totalGst: 0,
          totalTds: 0,
          totalVendorPayout: 0,
          orderCount: 0,
        }
      );
    } catch (error) {
      this.logger.error(
        `Failed to get commission stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * List commission rules with optional filters.
   */
  async getCommissionRules(
    moduleId?: number,
    storeId?: number,
  ): Promise<CommissionRule[]> {
    try {
      if (moduleId && storeId) {
        return await this.prisma.$queryRaw<CommissionRule[]>`
          SELECT
            id, store_id AS "storeId", module_id AS "moduleId",
            zone_id AS "zoneId", commission_rate AS "commissionRate",
            min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
            priority, is_active AS "isActive", created_at AS "createdAt"
          FROM commission_rules
          WHERE module_id = ${moduleId} AND store_id = ${storeId}
          ORDER BY priority DESC
        `;
      } else if (moduleId) {
        return await this.prisma.$queryRaw<CommissionRule[]>`
          SELECT
            id, store_id AS "storeId", module_id AS "moduleId",
            zone_id AS "zoneId", commission_rate AS "commissionRate",
            min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
            priority, is_active AS "isActive", created_at AS "createdAt"
          FROM commission_rules
          WHERE module_id = ${moduleId}
          ORDER BY priority DESC
        `;
      }

      return await this.prisma.$queryRaw<CommissionRule[]>`
        SELECT
          id, store_id AS "storeId", module_id AS "moduleId",
          zone_id AS "zoneId", commission_rate AS "commissionRate",
          min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
          priority, is_active AS "isActive", created_at AS "createdAt"
        FROM commission_rules
        ORDER BY module_id, priority DESC
      `;
    } catch (error) {
      this.logger.error(
        `Failed to get commission rules: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }

  /**
   * Create a new commission rule.
   */
  async createCommissionRule(data: {
    storeId?: number;
    moduleId: number;
    zoneId?: number;
    commissionRate: number;
    minOrderAmount?: number;
    maxCommission?: number;
    priority?: number;
  }): Promise<CommissionRule> {
    try {
      const rows = await this.prisma.$queryRaw<CommissionRule[]>`
        INSERT INTO commission_rules (
          store_id, module_id, zone_id, commission_rate,
          min_order_amount, max_commission, priority
        ) VALUES (
          ${data.storeId ?? null}, ${data.moduleId}, ${data.zoneId ?? null},
          ${data.commissionRate}, ${data.minOrderAmount ?? null},
          ${data.maxCommission ?? null}, ${data.priority ?? 0}
        )
        RETURNING
          id, store_id AS "storeId", module_id AS "moduleId",
          zone_id AS "zoneId", commission_rate AS "commissionRate",
          min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
          priority, is_active AS "isActive", created_at AS "createdAt"
      `;

      this.logger.log(
        `Commission rule created: ${rows[0]?.id} for module=${data.moduleId}`,
      );
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to create commission rule: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Update an existing commission rule.
   */
  async updateCommissionRule(
    ruleId: string,
    data: {
      commissionRate?: number;
      minOrderAmount?: number;
      maxCommission?: number;
      priority?: number;
      isActive?: boolean;
    },
  ): Promise<CommissionRule | null> {
    try {
      const rows = await this.prisma.$queryRaw<CommissionRule[]>`
        UPDATE commission_rules
        SET
          commission_rate = COALESCE(${data.commissionRate ?? null}, commission_rate),
          min_order_amount = COALESCE(${data.minOrderAmount ?? null}, min_order_amount),
          max_commission = COALESCE(${data.maxCommission ?? null}, max_commission),
          priority = COALESCE(${data.priority ?? null}, priority),
          is_active = COALESCE(${data.isActive ?? null}, is_active),
          updated_at = NOW()
        WHERE id = ${ruleId}::uuid
        RETURNING
          id, store_id AS "storeId", module_id AS "moduleId",
          zone_id AS "zoneId", commission_rate AS "commissionRate",
          min_order_amount AS "minOrderAmount", max_commission AS "maxCommission",
          priority, is_active AS "isActive", created_at AS "createdAt"
      `;

      if (rows.length === 0) {
        this.logger.warn(`Commission rule ${ruleId} not found for update`);
        return null;
      }

      this.logger.log(`Commission rule updated: ${ruleId}`);
      return rows[0];
    } catch (error) {
      this.logger.error(
        `Failed to update commission rule ${ruleId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * List commissions with filters (used by admin controller).
   */
  async listCommissions(filters: {
    storeId?: number;
    startDate?: Date;
    endDate?: Date;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: any[]; total: number }> {
    try {
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 20;
      const offset = (page - 1) * limit;

      // Build filter conditions
      const now = new Date();
      const startDate = filters.startDate ?? new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = filters.endDate ?? now;
      const status = filters.status ?? 'active';

      let data: any[];
      let countResult: { count: number }[];

      if (filters.storeId) {
        data = await this.prisma.$queryRaw`
          SELECT
            id, order_id AS "orderId", store_id AS "storeId",
            module_id AS "moduleId", order_amount AS "orderAmount",
            commission_rate AS "commissionRate", platform_fee AS "platformFee",
            gst_on_commission AS "gstOnCommission", tds_amount AS "tdsAmount",
            net_vendor_payout AS "netVendorPayout", payment_method AS "paymentMethod",
            status, created_at AS "createdAt"
          FROM commissions
          WHERE store_id = ${filters.storeId}
            AND status = ${status}
            AND created_at >= ${startDate}
            AND created_at <= ${endDate}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM commissions
          WHERE store_id = ${filters.storeId}
            AND status = ${status}
            AND created_at >= ${startDate}
            AND created_at <= ${endDate}
        `;
      } else {
        data = await this.prisma.$queryRaw`
          SELECT
            id, order_id AS "orderId", store_id AS "storeId",
            module_id AS "moduleId", order_amount AS "orderAmount",
            commission_rate AS "commissionRate", platform_fee AS "platformFee",
            gst_on_commission AS "gstOnCommission", tds_amount AS "tdsAmount",
            net_vendor_payout AS "netVendorPayout", payment_method AS "paymentMethod",
            status, created_at AS "createdAt"
          FROM commissions
          WHERE status = ${status}
            AND created_at >= ${startDate}
            AND created_at <= ${endDate}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        countResult = await this.prisma.$queryRaw`
          SELECT COUNT(*)::INT AS count FROM commissions
          WHERE status = ${status}
            AND created_at >= ${startDate}
            AND created_at <= ${endDate}
        `;
      }

      return {
        data,
        total: countResult[0]?.count ?? 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to list commissions: ${error.message}`,
        error.stack,
      );
      return { data: [], total: 0 };
    }
  }
}
