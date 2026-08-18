import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';

/**
 * PHP Payment Service
 * Handles all payment-related API calls
 */
@Injectable()
export class PhpPaymentService extends PhpApiService {
  constructor(configService: ConfigService) {
    super(configService);
  }

  /**
   * Calculate tax for order
   * @param cartData.moduleId Optional module ID header (4=Food, 5=Ecommerce) for zone-specific tax rates
   */
  async calculateTax(cartData: {
    items: any[];
    deliveryCharge: number;
    distance: number;
    moduleId?: number;
    storeId?: number | string;
    orderType?: string;
    token?: string;
    /** State code for parcel GST — required so PHP doesn't default to IGST. Today '27' (Maharashtra/Nashik). */
    customerStateCode?: string;
  }): Promise<{
    success: boolean;
    tax?: number;
    /** true when tax is already included in item prices (PHP tax_included === 1) */
    taxIncluded?: boolean;
    message?: string;
  }> {
    try {
      this.logger.log(`💰 Calculating tax (module: ${cartData.moduleId || 'default'})`);

      const headers: Record<string, string> = {};
      if (cartData.moduleId) {
        headers['moduleId'] = String(cartData.moduleId);
      }

      const cartItems = Array.isArray(cartData.items)
        ? cartData.items
          .map(item => {
            const itemId = item?.item_id || item?.itemId || item?.id;
            if (!itemId) return null;
            return {
              item_id: itemId,
              quantity: item?.quantity || 1,
              variation: item?.variation || item?.variant || [],
              variant: item?.variant || item?.variation || [],
              add_on_ids: item?.add_on_ids || item?.addon_ids || [],
              add_on_qtys: item?.add_on_qtys || item?.addon_quantities || [],
              model: item?.model || 'Item',
              item_type: item?.item_type || 'AppModelsItem',
              price: item?.price || item?.item_price || 0,
            };
          })
          .filter(Boolean)
        : [];

      const payload = {
        items: cartData.items,
        cart: cartItems.length > 0 ? JSON.stringify(cartItems) : undefined,
        store_id: cartData.storeId,
        order_type: cartData.orderType || 'delivery',
        is_prescription: false,
        delivery_charge: cartData.deliveryCharge,
        distance: cartData.distance,
        // Include state code so PHP's parcel GST calc uses CGST+SGST for
        // intra-state rather than defaulting to IGST.
        place_of_supply_state_code: cartData.customerStateCode || '27',
      };

      const response: any = cartData.token
        ? await this.authenticatedRequest('post', '/api/v1/customer/order/get-Tax', cartData.token, payload, headers)
        : await this.post('/api/v1/customer/order/get-Tax', payload, headers);

      // PHP returns { tax_amount, tax_included } — NOT tax, total, or delivery_charge
      return {
        success: true,
        tax: parseFloat(response.tax_amount ?? 0),
        taxIncluded: response.tax_included === 1,
      };
    } catch (error) {
      this.logger.error(`Failed to calculate tax: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Platform delivery quote — same Laravel endpoint the Flutter app uses.
   * Source of truth for delivery fee across food/ecom/parcel (surge,
   * rate-card versioning, server-computed distance all applied by Laravel).
   */
  async getDeliveryQuote(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat: number;
    dropLng: number;
    vehicleType?: string;
    orderType: 'food' | 'ecom' | 'ecommerce' | 'parcel';
    moduleId?: number;
    isCod?: boolean;
    storeId?: number | string;
  }): Promise<{
    success: boolean;
    deliveryCharge?: number;
    originalDeliveryCharge?: number;
    distanceKm?: number;
    quoteId?: string;
    rateCardId?: string;
    rateCardVersion?: number;
    taxAmount?: number;
    message?: string;
    raw?: any;
  }> {
    try {
      const response: any = await this.post('/api/v1/customer/delivery-quote', {
        pickup_lat: params.pickupLat,
        pickup_lng: params.pickupLng,
        drop_lat: params.dropLat,
        drop_lng: params.dropLng,
        vehicle_type: params.vehicleType || 'BIKE',
        order_type: params.orderType,
        module_id: params.moduleId,
        is_cod: params.isCod || false,
        store_id: params.storeId,
      });

      return {
        success: true,
        deliveryCharge: parseFloat(response.delivery_charge ?? 0),
        originalDeliveryCharge: parseFloat(response.original_delivery_charge ?? response.delivery_charge ?? 0),
        distanceKm: response.distance_km != null ? parseFloat(response.distance_km) : undefined,
        quoteId: response.quote_id,
        rateCardId: response.rate_card_id,
        rateCardVersion: response.rate_card_version != null ? Number(response.rate_card_version) : undefined,
        taxAmount: response.tax_amount != null ? parseFloat(response.tax_amount) : undefined,
        raw: response,
      };
    } catch (error) {
      this.logger.warn(`Delivery quote failed: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Get zone-specific delivery fee configuration from PHP.
   * PHP's /api/v1/config returns delivery_management settings for the zone.
   * These are the EXACT values PHP uses when computing the delivery charge
   * at order placement time, so our preview will match.
   */
  async getDeliveryConfig(zoneId: number, moduleId: number = 4): Promise<{
    success: boolean;
    minCharge?: number;
    perKmCharge?: number;
    freeDeliveryOverAmount?: number;
    freeDeliveryDistance?: number;
    message?: string;
  }> {
    try {
      this.logger.debug(`📦 Fetching delivery config for zone ${zoneId}, module ${moduleId}`);

      const headers: any = {
        moduleId: String(moduleId),
        zoneId: JSON.stringify([zoneId]),
      };

      const response: any = await this.get('/api/v1/config', {}, headers);
      const dm = response?.delivery_management;

      if (!dm) {
        this.logger.warn('delivery_management not found in PHP config response');
        return { success: false, message: 'delivery_management not in config' };
      }

      return {
        success: true,
        minCharge: parseFloat(dm.min_shipping_charge ?? dm.minimum_shipping_charge ?? 30),
        perKmCharge: parseFloat(dm.shipping_per_km_charge ?? dm.per_km_shipping_charge ?? 10),
        freeDeliveryOverAmount: parseFloat(dm.free_delivery_over_amount ?? 0),
        freeDeliveryDistance: parseFloat(dm.free_delivery_distance ?? 0),
      };
    } catch (error) {
      this.logger.warn(`Failed to fetch delivery config: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get available payment methods from config
   */
  async getPaymentMethods(moduleId?: number, zoneId?: number, orderType?: string): Promise<{
    success: boolean;
    methods?: Array<{
      id: string;
      name: string;
      type: string;
      enabled: boolean;
    }>;
    partialPaymentEnabled?: boolean;
    partialPaymentMethod?: string;
    message?: string;
  }> {
    try {
      this.logger.log(`💳 Fetching payment methods from config (Module: ${moduleId}, Zone: ${zoneId}, OrderType: ${orderType})`);

      // Cash is parcel-only. Laravel refuses cash for every non-parcel order
      // before any store/zone/global check (PlaceNewOrder.php:124-132), so
      // handing cash back for food or shopping can only produce a 403 at
      // placement. Fail closed: the caller must say 'parcel' to get cash.
      const cashAllowed = orderType === 'parcel';

      const headers: any = {};
      if (moduleId) headers['moduleId'] = moduleId.toString();
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      // Use /api/v1/config endpoint which has payment info
      const response: any = await this.get('/api/v1/config', {}, headers);

      const methods: Array<{id: string; name: string; type: string; enabled: boolean}> = [];

      // Check if COD is enabled (and permitted for this order type at all)
      if (response?.cash_on_delivery === true && cashAllowed) {
        methods.push({
          id: 'cash_on_delivery',
          name: 'Cash on Delivery',
          type: 'cash',
          enabled: true,
        });
      }

      // Check if wallet is enabled
      if (response?.customer_wallet_status === 1) {
        methods.push({
          id: 'wallet',
          name: '👛 Wallet',
          type: 'wallet',
          enabled: true,
        });
      }

      // Check if digital payment is enabled and add active gateways
      if (response?.digital_payment === true && response?.active_payment_method_list) {
        for (const gateway of response.active_payment_method_list) {
          methods.push({
            id: 'digital_payment',
            name: gateway.gateway_title || '💳 Pay Online',
            type: 'digital',
            enabled: true,
          });
        }
      }

      // Store partial payment config
      const partialPaymentEnabled = response?.partial_payment_status === 1;
      const partialPaymentMethod = response?.partial_payment_method || 'none';

      // If no methods found, return defaults
      if (methods.length === 0) {
        this.logger.warn('No payment methods configured, using defaults');
        // The old default was cash-only, which is the worst possible fallback
        // for food/shopping: it offers the one method placement always rejects.
        return {
          success: true,
          methods: cashAllowed
            ? [
                {
                  id: 'cash_on_delivery',
                  name: 'Cash on Delivery',
                  type: 'cash',
                  enabled: true,
                },
              ]
            : [
                {
                  id: 'digital_payment',
                  name: '💳 Pay Online',
                  type: 'digital',
                  enabled: true,
                },
              ],
        };
      }

      this.logger.log(`✅ Found ${methods.length} active payment methods: ${methods.map(m => m.name).join(', ')}`);

      return {
        success: true,
        methods,
        partialPaymentEnabled,
        partialPaymentMethod,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch payment methods: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Initialize Razorpay payment
   * Constructs the PHP payment-mobile URL which creates a PaymentRequest
   * record in the database and redirects the user to the Razorpay payment page.
   * 
   * Flow: User clicks link → PHP PaymentController::payment() runs →
   *   Creates PaymentRequest record → Redirects to /payment/razor-pay/pay?payment_id={uuid} →
   *   RazorPayController::index() renders Razorpay checkout → User pays →
   *   PHP handles callback and updates order status
   */
  async initializeRazorpay(
    token: string,
    orderId: number,
    amount: number,
    customerId?: number,
  ): Promise<{
    success: boolean;
    paymentLink?: string;
    razorpayOrderId?: string;
    paymentRequestId?: string;
    message?: string;
  }> {
    try {
      this.logger.log(`💳 Initializing Razorpay payment for order ${orderId}, amount: ₹${amount}, customerId: ${customerId}`);

      // The correct PHP flow for payment is:
      // GET /payment-mobile?order_id=X&customer_id=Y&payment_method=razor_pay&payment_platform=web
      // This endpoint (PaymentController::payment()):
      //   1. Looks up the order and customer
      //   2. Creates a PaymentRequest record via Payment::generate_link()
      //   3. Redirects to /payment/razor-pay/pay?payment_id={uuid}
      //   4. RazorPayController::index() loads the Razorpay checkout page
      //
      // We just need to construct this URL and send it to the user.

      if (!customerId) {
        // Try to get customer ID from the order details
        try {
          const orderDetails: any = await this.authenticatedRequest(
            'get',
            '/api/v1/customer/order/details',
            token,
            { order_id: orderId },
          );
          customerId = orderDetails?.user_id;
          this.logger.debug(`Got customerId from order details: ${customerId}`);
        } catch (e) {
          this.logger.warn(`Could not fetch order details to get customerId: ${e.message}`);
        }
      }

      if (!customerId) {
        this.logger.error('❌ Cannot create payment link without customerId');
        return {
          success: false,
          message: 'Customer ID not available for payment link generation',
        };
      }

      // Construct the payment-mobile URL
      // When the user clicks this, PHP creates PaymentRequest + redirects to Razorpay
      const paymentLink = `${this.baseUrl}/payment-mobile?order_id=${orderId}&customer_id=${customerId}&payment_method=razor_pay&payment_platform=web`;

      this.logger.log(`✅ Payment link generated: ${paymentLink}`);

      return {
        success: true,
        paymentLink,
        razorpayOrderId: `order_${orderId}`,
      };
    } catch (error) {
      this.logger.error(`Failed to initialize Razorpay: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Verify Razorpay payment
   */
  async verifyRazorpayPayment(
    token: string,
    orderId: number,
    paymentId: string,
    signature: string,
  ): Promise<{
    success: boolean;
    verified?: boolean;
    message?: string;
  }> {
    try {
      this.logger.log(`🔐 Verifying Razorpay payment: ${paymentId}`);

      // This would typically verify the payment signature with Razorpay
      // The PHP backend should handle this
      const response: any = await this.authenticatedRequest(
        'post',
        '/api/v1/customer/order/verify-payment',
        token,
        {
          order_id: orderId,
          payment_id: paymentId,
          signature: signature,
        },
      );

      this.logger.log('✅ Payment verified');

      return {
        success: true,
        verified: response.verified === true,
      };
    } catch (error) {
      this.logger.error(`Failed to verify payment: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Update offline payment information
   */
  async updateOfflinePayment(
    token: string,
    orderId: number,
    paymentInfo: {
      method: string;
      transactionId?: string;
      note?: string;
    },
  ): Promise<{
    success: boolean;
    message?: string;
  }> {
    try {
      this.logger.log(`💰 Updating offline payment for order ${orderId}`);

      await this.authenticatedRequest('put', '/api/v1/customer/order/offline-payment', token, {
        order_id: orderId,
        payment_method: paymentInfo.method,
        transaction_id: paymentInfo.transactionId,
        note: paymentInfo.note,
      });

      this.logger.log('✅ Offline payment updated');

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update offline payment: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Get payment method emoji
   */
  getPaymentMethodEmoji(method: string): string {
    switch (method) {
      case 'cash_on_delivery':
        return '💵';
      case 'digital_payment':
        return '💳';
      case 'wallet':
        return '👛';
      case 'offline_payment':
        return '🏦';
      default:
        return '💰';
    }
  }

  /**
   * Format payment method for display
   */
  formatPaymentMethod(method: string): string {
    const methodMap: { [key: string]: string } = {
      cash_on_delivery: 'Cash on Delivery',
      digital_payment: 'Online Payment (Razorpay)',
      wallet: 'Wallet',
      offline_payment: 'Offline Payment',
    };
    return methodMap[method] || method;
  }

  /**
   * Get surge price for current time/zone/module
   * POST /api/v1/customer/order/get-surge-price
   * Requires auth token — PHP endpoint returns 401 without it.
   */
  async getSurgePrice(zoneId: number, moduleId: number, token?: string): Promise<{
    success: boolean;
    hasSurge?: boolean;
    title?: string;
    customerNote?: string;
    price?: number;
    priceType?: 'fixed' | 'percent';
    message?: string;
  }> {
    try {
      const body = {
        zone_id: zoneId,
        module_id: moduleId,
        date_time: new Date().toISOString(),
      };

      const response: any = token
        ? await this.authenticatedRequest('post', '/api/v1/customer/order/get-surge-price', token, body)
        : await this.post('/api/v1/customer/order/get-surge-price', body);

      const hasSurge = response && parseFloat(response.price || 0) > 0;
      return {
        success: true,
        hasSurge,
        title: response?.title || '',
        customerNote: response?.customer_note || '',
        price: parseFloat(response?.price || 0),
        priceType: response?.price_type || 'fixed',
      };
    } catch (error) {
      this.logger.warn(`Surge price check failed (non-blocking): ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}
