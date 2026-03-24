import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { StoreScheduleService } from '../../stores/services/store-schedule.service';

/**
 * Location coordinates
 */
export interface Location {
  latitude: number;
  longitude: number;
}

/**
 * Distance calculation result
 */
export interface DistanceResult {
  distance_km: number;
  duration_min: number;
  distance_m: number;
  duration_s: number;
}

/**
 * Bulk distance calculation result (one user → many stores)
 */
export interface BulkDistanceResult {
  source: Location;
  destinations: Array<{
    location: Location;
    distance_km: number;
    duration_min: number;
    store_id?: number;
  }>;
}

/**
 * OSRM Service
 * 
 * Calculates distances and delivery times using OSRM routing engine
 * OSRM container runs on port 5000 with India OSM data
 */
@Injectable()
export class OSRMService {
  private readonly logger = new Logger(OSRMService.name);
  private readonly osrmUrl: string;
  private readonly averageDeliverySpeedKmh = 25; // Default: 25 km/h for delivery
  
  // Configurable delivery time buffer (default 10%)
  // This can be updated via admin frontend
  private deliveryTimeBufferPercent = 10; // 10% buffer on top of prep time

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly storeScheduleService: StoreScheduleService, // Inject StoreScheduleService
  ) {
    this.osrmUrl = this.configService.get<string>('OSRM_URL') || 'http://localhost:5000';
    
    // Load buffer percentage from config or use default 10%
    this.deliveryTimeBufferPercent = this.configService.get<number>('DELIVERY_TIME_BUFFER_PERCENT') || 10;
    
    this.logger.log(`🗺️  OSRM Service initialized: ${this.osrmUrl}`);
    this.logger.log(`⏱️  Delivery time buffer: ${this.deliveryTimeBufferPercent}%`);
  }

  /**
   * Get current delivery time buffer percentage
   */
  getDeliveryTimeBuffer(): number {
    return this.deliveryTimeBufferPercent;
  }

  /**
   * Set delivery time buffer percentage (configurable from frontend)
   * @param percent - Buffer percentage (e.g., 10 for 10%)
   */
  setDeliveryTimeBuffer(percent: number): void {
    if (percent < 0 || percent > 100) {
      throw new Error('Buffer percentage must be between 0 and 100');
    }
    this.deliveryTimeBufferPercent = percent;
    this.logger.log(`⏱️  Delivery time buffer updated to: ${percent}%`);
  }

  /**
   * Calculate distance and duration between two points
   */
  async calculateDistance(
    from: Location,
    to: Location,
  ): Promise<DistanceResult | null> {
    try {
      // OSRM expects: longitude,latitude (not lat,lng!)
      const url = `${this.osrmUrl}/route/v1/car/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;

      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 3000 }),
      );

      if (response.data.code !== 'Ok' || !response.data.routes?.[0]) {
        this.logger.warn(`OSRM route not found for ${from.latitude},${from.longitude} → ${to.latitude},${to.longitude}`);
        return this.fallbackDistance(from, to);
      }

      const route = response.data.routes[0];
      const distanceMeters = route.distance; // in meters
      const durationSeconds = route.duration; // in seconds

      return {
        distance_m: distanceMeters,
        distance_km: parseFloat((distanceMeters / 1000).toFixed(2)),
        duration_s: durationSeconds,
        duration_min: Math.ceil(durationSeconds / 60),
      };
    } catch (error) {
      this.logger.error(`OSRM distance calculation failed: ${error.message}`);
      return this.fallbackDistance(from, to);
    }
  }

  /**
   * Calculate distances from one source to multiple destinations (efficient bulk operation)
   * Uses OSRM Table service for many-to-many distance matrix
   */
  async calculateBulkDistances(
    source: Location,
    destinations: Array<Location & { store_id?: number }>,
  ): Promise<BulkDistanceResult | null> {
    try {
      if (destinations.length === 0) {
        return { source, destinations: [] };
      }

      // Build coordinates string: source;dest1;dest2;dest3...
      // OSRM format: longitude,latitude
      const coords = [
        `${source.longitude},${source.latitude}`,
        ...destinations.map(d => `${d.longitude},${d.latitude}`),
      ].join(';');

      // Sources: index 0 (user location)
      // Destinations: indices 1..N (stores)
      const url = `${this.osrmUrl}/table/v1/car/${coords}?sources=0&annotations=distance,duration`;

      const response = await firstValueFrom(
        this.httpService.get(url, { timeout: 5000 }),
      );

      if (response.data.code !== 'Ok') {
        this.logger.warn(`OSRM table calculation failed: ${response.data.code}`);
        return this.fallbackBulkDistances(source, destinations);
      }

      // Response has distances[0] and durations[0] arrays
      // distances[0][i] = distance from source to destination i
      const distances = response.data.distances[0]; // in meters
      const durations = response.data.durations[0]; // in seconds

      const results = destinations.map((dest, index) => {
        const distanceMeters = distances[index + 1]; // +1 because index 0 is source
        const durationSeconds = durations[index + 1];

        return {
          location: dest,
          distance_km: parseFloat((distanceMeters / 1000).toFixed(2)),
          duration_min: Math.ceil(durationSeconds / 60),
          store_id: dest.store_id,
        };
      });

      this.logger.debug(`✅ Calculated ${results.length} distances via OSRM table service`);

      return {
        source,
        destinations: results,
      };
    } catch (error) {
      this.logger.error(`OSRM bulk distance calculation failed: ${error.message}`);
      return this.fallbackBulkDistances(source, destinations);
    }
  }

  /**
   * Enrich search results with distance and delivery time
   */
  async enrichWithDistance<T extends { 
    store_latitude?: number; 
    store_longitude?: number; 
    store_id?: number;
    preparation_time?: number; // Store's food prep time (in minutes)
    delivery_time?: string; // Existing generic delivery time
    available_time_starts?: string; // Store opening time
    available_time_ends?: string; // Store closing time
  }>(
    items: T[],
    userLocation: Location,
  ): Promise<Array<T & { 
    distance_km: number; 
    duration_min: number; 
    delivery_time_estimate: string;
    total_delivery_time: number; // Travel + Prep time
    is_open: boolean;
    opens_at?: string;
    closes_at?: string;
  }>> {
    try {
      // Extract store locations
      const storeLocations = items
        .filter(item => item.store_latitude && item.store_longitude)
        .map(item => ({
          latitude: item.store_latitude!,
          longitude: item.store_longitude!,
          store_id: item.store_id,
        }));

      if (storeLocations.length === 0) {
        this.logger.warn('No store locations available for distance calculation');
        return items.map(item => ({
          ...item,
          distance_km: 0,
          duration_min: 0,
          delivery_time_estimate: 'Unknown',
          total_delivery_time: 0,
          is_open: true,
        }));
      }

      // Calculate all distances in one call
      const bulkResult = await this.calculateBulkDistances(userLocation, storeLocations);

      if (!bulkResult) {
        return items.map(item => ({
          ...item,
          distance_km: 0,
          duration_min: 0,
          delivery_time_estimate: 'Unknown',
          total_delivery_time: 0,
          is_open: this.checkIfOpen(item.available_time_starts, item.available_time_ends),
          opens_at: item.available_time_starts,
          closes_at: item.available_time_ends,
        }));
      }

      // Create a map of store_id → distance result
      const distanceMap = new Map<number, { distance_km: number; duration_min: number }>();
      bulkResult.destinations.forEach(dest => {
        if (dest.store_id) {
          distanceMap.set(dest.store_id, {
            distance_km: dest.distance_km,
            duration_min: dest.duration_min,
          });
        }
      });

      // Enrich items with distance data + store schedule
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const distanceData = item.store_id ? distanceMap.get(item.store_id) : null;
        
        // Parse store's delivery_time field (e.g., "20-30 min" or "40-50")
        const [prepMin, prepMax] = this.parseStoreDeliveryTime(item.delivery_time);
        
        // Add buffer to preparation time (configurable, default 10%)
        const bufferMultiplier = 1 + (this.deliveryTimeBufferPercent / 100);
        const prepTimeWithBuffer = Math.round((prepMin + prepMax) / 2 * bufferMultiplier);
        
        // Get accurate store open/closed status from MySQL
        let isOpen = true;
        let storeStatusMessage = '';
        let opensAt: string | undefined;
        let closesAt: string | undefined;
        
        this.logger.debug(`📦 Enriching item: store_id=${item.store_id}, name=${item['name'] || 'unknown'}`);
        
        if (item.store_id) {
          try {
            this.logger.debug(`🔍 Checking store ${item.store_id} schedule...`);
            const storeStatus = await this.storeScheduleService.isStoreOpen(item.store_id);
            isOpen = storeStatus.is_open;
            storeStatusMessage = storeStatus.message;
            opensAt = storeStatus.opens_at;
            closesAt = storeStatus.closes_at;
            this.logger.debug(`✅ Store ${item.store_id}: ${isOpen ? 'OPEN' : 'CLOSED'} - ${storeStatusMessage}`);
          } catch (error) {
            this.logger.warn(`⚠️  Store schedule query failed for store ${item.store_id}: ${error.message}`);
            // Fallback to old method if schedule service fails
            isOpen = this.checkIfOpen(item.available_time_starts, item.available_time_ends);
            opensAt = item.available_time_starts;
            closesAt = item.available_time_ends;
          }
        } else {
          this.logger.debug(`⚠️  No store_id for item, using fallback`);
          // No store_id, use old method
          isOpen = this.checkIfOpen(item.available_time_starts, item.available_time_ends);
          opensAt = item.available_time_starts;
          closesAt = item.available_time_ends;
        }
        
        if (distanceData) {
          const travelTime = distanceData.duration_min;
          const totalTime = travelTime + prepTimeWithBuffer;
          
          return {
            ...item,
            distance_km: distanceData.distance_km,
            duration_min: travelTime, // Just travel time
            prep_time_min: prepTimeWithBuffer, // Prep time with buffer
            total_delivery_time: totalTime, // Travel + Prep + Buffer
            delivery_time_estimate: this.formatDeliveryTime(totalTime),
            is_open: isOpen,
            store_status_message: storeStatusMessage || (isOpen ? 'Open now' : 'Closed'),
            opens_at: opensAt,
            closes_at: closesAt,
          };
        }

        return {
          ...item,
          distance_km: 0,
          duration_min: 0,
          prep_time_min: prepTimeWithBuffer,
          total_delivery_time: prepTimeWithBuffer,
          delivery_time_estimate: this.formatDeliveryTime(prepTimeWithBuffer),
          is_open: isOpen,
          store_status_message: storeStatusMessage || (isOpen ? 'Open now' : 'Closed'),
          opens_at: opensAt,
          closes_at: closesAt,
        };
      }));
      
      return enrichedItems;
    } catch (error) {
      this.logger.error(`Failed to enrich items with distance: ${error.message}`);
      return items.map(item => ({
        ...item,
        distance_km: 0,
        duration_min: 0,
        prep_time_min: 0,
        total_delivery_time: 0,
        delivery_time_estimate: 'Unknown',
        is_open: true,
      }));
    }
  }

  /**
   * Parse store's delivery_time field
   * Examples: "20-30 min", "30-40", "40 min"
   * Returns: [minTime, maxTime] in minutes
   */
  private parseStoreDeliveryTime(deliveryTime?: string): [number, number] {
    if (!deliveryTime) {
      this.logger.debug('No delivery_time provided, using default 15-25 min range');
      return [15, 25]; // Default range
    }

    // Remove "min" and extra spaces, then parse
    const cleaned = deliveryTime.toLowerCase().replace(/\s*min.*$/i, '').trim();
    
    // Match patterns: "20-30" or "30" or "20 - 30"
    const match = cleaned.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    
    if (!match) {
      this.logger.warn(`Could not parse delivery_time: "${deliveryTime}", using default`);
      return [15, 25];
    }

    const minTime = parseInt(match[1]);
    const maxTime = match[2] ? parseInt(match[2]) : minTime + 10;
    
    this.logger.debug(`Parsed delivery_time "${deliveryTime}" → [${minTime}, ${maxTime}] mins`);
    return [minTime, maxTime];
  }

  /**
   * Estimate preparation time based on item type (fallback if not provided)
   */
  private estimatePreparationTime(item: any): number {
    // Default preparation times by category (in minutes)
    const categoryTimes: Record<string, number> = {
      'pizza': 20,
      'burger': 15,
      'biryani': 25,
      'chinese': 20,
      'dessert': 10,
      'beverage': 5,
      'fast food': 15,
      'indian': 20,
      'italian': 20,
    };

    // Check category name
    const categoryName = (item.category_name || '').toLowerCase();
    for (const [key, time] of Object.entries(categoryTimes)) {
      if (categoryName.includes(key)) {
        return time;
      }
    }

    // Check item name
    const itemName = (item.name || '').toLowerCase();
    for (const [key, time] of Object.entries(categoryTimes)) {
      if (itemName.includes(key)) {
        return time;
      }
    }

    // Default: 15 minutes
    return 15;
  }

  /**
   * Check if store is currently open based on opening/closing hours
   */
  private checkIfOpen(opensAt?: string, closesAt?: string): boolean {
    if (!opensAt || !closesAt) {
      return true; // Assume open if times not provided
    }

    try {
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes(); // Current time in minutes

      // Parse opening time (format: "09:00:00" or "09:00")
      const openParts = opensAt.split(':');
      const openTime = parseInt(openParts[0]) * 60 + parseInt(openParts[1]);

      // Parse closing time
      const closeParts = closesAt.split(':');
      const closeTime = parseInt(closeParts[0]) * 60 + parseInt(closeParts[1]);

      // Handle overnight stores (e.g., opens 22:00, closes 02:00)
      if (closeTime < openTime) {
        return currentTime >= openTime || currentTime <= closeTime;
      }

      return currentTime >= openTime && currentTime <= closeTime;
    } catch (error) {
      this.logger.error(`Failed to parse store hours: ${error.message}`);
      return true; // Assume open on error
    }
  }

  /**
   * Format delivery time as human-readable string
   */
  private formatDeliveryTime(minutes: number): string {
    if (minutes < 15) {
      return '10-15 mins';
    } else if (minutes < 25) {
      return '15-25 mins';
    } else if (minutes < 35) {
      return '25-35 mins';
    } else if (minutes < 50) {
      return '35-50 mins';
    } else {
      return `${Math.ceil(minutes / 10) * 10}-${Math.ceil(minutes / 10) * 10 + 10} mins`;
    }
  }

  /**
   * Fallback: Calculate distance using Haversine formula (as the crow flies)
   * Applies 1.3x multiplier to approximate road distance from straight-line distance
   */
  private fallbackDistance(from: Location, to: Location): DistanceResult {
    const straightLine_km = this.haversineDistance(from, to);
    const distance_km = parseFloat((straightLine_km * 1.3).toFixed(2)); // 1.3x road-distance approximation
    const duration_min = Math.ceil((distance_km / this.averageDeliverySpeedKmh) * 60);

    this.logger.warn(`Using Haversine fallback: straight-line ${straightLine_km.toFixed(2)} km * 1.3 = ${distance_km} km, ${duration_min} min`);

    return {
      distance_m: distance_km * 1000,
      distance_km: parseFloat(distance_km.toFixed(2)),
      duration_s: duration_min * 60,
      duration_min,
    };
  }

  /**
   * Fallback for bulk calculations
   * Applies 1.3x multiplier to approximate road distance from straight-line distance
   */
  private fallbackBulkDistances(
    source: Location,
    destinations: Array<Location & { store_id?: number }>,
  ): BulkDistanceResult {
    this.logger.warn(`Using Haversine fallback for ${destinations.length} bulk distances (1.3x road multiplier)`);

    const results = destinations.map(dest => {
      const straightLine_km = this.haversineDistance(source, dest);
      const distance_km = parseFloat((straightLine_km * 1.3).toFixed(2)); // 1.3x road-distance approximation
      const duration_min = Math.ceil((distance_km / this.averageDeliverySpeedKmh) * 60);

      return {
        location: dest,
        distance_km,
        duration_min,
        store_id: dest.store_id,
      };
    });

    return { source, destinations: results };
  }

  /**
   * Haversine formula to calculate distance between two coordinates
   * Returns distance in kilometers
   */
  private haversineDistance(from: Location, to: Location): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(to.latitude - from.latitude);
    const dLon = this.toRad(to.longitude - from.longitude);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(from.latitude)) *
        Math.cos(this.toRad(to.latitude)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   */
  private toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Health check for OSRM service
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Try a simple route calculation
      const testLocation = { latitude: 19.96, longitude: 73.76 };
      const result = await this.calculateDistance(testLocation, testLocation);
      return result !== null;
    } catch (error) {
      this.logger.error(`OSRM health check failed: ${error.message}`);
      return false;
    }
  }
}
