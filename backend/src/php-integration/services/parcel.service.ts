import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpHttpClientService } from './http-client.service';
import { PhpOrderService } from './php-order.service';
import { OSRMService } from '../../routing/services/osrm.service';
import { maskPhone } from '../../common/utils/phone.util';
import * as mysql from 'mysql2/promise';

/** Rider-API rate card structure (cached in PHP business_settings) */
interface RateCard {
  pickup: { min_amount: number; min_distance_km: number; approach_per_km: number; max_amount: number };
  drop: { min_amount: number; min_distance_km: number; per_km: number; max_amount: number };
  stop_cost: number;
}

/** Category → vehicle type mapping */
interface CategoryVehicleMap {
  [categoryId: number]: string; // e.g. 5 → 'BIKE', 9 → '3_WHEELER'
}

@Injectable()
export class PhpParcelService {
  private readonly logger = new Logger(PhpParcelService.name);
  private readonly defaultModuleId: number;
  private mysqlPool: mysql.Pool | null = null;

  // Cache rate cards and category→vehicle mapping (refresh every 10 min)
  private rateCardCache: Map<string, RateCard> = new Map();
  private categoryVehicleMap: CategoryVehicleMap = {};
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private mysqlFallbackActive = false;

  constructor(
    private httpClient: PhpHttpClientService,
    private configService: ConfigService,
    private osrmService: OSRMService,
    private phpOrderService: PhpOrderService,
  ) {
    this.defaultModuleId = this.configService.get('php.defaultModuleId');
    this.initMysqlPool();
  }

