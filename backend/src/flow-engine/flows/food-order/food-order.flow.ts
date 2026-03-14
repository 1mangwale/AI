import { FlowDefinition } from '../../types/flow.types';
import { entryAndTriggerStates } from './states/entry-and-trigger';
import { authAndAddressStates } from './states/auth-and-address';
import { searchAndBrowseStates } from './states/search-and-browse';
import { cartAndSelectionStates } from './states/cart-and-selection';
import { checkoutAndPaymentStates } from './states/checkout-and-payment';
import { finalStatesStates } from './states/final-states';

/**
 * Food Order Flow — Main Orchestrator
 *
 * Complete food ordering flow with search, selection, address, and payment.
 * States are split into sub-modules for maintainability:
 *
 * - entry-and-trigger.ts     — 9 states  (trigger detection, express order, quick order)
 * - auth-and-address.ts      — 18 states (login, location, saved addresses)
 * - search-and-browse.ts     — 82 states (search, browse, categories, recommendations, external vendors)
 * - cart-and-selection.ts     — 51 states (item selection, variants, addons, cart CRUD, upsells)
 * - checkout-and-payment.ts  — 96 states (payment, checkout, OTP, address, zone, surge, order placement)
 * - final-states.ts          — 6 states  (completed, cancelled, error states)
 *
 * Total: 262 states
 */
export const foodOrderFlow: FlowDefinition = {
  id: 'food_order_v1',
  name: 'Food Order Flow',
  description: 'Complete food ordering flow with search, selection, address, and payment',
  module: 'food',
  trigger: 'order_food|browse_menu|browse_category|ask_recommendation|ask_famous|check_availability|ask_fastest_delivery|quick_reorder|order_again|reorder',
  version: '1.0.0',

  contextSchema: {
    search_query: { type: 'string', required: false },
    search_results: { type: 'array', required: false },
    selected_items: { type: 'array', required: true },
    delivery_address: { type: 'object', required: true },
    distance: { type: 'number', required: true },
    pricing: { type: 'object', required: true },
    order_result: { type: 'object', required: false },
    // Custom Order / Parcel Fallback Context
    custom_pickup_location: { type: 'object', required: false },
    custom_item_details: { type: 'string', required: false },
    is_custom_order: { type: 'boolean', required: false },
  },

  states: {
    ...entryAndTriggerStates,
    ...authAndAddressStates,
    ...searchAndBrowseStates,
    ...cartAndSelectionStates,
    ...checkoutAndPaymentStates,
    ...finalStatesStates,
  },

  initialState: 'check_trigger',
  finalStates: ['completed', 'cancelled', 'address_error', 'out_of_zone', 'distance_error', 'order_failed'],
};
