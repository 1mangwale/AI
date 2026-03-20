import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

/**
 * Behavioral Analytics Service
 * 
 * Analyzes implicit user behavior signals to build richer profiles:
 * - Purchase patterns (time, frequency, basket size)
 * - RFM (Recency-Frequency-Monetary) scoring
 * - Browse vs Buy ratio
 * - Category affinity scores
 * - Session engagement metrics
 */

export interface RFMScore {
  recency: number;      // Days since last purchase (lower is better)
  frequency: number;    // Purchase count in period
  monetary: number;     // Average order value
  recencyScore: number; // 1-5 score
  frequencyScore: number; // 1-5 score
  monetaryScore: number; // 1-5 score
  segment: CustomerSegment;
}

export type CustomerSegment = 
  | 'champion'        // 555 - Best customers
  | 'loyal'           // High frequency
  | 'potential_loyalist' // Recent with growing frequency
  | 'new_customer'    // Very recent, low frequency
  | 'promising'       // Recent, medium value
  | 'need_attention'  // Above average but slipping
  | 'about_to_sleep'  // Below average, haven't purchased recently
  | 'at_risk'         // Were good, now inactive
  | 'hibernating'     // Low scores across board
  | 'lost';           // Haven't purchased in very long time

export interface PurchasePattern {
  preferredTimeOfDay: 'morning' | 'afternoon' | 'evening' | 'night' | 'mixed';
  preferredDayOfWeek: string; // e.g., 'weekend', 'weekday', 'monday'
  averageBasketSize: number;
  averageOrderValue: number;
  orderFrequencyDays: number; // Average days between orders
  lastOrderDaysAgo: number;
  peakOrderHour: number;
  categoryBreakdown: { [category: string]: number }; // % of orders per category
}

export interface EngagementMetrics {
  searchToClickRatio: number;     // How often searches lead to clicks
  clickToCartRatio: number;       // How often clicks lead to cart adds
  cartToOrderRatio: number;       // Cart abandonment inverse
  averageSessionDuration: number; // Minutes
  sessionsPerWeek: number;
  browseOnlyRate: number;         // Sessions with no purchase
  repeatItemRate: number;         // How often they reorder same items
}

export interface CategoryAffinity {
  categoryId: number;
  categoryName: string;
  affinityScore: number;     // 0-100
  purchaseCount: number;
  viewCount: number;
  conversionRate: number;    // view to purchase ratio
  averageSpend: number;
  lastPurchased: Date | null;
}

/**
 * Merged from CustomerHealthService:
 * Customer health scoring types
 */
export interface CustomerHealthScore {
  id: string;
  userId: number;
  phone: string | null;
  rfmScore: string | null;
  rfmSegment: string | null;
  churnRisk: number;
  ltvPredicted: number;
  healthScore: number;
  recencyDays: number;
  frequency90d: number;
  avgOrderValue: number;
  complaintRate: number;
  lastComputedAt: Date;
}

