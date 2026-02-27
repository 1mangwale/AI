/**
 * 🧠 Scraper Knowledge Integration Service
 * 
 * Converts scraped competitor data into ACTIONABLE KNOWLEDGE for MangwaleAI:
 * 
 * 1. PRICING INTELLIGENCE
 *    - Track competitor prices over time
 *    - Suggest optimal pricing strategies
 *    - Alert when competitors change prices
 * 
 * 2. MENU INSIGHTS
 *    - Identify trending items across competitors
 *    - Suggest new items based on competitor menus
 *    - Category gap analysis
 * 
 * 3. CUSTOMER SENTIMENT
 *    - Analyze competitor reviews for common complaints
 *    - Identify what customers love/hate
 *    - Generate improvement recommendations
 * 
 * 4. DELIVERY INSIGHTS
 *    - Compare delivery times
 *    - Identify peak hours
 *    - Optimize delivery zones
 * 
 * 5. CONVERSATIONAL KNOWLEDGE
 *    - Train NLU on competitor item names
 *    - Generate synonyms from menu descriptions
 *    - Improve search relevance
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Pool } from 'pg';
import { firstValueFrom } from 'rxjs';
import { Cron, CronExpression } from '@nestjs/schedule';

interface PricingInsight {
  itemName: string;
  ourPrice: number;
  competitorAvg: number;
  recommendation: 'increase' | 'decrease' | 'maintain';
  reasoning: string;
  potentialRevenue: number;
}

interface MenuInsight {
  trendingItems: string[];
  missingCategories: string[];
  popularCombos: string[];
  seasonalTrends: string[];
}

interface SentimentInsight {
  commonComplaints: { issue: string; frequency: number }[];
  commonPraises: { aspect: string; frequency: number }[];
  deliveryScore: number;
  foodQualityScore: number;
  valueScore: number;
}

@Injectable()
export class ScraperKnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(ScraperKnowledgeService.name);
  private pool: Pool;
  private readonly opensearchUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.opensearchUrl = this.configService.get('OPENSEARCH_URL');
  }

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: this.configService.get('DATABASE_URL'),
      max: 5,
    });
    this.logger.log('🧠 ScraperKnowledgeService initialized');
  }

  /**
   * 💰 PRICING INTELLIGENCE
   * Analyze competitor pricing and suggest strategies
   */
  async analyzePricing(storeId?: number): Promise<PricingInsight[]> {
    this.logger.log(`💰 Analyzing pricing intelligence for store ${storeId || 'all'}`);
    
    try {
      const query = `
        WITH our_items AS (
          SELECT name, price, category_name, store_id
          FROM food_items 
          WHERE status = 1 ${storeId ? 'AND store_id = $1' : ''}
        ),
        competitor_items AS (
          SELECT 
            item_name,
            AVG(zomato_price) as avg_zomato,
            AVG(swiggy_price) as avg_swiggy,
            (COALESCE(AVG(zomato_price), 0) + COALESCE(AVG(swiggy_price), 0)) / 
              NULLIF((CASE WHEN AVG(zomato_price) IS NOT NULL THEN 1 ELSE 0 END + 
                      CASE WHEN AVG(swiggy_price) IS NOT NULL THEN 1 ELSE 0 END), 0) as competitor_avg
          FROM competitor_pricing
          ${storeId ? 'WHERE store_id = $1' : ''}
          GROUP BY item_name
        )
        SELECT 
          oi.name,
          oi.price as our_price,
          ci.competitor_avg,
          CASE 
            WHEN oi.price < ci.competitor_avg * 0.85 THEN 'increase'
            WHEN oi.price > ci.competitor_avg * 1.15 THEN 'decrease'
            ELSE 'maintain'
          END as recommendation,
          (ci.competitor_avg - oi.price) as price_diff
        FROM our_items oi
        LEFT JOIN competitor_items ci ON LOWER(oi.name) = LOWER(ci.item_name)
        WHERE ci.competitor_avg IS NOT NULL
        ORDER BY ABS(ci.competitor_avg - oi.price) DESC
        LIMIT 20
      `;
      
      const result = await this.pool.query(query, storeId ? [storeId] : []);
      
      return result.rows.map(row => ({
        itemName: row.name,
        ourPrice: parseFloat(row.our_price),
        competitorAvg: parseFloat(row.competitor_avg),
        recommendation: row.recommendation,
        reasoning: this.generatePricingReasoning(row),
        potentialRevenue: this.estimateRevenueImpact(row),
      }));
    } catch (error) {
      this.logger.error(`Pricing analysis failed: ${error.message}`);
      return [];
    }
  }

  private generatePricingReasoning(row: any): string {
    const diff = parseFloat(row.competitor_avg) - parseFloat(row.our_price);
    const pct = (diff / parseFloat(row.our_price) * 100).toFixed(0);
    
    if (row.recommendation === 'increase') {
      return `Our price is ${Math.abs(parseInt(pct))}% below competitors. Consider raising to capture more margin.`;
    } else if (row.recommendation === 'decrease') {
      return `Our price is ${Math.abs(parseInt(pct))}% above competitors. Consider lowering to improve competitiveness.`;
    }
    return `Price is competitive within 15% of competitor average.`;
  }

  private estimateRevenueImpact(row: any): number {
    // Simplified estimate - assumes 10 daily orders per item
    const priceChange = parseFloat(row.competitor_avg) - parseFloat(row.our_price);
    return priceChange * 10 * 30; // Monthly impact estimate
  }

  /**
   * 📊 MENU INSIGHTS
   * Identify trending items and gaps in menu
   */
  async analyzeMenuTrends(): Promise<MenuInsight> {
    this.logger.log('📊 Analyzing menu trends from competitors');
    
    try {
      // Get trending items (bestsellers across competitors)
      const trendingQuery = `
        SELECT name, COUNT(*) as count
        FROM competitor_menu_items
        WHERE is_bestseller = true
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
      `;
      
      // Get categories we're missing
      const categoryGapQuery = `
        SELECT DISTINCT category
        FROM competitor_menu_items
        WHERE category NOT IN (
          SELECT DISTINCT category_name FROM food_items WHERE status = 1
        )
        LIMIT 10
      `;
      
      const [trending, gaps] = await Promise.all([
        this.pool.query(trendingQuery),
        this.pool.query(categoryGapQuery),
      ]);
      
      return {
        trendingItems: trending.rows.map(r => r.name),
        missingCategories: gaps.rows.map(r => r.category),
        popularCombos: trending.rows.length > 1
          ? this.detectCombos(trending.rows.map(r => r.name))
          : [],
        seasonalTrends: this.getSeasonalDefaults(),
      };
    } catch (error) {
      this.logger.error(`Menu analysis failed: ${error.message}`);
      return { trendingItems: [], missingCategories: [], popularCombos: [], seasonalTrends: [] };
    }
  }

  /**
   * 😊 SENTIMENT ANALYSIS
   * Analyze competitor reviews for insights
   */
  async analyzeSentiment(externalRestaurantId?: string): Promise<SentimentInsight> {
    this.logger.log('😊 Analyzing competitor review sentiment');
    
    try {
      // Get common issues from negative reviews
      const complaintsQuery = `
        SELECT text, sentiment_score
        FROM competitor_reviews
        WHERE sentiment = 'negative'
        ${externalRestaurantId ? 'AND external_restaurant_id = $1' : ''}
        ORDER BY scraped_at DESC
        LIMIT 100
      `;
      
      // Get common praises from positive reviews
      const praisesQuery = `
        SELECT text, sentiment_score
        FROM competitor_reviews
        WHERE sentiment = 'positive'
        ${externalRestaurantId ? 'AND external_restaurant_id = $1' : ''}
        ORDER BY scraped_at DESC
        LIMIT 100
      `;
      
      const [complaints, praises] = await Promise.all([
        this.pool.query(complaintsQuery, externalRestaurantId ? [externalRestaurantId] : []),
        this.pool.query(praisesQuery, externalRestaurantId ? [externalRestaurantId] : []),
      ]);
      
      // Extract common themes (simplified - in production use NLP)
      const commonComplaints = this.extractThemes(complaints.rows, 'complaints');
      const commonPraisesRaw = this.extractThemes(praises.rows, 'praises');
      
      // Calculate scores from review sentiment averages
      const deliveryScore = this.calculateAspectScore(complaints.rows, praises.rows, 'delivery');
      const foodQualityScore = this.calculateAspectScore(complaints.rows, praises.rows, 'food');
      const valueScore = this.calculateAspectScore(complaints.rows, praises.rows, 'price');

      return {
        commonComplaints,
        commonPraises: commonPraisesRaw.map(p => ({ aspect: p.issue, frequency: p.frequency })),
        deliveryScore,
        foodQualityScore,
        valueScore,
      };
    } catch (error) {
      this.logger.error(`Sentiment analysis failed: ${error.message}`);
      return {
        commonComplaints: [],
        commonPraises: [],
        deliveryScore: 0,
        foodQualityScore: 0,
        valueScore: 0,
      };
    }
  }

  private extractThemes(reviews: any[], type: string): { issue: string; frequency: number }[] {
    // Simplified keyword extraction - in production use proper NLP
    const keywords: Record<string, number> = {};
    const patterns = type === 'complaints' 
      ? ['cold', 'late', 'wrong', 'missing', 'small', 'expensive', 'rude', 'slow']
      : ['fresh', 'hot', 'fast', 'tasty', 'value', 'friendly', 'quick', 'delicious'];
    
    for (const review of reviews) {
      const text = (review.text || '').toLowerCase();
      for (const keyword of patterns) {
        if (text.includes(keyword)) {
          keywords[keyword] = (keywords[keyword] || 0) + 1;
        }
      }
    }
    
    return Object.entries(keywords)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([issue, frequency]) => ({ issue, frequency }));
  }

  /**
   * Detect likely food combos from trending items
   */
  private detectCombos(itemNames: string[]): string[] {
    const comboPairs: string[] = [];
    const comboKeywords = [
      ['biryani', 'raita'], ['pizza', 'coke'], ['burger', 'fries'],
      ['dosa', 'chutney'], ['naan', 'dal'], ['rice', 'curry'],
      ['momos', 'chutney'], ['sandwich', 'juice'], ['thali', 'lassi'],
    ];

    for (const [a, b] of comboKeywords) {
      const hasA = itemNames.some(n => n.toLowerCase().includes(a));
      const hasB = itemNames.some(n => n.toLowerCase().includes(b));
      if (hasA && hasB) comboPairs.push(`${a} + ${b}`);
    }
    return comboPairs.slice(0, 5);
  }

  /**
   * Get seasonal food defaults based on current month
   */
  private getSeasonalDefaults(): string[] {
    const month = new Date().getMonth(); // 0-11
    if (month >= 2 && month <= 4) return ['summer drinks', 'ice cream', 'cold coffee', 'mango shake'];
    if (month >= 5 && month <= 8) return ['hot soup', 'chai', 'pakora', 'maggi'];
    if (month >= 9 && month <= 11) return ['sweets', 'festival specials', 'dry fruits', 'laddu'];
    return ['hot chocolate', 'gajar halwa', 'winter specials'];
  }

  /**
   * Calculate aspect score from positive/negative review mentions (0-10 scale)
   */
  private calculateAspectScore(complaints: any[], praises: any[], aspect: string): number {
    const aspectKeywords: Record<string, string[]> = {
      delivery: ['delivery', 'late', 'slow', 'fast', 'quick', 'time', 'speed'],
      food: ['taste', 'tasty', 'fresh', 'cold', 'stale', 'delicious', 'quality', 'hot'],
      price: ['price', 'expensive', 'cheap', 'value', 'worth', 'overpriced', 'affordable'],
    };

    const keywords = aspectKeywords[aspect] || [];
    let positive = 0, negative = 0;

    for (const review of praises) {
      const text = (review.text || '').toLowerCase();
      if (keywords.some(k => text.includes(k))) positive++;
    }
    for (const review of complaints) {
      const text = (review.text || '').toLowerCase();
      if (keywords.some(k => text.includes(k))) negative++;
    }

    const total = positive + negative;
    if (total === 0) return 5.0; // neutral default
    return Math.round((positive / total) * 100) / 10; // 0-10 scale
  }

  /**
   * 🔄 SYNC TO OPENSEARCH
   * Push knowledge to OpenSearch for search enhancement
   */
  async syncToOpenSearch(): Promise<void> {
    this.logger.log('🔄 Syncing scraper knowledge to OpenSearch');
    
    try {
      // Get competitor item names and synonyms
      const itemsQuery = `
        SELECT DISTINCT 
          name,
          description,
          category
        FROM competitor_menu_items
        WHERE name IS NOT NULL
      `;
      
      const result = await this.pool.query(itemsQuery);
      
      // Create a knowledge index for search enhancement
      const indexName = 'competitor_knowledge';
      
      // Ensure index exists
      try {
        await firstValueFrom(
          this.httpService.put(`${this.opensearchUrl}/${indexName}`, {
            mappings: {
              properties: {
                item_name: { type: 'text', analyzer: 'standard' },
                description: { type: 'text' },
                category: { type: 'keyword' },
                synonyms: { type: 'text' },
                source: { type: 'keyword' },
              }
            }
          })
        );
      } catch (e) {
        // Index might already exist
      }
      
      // Bulk index competitor knowledge
      const bulkBody: string[] = [];
      for (const row of result.rows) {
        bulkBody.push(JSON.stringify({ index: { _index: indexName } }));
        bulkBody.push(JSON.stringify({
          item_name: row.name,
          description: row.description,
          category: row.category,
          synonyms: this.generateSynonyms(row.name),
          source: 'competitor_scraper',
        }));
      }
      
      if (bulkBody.length > 0) {
        await firstValueFrom(
          this.httpService.post(`${this.opensearchUrl}/_bulk`, bulkBody.join('\n') + '\n', {
            headers: { 'Content-Type': 'application/x-ndjson' }
          })
        );
        this.logger.log(`✅ Synced ${result.rows.length} competitor items to OpenSearch`);
      }
    } catch (error) {
      this.logger.error(`OpenSearch sync failed: ${error.message}`);
    }
  }

  private generateSynonyms(itemName: string): string {
    // Generate common synonyms/variations
    const variations: string[] = [itemName];
    
    // Common food name variations
    const replacements: Record<string, string[]> = {
      'biryani': ['biriyani', 'briyani', 'pulao'],
      'paneer': ['cottage cheese', 'panir'],
      'chicken': ['murgh', 'murg'],
      'mutton': ['lamb', 'goat'],
      'naan': ['nan', 'roti', 'bread'],
      'dal': ['daal', 'lentil'],
      'rice': ['chawal', 'pulao'],
    };
    
    const lower = itemName.toLowerCase();
    for (const [key, synonyms] of Object.entries(replacements)) {
      if (lower.includes(key)) {
        for (const syn of synonyms) {
          variations.push(lower.replace(key, syn));
        }
      }
    }
    
    return variations.join(' ');
  }

  /**
   * 📅 SCHEDULED: Daily Knowledge Sync
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async dailyKnowledgeSync() {
    this.logger.log('📅 Running daily knowledge sync...');
    
    try {
      await this.syncToOpenSearch();
      this.logger.log('✅ Daily knowledge sync completed');
    } catch (error) {
      this.logger.error(`Daily sync failed: ${error.message}`);
    }
  }

  /**
   * 🎯 GET RECOMMENDATIONS FOR AI
   * Generate recommendations that can be used by AI agents
   */
  async getAIRecommendations(storeId: number): Promise<{
    pricingTips: string[];
    menuSuggestions: string[];
    improvementAreas: string[];
  }> {
    const [pricing, menu, sentiment] = await Promise.all([
      this.analyzePricing(storeId),
      this.analyzeMenuTrends(),
      this.analyzeSentiment(),
    ]);
    
    return {
      pricingTips: pricing.slice(0, 3).map(p => 
        `${p.recommendation === 'increase' ? '📈' : p.recommendation === 'decrease' ? '📉' : '✅'} ${p.itemName}: ${p.reasoning}`
      ),
      menuSuggestions: [
        ...menu.trendingItems.slice(0, 3).map(i => `🔥 Trending: ${i} is popular on Zomato/Swiggy`),
        ...menu.missingCategories.slice(0, 2).map(c => `➕ Consider adding ${c} category`),
      ],
      improvementAreas: sentiment.commonComplaints.slice(0, 3).map(c => 
        `⚠️ Address "${c.issue}" - mentioned ${c.frequency} times in competitor reviews`
      ),
    };
  }
}
