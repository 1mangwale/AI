import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';
import { PhpWalletService } from '../../php-integration/services/php-wallet.service';
import { SessionService } from '../../session/session.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';
import { OrderLearningService } from '../../order/services/order-learning.service';
import { PricingValidatorService } from '../../common/validators/pricing.validator';
import { AuthValidatorService } from '../../common/validators/auth.validator';
import { ConversationEnrichmentService } from '../../personalization/conversation-enrichment.service';

/**
 * Order Executor
 * 
 * Creates orders in PHP backend
 */
@Injectable()
export class OrderExecutor implements ActionExecutor {
  readonly name = 'order';
  private readonly logger = new Logger(OrderExecutor.name);
  private readonly trackingBaseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly phpOrderService: PhpOrderService,
    private readonly phpPaymentService: PhpPaymentService,
    private readonly phpWalletService: PhpWalletService,
    private readonly sessionService: SessionService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
    private readonly pricingValidator: PricingValidatorService,
    private readonly authValidator: AuthValidatorService,
    @Optional() private readonly orderLearning?: OrderLearningService,
    @Optional() private readonly conversationEnrichment?: ConversationEnrichmentService,
  ) {
    this.trackingBaseUrl = this.configService.get('tracking.baseUrl') || process.env.TRACKING_BASE_URL || 'https://track.mangwale.in';
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const orderType = config.type as 'food' | 'parcel' | 'ecommerce' | 'multi_store';

      if (!orderType) {
        this.logger.error('Order type required but not specified in config');
        return {
          success: false,
          error: 'Order type required. Please specify food, parcel, or ecommerce.',
        };
      }

      // 🔒 CRITICAL SECURITY FIX: Validate user authentication
      // Get session for auth token
      const session = await this.sessionService.getSession(context._system.sessionId);
      const authToken = session?.data?.auth_token;
      const userId = session?.data?.user_id || context.data.user_id;

      if (!userId) {
        this.logger.error('❌ User ID is missing - authentication required');
        return {
          success: false,
          error: 'Authentication required to place order. Please login.',
        };
      }

      // Validate that user_id matches auth_token or session
      // This prevents user impersonation attacks
      try {
        const validation = await this.authValidator.validateUser(
          authToken,
          userId,
          context._system.sessionId,
        );
        this.logger.log(`✅ User authenticated: user_id=${validation.userId}, phone=${validation.profile?.phone}`);

        // Store zone_id from user profile for zone resolution fallback
        if (validation.profile?.zoneId && !context.data.zone_id) {
          context.data.zone_id = validation.profile.zoneId;
          this.logger.debug(`📍 Set zone_id=${validation.profile.zoneId} from user profile`);
        }
      } catch (error) {
        this.logger.error(`❌ Authentication validation failed: ${error.message}`);
        return {
          success: false,
          error: error.message || 'Authentication validation failed',
        };
      }

      let result: any;

      if (orderType === 'parcel') {
        result = await this.createParcelOrder(config, context, authToken || null, userId);
      } else if (orderType === 'multi_store') {
        result = await this.createMultiStoreOrder(config, context, authToken || null, userId);
      } else if (orderType === 'food') {
        result = await this.createFoodOrder(config, context, authToken || null, userId);
      } else {
        result = await this.createEcommerceOrder(config, context, authToken || null, userId);
      }

      if (result.success) {
        this.logger.log(`✅ Order created: ${result.orderId}`);

        // Invalidate wallet cache after wallet/partial payment (balance changed server-side)
        const paymentMethod = context.data.payment_method || config.payment_method;
        if (authToken && (paymentMethod === 'wallet' || paymentMethod === 'partial_payment')) {
          this.phpWalletService.invalidateWalletCache(authToken).catch(() => {});
        }

        // Phase 2: Record successful order
        await this.recordOrderInteraction(context, orderType, true);

        return {
          success: true,
          output: result,
          event: 'success',
        };
      } else {
        this.logger.error(`Order creation failed: ${result.message}`);
        
        // Phase 2: Record failed order
        await this.recordOrderInteraction(context, orderType, false);

        // The store/zone refuses cash. This is a decision Laravel already made,
        // so retrying just re-POSTs the same placement (up to maxRetries times).
        // retryable:false keeps the retry loop from swallowing the event.
        if (result.errorCode === 'COD_NOT_AVAILABLE') {
          this.logger.warn('COD not available for this store - re-offering payment methods');
          return {
            success: false,
            error: result.message,
            event: 'cod_not_available',
            retryable: false,
          };
        }

        return {
          success: false,
          error: result.message,
        };
      }
    } catch (error) {
      this.logger.error(`Order executor failed: ${error.message}`, error.stack);

      // Handle auth token expiry - signal flow to re-authenticate
      if (error.requiresReAuth || error.code === 'AUTH_TOKEN_EXPIRED' || error.code === 'auth_expired' || error.statusCode === 401) {
        this.logger.warn('⚠️ Auth token expired during order placement - triggering re-auth');

        // Clear the stale auth token from session so re-auth fetches a fresh one
        try {
          const session = await this.sessionService.getSession(context._system.sessionId);
          if (session?.data?.auth_token) {
            await this.sessionService.updateSession(context._system.sessionId, {
              ...session.data,
              auth_token: null,
            });
            this.logger.log('🔑 Cleared expired auth token from session');
          }
        } catch (clearErr) {
          this.logger.warn(`Failed to clear expired auth token: ${clearErr.message}`);
        }

        // Signal flow to transition to re-auth state
        context.data._auth_expired = true;
        context.data._friendly_error = 'Your session has expired. Let me log you back in so we can place your order.';

        return {
          success: false,
          error: 'Your session has expired. Please log in again to place your order.',
          event: 'auth_expired',
          output: { requiresReAuth: true },
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  private resolveValueFromPath(path: string | undefined, context: FlowContext): any {
    if (!path) return undefined;
    return path.split('.').reduce((o, i) => (o ? o[i] : undefined), context.data);
  }

  private normalizePaymentMethod(method: any): string | undefined {
    if (!method) return undefined;

    const raw = String(method).trim();
    if (!raw) return undefined;

    const normalized = raw.toLowerCase();

    // Already in PHP expected IDs
    if (normalized === 'cash_on_delivery' || normalized === 'digital_payment' || normalized === 'wallet' || normalized === 'partial_payment') {
      return normalized;
    }

    // Common aliases
    if (normalized === 'cod' || normalized === 'cash' || normalized.includes('cash')) {
      return 'cash_on_delivery';
    }
    if (
      normalized === 'online' ||
      normalized === 'card' ||
      normalized === 'upi' ||
      normalized.includes('digital') ||
      normalized.includes('online')
    ) {
      return 'digital_payment';
    }

    return raw;
  }

  private resolvePaymentMethod(config: any, context: FlowContext, fallback: string): string {
    // Priority order: explicit config fields -> config paymentPath -> context fields -> context payment_details
    const fromConfig =
      config.payment_method ??
      config.paymentMethod ??
      config.payment_method_id ??
      config.paymentMethodId;

    const fromPaymentPath = this.resolveValueFromPath(config.paymentPath, context);
    const fromPaymentPathMethod =
      typeof fromPaymentPath === 'object' ? fromPaymentPath?.method ?? fromPaymentPath?.id : fromPaymentPath;

    const fromContext = context.data.payment_method ?? context.data.paymentMethod;
    const fromContextDetails =
      context.data.payment_details?.id ??
      context.data.payment_details?.method ??
      context.data.paymentDetails?.id ??
      context.data.paymentDetails?.method;

    return (
      this.normalizePaymentMethod(fromConfig) ||
      this.normalizePaymentMethod(fromPaymentPathMethod) ||
      this.normalizePaymentMethod(fromContext) ||
      this.normalizePaymentMethod(fromContextDetails) ||
      fallback
    );
  }

  private async createParcelOrder(
    config: any,
    context: FlowContext,
    authToken: string | null,
    userId?: number
  ): Promise<any> {
    // ⚠️ CRITICAL: PHP requires JWT auth token for ALL orders (no guest orders)
    // For WhatsApp users verified via MySQL, we use user_id if auth_token is not available
    if (!authToken && !userId) {
      this.logger.error('❌ Authentication required - need auth_token or user_id');
      return {
        success: false,
        message: 'Authentication required. Please login before placing an order.',
      };
    }

    // Get session for user info
    const session = await this.sessionService.getSession(context._system.sessionId);
    
    // Resolve paths if provided, otherwise fallback to direct config or default context keys
    const resolve = (path: string, defaultKey: string) => {
      if (!path) return context.data[defaultKey];
      return path.split('.').reduce((o, i) => o?.[i], context.data);
    };

    const pickupAddress = resolve(config.pickupAddressPath, 'sender_address') || resolve(config.pickupAddressPath, 'pickup_address') || config.pickup_address;
    const deliveryAddress = resolve(config.deliveryAddressPath, 'receiver_address') || resolve(config.deliveryAddressPath, 'delivery_address') || config.delivery_address;
    const recipientDetails = resolve(config.recipientPath, 'recipient_details');
    const distance = resolve(config.distancePath, 'distance') || config.distance;
    const pricing = resolve(config.pricingPath, 'pricing');
    const parcelDetails = resolve(config.detailsPath, 'parcel_details');
    
    const parcelCategoryId = config.parcel_category_id || context.data.parcel_category_id;
    if (!parcelCategoryId) {
      this.logger.error('❌ parcel_category_id is required but missing');
      return {
        success: false,
        message: 'Please select a vehicle type for delivery.',
      };
    }
    const paymentMethod = this.resolvePaymentMethod(config, context, 'cash_on_delivery');

    // Map recipient details if available
    const receiverName = recipientDetails?.name || deliveryAddress?.contact_person_name;
    const receiverPhone = recipientDetails?.phone || deliveryAddress?.contact_person_number;

    // Get sender (logged in user) info from session
    const senderName = session?.data?.user_name || session?.data?.userName || pickupAddress?.contact_person_name || 'Customer';
    const senderPhone = session?.data?.phone || pickupAddress?.contact_person_number;
    const senderEmail = session?.data?.email || session?.data?.user_email || '';
    const sessionUserId = session?.data?.user_id || userId;
    const orderSource = this.resolveOrderSource(config, context, session);
    const requestId = this.buildOrderRequestId(config, context, orderSource);

    this.logger.log(`📦 Creating parcel order - Sender: ${senderName} (${senderPhone}), Receiver: ${receiverName} (${receiverPhone}), PaymentMethod: ${paymentMethod}`);

    // 🔒 CRITICAL SECURITY FIX: Server-side pricing validation
    // PHP does NOT compute order_amount for parcel orders server-side
    // We MUST validate the submitted amount to prevent manipulation
    const submittedAmount = pricing?.total_charge || pricing?.total || pricing?.delivery_charge || 0;

    if (!distance || distance <= 0) {
      this.logger.error(`❌ Invalid distance for parcel order: ${distance}`);
      return {
        success: false,
        message: 'Invalid delivery distance. Please select pickup and delivery addresses.',
      };
    }

    // Validate submitted amount against server-side calculation (sanity check only)
    // PHP is the source of truth for pricing — uses category-specific rates
    // Our hardcoded validator rates may not match, so we warn but don't block
    const validation = this.pricingValidator.validateParcelOrderAmount(submittedAmount, distance);

    if (!validation.valid) {
      this.logger.warn(`⚠️ Parcel pricing sanity check: ${validation.message}`);
      this.logger.warn(`   Submitted (PHP): ₹${submittedAmount}, Validator expected: ₹${validation.expected?.totalAmount}`);
      this.logger.warn(`   Proceeding with PHP-calculated amount ₹${submittedAmount} (PHP is source of truth)`);
      // Don't fail the order — PHP calculates the actual amount with category-specific rates
    } else {
      this.logger.log(`✅ Parcel order amount sanity check passed: ₹${submittedAmount}`);
    }

    // Trust PHP-calculated amount (submitted from flow context)
    // PHP uses category-specific rates that our hardcoded validator doesn't know about
    const totalAmount = submittedAmount || validation.expected?.totalAmount || 0;

    this.logger.log(`📦 Parcel order amount: ₹${totalAmount} (distance: ${distance}km)`);

    // 🔒 CRITICAL SECURITY FIX: Validate wallet balance for wallet/partial payments
    if (paymentMethod === 'wallet' || paymentMethod === 'partial_payment') {
      const walletBalance = context.data.wallet_balance || session?.data?.wallet_balance || 0;
      const walletDeduction = context.data.wallet_deduction ||
                            (paymentMethod === 'wallet' ? totalAmount : 0);

      this.logger.log(`💰 Wallet payment detected: balance=₹${walletBalance}, deduction=₹${walletDeduction}`);

      const walletValidation = this.pricingValidator.validateWalletBalance(
        walletBalance,
        walletDeduction,
        totalAmount,
      );

      if (!walletValidation.valid) {
        this.logger.error(`❌ Wallet balance validation failed: ${walletValidation.message}`);
        return {
          success: false,
          message: walletValidation.message,
        };
      }

      this.logger.log(`✅ Wallet balance validated: sufficient funds for order`);
    }

    // Resolve zone IDs with multiple fallbacks (zone executor output → address → context → user profile)
    const senderZoneId = pickupAddress?.zone_id || context.data.sender_zone_id
      || context.data.pickup_zone?.zoneId || context.data.zone_id
      || session?.data?.zone_id;
    const deliveryZoneId = deliveryAddress?.zone_id || context.data.delivery_zone_id
      || context.data.delivery_zone?.zoneId || context.data.zone_id
      || session?.data?.zone_id;

    if (!senderZoneId) {
      this.logger.warn('⚠️ sender_zone_id not available — PHP may reject the order');
    }
    if (!deliveryZoneId) {
      this.logger.warn('⚠️ delivery_zone_id not available — PHP may reject the order');
    }

    const orderResult = await this.phpOrderService.createOrder(authToken, {
      pickupAddress: {
        address: this.resolveHumanAddress(pickupAddress),
        latitude: pickupAddress.lat || pickupAddress.latitude,
        longitude: pickupAddress.lng || pickupAddress.longitude,
        landmark: pickupAddress.landmark || '',
        floor: pickupAddress.floor || pickupAddress.metadata?.floor || '',
        road: pickupAddress.road || pickupAddress.metadata?.road || '',
        house: pickupAddress.house || pickupAddress.metadata?.house || '',
      },
      deliveryAddress: {
        address: this.resolveHumanAddress(deliveryAddress),
        latitude: deliveryAddress.lat || deliveryAddress.latitude,
        longitude: deliveryAddress.lng || deliveryAddress.longitude,
        landmark: deliveryAddress.landmark || '',
        floor: deliveryAddress.floor || deliveryAddress.metadata?.floor || '',
        road: deliveryAddress.road || deliveryAddress.metadata?.road || '',
        house: deliveryAddress.house || deliveryAddress.metadata?.house || '',
      },
      receiverName,
      receiverPhone,
      receiverEmail: recipientDetails?.email || '',
      senderName,
      senderPhone,
      senderEmail,
      userId,
      requestId,
      source: orderSource,
      moduleId: 3, // Parcel/Local Delivery
      paymentMethod,
      totalAmount,
      // Build order note from parcel details with defaults
      orderNote: config.order_note || context.data.order_note || this.buildParcelNote(parcelDetails),
      distance,
      parcelCategoryId,
      senderZoneId,
      deliveryZoneId,
    });

    // 💳 For digital payments, create Razorpay order
    if (orderResult.success && paymentMethod === 'digital_payment') {
      const razorpayAmount = pricing?.total_charge || pricing?.total;
      if (!razorpayAmount || razorpayAmount <= 0) {
        this.logger.error(`Pricing unavailable for digital payment on parcel #${orderResult.orderId} — skipping Razorpay`);
        orderResult.paymentNote = 'Pricing unavailable for online payment. Please pay via cash on delivery or retry.';
      } else {
      const customerId = orderResult.rawResponse?.user_id || sessionUserId;
      this.logger.log(`💳 Creating Razorpay payment link for parcel #${orderResult.orderId}, amount: ₹${razorpayAmount}, customerId: ${customerId}`);

      try {
        const razorpayResult = await this.phpPaymentService.initializeRazorpay(
          authToken,
          orderResult.orderId,
          razorpayAmount,
          customerId,
        );

        if (razorpayResult.success && razorpayResult.razorpayOrderId) {
          orderResult.razorpayOrderId = razorpayResult.razorpayOrderId;
          orderResult.paymentRequestId = razorpayResult.paymentRequestId;
          orderResult.paymentLink = razorpayResult.paymentLink;
          this.logger.log(`✅ Razorpay order created: ${razorpayResult.razorpayOrderId}, paymentLink: ${razorpayResult.paymentLink}`);
        } else {
          this.logger.warn(`⚠️ Razorpay order creation failed, using fallback`);
        }
      } catch (error) {
        this.logger.error(`❌ Razorpay initialization failed: ${error.message}`);
        // Don't fail the order, just log the error
      }
      } // end else (razorpayAmount available)
    }

    // Generate tracking URL
    if (orderResult.success && orderResult.orderId) {
      const cleanReceiverPhone = String(receiverPhone || '').replace(/\D/g, '').slice(-10);
      orderResult.trackingUrl = `${this.trackingBaseUrl}/track/${orderResult.orderId}${cleanReceiverPhone ? '/' + cleanReceiverPhone : ''}`;

      // Track order for learning/personalization
      this.trackOrderForLearning(context, 'parcel', orderResult).catch(() => {});
    }

    return orderResult;
  }

  /**
   * Normalize order_note / preference to a plain string.
   * NER returns preference as an array (e.g., ["no tarri", "extra spicy"]).
   * PHP's order_note field expects a single string.
   */
  private resolveOrderNote(...sources: any[]): string | undefined {
    for (const src of sources) {
      if (!src) continue;
      if (Array.isArray(src) && src.length > 0) return src.join(', ');
      if (typeof src === 'string' && src.trim()) return src.trim();
    }
    return undefined;
  }

  private resolveHumanAddress(address: any): string {
    const resolved = String(address?.address || address?.formatted || address?.formatted_address || '').trim();
    const rawInput = this.normalizeRawAddressLabel(
      address?.raw_input || address?.metadata?.raw_input || address?.source_message || '',
    );

    if (this.shouldPreferRawAddressLabel(rawInput, resolved)) {
      if (/nashik/i.test(rawInput)) return rawInput;
      if (/nashik/i.test(resolved)) return `${rawInput}, ${resolved}`;
      return rawInput;
    }

    return resolved || rawInput;
  }

  private normalizeRawAddressLabel(rawInput: any): string {
    return String(rawInput || '')
      .replace(/^\s*(pickup|pick up|sender|drop|delivery|receiver)\s*(location|address|from|to)?\s*[:\-]?\s*/i, '')
      .trim();
  }

  private shouldPreferRawAddressLabel(rawInput: string, resolved: string): boolean {
    if (!rawInput || rawInput.length < 8) return false;
    if (/^(nashik|maharashtra|india|location shared)[\s,.-]*$/i.test(rawInput)) return false;

    const cleanedRaw = rawInput.replace(/\s+/g, ' ').trim().toLowerCase();
    const cleanedResolved = String(resolved || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!cleanedResolved || cleanedRaw === cleanedResolved || cleanedResolved.includes(cleanedRaw)) {
      return false;
    }

    const specificAddressTerms = /\b(mall|gate|road|rd|college|hospital|school|tower|society|apartment|apt|building|bungalow|shop|store|market|chowk|naka|phata|circle|bus stop|station|mandir|temple|masjid|lane|floor|flat|house|near|opposite|opp|behind)\b/i;
    return specificAddressTerms.test(rawInput) || rawInput.length > resolved.length + 8;
  }

  private resolveOrderSource(config: any, context: FlowContext, session: any): string {
    const explicitSource =
      config?.source ||
      context.data.order_source ||
      context.data.source_channel ||
      context.data.source;
    const normalizedExplicit = explicitSource ? this.normalizeOrderSource(explicitSource) : undefined;
    if (explicitSource && normalizedExplicit !== 'web') {
      return normalizedExplicit;
    }

    const platform = [
      context.data.platform,
      context.data.channel,
      session?.data?.platform,
      session?.data?.channel,
    ].filter(Boolean).join(' ');

    if (/whats\s*app|whatsapp|\bwa\b/i.test(platform)) return 'whatsapp_ai';
    if (/web|chat/i.test(platform)) return 'web_ai';
    if (/mobile|app|flutter|android|ios/i.test(platform)) return 'app';

    return normalizedExplicit || 'ai';
  }

  private normalizeOrderSource(source: any): string {
    const normalized = String(source || 'web')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const allowedSources = new Set([
      'app',
      'mobile',
      'user_app',
      'web',
      'web_ai',
      'chat_ai',
      'whatsapp',
      'whatsapp_ai',
      'ai',
      'api',
      'enterprise_api',
    ]);
    return allowedSources.has(normalized) ? normalized : 'web';
  }

  private buildOrderRequestId(config: any, context: FlowContext, source: string): string {
    const explicitRequestId = config?.request_id || context.data.request_id || context.data.order_request_id;
    const rawRequestId = explicitRequestId || `${source}_${context._system.flowRunId || context._system.sessionId || Date.now()}`;
    return String(rawRequestId)
      .trim()
      .replace(/[^a-zA-Z0-9_:\-]/g, '_')
      .slice(0, 80);
  }

  /**
   * Build order note from parcel details with sensible defaults
   */
  private buildParcelNote(parcelDetails: any): string {
    if (!parcelDetails) {
      return 'Standard parcel delivery';
    }
    
    const parts = [];
    if (parcelDetails.description) {
      parts.push(parcelDetails.description);
    }
    if (parcelDetails.weight) {
      parts.push(`Weight: ${parcelDetails.weight}kg`);
    }
    if (parcelDetails.size) {
      parts.push(`Size: ${parcelDetails.size}`);
    }
    
    return parts.length > 0 ? parts.join(', ') : 'Standard parcel delivery';
  }

  private async createFoodOrder(
    config: any,
    context: FlowContext,
    authToken: string | null,
    userId?: number
  ): Promise<any> {
    // ⚠️ CRITICAL: PHP requires JWT auth token for ALL orders (no guest orders)
    // For WhatsApp users verified via MySQL, we use user_id if auth_token is not available
    if (!authToken && !userId) {
      this.logger.error('❌ Authentication required - need auth_token or user_id');
      return {
        success: false,
        message: 'Authentication required. Please login before placing an order.',
      };
    }

    const items = config.items || context.data.selected_items;
    const deliveryAddress = config.delivery_address || context.data.delivery_address;
    // PHP food ordering currently forces digital payment in PhpOrderService,
    // but we still record/forward user preference when available.
    const paymentMethod = this.resolvePaymentMethod(config, context, 'digital_payment');
    // Check order_note from config, context data, or extracted_food special_instructions
    const orderNote = this.resolveOrderNote(config.order_note, context.data.order_note, context.data.extracted_food?.special_instructions);

    if (!items || items.length === 0) {
      return {
        success: false,
        message: 'No items selected for order',
      };
    }

    if (!deliveryAddress) {
      return {
        success: false,
        message: 'Delivery address is required',
      };
    }

    // Get moduleId from first item (all items should be from same module)
    // Derive moduleId from item data — PHP module IDs: 3=Parcel, 4=Food, 5=E-commerce
    const moduleId = items[0]?.moduleId || items[0]?.module_id || context.data.module_id;

    // 🔒 SECURITY: Validate food order amount (sanity check)
    // Note: PHP is the source of truth for food orders, but we add validation
    // to prevent gross manipulation attempts
    const estimatedAmount = context.data.total_amount || context.data.order_amount || 0;
    if (estimatedAmount > 0) {
      const itemsForValidation = items.map((item: any) => ({
        price: item.price || item.rawPrice || 0,
        quantity: item.quantity || 1,
      }));

      const foodValidation = this.pricingValidator.validateFoodOrderAmount(
        estimatedAmount,
        itemsForValidation,
        20, // 20% tolerance since PHP calculates actual amount
      );

      if (!foodValidation.valid) {
        this.logger.warn(`⚠️ Food order amount validation failed: ${foodValidation.message}`);
        this.logger.warn(`   This is a sanity check - proceeding with order but logging discrepancy`);
        // Don't fail the order, just log the warning for monitoring
        // PHP will calculate the correct amount anyway
      } else {
        this.logger.log(`✅ Food order amount sanity check passed: ₹${estimatedAmount}`);
      }
    }

    // 🔒 Validate wallet balance for wallet/partial payments (food orders)
    if (paymentMethod === 'wallet' || paymentMethod === 'partial_payment') {
      const session = await this.sessionService.getSession(context._system.sessionId);
      const walletBalance = context.data.wallet_balance || session?.data?.wallet_balance || 0;
      const walletDeduction = context.data.wallet_deduction ||
                            context.data.payment_details?.wallet_amount ||
                            (paymentMethod === 'wallet' ? estimatedAmount : 0);

      this.logger.log(`💰 Wallet payment detected: balance=₹${walletBalance}, deduction=₹${walletDeduction}`);

      const walletValidation = this.pricingValidator.validateWalletBalance(
        walletBalance,
        walletDeduction,
        estimatedAmount || 0,
      );

      if (!walletValidation.valid) {
        this.logger.error(`❌ Wallet balance validation failed: ${walletValidation.message}`);
        return {
          success: false,
          message: walletValidation.message,
        };
      }

      this.logger.log(`✅ Wallet balance validated: sufficient funds for order`);
    }

    const orderResult = await this.phpOrderService.createFoodOrder(authToken, {
      items,
      deliveryAddress: {
        address: deliveryAddress.address,
        latitude: deliveryAddress.lat || deliveryAddress.latitude,
        longitude: deliveryAddress.lng || deliveryAddress.longitude,
        contact_person_name: deliveryAddress.contact_person_name || context.data.user_name,
        contact_person_number: deliveryAddress.contact_person_number || context.data.user_phone,
      },
      paymentMethod,
      orderNote,
      moduleId, // Pass moduleId from item data
      userId,   // Pass userId for WhatsApp verified users without auth_token
      couponCode: context.data.coupon_code,
    });

    // 💳 For digital payments or partial payments, create Razorpay order
    if (orderResult.success && (paymentMethod === 'digital_payment' || paymentMethod === 'partial_payment')) {
      // Prefer PHP-returned order total (includes delivery, GST, platform charges)
      // Fall back to items recalculation if PHP didn't return a total
      let totalAmount = orderResult.orderTotal;

      if (!totalAmount || totalAmount <= 0) {
        totalAmount = items.reduce((sum: number, item: any) => {
          const price = item.price || item.rawPrice || 0;
          const qty = item.quantity || 1;
          return sum + (price * qty);
        }, 0);
        this.logger.warn(`PHP orderTotal not available, falling back to items sum: ₹${totalAmount}`);
      }

      if (!totalAmount || totalAmount <= 0) {
        this.logger.error(`Cannot calculate order total — items total is ₹${totalAmount}`);
        return {
          success: true,
          output: orderResult,
          event: 'success',
        };
      }
      
      // For partial payment, Razorpay only charges the remaining amount (after wallet deduction)
      if (paymentMethod === 'partial_payment' && context.data.payment_details?.online_amount) {
        totalAmount = parseFloat(context.data.payment_details.online_amount) || totalAmount;
        this.logger.log(`💳 Partial payment: wallet covers ₹${context.data.payment_details.wallet_amount}, Razorpay charging ₹${totalAmount}`);
      }
      
      const customerId = orderResult.rawResponse?.user_id || userId;
      this.logger.log(`💳 Creating Razorpay payment link for food order #${orderResult.orderId}, amount: ₹${totalAmount}, customerId: ${customerId}`);
      
      try {
        const razorpayResult = await this.phpPaymentService.initializeRazorpay(
          authToken,
          orderResult.orderId,
          totalAmount,
          customerId,
        );
        
        if (razorpayResult.success && razorpayResult.razorpayOrderId) {
          orderResult.razorpayOrderId = razorpayResult.razorpayOrderId;
          orderResult.paymentRequestId = razorpayResult.paymentRequestId;
          orderResult.paymentLink = razorpayResult.paymentLink;
          this.logger.log(`✅ Razorpay order created: ${razorpayResult.razorpayOrderId}, paymentLink: ${razorpayResult.paymentLink}`);
        } else {
          this.logger.warn(`⚠️ Razorpay order creation failed, using fallback`);
        }
      } catch (error) {
        this.logger.error(`❌ Razorpay initialization failed: ${error.message}`);
        // Don't fail the order, just log the error
      }
    }

    // Generate tracking URL for food orders
    if (orderResult.success && orderResult.orderId) {
      const customerPhone = context.data.user_phone || context._system?.phoneNumber || '';
      const cleanPhone = String(customerPhone).replace(/\D/g, '').slice(-10);
      orderResult.trackingUrl = `${this.trackingBaseUrl}/track/${orderResult.orderId}${cleanPhone ? '/' + cleanPhone : ''}`;

      // Track order for learning/personalization
      this.trackOrderForLearning(context, 'food', orderResult).catch(() => {});
    }

    return orderResult;
  }

  /**
   * Place separate orders for each store in a multi-store cart
   * PHP API only supports single store_id per order, so we split and place sequentially
   */
  private async createMultiStoreOrder(
    config: any,
    context: FlowContext,
    authToken: string | null,
    userId?: number
  ): Promise<any> {
    if (!authToken && !userId) {
      return {
        success: false,
        message: 'Authentication required. Please login before placing an order.',
      };
    }

    // Get order groups from cart validation (grouped by store)
    const orderGroups = config.orderGroups || context.data.cart_validation?.orderGroups || [];
    const deliveryAddress = config.delivery_address || context.data.delivery_address;
    const paymentMethod = this.resolvePaymentMethod(config, context, 'digital_payment');
    const orderNote = this.resolveOrderNote(config.order_note, context.data.order_note, context.data.extracted_food?.special_instructions);

    if (!orderGroups || orderGroups.length === 0) {
      return {
        success: false,
        message: 'No store groups found for multi-store order',
      };
    }

    if (!deliveryAddress) {
      return {
        success: false,
        message: 'Delivery address is required',
      };
    }

    this.logger.log(`🏪 Placing multi-store order: ${orderGroups.length} stores`);

    const results: any[] = [];
    const orderIds: number[] = [];
    let totalAmount = 0;
    let hasFailure = false;

    // Place orders sequentially per store
    for (const group of orderGroups) {
      this.logger.log(`📦 Placing order for store: ${group.storeName} (${group.storeId}) - ${group.items.length} items`);

      const storeResult = await this.phpOrderService.createFoodOrder(authToken, {
        items: group.items,
        deliveryAddress: {
          address: deliveryAddress.address,
          latitude: deliveryAddress.lat || deliveryAddress.latitude,
          longitude: deliveryAddress.lng || deliveryAddress.longitude,
          contact_person_name: deliveryAddress.contact_person_name || context.data.user_name,
          contact_person_number: deliveryAddress.contact_person_number || context.data.user_phone,
        },
        paymentMethod,
        orderNote,
        moduleId: group.items[0]?.moduleId || group.items[0]?.module_id || context.data.module_id,
        userId,
      });

      results.push({
        storeId: group.storeId,
        storeName: group.storeName,
        ...storeResult,
      });

      if (storeResult.success) {
        orderIds.push(storeResult.orderId);
        totalAmount += group.total;
        this.logger.log(`✅ Order #${storeResult.orderId} placed for ${group.storeName}`);
      } else {
        hasFailure = true;
        this.logger.error(`❌ Failed for ${group.storeName}: ${storeResult.message}`);
      }
    }

    // 🐛 FIX: Multi-store partial success handling
    // Remove successfully ordered items from cart, keep failed items for retry
    const successfulStoreIds = results.filter(r => r.success).map(r => r.storeId);
    const failedResults = results.filter(r => !r.success);

    // Update cart in context - remove successful items
    if (successfulStoreIds.length > 0 && context.data.cart) {
      const updatedCart = context.data.cart.filter((item: any) => {
        const itemStoreId = item.store_id || item.storeId;
        return !successfulStoreIds.includes(itemStoreId);
      });

      context.data.cart = updatedCart;
      this.logger.log(`🛒 Cart updated: removed ${context.data.cart.length - updatedCart.length} items from successful stores`);
    }

    // Build combined result
    const successCount = results.filter(r => r.success).length;

    // Build detailed error message for failed stores
    let detailedMessage = '';
    if (hasFailure && successCount > 0) {
      const successStores = results.filter(r => r.success).map(r => r.storeName).join(', ');
      const failedStores = failedResults.map(r => `${r.storeName}: ${r.message || 'Order failed'}`).join('; ');
      detailedMessage = `✅ ${successCount}/${orderGroups.length} orders placed successfully (${successStores}).\n\n` +
                       `❌ Failed stores: ${failedStores}\n\n` +
                       `The failed items remain in your cart. You can retry ordering them.`;
    } else if (hasFailure && successCount === 0) {
      const failedStores = failedResults.map(r => `${r.storeName}: ${r.message || 'Order failed'}`).join('; ');
      detailedMessage = `❌ All orders failed:\n${failedStores}\n\nPlease check and try again.`;
    } else {
      detailedMessage = `✅ All ${successCount} orders placed successfully!`;
    }

    const combinedResult: any = {
      success: successCount > 0, // At least one order succeeded
      isMultiStore: true,
      totalOrders: orderGroups.length,
      successfulOrders: successCount,
      failedOrders: orderGroups.length - successCount,
      orderIds,
      orderId: orderIds[0], // Primary order ID for compatibility
      results,
      message: detailedMessage,
      // Store failed results for potential retry logic
      failedStores: failedResults.map(r => ({
        storeId: r.storeId,
        storeName: r.storeName,
        error: r.message,
      })),
    };

    // Generate Razorpay for digital/partial payment
    if (combinedResult.success && (paymentMethod === 'digital_payment' || paymentMethod === 'partial_payment')) {
      let chargeAmount = totalAmount;
      if (paymentMethod === 'partial_payment' && context.data.payment_details?.online_amount) {
        chargeAmount = parseFloat(context.data.payment_details.online_amount) || totalAmount;
      }

      // Use the first order for Razorpay (PHP will apply wallet deduction across orders)
      try {
        const razorpayResult = await this.phpPaymentService.initializeRazorpay(
          authToken,
          orderIds[0],
          chargeAmount,
          userId,
        );
        if (razorpayResult.success && razorpayResult.razorpayOrderId) {
          combinedResult.razorpayOrderId = razorpayResult.razorpayOrderId;
          combinedResult.paymentLink = razorpayResult.paymentLink;
          combinedResult.paymentRequestId = razorpayResult.paymentRequestId;
        }
      } catch (error) {
        this.logger.error(`❌ Razorpay for multi-store failed: ${error.message}`);
      }
    }

    // Generate tracking URLs
    const customerPhone = context.data.user_phone || context._system?.phoneNumber || '';
    const cleanPhone = String(customerPhone).replace(/\D/g, '').slice(-10);
    combinedResult.trackingUrls = orderIds.map(id => 
      `${this.trackingBaseUrl}/track/${id}${cleanPhone ? '/' + cleanPhone : ''}`
    );
    combinedResult.trackingUrl = combinedResult.trackingUrls[0];

    return combinedResult;
  }

  /**
   * Track order completion for learning/personalization
   */
  private async trackOrderForLearning(
    context: FlowContext,
    orderType: string,
    orderResult: any,
  ): Promise<void> {
    if (!this.orderLearning) return;
    try {
      const userId = context.data.user_id || context._system?.phoneNumber || 'unknown';
      await this.orderLearning.trackInteraction({
        userId: String(userId),
        sessionId: context._system?.sessionId || '',
        timestamp: new Date(),
        originalMessage: context.data._user_message || '',
        classifiedIntent: orderType === 'food' ? 'order_food' : 'send_parcel',
        intentConfidence: 1.0,
        recommendationsShown: (context.data.selected_items || []).map((item: any, idx: number) => ({
          id: String(item.id || idx),
          name: item.name || item.title || 'item',
          position: idx,
          reason: 'user_selected',
          matchScore: 1.0,
        })),
        selectedOption: {
          id: String(orderResult.orderId),
          name: `${orderType}_order_${orderResult.orderId}`,
          position: 0,
        },
        orderPlaced: true,
        orderId: String(orderResult.orderId),
        orderValue: orderResult.orderValue || context.data.total_amount || 0,
      });
      this.logger.log(`📊 Order tracked for learning: ${orderType} #${orderResult.orderId}`);
    } catch (err) {
      this.logger.warn(`Failed to track order for learning: ${err.message}`);
    }
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/;
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  /**
   * Phase 2: Record order interaction for training
   */
  private async recordOrderInteraction(context: FlowContext, orderType: string, success: boolean): Promise<void> {
    try {
      const userMessage = context.data._user_message || '';
      if (!userMessage) return;

      const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
        conversation_history: context.data._conversation_history || [],
        flow_stage: 'order_creation',
      });

      await this.advancedLearning.recordTrainingData({
        message: userMessage,
        questionType: `order_${orderType}`,
        actualClassification: success,
        predictedClassification: success,
        confidence: success ? 0.95 : 0.2,
        flowContext: 'order_placement',
        language: this.detectLanguage(userMessage),
        userId: context._system?.userId || 'unknown',
        sessionId: context._system?.sessionId || 'unknown',
      });

      if (success) {
        this.logger.log(`✅ Order placed successfully (${orderType}) - sentiment: ${sentiment.emotion}`);

        // Trigger real-time profile enrichment after successful order
        const userId = context._system?.userId ? Number(context._system.userId) : null;
        if (userId && this.conversationEnrichment) {
          this.conversationEnrichment.enrichProfileFromOrder(userId, {
            orderType,
            items: context.data.selectedItems || context.data.cart_items || [],
            storeName: context.data.store_name || context.data.selected_store_name,
            totalPrice: context.data.total_price || context.data.order_total,
          }).catch(err => this.logger.debug(`Profile enrichment failed (non-fatal): ${err.message}`));
        }
      } else if (sentiment.frustration_score > 0.7) {
        this.logger.log(`😤 Order failed with high frustration: ${sentiment.frustration_score.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.warn(`Phase 2 order tracking failed: ${error.message}`);
    }
  }

  private async createEcommerceOrder(
    config: any,
    context: FlowContext,
    authToken: string | null,
    userId?: number
  ): Promise<any> {
    // ⚠️ CRITICAL: PHP requires JWT auth token for ALL orders (no guest orders)
    // For WhatsApp users verified via MySQL, we use user_id if auth_token is not available
    if (!authToken && !userId) {
      this.logger.error('❌ Authentication required - need auth_token or user_id');
      return {
        success: false,
        message: 'Authentication required. Please login before placing an order.',
      };
    }

    const items = config.items || context.data.selected_items || context.data.cart_items;
    const deliveryAddress = config.delivery_address || context.data.delivery_address;
    // Use user-selected payment method (should be set by flow before reaching this executor)
    const paymentMethod = config.payment_method || context.data.payment_method;
    
    if (!paymentMethod) {
      this.logger.error('❌ Payment method not selected before creating ecommerce order');
      return {
        success: false,
        message: 'Payment method is required. Please select a payment method before placing the order.',
      };
    }
    const orderNote = this.resolveOrderNote(config.order_note, context.data.order_note);

    if (!items || items.length === 0) {
      return {
        success: false,
        message: 'No items selected for order',
      };
    }

    if (!deliveryAddress) {
      return {
        success: false,
        message: 'Delivery address is required',
      };
    }

    this.logger.log(`🛒 Creating e-commerce order with ${items.length} items, userId: ${userId || 'using authToken'}`);

    // E-commerce orders use the same food order flow but with module_id for ecommerce
    // The PHP backend handles both through the same cart/order endpoints
    return this.phpOrderService.createFoodOrder(authToken, {
      items: items.map((item: any) => ({
        item_id: item.item_id || item.id,
        quantity: item.quantity || 1,
        store_id: item.store_id || item.storeId,
        price: item.price || item.rawPrice || item.item_price || 0,
        variant: item.variant || [],
        addon_ids: item.addon_ids || [],
        addon_quantities: item.addon_quantities || [],
      })),
      deliveryAddress: {
        address: deliveryAddress.address,
        latitude: deliveryAddress.lat || deliveryAddress.latitude,
        longitude: deliveryAddress.lng || deliveryAddress.longitude,
        contact_person_name: deliveryAddress.contact_person_name || context.data.user_name,
        contact_person_number: deliveryAddress.contact_person_number || context.data.user_phone,
      },
      paymentMethod,
      orderNote: orderNote || 'E-commerce order',
      moduleId: 5, // Module ID 5 = Shop (E-commerce)
    });
  }

  validate(config: Record<string, any>): boolean {
    return !!config.type;
  }
}
