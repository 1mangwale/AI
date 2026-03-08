import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  Zone,
  ZoneDetectionResult,
  Coordinates,
  StoreLocation,
  DeliveryAvailability,
  ZoneFilteredResult,
  ModuleDeliveryRate,
} from '../interfaces/zone.interface';

/**
 * Zone Service
 * Handles all zone-related operations for hyperlocal delivery
 * 
 * Key Responsibilities:
 * 1. Detect user's zone from coordinates
 * 2. Validate if stores can deliver to user's zone
 * 3. Filter search results by zone
 * 4. Calculate delivery availability
 * 5. Enrich items with zone information
 */
@Injectable()
export class ZoneService {
  private readonly logger = new Logger(ZoneService.name);
  private readonly phpBackendUrl: string;
  private zonesCache: Map<number, Zone> = new Map();
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL') || this.configService.get<string>('PHP_API_BASE_URL');

    if (!this.phpBackendUrl) {
      throw new Error('PHP_BACKEND_URL is not defined in environment variables');
    }
  }

  /**
   * Get zone ID from coordinates (user's location)
   * Uses PHP backend's point-in-polygon detection
   */
  async getZoneIdByCoordinates(lat: number, lng: number): Promise<ZoneDetectionResult | null> {
    try {
      this.logger.log(`🗺️  Detecting zone for coordinates: ${lat}, ${lng}`);

      const url = `${this.phpBackendUrl}/api/v1/config/get-zone-id`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          params: { lat, lng },
          timeout: 5000,
        }),
      );

      // Check for error response
      if (response.data.errors) {
        this.logger.warn(
          `Zone not found for coordinates ${lat}, ${lng}: ${response.data.errors[0]?.message}`,
        );
        return null;
      }

      // Response contains zone_id (as string "[4]") and zone_data (as array)
      let zoneId: number;
      try {
        // Parse zone_id from string format "[4]" or just "4"
        const zoneIdStr = response.data.zone_id;
        if (typeof zoneIdStr === 'string') {
          // Remove brackets and parse: "[4]" -> 4
          zoneId = parseInt(zoneIdStr.replace(/[\[\]]/g, ''));
        } else {
          zoneId = zoneIdStr;
        }
      } catch (error) {
        this.logger.error(`Failed to parse zone_id: ${response.data.zone_id}`);
        return null;
      }

      // zone_data is an array with one element
      const zoneDataArray = response.data.zone_data;
      const zoneData = Array.isArray(zoneDataArray) ? zoneDataArray[0] : zoneDataArray;

      if (!zoneId || !zoneData) {
        this.logger.warn(`Invalid zone response for ${lat}, ${lng}`);
        return null;
      }

      // Cache the zone data
      this.zonesCache.set(zoneId, zoneData);

      const result: ZoneDetectionResult = {
        zone_id: zoneId,
        zone_name: zoneData.name || 'Unknown Zone',
        zone_data: zoneData,
        is_serviceable: zoneData.status === 1,
        available_modules: this.extractModuleNames(zoneData),
        payment_methods: {
          cash_on_delivery: zoneData.cash_on_delivery,
          digital_payment: zoneData.digital_payment,
          offline_payment: zoneData.offline_payment || false,
        },
        delivery_rates: this.extractDeliveryRates(zoneData),
      };

      this.logger.log(`✅ Zone detected: ${result.zone_name} (ID: ${result.zone_id})`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to detect zone: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all available zones from PHP backend
   */
  async getAllZones(): Promise<Zone[]> {
    try {
      // Check cache
      const now = Date.now();
      if (this.zonesCache.size > 0 && now < this.cacheExpiry) {
        this.logger.log('📦 Returning zones from cache');
        return Array.from(this.zonesCache.values());
      }

      this.logger.log('🔄 Fetching zones from PHP backend');
      const url = `${this.phpBackendUrl}/api/v1/zone/list`;
      const response = await firstValueFrom(
        this.httpService.get<Zone[]>(url, {
          timeout: 5000,
        }),
      );

      const zones = response.data;

      // Update cache
      this.zonesCache.clear();
      zones.forEach((zone) => this.zonesCache.set(zone.id, zone));
      this.cacheExpiry = now + this.CACHE_TTL_MS;

      this.logger.log(`✅ Loaded ${zones.length} zones`);
      return zones;
    } catch (error) {
      this.logger.error(`Failed to fetch zones: ${error.message}`);
      return [];
    }
  }

  /**
   * Get zone by ID
   */
  async getZoneById(zoneId: number): Promise<Zone | null> {
    // Check cache first
    if (this.zonesCache.has(zoneId)) {
      return this.zonesCache.get(zoneId)!;
    }

    // Fetch all zones and return specific one
    const zones = await this.getAllZones();
    return zones.find((z) => z.id === zoneId) || null;
  }

  /**
   * Check if delivery is available from store to user
   */
  async checkDeliveryAvailability(
    storeLocation: StoreLocation,
    userLocation: Coordinates,
    userZoneId?: number,
  ): Promise<DeliveryAvailability> {
    try {
      // Detect user's zone if not provided
      if (!userZoneId) {
        const userZone = await this.getZoneIdByCoordinates(userLocation.lat, userLocation.lng);
        userZoneId = userZone?.zone_id;
      }

      if (!userZoneId) {
        return {
          is_available: false,
          user_zone_id: 0,
          store_zone_id: storeLocation.zone_id,
          same_zone: false,
          reason: 'User location not in serviceable area',
        };
      }

      // Check if same zone
      const sameZone = userZoneId === storeLocation.zone_id;

      if (!sameZone) {
        return {
          is_available: false,
          user_zone_id: userZoneId,
          store_zone_id: storeLocation.zone_id,
          same_zone: false,
          reason: 'Store and user are in different zones',
        };
      }

      // Same zone - delivery available
      return {
        is_available: true,
        user_zone_id: userZoneId,
        store_zone_id: storeLocation.zone_id,
        same_zone: true,
      };
    } catch (error) {
      this.logger.error(`Delivery availability check failed: ${error.message}`);
      return {
        is_available: false,
        user_zone_id: userZoneId || 0,
        store_zone_id: storeLocation.zone_id,
        same_zone: false,
        reason: 'Error checking delivery availability',
      };
    }
  }

  /**
   * Filter search results by zone
   * Removes items from stores in different zones
   */
  async filterItemsByZone<T extends { store_id?: number; zone_id?: number }>(
    items: T[],
    userZoneId: number,
  ): Promise<ZoneFilteredResult<T>> {
    const totalCount = items.length;
    const removedReasons = {
      different_zone: 0,
      store_inactive: 0,
      out_of_delivery_radius: 0,
    };

    const filteredItems = items.filter((item) => {
      const itemZoneId = item.zone_id;

      // If no zone info, assume it's available (fallback behavior)
      if (!itemZoneId) {
        return true;
      }

      // Check if same zone
      if (itemZoneId !== userZoneId) {
        removedReasons.different_zone++;
        return false;
      }

      return true;
    });

    const userZone = await this.getZoneById(userZoneId);

    return {
      items: filteredItems,
      total_count: totalCount,
      filtered_count: filteredItems.length,
      user_zone: {
        id: userZoneId,
        name: userZone?.name || 'Unknown Zone',
      },
      removed_count: totalCount - filteredItems.length,
      removed_reasons: removedReasons,
    };
  }

  /**
   * Enrich search items with zone information
   * Adds zone_id and zone_name to items based on store
   */
  async enrichItemsWithZone<T extends { store_id?: number }>(
    items: T[],
    storeZoneMap: Map<number, { zone_id: number; zone_name: string }>,
  ): Promise<Array<T & { zone_id?: number; zone_name?: string }>> {
    return items.map((item) => {
      if (item.store_id && storeZoneMap.has(item.store_id)) {
        const zoneInfo = storeZoneMap.get(item.store_id)!;
        return {
          ...item,
          zone_id: zoneInfo.zone_id,
          zone_name: zoneInfo.zone_name,
        };
      }
      return item;
    });
  }

  /**
   * Get zone name by ID
   */
  async getZoneName(zoneId: number): Promise<string> {
    const zone = await this.getZoneById(zoneId);
    return zone?.name || `Zone ${zoneId}`;
  }

  /**
   * Check if point is in zone polygon
   * Uses ray-casting algorithm for point-in-polygon detection
   * Fallback if PHP backend is unavailable
   */
  private isPointInPolygon(point: Coordinates, polygon: number[][]): boolean {
    const { lat, lng } = point;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];

      const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Extract available module names from zone data
   */
  private extractModuleNames(zone: Zone): string[] {
    if (!zone.modules || zone.modules.length === 0) {
      return [];
    }

    return zone.modules.map((m) => m.module_type);
  }

  /**
   * Extract per-module delivery rates from zone-module pivot table.
   * PHP stores rates in modules[].pivot, keyed by module ID.
   */
  private extractDeliveryRates(zone: Zone): Record<number, ModuleDeliveryRate> {
    const rates: Record<number, ModuleDeliveryRate> = {};

    if (!zone.modules || zone.modules.length === 0) {
      return rates;
    }

    for (const m of zone.modules) {
      // PHP returns rates in pivot sub-object; some interfaces flatten them
      const pivot = m.pivot || m;
      const perKm = parseFloat(String(pivot.per_km_shipping_charge ?? 0)) || 0;
      const min = parseFloat(String(pivot.minimum_shipping_charge ?? 0)) || 0;
      const max = parseFloat(String(pivot.maximum_shipping_charge ?? 0)) || null;
      const chargeType = (pivot.delivery_charge_type as 'fixed' | 'distance') || 'distance';
      const fixedCharge = parseFloat(String(pivot.fixed_shipping_charge ?? 0)) || null;

      rates[m.id] = {
        moduleId: m.id,
        moduleName: m.module_name || m.module_type,
        perKmCharge: perKm,
        minCharge: min,
        maxCharge: max,
        chargeType,
        fixedCharge,
      };

      this.logger.debug(
        `📦 Zone ${zone.id} module ${m.id} (${m.module_name}): ₹${perKm}/km, min ₹${min}, max ₹${max ?? 'none'}, type=${chargeType}`,
      );
    }

    return rates;
  }

  /**
   * Clear zone cache (useful for testing or admin operations)
   */
  clearCache(): void {
    this.logger.log('🗑️  Clearing zone cache');
    this.zonesCache.clear();
    this.cacheExpiry = 0;
  }

  /**
   * Get cache status (for debugging)
   */
  getCacheStatus(): { size: number; expiry: Date; ttl_minutes: number } {
    return {
      size: this.zonesCache.size,
      expiry: new Date(this.cacheExpiry),
      ttl_minutes: this.CACHE_TTL_MS / 60000,
    };
  }
}
