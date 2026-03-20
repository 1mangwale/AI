import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import {
  BusinessMetricsDaily,
  TopPerformer,
  BusinessMilestone,
} from '../interfaces/content-factory.interfaces';

const MODULE_NAMES: Record<number, string> = { 3: 'parcel', 4: 'food', 5: 'shop' };

@Injectable()
export class DataSyncService implements OnModuleInit {
  private readonly logger = new Logger(DataSyncService.name);
  private pool: Pool;
  private mysqlPool: mysql.Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    // PostgreSQL connection
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    // MySQL connection (PHP backend — readonly)
    const mysqlHost = this.config.get('PHP_MYSQL_HOST') || '103.160.107.208';
    const mysqlPort = parseInt(this.config.get('PHP_MYSQL_PORT') || '3307', 10);
    const mysqlUser = this.config.get('PHP_MYSQL_USER') || 'mangwale_readonly';
    const mysqlPassword = this.config.get('PHP_MYSQL_PASSWORD') || '';
    const mysqlDatabase = this.config.get('PHP_MYSQL_DATABASE') || 'mangwale';

    try {
      this.mysqlPool = mysql.createPool({
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
      });
      this.logger.log(`MySQL pool created (${mysqlHost}:${mysqlPort}/${mysqlDatabase})`);
    } catch (error: any) {
      this.logger.warn(`MySQL connection failed — sync disabled: ${error.message}`);
      this.mysqlPool = null;
    }

