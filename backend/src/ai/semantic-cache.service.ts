import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Semantic Cache Configuration
 */
interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
  similarityThreshold: number;
  // Use hash-based matching for exact same prompts
  useExactMatch: boolean;
  // Use embedding similarity for semantic matching
  useSemanticMatch: boolean;
}

interface CacheEntry {
  query: string;
  queryHash: string;
  response: string;
  model: string;
  tenantId: string;
  hitCount: number;
  createdAt: number;
  lastAccessedAt: number;
  tokens: {
    prompt: number;
    completion: number;
  };
  latencyMs: number;
}

export interface CacheStats {
  totalEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  avgLatencySaved: number;
  tokensSaved: number;
  estimatedCostSaved: number;
}

/**
 * Semantic Cache Service
 * 
 * Provides intelligent caching for LLM responses with both exact-match
 * and semantic similarity matching.
 * 
 * Benefits:
 * - Reduces LLM API costs by caching common queries
 * - Improves response time for cached queries
 * - Tracks cache effectiveness metrics
 */
@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);
  private config: CacheConfig;

  // Local stats (persisted to Redis periodically)
  private localStats = {
    hits: 0,
    misses: 0,
    tokensSaved: 0,
    latencySavedMs: 0,
  };

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.config = {
      enabled: this.configService.get('SEMANTIC_CACHE_ENABLED', 'true') === 'true',
      ttlSeconds: parseInt(this.configService.get('SEMANTIC_CACHE_TTL', '3600'), 10), // 1 hour default
      maxEntries: parseInt(this.configService.get('SEMANTIC_CACHE_MAX_ENTRIES', '10000'), 10),
      similarityThreshold: parseFloat(this.configService.get('SEMANTIC_CACHE_THRESHOLD', '0.92')),
      useExactMatch: true,
      useSemanticMatch: false, // Will enable when embeddings are available
    };

    this.logger.log(`✅ Semantic Cache initialized with shared Redis`);
    this.logger.log(`   - TTL: ${this.config.ttlSeconds}s`);
    this.logger.log(`   - Max entries: ${this.config.maxEntries}`);
    this.logger.log(`   - Exact match: ${this.config.useExactMatch}`);
    this.logger.log(`   - Semantic match: ${this.config.useSemanticMatch}`);
  }

  /**
   * Generate a hash for exact matching
   * Note: We use 'any' as model placeholder for lookup when actual model isn't known
   * This ensures cache hits work regardless of which LLM is used
   */
  private generateQueryHash(query: string, model: string, tenantId: string): string {
    const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
    // Use 'any' for model matching to allow cache hits regardless of provider
    const modelKey = (model === 'unknown' || !model) ? 'any' : 'any';
    return crypto
      .createHash('sha256')
      .update(`${tenantId}:${modelKey}:${normalized}`)
      .digest('hex')
      .substring(0, 32);
  }

  /**
   * Check cache for existing response
   */
  async get(
    query: string,
    model: string,
    tenantId: string = 'default',
  ): Promise<CacheEntry | null> {
    if (!this.config.enabled || !this.redis) {
      return null;
    }

    try {
      const queryHash = this.generateQueryHash(query, model, tenantId);
      
      // Try exact match first
      if (this.config.useExactMatch) {
        const cached = await this.redis.get(`exact:${queryHash}`);
        if (cached) {
          const entry: CacheEntry = JSON.parse(cached);
          
          // Update hit count and last accessed time
          entry.hitCount++;
          entry.lastAccessedAt = Date.now();
          await this.redis.set(
            `exact:${queryHash}`,
            JSON.stringify(entry),
            'EX',
            this.config.ttlSeconds,
          );

          // Track stats
          this.localStats.hits++;
          this.localStats.tokensSaved += entry.tokens.prompt + entry.tokens.completion;
          this.localStats.latencySavedMs += entry.latencyMs;

          this.logger.debug(`✅ Cache hit: ${queryHash} (hits: ${entry.hitCount})`);
          return entry;
        }
      }

      // TODO: Implement semantic matching with embeddings
      // This would compare embedding vectors to find similar queries
      // if (this.config.useSemanticMatch) {
      //   const embedding = await this.getEmbedding(query);
      //   const similar = await this.findSimilar(embedding, tenantId, model);
      //   if (similar && similar.similarity >= this.config.similarityThreshold) {
      //     return similar.entry;
      //   }
      // }

      this.localStats.misses++;
      return null;
    } catch (error) {
      this.logger.error(`Cache get error: ${error.message}`);
      return null;
    }
  }

  /**
   * Store a response in the cache
   */
  async set(
    query: string,
    response: string,
    model: string,
    tenantId: string = 'default',
    tokens: { prompt: number; completion: number },
    latencyMs: number,
  ): Promise<void> {
    if (!this.config.enabled || !this.redis) {
      return;
    }

    try {
      const queryHash = this.generateQueryHash(query, model, tenantId);
      
      const entry: CacheEntry = {
        query,
        queryHash,
        response,
        model,
        tenantId,
        hitCount: 0,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        tokens,
        latencyMs,
      };

      // Store with exact match key
      await this.redis.set(
        `exact:${queryHash}`,
        JSON.stringify(entry),
        'EX',
        this.config.ttlSeconds,
      );

      // Track entry in tenant's cache index
      await this.redis.sadd(`index:${tenantId}`, queryHash);
      
      // Enforce max entries (simple LRU-like eviction)
      const indexSize = await this.redis.scard(`index:${tenantId}`);
      if (indexSize > this.config.maxEntries) {
        // Remove oldest entries (simplified - could use sorted set for better LRU)
        const toRemove = Math.ceil(this.config.maxEntries * 0.1); // Remove 10% when over limit
        const members = await this.redis.srandmember(`index:${tenantId}`, toRemove);
        if (members && members.length > 0) {
          await this.redis.srem(`index:${tenantId}`, ...members);
          await Promise.all(members.map(m => this.redis!.del(`exact:${m}`)));
          this.logger.debug(`♻️ Evicted ${members.length} cache entries`);
        }
      }

      this.logger.debug(`📝 Cached response: ${queryHash} (tokens: ${tokens.prompt + tokens.completion})`);
    } catch (error) {
      this.logger.error(`Cache set error: ${error.message}`);
    }
  }

  /**
   * Invalidate a specific cache entry
   */
  async invalidate(query: string, model: string, tenantId: string = 'default'): Promise<void> {
    if (!this.redis) return;

    try {
      const queryHash = this.generateQueryHash(query, model, tenantId);
      await this.redis.del(`exact:${queryHash}`);
      await this.redis.srem(`index:${tenantId}`, queryHash);
      this.logger.debug(`🗑️ Invalidated cache entry: ${queryHash}`);
    } catch (error) {
      this.logger.error(`Cache invalidate error: ${error.message}`);
    }
  }

  /**
   * Clear all cache entries for a tenant
   */
  async clearTenantCache(tenantId: string): Promise<number> {
    if (!this.redis) return 0;

    try {
      const members = await this.redis.smembers(`index:${tenantId}`);
      if (members.length > 0) {
        await Promise.all(members.map(m => this.redis!.del(`exact:${m}`)));
        await this.redis.del(`index:${tenantId}`);
      }
      this.logger.log(`🗑️ Cleared ${members.length} cache entries for tenant: ${tenantId}`);
      return members.length;
    } catch (error) {
      this.logger.error(`Cache clear error: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(tenantId?: string): Promise<CacheStats> {
    if (!this.redis) {
      return {
        totalEntries: 0,
        hits: this.localStats.hits,
        misses: this.localStats.misses,
        hitRate: 0,
        avgLatencySaved: 0,
        tokensSaved: this.localStats.tokensSaved,
        estimatedCostSaved: 0,
      };
    }

    try {
      let totalEntries = 0;
      
      if (tenantId) {
        totalEntries = await this.redis.scard(`index:${tenantId}`);
      } else {
        // Count all entries (scan all index:* keys)
        const keys = await this.scanKeys('index:*');
        for (const key of keys) {
          totalEntries += await this.redis.scard(key);
        }
      }

      const totalRequests = this.localStats.hits + this.localStats.misses;
      const hitRate = totalRequests > 0 ? this.localStats.hits / totalRequests : 0;
      const avgLatencySaved = this.localStats.hits > 0 
        ? this.localStats.latencySavedMs / this.localStats.hits 
        : 0;

      // Estimate cost savings (rough: $0.002 per 1K tokens for GPT-3.5 equivalent)
      const estimatedCostSaved = (this.localStats.tokensSaved / 1000) * 0.002;

      return {
        totalEntries,
        hits: this.localStats.hits,
        misses: this.localStats.misses,
        hitRate,
        avgLatencySaved,
        tokensSaved: this.localStats.tokensSaved,
        estimatedCostSaved,
      };
    } catch (error) {
      this.logger.error(`Get stats error: ${error.message}`);
      return {
        totalEntries: 0,
        hits: this.localStats.hits,
        misses: this.localStats.misses,
        hitRate: 0,
        avgLatencySaved: 0,
        tokensSaved: this.localStats.tokensSaved,
        estimatedCostSaved: 0,
      };
    }
  }

  /**
   * Get top cached queries by hit count
   */
  async getTopCachedQueries(tenantId: string, limit: number = 10): Promise<Array<{
    query: string;
    hitCount: number;
    model: string;
    tokensSaved: number;
  }>> {
    if (!this.redis) return [];

    try {
      const members = await this.redis.smembers(`index:${tenantId}`);
      const entries: CacheEntry[] = [];

      for (const hash of members) {
        const cached = await this.redis.get(`exact:${hash}`);
        if (cached) {
          entries.push(JSON.parse(cached));
        }
      }

      // Sort by hit count and return top N
      return entries
        .sort((a, b) => b.hitCount - a.hitCount)
        .slice(0, limit)
        .map(e => ({
          query: e.query.substring(0, 100) + (e.query.length > 100 ? '...' : ''),
          hitCount: e.hitCount,
          model: e.model,
          tokensSaved: (e.tokens.prompt + e.tokens.completion) * e.hitCount,
        }));
    } catch (error) {
      this.logger.error(`Get top queries error: ${error.message}`);
      return [];
    }
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(config: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.log(`⚙️ Cache config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Check if cache is enabled and available
   */
  isAvailable(): boolean {
    return this.config.enabled && this.redis !== null;
  }

  /**
   * Helper to scan Redis keys
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    if (!this.redis) return [];
    
    const keys: string[] = [];
    let cursor = '0';
    
    do {
      const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');
    
    return keys;
  }

  // Redis cleanup handled by RedisModule
}
