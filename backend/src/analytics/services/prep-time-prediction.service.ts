import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

/**
 * Prep Time Prediction Service
 *
 * Per-restaurant rolling average prep times for accurate ETAs.
 * Reads order lifecycle data from PHP MySQL, caches computed
 * predictions in PG for fast lookups.
 */
@Injectable()
export class PrepTimePredictionService implements OnModuleInit {
  private readonly logger = new Logger(PrepTimePredictionService.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    // PostgreSQL for cached predictions
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
        CREATE TABLE IF NOT EXISTS prep_time_predictions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id INTEGER NOT NULL,
          store_name VARCHAR(255),
          item_category VARCHAR(100) DEFAULT 'all',
          avg_prep_time DECIMAL(8,2),
          p90_prep_time DECIMAL(8,2),
          sample_count INTEGER DEFAULT 0,
          last_order_date DATE,
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(store_id, item_category)
        );
        CREATE INDEX IF NOT EXISTS idx_prep_store ON prep_time_predictions(store_id);
      `);
      client.release();
      this.logger.log('PrepTimePredictionService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Get prep time estimate for a store (from cached PG data).
   */
  async getPrepTimeEstimate(storeId: number, itemCategory?: string): Promise<{
    avgPrepTime: number;
    p90PrepTime: number;
    sampleCount: number;
    confidence: 'high' | 'medium' | 'low' | 'none';
  }> {
    try {
      const category = itemCategory || 'all';
      const result = await this.pgPool.query(
        `SELECT avg_prep_time, p90_prep_time, sample_count
         FROM prep_time_predictions
         WHERE store_id = $1 AND item_category = $2`,
        [storeId, category],
      );

      if (result.rows.length === 0) {
        // Fall back to 'all' category if specific category not found
        if (category !== 'all') {
          return this.getPrepTimeEstimate(storeId, 'all');
        }
        return { avgPrepTime: 0, p90PrepTime: 0, sampleCount: 0, confidence: 'none' };
      }

      const row = result.rows[0];
      const sampleCount = parseInt(row.sample_count) || 0;

      return {
        avgPrepTime: Math.round(parseFloat(row.avg_prep_time) || 0),
        p90PrepTime: Math.round(parseFloat(row.p90_prep_time) || 0),
        sampleCount,
        confidence: this.classifyConfidence(sampleCount),
      };
    } catch (error: any) {
      this.logger.error(`getPrepTimeEstimate failed: ${error.message}`);
      return { avgPrepTime: 0, p90PrepTime: 0, sampleCount: 0, confidence: 'none' };
    }
  }

  /**
   * Detailed prep time breakdown by category for a store.
   */
  async getStorePerformance(storeId: number): Promise<Array<{
    itemCategory: string;
    avgPrepTime: number;
    p90PrepTime: number;
    sampleCount: number;
    lastOrderDate: string | null;
  }>> {
    try {
      const result = await this.pgPool.query(
        `SELECT item_category, avg_prep_time, p90_prep_time, sample_count, last_order_date
         FROM prep_time_predictions
         WHERE store_id = $1
         ORDER BY sample_count DESC`,
        [storeId],
      );

      return result.rows.map((r: any) => ({
        itemCategory: r.item_category,
        avgPrepTime: Math.round(parseFloat(r.avg_prep_time) || 0),
        p90PrepTime: Math.round(parseFloat(r.p90_prep_time) || 0),
        sampleCount: parseInt(r.sample_count) || 0,
        lastOrderDate: r.last_order_date
          ? new Date(r.last_order_date).toISOString().split('T')[0]
          : null,
      }));
    } catch (error: any) {
      this.logger.error(`getStorePerformance failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Batch compute prep times for all stores from last 30 days.
   * Queries MySQL, computes avg and p90, upserts into PG.
   */
  async computePrepTimes(): Promise<{ storesUpdated: number; errors: number }> {
    let storesUpdated = 0;
    let errors = 0;

    try {
      // Fetch delivered orders with prep time from MySQL
      const [rows] = await this.mysqlPool.query(`
        SELECT
          o.store_id,
          s.name as store_name,
          TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) as prep_time,
          DATE(o.created_at) as order_date
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        WHERE o.order_status = 'delivered'
          AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND o.accepted_at IS NOT NULL
          AND TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) > 0
          AND TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) < 120
        ORDER BY o.store_id
      `) as any;

      if (!rows || rows.length === 0) {
        this.logger.warn('No delivered orders found for prep time computation');
        return { storesUpdated: 0, errors: 0 };
      }

      // Group by store
      const storeData = new Map<number, {
        storeName: string;
        prepTimes: number[];
        lastOrderDate: string;
      }>();

      for (const row of rows) {
        const storeId = row.store_id;
        const prepTime = parseFloat(row.prep_time);
        if (isNaN(prepTime) || prepTime <= 0) continue;

        if (!storeData.has(storeId)) {
          storeData.set(storeId, {
            storeName: row.store_name || `Store ${storeId}`,
            prepTimes: [],
            lastOrderDate: '',
          });
        }

        const data = storeData.get(storeId)!;
        data.prepTimes.push(prepTime);
        const orderDate = row.order_date instanceof Date
          ? row.order_date.toISOString().split('T')[0]
          : String(row.order_date);
        if (orderDate > data.lastOrderDate) {
          data.lastOrderDate = orderDate;
        }
      }

      // Compute stats and upsert into PG
      const client = await this.pgPool.connect();
      try {
        for (const [storeId, data] of storeData) {
          try {
            const sorted = data.prepTimes.slice().sort((a, b) => a - b);
            const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
            const p90Index = Math.floor(sorted.length * 0.9);
            const p90 = sorted[Math.min(p90Index, sorted.length - 1)];

            await client.query(
              `INSERT INTO prep_time_predictions
                 (store_id, store_name, item_category, avg_prep_time, p90_prep_time, sample_count, last_order_date, updated_at)
               VALUES ($1, $2, 'all', $3, $4, $5, $6, NOW())
               ON CONFLICT (store_id, item_category) DO UPDATE SET
                 store_name = EXCLUDED.store_name,
                 avg_prep_time = EXCLUDED.avg_prep_time,
                 p90_prep_time = EXCLUDED.p90_prep_time,
                 sample_count = EXCLUDED.sample_count,
                 last_order_date = EXCLUDED.last_order_date,
                 updated_at = NOW()`,
              [storeId, data.storeName, avg.toFixed(2), p90.toFixed(2), sorted.length, data.lastOrderDate],
            );

            storesUpdated++;
          } catch (err: any) {
            this.logger.error(`Failed to upsert store ${storeId}: ${err.message}`);
            errors++;
          }
        }
      } finally {
        client.release();
      }

      this.logger.log(`computePrepTimes complete: ${storesUpdated} stores updated, ${errors} errors`);
    } catch (error: any) {
      this.logger.error(`computePrepTimes failed: ${error.message}`);
    }

    return { storesUpdated, errors };
  }

