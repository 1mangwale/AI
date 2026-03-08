/**
 * Rider Profile Service
 * 
 * Manages delivery rider profiles in PostgreSQL
 * Syncs from PHP backend and enriches with performance + external platform data
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as mysql from 'mysql2/promise';

export interface RiderProfile {
  id: string;                     // PostgreSQL UUID
  phpRiderId: number;             // PHP/MySQL rider ID (deliveryman_id)
  name: string;
  phone: string;
  email?: string;
  vehicleType: string;
  vehicleNumber?: string;
  isActive: boolean;
  zoneIds?: number[];
  performanceMetrics?: RiderPerformance;
  externalPlatforms?: ExternalPlatformProfile[];
  profileImage?: string;
}

export interface RiderPerformance {
  totalDeliveries: number;
  avgDeliveryTime: number;      // minutes
  avgRating: number;
  positiveRatings: number;
  negativeRatings: number;
  completionRate: number;
  monthlyEarnings: number;
  activeHours: number;
  lastDeliveryAt?: Date;
}

export interface ExternalPlatformProfile {
  platform: 'zomato' | 'swiggy' | 'dunzo';
  externalId?: string;
  rating?: number;
  deliveryCount?: number;
  isActive: boolean;
  lastSyncedAt?: Date;
}

@Injectable()
export class RiderProfileService implements OnModuleInit {
  private readonly logger = new Logger(RiderProfileService.name);
  private readonly phpBackendUrl: string;
  private mysqlPool: mysql.Pool;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.phpBackendUrl = this.configService.get('PHP_BACKEND_URL');
    
    // Initialize MySQL pool for direct rider queries
    const mysqlHost = this.configService.get('MYSQL_HOST');
    const mysqlPort = parseInt(this.configService.get('MYSQL_PORT', '3306'));
    const mysqlUser = this.configService.get('MYSQL_USERNAME') || this.configService.get('MYSQL_USER', 'root');
    const mysqlPassword = this.configService.get('MYSQL_PASSWORD');
    const mysqlDatabase = this.configService.get('MYSQL_DATABASE', 'mangwale_db');
    
    if (!mysqlHost || !mysqlPassword) {
      throw new Error('MYSQL_HOST and MYSQL_PASSWORD are required environment variables');
    }
    
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
  }

  async onModuleInit() {
    this.logger.log('🏍️ RiderProfileService initialized');
    this.logger.log(`   MySQL: ${this.configService.get('MYSQL_HOST')}`);
  }

  /**
   * Sync rider profile from MySQL to PostgreSQL
   */
  async syncRiderFromPhp(phpRiderId: number): Promise<RiderProfile | null> {
    try {
      this.logger.log(`📥 Syncing rider from MySQL: ${phpRiderId}`);

      // Fetch rider details from MySQL
      const [rows] = await this.mysqlPool.execute(`
        SELECT 
          dm.id as rider_id,
          dm.f_name,
          dm.l_name,
          dm.email,
          dm.phone,
          dm.image,
          dm.active,
          dm.vehicle_id
        FROM delivery_men dm
        WHERE dm.id = ?
        LIMIT 1
      `, [phpRiderId]);

      const riderRows = rows as any[];
      if (!riderRows || riderRows.length === 0) {
        this.logger.warn(`Rider not found in MySQL: ${phpRiderId}`);
        return null;
      }

      const phpRider = riderRows[0];
      this.logger.log(`📥 Found rider: ${phpRider.f_name} ${phpRider.l_name}`);

      // Upsert rider profile to PostgreSQL
      const result = await this.prisma.$queryRaw<any[]>`
        INSERT INTO rider_profiles (
          php_rider_id,
          first_name,
          last_name,
          phone,
          email,
          vehicle_type,
          is_active,
          preferred_zones,
          avatar_url
        ) VALUES (
          ${phpRiderId}::INTEGER,
          ${phpRider.f_name || ''}::VARCHAR,
          ${phpRider.l_name || ''}::VARCHAR,
          ${phpRider.phone || ''}::VARCHAR,
          ${phpRider.email || null}::VARCHAR,
          ${phpRider.vehicle_id ? 'bike' : 'bike'}::VARCHAR,
          ${phpRider.active === 1}::BOOLEAN,
          '{}'::INTEGER[],
          ${phpRider.image || null}::TEXT
        )
        ON CONFLICT (php_rider_id)
        DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          vehicle_type = EXCLUDED.vehicle_type,
          is_active = EXCLUDED.is_active,
          avatar_url = EXCLUDED.avatar_url,
          updated_at = NOW()
        RETURNING *
      `;

      const rider = result[0];
      this.logger.log(`✅ Synced rider: ${rider.first_name} ${rider.last_name} (${rider.id})`);

      return this.mapRiderRow(rider);
    } catch (error) {
      this.logger.error(`Failed to sync rider ${phpRiderId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get rider profile by PHP ID
   */
  async getRiderByPhpId(phpRiderId: number): Promise<RiderProfile | null> {
    const riders = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM rider_profiles WHERE php_rider_id = ${phpRiderId}
    `;

    if (riders.length === 0) {
      // Try to sync from PHP first
      return this.syncRiderFromPhp(phpRiderId);
    }

    return this.mapRiderRow(riders[0]);
  }

  /**
   * Get rider profile by phone number
   */
  async getRiderByPhone(phone: string): Promise<RiderProfile | null> {
    const riders = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM rider_profiles WHERE phone = ${phone}
    `;

    if (riders.length === 0) {
      return null;
    }

    return this.mapRiderRow(riders[0]);
  }

  /**
   * Update rider performance metrics
   */
  async updatePerformanceMetrics(
    phpRiderId: number,
    metrics: Partial<RiderPerformance>
  ): Promise<void> {
    const rider = await this.getRiderByPhpId(phpRiderId);
    if (!rider) {
      this.logger.warn(`Cannot update metrics - rider not found: ${phpRiderId}`);
      return;
    }

    await this.prisma.$queryRaw`
      UPDATE rider_profiles
      SET
        total_deliveries = COALESCE(${metrics.totalDeliveries}::INTEGER, total_deliveries),
        avg_delivery_time = COALESCE(${metrics.avgDeliveryTime}::INTEGER, avg_delivery_time),
        avg_rating = COALESCE(${metrics.avgRating}::DECIMAL, avg_rating),
        positive_ratings = COALESCE(${metrics.positiveRatings}::INTEGER, positive_ratings),
        negative_ratings = COALESCE(${metrics.negativeRatings}::INTEGER, negative_ratings),
        completion_rate = COALESCE(${metrics.completionRate}::DECIMAL, completion_rate),
        monthly_earnings = COALESCE(${metrics.monthlyEarnings}::DECIMAL, monthly_earnings),
        active_hours = COALESCE(${metrics.activeHours}::INTEGER, active_hours),
        last_delivery_at = COALESCE(${metrics.lastDeliveryAt}::TIMESTAMP, last_delivery_at),
        updated_at = NOW()
      WHERE php_rider_id = ${phpRiderId}
    `;

    this.logger.log(`📊 Updated performance metrics for rider ${phpRiderId}`);
  }

  /**
   * Update external platform profile for rider
   * (e.g., if they also work for Zomato/Swiggy)
   */
  async updateExternalPlatform(
    phpRiderId: number,
    platform: ExternalPlatformProfile
  ): Promise<void> {
    const rider = await this.getRiderByPhpId(phpRiderId);
    if (!rider) {
      this.logger.warn(`Cannot update external platform - rider not found: ${phpRiderId}`);
      return;
    }

    // Merge with existing platforms
    const existingPlatforms = rider.externalPlatforms || [];
    const platformIndex = existingPlatforms.findIndex(p => p.platform === platform.platform);
    
    if (platformIndex >= 0) {
      existingPlatforms[platformIndex] = {
        ...existingPlatforms[platformIndex],
        ...platform,
        lastSyncedAt: new Date(),
      };
    } else {
      existingPlatforms.push({
        ...platform,
        lastSyncedAt: new Date(),
      });
    }

    await this.prisma.$queryRaw`
      UPDATE rider_profiles
      SET
        external_platforms = ${JSON.stringify(existingPlatforms)}::JSONB,
        updated_at = NOW()
      WHERE php_rider_id = ${phpRiderId}
    `;

    this.logger.log(`📱 Updated ${platform.platform} profile for rider ${phpRiderId}`);
  }

  /**
   * Get rider performance view
   */
  async getRiderPerformance(phpRiderId: number): Promise<any> {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_rider_performance WHERE php_rider_id = ${phpRiderId}
    `;

    return result[0] || null;
  }

  /**
   * Get active riders in zone
   */
  async getActiveRidersInZone(zoneId: number): Promise<RiderProfile[]> {
    const riders = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM rider_profiles 
      WHERE is_active = true 
      AND ${zoneId} = ANY(zone_ids)
      ORDER BY avg_rating DESC NULLS LAST
    `;

    return riders.map(r => this.mapRiderRow(r));
  }

  /**
   * Get all active riders
   */
  async getActiveRiders(): Promise<RiderProfile[]> {
    const riders = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM rider_profiles 
      WHERE is_active = true
      ORDER BY total_deliveries DESC NULLS LAST
    `;

    return riders.map(r => this.mapRiderRow(r));
  }

  /**
   * Get top performers by metric
   */
  async getTopPerformers(
    metric: 'rating' | 'deliveries' | 'speed',
    limit: number = 10
  ): Promise<RiderProfile[]> {
    // Whitelist ORDER BY clauses to prevent SQL injection
    const ALLOWED_ORDER_BY: Record<string, string> = {
      'rating': 'avg_rating DESC NULLS LAST',
      'deliveries': 'total_deliveries DESC NULLS LAST',
      'speed': 'avg_delivery_time ASC NULLS LAST',
    };

    const orderBy = Prisma.raw(ALLOWED_ORDER_BY[metric] || ALLOWED_ORDER_BY['rating']);

    const riders = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM rider_profiles
      WHERE is_active = true
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;

    return riders.map(r => this.mapRiderRow(r));
  }

  /**
   * Handle rider login - sync profile
   */
  async onRiderLogin(phpRiderId: number): Promise<RiderProfile | null> {
    this.logger.log(`🔐 Rider login: ${phpRiderId}`);
    
    // Sync rider profile on login
    const profile = await this.syncRiderFromPhp(phpRiderId);
    
    if (profile) {
      // Update last login time
      await this.prisma.$queryRaw`
        UPDATE rider_profiles
        SET updated_at = NOW()
        WHERE php_rider_id = ${phpRiderId}
      `;
    }

    return profile;
  }

  private mapRiderRow(row: any): RiderProfile {
    return {
      id: row.id,
      phpRiderId: row.php_rider_id,
      name: ((row.first_name || '') + ' ' + (row.last_name || '')).trim(),
      phone: row.phone,
      email: row.email,
      vehicleType: row.vehicle_type,
      vehicleNumber: row.vehicle_number,
      isActive: row.is_active,
      zoneIds: row.preferred_zones || [],
      performanceMetrics: {
        totalDeliveries: row.total_deliveries || 0,
        avgDeliveryTime: row.avg_delivery_time || 0,
        avgRating: parseFloat(row.avg_rating || '0'),
        positiveRatings: row.total_ratings || 0,
        negativeRatings: 0,
        completionRate: parseFloat(row.on_time_delivery_rate || '0'),
        monthlyEarnings: parseFloat(row.current_week_earnings || '0'),
        activeHours: 0,
        lastDeliveryAt: row.last_online_at,
      },
      externalPlatforms: row.external_platforms || [],
      profileImage: row.avatar_url,
    };
  }
}
