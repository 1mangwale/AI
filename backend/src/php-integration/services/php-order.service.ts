import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { Order, Address } from '../../common/interfaces/common.interface';

/**
 * PHP Order Service
 * Handles all order-related API calls
 */
@Injectable()
export class PhpOrderService extends PhpApiService {
  constructor(configService: ConfigService) {
    super(configService);
  }

  /**
   * Create new parcel delivery order
   */
  async createOrder(token: string, orderData: any): Promise<any> {
    // MOCK FOR TESTING
    if (process.env.TEST_MODE === 'true') {
      this.logger.log('🧪 TEST MODE: Mocking createOrder');
      return {
        success: true,
        orderId: 12345,
        message: 'Order placed successfully (Mock)',
        rawResponse: { id: 12345, message: 'Order placed successfully' },
      };
    }

    try {
      this.logger.log('📦 Creating parcel delivery order');

      if (!orderData.deliveryZoneId) {
        this.logger.warn('deliveryZoneId not provided for parcel order - zone_id will be undefined');
      }
      if (!orderData.senderZoneId) {
        this.logger.warn('senderZoneId not provided for parcel order - zoneId header will be undefined');
      }

      // Build receiver details (JSON string)
      const receiverDetails = {
        contact_person_name: orderData.receiverName,
        contact_person_number: orderData.receiverPhone,
        contact_person_email: orderData.receiverEmail || '',
        address: orderData.deliveryAddress.address,
        latitude: orderData.deliveryAddress.latitude.toString(),  // Must be string
        longitude: orderData.deliveryAddress.longitude.toString(),  // Must be string
        landmark: orderData.deliveryAddress.landmark || '',
        floor: orderData.deliveryAddress.floor || '',
        road: orderData.deliveryAddress.road || '',
        house: orderData.deliveryAddress.house || '',
        zone_id: orderData.deliveryZoneId,  // Zone ID - must be provided by flow context
        address_type: 'Delivery',
      };

      // Prepare order payload matching PHP backend validation
      const payload = {
        // Required fields
        order_type: 'parcel',  // CRITICAL: Must specify order type
        payment_method: orderData.paymentMethod === 'cash' ? 'cash_on_delivery' : (orderData.paymentMethod || 'cash_on_delivery'),
        request_id: orderData.requestId || orderData.request_id || undefined,
        source: orderData.source || 'web',
        source_channel: orderData.source || 'web',
        order_source: orderData.source || 'web',
        
        // Sender (user) contact info - REQUIRED by PHP
        contact_person_name: orderData.senderName || orderData.userName || 'Customer',
        contact_person_number: orderData.senderPhone || orderData.userPhone || '',
        contact_person_email: orderData.senderEmail || orderData.userEmail || '',
        guest_id: orderData.guestId || orderData.userId?.toString() || 'guest_' + Date.now(),
        
        // Sender location (pickup) - FLAT FIELDS
        address: orderData.pickupAddress.address,
        latitude: orderData.pickupAddress.latitude.toString(),  // Must be string
        longitude: orderData.pickupAddress.longitude.toString(),  // Must be string
        floor: orderData.pickupAddress.floor || '',
        road: orderData.pickupAddress.road || '',
        house: orderData.pickupAddress.house || '',
        address_type: 'Pickup',
        
        // Receiver location - JSON STRING
        receiver_details: JSON.stringify(receiverDetails),
        
        // Parcel specific
        parcel_category_id: orderData.parcelCategoryId || 5,  // From user selection
        charge_payer: 'sender',  // Who pays: sender or receiver
        distance: orderData.distance !== undefined && orderData.distance !== null ? orderData.distance : 5,
        
        // Optional
        order_note: orderData.orderNote || '',
        delivery_instruction: orderData.deliveryInstruction || '',
        // CRITICAL: PHP does NOT compute order_amount for parcel orders server-side.
        // Whatever value we send here is what gets stored in the database.
        order_amount: orderData.orderAmount || orderData.totalAmount || 0,
        dm_tips: orderData.dmTips || 0,
      };

      if (!payload.order_amount || payload.order_amount <= 0) {
        this.logger.warn(`⚠️ order_amount is ${payload.order_amount} — pricing may not be computed! orderData.orderAmount=${orderData.orderAmount}, orderData.totalAmount=${orderData.totalAmount}`);
      } else {
        this.logger.log(`💰 Sending order_amount=₹${payload.order_amount} to PHP`);
      }

      this.logger.debug('Order payload:', payload);

      // Prepare headers
      const headers = {
        moduleId: '3',  // Module ID 3 = "Local Delivery" for parcel
        zoneId: JSON.stringify([orderData.senderZoneId]),  // Zone IDs as JSON array - must be provided
      };

      this.logger.debug('Request headers:', headers);

      // Send order creation request with headers
      const response = await this.authenticatedRequest(
        'post',
        '/api/v1/customer/order/place',
        token,
        payload,
        headers,  // Pass headers
      );

      this.logger.log('✅ Order created successfully');
      this.logger.debug('PHP Response:', response);
      
      // Transform PHP response to expected format
      // PHP returns: { message: "Order placed successfully", order_id: 123, ... }
      return {
        success: true,
        orderId: response.order_id || response.id,
        message: response.message || 'Order placed successfully',
        rawResponse: response,
      };
    } catch (error) {
      this.logger.error('Failed to create order:', error.message);
      throw error;
    }
  }

