import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { Pool } from 'pg';

/**
 * User Context Service
 * 
 * Provides comprehensive user context for personalized AI interactions.
 * Combines data from:
 * - MySQL (PHP backend): Orders, wallet, addresses, loyalty points
 * - PostgreSQL (NestJS): User preferences, conversation memory, insights
 * 
 * This enables "smart history" where the AI knows:
 * - User's favorite stores and items
 * - Typical order patterns (time, frequency, value)
 * - Dietary preferences and restrictions
 * - Wallet balance and loyalty points
 * - Recent conversations and context
 */

export interface UserOrderHistory {
  totalOrders: number;
  deliveredOrders: number;
  canceledOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  lastOrderDate: Date | null;
  recentOrders: Array<{
    orderId: number;
    status: string;
    amount: number;
    storeName: string;
    moduleType: string;
    createdAt: Date;
    items: string[];
  }>;
  favoriteStores: Array<{
    storeId: number;
    storeName: string;
    orderCount: number;
    moduleType: string;
  }>;
  favoriteItems: Array<{
    itemId: number;
    itemName: string;
    orderCount: number;
    category: string;
  }>;
  ordersByModule: Record<string, number>;
}

export interface UserWalletInfo {
  balance: number;
  loyaltyPoints: number;
  recentTransactions: Array<{
    type: string;
    amount: number;
    reference: string;
    createdAt: Date;
  }>;
  totalCashbackEarned: number;
  totalReferralEarnings: number;
}

export interface UserAddressInfo {
  savedAddresses: Array<{
    id: number;
    type: string;
    address: string;
    latitude: number;
    longitude: number;
    contactName: string;
    contactPhone: string;
  }>;
  defaultAddress: {
    address: string;
    latitude: number;
    longitude: number;
  } | null;
}

export interface UserPreferences {
  dietaryType: string | null; // veg, non-veg, eggetarian
  dietaryRestrictions: string[];
  allergies: string[];
  favoriteCuisines: string[];
  dislikedIngredients: string[];
  priceSensitivity: string; // budget, moderate, premium
  preferredMealTimes: Record<string, string>; // breakfast: "8-10am"
  communicationTone: string; // formal, casual, friendly
}

export interface ConversationMemory {
  recentTopics: string[];
  pendingRequests: string[];
  lastInteractionDate: Date | null;
  conversationCount: number;
  extractedInsights: Array<{
    type: string;
    value: string;
    confidence: number;
  }>;
}

export interface UserContext {
  // Basic Info
  userId: number;
  phone: string;
  firstName: string;
  lastName: string;
  email: string;
  isVerified: boolean;
  memberSince: Date;
  
  // Order & Transaction History
  orderHistory: UserOrderHistory;
  wallet: UserWalletInfo;
  addresses: UserAddressInfo;
  
  // Preferences & Memory
  preferences: UserPreferences;
  conversationMemory: ConversationMemory;
  
  // Smart Summary for AI
  personalizedGreeting: string;
  contextSummary: string;
  suggestedActions: string[];
}

@Injectable()
export class UserContextService {
  private readonly logger = new Logger(UserContextService.name);
  private mysqlPool: mysql.Pool;
  private pgPool: Pool;

  constructor(private configService: ConfigService) {
    this.initializePools();
  }

  // Circuit breaker for MySQL connection
  private mysqlCircuitOpen = false;
  private mysqlLastFailure = 0;
  private readonly MYSQL_CIRCUIT_RESET_MS = 60000; // 1 minute

