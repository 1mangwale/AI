import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * Unit Economics Service
 *
 * Tracks key business metrics: GMV, revenue, AOV, CAC, LTV
 */
@Injectable()
export class UnitEconomicsService implements OnModuleInit {
  private readonly logger = new Logger(UnitEconomicsService.name);
  private mysqlPool: mysql.Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.mysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'mangwale_user',
      password: this.config.get('PHP_DB_PASSWORD') || '',
      database: this.config.get('PHP_DB_NAME') || 'mangwale_db',
      connectionLimit: 5,
      connectTimeout: 10000,
    });
    this.logger.log('UnitEconomicsService initialized');
  }

  /**
   * Get daily unit economics for The Vitals dashboard
   */
  async getDailyMetrics(date: string): Promise<{
    gmv: number;
    totalOrders: number;
    completedOrders: number;
    avgOrderValue: number;
    activeUsers: number;
    newUsers: number;
    repeatUsers: number;
    repeatRate: number;
    avgDeliveryTimeMins: number;
    revenueEstimate: number;
  }> {
    try {
      // Core order metrics
      const [orderRows] = await this.mysqlPool.query(`
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN order_status = 'delivered' THEN order_amount ELSE 0 END) as gmv,
          AVG(CASE WHEN order_status = 'delivered' THEN order_amount END) as avg_order_value,
          AVG(CASE WHEN order_status = 'delivered'
              THEN TIMESTAMPDIFF(MINUTE, created_at, delivered) END) as avg_delivery_time,
          COUNT(DISTINCT user_id) as active_users
        FROM orders
        WHERE DATE(created_at) = ?
      `, [date]) as any;

      const stats = orderRows[0] || {};

      // New vs repeat users
      const [userRows] = await this.mysqlPool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN prev_orders.cnt IS NULL OR prev_orders.cnt = 0 THEN o.user_id END) as new_users,
          COUNT(DISTINCT CASE WHEN prev_orders.cnt > 0 THEN o.user_id END) as repeat_users
        FROM orders o
        LEFT JOIN (
          SELECT user_id, COUNT(*) as cnt
          FROM orders
          WHERE DATE(created_at) < ?
            AND order_status = 'delivered'
          GROUP BY user_id
        ) prev_orders ON o.user_id = prev_orders.user_id
        WHERE DATE(o.created_at) = ?
          AND o.order_status = 'delivered'
      `, [date, date]) as any;

      const users = userRows[0] || {};
      const activeUsers = parseInt(stats.active_users) || 0;
      const repeatUsers = parseInt(users.repeat_users) || 0;

      return {
        gmv: Math.round((parseFloat(stats.gmv) || 0) * 100) / 100,
        totalOrders: parseInt(stats.total_orders) || 0,
        completedOrders: parseInt(stats.completed) || 0,
        avgOrderValue: Math.round((parseFloat(stats.avg_order_value) || 0) * 100) / 100,
        activeUsers,
        newUsers: parseInt(users.new_users) || 0,
        repeatUsers,
        repeatRate: activeUsers > 0 ? Math.round((repeatUsers / activeUsers) * 100) : 0,
        avgDeliveryTimeMins: Math.round(parseFloat(stats.avg_delivery_time) || 0),
        revenueEstimate: Math.round((parseFloat(stats.gmv) || 0) * 0.15 * 100) / 100, // ~15% commission estimate
      };
    } catch (error: any) {
      this.logger.error(`getDailyMetrics failed: ${error.message}`);
      return {
        gmv: 0, totalOrders: 0, completedOrders: 0, avgOrderValue: 0,
        activeUsers: 0, newUsers: 0, repeatUsers: 0, repeatRate: 0,
        avgDeliveryTimeMins: 0, revenueEstimate: 0,
      };
    }
  }

  /**
   * Get weekly revenue trend
   */
  async getRevenueTrend(days: number = 7): Promise<Array<{ date: string; gmv: number; orders: number; aov: number }>> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          DATE(created_at) as date,
          SUM(CASE WHEN order_status = 'delivered' THEN order_amount ELSE 0 END) as gmv,
          COUNT(CASE WHEN order_status = 'delivered' THEN 1 END) as orders,
          AVG(CASE WHEN order_status = 'delivered' THEN order_amount END) as aov
        FROM orders
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)
        ORDER BY date
      `, [days]) as any;

      return (rows || []).map((r: any) => ({
        date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
        gmv: Math.round((parseFloat(r.gmv) || 0) * 100) / 100,
        orders: parseInt(r.orders) || 0,
        aov: Math.round((parseFloat(r.aov) || 0) * 100) / 100,
      }));
    } catch (error: any) {
      this.logger.error(`getRevenueTrend failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get monthly comparison
   */
  async getMonthlyComparison(months: number = 3): Promise<Array<{
    month: string;
    gmv: number;
    orders: number;
    avgOrderValue: number;
    uniqueCustomers: number;
    newCustomers: number;
  }>> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m') as month,
          SUM(CASE WHEN order_status = 'delivered' THEN order_amount ELSE 0 END) as gmv,
          COUNT(CASE WHEN order_status = 'delivered' THEN 1 END) as orders,
          AVG(CASE WHEN order_status = 'delivered' THEN order_amount END) as avg_value,
          COUNT(DISTINCT user_id) as unique_customers
        FROM orders
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY month
      `, [months]) as any;

      return (rows || []).map((r: any) => ({
        month: r.month,
        gmv: Math.round(parseFloat(r.gmv) || 0),
        orders: parseInt(r.orders) || 0,
        avgOrderValue: Math.round(parseFloat(r.avg_value) || 0),
        uniqueCustomers: parseInt(r.unique_customers) || 0,
        newCustomers: 0, // Would need more complex query
      }));
    } catch (error: any) {
      this.logger.error(`getMonthlyComparison failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get active rider count for today
   */
  async getActiveRiderCount(date: string): Promise<number> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT COUNT(DISTINCT delivery_man_id) as active_riders
        FROM orders
        WHERE DATE(created_at) = ?
          AND delivery_man_id IS NOT NULL
          AND order_status IN ('delivered', 'picked_up', 'accepted', 'confirmed')
      `, [date]) as any;
      return parseInt(rows[0]?.active_riders) || 0;
    } catch (error: any) {
      this.logger.error(`getActiveRiderCount failed: ${error.message}`);
      return 0;
    }
  }
}