  /**
   * Populate PHP cart for pricing preview.
   * Clears existing cart and adds items so get-Tax can read them.
   * Called by PricingExecutor BEFORE showing order summary.
   * createFoodOrder also clears+repopulates cart at placement time, so double-population is safe.
   */
  async populateCartForPricing(
    token: string,
    items: any[],
    moduleId: number,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      // Clear existing cart
      await this.authenticatedRequest(
        'delete',
        '/api/v1/customer/cart/remove?guest_id=0',
        token,
        null,
        { moduleId: String(moduleId) },
      );

      // Add each item
      for (const item of items) {
        const itemId = item.item_id || item.itemId || item.id;
        if (!itemId) continue;
        try {
          await this.authenticatedRequest(
            'post',
            '/api/v1/customer/cart/add',
            token,
            {
              item_id: itemId,
              quantity: item.quantity || 1,
              variation: item.variation || [],
              add_on_ids: item.add_on_ids || [],
              add_on_qtys: item.add_on_qtys || [],
              model: 'Item',
              price: item.price || 0,
              guest_id: '0',
            },
            { moduleId: String(moduleId) },
          );
        } catch (e) {
          this.logger.debug(`Pricing cart add failed for item ${itemId} (non-blocking): ${e.message}`);
        }
      }

      this.logger.debug(`✅ Cart populated for pricing: ${items.length} items (module ${moduleId})`);
      return { success: true };
    } catch (error) {
      this.logger.warn(`Cart population for pricing failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Create food order (Cart -> Address -> Place)
   * Also used for e-commerce orders with moduleId parameter
   */
  async createFoodOrder(token: string, orderData: any): Promise<any> {
    try {
      if (!orderData.moduleId) {
        throw new Error('moduleId is required in orderData (4 = Food, 5 = E-commerce/Shop, 3 = Parcel)');
      }
      const moduleId = orderData.moduleId;
      this.logger.log(`🍔 Creating ${moduleId === 5 ? 'e-commerce' : 'food'} order`);

      // 1. Add/Get Address ID
      // 🐛 FIX: Race condition-safe address matching using unique request identifier
      let addressId = orderData.addressId;
      if (!addressId && orderData.deliveryAddress) {
        this.logger.debug('Adding new address for order');

        // Generate unique request identifier to prevent race conditions
        // Format: timestamp_randomSuffix (e.g., "1707823456789_a3f2")
        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const deliveryAddr = orderData.deliveryAddress;

        // Add unique marker to address to help identify it later
        // This mitigates race condition where concurrent address creations
        // could cause wrong address to be selected when fetching list
        const addressPayload = {
          address: deliveryAddr.address,
          address_type: 'Other',
          contact_person_name: deliveryAddr.contact_person_name || 'User',
          contact_person_number: deliveryAddr.contact_person_number || '0000000000',
          latitude: deliveryAddr.latitude,
          longitude: deliveryAddr.longitude,
          // Add request_id as metadata (if PHP backend supports storing it)
          // This acts as a unique identifier for matching
          road: deliveryAddr.road || `req_${requestId}`, // Use road field to store request_id if not provided
        };

        const addressResponse = await this.authenticatedRequest(
          'post',
          '/api/v1/customer/address/add',
          token,
          addressPayload
        );

        // Check response for ID (IDEAL: PHP should return address_id here)
        addressId = addressResponse.id || addressResponse.address_id;
        this.logger.debug(`Add address response: ${JSON.stringify(addressResponse)}`);

        // PHP API doesn't return ID in add response, so fetch latest address
        // TODO: Update PHP backend to return address_id in create response to avoid this race condition
        if (!addressId) {
          this.logger.debug('Address ID not in response, fetching address list');
          const addressList = await this.authenticatedRequest(
            'get',
            '/api/v1/customer/address/list',
            token
          );

          const addresses = addressList?.addresses || addressList || [];
          if (Array.isArray(addresses) && addresses.length > 0) {
            this.logger.debug(`Fetched ${addresses.length} addresses for matching`);

            // STRATEGY 1: Match by request_id (embedded in road field)
            let matchingAddress = addresses.find((a: any) =>
              a.road && a.road.includes(`req_${requestId}`)
            );

            if (matchingAddress) {
              this.logger.debug(`✅ Found address by request_id: ${requestId}`);
            } else {
              // STRATEGY 2: Match by coordinates + contact person number (more robust than coordinates alone)
              // This prevents selecting wrong address when multiple users create addresses simultaneously
              matchingAddress = addresses.find((a: any) => {
                const latMatch = Math.abs(parseFloat(a.latitude) - parseFloat(deliveryAddr.latitude)) < 0.0001; // Tighter tolerance: ~11 meters
                const lngMatch = Math.abs(parseFloat(a.longitude) - parseFloat(deliveryAddr.longitude)) < 0.0001;
                const phoneMatch = a.contact_person_number === addressPayload.contact_person_number;

                return latMatch && lngMatch && phoneMatch;
              });

              if (matchingAddress) {
                this.logger.debug(`✅ Found address by coordinates + phone match`);
              } else {
                // STRATEGY 3: Fallback to coordinates only (less strict)
                matchingAddress = addresses.find((a: any) =>
                  Math.abs(parseFloat(a.latitude) - parseFloat(deliveryAddr.latitude)) < 0.001 &&
                  Math.abs(parseFloat(a.longitude) - parseFloat(deliveryAddr.longitude)) < 0.001
                );

                if (matchingAddress) {
                  this.logger.warn(`⚠️ Found address by coordinates only (risky - possible race condition)`);
                } else {
                  // STRATEGY 4: Last resort - most recent address (RISKY in concurrent scenarios)
                  this.logger.warn(`⚠️ No matching address found, using most recent (RISKY - possible race condition)`);
                  matchingAddress = addresses[0];
                }
              }
            }

            addressId = matchingAddress?.id;
            this.logger.debug(`Found address ID: ${addressId} using matching strategy`);
          }
        }
      }

      if (!addressId) {
        throw new Error('Failed to obtain delivery address ID');
      }

      // 2. Clear Cart
      this.logger.debug('Clearing existing cart');
      await this.authenticatedRequest(
        'delete', 
        '/api/v1/customer/cart/remove?guest_id=0', 
        token,
        null,
        { moduleId: String(moduleId) }
      );

      // 3. Add Items to Cart
      // 🐛 FIX: Robust error handling with retry logic to prevent partial cart state
      this.logger.debug(`Adding ${orderData.items.length} items to cart`);
      let storeId = null;
      const cartResults = {
        successful: [] as any[],
        failed: [] as any[],
      };

      // Helper function to add single item with retry logic
      const addItemToCart = async (item: any, maxRetries = 3): Promise<boolean> => {
        const itemId = item.item_id || item.itemId || item.id;
        if (!itemId) {
          this.logger.error(`Item missing ID: ${JSON.stringify(item)}`);
          return false;
        }

        const itemPrice = item.price || item.item_price || 0;
        const payload = {
          item_id: itemId,
          quantity: item.quantity || 1,
          variation: item.variation || item.variant || [],
          add_on_ids: item.addon_ids || item.add_on_ids || [],
          add_on_qtys: item.addon_quantities || item.add_on_qtys || [],
          model: 'Item',
          price: itemPrice,
          guest_id: '0',
        };

        // Retry with exponential backoff
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            this.logger.debug(`Adding item to cart (attempt ${attempt}/${maxRetries}): item_id=${itemId}, quantity=${payload.quantity}, price=${itemPrice}`);

            await this.authenticatedRequest(
              'post',
              '/api/v1/customer/cart/add',
              token,
              payload,
              { moduleId: String(moduleId) }
            );

            // Success!
            this.logger.debug(`✅ Item ${itemId} added to cart successfully`);
            return true;

          } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            this.logger.warn(`⚠️ Failed to add item ${itemId} to cart (attempt ${attempt}/${maxRetries}): ${error.message}`);

            if (isLastAttempt) {
              // All retries exhausted
              this.logger.error(`❌ Failed to add item ${itemId} after ${maxRetries} attempts`);
              return false;
            }

            // Exponential backoff: 500ms, 1000ms, 2000ms
            const backoffMs = 500 * Math.pow(2, attempt - 1);
            this.logger.debug(`⏳ Retrying in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        }

        return false; // Should never reach here, but TypeScript requires it
      };

