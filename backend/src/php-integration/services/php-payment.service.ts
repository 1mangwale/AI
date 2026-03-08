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

      const response: any = await this.post('/api/v1/customer/order/get-Tax', {
        items: cartData.items,
        delivery_charge: cartData.deliveryCharge,
        distance: cartData.distance,
      }, headers);

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
   * Get zone-specific delivery fee configuration from PHP.
   *
   * PHP's /api/v1/config does NOT return a `delivery_management` key.
   * Instead, delivery rates come from the zone-module pivot table, fetched
   * via /api/v1/config/get-zone-id. The zone executor now extracts these
   * rates into context.data.delivery_zone.delivery_rates.
   *
   * This method is kept as a fallback: it calls /api/v1/config and reads
   * the top-level `parcel_per_km_shipping_charge` / `admin_free_delivery`
   * fields (the only delivery-related fields in that endpoint).
   */
  async getDeliveryConfig(zoneId: number, moduleId: number = 4): Promise<{
    success: boolean;
    minCharge?: number;
    perKmCharge?: number;
    maxCharge?: number | null;
    freeDeliveryOverAmount?: number;
    freeDeliveryDistance?: number;
    additionalCharge?: number;
    additionalChargeName?: string;
    message?: string;
  }> {
    try {
      this.logger.debug(`📦 Fetching delivery config for zone ${zoneId}, module ${moduleId}`);

      const headers: any = {
        moduleId: String(moduleId),
        zoneId: JSON.stringify([zoneId]),
      };

      const response: any = await this.get('/api/v1/config', {}, headers);

      // PHP config returns global parcel rates + admin free delivery at top level
      const adminFreeDelivery = response?.admin_free_delivery || {};
      const freeOverAmount = adminFreeDelivery.status
        ? parseFloat(adminFreeDelivery.free_delivery_over || 0)
        : 0;

      // For parcel module, use the global parcel rates from config
      if (moduleId === 3) {
        return {
          success: true,
          perKmCharge: parseFloat(response?.parcel_per_km_shipping_charge ?? 11.5),
          minCharge: parseFloat(response?.parcel_minimum_shipping_charge ?? 40),
          maxCharge: null,
          freeDeliveryOverAmount: freeOverAmount,
          freeDeliveryDistance: 0,
          additionalCharge: response?.additional_charge_status === 1 ? parseFloat(response?.additional_charge ?? 0) : 0,
          additionalChargeName: response?.additional_charge_name || '',
        };
      }

      // For food/ecom: config endpoint doesn't have per-module rates.
      // Return success=false so caller uses zone pivot data from delivery_rates instead.
      this.logger.debug(`Config endpoint has no per-module delivery rates for module ${moduleId} — use zone pivot data`);
      return {
        success: false,
        freeDeliveryOverAmount: freeOverAmount,
        additionalCharge: response?.additional_charge_status === 1 ? parseFloat(response?.additional_charge ?? 0) : 0,
        additionalChargeName: response?.additional_charge_name || '',
        message: 'Use zone pivot delivery_rates for food/ecom modules',
      };
    } catch (error) {
      this.logger.warn(`Failed to fetch delivery config: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get available payment methods from config
   */
  async getPaymentMethods(moduleId?: number, zoneId?: number): Promise<{
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
      this.logger.log(`💳 Fetching payment methods from config (Module: ${moduleId}, Zone: ${zoneId})`);

      const headers: any = {};
      if (moduleId) headers['moduleId'] = moduleId.toString();
      if (zoneId) headers['zoneId'] = JSON.stringify([zoneId]);

      // Use /api/v1/config endpoint which has payment info
      const response: any = await this.get('/api/v1/config', {}, headers);

      const methods: Array<{id: string; name: string; type: string; enabled: boolean}> = [];

      // Check if COD is enabled
      if (response?.cash_on_delivery === true) {
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
        return {
          success: true,
          methods: [
            {
              id: 'cash_on_delivery',
              name: 'Cash on Delivery',
              type: 'cash',
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
    priceType?: 'amount' | 'percent';
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

  /**
   * Generate UPI deep link for in-chat payment
   * Creates a `upi://pay` URI that opens UPI apps (GPay, PhonePe, Paytm)
   */
  generateUpiLink(params: {
    orderId: string | number;
    amount: number;
    merchantVpa?: string;
    merchantName?: string;
  }): string {
    const vpa = params.merchantVpa || this.configService.get('MERCHANT_UPI_VPA') || '';
    const name = params.merchantName || 'Mangwale';
    const txnRef = `MNG${params.orderId}`;

    if (!vpa) {
      this.logger.warn('MERCHANT_UPI_VPA not configured — UPI link will not work');
    }

    const upiParams = new URLSearchParams({
      pa: vpa,
      pn: name,
      am: String(params.amount),
      tr: txnRef,
      tn: `Order ${params.orderId}`,
      cu: 'INR',
    });

    return `upi://pay?${upiParams.toString()}`;
  }
}
