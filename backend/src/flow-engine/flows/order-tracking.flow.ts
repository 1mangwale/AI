import { FlowDefinition } from '../types/flow.types';
import configuration from '../../config/configuration';
import { SEARCH } from '../../config/flow.constants';

// Resolve tracking base URL from centralised config (single source of truth)
const trackingBaseUrl = configuration().tracking.baseUrl;

/**
 * Order Tracking Flow
 * 
 * Allows users to:
 * - View their current/running orders
 * - View order history
 * - Track a specific order
 * - Cancel an order
 * - Reorder from history
 */
export const orderTrackingFlow: FlowDefinition = {
  id: 'order_tracking_v1',
  name: 'Order Tracking Flow',
  description: 'Track orders, view history, cancel or reorder',
  module: 'general',
  trigger: 'track_order|order_history|cancel_order|repeat_order|reorder',
  version: '1.0.0',
  enabled: true,
  initialState: 'check_auth',
  finalStates: ['end_flow'],
  
  contextSchema: {
    orders: { type: 'array', required: false },
    selected_order: { type: 'object', required: false },
    order_status: { type: 'string', required: false },
  },
  
  states: {
    // Auth guard - check if user is authenticated before showing orders
    check_auth: {
      type: 'decision',
      description: 'Check if user is authenticated before showing orders',
      conditions: [
        {
          expression: 'context.auth_token || context.authenticated',
          event: 'authenticated',
        },
      ],
      transitions: {
        authenticated: 'init',
        default: 'request_login',
      },
    },

    // Ask user to login
    request_login: {
      type: 'wait',
      description: 'Ask user to login to see orders',
      onEntry: [
        {
          id: 'login_prompt',
          executor: 'response',
          config: {
            message: 'Please log in to view your orders.',
            metadata: { action: 'trigger_auth_modal', responseType: 'request_phone' },
            buttons: [
              { id: 'login', label: 'Login', value: '__LOGIN__' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'check_auth',
        default: 'check_auth',
      },
    },

    // Initial state - check what user wants to do based on trigger intent or message
    init: {
      type: 'decision',
      description: 'Determine what tracking action to take based on intent or message',
      conditions: [
        // Check trigger intent first (from NLU classification)
        {
          expression: 'context._trigger_intent === "order_history"',
          event: 'wants_history',
        },
        {
          expression: 'context._trigger_intent === "cancel_order"',
          event: 'wants_cancel',
        },
        {
          expression: 'context._trigger_intent === "repeat_order" || context._trigger_intent === "reorder"',
          event: 'wants_reorder',
        },
        // Fallback to message analysis
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("cancel")',
          event: 'wants_cancel',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("history") || context._user_message.toLowerCase().includes("past"))',
          event: 'wants_history',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("reorder") || context._user_message.toLowerCase().includes("repeat") || context._user_message.toLowerCase().includes("same again"))',
          event: 'wants_reorder',
        },
      ],
      transitions: {
        wants_cancel: 'fetch_running_orders',
        wants_history: 'fetch_order_history',
        wants_reorder: 'fetch_order_history',
        default: 'show_options',
      },
    },

    // Show tracking options
    show_options: {
      type: 'wait',
      description: 'Show order tracking options',
      onEntry: [
        {
          id: 'show_menu',
          executor: 'response',
          config: {
            message: '📦 **Order Tracking**\n\nWhat would you like to do?',
            buttons: [
              { id: 'track_current', label: '🚚 Track Current Order', value: 'track current order' },
              { id: 'view_history', label: '📋 Order History', value: 'show order history' },
              { id: 'cancel_order', label: '❌ Cancel Order', value: 'cancel my order' },
              { id: 'back', label: '🔙 Back to Menu', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'route_action',
        // Button click values are passed as events directly
        'track current order': 'route_action',
        'show order history': 'route_action',
        'cancel my order': 'route_action',
        'back to menu': 'route_action',
        default: 'route_action',
      },
    },

    // Route based on user selection
    route_action: {
      type: 'decision',
      description: 'Route to appropriate action',
      conditions: [
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("current") || context._user_message.toLowerCase().includes("track"))',
          event: 'track_current',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("history") || context._user_message.toLowerCase().includes("past"))',
          event: 'view_history',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("cancel")',
          event: 'cancel_order',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("back") || context._user_message.toLowerCase().includes("menu"))',
          event: 'back_to_menu',
        },
      ],
      transitions: {
        track_current: 'fetch_running_orders',
        view_history: 'fetch_order_history',
        cancel_order: 'fetch_running_orders',
        back_to_menu: 'end_flow',
        default: 'show_options',
      },
    },

    // Fetch running orders
    fetch_running_orders: {
      type: 'action',
      description: 'Get running/active orders from PHP backend',
      actions: [
        {
          id: 'get_running',
          executor: 'php_api',
          config: {
            action: 'get_all_running_orders',
            token: '{{auth_token}}',
          },
          output: 'running_orders',
        },
      ],
      transitions: {
        success: 'check_running_orders',
        error: 'no_orders_error',
      },
    },

    // Check if there are running orders
    check_running_orders: {
      type: 'decision',
      description: 'Check if user has running orders',
      conditions: [
        {
          expression: 'context.running_orders && context.running_orders.length > 0',
          event: 'has_orders',
        },
      ],
      transitions: {
        has_orders: 'display_running_orders',
        default: 'no_running_orders',
      },
    },

    // Display running orders
    display_running_orders: {
      type: 'wait',
      description: 'Show list of running orders',
      onEntry: [
        {
          id: 'format_orders',
          executor: 'llm',
          config: {
            systemPrompt: 'Format order list as a concise numbered list with emojis. Show order ID, status, and amount.',
            prompt: `Format these orders for display:
{{#each running_orders}}
- Order #{{this.id}}: {{this.orderStatus}} - ₹{{this.orderAmount}}
{{/each}}

Keep it under 200 chars. Use status emojis: ⏳pending ✅confirmed 📦processing 🚚picked_up 🤝handover ✅delivered`,
            temperature: 0.3,
            maxTokens: 150,
          },
          output: 'formatted_orders',
        },
        {
          id: 'show_orders',
          executor: 'response',
          config: {
            message: '🚚 **Your Active Orders**\n\n{{formatted_orders}}\n\nSelect an order to track or cancel:',
            buttons: [
              { id: 'select_first', label: 'Track Order #{{running_orders.[0].id}}', value: 'track order {{running_orders.[0].id}}' },
              { id: 'cancel', label: '❌ Cancel an Order', value: 'cancel order' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'handle_order_selection',
        'cancel order': 'handle_order_selection',
        'back to menu': 'show_options',
        default: 'handle_order_selection',
      },
    },

    // No running orders
    no_running_orders: {
      type: 'wait',
      description: 'Inform user they have no active orders',
      onEntry: [
        {
          id: 'no_orders_msg',
          executor: 'response',
          config: {
            message: '📭 You don\'t have any active orders right now.\n\nWould you like to view your order history or place a new order?',
            buttons: [
              { id: 'history', label: '📋 Order History', value: 'show order history' },
              { id: 'new_order', label: '🍔 Order Food', value: 'order food' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'route_action',
        'show order history': 'route_action',
        'order food': 'end_flow',
        'back to menu': 'show_options',
        default: 'route_action',
      },
    },

    // Handle order selection
    handle_order_selection: {
      type: 'action',
      description: 'Extract order ID from user message',
      actions: [
        {
          id: 'extract_order_id',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract order ID from message. Return JSON with "order_id" (number) and "action" (track/cancel).',
            prompt: `Message: "{{_user_message}}"
Available orders: {{running_orders}}

JSON:`,
            temperature: 0,
            maxTokens: 50,
            parseJson: true,
          },
          output: 'selection',
        },
      ],
      transitions: {
        success: 'process_selection',
        error: 'show_options',
      },
    },

    // Process the selection
    process_selection: {
      type: 'decision',
      description: 'Route based on action',
      conditions: [
        {
          expression: 'context.selection && context.selection.action === "cancel"',
          event: 'cancel',
        },
        {
          expression: 'context.selection && context.selection.order_id',
          event: 'track',
        },
      ],
      transitions: {
        cancel: 'confirm_cancel',
        track: 'track_order_details',
        default: 'display_running_orders',
      },
    },

    // Track specific order
    track_order_details: {
      type: 'action',
      description: 'Get detailed order status',
      actions: [
        {
          id: 'get_details',
          executor: 'php_api',
          config: {
            action: 'get_order_details',
            token: '{{auth_token}}',
            orderId: '{{selection.order_id}}',
          },
          output: 'order_details',
        },
        {
          id: 'track_location',
          executor: 'php_api',
          config: {
            action: 'track_order',
            orderId: '{{selection.order_id}}',
          },
          output: 'tracking',
        },
      ],
      transitions: {
        success: 'show_tracking_details',
        error: 'tracking_error',
      },
    },

    // Show tracking details
    show_tracking_details: {
      type: 'wait',
      description: 'Display order tracking information',
      onEntry: [
        {
          id: 'format_tracking',
          executor: 'llm',
          config: {
            systemPrompt: 'Format order tracking details nicely with emojis. Be concise. Include the tracking link provided.',
            prompt: `Order: {{order_details}}
Tracking: {{tracking}}

Format a tracking status message showing:
- Order ID and status
- Estimated delivery (if available)
- Delivery person info (if available)
- Include this live tracking link: ${trackingBaseUrl}/track/{{selection.order_id}}/{{order_details.receiverPhone}}
Keep under 300 chars.`,
            temperature: 0.3,
            maxTokens: 200,
          },
          output: 'tracking_message',
        },
        {
          id: 'show_tracking',
          executor: 'response',
          config: {
            message: `📍 **Order Tracking**\n\n{{tracking_message}}\n\n🔗 Live Track: ${trackingBaseUrl}/track/{{selection.order_id}}/{{order_details.receiverPhone}}`,
            buttons: [
              { id: 'refresh', label: '🔄 Refresh', value: 'track order {{selection.order_id}}' },
              { id: 'rate', label: '⭐ Rate Order', value: 'rate_order' },
              { id: 'cancel', label: '❌ Cancel Order', value: 'cancel order {{selection.order_id}}' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
            metadata: {
              order_tracking: {
                orderId: '{{selection.order_id}}',
                storeName: '{{order_details.storeName}}',
              },
            },
          },
        },
      ],
      transitions: {
        rate_order: 'collect_order_rating',
        user_message: 'route_action',
        'back to menu': 'show_options',
        default: 'route_action',
      },
    },

    // Confirm cancellation
    confirm_cancel: {
      type: 'wait',
      description: 'Confirm order cancellation',
      onEntry: [
        {
          id: 'confirm_msg',
          executor: 'response',
          config: {
            message: '⚠️ Are you sure you want to cancel this order?\n\nThis action cannot be undone.',
            buttons: [
              { id: 'yes', label: '✅ Yes, Cancel', value: 'yes cancel' },
              { id: 'no', label: '❌ No, Keep Order', value: 'no keep' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'process_cancel_confirmation',
        'yes cancel': 'process_cancel_confirmation',
        'no keep': 'process_cancel_confirmation',
        default: 'process_cancel_confirmation',
      },
    },

    // Process cancel confirmation
    process_cancel_confirmation: {
      type: 'decision',
      description: 'Check if user confirmed cancellation',
      conditions: [
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("yes") || context._user_message.toLowerCase().includes("cancel"))',
          event: 'confirmed',
        },
      ],
      transitions: {
        confirmed: 'cancel_order_api',
        default: 'display_running_orders',
      },
    },

    // Cancel order via API
    cancel_order_api: {
      type: 'action',
      description: 'Cancel order in PHP backend',
      actions: [
        {
          id: 'cancel',
          executor: 'php_api',
          config: {
            action: 'cancel_order',
            token: '{{auth_token}}',
            orderId: '{{selection.order_id}}',
            reason: 'Customer requested cancellation via chatbot',
          },
          output: 'cancel_result',
        },
      ],
      transitions: {
        success: 'cancel_success',
        error: 'cancel_error',
      },
    },

    // Cancellation success
    cancel_success: {
      type: 'wait',
      description: 'Order cancelled successfully',
      onEntry: [
        {
          id: 'success_msg',
          executor: 'response',
          config: {
            message: '✅ Your order has been cancelled successfully.\n\nIf you were charged, a refund will be processed within 5-7 business days.',
            buttons: [
              { id: 'new_order', label: '🍔 Order Again', value: 'order food' },
              { id: 'back', label: '🔙 Back to Menu', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'end_flow',
        'order food': 'end_flow',
        'back to menu': 'end_flow',
        default: 'end_flow',
      },
    },

    // Cancel error
    cancel_error: {
      type: 'wait',
      description: 'Order cancellation failed',
      onEntry: [
        {
          id: 'error_msg',
          executor: 'response',
          config: {
            message: '❌ Sorry, we couldn\'t cancel your order.\n\nThis may be because the order is already being prepared. Please contact support for assistance.',
            buttons: [
              { id: 'support', label: '📞 Contact Support', value: 'contact support' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'route_action',
        'contact support': 'route_action',
        'back to menu': 'show_options',
        default: 'route_action',
      },
    },

    // Fetch order history
    fetch_order_history: {
      type: 'action',
      description: 'Get order history from PHP backend',
      actions: [
        {
          id: 'get_history',
          executor: 'php_api',
          config: {
            action: 'get_all_customer_orders',
            token: '{{auth_token}}',
            limit: SEARCH.ORDER_HISTORY_LIMIT,
          },
          output: 'order_history',
        },
      ],
      transitions: {
        success: 'check_order_history',
        error: 'no_orders_error',
      },
    },

    // Check if there's order history
    check_order_history: {
      type: 'decision',
      description: 'Check if user has order history',
      conditions: [
        {
          expression: 'context.order_history && context.order_history.length > 0',
          event: 'has_history',
        },
      ],
      transitions: {
        has_history: 'display_order_history',
        default: 'no_order_history',
      },
    },

    // Display order history
    display_order_history: {
      type: 'wait',
      description: 'Show order history list',
      onEntry: [
        {
          id: 'format_history',
          executor: 'llm',
          config: {
            systemPrompt: 'Format order history as a brief numbered list. Show order ID, status, date, and amount.',
            prompt: `Format these past orders:
{{#each order_history}}
- Order #{{this.id}}: {{this.orderStatus}} - ₹{{this.orderAmount}} on {{this.createdAt}}
{{/each}}

Keep it concise with status emojis.`,
            temperature: 0.3,
            maxTokens: 200,
          },
          output: 'formatted_history',
        },
        {
          id: 'show_history',
          executor: 'response',
          config: {
            message: '📋 **Your Order History**\n\n{{formatted_history}}\n\nWould you like to reorder any of these?',
            buttons: [
              { id: 'reorder', label: '🔄 Reorder Last', value: 'reorder last order' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'handle_history_action',
        'reorder last order': 'handle_history_action',
        'back to menu': 'show_options',
        default: 'handle_history_action',
      },
    },

    // No order history
    no_order_history: {
      type: 'wait',
      description: 'Inform user they have no order history',
      onEntry: [
        {
          id: 'no_history_msg',
          executor: 'response',
          config: {
            message: '📭 You haven\'t placed any orders yet.\n\nLet\'s change that! What would you like to order?',
            buttons: [
              { id: 'food', label: '🍔 Order Food', value: 'order food' },
              { id: 'parcel', label: '📦 Send Parcel', value: 'send parcel' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'end_flow',
        'order food': 'end_flow',
        'send parcel': 'end_flow',
        'back to menu': 'end_flow',
        default: 'end_flow',
      },
    },

    // Handle history action (reorder)
    handle_history_action: {
      type: 'decision',
      description: 'Handle reorder or other actions',
      conditions: [
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("reorder")',
          event: 'reorder',
        },
      ],
      transitions: {
        reorder: 'reorder_confirmation',
        default: 'route_action',
      },
    },

    // Reorder confirmation
    reorder_confirmation: {
      type: 'wait',
      description: 'Confirm reorder',
      onEntry: [
        {
          id: 'confirm_reorder',
          executor: 'response',
          config: {
            message: '🔄 Ready to reorder your last order?\n\nThis will add the same items to your cart.',
            buttons: [
              { id: 'yes', label: '✅ Yes, Reorder', value: 'yes reorder' },
              { id: 'no', label: '❌ No, Browse Menu', value: 'order food' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'process_reorder',
        'yes reorder': 'process_reorder',
        'order food': 'process_reorder',
        default: 'process_reorder',
      },
    },

    // Process reorder
    process_reorder: {
      type: 'decision',
      description: 'Check if user confirmed reorder',
      conditions: [
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("yes")',
          event: 'confirmed',
        },
      ],
      transitions: {
        confirmed: 'trigger_reorder',
        default: 'end_flow',
      },
    },

    // Trigger reorder (start food order flow with last order items)
    trigger_reorder: {
      type: 'action',
      description: 'Set up reorder context and redirect to food order flow',
      actions: [
        {
          id: 'reorder_msg',
          executor: 'response',
          config: {
            message: '✅ Great! I\'ve added your previous order items. Let me help you complete the order.',
          },
          output: 'reorder_context',
        },
      ],
      transitions: {
        success: 'end_flow', // Will trigger food_order flow with pre-filled items
      },
    },

    // Generic error state
    no_orders_error: {
      type: 'wait',
      description: 'Error fetching orders',
      onEntry: [
        {
          id: 'error_msg',
          executor: 'response',
          config: {
            message: '❌ Sorry, I couldn\'t fetch your orders. Please try again later.',
            buttons: [
              { id: 'retry', label: '🔄 Try Again', value: 'track order' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'route_action',
        'track order': 'route_action',
        'back to menu': 'show_options',
        default: 'route_action',
      },
    },

    // Tracking error
    tracking_error: {
      type: 'wait',
      description: 'Error tracking order',
      onEntry: [
        {
          id: 'error_msg',
          executor: 'response',
          config: {
            message: '❌ Sorry, I couldn\'t get tracking info for this order.',
            buttons: [
              { id: 'retry', label: '🔄 Try Again', value: 'track order' },
              { id: 'back', label: '🔙 Back', value: 'back to menu' },
            ],
          },
        },
      ],
      transitions: {
        user_message: 'route_action',
        'track order': 'route_action',
        'back to menu': 'show_options',
        default: 'route_action',
      },
    },

    // ─── Post-delivery review ─────────────────────────────────────────────────

    // Ask user to rate their order (1-5 stars via buttons)
    collect_order_rating: {
      type: 'wait',
      description: 'Ask user to rate their order',
      onEntry: [
        {
          id: 'ask_rating',
          executor: 'response',
          config: {
            message: '⭐ How was your order? Tap a star to rate!',
            buttons: [
              { label: '⭐ 1', value: 'rating_1' },
              { label: '⭐⭐ 2', value: 'rating_2' },
              { label: '⭐⭐⭐ 3', value: 'rating_3' },
              { label: '⭐⭐⭐⭐ 4', value: 'rating_4' },
              { label: '⭐⭐⭐⭐⭐ 5', value: 'rating_5' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        rating_1: 'capture_rating',
        rating_2: 'capture_rating',
        rating_3: 'capture_rating',
        rating_4: 'capture_rating',
        rating_5: 'capture_rating',
        user_message: 'capture_rating',
        default: 'capture_rating',
      },
    },

    // Save rating to context and decide whether to ask for a comment
    capture_rating: {
      type: 'action',
      description: 'Save the star rating to context',
      actions: [
        {
          id: 'save_rating',
          executor: 'session',
          config: {
            action: 'set',
            key: 'order_rating',
            value: '{{_user_message}}',
          },
          output: '_rating_saved',
        },
      ],
      transitions: {
        default: 'ask_review_comment',
      },
    },

    // Optionally ask for a text comment
    ask_review_comment: {
      type: 'wait',
      description: 'Ask for an optional review comment',
      onEntry: [
        {
          id: 'ask_comment',
          executor: 'response',
          config: {
            message: '💬 Want to add a comment? (Optional — helps us improve!)',
            buttons: [
              { label: '⏭️ Skip', value: 'skip_review_comment' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_review_comment: 'save_order_rating',
        user_message: 'save_order_rating',
        default: 'save_order_rating',
      },
    },

    // Submit rating + comment to PHP
    save_order_rating: {
      type: 'action',
      description: 'Submit rating and optional comment to PHP backend',
      actions: [
        {
          id: 'submit_review',
          executor: 'php_api',
          config: {
            action: 'submit_order_review',
            token: '{{auth_token}}',
            order_id: '{{selection.order_id}}',
            rating: '{{order_rating}}',
            comment: '{{_user_message}}',
          },
          output: '_review_result',
        },
      ],
      transitions: {
        default: 'review_submitted',
      },
    },

    // Thank-you screen after review
    review_submitted: {
      type: 'wait',
      description: 'Thank user for their review',
      onEntry: [
        {
          id: 'thank_you',
          executor: 'response',
          config: {
            message: '🙏 Thank you for your feedback! It helps us serve you better.\n\n🍔 Hungry again?',
            buttons: [
              { label: '🔁 Order Again', value: 'order food' },
              { label: '📋 My Orders', value: 'track order' },
              { label: '🏠 Main Menu', value: 'back to menu' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        'order food': 'end_flow',
        'track order': 'show_options',
        'back to menu': 'end_flow',
        user_message: 'end_flow',
        default: 'end_flow',
      },
    },

    // ─── End flow ─────────────────────────────────────────────────────────────

    // End flow
    end_flow: {
      type: 'end',
      description: 'End the order tracking flow',
      actions: [],
      transitions: {},
    },
  },
  
  metadata: {
    author: 'Mangwale AI Team',
    createdAt: '2025-01-01',
    tags: ['order', 'tracking', 'history'],
    priority: 65,
  },
};
