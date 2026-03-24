/**
 * Canonical order status constants.
 * ALL status→emoji and status→label mappings MUST reference this file.
 * Do NOT define local maps in individual services/executors.
 */

export const ORDER_STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  confirmed: '✅',
  processing: '📦',
  preparing: '👨‍🍳',
  handover: '🤝',
  ready: '📦',
  picked_up: '🚚',
  in_transit: '🚴',
  out_for_delivery: '🛵',
  delivered: '✅',
  canceled: '❌',
  cancelled: '❌',
  refunded: '💰',
  failed: '⚠️',
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Preparing',
  preparing: 'Being Prepared',
  handover: 'Ready for Pickup',
  ready: 'Ready for Pickup',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  canceled: 'Cancelled',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  failed: 'Failed',
};

export function getStatusEmoji(status: string): string {
  return ORDER_STATUS_EMOJI[status] || '📋';
}

export function getStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] || status;
}
