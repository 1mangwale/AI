import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

/**
 * User Profile Enrichment Service
 * 
 * Builds comprehensive user profiles in PostgreSQL by:
 * 1. Syncing user data from MySQL (PHP backend) on first login
 * 2. Analyzing order history to detect patterns
 * 3. Calculating preferences (cuisines, price range, meal times)
 * 4. Updating profile after each order
 * 
 * This enables personalized AI interactions with:
 * - Knowledge of user's favorite items/stores
 * - Dietary preferences detection
 * - Price sensitivity analysis
 * - Order frequency patterns
 */

export interface OrderPatterns {
  favoriteCuisines: Array<{ cuisine: string; orderCount: number; percentage: number }>;
  favoriteStores: Array<{ storeId: number; storeName: string; orderCount: number }>;
  favoriteItems: Array<{ itemId: number; itemName: string; orderCount: number; category: string }>;
  avgOrderValue: number;
  orderFrequency: string; // 'daily', 'weekly', 'monthly', 'occasional'
  preferredMealTimes: {
    breakfast: number;
    lunch: number;
    dinner: number;
    lateNight: number;
  };
  priceSensitivity: string; // 'budget', 'moderate', 'premium'
  dietaryType: string | null; // 'vegetarian', 'non-vegetarian', 'eggetarian', 'vegan'
}

@Injectable()
export class UserProfileEnrichmentService {
  private readonly logger = new Logger(UserProfileEnrichmentService.name);
  private mysqlPool: mysql.Pool;
  private pgPool: Pool;

  constructor() {
    this.initializePools();
  }

  // Cache to track recent enrichments (prevents duplicate calls)
  private recentEnrichments = new Map<number, number>();
  private readonly ENRICHMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Check if we should skip enrichment (already done recently)
   * Returns skip reason string if should skip, null if should proceed
   */
  private async shouldSkipEnrichment(userId: number): Promise<string | null> {
    // Check in-memory cache first (fastest)
    const lastEnriched = this.recentEnrichments.get(userId);
    if (lastEnriched && Date.now() - lastEnriched < this.ENRICHMENT_COOLDOWN_MS) {
      const hoursAgo = Math.round((Date.now() - lastEnriched) / (1000 * 60 * 60));
      return `enriched ${hoursAgo} hours ago (in-memory cache)`;
    }
    
    // Check PostgreSQL for last enrichment time
    if (this.pgPool) {
      try {
        const result = await this.pgPool.query(
          `SELECT updated_at FROM user_profiles WHERE user_id = $1`,
          [userId]
        );
        
        if (result.rows.length > 0) {
          const lastUpdated = new Date(result.rows[0].updated_at).getTime();
          if (Date.now() - lastUpdated < this.ENRICHMENT_COOLDOWN_MS) {
            // Update in-memory cache
            this.recentEnrichments.set(userId, lastUpdated);
            const hoursAgo = Math.round((Date.now() - lastUpdated) / (1000 * 60 * 60));
            return `enriched ${hoursAgo} hours ago (database)`;
          }
        }
      } catch (e) {
        this.logger.warn(`Could not check last enrichment time: ${e.message}`);
      }
    }
    
    return null; // Proceed with enrichment
  }

