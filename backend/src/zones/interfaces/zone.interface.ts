/**
 * Zone-related interfaces for Mangwale delivery system
 */

/**
 * Geographic coordinate point
 */
export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Zone polygon coordinates
 * Following GeoJSON Polygon format
 */
export interface ZoneCoordinates {
  type: 'Polygon';
  coordinates: number[][][]; // Array of linear rings (first is exterior, rest are holes)
}

/**
 * Zone entity from PHP backend
 */
export interface Zone {
  id: number;
  name: string;
  display_name?: string;
  coordinates: ZoneCoordinates;
  status: number; // 1 = active, 0 = inactive
  store_wise_topic?: string;
  customer_wise_topic?: string;
  deliveryman_wise_topic?: string;
  cash_on_delivery: boolean;
  digital_payment: boolean;
  offline_payment?: boolean;
  increased_delivery_fee?: number;
  increased_delivery_fee_status?: number;
  increase_delivery_charge_message?: string;
  created_at?: string;
  updated_at?: string;
  modules?: ZoneModule[];
}

/**
 * Module availability per zone
 */
export interface ZoneModule {
  id: number;
  module_name: string;
  module_type: string;
  per_km_shipping_charge: number;
  minimum_shipping_charge: number;
  maximum_shipping_charge: number;
  maximum_cod_order_amount?: number;
  delivery_charge_type?: 'fixed' | 'distance';
  fixed_shipping_charge?: number;
  pivot?: {
    per_km_shipping_charge: number | null;
    minimum_shipping_charge: number | null;
    maximum_shipping_charge: number | null;
    delivery_charge_type?: string;
    fixed_shipping_charge?: number | null;
  };
}

/**
 * Per-module delivery rate extracted from zone-module pivot
 */
export interface ModuleDeliveryRate {
  moduleId: number;
  moduleName: string;
  perKmCharge: number;
  minCharge: number;
  maxCharge: number | null;
  chargeType: 'fixed' | 'distance';
  fixedCharge: number | null;
}

/**
 * Zone detection result
 */
export interface ZoneDetectionResult {
  zone_id: number;
  zone_name: string;
  zone_data: Zone;
  is_serviceable: boolean;
  available_modules: string[];
  payment_methods: {
    cash_on_delivery: boolean;
    digital_payment: boolean;
    offline_payment: boolean;
  };
  /** Per-module delivery rates from zone-module pivot table, keyed by module ID */
  delivery_rates?: Record<number, ModuleDeliveryRate>;
}

/**
 * Store location information
 */
export interface StoreLocation {
  store_id: number;
  store_name?: string;
  latitude: number;
  longitude: number;
  zone_id: number;
  zone_name?: string;
  address?: string;
  module_id?: number;
  module_type?: string;
}

/**
 * Delivery availability check result
 */
export interface DeliveryAvailability {
  is_available: boolean;
  user_zone_id: number;
  store_zone_id: number;
  same_zone: boolean;
  reason?: string;
  estimated_delivery_time_min?: number;
  delivery_distance_km?: number;
}

/**
 * Zone-filtered search result
 */
export interface ZoneFilteredResult<T> {
  items: T[];
  total_count: number;
  filtered_count: number;
  user_zone: {
    id: number;
    name: string;
  };
  removed_count: number;
  removed_reasons: {
    different_zone: number;
    store_inactive: number;
    out_of_delivery_radius: number;
  };
}
