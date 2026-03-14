import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import Redis from 'ioredis';

/** Cache TTLs in seconds */
const RECOMMENDATIONS_CACHE_TTL = 300; // 5 min
const PROFILE_CACHE_TTL = 600;         // 10 min
const SEARCH_CACHE_TTL = 60;           // 1 min

/**
 * PHP Personalization Service
 *
 * Proxies the 6 personalization endpoints from the PHP backend
 * (used by the Flutter app) so that WhatsApp/MCP channels can
 * access recommendations, profile summaries, and enhanced search.
 */
@Injectable()
export class PhpPersonalizationService extends PhpApiService {
  protected readonly logger = new Logger(PhpPersonalizationService.name);

  constructor(
    configService: ConfigService,
    circuitBreaker: CircuitBreakerService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super(configService, circuitBreaker);
  }

  /** Derive a short cache key suffix from the bearer token */
  private tokenCacheKey(token: string): string {
    return token.length > 16 ? token.slice(-16) : token;
  }

  /**
   * GET /api/v1/customer/recommendations
   * Hybrid recommendations (collaborative + content-based)
   */
  async getRecommendations(
    token: string,
    zoneId: number,
    limit: number = 10,
  ): Promise<any[]> {
    const cacheKey = `personalization:recs:${this.tokenCacheKey(token)}:z${zoneId}:l${limit}`;

    // Try cache first
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug('Recommendations cache HIT');
        return JSON.parse(cached);
      }
    } catch (e) {
      // cache miss or Redis error — fall through
    }

    try {
      this.logger.log(`Fetching recommendations (zone: ${zoneId}, limit: ${limit})`);

      const response: any = await this.get(
        '/api/v1/customer/recommendations',
        { zone_id: zoneId, limit },
        { Authorization: `Bearer ${token}` },
      );

      const items = Array.isArray(response) ? response : (response?.data || response?.items || []);

      try {
        await this.redis.setex(cacheKey, RECOMMENDATIONS_CACHE_TTL, JSON.stringify(items));
      } catch (e) {
        // cache write error — non-fatal
      }

      return items;
    } catch (error) {
      this.logger.warn(`Failed to get recommendations: ${error.message}`);
      return [];
    }
  }

  /**
   * GET /api/v1/customer/recommendations/reorder
   * Suggestions based on past orders
   */
  async getReorderSuggestions(
    token: string,
    limit: number = 10,
  ): Promise<any[]> {
    const cacheKey = `personalization:reorder:${this.tokenCacheKey(token)}:l${limit}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug('Reorder suggestions cache HIT');
        return JSON.parse(cached);
      }
    } catch (e) {
      // fall through
    }

    try {
      this.logger.log(`Fetching reorder suggestions (limit: ${limit})`);

      const response: any = await this.get(
        '/api/v1/customer/recommendations/reorder',
        { limit },
        { Authorization: `Bearer ${token}` },
      );

      const items = Array.isArray(response) ? response : (response?.data || response?.items || []);

      try {
        await this.redis.setex(cacheKey, RECOMMENDATIONS_CACHE_TTL, JSON.stringify(items));
      } catch (e) {
        // non-fatal
      }

      return items;
    } catch (error) {
      this.logger.warn(`Failed to get reorder suggestions: ${error.message}`);
      return [];
    }
  }

  /**
   * GET /api/v1/customer/recommendations/complementary
   * Items that pair well with what the user has ordered / is browsing
   */
  async getComplementaryItems(
    token: string,
    zoneId: number,
    limit: number = 5,
  ): Promise<any[]> {
    const cacheKey = `personalization:complementary:${this.tokenCacheKey(token)}:z${zoneId}:l${limit}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug('Complementary items cache HIT');
        return JSON.parse(cached);
      }
    } catch (e) {
      // fall through
    }

    try {
      this.logger.log(`Fetching complementary items (zone: ${zoneId}, limit: ${limit})`);

      const response: any = await this.get(
        '/api/v1/customer/recommendations/complementary',
        { zone_id: zoneId, limit },
        { Authorization: `Bearer ${token}` },
      );

      const items = Array.isArray(response) ? response : (response?.data || response?.items || []);

      try {
        await this.redis.setex(cacheKey, RECOMMENDATIONS_CACHE_TTL, JSON.stringify(items));
      } catch (e) {
        // non-fatal
      }

      return items;
    } catch (error) {
      this.logger.warn(`Failed to get complementary items: ${error.message}`);
      return [];
    }
  }

  /**
   * GET /api/v1/customer/profile/summary
   * Customer profile summary (order count, preferences, tier, etc.)
   */
  async getProfileSummary(token: string): Promise<any | null> {
    const cacheKey = `personalization:profile:${this.tokenCacheKey(token)}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug('Profile summary cache HIT');
        return JSON.parse(cached);
      }
    } catch (e) {
      // fall through
    }

    try {
      this.logger.log('Fetching profile summary');

      const response: any = await this.get(
        '/api/v1/customer/profile/summary',
        {},
        { Authorization: `Bearer ${token}` },
      );

      const profile = response?.data || response;

      try {
        await this.redis.setex(cacheKey, PROFILE_CACHE_TTL, JSON.stringify(profile));
      } catch (e) {
        // non-fatal
      }

      return profile;
    } catch (error) {
      this.logger.warn(`Failed to get profile summary: ${error.message}`);
      return null;
    }
  }

  /**
   * GET /api/v1/customer/search/enhanced?q=query
   * Personalized search results incorporating user preferences and history
   */
  async getEnhancedSearch(
    token: string,
    query: string,
    moduleId?: number,
  ): Promise<any> {
    const cacheKey = `personalization:search:${this.tokenCacheKey(token)}:q${query}:m${moduleId || 0}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug('Enhanced search cache HIT');
        return JSON.parse(cached);
      }
    } catch (e) {
      // fall through
    }

    try {
      this.logger.log(`Enhanced search: "${query}" (module: ${moduleId || 'all'})`);

      const params: any = { q: query };
      if (moduleId) params.module_id = moduleId;

      const response: any = await this.get(
        '/api/v1/customer/search/enhanced',
        params,
        { Authorization: `Bearer ${token}` },
      );

      const result = response?.data || response;

      try {
        await this.redis.setex(cacheKey, SEARCH_CACHE_TTL, JSON.stringify(result));
      } catch (e) {
        // non-fatal
      }

      return result;
    } catch (error) {
      this.logger.warn(`Failed to get enhanced search: ${error.message}`);
      return { items: [], total: 0 };
    }
  }

  /**
   * GET /api/v1/customer/recommendations/{item_id}/explain
   * Explains why a specific item was recommended to the user
   */
  async explainRecommendation(
    token: string,
    itemId: number,
  ): Promise<any | null> {
    // No cache for explanations — they are infrequent and user-specific
    try {
      this.logger.log(`Explaining recommendation for item ${itemId}`);

      const response: any = await this.get(
        `/api/v1/customer/recommendations/${itemId}/explain`,
        {},
        { Authorization: `Bearer ${token}` },
      );

      return response?.data || response;
    } catch (error) {
      this.logger.warn(`Failed to explain recommendation: ${error.message}`);
      return null;
    }
  }

  /**
   * Invalidate all personalization caches for a user
   * (call after significant user actions like placing an order)
   */
  async invalidateUserCache(token: string): Promise<void> {
    const suffix = this.tokenCacheKey(token);
    try {
      const keys = await this.redis.keys(`personalization:*:${suffix}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.debug(`Invalidated ${keys.length} personalization cache entries`);
      }
    } catch (e) {
      // non-fatal
    }
  }
}
