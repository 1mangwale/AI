/**
 * Fee Calculator Service — VENDOR-SIDE CALCULATIONS ONLY
 *
 * Handles fee/tax calculations for VENDOR PAYOUTS and PLATFORM REVENUE:
 * - Platform commission
 * - GST (5% food, 18% services) split into CGST + SGST
 * - TDS 1% per Section 194-O (e-commerce aggregator withholding)
 * - Delivery charge estimates for vendor settlement
 * - Net vendor payout computation
 *
 * IMPORTANT: This service does NOT compute consumer-facing prices.
 * Consumer prices (delivery fees, tax shown to user) come from PHP:
 * - Zone pivot delivery rates: GET /api/v1/config/get-zone-id
 * - Tax calculation: POST /api/v1/customer/order/get-Tax
 * - Final total: computed at order placement by PHP
 *
 * The delivery charge constants below are for vendor payout estimation only.
 * They may differ from consumer-facing rates set in PHP admin panel.
 *
 * India-specific tax rules applied throughout.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  FeeBreakdown,
  FeeCalculationInput,
  DeliveryChargeInput,
} from '../interfaces/finance.interfaces';

@Injectable()
export class FeeCalculatorService {
  private readonly logger = new Logger(FeeCalculatorService.name);

  // Module IDs (PHP backend ground truth)
  private readonly MODULE_FOOD = 4;
  private readonly MODULE_ECOMMERCE = 5;
  private readonly MODULE_PARCEL = 3;

  // GST rates
  private readonly GST_FOOD_RATE = 0.05; // 5% for food (restaurant services)
  private readonly GST_SERVICE_RATE = 0.18; // 18% for platform commission on services

  // TDS rate per Section 194-O (e-commerce)
  private readonly TDS_RATE = 0.01; // 1%

  // Delivery charge configuration
  private readonly DELIVERY_BASE_CHARGE: Record<number, number> = {
    [this.MODULE_FOOD]: 25, // Rs 25 base for food
    [this.MODULE_ECOMMERCE]: 40, // Rs 40 base for ecommerce
    [this.MODULE_PARCEL]: 30, // Rs 30 base for parcel
  };

  private readonly DELIVERY_PER_KM: Record<number, number> = {
    [this.MODULE_FOOD]: 8, // Rs 8/km for food
    [this.MODULE_ECOMMERCE]: 10, // Rs 10/km for ecommerce
    [this.MODULE_PARCEL]: 12, // Rs 12/km for parcel
  };

  private readonly DELIVERY_MIN_CHARGE = 15;
  private readonly DELIVERY_MAX_CHARGE = 150;

  /**
   * Calculate complete fee breakdown for an order.
   *
   * Flow:
   * 1. Calculate platform fee (commission on order amount)
   * 2. Apply GST on platform commission
   * 3. Calculate TDS on vendor payout
   * 4. Compute net vendor payout
   * 5. Compute total customer pays
   */
  calculateFees(input: FeeCalculationInput): FeeBreakdown {
    try {
      const {
        orderAmount,
        deliveryCharge,
        moduleId,
        couponDiscount = 0,
        packagingCharge = 0,
      } = input;

      // Default commission rate 15% if not specified externally
      const commissionRate = 0.15;
      const platformFee = this.calculatePlatformFee(orderAmount, commissionRate);

      // GST on platform commission
      const gstResult = this.calculateGst(platformFee, moduleId);

      // Vendor payout before TDS
      const vendorPayoutBeforeTds =
        orderAmount - platformFee - gstResult.totalGst;

      // TDS on vendor payout
      const tdsAmount = this.calculateTds(vendorPayoutBeforeTds);

      // Net vendor payout
      const vendorReceives = Math.max(
        0,
        vendorPayoutBeforeTds - tdsAmount,
      );

      // Total customer pays
      const totalCustomerPays =
        orderAmount + deliveryCharge + packagingCharge - couponDiscount;

      const breakdown: FeeBreakdown = {
        orderAmount,
        platformFee: this.round(platformFee),
        deliveryCharge: this.round(deliveryCharge),
        packagingCharge: this.round(packagingCharge),
        gstAmount: this.round(gstResult.totalGst),
        cgst: this.round(gstResult.cgst),
        sgst: this.round(gstResult.sgst),
        tdsAmount: this.round(tdsAmount),
        totalCustomerPays: this.round(totalCustomerPays),
        vendorReceives: this.round(vendorReceives),
      };

      this.logger.debug(
        `Fee breakdown for order amount ${orderAmount}: ` +
          `platform=${breakdown.platformFee}, GST=${breakdown.gstAmount}, ` +
          `TDS=${breakdown.tdsAmount}, vendor=${breakdown.vendorReceives}`,
      );

      return breakdown;
    } catch (error) {
      this.logger.error(
        `Failed to calculate fees: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Calculate GST on a given amount based on module type.
   *
   * - Food (moduleId=4): 5% GST on restaurant services
   * - Services/E-commerce: 18% GST on platform commission
   * - Split equally into CGST and SGST (intra-state, which is assumed
   *   since Mangwale operates within a single state/zone)
   */
  calculateGst(
    amount: number,
    moduleId: number,
  ): { totalGst: number; cgst: number; sgst: number } {
    try {
      const gstRate =
        moduleId === this.MODULE_FOOD
          ? this.GST_FOOD_RATE
          : this.GST_SERVICE_RATE;

      const totalGst = amount * gstRate;
      const cgst = totalGst / 2;
      const sgst = totalGst / 2;

      return {
        totalGst: this.round(totalGst),
        cgst: this.round(cgst),
        sgst: this.round(sgst),
      };
    } catch (error) {
      this.logger.error(
        `Failed to calculate GST: ${error.message}`,
        error.stack,
      );
      return { totalGst: 0, cgst: 0, sgst: 0 };
    }
  }

  /**
   * Calculate TDS at 1% per Section 194-O of Income Tax Act.
   *
   * Applicable when:
   * - E-commerce operator facilitates sale of goods/services
   * - Deducted from vendor payout before settlement
   *
   * Threshold: TDS applies if vendor annual payout > Rs 5 lakh
   * (simplified: we always deduct and vendor claims credit in ITR)
   */
  calculateTds(vendorPayout: number): number {
    try {
      if (vendorPayout <= 0) return 0;
      return this.round(vendorPayout * this.TDS_RATE);
    } catch (error) {
      this.logger.error(
        `Failed to calculate TDS: ${error.message}`,
        error.stack,
      );
      return 0;
    }
  }

  /**
   * Calculate platform commission fee as a percentage of order amount.
   */
  calculatePlatformFee(orderAmount: number, commissionRate: number): number {
    try {
      if (orderAmount <= 0 || commissionRate <= 0) return 0;
      return this.round(orderAmount * commissionRate);
    } catch (error) {
      this.logger.error(
        `Failed to calculate platform fee: ${error.message}`,
        error.stack,
      );
      return 0;
    }
  }

  /**
   * Estimate delivery charge for vendor payout calculation.
   *
   * NOTE: This is for VENDOR SETTLEMENT, not consumer-facing display.
   * Consumer delivery fees come from PHP zone config (GET /api/v1/config/get-zone-id).
   *
   * Formula: base + (perKm * distance) * surgeMultiplier
   * Clamped between min and max charges.
   */
  calculateDeliveryCharge(input: DeliveryChargeInput): number {
    try {
      const { distanceKm, moduleId, surgeMultiplier = 1.0 } = input;

      const baseCharge = this.DELIVERY_BASE_CHARGE[moduleId] ?? 30;
      const perKm = this.DELIVERY_PER_KM[moduleId] ?? 10;

      let charge = baseCharge + perKm * Math.max(0, distanceKm);
      charge *= surgeMultiplier;

      // Clamp to min/max
      charge = Math.max(this.DELIVERY_MIN_CHARGE, charge);
      charge = Math.min(this.DELIVERY_MAX_CHARGE, charge);

      return this.round(charge);
    } catch (error) {
      this.logger.error(
        `Failed to calculate delivery charge: ${error.message}`,
        error.stack,
      );
      return this.DELIVERY_BASE_CHARGE[input.moduleId] ?? 30;
    }
  }

  /**
   * Calculate fees with a custom commission rate (used by CommissionService).
   */
  calculateFeesWithRate(
    orderAmount: number,
    deliveryCharge: number,
    moduleId: number,
    commissionRate: number,
    paymentMethod: string,
  ): FeeBreakdown {
    try {
      const platformFee = this.calculatePlatformFee(orderAmount, commissionRate);
      const gstResult = this.calculateGst(platformFee, moduleId);
      const vendorPayoutBeforeTds =
        orderAmount - platformFee - gstResult.totalGst;
      const tdsAmount = this.calculateTds(vendorPayoutBeforeTds);
      const vendorReceives = Math.max(0, vendorPayoutBeforeTds - tdsAmount);

      return {
        orderAmount,
        platformFee: this.round(platformFee),
        deliveryCharge: this.round(deliveryCharge),
        packagingCharge: 0,
        gstAmount: this.round(gstResult.totalGst),
        cgst: this.round(gstResult.cgst),
        sgst: this.round(gstResult.sgst),
        tdsAmount: this.round(tdsAmount),
        totalCustomerPays: this.round(orderAmount + deliveryCharge),
        vendorReceives: this.round(vendorReceives),
      };
    } catch (error) {
      this.logger.error(
        `Failed to calculate fees with rate: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Round to 2 decimal places (standard for INR).
   */
  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