  private async initializePools() {
    // MySQL connection (PHP backend)
    const mysqlHost = process.env.MYSQL_HOST;
    const mysqlPort = parseInt(process.env.MYSQL_PORT || '3306');
    const mysqlUser = process.env.MYSQL_USERNAME || process.env.MYSQL_USER;
    const mysqlPassword = process.env.MYSQL_PASSWORD;
    const mysqlDatabase = process.env.MYSQL_DATABASE;

    if (!mysqlHost || !mysqlUser || !mysqlPassword || !mysqlDatabase) {
      this.logger.warn('⚠️ MySQL credentials not configured via env vars (MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE). MySQL features disabled.');
      this.mysqlCircuitOpen = true;
      return;
    }

    try {
      this.mysqlPool = mysql.createPool({
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 2000, // 2 second connection timeout
      });
      this.logger.log(`✅ MySQL pool initialized (${mysqlHost}:${mysqlPort})`);
    } catch (error) {
      this.logger.error(`❌ MySQL connection failed: ${error.message}`);
      this.mysqlCircuitOpen = true;
    }

    // PostgreSQL connection (NestJS preferences)
    const pgUrl = process.env.DATABASE_URL;

    if (!pgUrl) {
      this.logger.warn('⚠️ DATABASE_URL not configured. PostgreSQL features disabled.');
      return;
    }

    try {
      this.pgPool = new Pool({
        connectionString: pgUrl,
        max: 10,
        idleTimeoutMillis: 30000,
      });
      this.logger.log('✅ PostgreSQL pool initialized');
    } catch (error) {
      this.logger.error(`❌ PostgreSQL connection failed: ${error.message}`);
    }
  }

  /**
   * Get comprehensive user context by phone number
   */
  async getUserContext(phone: string): Promise<UserContext | null> {
    try {
      // Normalize phone
      const normalizedPhone = this.normalizePhone(phone);
      
      // Get user from MySQL
      const user = await this.getUserFromMySQL(normalizedPhone);
      if (!user) {
        this.logger.log(`User not found for phone: ${normalizedPhone}`);
        return null;
      }

      // Fetch all data in parallel
      const [orderHistory, wallet, addresses, preferences, memory] = await Promise.all([
        this.getOrderHistory(user.id),
        this.getWalletInfo(user.id),
        this.getAddresses(user.id),
        this.getPreferences(user.id, normalizedPhone),
        this.getConversationMemory(user.id, normalizedPhone),
      ]);

      // Build personalized greeting and summary
      const greeting = this.buildPersonalizedGreeting(user, orderHistory);
      const summary = this.buildContextSummary(user, orderHistory, wallet, preferences);
      const suggestions = this.generateSuggestedActions(orderHistory, wallet);

      return {
        userId: user.id,
        phone: normalizedPhone,
        firstName: user.f_name || '',
        lastName: user.l_name || '',
        email: user.email || '',
        isVerified: user.is_phone_verified === 1,
        memberSince: user.created_at,
        orderHistory,
        wallet,
        addresses,
        preferences,
        conversationMemory: memory,
        personalizedGreeting: greeting,
        contextSummary: summary,
        suggestedActions: suggestions,
      };
    } catch (error) {
      this.logger.error(`Failed to get user context: ${error.message}`);
      return null;
    }
  }

