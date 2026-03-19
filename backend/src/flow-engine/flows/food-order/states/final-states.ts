import { FlowState } from '../../../types/flow.types';
import { MODULE_ID } from '../../../../config/flow.constants';

/**
 * Food Order Flow — Final States States
 * Auto-extracted from food-order.flow.ts
 */
export const finalStatesStates: Record<string, FlowState> = {
    completed: {
      type: 'end',
      description: 'Order successfully placed',
      actions: [
        {
          id: 'success_message',
          executor: 'response',
          config: {
            message: '🎉 **Order placed! Your food is on its way!** 🍴\n\n✅ Order ID: #{{order_result.orderId}}\n💰 Total: ₹{{order_result.orderTotal}}\n📍 Delivering to: {{delivery_address.label}}\n⏱️ ETA: 30–45 minutes\n\nI\'ll keep you posted on WhatsApp every step of the way! 📱',
            metadata: {
              order_tracking: {
                orderId: '{{order_result.orderId}}',
                storeName: '{{selected_store.name}}',
              },
            },
          },
          output: '_last_response',
        },
        {
          id: 'learn_from_order',
          executor: 'profile',
          config: {
            action: 'learn_from_order',
          },
          output: '_profile_learned',
        },
        {
          id: 'track_purchase_for_recs',
          executor: 'recommendation',
          config: { action: 'track_purchase', moduleId: MODULE_ID.FOOD },
          output: '_rec_purchase_tracked',
        },
        {
          id: 'post_order_question',
          executor: 'profile',
          config: {
            action: 'ask_question',
            context: 'post_food_order',
            onlyIfIncomplete: true,
          },
          output: '_profile_question',
        },
        {
          id: 'save_last_delivery_address',
          executor: 'response',
          config: {
            // Save delivery address so next order can auto-offer it without re-asking
            saveToContext: {
              last_delivery_address: '{{delivery_address}}',
            },
            event: 'saved',
          },
          output: '_address_saved',
        },
        {
          id: 'persist_order_id',
          executor: 'session',
          config: {
            // Persist orderId to session so "track my order" works instantly after placement
            action: 'save',
            key: 'last_order_id',
            valuePath: 'order_result.orderId',
          },
          output: '_order_id_persisted',
        },
      ],
      transitions: {},
    },

    address_error: {
      type: 'end',
      description: 'Failed to get valid address',
      actions: [
        {
          id: 'error_message',
          executor: 'response',
          config: {
            message: 'Sorry, we couldn\'t understand your delivery address. Please try ordering again.',
          },
        },
      ],
      transitions: {},
    },

    out_of_zone: {
      type: 'end',
      description: 'Delivery location outside service area',
      actions: [
        {
          id: 'zone_error',
          executor: 'response',
          config: {
            message: 'Sorry, we don\'t deliver to this location yet. We currently serve Nashik city. We\'ll notify you when we expand!',
          },
        },
      ],
      transitions: {},
    },

    distance_error: {
      type: 'end',
      description: 'Failed to calculate distance',
      actions: [
        {
          id: 'error_message',
          executor: 'response',
          config: {
            message: 'Sorry, we encountered an error calculating delivery distance. Please try again.',
          },
        },
      ],
      transitions: {},
    },

    order_failed: {
      type: 'end',
      description: 'Order placement failed',
      actions: [
        {
          id: 'failure_message',
          executor: 'response',
          config: {
            message: 'Sorry, we couldn\'t place your order right now. Please try again in a few minutes.',
          },
        },
      ],
      transitions: {},
    },

    cancelled: {
      type: 'end',
      description: 'User cancelled the order',
      actions: [
        {
          id: 'cancel_message',
          executor: 'response',
          config: {
            message: 'No worries! Your order has been cancelled. Come back when you\'re hungry! 🍕',
          },
        },
      ],
      transitions: {},
    },

};