@Injectable()
export class BehavioralAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(BehavioralAnalyticsService.name);
  private pool: Pool;

  // ===================================
  // Merged from CustomerHealthService
  // ===================================
  private healthPgPool: Pool;
  private healthMysqlPool: mysql.Pool;

  constructor(private readonly config: ConfigService) {
    this.initializePool();
  }

  private async initializePool() {
    const databaseUrl = process.env.DATABASE_URL || 
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.logger.log('✅ BehavioralAnalyticsService initialized');
  }

  /**
   * Calculate RFM score for a user
   */
  async calculateRFMScore(userId: number, periodDays: number = 90): Promise<RFMScore | null> {
    try {
      // Get order history from PHP backend data
      const orderStats = await this.pool.query(`
        SELECT 
          COUNT(*) as order_count,
          SUM(COALESCE((order_data->>'total')::numeric, 0)) as total_spent,
          MAX(created_at) as last_order_date,
          AVG(COALESCE((order_data->>'total')::numeric, 0)) as avg_order_value
        FROM user_orders
        WHERE user_id = $1 
          AND created_at >= NOW() - INTERVAL '${periodDays} days'
          AND status NOT IN ('cancelled', 'failed')
      `, [userId]);

      if (!orderStats.rows[0] || orderStats.rows[0].order_count === 0) {
        // Check if user has any orders at all
        const anyOrders = await this.pool.query(
          `SELECT MAX(created_at) as last_order FROM user_orders WHERE user_id = $1`,
          [userId]
        );
        
        if (!anyOrders.rows[0]?.last_order) {
          return null; // Never ordered
        }

        const daysSinceLast = Math.floor(
          (Date.now() - new Date(anyOrders.rows[0].last_order).getTime()) / (1000 * 60 * 60 * 24)
        );

        return {
          recency: daysSinceLast,
          frequency: 0,
          monetary: 0,
          recencyScore: this.scoreRecency(daysSinceLast),
          frequencyScore: 1,
          monetaryScore: 1,
          segment: daysSinceLast > 180 ? 'lost' : 'hibernating'
        };
      }

      const stats = orderStats.rows[0];
      const recency = stats.last_order_date 
        ? Math.floor((Date.now() - new Date(stats.last_order_date).getTime()) / (1000 * 60 * 60 * 24))
        : 999;
      const frequency = parseInt(stats.order_count) || 0;
      const monetary = parseFloat(stats.avg_order_value) || 0;

      const rfm: RFMScore = {
        recency,
        frequency,
        monetary,
        recencyScore: this.scoreRecency(recency),
        frequencyScore: this.scoreFrequency(frequency, periodDays),
        monetaryScore: this.scoreMonetary(monetary),
        segment: 'new_customer' // Will be calculated below
      };

      rfm.segment = this.determineSegment(rfm);

      return rfm;
    } catch (error) {
      this.logger.error(`Failed to calculate RFM for user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get purchase patterns for a user
   */
  async getPurchasePatterns(userId: number): Promise<PurchasePattern | null> {
    try {
      // Time of day analysis
      const timeAnalysis = await this.pool.query(`
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          EXTRACT(DOW FROM created_at) as day_of_week,
          COUNT(*) as order_count,
          AVG(COALESCE((order_data->>'item_count')::numeric, 1)) as avg_items,
          AVG(COALESCE((order_data->>'total')::numeric, 0)) as avg_value
        FROM user_orders
        WHERE user_id = $1 AND status NOT IN ('cancelled', 'failed')
        GROUP BY EXTRACT(HOUR FROM created_at), EXTRACT(DOW FROM created_at)
        ORDER BY order_count DESC
      `, [userId]);

      if (timeAnalysis.rows.length === 0) {
        return null;
      }

      // Calculate preferred times
      const hourCounts: { [hour: number]: number } = {};
      const dayCounts: { [day: number]: number } = {};
      let totalOrders = 0;
      let totalItems = 0;
      let totalValue = 0;

      for (const row of timeAnalysis.rows) {
        const hour = parseInt(row.hour);
        const day = parseInt(row.day_of_week);
        const count = parseInt(row.order_count);
        
        hourCounts[hour] = (hourCounts[hour] || 0) + count;
        dayCounts[day] = (dayCounts[day] || 0) + count;
        totalOrders += count;
        totalItems += parseFloat(row.avg_items) * count;
        totalValue += parseFloat(row.avg_value) * count;
      }

      const peakHour = Object.entries(hourCounts)
        .sort(([,a], [,b]) => b - a)[0];
      const peakDay = Object.entries(dayCounts)
        .sort(([,a], [,b]) => b - a)[0];

      // Get order frequency
      const frequencyResult = await this.pool.query(`
        SELECT 
          AVG(days_between) as avg_days_between,
          COUNT(*) as total_orders,
          MAX(created_at) as last_order
        FROM (
          SELECT 
            created_at,
            EXTRACT(DAY FROM created_at - LAG(created_at) OVER (ORDER BY created_at)) as days_between
          FROM user_orders
          WHERE user_id = $1 AND status NOT IN ('cancelled', 'failed')
        ) sub
      `, [userId]);

      // Get category breakdown
      const categoryResult = await this.pool.query(`
        SELECT 
          COALESCE(order_data->>'category', 'unknown') as category,
          COUNT(*) as order_count
        FROM user_orders
        WHERE user_id = $1 AND status NOT IN ('cancelled', 'failed')
        GROUP BY order_data->>'category'
        ORDER BY order_count DESC
      `, [userId]);

      const categoryBreakdown: { [category: string]: number } = {};
      for (const row of categoryResult.rows) {
        categoryBreakdown[row.category] = (parseInt(row.order_count) / totalOrders) * 100;
      }

      const peakHourNum = parseInt(peakHour?.[0] || '12');
      const preferredTimeOfDay = 
        peakHourNum >= 5 && peakHourNum < 12 ? 'morning' :
        peakHourNum >= 12 && peakHourNum < 17 ? 'afternoon' :
        peakHourNum >= 17 && peakHourNum < 21 ? 'evening' : 'night';

      const preferredDayNum = parseInt(peakDay?.[0] || '0');
      const preferredDayOfWeek = 
        preferredDayNum === 0 || preferredDayNum === 6 ? 'weekend' :
        ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][preferredDayNum];

      const freq = frequencyResult.rows[0];
      const lastOrderDays = freq?.last_order 
        ? Math.floor((Date.now() - new Date(freq.last_order).getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      return {
        preferredTimeOfDay,
        preferredDayOfWeek,
        averageBasketSize: totalItems / totalOrders,
        averageOrderValue: totalValue / totalOrders,
        orderFrequencyDays: parseFloat(freq?.avg_days_between) || 30,
        lastOrderDaysAgo: lastOrderDays,
        peakOrderHour: peakHourNum,
        categoryBreakdown
      };
    } catch (error) {
      this.logger.error(`Failed to get purchase patterns: ${error.message}`);
      return null;
    }
  }

  /**
   * Get engagement metrics for a user
   */
  async getEngagementMetrics(userId: number): Promise<EngagementMetrics | null> {
    try {
      // Get search to click stats
      const searchStats = await this.pool.query(`
        SELECT 
          COUNT(*) as total_searches,
          SUM(total_clicks) as total_clicks,
          SUM(total_conversions) as total_conversions
        FROM user_search_patterns
        WHERE user_id = $1
      `, [userId]);

      // Get item interaction stats
      const interactionStats = await this.pool.query(`
        SELECT 
          SUM(viewed_count) as total_views,
          SUM(clicked_count) as total_clicks,
          SUM(ordered_count) as total_orders,
          COUNT(DISTINCT item_id) as unique_items,
          COUNT(DISTINCT CASE WHEN ordered_count > 1 THEN item_id END) as repeat_items
        FROM user_item_interactions
        WHERE user_id = $1
      `, [userId]);

      // Get session stats from profile
      const profileStats = await this.pool.query(`
        SELECT 
          total_conversations,
          total_searches,
          total_orders
        FROM user_profiles
        WHERE user_id = $1
      `, [userId]);

      const search = searchStats.rows[0] || {};
      const interact = interactionStats.rows[0] || {};
      const profile = profileStats.rows[0] || {};

      const totalSearches = parseInt(search.total_searches) || 1;
      const totalClicks = parseInt(search.total_clicks) || 0;
      const totalViews = parseInt(interact.total_views) || 1;
      const totalOrders = parseInt(interact.total_orders) || 0;
      const uniqueItems = parseInt(interact.unique_items) || 1;
      const repeatItems = parseInt(interact.repeat_items) || 0;
      const totalConversations = parseInt(profile.total_conversations) || 1;

      return {
        searchToClickRatio: totalClicks / totalSearches,
        clickToCartRatio: 0.5, // Would need cart data
        cartToOrderRatio: 0.7, // Would need cart abandonment data
        averageSessionDuration: 5, // Would need session tracking
        sessionsPerWeek: totalConversations / 4,
        browseOnlyRate: Math.max(0, 1 - (totalOrders / totalConversations)),
        repeatItemRate: repeatItems / uniqueItems
      };
    } catch (error) {
      this.logger.error(`Failed to get engagement metrics: ${error.message}`);
      return null;
    }
  }

  /**
   * Get category affinity scores
   */
  async getCategoryAffinities(userId: number, limit: number = 10): Promise<CategoryAffinity[]> {
    try {
      const result = await this.pool.query(`
        WITH category_stats AS (
          SELECT 
            COALESCE(order_data->>'category_id', '0')::int as category_id,
            COALESCE(order_data->>'category', 'unknown') as category_name,
            COUNT(*) as purchase_count,
            AVG(COALESCE((order_data->>'total')::numeric, 0)) as avg_spend,
            MAX(created_at) as last_purchased
          FROM user_orders
          WHERE user_id = $1 AND status NOT IN ('cancelled', 'failed')
          GROUP BY order_data->>'category_id', order_data->>'category'
        ),
        view_stats AS (
          SELECT 
            COALESCE((item_data->>'category_id')::int, 0) as category_id,
            SUM(viewed_count) as view_count
          FROM user_item_interactions uii
          LEFT JOIN LATERAL (
            SELECT item_data FROM item_cache WHERE item_id = uii.item_id LIMIT 1
          ) ic ON true
          WHERE user_id = $1
          GROUP BY (item_data->>'category_id')::int
        )
        SELECT 
          cs.category_id,
          cs.category_name,
          cs.purchase_count,
          cs.avg_spend,
          cs.last_purchased,
          COALESCE(vs.view_count, 0) as view_count,
          CASE 
            WHEN COALESCE(vs.view_count, 0) > 0 
            THEN cs.purchase_count::float / vs.view_count * 100
            ELSE 0 
          END as conversion_rate,
          -- Affinity score: weighted combination of purchase frequency, spend, and recency
          (
            cs.purchase_count * 10 +
            (cs.avg_spend / 100) * 5 +
            CASE 
              WHEN cs.last_purchased > NOW() - INTERVAL '7 days' THEN 30
              WHEN cs.last_purchased > NOW() - INTERVAL '30 days' THEN 20
              WHEN cs.last_purchased > NOW() - INTERVAL '90 days' THEN 10
              ELSE 0
            END
          ) as affinity_score
        FROM category_stats cs
        LEFT JOIN view_stats vs ON cs.category_id = vs.category_id
        ORDER BY affinity_score DESC
        LIMIT $2
      `, [userId, limit]);

      return result.rows.map(row => ({
        categoryId: row.category_id,
        categoryName: row.category_name,
        affinityScore: Math.min(100, row.affinity_score),
        purchaseCount: row.purchase_count,
        viewCount: row.view_count,
        conversionRate: row.conversion_rate,
        averageSpend: row.avg_spend,
        lastPurchased: row.last_purchased
      }));
    } catch (error) {
      this.logger.error(`Failed to get category affinities: ${error.message}`);
      return [];
    }
  }

  /**
   * Update user profile with behavioral analytics
   */
  async updateProfileWithBehavior(userId: number): Promise<void> {
    try {
      const [rfm, patterns, engagement] = await Promise.all([
        this.calculateRFMScore(userId),
        this.getPurchasePatterns(userId),
        this.getEngagementMetrics(userId)
      ]);

      const updates: any = {
        behavioral_updated_at: new Date()
      };

      if (rfm) {
        updates.rfm_segment = rfm.segment;
        updates.rfm_score = `${rfm.recencyScore}${rfm.frequencyScore}${rfm.monetaryScore}`;
      }

      if (patterns) {
        updates.preferred_order_time = patterns.preferredTimeOfDay;
        updates.avg_basket_size = patterns.averageBasketSize;
        updates.avg_order_value = patterns.averageOrderValue;
        updates.order_frequency_days = patterns.orderFrequencyDays;
      }

      if (engagement) {
        updates.search_to_click_ratio = engagement.searchToClickRatio;
        updates.repeat_item_rate = engagement.repeatItemRate;
        updates.browse_only_rate = engagement.browseOnlyRate;
      }

      // Build update query
      const setClauses = Object.keys(updates).map((key, i) => `${key} = $${i + 2}`);
      const values = [userId, ...Object.values(updates)];

      await this.pool.query(
        `UPDATE user_profiles SET ${setClauses.join(', ')} WHERE user_id = $1`,
        values
      );

      this.logger.debug(`Updated behavioral analytics for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to update behavioral profile: ${error.message}`);
    }
  }

  /**
   * Get full behavioral profile for personalization
   */
  async getFullBehavioralProfile(userId: number): Promise<{
    rfm: RFMScore | null;
    patterns: PurchasePattern | null;
    engagement: EngagementMetrics | null;
    affinities: CategoryAffinity[];
  }> {
    const [rfm, patterns, engagement, affinities] = await Promise.all([
      this.calculateRFMScore(userId),
      this.getPurchasePatterns(userId),
      this.getEngagementMetrics(userId),
      this.getCategoryAffinities(userId)
    ]);

    return { rfm, patterns, engagement, affinities };
  }

  // ===================================
  // Private Scoring Methods
  // ===================================

  private scoreRecency(days: number): number {
    if (days <= 7) return 5;
    if (days <= 14) return 4;
    if (days <= 30) return 3;
    if (days <= 60) return 2;
    return 1;
  }

  private scoreFrequency(count: number, periodDays: number): number {
    const ordersPerMonth = (count / periodDays) * 30;
    if (ordersPerMonth >= 8) return 5;  // 2+ orders/week
    if (ordersPerMonth >= 4) return 4;  // 1 order/week
    if (ordersPerMonth >= 2) return 3;  // 2 orders/month
    if (ordersPerMonth >= 1) return 2;  // 1 order/month
    return 1;
  }

  private scoreMonetary(avgValue: number): number {
    if (avgValue >= 500) return 5;
    if (avgValue >= 300) return 4;
    if (avgValue >= 200) return 3;
    if (avgValue >= 100) return 2;
    return 1;
  }

  private determineSegment(rfm: RFMScore): CustomerSegment {
    const { recencyScore: r, frequencyScore: f, monetaryScore: m } = rfm;
    const score = r * 100 + f * 10 + m;

    // Champion: Recent, frequent, high spenders
    if (r >= 4 && f >= 4 && m >= 4) return 'champion';
    
    // Loyal: Frequent buyers
    if (f >= 4) return 'loyal';
    
    // Potential Loyalist: Recent with decent frequency
    if (r >= 4 && f >= 2 && f < 4) return 'potential_loyalist';
    
    // New Customer: Very recent, single purchase
    if (r >= 4 && f <= 2) return 'new_customer';
    
    // Promising: Recent, medium value
    if (r >= 3 && m >= 3) return 'promising';
    
    // Need Attention: Were good, slipping
    if (r >= 2 && r < 4 && f >= 3) return 'need_attention';
    
    // About to Sleep: Below average across board
    if (r >= 2 && r < 4 && f >= 2 && f < 4) return 'about_to_sleep';
    
    // At Risk: Were champions/loyal, now inactive
    if (r < 2 && (f >= 4 || m >= 4)) return 'at_risk';
    
    // Hibernating: Low engagement
    if (r < 3 && f < 3) return 'hibernating';
    
    // Lost: Very old, no engagement
    return 'lost';
  }

  /**
   * Get recommended actions based on segment
   */
  getSegmentActions(segment: CustomerSegment): string[] {
    const actions: { [key in CustomerSegment]: string[] } = {
      champion: [
        'Offer exclusive early access to new products',
        'Invite to loyalty program VIP tier',
        'Ask for reviews and referrals'
      ],
      loyal: [
        'Upsell premium products',
        'Offer bundle deals',
        'Send personalized recommendations'
      ],
      potential_loyalist: [
        'Offer membership benefits',
        'Send targeted promotions',
        'Encourage frequent purchases with rewards'
      ],
      new_customer: [
        'Welcome with first-order discount',
        'Showcase best sellers',
        'Educational content about products'
      ],
      promising: [
        'Create brand awareness',
        'Offer free trial of premium features',
        'Category-specific promotions'
      ],
      need_attention: [
        'Send re-engagement campaign',
        'Offer special "we miss you" discount',
        'Survey for feedback'
      ],
      about_to_sleep: [
        'Time-limited offers',
        'Share popular products',
        'Recommend based on past purchases'
      ],
      at_risk: [
        'Win-back campaign with strong incentive',
        'Personal outreach',
        'Exclusive comeback offer'
      ],
      hibernating: [
        'Reactivation campaign',
        'Show what\'s new since last visit',
        'Deep discount to re-engage'
      ],
      lost: [
        'Survey to understand why they left',
        'Aggressive win-back offer',
        'Consider removing from active campaigns'
      ]
    };

    return actions[segment] || [];
  }

  // ===================================
  // Methods merged from CustomerHealthService
  // ===================================

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.healthPgPool = new Pool({ connectionString: databaseUrl, max: 5 });

    this.healthMysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'mangwale_user',
      password: this.config.get('PHP_DB_PASSWORD') || '',
      database: this.config.get('PHP_DB_NAME') || 'mangwale_db',
      connectionLimit: 5,
      connectTimeout: 10000,
    });

    try {
      const client = await this.healthPgPool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS customer_health_scores (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id INTEGER NOT NULL,
          phone VARCHAR(50),
          rfm_score VARCHAR(10),
          rfm_segment VARCHAR(30),
          churn_risk DECIMAL(5,4) DEFAULT 0,
          ltv_predicted DECIMAL(10,2) DEFAULT 0,
          health_score INTEGER DEFAULT 50,
          recency_days INTEGER DEFAULT 0,
          frequency_90d INTEGER DEFAULT 0,
          avg_order_value DECIMAL(10,2) DEFAULT 0,
          complaint_rate DECIMAL(5,4) DEFAULT 0,
          last_computed_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_health_score ON customer_health_scores(health_score);
        CREATE INDEX IF NOT EXISTS idx_health_churn ON customer_health_scores(churn_risk);
        CREATE INDEX IF NOT EXISTS idx_health_segment ON customer_health_scores(rfm_segment);
      `);
      client.release();
      this.logger.log('CustomerHealth subsystem initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize health subsystem: ${error.message}`);
    }
  }

  /**
   * Compute health score for a single user
   */
  async computeHealthScore(userId: number): Promise<CustomerHealthScore | null> {
    try {
      // Get order stats from MySQL
      const [orderRows] = await this.healthMysqlPool.query(`
        SELECT
          u.id as user_id,
          u.phone as phone,
          COUNT(CASE WHEN o.order_status = 'delivered' AND o.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 END) as orders_90d,
          AVG(CASE WHEN o.order_status = 'delivered' THEN o.order_amount END) as avg_order_value,
          MAX(o.created_at) as last_order_date,
          DATEDIFF(NOW(), MAX(o.created_at)) as recency_days,
          COUNT(CASE WHEN o.order_status = 'canceled' THEN 1 END) / GREATEST(COUNT(*), 1) as cancel_rate
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE u.id = ?
        GROUP BY u.id, u.phone
      `, [userId]) as any;

      if (!orderRows[0]) return null;

      const data = orderRows[0];
      const recencyDays = parseInt(data.recency_days) || 999;
      const frequency = parseInt(data.orders_90d) || 0;
      const avgValue = parseFloat(data.avg_order_value) || 0;
      const cancelRate = parseFloat(data.cancel_rate) || 0;

      // Compute RFM scores (1-5)
      const rScore = recencyDays <= 7 ? 5 : recencyDays <= 14 ? 4 : recencyDays <= 30 ? 3 : recencyDays <= 60 ? 2 : 1;
      const fScore = frequency >= 8 ? 5 : frequency >= 4 ? 4 : frequency >= 2 ? 3 : frequency >= 1 ? 2 : 1;
      const mScore = avgValue >= 500 ? 5 : avgValue >= 300 ? 4 : avgValue >= 200 ? 3 : avgValue >= 100 ? 2 : 1;

      // Determine segment
      const rfmScore = `${rScore}${fScore}${mScore}`;
      const segment = this.determineHealthSegment(rScore, fScore, mScore);

      // Compute churn risk (0-1, higher = more risk)
      let churnRisk = 0;
      if (recencyDays > 60) churnRisk += 0.3;
      else if (recencyDays > 30) churnRisk += 0.15;
      else if (recencyDays > 14) churnRisk += 0.05;

      if (frequency <= 1) churnRisk += 0.3;
      else if (frequency <= 2) churnRisk += 0.15;

      if (cancelRate > 0.3) churnRisk += 0.2;
      else if (cancelRate > 0.1) churnRisk += 0.1;

      churnRisk = Math.min(1, churnRisk);

      // Health score (0-100, higher = healthier)
      const healthScore = Math.round(
        (rScore * 6 + fScore * 6 + mScore * 4 + (1 - churnRisk) * 20)
      );

      // Simple LTV prediction: frequency * AOV * expected lifetime months
      const monthlyFreq = frequency / 3; // from 90 day window
      const expectedMonths = churnRisk < 0.3 ? 12 : churnRisk < 0.6 ? 6 : 3;
      const ltvPredicted = Math.round(monthlyFreq * avgValue * expectedMonths);

      // Upsert to PG
      await this.healthPgPool.query(`
        INSERT INTO customer_health_scores
          (user_id, phone, rfm_score, rfm_segment, churn_risk, ltv_predicted, health_score, recency_days, frequency_90d, avg_order_value, complaint_rate, last_computed_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          phone = $2, rfm_score = $3, rfm_segment = $4, churn_risk = $5, ltv_predicted = $6,
          health_score = $7, recency_days = $8, frequency_90d = $9, avg_order_value = $10,
          complaint_rate = $11, last_computed_at = NOW(), updated_at = NOW()
      `, [userId, data.phone, rfmScore, segment, churnRisk, ltvPredicted, healthScore, recencyDays, frequency, Math.round(avgValue * 100) / 100, cancelRate]);

      return {
        id: '', userId, phone: data.phone, rfmScore, rfmSegment: segment,
        churnRisk, ltvPredicted, healthScore, recencyDays, frequency90d: frequency,
        avgOrderValue: avgValue, complaintRate: cancelRate, lastComputedAt: new Date(),
      };
    } catch (error: any) {
      this.logger.error(`computeHealthScore failed for user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Batch compute for all active users
   */
  async computeAllHealthScores(): Promise<{ computed: number; errors: number }> {
    let computed = 0, errors = 0;
    try {
      const [rows] = await this.healthMysqlPool.query(`
        SELECT DISTINCT user_id FROM orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)
          AND user_id IS NOT NULL
      `) as any;

      for (const row of rows) {
        try {
          const result = await this.computeHealthScore(row.user_id);
          if (result) {
            computed++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }
      this.logger.log(`Computed health scores: ${computed} success, ${errors} errors`);
    } catch (error: any) {
      this.logger.error(`Batch compute failed: ${error.message}`);
    }
    return { computed, errors };
  }

  /**
   * Get paginated health score board
   */
  async getHealthScoreBoard(filters?: {
    segment?: string;
    minHealth?: number;
    maxHealth?: number;
    minChurnRisk?: number;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: CustomerHealthScore[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.segment) {
      conditions.push(`rfm_segment = $${idx++}`);
      params.push(filters.segment);
    }
    if (filters?.minHealth !== undefined) {
      conditions.push(`health_score >= $${idx++}`);
      params.push(filters.minHealth);
    }
    if (filters?.maxHealth !== undefined) {
      conditions.push(`health_score <= $${idx++}`);
      params.push(filters.maxHealth);
    }
    if (filters?.minChurnRisk !== undefined) {
      conditions.push(`churn_risk >= $${idx++}`);
      params.push(filters.minChurnRisk);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = filters?.sortBy || 'health_score';
    const sortOrder = filters?.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const allowedSorts = ['health_score', 'churn_risk', 'recency_days', 'frequency_90d', 'avg_order_value', 'ltv_predicted'];
    const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : 'health_score';

    const [itemsRes, countRes] = await Promise.all([
      this.healthPgPool.query(
        `SELECT * FROM customer_health_scores ${where} ORDER BY ${safeSortBy} ${sortOrder} LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset],
      ),
      this.healthPgPool.query(
        `SELECT COUNT(*) as total FROM customer_health_scores ${where}`,
        params,
      ),
    ]);

    return {
      items: itemsRes.rows.map(this.mapHealthRow),
      total: parseInt(countRes.rows[0].total),
    };
  }

  /**
   * Get churn risk list
   */
  async getChurnRiskList(threshold: number = 0.5, limit: number = 20): Promise<CustomerHealthScore[]> {
    const result = await this.healthPgPool.query(
      `SELECT * FROM customer_health_scores WHERE churn_risk >= $1 ORDER BY churn_risk DESC LIMIT $2`,
      [threshold, limit],
    );
    return result.rows.map(this.mapHealthRow);
  }

  /**
   * Get segment distribution
   */
  async getSegmentDistribution(): Promise<Array<{ segment: string; count: number; avgHealth: number }>> {
    const result = await this.healthPgPool.query(`
      SELECT rfm_segment as segment, COUNT(*) as count, AVG(health_score) as avg_health
      FROM customer_health_scores
      GROUP BY rfm_segment
      ORDER BY count DESC
    `);
    return result.rows.map(r => ({
      segment: r.segment || 'unknown',
      count: parseInt(r.count),
      avgHealth: Math.round(parseFloat(r.avg_health) || 0),
    }));
  }

  /**
   * Get health score distribution for histogram
   */
  async getHealthDistribution(): Promise<Array<{ range: string; count: number }>> {
    const result = await this.healthPgPool.query(`
      SELECT
        CASE
          WHEN health_score <= 20 THEN '0-20'
          WHEN health_score <= 40 THEN '21-40'
          WHEN health_score <= 60 THEN '41-60'
          WHEN health_score <= 80 THEN '61-80'
          ELSE '81-100'
        END as range,
        COUNT(*) as count
      FROM customer_health_scores
      GROUP BY 1
      ORDER BY 1
    `);
    return result.rows.map(r => ({ range: r.range, count: parseInt(r.count) }));
  }

  /**
   * Determine health segment from RFM scores
   * NOTE: Renamed from determineSegment() to avoid collision with existing method
   */
  private determineHealthSegment(r: number, f: number, m: number): string {
    if (r >= 4 && f >= 4 && m >= 4) return 'champion';
    if (f >= 4) return 'loyal';
    if (r >= 4 && f >= 2 && f < 4) return 'potential_loyalist';
    if (r >= 4 && f <= 2) return 'new_customer';
    if (r >= 3 && m >= 3) return 'promising';
    if (r >= 2 && r < 4 && f >= 3) return 'need_attention';
    if (r >= 2 && r < 4 && f >= 2 && f < 4) return 'about_to_sleep';
    if (r < 2 && (f >= 4 || m >= 4)) return 'at_risk';
    if (r < 3 && f < 3) return 'hibernating';
    return 'lost';
  }

  private mapHealthRow(row: any): CustomerHealthScore {
    return {
      id: row.id,
      userId: row.user_id,
      phone: row.phone,
      rfmScore: row.rfm_score,
      rfmSegment: row.rfm_segment,
      churnRisk: parseFloat(row.churn_risk) || 0,
      ltvPredicted: parseFloat(row.ltv_predicted) || 0,
      healthScore: parseInt(row.health_score) || 0,
      recencyDays: parseInt(row.recency_days) || 0,
      frequency90d: parseInt(row.frequency_90d) || 0,
      avgOrderValue: parseFloat(row.avg_order_value) || 0,
      complaintRate: parseFloat(row.complaint_rate) || 0,
      lastComputedAt: row.last_computed_at,
    };
  }
}
