import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';
import { SessionService } from '../../session/session.service';

/**
 * Pricing Executor
 *
 * GATE-MONEY (2026-07-31, CEO-approved): the bot NEVER computes a price.
 * Every number shown to the user comes from the platform:
 *   - Delivery fee: Laravel /api/v1/customer/delivery-quote (same endpoint the
 *     Flutter app uses — surge, rate-card versioning, server distance included)
 *   - Tax: Laravel /api/v1/customer/order/get-Tax
 * If the platform cannot price, this executor FAILS with an honest error —
 * there is deliberately no local fallback math.
 *
 * The actual order total is always recalculated by PHP at placement time.
 * This executor produces the pre-confirmation preview shown to the user.
 */
@Injectable()
export class PricingExecutor implements ActionExecutor {
  readonly name = 'pricing';
  private readonly logger = new Logger(PricingExecutor.name);

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly phpPaymentService?: PhpPaymentService,
    @Optional() private readonly sessionService?: SessionService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const type = config.type as 'food' | 'parcel' | 'ecommerce' || 'food';

      const output = type === 'parcel'
        ? await this.calculateParcelViaQuote(config, context)
        : await this.calculateViaPhpCart(config, context, type);

      this.logger.debug(`Pricing calculated (${output.source}): ₹${output.total}`);

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
   * Food/ecom pricing — platform numbers only:
   * 1. Delivery fee via Laravel delivery-quote (store → drop coordinates)
   * 2. Tax via get-Tax with the explicit cart (authenticated when possible)
   */
  private async calculateViaPhpCart(
    config: any,
    context: FlowContext,
    type: 'food' | 'ecommerce',
  ): Promise<any> {
    if (!this.phpPaymentService) {
      throw new Error('PhpPaymentService unavailable — cannot price order');
    }

    const session = await this.sessionService?.getSession(context._system?.sessionId);
    const authToken = session?.data?.auth_token;

    const isEcom = type === 'ecommerce';
    const moduleId = isEcom ? 5 : 4; // 5=Shop, 4=Food
    const items = config.items || context.data.selected_items || context.data.cart_items || [];
    let distance = config.distance || context.data.distance || 0;

    if (!items || items.length === 0) {
      throw new Error('No items in cart — cannot price order');
    }

    const itemsTotal = items.reduce((s: number, i: any) => s + (i.price * (i.quantity || 1)), 0);

    const storeId = config.storeId
      || config.store_id
      || context.data.store_id
      || context.data.store?.id
      || items[0]?.storeId
      || items[0]?.store_id;

    const firstItem = items[0] || {};
    const deliveryAddress = context.data.delivery_address || {};
    const pickupLat = Number(firstItem.storeLat ?? firstItem.store_lat ?? firstItem.pickupLat);
    const pickupLng = Number(firstItem.storeLng ?? firstItem.store_lng ?? firstItem.pickupLng);
    const dropLat = Number(deliveryAddress.latitude ?? deliveryAddress.lat);
    const dropLng = Number(deliveryAddress.longitude ?? deliveryAddress.lng);

    if (![pickupLat, pickupLng, dropLat, dropLng].every(Number.isFinite)) {
      throw new Error('Missing store or delivery coordinates — cannot get platform delivery quote');
    }

    const deliveryQuote = await this.phpPaymentService.getDeliveryQuote({
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      vehicleType: config.vehicleType || context.data.vehicle_type || 'BIKE',
      orderType: isEcom ? 'ecommerce' : 'food',
      moduleId,
      isCod: context.data.payment_method === 'cash_on_delivery',
      storeId,
    });

    if (!deliveryQuote?.success || deliveryQuote.deliveryCharge == null || deliveryQuote.deliveryCharge < 0) {
      throw new Error(`Platform delivery quote failed: ${deliveryQuote?.message || 'no delivery charge returned'}`);
    }

    const deliveryCharge = deliveryQuote.deliveryCharge;
    if (deliveryQuote.distanceKm && deliveryQuote.distanceKm > 0) {
      distance = deliveryQuote.distanceKm;
      context.data.distance = deliveryQuote.distanceKm;
    }

    // Tax: authenticated get-Tax with explicit cart when we have a token;
    // otherwise use the quote's own platform-computed tax (never local math).
    let tax: number;
    if (authToken && storeId) {
      const taxResult = await this.phpPaymentService.calculateTax({
        items,
        deliveryCharge,
        distance,
        moduleId,
        storeId,
        orderType: 'delivery',
        token: authToken,
      });
      if (!taxResult?.success) {
        throw new Error(`Platform tax calculation failed: ${taxResult?.message || 'get-Tax error'}`);
      }
      tax = taxResult.taxIncluded ? 0 : (taxResult.tax ?? 0);
    } else {
      const quoteTaxIncluded = deliveryQuote.raw?.tax_included === 1 || deliveryQuote.raw?.tax_included === true;
      tax = quoteTaxIncluded ? 0 : (deliveryQuote.taxAmount ?? 0);
      this.logger.log(`No auth token/store for get-Tax — using quote tax ₹${tax} (pre-auth preview)`);
    }

    const total = itemsTotal + deliveryCharge + tax;
    const freeShipping = isEcom && deliveryCharge === 0;

    this.logger.log(
      `Platform pricing (${type}): items=₹${itemsTotal}, delivery=₹${deliveryCharge} [php_delivery_quote], tax=₹${tax}, total=₹${total}`
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
      source: 'php_delivery_quote',
      quote_id: deliveryQuote.quoteId,
      rate_card_id: deliveryQuote.rateCardId,
      rate_card_version: deliveryQuote.rateCardVersion,
      distance,
      breakdown: { items: itemsTotal, delivery: deliveryCharge, tax },
    };
  }