    // Create PostgreSQL tables
    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS business_metrics_daily (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          metrics_date DATE NOT NULL UNIQUE,
          total_orders INTEGER DEFAULT 0,
          total_revenue DECIMAL(12,2) DEFAULT 0,
          avg_order_value DECIMAL(10,2) DEFAULT 0,
          new_users INTEGER DEFAULT 0,
          active_stores INTEGER DEFAULT 0,
          orders_by_module JSONB DEFAULT '{}',
          additional_metrics JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_date ON business_metrics_daily(metrics_date DESC);

        CREATE TABLE IF NOT EXISTS top_performers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          category VARCHAR(50) NOT NULL,
          performer_id VARCHAR(100),
          performer_name VARCHAR(300) NOT NULL,
          metric_value DECIMAL(12,2) NOT NULL,
          metric_label VARCHAR(100) NOT NULL,
          period VARCHAR(30) NOT NULL DEFAULT 'weekly',
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_top_perf_category ON top_performers(category);
        CREATE INDEX IF NOT EXISTS idx_top_perf_created ON top_performers(created_at DESC);

        CREATE TABLE IF NOT EXISTS business_milestones (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          milestone_type VARCHAR(50) NOT NULL,
          title VARCHAR(300) NOT NULL,
          description TEXT,
          metric_value DECIMAL(12,2),
          status VARCHAR(30) DEFAULT 'detected',
          content_piece_id UUID,
          detected_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_milestones_type ON business_milestones(milestone_type);
      `);
      client.release();
      this.logger.log('DataSyncService initialized — tables ready');
    } catch (error: any) {
      this.logger.error(`Failed to initialize tables: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync daily metrics from MySQL → PostgreSQL
  // ---------------------------------------------------------------------------

  async syncDailyMetrics(date?: string): Promise<{ metricsDate: string; totalOrders: number }> {
    const metricsDate = date || this.yesterday();

    if (!this.mysqlPool) {
      this.logger.warn('MySQL not available — returning empty metrics');
      return { metricsDate, totalOrders: 0 };
    }

    try {
      // Orders summary
      const [orderRows] = await this.mysqlPool.query(
        `SELECT
           COUNT(*) as total_orders,
           COALESCE(SUM(total_amount), 0) as total_revenue,
           COALESCE(AVG(total_amount), 0) as avg_order_value
         FROM orders
         WHERE DATE(created_at) = ?`,
        [metricsDate],
      );
      const orderSummary = (orderRows as any[])[0] || { total_orders: 0, total_revenue: 0, avg_order_value: 0 };

      // New users
      let newUsers = 0;
      try {
        const [userRows] = await this.mysqlPool.query(
          'SELECT COUNT(*) as new_users FROM users WHERE DATE(created_at) = ?',
          [metricsDate],
        );
        newUsers = (userRows as any[])[0]?.new_users || 0;
      } catch (err: any) {
        this.logger.warn(`Could not query new users: ${err.message}`);
      }

      // Active stores
      let activeStores = 0;
      try {
        const [storeRows] = await this.mysqlPool.query(
          'SELECT COUNT(DISTINCT store_id) as active_stores FROM orders WHERE DATE(created_at) = ?',
          [metricsDate],
        );
        activeStores = (storeRows as any[])[0]?.active_stores || 0;
      } catch (err: any) {
        this.logger.warn(`Could not query active stores: ${err.message}`);
      }

      // Orders by module
      const ordersByModule: Record<string, number> = {};
      try {
        const [moduleRows] = await this.mysqlPool.query(
          'SELECT module_id, COUNT(*) as count FROM orders WHERE DATE(created_at) = ? GROUP BY module_id',
          [metricsDate],
        );
        for (const row of moduleRows as any[]) {
          const name = MODULE_NAMES[row.module_id] || `module_${row.module_id}`;
          ordersByModule[name] = row.count;
        }
      } catch (err: any) {
        this.logger.warn(`Could not query orders by module: ${err.message}`);
      }

      const totalOrders = Number(orderSummary.total_orders) || 0;
      const totalRevenue = Number(orderSummary.total_revenue) || 0;
      const avgOrderValue = Number(orderSummary.avg_order_value) || 0;

      // UPSERT into PostgreSQL
      await this.pool.query(
        `INSERT INTO business_metrics_daily
           (metrics_date, total_orders, total_revenue, avg_order_value, new_users, active_stores, orders_by_module)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (metrics_date) DO UPDATE SET
           total_orders = EXCLUDED.total_orders,
           total_revenue = EXCLUDED.total_revenue,
           avg_order_value = EXCLUDED.avg_order_value,
           new_users = EXCLUDED.new_users,
           active_stores = EXCLUDED.active_stores,
           orders_by_module = EXCLUDED.orders_by_module`,
        [metricsDate, totalOrders, totalRevenue, avgOrderValue, newUsers, activeStores, JSON.stringify(ordersByModule)],
      );

      this.logger.log(`Synced daily metrics for ${metricsDate}: ${totalOrders} orders, revenue ${totalRevenue}`);
      return { metricsDate, totalOrders };
    } catch (error: any) {
      this.logger.error(`syncDailyMetrics failed: ${error.message}`);
      return { metricsDate, totalOrders: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Sync top performers (weekly)
  // ---------------------------------------------------------------------------

  async syncTopPerformers(): Promise<{ performers: number }> {
    if (!this.mysqlPool) {
      this.logger.warn('MySQL not available — skipping top performers sync');
      return { performers: 0 };
    }

    const rows: Array<{ category: string; performerId: string | null; performerName: string; metricValue: number; metricLabel: string }> = [];

    // Top 10 stores by order count
    try {
      const [storeRows] = await this.mysqlPool.query(
        `SELECT store_id, store_name, COUNT(*) as order_count
         FROM orders JOIN stores ON orders.store_id = stores.id
         WHERE orders.created_at >= NOW() - INTERVAL 7 DAY
         GROUP BY store_id, store_name
         ORDER BY order_count DESC
         LIMIT 10`,
      );
      for (const row of storeRows as any[]) {
        rows.push({
          category: 'store',
          performerId: String(row.store_id),
          performerName: row.store_name,
          metricValue: Number(row.order_count),
          metricLabel: 'orders_7d',
        });
      }
    } catch (err: any) {
      this.logger.warn(`Could not query top stores: ${err.message}`);
    }

    // Top 10 products by quantity
    try {
      const [productRows] = await this.mysqlPool.query(
        `SELECT product_name, SUM(quantity) as total_qty
         FROM order_items
         WHERE created_at >= NOW() - INTERVAL 7 DAY
         GROUP BY product_name
         ORDER BY total_qty DESC
         LIMIT 10`,
      );
      for (const row of productRows as any[]) {
        rows.push({
          category: 'product',
          performerId: null,
          performerName: row.product_name,
          metricValue: Number(row.total_qty),
          metricLabel: 'quantity_7d',
        });
      }
    } catch (err: any) {
      this.logger.warn(`Could not query top products: ${err.message}`);
    }

    if (rows.length === 0) {
      return { performers: 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Clear old weekly performers
      await client.query(`DELETE FROM top_performers WHERE period = 'weekly'`);

      // Insert new rows
      for (const r of rows) {
        await client.query(
          `INSERT INTO top_performers (category, performer_id, performer_name, metric_value, metric_label, period)
           VALUES ($1, $2, $3, $4, $5, 'weekly')`,
          [r.category, r.performerId, r.performerName, r.metricValue, r.metricLabel],
        );
      }

      await client.query('COMMIT');
      this.logger.log(`Synced ${rows.length} top performers`);
      return { performers: rows.length };
    } catch (error: any) {
      await client.query('ROLLBACK');
      this.logger.error(`syncTopPerformers insert failed: ${error.message}`);
      return { performers: 0 };
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Detect milestones
  // ---------------------------------------------------------------------------

  async detectMilestones(): Promise<{ milestones: string[] }> {
    const milestones: string[] = [];
    const thresholds = [1000, 5000, 10000, 25000, 50000, 100000];

    try {
      // Cumulative total orders
      const cumResult = await this.pool.query(
        'SELECT COALESCE(SUM(total_orders), 0)::int as cumulative FROM business_metrics_daily',
      );
      const cumulative = cumResult.rows[0]?.cumulative || 0;

      for (const threshold of thresholds) {
        if (cumulative >= threshold) {
          // Check if already detected
          const existing = await this.pool.query(
            `SELECT id FROM business_milestones WHERE milestone_type = 'cumulative_orders' AND metric_value = $1`,
            [threshold],
          );
          if (existing.rows.length === 0) {
            const title = `Reached ${threshold.toLocaleString()} total orders!`;
            await this.pool.query(
              `INSERT INTO business_milestones (milestone_type, title, description, metric_value)
               VALUES ('cumulative_orders', $1, $2, $3)`,
              [title, `Cumulative orders crossed the ${threshold.toLocaleString()} mark.`, threshold],
            );
            milestones.push(title);
          }
        }
      }

      // Record-breaking day: yesterday vs max of previous 30 days
      const yesterdayStr = this.yesterday();
      const recordResult = await this.pool.query(
        `SELECT total_orders FROM business_metrics_daily WHERE metrics_date = $1`,
        [yesterdayStr],
      );
      const yesterdayOrders = recordResult.rows[0]?.total_orders || 0;

      if (yesterdayOrders > 0) {
        const prevMaxResult = await this.pool.query(
          `SELECT COALESCE(MAX(total_orders), 0)::int as prev_max
           FROM business_metrics_daily
           WHERE metrics_date < $1 AND metrics_date >= ($1::date - INTERVAL '30 days')`,
          [yesterdayStr],
        );
        const prevMax = prevMaxResult.rows[0]?.prev_max || 0;

        if (yesterdayOrders > prevMax && prevMax > 0) {
          const existing = await this.pool.query(
            `SELECT id FROM business_milestones WHERE milestone_type = 'record_day' AND metric_value = $1 AND detected_at::date = CURRENT_DATE`,
            [yesterdayOrders],
          );
          if (existing.rows.length === 0) {
            const title = `Record-breaking day: ${yesterdayOrders} orders on ${yesterdayStr}!`;
            await this.pool.query(
              `INSERT INTO business_milestones (milestone_type, title, description, metric_value)
               VALUES ('record_day', $1, $2, $3)`,
              [title, `Beat the previous 30-day high of ${prevMax} orders.`, yesterdayOrders],
            );
            milestones.push(title);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`detectMilestones failed: ${error.message}`);
    }

    if (milestones.length > 0) {
      this.logger.log(`Detected ${milestones.length} new milestones: ${milestones.join(', ')}`);
    }
    return { milestones };
  }

  // ---------------------------------------------------------------------------
  // Backfill metrics for a date range
  // ---------------------------------------------------------------------------

  async backfillMetrics(startDate: string, endDate: string): Promise<{ daysProcessed: number; totalOrders: number }> {
    this.logger.log(`Backfilling metrics from ${startDate} to ${endDate}`);
    let daysProcessed = 0;
    let totalOrders = 0;

    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      try {
        const result = await this.syncDailyMetrics(dateStr);
        totalOrders += result.totalOrders;
        daysProcessed++;
      } catch (error: any) {
        this.logger.warn(`Backfill failed for ${dateStr}: ${error.message}`);
      }
      current.setDate(current.getDate() + 1);
    }

    this.logger.log(`Backfill complete: ${daysProcessed} days processed, ${totalOrders} total orders`);
    return { daysProcessed, totalOrders };
  }

  // ---------------------------------------------------------------------------
  // Read helpers
  // ---------------------------------------------------------------------------

  async getLatestMetrics(): Promise<BusinessMetricsDaily | null> {
    const result = await this.pool.query(
      'SELECT * FROM business_metrics_daily ORDER BY metrics_date DESC LIMIT 1',
    );
    return result.rows[0] ? this.mapMetricsRow(result.rows[0]) : null;
  }

  async getTopPerformers(category?: string): Promise<TopPerformer[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (category) {
      conditions.push(`category = $${idx++}`);
      params.push(category);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM top_performers ${where} ORDER BY metric_value DESC LIMIT $${idx}`,
      [...params, 20],
    );
    return result.rows.map(r => this.mapPerformerRow(r));
  }

  async getRecentMilestones(limit?: number): Promise<BusinessMilestone[]> {
    const result = await this.pool.query(
      'SELECT * FROM business_milestones ORDER BY detected_at DESC LIMIT $1',
      [limit || 10],
    );
    return result.rows.map(r => this.mapMilestoneRow(r));
  }

  async getBusinessContext(): Promise<Record<string, any>> {
    const metrics = await this.getLatestMetrics();
    const performers = await this.getTopPerformers();
    const milestones = await this.getRecentMilestones(3);
    return {
      date: metrics?.metricsDate || 'unknown',
      total_orders: metrics?.totalOrders || 0,
      total_revenue: metrics?.totalRevenue || 0,
      avg_order_value: metrics?.avgOrderValue || 0,
      new_users: metrics?.newUsers || 0,
      active_stores: metrics?.activeStores || 0,
      orders_by_module: metrics?.ordersByModule || {},
      top_stores: performers.filter(p => p.category === 'store').slice(0, 3).map(p => p.performerName),
      top_products: performers.filter(p => p.category === 'product').slice(0, 3).map(p => p.performerName),
      recent_milestones: milestones.map(m => m.title),
    };
  }

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------

  private mapMetricsRow(row: any): BusinessMetricsDaily {
    return {
      id: row.id,
      metricsDate: row.metrics_date,
      totalOrders: Number(row.total_orders) || 0,
      totalRevenue: parseFloat(row.total_revenue) || 0,
      avgOrderValue: parseFloat(row.avg_order_value) || 0,
      newUsers: Number(row.new_users) || 0,
      activeStores: Number(row.active_stores) || 0,
      ordersByModule: row.orders_by_module || {},
      additionalMetrics: row.additional_metrics || {},
      createdAt: row.created_at,
    };
  }

  private mapPerformerRow(row: any): TopPerformer {
    return {
      id: row.id,
      category: row.category,
      performerId: row.performer_id,
      performerName: row.performer_name,
      metricValue: parseFloat(row.metric_value) || 0,
      metricLabel: row.metric_label,
      period: row.period,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    };
  }

  private mapMilestoneRow(row: any): BusinessMilestone {
    return {
      id: row.id,
      milestoneType: row.milestone_type,
      title: row.title,
      description: row.description,
      metricValue: row.metric_value != null ? parseFloat(row.metric_value) : null,
      status: row.status,
      contentPieceId: row.content_piece_id,
      detectedAt: row.detected_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private yesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
