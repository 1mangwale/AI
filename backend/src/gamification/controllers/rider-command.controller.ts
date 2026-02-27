import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { RiderQuestService } from '../services/rider-quest.service';
import { RiderTierService } from '../services/rider-tier.service';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';

/**
 * Rider Command Controller
 *
 * Aggregates rider-related data from multiple services and databases:
 * - Quests & Tiers from GamificationModule services (injected)
 * - Zone density/hotspots from MySQL (direct queries, same SQL as ZoneHeatMapService)
 * - Prep-time predictions from PG + MySQL (direct queries, same SQL as PrepTimePredictionService)
 *
 * This avoids complex cross-module dependency injection by querying databases
 * directly for zone and prep-time endpoints.
 */
@Controller('mos/riders')
export class RiderCommandController implements OnModuleInit {
  private readonly logger = new Logger(RiderCommandController.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(
    private readonly riderQuest: RiderQuestService,
    private readonly riderTier: RiderTierService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // PostgreSQL for prep-time predictions
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pgPool = new Pool({ connectionString: databaseUrl, max: 3 });

    // MySQL for zone/order queries
    this.mysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'mangwale_user',
      password: this.config.get('PHP_DB_PASSWORD') || '',
      database: this.config.get('PHP_DB_NAME') || 'mangwale_db',
      connectionLimit: 3,
      connectTimeout: 10000,
    });

