import { Injectable, Logger, Optional } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpVendorAuthService, VendorUser } from '../../php-integration/services/php-vendor-auth.service';
import { PhpDeliveryAuthService } from '../../php-integration/services/php-delivery-auth.service';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { PhpAuthService } from '../../php-integration/services/php-auth.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';
import { PhpWalletService } from '../../php-integration/services/php-wallet.service';
import { PhpCouponService } from '../../php-integration/services/php-coupon.service';
import { PhpReviewService } from '../../php-integration/services/php-review.service';
import { PhpStoreService } from '../../php-integration/services/php-store.service';
import { UserTypeDetectorService } from '../../php-integration/services/user-type-detector.service';
import { VendorProfileService } from '../../profiles/services/vendor-profile.service';
import { RiderProfileService } from '../../profiles/services/rider-profile.service';

/**
 * PHP API Executor
 * 
 * Maps YAML flow actions to PHP backend service methods.
 * This executor bridges the YAML V2 flows with the PHP integration layer.
 * 
 * Supported Actions:
 * - Vendor: vendor_login, vendor_get_current_orders, vendor_update_order_status, etc.
 * - Delivery: dm_login, dm_get_current_orders, dm_update_order_status, dm_get_earnings, etc.
 * - Customer: get_customer_orders, cancel_order, verify_payment, etc.
 * - Common: detect_user_type, get_saved_addresses, reverse_geocode, geocode
 */
@Injectable()
export class PhpApiExecutor implements ActionExecutor {
  readonly name = 'php_api';
  private readonly logger = new Logger(PhpApiExecutor.name);

