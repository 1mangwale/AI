import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER } from '../../redis/redis.module';
import {
  RiderLocation,
  DeliveryTimeline,
  DeliveryStage,
  DeliveryTimelineStage,
  RiderAssignment,
} from '../interfaces/rider.interfaces';

/**
 * Delivery Tracking Service
 *
 * Real-time rider location tracking and delivery timeline management.
 *
 * Redis keys:
 * - rider:location:{riderId}   — JSON with lat, lng, timestamp, speed, heading (TTL 300s)
 * - rider:online:{riderId}     — "1" presence flag (TTL 600s)
 * - rider:location:updates     — Pub/sub channel for location broadcasts
 *
 * Location updates are published to Redis pub/sub so that websocket gateways
 * or SSE endpoints can forward them to customers in real-time.
 */
@Injectable()
export class DeliveryTrackingService {
  private readonly logger = new Logger(DeliveryTrackingService.name);

  // TTLs in seconds
  private readonly locationTtl = 300;     // 5 minutes
  private readonly onlineTtl = 600;       // 10 minutes
  private readonly averageSpeedKmh = 25;  // Average delivery speed for ETA

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {
    this.logger.log('Delivery tracking service initialized');
  }

  // ============================================
  // RIDER LOCATION MANAGEMENT
  // ============================================

  /**
   * Update a rider's location in Redis and publish the update.
   * Called by the rider app on each GPS tick (every 5-10 seconds during delivery).
   */
  async updateRiderLocation(
    riderId: number,
    lat: number,
    lng: number,
    speed?: number,
    heading?: number,
  ): Promise<void> {
    try {
      const location: RiderLocation = {
        riderId,
        lat,
        lng,
        timestamp: Date.now(),
        speed,
        heading,
      };

      const key = `rider:location:${riderId}`;
      const payload = JSON.stringify(location);

      // Store location with TTL (auto-expires if rider stops sending updates)
      await this.redis.set(key, payload, 'EX', this.locationTtl);

      // Publish update for real-time subscribers (websocket, SSE)
      await this.publisher.publish('rider:location:updates', payload);

      this.logger.debug(`Location updated for rider #${riderId}: ${lat},${lng}`);
    } catch (error) {
      this.logger.error(`Failed to update location for rider #${riderId}: ${error.message}`, error.stack);
    }
  }

