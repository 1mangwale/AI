import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * MCP Cache Service
 *
 * Provides Redis-backed caching for MCP tool responses and tool call logging.
 * Discovery tools (menus, restaurants, categories) are cached with short TTLs
 * to reduce load on PHP backend and Search API.
 *
 * Key prefix: mcp:
 * Log key: mcp:tool_calls (Redis list, 24h expiry)
 */
@Injectable()
export class McpCacheService {
  private readonly logger = new Logger(McpCacheService.name);
  private readonly PREFIX = 'mcp:';
  private readonly LOG_KEY = 'mcp:tool_calls';
  private readonly LOG_TTL = 86400; // 24 hours

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Get a cached value by key
   */
  async get<T = any>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.PREFIX + key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set a cached value with TTL in seconds
   */
  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(this.PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Cache set failed for ${key}: ${err.message}`);
    }
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  async invalidate(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.keys(this.PREFIX + pattern);
      if (keys.length === 0) return 0;
      const count = await this.redis.del(...keys);
      return count;
    } catch (err) {
      this.logger.warn(`Cache invalidation failed for ${pattern}: ${err.message}`);
      return 0;
    }
  }

  /**
   * Log a tool call for analytics
   */
  async logToolCall(tool: string, args: any, durationMs: number, success: boolean): Promise<void> {
    try {
      const entry = JSON.stringify({
        tool,
        args: JSON.stringify(args || {}).slice(0, 500),
        duration_ms: durationMs,
        success,
        timestamp: new Date().toISOString(),
      });
      await this.redis.lpush(this.LOG_KEY, entry);
      await this.redis.ltrim(this.LOG_KEY, 0, 999); // Keep last 1000 entries
      await this.redis.expire(this.LOG_KEY, this.LOG_TTL);
    } catch {
      // Non-blocking — logging failures shouldn't break tool calls
    }
  }

  /**
   * Get or set pattern — returns cached value or calls factory and caches result
   */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      this.logger.debug(`Cache HIT: ${key}`);
      return cached;
    }

    this.logger.debug(`Cache MISS: ${key}`);
    const result = await factory();
    await this.set(key, result, ttlSeconds);
    return result;
  }

  /**
   * Build a cache key from tool name and params
   */
  buildKey(tool: string, params: Record<string, any>): string {
    // Sort params for consistent keys, exclude auth tokens
    const filtered = Object.entries(params || {})
      .filter(([k]) => k !== 'auth_token')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${tool}:${filtered || 'default'}`;
  }
}