  constructor(
    private readonly vendorAuthService: PhpVendorAuthService,
    private readonly deliveryAuthService: PhpDeliveryAuthService,
    private readonly orderService: PhpOrderService,
    private readonly authService: PhpAuthService,
    private readonly addressService: PhpAddressService,
    private readonly paymentService: PhpPaymentService,
    private readonly walletService: PhpWalletService,
    private readonly userTypeDetectorService: UserTypeDetectorService,
    private readonly vendorProfileService: VendorProfileService,
    private readonly riderProfileService: RiderProfileService,
    @Optional() private readonly couponService?: PhpCouponService,
    @Optional() private readonly reviewService?: PhpReviewService,
    @Optional() private readonly storeService?: PhpStoreService,
  ) {
    this.logger.log('🔌 PHP API Executor initialized');
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;
    
    if (!action) {
      return {
        success: false,
        error: 'No action specified for php_api executor',
      };
    }

    this.logger.log(`📡 Executing PHP API action: ${action}`);
    this.logger.debug(`Config: ${JSON.stringify(config)}`);

    try {
      // Resolve config values from context using {{variable}} syntax
      const resolvedConfig = this.resolveConfig(config, context);
      const result = await this.executeAction(action, resolvedConfig, context);
      
      this.logger.log(`✅ PHP API action ${action} completed`);
      
      // Debug: log payment-related order details
      if (action === 'get_order_details' || action === 'get_order_status_details') {
        if (result) {
          this.logger.log(`📋 Order status result: id=${result.id}, orderStatus=${result.orderStatus}, paymentStatus=${result.paymentStatus}, paymentMethod=${result.paymentMethod}`);
        } else {
          this.logger.warn(`📋 Order details returned null/undefined`);
        }
      }
      
      // Check if the API returned success: false (e.g., payment methods API failure)
      if (result && typeof result === 'object' && result.success === false) {
        this.logger.warn(`⚠️ PHP API action ${action} returned success: false - ${result.message || 'Unknown error'}`);
        return {
          success: false,
          output: result,
          error: result.message || 'API returned failure',
          event: 'error',
        };
      }
      
      return {
        success: true,
        output: result,
        event: 'success',
      };
    } catch (error) {
      this.logger.error(`❌ PHP API action ${action} failed: ${error.message}`);

      // Handle auth token expiry - propagate as auth_expired event
      if (error.requiresReAuth || error.code === 'AUTH_TOKEN_EXPIRED' || error.code === 'auth_expired' || error.statusCode === 401) {
        this.logger.warn(`⚠️ Auth token expired during PHP API action: ${action}`);
        context.data._auth_expired = true;
        context.data._friendly_error = 'Your session has expired. Please log in again to continue.';
        return {
          success: false,
          error: error.message,
          event: 'auth_expired',
          output: { requiresReAuth: true },
        };
      }

      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Resolve {{variable}} placeholders in config from context
   */
  private resolveConfig(config: Record<string, any>, context: FlowContext): Record<string, any> {
    const resolved: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const varName = value.slice(2, -2).trim();
        const resolvedValue = this.getNestedValue(context.data, varName);

        // Fail fast on critical keys that resolve to undefined (prevents sending literal "{{auth_token}}" to PHP)
        if (resolvedValue === undefined || resolvedValue === null) {
          const criticalKeys = ['token', 'auth_token', 'phone', 'orderId', 'order_id'];
          if (criticalKeys.includes(key)) {
            this.logger.error(`Critical config key "${key}" resolved to undefined (template: "${value}", varName: "${varName}"). Available context keys: ${Object.keys(context.data || {}).join(', ')}`);
            throw new Error(`Required flow context value "${varName}" is missing for key "${key}". User may need to re-authenticate.`);
          }
          this.logger.warn(`Config key "${key}" resolved to undefined (template: "${value}"), using placeholder`);
        }

        resolved[key] = resolvedValue ?? value;

        // Debug token resolution
        if (key === 'token') {
          this.logger.debug(`Resolving token: varName="${varName}", resolved=${resolvedValue ? 'YES (' + String(resolvedValue).substring(0, 30) + '...)' : 'NO (falling back to placeholder)'}`);
          this.logger.debug(`Available context.data keys: ${Object.keys(context.data || {}).join(', ')}`);
        }
      } else {
        resolved[key] = value;
      }
    }
    
    return resolved;
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Execute the specific action
   */
  private async executeAction(
    action: string,
    config: Record<string, any>,
    context: FlowContext
  ): Promise<any> {
    switch (action) {
      // ============================================
      // USER TYPE DETECTION
      // ============================================
      case 'detect_user_type':
        return this.userTypeDetectorService.detectUserType(config.phone);

      // ============================================
      // VENDOR AUTHENTICATION
      // ============================================
      case 'vendor_send_otp':
        return this.vendorAuthService.sendVendorOtp(
          config.emailOrPhone,
          config.vendorType || 'owner'
        );

      case 'vendor_verify_otp':
        // Verify OTP and sync vendor profile to PostgreSQL
        const otpResult = await this.vendorAuthService.verifyVendorOtp(
          config.emailOrPhone,
          config.otp,
          config.vendorType || 'owner'
        );
        
        // Auto-sync to PostgreSQL on successful login
        if (otpResult.success && otpResult.data?.vendor) {
          const vendorUser: VendorUser = {
            id: otpResult.data.vendor.id,
            phone: otpResult.data.vendor.phone,
            email: otpResult.data.vendor.email,
            firstName: otpResult.data.vendor.f_name || otpResult.data.vendor.firstName,
            lastName: otpResult.data.vendor.l_name || otpResult.data.vendor.lastName,
            token: otpResult.data.token,
            storeId: otpResult.data.vendor.stores?.[0]?.id || otpResult.data.vendor.store_id,
            storeName: otpResult.data.vendor.stores?.[0]?.name || otpResult.data.vendor.store_name,
            isActive: otpResult.data.vendor.status === 1,
            vendorType: config.vendorType || 'owner',
            zoneWiseTopic: otpResult.data.zoneWiseTopic,
          };
          
          // Sync vendor profile to PostgreSQL (non-blocking)
          this.vendorProfileService.onVendorLogin(vendorUser)
            .then(profile => {
              if (profile) {
                this.logger.log(`✅ Vendor ${profile.name} synced to PostgreSQL on login`);
              }
            })
            .catch(err => this.logger.error(`Failed to sync vendor on login: ${err.message}`));
        }
        
        return otpResult;

      case 'vendor_login':
        // Password login and sync vendor profile
        const loginResult = await this.vendorAuthService.vendorLogin(config.email, config.password);
        
        // Auto-sync to PostgreSQL on successful login
        if (loginResult.success && loginResult.data?.vendor) {
          const vendorUser: VendorUser = {
            id: loginResult.data.vendor.id,
            phone: loginResult.data.vendor.phone,
            email: loginResult.data.vendor.email,
            firstName: loginResult.data.vendor.f_name || loginResult.data.vendor.firstName,
            lastName: loginResult.data.vendor.l_name || loginResult.data.vendor.lastName,
            token: loginResult.data.token,
            storeId: loginResult.data.vendor.stores?.[0]?.id || loginResult.data.vendor.store_id,
            storeName: loginResult.data.vendor.stores?.[0]?.name || loginResult.data.vendor.store_name,
            isActive: loginResult.data.vendor.status === 1,
            vendorType: 'owner',
            zoneWiseTopic: loginResult.data.zoneWiseTopic,
          };
          
          // Sync vendor profile to PostgreSQL (non-blocking)
          this.vendorProfileService.onVendorLogin(vendorUser)
            .then(profile => {
              if (profile) {
                this.logger.log(`✅ Vendor ${profile.name} synced to PostgreSQL on login`);
              }
            })
            .catch(err => this.logger.error(`Failed to sync vendor on login: ${err.message}`));
        }
        
        return loginResult;

      case 'get_vendor_profile':
        return this.vendorAuthService.getVendorProfile(config.token);

      case 'update_vendor_profile':
        return this.vendorAuthService.updateVendorProfile(config.token, config.data);

      // ============================================
      // VENDOR ORDER MANAGEMENT
      // ============================================
      case 'vendor_get_current_orders':
        return this.vendorAuthService.getCurrentOrders(config.token);

      case 'vendor_update_order_status':
        return this.vendorAuthService.updateOrderStatus(
          config.token,
          config.orderId,
          config.status,
          config.reason
        );

      case 'vendor_get_items_list':
        return this.vendorAuthService.getItemsList(config.token);

      case 'vendor_toggle_item':
        return this.vendorAuthService.toggleItemStatus(
          config.token,
          config.itemId,
          config.isActive
        );

      // ============================================
      // DELIVERY MAN AUTHENTICATION
      // ============================================
      case 'delivery_man_login':
      case 'dm_login':
        // Login and sync rider profile to PostgreSQL
        const dmLoginResult = await this.deliveryAuthService.deliveryManLogin(config.email, config.password);
        
        // Auto-sync to PostgreSQL on successful login
        if (dmLoginResult.success && dmLoginResult.data?.deliveryMan) {
          const dm = dmLoginResult.data.deliveryMan;
          
          // Sync rider profile to PostgreSQL (non-blocking)
          this.riderProfileService.syncRiderFromPhp(dm.id)
            .then(profile => {
              if (profile) {
                this.logger.log(`✅ Rider ${profile.name} synced to PostgreSQL on login`);
              }
            })
            .catch(err => this.logger.error(`Failed to sync rider on login: ${err.message}`));
        }
        
        return dmLoginResult;

      case 'get_delivery_man_profile':
      case 'dm_get_profile':
        return this.deliveryAuthService.getDeliveryManProfile(config.token);

      case 'dm_update_profile':
        return this.deliveryAuthService.updateProfile(config.token, config.data);

      case 'dm_update_active_status':
        return this.deliveryAuthService.updateActiveStatus(config.token, config.isActive);

      // ============================================
      // DELIVERY MAN ORDER MANAGEMENT
      // ============================================
      case 'dm_get_current_orders':
        return this.deliveryAuthService.getCurrentOrders(config.token);

      case 'dm_get_order_history':
        return this.deliveryAuthService.getOrderHistory(config.token, config.limit || 10);

      case 'dm_accept_order':
        return this.deliveryAuthService.acceptOrder(config.token, config.orderId);

      case 'dm_update_order_status':
        return this.deliveryAuthService.updateOrderStatus(
          config.token,
          config.orderId,
          config.status
        );

      case 'dm_get_order_details':
        return this.deliveryAuthService.getOrderDetails(config.token, config.orderId);

      case 'dm_record_location':
        return this.deliveryAuthService.recordLocation(
          config.token,
          config.latitude,
          config.longitude
        );

      case 'dm_get_earnings':
        return this.deliveryAuthService.getEarnings(config.token);

      // ============================================
      // CUSTOMER ORDER MANAGEMENT
      // ============================================
      case 'get_customer_orders':
        return this.orderService.getOrders(config.token, config.limit || 10, 1, config.moduleId);

      case 'get_all_customer_orders': {
        const [foodOrders, parcelOrders] = await Promise.all([
          this.orderService.getOrders(config.token, config.limit || 10, 1, '4'),
          this.orderService.getOrders(config.token, config.limit || 10, 1, '3'),
        ]);
        return [...foodOrders, ...parcelOrders].sort((a, b) =>
          ((b.createdAt as any)?.getTime?.() || 0) - ((a.createdAt as any)?.getTime?.() || 0)
        );
      }

      case 'get_running_orders':
        return this.orderService.getRunningOrders(config.token, config.moduleId);

      case 'get_all_running_orders': {
        const [foodRunning, parcelRunning] = await Promise.all([
          this.orderService.getRunningOrders(config.token, '4'),
          this.orderService.getRunningOrders(config.token, '3'),
        ]);
        return [...foodRunning, ...parcelRunning].sort((a, b) =>
          ((b.createdAt as any)?.getTime?.() || 0) - ((a.createdAt as any)?.getTime?.() || 0)
        );
      }

      case 'get_order_details':
      case 'get_order_status_details': // Alias for YAML V2 flows
        // Support both orderId and order_id naming conventions
        return this.orderService.getOrderDetails(config.token, config.orderId || config.order_id);

      case 'track_order':
        return this.orderService.trackOrder(config.orderId || config.order_id);

      case 'cancel_order':
        return this.orderService.cancelOrder(config.token, config.orderId || config.order_id, config.reason);

      case 'get_cancellation_reasons':
        return this.orderService.getCancellationReasons();

      case 'request_refund':
        return this.orderService.requestRefund(
          config.token,
          config.orderId || config.order_id,
          config.reason,
          config.note,
          config.method || 'wallet',
        );

      // ============================================
      // COUPON
      // ============================================
      case 'apply_coupon': {
        const token = config.token || context.data.auth_token;
        if (!token) {
          return { success: false, message: 'Login required to apply coupon' };
        }
        if (!this.couponService) {
          return { success: false, message: 'Coupon service unavailable' };
        }
        const orderAmount = parseFloat(config.order_amount ?? config.orderAmount ?? 0);
        return this.couponService.applyCoupon(token, config.code, orderAmount, config.store_id);
      }

      case 'get_coupons': {
        const token = config.token || context.data.auth_token;
        // Always include a Skip button as last option
        const skipBtn = { label: '⏭️ Skip', value: 'skip_coupon' };
        if (!this.couponService) {
          return { success: true, event: 'no_coupons', coupons: [skipBtn] };
        }
        try {
          const result = await this.couponService.getCoupons(token);
          const raw = result.coupons || [];
          const formatted = raw.slice(0, 3).map((c: any) => ({
            label: `🎫 ${c.code}${c.discount_amount ? ` — ${c.discount_type === 'percent' ? c.discount_amount + '% off' : '₹' + c.discount_amount + ' off'}` : ''}`,
            value: c.code,
          }));
          formatted.push(skipBtn);
          return { success: true, event: formatted.length > 1 ? 'success' : 'no_coupons', coupons: formatted };
        } catch {
          return { success: true, event: 'no_coupons', coupons: [skipBtn] };
        }
      }

      case 'submit_order_review': {
        const token = config.token || context.data.auth_token;
        if (!token || !this.reviewService) {
          return { success: true, event: 'success' }; // silent pass-through
        }
        const orderId = parseInt(config.order_id || config.orderId || '0', 10);
        if (!orderId) return { success: true, event: 'success' };
        // Parse rating: 'rating_5' → 5
        const ratingRaw = String(config.rating || '5');
        const rating = ratingRaw.startsWith('rating_')
          ? parseInt(ratingRaw.replace('rating_', ''), 10)
          : (parseInt(ratingRaw, 10) || 5);
        const comment = (config.comment && config.comment !== 'skip_review_comment') ? config.comment : '';
        // Best-effort: get first item id from order context, fallback to orderId
        const items = (context.data?.order_details as any)?.items;
        const itemId = (Array.isArray(items) && items[0]?.id) ? parseInt(items[0].id, 10) : orderId;
        try {
          await this.reviewService.submitItemReview(token, itemId, orderId, rating, comment);
        } catch {
          // Swallow errors — UX should always thank the user
        }
        return { success: true, event: 'success' };
      }

      // ============================================
      // ADDRESS MANAGEMENT
      // ============================================
      case 'get_saved_addresses':
        return this.addressService.getAddresses(config.token);

      case 'add_address':
        return this.addressService.addAddress(config.token, config.address);

      case 'delete_address':
        return this.addressService.deleteAddress(config.token, config.addressId);

      // Note: reverseGeocode and geocode should be handled by a separate Geocoding service
      // These are placeholders that return success with mock data
      case 'reverse_geocode':
        return {
          success: true,
          address: `Location at ${config.latitude}, ${config.longitude}`,
          latitude: config.latitude,
          longitude: config.longitude,
        };

      case 'geocode': {
        // Use Google Maps Geocoding API
        const googleApiKey = this.authService['configService']?.get('GOOGLE_MAPS_API_KEY');
        if (googleApiKey && config.address) {
          try {
            const { default: axios } = await import('axios');
            const geoResp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
              params: { address: config.address, key: googleApiKey },
            });
            if (geoResp.data.status === 'OK' && geoResp.data.results.length > 0) {
              const loc = geoResp.data.results[0].geometry.location;
              return {
                success: true,
                address: geoResp.data.results[0].formatted_address,
                latitude: loc.lat,
                longitude: loc.lng,
              };
            }
            this.logger.warn(`Geocode returned ${geoResp.data.status} for "${config.address}"`);
          } catch (geoErr) {
            this.logger.error(`Geocode API error: ${geoErr.message}`);
          }
        }
        // Fallback if no API key or API fails
        return {
          success: false,
          error: 'Geocoding failed — Google Maps API key missing or address not found',
          address: config.address,
          latitude: 0,
          longitude: 0,
        };
      }

      // ============================================
      // PAYMENT
      // ============================================
      case 'verify_payment':
        if (config.token && config.orderId && config.paymentId && config.signature) {
          try {
            return await this.paymentService.verifyRazorpayPayment(
              config.token,
              config.orderId,
              config.paymentId,
              config.signature,
            );
          } catch (error) {
            this.logger.error(`Payment verification failed: ${error.message}`);
            return {
              success: false,
              verified: false,
              orderId: config.orderId,
              paymentId: config.paymentId,
              message: error.message,
            };
          }
        }
        // Fallback: if missing required params, log warning and return unverified
        this.logger.warn(`⚠️ verify_payment called without required params (token, orderId, paymentId, signature)`);
        return {
          success: false,
          verified: false,
          orderId: config.orderId,
          paymentId: config.paymentId,
          message: 'Missing required verification parameters',
        };

      case 'get_payment_methods': {
        // Was called with no arguments at all, so only the global config flag
        // was ever read and cash showed up for every module. The flow must now
        // declare its order type; anything but 'parcel' gets no cash option.
        const pmModuleId = config.module_id ? Number(config.module_id) : undefined;
        const pmZoneId = config.zone_id ? Number(config.zone_id) : undefined;
        const pmOrderType = config.order_type || context.data?.order_type;
        return this.paymentService.getPaymentMethods(pmModuleId, pmZoneId, pmOrderType);
      }

      case 'get_surge_price': {
        const zoneId = config.zone_id ? Number(config.zone_id) : 0;
        const moduleId = config.module_id ? Number(config.module_id) : 4;
        // Auth token is required by PHP — auto-pick from context if not in config
        const surgeToken = config.token || context.data.auth_token;
        return this.paymentService.getSurgePrice(zoneId, moduleId, surgeToken);
      }

      case 'get_wallet_balance':
        if (!config.token) {
          return { success: false, message: 'Auth token required to check wallet balance' };
        }
        return this.walletService.getWalletBalance(config.token);

      case 'generate_payment_link':
        // Generate real payment link via PHP payment-mobile URL
        if (config.token && config.orderId && config.amount) {
          try {
            const razorpayResult = await this.paymentService.initializeRazorpay(
              config.token,
              config.orderId,
              config.amount,
              config.customerId,
            );
            return {
              success: true,
              paymentLink: razorpayResult.paymentLink,
              razorpayOrderId: razorpayResult.razorpayOrderId,
            };
          } catch (error) {
            this.logger.error(`Payment link generation failed: ${error.message}`);
            return {
              success: false,
              message: error.message,
            };
          }
        }
        return {
          success: false,
          message: 'Missing required fields: token, orderId, amount',
        };

      case 'cancel_pending_order':
        return this.orderService.cancelOrder(config.token, config.orderId, 'Payment timeout');

      // ============================================
      // CUSTOMER AUTHENTICATION
      // ============================================
      case 'check_phone':
        // PhpAuthService.sendOtp returns { success, message, isNewUser }
        return this.authService.sendOtp(config.phone);

      case 'send_otp':
        return this.authService.sendOtp(config.phone);

      case 'verify_otp':
        return this.authService.verifyOtp(config.phone, config.otp);

      case 'customer_login':
        return this.authService.verifyOtp(config.phone, config.otp);

      case 'get_customer_profile':
        return this.authService.getUserProfile(config.token);

      // ============================================
      // FLOW UTILITY ACTIONS (Context Operations)
      // ============================================
      case 'check_cancel_eligibility':
        // Check if order can be cancelled based on status
        // Orders can be cancelled before 'accepted' status
        return this.orderService.checkCancelEligibility(config.token, config.orderId || config.order_id);

      case 'log_event':
        // Log analytics event - just acknowledge for now
        this.logger.log(`📊 Event logged: ${config.event_name || config.event}`);
        return { success: true };

      case 'notify_vendor_new_order':
        // Vendor notification handled by backend services
        this.logger.log(`🔔 Vendor notification triggered for order: ${config.orderId || config.order_id}`);
        return { success: true };

      case 'set_selected_role':
      case 'set_session_context':
        // These are handled by context service, not PHP API
        // Return success to let the flow continue
        return { success: true, ...config };

      case 'update':
        // Generic update action - pass through
        return { success: true, ...config };

      // ============================================
      // STORE
      // ============================================
      case 'get_store_details': {
        if (!this.storeService) {
          return { success: false, message: 'Store service unavailable' };
        }
        const storeId = Number(config.storeId || config.store_id);
        if (!storeId) {
          return { success: false, message: 'Store ID required' };
        }
        const zoneId = config.zoneId || config.zone_id
          ? Number(config.zoneId || config.zone_id)
          : undefined;
        return this.storeService.getStoreDetails(storeId, config.lat, config.lng, zoneId);
      }

      case 'check_store_status': {
        if (!this.storeService) {
          return { success: false, message: 'Store service unavailable' };
        }
        const storeId = Number(config.storeId || config.store_id);
        if (!storeId) {
          return { success: false, message: 'Store ID required' };
        }
        const zoneId = config.zoneId || config.zone_id
          ? Number(config.zoneId || config.zone_id)
          : undefined;
        return this.storeService.checkStoreAvailability(storeId, zoneId);
      }

      // ============================================
      // DEFAULT
      // ============================================
      default:
        throw new Error(`Unknown PHP API action: ${action}`);
    }
  }

  /**
   * Validate configuration
   */
  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
