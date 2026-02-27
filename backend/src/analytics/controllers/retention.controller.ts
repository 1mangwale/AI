import { Controller, Get, Post, Query, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

interface CohortRow {
  signup_cohort: string;
  total_users: string;
  month_0: string;
  month_1: string;
  month_2: string;
  month_3: string;
  month_6: string;
  month_12: string;
}

interface CohortData {
  cohort: string;
  totalUsers: number;
  retentionByMonth: Record<number, number>;
}

interface RetentionOverview {
  reorderSuggestionsSent: number;
  reorderSentToday: number;
  refundsProcessed: number;
  refundAmount: number;
  avgRefundAmount: number;
  cohortCount: number;
  timingDistribution: Array<{ timeOfDay: string; userCount: number; percentage: number }>;
}

interface RefundStats {
  totalRefunds: number;
  totalAmount: number;
  avgAmount: number;
  autoApproved: number;
  manualApproved: number;
  byReason: Array<{ reason: string; count: number; totalAmount: number }>;
}

interface TimingStats {
  distribution: Array<{ timeOfDay: string; userCount: number; percentage: number }>;
  totalUsers: number;
}

interface ReorderStats {
  totalSent: number;
  sentToday: number;
  pendingToday: number;
  topItems: Array<{ itemName: string; storeName: string; count: number }>;
  recentSuggestions: Array<{
    userId: number;
    itemName: string;
    storeName: string;
    daysSince: number;
    sentAt: string;
  }>;
}

@Controller('mos/retention')
export class RetentionController implements OnModuleInit {
  private readonly logger = new Logger(RetentionController.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pgPool = new Pool({ connectionString: databaseUrl, max: 5 });

    this.mysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'mangwale_user',
      password: this.config.get('PHP_DB_PASSWORD') || '',
      database: this.config.get('PHP_DB_NAME') || 'mangwale_db',
      connectionLimit: 5,
    });

    this.logger.log('RetentionController initialized');
  }

  /**
   * Aggregate overview: reorder stats, refund stats, cohort count, timing distribution
   */
  @Get('overview')
  async getOverview(): Promise<RetentionOverview> {
    try {
      const [reorderStats, refundStats, cohortCount, timingStats] = await Promise.all([
        this.getReorderStatsInternal(),
        this.getRefundStatsInternal(),
        this.getCohortCountInternal(),
        this.getTimingStatsInternal(),
      ]);

      return {
        reorderSuggestionsSent: reorderStats.totalSent,
        reorderSentToday: reorderStats.sentToday,
        refundsProcessed: refundStats.totalRefunds,
        refundAmount: refundStats.totalAmount,
        avgRefundAmount: refundStats.avgAmount,
        cohortCount,
        timingDistribution: timingStats.distribution,
      };
    } catch (error: any) {
      this.logger.error(`getOverview failed: ${error.message}`);
      return {
        reorderSuggestionsSent: 0,
        reorderSentToday: 0,
        refundsProcessed: 0,
        refundAmount: 0,
        avgRefundAmount: 0,
        cohortCount: 0,
        timingDistribution: [],
      };
    }
  }

  /**
   * Cohort retention data from MySQL orders + users
   */
  @Get('cohorts')
  async getCohorts(@Query('months') months?: string): Promise<CohortData[]> {
    const monthCount = months ? parseInt(months) : 6;
    try {
      const [rows] = await this.mysqlPool.query(`
        WITH user_signups AS (
          SELECT
            id as user_id,
            DATE_FORMAT(created_at, '%Y-%m') as signup_cohort,
            created_at as signup_date
          FROM users
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
        ),
        cohort_orders AS (
          SELECT
            us.signup_cohort,
            us.user_id,
            PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(us.signup_date, '%Y%m')) as months_since
          FROM user_signups us
          JOIN orders o ON us.user_id = o.user_id
          WHERE o.status = 'delivered'
        )
        SELECT
          signup_cohort,
          COUNT(DISTINCT user_id) as total_users,
          COUNT(DISTINCT CASE WHEN months_since = 0 THEN user_id END) as month_0,
          COUNT(DISTINCT CASE WHEN months_since = 1 THEN user_id END) as month_1,
          COUNT(DISTINCT CASE WHEN months_since = 2 THEN user_id END) as month_2,
          COUNT(DISTINCT CASE WHEN months_since = 3 THEN user_id END) as month_3,
          COUNT(DISTINCT CASE WHEN months_since BETWEEN 4 AND 6 THEN user_id END) as month_6,
          COUNT(DISTINCT CASE WHEN months_since BETWEEN 7 AND 12 THEN user_id END) as month_12
        FROM (
          SELECT DISTINCT signup_cohort, user_id FROM user_signups
        ) base
        LEFT JOIN cohort_orders co USING (signup_cohort, user_id)
        GROUP BY signup_cohort
        ORDER BY signup_cohort DESC
      `, [monthCount]) as any;

      return (rows || []).map((r: CohortRow) => {
        const total = parseInt(r.total_users) || 1;
        return {
          cohort: r.signup_cohort,
          totalUsers: total,
          retentionByMonth: {
            0: Math.round(((parseInt(r.month_0) || 0) / total) * 100),
            1: Math.round(((parseInt(r.month_1) || 0) / total) * 100),
            2: Math.round(((parseInt(r.month_2) || 0) / total) * 100),
            3: Math.round(((parseInt(r.month_3) || 0) / total) * 100),
            6: Math.round(((parseInt(r.month_6) || 0) / total) * 100),
            12: Math.round(((parseInt(r.month_12) || 0) / total) * 100),
          },
        };
      });
    } catch (error: any) {
      this.logger.error(`getCohorts failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Aggregate retention curve across all cohorts
   */
  @Get('retention-curve')
  async getRetentionCurve(): Promise<Array<{ month: number; retentionPct: number }>> {
    try {
      const cohorts = await this.getCohorts('12');
      if (cohorts.length === 0) return [];

      const monthKeys = [0, 1, 2, 3, 6, 12];
      return monthKeys.map(month => {
        const values = cohorts
          .map(c => c.retentionByMonth[month])
          .filter(v => v !== undefined && v > 0);
        const avg = values.length > 0
          ? Math.round(values.reduce((s, v) => s + v, 0) / values.length)
          : 0;
        return { month, retentionPct: avg };
      });
    } catch (error: any) {
      this.logger.error(`getRetentionCurve failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Reorder suggestion stats from PG reorder_suggestions table
   */
  @Get('reorder-stats')
  async getReorderStats(): Promise<ReorderStats> {
    try {
      return await this.getReorderStatsInternal();
    } catch (error: any) {
      this.logger.error(`getReorderStats failed: ${error.message}`);
      return { totalSent: 0, sentToday: 0, pendingToday: 0, topItems: [], recentSuggestions: [] };
    }
  }

  /**
   * Auto-refund stats from PG auto_refund_log table
   */
  @Get('refund-stats')
  async getRefundStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<RefundStats> {
    try {
      return await this.getRefundStatsInternal(startDate, endDate);
    } catch (error: any) {
      this.logger.error(`getRefundStats failed: ${error.message}`);
      return { totalRefunds: 0, totalAmount: 0, avgAmount: 0, autoApproved: 0, manualApproved: 0, byReason: [] };
    }
  }

  /**
   * Notification timing distribution from MySQL orders (peak order hours)
   */
  @Get('timing-stats')
  async getTimingStats(): Promise<TimingStats> {
    try {
      return await this.getTimingStatsInternal();
    } catch (error: any) {
      this.logger.error(`getTimingStats failed: ${error.message}`);
      return { distribution: [], totalUsers: 0 };
    }
  }

  /**
   * Trigger cohort computation — pulls from MySQL, caches in PG
   */
  @Post('compute-cohorts')
  async computeCohorts(): Promise<{ computed: number; errors: number }> {
    let computed = 0;
    let errors = 0;

    try {
      // Ensure table exists
      const client = await this.pgPool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS customer_cohorts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id INTEGER NOT NULL,
          signup_cohort VARCHAR(7) NOT NULL,
          signup_date DATE,
          orders_month_0 INTEGER DEFAULT 0,
          orders_month_1 INTEGER DEFAULT 0,
          orders_month_2 INTEGER DEFAULT 0,
          orders_month_3 INTEGER DEFAULT 0,
          orders_month_6 INTEGER DEFAULT 0,
          orders_month_12 INTEGER DEFAULT 0,
          total_orders INTEGER DEFAULT 0,
          total_spend DECIMAL(10,2) DEFAULT 0,
          last_order_date DATE,
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cohort_signup ON customer_cohorts(signup_cohort);
        CREATE INDEX IF NOT EXISTS idx_cohort_user ON customer_cohorts(user_id);
      `);
      client.release();

      const [rows] = await this.mysqlPool.query(`
        SELECT
          u.id as user_id,
          DATE_FORMAT(u.created_at, '%Y-%m') as signup_cohort,
          DATE(u.created_at) as signup_date,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) = 0 THEN 1 END) as m0,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) = 1 THEN 1 END) as m1,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) = 2 THEN 1 END) as m2,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) = 3 THEN 1 END) as m3,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) BETWEEN 4 AND 6 THEN 1 END) as m6,
          COUNT(CASE WHEN PERIOD_DIFF(DATE_FORMAT(o.created_at, '%Y%m'), DATE_FORMAT(u.created_at, '%Y%m')) BETWEEN 7 AND 12 THEN 1 END) as m12,
          COUNT(o.id) as total_orders,
          COALESCE(SUM(o.total), 0) as total_spend,
          MAX(o.created_at) as last_order
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'delivered'
        WHERE u.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
        GROUP BY u.id, DATE_FORMAT(u.created_at, '%Y-%m'), DATE(u.created_at)
      `) as any;

      for (const r of rows) {
        try {
          await this.pgPool.query(`
            INSERT INTO customer_cohorts (user_id, signup_cohort, signup_date, orders_month_0, orders_month_1, orders_month_2, orders_month_3, orders_month_6, orders_month_12, total_orders, total_spend, last_order_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              orders_month_0 = $4, orders_month_1 = $5, orders_month_2 = $6, orders_month_3 = $7,
              orders_month_6 = $8, orders_month_12 = $9, total_orders = $10, total_spend = $11,
              last_order_date = $12, updated_at = NOW()
          `, [r.user_id, r.signup_cohort, r.signup_date, r.m0, r.m1, r.m2, r.m3, r.m6, r.m12, r.total_orders, r.total_spend, r.last_order]);
          computed++;
        } catch {
          errors++;
        }
      }

      this.logger.log(`Cohort computation: ${computed} computed, ${errors} errors`);
    } catch (error: any) {
      this.logger.error(`computeCohorts failed: ${error.message}`);
    }

    return { computed, errors };
  }

  // ---- Internal helpers ----

  private async getReorderStatsInternal(): Promise<ReorderStats> {
    const [statsResult, topItemsResult, recentResult] = await Promise.all([
      this.pgPool.query(`
        SELECT
          COUNT(*) as total_sent,
          COUNT(CASE WHEN DATE(sent_at) = CURRENT_DATE THEN 1 END) as sent_today,
          COUNT(CASE WHEN status = 'pending' AND DATE(next_suggested_at) = CURRENT_DATE THEN 1 END) as pending_today
        FROM reorder_suggestions
      `).catch(() => ({ rows: [{}] })),
      this.pgPool.query(`
        SELECT item_name, store_name, COUNT(*) as cnt
        FROM reorder_suggestions
        WHERE sent_at IS NOT NULL
        GROUP BY item_name, store_name
        ORDER BY cnt DESC
        LIMIT 10
      `).catch(() => ({ rows: [] })),
      this.pgPool.query(`
        SELECT user_id, item_name, store_name,
               EXTRACT(DAY FROM NOW() - last_ordered_at)::INTEGER as days_since,
               sent_at
        FROM reorder_suggestions
        WHERE sent_at IS NOT NULL
        ORDER BY sent_at DESC
        LIMIT 20
      `).catch(() => ({ rows: [] })),
    ]);

    const stats = statsResult.rows[0] || {};
    return {
      totalSent: parseInt(stats.total_sent) || 0,
      sentToday: parseInt(stats.sent_today) || 0,
      pendingToday: parseInt(stats.pending_today) || 0,
      topItems: (topItemsResult.rows || []).map((r: any) => ({
        itemName: r.item_name || 'Unknown',
        storeName: r.store_name || 'Unknown',
        count: parseInt(r.cnt) || 0,
      })),
      recentSuggestions: (recentResult.rows || []).map((r: any) => ({
        userId: r.user_id,
        itemName: r.item_name || 'Unknown',
        storeName: r.store_name || 'Unknown',
        daysSince: parseInt(r.days_since) || 0,
        sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : '',
      })),
    };
  }

  private async getRefundStatsInternal(startDate?: string, endDate?: string): Promise<RefundStats> {
    const dateFilter = startDate && endDate
      ? `WHERE created_at >= $1 AND created_at <= $2`
      : `WHERE created_at >= NOW() - INTERVAL '30 days'`;
    const params = startDate && endDate ? [startDate, endDate] : [];

    const [statsResult, reasonResult] = await Promise.all([
      this.pgPool.query(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(amount), 0) as total_amount,
          COALESCE(AVG(amount), 0) as avg_amount,
          SUM(CASE WHEN auto_approved THEN 1 ELSE 0 END) as auto_count,
          SUM(CASE WHEN NOT auto_approved THEN 1 ELSE 0 END) as manual_count
        FROM auto_refund_log ${dateFilter}
      `, params).catch(() => ({ rows: [{}] })),
      this.pgPool.query(`
        SELECT reason, COUNT(*) as count, SUM(amount) as total_amount
        FROM auto_refund_log ${dateFilter}
        GROUP BY reason
        ORDER BY count DESC
      `, params).catch(() => ({ rows: [] })),
    ]);

    const stats = statsResult.rows[0] || {};
    return {
      totalRefunds: parseInt(stats.total) || 0,
      totalAmount: Math.round(parseFloat(stats.total_amount) || 0),
      avgAmount: Math.round(parseFloat(stats.avg_amount) || 0),
      autoApproved: parseInt(stats.auto_count) || 0,
      manualApproved: parseInt(stats.manual_count) || 0,
      byReason: (reasonResult.rows || []).map((r: any) => ({
        reason: r.reason,
        count: parseInt(r.count),
        totalAmount: Math.round(parseFloat(r.total_amount) || 0),
      })),
    };
  }

  private async getTimingStatsInternal(): Promise<TimingStats> {
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT
          CASE
            WHEN peak_hour >= 5 AND peak_hour < 12 THEN 'morning'
            WHEN peak_hour >= 12 AND peak_hour < 17 THEN 'afternoon'
            WHEN peak_hour >= 17 AND peak_hour < 21 THEN 'evening'
            ELSE 'night'
          END as time_of_day,
          COUNT(*) as user_count
        FROM (
          SELECT user_id, HOUR(created_at) as peak_hour, COUNT(*) as cnt,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) as rn
          FROM orders
          WHERE status = 'delivered' AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
          GROUP BY user_id, HOUR(created_at)
        ) sub
        WHERE rn = 1
        GROUP BY time_of_day
      `) as any;

      const total = rows.reduce((s: number, r: any) => s + parseInt(r.user_count), 0) || 1;
      return {
        distribution: (rows || []).map((r: any) => ({
          timeOfDay: r.time_of_day,
          userCount: parseInt(r.user_count),
          percentage: Math.round((parseInt(r.user_count) / total) * 100),
        })),
        totalUsers: total,
      };
    } catch (error: any) {
      this.logger.error(`getTimingStatsInternal failed: ${error.message}`);
      return { distribution: [], totalUsers: 0 };
    }
  }

  private async getCohortCountInternal(): Promise<number> {
    try {
      const result = await this.pgPool.query(
        `SELECT COUNT(DISTINCT signup_cohort) as cnt FROM customer_cohorts`,
      );
      return parseInt(result.rows[0]?.cnt) || 0;
    } catch {
      // Table may not exist yet
      return 0;
    }
  }
}
