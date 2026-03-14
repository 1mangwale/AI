import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { SessionService } from '../../session/session.service';

/**
 * Pricing Executor
 *
 * Delivery fee source of truth: zone-module pivot table (from PHP zone API).
 * The zone executor extracts per-module rates into context.data.delivery_zone.delivery_rates.
 *
 * Module delivery rate structure (from zone pivot):
 *   - Food (4):    per_km=₹11, min=₹25, max=₹45, type=distance
 *   - Ecom (5):    per_km=₹11, min=₹25, max=₹45, type=distance
 *   - Parcel (3):  null in zone → uses global config (₹11.5/km, min ₹40)
 *
 * For food/ecommerce: populates PHP cart → calls get-Tax for real tax.
 * For parcel: uses PHP global config or parcel category rates.
 *
 * The actual order total is always calculated by PHP at placement time.
 * This executor produces the pre-confirmation preview shown to the user.
 */
@Injectable()
export class PricingExecutor implements ActionExecutor {
  readonly name = 'pricing';
  private readonly logger = new Logger(PricingExecutor.name);

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly phpPaymentService?: PhpPaymentService,
    @Optional() private readonly phpOrderService?: PhpOrderService,
    @Optional() private readonly sessionService?: SessionService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const type = config.type as 'food' | 'parcel' | 'ecommerce' || 'food';

      let output: any;

      // Food + ecommerce: try PHP cart-populate → get-Tax for real numbers
      if (type === 'food' || type === 'ecommerce') {
        output = await this.calculateViaPhpCart(config, context, type);
      }

      // Parcel or fallback: local calculation with zone rates
      if (!output) {
        if (type === 'food') {
          output = this.calculateFoodPricing(config, context);
        } else if (type === 'parcel') {
          output = this.calculateParcelPricing(config, context);
        } else {
          output = this.calculateEcommercePricing(config, context);
        }
      }

      this.logger.debug(`Pricing calculated (${output.source || 'local'}): ₹${output.total}`);