  private initMysqlPool(): void {
    try {
      const host = process.env.MYSQL_HOST || '127.0.0.1';
      const port = parseInt(process.env.MYSQL_PORT || '13307');
      const user = process.env.MYSQL_USERNAME || 'readonly';
      const password = process.env.MYSQL_PASSWORD;
      const database = process.env.MYSQL_DATABASE || 'mangwale_db';

      if (!password) {
        this.logger.warn('⚠️ MYSQL_PASSWORD not set — rate card pricing will use hardcoded fallback');
        this.mysqlFallbackActive = true;
        return;
      }

      this.mysqlPool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 3,
        queueLimit: 0,
      });
      this.logger.log(`✅ MySQL pool initialized for rate card pricing (${host}:${port})`);
    } catch (error) {
      this.logger.warn(`⚠️ MySQL pool init failed: ${error.message}`);
      this.mysqlFallbackActive = true;
    }
  }

  /**
   * Refresh rate cards and category→vehicle mapping from PHP MySQL DB.
   * Reads `business_settings.cached_rider_rate_card_*` and `parcel_categories.vehicle_type`.
   */
  private async refreshRateCardCache(): Promise<void> {
    if (!this.mysqlPool) return;
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS && this.rateCardCache.size > 0) return;

    try {
      // Fetch rate cards
      const [rateRows]: any = await this.mysqlPool.execute(
        `SELECT \`key\`, value FROM business_settings WHERE \`key\` LIKE 'cached_rider_rate_card_%'`
      );
      for (const row of rateRows) {
        const vehicleType = row.key.replace('cached_rider_rate_card_', '');
        try {
          this.rateCardCache.set(vehicleType, JSON.parse(row.value));
        } catch (e) {
          this.logger.warn(`⚠️ Failed to parse rate card for ${vehicleType}: ${e.message}`);
        }
      }

      // Fetch category → vehicle_type mapping
      const [catRows]: any = await this.mysqlPool.execute(
        `SELECT id, vehicle_type FROM parcel_categories WHERE vehicle_type IS NOT NULL`
      );
      for (const row of catRows) {
        this.categoryVehicleMap[row.id] = row.vehicle_type;
      }

      this.cacheTimestamp = Date.now();
      this.logger.log(`✅ Rate card cache refreshed: ${this.rateCardCache.size} cards, ${catRows.length} categories`);
    } catch (error) {
      this.logger.warn(`⚠️ Failed to refresh rate card cache: ${error.message}`);
    }
  }

  /**
   * Compute delivery charge using rider-api rate card formula.
   * Matches PHP DeliveryChargeService::computeRateCardPrice() exactly.
   */
  private computeRateCardPrice(rateCard: RateCard, distanceKm: number): number {
    const drop = rateCard.drop;
    const pickup = rateCard.pickup;

    // Drop earnings (based on delivery distance)
    let dropEarning: number;
    if (distanceKm <= drop.min_distance_km) {
      dropEarning = drop.min_amount;
    } else {
      dropEarning = Math.min(
        drop.min_amount + (distanceKm - drop.min_distance_km) * drop.per_km,
        drop.max_amount,
      );
    }

    // Pickup earnings (assume avg 1km pickup approach)
    const pickupApproachKm = 1;
    let pickupEarning: number;
    if (pickupApproachKm <= pickup.min_distance_km) {
      pickupEarning = pickup.min_amount;
    } else {
      pickupEarning = Math.min(
        pickup.min_amount + (pickupApproachKm - pickup.min_distance_km) * pickup.approach_per_km,
        pickup.max_amount,
      );
    }

    return Math.round((dropEarning + pickupEarning) * 100) / 100;
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

      // Extract parcel modules from zones
      const parcelModules = [];
      for (const zone of zoneData) {
        for (const module of zone.modules || []) {
          if (module.module_type === 'parcel' && !parcelModules.find(m => m.id === module.id)) {
            parcelModules.push(module);
          }
        }
      }

      return {
        zoneIds,
        zoneData,
        parcelModules,
        primaryZoneId: zoneIds[0],
        primaryModuleId: parcelModules[0]?.id || this.defaultModuleId,
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
      this.logger.log(`Creating guest order for ${maskPhone(phoneNumber)}`);

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
        vehicle_type: orderData.vehicle_type || null,
        receiver_details: JSON.stringify({
          contact_person_name: orderData.receiver_name,
          contact_person_number: orderData.receiver_phone,
          contact_person_email: orderData.receiver_email,
          address: orderData.receiver_address,
          floor: orderData.receiver_floor || '',
          road: orderData.receiver_road || '',
          house: orderData.receiver_house || '',
          latitude: orderData.receiver_latitude.toString(),
          longitude: orderData.receiver_longitude.toString(),
          zone_id: orderData.receiver_zone_id,
          address_type: 'Delivery',
        }),
        charge_payer: 'sender',

        // Sender location (pickup)
        distance: orderData.distance,
        address: orderData.sender_address,
        longitude: orderData.sender_longitude.toString(),
        latitude: orderData.sender_latitude.toString(),
        floor: orderData.sender_floor || '',
        road: orderData.sender_road || '',
        house: orderData.sender_house || '',
        address_type: 'Pickup',

        // Amounts — PHP recalculates delivery_charge server-side from rate cards
        order_amount: (orderData.total_charge || orderData.delivery_charge || 0),
        additional_charge: orderData.platform_fee || 5,
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
   * Calculate shipping charge using rider-api rate cards from PHP DB.
   * Matches PHP DeliveryChargeService::calculateParcelDeliveryCharge() exactly.
   * Flow: MySQL rate_card lookup → computeRateCardPrice() → add platform fee + GST
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
    vehicle_type?: string;
  }> {
    const PLATFORM_FEE = this.configService.get<number>('pricing.platformFee') || 5;
    const GST_RATE = 0.05; // 5% GST on delivery + platform fee (tax_id=1 in PHP)

    this.logger.log(`💰 Calculating shipping: distance=${distance}km, category=${parcelCategoryId}`);

    try {
      // Refresh rate card cache from MySQL
      await this.refreshRateCardCache();

      // Look up vehicle type for this category
      const vehicleType = this.categoryVehicleMap[parcelCategoryId] || 'BIKE';
      const rateCard = this.rateCardCache.get(vehicleType);

      if (rateCard) {
        const delivery_charge = this.computeRateCardPrice(rateCard, distance);
        const tax = Math.round((delivery_charge + PLATFORM_FEE) * GST_RATE * 100) / 100;
        const total_charge = Math.round((delivery_charge + PLATFORM_FEE + tax) * 100) / 100;

        this.logger.log(`💰 Rate card pricing (${vehicleType}): delivery=₹${delivery_charge}, platform=₹${PLATFORM_FEE}, tax=₹${tax}, total=₹${total_charge}`);

        return { total_charge, delivery_charge, tax, platform_fee: PLATFORM_FEE, distance, vehicle_type: vehicleType };
      }

      this.logger.warn(`⚠️ No rate card found for ${vehicleType}, using BIKE hardcoded fallback`);
    } catch (error) {
      this.logger.warn(`⚠️ Rate card lookup failed: ${error.message}`);
    }

    // Hardcoded BIKE rate card fallback (matches PHP DeliveryChargeService::getRateCard fallback)
    const fallbackRateCard: RateCard = {
      pickup: { min_amount: 8, min_distance_km: 1.5, approach_per_km: 6, max_amount: 40 },
      drop: { min_amount: 25, min_distance_km: 3, per_km: 7, max_amount: 130 },
      stop_cost: 10,
    };
    const delivery_charge = this.computeRateCardPrice(fallbackRateCard, distance);
    const tax = Math.round((delivery_charge + PLATFORM_FEE) * GST_RATE * 100) / 100;
    const total_charge = Math.round((delivery_charge + PLATFORM_FEE + tax) * 100) / 100;

    this.logger.log(`💰 Fallback pricing (BIKE): delivery=₹${delivery_charge}, platform=₹${PLATFORM_FEE}, tax=₹${tax}, total=₹${total_charge}`);

    return { total_charge, delivery_charge, tax, platform_fee: PLATFORM_FEE, distance, vehicle_type: 'BIKE' };
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
   * Applies 1.3x multiplier to approximate road distance from straight-line distance
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
    const straightLine = R * c;
    const roadApprox = straightLine * 1.3; // 1.3x road-distance approximation

    this.logger.warn(`Haversine fallback: straight-line ${Math.round(straightLine * 100) / 100} km * 1.3 = ${Math.round(roadApprox * 100) / 100} km`);
    return Math.round(roadApprox * 100) / 100; // Round to 2 decimals
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
      this.logger.log(`🔑 Sending OTP login request to ${maskPhone(phoneNumber)}`);

      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
        },
      );

      this.logger.log(`✅ OTP sent to ${maskPhone(phoneNumber)}`);
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
      this.logger.log(`🔑 Verifying OTP for ${maskPhone(phoneNumber)}`);

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
      this.logger.log(`✅ OTP verified for ${maskPhone(phoneNumber)}, token received: ${response.token ? 'YES' : 'NO'}, is_personal_info: ${response.is_personal_info}`);
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
      this.logger.log(`🔍 Checking if user exists by initiating OTP: ${maskPhone(phoneNumber)}`);

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
      
      this.logger.log(`✅ OTP sent to ${maskPhone(phoneNumber)} - User existence check complete`);
      return { 
        exists: true,  // If PHP sends OTP, user exists (or will be created on verification)
        otpSent: true,
        response 
      };
    } catch (error) {
      this.logger.error(`❌ User existence check failed: ${maskPhone(phoneNumber)} (PHP API Error: ${error.message})`);
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
      this.logger.log(`📝 Sending OTP for registration/login to ${maskPhone(phoneNumber)}`);

      // Same endpoint as login - PHP handles both cases
      const response = await this.httpClient.post(
        '/api/v1/auth/login',
        {
          login_type: 'otp',
          phone: phoneNumber,
        },
      );

      this.logger.log(`✅ OTP sent to ${maskPhone(phoneNumber)}`);
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
      this.logger.log(`👤 Updating user info for ${maskPhone(phoneNumber)}: ${fullName}`);

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
      this.logger.log(`✅ User info updated for ${maskPhone(phoneNumber)}, token received: ${response.token ? 'YES' : 'NO'}`);
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
      this.logger.log(`🧪 TEST MODE: Mocking createAuthenticatedOrder for ${maskPhone(phoneNumber)}`);
      return {
        order_id: 100000 + Math.floor(Math.random() * 900000),
        message: 'Order placed successfully (Mock)',
        status: 'pending'
      };
    }

    try {
      this.logger.log(`Creating authenticated order for ${maskPhone(phoneNumber)}`);

      const payload = {
        order_type: 'parcel',
        payment_method: orderData.payment_method || 'digital_payment', // cash_on_delivery or digital_payment

        // Parcel specific
        parcel_category_id: orderData.category_id,
        vehicle_type: orderData.vehicle_type || null, // BIKE, 3_WHEELER, 4_WHEELER — PHP derives from category if null
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
          landmark: orderData.delivery_landmark || '',
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

        // Amounts — PHP is server-authoritative for delivery_charge (recalculates from rate cards),
        // but uses our additional_charge (platform fee) and order_amount as reference
        order_amount: (orderData.total_charge || orderData.delivery_charge || 0),
        additional_charge: orderData.platform_fee || 5, // Platform fee — PHP uses this for parcel orders
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

  /**
   * Get the user's most recent parcel order (module_id=3) for one-tap reorder.
   * Returns pickup/delivery addresses with lat/lng, recipient, vehicle, payment method.
   */
  async getLastParcelOrder(authToken: string): Promise<{
    orderId: number;
    pickupAddress: any;
    deliveryAddress: any;
    recipientName: string;
    recipientPhone: string;
    vehicleId: number;
    paymentMethod: string;
    distance: number;
    orderAmount: number;
    createdAt?: Date;
  } | null> {
    try {
      this.logger.log('🔄 Fetching last parcel order for reorder');

      // Call PHP API directly to get raw parcel order data (getOrders loses delivery_address field)
      const response = await this.phpOrderService.getOrdersRaw(authToken, 1, 1, '3');
      const orderList = response?.orders || response?.data || [];

      if (!orderList.length) {
        this.logger.log('No previous parcel orders found');
        return null;
      }

      const rawOrder = orderList[0];
      // PHP parcel orders: delivery_address = PICKUP (sender), receiver_details = DELIVERY (receiver)
      const pickup = rawOrder.delivery_address || {};
      let receiver: Record<string, any> = {};
      if (rawOrder.receiver_details) {
        if (typeof rawOrder.receiver_details === 'string') {
          try {
            receiver = JSON.parse(rawOrder.receiver_details);
          } catch (parseErr) {
            this.logger.warn(`⚠️ Failed to parse receiver_details JSON: ${parseErr.message}`);
            return null;
          }
        } else {
          receiver = rawOrder.receiver_details;
        }
      }

      const pickupLat = pickup.latitude;
      const pickupLng = pickup.longitude;
      const deliveryLat = receiver.latitude;
      const deliveryLng = receiver.longitude;

      if (!pickupLat || !pickupLng || !deliveryLat || !deliveryLng) {
        this.logger.warn(`⚠️ Last parcel order missing coordinates — pickup: (${pickupLat}, ${pickupLng}), delivery: (${deliveryLat}, ${deliveryLng})`);
        return null;
      }

      const result = {
        orderId: rawOrder.id,
        pickupAddress: {
          address: pickup.address || '',
          latitude: parseFloat(pickupLat),
          longitude: parseFloat(pickupLng),
          floor: pickup.floor || '',
          road: pickup.road || '',
          house: pickup.house || '',
          landmark: pickup.landmark || '',
        },
        deliveryAddress: {
          address: receiver.address || '',
          latitude: parseFloat(deliveryLat),
          longitude: parseFloat(deliveryLng),
          floor: receiver.floor || '',
          road: receiver.road || '',
          house: receiver.house || '',
          landmark: receiver.landmark || '',
          zone_id: receiver.zone_id,
        },
        recipientName: receiver.contact_person_name || receiver.name || '',
        recipientPhone: receiver.contact_person_number || receiver.phone || '',
        vehicleId: rawOrder.parcel_category_id || rawOrder.vehicle_category_id || rawOrder.vehicle_id || 0,
        paymentMethod: rawOrder.payment_method || 'cash_on_delivery',
        distance: rawOrder.distance ? parseFloat(String(rawOrder.distance)) : 0,
        orderAmount: parseFloat(rawOrder.order_amount) || 0,
        createdAt: rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
      };

      this.logger.log(`✅ Last parcel order: #${result.orderId} — ${result.pickupAddress.address} → ${result.deliveryAddress.address}`);
      return result;
    } catch (error) {
      this.logger.error(`❌ Failed to fetch last parcel order: ${error.message}`);
      return null;
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


