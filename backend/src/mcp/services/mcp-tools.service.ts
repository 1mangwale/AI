import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PhpStoreService } from '../../php-integration/services/php-store.service';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { PhpWalletService } from '../../php-integration/services/php-wallet.service';
import { PhpCouponService } from '../../php-integration/services/php-coupon.service';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';
import { PhpPersonalizationService } from '../../php-integration/services/php-personalization.service';
import { ZoneService } from '../../zones/services/zone.service';
import { SearchAIIntegrationService } from '../../search/services/search-ai-integration.service';

/**
 * MCP Tools Service
 *
 * Implements all MCP tool handlers that wrap existing Mangwale services.
 * Each method corresponds to a single MCP tool callable by AI agents.
 *
 * Tools follow the convention:
 * - Discovery tools (no auth): search_restaurants, get_restaurant_menu, search_items, check_serviceability, get_coupons, get_payment_methods, get_categories
 * - Transactional tools (auth required): add_to_cart, place_order, get_addresses, get_wallet_balance, get_order_status, get_order_history, cancel_order, add_address, send_otp, verify_otp
 */
@Injectable()
export class McpToolsService {
  private readonly logger = new Logger(McpToolsService.name);
  private readonly phpBaseUrl: string;
  private readonly searchApiUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
    private readonly storeService: PhpStoreService,
    private readonly orderService: PhpOrderService,
    private readonly addressService: PhpAddressService,
    private readonly walletService: PhpWalletService,
    private readonly couponService: PhpCouponService,
    private readonly paymentService: PhpPaymentService,
    private readonly personalizationService: PhpPersonalizationService,
    private readonly zoneService: ZoneService,
    @Optional() private readonly searchAI?: SearchAIIntegrationService,
  ) {
    this.phpBaseUrl = this.config.get('PHP_API_BASE_URL') || 'https://new.mangwale.com';
    this.searchApiUrl = this.config.get('SEARCH_API_URL') || 'http://localhost:3100';
  }

  // ─── Discovery Tools (No Auth) ──────────────────────────────

  async searchRestaurants(params: {
    query?: string;
    lat?: number;
    lng?: number;
    radius_km?: number;
    veg_only?: boolean;
    cuisine?: string;
    limit?: number;
  }): Promise<any> {
    const { query, lat, lng, radius_km = 10, veg_only, cuisine, limit = 10 } = params;

    try {
      // Use Search API for better results (hybrid BM25+KNN)
      const searchParams: Record<string, string> = {
        module_ids: '4', // Food module
        size: String(limit),
        type: 'stores',
      };
      if (query) searchParams.q = query;
      if (lat && lng) {
        searchParams.lat = String(lat);
        searchParams.lon = String(lng);
        searchParams.radius_km = String(radius_km);
      }
      if (veg_only) searchParams.veg = '1';
      if (cuisine) searchParams.q = `${query || ''} ${cuisine}`.trim();

      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/stores`, { params: searchParams }),
      );

      const stores = response.data?.results || response.data?.stores || [];
      return {
        restaurants: stores.slice(0, limit).map((s: any) => ({
          id: s.id || s.store_id,
          name: s.name || s.store_name,
          description: s.description || '',
          cuisine: s.cuisine || s.category_name || '',
          rating: s.rating || s.avg_rating || 0,
          delivery_time: s.delivery_time || s.estimated_delivery_time || '30-45 min',
          is_open: s.is_open ?? s.active ?? true,
          address: s.address || '',
          image: s.cover_photo || s.logo || '',
          distance_km: s.distance_km || s.distance || null,
        })),
        total: stores.length,
      };
    } catch (err) {
      this.logger.error(`searchRestaurants failed: ${err.message}`);
      // Fallback to PHP API
      try {
        const phpResult = await this.storeService.searchStores(query || 'restaurant');
        return { restaurants: phpResult || [], total: (phpResult || []).length };
      } catch {
        return { restaurants: [], total: 0, error: 'Search service unavailable' };
      }
    }
  }

  async getRestaurantMenu(params: {
    store_id: number;
    lat?: number;
    lng?: number;
  }): Promise<any> {
    try {
      // Use Search API which has all items indexed with categories
      const searchParams: Record<string, string> = {
        q: '*',
        module_ids: '4',
        store_id: String(params.store_id),
        size: '100',
        zone_id: '4',
      };
      if (params.lat) searchParams.lat = String(params.lat);
      if (params.lng) searchParams.lon = String(params.lng);

      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/items`, { params: searchParams }),
      );

      const items = response.data?.items || [];
      const storeInfo = response.data?.resolved_store || {};

      if (items.length === 0) {
        return { error: 'Restaurant not found or menu unavailable' };
      }

      // Group items by category
      const categoryMap = new Map<string, any[]>();
      for (const item of items) {
        const catName = item.category_path || item.category_name || 'Other';
        if (!categoryMap.has(catName)) categoryMap.set(catName, []);
        categoryMap.get(catName).push({
          id: item.id,
          name: item.name,
          description: item.description || '',
          price: item.price,
          image: item.image || '',
          veg: item.veg === 1 || item.veg === true,
          available: item.status === 1,
        });
      }

      const categories = Array.from(categoryMap.entries()).map(([name, catItems]) => ({
        name,
        items: catItems,
      }));

      return {
        store_id: params.store_id,
        store_name: storeInfo.name || '',
        delivery_time: storeInfo.delivery_time || '',
        categories,
        total_items: items.length,
      };
    } catch (err) {
      this.logger.error(`getRestaurantMenu failed: ${err.message}`);
      return { error: 'Failed to fetch menu' };
    }
  }

  async searchItems(params: {
    query: string;
    module?: 'food' | 'ecommerce';
    lat?: number;
    lng?: number;
    veg_only?: boolean;
    price_max?: number;
    sort?: string;
    limit?: number;
  }): Promise<any> {
    const { query, module = 'food', lat, lng, veg_only, price_max, sort, limit = 10 } = params;
    const moduleId = module === 'food' ? 4 : 5;

    try {
      const searchParams: Record<string, string> = {
        q: query,
        module_ids: String(moduleId),
        size: String(limit),
      };
      if (lat && lng) {
        searchParams.lat = String(lat);
        searchParams.lon = String(lng);
      }
      if (veg_only) searchParams.veg = '1';
      if (price_max) searchParams.price_max = String(price_max);
      if (sort) searchParams.sort = sort;

      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/v2/search/items`, { params: searchParams }),
      );

      const items = response.data?.results || response.data?.items || [];
      return {
        items: items.slice(0, limit).map((item: any) => ({
          id: item.id || item.item_id,
          name: item.name || item.item_name,
          description: item.description || '',
          price: item.price,
          store_id: item.store_id,
          store_name: item.store_name,
          image: item.image || item.image_url || '',
          veg: item.veg === 1 || item.veg === true,
          rating: item.avg_rating || item.rating || 0,
          category: item.category_name || '',
        })),
        total: items.length,
        query,
      };
    } catch (err) {
      this.logger.error(`searchItems failed: ${err.message}`);
      return { items: [], total: 0, error: 'Search service unavailable' };
    }
  }

  async checkServiceability(params: {
    lat: number;
    lng: number;
  }): Promise<any> {
    try {
      const result = await this.zoneService.getZoneIdByCoordinates(params.lat, params.lng);
      if (!result) {
        return {
          serviceable: false,
          message: 'Sorry, Mangwale does not yet serve this area. We are expanding soon!',
        };
      }
      return {
        serviceable: true,
        zone_id: result.zone_id,
        zone_name: result.zone_name,
        available_services: result.available_modules || [],
        payment_methods: result.payment_methods || [],
      };
    } catch (err) {
      this.logger.error(`checkServiceability failed: ${err.message}`);
      return { serviceable: false, error: 'Failed to check serviceability' };
    }
  }

  async getCoupons(params: { auth_token?: string }): Promise<any> {
    try {
      const result = await this.couponService.getCoupons(params.auth_token);
      const coupons = result?.coupons || [];
      return {
        coupons: coupons.map((c: any) => ({
          code: c.code,
          title: c.title || c.name,
          description: c.description || '',
          discount_type: c.discount_type, // percent or amount
          discount: c.discount,
          min_purchase: c.min_purchase || 0,
          max_discount: c.max_discount || 0,
          valid_until: c.expire_date || c.valid_until,
        })),
      };
    } catch (err) {
      this.logger.error(`getCoupons failed: ${err.message}`);
      return { coupons: [], error: 'Failed to fetch coupons' };
    }
  }

  // ─── Transactional Tools (Auth Required) ─────────────────────

  async addToCart(params: {
    auth_token: string;
    items: Array<{ id: number; quantity: number }>;
    store_id?: number;
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required. Use send_otp and verify_otp to authenticate.' };

    try {
      const cartItems = params.items.map(i => ({
        item_id: i.id,
        quantity: i.quantity,
        price: 0, // PHP backend resolves price
      }));

      const result = await this.orderService.populateCartForPricing(
        params.auth_token,
        cartItems,
        4, // Food module
      );

      return {
        success: result.success,
        message: result.success ? 'Items added to cart' : (result.message || 'Failed to add items'),
      };
    } catch (err) {
      this.logger.error(`addToCart failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async placeOrder(params: {
    auth_token: string;
    address_id: number;
    payment_method: 'cash_on_delivery' | 'digital_payment' | 'wallet';
    coupon_code?: string;
    order_note?: string;
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required' };
    if (!params.address_id) return { error: 'address_id is required. Use get_addresses to find saved addresses.' };

    try {
      const result = await this.orderService.createFoodOrder(params.auth_token, {
        moduleId: 4,
        addressId: params.address_id,
        paymentMethod: params.payment_method,
        couponCode: params.coupon_code || '',
        orderNote: params.order_note || '',
      });

      if (result?.orderId) {
        return {
          success: true,
          order_id: result.orderId,
          total: result.orderTotal || result.total,
          status: 'confirmed',
          message: `Order #${result.orderId} placed successfully!`,
          payment_link: result.paymentLink || null,
        };
      }
      return { success: false, error: result?.message || 'Order placement failed' };
    } catch (err) {
      this.logger.error(`placeOrder failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async getAddresses(params: { auth_token: string }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required' };

    try {
      const addresses = await this.addressService.getAddresses(params.auth_token);
      return {
        addresses: (addresses || []).map((a: any) => ({
          id: a.id,
          type: a.type || 'other', // home, office, other
          address: a.address,
          latitude: a.latitude,
          longitude: a.longitude,
          house: a.house || '',
          road: a.road || '',
          floor: a.floor || '',
        })),
      };
    } catch (err) {
      this.logger.error(`getAddresses failed: ${err.message}`);
      return { addresses: [], error: 'Failed to fetch addresses' };
    }
  }

  async getWalletBalance(params: { auth_token: string }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required' };

    try {
      const result = await this.walletService.getWalletBalance(params.auth_token);
      return {
        balance: result.balance || 0,
        formatted: result.formattedBalance || `₹${result.balance || 0}`,
        currency: 'INR',
      };
    } catch (err) {
      this.logger.error(`getWalletBalance failed: ${err.message}`);
      return { balance: 0, error: 'Failed to fetch balance' };
    }
  }

  // ─── Authentication Tools ────────────────────────────────────

  async sendOtp(params: { phone: string }): Promise<any> {
    if (!params.phone) return { error: 'phone number is required (e.g., +919876543210)' };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.phpBaseUrl}/api/v1/auth/send-otp`, {
          phone: params.phone,
        }),
      );
      return {
        success: true,
        message: 'OTP sent to your phone. Use verify_otp to complete authentication.',
      };
    } catch (err) {
      this.logger.error(`sendOtp failed: ${err.message}`);
      return { success: false, error: 'Failed to send OTP' };
    }
  }

  async verifyOtp(params: { phone: string; otp: string }): Promise<any> {
    if (!params.phone || !params.otp) return { error: 'phone and otp are required' };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.phpBaseUrl}/api/v1/auth/verify-otp`, {
          phone: params.phone,
          otp: params.otp,
        }),
      );

      const data = response.data;
      if (data?.token) {
        return {
          success: true,
          auth_token: data.token,
          user: {
            id: data.user?.id,
            name: data.user?.name || data.user?.f_name,
            phone: data.user?.phone,
          },
          message: 'Authenticated! Use this auth_token for cart, order, and payment tools.',
        };
      }
      return { success: false, error: data?.message || 'OTP verification failed' };
    } catch (err) {
      this.logger.error(`verifyOtp failed: ${err.message}`);
      return { success: false, error: 'OTP verification failed' };
    }
  }

  // ─── Order Management Tools ─────────────────────────────────

  async getOrderStatus(params: {
    auth_token: string;
    order_id: number;
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required. Use send_otp + verify_otp to get an auth_token first.' };
    if (!params.order_id) return { error: 'order_id is required.' };

    try {
      const order = await this.orderService.getOrderDetails(params.auth_token, params.order_id);
      if (!order) {
        return { error: `Order #${params.order_id} not found` };
      }

      return {
        order_id: order.id,
        status: order.orderStatus,
        payment_method: order.paymentMethod,
        payment_status: order.paymentStatus,
        order_amount: order.orderAmount,
        delivery_charge: order.deliveryCharge,
        order_note: order.orderNote || '',
        created_at: order.createdAt?.toISOString() || null,
      };
    } catch (err) {
      this.logger.error(`getOrderStatus failed: ${err.message}`);
      return { error: 'Failed to fetch order status' };
    }
  }

  async getOrderHistory(params: {
    auth_token: string;
    limit?: number;
    module?: 'food' | 'ecommerce' | 'parcel';
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required. Use send_otp + verify_otp to get an auth_token first.' };

    const moduleMap = { food: '4', ecommerce: '5', parcel: '3' };
    const moduleId = params.module ? moduleMap[params.module] : undefined;

    try {
      const orders = await this.orderService.getOrders(
        params.auth_token,
        params.limit || 10,
        1,
        moduleId,
      );

      return {
        orders: orders.map((o: any) => ({
          id: o.id,
          status: o.orderStatus,
          amount: o.orderAmount,
          delivery_charge: o.deliveryCharge,
          payment_method: o.paymentMethod,
          payment_status: o.paymentStatus,
          created_at: o.createdAt?.toISOString() || null,
        })),
        total: orders.length,
      };
    } catch (err) {
      this.logger.error(`getOrderHistory failed: ${err.message}`);
      return { orders: [], total: 0, error: 'Failed to fetch order history' };
    }
  }

  async cancelOrder(params: {
    auth_token: string;
    order_id: number;
    reason?: string;
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required. Use send_otp + verify_otp to get an auth_token first.' };
    if (!params.order_id) return { error: 'order_id is required.' };

    try {
      // Check eligibility first
      const eligibility = await this.orderService.checkCancelEligibility(
        params.auth_token,
        params.order_id,
      );

      if (!eligibility.can_cancel) {
        return {
          success: false,
          message: eligibility.cancel_reason || 'Order cannot be cancelled at this stage.',
        };
      }

      // Proceed with cancellation
      const result = await this.orderService.cancelOrder(
        params.auth_token,
        params.order_id,
        params.reason || 'Customer requested cancellation',
      );

      return {
        success: result.success,
        message: result.success
          ? `Order #${params.order_id} cancelled successfully.`
          : (result.message || 'Cancellation failed'),
      };
    } catch (err) {
      this.logger.error(`cancelOrder failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async addAddress(params: {
    auth_token: string;
    address: string;
    lat: number;
    lng: number;
    type?: 'home' | 'office' | 'other';
    house?: string;
    road?: string;
    floor?: string;
  }): Promise<any> {
    if (!params.auth_token) return { error: 'auth_token is required. Use send_otp + verify_otp to get an auth_token first.' };
    if (!params.address) return { error: 'address is required.' };
    if (!params.lat || !params.lng) return { error: 'lat and lng are required.' };

    try {
      const result = await this.addressService.addAddress(params.auth_token, {
        contactPersonName: 'User',
        contactPersonNumber: '',
        addressType: params.type || 'other',
        address: params.address,
        latitude: String(params.lat),
        longitude: String(params.lng),
        house: params.house || '',
        road: params.road || '',
        floor: params.floor || '',
      });

      return {
        success: result.success,
        address_id: result.addressId || null,
        message: result.success
          ? 'Address added successfully. Use get_addresses to see all saved addresses.'
          : (result.message || 'Failed to add address'),
      };
    } catch (err) {
      this.logger.error(`addAddress failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Discovery Tools (cont.) ────────────────────────────────

  async getPaymentMethods(params: {
    module?: 'food' | 'ecommerce' | 'parcel';
  }): Promise<any> {
    const moduleMap = { food: 4, ecommerce: 5, parcel: 3 };
    const moduleId = params.module ? moduleMap[params.module] : 4;

    try {
      const result = await this.paymentService.getPaymentMethods(moduleId);

      if (!result.success) {
        return { methods: [], error: result.message || 'Failed to fetch payment methods' };
      }

      return {
        methods: (result.methods || []).map((m: any) => ({
          id: m.id,
          name: m.name,
          type: m.type,
        })),
        partial_payment_enabled: result.partialPaymentEnabled || false,
      };
    } catch (err) {
      this.logger.error(`getPaymentMethods failed: ${err.message}`);
      return { methods: [], error: 'Failed to fetch payment methods' };
    }
  }

  // ─── Conversational Search (Tool #18) ─────────────────────

  async conversationalSearch(params: {
    query: string;
    previous_query?: string;
    previous_results?: Array<{ item_id: number; name: string; price: number }>;
    module?: 'food' | 'ecommerce';
    zone_id?: number;
  }): Promise<any> {
    if (!this.searchAI) {
      return { error: 'Conversational search not available — Search AI integration not configured' };
    }

    const moduleMap = { food: 4, ecommerce: 5 };
    const moduleId = params.module ? moduleMap[params.module] : 4;

    try {
      const result = await this.searchAI.conversationalSearch(
        params.query,
        {
          previous_query: params.previous_query,
          previous_results: params.previous_results,
        },
        {
          module_id: moduleId,
          zone_id: params.zone_id,
        },
      );

      if (!result) {
        // Fallback to regular search
        return this.searchItems({ query: params.query, module: params.module });
      }

      return {
        query: params.query,
        understanding: result.understanding || {},
        results: result.results || result.items || [],
        refinement_applied: !!params.previous_query,
        total: result.total || (result.results || result.items || []).length,
      };
    } catch (err) {
      this.logger.error(`conversationalSearch failed: ${err.message}`);
      // Graceful fallback to regular search
      return this.searchItems({ query: params.query, module: params.module });
    }
  }

  // ─── Recipe-Based Ordering (Tool #19) ──────────────────────

  /**
   * Decompose a recipe/meal name into ingredients and search for matching items.
   * Inspired by Swiggy's "order ingredients for Thai curry" capability.
   *
   * Uses the LLM (via SearchAIIntegrationService) to understand the recipe,
   * then performs parallel searches for each ingredient group.
   */
  async orderByRecipe(params: {
    recipe_or_meal: string;
    servings?: number;
    module?: 'food' | 'ecommerce';
    lat?: number;
    lng?: number;
    veg_only?: boolean;
  }): Promise<any> {
    const { recipe_or_meal, servings = 2, module = 'food', lat, lng, veg_only } = params;

    // Common Indian recipe ingredient mappings (fast path, no LLM needed)
    const recipeDb: Record<string, { ingredients: string[]; dish_searches: string[] }> = {
      'paneer butter masala': {
        ingredients: ['paneer', 'butter', 'tomato', 'cream', 'onion', 'ginger garlic paste', 'kasuri methi'],
        dish_searches: ['paneer butter masala', 'paneer makhani'],
      },
      'chicken biryani': {
        ingredients: ['chicken', 'basmati rice', 'onion', 'yogurt', 'biryani masala', 'saffron', 'ghee'],
        dish_searches: ['chicken biryani', 'dum biryani'],
      },
      'dal makhani': {
        ingredients: ['urad dal', 'rajma', 'butter', 'cream', 'tomato', 'ginger garlic paste'],
        dish_searches: ['dal makhani'],
      },
      'chole bhature': {
        ingredients: ['chickpeas', 'onion', 'tomato', 'chole masala', 'maida', 'yogurt'],
        dish_searches: ['chole bhature', 'chole'],
      },
      'masala dosa': {
        ingredients: ['dosa batter', 'potato', 'onion', 'mustard seeds', 'curry leaves', 'chutney'],
        dish_searches: ['masala dosa', 'dosa'],
      },
      'pav bhaji': {
        ingredients: ['potato', 'cauliflower', 'capsicum', 'peas', 'tomato', 'pav bhaji masala', 'pav buns', 'butter'],
        dish_searches: ['pav bhaji'],
      },
      'palak paneer': {
        ingredients: ['paneer', 'spinach', 'onion', 'tomato', 'cream', 'ginger garlic paste'],
        dish_searches: ['palak paneer'],
      },
      'veg pulao': {
        ingredients: ['basmati rice', 'mixed vegetables', 'ghee', 'whole spices', 'onion'],
        dish_searches: ['veg pulao', 'vegetable pulao'],
      },
      'thai green curry': {
        ingredients: ['coconut milk', 'green curry paste', 'basil', 'bamboo shoots', 'tofu or chicken', 'fish sauce', 'lime'],
        dish_searches: ['thai green curry'],
      },
      'pasta': {
        ingredients: ['pasta', 'olive oil', 'garlic', 'tomato sauce', 'cheese', 'basil'],
        dish_searches: ['pasta', 'spaghetti'],
      },
    };

    // Normalize recipe name for lookup
    const normalizedRecipe = recipe_or_meal.toLowerCase().trim()
      .replace(/^order\s+(ingredients?\s+for\s+)?/, '')
      .replace(/^make\s+/, '')
      .replace(/^cook\s+/, '')
      .trim();

    // Try exact match first, then partial match
    let matched = recipeDb[normalizedRecipe];
    if (!matched) {
      const partialKey = Object.keys(recipeDb).find(k => normalizedRecipe.includes(k) || k.includes(normalizedRecipe));
      if (partialKey) matched = recipeDb[partialKey];
    }

    // If we have a match, search for the dish directly (food module)
    // or search for ingredients (ecommerce/grocery module)
    const results: Array<{ category: string; query: string; items: any[] }> = [];

    if (matched) {
      if (module === 'food') {
        // For food module: search for the ready-made dish from restaurants
        for (const dishQuery of matched.dish_searches) {
          try {
            const searchResult = await this.searchItems({
              query: dishQuery,
              module: 'food',
              lat,
              lng,
              veg_only,
              limit: 5,
            });
            if (searchResult.items?.length > 0) {
              results.push({ category: 'Ready-to-eat', query: dishQuery, items: searchResult.items });
            }
          } catch { /* skip failed searches */ }
        }
      } else {
        // For ecommerce module: search for raw ingredients
        for (const ingredient of matched.ingredients) {
          try {
            const searchResult = await this.searchItems({
              query: ingredient,
              module: 'ecommerce',
              lat,
              lng,
              limit: 3,
            });
            if (searchResult.items?.length > 0) {
              results.push({ category: 'Ingredient', query: ingredient, items: searchResult.items });
            }
          } catch { /* skip failed searches */ }
        }
      }

      return {
        recipe: recipe_or_meal,
        servings,
        mode: module === 'food' ? 'order_ready_dish' : 'order_ingredients',
        ingredients: matched.ingredients,
        results,
        total_options: results.reduce((sum, r) => sum + r.items.length, 0),
        tip: module === 'food'
          ? 'These are ready-to-eat dishes from nearby restaurants. Use add_to_cart to order.'
          : `These are raw ingredients for ${servings} servings. Adjust quantities as needed.`,
      };
    }

    // No recipe match — do a general search for the dish/meal name
    const generalSearch = await this.searchItems({
      query: recipe_or_meal,
      module,
      lat,
      lng,
      veg_only,
      limit: 10,
    });

    return {
      recipe: recipe_or_meal,
      servings,
      mode: 'general_search',
      results: [{ category: 'Search results', query: recipe_or_meal, items: generalSearch.items || [] }],
      total_options: generalSearch.items?.length || 0,
      tip: `No exact recipe match for "${recipe_or_meal}". Showing general search results. Try specific dish names like "paneer butter masala" or "chicken biryani".`,
    };
  }

  // ─── Personalization Tools (Tool #20) ─────────────────────

  /**
   * Get personalized recommendations based on type.
   * Requires authentication (auth_token from verify_otp).
   */
  async getRecommendations(params: {
    auth_token: string;
    type?: 'hybrid' | 'reorder' | 'complementary';
    zone_id?: number;
    limit?: number;
  }): Promise<any> {
    if (!params.auth_token) {
      return { error: 'auth_token is required. Use send_otp + verify_otp to authenticate.' };
    }

    const type = params.type || 'hybrid';
    const limit = params.limit || 10;
    const zoneId = params.zone_id || 4; // default zone

    try {
      let items: any[];

      switch (type) {
        case 'reorder':
          items = await this.personalizationService.getReorderSuggestions(
            params.auth_token,
            limit,
          );
          break;
        case 'complementary':
          items = await this.personalizationService.getComplementaryItems(
            params.auth_token,
            zoneId,
            limit,
          );
          break;
        case 'hybrid':
        default:
          items = await this.personalizationService.getRecommendations(
            params.auth_token,
            zoneId,
            limit,
          );
          break;
      }

      return {
        type,
        recommendations: (items || []).map((item: any) => ({
          id: item.id || item.item_id,
          name: item.name || item.item_name,
          description: item.description || '',
          price: item.price,
          store_id: item.store_id,
          store_name: item.store_name || '',
          image: item.image || item.image_url || '',
          rating: item.avg_rating || item.rating || 0,
          reason: item.reason || item.recommendation_reason || '',
        })),
        total: (items || []).length,
      };
    } catch (err) {
      this.logger.error(`getRecommendations failed: ${err.message}`);
      return { recommendations: [], total: 0, error: 'Failed to fetch recommendations' };
    }
  }

  async getCategories(params: {
    module?: 'food' | 'ecommerce';
    store_id?: number;
  }): Promise<any> {
    const module = params.module || 'food';
    const moduleId = module === 'food' ? 4 : 5;

    try {
      if (params.store_id) {
        // Get categories from a specific store's menu
        const menu = await this.storeService.getStoreMenu(params.store_id);
        const categories = (menu?.categories || menu || []).map((cat: any) => ({
          name: cat.name || cat.category_name,
          item_count: (cat.items || cat.products || []).length,
        }));
        return { store_id: params.store_id, categories, total: categories.length };
      }

      // Get categories from Search API admin endpoint
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/admin/categories`, {
          params: { module_id: String(moduleId), size: '100' },
        }),
      );

      const data = response.data?.data || response.data || [];
      // Return top-level categories (parent_id=0) for cleaner results
      const allCategories = Array.isArray(data) ? data : [];
      const topLevel = allCategories.filter((c: any) => c.parent_id === 0 || c.parent_id === null);
      const result = (topLevel.length > 0 ? topLevel : allCategories).map((c: any) => ({
        id: c.id,
        name: c.name,
        slug: c.slug || '',
        image: c.image || '',
      }));

      return {
        categories: result,
        total: response.data?.meta?.total || result.length,
        module,
      };
    } catch (err) {
      this.logger.error(`getCategories failed: ${err.message}`);
      return { categories: [], error: 'Failed to fetch categories' };
    }
  }
}
