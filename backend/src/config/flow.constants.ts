/**
 * Flow Constants — single source of truth for all flow-related magic values.
 *
 * MODULE IDs must match PHP backend (ground truth):
 *   3 = Parcel (Local Delivery)
 *   4 = Food
 *   5 = Shop (E-commerce)
 */

// ── Module IDs (PHP ground truth) ────────────────────────────────────────────
export const MODULE_ID = {
  PARCEL: 3,
  FOOD: 4,
  ECOMMERCE: 5,
} as const;

// ── Special message tokens ───────────────────────────────────────────────────
export const TOKEN = {
  LOCATION: '__LOCATION__',
  PAYMENT_SUCCESS: '__payment_success__',
  PAYMENT_FAILED: '__payment_failed__',
  SKIP: '__skip__',
} as const;

// ── Timeouts (ms) ────────────────────────────────────────────────────────────
export const TIMEOUT = {
  PAYMENT: 300_000,       // 5 min — waiting for payment callback
  ADDRESS: 300_000,       // 5 min — collecting address
  SHORT_INPUT: 120_000,   // 2 min — name, email, OTP
  PROFILE_ANSWER: 30_000, // 30 sec — onboarding profile question
} as const;

// ── Search defaults ──────────────────────────────────────────────────────────
export const SEARCH = {
  DEFAULT_RADIUS: '5km',
  FALLBACK_RADIUS: '10km',
  EXTERNAL_RADIUS_METERS: 25_000,  // 25 km
  GEOCODE_RADIUS_METERS: 25_000,
  RESULT_LIMIT: 15,
  FALLBACK_RESULT_LIMIT: 20,
  CATEGORY_LIMIT: 8,
  STORE_LIMIT: 10,
  UPSELL_LIMIT: 3,
  CROSS_SELL_LIMIT: 2,
  ORDER_HISTORY_LIMIT: 10,
  ECOM_RESULT_LIMIT: 15,
} as const;

// ── States where greeting should NOT reset the flow ──────────────────────────
export const GREETING_CRITICAL_STATES = [
  'wait_payment_selection', 'select_payment_method', 'select_payment_method_fallback',
  'handle_payment_selection', 'confirm_order', 'show_summary',
  'wait_for_pickup', 'wait_for_delivery', 'collect_recipient', 'wait_recipient',
  'wait_confirmation', 'wait_vehicle_selection', 'confirm_checkout',
  'wait_quantity', 'wait_size', 'wait_addon_selection',
  'show_categories', 'show_categories_retry',
  'collect_pickup', 'collect_delivery', 'extract_pickup_address', 'extract_delivery_address',
  'collect_address_input', 'collect_address', 'await_flow_address',
  'wait_address_label', 'validate_address',
  'prompt_coupon_code', 'wait_coupon_input', 'apply_coupon',
  'prompt_tip', 'wait_tip_input', 'show_final_summary', 'wait_order_confirm',
  'wait_after_add', 'show_cart', 'check_cart_action',
  'show_order_summary', 'check_final_confirmation', 'wait_order_summary_confirm',
  'apply_coupon_code', 'coupon_applied', 'coupon_invalid',
  'calculate_pricing', 'confirm_order_details',
  'wait_payment_result', 'wait_food_payment_result',
  'await_payment_retry', 'await_food_payment_retry',
  'request_location', 'handle_location_response', 'ask_location',
  'request_phone', 'verify_otp', 'otp_retry', 'collect_phone', 'ask_for_otp',
  'ask_name', 'ask_email',
] as const;

// ── States where flow switching should be blocked ────────────────────────────
export const FLOW_SWITCH_BLOCKED_STATES = [
  ...GREETING_CRITICAL_STATES,
  'collect_pickup_location', 'collect_delivery_location',
  'wait_pickup_address', 'wait_delivery_address',
] as const;

// ── Location-wait states ─────────────────────────────────────────────────────
export const LOCATION_WAIT_STATES = [
  'request_location', 'handle_location_response', 'ask_location',
  'collect_address_input', 'collect_address', 'await_flow_address',
  'wait_address_label', 'validate_address',
  'collect_pickup_location', 'collect_delivery_location',
  'wait_pickup_address', 'wait_delivery_address',
] as const;
