import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * 🗄️ LLM Response Cache
 * 
 * Caches common LLM responses to:
 * - Reduce API calls and costs
 * - Improve response times
 * - Handle traffic spikes
 * 
 * Cache Strategy:
 * - Exact match: Hash of prompt + model + params
 * - Semantic match: Embedding similarity (Phase 2)
 * - Popular queries: Pre-computed responses
 * 
 * Cache Tiers:
 * - L1: In-memory (hot queries, 100 entries)
 * - L2: Redis (warm queries, TTL-based)
 * - L3: PostgreSQL (cold queries, analytics)
 */

export interface CachedResponse {
  response: string;
  modelId: string;
  tokens: { input: number; output: number };
  cachedAt: Date;
  hitCount: number;
  ttl: number;
}

export interface CacheKey {
  prompt: string;
  systemPrompt?: string;
  modelId?: string;
  temperature?: number;
  tenantId?: number;
}

@Injectable()
export class LlmCacheService {
  private readonly logger = new Logger(LlmCacheService.name);
  private memoryCache: Map<string, { data: CachedResponse; expiry: Date }> = new Map();

  // Configuration
  private readonly CACHE_PREFIX = 'llm:cache:';
  private readonly DEFAULT_TTL = 3600; // 1 hour
  private readonly MAX_MEMORY_ENTRIES = 100;
  private readonly SIMILARITY_THRESHOLD = 0.95; // For semantic cache

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('✅ LlmCacheService initialized with shared Redis');
  }

  /**
   * Generate cache key from request
   */
  private generateKey(keyData: CacheKey): string {
    // Normalize the prompt for better cache hits
    const normalizedPrompt = keyData.prompt
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '');

    const keyComponents = [
      normalizedPrompt,
      keyData.systemPrompt?.slice(0, 100) || '', // Only first 100 chars of system prompt
      keyData.modelId || 'default',
      keyData.temperature?.toString() || '0.7',
      keyData.tenantId?.toString() || 'global',
    ];

    const hash = crypto
      .createHash('sha256')
      .update(keyComponents.join('|'))
      .digest('hex')
      .slice(0, 16);

    return `${this.CACHE_PREFIX}${hash}`;
  }

  /**
   * Get cached response
   */
  async get(keyData: CacheKey): Promise<CachedResponse | null> {
    const key = this.generateKey(keyData);

    // Check L1 memory cache
    const memCached = this.memoryCache.get(key);
    if (memCached && memCached.expiry > new Date()) {
      memCached.data.hitCount++;
      return memCached.data;
    }

    // Check L2 Redis cache
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const data: CachedResponse = JSON.parse(cached);
        data.hitCount++;

        // Promote to L1 on hit
        this.setMemoryCache(key, data);

        // Update hit count in Redis (fire and forget)
        this.redis.set(key, JSON.stringify(data), 'KEEPTTL').catch(() => {});

        return data;
      }
    } catch (error: any) {
      this.logger.error(`Redis get failed: ${error.message}`);
    }

    return null;
  }

  /**
   * Set cached response
   */
  async set(
    keyData: CacheKey,
    response: string,
    modelId: string,
    tokens: { input: number; output: number },
    ttl?: number,
  ): Promise<void> {
    const key = this.generateKey(keyData);
    const effectiveTtl = ttl || this.calculateTtl(keyData, response);

    const cacheData: CachedResponse = {
      response,
      modelId,
      tokens,
      cachedAt: new Date(),
      hitCount: 0,
      ttl: effectiveTtl,
    };

    // Set in L1 memory cache
    this.setMemoryCache(key, cacheData);

    // Set in L2 Redis cache
    try {
      await this.redis.set(key, JSON.stringify(cacheData), 'EX', effectiveTtl);
    } catch (error: any) {
      this.logger.error(`Redis set failed: ${error.message}`);
    }
  }

  /**
   * Set in memory cache with eviction
   */
  private setMemoryCache(key: string, data: CachedResponse): void {
    // Evict oldest if at capacity
    if (this.memoryCache.size >= this.MAX_MEMORY_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestTime = new Date();

      for (const [k, v] of this.memoryCache) {
        if (v.expiry < oldestTime) {
          oldestTime = v.expiry;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }

    this.memoryCache.set(key, {
      data,
      expiry: new Date(Date.now() + (data.ttl * 1000)),
    });
  }

  /**
   * Calculate optimal TTL based on query characteristics
   */
  private calculateTtl(keyData: CacheKey, response: string): number {
    const prompt = keyData.prompt.toLowerCase();
    let ttl = this.DEFAULT_TTL;

    // Static content - longer TTL
    if (
      prompt.includes('what is your name') ||
      prompt.includes('who are you') ||
      prompt.includes('menu') ||
      prompt.includes('working hours') ||
      prompt.includes('contact')
    ) {
      ttl = 86400; // 24 hours
    }

    // Greetings - medium TTL (vary by time of day)
    else if (
      prompt.includes('hello') ||
      prompt.includes('hi') ||
      prompt.includes('namaste')
    ) {
      ttl = 7200; // 2 hours
    }

    // Product queries - shorter TTL (prices change)
    else if (
      prompt.includes('price') ||
      prompt.includes('cost') ||
      prompt.includes('available')
    ) {
      ttl = 1800; // 30 minutes
    }

    // Order status - very short TTL
    else if (
      prompt.includes('order status') ||
      prompt.includes('where is my order')
    ) {
      ttl = 300; // 5 minutes
    }

    return ttl;
  }

  /**
   * Invalidate cache for pattern
   */
  async invalidate(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.keys(`${this.CACHE_PREFIX}${pattern}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }

      // Clear memory cache too
      for (const key of this.memoryCache.keys()) {
        if (key.includes(pattern)) {
          this.memoryCache.delete(key);
        }
      }

      return keys.length;
    } catch (error: any) {
      this.logger.error(`Invalidate failed: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    memoryEntries: number;
    redisKeys: number;
    hitRate: number;
    avgTtl: number;
    topCached: Array<{ prompt: string; hits: number }>;
  }> {
    try {
      // Count Redis keys
      const keys = await this.redis.keys(`${this.CACHE_PREFIX}*`);

      // Get samples for stats
      const samples = await Promise.all(
        keys.slice(0, 100).map(async (key) => {
          const data = await this.redis.get(key);
          return data ? JSON.parse(data) : null;
        }),
      );

      const validSamples = samples.filter(Boolean) as CachedResponse[];
      const totalHits = validSamples.reduce((sum, s) => sum + s.hitCount, 0);
      const avgTtl = validSamples.length > 0
        ? validSamples.reduce((sum, s) => sum + s.ttl, 0) / validSamples.length
        : this.DEFAULT_TTL;

      // Sort by hit count
      validSamples.sort((a, b) => b.hitCount - a.hitCount);

      return {
        memoryEntries: this.memoryCache.size,
        redisKeys: keys.length,
        hitRate: validSamples.length > 0 ? totalHits / (totalHits + validSamples.length) : 0,
        avgTtl: Math.round(avgTtl),
        topCached: validSamples.slice(0, 10).map((s) => ({
          prompt: s.response.slice(0, 50) + '...',
          hits: s.hitCount,
        })),
      };
    } catch (error: any) {
      this.logger.error(`Get stats failed: ${error.message}`);
      return {
        memoryEntries: this.memoryCache.size,
        redisKeys: 0,
        hitRate: 0,
        avgTtl: this.DEFAULT_TTL,
        topCached: [],
      };
    }
  }

  /**
   * Warm up cache with popular queries
   */
  async warmUp(popularQueries: Array<{ prompt: string; response: string; modelId: string }>): Promise<void> {
    this.logger.log(`🔥 Warming up cache with ${popularQueries.length} queries...`);

    for (const query of popularQueries) {
      await this.set(
        { prompt: query.prompt },
        query.response,
        query.modelId,
        { input: 0, output: 0 },
        86400, // 24 hours
      );
    }

    this.logger.log(`✅ Cache warmed up`);
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${this.CACHE_PREFIX}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      this.memoryCache.clear();
      this.logger.log('🗑️ Cache cleared');
    } catch (error: any) {
      this.logger.error(`Clear failed: ${error.message}`);
    }
  }
}
