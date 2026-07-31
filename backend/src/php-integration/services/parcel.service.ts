import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpHttpClientService } from './http-client.service';
import { OSRMService } from '../../routing/services/osrm.service';

@Injectable()
export class PhpParcelService {
  private readonly logger = new Logger(PhpParcelService.name);
  private readonly defaultModuleId: number;

  constructor(
    private httpClient: PhpHttpClientService,
    private configService: ConfigService,
    private osrmService: OSRMService, // Inject OSRM service for distance calculation
  ) {
    this.defaultModuleId = this.configService.get('php.defaultModuleId');
  }

  async getZoneByLocation(latitude: number, longitude: number): Promise<any> {
    try {
      const response = await this.httpClient.get(
        `/api/v1/config/get-zone-id?lat=${latitude}&lng=${longitude}`,
      );

      if (response.errors) {
        throw new Error(response.errors[0]?.message || 'Zone not found');
      }

      const zoneIds = JSON.parse(response.zone_id);  // [1, 2, 3]
      const zoneData = response.zone_data;

      // Extract active parcel modules from zones. Some zones also expose
      // inactive parcel-like modules (for example Ambulance), which must not
      // drive the live parcel category lookup.
      const parcelModules = [];
      for (const zone of zoneData) {
        for (const module of zone.modules || []) {
          const isActive = module.status === 1 || module.status === '1' || module.status === true;
          if (module.module_type === 'parcel' && isActive && !parcelModules.find(m => m.id === module.id)) {
            parcelModules.push(module);
          }
        }
      }
      const preferredModule =
        parcelModules.find((module) => Number(module.id) === Number(this.defaultModuleId)) ||
        parcelModules[0];

      return {
        zoneIds,
        zoneData,
        parcelModules,
        primaryZoneId: zoneIds[0],
        primaryModuleId: preferredModule?.id || this.defaultModuleId,
      };
    } catch (error) {
      this.logger.error('❌ Error getting zone:', error.message);
      throw error;
    }
  }

