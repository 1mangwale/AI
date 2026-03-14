import { FlowState } from '../../../types/flow.types';

/**
 * Food Order Flow — Entry And Trigger States
 * Auto-extracted from food-order.flow.ts
 */
export const entryAndTriggerStates: Record<string, FlowState> = {
    check_trigger: {
      type: 'decision',
      description: 'Check if user already specified what they want',
      conditions: [
        {
          // If message is long enough and not just a greeting, assume it's a query
          // Check both user_message and _user_message to be safe
          expression: '(context.user_message || context._user_message) && (context.user_message || context._user_message).length > 3 && !["hi", "hello", "hey", "start", "order_food", "order food", "food", "khana", "khaana"].includes((context.user_message || context._user_message).toLowerCase().trim())',
          event: 'has_query',
        }
      ],
      transitions: {
        has_query: 'detect_express_order',
        default: 'greet_user',
      },
    },

    detect_express_order: {
      type: 'action',
      description: 'Detect if user provided complete order using NLU entities',
      actions: [
        {
          id: 'nlu_extract',
          executor: 'nlu',
          config: {
            input: '{{_user_message}}',
            extractEntities: true,
          },
          output: 'nlu_result',
        },
        {
          // Map NLU entities to express_order_detection format
          id: 'check_express',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              express_order_detection: {
                food_items: '{{nlu_result.entities.food_reference || []}}',
                restaurant: '{{nlu_result.entities.store_reference || null}}',
                // delivery_type (home/office) is extracted by regex from "home address", "ghar", "office"
                // location_reference is extracted by NER for actual place names
                delivery_address_type: '{{nlu_result.entities.delivery_type || nlu_result.entities.location_reference || null}}',
                // 🆕 Capture quantity (e.g., "5" in "add 5 samosa") for auto_cart defaultQuantity
                quantity: '{{nlu_result.entities.quantity || 1}}',
                // Capture special instructions from NER PREF entity (e.g., "no oil", "extra spicy")
                special_instructions: '{{nlu_result.entities.preference || null}}',
              },
              // Propagate special instructions to order_note so checkout picks it up automatically
              order_note: '{{nlu_result.entities.preference || null}}',
              special_instructions: '{{nlu_result.entities.preference || null}}',
            },
          },
        },
      ],
      transitions: {
        success: 'check_if_express_order',
        default: 'save_original_query',
      },
    },

    check_if_express_order: {
      type: 'decision',
      description: 'Route to express checkout if complete order detected',
      conditions: [
        {
          // Express order = NLU extracted both food items AND a restaurant reference
          expression: 'context.express_order_detection?.food_items?.length > 0 && context.express_order_detection?.restaurant',
          event: 'express_order',
        },
      ],
      transitions: {
        express_order: 'express_order_flow',
        default: 'save_original_query',
      },
    },

    express_order_flow: {
      type: 'action',
      description: 'Handle express order - search item, add to cart, show checkout',
      actions: [
        {
          id: 'save_express_data',
          executor: 'response',
          config: {
            saveToContext: {
              original_food_query: '{{_user_message}}',
              extracted_food: {
                items: '{{express_order_detection.food_items}}',
                restaurant: '{{express_order_detection.restaurant}}',
                search_query: '{{#each express_order_detection.food_items}}{{this.name}} {{/each}}',
                special_instructions: '{{express_order_detection.special_instructions}}',
              },
              _is_express_order: true,
              _delivery_address_type: '{{express_order_detection.delivery_address_type}}',
              _payment_query: '{{express_order_detection.payment_query}}',
            },
            event: 'saved',
          },
        },
      ],
      transitions: {
        saved: 'check_saved_address_intent',
        default: 'check_saved_address_intent',
      },
    },

    save_original_query: {
      type: 'action',
      description: 'Save the original user query and delivery address hints from NLU for later use',
      actions: [
        {
          id: 'save_query',
          executor: 'response',
          config: {
            saveToContext: {
              original_food_query: '{{_user_message}}',
              // 🏠 Propagate delivery address type from NLU entities (home/office/ghar)
              _delivery_address_type: '{{express_order_detection.delivery_address_type}}',
              // 🥗 Propagate food preference from NLU (veg/non-veg)
              _user_food_preference: '{{nlu_result.entities.preference}}',
            },
            event: 'saved',
          },
        },
      ],
      transitions: {
        saved: 'check_saved_address_intent',
        default: 'check_saved_address_intent',
      },
    },

    check_quick_order_flow: {
      type: 'decision',
      description: 'Check if Quick Order WhatsApp Flow is available',
      conditions: [
        {
          expression: `context.platform === 'whatsapp' && !!('${process.env.WA_FLOW_QUICK_ORDER_ID || ''}')`,
          event: 'flow_available',
        },
      ],
      transitions: {
        flow_available: 'send_quick_order_flow',
        default: 'greet_user', // Fallback to standard flow if no Quick Order Flow ID
      },
    },

    send_quick_order_flow: {
      type: 'action',
      description: 'Launch Quick Order WhatsApp Flow',
      actions: [
        {
          id: 'send_wa_quick_order',
          executor: 'response',
          config: {
            message: 'Tap below to quickly order food from nearby restaurants!',
            flow: {
              flowId: process.env.WA_FLOW_QUICK_ORDER_ID || '',
              flowType: 'quick_order',
              ctaText: 'Quick Order',
              body: 'Order food in a few taps',
            },
          },
          output: '_quick_order_flow_result',
        },
      ],
      transitions: {
        flow_sent: 'await_flow_quick_order',
        default: 'greet_user',
        error: 'greet_user',
      },
    },

    await_flow_quick_order: {
      type: 'wait',
      description: 'Wait for Quick Order WhatsApp Flow completion',
      actions: [],
      transitions: {
        flow_response: 'process_quick_order_result',
        user_message: 'process_quick_order_result',
        default: 'process_quick_order_result',
      },
    },

    process_quick_order_result: {
      type: 'action',
      description: 'Process completed Quick Order from WhatsApp Flow',
      actions: [
        {
          id: 'load_quick_order_result',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_response_data',
          },
          output: 'quick_order_data',
        },
        {
          id: 'confirm_quick_order',
          executor: 'response',
          config: {
            message: '{{#if quick_order_data.order_id}}Your order #{{quick_order_data.order_id}} has been placed! We\'ll notify you when the restaurant confirms. 🎉{{else}}Your quick order is being processed. We\'ll update you shortly!{{/if}}',
          },
        },
      ],
      transitions: {
        success: 'completed',
        default: 'completed',
        error: 'greet_user',
      },
    },

};
