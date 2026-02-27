import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from '../redis/redis.module';

/**
 * Dynamic Config Service
 * 
 * Enables runtime configuration changes without redeployment:
 * - Bot messages (greetings, prompts, error messages)
 * - Feature flags (enable/disable features)
 * - Business rules (min order value, delivery zones)
 * - A/B test variants
 * 
 * Architecture:
 * 1. PostgreSQL: Source of truth (bot_config table)
 * 2. Redis: In-memory cache for fast access (~1ms)
 * 3. Pub/Sub: Real-time sync across multiple instances
 * 
 * Usage:
 * ```typescript
 * const greeting = await configService.get('greeting_hindi');
 * await configService.set('bot_name', 'Chotu');
 * const allMessages = await configService.getByCategory('messages');
 * ```
 */

export interface BotConfig {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  category: string;
  description?: string;
  updatedBy?: number;
  updatedAt: Date;
}

@Injectable()
export class DynamicConfigService implements OnModuleInit {
  private readonly logger = new Logger(DynamicConfigService.name);
  private cache = new Map<string, string>();

  private readonly CACHE_PREFIX = 'config:';
  private readonly CACHE_TTL = 3600; // 1 hour in Redis

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {
    this.logger.log('✅ DynamicConfigService initialized with shared Redis');
  }

  async onModuleInit() {
    try {
      // Load all configs into memory on startup
      await this.loadAllConfigs();
      
      // Subscribe to config updates from other instances
      await this.subscriber.subscribe('config:update');
      this.subscriber.on('message', (channel, message) => {
        if (channel === 'config:update') {
          const { key, value } = JSON.parse(message);
          this.cache.set(key, value);
          this.logger.debug(`🔄 Config updated from pub/sub: ${key}`);
        }
      });
      
      this.logger.log('✅ DynamicConfigService initialized with cache');
    } catch (error) {
      this.logger.error(`Failed to initialize config service: ${error.message}`);
    }
  }

  /**
   * Load all configs from database into memory
   */
  private async loadAllConfigs(): Promise<void> {
    try {
      const configs = await this.prisma.bot_config.findMany();
      
      for (const config of configs) {
        this.cache.set(config.configKey, config.configValue);
        
        // Also store in Redis for cross-instance sharing
        await this.redis.setex(
          `${this.CACHE_PREFIX}${config.configKey}`,
          this.CACHE_TTL,
          config.configValue
        );
      }
      
      this.logger.log(`📦 Loaded ${configs.length} configs into cache`);
    } catch (error) {
      this.logger.error(`Failed to load configs: ${error.message}`);
    }
  }

  /**
   * Get config value (checks cache → Redis → database)
   */
  async get(key: string, defaultValue?: string): Promise<string | null> {
    try {
      // 1. Check in-memory cache (fastest: ~0.01ms)
      if (this.cache.has(key)) {
        return this.cache.get(key);
      }

      // 2. Check Redis cache (fast: ~1ms)
      const redisValue = await this.redis.get(`${this.CACHE_PREFIX}${key}`);
      if (redisValue) {
        this.cache.set(key, redisValue);
        return redisValue;
      }

      // 3. Check database (slow: ~10ms)
      const config = await this.prisma.bot_config.findUnique({
        where: { configKey: key },
      });

      if (config) {
        const value = config.configValue;
        
        // Update caches
        this.cache.set(key, value);
        await this.redis.setex(`${this.CACHE_PREFIX}${key}`, this.CACHE_TTL, value);
        
        return value;
      }

      // Return default if not found
      return defaultValue || null;
    } catch (error) {
      this.logger.error(`Failed to get config ${key}: ${error.message}`);
      return defaultValue || null;
    }
  }

  /**
   * Get config as number
   */
  async getNumber(key: string, defaultValue: number = 0): Promise<number> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  /**
   * Get config as boolean
   */
  async getBoolean(key: string, defaultValue: boolean = false): Promise<boolean> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    
    return value === 'true' || value === '1' || value === 'yes';
  }

  /**
   * Get config as JSON
   */
  async getJson<T = any>(key: string, defaultValue: T = null): Promise<T> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    
    try {
      return JSON.parse(value);
    } catch {
      return defaultValue;
    }
  }

  /**
   * Set/update config value
   */
  async set(
    key: string,
    value: string,
    options?: {
      type?: BotConfig['type'];
      category?: string;
      description?: string;
      updatedBy?: number;
    }
  ): Promise<void> {
    try {
      // Upsert to database
      await this.prisma.bot_config.upsert({
        where: { configKey: key },
        create: {
          configKey: key,
          configValue: value,
          configType: options?.type || 'string',
          category: options?.category || 'general',
          description: options?.description,
          updatedBy: options?.updatedBy,
        },
        update: {
          configValue: value,
          updatedBy: options?.updatedBy,
          updatedAt: new Date(),
        },
      });

      // Update caches
      this.cache.set(key, value);
      await this.redis.setex(`${this.CACHE_PREFIX}${key}`, this.CACHE_TTL, value);

      // Broadcast to other instances
      await this.redis.publish('config:update', JSON.stringify({ key, value }));

      this.logger.log(`✅ Config updated: ${key} = ${value}`);
    } catch (error) {
      this.logger.error(`Failed to set config ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all configs by category
   */
  async getByCategory(category: string): Promise<BotConfig[]> {
    try {
      const configs = await this.prisma.bot_config.findMany({
        where: { category },
        orderBy: { configKey: 'asc' },
      });

      return configs.map(c => ({
        key: c.configKey,
        value: c.configValue,
        type: c.configType as BotConfig['type'],
        category: c.category,
        description: c.description,
        updatedBy: c.updatedBy,
        updatedAt: c.updatedAt,
      }));
    } catch (error) {
      this.logger.error(`Failed to get configs by category: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all configs
   */
  async getAll(): Promise<BotConfig[]> {
    try {
      const configs = await this.prisma.bot_config.findMany({
        orderBy: [{ category: 'asc' }, { configKey: 'asc' }],
      });

      return configs.map(c => ({
        key: c.configKey,
        value: c.configValue,
        type: c.configType as BotConfig['type'],
        category: c.category,
        description: c.description,
        updatedBy: c.updatedBy,
        updatedAt: c.updatedAt,
      }));
    } catch (error) {
      this.logger.error(`Failed to get all configs: ${error.message}`);
      return [];
    }
  }

  /**
   * Delete config
   */
  async delete(key: string): Promise<void> {
    try {
      await this.prisma.bot_config.delete({
        where: { configKey: key },
      });

      // Clear from caches
      this.cache.delete(key);
      await this.redis.del(`${this.CACHE_PREFIX}${key}`);

      // Broadcast deletion
      await this.redis.publish('config:update', JSON.stringify({ key, value: null }));

      this.logger.log(`🗑️ Config deleted: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete config ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Refresh cache from database
   */
  async refresh(): Promise<void> {
    this.cache.clear();
    await this.loadAllConfigs();
    this.logger.log('🔄 Config cache refreshed');
  }
}