  /**
   * Stores with avg prep time above threshold (slow kitchens).
   */
  async getSlowKitchens(threshold: number = 20): Promise<Array<{
    storeId: number;
    storeName: string;
    avgPrepTime: number;
    p90PrepTime: number;
    sampleCount: number;
    rank: number;
  }>> {
    try {
      const result = await this.pgPool.query(
        `SELECT store_id, store_name, avg_prep_time, p90_prep_time, sample_count,
                ROW_NUMBER() OVER (ORDER BY avg_prep_time DESC) as rank
         FROM prep_time_predictions
         WHERE item_category = 'all'
           AND avg_prep_time > $1
           AND sample_count >= 3
         ORDER BY avg_prep_time DESC`,
        [threshold],
      );

      return result.rows.map((r: any) => ({
        storeId: r.store_id,
        storeName: r.store_name || 'Unknown',
        avgPrepTime: Math.round(parseFloat(r.avg_prep_time) || 0),
        p90PrepTime: Math.round(parseFloat(r.p90_prep_time) || 0),
        sampleCount: parseInt(r.sample_count) || 0,
        rank: parseInt(r.rank),
      }));
    } catch (error: any) {
      this.logger.error(`getSlowKitchens failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Platform-wide prep time statistics.
   */
  async getOverallStats(): Promise<{
    avgPrepTime: number;
    medianPrepTime: number;
    p90PrepTime: number;
    totalStores: number;
    slowKitchenCount: number;
  }> {
    try {
      const result = await this.pgPool.query(`
        SELECT
          AVG(avg_prep_time) as platform_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY avg_prep_time) as median_prep,
          PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY avg_prep_time) as p90_prep,
          COUNT(*) as total_stores,
          SUM(CASE WHEN avg_prep_time > 20 THEN 1 ELSE 0 END) as slow_count
        FROM prep_time_predictions
        WHERE item_category = 'all'
          AND sample_count >= 3
      `);

      const row = result.rows[0] || {};

      return {
        avgPrepTime: Math.round(parseFloat(row.platform_avg) || 0),
        medianPrepTime: Math.round(parseFloat(row.median_prep) || 0),
        p90PrepTime: Math.round(parseFloat(row.p90_prep) || 0),
        totalStores: parseInt(row.total_stores) || 0,
        slowKitchenCount: parseInt(row.slow_count) || 0,
      };
    } catch (error: any) {
      this.logger.error(`getOverallStats failed: ${error.message}`);
      return { avgPrepTime: 0, medianPrepTime: 0, p90PrepTime: 0, totalStores: 0, slowKitchenCount: 0 };
    }
  }

  private classifyConfidence(sampleCount: number): 'high' | 'medium' | 'low' | 'none' {
    if (sampleCount >= 30) return 'high';
    if (sampleCount >= 10) return 'medium';
    if (sampleCount >= 1) return 'low';
    return 'none';
  }
}