    this.logger.log('RiderCommandController initialized (PG + MySQL pools)');
  }

  // ─── Quest endpoints ──────────────────────────────────────────────

  @Get('quests')
  async getActiveQuests() {
    return this.riderQuest.getActiveQuests();
  }

  @Get('quests/stats')
  async getDailyQuestStats(@Query('date') date?: string) {
    return this.riderQuest.getDailyQuestStats(date);
  }

  @Get('quests/leaderboard')
  async getQuestLeaderboard(
    @Query('date') date?: string,
    @Query('limit') limit: number = 10,
  ) {
    return this.riderQuest.getLeaderboard(date, +limit);
  }

  @Post('quests')
  async createQuest(@Body() body: any) {
    return this.riderQuest.createQuest(body);
  }

  @Patch('quests/:id')
  async updateQuest(@Param('id') id: string, @Body() body: any) {
    return this.riderQuest.updateQuest(id, body);
  }

  // ─── Tier endpoints ───────────────────────────────────────────────

  @Get('tiers/distribution')
  async getTierDistribution() {
    return this.riderTier.getTierDistribution();
  }

  @Get('tiers/leaderboard')
  async getTierLeaderboard(
    @Query('tier') tier?: string,
    @Query('limit') limit: number = 20,
  ) {
    return this.riderTier.getTierLeaderboard(tier, +limit);
  }

  @Post('tiers/compute')
  async computeAllTiers() {
    return this.riderTier.computeAllTiers();
  }

  // ─── Zone endpoints (direct MySQL queries) ────────────────────────

  @Get('zones/density')
  async getZoneDensity(@Query('hours') hours: number = 2) {
    try {
      const [rows] = (await this.mysqlPool.query(
        `
        SELECT
          o.zone_id,
          z.name as zone_name,
          COUNT(*) as order_count,
          AVG(CASE WHEN o.status = 'delivered'
              THEN TIMESTAMPDIFF(MINUTE, o.created_at, o.delivered_at) END) as avg_delivery_time
        FROM orders o
        LEFT JOIN zones z ON o.zone_id = z.id
        WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          AND o.status IN ('delivered', 'accepted', 'picked_up', 'pending')
          AND o.zone_id IS NOT NULL
        GROUP BY o.zone_id, z.name
        ORDER BY order_count DESC
        `,
        [+hours],
      )) as any;

      return (rows || []).map((r: any) => {
        const count = parseInt(r.order_count) || 0;
        return {
          zoneId: r.zone_id,
          zoneName: r.zone_name || `Zone ${r.zone_id}`,
          orderCount: count,
          avgDeliveryTimeMins: Math.round(
            parseFloat(r.avg_delivery_time) || 0,
          ),
          demandLevel: this.classifyDemand(count),
        };
      });
    } catch (error: any) {
      this.logger.error(`getZoneDensity failed: ${error.message}`);
      return [];
    }
  }

  @Get('zones/hotspots')
  async getZoneHotspots(@Query('limit') limit: number = 10) {
    try {
      const [rows] = (await this.mysqlPool.query(
        `
        SELECT
          o.zone_id,
          z.name as zone_name,
          COUNT(*) as order_count,
          AVG(o.total) as avg_order_value
        FROM orders o
        LEFT JOIN zones z ON o.zone_id = z.id
        WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
          AND o.zone_id IS NOT NULL
        GROUP BY o.zone_id, z.name
        ORDER BY order_count DESC
        LIMIT ?
        `,
        [+limit],
      )) as any;

      return (rows || []).map((r: any) => ({
        zoneId: r.zone_id,
        zoneName: r.zone_name || `Zone ${r.zone_id}`,
        orderCount: parseInt(r.order_count) || 0,
        avgOrderValue:
          Math.round((parseFloat(r.avg_order_value) || 0) * 100) / 100,
      }));
    } catch (error: any) {
      this.logger.error(`getZoneHotspots failed: ${error.message}`);
      return [];
    }
  }

  @Get('zones/positioning')
  async getRiderPositioning() {
    try {
      // Active riders: riders with in-progress deliveries
      const [riderRows] = (await this.mysqlPool.query(`
        SELECT
          o.zone_id,
          z.name as zone_name,
          COUNT(DISTINCT o.rider_id) as active_riders
        FROM orders o
        LEFT JOIN zones z ON o.zone_id = z.id
        WHERE o.status IN ('accepted', 'picked_up')
          AND o.rider_id IS NOT NULL
          AND o.zone_id IS NOT NULL
          AND o.created_at >= DATE_SUB(NOW(), INTERVAL 4 HOUR)
        GROUP BY o.zone_id, z.name
      `)) as any;

      // Pending orders awaiting rider assignment
      const [pendingRows] = (await this.mysqlPool.query(`
        SELECT
          o.zone_id,
          COUNT(*) as pending_orders
        FROM orders o
        WHERE o.status IN ('pending', 'accepted')
          AND (o.rider_id IS NULL OR o.status = 'pending')
          AND o.zone_id IS NOT NULL
          AND o.created_at >= DATE_SUB(NOW(), INTERVAL 4 HOUR)
        GROUP BY o.zone_id
      `)) as any;

      // Merge rider and pending data
      const zoneMap = new Map<
        number,
        {
          zoneId: number;
          zoneName: string;
          activeRiders: number;
          pendingOrders: number;
        }
      >();

      for (const row of riderRows || []) {
        zoneMap.set(row.zone_id, {
          zoneId: row.zone_id,
          zoneName: row.zone_name || `Zone ${row.zone_id}`,
          activeRiders: parseInt(row.active_riders) || 0,
          pendingOrders: 0,
        });
      }

      for (const row of pendingRows || []) {
        const existing = zoneMap.get(row.zone_id);
        if (existing) {
          existing.pendingOrders = parseInt(row.pending_orders) || 0;
        } else {
          zoneMap.set(row.zone_id, {
            zoneId: row.zone_id,
            zoneName: `Zone ${row.zone_id}`,
            activeRiders: 0,
            pendingOrders: parseInt(row.pending_orders) || 0,
          });
        }
      }

      const zones = Array.from(zoneMap.values()).map((z) => ({
        ...z,
        ridersNeeded: Math.max(0, z.pendingOrders - z.activeRiders),
      }));

      zones.sort((a, b) => b.ridersNeeded - a.ridersNeeded);

      return { zones };
    } catch (error: any) {
      this.logger.error(`getRiderPositioning failed: ${error.message}`);
      return { zones: [] };
    }
  }

  // ─── Prep-time endpoints (direct PG + MySQL queries) ──────────────

  @Get('prep-time/slow-kitchens')
  async getSlowKitchens(@Query('threshold') threshold: number = 20) {
    try {
      const result = await this.pgPool.query(
        `SELECT store_id, store_name, avg_prep_time, p90_prep_time, sample_count,
                ROW_NUMBER() OVER (ORDER BY avg_prep_time DESC) as rank
         FROM prep_time_predictions
         WHERE item_category = 'all'
           AND avg_prep_time > $1
           AND sample_count >= 3
         ORDER BY avg_prep_time DESC`,
        [+threshold],
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

  @Get('prep-time/stats')
  async getPrepTimeStats() {
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
      this.logger.error(`getPrepTimeStats failed: ${error.message}`);
      return {
        avgPrepTime: 0,
        medianPrepTime: 0,
        p90PrepTime: 0,
        totalStores: 0,
        slowKitchenCount: 0,
      };
    }
  }

  @Post('prep-time/compute')
  async computePrepTimes() {
    let storesUpdated = 0;
    let errors = 0;

    try {
      // Fetch delivered orders with prep time from MySQL
      const [rows] = (await this.mysqlPool.query(`
        SELECT
          o.store_id,
          s.name as store_name,
          TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) as prep_time,
          DATE(o.created_at) as order_date
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        WHERE o.status = 'delivered'
          AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND o.accepted_at IS NOT NULL
          AND TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) > 0
          AND TIMESTAMPDIFF(MINUTE, o.created_at, o.accepted_at) < 120
        ORDER BY o.store_id
      `)) as any;

      if (!rows || rows.length === 0) {
        this.logger.warn('No delivered orders found for prep time computation');
        return { storesUpdated: 0, errors: 0 };
      }

      // Group by store
      const storeData = new Map<
        number,
        {
          storeName: string;
          prepTimes: number[];
          lastOrderDate: string;
        }
      >();

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
        const orderDate =
          row.order_date instanceof Date
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
            const avg =
              sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
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
              [
                storeId,
                data.storeName,
                avg.toFixed(2),
                p90.toFixed(2),
                sorted.length,
                data.lastOrderDate,
              ],
            );

            storesUpdated++;
          } catch (err: any) {
            this.logger.error(
              `Failed to upsert store ${storeId}: ${err.message}`,
            );
            errors++;
          }
        }
      } finally {
        client.release();
      }

      this.logger.log(
        `computePrepTimes complete: ${storesUpdated} stores updated, ${errors} errors`,
      );
    } catch (error: any) {
      this.logger.error(`computePrepTimes failed: ${error.message}`);
    }

    return { storesUpdated, errors };
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private classifyDemand(
    orderCount: number,
  ): 'low' | 'medium' | 'high' | 'surge' {
    if (orderCount > 30) return 'surge';
    if (orderCount > 15) return 'high';
    if (orderCount >= 5) return 'medium';
    return 'low';
  }
}
