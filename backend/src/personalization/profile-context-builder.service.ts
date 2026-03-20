import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../database/prisma.service';
import { UserContextService } from '../user-context/user-context.service';
import { SessionService } from '../session/session.service';
import { BehavioralAnalyticsService } from './services/behavioral-analytics.service';
import { ProfileContext, SearchBoosts } from './profile-context.interface';

/**
 * ProfileContextBuilder Service
 *
 * Assembles a complete ProfileContext from multiple data sources:
 *   - user_profiles table (PG) → dietary, communication, profileCompleteness
 *   - user_insights table (PG) → favoriteStores, favoriteItems
 *   - Order history (MySQL via UserContextService) → recentOrders, avgOrderValue, frequency
 *   - Session data (Redis) → current location
 *   - customer_health_scores (PG) → rfmSegment, churnRisk, healthScore
 *   - Customer addresses (via UserContextService) → suggestedAddress
 *   - Payment history → suggestedPayment
 *
 * Cached in Redis with 10-minute TTL.
 */
@Injectable()
export class ProfileContextBuilderService {
  private readonly logger = new Logger(ProfileContextBuilderService.name);
  private readonly CACHE_TTL = 600; // 10 minutes in seconds
  private readonly CACHE_PREFIX = 'profile_context:';

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly userContextService?: UserContextService,
    @Optional() private readonly sessionService?: SessionService,
    @Optional() private readonly behavioralAnalytics?: BehavioralAnalyticsService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Build a complete ProfileContext from all data sources.
   * Cache in Redis with 10-minute TTL.
   */
  async buildContext(userId: number, phone: string): Promise<ProfileContext> {
    try {
      // 1. Check Redis cache first
      if (this.redis) {
        const cached = await this.redis.get(`${this.CACHE_PREFIX}${userId}`);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      // 2. Assemble from sources in parallel
      const [profile, insights, orderHistory, healthScore, addresses] = await Promise.allSettled([
        this.getProfile(userId),
        this.getInsights(userId),
        this.getOrderHistory(phone),
        this.getHealthScore(userId),
        this.getAddresses(phone),
      ]);

      const profileData = profile.status === 'fulfilled' ? profile.value : null;
      const insightsData = insights.status === 'fulfilled' ? insights.value : null;
      const orderData = orderHistory.status === 'fulfilled' ? orderHistory.value : null;
      const healthData = healthScore.status === 'fulfilled' ? healthScore.value : null;
      const addressData = addresses.status === 'fulfilled' ? addresses.value : null;

      const context: ProfileContext = {
        identity: {
          userId,
          phone,
          name: profileData?.name || '',
          memberSince: profileData?.created_at ? new Date(profileData.created_at).toISOString() : '',
          segment: healthData?.rfmSegment || 'unknown',
        },
        dietary: {
          type: profileData?.dietary_type || 'unknown',
          restrictions: this.parseJsonArray(profileData?.dietary_restrictions),
          allergies: this.parseJsonArray(profileData?.allergies),
          spiceLevel: profileData?.spice_level || 'medium',
          dislikedIngredients: this.parseJsonArray(profileData?.disliked_ingredients),
        },
        shopping: {
          avgOrderValue: orderData?.avgOrderValue || 0,
          frequency: orderData?.orderFrequency || 0,
          favoriteStores: (orderData?.favoriteStores || []).map((s: any) => s.storeName),
          favoriteItems: (orderData?.favoriteItems || []).map((i: any) => i.itemName),
          recentOrders: (orderData?.recentOrders || []).slice(0, 5).map((o: any) => ({
            storeId: String(o.storeId || ''),
            items: o.items || [],
            date: o.createdAt ? new Date(o.createdAt).toISOString() : '',
          })),
        },
        communication: {
          tone: profileData?.communication_tone || 'friendly',
          language: profileData?.preferred_language || 'en',
          emojiUsage: profileData?.emoji_usage || 'moderate',
          preferredMessageLength: profileData?.preferred_message_length || 'brief',
        },
        behavioral: {
          rfmSegment: healthData?.rfmSegment || 'unknown',
          churnRisk: healthData?.churnRisk || 0,
          healthScore: healthData?.healthScore || 50,
          profileCompleteness: profileData?.profile_completeness || 0,
        },
        defaults: {
          suggestedAddress: addressData?.defaultAddress || null,
          suggestedPayment: this.inferPaymentPreference(orderData),
          suggestedItems: (insightsData?.favoriteItems || []).slice(0, 5).map((item: any) => ({
            name: item.value || item.itemName || '',
            storeId: item.storeId || '',
          })),
        },
      };

      // 3. Store in Redis with 10-minute TTL
      if (this.redis) {
        await this.redis.setex(
          `${this.CACHE_PREFIX}${userId}`,
          this.CACHE_TTL,
          JSON.stringify(context),
        ).catch(err => this.logger.warn(`Cache write failed: ${err.message}`));
      }

      return context;
    } catch (error) {
      this.logger.error(`Failed to build context for user ${userId}: ${error.message}`);
      return this.getEmptyContext(userId, phone);
    }
  }

  /**
   * Invalidate cache (call after profile updates)
   */
  async invalidateContext(userId: number): Promise<void> {
    if (this.redis) {
      await this.redis.del(`${this.CACHE_PREFIX}${userId}`).catch(() => {});
    }
  }

  /**
   * Quick method for search boosts (subset of full context)
   */
  async getSearchBoosts(userId: number, phone: string): Promise<SearchBoosts> {
    try {
      const context = await this.buildContext(userId, phone);

      return {
        boostVeg: context.dietary.type === 'vegetarian' || context.dietary.type === 'jain',
        boostCuisines: this.extractFavoriteCuisines(context),
        priceRange: this.inferPriceRange(context.shopping.avgOrderValue),
        favoriteStores: context.shopping.favoriteStores.slice(0, 5),
      };
    } catch (error) {
      this.logger.warn(`getSearchBoosts failed for user ${userId}: ${error.message}`);
      return { boostVeg: false, boostCuisines: [], priceRange: 'mid', favoriteStores: [] };
    }
  }

  // ── Private helpers ────────────────────────────────────────

  private async getProfile(userId: number): Promise<any> {
    try {
      return await this.prisma.user_profiles.findUnique({ where: { user_id: userId } });
    } catch {
      return null;
    }
  }

  private async getInsights(userId: number): Promise<any> {
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT insight_type, value, confidence FROM user_insights
         WHERE user_id = $1 AND insight_type IN ('favorite_item', 'favorite_store', 'favorite_cuisine')
         ORDER BY confidence DESC LIMIT 20`,
        userId,
      );
      const items = (rows as any[]).filter(r => r.insight_type === 'favorite_item');
      const stores = (rows as any[]).filter(r => r.insight_type === 'favorite_store');
      const cuisines = (rows as any[]).filter(r => r.insight_type === 'favorite_cuisine');
      return { favoriteItems: items, favoriteStores: stores, favoriteCuisines: cuisines };
    } catch {
      return null;
    }
  }

  private async getOrderHistory(phone: string): Promise<any> {
    if (!this.userContextService) return null;
    try {
      return await this.userContextService.getOrderHistoryByPhone(phone);
    } catch {
      return null;
    }
  }

  private async getHealthScore(userId: number): Promise<any> {
    if (!this.behavioralAnalytics) return null;
    try {
      return await this.behavioralAnalytics.computeHealthScore(userId);
    } catch {
      return null;
    }
  }

  private async getAddresses(phone: string): Promise<any> {
    if (!this.userContextService) return null;
    try {
      return await this.userContextService.getAddressesByPhone(phone);
    } catch {
      return null;
    }
  }

  private inferPaymentPreference(orderData: any): string {
    if (!orderData?.recentOrders?.length) return 'cod';
    // Count payment methods from recent orders
    const methods: Record<string, number> = {};
    for (const order of orderData.recentOrders) {
      const method = order.paymentMethod || order.payment_method || 'cod';
      methods[method] = (methods[method] || 0) + 1;
    }
    const sorted = Object.entries(methods).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || 'cod';
  }

  private extractFavoriteCuisines(context: ProfileContext): string[] {
    // Infer from favorite items if not explicitly set
    const cuisineKeywords: Record<string, string> = {
      biryani: 'Indian', pizza: 'Italian', burger: 'American',
      sushi: 'Japanese', noodles: 'Chinese', momos: 'Tibetan',
      thali: 'Indian', dosa: 'South Indian', paneer: 'North Indian',
      kebab: 'Mughlai', pasta: 'Italian', ramen: 'Japanese',
    };

    const cuisines = new Set<string>();
    for (const item of context.shopping.favoriteItems) {
      const lower = item.toLowerCase();
      for (const [keyword, cuisine] of Object.entries(cuisineKeywords)) {
        if (lower.includes(keyword)) cuisines.add(cuisine);
      }
    }
    return Array.from(cuisines);
  }

  private inferPriceRange(avgOrderValue: number): string {
    if (avgOrderValue <= 0) return 'mid';
    if (avgOrderValue < 200) return 'budget';
    if (avgOrderValue < 500) return 'mid';
    return 'premium';
  }

  private parseJsonArray(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return []; }
    }
    return [];
  }

  private getEmptyContext(userId: number, phone: string): ProfileContext {
    return {
      identity: { userId, phone, name: '', memberSince: '', segment: 'unknown' },
      dietary: { type: 'unknown', restrictions: [], allergies: [], spiceLevel: 'medium', dislikedIngredients: [] },
      shopping: { avgOrderValue: 0, frequency: 0, favoriteStores: [], favoriteItems: [], recentOrders: [] },
      communication: { tone: 'friendly', language: 'en', emojiUsage: 'moderate', preferredMessageLength: 'brief' },
      behavioral: { rfmSegment: 'unknown', churnRisk: 0, healthScore: 50, profileCompleteness: 0 },
      defaults: { suggestedAddress: null, suggestedPayment: 'cod', suggestedItems: [] },
    };
  }
}
