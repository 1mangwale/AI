import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import { ConversationAnalyzerService, ConversationAnalysis, MessageInsight } from './conversation-analyzer.service';
import { PreferenceSignal } from './preference-signal.interface';

/**
 * Merged from UserProfileEnrichmentService:
 * Order pattern analysis types for MySQL-based enrichment
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

/**
 * User Profiling Service
 *
 * Builds and maintains comprehensive user profiles from:
 * - Conversation history analysis
 * - Search behavior
 * - Order history
 * - Item interactions
 *
 * Uses this data to personalize search results and recommendations
 *
 * Also includes methods merged from UserProfileEnrichmentService:
 * - enrichUserProfile(), analyzeOrderHistory(), updateProfileWithPatterns()
 * - storeFavorites(), getFavoriteItemsFromOrders(), getFavoriteStores()
 * - getProfileSummary(), onOrderPlaced()
 */
@Injectable()
export class UserProfilingService {
  private readonly logger = new Logger(UserProfilingService.name);
  private pool: Pool;

  // ===================================
  // Merged from UserProfileEnrichmentService
  // ===================================
  private mysqlPool: mysql.Pool;
  private enrichmentPgPool: Pool;

  // Cache to track recent enrichments (prevents duplicate calls)
  private recentEnrichments = new Map<number, number>();
  private readonly ENRICHMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly conversationAnalyzer: ConversationAnalyzerService
  ) {
    this.initializePool();
    this.initializeEnrichmentPools();
  }

  private async initializePool() {
    const databaseUrl = process.env.DATABASE_URL || 
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.logger.log('✅ User Profiling Service initialized');
  }

  /**
   * Get or create user profile
   */
  async getProfile(userId: number): Promise<UserProfile | null> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM user_profiles WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToProfile(result.rows[0]);
    } catch (error) {
      this.logger.error(`Failed to get profile for user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get recent insights for a user
   */
  async getInsights(userId: number, limit: number = 10): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT insight_type, insight_key, insight_value, confidence, source, extracted_at
         FROM user_insights
         WHERE user_id = $1
         ORDER BY extracted_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      return result.rows.map(r => ({
        type: r.insight_type,
        key: r.insight_key,
        value: r.insight_value,
        confidence: r.confidence,
        source: r.source,
        timestamp: r.extracted_at,
      }));
    } catch (error) {
      this.logger.error(`Failed to get insights for user ${userId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Build/update user profile from conversation analysis
   */
  async updateProfileFromConversation(params: {
    userId: number;
    phone: string;
    conversationHistory: Array<{ role: string; content: string }>;
    sessionId?: string;
  }): Promise<void> {
    try {
      // Analyze conversation
      const analysis = await this.conversationAnalyzer.analyzeConversation({
        userId: params.userId,
        phone: params.phone,
        conversationHistory: params.conversationHistory
      });

      // Get existing profile or create new one
      let profile = await this.getProfile(params.userId);

      if (!profile) {
        // Create new profile
        await this.createProfile(params.userId, params.phone);
        profile = await this.getProfile(params.userId);
      }

      // Update profile with analysis results
      await this.mergeAnalysisIntoProfile(params.userId, analysis);

      // Store insights
      await this.storeConversationInsights(params.userId, analysis, params.sessionId);

      // Update conversation memory
      await this.updateConversationMemory(params.userId, analysis, params.sessionId);

      this.logger.log(`✅ Updated profile for user ${params.userId} from conversation`);

    } catch (error) {
      this.logger.error(`Failed to update profile: ${error.message}`);
      throw error;
    }
  }

  /**
   * Record message insights in real-time
   */
  async recordMessageInsights(params: {
    userId: number;
    messageText: string;
    sessionId?: string;
  }): Promise<void> {
    try {
      const insights = await this.conversationAnalyzer.extractMessageInsights({
        userId: params.userId,
        messageText: params.messageText
      });

      // Store each insight
      for (const insight of insights) {
        await this.pool.query(
          `INSERT INTO conversation_insights 
           (user_id, session_id, insight_type, insight_category, text_excerpt, extracted_value, confidence, analyzed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            params.userId,
            params.sessionId,
            insight.type,
            insight.category,
            insight.textExcerpt,
            JSON.stringify(insight.value),
            insight.confidence,
            'rule_based'
          ]
        );
      }

      // Apply high-confidence insights immediately to profile
      const highConfidenceInsights = insights.filter(i => i.confidence > 0.8);
      if (highConfidenceInsights.length > 0) {
        await this.applyInsightsToProfile(params.userId, highConfidenceInsights);
      }

    } catch (error) {
      this.logger.error(`Failed to record insights: ${error.message}`);
    }
  }

  /**
   * Track user search pattern
   */
  async trackSearch(params: {
    userId: number;
    query: string;
    module: string;
    clickedItemId?: number;
    converted?: boolean;
  }): Promise<void> {
    try {
      const normalized = params.query.trim().toLowerCase();

      // Update or insert search pattern
      await this.pool.query(
        `INSERT INTO user_search_patterns 
         (user_id, query_text, query_normalized, module, search_count, last_searched_at, first_searched_at)
         VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, query_normalized, module) 
         DO UPDATE SET 
           search_count = user_search_patterns.search_count + 1,
           last_searched_at = CURRENT_TIMESTAMP,
           total_clicks = user_search_patterns.total_clicks + CASE WHEN $5::int IS NOT NULL THEN 1 ELSE 0 END,
           total_conversions = user_search_patterns.total_conversions + CASE WHEN $6::boolean THEN 1 ELSE 0 END`,
        [params.userId, params.query, normalized, params.module, params.clickedItemId || null, params.converted || false]
      );

      // Update profile search count
      await this.pool.query(
        `UPDATE user_profiles 
         SET total_searches = total_searches + 1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [params.userId]
      );

    } catch (error) {
      this.logger.error(`Failed to track search: ${error.message}`);
    }
  }

  /**
   * Track item interaction (view, click, order)
   */
  async trackItemInteraction(params: {
    userId: number;
    itemId: number;
    module: string;
    interactionType: 'view' | 'click' | 'order' | 'save';
    searchQuery?: string;
  }): Promise<void> {
    try {
      const columnMap = {
        view: 'viewed_count',
        click: 'clicked_count',
        order: 'ordered_count',
        save: 'saved_count'
      };

      const column = columnMap[params.interactionType];
      const timestampColumn = params.interactionType === 'view' ? 'last_viewed_at' : 
                              params.interactionType === 'order' ? 'last_ordered_at' : null;

      let query = `
        INSERT INTO user_item_interactions 
        (user_id, item_id, module, ${column}, first_viewed_at, last_viewed_at, typical_search_query)
        VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4)
        ON CONFLICT (user_id, item_id, module) 
        DO UPDATE SET 
          ${column} = user_item_interactions.${column} + 1,
          ${timestampColumn ? `${timestampColumn} = CURRENT_TIMESTAMP,` : ''}
          typical_search_query = COALESCE($4, user_item_interactions.typical_search_query),
          updated_at = CURRENT_TIMESTAMP
      `;

      await this.pool.query(query, [params.userId, params.itemId, params.module, params.searchQuery]);

      // Update favorite items list if ordered multiple times
      if (params.interactionType === 'order') {
        await this.updateFavoriteItems(params.userId, params.itemId);
      }

    } catch (error) {
      this.logger.error(`Failed to track item interaction: ${error.message}`);
    }
  }

  /**
   * Get user's favorite items (ordered 3+ times)
   */
  async getFavoriteItems(userId: number, limit: number = 10): Promise<number[]> {
    try {
      const result = await this.pool.query(
        `SELECT item_id FROM user_item_interactions 
         WHERE user_id = $1 AND ordered_count >= 3
         ORDER BY ordered_count DESC, last_ordered_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows.map(r => r.item_id);
    } catch (error) {
      this.logger.error(`Failed to get favorite items: ${error.message}`);
      return [];
    }
  }

  /**
   * Get personalization boosts for search
   */
  async getPersonalizationBoosts(userId: number, module: string): Promise<PersonalizationBoosts> {
    try {
      const profile = await this.getProfile(userId);
      if (!profile) {
        return this.getDefaultBoosts();
      }

      const boosts: PersonalizationBoosts = {
        itemBoosts: {},
        categoryBoosts: {},
        storeBoosts: {},
        filters: {},
        sortPreference: null
      };

      // Boost favorite items (3x)
      const favoriteItems = await this.getFavoriteItems(userId);
      favoriteItems.forEach(itemId => {
        boosts.itemBoosts[itemId] = 3.0;
      });

      // Boost favorite categories (2x)
      if (profile.favorite_categories) {
        profile.favorite_categories.forEach(catId => {
          boosts.categoryBoosts[catId] = 2.0;
        });
      }

      // Boost favorite stores (2.5x)
      if (profile.favorite_stores) {
        profile.favorite_stores.forEach(storeId => {
          boosts.storeBoosts[storeId] = 2.5;
        });
      }

      // Apply dietary filters
      if (profile.food_preferences?.dietary_type === 'vegetarian') {
        boosts.filters['veg'] = true;
      }

      if (profile.dietary_restrictions) {
        boosts.filters['dietary_restrictions'] = profile.dietary_restrictions;
      }

      // Sort preference based on behavior
      if (profile.price_sensitivity === 'high') {
        boosts.sortPreference = 'price_asc';
      } else if (profile.profile_completeness > 70) {
        boosts.sortPreference = 'relevance'; // Trust our personalization
      }

      return boosts;

    } catch (error) {
      this.logger.error(`Failed to get personalization boosts: ${error.message}`);
      return this.getDefaultBoosts();
    }
  }

  /**
   * Get conversation memory for context
   */
  async getConversationMemory(userId: number, limit: number = 5): Promise<ConversationMemory[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM conversation_memory 
         WHERE user_id = $1 AND still_valid = TRUE
         ORDER BY importance DESC, recency_score DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        memoryType: row.memory_type,
        category: row.category,
        memoryText: row.memory_text,
        memoryData: row.memory_data,
        importance: row.importance,
        timesReferenced: row.times_referenced
      }));

    } catch (error) {
      this.logger.error(`Failed to get conversation memory: ${error.message}`);
      return [];
    }
  }

  // ===================================
  // Private Helper Methods
  // ===================================

  private async createProfile(userId: number, phone: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_profiles (user_id, phone) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, phone]
    );
  }

  private async mergeAnalysisIntoProfile(userId: number, analysis: ConversationAnalysis): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [userId];
    let paramIndex = 2;

    if (analysis.food_preferences && analysis.food_preferences.confidence > 0.6) {
      updates.push(`food_preferences = $${paramIndex++}`);
      values.push(JSON.stringify(analysis.food_preferences));
    }

    if (analysis.dietary_restrictions && analysis.dietary_restrictions.length > 0) {
      updates.push(`dietary_restrictions = $${paramIndex++}`);
      values.push(analysis.dietary_restrictions);
    }

    if (analysis.shopping_preferences && analysis.shopping_preferences.confidence > 0.6) {
      updates.push(`shopping_preferences = $${paramIndex++}`);
      values.push(JSON.stringify(analysis.shopping_preferences));
    }

    if (analysis.communication_style) {
      if (analysis.communication_style.tone) {
        updates.push(`tone = $${paramIndex++}`);
        values.push(analysis.communication_style.tone);
      }
      if (analysis.communication_style.response_style) {
        updates.push(`response_style = $${paramIndex++}`);
        values.push(analysis.communication_style.response_style);
      }
      if (analysis.communication_style.emoji_usage) {
        updates.push(`emoji_usage = $${paramIndex++}`);
        values.push(analysis.communication_style.emoji_usage);
      }
    }

    if (analysis.personality_traits) {
      updates.push(`personality_traits = $${paramIndex++}`);
      values.push(JSON.stringify(analysis.personality_traits));
    }

    if (analysis.sentiment && analysis.sentiment.satisfaction_score) {
      updates.push(`satisfaction_score = $${paramIndex++}`);
      values.push(analysis.sentiment.satisfaction_score);
    }

    updates.push(`total_conversations = total_conversations + 1`);
    updates.push(`last_analyzed_at = CURRENT_TIMESTAMP`);
    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    if (updates.length > 0) {
      const query = `UPDATE user_profiles SET ${updates.join(', ')} WHERE user_id = $1`;
      await this.pool.query(query, values);
    }

    // Calculate and update profile completeness
    await this.updateProfileCompleteness(userId);
  }

  private async storeConversationInsights(userId: number, analysis: ConversationAnalysis, sessionId?: string): Promise<void> {
    if (analysis.extracted_facts && analysis.extracted_facts.length > 0) {
      for (const fact of analysis.extracted_facts) {
        await this.pool.query(
          `INSERT INTO conversation_insights 
           (user_id, session_id, insight_type, insight_category, text_excerpt, extracted_value, confidence, analyzed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId,
            sessionId,
            'fact',
            fact.category,
            fact.fact,
            JSON.stringify({ importance: fact.importance }),
            0.8,
            'llm'
          ]
        );
      }
    }
  }

  private async updateConversationMemory(userId: number, analysis: ConversationAnalysis, sessionId?: string): Promise<void> {
    if (analysis.extracted_facts) {
      for (const fact of analysis.extracted_facts) {
        if (fact.importance > 60) { // Only store important facts
          await this.pool.query(
            `INSERT INTO conversation_memory 
             (user_id, memory_type, category, memory_text, memory_data, importance, recency_score, extracted_from_session)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              userId,
              'fact',
              fact.category,
              fact.fact,
              JSON.stringify(fact),
              fact.importance,
              1.0,
              sessionId
            ]
          );
        }
      }
    }
  }

  /**
   * Update user profile from NER-extracted PreferenceSignals.
   * Called from context-router as fire-and-forget after NLU classification.
   */
  async updateFromSignals(userId: number, signals: PreferenceSignal[]): Promise<void> {
    if (!signals || signals.length === 0) return;

    try {
      for (const signal of signals) {
        switch (signal.key) {
          case 'dietary_type':
            await this.pool.query(
              `UPDATE user_profiles
               SET food_preferences = jsonb_set(COALESCE(food_preferences, '{}'::jsonb), '{dietary_type}', $2::jsonb),
                   updated_at = CURRENT_TIMESTAMP
               WHERE user_id = $1`,
              [userId, JSON.stringify(signal.value)],
            );
            break;

          case 'allergies':
            // signal.value is string[]
            for (const allergen of (Array.isArray(signal.value) ? signal.value : [signal.value])) {
              await this.pool.query(
                `UPDATE user_profiles
                 SET dietary_restrictions = array_append(COALESCE(dietary_restrictions, ARRAY[]::text[]), $2),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND NOT ($2 = ANY(COALESCE(dietary_restrictions, ARRAY[]::text[])))`,
                [userId, allergen],
              );
            }
            break;

          case 'spice_level':
            await this.pool.query(
              `UPDATE user_profiles
               SET food_preferences = jsonb_set(COALESCE(food_preferences, '{}'::jsonb), '{spice_level}', $2::jsonb),
                   updated_at = CURRENT_TIMESTAMP
               WHERE user_id = $1`,
              [userId, JSON.stringify(signal.value)],
            );
            break;

          case 'price_sensitivity':
            await this.pool.query(
              `UPDATE user_profiles
               SET food_preferences = jsonb_set(COALESCE(food_preferences, '{}'::jsonb), '{price_sensitivity}', $2::jsonb),
                   updated_at = CURRENT_TIMESTAMP
               WHERE user_id = $1`,
              [userId, JSON.stringify(signal.value)],
            );
            break;

          case 'favorite_items':
            // Store as insight rather than overwriting
            if (Array.isArray(signal.value)) {
              for (const item of signal.value) {
                await this.pool.query(
                  `INSERT INTO conversation_insights
                   (user_id, insight_type, insight_category, extracted_value, confidence, analyzed_by)
                   VALUES ($1, 'favorite_item', 'dietary', $2, $3, 'ner_regex')
                   ON CONFLICT DO NOTHING`,
                  [userId, JSON.stringify(item), signal.confidence],
                );
              }
            }
            break;

          default:
            this.logger.debug(`Unhandled signal key: ${signal.key}`);
        }
      }

      // Recalculate completeness
      await this.updateProfileCompleteness(userId);
      this.logger.debug(`Updated profile for user ${userId} from ${signals.length} signal(s)`);
    } catch (error) {
      this.logger.warn(`Failed to update profile from signals for user ${userId}: ${error.message}`);
    }
  }

  private async applyInsightsToProfile(userId: number, insights: MessageInsight[]): Promise<void> {
    for (const insight of insights) {
      if (insight.type === 'food_preference' && insight.value.preference === 'vegetarian') {
        await this.pool.query(
          `UPDATE user_profiles 
           SET food_preferences = jsonb_set(COALESCE(food_preferences, '{}'::jsonb), '{dietary_type}', '"vegetarian"')
           WHERE user_id = $1`,
          [userId]
        );
      }

      if (insight.type === 'food_preference' && insight.value.restriction) {
        await this.pool.query(
          `UPDATE user_profiles 
           SET dietary_restrictions = array_append(COALESCE(dietary_restrictions, ARRAY[]::text[]), $2)
           WHERE user_id = $1 AND NOT ($2 = ANY(COALESCE(dietary_restrictions, ARRAY[]::text[])))`,
          [userId, insight.value.restriction]
        );
      }
    }
  }

  private async updateFavoriteItems(userId: number, itemId: number): Promise<void> {
    // Add to favorites if ordered 3+ times
    const result = await this.pool.query(
      `SELECT ordered_count FROM user_item_interactions 
       WHERE user_id = $1 AND item_id = $2`,
      [userId, itemId]
    );

    if (result.rows.length > 0 && result.rows[0].ordered_count >= 3) {
      await this.pool.query(
        `UPDATE user_profiles 
         SET favorite_items = array_append(COALESCE(favorite_items, ARRAY[]::integer[]), $2)
         WHERE user_id = $1 AND NOT ($2 = ANY(COALESCE(favorite_items, ARRAY[]::integer[])))`,
        [userId, itemId]
      );
    }
  }

  private async updateProfileCompleteness(userId: number): Promise<void> {
    // Calculate completeness based on filled fields (0-100)
    const result = await this.pool.query(
      `SELECT 
         CASE WHEN food_preferences IS NOT NULL AND food_preferences != '{}'::jsonb THEN 15 ELSE 0 END +
         CASE WHEN array_length(dietary_restrictions, 1) > 0 THEN 10 ELSE 0 END +
         CASE WHEN array_length(favorite_items, 1) > 0 THEN 15 ELSE 0 END +
         CASE WHEN tone IS NOT NULL THEN 10 ELSE 0 END +
         CASE WHEN personality_traits IS NOT NULL AND personality_traits != '{}'::jsonb THEN 15 ELSE 0 END +
         CASE WHEN array_length(favorite_stores, 1) > 0 THEN 10 ELSE 0 END +
         CASE WHEN shopping_preferences IS NOT NULL AND shopping_preferences != '{}'::jsonb THEN 15 ELSE 0 END +
         CASE WHEN total_conversations > 5 THEN 10 ELSE total_conversations * 2 END
         AS completeness
       FROM user_profiles WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length > 0) {
      await this.pool.query(
        `UPDATE user_profiles SET profile_completeness = $2 WHERE user_id = $1`,
        [userId, result.rows[0].completeness]
      );
    }
  }

  private mapRowToProfile(row: any): UserProfile {
    return {
      user_id: row.user_id,
      phone: row.phone,
      dietary_type: row.dietary_type,
      food_preferences: row.food_preferences,
      dietary_restrictions: row.dietary_restrictions,
      favorite_items: row.favorite_items,
      favorite_categories: row.favorite_categories,
      favorite_stores: row.favorite_stores,
      shopping_preferences: row.shopping_preferences,
      tone: row.tone,
      language: row.language,
      response_style: row.response_style,
      emoji_usage: row.emoji_usage,
      personality_traits: row.personality_traits,
      price_sensitivity: row.price_sensitivity,
      total_conversations: row.total_conversations,
      total_orders: row.total_orders,
      total_searches: row.total_searches,
      satisfaction_score: row.satisfaction_score,
      profile_completeness: row.profile_completeness,
      confidence_score: row.confidence_score,
      last_analyzed_at: row.last_analyzed_at,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private getDefaultBoosts(): PersonalizationBoosts {
    return {
      itemBoosts: {},
      categoryBoosts: {},
      storeBoosts: {},
      filters: {},
      sortPreference: null
    };
  }

  // ===================================
  // Methods merged from UserProfileEnrichmentService
  // ===================================

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
    if (this.enrichmentPgPool) {
      try {
        const result = await this.enrichmentPgPool.query(
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

  private async initializeEnrichmentPools() {
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
      this.logger.log(`MySQL pool initialized for profile enrichment`);
    } catch (error) {
      this.logger.error(`MySQL connection failed: ${error.message}`);
    }

    // PostgreSQL connection (AI features)
    const pgUrl = process.env.DATABASE_URL ||
      'postgresql://mangwale_config:config_secure_pass_2024@172.17.0.2:5432/headless_mangwale';

    try {
      this.enrichmentPgPool = new Pool({
        connectionString: pgUrl,
        max: 10,
        idleTimeoutMillis: 30000,
      });
      this.logger.log('PostgreSQL pool initialized for profile enrichment');
    } catch (error) {
      this.logger.error(`PostgreSQL connection failed: ${error.message}`);
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
        this.logger.log(`Skipping profile enrichment for user ${userId}: ${skipReason}`);
        return;
      }

      this.logger.log(`Enriching profile for user ${userId} (${phone})`);

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

      this.logger.log(`Profile enriched for user ${userId}: ${orderPatterns.favoriteCuisines.length} cuisines, ${orderPatterns.favoriteItems.length} items`);
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
    if (!this.enrichmentPgPool) return;

    // Check if profile exists
    const existing = await this.enrichmentPgPool.query(
      `SELECT id FROM user_profiles WHERE user_id = $1`,
      [userId]
    );

    if (existing.rows.length === 0) {
      // Create new profile
      await this.enrichmentPgPool.query(
        `INSERT INTO user_profiles (user_id, phone, created_at, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, phone]
      );
      this.logger.log(`Created new profile for user ${userId}`);
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
    if (!this.enrichmentPgPool) return;

    try {
      await this.enrichmentPgPool.query(
        `UPDATE user_profiles SET
           dietary_type = $1,
           favorite_cuisines = $2,
           avg_order_value = $3,
           order_frequency = $4,
           preferred_meal_times = $5,
           price_sensitivity = $6,
           favorite_items = $8,
           favorite_stores = $9,
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
          JSON.stringify(patterns.favoriteItems.map(i => i.itemName)),
          JSON.stringify(patterns.favoriteStores.map(s => s.storeName)),
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
    if (!this.enrichmentPgPool) return;

    try {
      // Store insights for favorite stores
      for (const store of patterns.favoriteStores) {
        await this.enrichmentPgPool.query(
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
        await this.enrichmentPgPool.query(
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

      this.logger.log(`Stored ${patterns.favoriteStores.length} stores, ${patterns.favoriteItems.length} items for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to store favorites: ${error.message}`);
    }
  }

  /**
   * Get user's favorite items for quick reorder suggestions (from order history enrichment)
   * NOTE: Renamed from getFavoriteItems() to avoid collision with existing method
   */
  async getFavoriteItemsFromOrders(userId: number): Promise<Array<{ itemId: number; name: string; category: string; orderCount: number }>> {
    try {
      const result = await this.enrichmentPgPool.query(
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
   * Get user's favorite stores (from order history enrichment)
   */
  async getFavoriteStoresFromOrders(userId: number): Promise<Array<{ storeId: number; name: string; orderCount: number }>> {
    try {
      const result = await this.enrichmentPgPool.query(
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
      const result = await this.enrichmentPgPool.query(
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
      this.logger.log(`Order ${params.orderId} placed - updating profile for user ${params.userId}`);

      // Update order count in insights
      for (const item of params.items) {
        await this.enrichmentPgPool.query(
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

  /**
   * Get all insights across all users (admin dashboard)
   */
  async getAllInsights(options: {
    page?: number;
    limit?: number;
    type?: string;
    minConfidence?: number;
    search?: string;
  } = {}): Promise<{ insights: any[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE 1=1';
      const params: any[] = [];
      let paramIdx = 1;

      if (options.type) {
        whereClause += ` AND i.insight_type = $${paramIdx++}`;
        params.push(options.type);
      }
      if (options.minConfidence) {
        whereClause += ` AND i.confidence >= $${paramIdx++}`;
        params.push(options.minConfidence);
      }
      if (options.search) {
        whereClause += ` AND (p.phone ILIKE $${paramIdx} OR i.insight_key ILIKE $${paramIdx} OR i.insight_value::text ILIKE $${paramIdx})`;
        params.push(`%${options.search}%`);
        paramIdx++;
      }

      const countResult = await this.pool.query(
        `SELECT COUNT(*) FROM user_insights i LEFT JOIN user_profiles p ON i.user_id = p.user_id ${whereClause}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      params.push(limit, offset);
      const result = await this.pool.query(
        `SELECT i.*, p.phone, p.dietary_type, p.profile_completeness
         FROM user_insights i
         LEFT JOIN user_profiles p ON i.user_id = p.user_id
         ${whereClause}
         ORDER BY i.extracted_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        params,
      );

      return { insights: result.rows, total };
    } catch (error) {
      this.logger.error(`Failed to get all insights: ${error.message}`);
      return { insights: [], total: 0 };
    }
  }

  /**
   * Get insight statistics (admin dashboard)
   */
  async getInsightStats(): Promise<any> {
    try {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) as total_insights,
          COUNT(DISTINCT user_id) as unique_users,
          AVG(confidence) as avg_confidence,
          COUNT(*) FILTER (WHERE extracted_at > NOW() - INTERVAL '24 hours') as last_24h,
          COUNT(*) FILTER (WHERE extracted_at > NOW() - INTERVAL '7 days') as last_7d
        FROM user_insights
      `);

      const typeResult = await this.pool.query(`
        SELECT insight_type, COUNT(*) as count
        FROM user_insights
        GROUP BY insight_type
        ORDER BY count DESC
      `);

      const stats = result.rows[0];
      return {
        totalInsights: parseInt(stats.total_insights, 10),
        uniqueUsers: parseInt(stats.unique_users, 10),
        avgConfidence: parseFloat(stats.avg_confidence) || 0,
        last24h: parseInt(stats.last_24h, 10),
        last7d: parseInt(stats.last_7d, 10),
        byType: typeResult.rows.reduce((acc: any, row: any) => {
          acc[row.insight_type] = parseInt(row.count, 10);
          return acc;
        }, {}),
      };
    } catch (error) {
      this.logger.error(`Failed to get insight stats: ${error.message}`);
      return { totalInsights: 0, uniqueUsers: 0, avgConfidence: 0, last24h: 0, last7d: 0, byType: {} };
    }
  }

  /**
   * Clean garbage data from a user's personality_traits and other profile fields.
   * Validates each field and removes invalid entries.
   */
  async cleanGarbageProfileData(userId: number): Promise<void> {
    if (!this.enrichmentPgPool) return;

    try {
      const result = await this.enrichmentPgPool.query(
        `SELECT personality_traits FROM user_profiles WHERE user_id = $1`,
        [userId],
      );

      if (result.rows.length === 0) return;

      const traits = result.rows[0].personality_traits;
      if (!traits || typeof traits !== 'object') return;

      const cleanedTraits: Record<string, any> = {};
      const VALID_SPICE = ['mild', 'medium', 'spicy', 'extra_hot'];
      const VALID_FAMILY = ['1', '2', '3-4', '5+'];

      for (const [key, value] of Object.entries(traits)) {
        if (key === 'spice_level' && typeof value === 'string' && VALID_SPICE.includes(value.toLowerCase())) {
          cleanedTraits[key] = value;
        } else if (key === 'family_size') {
          const strVal = String(value).trim();
          if (VALID_FAMILY.includes(strVal) || /^\d+$/.test(strVal)) {
            cleanedTraits[key] = strVal;
          } else {
            this.logger.warn(`Removing garbage family_size for user ${userId}: "${value}"`);
          }
        } else {
          // Keep other traits as-is unless clearly invalid
          if (typeof value === 'string' && value.length > 0 && value.length < 100) {
            cleanedTraits[key] = value;
          }
        }
      }

      await this.enrichmentPgPool.query(
        `UPDATE user_profiles SET personality_traits = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [JSON.stringify(cleanedTraits), userId],
      );

      this.logger.log(`Cleaned personality_traits for user ${userId}: ${JSON.stringify(cleanedTraits)}`);
    } catch (error) {
      this.logger.error(`Failed to clean garbage data for user ${userId}: ${error.message}`);
    }
  }

  /**
   * Get distinct insight types (for filter dropdown)
   */
  async getInsightTypes(): Promise<Array<{ type: string; count: number }>> {
    try {
      const result = await this.pool.query(`
        SELECT insight_type as type, COUNT(*) as count
        FROM user_insights
        GROUP BY insight_type
        ORDER BY count DESC
      `);
      return result.rows.map((row: any) => ({
        type: row.type,
        count: parseInt(row.count, 10),
      }));
    } catch (error) {
      this.logger.error(`Failed to get insight types: ${error.message}`);
      return [];
    }
  }
}

// Type Definitions
export interface UserProfile {
  user_id: number;
  phone: string;
  dietary_type?: string;
  food_preferences?: any;
  dietary_restrictions?: string[];
  favorite_items?: number[];
  favorite_categories?: number[];
  favorite_stores?: number[];
  shopping_preferences?: any;
  tone?: string;
  language?: string;
  response_style?: string;
  emoji_usage?: string;
  personality_traits?: any;
  price_sensitivity?: string;
  total_conversations?: number;
  total_orders?: number;
  total_searches?: number;
  satisfaction_score?: number;
  profile_completeness?: number;
  confidence_score?: number;
  last_analyzed_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface PersonalizationBoosts {
  itemBoosts: { [itemId: number]: number };
  categoryBoosts: { [catId: number]: number };
  storeBoosts: { [storeId: number]: number };
  filters: any;
  sortPreference: string | null;
}

export interface ConversationMemory {
  id: number;
  memoryType: string;
  category: string;
  memoryText: string;
  memoryData: any;
  importance: number;
  timesReferenced: number;
}