  /**
   * Parcel-style pricing (used by food-flow custom orders) — delivery-only
   * charge from the platform quote. Pickup = custom pickup location,
   * drop = delivery address.
   */
  private async calculateParcelViaQuote(config: any, context: FlowContext): Promise<any> {
    if (!this.phpPaymentService) {
      throw new Error('PhpPaymentService unavailable — cannot price order');
    }

    const pickup = context.data.custom_pickup_location || context.data.pickup_address || {};
    const drop = context.data.delivery_address || {};
    const pickupLat = Number(pickup.latitude ?? pickup.lat);
    const pickupLng = Number(pickup.longitude ?? pickup.lng);
    const dropLat = Number(drop.latitude ?? drop.lat);
    const dropLng = Number(drop.longitude ?? drop.lng);

    if (![pickupLat, pickupLng, dropLat, dropLng].every(Number.isFinite)) {
      throw new Error('Missing pickup or delivery coordinates — cannot get platform parcel quote');
    }

    const quote = await this.phpPaymentService.getDeliveryQuote({
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      vehicleType: config.vehicleType || context.data.vehicle_type || 'BIKE',
      orderType: 'parcel',
      moduleId: config.moduleId || 3,
      isCod: context.data.payment_method === 'cash_on_delivery',
    });

    if (!quote?.success || quote.deliveryCharge == null || quote.deliveryCharge <= 0) {
      throw new Error(`Platform parcel quote failed: ${quote?.message || 'no delivery charge returned'}`);
    }

    const deliveryFee = quote.deliveryCharge;
    const taxIncluded = quote.raw?.tax_included === 1 || quote.raw?.tax_included === true;
    const tax = taxIncluded ? 0 : (quote.taxAmount ?? 0);
    const total = Math.round((deliveryFee + tax) * 100) / 100;
    const distance = quote.distanceKm || context.data.distance || 0;
    if (quote.distanceKm && quote.distanceKm > 0) {
      context.data.distance = quote.distanceKm;
    }

    this.logger.log(`Platform parcel pricing: delivery=₹${deliveryFee}, tax=₹${tax}, total=₹${total} (quote=${quote.quoteId || 'n/a'})`);

    return {
      distance,
      delivery_fee: deliveryFee,
      subtotal: deliveryFee,
      tax,
      total,
      source: 'php_delivery_quote',
      quote_id: quote.quoteId,
      rate_card_id: quote.rateCardId,
      rate_card_version: quote.rateCardVersion,
    };
  }
}
