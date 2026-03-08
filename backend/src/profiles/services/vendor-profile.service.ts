/**
 * Vendor Profile Service
 * 
 * Manages vendor profiles in PostgreSQL
 * Syncs from PHP backend and enriches with performance data
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PhpVendorAuthService, VendorUser } from '../../php-integration/services/php-vendor-auth.service';
import { StoreSyncService } from './store-sync.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as mysql from 'mysql2/promise';

export interface VendorProfile {
  id: string;                     // PostgreSQL UUID
  phpVendorId: number;            // PHP/MySQL vendor ID
  storeId?: string;               // PostgreSQL store UUID
  phpStoreId?: number;            // PHP/MySQL store ID
  storeName?: string;
  name?: string;
  phone: string;
  email?: string;
  vendorType: string;
  role: string;
  isActive: boolean;
  isPrimaryOwner: boolean;
  permissions?: Record<string, boolean>;
  performanceMetrics?: VendorPerformance;
  zoneWiseTopic?: string;
  profileImage?: string;
}

export interface VendorPerformance {
  totalOrders: number;
  avgOrderValue: number;
  avgPreparationTime: number;
  positiveRatings: number;
  negativeRatings: number;
  cancellationRate: number;
  monthlyRevenue: number;
  lastOrderAt?: Date;
}

@Injectable()
export class VendorProfileService implements OnModuleInit {
  private readonly logger = new Logger(VendorProfileService.name);
  private readonly phpBackendUrl: string;
  private mysqlPool: mysql.Pool;
  constructor(
    private readonly prisma: PrismaService,
    private readonly phpVendorAuth: PhpVendorAuthService,
    private readonly storeSyncService: StoreSyncService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.phpBackendUrl = this.configService.get('PHP_BACKEND_URL');
    
    // Initialize MySQL pool for direct vendor queries
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
    this.logger.log('👤 VendorProfileService initialized');
    this.logger.log(`   MySQL: ${this.configService.get('MYSQL_HOST')}`);
  }

  /**
   * Sync vendor profile from PHP using vendor ID (direct MySQL query)
   */
  async syncVendorFromPhp(phpVendorId: number): Promise<VendorProfile | null> {
    try {
      this.logger.log(`📥 Syncing vendor from MySQL: ${phpVendorId}`);

      // Fetch vendor details directly from MySQL
      // stores.vendor_id links to vendors.id
      const [rows] = await this.mysqlPool.execute(`
        SELECT 
          v.id as vendor_id,
          v.f_name,
          v.l_name,
          v.email,
          v.phone,
          v.image,
          v.status,
          s.id as store_id,
          s.name as store_name
        FROM vendors v
        LEFT JOIN stores s ON s.vendor_id = v.id
        WHERE v.id = ?
        LIMIT 1
      `, [phpVendorId]);

      const vendorRows = rows as any[];
      if (!vendorRows || vendorRows.length === 0) {
        this.logger.warn(`Vendor not found in MySQL: ${phpVendorId}`);
        return null;
      }

      const phpVendor = vendorRows[0];
      this.logger.log(`📥 Found vendor: ${phpVendor.f_name} ${phpVendor.l_name} (Store: ${phpVendor.store_name || 'N/A'})`);

      // Ensure store is synced first
      let storeId: string | null = null;
      if (phpVendor.store_id) {
        const store = await this.storeSyncService.getStoreByPhpId(phpVendor.store_id);
        if (!store) {
          // Sync the store first
          await this.storeSyncService.syncStoreFromPhp(phpVendor.store_id);
          const syncedStore = await this.storeSyncService.getStoreByPhpId(phpVendor.store_id);
          storeId = syncedStore?.id || null;
        } else {
          storeId = store.id;
        }
      }

      // Upsert vendor profile to PostgreSQL
      const result = await this.prisma.$queryRaw<any[]>`
        INSERT INTO vendor_profiles (
          php_vendor_id,
          store_id,
          php_store_id,
          name,
          phone,
          email,
          vendor_type,
          role,
          is_active,
          is_primary_owner,
          permissions,
          profile_image
        ) VALUES (
          ${phpVendorId}::INTEGER,
          ${storeId}::UUID,
          ${phpVendor.store_id || null}::INTEGER,
          ${(phpVendor.f_name || '') + ' ' + (phpVendor.l_name || '')}::VARCHAR,
          ${phpVendor.phone || ''}::VARCHAR,
          ${phpVendor.email || null}::VARCHAR,
          'owner'::VARCHAR,
          'owner'::VARCHAR,
          ${phpVendor.status === 1}::BOOLEAN,
          true::BOOLEAN,
          '{}'::JSONB,
          ${phpVendor.image || null}::VARCHAR
        )
        ON CONFLICT (php_vendor_id)
        DO UPDATE SET
          store_id = EXCLUDED.store_id,
          php_store_id = EXCLUDED.php_store_id,
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          vendor_type = EXCLUDED.vendor_type,
          role = EXCLUDED.role,
          is_active = EXCLUDED.is_active,
          profile_image = EXCLUDED.profile_image,
          updated_at = NOW()
        RETURNING *
      `;

      const vendor = result[0];
      this.logger.log(`✅ Synced vendor: ${vendor.name} (${vendor.id})`);

      return this.mapVendorRow(vendor);
    } catch (error) {
      this.logger.error(`Failed to sync vendor ${phpVendorId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Sync vendor profile from authenticated VendorUser
   */
  async syncFromVendorUser(vendorUser: VendorUser): Promise<VendorProfile | null> {
    try {
      this.logger.log(`📥 Syncing vendor from VendorUser: ${vendorUser.id}`);

      // Ensure store is synced first
      let storeId: string | null = null;
      if (vendorUser.storeId) {
        const store = await this.storeSyncService.getStoreByPhpId(vendorUser.storeId);
        storeId = store?.id || null;
      }

      // Upsert vendor profile to PostgreSQL
      const result = await this.prisma.$queryRaw<any[]>`
        INSERT INTO vendor_profiles (
          php_vendor_id,
          store_id,
          php_store_id,
          name,
          phone,
          email,
          vendor_type,
          role,
          is_active,
          is_primary_owner,
          zone_wise_topic
        ) VALUES (
          ${vendorUser.id}::INTEGER,
          ${storeId}::UUID,
          ${vendorUser.storeId || null}::INTEGER,
          ${vendorUser.firstName + ' ' + (vendorUser.lastName || '')}::VARCHAR,
          ${vendorUser.phone || ''}::VARCHAR,
          ${vendorUser.email || null}::VARCHAR,
          ${vendorUser.vendorType || 'owner'}::VARCHAR,
          ${vendorUser.vendorType || 'owner'}::VARCHAR,
          ${vendorUser.isActive ?? true}::BOOLEAN,
          true::BOOLEAN,
          ${vendorUser.zoneWiseTopic || null}::VARCHAR
        )
        ON CONFLICT (php_vendor_id)
        DO UPDATE SET
          store_id = EXCLUDED.store_id,
          php_store_id = EXCLUDED.php_store_id,
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          vendor_type = EXCLUDED.vendor_type,
          is_active = EXCLUDED.is_active,
          zone_wise_topic = EXCLUDED.zone_wise_topic,
          updated_at = NOW()
        RETURNING *
      `;

      const vendor = result[0];
      this.logger.log(`✅ Synced vendor: ${vendor.name} (${vendor.id})`);

      return this.mapVendorRow(vendor);
    } catch (error) {
      this.logger.error(`Failed to sync vendor ${vendorUser.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get vendor profile by PHP ID
   */
  async getVendorByPhpId(phpVendorId: number): Promise<VendorProfile | null> {
    const vendors = await this.prisma.$queryRaw<any[]>`
      SELECT 
        vp.*,
        s.name as store_name
      FROM vendor_profiles vp
      LEFT JOIN stores s ON s.id = vp.store_id
      WHERE vp.php_vendor_id = ${phpVendorId}
    `;

    if (vendors.length === 0) {
      // Try to sync from PHP first
      return this.syncVendorFromPhp(phpVendorId);
    }

    return this.mapVendorRow(vendors[0]);
  }

  /**
   * Get vendor profile by phone number
   */
  async getVendorByPhone(phone: string): Promise<VendorProfile | null> {
    const vendors = await this.prisma.$queryRaw<any[]>`
      SELECT 
        vp.*,
        s.name as store_name
      FROM vendor_profiles vp
      LEFT JOIN stores s ON s.id = vp.store_id
      WHERE vp.phone = ${phone}
    `;

    if (vendors.length === 0) {
      return null;
    }

    return this.mapVendorRow(vendors[0]);
  }

  /**
   * Get all vendors for a store
   */
  async getVendorsByStore(phpStoreId: number): Promise<VendorProfile[]> {
    const vendors = await this.prisma.$queryRaw<any[]>`
      SELECT 
        vp.*,
        s.name as store_name
      FROM vendor_profiles vp
      LEFT JOIN stores s ON s.id = vp.store_id
      WHERE vp.php_store_id = ${phpStoreId}
      ORDER BY vp.is_primary_owner DESC, vp.created_at ASC
    `;

    return vendors.map(v => this.mapVendorRow(v));
  }

  /**
   * Update vendor performance metrics
   */
  async updatePerformanceMetrics(
    phpVendorId: number,
    metrics: Partial<VendorPerformance>
  ): Promise<void> {
    const vendor = await this.getVendorByPhpId(phpVendorId);
    if (!vendor) {
      this.logger.warn(`Cannot update metrics - vendor not found: ${phpVendorId}`);
      return;
    }

    await this.prisma.$queryRaw`
      UPDATE vendor_profiles
      SET
        total_orders = COALESCE(${metrics.totalOrders}::INTEGER, total_orders),
        avg_order_value = COALESCE(${metrics.avgOrderValue}::DECIMAL, avg_order_value),
        avg_preparation_time = COALESCE(${metrics.avgPreparationTime}::INTEGER, avg_preparation_time),
        positive_ratings = COALESCE(${metrics.positiveRatings}::INTEGER, positive_ratings),
        negative_ratings = COALESCE(${metrics.negativeRatings}::INTEGER, negative_ratings),
        cancellation_rate = COALESCE(${metrics.cancellationRate}::DECIMAL, cancellation_rate),
        monthly_revenue = COALESCE(${metrics.monthlyRevenue}::DECIMAL, monthly_revenue),
        last_order_at = COALESCE(${metrics.lastOrderAt}::TIMESTAMP, last_order_at),
        updated_at = NOW()
      WHERE php_vendor_id = ${phpVendorId}
    `;

    this.logger.log(`📊 Updated performance metrics for vendor ${phpVendorId}`);
  }

  /**
   * Get vendor performance view
   */
  async getVendorPerformance(phpVendorId: number): Promise<any> {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_vendor_performance WHERE php_vendor_id = ${phpVendorId}
    `;

    return result[0] || null;
  }

  /**
   * Get all active vendors (for notifications, broadcasts)
   */
  async getActiveVendors(vendorType?: string): Promise<VendorProfile[]> {
    let vendors: any[];

    if (vendorType) {
      vendors = await this.prisma.$queryRaw<any[]>`
        SELECT 
          vp.*,
          s.name as store_name
        FROM vendor_profiles vp
        LEFT JOIN stores s ON s.id = vp.store_id
        WHERE vp.is_active = true AND vp.vendor_type = ${vendorType}
      `;
    } else {
      vendors = await this.prisma.$queryRaw<any[]>`
        SELECT 
          vp.*,
          s.name as store_name
        FROM vendor_profiles vp
        LEFT JOIN stores s ON s.id = vp.store_id
        WHERE vp.is_active = true
      `;
    }

    return vendors.map(v => this.mapVendorRow(v));
  }

  /**
   * Handle vendor login - sync profile
   */
  async onVendorLogin(vendorUser: VendorUser): Promise<VendorProfile | null> {
    this.logger.log(`🔐 Vendor login: ${vendorUser.phone} (${vendorUser.id})`);
    
    // Sync vendor profile on login using VendorUser data
    const profile = await this.syncFromVendorUser(vendorUser);
    
    if (profile) {
      // Update last login time
      await this.prisma.$queryRaw`
        UPDATE vendor_profiles
        SET updated_at = NOW()
        WHERE php_vendor_id = ${vendorUser.id}
      `;
    }

    return profile;
  }

  private mapVendorRow(row: any): VendorProfile {
    return {
      id: row.id,
      phpVendorId: row.php_vendor_id,
      storeId: row.store_id,
      phpStoreId: row.php_store_id,
      storeName: row.store_name,
      name: row.name,
      phone: row.phone,
      email: row.email,
      vendorType: row.vendor_type,
      role: row.role,
      isActive: row.is_active,
      isPrimaryOwner: row.is_primary_owner,
      permissions: row.permissions,
      performanceMetrics: {
        totalOrders: row.total_orders,
        avgOrderValue: parseFloat(row.avg_order_value || '0'),
        avgPreparationTime: row.avg_preparation_time,
        positiveRatings: row.positive_ratings,
        negativeRatings: row.negative_ratings,
        cancellationRate: parseFloat(row.cancellation_rate || '0'),
        monthlyRevenue: parseFloat(row.monthly_revenue || '0'),
        lastOrderAt: row.last_order_at,
      },
      zoneWiseTopic: row.zone_wise_topic,
      profileImage: row.profile_image,
    };
  }
}