  async getParcelCategories(moduleId?: number, zoneId?: number): Promise<any[]> {
    try {
      const mId = moduleId || this.defaultModuleId;
      this.logger.log(`Fetching parcel categories for module ${mId} (Zone: ${zoneId || 'Default'})`);

      const headers: any = {
        'moduleId': mId.toString(),
      };

      if (zoneId) {
        headers['zoneId'] = JSON.stringify([zoneId]);
      }

      const response = await this.httpClient.get(
        '/api/v1/parcel-category',
        headers,
      );

      this.logger.log(`✅ Fetched ${response.length} categories`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error fetching categories:', error.message);
      throw error;
    }
  }

  async createGuestOrder(phoneNumber: string, orderData: any): Promise<any> {
    try {
      this.logger.log(`Creating guest order for ${phoneNumber}`);

      const payload = {
        order_type: 'parcel',
        payment_method: 'digital_payment',
        
        // Guest identification (NO JWT!)
        guest_id: `wa_${phoneNumber}`,
        contact_person_name: orderData.sender_name,
        contact_person_number: phoneNumber,
        contact_person_email: orderData.sender_email,
        
        // Parcel specific
        parcel_category_id: orderData.category_id,
        receiver_details: JSON.stringify({
          contact_person_name: orderData.receiver_name,
          contact_person_number: orderData.receiver_phone,
          contact_person_email: orderData.receiver_email,
          address: orderData.receiver_address,
          floor: orderData.receiver_floor || '',
          road: orderData.receiver_road || '',
          house: orderData.receiver_house || '',
          latitude: orderData.receiver_latitude.toString(),  // STRING!
          longitude: orderData.receiver_longitude.toString(),  // STRING!
          zone_id: orderData.receiver_zone_id,  // NUMBER
          address_type: 'Delivery',
        }),
        charge_payer: 'sender',
        
        // Sender location (pickup)
        distance: orderData.distance,
        address: orderData.sender_address,
        longitude: orderData.sender_longitude.toString(),  // STRING!
        latitude: orderData.sender_latitude.toString(),  // STRING!
        floor: orderData.sender_floor || '',
        road: orderData.sender_road || '',
        house: orderData.sender_house || '',
        address_type: 'Pickup',
        
        // Amounts - CRITICAL: PHP does NOT compute order_amount for parcel orders,
        // it uses whatever we send. Must include delivery_charge + platform_fee (additional_charge)
        order_amount: (orderData.total_charge || orderData.delivery_charge || 0),
        dm_tips: orderData.dm_tips || 0,
        
        // Optional
        order_note: orderData.order_note || '',
        delivery_instruction: orderData.delivery_instruction || '',
        bring_change_amount: 0,
        partial_payment: false,
      };

      const response = await this.httpClient.post(
        '/api/v1/customer/order/place',
        payload,
        {
          'moduleId': orderData.module_id.toString(),
          'zoneId': JSON.stringify(orderData.zone_ids),
        },
      );

      this.logger.log(`✅ Order created: #${response.order_id}`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error creating order:', error.message);
      throw error;
    }
  }

  async trackOrder(orderId: number): Promise<any> {
    try {
      const response = await this.httpClient.get(
        `/api/v1/customer/order/track?order_id=${orderId}`,
      );

      return response;
    } catch (error) {
      this.logger.error(`Error tracking order ${orderId}:`, error.message);
      throw error;
    }
  }

  /**
   * Calculate shipping charge via PHP backend
   * Replaces local calculation logic to ensure zone-based pricing accuracy
   */
  async calculateShippingCharge(
    distance: number,
    parcelCategoryId: number,
    zoneIds: number[]
  ): Promise<{
    total_charge: number;
    delivery_charge: number;
    tax: number;
    platform_fee: number;
    distance: number;
  }> {
    // Mock for testing or when PHP endpoint not available
    const isMockMode = process.env.TEST_MODE === 'true' || process.env.MOCK_PARCEL_PRICING === 'true';
    
    // Platform fee (from config, matching PHP backend)
    const PLATFORM_FEE = this.configService.get<number>('pricing.platformFee') || 5;
    
    // Calculate fallback pricing based on category pricing from PHP
    const calculateLocalPricing = async (dist: number): Promise<{
      total_charge: number;
      delivery_charge: number;
      tax: number;
      platform_fee: number;
      distance: number;
    }> => {
      try {
        // Fetch actual category pricing from PHP
        const zoneIdForPricing = zoneIds[0];
        if (!zoneIdForPricing) {
          this.logger.warn(`⚠️ getParcelCategories called without zone_id — using module default`);
        }
        const categories = await this.getParcelCategories(3, zoneIdForPricing);
        const category = categories.find(c => c.id === parcelCategoryId);
        
        if (category) {
          // Use actual category pricing
          const perKmCharge = parseFloat(category.parcel_per_km_shipping_charge) || 11.11;
          const minimumCharge = parseFloat(category.parcel_minimum_shipping_charge) || 44;
          
          // Calculate: max(minimum, distance * per_km)
          const calculatedCharge = dist * perKmCharge;
          const delivery_charge = Math.max(minimumCharge, Math.round(calculatedCharge * 100) / 100);
          const tax = 0; // No additional tax as PHP doesn't add it
          const total_charge = delivery_charge + PLATFORM_FEE;
          
          this.logger.log(`💰 Category pricing: ${category.name} - ₹${perKmCharge}/km, min ₹${minimumCharge}`);
          this.logger.log(`💰 Calculated: delivery=₹${delivery_charge}, platform=₹${PLATFORM_FEE}, total=₹${total_charge}`);
          
          return {
            total_charge,
            delivery_charge,
            tax,
            platform_fee: PLATFORM_FEE,
            distance: dist
          };
        }
      } catch (catError) {
        this.logger.warn(`⚠️ Failed to fetch category pricing: ${catError.message}`);
      }
      
      // Absolute fallback with default pricing (matching Bike Delivery category)
      const defaultMinimum = 44;
      const defaultPerKm = 11.11;
      const calculatedCharge = dist * defaultPerKm;
      const delivery_charge = Math.max(defaultMinimum, Math.round(calculatedCharge * 100) / 100);
      const total_charge = delivery_charge + PLATFORM_FEE;
      
      this.logger.log(`💰 Using default pricing: delivery=₹${delivery_charge}, platform=₹${PLATFORM_FEE}, total=₹${total_charge}`);
      
      return {
        total_charge,
        delivery_charge,
        tax: 0,
        platform_fee: PLATFORM_FEE,
        distance: dist
      };
    };

    try {
      this.logger.log(`💰 Calculating shipping charge via PHP backend: distance=${distance}, category=${parcelCategoryId}`);

      // We pass zoneId in header as per other requests to ensure zone-specific pricing
      const response = await this.httpClient.post(
        '/api/v1/parcel/shipping-charge',
        {
          distance: distance,
          parcel_category_id: parcelCategoryId,
        },
        {
          'zoneId': JSON.stringify(zoneIds)
        }
      );

      return {
        total_charge: parseFloat(response.total_charge || response.total_amount || 0),
        delivery_charge: parseFloat(response.delivery_charge || 0),
        tax: parseFloat(response.tax || response.tax_amount || 0),
        platform_fee: parseFloat(response.platform_fee || PLATFORM_FEE),
        distance: parseFloat(response.distance || distance)
      };
    } catch (error) {
      this.logger.warn(`⚠️ PHP shipping-charge API failed, using category-based pricing: ${error.message}`);
      // Fallback to category-based calculation
      return await calculateLocalPricing(distance);
    }
  }

  /**
   * Calculate distance between two points using OSRM (1st choice) or Haversine fallback
   * OSRM provides accurate road-based routing, Haversine is straight-line distance
   */
  async calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): Promise<number> {
    try {
      // Try OSRM first for accurate road-based distance
      this.logger.debug(`📍 Calculating distance: (${lat1},${lon1}) → (${lat2},${lon2})`);
      
      const result = await this.osrmService.calculateDistance(
        { latitude: lat1, longitude: lon1 },
        { latitude: lat2, longitude: lon2 },
      );

      if (result) {
        this.logger.debug(`✅ OSRM distance: ${result.distance_km} km`);
        return result.distance_km;
      }

      // OSRM failed, fall back to Haversine
      this.logger.warn('⚠️  OSRM unavailable, using Haversine fallback');
      return this.haversineDistance(lat1, lon1, lat2, lon2);
    } catch (error) {
      this.logger.error(`❌ Distance calculation error: ${error.message}`);
      // Fallback to Haversine on any error
      return this.haversineDistance(lat1, lon1, lat2, lon2);
    }
  }

  /**
   * Haversine formula for straight-line distance (fallback when OSRM unavailable)
   */
  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    this.logger.debug(`📏 Haversine distance: ${Math.round(distance * 100) / 100} km`);
    return Math.round(distance * 100) / 100; // Round to 2 decimals
  }

