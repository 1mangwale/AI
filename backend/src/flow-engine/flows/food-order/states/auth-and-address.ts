import { FlowState } from '../../../types/flow.types';

/**
 * Food Order Flow — Auth And Address States
 * Auto-extracted from food-order.flow.ts
 */
export const authAndAddressStates: Record<string, FlowState> = {
    check_saved_address_intent: {
      type: 'decision',
      description: 'Check if user wants to use a saved address via entities or keywords',
      conditions: [
        {
          // Check if NLU extracted delivery_address_type (e.g., "home", "office") in detect_express_order
          expression: `context.express_order_detection?.delivery_address_type && 
                       context.express_order_detection.delivery_address_type !== 'null' && 
                       context.express_order_detection.delivery_address_type !== '' &&
                       context.express_order_detection.delivery_address_type !== null`,
          event: 'has_address_hint',
        },
        {
          // Check saved _delivery_address_type from express order flow
          expression: `context._delivery_address_type && 
                       context._delivery_address_type !== 'null' && 
                       context._delivery_address_type !== '' &&
                       context._delivery_address_type !== null`,
          event: 'has_address_hint',
        },
        {
          // Keyword fallback: check for home/office/ghar in original message
          expression: `/\\b(home|ghar|office|daftar|delivered at home|deliver at home|delivery at home|ghar pe|ghar par|घर|ऑफिस)\\b/i.test(context._user_message || context.original_food_query || '')`,
          event: 'has_address_hint',
        },
      ],
      transitions: {
        has_address_hint: 'auto_select_saved_address',
        default: 'check_existing_location',
      },
    },

    check_existing_location: {
      type: 'decision',
      description: 'Check if location already available in session context - avoids re-asking',
      conditions: [
        {
          // Session already has location from previous interaction
          expression: 'context.location && context.location.lat && context.location.lng',
          event: 'has_location',
        }
      ],
      transitions: {
        // 🔧 FIX: If location exists in session, still need to restore original query
        // before NLU analysis to avoid hallucination
        has_location: 'restore_original_query',
        default: 'request_location',
      },
    },

    auto_select_saved_address: {
      type: 'action',
      description: 'Fetch saved addresses and auto-select home/office based on user message',
      actions: [
        {
          id: 'fetch_and_select',
          executor: 'saved_address_selector',
          config: {
            addressTypeHint: '{{_user_message}}', // Will parse home/office from message
            saveToContext: 'delivery_address',
          },
          onError: 'continue', // Don't fail flow if user not authenticated - just transition to request_location
        },
      ],
      transitions: {
        address_selected: 'use_saved_address_location',    // Address found and selected
        no_auth: 'prompt_login_for_saved_address',         // Guest user → show login option
        no_saved_address: 'request_location',              // Logged-in but no saved address → ask location
        default: 'request_location',
      },
    },

    prompt_login_for_saved_address: {
      type: 'wait',
      description: 'User mentioned home/office address but is not logged in. Offer login or live location.',
      onEntry: [
        {
          id: 'ask_login_or_location',
          executor: 'response',
          config: {
            message: '📍 To deliver to your saved home/office address, please log in first.\n\nOr tap *Share Location* to order as a guest.',
            responseType: 'prompt_login_or_location',
            buttons: [
              { id: 'btn_login', label: '🔑 Log In / Register', value: 'login', action: 'trigger_auth_modal' },
              { id: 'btn_location', label: '📍 Share Location', value: '__LOCATION__' },
              { id: 'btn_skip', label: 'Skip for now', value: 'skip_location' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        location_shared: 'confirm_location_received',     // User shared GPS from this prompt
        user_message: 'handle_post_login_or_location',   // Check if login or location
        default: 'handle_post_login_or_location',
      },
    },

    handle_post_login_or_location: {
      type: 'decision',
      description: 'Route based on whether user logged in, shared location, or skipped',
      conditions: [
        {
          // GPS location prefix from WhatsApp
          expression: 'context._user_message?.startsWith("LOCATION:")',
          event: 'location_shared',
        },
        {
          // GPS coordinates in context (from web location picker)
          expression: 'context.location?.lat && context.location?.lng',
          event: 'location_shared',
        },
        {
          // User skipped login prompt
          expression: '/^(skip|skip_location)$/i.test(context._user_message?.trim() || "")',
          event: 'skipped',
        },
        {
          // User cancelled login modal (X button sends 'cancel') → ask for live location
          expression: '/^cancel$/i.test(context._user_message?.trim() || "")',
          event: 'cancelled',
        },
        {
          // User just logged in (frontend sends 'checkout' after syncAuthLogin)
          // Re-try address selection now that we have auth
          expression: 'context.user_authenticated === true',
          event: 'authenticated',
        },
      ],
      transitions: {
        location_shared: 'confirm_location_received',  // GPS shared → proceed with location
        skipped: 'restore_original_query',             // Skipped → restore and search (no location)
        cancelled: 'request_location',                 // Dismissed login → ask for live location
        authenticated: 'auto_select_saved_address',    // Just logged in → re-try address selection
        default: 'extract_location_from_text',         // Text input → try to parse as area name
      },
    },

    use_saved_address_location: {
      type: 'action',
      description: 'Copy saved address coordinates to location context for geo-search',
      actions: [
        {
          id: 'copy_location',
          executor: 'response',
          config: {
            saveToContext: {
              location: {
                lat: '{{delivery_address.latitude}}',
                lng: '{{delivery_address.longitude}}',
              },
              _address_auto_selected: true,
              _location_source: 'saved_address',
            },
            event: 'location_set',
          },
        },
      ],
      transitions: {
        // 🔧 FIX: Must restore original query before NLU analysis
        location_set: 'restore_original_query',
        default: 'restore_original_query',
      },
    },

    request_location: {
      type: 'wait',
      description: 'Ask user to share their location for better results',
      onEntry: [
        {
          id: 'ask_location',
          executor: 'response',
          config: {
            message: '📍 To show you the best food options nearby, please share your location!\n\nTap the button below or type your area name.',
            responseType: 'request_location',
            buttons: [
              { id: 'btn_location', label: '📍 Share Location', value: '__LOCATION__' },
              { id: 'btn_skip', label: 'Skip for now', value: 'skip_location' }
            ]
          },
          output: '_last_response',
        }
      ],
      transitions: {
        location_shared: 'confirm_location_received',
        user_message: 'handle_location_response',
        default: 'handle_location_response',
      },
    },

    confirm_location_received: {
      type: 'action',
      description: 'Set flag that location was just received (confirmation shown in next prompt)',
      actions: [
        {
          id: 'set_location_confirmed_flag',
          executor: 'response',
          config: {
            // Clear the old request_location responseType by setting a new one
            responseType: 'silent',
            saveToContext: {
              _location_just_received: true,
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'restore_original_query',
      },
    },

    handle_location_response: {
      type: 'decision',
      description: 'Check if user shared GPS location, skipped, or provided area name',
      conditions: [
        {
          // Check if message contains LOCATION: prefix (from WhatsApp GPS share)
          expression: 'context._user_message?.startsWith("LOCATION:")',
          event: 'location_shared',
        },
        {
          // Check if GPS coordinates were shared (location object in context)
          expression: 'context.location?.lat && context.location?.lng',
          event: 'location_shared',
        },
        {
          // Check if _raw_location has coordinates (from message)
          expression: 'context._raw_location?.lat && context._raw_location?.lng',
          event: 'location_shared',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("skip")',
          event: 'skipped',
        }
      ],
      transitions: {
        location_shared: 'confirm_location_received', // GPS coordinates received - confirm and restore query
        skipped: 'restore_original_query', // Continue without location
        default: 'extract_location_from_text',
      },
    },

    restore_original_query: {
      type: 'action',
      description: 'Restore the original food query to _user_message for NLU analysis. Also marks session as location-ready.',
      actions: [
        {
          id: 'restore_query',
          executor: 'response',
          config: {
            saveToContext: {
              // Restore original query for NLU analysis
              _user_message: '{{original_food_query}}',
              // Mark session as having location ready - prevents re-asking
              _session_has_location: true,
              _location_captured_at: '{{_now}}',
            },
            event: 'restored',
          },
        },
      ],
      transitions: {
        restored: 'understand_request',
        default: 'understand_request',
      },
    },

    extract_location_from_text: {
      type: 'action',
      description: 'Extract location from user area name',
      actions: [
        {
          id: 'parse_area',
          executor: 'address',
          config: {
            field: 'location',
            useUserMessage: true,
            city: 'Nashik',
          },
          output: 'location',
        }
      ],
      transitions: {
        // 🔧 FIX: Restore original food query after text location extraction
        address_valid: 'restore_original_query',
        waiting_for_input: 'request_location', // Go back to request if address not found
        error: 'restore_original_query', // Continue even if extraction fails - but restore query first!
        default: 'restore_original_query', // Fallback - always restore query
      },
    },

    request_exact_location: {
      type: 'wait',
      description: 'Ask user for exact location',
      actions: [
        {
          id: 'ask_location',
          executor: 'response',
          config: {
            message: '📍 I couldn\'t find that location. Please:\n\n• Share your **GPS location** using the button below, or\n• Type the **exact address** with landmarks',
            buttons: [
              { id: 'btn_share', label: '📍 Share Location', value: '__LOCATION__' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_custom_pickup_location',
        location: 'save_custom_pickup_location',
        default: 'handle_custom_pickup_location',
      }
    },

    handle_location_confirmation: {
      type: 'action',
      description: 'Check if user confirmed the location',
      actions: [
        {
          id: 'parse_confirmation',
          executor: 'llm',
          config: {
            prompt: 'User said: "{{user_message}}". Did they confirm the location is correct? Return JSON: {"confirmed": true/false}',
            temperature: 0.1,
            maxTokens: 30,
            parseJson: true
          },
          output: '_location_confirmation',
        }
      ],
      transitions: {
        success: 'check_location_confirmed',
        error: 'request_exact_location',
      }
    },

    check_location_confirmed: {
      type: 'decision',
      conditions: [
        {
          expression: 'context._location_confirmation?.confirmed === true',
          event: 'confirmed',
        }
      ],
      transitions: {
        confirmed: 'finalize_custom_pickup_location',
        default: 'request_exact_location',
      }
    },

    auth_expired_relogin: {
      type: 'action',
      description: 'Auth token expired - inform user and redirect to login',
      actions: [
        {
          id: 'notify_reauth',
          executor: 'response',
          config: {
            message: 'Your session has expired. Please log in again to complete your order. Your cart items have been saved.',
          },
        },
      ],
      transitions: {
        default: 'check_auth_before_flow',
      },
    },

    check_auth_before_flow: {
      type: 'action',
      description: 'Refresh auth from session and check if user is logged in',
      actions: [
        {
          id: 'refresh_auth_status',
          executor: 'session',
          config: { action: 'refresh_auth' },
          output: '_auth_status',
        },
      ],
      transitions: {
        authenticated: 'show_order_summary',
        not_authenticated: 'prompt_login_for_order',
        default: 'prompt_login_for_order',
      },
    },

    check_auth_for_checkout: {
      type: 'action',
      description: 'Refresh auth from session then check if user is authenticated before checkout',
      actions: [
        {
          id: 'refresh_auth_before_checkout',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_auth_refresh_result',
        },
      ],
      transitions: {
        next: 'decide_auth_for_checkout',
        default: 'decide_auth_for_checkout',
      },
    },

    prompt_login_for_order: {
      type: 'action',
      description: 'Prompt user to log in before placing order',
      actions: [
        {
          id: 'login_prompt',
          executor: 'response',
          config: {
            message: 'Please log in to place your order. Your cart has been saved and will be available after login.',
          },
        },
      ],
      transitions: {
        default: 'completed',
      },
    },

};
