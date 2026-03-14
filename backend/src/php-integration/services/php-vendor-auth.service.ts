import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * Vendor Authentication Interface
 */
export interface VendorUser {
  id: number;
  phone?: string;
  email: string;
  firstName: string;
  lastName?: string;
  token: string;
  storeName?: string;
  storeId?: number;
  isActive?: boolean;
  vendorType?: 'owner' | 'employee';
  zoneWiseTopic?: string; // FCM topic for push notifications
}

/**
 * Vendor Type - Owner vs Employee
 * Owner: Full access to store management
 * Employee: Limited access, works under an owner
 */
export type VendorType = 'owner' | 'employee';

/**
 * PHP Vendor Authentication Service
 * Handles all vendor-related authentication API calls
 * 
 * Vendors are restaurant/store owners who:
 * - Receive orders from customers
 * - Manage their menu/items
 * - Update order status (confirm, preparing, ready)
 */
@Injectable()
export class PhpVendorAuthService extends PhpApiService {
  protected logger = new Logger(PhpVendorAuthService.name);

  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  // ========================================
  // OTP-BASED AUTHENTICATION (NEW)
  // ========================================

  /**
   * Send OTP to vendor's email or phone
   * PHP endpoint: POST /api/v1/auth/vendor/send-otp
   * 
   * @param emailOrPhone - Email address or phone number
   * @param vendorType - 'owner' or 'employee'
   */
  async sendVendorOtp(
    emailOrPhone: string,
    vendorType: VendorType = 'owner'
  ): Promise<{
    success: boolean;
    message?: string;
    otpSentTo?: 'email' | 'phone';
  }> {
    try {
      this.logger.log(`📱 Sending OTP to vendor: ${emailOrPhone} (${vendorType})`);

      const response: any = await this.post('/api/v1/auth/vendor/send-otp', {
        email_or_phone: emailOrPhone,
        vendor_type: vendorType,
      });

      this.logger.log(`✅ OTP sent successfully to ${emailOrPhone}`);

      return {
        success: true,
        message: response.message || 'OTP sent successfully',
        otpSentTo: emailOrPhone.includes('@') ? 'email' : 'phone',
      };
    } catch (error) {
      this.logger.error(`❌ Failed to send vendor OTP: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Verify OTP and login vendor
   * PHP endpoint: POST /api/v1/auth/vendor/verify-otp
   * 
   * @param emailOrPhone - Email address or phone number
   * @param otp - The OTP received
   * @param vendorType - 'owner' or 'employee'
   */
  async verifyVendorOtp(
    emailOrPhone: string,
    otp: string,
    vendorType: VendorType = 'owner'
  ): Promise<{
    success: boolean;
    data?: {
      token: string;
      vendor?: any;
      zoneWiseTopic?: string;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`🔐 Verifying vendor OTP for: ${emailOrPhone}`);

      const response: any = await this.post('/api/v1/auth/vendor/verify-otp', {
        email_or_phone: emailOrPhone,
        otp,
        vendor_type: vendorType,
      });

      this.logger.log(`✅ Vendor OTP verified: token=${response.token ? 'YES' : 'NO'}`);

      return {
        success: true,
        data: {
          token: response.token,
          vendor: response.vendor || response,
          zoneWiseTopic: response.zone_wise_topic, // For FCM push notifications
        },
      };
    } catch (error) {
      this.logger.error(`❌ Vendor OTP verification failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // ========================================
  // PASSWORD-BASED AUTHENTICATION
  // ========================================

  /**
   * Vendor login with email/phone and password
   * PHP endpoint: POST /api/v1/auth/vendor/login
   * Supports both owner and employee login
   */
  async vendorLogin(
    emailOrPhone: string,
    password: string,
    vendorType: VendorType = 'owner'
  ): Promise<{
    success: boolean;
    data?: {
      token: string;
      vendor?: any;
      zoneWiseTopic?: string;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`🏪 Vendor login attempt for: ${emailOrPhone} (${vendorType})`);

      const response: any = await this.post('/api/v1/auth/vendor/login', {
        email: emailOrPhone, // PHP backend uses 'email' for both email and phone
        password,
        vendor_type: vendorType,
      });

      this.logger.log(`✅ Vendor login successful: token=${response.token ? 'YES' : 'NO'}`);

      return {
        success: true,
        data: {
          token: response.token,
          vendor: response.vendor || response,
          zoneWiseTopic: response.zone_wise_topic, // For FCM push notifications
        },
      };
    } catch (error) {
      this.logger.error(`❌ Vendor login failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get vendor profile
   * PHP endpoint: GET /api/v1/vendor/profile
   */
  async getVendorProfile(token: string): Promise<VendorUser | null> {
    try {
      this.logger.log(`👤 Fetching vendor profile`);

      const response = await this.authenticatedRequest(
        'get',
        '/api/v1/vendor/profile',
        token
      );

      this.logger.log(`✅ Vendor profile fetched: ${response.f_name || response.name}`);

      return {
        id: response.id,
        email: response.email,
        phone: response.phone,
        firstName: response.f_name || response.name?.split(' ')[0],
        lastName: response.l_name || response.name?.split(' ').slice(1).join(' '),
        token,
        storeName: response.restaurants?.[0]?.name || response.store_name,
        storeId: response.restaurants?.[0]?.id || response.store_id,
        isActive: response.status === 1 || response.is_active === 1,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch vendor profile: ${error.message}`);
      return null;
    }
  }

  /**
   * Update vendor profile
   * PHP endpoint: PUT /api/v1/vendor/update-profile
   */
  async updateVendorProfile(
    token: string,
    data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
    }
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`📝 Updating vendor profile`);

      await this.authenticatedRequest(
        'put',
        '/api/v1/vendor/update-profile',
        token,
        {
          f_name: data.firstName,
          l_name: data.lastName,
          email: data.email,
          phone: data.phone,
        }
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to update vendor profile: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get vendor's current orders
   * PHP endpoint: GET /api/v1/vendor/current-orders
   */
  async getCurrentOrders(token: string): Promise<{
    success: boolean;
    orders?: any[];
    message?: string;
  }> {
    try {
      this.logger.log(`📦 Fetching vendor current orders`);

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/vendor/current-orders',
        token
      );

      const orders = Array.isArray(response) ? response : (response.orders || []);
      this.logger.log(`✅ Found ${orders.length} current orders`);

      return {
        success: true,
        orders: orders.map((order: any) => ({
          id: order.id,
          orderId: order.order_id || `#${order.id}`,
          status: order.order_status,
          orderAmount: order.order_amount,
          deliveryCharge: order.delivery_charge,
          totalAmount: order.order_amount + (order.delivery_charge || 0),
          customerName: order.customer?.f_name || 'Customer',
          customerPhone: order.customer?.phone,
          deliveryAddress: order.delivery_address?.address,
          items: order.details?.map((item: any) => ({
            name: item.food?.name || item.item_name,
            quantity: item.quantity,
            price: item.price,
          })) || [],
          createdAt: order.created_at,
          scheduledAt: order.schedule_at,
        })),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch current orders: ${error.message}`);
      return { success: false, message: error.message, orders: [] };
    }
  }

  /**
   * Update order status
   * PHP endpoint: PUT /api/v1/vendor/update-order-status
   * 
   * Status values: pending, confirmed, processing, handover, delivered, canceled
   */
  async updateOrderStatus(
    token: string,
    orderId: number,
    status: 'confirmed' | 'processing' | 'handover' | 'canceled',
    reason?: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`📝 Updating order ${orderId} status to: ${status}`);

      await this.authenticatedRequest(
        'put',
        '/api/v1/vendor/update-order-status',
        token,
        {
          order_id: orderId,
          status,
          reason,
        }
      );

      this.logger.log(`✅ Order ${orderId} status updated to ${status}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to update order status: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get vendor's items/menu list
   * PHP endpoint: GET /api/v1/vendor/get-items-list
   */
  async getItemsList(token: string): Promise<{
    success: boolean;
    items?: any[];
    message?: string;
  }> {
    try {
      this.logger.log(`📜 Fetching vendor items list`);

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/vendor/get-items-list',
        token
      );

      const items = Array.isArray(response) ? response : (response.items || response.products || []);
      this.logger.log(`✅ Found ${items.length} items`);

      return {
        success: true,
        items: items.map((item: any) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price,
          image: item.image,
          category: item.category_name || item.category?.name,
          isAvailable: item.status === 1,
          stock: item.stock,
        })),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch items list: ${error.message}`);
      return { success: false, message: error.message, items: [] };
    }
  }

  /**
   * Toggle item availability
   * PHP endpoint: POST /api/v1/vendor/item/status
   */
  async toggleItemStatus(
    token: string,
    itemId: number,
    isAvailable: boolean
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`🔄 Toggling item ${itemId} availability to: ${isAvailable}`);

      await this.authenticatedRequest(
        'post',
        '/api/v1/vendor/item/status',
        token,
        {
          item_id: itemId,
          status: isAvailable ? 1 : 0,
        }
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to toggle item status: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}
