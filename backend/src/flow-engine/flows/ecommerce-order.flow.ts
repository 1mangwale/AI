import { FlowDefinition } from '../types/flow.types';

export const ecommerceOrderFlow: FlowDefinition = {
  id: 'ecommerce_order_v1',
  name: 'E-commerce Order Flow',
  description: 'Complete e-commerce shopping flow with search, cart, address, and payment',
  module: 'ecommerce',
  trigger: 'search_product',
  version: '1.0.0',
  
  contextSchema: {
    search_query: { type: 'string', required: false },
    search_results: { type: 'array', required: false },
    cart_items: { type: 'array', required: true },
    delivery_address: { type: 'object', required: true },
    distance: { type: 'number', required: false },
    pricing: { type: 'object', required: true },
    payment_method: { type: 'string', required: false },
    order_result: { type: 'object', required: false },
  },
  
  states: {
    // Check trigger
    check_trigger: {
      type: 'decision',
      description: 'Check if user already specified a product or wants to reorder',
      conditions: [
        {
          // Quick reorder intent
          expression: '/reorder|order again|last order|usual|phir se|wahi|same order|dobara/i.test(String(context._user_message || ""))',
          event: 'reorder',
        },
        {
          expression: 'context._user_message && context._user_message.length > 3 && !["hi", "hello", "shop"].includes(context._user_message.toLowerCase())',
          event: 'has_query',
        }
      ],
      transitions: {
        reorder: 'quick_reorder',
        has_query: 'understand_request',
        default: 'init',
      },
    },

    // Initial state
    init: {
      type: 'action',
      description: 'Welcome and ask what user wants to shop for',
      actions: [
        {
          id: 'welcome_message',
          executor: 'llm',
          config: {
            systemPrompt: 'You are Mangwale Mart Assistant. Be concise.',
            prompt: 'Greet user. Ask "What would you like to buy today? We have groceries, electronics, and more."',
            temperature: 0.6,
            maxTokens: 60,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'understand_request',
      },
    },

    // Extract shopping intent
    understand_request: {
      type: 'action',
      description: 'Understand what user wants to buy',
      actions: [
        {
          id: 'analyze_request',
          executor: 'nlu',
          config: {
            extractEntities: true,
          },
          output: 'shopping_nlu',
        },
      ],
      transitions: {
        success: 'search_products',
      },
    },

    // Search products
    search_products: {
      type: 'action',
      description: 'Search e-commerce products',
      actions: [
        {
          id: 'search_items',
          executor: 'search',
          config: {
            index: 'ecom_items_v2',
            queryPath: '_user_message',
            size: 15,
            fields: ['title', 'category', 'brand', 'description', 'tags'],
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'show_products',
        no_items: 'no_results',
      },
    },

    // Display products - uses response executor with cardsPath for proper card rendering
    show_products: {
      type: 'wait',
      description: 'Display product search results to user and wait for selection',
      onEntry: [
        {
          id: 'display_products',
          executor: 'response',
          config: {
            message: 'Found {{search_results.totalItems}} items for you 🛍️',
            cardsPath: 'search_results.cards',
            buttonsPath: 'search_results.filterButtons',
            buttons: [
              { id: 'btn_view_cart', label: '🛒 View Cart', value: 'view cart' },
              { id: 'btn_checkout', label: '✅ Checkout', value: 'checkout' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'process_user_action',
        default: 'process_user_action',
      },
    },

    // Process user action (add to cart, search more, checkout)
    process_user_action: {
      type: 'decision',
      description: 'Determine user action',
      conditions: [
        {
          // Match "item_XXXXX" (card button clicks), "NxM" (quantity format), or plain number "1"-"99"
          expression: 'context._user_message?.match(/^item_\\d+$/) || context._user_message?.match(/\\d+x\\d+/) || context._user_message?.match(/^\\d{1,2}$/)',
          event: 'add_to_cart',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("cart") || context._user_message?.toLowerCase().includes("checkout")',
          event: 'view_cart',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("search") || context._user_message?.toLowerCase().includes("find")',
          event: 'search_more',
        },
      ],
      transitions: {
        add_to_cart: 'add_to_cart',
        view_cart: 'show_cart',
        search_more: 'search_products',
        default: 'show_products',
      },
    },

    // Add items to cart — transitions to wait state after LLM confirmation
    add_to_cart: {
      type: 'action',
      description: 'Parse and add selected items to cart',
      actions: [
        {
          id: 'parse_selection',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract item selections from user message. Return JSON array.',
            prompt: 'User message: {{_user_message}}\n\nExtract selections as JSON: [{"itemIndex": 0, "quantity": 2}]',
            temperature: 0.2,
            maxTokens: 150,
          },
          output: '_selection_data',
        },
        {
          id: 'confirm_addition',
          executor: 'llm',
          config: {
            systemPrompt: 'Confirm items added to cart.',
            prompt: 'Items added to cart. Current cart has {{cart_items.length}} unique items. Ask if they want to continue shopping or proceed to checkout.',
            temperature: 0.7,
            maxTokens: 100,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        success: 'wait_after_add',
        default: 'wait_after_add',
      },
    },

    // Wait for user decision after adding to cart
    wait_after_add: {
      type: 'wait',
      description: 'Wait for user to continue shopping or checkout after adding item',
      onEntry: [],
      actions: [],
      transitions: {
        user_message: 'process_user_action',
        default: 'process_user_action',
      },
    },

    // Show cart — structured display with buttons
    show_cart: {
      type: 'wait',
      description: 'Display shopping cart and wait for action',
      onEntry: [
        {
          id: 'display_cart',
          executor: 'response',
          config: {
            message: '🛒 **Your Cart**\n\n{{#each cart_items}}{{@index_plus_1}}. *{{this.title}}* x{{this.quantity}} — ₹{{this.total}}\n{{/each}}\n\n💰 **Subtotal:** ₹{{pricing.itemsTotal}}',
            buttons: [
              { label: '✅ Checkout', value: 'checkout', action: 'proceed_checkout' },
              { label: '🔄 Continue Shopping', value: 'continue', action: 'continue_shopping' },
              { label: '🗑️ Clear Cart', value: 'clear', action: 'clear_cart' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        proceed_checkout: 'collect_address',
        continue_shopping: 'search_products',
        clear_cart: 'clear_cart_confirm',
        user_message: 'check_cart_action',
        default: 'check_cart_action',
      },
    },

    // Check cart action from free text
    check_cart_action: {
      type: 'decision',
      description: 'Determine next step from cart',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/checkout|proceed|order|buy|place/)',
          event: 'proceed_checkout',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/shop|continue|more|browse/)',
          event: 'continue_shopping',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/clear|empty|reset/)',
          event: 'clear_cart',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/remove|delete|hata|nikal/)',
          event: 'remove_item',
        },
      ],
      transitions: {
        proceed_checkout: 'collect_address',
        continue_shopping: 'search_products',
        clear_cart: 'clear_cart_confirm',
        remove_item: 'remove_from_cart',
        default: 'show_cart',
      },
    },

    // Confirm cart clear
    clear_cart_confirm: {
      type: 'action',
      description: 'Clear the cart and inform user',
      actions: [
        {
          id: 'clear_msg',
          executor: 'response',
          config: {
            message: '🗑️ Cart cleared! What would you like to shop for?',
            saveToContext: {
              cart_items: [],
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'search_products',
      },
    },

    // Remove item from cart
    remove_from_cart: {
      type: 'action',
      description: 'Ask which item to remove',
      actions: [
        {
          id: 'ask_remove',
          executor: 'response',
          config: {
            message: '🗑️ Which item do you want to remove? Reply with the item number.\n\n{{#each cart_items}}{{@index_plus_1}}. {{this.title}} x{{this.quantity}}\n{{/each}}',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'show_cart',  // After removal input, redisplay cart
        default: 'show_cart',
      },
    },

    // Quick reorder — fetch last order and populate cart
    quick_reorder: {
      type: 'action',
      description: 'Fetch last e-commerce order for quick reorder',
      actions: [
        {
          id: 'fetch_last_order',
          executor: 'quick_reorder',
          config: {
            moduleId: 5,
            token: '{{session.auth_token}}',
          },
          output: 'reorder_result',
        },
      ],
      transitions: {
        success: 'show_cart',
        no_items: 'init',
        error: 'init',
      },
    },

    // Collect delivery address
    collect_address: {
      type: 'action',
      description: 'Get delivery address',
      actions: [
        {
          id: 'get_address',
          executor: 'response',
          config: {
            channelResponses: {
              whatsapp: {
                message: '📍 Select delivery address',
                flow: {
                  flowId: '{{env.WA_FLOW_ADDRESS_ID}}',
                  flowType: 'address_selection',
                  ctaText: 'Select Address',
                  body: '📍 Tap below to select or add a delivery address',
                },
              },
              default: {
                message: 'Where should we deliver your order?',
              },
            },
          },
          output: '_address_prompt_result',
        },
        {
          id: 'get_address_fallback',
          executor: 'address',
          config: {
            field: 'delivery_address',
            prompt: 'Where should we deliver your order?',
            offerSaved: true,
            skipIf: '{{_address_prompt_result.event === "flow_sent"}}',
          },
          output: 'delivery_address',
          retryOnError: true,
          maxRetries: 3,
        },
      ],
      transitions: {
        flow_sent: 'await_flow_address_ecom',
        address_valid: 'validate_zone',
        waiting_for_input: 'collect_address',
        error: 'address_error',
        default: 'validate_zone',  // Fix: response executor emits 'default' which shadows address_valid
      },
    },

    // Wait for WhatsApp Flow address response (e-commerce)
    await_flow_address_ecom: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow address selection response',
      actions: [],
      transitions: {
        flow_response: 'process_flow_address_ecom',
        user_message: 'process_flow_address_ecom',
        default: 'process_flow_address_ecom',
      },
    },

    // Read address result from session and save to context
    process_flow_address_ecom: {
      type: 'action',
      description: 'Process WhatsApp Flow address result for e-commerce',
      actions: [
        {
          id: 'read_flow_address',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_address_result',
          },
          output: '_flow_addr',
        },
        {
          id: 'save_address_to_context',
          executor: 'response',
          config: {
            saveToContext: {
              delivery_address: '{{_flow_addr.flow_address_result}}',
            },
          },
        },
      ],
      transitions: {
        default: 'check_flow_address_ecom',
      },
    },

    // Validate that we got a valid address from the flow
    check_flow_address_ecom: {
      type: 'decision',
      description: 'Check if Flow returned a valid address',
      conditions: [
        {
          expression: 'context.delivery_address && (context.delivery_address.lat || context.delivery_address.address)',
          event: 'valid',
        },
      ],
      transitions: {
        valid: 'validate_zone',
        default: 'collect_address', // Fallback to normal address collection
      },
    },

    // Validate zone
    validate_zone: {
      type: 'action',
      description: 'Check service area',
      actions: [
        {
          id: 'check_zone',
          executor: 'zone',
          config: {
            latPath: 'delivery_address.lat',
            lngPath: 'delivery_address.lng',
            moduleId: 5,  // e-commerce
          },
          output: 'delivery_zone',
        },
      ],
      transitions: {
        zone_valid: 'calculate_pricing',
        zone_invalid: 'out_of_zone',
      },
    },

    // Calculate pricing
    calculate_pricing: {
      type: 'action',
      description: 'Calculate e-commerce order pricing',
      actions: [
        {
          id: 'get_pricing',
          executor: 'pricing',
          config: {
            type: 'ecommerce',
            itemsPath: 'cart_items',
            // Industry defaults; pull from PHP API when endpoint is available
            freeShippingThreshold: 500,
            shippingFee: 40,
            taxRate: 0.18,
          },
          output: 'pricing',
        },
      ],
      transitions: {
        calculated: 'show_order_summary',
      },
    },

    // Show order summary
    show_order_summary: {
      type: 'action',
      description: 'Display final order summary',
      actions: [
        {
          id: 'summary_message',
          executor: 'response',
          config: {
            message: `🛒 **Looks good! Here's your order summary** 😊

📦 Items: {{cart_items.length}} items
💰 Subtotal: ₹{{pricing.itemsTotal}}
🚚 Shipping: {{#if pricing.freeShipping}}FREE 🎉{{else}}₹{{pricing.shippingFee}}{{/if}}
🧾 GST (18%): ₹{{pricing.tax}}
💳 **Total: ₹{{pricing.total}}**

📍 Delivering to: {{delivery_address.label}}
⏱️ ETA: 1–2 business days

Type "confirm" to place your order or "cancel" to go back.`,
            buttons: [
              { id: 'btn_confirm', label: '✅ Confirm Order', value: 'confirm' },
              { id: 'btn_cancel', label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        success: 'wait_order_summary_confirm',
        default: 'wait_order_summary_confirm',
      },
    },

    wait_order_summary_confirm: {
      type: 'wait',
      description: 'Wait for user to confirm or cancel the order',
      onEntry: [],
      actions: [],
      transitions: {
        user_message: 'check_final_confirmation',
        default: 'check_final_confirmation',
      },
    },

    // Check confirmation
    check_final_confirmation: {
      type: 'decision',
      description: 'Evaluate confirmation',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().includes("confirm") || context._user_message?.toLowerCase().includes("yes")',
          event: 'user_confirms',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("cancel") || context._user_message?.toLowerCase().includes("no")',
          event: 'user_cancels',
        },
      ],
      transitions: {
        user_confirms: 'select_payment_method',
        user_cancels: 'cancelled',
        default: 'show_order_summary',
      },
    },

    // Payment method selection
    select_payment_method: {
      type: 'action',
      description: 'Show payment method options',
      actions: [
        {
          id: 'payment_options_msg',
          executor: 'response',
          config: {
            channelResponses: {
              whatsapp: {
                message: '💳 Select payment method',
                flow: {
                  flowId: '{{env.WA_FLOW_PAYMENT_ID}}',
                  flowType: 'payment_selection',
                  ctaText: 'Select Payment',
                  body: '💳 Tap below to choose how you want to pay\n\nOrder Total: ₹{{pricing.total}}',
                  initialData: {
                    orderTotal: '{{pricing.total}}',
                  },
                },
              },
              default: {
                message: '💳 **How would you like to pay?**\n\nOrder Total: ₹{{pricing.total}}',
                buttons: [
                  { label: '📱 UPI / Online', value: 'online', action: 'pay_online' },
                  { label: '💵 Cash on Delivery', value: 'cod', action: 'pay_cod' },
                ],
              },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        flow_sent: 'await_flow_payment_ecom',
        default: 'await_payment_choice',
      },
    },

    // Wait for WhatsApp Flow payment response (e-commerce)
    await_flow_payment_ecom: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow payment selection response',
      actions: [],
      transitions: {
        flow_response: 'process_flow_payment_ecom',
        user_message: 'process_flow_payment_ecom',
        default: 'process_flow_payment_ecom',
      },
    },

    // Read payment result from session and route accordingly
    process_flow_payment_ecom: {
      type: 'action',
      description: 'Process WhatsApp Flow payment result for e-commerce',
      actions: [
        {
          id: 'read_flow_payment',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_payment_result',
          },
          output: '_flow_pay',
        },
        {
          id: 'save_payment_to_context',
          executor: 'response',
          config: {
            saveToContext: {
              _flow_payment_method: '{{_flow_pay.flow_payment_result.payment_method}}',
            },
          },
        },
      ],
      transitions: {
        default: 'route_flow_payment_ecom',
      },
    },

    // Route based on payment method from WhatsApp Flow
    route_flow_payment_ecom: {
      type: 'decision',
      description: 'Route based on WhatsApp Flow payment selection',
      conditions: [
        {
          expression: 'context._flow_payment_method && (context._flow_payment_method.includes("cod") || context._flow_payment_method.includes("cash"))',
          event: 'cod',
        },
        {
          expression: 'context._flow_payment_method && (context._flow_payment_method.includes("digital") || context._flow_payment_method.includes("online") || context._flow_payment_method.includes("upi") || context._flow_payment_method.includes("wallet"))',
          event: 'online',
        },
      ],
      transitions: {
        cod: 'set_payment_cod',
        online: 'set_payment_online',
        default: 'select_payment_method', // Fallback if no valid method
      },
    },

    // Wait for payment choice
    await_payment_choice: {
      type: 'wait',
      description: 'Wait for user to choose payment method',
      onEntry: [],
      transitions: {
        pay_online: 'set_payment_online',
        pay_cod: 'set_payment_cod',
        user_message: 'handle_payment_input',
        default: 'handle_payment_input',
      },
    },

    // Handle free-text payment input
    handle_payment_input: {
      type: 'decision',
      description: 'Parse payment method from text',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/online|upi|gpay|phonepe|paytm|card|debit|credit|digital|net\\s*banking/)',
          event: 'online',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/cod|cash|delivery|pay\\s*later/)',
          event: 'cod',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/cancel|no|nahi|stop/)',
          event: 'user_cancels',
        },
      ],
      transitions: {
        online: 'set_payment_online',
        cod: 'set_payment_cod',
        user_cancels: 'cancelled',
        default: 'select_payment_method',
      },
    },

    // Set online payment
    set_payment_online: {
      type: 'action',
      description: 'Set payment method to online and persist to context',
      actions: [
        {
          id: 'set_online',
          executor: 'response',
          config: {
            message: '📱 Online payment selected. Processing your order...',
            saveToContext: {
              payment_method: 'digital_payment',
              payment_details: { method: 'digital_payment', id: 'digital_payment' },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'check_store_before_order',
      },
    },

    // Set COD payment
    set_payment_cod: {
      type: 'action',
      description: 'Set payment method to COD and persist to context',
      actions: [
        {
          id: 'set_cod',
          executor: 'response',
          config: {
            message: '💵 Cash on Delivery selected. Processing your order...',
            saveToContext: {
              payment_method: 'cash_on_delivery',
              payment_details: { method: 'COD', id: 'cash_on_delivery' },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'check_store_before_order',
      },
    },

    // Verify store is open before placing the ecom order
    check_store_before_order: {
      type: 'action',
      description: 'Check if the store is accepting orders before payment',
      actions: [
        {
          id: 'store_open_check',
          executor: 'php_api',
          config: {
            action: 'get_store_details',
            storeId: '{{cart_items.0.store_id}}',
          },
          output: 'pre_order_store_check',
        },
      ],
      transitions: {
        success: 'place_order',
        closed: 'store_currently_closed',
        error: 'place_order', // graceful — PHP validates at order time
      },
    },

    // Friendly closed-store message
    store_currently_closed: {
      type: 'end',
      description: 'Inform user the store is closed right now',
      actions: [
        {
          id: 'closed_message',
          executor: 'response',
          config: {
            message: '🔒 *Store is currently closed*\n\n{{pre_order_store_check.message}}\n\nWould you like to search for something else or try again later?',
          },
          output: '_last_response',
        },
      ],
      transitions: {},
    },

    // Place order
    place_order: {
      type: 'action',
      description: 'Create e-commerce order',
      actions: [
        {
          id: 'create_order',
          executor: 'order',
          config: {
            type: 'ecommerce',
            itemsPath: 'cart_items',
            addressPath: 'delivery_address',
            pricingPath: 'pricing',
            // Payment method read from context.data.payment_method (set by select_payment states)
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        success: 'completed',
        error: 'order_failed',
      },
    },

    // Success
    completed: {
      type: 'end',
      description: 'Order placed successfully',
      actions: [
        {
          id: 'success_message',
          executor: 'llm',
          config: {
            systemPrompt: 'Confirm e-commerce order placement. Be positive!',
            prompt: `Order Confirmed! 🎉
✅ Order ID: {{order_result.orderId}}
💰 Total: ₹{{pricing.total}}
📍 Delivery: {{delivery_address.label}}
📦 Estimated: 1-2 business days

You'll receive order updates on WhatsApp. Track your order anytime!`,
            temperature: 0.8,
            maxTokens: 200,
          },
          output: '_last_response',
        },
      ],
      transitions: {},
    },

    // Error states
    no_results: {
      type: 'action',
      description: 'No products found',
      actions: [
        {
          id: 'no_results_message',
          executor: 'llm',
          config: {
            systemPrompt: 'Apologize and suggest alternatives.',
            prompt: 'No products found for "{{_user_message}}". Suggest browsing categories like groceries, electronics, fashion, home essentials. Ask what they\'re looking for.',
            temperature: 0.8,
            maxTokens: 120,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'understand_request',
      },
    },

    address_error: {
      type: 'end',
      description: 'Address collection failed',
      actions: [
        {
          id: 'error_message',
          executor: 'response',
          config: {
            message: 'Sorry, we couldn\'t get your delivery address. Please try again later.',
          },
        },
      ],
      transitions: {},
    },

    out_of_zone: {
      type: 'end',
      description: 'Outside service area',
      actions: [
        {
          id: 'zone_error',
          executor: 'response',
          config: {
            message: 'Sorry, we don\'t deliver to this area yet. Currently serving Nashik city. We\'ll notify you when we expand!',
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
            message: 'Sorry, we couldn\'t place your order. Please try again in a few minutes.',
          },
        },
      ],
      transitions: {},
    },

    cancelled: {
      type: 'end',
      description: 'Order cancelled',
      actions: [
        {
          id: 'cancel_message',
          executor: 'response',
          config: {
            message: 'Your order has been cancelled. Your cart is saved, come back anytime! 🛒',
          },
        },
      ],
      transitions: {},
    },
  },

  initialState: 'check_trigger',
  finalStates: ['completed', 'cancelled', 'address_error', 'out_of_zone', 'order_failed', 'store_currently_closed'],
};