      return {
        success: true,
        output,
        event: 'calculated',
      };
    } catch (error) {
      this.logger.error(`Pricing calculation failed: ${error.message}`, error.stack);
      context.data._friendly_error = 'We could not calculate the price right now. Please try again, or contact support if the issue persists.';
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get delivery charge using zone pivot rates (primary) or local fallback.
   * PHP stores per-module rates in the zone-module pivot table.
   * The zone executor extracts these into context.data.delivery_zone.delivery_rates.
   */
  private getDeliveryChargeFromZone(
    moduleId: number,
    distance: number,
    itemsTotal: number,
    context: FlowContext,
  ): { charge: number; source: string; maxCharge: number | null } {
    // Primary: zone pivot delivery rates (set by zone executor)
    const deliveryRates = context.data.delivery_zone?.delivery_rates;
    const moduleRate = deliveryRates?.[moduleId];

    if (moduleRate && moduleRate.perKmCharge > 0) {
      let charge: number;

      if (moduleRate.chargeType === 'fixed' && moduleRate.fixedCharge) {
        charge = moduleRate.fixedCharge;
      } else {
        const rawCharge = distance * moduleRate.perKmCharge;
        charge = Math.max(rawCharge, moduleRate.minCharge || 0);
      }

      // Apply maximum cap if set
      if (moduleRate.maxCharge && charge > moduleRate.maxCharge) {
        this.logger.debug(
          `Delivery fee capped: ₹${charge.toFixed(2)} → ₹${moduleRate.maxCharge} (max for module ${moduleId})`,
        );
        charge = moduleRate.maxCharge;
      }

      this.logger.debug(
        `Zone pivot delivery: module ${moduleId}, ${distance}km × ₹${moduleRate.perKmCharge}/km = ₹${charge} (min ₹${moduleRate.minCharge}, max ₹${moduleRate.maxCharge ?? 'none'})`,
      );

      return { charge, source: 'zone_pivot', maxCharge: moduleRate.maxCharge };
    }

    // Fallback: local env-var-based estimate — CONSUMER PRICE ESTIMATE ONLY
    // PHP is the source of truth for consumer prices. This fallback is used only when:
    // 1. User is not yet authenticated (no zone config fetched)
    // 2. Zone config didn't include rates for this module
    // The actual order total is always calculated by PHP at placement time.
    this.logger.warn(`No zone pivot rates for module ${moduleId} — using local estimate (PHP will recalculate at order placement)`);
    const isEcom = moduleId === 5;
    return {
      charge: this.localDeliveryFeeEstimate(distance, isEcom, itemsTotal),
      source: 'local_estimate',
      maxCharge: null,
    };
  }

  /**
   * Proper PHP-backed pricing:
   * 1. Get delivery charge from zone pivot rates
   * 2. Populate PHP cart with the selected items
   * 3. Call get-Tax (PHP reads cart, returns real tax)
   * 4. Return real numbers to display in order summary
   */
  private async calculateViaPhpCart(
    config: any,
    context: FlowContext,
    type: 'food' | 'ecommerce',
  ): Promise<any | null> {
    try {
      // Need auth token to populate PHP cart
      const session = await this.sessionService?.getSession(context._system?.sessionId);
      const authToken = session?.data?.auth_token;
      if (!authToken) {
        this.logger.debug('No auth token available — using local pricing estimate');
        return null;
      }

      const isEcom = type === 'ecommerce';
      const moduleId = isEcom ? 5 : 4; // 5=Shop, 4=Food
      const items = config.items || context.data.selected_items || context.data.cart_items || [];
      const distance = config.distance || context.data.distance || 0;

      if (!items || items.length === 0) {
        this.logger.debug('No items to price — using local fallback');
        return null;
      }

      const itemsTotal = items.reduce((s: number, i: any) => s + (i.price * (i.quantity || 1)), 0);

      // Step 1: Get delivery charge from zone pivot rates (set by zone executor)
      const { charge: deliveryCharge, source: deliverySource } =
        this.getDeliveryChargeFromZone(moduleId, distance, itemsTotal, context);

      // Step 2: Populate PHP cart so get-Tax reads real items
      const cartResult = await this.phpOrderService?.populateCartForPricing(authToken, items, moduleId);
      if (!cartResult?.success) {
        this.logger.warn('Cart population failed — falling back to local pricing');
        return null;
      }

      // Step 3: Call get-Tax — PHP now reads the populated cart and applies
      // the correct tax rate (food=0%, ecom=GST from business settings)
      const taxResult = await this.phpPaymentService?.calculateTax({
        items: [],  // PHP ignores this array and reads from the cart table
        deliveryCharge,
        distance,
        moduleId,
      });

      if (!taxResult?.success) {
        this.logger.warn('get-Tax failed after cart population — falling back to local pricing');
        return null;
      }

      const tax = taxResult.tax ?? 0;
      const total = itemsTotal + deliveryCharge + tax;
      const freeShipping = isEcom && deliveryCharge === 0;

      this.logger.log(
        `PHP cart pricing (${type}): items=₹${itemsTotal}, delivery=₹${deliveryCharge} [${deliverySource}], tax=₹${tax}, total=₹${total}`
      );

      return {
        items_total: itemsTotal,
        itemsTotal,
        delivery_fee: deliveryCharge,
        shipping_fee: deliveryCharge,
        shippingFee: deliveryCharge,
        freeShipping,
        subtotal: itemsTotal + deliveryCharge,
        tax,
        total,
        source: deliverySource === 'zone_pivot' ? 'php_zone' : 'php_cart',
        breakdown: { items: itemsTotal, delivery: deliveryCharge, tax },
      };
    } catch (error) {
      this.logger.warn(`PHP cart pricing error: ${error.message} — falling back to local calc`);
      return null;
    }
  }

  /**
   * Local delivery fee ESTIMATE — used only as pre-auth fallback.
   * PHP is the sole source of truth for consumer-facing prices.
   * This method exists because zone config requires an authenticated session.
   * The actual delivery fee is always recalculated by PHP at order placement.
   * @internal Do not use for final pricing — always prefer calculateViaPhpCart()
   */
  private localDeliveryFeeEstimate(distance: number, isEcom: boolean, itemsTotal: number): number {
    if (isEcom) {
      // Ecom fallback: use distance-based like food (₹11/km, min ₹25, max ₹45)
      // Old code used flat ₹40 which was wrong
      const feePerKm = parseFloat(process.env.DEFAULT_ECOM_DELIVERY_FEE_PER_KM) || 11;
      const minFee = parseFloat(process.env.DEFAULT_ECOM_MIN_DELIVERY_FEE) || 25;
      const maxFee = parseFloat(process.env.DEFAULT_ECOM_MAX_DELIVERY_FEE) || 45;
      const raw = Math.max(distance * feePerKm, minFee);
      return maxFee > 0 ? Math.min(raw, maxFee) : raw;
    }
    // Food fallback: ₹11/km, min ₹25, max ₹45 (matching PHP zone 4)
    const feePerKm = parseFloat(process.env.DEFAULT_DELIVERY_FEE_PER_KM) || 11;
    const minFee = parseFloat(process.env.DEFAULT_MIN_DELIVERY_FEE) || 25;
    const maxFee = parseFloat(process.env.DEFAULT_MAX_DELIVERY_FEE) || 45;
    const raw = Math.max(distance * feePerKm, minFee);
    return maxFee > 0 ? Math.min(raw, maxFee) : raw;
  }

  /** @internal Local estimate only — PHP recalculates at placement. Used when user is not yet authenticated. */
  private calculateFoodPricing(config: any, context: FlowContext): any {
    this.logger.warn('Using local food pricing ESTIMATE — PHP will recalculate at order placement');
    const items = config.items || context.data.selected_items || [];
    const distance = config.distance || context.data.distance || 0;

    const itemsTotal = items.reduce((sum: number, item: any) => {
      return sum + (item.price * (item.quantity || 1));
    }, 0);

    // Use zone pivot rates if available, else env-var fallback
    const { charge: deliveryFee, source } = this.getDeliveryChargeFromZone(4, distance, itemsTotal, context);
    const subtotal = itemsTotal + deliveryFee;
    const foodGstRate = parseFloat(process.env.FOOD_GST_RATE) || 0; // 0% food GST
    const tax = Math.ceil(subtotal * foodGstRate);
    const total = subtotal + tax;

    return {
      items_total: itemsTotal,
      itemsTotal,
      delivery_fee: deliveryFee,
      subtotal,
      tax,
      total,
      source,
      breakdown: { items: itemsTotal, delivery: deliveryFee, tax },
    };
  }

  private calculateParcelPricing(config: any, context: FlowContext): any {
    const distance = config.distance || context.data.distance || 0;

    // Parcel: zone pivot may have null rates → use PHP global config values
    const { charge: deliveryFee, source } = this.getDeliveryChargeFromZone(3, distance, 0, context);

    let perKmCharge: number;
    let minimumCharge: number;

    if (source === 'zone_pivot') {
      // Zone had parcel rates
      perKmCharge = context.data.delivery_zone?.delivery_rates?.[3]?.perKmCharge || 11.5;
      minimumCharge = context.data.delivery_zone?.delivery_rates?.[3]?.minCharge || 40;
    } else {
      // Use PHP global config or env vars (parcel zone rates are often null)
      perKmCharge = config.per_km_charge || context.data.per_km_charge || parseFloat(process.env.PARCEL_PER_KM_RATE) || 11.5;
      minimumCharge = config.minimum_charge || context.data.minimum_charge || parseFloat(process.env.PARCEL_MIN_CHARGE) || 40;
    }

    const distanceCharge = Math.ceil(distance * perKmCharge);
    const subtotal = Math.max(minimumCharge, distanceCharge);
    const parcelGstRate = parseFloat(process.env.PARCEL_GST_RATE) || 0.18;
    const tax = Math.ceil(subtotal * parcelGstRate);
    const total = subtotal + tax;

    return {
      distance,
      per_km_charge: perKmCharge,
      minimum_charge: minimumCharge,
      delivery_fee: subtotal,
      subtotal,
      tax,
      total,
      source: source === 'zone_pivot' ? 'php_zone' : 'local',
    };
  }

  /** @internal Local estimate only — PHP recalculates at placement. Used when user is not yet authenticated. */
  private calculateEcommercePricing(config: any, context: FlowContext): any {
    this.logger.warn('Using local ecommerce pricing ESTIMATE — PHP will recalculate at order placement');
    const items = config.items || context.data.cart_items || context.data.selected_items || [];
    const distance = config.distance || context.data.distance || 0;

    const itemsTotal = items.reduce((sum: number, item: any) => {
      return sum + (item.price * (item.quantity || 1));
    }, 0);

    // Use zone pivot rates if available (ecom = module 5)
    const { charge: shippingFee, source } = this.getDeliveryChargeFromZone(5, distance, itemsTotal, context);
    const freeShipping = shippingFee === 0;
    const subtotal = itemsTotal + shippingFee;
    const tax = Math.ceil(subtotal * 0.18); // 18% GST fallback
    const total = subtotal + tax;

    return {
      items_total: itemsTotal,
      itemsTotal,
      delivery_fee: shippingFee,
      shipping_fee: shippingFee,
      shippingFee,
      freeShipping,
      subtotal,
      tax,
      total,
      source,
    };
  }
}