  /**
   * Get user from MySQL by phone - with circuit breaker
   */
  private async getUserFromMySQL(phone: string): Promise<any | null> {
    if (!this.mysqlPool) return null;

    // Circuit breaker check - skip if circuit is open
    if (this.mysqlCircuitOpen) {
      const timeSinceFailure = Date.now() - this.mysqlLastFailure;
      if (timeSinceFailure < this.MYSQL_CIRCUIT_RESET_MS) {
        // Circuit still open, skip MySQL call
        return null;
      }
      // Try to reset circuit
      this.logger.log('🔄 MySQL circuit breaker: attempting reset...');
      this.mysqlCircuitOpen = false;
    }

    try {
      const phoneVariants = [
        phone,
        phone.replace(/^\+/, ''),
        phone.replace(/^\+91/, ''),
      ];

      const [rows] = await this.mysqlPool.query(
        `SELECT id, f_name, l_name, email, phone, wallet_balance, loyalty_point, 
                order_count, is_phone_verified, is_email_verified, created_at
         FROM users 
         WHERE phone IN (?, ?, ?) 
         LIMIT 1`,
        phoneVariants
      );

      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch (error) {
      // Open circuit on failure
      this.mysqlCircuitOpen = true;
      this.mysqlLastFailure = Date.now();
      this.logger.warn(`⚡ MySQL circuit breaker opened: ${error.message}`);
      return null;
    }
  }

  /**
   * Get order history from MySQL
   */
  private async getOrderHistory(userId: number): Promise<UserOrderHistory> {
    if (!this.mysqlPool) {
      this.logger.warn('MySQL pool not initialized for order history');
      return this.emptyOrderHistory();
    }

    try {
      this.logger.debug(`Fetching order history for user ${userId}`);
      
      // Get order summary
      const [summaryRows] = await this.mysqlPool.query(
        `SELECT 
          COUNT(*) as total_orders,
          SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN order_status = 'canceled' THEN 1 ELSE 0 END) as canceled,
          COALESCE(SUM(order_amount), 0) as total_spent,
          COALESCE(AVG(order_amount), 0) as avg_order,
          MAX(created_at) as last_order
         FROM orders 
         WHERE user_id = ?`,
        [userId]
      );
      
      const summaryArr = summaryRows as any[];
      if (!summaryArr || summaryArr.length === 0) {
        this.logger.warn(`No order summary found for user ${userId}`);
        return this.emptyOrderHistory();
      }
      
      const summary = summaryArr[0];
      this.logger.debug(`Order summary: ${JSON.stringify(summary)}`);
      
      const totalOrders = Number(summary.total_orders) || 0;
      const deliveredOrders = Number(summary.delivered) || 0;
      const canceledOrders = Number(summary.canceled) || 0;
      const totalSpent = Number(summary.total_spent) || 0;
      const avgOrderValue = Number(summary.avg_order) || 0;

      // Get recent orders with items
      const [recentRows] = await this.mysqlPool.query(
        `SELECT o.id, o.order_status, o.order_amount, o.created_at,
                s.name as store_name, m.module_type
         FROM orders o
         LEFT JOIN stores s ON o.store_id = s.id
         LEFT JOIN modules m ON o.module_id = m.id
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC
         LIMIT 10`,
        [userId]
      );

      // Get order items for recent orders
      const recentOrders = [];
      for (const order of recentRows as any[]) {
        const [itemRows] = await this.mysqlPool.query(
          `SELECT JSON_UNQUOTE(JSON_EXTRACT(item_details, '$.name')) as item_name
           FROM order_details 
           WHERE order_id = ?
           LIMIT 5`,
          [order.id]
        );
        recentOrders.push({
          orderId: order.id,
          status: order.order_status,
          amount: parseFloat(order.order_amount),
          storeName: order.store_name || 'Unknown',
          moduleType: order.module_type || 'unknown',
          createdAt: order.created_at,
          items: (itemRows as any[]).map(i => i.item_name).filter(Boolean),
        });
      }

      // Get favorite stores
      const [storeRows] = await this.mysqlPool.query(
        `SELECT s.id, s.name, COUNT(*) as order_count, m.module_type
         FROM orders o
         JOIN stores s ON o.store_id = s.id
         LEFT JOIN modules m ON o.module_id = m.id
         WHERE o.user_id = ? AND o.order_status = 'delivered'
         GROUP BY s.id, s.name, m.module_type
         ORDER BY order_count DESC
         LIMIT 5`,
        [userId]
      );

      // Get favorite items - using full expressions in GROUP BY for SQL strict mode
      const [itemRows] = await this.mysqlPool.query(
        `SELECT 
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.id')) as item_id,
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.name')) as item_name,
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.category_ids[0].name')) as category,
          COUNT(*) as order_count
         FROM order_details od
         JOIN orders o ON od.order_id = o.id
         WHERE o.user_id = ? AND o.order_status = 'delivered'
         GROUP BY 
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.id')),
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.name')),
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.category_ids[0].name'))
         ORDER BY order_count DESC
         LIMIT 10`,
        [userId]
      );

      // Get orders by module
      const [moduleRows] = await this.mysqlPool.query(
        `SELECT m.module_type, COUNT(*) as count
         FROM orders o
         JOIN modules m ON o.module_id = m.id
         WHERE o.user_id = ?
         GROUP BY m.module_type`,
        [userId]
      );

      const ordersByModule: Record<string, number> = {};
      for (const row of moduleRows as any[]) {
        ordersByModule[row.module_type] = row.count;
      }

      return {
        totalOrders,
        deliveredOrders,
        canceledOrders,
        totalSpent,
        avgOrderValue,
        lastOrderDate: summary.last_order,
        recentOrders,
        favoriteStores: (storeRows as any[]).map(s => ({
          storeId: s.id,
          storeName: s.name,
          orderCount: s.order_count,
          moduleType: s.module_type,
        })),
        favoriteItems: (itemRows as any[]).map(i => ({
          itemId: parseInt(i.item_id),
          itemName: i.item_name,
          orderCount: i.order_count,
          category: i.category || 'Unknown',
        })),
        ordersByModule,
      };
    } catch (error) {
      this.logger.error(`Failed to get order history: ${error.message}`);
      return this.emptyOrderHistory();
    }
  }

  /**
   * Get wallet info from MySQL
   */
  private async getWalletInfo(userId: number): Promise<UserWalletInfo> {
    if (!this.mysqlPool) {
      return { balance: 0, loyaltyPoints: 0, recentTransactions: [], totalCashbackEarned: 0, totalReferralEarnings: 0 };
    }

    try {
      // Get balance from users table
      const [userRows] = await this.mysqlPool.query(
        'SELECT wallet_balance, loyalty_point FROM users WHERE id = ?',
        [userId]
      );
      const user = (userRows as any[])[0] || {};

      // Get recent transactions
      const [txRows] = await this.mysqlPool.query(
        `SELECT transaction_type, debit, credit, reference, created_at
         FROM wallet_transactions
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId]
      );

      // Calculate totals
      const [totalsRows] = await this.mysqlPool.query(
        `SELECT 
          SUM(CASE WHEN transaction_type = 'CashBack' THEN credit ELSE 0 END) as cashback,
          SUM(CASE WHEN transaction_type = 'referrer' THEN credit ELSE 0 END) as referral
         FROM wallet_transactions
         WHERE user_id = ?`,
        [userId]
      );
      const totals = (totalsRows as any[])[0] || {};

      return {
        balance: parseFloat(user.wallet_balance) || 0,
        loyaltyPoints: parseFloat(user.loyalty_point) || 0,
        recentTransactions: (txRows as any[]).map(tx => ({
          type: tx.transaction_type,
          amount: parseFloat(tx.credit) || -parseFloat(tx.debit),
          reference: tx.reference,
          createdAt: tx.created_at,
        })),
        totalCashbackEarned: parseFloat(totals.cashback) || 0,
        totalReferralEarnings: parseFloat(totals.referral) || 0,
      };
    } catch (error) {
      this.logger.error(`Failed to get wallet info: ${error.message}`);
      return { balance: 0, loyaltyPoints: 0, recentTransactions: [], totalCashbackEarned: 0, totalReferralEarnings: 0 };
    }
  }

  /**
   * Get saved addresses from MySQL
   */
  private async getAddresses(userId: number): Promise<UserAddressInfo> {
    if (!this.mysqlPool) {
      return { savedAddresses: [], defaultAddress: null };
    }

    try {
      const [rows] = await this.mysqlPool.query(
        `SELECT id, address_type, address, latitude, longitude, 
                contact_person_name, contact_person_number
         FROM customer_addresses
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [userId]
      );

      const addresses = (rows as any[]).map(a => ({
        id: a.id,
        type: a.address_type || 'other',
        address: a.address,
        latitude: parseFloat(a.latitude),
        longitude: parseFloat(a.longitude),
        contactName: a.contact_person_name,
        contactPhone: a.contact_person_number,
      }));

      // First address (most recent) as default
      const defaultAddress = addresses.length > 0 ? {
        address: addresses[0].address,
        latitude: addresses[0].latitude,
        longitude: addresses[0].longitude,
      } : null;

      return { savedAddresses: addresses, defaultAddress };
    } catch (error) {
      this.logger.error(`Failed to get addresses: ${error.message}`);
      return { savedAddresses: [], defaultAddress: null };
    }
  }

  /**
   * Get preferences from PostgreSQL
   */
  private async getPreferences(userId: number, phone: string): Promise<UserPreferences> {
    const defaults: UserPreferences = {
      dietaryType: null,
      dietaryRestrictions: [],
      allergies: [],
      favoriteCuisines: [],
      dislikedIngredients: [],
      priceSensitivity: 'moderate',
      preferredMealTimes: {},
      communicationTone: 'friendly',
    };

    if (!this.pgPool) return defaults;

    try {
      const result = await this.pgPool.query(
        `SELECT * FROM user_profiles WHERE user_id = $1 OR phone = $2 LIMIT 1`,
        [userId, phone]
      );

      if (result.rows.length === 0) return defaults;

      const profile = result.rows[0];
      return {
        dietaryType: profile.dietary_type,
        dietaryRestrictions: profile.dietary_restrictions || [],
        allergies: profile.allergies || [],
        favoriteCuisines: profile.favorite_cuisines || [],
        dislikedIngredients: profile.disliked_ingredients || [],
        priceSensitivity: profile.price_sensitivity || 'moderate',
        preferredMealTimes: profile.preferred_meal_times || {},
        communicationTone: profile.communication_tone || 'friendly',
      };
    } catch (error) {
      this.logger.error(`Failed to get preferences: ${error.message}`);
      return defaults;
    }
  }

  /**
   * Get conversation memory by phone (public convenience wrapper)
   */
  async getConversationMemoryByPhone(phone: string): Promise<ConversationMemory> {
    const normalizedPhone = this.normalizePhone(phone);
    const user = await this.getUserFromMySQL(normalizedPhone);
    if (!user) {
      return { recentTopics: [], pendingRequests: [], lastInteractionDate: null, conversationCount: 0, extractedInsights: [] };
    }
    return this.getConversationMemory(user.id, normalizedPhone);
  }

  /**
   * Get conversation memory from PostgreSQL
   */
  private async getConversationMemory(userId: number, phone: string): Promise<ConversationMemory> {
    const defaults: ConversationMemory = {
      recentTopics: [],
      pendingRequests: [],
      lastInteractionDate: null,
      conversationCount: 0,
      extractedInsights: [],
    };

    if (!this.pgPool) return defaults;

    try {
      // Get conversation count and last interaction
      const convResult = await this.pgPool.query(
        `SELECT COUNT(DISTINCT session_id) as count, MAX(created_at) as last_interaction
         FROM conversation_messages
         WHERE session_id LIKE $1`,
        [`%${phone.replace(/\+/g, '')}%`]
      );

      // Get recent insights
      const insightsResult = await this.pgPool.query(
        `SELECT insight_type, insight_value, confidence
         FROM user_insights
         WHERE user_id = $1
         ORDER BY extracted_at DESC
         LIMIT 10`,
        [userId]
      );

      // Get recent topics from flow_id in conversation messages
      const topicsResult = await this.pgPool.query(
        `SELECT flow_id, MAX(created_at) as last_seen
         FROM conversation_messages
         WHERE session_id LIKE $1
           AND flow_id IS NOT NULL
           AND flow_id != ''
         GROUP BY flow_id
         ORDER BY last_seen DESC
         LIMIT 5`,
        [`%${phone.replace(/\+/g, '')}%`]
      ).catch(() => ({ rows: [] }));

      // Also check user_insights for topic-type entries
      const topicInsights = insightsResult.rows
        .filter(i => i.insight_type === 'topic' || i.insight_type === 'interest')
        .map(i => i.insight_value);

      // Combine flow-based topics with insight-based topics, deduplicate
      const flowTopics = topicsResult.rows.map(r => r.flow_id);
      const allTopics = [...new Set([...flowTopics, ...topicInsights])].slice(0, 8);

      const conv = convResult.rows[0] || {};
      return {
        recentTopics: allTopics,
        pendingRequests: [],
        lastInteractionDate: conv.last_interaction,
        conversationCount: parseInt(conv.count) || 0,
        extractedInsights: insightsResult.rows.map(i => ({
          type: i.insight_type,
          value: i.insight_value,
          confidence: parseFloat(i.confidence),
        })),
      };
    } catch (error) {
      this.logger.error(`Failed to get conversation memory: ${error.message}`);
      return defaults;
    }
  }

  /**
   * Build personalized greeting based on user history
   */
  private buildPersonalizedGreeting(user: any, orderHistory: UserOrderHistory): string {
    const name = user.f_name || 'there';
    const hour = new Date().getHours();
    
    let timeGreeting = 'Hello';
    if (hour < 12) timeGreeting = 'Good morning';
    else if (hour < 17) timeGreeting = 'Good afternoon';
    else timeGreeting = 'Good evening';

    // Personalize based on history
    if (orderHistory.totalOrders === 0) {
      return `${timeGreeting}, ${name}! 👋 Welcome to Mangwale! I'm here to help you discover amazing food, shops, and delivery services in your area.`;
    } else if (orderHistory.totalOrders < 5) {
      return `${timeGreeting}, ${name}! 👋 Great to see you again! How can I help you today?`;
    } else {
      const favoriteStore = orderHistory.favoriteStores[0]?.storeName;
      if (favoriteStore) {
        return `${timeGreeting}, ${name}! 👋 Welcome back! Would you like to order from ${favoriteStore} again, or try something new?`;
      }
      return `${timeGreeting}, ${name}! 👋 Welcome back, valued customer! What can I get for you today?`;
    }
  }

  /**
   * Build context summary for AI
   */
  private buildContextSummary(
    user: any,
    orderHistory: UserOrderHistory,
    wallet: UserWalletInfo,
    preferences: UserPreferences
  ): string {
    const parts: string[] = [];

    // Basic info
    parts.push(`User: ${user.f_name || 'Unknown'} ${user.l_name || ''} (ID: ${user.id})`);
    
    // Order stats
    if (orderHistory.totalOrders > 0) {
      parts.push(`Orders: ${orderHistory.deliveredOrders} delivered, ${orderHistory.canceledOrders} canceled`);
      parts.push(`Avg order: ₹${orderHistory.avgOrderValue.toFixed(0)}`);
      
      // Module preferences
      const modulePrefs = Object.entries(orderHistory.ordersByModule)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([mod, count]) => `${mod}(${count})`);
      if (modulePrefs.length > 0) {
        parts.push(`Prefers: ${modulePrefs.join(', ')}`);
      }
    }

    // Wallet
    if (wallet.balance > 0 || wallet.loyaltyPoints > 0) {
      parts.push(`Wallet: ₹${wallet.balance.toFixed(0)}, ${wallet.loyaltyPoints.toFixed(0)} points`);
    }

    // Dietary preferences
    if (preferences.dietaryType) {
      parts.push(`Diet: ${preferences.dietaryType}`);
    }
    if (preferences.allergies.length > 0) {
      parts.push(`⚠️ Allergies: ${preferences.allergies.join(', ')}`);
    }

    return parts.join(' | ');
  }

