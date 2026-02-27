import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

export interface CustomerHealthScore {
  id: string;
  userId: number;
  phone: string | null;
  rfmScore: string | null;
  rfmSegment: string | null;
  churnRisk: number;
  ltvPredicted: number;
  healthScore: number;
  recencyDays: number;
  frequency90d: number;
  avgOrderValue: number;
  complaintRate: number;
  lastComputedAt: Date;
}

@Injectable()
export class CustomerHealthService implements OnModuleInit {
  private readonly logger = new Logger(CustomerHealthService.name);
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
      connectTimeout: 10000,
    });

    try {
      const client = await this.pgPool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS customer_health_scores (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id INTEGER NOT NULL,
          phone VARCHAR(50),
          rfm_score VARCHAR(10),
          rfm_segment VARCHAR(30),
          churn_risk DECIMAL(5,4) DEFAULT 0,
          ltv_predicted DECIMAL(10,2) DEFAULT 0,
          health_score INTEGER DEFAULT 50,
          recency_days INTEGER DEFAULT 0,
          frequency_90d INTEGER DEFAULT 0,
          avg_order_value DECIMAL(10,2) DEFAULT 0,
          complaint_rate DECIMAL(5,4) DEFAULT 0,
          last_computed_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_health_score ON customer_health_scores(health_score);
        CREATE INDEX IF NOT EXISTS idx_health_churn ON customer_health_scores(churn_risk);
        CREATE INDEX IF NOT EXISTS idx_health_segment ON customer_health_scores(rfm_segment);
      `);
      client.release();
      this.logger.log('CustomerHealthService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Compute health score for a single user
   */
  async computeHealthScore(userId: number): Promise<CustomerHealthScore | null> {
    try {
      // Get order stats from MySQL
      const [orderRows] = await this.mysqlPool.query(`
        SELECT
          u.id as user_id,
          u.phone as phone,
          COUNT(CASE WHEN o.order_status = 'delivered' AND o.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 END) as orders_90d,
          AVG(CASE WHEN o.order_status = 'delivered' THEN o.order_amount END) as avg_order_value,
          MAX(o.created_at) as last_order_date,
          DATEDIFF(NOW(), MAX(o.created_at)) as recency_days,
          COUNT(CASE WHEN o.order_status = 'canceled' THEN 1 END) / GREATEST(COUNT(*), 1) as cancel_rate
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE u.id = ?
        GROUP BY u.id, u.phone
      `, [userId]) as any;

      if (!orderRows[0]) return null;

      const data = orderRows[0];
      const recencyDays = parseInt(data.recency_days) || 999;
      const frequency = parseInt(data.orders_90d) || 0;
      const avgValue = parseFloat(data.avg_order_value) || 0;
      const cancelRate = parseFloat(data.cancel_rate) || 0;

      // Compute RFM scores (1-5)
      const rScore = recencyDays <= 7 ? 5 : recencyDays <= 14 ? 4 : recencyDays <= 30 ? 3 : recencyDays <= 60 ? 2 : 1;
      const fScore = frequency >= 8 ? 5 : frequency >= 4 ? 4 : frequency >= 2 ? 3 : frequency >= 1 ? 2 : 1;
      const mScore = avgValue >= 500 ? 5 : avgValue >= 300 ? 4 : avgValue >= 200 ? 3 : avgValue >= 100 ? 2 : 1;

      // Determine segment
      const rfmScore = `${rScore}${fScore}${mScore}`;
      const segment = this.determineSegment(rScore, fScore, mScore);

      // Compute churn risk (0-1, higher = more risk)
      let churnRisk = 0;
      if (recencyDays > 60) churnRisk += 0.3;
      else if (recencyDays > 30) churnRisk += 0.15;
      else if (recencyDays > 14) churnRisk += 0.05;

      if (frequency <= 1) churnRisk += 0.3;
      else if (frequency <= 2) churnRisk += 0.15;

      if (cancelRate > 0.3) churnRisk += 0.2;
      else if (cancelRate > 0.1) churnRisk += 0.1;

      churnRisk = Math.min(1, churnRisk);

      // Health score (0-100, higher = healthier)
      const healthScore = Math.round(
        (rScore * 6 + fScore * 6 + mScore * 4 + (1 - churnRisk) * 20)
      );

      // Simple LTV prediction: frequency * AOV * expected lifetime months
      const monthlyFreq = frequency / 3; // from 90 day window
      const expectedMonths = churnRisk < 0.3 ? 12 : churnRisk < 0.6 ? 6 : 3;
      const ltvPredicted = Math.round(monthlyFreq * avgValue * expectedMonths);

      // Upsert to PG
      await this.pgPool.query(`
        INSERT INTO customer_health_scores
          (user_id, phone, rfm_score, rfm_segment, churn_risk, ltv_predicted, health_score, recency_days, frequency_90d, avg_order_value, complaint_rate, last_computed_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          phone = $2, rfm_score = $3, rfm_segment = $4, churn_risk = $5, ltv_predicted = $6,
          health_score = $7, recency_days = $8, frequency_90d = $9, avg_order_value = $10,
          complaint_rate = $11, last_computed_at = NOW(), updated_at = NOW()
      `, [userId, data.phone, rfmScore, segment, churnRisk, ltvPredicted, healthScore, recencyDays, frequency, Math.round(avgValue * 100) / 100, cancelRate]);

      return {
        id: '', userId, phone: data.phone, rfmScore, rfmSegment: segment,
        churnRisk, ltvPredicted, healthScore, recencyDays, frequency90d: frequency,
        avgOrderValue: avgValue, complaintRate: cancelRate, lastComputedAt: new Date(),
      };
    } catch (error: any) {
      this.logger.error(`computeHealthScore failed for user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Batch compute for all active users
   */
  async computeAllHealthScores(): Promise<{ computed: number; errors: number }> {
    let computed = 0, errors = 0;
    try {
      const [rows] = await this.mysqlPool.query(`
        SELECT DISTINCT user_id FROM orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)
          AND user_id IS NOT NULL
      `) as any;

      for (const row of rows) {
        try {
          const result = await this.computeHealthScore(row.user_id);
          if (result) {
            computed++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }
      this.logger.log(`Computed health scores: ${computed} success, ${errors} errors`);
    } catch (error: any) {
      this.logger.error(`Batch compute failed: ${error.message}`);
    }
    return { computed, errors };
  }

  /**
   * Get paginated health score board
   */
  async getHealthScoreBoard(filters?: {
    segment?: string;
    minHealth?: number;
    maxHealth?: number;
    minChurnRisk?: number;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: CustomerHealthScore[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.segment) {
      conditions.push(`rfm_segment = $${idx++}`);
      params.push(filters.segment);
    }
    if (filters?.minHealth !== undefined) {
      conditions.push(`health_score >= $${idx++}`);
      params.push(filters.minHealth);
    }
    if (filters?.maxHealth !== undefined) {
      conditions.push(`health_score <= $${idx++}`);
      params.push(filters.maxHealth);
    }
    if (filters?.minChurnRisk !== undefined) {
      conditions.push(`churn_risk >= $${idx++}`);
      params.push(filters.minChurnRisk);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = filters?.sortBy || 'health_score';
    const sortOrder = filters?.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const allowedSorts = ['health_score', 'churn_risk', 'recency_days', 'frequency_90d', 'avg_order_value', 'ltv_predicted'];
    const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : 'health_score';

    const [itemsRes, countRes] = await Promise.all([
      this.pgPool.query(
        `SELECT * FROM customer_health_scores ${where} ORDER BY ${safeSortBy} ${sortOrder} LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset],
      ),
      this.pgPool.query(
        `SELECT COUNT(*) as total FROM customer_health_scores ${where}`,
        params,
      ),
    ]);

    return {
      items: itemsRes.rows.map(this.mapRow),
      total: parseInt(countRes.rows[0].total),
    };
  }

  /**
   * Get churn risk list
   */
  async getChurnRiskList(threshold: number = 0.5, limit: number = 20): Promise<CustomerHealthScore[]> {
    const result = await this.pgPool.query(
      `SELECT * FROM customer_health_scores WHERE churn_risk >= $1 ORDER BY churn_risk DESC LIMIT $2`,
      [threshold, limit],
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Get segment distribution
   */
  async getSegmentDistribution(): Promise<Array<{ segment: string; count: number; avgHealth: number }>> {
    const result = await this.pgPool.query(`
      SELECT rfm_segment as segment, COUNT(*) as count, AVG(health_score) as avg_health
      FROM customer_health_scores
      GROUP BY rfm_segment
      ORDER BY count DESC
    `);
    return result.rows.map(r => ({
      segment: r.segment || 'unknown',
      count: parseInt(r.count),
      avgHealth: Math.round(parseFloat(r.avg_health) || 0),
    }));
  }

  /**
   * Get health score distribution for histogram
   */
  async getHealthDistribution(): Promise<Array<{ range: string; count: number }>> {
    const result = await this.pgPool.query(`
      SELECT
        CASE
          WHEN health_score <= 20 THEN '0-20'
          WHEN health_score <= 40 THEN '21-40'
          WHEN health_score <= 60 THEN '41-60'
          WHEN health_score <= 80 THEN '61-80'
          ELSE '81-100'
        END as range,
        COUNT(*) as count
      FROM customer_health_scores
      GROUP BY 1
      ORDER BY 1
    `);
    return result.rows.map(r => ({ range: r.range, count: parseInt(r.count) }));
  }

  private determineSegment(r: number, f: number, m: number): string {
    if (r >= 4 && f >= 4 && m >= 4) return 'champion';
    if (f >= 4) return 'loyal';
    if (r >= 4 && f >= 2 && f < 4) return 'potential_loyalist';
    if (r >= 4 && f <= 2) return 'new_customer';
    if (r >= 3 && m >= 3) return 'promising';
    if (r >= 2 && r < 4 && f >= 3) return 'need_attention';
    if (r >= 2 && r < 4 && f >= 2 && f < 4) return 'about_to_sleep';
    if (r < 2 && (f >= 4 || m >= 4)) return 'at_risk';
    if (r < 3 && f < 3) return 'hibernating';
    return 'lost';
  }

  private mapRow(row: any): CustomerHealthScore {
    return {
      id: row.id,
      userId: row.user_id,
      phone: row.phone,
      rfmScore: row.rfm_score,
      rfmSegment: row.rfm_segment,
      churnRisk: parseFloat(row.churn_risk) || 0,
      ltvPredicted: parseFloat(row.ltv_predicted) || 0,
      healthScore: parseInt(row.health_score) || 0,
      recencyDays: parseInt(row.recency_days) || 0,
      frequency90d: parseInt(row.frequency_90d) || 0,
      avgOrderValue: parseFloat(row.avg_order_value) || 0,
      complaintRate: parseFloat(row.complaint_rate) || 0,
      lastComputedAt: row.last_computed_at,
    };
  }
}
