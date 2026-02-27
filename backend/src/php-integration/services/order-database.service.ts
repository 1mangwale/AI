import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * Order Status Cache Entry
 */
interface OrderCache {
  orderId: number;
  status: string;
  deliveryManId?: number;
  deliveryManName?: string;
  deliveryManPhone?: string;
  deliveryManLocation?: { lat: number; lng: number };
  eta?: number;
  updatedAt: Date;
  storeName?: string;
  totalAmount?: number;
  paymentStatus?: string;
}

/**
 * OrderDatabaseService - Direct MySQL READ-ONLY fallback for order queries
 * 
 * PURPOSE:
 * 1. Fallback when PHP API is unavailable
 * 2. Fast order status lookups from Redis cache
 * 3. Real-time order info for Voice/WhatsApp quick responses
 * 
 * ARCHITECTURE:
 * - Primary: Redis Cache (< 100ms) - updated by webhooks
 * - Fallback 1: PHP API (if available)
 * - Fallback 2: Direct MySQL (read-only)
 */
@Injectable()
export class OrderDatabaseService {
  private readonly logger = new Logger(OrderDatabaseService.name);
  private pool: mysql.Pool | null = null;
  private readonly CACHE_TTL = 300; // 5 minutes cache
  private readonly CACHE_PREFIX = 'order:status:';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private configService: ConfigService,
  ) {
    this.initializeMysql();
  }

  private async initializeMysql() {
    // Initialize MySQL Read-Only Connection
    try {
      const host = process.env.PHP_DB_HOST || this.configService.get('php.database.host') || '127.0.0.1';
      const port = parseInt(process.env.PHP_DB_PORT || this.configService.get('php.database.port') || '23306');
      const user = process.env.PHP_DB_READ_USER || process.env.PHP_DB_USER || 'mangwale_user';
      const password = process.env.PHP_DB_READ_PASSWORD || process.env.PHP_DB_PASSWORD;
      const database = process.env.PHP_DB_NAME || 'mangwale_db';

      if (!password) {
        throw new Error('PHP_DB_PASSWORD or PHP_DB_READ_PASSWORD environment variable is required');
      }

      this.pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 5, // Lower limit for read-only fallback
        queueLimit: 0,
      });

      this.logger.log(`✅ OrderDatabaseService MySQL initialized (READ-ONLY): ${host}:${port}/${database}`);
    } catch (error) {
      this.logger.warn(`⚠️ MySQL connection failed - order fallback disabled: ${error.message}`);
    }

    this.logger.log('✅ OrderDatabaseService initialized with shared Redis');
  }

  /**
   * Get order status with fallback chain:
   * 1. Redis Cache (fastest)
   * 2. Direct MySQL (fallback)
   */
  async getOrderStatus(orderId: number): Promise<OrderCache | null> {
    // Try Redis cache first
    const cached = await this.getFromCache(orderId);
    if (cached) {
      this.logger.debug(`✅ Order #${orderId} found in cache`);
      return cached;
    }

    // Fallback to direct MySQL
    const dbResult = await this.getFromDatabase(orderId);
    if (dbResult) {
      // Cache for next time
      await this.setCache(orderId, dbResult);
      return dbResult;
    }

    return null;
  }

  /**
   * Get order status by phone number (for voice/WhatsApp quick lookup)
   */
  async getLatestOrderByPhone(phone: string): Promise<OrderCache | null> {
    if (!this.pool) return null;

    try {
      // Normalize phone
      const normalizedPhone = phone.replace(/[\s\-\+]/g, '');
      const phoneVariants = [
        phone,
        normalizedPhone,
        normalizedPhone.replace(/^91/, ''),
      ];

      const [rows] = await this.pool.query(`
        SELECT 
          o.id as order_id,
          o.order_status as status,
          o.delivery_charge,
          o.order_amount,
          o.total_amount,
          o.payment_status,
          o.created_at,
          o.updated_at,
          o.delivery_man_id,
          s.name as store_name,
          dm.f_name as dm_first_name,
          dm.l_name as dm_last_name,
          dm.phone as dm_phone
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        LEFT JOIN delivery_men dm ON o.delivery_man_id = dm.id
        WHERE o.user_id IN (
          SELECT id FROM users WHERE phone IN (?, ?, ?)
        )
        ORDER BY o.created_at DESC
        LIMIT 1
      `, phoneVariants);

      if (Array.isArray(rows) && rows.length > 0) {
        const order = rows[0] as any;
        return {
          orderId: order.order_id,
          status: order.status,
          deliveryManId: order.delivery_man_id,
          deliveryManName: order.dm_first_name ? `${order.dm_first_name} ${order.dm_last_name || ''}`.trim() : undefined,
          deliveryManPhone: order.dm_phone,
          storeName: order.store_name,
          totalAmount: parseFloat(order.total_amount),
          paymentStatus: order.payment_status,
          updatedAt: new Date(order.updated_at),
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`❌ Failed to get order by phone: ${error.message}`);
      return null;
    }
  }

  /**
   * Get active orders for a user (for voice quick response)
   */
  async getActiveOrdersByPhone(phone: string): Promise<OrderCache[]> {
    if (!this.pool) return [];

    try {
      const normalizedPhone = phone.replace(/[\s\-\+]/g, '');
      const phoneVariants = [phone, normalizedPhone, normalizedPhone.replace(/^91/, '')];

      const [rows] = await this.pool.query(`
        SELECT 
          o.id as order_id,
          o.order_status as status,
          o.total_amount,
          o.payment_status,
          o.updated_at,
          s.name as store_name,
          dm.f_name as dm_first_name,
          dm.l_name as dm_last_name,
          dm.phone as dm_phone
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        LEFT JOIN delivery_men dm ON o.delivery_man_id = dm.id
        WHERE o.user_id IN (
          SELECT id FROM users WHERE phone IN (?, ?, ?)
        )
        AND o.order_status NOT IN ('delivered', 'canceled', 'refunded', 'failed')
        ORDER BY o.created_at DESC
        LIMIT 5
      `, phoneVariants);

      return (rows as any[]).map(order => ({
        orderId: order.order_id,
        status: order.status,
        storeName: order.store_name,
        totalAmount: parseFloat(order.total_amount),
        paymentStatus: order.payment_status,
        deliveryManName: order.dm_first_name ? `${order.dm_first_name} ${order.dm_last_name || ''}`.trim() : undefined,
        deliveryManPhone: order.dm_phone,
        updatedAt: new Date(order.updated_at),
      }));
    } catch (error) {
      this.logger.error(`❌ Failed to get active orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Update order cache (called from webhook)
   */
  async updateCache(orderId: number, data: Partial<OrderCache>): Promise<void> {
    const existing = await this.getFromCache(orderId) || { orderId, updatedAt: new Date() } as OrderCache;
    const updated = { ...existing, ...data, orderId, updatedAt: new Date() };
    await this.setCache(orderId, updated);
    this.logger.log(`✅ Order #${orderId} cache updated: ${data.status || 'no status change'}`);
  }

  /**
   * Update delivery man location (for real-time tracking)
   */
  async updateDeliveryLocation(orderId: number, lat: number, lng: number): Promise<void> {
    await this.updateCache(orderId, {
      deliveryManLocation: { lat, lng },
    });
  }

  // ========================================
  // Private Methods
  // ========================================

  private async getFromCache(orderId: number): Promise<OrderCache | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(`${this.CACHE_PREFIX}${orderId}`);
      if (data) {
        return JSON.parse(data);
      }
    } catch (error) {
      this.logger.error(`Redis get error: ${error.message}`);
    }
    return null;
  }

  private async setCache(orderId: number, data: OrderCache): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.setex(
        `${this.CACHE_PREFIX}${orderId}`,
        this.CACHE_TTL,
        JSON.stringify(data)
      );
    } catch (error) {
      this.logger.error(`Redis set error: ${error.message}`);
    }
  }

  private async getFromDatabase(orderId: number): Promise<OrderCache | null> {
    if (!this.pool) return null;

    try {
      const [rows] = await this.pool.query(`
        SELECT 
          o.id as order_id,
          o.order_status as status,
          o.delivery_charge,
          o.order_amount,
          o.total_amount,
          o.payment_status,
          o.created_at,
          o.updated_at,
          o.delivery_man_id,
          o.processing_time,
          s.name as store_name,
          dm.f_name as dm_first_name,
          dm.l_name as dm_last_name,
          dm.phone as dm_phone
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        LEFT JOIN delivery_men dm ON o.delivery_man_id = dm.id
        WHERE o.id = ?
        LIMIT 1
      `, [orderId]);

      if (Array.isArray(rows) && rows.length > 0) {
        const order = rows[0] as any;
        return {
          orderId: order.order_id,
          status: order.status,
          deliveryManId: order.delivery_man_id,
          deliveryManName: order.dm_first_name ? `${order.dm_first_name} ${order.dm_last_name || ''}`.trim() : undefined,
          deliveryManPhone: order.dm_phone,
          storeName: order.store_name,
          totalAmount: parseFloat(order.total_amount),
          paymentStatus: order.payment_status,
          eta: order.processing_time,
          updatedAt: new Date(order.updated_at),
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`❌ Database query failed for order #${orderId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get human-readable status
   */
  getStatusMessage(status: string, storeName?: string, deliveryManName?: string): string {
    const statusMessages: Record<string, string> = {
      pending: `Order received, waiting for ${storeName || 'restaurant'} to confirm.`,
      confirmed: `${storeName || 'Restaurant'} confirmed your order and will start preparing soon.`,
      processing: `${storeName || 'Restaurant'} is preparing your order now.`,
      handover: `Your order is ready! ${deliveryManName ? `${deliveryManName} will pick it up soon.` : 'Waiting for delivery partner.'}`,
      picked_up: `${deliveryManName || 'Delivery partner'} has picked up your order and is on the way!`,
      delivered: `Your order has been delivered. Enjoy your meal! 🎉`,
      canceled: `This order was canceled.`,
      refunded: `Refund has been processed for this order.`,
      failed: `Order could not be processed. Please try again.`,
    };

    return statusMessages[status] || `Order status: ${status}`;
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<{ mysql: boolean; redis: boolean }> {
    let mysqlOk = false;
    let redisOk = false;

    if (this.pool) {
      try {
        await this.pool.query('SELECT 1');
        mysqlOk = true;
      } catch (e) {
        this.logger.error(`MySQL health check failed: ${e.message}`);
      }
    }

    if (this.redis) {
      try {
        await this.redis.ping();
        redisOk = true;
      } catch (e) {
        this.logger.error(`Redis health check failed: ${e.message}`);
      }
    }

    return { mysql: mysqlOk, redis: redisOk };
  }

  async onModuleDestroy() {
    if (this.pool) await this.pool.end();
    // Redis cleanup handled by RedisModule
  }
}
