import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

@Injectable()
export class ComplaintPatternService implements OnModuleInit {
  private readonly logger = new Logger(ComplaintPatternService.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  private readonly COMPLAINT_TYPES = [
    'late_delivery', 'wrong_item', 'missing_item', 'cold_food',
    'rude_rider', 'payment_issue', 'quality_issue', 'packaging_issue',
  ];

  private readonly COMPLAINT_KEYWORDS: Record<string, string[]> = {
    late_delivery: ['late', 'delay', 'slow', 'waiting', 'took long', 'time'],
    wrong_item: ['wrong', 'incorrect', 'different', 'not what', 'mistake'],
    missing_item: ['missing', 'not included', 'forgot', 'incomplete', 'short'],
    cold_food: ['cold', 'not hot', 'lukewarm', 'stale', 'not fresh'],
    rude_rider: ['rude', 'behaviour', 'behavior', 'attitude', 'rider issue', 'unprofessional'],
    payment_issue: ['payment', 'charge', 'refund', 'overcharged', 'amount', 'money'],
    quality_issue: ['quality', 'taste', 'bad', 'spoiled', 'undercooked', 'raw'],
    packaging_issue: ['packaging', 'spill', 'leaked', 'damaged', 'broken', 'crushed'],
  };

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
        CREATE TABLE IF NOT EXISTS complaint_patterns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id INTEGER NOT NULL,
          store_name VARCHAR(255),
          complaint_type VARCHAR(50) NOT NULL,
          count INTEGER DEFAULT 1,
          severity VARCHAR(20) DEFAULT 'medium',
          sample_messages JSONB DEFAULT '[]',
          first_seen TIMESTAMP DEFAULT NOW(),
          last_seen TIMESTAMP DEFAULT NOW(),
          resolved BOOLEAN DEFAULT false,
          notes TEXT,
          UNIQUE(store_id, complaint_type)
        );
        CREATE INDEX IF NOT EXISTS idx_complaint_store ON complaint_patterns(store_id);
        CREATE INDEX IF NOT EXISTS idx_complaint_type ON complaint_patterns(complaint_type);
        CREATE INDEX IF NOT EXISTS idx_complaint_resolved ON complaint_patterns(resolved);
      `);
      client.release();
      this.logger.log('ComplaintPatternService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async analyzeComplaints(days: number = 30): Promise<{ processed: number; patterns: number }> {
    try {
      // Query cancelled orders and orders with complaint-related notes from MySQL
      const [rows] = await this.mysqlPool.query(`
        SELECT
          o.id as order_id,
          o.store_id,
          s.name as store_name,
          o.order_status as status,
          o.cancel_reason,
          o.notes,
          o.created_at
        FROM orders o
        LEFT JOIN stores s ON o.store_id = s.id
        WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND (
            o.order_status = 'canceled'
            OR o.notes IS NOT NULL
            OR o.cancel_reason IS NOT NULL
          )
        ORDER BY o.created_at DESC
      `, [days]) as any;

      let processed = 0;
      const patternMap = new Map<string, {
        storeId: number;
        storeName: string;
        complaintType: string;
        count: number;
        messages: string[];
      }>();

      for (const row of rows) {
        const text = [row.cancel_reason, row.notes].filter(Boolean).join(' ').toLowerCase();
        if (!text) continue;

        for (const [type, keywords] of Object.entries(this.COMPLAINT_KEYWORDS)) {
          const matched = keywords.some(kw => text.includes(kw));
          if (!matched) continue;

          const key = `${row.store_id}:${type}`;
          const existing = patternMap.get(key);

          if (existing) {
            existing.count++;
            if (existing.messages.length < 5) {
              existing.messages.push(text.substring(0, 200));
            }
          } else {
            patternMap.set(key, {
              storeId: row.store_id,
              storeName: row.store_name || 'Unknown',
              complaintType: type,
              count: 1,
              messages: [text.substring(0, 200)],
            });
          }
          processed++;
        }
      }

      // Upsert patterns into PG
      for (const pattern of patternMap.values()) {
        const severity = pattern.count >= 10 ? 'high' : pattern.count >= 5 ? 'medium' : 'low';

        await this.pgPool.query(`
          INSERT INTO complaint_patterns (store_id, store_name, complaint_type, count, severity, sample_messages, last_seen)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (store_id, complaint_type) DO UPDATE SET
            store_name = EXCLUDED.store_name,
            count = complaint_patterns.count + EXCLUDED.count,
            severity = EXCLUDED.severity,
            sample_messages = EXCLUDED.sample_messages,
            last_seen = NOW()
        `, [
          pattern.storeId,
          pattern.storeName,
          pattern.complaintType,
          pattern.count,
          severity,
          JSON.stringify(pattern.messages),
        ]);
      }

      this.logger.log(`Analyzed complaints: ${processed} processed, ${patternMap.size} patterns`);
      return { processed, patterns: patternMap.size };
    } catch (error: any) {
      this.logger.error(`analyzeComplaints failed: ${error.message}`);
      return { processed: 0, patterns: 0 };
    }
  }

  async getComplaintsByStore(storeId: number): Promise<any[]> {
    try {
      const result = await this.pgPool.query(
        `SELECT * FROM complaint_patterns WHERE store_id = $1 ORDER BY count DESC`,
        [storeId],
      );
      return result.rows;
    } catch (error: any) {
      this.logger.error(`getComplaintsByStore failed: ${error.message}`);
      return [];
    }
  }

  async getTopComplaintStores(limit: number = 20): Promise<any[]> {
    try {
      const result = await this.pgPool.query(`
        SELECT
          store_id,
          store_name,
          SUM(count) as total_complaints,
          COUNT(*) as complaint_types,
          ARRAY_AGG(complaint_type ORDER BY count DESC) as types,
          MAX(last_seen) as last_complaint
        FROM complaint_patterns
        WHERE resolved = false
        GROUP BY store_id, store_name
        ORDER BY total_complaints DESC
        LIMIT $1
      `, [limit]);
      return result.rows;
    } catch (error: any) {
      this.logger.error(`getTopComplaintStores failed: ${error.message}`);
      return [];
    }
  }

  async getComplaintTrends(days: number = 30): Promise<any[]> {
    try {
      const result = await this.pgPool.query(`
        SELECT
          complaint_type,
          SUM(count) as total,
          COUNT(DISTINCT store_id) as stores_affected,
          SUM(CASE WHEN resolved = false THEN count ELSE 0 END) as unresolved,
          AVG(count) as avg_per_store
        FROM complaint_patterns
        WHERE last_seen >= NOW() - INTERVAL '1 day' * $1
        GROUP BY complaint_type
        ORDER BY total DESC
      `, [days]);
      return result.rows;
    } catch (error: any) {
      this.logger.error(`getComplaintTrends failed: ${error.message}`);
      return [];
    }
  }

  async getComplaintOverview(): Promise<{
    totalComplaints: number;
    byType: Record<string, number>;
    topStores: any[];
    unresolvedCount: number;
  }> {
    try {
      const [totalRes, typeRes, topStores, unresolvedRes] = await Promise.all([
        this.pgPool.query(`SELECT SUM(count) as total FROM complaint_patterns`),
        this.pgPool.query(`SELECT complaint_type, SUM(count) as total FROM complaint_patterns GROUP BY complaint_type ORDER BY total DESC`),
        this.getTopComplaintStores(5),
        this.pgPool.query(`SELECT COUNT(*) as count FROM complaint_patterns WHERE resolved = false`),
      ]);

      const byType: Record<string, number> = {};
      for (const row of typeRes.rows) {
        byType[row.complaint_type] = parseInt(row.total);
      }

      return {
        totalComplaints: parseInt(totalRes.rows[0]?.total) || 0,
        byType,
        topStores,
        unresolvedCount: parseInt(unresolvedRes.rows[0].count),
      };
    } catch (error: any) {
      this.logger.error(`getComplaintOverview failed: ${error.message}`);
      return { totalComplaints: 0, byType: {}, topStores: [], unresolvedCount: 0 };
    }
  }

  async resolveComplaint(id: string, notes?: string): Promise<any> {
    try {
      const result = await this.pgPool.query(
        `UPDATE complaint_patterns SET resolved = true, notes = COALESCE($2, notes) WHERE id = $1 RETURNING *`,
        [id, notes || null],
      );
      return result.rows[0] || null;
    } catch (error: any) {
      this.logger.error(`resolveComplaint failed: ${error.message}`);
      throw error;
    }
  }
}
