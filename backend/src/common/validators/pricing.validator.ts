import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ParcelPricingConfig {
  baseCharge: number;
  perKmRate: number;
  platformFeePercent: number;
  minDistance: number;
  maxDistance: number;
}

export interface ParcelOrderPricing {
  distance: number;
  baseCharge: number;
  distanceCharge: number;
  platformFee: number;
  totalAmount: number;
}

export interface FoodOrderPricing {
  itemsTotal: number;
  deliveryCharge: number;
  taxes: number;
  platformFee: number;
  discount: number;
  totalAmount: number;
}

/**
 * Pricing Validator Service
 *
 * CRITICAL SECURITY: Server-side validation of order amounts
 * Prevents frontend manipulation of order amounts
 *
 * Used for:
 * - Parcel delivery orders (base + distance-based pricing)
 * - Food orders (items + delivery + taxes)
 * - Wallet balance validation
 */
@Injectable()
export class PricingValidatorService {
  private readonly logger = new Logger(PricingValidatorService.name);
  private readonly parcelPricing: ParcelPricingConfig;

  constructor(private readonly configService: ConfigService) {
    // Load pricing configuration from environment or use defaults
    this.parcelPricing = {
      baseCharge: this.configService.get('PARCEL_BASE_CHARGE', 30),
      perKmRate: this.configService.get('PARCEL_PER_KM_RATE', 10),
      platformFeePercent: this.configService.get('PARCEL_PLATFORM_FEE_PERCENT', 5),
      minDistance: this.configService.get('PARCEL_MIN_DISTANCE', 1),
      maxDistance: this.configService.get('PARCEL_MAX_DISTANCE', 50),
    };

    this.logger.log(`✅ Pricing Validator initialized`);
    this.logger.log(`   Parcel Base Charge: ₹${this.parcelPricing.baseCharge}`);
    this.logger.log(`   Per KM Rate: ₹${this.parcelPricing.perKmRate}/km`);
    this.logger.log(`   Platform Fee: ${this.parcelPricing.platformFeePercent}%`);
  }

  /**
   * Calculate expected parcel order amount
   * Formula: base_charge + (distance * per_km_rate) + platform_fee
   */
  calculateParcelOrderAmount(distance: number): ParcelOrderPricing {
    // Validate distance bounds
    if (distance < this.parcelPricing.minDistance) {
      throw new Error(`Distance too short: ${distance}km (minimum: ${this.parcelPricing.minDistance}km)`);
    }
    if (distance > this.parcelPricing.maxDistance) {
      throw new Error(`Distance too long: ${distance}km (maximum: ${this.parcelPricing.maxDistance}km)`);
    }

    const baseCharge = this.parcelPricing.baseCharge;
    const distanceCharge = distance * this.parcelPricing.perKmRate;
    const subtotal = baseCharge + distanceCharge;
    const platformFee = Math.round((subtotal * this.parcelPricing.platformFeePercent) / 100);
    const totalAmount = subtotal + platformFee;

    return {
      distance,
      baseCharge,
      distanceCharge: Math.round(distanceCharge),
      platformFee,
      totalAmount: Math.round(totalAmount),
    };
  }

  /**
   * Validate parcel order amount against expected calculation
   * Returns true if amount is within acceptable tolerance (±5%)
   */
  validateParcelOrderAmount(
    submittedAmount: number,
    distance: number,
    tolerancePercent: number = 5,
  ): { valid: boolean; expected: ParcelOrderPricing; difference: number; message?: string } {
    // Hard ceiling: reject any parcel order above ₹5,000 (sanity check)
    const MAX_PARCEL_AMOUNT = 5000;
    if (submittedAmount > MAX_PARCEL_AMOUNT) {
      this.logger.error(`❌ Parcel order amount ₹${submittedAmount} exceeds ceiling ₹${MAX_PARCEL_AMOUNT}`);
      return {
        valid: false,
        expected: null as any,
        difference: 0,
        message: `Order amount ₹${submittedAmount} exceeds maximum allowed ₹${MAX_PARCEL_AMOUNT}`,
      };
    }

    try {
      // NOTE: These rates are a sanity check only. PHP uses category-specific rates
      // from business_settings that may differ. Tolerance is set at ±5% to allow divergence.
      const expected = this.calculateParcelOrderAmount(distance);
      const difference = Math.abs(submittedAmount - expected.totalAmount);
      const tolerance = Math.round((expected.totalAmount * tolerancePercent) / 100);

      const valid = difference <= tolerance;

      if (!valid) {
        const message = `Order amount mismatch: submitted=₹${submittedAmount}, expected=₹${expected.totalAmount}, difference=₹${difference} (tolerance: ±₹${tolerance})`;
        this.logger.warn(`⚠️ ${message}`);
        return { valid: false, expected, difference, message };
      }

      this.logger.debug(`✅ Parcel order amount validated: ₹${submittedAmount} (expected: ₹${expected.totalAmount})`);
      return { valid: true, expected, difference };
    } catch (error) {
      return {
        valid: false,
        expected: null as any,
        difference: 0,
        message: `Validation error: ${error.message}`,
      };
    }
  }

