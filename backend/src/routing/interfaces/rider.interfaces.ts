/**
 * Rider Assignment & Delivery Tracking Interfaces
 *
 * Types for rider assignment, location tracking, earnings calculation,
 * and delivery timeline management.
 */

// ============================================
// RIDER ASSIGNMENT
// ============================================

export type RiderAssignmentStatus =
  | 'searching'
  | 'assigned'
  | 'accepted'
  | 'picked_up'
  | 'delivered'
  | 'cancelled'
  | 'expired';

export interface RiderAssignment {
  id: string;
  order_id: number;
  rider_id: number | null;
  store_id: number;
  status: RiderAssignmentStatus;
  assigned_at: Date | null;
  accepted_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  distance_km: number | null;
  estimated_time_min: number | null;
  actual_time_min: number | null;
  earnings: number | null;
  search_attempts: number;
  max_search_attempts: number;
  search_radius_km: number;
  created_at: Date;
}

export interface CreateRiderAssignment {
  order_id: number;
  store_id: number;
  rider_id?: number;
  distance_km?: number;
  estimated_time_min?: number;
}

// ============================================
// RIDER LOCATION
// ============================================

export interface RiderLocation {
  riderId: number;
  lat: number;
  lng: number;
  timestamp: number;
  speed?: number;
  heading?: number;
}

export interface NearbyRider {
  riderId: number;
  lat: number;
  lng: number;
  distanceKm: number;
  isOnline: boolean;
}

// ============================================
// DELIVERY TIMELINE
// ============================================

export type DeliveryStage =
  | 'order_placed'
  | 'searching_rider'
  | 'rider_assigned'
  | 'rider_accepted'
  | 'rider_at_store'
  | 'picked_up'
  | 'in_transit'
  | 'arriving'
  | 'delivered'
  | 'cancelled';

export interface DeliveryTimelineStage {
  stage: DeliveryStage;
  timestamp: Date | null;
  location?: {
    lat: number;
    lng: number;
  };
  description?: string;
}

export interface DeliveryTimeline {
  orderId: number;
  assignmentId: string;
  currentStage: DeliveryStage;
  stages: DeliveryTimelineStage[];
  estimatedDeliveryTime?: Date;
}

// ============================================
// RIDER EARNINGS
// ============================================

export interface RiderEarnings {
  baseEarning: number;
  distanceEarning: number;
  surgeBonus: number;
  totalEarning: number;
}

export interface EarningsConfig {
  baseFare: number;
  perKmRate: number;
  surgeMultiplier: number;
  minimumFare: number;
}

// ============================================
// MODULE-SPECIFIC EARNING RATES
// ============================================

export const EARNING_RATES: Record<number, EarningsConfig> = {
  // Module 3 = Parcel (Local Delivery)
  3: {
    baseFare: 25,
    perKmRate: 8,
    surgeMultiplier: 1.0,
    minimumFare: 30,
  },
  // Module 4 = Food
  4: {
    baseFare: 20,
    perKmRate: 7,
    surgeMultiplier: 1.0,
    minimumFare: 25,
  },
  // Module 5 = Shop (E-commerce)
  5: {
    baseFare: 30,
    perKmRate: 10,
    surgeMultiplier: 1.0,
    minimumFare: 35,
  },
};

// Default rates if module not found
export const DEFAULT_EARNING_RATES: EarningsConfig = {
  baseFare: 20,
  perKmRate: 7,
  surgeMultiplier: 1.0,
  minimumFare: 25,
};