  private toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  /**
   * PROPER PHP AUTH FLOW: Send OTP via /api/v1/auth/login
   * PHP expects: { login_type: 'otp', phone: '+919158886329' }
   * PHP returns: { token: null, is_phone_verified: 0, is_email_verified: 1, is_personal_info: 1, is_exist_user: null, login_type: 'otp', email: null }
   */
  async sendOtpLogin(phoneNumber: string): Promise<any> {
    try {
      this.logger.log(`🔑 Sending OTP login request to ${phoneNumber}`);

      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
        },
      );

      this.logger.log(`✅ OTP sent to ${phoneNumber}`);
      return { success: true, ...response };
    } catch (error) {
      this.logger.error('❌ Error sending OTP:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * PROPER PHP AUTH FLOW: Verify OTP via /api/v1/auth/login with verified=true
   * PHP expects: { login_type: 'otp', phone: '+919158886329', otp: '123456', verified: true }
   * PHP returns: { token: "eyJ..." (if is_personal_info=1), is_phone_verified: 1, is_email_verified: 1, is_personal_info: 0/1, login_type: 'otp', email: "user@example.com" }
   * 
   * IMPORTANT: PHP searches users table by phone field ONLY
   * If user registered with email (phone field contains email), they won't be found
   * In that case, PHP creates NEW user with this phone number (is_personal_info=0, no token)
   */
  async verifyOtpLogin(phoneNumber: string, otp: string): Promise<any> {
    try {
      this.logger.log(`🔑 Verifying OTP ${otp} for ${phoneNumber}`);

      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
          otp: otp,
          verified: true,
        },
      );

      this.logger.debug(`📦 PHP Response: ${JSON.stringify(response)}`);
      this.logger.log(`✅ OTP verified for ${phoneNumber}, token received: ${response.token ? 'YES' : 'NO'}, is_personal_info: ${response.is_personal_info}`);
      return { success: true, data: response };
    } catch (error) {
      this.logger.error('❌ Error verifying OTP:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Check if user exists in database
   * PHP Backend Note: /api/v1/customer/info requires authentication
   * Instead, we initiate OTP login which works for both existing and new users
   * The PHP backend will send OTP if user exists, or return is_exist_user flag
   */
  async checkUserExists(phoneNumber: string): Promise<any> {
    try {
      this.logger.log(`🔍 Checking if user exists by initiating OTP: ${phoneNumber}`);

      // Call OTP login endpoint - PHP will send OTP if user exists
      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
        },
      );

      // Response: { token: "temp_token", is_phone_verified: 0/1, is_email_verified: 1, is_personal_info: 1, is_exist_user: null, login_type: 'otp', email: null }
      // The OTP is sent to the phone via SMS by PHP backend
      
      this.logger.log(`✅ OTP sent to ${phoneNumber} - User existence check complete`);
      return { 
        exists: true,  // If PHP sends OTP, user exists (or will be created on verification)
        otpSent: true,
        response 
      };
    } catch (error) {
      this.logger.error(`❌ User existence check failed: ${phoneNumber} (PHP API Error: ${error.message})`);
      return { exists: false, otpSent: false, error: error.message };
    }
  }

  /**
   * Send OTP for registration (new users)
   * NOTE: PHP backend doesn't have separate registration OTP endpoint
   * Use the same login OTP flow - it handles both existing and new users
   * User will be created when they verify OTP if they don't exist
   */
  async sendOtpForRegistration(phoneNumber: string): Promise<any> {
    try {
      this.logger.log(`📝 Sending OTP for registration/login to ${phoneNumber}`);

      // Same endpoint as login - PHP handles both cases
      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
        },
      );

      this.logger.log(`✅ OTP sent to ${phoneNumber}`);
      return { success: true, otpSent: true, ...response };
    } catch (error) {
      this.logger.error('❌ Error sending OTP:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update user personal info via /api/v1/auth/update-info
   * FIXED: PHP expects 'name' (full name as single string), not f_name/l_name
   * Note: PHP backend requires: name, email (both mandatory), phone, login_type
   */
  async updateUserInfo(phoneNumber: string, fullName: string, email: string = 'noemail@mangwale.com'): Promise<any> {
    try {
      this.logger.log(`👤 Updating user info for ${phoneNumber}: ${fullName}`);

      const response = await this.httpClient.post(
        '/api/v1/auth/update-info',
        {
          name: fullName,
          email: email,
          phone: phoneNumber,
          login_type: 'otp'
        },
      );

      // Response: { token: "new_jwt_token", is_phone_verified: 1, is_email_verified: 1, is_personal_info: 1, login_type: 'otp', email: "email" }
      this.logger.log(`✅ User info updated for ${phoneNumber}, token received: ${response.token ? 'YES' : 'NO'}`);
      return { success: true, ...response };
    } catch (error) {
      this.logger.error('❌ Error updating user info:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get user profile/info using JWT token
   * PHP Backend: /api/v1/customer/info requires authentication
   */
  async getUserProfile(jwtToken: string): Promise<any> {
    try {
      this.logger.log('🔍 Fetching user profile');

      const response = await this.httpClient.get(
        '/api/v1/customer/info',
        { 'Authorization': `Bearer ${jwtToken}` }
      );

      this.logger.log(`✅ User profile fetched: ${response.f_name} ${response.l_name || ''}`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error fetching user profile:', error.message);
      throw error;
    }
  }

  /**
   * Get user's saved addresses
   * PHP Backend: /api/v1/customer/address requires authentication
   */
  async getUserAddresses(jwtToken: string): Promise<any> {
    try {
      this.logger.log('📍 Fetching user addresses');

      const response = await this.httpClient.get(
        '/api/v1/customer/address',
        { 'Authorization': `Bearer ${jwtToken}` }
      );

      this.logger.log(`✅ Fetched ${response.length || 0} saved addresses`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error fetching addresses:', error.message);
      return [];
    }
  }

  /**
   * Add new address for user
   * PHP Backend: /api/v1/customer/address/add requires authentication
   */
  async addUserAddress(jwtToken: string, addressData: any): Promise<any> {
    try {
      this.logger.log('📍 Adding new address');

      const response = await this.httpClient.post(
        '/api/v1/customer/address/add',
        {
          contact_person_name: addressData.contact_person_name,
          contact_person_number: addressData.contact_person_number,
          address_type: addressData.address_type || 'Other', // Home, Work, Other
          address: addressData.address,
          floor: addressData.floor || '',
          road: addressData.road || '',
          house: addressData.house || '',
          latitude: addressData.latitude.toString(),
          longitude: addressData.longitude.toString(),
        },
        { 'Authorization': `Bearer ${jwtToken}` }
      );

      this.logger.log(`✅ Address added successfully`);
      return { success: true, ...response };
    } catch (error) {
      this.logger.error('❌ Error adding address:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get available modules with optional JWT token
   */
  async getAvailableModules(jwtToken?: string): Promise<any[]> {
    try {
      this.logger.log('Fetching available modules');

      const headers = jwtToken ? { 'Authorization': `Bearer ${jwtToken}` } : {};

      const response = await this.httpClient.get('/api/v1/module', headers);

      this.logger.log(`✅ Fetched ${response.length} modules`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error fetching modules:', error.message);
      throw error;
    }
  }

  /**
   * Create authenticated order with JWT token
   * UPDATED: Now accepts payment_method from orderData
   */
  async createAuthenticatedOrder(jwtToken: string, phoneNumber: string, orderData: any): Promise<any> {
    // Mock for testing
    if (process.env.TEST_MODE === 'true') {
      this.logger.log(`🧪 TEST MODE: Mocking createAuthenticatedOrder for ${phoneNumber}`);
      return {
        order_id: 100000 + Math.floor(Math.random() * 900000),
        message: 'Order placed successfully (Mock)',
        status: 'pending'
      };
    }

    try {
      this.logger.log(`Creating authenticated order for ${phoneNumber}`);

      const payload = {
        order_type: 'parcel',
        payment_method: orderData.payment_method || 'digital_payment', // cash_on_delivery or digital_payment
        
        // Parcel specific
        parcel_category_id: orderData.category_id,
        receiver_details: JSON.stringify({
          contact_person_name: orderData.receiver_name,
          contact_person_number: orderData.receiver_phone,
          contact_person_email: orderData.receiver_email,
          address: orderData.delivery_address,
          floor: orderData.receiver_floor || '',
          road: orderData.receiver_road || '',
          house: orderData.receiver_house || '',
          latitude: orderData.delivery_latitude.toString(),
          longitude: orderData.delivery_longitude.toString(),
          zone_id: orderData.delivery_zone_id,
          address_type: 'Delivery',
          landmark: orderData.delivery_landmark || '', // Add landmark
        }),
        charge_payer: 'sender',
        
        // Pickup location
        distance: orderData.distance,
        address: orderData.pickup_landmark ? `${orderData.pickup_address} (${orderData.pickup_landmark})` : orderData.pickup_address,
        longitude: orderData.pickup_longitude.toString(),
        latitude: orderData.pickup_latitude.toString(),
        floor: orderData.pickup_floor || '',
        road: orderData.pickup_road || '',
        house: orderData.pickup_house || '',
        address_type: 'Pickup',
        
        // Amounts - CRITICAL: PHP does NOT compute order_amount for parcel orders,
        // it uses whatever we send. Must include delivery_charge + platform_fee (additional_charge)
        order_amount: (orderData.total_charge || orderData.delivery_charge || 0),
        dm_tips: orderData.dm_tips || 0,
        
        // Optional
        order_note: orderData.order_note || '',
        delivery_instruction: orderData.delivery_instruction || '',
        bring_change_amount: 0,
        partial_payment: false,
      };

      const response = await this.httpClient.post(
        '/api/v1/customer/order/place',
        payload,
        {
          'Authorization': `Bearer ${jwtToken}`,
          'moduleId': (orderData.module_id || orderData.selected_module_id).toString(),
          'zoneId': orderData.zone_ids ? JSON.stringify(orderData.zone_ids) : JSON.stringify([orderData.pickup_zone_id]),
        },
      );

      this.logger.log(`✅ Authenticated order created: #${response.order_id}`);
      return response;
    } catch (error) {
      this.logger.error('❌ Error creating authenticated order:', error.message);
      throw error;
    }
  }

  /**
   * Get user's saved addresses
   */
  async getSavedAddresses(jwtToken: string, limit: number = 10, offset: number = 1): Promise<any> {
    try {
      this.logger.log('📍 Fetching user\'s saved addresses');

      const response = await this.httpClient.get(
        `/api/v1/customer/address/list?limit=${limit}&offset=${offset}`,
        {
          'Authorization': `Bearer ${jwtToken}`,
        },
      );

      this.logger.log(`✅ Fetched ${response.addresses?.length || 0} saved addresses`);
      return {
        success: true,
        data: response.addresses || [],
        total: response.total_size || 0,
      };
    } catch (error) {
      this.logger.error('❌ Error fetching saved addresses:', error.message);
      return {
        success: false,
        message: error.message,
        data: [],
      };
    }
  }

  /**
   * Save new address to user's account
   */
  async saveAddress(jwtToken: string, addressData: {
    contact_person_name: string;
    contact_person_number: string;
    address_type: string;
    address: string;
    latitude: string;
    longitude: string;
    floor?: string;
    road?: string;
    house?: string;
  }): Promise<any> {
    try {
      this.logger.log(`💾 Saving new ${addressData.address_type} address`);

      const response = await this.httpClient.post(
        '/api/v1/customer/address/add',
        addressData,
        {
          'Authorization': `Bearer ${jwtToken}`,
        },
      );

      this.logger.log('✅ Address saved successfully');
      return {
        success: true,
        message: response.message || 'Address saved successfully',
        zone_ids: response.zone_ids || [],
      };
    } catch (error) {
      this.logger.error('❌ Error saving address:', error.message);
      return {
        success: false,
        message: error.message,
        errors: error.response?.data?.errors || [],
      };
    }
  }

  /**
   * Update existing address
   */
  async updateAddress(jwtToken: string, addressId: number, addressData: {
    contact_person_name: string;
    contact_person_number: string;
    address_type: string;
    address: string;
    latitude: string;
    longitude: string;
    floor?: string;
    road?: string;
    house?: string;
  }): Promise<any> {
    try {
      this.logger.log(`📝 Updating address ID: ${addressId}`);

      const response = await this.httpClient.put(
        `/api/v1/customer/address/update/${addressId}`,
        addressData,
        {
          'Authorization': `Bearer ${jwtToken}`,
        },
      );

      this.logger.log('✅ Address updated successfully');
      return {
        success: true,
        message: response.message || 'Address updated successfully',
        zone_id: response.zone_id,
      };
    } catch (error) {
      this.logger.error('❌ Error updating address:', error.message);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Delete saved address
   */
  async deleteAddress(jwtToken: string, addressId: number): Promise<any> {
    try {
      this.logger.log(`🗑️ Deleting address ID: ${addressId}`);

      const response = await this.httpClient.delete(
        '/api/v1/customer/address/delete',
        {
          'Authorization': `Bearer ${jwtToken}`,
        },
        {
          address_id: addressId,
        },
      );

      this.logger.log('✅ Address deleted successfully');
      return {
        success: true,
        message: response.message || 'Address deleted successfully',
      };
    } catch (error) {
      this.logger.error('❌ Error deleting address:', error.message);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  // Legacy methods for backward compatibility
  async sendOtp(phoneNumber: string): Promise<any> {
    return await this.sendOtpLogin(phoneNumber);
  }

  async verifyOtp(phoneNumber: string, otp: string, token?: string): Promise<any> {
    return await this.verifyOtpLogin(phoneNumber, otp);
  }
}