  /**
   * Validate wallet balance before order placement
   * Ensures user has sufficient balance for wallet/partial payment
   */
  validateWalletBalance(
    userWalletBalance: number,
    walletDeduction: number,
    orderAmount: number,
  ): { valid: boolean; message?: string } {
    // Check if wallet deduction exceeds available balance
    if (walletDeduction > userWalletBalance) {
      const message = `Insufficient wallet balance: requested=₹${walletDeduction}, available=₹${userWalletBalance}`;
      this.logger.warn(`⚠️ ${message}`);
      return { valid: false, message };
    }

    // Check if wallet deduction exceeds order amount (over-deduction)
    if (walletDeduction > orderAmount) {
      const message = `Wallet deduction exceeds order amount: wallet=₹${walletDeduction}, order=₹${orderAmount}`;
      this.logger.warn(`⚠️ ${message}`);
      return { valid: false, message };
    }

    // Check for negative values
    if (walletDeduction < 0 || userWalletBalance < 0 || orderAmount < 0) {
      const message = `Negative values detected: wallet_balance=₹${userWalletBalance}, deduction=₹${walletDeduction}, order=₹${orderAmount}`;
      this.logger.warn(`⚠️ ${message}`);
      return { valid: false, message };
    }

    this.logger.debug(`✅ Wallet balance validated: deduction=₹${walletDeduction}, balance=₹${userWalletBalance}`);
    return { valid: true };
  }

  /**
   * Calculate food order pricing
   * Note: This is for validation purposes. PHP backend calculates actual food order amounts.
   */
  calculateFoodOrderAmount(items: Array<{ price: number; quantity: number }>): FoodOrderPricing {
    const itemsTotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const deliveryCharge = this.configService.get<number>('FOOD_DELIVERY_BASE_CHARGE', 30);
    const taxPercent = Math.round(this.configService.get<number>('pricing.foodGstRate', 0.05) * 100); // GST percentage
    const platformFeePercent = this.configService.get<number>('FOOD_PLATFORM_FEE_PERCENT', 2);

    const taxes = Math.round((itemsTotal * taxPercent) / 100);
    const platformFee = Math.round((itemsTotal * platformFeePercent) / 100);
    const totalAmount = itemsTotal + deliveryCharge + taxes + platformFee;

    return {
      itemsTotal,
      deliveryCharge,
      taxes,
      platformFee,
      discount: 0,
      totalAmount: Math.round(totalAmount),
    };
  }

  /**
   * Validate food order amount
   * Note: PHP backend is the source of truth for food orders,
   * this is just a sanity check to prevent gross manipulation
   */
  validateFoodOrderAmount(
    submittedAmount: number,
    items: Array<{ price: number; quantity: number }>,
    tolerancePercent: number = 20, // Higher tolerance since PHP calculates actual
  ): { valid: boolean; expected: FoodOrderPricing; difference: number; message?: string } {
    const expected = this.calculateFoodOrderAmount(items);
    const difference = Math.abs(submittedAmount - expected.totalAmount);
    const tolerance = Math.round((expected.totalAmount * tolerancePercent) / 100);

    const valid = difference <= tolerance;

    if (!valid) {
      const message = `Food order amount mismatch: submitted=₹${submittedAmount}, expected=₹${expected.totalAmount}, difference=₹${difference} (tolerance: ±₹${tolerance})`;
      this.logger.warn(`⚠️ ${message}`);
      return { valid: false, expected, difference, message };
    }

    this.logger.debug(`✅ Food order amount validated: ₹${submittedAmount} (expected: ₹${expected.totalAmount})`);
    return { valid: true, expected, difference };
  }

  /**
   * Get pricing configuration for display/debugging
   */
  getPricingConfig(): ParcelPricingConfig {
    return { ...this.parcelPricing };
  }
}
