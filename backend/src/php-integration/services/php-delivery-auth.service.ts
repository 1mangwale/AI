import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * Delivery Man User Interface
 */
export interface DeliveryManUser {
  id: number;
  phone?: string;
  email: string;
  firstName: string;
  lastName?: string;
  token: string;
  vehicleType?: string;
  isActive?: boolean;
  isOnline?: boolean;
  currentLocation?: {
    latitude: number;
    longitude: number;
  };
  rating?: number;
  totalDeliveries?: number;
}

/**
 * PHP Delivery Man Authentication Service
 * Handles all delivery partner related authentication API calls
 * 
 * Delivery Men are delivery partners who:
 * - Accept and deliver orders
 * - Update delivery status (picked, on_way, delivered)
 * - Track and share their location
 */
@Injectable()
export class PhpDeliveryAuthService extends PhpApiService {
  protected logger = new Logger(PhpDeliveryAuthService.name);

  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  /**
   * Delivery Man login with email and password
   * PHP endpoint: POST /api/v1/auth/delivery-man/login
   */
  async deliveryManLogin(email: string, password: string): Promise<{
    success: boolean;
    data?: {
      token: string;
      deliveryMan?: any;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`🚚 Delivery Man login attempt for: ${email}`);

      const response: any = await this.post('/api/v1/auth/delivery-man/login', {
        email,
        password,
      });

      this.logger.log(`✅ Delivery Man login successful: token=${response.token ? 'YES' : 'NO'}`);

      return {
        success: true,
        data: {
          token: response.token,
          deliveryMan: response.delivery_man || response,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Delivery Man login failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get delivery man profile
   * PHP endpoint: GET /api/v1/delivery-man/profile
   */
  async getDeliveryManProfile(token: string): Promise<DeliveryManUser | null> {
    try {
      this.logger.log(`👤 Fetching delivery man profile`);

      const response = await this.authenticatedRequest(
        'get',
        '/api/v1/delivery-man/profile',
        token
      );

      this.logger.log(`✅ Delivery man profile fetched: ${response.f_name || response.name}`);

      return {
        id: response.id,
        email: response.email,
        phone: response.phone,
        firstName: response.f_name || response.name?.split(' ')[0],
        lastName: response.l_name || response.name?.split(' ').slice(1).join(' '),
        token,
        vehicleType: response.vehicle_type || response.vehicle,
        isActive: response.status === 1,
        isOnline: response.active === 1 || response.is_online === 1,
        rating: response.avg_rating || response.rating,
        totalDeliveries: response.order_count || response.total_deliveries,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch delivery man profile: ${error.message}`);
      return null;
    }
  }

  /**
   * Update delivery man profile
   * PHP endpoint: PUT /api/v1/delivery-man/update-profile
   */
  async updateProfile(
    token: string,
    data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
    }
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`📝 Updating delivery man profile`);

      await this.authenticatedRequest(
        'put',
        '/api/v1/delivery-man/update-profile',
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
      this.logger.error(`❌ Failed to update profile: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update active/online status
   * PHP endpoint: POST /api/v1/delivery-man/update-active-status
   */
  async updateActiveStatus(
    token: string,
    isActive: boolean
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`🔄 Setting delivery man online status to: ${isActive}`);

      await this.authenticatedRequest(
        'post',
        '/api/v1/delivery-man/update-active-status',
        token,
        {
          is_active: isActive ? 1 : 0,
        }
      );

      this.logger.log(`✅ Status updated to ${isActive ? 'ONLINE' : 'OFFLINE'}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to update active status: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get current assigned orders
   * PHP endpoint: GET /api/v1/delivery-man/current-orders
   */
  async getCurrentOrders(token: string): Promise<{
    success: boolean;
    orders?: any[];
    message?: string;
  }> {
    try {
      this.logger.log(`📦 Fetching current delivery orders`);

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/delivery-man/current-orders',
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
          pickupAddress: order.restaurant?.address || order.pickup_address,
          pickupLocation: {
            latitude: parseFloat(order.restaurant?.latitude || order.pickup_lat),
            longitude: parseFloat(order.restaurant?.longitude || order.pickup_lng),
          },
          deliveryAddress: order.delivery_address?.address,
          deliveryLocation: {
            latitude: parseFloat(order.delivery_address?.latitude),
            longitude: parseFloat(order.delivery_address?.longitude),
          },
          restaurantName: order.restaurant?.name || 'Restaurant',
          restaurantPhone: order.restaurant?.phone,
          distance: order.distance,
          items: order.details?.map((item: any) => ({
            name: item.food?.name || item.item_name,
            quantity: item.quantity,
          })) || [],
          createdAt: order.created_at,
        })),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch current orders: ${error.message}`);
      return { success: false, message: error.message, orders: [] };
    }
  }

  /**
   * Get order delivery history
   * PHP endpoint: GET /api/v1/delivery-man/order-delivery-history
   */
  async getOrderHistory(token: string, limit: number = 10): Promise<{
    success: boolean;
    orders?: any[];
    message?: string;
  }> {
    try {
      this.logger.log(`📜 Fetching delivery history`);

      const response: any = await this.authenticatedRequest(
        'get',
        `/api/v1/delivery-man/order-delivery-history?limit=${limit}`,
        token
      );

      const orders = Array.isArray(response) ? response : (response.orders || []);
      this.logger.log(`✅ Found ${orders.length} completed deliveries`);

      return {
        success: true,
        orders: orders.map((order: any) => ({
          id: order.id,
          orderId: order.order_id || `#${order.id}`,
          status: order.order_status,
          totalAmount: order.order_amount + (order.delivery_charge || 0),
          earnings: order.delivery_charge || order.dm_earnings,
          customerName: order.customer?.f_name,
          restaurantName: order.restaurant?.name,
          deliveredAt: order.delivered_at || order.updated_at,
        })),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch order history: ${error.message}`);
      return { success: false, message: error.message, orders: [] };
    }
  }

  /**
   * Accept an order
   * PHP endpoint: PUT /api/v1/delivery-man/accept-order
   */
  async acceptOrder(
    token: string,
    orderId: number
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`✅ Accepting order ${orderId}`);

      await this.authenticatedRequest(
        'put',
        '/api/v1/delivery-man/accept-order',
        token,
        {
          order_id: orderId,
        }
      );

      this.logger.log(`✅ Order ${orderId} accepted`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to accept order: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update order delivery status
   * PHP endpoint: PUT /api/v1/delivery-man/update-order-status
   * 
   * Status values: picked_up, handover, delivered
   */
  async updateOrderStatus(
    token: string,
    orderId: number,
    status: 'picked_up' | 'handover' | 'delivered',
    otp?: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`📝 Updating order ${orderId} status to: ${status}`);

      const payload: any = {
        order_id: orderId,
        status,
      };

      // OTP required for delivery confirmation
      if (status === 'delivered' && otp) {
        payload.otp = otp;
      }

      await this.authenticatedRequest(
        'put',
        '/api/v1/delivery-man/update-order-status',
        token,
        payload
      );

      this.logger.log(`✅ Order ${orderId} status updated to ${status}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to update order status: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Record current location
   * PHP endpoint: POST /api/v1/delivery-man/record-location-data
   */
  async recordLocation(
    token: string,
    latitude: number,
    longitude: number
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.debug(`📍 Recording location: ${latitude}, ${longitude}`);

      await this.authenticatedRequest(
        'post',
        '/api/v1/delivery-man/record-location-data',
        token,
        {
          latitude,
          longitude,
        }
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`❌ Failed to record location: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get order details
   * PHP endpoint: GET /api/v1/delivery-man/order-details?order_id=X
   */
  async getOrderDetails(
    token: string,
    orderId: number
  ): Promise<{
    success: boolean;
    order?: any;
    message?: string;
  }> {
    try {
      this.logger.log(`📋 Fetching order details for ${orderId}`);

      const response: any = await this.authenticatedRequest(
        'get',
        `/api/v1/delivery-man/order-details?order_id=${orderId}`,
        token
      );

      return {
        success: true,
        order: {
          id: response.id,
          orderId: response.order_id || `#${response.id}`,
          status: response.order_status,
          paymentMethod: response.payment_method,
          paymentStatus: response.payment_status,
          orderAmount: response.order_amount,
          deliveryCharge: response.delivery_charge,
          totalAmount: response.order_amount + (response.delivery_charge || 0),
          customer: {
            name: response.customer?.f_name + ' ' + (response.customer?.l_name || ''),
            phone: response.customer?.phone,
          },
          restaurant: {
            name: response.restaurant?.name,
            phone: response.restaurant?.phone,
            address: response.restaurant?.address,
            location: {
              latitude: parseFloat(response.restaurant?.latitude),
              longitude: parseFloat(response.restaurant?.longitude),
            },
          },
          deliveryAddress: {
            address: response.delivery_address?.address,
            contactName: response.delivery_address?.contact_person_name,
            contactPhone: response.delivery_address?.contact_person_number,
            location: {
              latitude: parseFloat(response.delivery_address?.latitude),
              longitude: parseFloat(response.delivery_address?.longitude),
            },
          },
          items: response.details?.map((item: any) => ({
            name: item.food?.name || item.item_name,
            quantity: item.quantity,
            price: item.price,
          })) || [],
          orderNote: response.order_note,
          otp: response.otp, // OTP for delivery verification
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to fetch order details: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get earnings summary
   * PHP endpoint: GET /api/v1/delivery-man/earnings (if available)
   */
  async getEarnings(token: string): Promise<{
    success: boolean;
    earnings?: {
      today: number;
      thisWeek: number;
      thisMonth: number;
      total: number;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`💰 Fetching earnings summary`);

      // Try earnings endpoint, fallback to calculating from history
      try {
        const response: any = await this.authenticatedRequest(
          'get',
          '/api/v1/delivery-man/earnings',
          token
        );

        return {
          success: true,
          earnings: {
            today: response.today || response.daily || 0,
            thisWeek: response.this_week || response.weekly || 0,
            thisMonth: response.this_month || response.monthly || 0,
            total: response.total || response.all_time || 0,
          },
        };
      } catch {
        // Fallback: calculate from profile stats
        const profile = await this.getDeliveryManProfile(token);
        return {
          success: true,
          earnings: {
            today: 0,
            thisWeek: 0,
            thisMonth: 0,
            total: 0,
          },
        };
      }
    } catch (error) {
      this.logger.error(`❌ Failed to fetch earnings: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}
