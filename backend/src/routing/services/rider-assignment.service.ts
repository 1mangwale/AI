import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import Redis from 'ioredis';
import { PrismaService } from '../../database/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  RiderAssignment,
  RiderAssignmentStatus,
  NearbyRider,
  RiderEarnings,
  EARNING_RATES,
  DEFAULT_EARNING_RATES,
} from '../interfaces/rider.interfaces';

/**
 * Rider Assignment Service
 *
 * Manages the full lifecycle of rider-to-order assignment:
 * - Finding nearest available riders from Redis geolocation data
 * - Creating and managing assignments through status transitions
 * - Retry logic with expanding search radius
 * - Earnings calculation per module type
 *
 * Redis keys used:
 * - rider:location:{riderId}  — JSON { lat, lng, timestamp, speed?, heading? }
 * - rider:online:{riderId}    — presence flag with TTL
 */
@Injectable()
export class RiderAssignmentService implements OnModuleInit {
  private readonly logger = new Logger(RiderAssignmentService.name);

  // Default search config
  private readonly defaultSearchRadiusKm = 3.0;
  private readonly maxSearchAttempts = 5;
  private readonly radiusExpansionFactor = 1.5;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS rider_assignments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id BIGINT NOT NULL,
          rider_id BIGINT,
          store_id BIGINT NOT NULL,
          status VARCHAR(30) DEFAULT 'searching',
          assigned_at TIMESTAMP,
          accepted_at TIMESTAMP,
          picked_up_at TIMESTAMP,
          delivered_at TIMESTAMP,
          cancelled_at TIMESTAMP,
          cancel_reason TEXT,
          distance_km DECIMAL(6,2),
          estimated_time_min INT,
          actual_time_min INT,
          earnings DECIMAL(10,2),
          search_attempts INT DEFAULT 0,
          max_search_attempts INT DEFAULT 5,
          search_radius_km DECIMAL(4,1) DEFAULT 3.0,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_rider_assignments_order
          ON rider_assignments(order_id)
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_rider_assignments_rider
          ON rider_assignments(rider_id, status)
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS idx_rider_assignments_status
          ON rider_assignments(status)
      `;

      this.logger.log('Rider assignments table initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize rider_assignments table: ${error.message}`, error.stack);
    }
  }

  // ============================================
  // ASSIGNMENT LIFECYCLE
  // ============================================

  /**
   * Assign a rider to an order. Finds the nearest available rider
   * and creates an assignment record.
   */
  async assignRider(
    orderId: number,
    storeId: number,
    storeLat: number,
    storeLng: number,
  ): Promise<RiderAssignment | null> {
    try {
      this.logger.log(`Searching for rider for order #${orderId} near store #${storeId}`);

      // Find nearest available riders within default radius
      const nearbyRiders = await this.findNearestRiders(
        storeLat,
        storeLng,
        this.defaultSearchRadiusKm,
        5,
      );

      if (nearbyRiders.length === 0) {
        this.logger.warn(`No riders found near store #${storeId} within ${this.defaultSearchRadiusKm}km`);

        // Create assignment in 'searching' status for retry
        const assignment = await this.createAssignment({
          orderId,
          storeId,
          riderId: null,
          status: 'searching',
          searchAttempts: 1,
          searchRadiusKm: this.defaultSearchRadiusKm,
        });

        return assignment;
      }

      // Pick the closest online rider
      const selectedRider = nearbyRiders[0];
      this.logger.log(
        `Selected rider #${selectedRider.riderId} at ${selectedRider.distanceKm}km for order #${orderId}`,
      );

      // Estimate delivery time (distance / 25 km/h average speed)
      const estimatedTimeMin = Math.ceil((selectedRider.distanceKm / 25) * 60) + 5; // +5 min buffer

      const assignment = await this.createAssignment({
        orderId,
        storeId,
        riderId: selectedRider.riderId,
        status: 'assigned',
        distanceKm: selectedRider.distanceKm,
        estimatedTimeMin,
        searchAttempts: 1,
        searchRadiusKm: this.defaultSearchRadiusKm,
      });

      return assignment;
    } catch (error) {
      this.logger.error(`Failed to assign rider for order #${orderId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Find nearest riders to a given location by scanning Redis location keys.
   * Returns riders sorted by distance (ascending).
   */
  async findNearestRiders(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number = 10,
  ): Promise<NearbyRider[]> {
    try {
      const riders: NearbyRider[] = [];
      let cursor = '0';

      // Scan all rider:location:* keys
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          'rider:location:*',
          'COUNT',
          100,
        );
        cursor = nextCursor;

        for (const key of keys) {
          try {
            const data = await this.redis.get(key);
            if (!data) continue;

            const location = JSON.parse(data);
            const riderId = parseInt(key.split(':').pop() || '0', 10);

            if (!riderId || !location.lat || !location.lng) continue;

            // Check if rider is online
            const isOnline = await this.redis.exists(`rider:online:${riderId}`);
            if (!isOnline) continue;

            // Calculate haversine distance
            const distance = this.haversineDistance(lat, lng, location.lat, location.lng);

            if (distance <= radiusKm) {
              riders.push({
                riderId,
                lat: location.lat,
                lng: location.lng,
                distanceKm: parseFloat(distance.toFixed(2)),
                isOnline: true,
              });
            }
          } catch (parseError) {
            this.logger.warn(`Failed to parse rider location for key ${key}: ${parseError.message}`);
          }
        }
      } while (cursor !== '0');

      // Sort by distance and limit results
      riders.sort((a, b) => a.distanceKm - b.distanceKm);

      this.logger.debug(`Found ${riders.length} riders within ${radiusKm}km, returning top ${limit}`);
      return riders.slice(0, limit);
    } catch (error) {
      this.logger.error(`Failed to find nearest riders: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Rider accepts the assignment.
   */
  async acceptAssignment(assignmentId: string, riderId: number): Promise<RiderAssignment | null> {
    try {
      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        UPDATE rider_assignments
        SET status = 'accepted',
            rider_id = ${riderId},
            accepted_at = NOW()
        WHERE id = ${assignmentId}::uuid
          AND (status = 'assigned' OR status = 'searching')
        RETURNING *
      `;

      if (!result || result.length === 0) {
        this.logger.warn(`Assignment ${assignmentId} not found or not in assignable state`);
        return null;
      }

      this.logger.log(`Rider #${riderId} accepted assignment ${assignmentId} for order #${result[0].order_id}`);
      return result[0];
    } catch (error) {
      this.logger.error(`Failed to accept assignment ${assignmentId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Mark assignment as picked up (rider has the order).
   */
  async markPickedUp(assignmentId: string): Promise<RiderAssignment | null> {
    try {
      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        UPDATE rider_assignments
        SET status = 'picked_up',
            picked_up_at = NOW()
        WHERE id = ${assignmentId}::uuid
          AND status = 'accepted'
        RETURNING *
      `;

      if (!result || result.length === 0) {
        this.logger.warn(`Assignment ${assignmentId} not found or not in accepted state`);
        return null;
      }

      this.logger.log(`Order #${result[0].order_id} picked up by rider #${result[0].rider_id}`);
      return result[0];
    } catch (error) {
      this.logger.error(`Failed to mark picked up for assignment ${assignmentId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Mark assignment as delivered. Calculates earnings and actual delivery time.
   */
  async markDelivered(assignmentId: string, moduleId: number = 4): Promise<RiderAssignment | null> {
    try {
      // First fetch the assignment to get details for earnings calculation
      const existing = await this.prisma.$queryRaw<RiderAssignment[]>`
        SELECT * FROM rider_assignments WHERE id = ${assignmentId}::uuid
      `;

      if (!existing || existing.length === 0) {
        this.logger.warn(`Assignment ${assignmentId} not found`);
        return null;
      }

      const assignment = existing[0];

      if (assignment.status !== 'picked_up') {
        this.logger.warn(`Assignment ${assignmentId} not in picked_up state (current: ${assignment.status})`);
        return null;
      }

      // Calculate earnings based on distance
      const distanceKm = Number(assignment.distance_km) || 0;
      const earnings = this.calculateRiderEarnings(distanceKm, moduleId);

      // Calculate actual delivery time
      let actualTimeMin: number | null = null;
      if (assignment.accepted_at) {
        const acceptedAt = new Date(assignment.accepted_at).getTime();
        const now = Date.now();
        actualTimeMin = Math.ceil((now - acceptedAt) / 60000);
      }

      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        UPDATE rider_assignments
        SET status = 'delivered',
            delivered_at = NOW(),
            earnings = ${earnings.totalEarning},
            actual_time_min = ${actualTimeMin}
        WHERE id = ${assignmentId}::uuid
        RETURNING *
      `;

      if (result && result.length > 0) {
        this.logger.log(
          `Order #${result[0].order_id} delivered by rider #${result[0].rider_id}. ` +
          `Earnings: ${earnings.totalEarning}, Actual time: ${actualTimeMin}min`,
        );
      }

      return result?.[0] || null;
    } catch (error) {
      this.logger.error(`Failed to mark delivered for assignment ${assignmentId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Cancel an assignment. If retries are available, triggers retry with expanded radius.
   */
  async cancelAssignment(assignmentId: string, reason: string): Promise<RiderAssignment | null> {
    try {
      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        UPDATE rider_assignments
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancel_reason = ${reason}
        WHERE id = ${assignmentId}::uuid
          AND status NOT IN ('delivered', 'cancelled')
        RETURNING *
      `;

      if (!result || result.length === 0) {
        this.logger.warn(`Assignment ${assignmentId} not found or already completed`);
        return null;
      }

      const assignment = result[0];
      this.logger.log(`Assignment ${assignmentId} for order #${assignment.order_id} cancelled: ${reason}`);

      // If we haven't exhausted search attempts, retry with expanded radius
      if (assignment.search_attempts < assignment.max_search_attempts) {
        this.logger.log(`Retrying assignment for order #${assignment.order_id} (attempt ${assignment.search_attempts + 1})`);
        await this.retryAssignment(assignmentId);
      } else {
        this.logger.warn(`Max search attempts reached for order #${assignment.order_id}`);
      }

      return assignment;
    } catch (error) {
      this.logger.error(`Failed to cancel assignment ${assignmentId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Get the current assignment for an order.
   */
  async getAssignment(orderId: number): Promise<RiderAssignment | null> {
    try {
      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        SELECT * FROM rider_assignments
        WHERE order_id = ${orderId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      return result?.[0] || null;
    } catch (error) {
      this.logger.error(`Failed to get assignment for order #${orderId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Get all active assignments for a rider.
   */
  async getRiderActiveAssignments(riderId: number): Promise<RiderAssignment[]> {
    try {
      const result = await this.prisma.$queryRaw<RiderAssignment[]>`
        SELECT * FROM rider_assignments
        WHERE rider_id = ${riderId}
          AND status IN ('assigned', 'accepted', 'picked_up')
        ORDER BY created_at DESC
      `;

      return result || [];
    } catch (error) {
      this.logger.error(`Failed to get active assignments for rider #${riderId}: ${error.message}`, error.stack);
      return [];
    }
  }

  // ============================================
  // EARNINGS CALCULATION
  // ============================================

  /**
   * Calculate rider earnings based on distance and module type.
   * Module IDs: 3=Parcel, 4=Food, 5=E-commerce
   */
  calculateRiderEarnings(distanceKm: number, moduleId: number = 4): RiderEarnings {
    const rates = EARNING_RATES[moduleId] || DEFAULT_EARNING_RATES;

    const baseEarning = rates.baseFare;
    const distanceEarning = parseFloat((distanceKm * rates.perKmRate).toFixed(2));
    const subtotal = baseEarning + distanceEarning;
    const surgeBonus = parseFloat((subtotal * (rates.surgeMultiplier - 1)).toFixed(2));
    const totalBeforeMin = subtotal + surgeBonus;
    const totalEarning = parseFloat(Math.max(totalBeforeMin, rates.minimumFare).toFixed(2));

    return {
      baseEarning,
      distanceEarning,
      surgeBonus,
      totalEarning,
    };
  }

  // ============================================
  // RETRY LOGIC
  // ============================================

  /**
   * Retry assignment with expanded search radius.
   * Creates a new assignment record with incremented attempts and wider radius.
   */
  async retryAssignment(assignmentId: string): Promise<RiderAssignment | null> {
    try {
      // Get the cancelled assignment details
      const existing = await this.prisma.$queryRaw<RiderAssignment[]>`
        SELECT * FROM rider_assignments WHERE id = ${assignmentId}::uuid
      `;

      if (!existing || existing.length === 0) {
        this.logger.warn(`Assignment ${assignmentId} not found for retry`);
        return null;
      }

      const prev = existing[0];
      const newAttempts = prev.search_attempts + 1;
      const newRadius = parseFloat((Number(prev.search_radius_km) * this.radiusExpansionFactor).toFixed(1));

      if (newAttempts > prev.max_search_attempts) {
        this.logger.warn(`Max search attempts (${prev.max_search_attempts}) exceeded for order #${prev.order_id}`);
        return null;
      }

      this.logger.log(
        `Retry #${newAttempts} for order #${prev.order_id}: expanding radius to ${newRadius}km`,
      );

      // We need the store location to search again. Fetch from Redis or create
      // a new searching assignment for the orchestration layer to pick up.
      const newAssignment = await this.createAssignment({
        orderId: prev.order_id,
        storeId: prev.store_id,
        riderId: null,
        status: 'searching',
        searchAttempts: newAttempts,
        searchRadiusKm: newRadius,
      });

      return newAssignment;
    } catch (error) {
      this.logger.error(`Failed to retry assignment ${assignmentId}: ${error.message}`, error.stack);
      return null;
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Create a new assignment record in the database.
   */
  private async createAssignment(params: {
    orderId: number;
    storeId: number;
    riderId: number | null;
    status: RiderAssignmentStatus;
    distanceKm?: number;
    estimatedTimeMin?: number;
    searchAttempts?: number;
    searchRadiusKm?: number;
  }): Promise<RiderAssignment> {
    const {
      orderId,
      storeId,
      riderId,
      status,
      distanceKm,
      estimatedTimeMin,
      searchAttempts = 0,
      searchRadiusKm = this.defaultSearchRadiusKm,
    } = params;

    const assignedAt = riderId ? new Date() : null;

    const result = await this.prisma.$queryRaw<RiderAssignment[]>`
      INSERT INTO rider_assignments (
        order_id, rider_id, store_id, status, assigned_at,
        distance_km, estimated_time_min, search_attempts,
        max_search_attempts, search_radius_km
      ) VALUES (
        ${orderId}, ${riderId}, ${storeId}, ${status}, ${assignedAt},
        ${distanceKm || null}, ${estimatedTimeMin || null}, ${searchAttempts},
        ${this.maxSearchAttempts}, ${searchRadiusKm}
      )
      RETURNING *
    `;

    return result[0];
  }

  /**
   * Haversine formula to calculate distance between two coordinates.
   * Returns distance in kilometers.
   */
  private haversineDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }
}