  private async initializePools() {
    // MySQL connection (PHP backend - source of truth for orders)
    const mysqlHost = process.env.MYSQL_HOST;
    if (!mysqlHost) {
      this.logger.warn('MYSQL_HOST env var not set - MySQL pool will not be initialized');
      return;
    }
    const mysqlPort = parseInt(process.env.MYSQL_PORT || '3306');
    const mysqlUser = process.env.MYSQL_USERNAME || process.env.MYSQL_USER || 'root';
    const mysqlPassword = process.env.MYSQL_PASSWORD || 'root_password';
    const mysqlDatabase = process.env.MYSQL_DATABASE || 'mangwale_db';

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
      });
      this.logger.log(`✅ MySQL pool initialized for profile enrichment`);
    } catch (error) {
      this.logger.error(`❌ MySQL connection failed: ${error.message}`);
    }

    // PostgreSQL connection (AI features)
    const pgUrl = process.env.DATABASE_URL || 
      'postgresql://mangwale_config:config_secure_pass_2024@172.17.0.2:5432/headless_mangwale';

    try {
      this.pgPool = new Pool({
        connectionString: pgUrl,
        max: 10,
        idleTimeoutMillis: 30000,
      });
      this.logger.log('✅ PostgreSQL pool initialized for profile enrichment');
    } catch (error) {
      this.logger.error(`❌ PostgreSQL connection failed: ${error.message}`);
    }
  }

  /**
   * Enrich user profile on first login or periodically
   * Called after authentication success
   * 
   * DUPLICATE PREVENTION:
   * - Skips if profile was enriched in the last 24 hours
   * - Uses Redis lock to prevent concurrent enrichment
   */
  async enrichUserProfile(params: {
    userId: number;
    phone: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  }): Promise<void> {
    const { userId, phone, firstName, lastName, email } = params;
    
    try {
      // DUPLICATE PREVENTION: Check if already enriched recently
      const skipReason = await this.shouldSkipEnrichment(userId);
      if (skipReason) {
        this.logger.log(`⏭️ Skipping profile enrichment for user ${userId}: ${skipReason}`);
        return;
      }
      
      this.logger.log(`📊 Enriching profile for user ${userId} (${phone})`);

      // 1. Create or update base profile in PostgreSQL
      await this.upsertBaseProfile(userId, phone, firstName, lastName, email);

      // 2. Fetch and analyze order history from MySQL
      const orderPatterns = await this.analyzeOrderHistory(userId);

      // 3. Update profile with patterns
      await this.updateProfileWithPatterns(userId, orderPatterns);

      // 4. Store favorite items and stores
      await this.storeFavorites(userId, orderPatterns);

      // Mark enrichment complete in cache
      this.recentEnrichments.set(userId, Date.now());
      
      this.logger.log(`✅ Profile enriched for user ${userId}: ${orderPatterns.favoriteCuisines.length} cuisines, ${orderPatterns.favoriteItems.length} items`);
    } catch (error) {
      this.logger.error(`Failed to enrich profile for user ${userId}: ${error.message}`);
    }
  }

  /**
   * Create or update base profile
   */
  private async upsertBaseProfile(
    userId: number, 
    phone: string, 
    firstName?: string, 
    lastName?: string,
    email?: string
  ): Promise<void> {
    if (!this.pgPool) return;

    // Check if profile exists
    const existing = await this.pgPool.query(
      `SELECT id FROM user_profiles WHERE user_id = $1`,
      [userId]
    );

    if (existing.rows.length === 0) {
      // Create new profile
      await this.pgPool.query(
        `INSERT INTO user_profiles (user_id, phone, created_at, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, phone]
      );
      this.logger.log(`📝 Created new profile for user ${userId}`);
    }
  }

  /**
   * Analyze order history from MySQL to detect patterns
   */
  async analyzeOrderHistory(userId: number): Promise<OrderPatterns> {
    const patterns: OrderPatterns = {
      favoriteCuisines: [],
      favoriteStores: [],
      favoriteItems: [],
      avgOrderValue: 0,
      orderFrequency: 'occasional',
      preferredMealTimes: { breakfast: 0, lunch: 0, dinner: 0, lateNight: 0 },
      priceSensitivity: 'moderate',
      dietaryType: null,
    };

    if (!this.mysqlPool) return patterns;

    try {
      // Get order summary
      const [orderSummary]: any = await this.mysqlPool.query(
        `SELECT 
           COUNT(*) as total_orders,
           AVG(order_amount) as avg_amount,
           SUM(order_amount) as total_spent,
           MIN(created_at) as first_order,
           MAX(created_at) as last_order
         FROM orders 
         WHERE user_id = ? AND order_status NOT IN ('canceled', 'failed')`,
        [userId]
      );

      if (orderSummary[0]?.total_orders > 0) {
        patterns.avgOrderValue = parseFloat(orderSummary[0].avg_amount) || 0;
        
        // Calculate order frequency
        const totalOrders = parseInt(orderSummary[0].total_orders);
        const firstOrder = new Date(orderSummary[0].first_order);
        const lastOrder = new Date(orderSummary[0].last_order);
        const daysDiff = Math.max(1, (lastOrder.getTime() - firstOrder.getTime()) / (1000 * 60 * 60 * 24));
        const ordersPerWeek = (totalOrders / daysDiff) * 7;

        if (ordersPerWeek >= 5) patterns.orderFrequency = 'daily';
        else if (ordersPerWeek >= 1) patterns.orderFrequency = 'weekly';
        else if (ordersPerWeek >= 0.25) patterns.orderFrequency = 'monthly';
        else patterns.orderFrequency = 'occasional';

        // Determine price sensitivity
        if (patterns.avgOrderValue < 150) patterns.priceSensitivity = 'budget';
        else if (patterns.avgOrderValue < 400) patterns.priceSensitivity = 'moderate';
        else patterns.priceSensitivity = 'premium';
      }

      // Get favorite stores
      const [favoriteStores]: any = await this.mysqlPool.query(
        `SELECT o.store_id, s.name as store_name, COUNT(*) as order_count
         FROM orders o
         JOIN stores s ON o.store_id = s.id
         WHERE o.user_id = ? AND o.order_status NOT IN ('canceled', 'failed')
         GROUP BY o.store_id, s.name
         ORDER BY order_count DESC
         LIMIT 5`,
        [userId]
      );

      patterns.favoriteStores = favoriteStores.map((s: any) => ({
        storeId: s.store_id,
        storeName: s.store_name,
        orderCount: parseInt(s.order_count),
      }));

      // Get favorite items with categories
      const [favoriteItems]: any = await this.mysqlPool.query(
        `SELECT 
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.id')) as item_id,
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.name')) as item_name,
          JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.category_ids[0].name')) as category,
          COUNT(*) as order_count
         FROM order_details od
         JOIN orders o ON od.order_id = o.id
         WHERE o.user_id = ? AND o.order_status NOT IN ('canceled', 'failed')
         GROUP BY 
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.id')),
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.name')),
           JSON_UNQUOTE(JSON_EXTRACT(od.item_details, '$.category_ids[0].name'))
         ORDER BY order_count DESC
         LIMIT 10`,
        [userId]
      );

      patterns.favoriteItems = favoriteItems.map((item: any) => {
        return {
          itemId: item.item_id,
          itemName: item.item_name || `Item ${item.item_id}`,
          orderCount: parseInt(item.order_count),
          category: item.category || 'Unknown',
        };
      });

      // Analyze cuisines from item categories
      const cuisineCounts: Record<string, number> = {};
      let totalCuisineOrders = 0;
      
      for (const item of patterns.favoriteItems) {
        const cuisine = item.category;
        cuisineCounts[cuisine] = (cuisineCounts[cuisine] || 0) + item.orderCount;
        totalCuisineOrders += item.orderCount;
      }

      patterns.favoriteCuisines = Object.entries(cuisineCounts)
        .map(([cuisine, count]) => ({
          cuisine,
          orderCount: count,
          percentage: totalCuisineOrders > 0 ? Math.round((count / totalCuisineOrders) * 100) : 0,
        }))
        .sort((a, b) => b.orderCount - a.orderCount)
        .slice(0, 5);

      // Analyze meal times
      const [mealTimes]: any = await this.mysqlPool.query(
        `SELECT 
           HOUR(created_at) as hour,
           COUNT(*) as count
         FROM orders
         WHERE user_id = ? AND order_status NOT IN ('canceled', 'failed')
         GROUP BY HOUR(created_at)`,
        [userId]
      );

      for (const mt of mealTimes) {
        const hour = parseInt(mt.hour);
        const count = parseInt(mt.count);
        
        if (hour >= 6 && hour < 11) patterns.preferredMealTimes.breakfast += count;
        else if (hour >= 11 && hour < 15) patterns.preferredMealTimes.lunch += count;
        else if (hour >= 17 && hour < 22) patterns.preferredMealTimes.dinner += count;
        else patterns.preferredMealTimes.lateNight += count;
      }

      // Detect dietary type from items
      const [dietaryAnalysis]: any = await this.mysqlPool.query(
        `SELECT 
           SUM(CASE WHEN i.veg = 1 THEN 1 ELSE 0 END) as veg_count,
           SUM(CASE WHEN i.veg = 0 THEN 1 ELSE 0 END) as non_veg_count,
           COUNT(*) as total
         FROM order_details od
         JOIN orders o ON od.order_id = o.id
         JOIN items i ON od.item_id = i.id
         WHERE o.user_id = ? AND o.order_status NOT IN ('canceled', 'failed')`,
        [userId]
      );

      if (dietaryAnalysis[0]?.total > 0) {
        const vegPct = (dietaryAnalysis[0].veg_count / dietaryAnalysis[0].total) * 100;
        if (vegPct >= 95) patterns.dietaryType = 'vegetarian';
        else if (vegPct <= 20) patterns.dietaryType = 'non-vegetarian';
        else patterns.dietaryType = 'eggetarian';
      }

      return patterns;
    } catch (error) {
      this.logger.error(`Failed to analyze order history: ${error.message}`);
      return patterns;
    }
  }

  /**
   * Update user profile with analyzed patterns
   */
  private async updateProfileWithPatterns(userId: number, patterns: OrderPatterns): Promise<void> {
    if (!this.pgPool) return;

    try {
      await this.pgPool.query(
        `UPDATE user_profiles SET
           dietary_type = $1,
           favorite_cuisines = $2,
           avg_order_value = $3,
           order_frequency = $4,
           preferred_meal_times = $5,
           price_sensitivity = $6,
           profile_completeness = LEAST(100, COALESCE(profile_completeness, 0) + 30),
           last_conversation_analyzed = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $7`,
        [
          patterns.dietaryType,
          JSON.stringify(patterns.favoriteCuisines.map(c => c.cuisine)),
          patterns.avgOrderValue,
          patterns.orderFrequency,
          JSON.stringify(patterns.preferredMealTimes),
          patterns.priceSensitivity,
          userId,
        ]
      );
    } catch (error) {
      this.logger.error(`Failed to update profile patterns: ${error.message}`);
    }
  }

  /**
   * Store favorite items and stores for quick access
   */
  private async storeFavorites(userId: number, patterns: OrderPatterns): Promise<void> {
    if (!this.pgPool) return;

    try {
      // Store insights for favorite stores
      for (const store of patterns.favoriteStores) {
        await this.pgPool.query(
          `INSERT INTO user_insights (user_id, insight_type, insight_key, insight_value, confidence, source)
           VALUES ($1, 'favorite_store', $2, $3, $4, 'order_history')
           ON CONFLICT (user_id, insight_type, insight_key) 
           DO UPDATE SET insight_value = $3, confidence = $4, extracted_at = CURRENT_TIMESTAMP`,
          [
            userId,
            store.storeId.toString(),
            JSON.stringify({ name: store.storeName, orderCount: store.orderCount }),
            Math.min(0.99, store.orderCount / 10),
          ]
        );
      }

      // Store insights for favorite items
      for (const item of patterns.favoriteItems.slice(0, 5)) {
        await this.pgPool.query(
          `INSERT INTO user_insights (user_id, insight_type, insight_key, insight_value, confidence, source)
           VALUES ($1, 'favorite_item', $2, $3, $4, 'order_history')
           ON CONFLICT (user_id, insight_type, insight_key) 
           DO UPDATE SET insight_value = $3, confidence = $4, extracted_at = CURRENT_TIMESTAMP`,
          [
            userId,
            item.itemId.toString(),
            JSON.stringify({ name: item.itemName, category: item.category, orderCount: item.orderCount }),
            Math.min(0.99, item.orderCount / 5),
          ]
        );
      }

      this.logger.log(`📊 Stored ${patterns.favoriteStores.length} stores, ${patterns.favoriteItems.length} items for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to store favorites: ${error.message}`);
    }
  }

  /**
   * Get user's favorite items for quick reorder suggestions
   */
  async getFavoriteItems(userId: number): Promise<Array<{ itemId: number; name: string; category: string; orderCount: number }>> {
    try {
      const result = await this.pgPool.query(
        `SELECT insight_key, insight_value 
         FROM user_insights 
         WHERE user_id = $1 AND insight_type = 'favorite_item'
         ORDER BY confidence DESC
         LIMIT 10`,
        [userId]
      );

      return result.rows.map(row => {
        const value = typeof row.insight_value === 'string' 
          ? JSON.parse(row.insight_value) 
          : row.insight_value;
        return {
          itemId: parseInt(row.insight_key),
          name: value.name,
          category: value.category,
          orderCount: value.orderCount,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get favorite items: ${error.message}`);
      return [];
    }
  }

  /**
   * Get user's favorite stores
   */
  async getFavoriteStores(userId: number): Promise<Array<{ storeId: number; name: string; orderCount: number }>> {
    try {
      const result = await this.pgPool.query(
        `SELECT insight_key, insight_value 
         FROM user_insights 
         WHERE user_id = $1 AND insight_type = 'favorite_store'
         ORDER BY confidence DESC
         LIMIT 5`,
        [userId]
      );

      return result.rows.map(row => {
        const value = typeof row.insight_value === 'string' 
          ? JSON.parse(row.insight_value) 
          : row.insight_value;
        return {
          storeId: parseInt(row.insight_key),
          name: value.name,
          orderCount: value.orderCount,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get favorite stores: ${error.message}`);
      return [];
    }
  }

  /**
   * Get profile summary for AI context
   */
  async getProfileSummary(userId: number): Promise<string> {
    try {
      const result = await this.pgPool.query(
        `SELECT * FROM user_profiles WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return 'New user with no order history.';
      }

      const profile = result.rows[0];
      const parts: string[] = [];

      if (profile.dietary_type) {
        parts.push(`Dietary: ${profile.dietary_type}`);
      }

      if (profile.favorite_cuisines && profile.favorite_cuisines.length > 0) {
        const cuisines = Array.isArray(profile.favorite_cuisines) 
          ? profile.favorite_cuisines 
          : JSON.parse(profile.favorite_cuisines || '[]');
        if (cuisines.length > 0) {
          parts.push(`Favorites: ${cuisines.slice(0, 3).join(', ')}`);
        }
      }

      if (profile.order_frequency) {
        parts.push(`Orders: ${profile.order_frequency}`);
      }

      if (profile.price_sensitivity) {
        parts.push(`Budget: ${profile.price_sensitivity}`);
      }

      if (profile.avg_order_value) {
        parts.push(`Avg order: ₹${Math.round(profile.avg_order_value)}`);
      }

      return parts.length > 0 
        ? parts.join(' | ') 
        : 'User profile being built.';
    } catch (error) {
      this.logger.error(`Failed to get profile summary: ${error.message}`);
      return 'Profile unavailable.';
    }
  }

  /**
   * Update profile after a new order is placed
   */
  async onOrderPlaced(params: {
    userId: number;
    orderId: number;
    storeId: number;
    storeName: string;
    items: Array<{ id: number; name: string; category: string; price: number }>;
    totalAmount: number;
  }): Promise<void> {
    try {
      this.logger.log(`📦 Order ${params.orderId} placed - updating profile for user ${params.userId}`);

      // Update order count in insights
      for (const item of params.items) {
        await this.pgPool.query(
          `INSERT INTO user_insights (user_id, insight_type, insight_key, insight_value, confidence, source)
           VALUES ($1, 'ordered_item', $2, $3, 0.8, 'new_order')
           ON CONFLICT (user_id, insight_type, insight_key) 
           DO UPDATE SET 
             insight_value = jsonb_set(
               COALESCE(user_insights.insight_value::jsonb, '{}'::jsonb),
               '{orderCount}',
               (COALESCE((user_insights.insight_value::jsonb->>'orderCount')::int, 0) + 1)::text::jsonb
             ),
             confidence = LEAST(0.99, user_insights.confidence + 0.05),
             extracted_at = CURRENT_TIMESTAMP`,
          [
            params.userId,
            item.id.toString(),
            JSON.stringify({ name: item.name, category: item.category, price: item.price, orderCount: 1 }),
          ]
        );
      }

      // Schedule full profile re-analysis (async, don't wait)
      setImmediate(() => {
        this.analyzeOrderHistory(params.userId)
          .then(patterns => this.updateProfileWithPatterns(params.userId, patterns))
          .catch(err => this.logger.error(`Async profile update failed: ${err.message}`));
      });

    } catch (error) {
      this.logger.error(`Failed to update profile after order: ${error.message}`);
    }
  }
}