  /**
   * Generate suggested actions based on context
   */
  private generateSuggestedActions(orderHistory: UserOrderHistory, wallet: UserWalletInfo): string[] {
    const suggestions: string[] = [];

    // Reorder suggestion
    if (orderHistory.recentOrders.length > 0) {
      const lastOrder = orderHistory.recentOrders[0];
      if (lastOrder.status === 'delivered') {
        suggestions.push(`Reorder from ${lastOrder.storeName}`);
      }
    }

    // Wallet usage suggestion
    if (wallet.balance >= 50) {
      suggestions.push(`Use ₹${wallet.balance.toFixed(0)} wallet balance`);
    }

    // Loyalty points suggestion
    if (wallet.loyaltyPoints >= 100) {
      suggestions.push(`Redeem ${wallet.loyaltyPoints.toFixed(0)} loyalty points`);
    }

    // Favorite store suggestion
    if (orderHistory.favoriteStores.length > 0) {
      suggestions.push(`Order from ${orderHistory.favoriteStores[0].storeName}`);
    }

    return suggestions.slice(0, 3);
  }

  private emptyOrderHistory(): UserOrderHistory {
    return {
      totalOrders: 0,
      deliveredOrders: 0,
      canceledOrders: 0,
      totalSpent: 0,
      avgOrderValue: 0,
      lastOrderDate: null,
      recentOrders: [],
      favoriteStores: [],
      favoriteItems: [],
      ordersByModule: {},
    };
  }