  /**
   * Get a rider's last known location.
   */
  async getRiderLocation(riderId: number): Promise<RiderLocation | null> {
    try {
      const key = `rider:location:${riderId}`;
      const data = await this.redis.get(key);

      if (!data) {
        this.logger.debug(`No location data for rider #${riderId}`);
        return null;
      }

      return JSON.parse(data) as RiderLocation;
    } catch (error) {
      this.logger.error(`Failed to get location for rider #${riderId}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Get all active riders with their locations.
   * Optionally filter by a zone (not yet implemented — returns all).
   */
  async getActiveRiders(zoneId?: string): Promise<RiderLocation[]> {
    try {
      const riders: RiderLocation[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          'rider:location:*',
          'COUNT',
          100,
        );
        cursor = nextCursor;

        if (keys.length === 0) continue;

        // Batch fetch all location values
        const values = await this.redis.mget(...keys);

        for (let i = 0; i < keys.length; i++) {
          const data = values[i];
          if (!data) continue;

          try {
            const location = JSON.parse(data) as RiderLocation;
            riders.push(location);
          } catch (parseError) {
            this.logger.warn(`Failed to parse location data for key ${keys[i]}`);
          }
        }
      } while (cursor !== '0');

      this.logger.debug(`Found ${riders.length} active rider locations`);
      return riders;
    } catch (error) {
      this.logger.error(`Failed to get active riders: ${error.message}`, error.stack);
      return [];
    }
  }

  // ============================================
  // ETA CALCULATION
  // ============================================

  /**
   * Calculate estimated time of arrival from rider to destination.
   * Uses haversine distance with average speed estimate.
   * Returns ETA in minutes.
   */
  calculateETA(
    riderLat: number,
    riderLng: number,
    destLat: number,
    destLng: number,
  ): number {
    const distanceKm = this.haversineDistance(riderLat, riderLng, destLat, destLng);

    // Time = distance / speed, converted to minutes
    const timeMin = (distanceKm / this.averageSpeedKmh) * 60;

    // Add 2 min buffer for traffic signals, navigation
    const etaMin = Math.ceil(timeMin) + 2;

    this.logger.debug(
      `ETA: ${distanceKm.toFixed(2)}km at ${this.averageSpeedKmh}km/h = ${etaMin}min`,
    );

    return etaMin;
  }

  /**
   * Calculate live ETA for an active delivery.
   * Fetches current rider location and computes ETA to destination.
   */
  async calculateLiveETA(
    riderId: number,
    destLat: number,
    destLng: number,
  ): Promise<{ etaMin: number; distanceKm: number } | null> {
    const riderLocation = await this.getRiderLocation(riderId);

    if (!riderLocation) {
      this.logger.warn(`Cannot calculate live ETA: no location for rider #${riderId}`);
      return null;
    }

    const distanceKm = this.haversineDistance(
      riderLocation.lat,
      riderLocation.lng,
      destLat,
      destLng,
    );

    // Use rider's actual speed if available, else average
    const speed = riderLocation.speed && riderLocation.speed > 0
      ? riderLocation.speed
      : this.averageSpeedKmh;

    const etaMin = Math.ceil((distanceKm / speed) * 60) + 2;

    return {
      etaMin,
      distanceKm: parseFloat(distanceKm.toFixed(2)),
    };
  }

  // ============================================
  // LOCATION SUBSCRIPTIONS (PUB/SUB)
  // ============================================

  /**
   * Subscribe to location updates for a specific rider.
   * Used by websocket gateways to push real-time updates to customers.
   */
  subscribeToLocationUpdates(
    riderId: number,
    callback: (location: RiderLocation) => void,
  ): () => void {
    const channel = 'rider:location:updates';

    const messageHandler = (ch: string, message: string) => {
      if (ch !== channel) return;

      try {
        const location = JSON.parse(message) as RiderLocation;
        if (location.riderId === riderId) {
          callback(location);
        }
      } catch (error) {
        this.logger.warn(`Failed to parse location update message: ${error.message}`);
      }
    };

    this.subscriber.subscribe(channel).catch((error) => {
      this.logger.error(`Failed to subscribe to ${channel}: ${error.message}`);
    });

    this.subscriber.on('message', messageHandler);

    // Return unsubscribe function
    return () => {
      this.subscriber.removeListener('message', messageHandler);
      // Note: we don't unsubscribe from the channel because other listeners
      // may still be using it. The subscriber module handles cleanup on destroy.
    };
  }

  // ============================================
  // DELIVERY TIMELINE
  // ============================================

  /**
   * Build a delivery timeline from the assignment record.
   * Shows the progression of stages with timestamps.
   */
  getDeliveryTimeline(assignment: RiderAssignment): DeliveryTimeline {
    const stages: DeliveryTimelineStage[] = [];

    // Stage 1: Order placed (always present)
    stages.push({
      stage: 'order_placed',
      timestamp: assignment.created_at,
      description: 'Order has been placed',
    });

    // Stage 2: Searching for rider
    if (assignment.status === 'searching') {
      stages.push({
        stage: 'searching_rider',
        timestamp: assignment.created_at,
        description: `Searching for rider (attempt ${assignment.search_attempts})`,
      });
    }

    // Stage 3: Rider assigned
    if (assignment.assigned_at) {
      stages.push({
        stage: 'rider_assigned',
        timestamp: assignment.assigned_at,
        description: `Rider #${assignment.rider_id} assigned`,
      });
    }

    // Stage 4: Rider accepted
    if (assignment.accepted_at) {
      stages.push({
        stage: 'rider_accepted',
        timestamp: assignment.accepted_at,
        description: 'Rider is on the way to the store',
      });
    }

    // Stage 5: Picked up
    if (assignment.picked_up_at) {
      stages.push({
        stage: 'picked_up',
        timestamp: assignment.picked_up_at,
        description: 'Order picked up from store',
      });
    }

    // Stage 6: Delivered
    if (assignment.delivered_at) {
      stages.push({
        stage: 'delivered',
        timestamp: assignment.delivered_at,
        description: 'Order delivered',
      });
    }

    // Stage: Cancelled
    if (assignment.cancelled_at) {
      stages.push({
        stage: 'cancelled',
        timestamp: assignment.cancelled_at,
        description: assignment.cancel_reason || 'Assignment cancelled',
      });
    }

    // Determine current stage
    let currentStage: DeliveryStage = 'order_placed';
    if (assignment.status === 'searching') currentStage = 'searching_rider';
    else if (assignment.status === 'assigned') currentStage = 'rider_assigned';
    else if (assignment.status === 'accepted') currentStage = 'rider_accepted';
    else if (assignment.status === 'picked_up') currentStage = 'in_transit';
    else if (assignment.status === 'delivered') currentStage = 'delivered';
    else if (assignment.status === 'cancelled') currentStage = 'cancelled';

    // Calculate estimated delivery time
    let estimatedDeliveryTime: Date | undefined;
    if (assignment.accepted_at && assignment.estimated_time_min) {
      estimatedDeliveryTime = new Date(
        new Date(assignment.accepted_at).getTime() +
          assignment.estimated_time_min * 60000,
      );
    }

    return {
      orderId: assignment.order_id,
      assignmentId: assignment.id,
      currentStage,
      stages,
      estimatedDeliveryTime,
    };
  }

  // ============================================
  // RIDER ONLINE STATUS
  // ============================================

  /**
   * Set a rider as online. Called when rider opens the app and starts shift.
   */
  async setRiderOnline(riderId: number): Promise<void> {
    try {
      const key = `rider:online:${riderId}`;
      await this.redis.set(key, '1', 'EX', this.onlineTtl);

      this.logger.log(`Rider #${riderId} is now online`);
    } catch (error) {
      this.logger.error(`Failed to set rider #${riderId} online: ${error.message}`, error.stack);
    }
  }

  /**
   * Set a rider as offline. Called when rider ends shift or closes app.
   */
  async setRiderOffline(riderId: number): Promise<void> {
    try {
      await this.redis.del(`rider:online:${riderId}`);
      await this.redis.del(`rider:location:${riderId}`);

      this.logger.log(`Rider #${riderId} is now offline`);
    } catch (error) {
      this.logger.error(`Failed to set rider #${riderId} offline: ${error.message}`, error.stack);
    }
  }

  /**
   * Get all currently online riders.
   */
  async getOnlineRiders(): Promise<number[]> {
    try {
      const riderIds: number[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          'rider:online:*',
          'COUNT',
          100,
        );
        cursor = nextCursor;

        for (const key of keys) {
          const riderId = parseInt(key.split(':').pop() || '0', 10);
          if (riderId) {
            riderIds.push(riderId);
          }
        }
      } while (cursor !== '0');

      this.logger.debug(`Found ${riderIds.length} online riders`);
      return riderIds;
    } catch (error) {
      this.logger.error(`Failed to get online riders: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Refresh rider's online TTL. Called periodically (heartbeat) by rider app.
   */
  async refreshOnlineStatus(riderId: number): Promise<void> {
    try {
      const key = `rider:online:${riderId}`;
      const exists = await this.redis.exists(key);

      if (exists) {
        await this.redis.expire(key, this.onlineTtl);
      } else {
        await this.setRiderOnline(riderId);
      }
    } catch (error) {
      this.logger.error(`Failed to refresh online status for rider #${riderId}: ${error.message}`, error.stack);
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

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
    const R = 6371;
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