      // Add all items with error handling
      for (const item of orderData.items) {
        // Extract store ID from first item
        if (!storeId) storeId = item.store_id || item.storeId;

        const success = await addItemToCart(item);

        if (success) {
          cartResults.successful.push(item);
        } else {
          cartResults.failed.push(item);
        }
      }

      // Validate cart state before proceeding to order placement
      const totalItems = orderData.items.length;
      const successCount = cartResults.successful.length;
      const failCount = cartResults.failed.length;

      this.logger.log(`📊 Cart state: ${successCount}/${totalItems} items added successfully, ${failCount} failed`);

      // CRITICAL: Prevent order placement if ALL items failed
      if (successCount === 0) {
        throw new Error(`Failed to add any items to cart. All ${totalItems} items failed. Please try again.`);
      }

      // WARN: Partial success - some items failed
      if (failCount > 0) {
        const failedItemNames = cartResults.failed.map(item => item.name || item.item_name || `Item ${item.id || item.item_id}`).join(', ');
        this.logger.warn(`⚠️ Partial cart failure: ${failCount} items could not be added: ${failedItemNames}`);
        this.logger.warn(`⚠️ Proceeding with ${successCount} items that were successfully added`);

        // TODO: In future, return this info to user so they know some items are missing from order
        // For now, we proceed with partial cart to not block the entire order
      }

