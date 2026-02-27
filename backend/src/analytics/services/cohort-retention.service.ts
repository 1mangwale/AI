import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

export interface CohortData {
  cohort: string; // 'YYYY-MM'
  totalUsers: number;
  retentionByMonth: { [month: number]: number }; // month 0..12 → % retained
}

@Injectable()
export class CohortRetentionService implements OnModuleInit {
  private readonly logger = new Logger(CohortRetentionService.name);
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

    try {
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
      this.logger.log('✅ CohortRetentionService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Get cohort retention data
   */
  async getCohortRetention(months: number = 6): Promise<CohortData[]> {
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
          WHERE o.order_status = 'delivered'
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
      `, [months]) as any;

      return (rows || []).map((r: any) => {
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
      this.logger.error(`getCohortRetention failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get aggregate retention curve across all cohorts
   */
  async getRetentionCurve(): Promise<Array<{ month: number; retentionPct: number }>> {
    try {
      const cohorts = await this.getCohortRetention(12);
      if (cohorts.length === 0) return [];

      const monthKeys = [0, 1, 2, 3, 6, 12];
      return monthKeys.map(month => {
        const values = cohorts
          .map(c => c.retentionByMonth[month])
          .filter(v => v !== undefined && v > 0);
        const avg = values.length > 0 ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : 0;
        return { month, retentionPct: avg };
      });
    } catch (error: any) {
      this.logger.error(`getRetentionCurve failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Compute and cache cohort data in PG for faster reads
   */
  async computeCohorts(): Promise<{ computed: number; errors: number }> {
    let computed = 0, errors = 0;
    try {
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
          COALESCE(SUM(o.order_amount), 0) as total_spend,
          MAX(o.created_at) as last_order
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id AND o.order_status = 'delivered'
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
        } catch { errors++; }
      }

      this.logger.log(`Cohort computation: ${computed} computed, ${errors} errors`);
    } catch (error: any) {
      this.logger.error(`computeCohorts failed: ${error.message}`);
    }
    return { computed, errors };
  }
}