  private normalizePhone(phone: string): string {
    // Remove all non-digits except +
    let cleaned = phone.replace(/[^\d+]/g, '');
    
    // Ensure +91 prefix for Indian numbers
    if (cleaned.length === 10) {
      cleaned = '+91' + cleaned;
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
      cleaned = '+' + cleaned;
    } else if (!cleaned.startsWith('+') && cleaned.length === 12) {
      cleaned = '+' + cleaned;
    }
    
    return cleaned;
  }

  /**
   * Get OTP for testing (from phone_verifications table)
   */
  async getOtpForPhone(phone: string): Promise<string | null> {
    if (!this.mysqlPool) return null;

    try {
      const normalizedPhone = this.normalizePhone(phone);
      const phoneVariants = [
        normalizedPhone,
        normalizedPhone.replace(/^\+/, ''),
      ];

      const [rows] = await this.mysqlPool.query(
        `SELECT token FROM phone_verifications 
         WHERE phone IN (?, ?)
         ORDER BY created_at DESC 
         LIMIT 1`,
        phoneVariants
      );

      return Array.isArray(rows) && rows.length > 0 ? (rows[0] as any).token : null;
    } catch (error) {
      this.logger.error(`Failed to get OTP: ${error.message}`);
      return null;
    }
  }

  /**
   * Delete user for testing fresh registration flow
   */
  async deleteUserForTesting(phone: string): Promise<boolean> {
    if (!this.mysqlPool) return false;

    try {
      const normalizedPhone = this.normalizePhone(phone);
      const phoneVariants = [
        normalizedPhone,
        normalizedPhone.replace(/^\+/, ''),
        normalizedPhone.replace(/^\+91/, ''),
      ];

      // Get user ID first
      const [userRows] = await this.mysqlPool.query(
        'SELECT id FROM users WHERE phone IN (?, ?, ?) LIMIT 1',
        phoneVariants
      );

      if (!Array.isArray(userRows) || userRows.length === 0) {
        this.logger.log(`User not found for phone: ${phone}`);
        return false;
      }

      const userId = (userRows[0] as any).id;
      this.logger.warn(`⚠️ DELETING TEST USER ${userId} (${phone})`);

      // Delete related data
      await this.mysqlPool.query('DELETE FROM customer_addresses WHERE user_id = ?', [userId]);
      await this.mysqlPool.query('DELETE FROM wallet_transactions WHERE user_id = ?', [userId]);
      await this.mysqlPool.query('DELETE FROM loyalty_point_transactions WHERE user_id = ?', [userId]);
      await this.mysqlPool.query('DELETE FROM phone_verifications WHERE phone IN (?, ?)', phoneVariants);
      await this.mysqlPool.query('DELETE FROM users WHERE id = ?', [userId]);

      this.logger.log(`✅ Deleted user ${userId} and related data`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete user: ${error.message}`);
      return false;
    }
  }

  // ==========================================
  // Helper methods for UserPreferenceService
  // ==========================================

  /**
   * Get order history directly by user ID (for CollectionsService and other internal callers)
   */
  async getOrderHistoryById(userId: number): Promise<UserOrderHistory | null> {
    try {
      return await this.getOrderHistory(userId);
    } catch (error) {
      this.logger.error(`getOrderHistoryById failed for ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get order history by phone number (for UserPreferenceService integration)
   */
  async getOrderHistoryByPhone(phone: string): Promise<UserOrderHistory | null> {
    try {
      const normalizedPhone = this.normalizePhone(phone);
      const user = await this.getUserFromMySQL(normalizedPhone);
      if (!user) return null;
      return await this.getOrderHistory(user.id);
    } catch (error) {
      this.logger.error(`getOrderHistoryByPhone failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get wallet info by phone number (for UserPreferenceService integration)
   */
  async getWalletInfoByPhone(phone: string): Promise<UserWalletInfo | null> {
    try {
      const normalizedPhone = this.normalizePhone(phone);
      const user = await this.getUserFromMySQL(normalizedPhone);
      if (!user) return null;
      return await this.getWalletInfo(user.id);
    } catch (error) {
      this.logger.error(`getWalletInfoByPhone failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get saved addresses by phone number (for UserPreferenceService integration)
   */
  async getAddressesByPhone(phone: string): Promise<{ savedAddresses: any[]; defaultAddress: any } | null> {
    try {
      const normalizedPhone = this.normalizePhone(phone);
      const user = await this.getUserFromMySQL(normalizedPhone);
      if (!user) return null;
      return await this.getAddresses(user.id);
    } catch (error) {
      this.logger.error(`getAddressesByPhone failed: ${error.message}`);
      return null;
    }
  }
}