      if (!storeId) {
        throw new Error('No store ID found in items');
      }

      // 4. Place Order
      this.logger.debug('Placing final order');
      
      // Get store coordinates to calculate distance
      const storeItem = orderData.items[0];
      const storeLat = storeItem.storeLat || storeItem.store_lat || 0;
      const storeLng = storeItem.storeLng || storeItem.store_lng || 0;
      const userLat = orderData.deliveryAddress?.latitude || 0;
      const userLng = orderData.deliveryAddress?.longitude || 0;
      
      // Calculate distance in km using Haversine formula
      const R = 6371; // Earth's radius in km
      const dLat = (storeLat - userLat) * Math.PI / 180;
      const dLon = (storeLng - userLng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(userLat * Math.PI / 180) * Math.cos(storeLat * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;
      
      // Use user-selected payment method, fall back to digital_payment
      const effectivePaymentMethod = orderData.paymentMethod || 'digital_payment';
      
      const payload: any = {
        store_id: storeId,
        delivery_address_id: addressId,
        payment_method: effectivePaymentMethod,
        delivery_instruction: orderData.orderNote || '',
        order_type: 'delivery',
        // Required fields for delivery orders
        distance: distance.toFixed(2),
        address: orderData.deliveryAddress?.address || 'Delivery Address',
        latitude: userLat,
        longitude: userLng,
      };

      // Attach coupon code if provided
      if (orderData.couponCode) {
        payload.coupon_code = orderData.couponCode;
        this.logger.log(`🏷️ Applying coupon code: ${orderData.couponCode}`);
      }

      this.logger.debug('Order payload:', JSON.stringify(payload));

      const response = await this.authenticatedRequest(
        'post',
        '/api/v1/customer/order/place',
        token,
        payload,
        { moduleId: String(moduleId) } // Pass moduleId in headers
      );

      this.logger.log(`✅ ${moduleId === 1 ? 'E-commerce' : 'Food'} order created successfully`);
      
      return {
        success: true,
        orderId: response.order_id || response.id,
        orderTotal: parseFloat(response.order_amount || 0),  // PHP's actual total (includes delivery, GST, platform charges)
        message: response.message || 'Order placed successfully',
        rawResponse: response,
      };

    } catch (error) {
      this.logger.error('Failed to create food order:', error.message);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Get user's order history
   */
  async getOrders(token: string, limit: number = 10, offset: number = 1, moduleId?: string): Promise<Order[]> {
    try {
      this.logger.log(`📋 Fetching order history${moduleId ? ` (module ${moduleId})` : ''}`);

      const headers: Record<string, string> = {};
      if (moduleId) headers.moduleId = moduleId;

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/customer/order/list',
        token,
        { limit, offset },
        headers,
      );

      // PHP API returns { total_size, limit, offset, orders: [...] }
      const orderList = response?.orders || (Array.isArray(response) ? response : []);
      if (!orderList.length) {
        return [];
      }

      const orders: Order[] = orderList.map((order: any) => ({
        id: order.id,
        userId: order.user_id,
        orderAmount: parseFloat(order.order_amount),
        deliveryCharge: parseFloat(order.delivery_charge || 0),
        orderStatus: order.order_status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        orderNote: order.order_note,
        distance: order.distance,
        vehicleId: order.vehicle_id,
        createdAt: order.created_at ? new Date(order.created_at) : undefined,
        // Parse addresses from JSON strings
        pickupAddress: order.sender_details ? (typeof order.sender_details === 'string' ? JSON.parse(order.sender_details) : order.sender_details) : {},
        deliveryAddress: order.receiver_details ? (typeof order.receiver_details === 'string' ? JSON.parse(order.receiver_details) : order.receiver_details) : {},
      }));

      this.logger.log(`✅ Fetched ${orders.length} orders`);
      return orders;
    } catch (error) {
      this.logger.error(`Failed to fetch orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Get running/active orders
   */
  async getRunningOrders(token: string, moduleId?: string): Promise<Order[]> {
    try {
      this.logger.log(`🚚 Fetching running orders${moduleId ? ` (module ${moduleId})` : ''}`);

      const headers: Record<string, string> = {};
      if (moduleId) headers.moduleId = moduleId;

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/customer/order/running-orders',
        token,
        { limit: 10, offset: 1 },
        headers,
      );

      // PHP API may return { orders: [...] } or a raw array
      const orderList = response?.orders || (Array.isArray(response) ? response : []);
      if (!orderList.length) {
        return [];
      }

      const orders: Order[] = orderList.map((order: any) => ({
        id: order.id,
        userId: order.user_id,
        orderAmount: parseFloat(order.order_amount),
        deliveryCharge: parseFloat(order.delivery_charge || 0),
        orderStatus: order.order_status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        createdAt: order.created_at ? new Date(order.created_at) : undefined,
        pickupAddress: order.sender_details ? JSON.parse(order.sender_details) : {},
        deliveryAddress: order.receiver_details ? JSON.parse(order.receiver_details) : {},
      }));

      this.logger.log(`✅ Found ${orders.length} running orders`);
      return orders;
    } catch (error) {
      this.logger.error(`Failed to fetch running orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Get order details
   */
  async getOrderDetails(token: string, orderId: number): Promise<Order | null> {
    try {
      this.logger.log(`📦 Fetching order details: ${orderId}`);

      const response: any = await this.authenticatedRequest(
        'get',
        '/api/v1/customer/order/details',
        token,
        { order_id: orderId },
      );

      if (!response) {
        this.logger.warn(`📦 Order ${orderId}: No response from PHP API`);
        return null;
      }

      this.logger.debug(`📦 Order ${orderId} raw: order_status=${response.order_status}, payment_status=${response.payment_status}, payment_method=${response.payment_method}`);

      // sender_details and receiver_details may be JSON strings OR already-parsed objects
      const safeParse = (val: any): any => {
        if (!val) return {};
        if (typeof val === 'object') return val;
        try { return JSON.parse(val); } catch { return {}; }
      };

      const order: Order = {
        id: response.id,
        userId: response.user_id,
        orderAmount: parseFloat(response.order_amount),
        deliveryCharge: parseFloat(response.delivery_charge || 0),
        orderStatus: response.order_status,
        paymentMethod: response.payment_method,
        paymentStatus: response.payment_status,
        orderNote: response.order_note,
        distance: response.distance,
        vehicleId: response.vehicle_id,
        createdAt: response.created_at ? new Date(response.created_at) : undefined,
        pickupAddress: safeParse(response.sender_details || response.delivery_address),
        deliveryAddress: safeParse(response.receiver_details),
      };

      this.logger.log(`✅ Order details fetched: status=${order.orderStatus}, payment=${order.paymentStatus}`);
      return order;
    } catch (error) {
      this.logger.error(`Failed to fetch order details: ${error.message}`);
      return null;
    }
  }

  /**
   * Track order (no authentication required)
   */
  async trackOrder(orderId: number): Promise<{
    success: boolean;
    status?: string;
    location?: { latitude: number; longitude: number };
    message?: string;
  }> {
    try {
      this.logger.log(`🔍 Tracking order: ${orderId}`);

      const response: any = await this.get('/api/v1/customer/order/track', { order_id: orderId });

      return {
        success: true,
        status: response.order_status,
        location: response.delivery_man_location
          ? {
              latitude: parseFloat(response.delivery_man_location.latitude),
              longitude: parseFloat(response.delivery_man_location.longitude),
            }
          : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to track order: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(
    token: string,
    orderId: number,
    reason?: string,
    note?: string,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`❌ Canceling order: ${orderId}`);

      await this.authenticatedRequest('put', '/api/v1/customer/order/cancel', token, {
        order_id: orderId,
        reason: reason || 'Customer requested cancellation',
        note: note,
      });

      this.logger.log('✅ Order canceled successfully');
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Check if an order can be cancelled
   * Orders can be cancelled before they are accepted/confirmed
   */
  async checkCancelEligibility(
    token: string,
    orderId: number,
  ): Promise<{ success: boolean; can_cancel: boolean; cancel_reason?: string }> {
    try {
      // Get order details to check status
      const order = await this.getOrderDetails(token, orderId);
      
      if (!order) {
        return {
          success: false,
          can_cancel: false,
          cancel_reason: 'Could not retrieve order details',
        };
      }

      const status = order.orderStatus;
      
      // Orders can only be cancelled in these early statuses
      const cancellableStatuses = ['pending', 'accepted', 'confirmed'];
      const canCancel = cancellableStatuses.includes(status);

      return {
        success: true,
        can_cancel: canCancel,
        cancel_reason: canCancel 
          ? undefined 
          : `Order cannot be cancelled - current status: ${this.formatOrderStatus(status)}`,
      };
    } catch (error) {
      this.logger.error(`Failed to check cancel eligibility: ${error.message}`);
      return {
        success: false,
        can_cancel: false,
        cancel_reason: error.message,
      };
    }
  }

  /**
   * Get available cancellation reasons
   */
  async getCancellationReasons(): Promise<{
    success: boolean;
    reasons?: Array<{ id: number; reason: string }>;
    message?: string;
  }> {
    try {
      const response: any = await this.get('/api/v1/customer/order/cancellation-reasons');
      if (response && Array.isArray(response)) {
        return {
          success: true,
          reasons: response.map((r: any) => ({ id: r.id, reason: r.reason })),
        };
      }
      return { success: false, message: 'No cancellation reasons found' };
    } catch (error) {
      this.logger.error(`Failed to get cancellation reasons: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Request a refund for a delivered order
   */
  async requestRefund(
    token: string,
    orderId: number,
    reason: string,
    note?: string,
    method: string = 'wallet',
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`💸 Requesting refund for order ${orderId}`);
      await this.authenticatedRequest('post', '/api/v1/customer/order/refund-request', token, {
        order_id: orderId,
        customer_reason: reason,
        customer_note: note,
        refund_method: method,
      });
      this.logger.log('✅ Refund requested successfully');
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to request refund: ${error.message}`);
      return { success: false, message: error.response?.data?.message || error.message };
    }
  }

  /**
   * Update payment method
   */
  async updatePaymentMethod(
    token: string,
    orderId: number,
    paymentMethod: string,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.log(`💳 Updating payment method for order: ${orderId}`);

      await this.authenticatedRequest('put', '/api/v1/customer/order/payment-method', token, {
        order_id: orderId,
        payment_method: paymentMethod,
      });

      this.logger.log('✅ Payment method updated');
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update payment method: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Get order status emoji
   */
  getOrderStatusEmoji(status: string): string {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'confirmed':
        return '✅';
      case 'processing':
        return '📦';
      case 'picked_up':
        return '🚚';
      case 'handover':
        return '🤝';
      case 'delivered':
        return '✅';
      case 'canceled':
        return '❌';
      case 'refunded':
        return '💰';
      case 'failed':
        return '❌';
      default:
        return '📋';
    }
  }

  /**
   * Format order status for display
   */
  formatOrderStatus(status: string): string {
    const statusMap: { [key: string]: string } = {
      pending: 'Pending',
      confirmed: 'Confirmed',
      processing: 'Processing',
      picked_up: 'Picked Up',
      handover: 'Handover',
      delivered: 'Delivered',
      canceled: 'Canceled',
      refunded: 'Refunded',
      failed: 'Failed',
    };
    return statusMap[status] || status;
  }

  /**
   * Get "visit again" / reorder suggestions based on past orders
   */
  async getVisitAgain(token: string): Promise<{
    success: boolean;
    items?: Array<{
      id: number;
      name: string;
      price: number;
      storeId: number;
      storeName: string;
      moduleId: number;
    }>;
    message?: string;
  }> {
    try {
      this.logger.log('🔄 Fetching visit-again suggestions');
      const response: any = await this.authenticatedRequest('get', '/api/v1/customer/visit-again', token);
      if (response && Array.isArray(response)) {
        return {
          success: true,
          items: response.map((item: any) => ({
            id: item.id,
            name: item.name,
            price: parseFloat(item.price || 0),
            storeId: item.store_id,
            storeName: item.store?.name || '',
            moduleId: item.module_id || 4,
          })),
        };
      }
      return { success: false, message: 'No past orders found' };
    } catch (error) {
      this.logger.error(`Failed to get visit-again: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}
