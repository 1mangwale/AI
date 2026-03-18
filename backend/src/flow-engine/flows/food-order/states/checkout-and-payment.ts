import { FlowState } from '../../../types/flow.types';

/**
 * Food Order Flow — Checkout And Payment States
 * Auto-extracted from food-order.flow.ts
 */
export const checkoutAndPaymentStates: Record<string, FlowState> = {
    review_cart_before_checkout: {
      type: 'action',
      description: 'Show cart summary with total so user can confirm or modify before entering address',
      actions: [
        {
          id: 'validate_cart_review',
          executor: 'cart_manager',
          config: { operation: 'validate' },
          output: 'cart_review',
        },
        {
          id: 'show_cart_review',
          executor: 'response',
          config: {
            message: '🛒 **Review Your Order**\n\n{{cart_review.cartSummary}}\n\n💰 **Total: ₹{{cart_review.totalPrice}}** ({{cart_review.totalItems}} items)\n\nReady to add your delivery address?',
            buttons: [
              { id: 'btn_proceed',    label: '✅ Confirm & Add Address', value: 'proceed' },
              { id: 'btn_modify_cart', label: '✏️ Modify Cart',          value: 'modify_cart' },
              { id: 'btn_cancel',     label: '❌ Cancel Order',          value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: { default: 'wait_cart_review' },
    },

    decide_auth_for_checkout: {
      type: 'decision',
      description: 'Decide if user is authenticated after fresh session check',
      conditions: [
        {
          expression: 'context.user_authenticated === true',
          event: 'authenticated',
        },
      ],
      transitions: {
        authenticated: 'review_cart_before_checkout',  // 🛒 Show cart review before address
        default: 'request_phone',
      },
    },

    request_phone: {
      type: 'wait',
      description: 'Ask user for phone number to authenticate',
      onEntry: [
        {
          id: 'ask_phone',
          executor: 'response',
          config: {
            message: 'To complete your order, please provide your phone number for verification.',
            responseType: 'request_phone',
            buttons: [
              { id: 'btn_modify', label: '✏️ Modify Cart', value: 'modify' },
              { id: 'btn_cancel', label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        phone_provided: 'verify_otp',
        user_message: 'recheck_auth_at_phone',
        default: 'recheck_auth_at_phone',
      },
    },

    recheck_auth_at_phone: {
      type: 'action',
      description: 'Re-check authentication before parsing phone - user may have logged in since last check',
      actions: [
        {
          id: 'recheck_auth_action',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_auth_recheck_result',
        },
      ],
      conditions: [
        {
          expression: 'context.user_authenticated === true && context.user_id > 0',
          event: 'authenticated',
        },
      ],
      transitions: {
        authenticated: 'auth_recovered_message',
        default: 'parse_phone',
      },
    },

    auth_recovered_message: {
      type: 'action',
      description: 'Notify user that they are now logged in and proceed to checkout',
      actions: [
        {
          id: 'auth_recovered_response',
          executor: 'response',
          config: {
            message: '✅ You\'re already logged in! Proceeding with your order...',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'collect_address',
      },
    },

    parse_phone: {
      type: 'action',
      description: 'Extract phone number from user message, with escape command support',
      actions: [
        {
          id: 'validate_phone_action',
          executor: 'auth',
          config: {
            action: 'validate_phone',
            input: '{{_user_message}}',
          },
          output: 'phone_result',
        },
      ],
      conditions: [
        // Escape commands - allow user to go back to modify cart without completing auth
        {
          expression: 'context._user_message?.toLowerCase().includes("add_more") || context._user_message?.toLowerCase().includes("add more")',
          event: 'add_more',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("modify") || context._user_message?.toLowerCase().includes("change") || context._user_message?.toLowerCase().includes("edit")',
          event: 'modify',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("cancel") || context._user_message?.toLowerCase().includes("nevermind") || context._user_message?.toLowerCase().includes("back")',
          event: 'cancel',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("clear") || context._user_message?.toLowerCase().includes("empty") || context._user_message?.toLowerCase().includes("remove all")',
          event: 'clear_cart',
        },
      ],
      transitions: {
        valid: 'send_otp',
        invalid: 'invalid_phone_with_help',
        add_more: 'show_results',      // Go back to search/browse
        modify: 'show_results',         // Go back to modify cart
        cancel: 'cancelled',
        clear_cart: 'clear_cart_state',
        error: 'request_phone',
      },
    },

    invalid_phone_with_help: {
      type: 'action',
      description: 'Show helpful message when phone is invalid',
      actions: [
        {
          id: 'invalid_phone_help',
          executor: 'response',
          config: {
            message: '❌ That doesn\'t look like a valid phone number.\n\n📱 Please enter your 10-digit mobile number (e.g., 9876543210)\n\nOr type:\n• "modify" to edit your cart\n• "cancel" to start over',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'request_phone',
      },
    },

    send_otp: {
      type: 'action',
      description: 'Send OTP to user phone',
      actions: [
        {
          id: 'send_otp_action',
          executor: 'auth',
          config: {
            action: 'send_otp',
          },
          output: 'otp_result',
        },
        {
          id: 'otp_sent_message',
          executor: 'response',
          config: {
            message: 'We\'ve sent an OTP to your phone. Please enter it to continue.',
            responseType: 'request_otp',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        success: 'verify_otp',
        otp_sent: 'verify_otp',
        error: 'otp_error',
      },
    },

    verify_otp: {
      type: 'wait',
      description: 'Wait for user to enter OTP',
      actions: [],
      transitions: {
        user_message: 'check_otp',
        default: 'check_otp',
      },
    },

    check_otp: {
      type: 'action',
      description: 'Verify the OTP entered by user',
      actions: [
        {
          id: 'verify_otp_action',
          executor: 'auth',
          config: {
            action: 'verify_otp',
            otp: '{{_user_message}}',
          },
          output: 'otp_verify_result',
        },
      ],
      transitions: {
        valid: 'collect_address',
        otp_valid: 'collect_address',
        invalid: 'otp_retry',
        otp_invalid: 'otp_retry',
        error: 'otp_error',
      },
    },

    otp_retry: {
      type: 'wait',
      description: 'Ask user to re-enter OTP',
      onEntry: [
        {
          id: 'otp_retry_prompt',
          executor: 'response',
          config: {
            message: '❌ That OTP is incorrect. Please try again or type "resend" to get a new OTP.',
            buttons: [
              { label: '🔄 Resend OTP', value: 'resend' },
            ],
          },
          output: '_retry_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'check_otp_or_resend',
        default: 'check_otp_or_resend',
      },
    },

    check_otp_or_resend: {
      type: 'decision',
      description: 'Check if user wants to resend OTP',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().includes("resend")',
          event: 'resend',
        },
      ],
      transitions: {
        resend: 'send_otp',
        default: 'check_otp',
      },
    },

    otp_error: {
      type: 'action',
      description: 'Handle OTP error',
      actions: [
        {
          id: 'otp_error_message',
          executor: 'response',
          config: {
            message: 'Sorry, there was an issue with OTP verification. Please try again.',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'request_phone',
      },
    },

    collect_address: {
      type: 'decision',
      description: 'Route address collection by channel — WhatsApp Flow or standard input',
      conditions: [
        {
          expression: `context.platform === 'whatsapp' && !!('${process.env.WA_FLOW_ADDRESS_ID || ''}')`,
          event: 'whatsapp_flow',
        },
      ],
      transitions: {
        whatsapp_flow: 'send_address_flow',
        default: 'collect_address_input',
      },
    },

    send_address_flow: {
      type: 'action',
      description: 'Send WhatsApp Flow for address selection',
      actions: [
        {
          id: 'send_wa_address_flow',
          executor: 'response',
          config: {
            message: 'Tap below to select or add a delivery address',
            flow: {
              flowId: process.env.WA_FLOW_ADDRESS_ID || '',
              flowType: 'address_selection',
              ctaText: 'Select Address',
              body: 'Tap below to select or add a delivery address',
            },
          },
          output: '_address_flow_result',
        },
      ],
      transitions: {
        flow_sent: 'await_flow_address',
        default: 'collect_address_input', // Fallback if flow dispatch fails (e.g. no phone)
        error: 'collect_address_input',
      },
    },

    await_flow_address: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow address response',
      actions: [],
      transitions: {
        flow_response: 'process_flow_address',
        user_message: 'process_flow_address',
        default: 'process_flow_address',
      },
    },

    process_flow_address: {
      type: 'action',
      description: 'Process address from WhatsApp Flow response',
      actions: [
        {
          id: 'load_flow_address',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_address_result',
          },
          output: 'flow_address',
        },
        {
          id: 'save_flow_address_to_context',
          executor: 'response',
          config: {
            saveToContext: {
              delivery_address: '{{flow_address.flow_address_result}}',
            },
          },
          output: '_saved',
        },
      ],
      transitions: {
        default: 'validate_zone',
      },
    },

    collect_address_input: {
      type: 'wait',
      description: 'Get delivery address',
      onEntry: [
        {
          id: 'get_address_onentry',
          executor: 'address',
          config: {
            field: 'delivery_address',
            prompt: 'Where should we deliver your order?',
            offerSaved: true,
          },
          output: 'delivery_address',
          retryOnError: true,
          maxRetries: 3,
        },
      ],
      actions: [
        {
          id: 'get_address',
          executor: 'address',
          config: {
            field: 'delivery_address',
            prompt: 'Where should we deliver your order?',
            offerSaved: true,
          },
          output: 'delivery_address',
          retryOnError: true,
          maxRetries: 3,
        },
      ],
      transitions: {
        address_valid: 'validate_zone',
        address_invalid: 'collect_address_input',  // No coordinates → re-ask
        waiting_for_input: null,  // Stay in current wait state
        error: 'address_error',
      },
    },

    ask_new_delivery_address: {
      type: 'wait',
      description: 'Ask user for new delivery address',
      onEntry: [
        {
          id: 'ask_address',
          executor: 'response',
          config: {
            message: '📍 Please share your delivery location or type your address:',
            buttons: [
              { id: 'btn_share', label: '📍 Share Location', value: '__LOCATION__' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'parse_new_delivery_address',
        location: 'save_parcel_delivery_location',
        default: 'parse_new_delivery_address',
      }
    },

    parse_new_delivery_address: {
      type: 'action',
      description: 'Parse user-typed delivery address',
      actions: [
        {
          id: 'geocode_delivery',
          executor: 'external_search',
          config: {
            query: '{{user_message}}',
            city: '{{or location.city "Nashik"}}',
            type: 'geocode',
            radius: 25000,
          },
          output: 'parsed_delivery_address',
        }
      ],
      transitions: {
        found: 'confirm_parsed_delivery_address',
        not_found: 'ask_new_delivery_address',
        error: 'ask_new_delivery_address',
      }
    },

    handle_delivery_address_verify: {
      type: 'action',
      description: 'Check if user confirmed delivery address',
      actions: [
        {
          id: 'verify',
          executor: 'llm',
          config: {
            prompt: 'User said: "{{user_message}}". Did they confirm yes or no? Return JSON: {"confirmed": true/false}',
            temperature: 0.1,
            maxTokens: 20,
            parseJson: true
          },
          output: '_delivery_verify',
        }
      ],
      transitions: {
        success: 'check_delivery_verified',
        error: 'ask_new_delivery_address',
      }
    },

    check_delivery_verified: {
      type: 'decision',
      conditions: [
        { expression: 'context._delivery_verify?.confirmed === true', event: 'confirmed' },
      ],
      transitions: {
        confirmed: 'create_simple_parcel_order',
        default: 'ask_new_delivery_address',
      }
    },

    confirm_parsed_delivery_address: {
      type: 'wait',
      description: 'Confirm the parsed delivery address',
      onEntry: [
        {
          id: 'confirm_parsed',
          executor: 'response',
          config: {
            saveToContext: {
              'parcel_delivery_location': {
                'lat': '{{parsed_delivery_address.topResult.lat}}',
                'lng': '{{parsed_delivery_address.topResult.lng}}',
                'address': '{{parsed_delivery_address.topResult.address}}',
              }
            },
            message: '📍 Is this your delivery address?\n\n**{{parsed_delivery_address.topResult.address}}**',
            buttons: [
              { id: 'btn_yes', label: '✅ Yes', value: 'yes correct' },
              { id: 'btn_no', label: '❌ No, try again', value: 'no wrong' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_delivery_address_verify',
        default: 'handle_delivery_address_verify',
      }
    },

    validate_zone: {
      type: 'action',
      description: 'Check if address is in service area',
      actions: [
        {
          id: 'check_zone',
          executor: 'zone',
          config: {
            latPath: 'delivery_address.latitude',
            lngPath: 'delivery_address.longitude',
          },
          output: 'delivery_zone',
        },
      ],
      transitions: {
        zone_valid: 'check_distance_type', // Changed from calculate_distance
        zone_invalid: 'out_of_zone',
        default: 'collect_address',  // Zone executor failed (missing/null coordinates) → ask again
        error: 'collect_address',    // Explicit error fallback
      },
    },

    calculate_distance: {
      type: 'action',
      description: 'Calculate delivery distance',
      actions: [
        {
          id: 'get_distance',
          executor: 'distance',
          config: {
            // Use storeLat/storeLng from cart_items (saved during add_to_cart)
            fromLatPath: 'cart_items.0.storeLat',
            fromLngPath: 'cart_items.0.storeLng',
            // delivery_address uses latitude/longitude not lat/lng
            toLatPath: 'delivery_address.latitude',
            toLngPath: 'delivery_address.longitude',
          },
          output: 'distance',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        calculated: 'calculate_pricing',
        error: 'distance_error',
      },
    },

    calculate_pricing: {
      type: 'action',
      description: 'Calculate food order pricing',
      actions: [
        {
          id: 'get_pricing',
          executor: 'pricing',
          config: {
            type: 'food',
            itemsPath: 'selected_items',
            distancePath: 'distance',
            deliveryPerKm: 10,
            taxRate: 0.05,
          },
          output: 'pricing',
        },
      ],
      transitions: {
        calculated: 'check_surge_price',
      },
    },

    check_distance_type: {
      type: 'decision',
      description: 'Route to correct distance calculation',
      conditions: [
        {
          expression: 'context.is_custom_order === true',
          event: 'custom',
        }
      ],
      transitions: {
        custom: 'calculate_custom_distance',
        default: 'calculate_distance',
      }
    },

    calculate_custom_distance: {
      type: 'action',
      description: 'Calculate distance for custom pickup',
      actions: [
        {
          id: 'get_custom_distance',
          executor: 'distance',
          config: {
            fromLatPath: 'custom_pickup_location.lat',
            fromLngPath: 'custom_pickup_location.lng',
            toLatPath: 'delivery_address.lat',
            toLngPath: 'delivery_address.lng',
          },
          output: 'distance',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        calculated: 'calculate_custom_pricing',
        error: 'distance_error',
      },
    },

    calculate_custom_pricing: {
      type: 'action',
      description: 'Calculate pricing for custom pickup (Parcel rates)',
      actions: [
        {
          id: 'get_custom_pricing',
          executor: 'pricing',
          config: {
            type: 'parcel', // Use parcel pricing for custom orders
            distancePath: 'distance',
            minimumFare: 40,
            perKmRate: 12,
            taxRate: 0.05,
          },
          output: 'pricing',
        },
      ],
      transitions: {
        calculated: 'show_custom_summary',
      },
    },

    show_custom_summary: {
      type: 'action',
      description: 'Show summary for custom pickup',
      actions: [
        {
          id: 'custom_summary_msg',
          executor: 'llm',
          config: {
            systemPrompt: 'Show custom pickup summary. Be clear this is a delivery-only service.',
            prompt: `Summary:
Pickup: {{custom_pickup_location.label}}
Drop: {{delivery_address.label}}
Item: {{custom_item_details}}
Distance: {{distance}} km
Delivery Fee: ₹{{pricing.total}}

Note: You need to pay the restaurant directly. We only charge for delivery.
Reply "confirm" to book the rider.`,
            temperature: 0.7,
            maxTokens: 200,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'check_final_confirmation', // Reuse existing confirmation logic
      },
    },

    check_surge_price: {
      type: 'action',
      description: 'Check if surge pricing applies for current time/zone',
      actions: [
        {
          id: 'get_surge',
          executor: 'php_api',
          config: {
            action: 'get_surge_price',
            zone_id: '{{zone_id}}',
            module_id: 4,
          },
          output: 'surge_info',
        },
      ],
      transitions: {
        success: 'route_surge_check',
        error: 'check_saved_payment',
        default: 'check_saved_payment',
      },
    },

    show_surge_notice: {
      type: 'wait',
      description: 'Inform user about surge pricing',
      onEntry: [
        {
          id: 'surge_message',
          executor: 'response',
          config: {
            message: '⚡ **{{surge_info.title}}**\n\n{{surge_info.customerNote}}\n\nSurge charge: ₹{{surge_info.price}} extra.\n\nDo you want to continue?',
            buttons: [
              { id: 'btn_surge_yes', label: '✅ Continue', value: 'confirm_surge' },
              { id: 'btn_surge_no', label: '❌ Cancel Order', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        confirm_surge: 'save_surge_confirmed',
        cancel: 'cancelled',
        user_message: 'handle_surge_response',
        default: 'save_surge_confirmed',
      },
    },

    handle_surge_response: {
      type: 'decision',
      description: 'Handle user response to surge pricing',
      conditions: [
        {
          expression: '/yes|ok|okay|confirm|continue|theek|haan|ha/i.test(context._user_message || "")',
          event: 'confirmed',
        },
        {
          expression: '/no|cancel|nahi|nhi|band|stop/i.test(context._user_message || "")',
          event: 'cancelled',
        },
      ],
      transitions: {
        confirmed: 'save_surge_confirmed',
        cancelled: 'cancelled',
        default: 'save_surge_confirmed',
      },
    },

    save_surge_confirmed: {
      type: 'action',
      description: 'Persist surge amount into context.data before payment selection',
      actions: [
        {
          id: 'persist_surge',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              surge_amount: '{{surge_info.price}}',
              surge_title: '{{surge_info.title}}',
              surge_applied: true,
            },
          },
          output: '_surge_saved',
        },
      ],
      transitions: {
        default: 'check_saved_payment',
      },
    },

    route_surge_check: {
      type: 'decision',
      description: 'Route to surge notice if surge applies, else skip to payment',
      conditions: [
        {
          expression: 'context.surge_info && context.surge_info.hasSurge === true',
          event: 'surge',
        },
      ],
      transitions: {
        surge: 'show_surge_notice',
        default: 'check_saved_payment',
      },
    },

    check_saved_payment: {
      type: 'action',
      description: 'Load preferred payment method from session (if previously saved)',
      actions: [
        {
          id: 'load_pref',
          executor: 'session',
          config: {
            action: 'get',
            keys: ['preferred_payment_method', 'preferred_payment_label'],
          },
          output: 'pref_payment_data',
        },
      ],
      transitions: {
        session_retrieved: 'route_payment_preference',
        default: 'collect_payment_method',
      },
    },

    route_payment_preference: {
      type: 'decision',
      description: 'Route to saved payment offer if preference exists',
      conditions: [
        {
          expression: `!!context.data?.pref_payment_data?.preferred_payment_method`,
          event: 'has_pref',
        },
      ],
      transitions: {
        has_pref: 'offer_saved_payment',
        default: 'collect_payment_method',
      },
    },

    offer_saved_payment: {
      type: 'wait',
      description: 'Ask if user wants to use their saved payment method',
      onEntry: [
        {
          id: 'show_saved_payment_offer',
          executor: 'response',
          config: {
            message: '💳 **Payment Method**\n\nUse your last payment method?\n\n⭐ **{{pref_payment_data.preferred_payment_label}}**',
            buttons: [
              { id: 'btn_use_saved', label: '✅ Yes, use this', value: 'use_saved_payment' },
              { id: 'btn_change_pmt', label: '🔄 Choose different', value: 'change_payment' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        use_saved_payment: 'apply_saved_payment',
        change_payment: 'collect_payment_method',
        user_message: 'handle_saved_payment_response',
        default: 'apply_saved_payment',
      },
    },

    handle_saved_payment_response: {
      type: 'decision',
      description: 'Parse yes/no response to saved payment offer',
      conditions: [
        {
          expression: `/yes|ok|okay|haan|ha|use|same|theek|sure/i.test(context._user_message || '')`,
          event: 'confirmed',
        },
        {
          expression: `/no|change|different|other|nahi|nope|choose/i.test(context._user_message || '')`,
          event: 'change',
        },
      ],
      transitions: {
        confirmed: 'apply_saved_payment',
        change: 'collect_payment_method',
        default: 'apply_saved_payment',
      },
    },

    apply_saved_payment: {
      type: 'decision',
      description: 'Route to correct payment setter based on saved preference',
      conditions: [
        {
          expression: `context.data?.pref_payment_data?.preferred_payment_method === 'cash_on_delivery'`,
          event: 'cod',
        },
        {
          expression: `context.data?.pref_payment_data?.preferred_payment_method === 'wallet'`,
          event: 'wallet',
        },
        {
          expression: `context.data?.pref_payment_data?.preferred_payment_method === 'digital_payment'`,
          event: 'digital',
        },
      ],
      transitions: {
        cod: 'set_payment_cod',
        wallet: 'check_wallet_balance',   // Wallet always needs balance check
        digital: 'set_payment_digital',
        default: 'collect_payment_method',
      },
    },

    collect_payment_method: {
      type: 'decision',
      description: 'Route payment collection by channel — WhatsApp Flow or standard',
      conditions: [
        {
          expression: `context.platform === 'whatsapp' && !!('${process.env.WA_FLOW_PAYMENT_ID || ''}')`,
          event: 'whatsapp_flow',
        },
      ],
      transitions: {
        whatsapp_flow: 'send_payment_flow',
        default: 'collect_payment_method_standard',
      },
    },

    send_payment_flow: {
      type: 'action',
      description: 'Send WhatsApp Flow for payment method selection',
      actions: [
        {
          id: 'send_wa_payment_flow',
          executor: 'response',
          config: {
            message: 'Tap below to select how you want to pay',
            flow: {
              flowId: process.env.WA_FLOW_PAYMENT_ID || '',
              flowType: 'payment_selection',
              ctaText: 'Pay Now',
              body: 'Tap below to select how you want to pay',
            },
          },
          output: '_payment_flow_result',
        },
      ],
      transitions: {
        flow_sent: 'await_flow_payment',
        default: 'collect_payment_method_standard', // Fallback if flow dispatch fails
        error: 'collect_payment_method_standard',
      },
    },

    await_flow_payment: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow payment response',
      actions: [],
      transitions: {
        flow_response: 'process_flow_payment',
        user_message: 'process_flow_payment',
        default: 'process_flow_payment',
      },
    },

    process_flow_payment: {
      type: 'action',
      description: 'Process payment method from WhatsApp Flow response',
      actions: [
        {
          id: 'load_flow_payment',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_payment_result',
          },
          output: 'flow_payment',
        },
        {
          id: 'save_flow_payment',
          executor: 'response',
          config: {
            saveToContext: {
              payment_method: '{{flow_payment.flow_payment_result.payment_method}}',
              payment_details: '{{flow_payment.flow_payment_result.payment_details}}',
            },
          },
          output: '_payment_saved',
        },
      ],
      transitions: {
        default: 'prompt_coupon_code',
      },
    },

    collect_payment_method_standard: {
      type: 'action',
      description: 'Fetch and display payment methods from PHP backend',
      actions: [
        {
          id: 'fetch_payment_methods',
          executor: 'php_api',
          config: {
            action: 'get_payment_methods',
          },
          output: 'payment_methods_response',
        },
        {
          id: 'show_payment_options',
          executor: 'response',
          config: {
            message: '💳 **Select Payment Method:**',
            buttonsPath: 'payment_methods_response.methods',
            buttonConfig: {
              labelPath: 'name',
              valuePath: 'id',
            },
            responseType: 'request_payment_method',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        success: 'wait_payment_selection',
        error: 'collect_payment_method_fallback',
      },
    },

    wait_payment_selection: {
      type: 'wait',
      description: 'Wait for payment method selection',
      actions: [],
      transitions: {
        user_message: 'select_payment_method',
        default: 'select_payment_method',
      },
    },

    collect_payment_method_fallback: {
      type: 'wait',
      description: 'Fallback payment method selection',
      onEntry: [
        {
          id: 'ask_payment_fallback',
          executor: 'response',
          config: {
            message: '💳 **Select Payment Method:**',
            buttons: [
              { id: 'btn_wallet', label: '👛 Wallet', value: 'wallet' },
              { id: 'btn_digital', label: '💳 Pay Online', value: 'digital_payment' },
              { id: 'btn_cod', label: '💵 Cash on Delivery', value: 'cash_on_delivery' },
            ],
            responseType: 'request_payment_method',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'select_payment_method',
        default: 'select_payment_method',
      },
    },

    select_payment_method: {
      type: 'decision',
      description: 'Determine payment method selection',
      conditions: [
        {
          expression: 'context._user_message === "wallet" || context._user_message?.toLowerCase().includes("wallet") || context._user_message?.toLowerCase().includes("balance")',
          event: 'wallet',
        },
        {
          expression: 'context._user_message === "cash_on_delivery" || context._user_message?.toLowerCase().includes("cod") || context._user_message?.toLowerCase().includes("cash")',
          event: 'cod',
        },
        {
          expression: 'context._user_message === "digital_payment" || context._user_message?.toLowerCase().includes("online") || context._user_message?.toLowerCase().includes("digital") || context._user_message?.toLowerCase().includes("upi") || context._user_message?.toLowerCase().includes("card") || context._user_message?.toLowerCase().includes("razor") || context._user_message?.toLowerCase().includes("pay online")',
          event: 'digital',
        },
      ],
      transitions: {
        wallet: 'check_wallet_balance',
        cod: 'set_payment_cod',
        digital: 'set_payment_digital',
        default: 'collect_payment_method',
      },
    },

    check_wallet_balance: {
      type: 'action',
      description: 'Check wallet balance and decide payment path',
      actions: [
        {
          id: 'fetch_wallet',
          executor: 'php_api',
          config: {
            action: 'get_wallet_balance',
            token: '{{auth_token}}',
          },
          output: 'wallet_info',
        },
      ],
      transitions: {
        success: 'decide_wallet_payment',
        error: 'set_payment_digital', // Fallback to digital if wallet check fails
      },
    },

    decide_wallet_payment: {
      type: 'decision',
      description: 'Check if wallet covers full amount or needs partial payment',
      conditions: [
        {
          // Wallet covers full amount
          expression: 'context.wallet_info?.balance >= context.pricing?.total',
          event: 'full_wallet',
        },
        {
          // Wallet has some balance but not enough - use partial payment
          expression: 'context.wallet_info?.balance > 0 && context.wallet_info?.balance < context.pricing?.total',
          event: 'partial_payment',
        },
      ],
      transitions: {
        full_wallet: 'set_payment_wallet',
        partial_payment: 'show_partial_payment_option',
        default: 'show_wallet_empty', // No wallet balance
      },
    },

    set_payment_wallet: {
      type: 'action',
      description: 'Set payment method to wallet',
      actions: [
        {
          id: 'save_payment_wallet',
          executor: 'response',
          config: {
            saveToContext: {
              payment_method: 'wallet',
              payment_method_label: 'Wallet',
              payment_details: { method: 'WALLET', id: 'wallet' },
            },
          },
          output: 'payment_saved',
        },
        {
          id: 'remember_wallet_pref',
          executor: 'session',
          config: {
            action: 'save',
            data: {
              preferred_payment_method: 'wallet',
              preferred_payment_label: 'Wallet Balance 👛',
            },
          },
          output: '_wallet_pref_saved',
        },
      ],
      transitions: {
        default: 'prompt_coupon_code',
      },
    },

    show_partial_payment_option: {
      type: 'wait',
      description: 'Show partial payment option',
      onEntry: [
        {
          id: 'show_partial',
          executor: 'response',
          config: {
            message: '👛 **Wallet Balance:** {{wallet_info.formattedBalance}}\n💰 **Order Total:** ₹{{pricing.total}}\n\n💡 Your wallet doesn\'t cover the full amount. I\'ll use your wallet balance first (₹{{wallet_info.balance}}) and the remaining **₹{{pricing.total - wallet_info.balance}}** will be charged online via Razorpay.\n\nShall I proceed?',
            buttons: [
              { id: 'btn_partial_yes', label: '✅ Yes, use wallet + pay rest online', value: 'yes use wallet' },
              { id: 'btn_full_online', label: '💳 Pay full amount online', value: 'pay full online' },
              { id: 'btn_cancel_payment', label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'handle_partial_payment_response',
        default: 'handle_partial_payment_response',
      },
    },

    handle_partial_payment_response: {
      type: 'decision',
      description: 'Handle partial payment selection',
      conditions: [
        {
          expression: '/yes|wallet|partial|proceed|haan|ha|ok/i.test(context._user_message || "")',
          event: 'use_partial',
        },
        {
          expression: '/full|online|digital|pay full|card|razorpay/i.test(context._user_message || "")',
          event: 'full_online',
        },
        {
          expression: '/cancel|no|nahi/i.test(context._user_message || "")',
          event: 'cancel',
        },
      ],
      transitions: {
        use_partial: 'set_payment_partial',
        full_online: 'set_payment_digital',
        cancel: 'collect_payment_method',
        default: 'show_partial_payment_option',
      },
    },

    set_payment_partial: {
      type: 'action',
      description: 'Set partial payment: wallet + online',
      actions: [
        {
          id: 'save_partial',
          executor: 'response',
          config: {
            saveToContext: {
              payment_method: 'partial_payment',
              payment_method_label: 'Wallet + Online',
              payment_details: {
                method: 'PARTIAL',
                id: 'partial_payment',
                wallet_amount: '{{wallet_info.balance}}',
                online_amount: '{{pricing.total - wallet_info.balance}}',
              },
            },
          },
          output: 'payment_saved',
        },
      ],
      transitions: {
        default: 'show_order_summary',
      },
    },

    show_wallet_empty: {
      type: 'wait',
      description: 'Wallet is empty, offer alternatives',
      onEntry: [
        {
          id: 'show_empty',
          executor: 'response',
          config: {
            message: '👛 Your wallet balance is **₹0**. Please choose another payment method:',
            buttons: [
              { id: 'btn_digital', label: '💳 Pay Online', value: 'digital_payment' },
              { id: 'btn_cod', label: '💵 Cash on Delivery', value: 'cash_on_delivery' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'select_payment_method',
        default: 'select_payment_method',
      },
    },

    set_payment_cod: {
      type: 'action',
      description: 'Set payment method to COD',
      actions: [
        {
          id: 'save_payment_cod',
          executor: 'response',
          config: {
            saveToContext: {
              payment_method: 'cash_on_delivery',
              payment_method_label: 'Cash on Delivery',
              payment_details: { method: 'COD', id: 'cash_on_delivery' },
            },
          },
          output: 'payment_saved',
        },
        {
          id: 'remember_cod_pref',
          executor: 'session',
          config: {
            action: 'save',
            data: {
              preferred_payment_method: 'cash_on_delivery',
              preferred_payment_label: 'Cash on Delivery 💵',
            },
          },
          output: '_cod_pref_saved',
        },
      ],
      transitions: {
        default: 'prompt_coupon_code',
      },
    },

    set_payment_digital: {
      type: 'action',
      description: 'Set payment method to Digital',
      actions: [
        {
          id: 'save_payment_digital',
          executor: 'response',
          config: {
            saveToContext: {
              payment_method: 'digital_payment',
              payment_method_label: 'Pay Online (UPI/Card)',
              payment_details: { method: 'ONLINE', id: 'digital_payment' },
            },
          },
          output: 'payment_saved',
        },
        {
          id: 'remember_digital_pref',
          executor: 'session',
          config: {
            action: 'save',
            data: {
              preferred_payment_method: 'digital_payment',
              preferred_payment_label: 'Online Payment (UPI/Card) 💳',
            },
          },
          output: '_digital_pref_saved',
        },
      ],
      transitions: {
        default: 'prompt_coupon_code',
      },
    },

    prompt_coupon_code: {
      type: 'wait',
      description: 'Fetch available coupons and ask if user wants to apply one',
      onEntry: [
        {
          id: 'fetch_coupons',
          executor: 'php_api',
          config: {
            action: 'get_coupons',
            token: '{{auth_token}}',
          },
          output: 'available_coupons',
        },
        {
          id: 'ask_coupon',
          executor: 'response',
          config: {
            message: '🏷️ Got a coupon code? Pick one below or type your code — or skip to continue.',
            buttonsPath: 'available_coupons.coupons',
            buttonConfig: { labelPath: 'label', valuePath: 'value' },
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_coupon: 'show_order_summary',
        user_message: 'apply_coupon_code',
        default: 'apply_coupon_code',
      },
    },

    apply_coupon_code: {
      type: 'action',
      description: 'Validate and apply coupon code',
      actions: [
        {
          id: 'validate_coupon',
          executor: 'php_api',
          config: {
            action: 'apply_coupon',
            code: '{{_user_message}}',
            order_amount: '{{pricing.total}}',
            store_id: '{{cart_store_id}}',
          },
          output: 'coupon_result',
        },
      ],
      transitions: {
        success: 'coupon_applied',
        error: 'coupon_invalid',
        default: 'coupon_invalid',
      },
    },

    coupon_applied: {
      type: 'action',
      description: 'Show coupon discount and update pricing',
      actions: [
        {
          id: 'save_coupon',
          executor: 'response',
          config: {
            message: '✅ **Coupon Applied!** You save ₹{{coupon_result.discount_amount}}!',
            saveToContext: {
              coupon_code: '{{_user_message}}',
              coupon_discount: '{{coupon_result.discount_amount}}',
              coupon_id: '{{coupon_result.coupon_id}}',
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'show_order_summary',
      },
    },

    coupon_invalid: {
      type: 'action',
      description: 'Show invalid coupon message',
      actions: [
        {
          id: 'show_invalid',
          executor: 'response',
          config: {
            message: '❌ Invalid or expired coupon code. Would you like to try another?',
            buttons: [
              { id: 'btn_try_again', label: '🔄 Try Another', value: 'try_coupon_again' },
              { id: 'btn_skip', label: '⏭️ Skip', value: 'skip_coupon' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        try_coupon_again: 'prompt_coupon_code',
        skip_coupon: 'show_order_summary',
        user_message: 'apply_coupon_code',
        default: 'show_order_summary',
      },
    },

    show_order_summary: {
      type: 'wait',
      description: 'Display complete order summary',
      onEntry: [
        {
          id: 'summary_message',
          executor: 'response',
          config: {
            message: '🛒 **Looks good! Here\'s your order summary** 😋\n\n{{cart_update_result.cartSummary}}\n\n🚚 Delivery Fee: ₹{{pricing.delivery_fee}} ({{distance}}km){{#if pricing.tax}}\n🧾 Tax: ₹{{pricing.tax}}{{/if}}{{#if surge_amount}}\n⚡ Surge ({{surge_title}}): ₹{{surge_amount}}{{/if}}\n{{#if coupon_discount}}🏷️ Coupon Discount: -₹{{coupon_discount}}\n{{/if}}💳 **Grand Total: ₹{{pricing.total}}{{#if surge_amount}} + ₹{{surge_amount}} surge{{/if}}**\n💸 Payment: {{payment_method_label}}\n\n📍 Delivering to: {{delivery_address.label}}\n{{delivery_address.address}}\n\n{{#if order_note}}📝 Note: {{order_note}}\n\n{{/if}}{{#if cart_update_result.isMultiStore}}📦 _{{cart_update_result.storeCount}} restaurants will prepare your order_\n\n{{/if}}_Ready to go? Hit confirm and I\'ll get it started!_ 🚀',
            buttons: [
              { id: 'btn_confirm', label: '✅ Confirm Order', value: 'confirm' },
              { id: 'btn_note', label: '📝 Add Note to Restaurant', value: 'add_note' },
              { id: 'btn_cancel', label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        add_note: 'collect_special_note',      // 🆕 User wants to add note to restaurant
        user_message: 'pre_check_confirmation',
        default: 'pre_check_confirmation',
      },
    },

    collect_special_note: {
      type: 'wait',
      description: 'Collect special instructions for the restaurant (pre-populated if captured at entry)',
      onEntry: [
        {
          id: 'ask_note',
          executor: 'response',
          config: {
            message: '{{#if order_note}}📝 We\'ll tell the restaurant: **"{{order_note}}"**\n\nWant to change it?{{else}}📝 What special instructions should we send to the restaurant?\n\n_Examples: "extra spicy", "no onions", "extra gravy", "less oil"_{{/if}}',
            buttons: [
              { id: 'btn_keep_note', label: '{{#if order_note}}✅ Keep It{{else}}⏭️ Skip{{/if}}', value: 'skip_note' },
              { id: 'btn_change_note', label: '{{#if order_note}}✏️ Change{{else}}📝 Add Note{{/if}}', value: 'change_note' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_note: 'show_order_summary',
        change_note: 'collect_new_special_note',
        user_message: 'save_special_note',
        default: 'save_special_note',
      },
    },

    collect_new_special_note: {
      type: 'wait',
      description: 'Collect replacement special instructions from user',
      onEntry: [
        {
          id: 'ask_new_note',
          executor: 'response',
          config: {
            message: '📝 What special instructions should we send to the restaurant?\n\n_Examples: "extra spicy", "no onions", "extra gravy", "less oil"_',
            buttons: [
              { id: 'btn_skip_note', label: '⏭️ Skip', value: 'skip_note' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_note: 'show_order_summary',
        user_message: 'save_special_note',
        default: 'save_special_note',
      },
    },

    save_special_note: {
      type: 'action',
      description: 'Save special note and return to order summary',
      actions: [
        {
          id: 'save_note',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              order_note: '{{_user_message}}',
            },
          },
          output: '_note_saved',
        },
      ],
      transitions: {
        default: 'show_order_summary',
      },
    },

    pre_check_confirmation: {
      type: 'decision',
      description: 'Fast regex check for confirm/cancel before NLU fallback',
      conditions: [
        {
          // Match button IDs (btn_confirm, confirm_order), common confirm phrases, and button titles with emojis
          expression: '/^(confirm|yes|ok|okay|haan|ha|haa|ji|place\\s*order|order\\s*karo|done|proceed|theek|thik|btn_confirm|confirm_order)$/i.test(String(_user_message || "").trim()) || /confirm\\s*order/i.test(String(_user_message || ""))',
          event: 'confirmed',
        },
        {
          expression: '/^(cancel|no|nahi|nhi|nah|band|stop|ruk|mat|chhodo|chhod|btn_cancel)$/i.test(String(_user_message || "").trim()) || /^[^a-z]*cancel/i.test(String(_user_message || ""))',
          event: 'cancelled',
        },
      ],
      transitions: {
        confirmed: 'cross_sell_gate',
        cancelled: 'cancelled',
        default: 'check_final_confirmation',
      },
    },

    check_final_confirmation: {
      type: 'action',
      description: 'Use NLU to evaluate final confirmation',
      actions: [
        {
          id: 'classify_confirm',
          executor: 'nlu_condition',
          config: {
            intents: ['confirm_action', 'confirm_checkout'],
            minConfidence: 0.5,
          },
          output: 'final_confirm_check',
        },
      ],
      transitions: {
        matched: 'cross_sell_gate',
        not_matched: 'check_final_cancel',
        default: 'show_order_summary',
      },
    },

    check_final_cancel: {
      type: 'action',
      description: 'Check if user wants to cancel order',
      actions: [
        {
          id: 'classify_final_cancel',
          executor: 'nlu_condition',
          config: {
            intents: ['cancel_flow', 'cancel_order'],
            minConfidence: 0.5,
          },
          output: 'final_cancel_check',
        },
      ],
      transitions: {
        matched: 'cancelled',
        not_matched: 'show_order_summary',
        default: 'show_order_summary',
      },
    },

    cross_sell_gate: {
      type: 'decision',
      description: 'Skip cross-sell if already shown this session',
      conditions: [
        {
          expression: 'context._cross_sell_shown === true',
          event: 'already_shown',
        },
      ],
      transitions: {
        already_shown: 'check_order_type_final',
        default: 'fetch_cross_sell',
      },
    },

    fetch_cross_sell: {
      type: 'action',
      description: 'Get frequently-bought-together items for cross-sell',
      actions: [
        {
          id: 'set_cross_sell_flag',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: { _cross_sell_shown: true },
          },
        },
        {
          id: 'get_cross_sell_items',
          executor: 'recommendation',
          config: { action: 'get_upsells', limit: 2, moduleId: 4 },
          output: 'cross_sell_results',
        },
      ],
      transitions: {
        items_found: 'show_cross_sell',
        no_items: 'check_order_type_final',
        error: 'check_order_type_final',
        default: 'check_order_type_final',
      },
    },

    show_cross_sell: {
      type: 'wait',
      description: 'Show cross-sell items before order placement',
      onEntry: [
        {
          id: 'display_cross_sell',
          executor: 'response',
          config: {
            message: '🤔 **Before we place your order...**\nCustomers who ordered this also loved:',
            cardsPath: 'cross_sell_results.cards',
            buttons: [
              { id: 'btn_skip_cs', label: '⏩ No thanks, place order', value: 'skip_cross_sell' },
            ],
          },
          output: '_cs_response',
        },
      ],
      actions: [],
      transitions: {
        skip_cross_sell: 'check_order_type_final',
        user_message: 'handle_cross_sell_selection',
        default: 'check_order_type_final',
      },
    },

    handle_cross_sell_selection: {
      type: 'decision',
      description: 'Check if user wants to add a cross-sell item or skip',
      conditions: [
        {
          expression: '/^(no|nahi|nhi|skip|nah|place|confirm|done|order)$/i.test(String(_user_message || "").trim())',
          event: 'skip',
        },
      ],
      transitions: {
        skip: 'check_order_type_final',
        default: 'add_cross_sell_to_cart',
      },
    },

    add_cross_sell_to_cart: {
      type: 'action',
      description: 'Add selected cross-sell item to cart',
      actions: [
        {
          id: 'add_cs_item',
          executor: 'selection',
          config: {
            action: 'select_from_message',
            source: 'cross_sell_results',
          },
          output: 'cs_selection',
        },
      ],
      transitions: {
        success: 'show_current_cart',
        error: 'check_order_type_final',
        default: 'check_order_type_final',
      },
    },

    check_order_type_final: {
      type: 'decision',
      description: 'Route to correct order placement (custom, multi-store, or single)',
      conditions: [
        {
          expression: 'context.is_custom_order === true',
          event: 'custom',
        },
        {
          // Multi-store cart: items from multiple restaurants
          expression: 'context.cart_validation?.isMultiStore === true || context.cart_update_result?.isMultiStore === true',
          event: 'multi_store',
        },
      ],
      transitions: {
        custom: 'place_custom_order',
        multi_store: 'check_payment_type_multi_store',
        default: 'check_store_before_order', // single-store: verify open first
      }
    },

    check_store_before_order: {
      type: 'action',
      description: 'Check if the restaurant is open and accepting orders before payment',
      actions: [
        {
          id: 'store_open_check',
          executor: 'inventory',
          config: {
            action: 'check_store',
            storeIdPath: 'cart_store_id', // Cart manager saves store ID here (not store_id)
          },
          output: 'pre_order_store_check',
        },
      ],
      transitions: {
        open: 'check_payment_type_for_order',
        closed: 'store_currently_closed',
        error: 'check_payment_type_for_order', // graceful on PHP error — PHP validates at order time
      },
    },

    store_currently_closed: {
      type: 'end',
      description: 'Inform user the restaurant is closed and cannot accept orders right now',
      actions: [
        {
          id: 'closed_message',
          executor: 'response',
          config: {
            message: '🔒 *Restaurant is currently closed*\n\n{{pre_order_store_check.message}}\n\nWould you like to search for another restaurant or try again later?',
          },
          output: '_last_response',
        },
      ],
      transitions: {},
    },

    check_payment_type_multi_store: {
      type: 'decision',
      description: 'Route multi-store payment: wallet goes direct, digital/partial needs gateway',
      conditions: [
        {
          expression: 'context.payment_method === "wallet"',
          event: 'wallet',
        },
        {
          expression: 'context.payment_method === "partial_payment" || context.payment_method === "digital_payment"',
          event: 'digital',
        },
      ],
      transitions: {
        wallet: 'place_multi_store_order',
        digital: 'place_multi_store_order_digital',
        default: 'place_multi_store_order', // COD
      },
    },

    place_multi_store_order: {
      type: 'action',
      description: 'Place separate orders per store (COD or wallet)',
      actions: [
        {
          id: 'create_multi_order',
          executor: 'order',
          config: {
            type: 'multi_store',
            itemsPath: 'selected_items',
            addressPath: 'delivery_address',
            paymentPath: 'payment_details',
            pricingPath: 'pricing',
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 1,
        },
      ],
      transitions: {
        success: 'multi_store_completed',
        error: 'order_failed',
      },
    },

    place_multi_store_order_digital: {
      type: 'action',
      description: 'Place separate orders per store with digital/partial payment',
      actions: [
        {
          id: 'create_multi_digital_order',
          executor: 'order',
          config: {
            type: 'multi_store',
            paymentMethod: 'digital_payment',
            itemsPath: 'selected_items',
            addressPath: 'delivery_address',
            paymentPath: 'payment_details',
            pricingPath: 'pricing',
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 1,
        },
      ],
      transitions: {
        success: 'show_food_payment_gateway',
        error: 'order_failed',
      },
    },

    multi_store_completed: {
      type: 'action',
      description: 'Show multi-store order confirmation with all order IDs',
      actions: [
        {
          id: 'show_multi_confirmation',
          executor: 'response',
          config: {
            message: '🎉 **All orders placed! Time to get hungry!** 🍴\n\n{{order_result.message}}\n\n📦 Order IDs: {{order_result.orderIds}}\n🔗 Track: {{order_result.trackingUrl}}\n\n_Each restaurant is now preparing your order. I\'ll send you WhatsApp updates as they progress!_ 📱',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'completed',
      },
    },

    check_payment_type_for_order: {
      type: 'decision',
      description: 'Route COD vs digital vs wallet payment for order placement',
      conditions: [
        {
          expression: 'context.payment_method === "wallet"',
          event: 'wallet',
        },
        {
          expression: 'context.payment_method === "partial_payment"',
          event: 'digital', // Partial still goes through digital payment gateway for the remaining amount
        },
        {
          expression: 'context.payment_method === "digital_payment" || context.payment_details?.method === "ONLINE"',
          event: 'digital',
        },
      ],
      transitions: {
        wallet: 'place_order',     // Wallet deducted server-side by PHP, like COD
        digital: 'place_order_digital',
        default: 'place_order', // COD or fallback
      },
    },

    place_order: {
      type: 'action',
      description: 'Create food order with COD payment',
      actions: [
        {
          id: 'create_order',
          executor: 'order',
          config: {
            type: 'food',
            itemsPath: 'selected_items',
            addressPath: 'delivery_address',
            paymentPath: 'payment_details',
            pricingPath: 'pricing',
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        success: 'completed',
        auth_expired: 'auth_expired_relogin',
        error: 'order_failed',
      },
    },

    place_order_digital: {
      type: 'action',
      description: 'Create food order with digital payment and show payment gateway',
      actions: [
        {
          id: 'create_digital_order',
          executor: 'order',
          config: {
            type: 'food',
            paymentMethod: 'digital_payment',
            itemsPath: 'selected_items',
            addressPath: 'delivery_address',
            paymentPath: 'payment_details',
            pricingPath: 'pricing',
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        success: 'show_food_payment_gateway',
        auth_expired: 'auth_expired_relogin',
        error: 'order_failed',
        default: 'order_failed',
      },
    },

    show_food_payment_gateway: {
      type: 'action',
      description: 'Open payment gateway or send payment link for food order',
      actions: [
        {
          id: 'payment_gateway',
          executor: 'response',
          config: {
            channelResponses: {
              whatsapp: {
                message: '💳 *Complete Payment*\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{order_result.orderTotal}}\n\n🔗 Pay securely here:\n{{order_result.paymentLink}}\n\n⏱️ Complete payment within 10 minutes.\nAfter payment, you\'ll receive order confirmation automatically.',
                metadata: {
                  action: 'payment_link_sent',
                  orderId: '{{order_result.orderId}}',
                },
              },
              telegram: {
                message: '💳 *Complete Payment*\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{order_result.orderTotal}}\n\n🔗 Pay securely here:\n{{order_result.paymentLink}}\n\n⏱️ Complete payment within 10 minutes.',
                metadata: {
                  action: 'payment_link_sent',
                  orderId: '{{order_result.orderId}}',
                },
              },
              default: {
                message: '💳 **Complete Payment**\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{order_result.orderTotal}}\n\n🔗 Click below to pay securely:',
                metadata: {
                  action: 'open_payment_gateway',
                  payment_data: {
                    orderId: '{{order_result.orderId}}',
                    razorpayOrderId: '{{order_result.razorpayOrderId}}',
                    amount: '{{order_result.orderTotal}}',
                    paymentLink: '{{order_result.paymentLink}}',
                    currency: 'INR',
                    name: 'Mangwale',
                    description: 'Food Order',
                    prefill: {
                      name: '{{session.user_name}}',
                      phone: '{{session.phone}}',
                    }
                  }
                },
              },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_food_payment_result',
      },
    },

    wait_food_payment_result: {
      type: 'wait',
      description: 'Wait for food order payment completion',
      timeout: 300000, // 5 minutes timeout
      onEntry: [],
      transitions: {
        user_message: 'check_food_payment_result',
        timeout: 'food_payment_timeout',
        default: 'check_food_payment_result',
      },
    },

    check_food_payment_result: {
      type: 'decision',
      description: 'Check if food payment succeeded or failed',
      conditions: [
        {
          // Safety valve: after 3 failed payment checks, offer COD fallback
          // _payment_checks is a string counter ("x" per check), appended in food_payment_not_confirmed_yet
          expression: '(context._payment_checks || "").length >= 3',
          event: 'too_many_checks',
        },
        {
          expression: 'context._user_message === "__payment_success__"',
          event: 'payment_success',
        },
        {
          expression: 'context._user_message === "__payment_failed__" || context._user_message?.includes("payment_failed")',
          event: 'payment_failed',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no|stop)$/)',
          event: 'cancelled',
        },
        {
          expression: '/^(payment\\s*(is\\s*)?done|paid|pay\\s*kiya|pay\\s*kar\\s*diya|payment\\s*ho\\s*gaya|payment\\s*ho\\s*gya|payment\\s*complete|payment\\s*success|payment\\s*kar\\s*diya|paise\\s*de\\s*diye|paisa\\s*diya|done|ho\\s*gaya|check\\s*status|status\\s*check|verify|payment\\s*kiya)/i.test(String(context._user_message || "").trim())',
          event: 'maybe_paid',
        },
      ],
      transitions: {
        too_many_checks: 'offer_cod_fallback',
        payment_success: 'completed',
        payment_failed: 'food_payment_failed',
        cancelled: 'cancelled',
        maybe_paid: 'verify_food_payment_via_api',
        default: 'food_payment_still_waiting',
      },
    },

    verify_food_payment_via_api: {
      type: 'action',
      description: 'Check food order payment status from PHP backend',
      actions: [
        {
          id: 'check_food_order_status',
          executor: 'php_api',
          config: {
            action: 'get_order_details',
            token: '{{auth_token}}',
            orderId: '{{order_result.orderId}}',
          },
          output: '_food_order_status_check',
        },
      ],
      transitions: {
        default: 'evaluate_food_payment_status',
      },
    },

    evaluate_food_payment_status: {
      type: 'decision',
      description: 'Check if PHP confirms food payment',
      conditions: [
        {
          expression: 'context._food_order_status_check?.paymentStatus === "paid" || context._food_order_status_check?.payment_status === "paid"',
          event: 'confirmed_paid',
        },
        {
          expression: 'context._food_order_status_check?.orderStatus === "confirmed" || context._food_order_status_check?.order_status === "confirmed"',
          event: 'confirmed_paid',
        },
      ],
      transitions: {
        confirmed_paid: 'completed',
        default: 'food_payment_not_confirmed_yet',
      },
    },

    food_payment_not_confirmed_yet: {
      type: 'action',
      description: 'Tell user food payment not yet confirmed, increment check counter',
      actions: [
        {
          id: 'increment_payment_check_count',
          executor: 'response',
          config: {
            saveToContext: {
              // String-append counter: each check adds "x", condition checks length >= 3
              _payment_checks: '{{_payment_checks}}x',
            },
          },
          output: '_payment_counter_set',
        },
        {
          id: 'food_not_confirmed_msg',
          executor: 'response',
          config: {
            message: '⏳ Payment not yet confirmed.\n\nIf you have already paid, please wait 1-2 minutes for processing.\n\nIf not, tap below to pay:\n🔗 {{order_result.paymentLink}}',
            buttons: [
              { label: '🔄 Check Again', value: 'payment is done' },
              { label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_food_payment_result',
      },
    },

    food_payment_still_waiting: {
      type: 'action',
      description: 'Acknowledge message and keep waiting for food payment',
      actions: [
        {
          id: 'food_still_waiting_msg',
          executor: 'response',
          config: {
            message: '⏳ Waiting for your payment...\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{order_result.orderTotal}}\n\nClick the button below to pay, or reply "cancel" to cancel.',
            metadata: {
              action: 'open_payment_gateway',
              payment_data: {
                orderId: '{{order_result.orderId}}',
                amount: '{{order_result.orderTotal}}',
                paymentLink: '{{order_result.paymentLink}}',
              },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_food_payment_result',
      },
    },

    offer_cod_fallback: {
      type: 'action',
      description: 'Online payment not going through — offer COD as fallback',
      actions: [
        {
          id: 'cod_fallback_msg',
          executor: 'response',
          config: {
            message: '😕 Online payment is not going through.\n\nWould you like to switch to **Cash on Delivery** instead?\n\n💰 Order Total: ₹{{order_result.orderTotal}}',
            buttons: [
              { label: '💵 Cash on Delivery', value: 'switch_to_cod', action: 'switch_to_cod' },
              { label: '🔄 Try Again', value: 'retry_payment', action: 'retry_payment' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel_order' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'await_cod_fallback_decision',
      },
    },

    await_cod_fallback_decision: {
      type: 'wait',
      description: 'Wait for user decision on COD fallback',
      onEntry: [],
      transitions: {
        switch_to_cod: 'set_payment_cod',
        retry_payment: 'show_food_payment_gateway',
        cancel_order: 'cancelled',
        user_message: 'handle_cod_fallback_input',
        default: 'handle_cod_fallback_input',
      },
    },

    handle_cod_fallback_input: {
      type: 'decision',
      description: 'Interpret user text response for COD fallback',
      conditions: [
        {
          expression: '/^(cod|cash|cash\\s*on\\s*delivery|haan\\s*cod|yes\\s*cod|switch)/i.test(String(context._user_message || "").trim())',
          event: 'switch_to_cod',
        },
        {
          expression: '/^(retry|try|phir\\s*se|again|dobara)/i.test(String(context._user_message || "").trim())',
          event: 'retry_payment',
        },
        {
          expression: '/^(cancel|nahi|no|stop)/i.test(String(context._user_message || "").trim())',
          event: 'cancelled',
        },
      ],
      transitions: {
        switch_to_cod: 'set_payment_cod',
        retry_payment: 'show_food_payment_gateway',
        cancelled: 'cancelled',
        default: 'set_payment_cod', // Default to COD since online wasn't working
      },
    },

    food_payment_failed: {
      type: 'action',
      description: 'Handle food payment failure',
      actions: [
        {
          id: 'payment_error',
          executor: 'response',
          config: {
            message: '❌ **Payment Failed**\n\nYour payment could not be completed. The order has been saved.\n\nYou can retry payment or cancel:',
            buttons: [
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '❌ Cancel Order', value: 'cancel', action: 'cancel_order' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'await_food_payment_retry',
      },
    },

    await_food_payment_retry: {
      type: 'wait',
      description: 'Wait for user decision on food payment retry',
      onEntry: [],
      transitions: {
        switch_to_cod: 'set_payment_cod',
        retry_payment: 'show_food_payment_gateway',
        cancel_order: 'cancelled',
        user_message: 'handle_food_payment_retry_input',
        default: 'handle_food_payment_retry_input',
      },
    },

    handle_food_payment_retry_input: {
      type: 'action',
      description: 'Handle text input for food payment retry',
      actions: [
        {
          id: 'interpret_retry',
          executor: 'nlu_condition',
          config: {
            intents: ['cancel_flow', 'cancel_order'],
            minConfidence: 0.5,
          },
          output: '_retry_cancel_check',
        },
      ],
      transitions: {
        matched: 'cancelled',
        not_matched: 'show_food_payment_gateway', // Default: retry payment
        default: 'show_food_payment_gateway',
      },
    },

    food_payment_timeout: {
      type: 'action',
      description: 'Food payment timed out — offer COD, retry, or cancel',
      actions: [
        {
          id: 'timeout_msg',
          executor: 'response',
          config: {
            message: '⏰ **Payment Timeout**\n\nPayment session expired. Your order has been saved.\n\nWhat would you like to do?',
            buttons: [
              { label: '💵 Cash on Delivery', value: 'switch_to_cod', action: 'switch_to_cod' },
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel_order' },
            ],
          },
        },
      ],
      transitions: {
        default: 'await_food_payment_retry',
      },
    },

};
