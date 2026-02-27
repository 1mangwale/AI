import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

/**
 * Order Dissection Service
 *
 * Analyzes order lifecycle timing from PHP MySQL database
 * and provides operations intelligence.
 */
@Injectable()
export class OrderDissectionService implements OnModuleInit {
  private readonly logger = new Logger(OrderDissectionService.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    // PostgreSQL for caching/aggregations
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pgPool = new Pool({ connectionString: databaseUrl, max: 5 });

    // MySQL for PHP order data
    this.mysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'mangwale_user',
      password: this.config.get('PHP_DB_PASSWORD') || '',
      database: this.config.get('PHP_DB_NAME') || 'mangwale_db',
      connectionLimit: 5,
      connectTimeout: 10000,
    });

    // Create PG cache table
    try {
      const client = await this.pgPool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS order_timing_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id INTEGER NOT NULL,
          store_id INTEGER,
          store_name VARCHAR(255),
          rider_id INTEGER,
          zone_id INTEGER,
          module_id INTEGER,
          created_at TIMESTAMP,
          accepted_at TIMESTAMP,
          prepared_at TIMESTAMP,
          picked_at TIMESTAMP,
          delivered_at TIMESTAMP,
          prep_time_mins DECIMAL(8,2),
          transit_time_mins DECIMAL(8,2),
          total_time_mins DECIMAL(8,2),
          order_total DECIMAL(10,2),
          cached_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_order_timing_store ON order_timing_events(store_id);
        CREATE INDEX IF NOT EXISTS idx_order_timing_date ON order_timing_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_order_timing_zone ON order_timing_events(zone_id);
      `);
      client.release();
      this.logger.log('OrderDissectionService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Get daily order statistics
   */
  async getDailyOrderStats(date: string, zoneId?: number): Promise<{
    totalOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    avgDeliveryTimeMins: number;
    avgPrepTimeMins: number;
    avgTransitTimeMins: number;
    totalGMV: number;
    peakHour: number;
    ordersByModule: { moduleId: number; moduleName: string; count: number }[];
  }> {
    try {
      // Query PHP MySQL for order data
      const [rows] = await this.mysqlPool.query(`
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN o.order_status = 'delivered' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN o.order_status = 'canceled' THEN 1 ELSE 0 END) as cancelled,
          AVG(TIMESTAMPDIFF(MINUTE, o.created_at, o.delivered)) as avg_delivery_time,
          AVG(TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted)) as avg_accept_time,
          SUM(o.order_amount) as total_gmv,
          HOUR(o.created_at) as order_hour
        FROM orders o
        WHERE DATE(o.created_at) = ?
          ${zoneId ? 'AND o.zone_id = ?' : ''}
        GROUP BY HOUR(o.created_at)
        ORDER BY order_hour
      `, zoneId ? [date, zoneId] : [date]) as any;

      let totalOrders = 0, completed = 0, cancelled = 0, totalGMV = 0;
      let totalDeliveryTime = 0, totalAcceptTime = 0, deliveredCount = 0;
      let peakHour = 0, peakCount = 0;

      for (const row of rows) {
        const count = parseInt(row.total_orders) || 0;
        totalOrders += count;
        completed += parseInt(row.completed) || 0;
        cancelled += parseInt(row.cancelled) || 0;
        totalGMV += parseFloat(row.total_gmv) || 0;

        if (row.avg_delivery_time) {
          totalDeliveryTime += parseFloat(row.avg_delivery_time) * count;
          deliveredCount += parseInt(row.completed) || 0;
        }
        if (row.avg_accept_time) {
          totalAcceptTime += parseFloat(row.avg_accept_time) * count;
        }

        if (count > peakCount) {
          peakCount = count;
          peakHour = parseInt(row.order_hour);
        }
      }

      // Module breakdown
      const [moduleRows] = await this.mysqlPool.query(`
        SELECT
          o.module_id,
          COUNT(*) as count
        FROM orders o
        WHERE DATE(o.created_at) = ?
          ${zoneId ? 'AND o.zone_id = ?' : ''}
        GROUP BY o.module_id
      `, zoneId ? [date, zoneId] : [date]) as any;

      const moduleNames: Record<number, string> = { 3: 'Parcel', 4: 'Food', 5: 'E-commerce' };
      const ordersByModule = (moduleRows || []).map((r: any) => ({
        moduleId: r.module_id,
        moduleName: moduleNames[r.module_id] || `Module ${r.module_id}`,
        count: parseInt(r.count),
      }));

      return {
        totalOrders,
        completedOrders: completed,
        cancelledOrders: cancelled,
        avgDeliveryTimeMins: deliveredCount > 0 ? Math.round(totalDeliveryTime / deliveredCount) : 0,
        avgPrepTimeMins: deliveredCount > 0 ? Math.round(totalAcceptTime / deliveredCount) : 0,
        avgTransitTimeMins: deliveredCount > 0 ? Math.round((totalDeliveryTime - totalAcceptTime) / deliveredCount) : 0,
        totalGMV: Math.round(totalGMV * 100) / 100,
        peakHour,
        ordersByModule,
      };
    } catch (error: any) {
      this.logger.error(`getDailyOrderStats failed: ${error.message}`);
      return {
        totalOrders: 0, completedOrders: 0, cancelledOrders: 0,
        avgDeliveryTimeMins: 0, avgPrepTimeMins: 0, avgTransitTimeMins: 0,
        totalGMV: 0, peakHour: 0, ordersByModule: [],
      };
    }
  }

  /**
   * Get hourly order volume for charts
   */
  async getHourlyOrderVolume(date: string, zoneId?: number): Promise<Array<{ hour: number; orders: number; gmv: number }>> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          HOUR(created_at) as hour,
          COUNT(*) as orders,
          SUM(order_amount) as gmv
        FROM orders
        WHERE DATE(created_at) = ?
          ${zoneId ? 'AND zone_id = ?' : ''}
        GROUP BY HOUR(created_at)
        ORDER BY hour
      `, zoneId ? [date, zoneId] : [date]) as any;

      // Fill all 24 hours
      const result = Array.from({ length: 24 }, (_, i) => ({ hour: i, orders: 0, gmv: 0 }));
      for (const row of rows) {
        const h = parseInt(row.hour);
        result[h] = { hour: h, orders: parseInt(row.orders), gmv: parseFloat(row.gmv) || 0 };
      }
      return result;
    } catch (error: any) {
      this.logger.error(`getHourlyOrderVolume failed: ${error.message}`);
      return Array.from({ length: 24 }, (_, i) => ({ hour: i, orders: 0, gmv: 0 }));
    }
  }

  /**
   * Get slow orders exceeding threshold
   */
  async getSlowOrders(date: string, thresholdMinutes: number = 45): Promise<Array<{
    orderId: number;
    storeName: string;
    totalTimeMins: number;
    prepTimeMins: number;
    transitTimeMins: number;
    orderTotal: number;
    status: string;
  }>> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          o.id as order_id,
          s.name as store_name,
          TIMESTAMPDIFF(MINUTE, o.created_at, o.delivered) as total_time,
          TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted) as prep_time,
          TIMESTAMPDIFF(MINUTE, o.accepted, o.delivered) as transit_time,
          o.order_amount as order_total,
          o.order_status as status
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        WHERE DATE(o.created_at) = ?
          AND o.order_status = 'delivered'
          AND TIMESTAMPDIFF(MINUTE, o.created_at, o.delivered) > ?
        ORDER BY total_time DESC
        LIMIT 50
      `, [date, thresholdMinutes]) as any;

      return (rows || []).map((r: any) => ({
        orderId: r.order_id,
        storeName: r.store_name || 'Unknown',
        totalTimeMins: parseInt(r.total_time) || 0,
        prepTimeMins: parseInt(r.prep_time) || 0,
        transitTimeMins: parseInt(r.transit_time) || 0,
        orderTotal: parseFloat(r.order_total) || 0,
        status: r.status,
      }));
    } catch (error: any) {
      this.logger.error(`getSlowOrders failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get store performance ranking
   */
  async getStorePerformance(date: string, limit: number = 20): Promise<Array<{
    storeId: number;
    storeName: string;
    orderCount: number;
    avgDeliveryMins: number;
    avgPrepMins: number;
    completionRate: number;
    totalRevenue: number;
  }>> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          o.store_id,
          s.name as store_name,
          COUNT(*) as order_count,
          AVG(CASE WHEN o.order_status = 'delivered'
              THEN TIMESTAMPDIFF(MINUTE, o.created_at, o.delivered) END) as avg_delivery,
          AVG(CASE WHEN o.order_status = 'delivered'
              THEN TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted) END) as avg_prep,
          SUM(CASE WHEN o.order_status = 'delivered' THEN 1 ELSE 0 END) / COUNT(*) * 100 as completion_rate,
          SUM(o.order_amount) as total_revenue
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        WHERE DATE(o.created_at) = ?
        GROUP BY o.store_id, s.name
        HAVING COUNT(*) >= 3
        ORDER BY avg_delivery ASC
        LIMIT ?
      `, [date, limit]) as any;

      return (rows || []).map((r: any) => ({
        storeId: r.store_id,
        storeName: r.store_name || 'Unknown',
        orderCount: parseInt(r.order_count),
        avgDeliveryMins: Math.round(parseFloat(r.avg_delivery) || 0),
        avgPrepMins: Math.round(parseFloat(r.avg_prep) || 0),
        completionRate: Math.round(parseFloat(r.completion_rate) || 0),
        totalRevenue: Math.round(parseFloat(r.total_revenue) || 0),
      }));
    } catch (error: any) {
      this.logger.error(`getStorePerformance failed: ${error.message}`);
      return [];
    }
  }
}
