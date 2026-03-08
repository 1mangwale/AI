import { FlowDefinition } from '../types/flow.types';

/**
 * SIMPLIFIED PARCEL DELIVERY FLOW
 * 
 * Philosophy: Ask ONLY what PHP API requires, nothing extra
 * 
 * Required PHP Payload Fields:
 * 1. Pickup address (lat, lng, address string)
 * 2. Delivery address (lat, lng, address string)
 * 3. Recipient name
 * 4. Recipient phone
 * 5. Vehicle type (parcel_category_id)
 * 
 * Optional: distance (auto-calculated), payment_method (defaults to COD)
 * 
 * Total Questions: 5 (down from 8-12)
 * Lines of Code: ~400 (down from 1436)
 */

export const parcelDeliveryFlow: FlowDefinition = {
  id: 'parcel_delivery_v1',
  name: 'Coolie / Local Delivery - Simplified',
  description: 'Streamlined parcel booking: 5 questions → Order placed (Nashik only)',
  module: 'parcel',
  trigger: 'parcel_booking',
  version: '2.0.0',
  
  contextSchema: {
    pickup_address: { type: 'object', required: true },
    delivery_address: { type: 'object', required: true },
    recipient_details: { type: 'object', required: true },
    distance: { type: 'number', required: true },
    pricing: { type: 'object', required: true },
    parcel_category_id: { type: 'number', required: true },
    order_result: { type: 'object', required: false },
  },
  
  states: {
    // Start: Check if user is authenticated
    check_trigger: {
      type: 'decision',
      description: 'Entry point - check initial context',
      conditions: [
        {
          expression: 'context._trigger === "parcel_booking_simple"',
          event: 'valid_trigger',
        },
      ],
      transitions: {
        valid_trigger: 'init',
        default: 'init',
      },
    },

    // Initialize - welcome message
    init: {
      type: 'action',
      description: 'Welcome and start parcel booking',
      actions: [
        {
          id: 'welcome',
          executor: 'response',
          config: {
            message: '📦 **Local Parcel Delivery** (Nashik only)\n\nI need 5 quick details to book your delivery. Let\'s start!',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'check_auth_before_flow',
      },
    },

    // CHECK AUTH EARLY - Refresh and check auth from session
    // Uses session executor to get FRESH auth data (handles race with session:join)
    check_auth_before_flow: {
      type: 'action',
      description: 'Refresh auth from session and check if user is logged in',
      actions: [
        {
          id: 'refresh_auth_status',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_auth_status',
        },
      ],
      transitions: {
        // session executor returns 'authenticated' or 'not_authenticated' event
        // Now we also check if user needs phone (Google OAuth without PHP account)
        authenticated: 'check_php_account',
        not_authenticated: 'require_login_first',
        default: 'require_login_first',
      },
    },

    // 🔧 NEW: Check if authenticated user has PHP account or just Google OAuth
    check_php_account: {
      type: 'action',
      description: 'Check if user has PHP account (user_id) or needs phone collection',
      actions: [
        {
          id: 'check_php_status',
          executor: 'session',
          config: {
            action: 'check_php_account',
          },
          output: '_php_check',
        },
      ],
      transitions: {
        has_php_account: 'fetch_saved_addresses_before_pickup', // 🔧 FIX: Fetch saved addresses if user has PHP account
        needs_phone: 'collect_phone_for_oauth',
        default: 'collect_pickup', // If unknown, proceed to collect pickup
      },
    },

    // 🔧 NEW: Fetch saved addresses before collecting pickup (if user is authenticated)
    fetch_saved_addresses_before_pickup: {
      type: 'decision',
      description: 'Check if we have auth_token before fetching saved addresses',
      conditions: [
        {
          expression: 'context.auth_token && context.auth_token.length > 0',
          event: 'has_token',
        },
      ],
      transitions: {
        has_token: 'fetch_addresses_action',
        default: 'collect_pickup', // No token, skip address fetch
      },
    },

    fetch_addresses_action: {
      type: 'action',
      description: 'Fetch user saved addresses',
      actions: [
        {
          id: 'fetch_addresses',
          executor: 'php_api',
          config: {
            action: 'get_saved_addresses',
            token: '{{auth_token}}',
          },
          output: 'saved_addresses',
          onError: 'continue', // Don't fail if addresses can't be fetched
        },
      ],
      transitions: {
        default: 'collect_pickup', // Always proceed to collect pickup
      },
    },

    // 🔧 NEW: Collect phone number for Google OAuth users
    collect_phone_for_oauth: {
      type: 'action',
      description: 'Ask Google OAuth user for phone number to create PHP account',
      actions: [
        {
          id: 'phone_prompt',
          executor: 'response',
          config: {
            message: '📱 **One more step!**\n\nTo use saved addresses and track your orders, please provide your phone number:\n\n_This links your Google account to our delivery system_',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_phone_oauth',
      },
    },

    // Wait for phone input
    wait_for_phone_oauth: {
      type: 'wait',
      description: 'Wait for phone number from Google OAuth user',
      actions: [],
      transitions: {
        user_message: 'extract_phone_oauth',
        default: 'extract_phone_oauth',
      },
    },

    // Extract and validate phone number
    extract_phone_oauth: {
      type: 'action',
      description: 'Extract phone number from user message',
      actions: [
        {
          id: 'extract_phone',
          executor: 'auth',
          config: {
            action: 'extract_phone',
            field: 'oauth_phone',
            prompt_on_invalid: 'Please enter a valid 10-digit phone number (e.g., 9876543210):',
          },
          output: '_phone_result',
        },
      ],
      transitions: {
        phone_extracted: 'link_phone_to_php',
        invalid_phone: 'collect_phone_for_oauth',
        waiting_for_input: 'wait_for_phone_oauth',
        default: 'collect_phone_for_oauth',
      },
    },

    // Link phone to PHP account
    link_phone_to_php: {
      type: 'action',
      description: 'Create/link PHP account with phone number',
      actions: [
        {
          id: 'create_php_account',
          executor: 'auth',
          config: {
            action: 'link_google_oauth',
          },
          output: '_php_link_result',
        },
      ],
      transitions: {
        account_linked: 'collect_pickup',
        link_failed: 'collect_pickup', // Continue anyway, just won't have saved addresses
        default: 'collect_pickup',
      },
    },

    // Prompt login before proceeding
    require_login_first: {
      type: 'action',
      description: 'Ask user to login before parcel booking',
      actions: [
        {
          id: 'login_prompt',
          executor: 'response',
          config: {
            message: '🔐 **Login Required**\n\nTo book a parcel delivery, please log in first. This lets us:\n\n• Use your saved addresses 📍\n• Track your orders 📋\n• Contact you for updates 📱\n\nTap **Login** to continue:',
            buttons: [
              { label: '🔐 Login', value: 'login', action: 'login' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_login',
      },
    },

    // Wait for login action
    wait_for_login: {
      type: 'wait',
      description: 'Wait for user to login',
      actions: [],
      transitions: {
        login: 'check_platform_for_auth',
        user_cancelled: 'cancelled',
        user_message: 'recheck_auth_after_message',
        // 🔧 FIX: Handle any unrecognized event (like 'parcel' button click after auth)
        // This ensures users who auth via modal and then click parcel are handled
        default: 'recheck_auth_after_message',
      },
    },

    // Re-check auth when user sends any message while waiting for login
    // This handles the case where user logged in via modal and now sends another message
    recheck_auth_after_message: {
      type: 'action',
      description: 'Re-check if user authenticated while we were waiting',
      actions: [
        {
          id: 'recheck_auth',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_recheck_auth_result',
        },
      ],
      transitions: {
        authenticated: 'check_php_account', // User is now logged in, check PHP account status
        not_authenticated: 'check_login_or_cancel', // Still not logged in, check what they said
        default: 'check_login_or_cancel',
      },
    },

    // Check if user typed login or wants to cancel
    check_login_or_cancel: {
      type: 'decision',
      description: 'Check user response during login wait',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(login|log in|sign in|signin)$/)',
          event: 'login',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|no|nahi|stop)$/)',
          event: 'cancelled',
        },
      ],
      transitions: {
        login: 'check_platform_for_auth',
        cancelled: 'cancelled',
        default: 'require_login_first', // Re-prompt
      },
    },



    // QUESTION 1: Get pickup address
    collect_pickup: {
      type: 'action',
      description: 'Collect pickup address',
      actions: [
        {
          id: 'pickup_prompt',
          executor: 'response',
          config: {
            channelResponses: {
              whatsapp: {
                message: '📍 Select pickup address',
                flow: {
                  flowId: '{{env.WA_FLOW_ADDRESS_ID}}',
                  flowType: 'address_selection',
                  ctaText: 'Select Pickup',
                  body: '📍 **Question 1/5:** Tap below to select your pickup address',
                  initialData: {
                    addressPurpose: 'pickup',
                  },
                },
              },
              default: {
                message: '📍 **Question 1/5:** Where should we pick up?\n\n• Share your live location 📍\n• Type an address\n• Or select a saved address (if logged in)',
              },
            },
          },
          output: '_pickup_prompt_result',
        },
        {
          id: 'get_pickup_address',
          executor: 'address',
          config: {
            field: 'pickup_address',
            prompt: '📍 **Question 1/5:** Where should we pick up?\n\n• Share your live location 📍\n• Type an address\n• Or select a saved address (if logged in)',
            offerSaved: true,
            requireAuth: false,
            skipIf: '{{_pickup_prompt_result.event === "flow_sent"}}',
          },
          output: 'pickup_address',
          retryOnError: true,
          maxRetries: 3,
        },
      ],
      transitions: {
        flow_sent: 'await_flow_pickup',
        address_valid: 'validate_pickup_zone',
        waiting_for_input: 'wait_for_pickup',
        user_cancelled: 'cancelled',
        error: 'pickup_error',
      },
    },

    // Wait for WhatsApp Flow pickup address response
    await_flow_pickup: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow pickup address selection',
      actions: [],
      transitions: {
        flow_response: 'process_flow_pickup',
        user_message: 'process_flow_pickup',
        default: 'process_flow_pickup',
      },
    },

    // Read pickup address from session and save to context
    process_flow_pickup: {
      type: 'action',
      description: 'Process WhatsApp Flow pickup address result',
      actions: [
        {
          id: 'read_flow_pickup',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_address_result',
          },
          output: '_flow_pickup',
        },
        {
          id: 'save_pickup_to_context',
          executor: 'response',
          config: {
            saveToContext: {
              pickup_address: '{{_flow_pickup.flow_address_result}}',
            },
          },
        },
      ],
      transitions: {
        default: 'check_flow_pickup',
      },
    },

    // Validate that we got a valid pickup address from the flow
    check_flow_pickup: {
      type: 'decision',
      description: 'Check if Flow returned a valid pickup address',
      conditions: [
        {
          expression: 'context.pickup_address && (context.pickup_address.lat || context.pickup_address.latitude || context.pickup_address.address)',
          event: 'valid',
        },
      ],
      transitions: {
        valid: 'validate_pickup_zone',
        default: 'collect_pickup', // Fallback to normal address collection
      },
    },

    wait_for_pickup: {
      type: 'wait',
      description: 'Wait for pickup address input',
      actions: [],
      transitions: {
        login: 'check_platform_for_auth',
        user_message: 'process_pickup_input',
        default: 'process_pickup_input', // Handle button clicks (address selection)
      },
    },

    process_pickup_input: {
      type: 'decision',
      description: 'Check if login requested before processing pickup',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(login|log in|sign in|signin|authenticate)$/)',
          event: 'login_requested',
        },
      ],
      transitions: {
        login_requested: 'check_platform_for_auth',
        default: 'extract_pickup_address',
      },
    },

    extract_pickup_address: {
      type: 'action',
      description: 'Process pickup address from user input',
      actions: [
        {
          id: 'extract_pickup',
          executor: 'address',
          config: {
            field: 'pickup_address',
            input: '{{_user_message}}',
          },
          output: 'pickup_address',
        },
      ],
      transitions: {
        address_valid: 'validate_pickup_zone',
        waiting_for_input: 'collect_pickup',
        error: 'pickup_error',
      },
    },

    // Validate pickup is in Nashik
    validate_pickup_zone: {
      type: 'action',
      description: 'Verify pickup is in Nashik service area',
      actions: [
        {
          id: 'check_pickup_zone',
          executor: 'zone',
          config: {
            latPath: 'pickup_address.latitude',
            lngPath: 'pickup_address.longitude',
          },
          output: 'pickup_zone',
        },
      ],
      transitions: {
        zone_valid: 'prepare_delivery',
        zone_invalid: 'pickup_out_of_zone',
        error: 'prepare_delivery', // If zone check fails, assume valid and proceed
        default: 'prepare_delivery',
      },
    },

    // Clear stale _user_message before collecting delivery
    // Without this, "yes" from pickup confirmation leaks into delivery collection
    // and causes the address executor to re-show all addresses
    prepare_delivery: {
      type: 'action',
      description: 'Clear stale user message before delivery collection',
      actions: [
        {
          id: 'clear_stale_message',
          executor: 'response',
          config: {
            saveToContext: {
              _user_message: '',
            },
          },
        },
      ],
      transitions: {
        default: 'collect_delivery',
      },
    },

    // QUESTION 2: Get delivery address
    collect_delivery: {
      type: 'action',
      description: 'Collect delivery address',
      actions: [
        {
          id: 'delivery_prompt',
          executor: 'response',
          config: {
            channelResponses: {
              whatsapp: {
                message: '📍 Select delivery address',
                flow: {
                  flowId: '{{env.WA_FLOW_ADDRESS_ID}}',
                  flowType: 'address_selection',
                  ctaText: 'Select Drop-off',
                  body: '✅ Pickup: {{pickup_address.address}}\n\n📍 **Question 2/5:** Tap below to select the drop-off address',
                  initialData: {
                    addressPurpose: 'dropoff',
                  },
                },
              },
              default: {
                message: '✅ **Pickup:** {{pickup_address.address}}\n\n📍 **Question 2/5:** Where to deliver?\n\n• Share location 📍\n• Type address\n• Or select saved address (if logged in)',
              },
            },
          },
          output: '_delivery_prompt_result',
        },
        {
          id: 'get_delivery_address',
          executor: 'address',
          config: {
            field: 'delivery_address',
            prompt: '✅ **Pickup:** {{pickup_address.address}}\n\n📍 **Question 2/5:** Where to deliver?\n\n• Share location 📍\n• Type address\n• Or select saved address (if logged in)',
            offerSaved: true,
            requireAuth: false,
            skipIf: '{{_delivery_prompt_result.event === "flow_sent"}}',
          },
          output: 'delivery_address',
          retryOnError: true,
          maxRetries: 3,
        },
      ],
      transitions: {
        flow_sent: 'await_flow_delivery',
        address_valid: 'validate_delivery_zone',
        waiting_for_input: 'wait_for_delivery',
        user_cancelled: 'cancelled',
        error: 'delivery_error',
      },
    },

    // Wait for WhatsApp Flow delivery address response
    await_flow_delivery: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow delivery address selection',
      actions: [],
      transitions: {
        flow_response: 'process_flow_delivery',
        user_message: 'process_flow_delivery',
        default: 'process_flow_delivery',
      },
    },

    // Read delivery address from session and save to context
    process_flow_delivery: {
      type: 'action',
      description: 'Process WhatsApp Flow delivery address result',
      actions: [
        {
          id: 'read_flow_delivery',
          executor: 'session',
          config: {
            action: 'get',
            key: 'flow_address_result',
          },
          output: '_flow_delivery',
        },
        {
          id: 'save_delivery_to_context',
          executor: 'response',
          config: {
            saveToContext: {
              delivery_address: '{{_flow_delivery.flow_address_result}}',
            },
          },
        },
      ],
      transitions: {
        default: 'check_flow_delivery',
      },
    },

    // Validate that we got a valid delivery address from the flow
    check_flow_delivery: {
      type: 'decision',
      description: 'Check if Flow returned a valid delivery address',
      conditions: [
        {
          expression: 'context.delivery_address && (context.delivery_address.lat || context.delivery_address.latitude || context.delivery_address.address)',
          event: 'valid',
        },
      ],
      transitions: {
        valid: 'validate_delivery_zone',
        default: 'collect_delivery', // Fallback to normal address collection
      },
    },

    wait_for_delivery: {
      type: 'wait',
      description: 'Wait for delivery address input',
      actions: [],
      transitions: {
        login: 'check_platform_for_auth',
        user_message: 'process_delivery_input',
        default: 'process_delivery_input', // Handle button clicks (address selection)
      },
    },

    process_delivery_input: {
      type: 'decision',
      description: 'Check if login requested before processing delivery',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(login|log in|sign in|signin|authenticate)$/)',
          event: 'login_requested',
        },
      ],
      transitions: {
        login_requested: 'check_platform_for_auth',
        default: 'extract_delivery_address',
      },
    },

    extract_delivery_address: {
      type: 'action',
      description: 'Process delivery address from user input',
      actions: [
        {
          id: 'extract_delivery',
          executor: 'address',
          config: {
            field: 'delivery_address',
            input: '{{_user_message}}',
          },
          output: 'delivery_address',
        },
      ],
      transitions: {
        address_valid: 'validate_delivery_zone',
        waiting_for_input: 'collect_delivery',
        error: 'delivery_error',
      },
    },

    // Validate delivery is in Nashik
    validate_delivery_zone: {
      type: 'action',
      description: 'Verify delivery is in Nashik service area',
      actions: [
        {
          id: 'check_delivery_zone',
          executor: 'zone',
          config: {
            latPath: 'delivery_address.latitude',
            lngPath: 'delivery_address.longitude',
          },
          output: 'delivery_zone',
        },
      ],
      transitions: {
        zone_valid: 'check_auth_for_recipient',
        zone_invalid: 'delivery_out_of_zone',
        error: 'check_auth_for_recipient', // If zone check fails, assume valid and proceed
        default: 'check_auth_for_recipient',
      },
    },

    // Check if user is authenticated - refresh from session first
    check_auth_for_recipient: {
      type: 'action',
      description: 'Refresh auth and check if user is logged in for recipient step',
      actions: [
        {
          id: 'refresh_auth_for_recipient',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_auth_status',
        },
      ],
      transitions: {
        authenticated: 'collect_recipient_auth',
        not_authenticated: 'collect_recipient_guest',
        default: 'collect_recipient_guest',
      },
    },

    // QUESTION 3A: Recipient (authenticated users can use "Same as Sender")
    collect_recipient_auth: {
      type: 'wait',
      description: 'Collect recipient details - authenticated user',
      onEntry: [
        {
          id: 'ask_recipient_auth',
          executor: 'response',
          config: {
            message: '✅ **Delivery:** {{delivery_address.address}}\n\n👤 **Question 3/5:** Who is the recipient?\n\nProvide name and phone:\nExample: "Rahul Kumar 9876543210"\n\nOr tap "Use my details" to deliver to yourself:',
            buttons: [
              { label: '👤 Use my details', value: 'use_my_details', action: 'use_my_details' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'check_recipient_input',
        use_my_details: 'check_recipient_input',  // Button click transition
        cancel: 'cancelled',
        user_cancelled: 'cancelled',
        default: 'check_recipient_input', // Handle any other button event
      },
    },

    // QUESTION 3B: Recipient (guest users must provide details)
    collect_recipient_guest: {
      type: 'wait',
      description: 'Collect recipient details - guest user',
      onEntry: [
        {
          id: 'ask_recipient_guest',
          executor: 'response',
          config: {
            message: '✅ **Delivery:** {{delivery_address.address}}\n\n👤 **Question 3/5:** Who is the recipient?\n\nProvide name and phone number:\nExample: "Rahul Kumar 9876543210"',
            buttons: [
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'check_recipient_input',  // Changed: Go through check first
        cancel: 'cancelled',
        user_cancelled: 'cancelled',
        default: 'check_recipient_input', // Handle any other button event
      },
    },

    // Check if user wants to use their own details
    check_recipient_input: {
      type: 'decision',
      description: 'Check if user selected "Use my details" or wants to provide recipient details',
      conditions: [
        {
          // ONLY allow "use self" if user is authenticated
          // Match: "use_my_details", "use my details", "use mine", "my details", "same as me", "myself", etc.
          expression: '(context.user_id || context.authenticated) && context._user_message?.toLowerCase().match(/(use_my_details|same_as_sender|same as me|use my|use mine|my details|my info|myself|mera|khud|mujhe|apna|apne details|mere details|mera number|my number|self|^same$|^me$|^mine$)/)',
          event: 'use_self',
        },
        {
          // Guest trying to use their details - need to login first
          expression: '(!context.user_id && !context.authenticated) && context._user_message?.toLowerCase().match(/(use_my_details|same_as_sender|same as me|use my|use mine|my details|my info|myself|mera|khud|mujhe|apna|apne details|mere details|mera number|my number|self|^same$|^me$|^mine$)/)',
          event: 'need_login',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no|stop)$/)',
          event: 'cancelled',
        },
      ],
      transitions: {
        use_self: 'copy_sender_to_recipient',
        need_login: 'prompt_login_for_recipient',
        cancelled: 'cancelled',
        default: 'extract_recipient_details',
      },
    },

    // Prompt guest to login when they try to use "same as me"
    prompt_login_for_recipient: {
      type: 'action',
      description: 'Guest tried to use their details - need login',
      actions: [
        {
          id: 'login_prompt',
          executor: 'response',
          config: {
            message: '🔐 To use your saved details as recipient, please **log in** first.\n\nOr provide recipient name and phone:\nExample: "Rahul Kumar 9876543210"',
            buttons: [
              { label: '🔐 Log In', value: 'login', action: 'login' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_recipient_or_login',
      },
    },

    // Wait for guest to either login or provide recipient details
    wait_for_recipient_or_login: {
      type: 'wait',
      description: 'Wait for recipient details or login',
      actions: [],
      transitions: {
        login: 'check_platform_for_auth',
        user_message: 'check_recipient_input',
        user_cancelled: 'cancelled',
        default: 'check_recipient_input', // Handle any other button event
      },
    },

    // Copy sender details to recipient
    copy_sender_to_recipient: {
      type: 'action',
      description: 'Use sender as recipient',
      actions: [
        {
          id: 'copy_sender',
          executor: 'profile',
          config: {
            action: 'copy_to_recipient',
          },
          output: 'recipient_copy_result',
        },
      ],
      transitions: {
        copied: 'confirm_recipient_copy',
        profile_incomplete: 'check_auth_for_recipient', // Sender profile incomplete — collect manually
        error: 'check_auth_for_recipient',
        default: 'confirm_recipient_copy',
      },
    },

    // Confirm recipient was copied
    confirm_recipient_copy: {
      type: 'action',
      description: 'Confirm recipient details copied from profile',
      actions: [
        {
          id: 'confirm_copy',
          executor: 'response',
          config: {
            message: '✅ Recipient set: **{{recipient_details.name}}** ({{recipient_details.phone}})',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'fetch_categories',
      },
    },

    // Extract recipient name and phone
    extract_recipient_details: {
      type: 'action',
      description: 'Extract name and phone from user message',
      actions: [
        {
          id: 'extract_recipient',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract recipient name and phone. Return JSON: {"name": "string", "phone": "string"}. If only one provided, set the other to null.',
            prompt: 'User message: "{{_user_message}}"\n\nExtract name and phone as JSON.',
            temperature: 0.1,
            maxTokens: 50,
            parseJson: true,
            skipHistory: true,
          },
          output: 'recipient_details',
        },
      ],
      transitions: {
        success: 'validate_recipient',
        error: 'collect_recipient_guest',
      },
    },

    // Validate recipient details
    validate_recipient: {
      type: 'decision',
      description: 'Check if both name and phone are present',
      conditions: [
        {
          expression: 'context.recipient_details?.name && context.recipient_details?.phone && context.recipient_details.phone.match(/^[0-9]{10,12}$/)',
          event: 'valid',
        },
      ],
      transitions: {
        valid: 'fetch_categories',
        default: 'ask_recipient_retry',
      },
    },

    // Ask for missing details
    ask_recipient_retry: {
      type: 'wait',
      description: 'Ask again for complete details',
      onEntry: [
        {
          id: 'ask_complete_details',
          executor: 'response',
          config: {
            message: '❓ I need both **name** and **phone number** (10 digits).\n\nExample: "Rahul Kumar 9876543210"',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'extract_recipient_details',
        default: 'extract_recipient_details', // Handle any other event
      },
    },

    // QUESTION 4: Fetch and show vehicle categories
    fetch_categories: {
      type: 'action',
      description: 'Get available vehicles',
      actions: [
        {
          id: 'get_categories',
          executor: 'parcel',
          config: {
            action: 'get_categories',
            pickupAddressPath: 'pickup_address',
          },
          output: 'vehicle_categories',
        },
      ],
      transitions: {
        categories_fetched: 'check_single_category',
        error: 'category_error',
      },
    },

    // Auto-select if only 1 category available
    check_single_category: {
      type: 'decision',
      description: 'Auto-select if only one vehicle category',
      conditions: [
        {
          expression: 'context.vehicle_categories?.length === 1',
          event: 'single_category',
        },
      ],
      transitions: {
        single_category: 'auto_select_category',
        default: 'show_categories',
      },
    },

    auto_select_category: {
      type: 'action',
      description: 'Auto-select the only available category',
      actions: [
        {
          id: 'auto_select',
          executor: 'response',
          config: {
            message: '✅ Recipient confirmed!\n\n🚗 **Question 4/5:** Vehicle selected automatically:\n\n**{{vehicle_categories.0.name}}** - {{vehicle_categories.0.price}}',
            saveToContext: {
              'parcel_category_id': '{{vehicle_categories.0.id}}',
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'calculate_distance',
      },
    },

    show_categories: {
      type: 'wait',
      description: 'Show vehicle options',
      onEntry: [
        {
          id: 'show_vehicles',
          executor: 'response',
          config: {
            message: '✅ Recipient confirmed!\n\n🚗 **Question 4/5:** Select vehicle type:',
            cardsPath: 'vehicle_categories',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_vehicle_selection',
        default: 'handle_vehicle_selection', // Handle button/card clicks
      },
    },

    // Handle vehicle selection
    handle_vehicle_selection: {
      type: 'action',
      description: 'Process vehicle selection - handles button clicks, numbers, and names',
      actions: [
        {
          id: 'interpret_vehicle',
          executor: 'llm',
          config: {
            systemPrompt: `You are extracting a category ID from user input. The user has been shown vehicle categories.

IMPORTANT RULES (in priority order):
1. If user clicked a button (message like "3" or action value), return that exact number
2. If user said "add", "select", "+", or clicked ADD button - return the ID of the category shown
3. If user describes vehicle by name (e.g., "bike", "Bike Delivery", "auto"), find matching category and return its ID
4. If only ONE category exists in the list, return that category's ID
5. If user says "yes", "ok", "confirm" and only 1 category - return that category's ID
6. If truly unclear, return "null"

Return ONLY the numeric ID, nothing else.`,
            prompt: 'User said: "{{_user_message}}"\n\nAvailable categories:\n{{json vehicle_categories}}\n\nExtract category ID (number only):',
            temperature: 0.1,
            maxTokens: 10,
            skipHistory: true,
          },
          output: 'selected_category_id_raw',
        },
        {
          id: 'save_vehicle',
          executor: 'response',
          config: {
            saveToContext: {
              'parcel_category_id': '{{selected_category_id_raw}}',
            },
          },
        },
      ],
      transitions: {
        success: 'validate_vehicle',
      },
    },

    validate_vehicle: {
      type: 'decision',
      description: 'Check if valid vehicle selected and exists in available categories',
      conditions: [
        {
          // Check if parcel_category_id is set AND exists in vehicle_categories list
          expression: 'context.parcel_category_id && context.parcel_category_id !== "null" && context.vehicle_categories?.some(cat => cat.id == context.parcel_category_id)',
          event: 'valid',
        },
      ],
      transitions: {
        valid: 'calculate_distance',
        default: 'show_categories_retry',
      },
    },

    show_categories_retry: {
      type: 'wait',
      description: 'Ask again for vehicle selection',
      onEntry: [
        {
          id: 'retry_vehicles',
          executor: 'response',
          config: {
            message: '❓ I couldn\'t match that selection.\n\n🚗 **Question 4/5:** Please tap **"+ ADD"** on your preferred vehicle, or type the vehicle name (e.g., "Bike"):',
            cardsPath: 'vehicle_categories',
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_vehicle_selection',
        default: 'handle_vehicle_selection', // Handle button/card clicks
      },
    },

    // QUESTION 5: Calculate distance and show price
    calculate_distance: {
      type: 'action',
      description: 'Calculate delivery distance',
      actions: [
        {
          id: 'get_distance',
          executor: 'distance',
          config: {
            fromLatPath: 'pickup_address.latitude',
            fromLngPath: 'pickup_address.longitude',
            toLatPath: 'delivery_address.latitude',
            toLngPath: 'delivery_address.longitude',
          },
          output: 'distance',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        calculated: 'validate_distance',
        error: 'distance_error',
      },
    },

    validate_distance: {
      type: 'decision',
      description: 'Check if distance is valid (not 0)',
      conditions: [
        {
          expression: 'context.distance > 0.01',
          event: 'valid_distance',
        },
      ],
      transitions: {
        valid_distance: 'calculate_pricing',
        default: 'same_location_error',
      },
    },

    same_location_error: {
      type: 'end',
      description: 'Pickup and delivery are the same location',
      actions: [
        {
          id: 'same_location_message',
          executor: 'response',
          config: {
            message: '❌ **Pickup and delivery locations are the same!**\n\nPlease provide different locations for pickup and delivery.\n\nUse /start to begin again.',
          },
          output: '_last_response',
        },
      ],
      transitions: {},
    },

    calculate_pricing: {
      type: 'action',
      description: 'Calculate delivery charges',
      actions: [
        {
          id: 'get_pricing',
          executor: 'parcel',
          config: {
            action: 'calculate_shipping',
            distancePath: 'distance',
            categoryPath: 'parcel_category_id',
          },
          output: 'pricing',
        },
      ],
      transitions: {
        shipping_calculated: 'show_summary',
        error: 'pricing_error',
      },
    },

    // Show order summary and confirm
    show_summary: {
      type: 'wait',
      description: 'Display summary and confirm',
      onEntry: [
        {
          id: 'summary',
          executor: 'response',
          config: {
            message: '📦 **Order Summary**\n\n📍 Pickup: {{pickup_address.address}}\n📍 Delivery: {{delivery_address.address}}\n👤 Recipient: {{recipient_details.name}} ({{recipient_details.phone}})\n📏 Distance: {{distance}} km\n\n💰 **Total: ₹{{pricing.total_charge}}**\n(Delivery: ₹{{pricing.delivery_charge}} + Fee: ₹{{pricing.platform_fee}})\n\n**Question 5/5:** Confirm your order? (You\'ll select payment method next)',
            buttons: [
              { label: '✅ Confirm', value: 'yes', action: 'yes' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'check_confirmation',
        edit_parcel: 'show_categories', // "Edit Details" → go back to vehicle selection
        default: 'check_confirmation', // Handle confirm/cancel button clicks
      },
    },

    check_confirmation: {
      type: 'decision',
      description: 'Check user confirmation',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(yes|confirm|ok|haan|ha|proceed|book)/)',
          event: 'confirmed',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(no|cancel|nahi|stop|exit)/)',
          event: 'cancelled',
        },
      ],
      transitions: {
        confirmed: 'check_auth_before_order',
        cancelled: 'cancelled',
        default: 'show_summary',
      },
    },

    // Check authentication before placing order - use session executor for fresh data
    check_auth_before_order: {
      type: 'action',
      description: 'Verify user is logged in (REQUIRED for all orders on PHP)',
      actions: [
        {
          id: 'refresh_auth_for_order',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_auth_status',
        },
      ],
      transitions: {
        authenticated: 'select_payment_method',
        not_authenticated: 'check_platform_for_auth_order',
        default: 'check_platform_for_auth_order',
      },
    },

    // Platform-aware authentication routing
    check_platform_for_auth: {
      type: 'decision',
      description: 'Route to appropriate auth based on platform - web uses frontend OAuth, others use inline OTP',
      conditions: [
        {
          // Note: In expression context, 'context' = context.data, so use 'context.platform' or just 'platform'
          expression: 'platform === "web"',
          event: 'web_platform',
        },
      ],
      transitions: {
        web_platform: 'trigger_frontend_auth',
        default: 'trigger_auth',
      },
    },

    check_platform_for_auth_order: {
      type: 'decision',
      description: 'Route to auth for order placement - web uses frontend modal, others use inline OTP',
      conditions: [
        {
          expression: 'platform === "web"',
          event: 'web_platform',
        },
      ],
      transitions: {
        // Web users get frontend login modal (better UX, industry standard)
        web_platform: 'trigger_frontend_auth_order',
        // WhatsApp/Telegram/Voice use inline OTP (no frontend available)
        default: 'require_login',
      },
    },

    trigger_frontend_auth: {
      type: 'wait',
      description: 'Trigger frontend OAuth and wait for auth completion',
      onEntry: [
        {
          id: 'notify_frontend',
          executor: 'response',
          config: {
            message: '🔐 Please login to continue with your parcel booking.',
            metadata: {
              action: 'trigger_auth_modal',
              reason: 'saved_addresses_required',
            },
            buttons: [
              { label: '🔐 Login', value: 'login', action: 'trigger_auth_modal' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        // After frontend login completes and user sends next message, recheck auth
        user_message: 'recheck_auth_after_frontend_login',
        user_cancelled: 'cancelled',
        cancel: 'cancelled',
        default: 'recheck_auth_after_frontend_login',
      },
    },

    // Re-check auth after frontend login modal
    recheck_auth_after_frontend_login: {
      type: 'action',
      description: 'Re-check if user authenticated via frontend OAuth',
      actions: [
        {
          id: 'recheck_frontend_auth',
          executor: 'session',
          config: {
            action: 'refresh_auth',
          },
          output: '_recheck_frontend_auth',
        },
      ],
      transitions: {
        authenticated: 'check_php_account',
        not_authenticated: 'require_login_first', // Still not authenticated, show login again
        default: 'require_login_first',
      },
    },

    trigger_frontend_auth_order: {
      type: 'wait',
      description: 'Wait for frontend OAuth to complete for order placement',
      onEntry: [
        {
          id: 'notify_frontend_order',
          executor: 'response',
          config: {
            message: '🔐 Please login to place your order.',
            metadata: {
              action: 'trigger_auth_modal',
              reason: 'order_placement_required',
            },
            buttons: [
              { label: '🔐 Login', value: 'login', action: 'trigger_auth_modal' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        // After frontend login completes, auth:success will trigger this
        user_message: 'handle_frontend_auth_response',
        default: 'handle_frontend_auth_response', // Handle any auth event
      },
    },

    handle_frontend_auth_response: {
      type: 'decision',
      description: 'Handle response after frontend auth - check if user is now authenticated',
      conditions: [
        {
          // User clicked login button (will trigger frontend modal)
          expression: 'context._user_message?.toLowerCase() === "login"',
          event: 'waiting_for_auth',
        },
        {
          // Check if session is now authenticated (set by auth:login handler)
          expression: 'context.authenticated === true || context.data?.authenticated === true',
          event: 'auth_complete',
        },
        {
          // Internal auth complete signal sent after successful login
          expression: 'context._user_message === "__AUTH_COMPLETE__"',
          event: 'auth_complete',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no|stop|exit)$/)',
          event: 'cancelled',
        },
      ],
      transitions: {
        waiting_for_auth: 'trigger_frontend_auth_order',
        auth_complete: 'auth_success',
        cancelled: 'cancelled',
        default: 'check_if_authenticated_now',
      },
    },

    check_if_authenticated_now: {
      type: 'action',
      description: 'Refresh auth state from session and check again',
      actions: [
        {
          id: 'check_session_auth',
          executor: 'session',
          config: {
            action: 'read',
            key: 'authenticated',
          },
          output: '_session_auth',
        },
      ],
      transitions: {
        default: 'auth_check_result',
      },
    },

    auth_check_result: {
      type: 'decision',
      description: 'Check if auth was successful',
      conditions: [
        {
          expression: 'context._session_auth === true',
          event: 'authenticated',
        },
      ],
      transitions: {
        authenticated: 'auth_success',
        default: 'trigger_frontend_auth_order',
      },
    },

    require_login: {
      type: 'wait',
      description: 'Request user to login',
      onEntry: [
        {
          id: 'login_prompt',
          executor: 'response',
          config: {
            message: '🔐 **Login Required**\n\nPlease login to place your order.\n\nTap below or type your phone number:',
            buttons: [
              { label: '📱 Login', value: 'login', action: 'trigger_auth_flow' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_login_action',
        default: 'handle_login_action', // Handle button clicks
      },
    },

    handle_login_action: {
      type: 'decision',
      description: 'Handle login button click or phone input',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(login|log in|sign in|signin|authenticate)$/)',
          event: 'start_auth',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no|stop|exit)$/)',
          event: 'cancelled',
        },
        {
          expression: 'context._user_message?.match(/^[6-9]\\d{9}$/)',
          event: 'phone_provided',
        },
      ],
      transitions: {
        start_auth: 'trigger_auth',
        phone_provided: 'trigger_auth',
        cancelled: 'cancelled',
        default: 'require_login',
      },
    },

    trigger_auth: {
      type: 'action',
      description: 'Store phone for auth and end flow to trigger auth',
      actions: [
        {
          id: 'store_auth_redirect',
          executor: 'session',
          config: {
            action: 'save',
            key: '_pending_flow_switch',
            value: 'login',
          },
          output: '_flow_switch_set',
        },
      ],
      transitions: {
        session_updated: 'wait_for_phone',
        success: 'wait_for_phone',
        default: 'wait_for_phone',
      },
    },

    wait_for_phone: {
      type: 'wait',
      description: 'Wait for phone number',
      onEntry: [
        {
          id: 'ask_phone',
          executor: 'response',
          config: {
            message: '📱 Please enter your 10-digit phone number:\n\nExample: 9876543210',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'validate_phone_and_start_auth',
        default: 'validate_phone_and_start_auth', // Handle any input
      },
    },

    validate_phone_and_start_auth: {
      type: 'decision',
      description: 'Validate phone number before auth',
      conditions: [
        {
          expression: 'context._user_message?.match(/^[6-9]\\d{9}$/)',
          event: 'valid_phone',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no|stop)$/)',
          event: 'cancelled',
        },
      ],
      transitions: {
        valid_phone: 'end_with_phone',
        cancelled: 'cancelled',
        default: 'wait_for_phone',
      },
    },

    end_with_phone: {
      type: 'action',
      description: 'Store phone and trigger OTP sending',
      actions: [
        {
          id: 'save_phone_for_auth',
          executor: 'session',
          config: {
            action: 'save',
            key: 'pending_phone',
            valuePath: '_user_message',
          },
          output: '_phone_saved',
        },
      ],
      transitions: {
        session_updated: 'send_otp',
        success: 'send_otp',
        default: 'send_otp',
      },
    },

    send_otp: {
      type: 'action',
      description: 'Send OTP to phone number',
      actions: [
        {
          id: 'trigger_otp',
          executor: 'auth',
          config: {
            action: 'send_otp',
            phone: '{{pending_phone}}',
          },
          output: 'otp_result',
        },
      ],
      transitions: {
        otp_sent: 'wait_for_otp',
        success: 'wait_for_otp',
        error: 'otp_error',
        default: 'wait_for_otp',
      },
    },

    wait_for_otp: {
      type: 'wait',
      description: 'Wait for OTP input',
      onEntry: [
        {
          id: 'ask_otp',
          executor: 'response',
          config: {
            message: '📨 OTP sent! Please enter the 6-digit code:',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'verify_otp',
        default: 'verify_otp', // Handle any input as OTP attempt
      },
    },

    verify_otp: {
      type: 'action',
      description: 'Verify OTP and complete authentication',
      actions: [
        {
          id: 'check_otp',
          executor: 'auth',
          config: {
            action: 'verify_otp',
            otp: '{{_user_message}}',
            phone: '{{pending_phone}}',
          },
          output: 'auth_result',
        },
      ],
      transitions: {
        // AuthExecutor emits `valid` (or `needs_profile`) on successful verification.
        // Keep `authenticated/success` for compatibility with other auth implementations.
        valid: 'auth_success',
        needs_profile: 'auth_success',
        authenticated: 'auth_success',
        success: 'auth_success',
        invalid: 'invalid_otp',
        invalid_otp: 'invalid_otp',
        error: 'otp_error',
        default: 'invalid_otp',
      },
    },

    invalid_otp: {
      type: 'wait',
      description: 'Invalid OTP - ask again',
      onEntry: [
        {
          id: 'invalid_otp_msg',
          executor: 'response',
          config: {
            message: '❌ Invalid OTP. Please enter the correct 6-digit code:',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'verify_otp',
        default: 'verify_otp', // Handle any input as OTP attempt
      },
    },

    otp_error: {
      type: 'wait',
      description: 'OTP sending failed',
      onEntry: [
        {
          id: 'otp_error_msg',
          executor: 'response',
          config: {
            message: '❌ Failed to send OTP. Please try again or type your phone number:',
            buttons: [
              { label: '🔄 Retry', value: 'retry', action: 'retry' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_otp_retry',
        default: 'handle_otp_retry', // Handle button clicks
      },
    },

    handle_otp_retry: {
      type: 'decision',
      description: 'Handle retry or cancel',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().match(/^(retry|again|phir se)$/)',
          event: 'retry',
        },
        {
          expression: 'context._user_message?.toLowerCase().match(/^(cancel|nahi|no)$/)',
          event: 'cancelled',
        },
        {
          expression: 'context._user_message?.match(/^[6-9]\\d{9}$/)',
          event: 'phone_provided',
        },
      ],
      transitions: {
        retry: 'send_otp',
        phone_provided: 'end_with_phone',
        cancelled: 'cancelled',
        default: 'otp_error',
      },
    },

    auth_success: {
      type: 'action',
      description: 'Authentication successful - resume flow',
      actions: [
        {
          id: 'auth_success_msg',
          executor: 'response',
          config: {
            message: '✅ Login successful! Continuing with your order...',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'resume_after_auth',
      },
    },

    resume_after_auth: {
      type: 'decision',
      description: 'Resume parcel flow from the correct step after login',
      conditions: [
        {
          // If we already collected all order details, continue to order placement.
          expression: 'context.pickup_address && context.delivery_address && context.recipient_details && context.pricing',
          event: 'has_order_context',
        },
      ],
      transitions: {
        has_order_context: 'check_auth_before_order',
        default: 'collect_pickup',
      },
    },

    auth_redirect_end: {
      type: 'end',
      description: 'End flow to trigger auth',
      actions: [],
      transitions: {},
    },

    start_auth_flow: {
      type: 'end',
      description: 'Placeholder for flow transition',
      actions: [],
      transitions: {},
    },

    // Payment method selection - Fetch from PHP API
    select_payment_method: {
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
            channelResponses: {
              whatsapp: {
                message: '💳 Select payment method',
                flow: {
                  flowId: '{{env.WA_FLOW_PAYMENT_ID}}',
                  flowType: 'payment_selection',
                  ctaText: 'Select Payment',
                  body: '💳 Tap below to choose how you want to pay\n\nTotal: ₹{{pricing.total_charge}}',
                  initialData: {
                    orderTotal: '{{pricing.total_charge}}',
                  },
                },
              },
              default: {
                message: '💳 **Select Payment Method:**',
                buttonsPath: 'payment_methods_response.methods',
                buttonConfig: {
                  labelPath: 'name',
                  valuePath: 'id',
                },
              },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        flow_sent: 'await_flow_payment_parcel',
        success: 'wait_payment_selection',
        error: 'select_payment_method_fallback',
      },
    },

    // Wait for WhatsApp Flow payment response (parcel)
    await_flow_payment_parcel: {
      type: 'wait',
      description: 'Wait for WhatsApp Flow payment selection response',
      actions: [],
      transitions: {
        flow_response: 'process_flow_payment_parcel',
        user_message: 'process_flow_payment_parcel',
        default: 'process_flow_payment_parcel',
      },
    },

    // Read payment result from session and route accordingly
    process_flow_payment_parcel: {
      type: 'action',
      description: 'Process WhatsApp Flow payment result for parcel',
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
        default: 'route_flow_payment_parcel',
      },
    },

    // Route based on payment method from WhatsApp Flow
    route_flow_payment_parcel: {
      type: 'decision',
      description: 'Route based on WhatsApp Flow payment selection for parcel',
      conditions: [
        {
          expression: 'context._flow_payment_method && (context._flow_payment_method.includes("cod") || context._flow_payment_method.includes("cash"))',
          event: 'cod_selected',
        },
        {
          expression: 'context._flow_payment_method && (context._flow_payment_method.includes("digital") || context._flow_payment_method.includes("online") || context._flow_payment_method.includes("upi") || context._flow_payment_method.includes("wallet"))',
          event: 'digital_selected',
        },
      ],
      transitions: {
        cod_selected: 'place_order_cod',
        digital_selected: 'place_order_digital',
        default: 'select_payment_method', // Fallback if no valid method
      },
    },

    // Wait for user to select payment method
    wait_payment_selection: {
      type: 'wait',
      description: 'Wait for payment method selection',
      actions: [],
      transitions: {
        user_message: 'handle_payment_selection',
        default: 'handle_payment_selection', // Handle button clicks
      },
    },

    // Fallback if API fails — retry fetching payment methods once
    select_payment_method_fallback: {
      type: 'action',
      description: 'Retry fetching payment methods if first attempt failed',
      actions: [
        {
          id: 'retry_fetch_payment_methods',
          executor: 'php_api',
          config: {
            action: 'get_payment_methods',
          },
          output: 'payment_methods_response',
        },
        {
          id: 'show_payment_options_retry',
          executor: 'response',
          config: {
            message: '💳 **Select Payment Method:**',
            buttonsPath: 'payment_methods_response.methods',
            buttonConfig: {
              labelPath: 'name',
              valuePath: 'id',
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_payment_selection',
      },
    },

    // Handle payment selection
    // Handle payment selection - first try direct button match, then LLM extraction
    handle_payment_selection: {
      type: 'decision',
      description: 'Check if user clicked a payment button directly',
      conditions: [
        {
          // Direct match: button value contains cash/cod
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("cash") || context._user_message.toLowerCase().includes("cod") || context._user_message.toLowerCase() === "cash_on_delivery")',
          event: 'cod_selected',
        },
        {
          // Direct match: button value contains digital/online/razor/upi/pay
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("digital") || context._user_message.toLowerCase().includes("razor") || context._user_message.toLowerCase().includes("online") || context._user_message.toLowerCase().includes("upi") || context._user_message.toLowerCase() === "pay_online" || context._user_message.toLowerCase().includes("pay online"))',
          event: 'digital_selected',
        },
      ],
      transitions: {
        cod_selected: 'place_order_cod',
        digital_selected: 'place_order_digital',
        default: 'handle_payment_selection_llm', // Only use LLM for ambiguous input
      },
    },

    // Fallback: use LLM to extract payment method from ambiguous user input
    handle_payment_selection_llm: {
      type: 'action',
      description: 'Use LLM to extract payment method from ambiguous input',
      actions: [
        {
          id: 'extract_payment_method',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract the payment method ID from user input. Return ONLY one of these exact values: digital_payment OR cash_on_delivery. No quotes, no extra text.',
            prompt: 'User said: "{{_user_message}}"\nAvailable methods: {{json payment_methods_response.methods}}\n\nReturn ONLY the payment method ID. For online/razorpay/upi/card, return digital_payment. For cash/cod, return cash_on_delivery.',
            temperature: 0.1,
            maxTokens: 30,
            skipHistory: true,
          },
          output: 'selected_payment_id',
        },
      ],
      transitions: {
        success: 'validate_payment_selection',
        error: 'wait_payment_selection',
      },
    },

    // Validate the selected payment method (from LLM extraction)
    validate_payment_selection: {
      type: 'decision',
      description: 'Check if valid payment method selected by LLM',
      conditions: [
        {
          // COD: cash_on_delivery, cod, cash (strip quotes and whitespace from LLM output)
          expression: `context.selected_payment_id && (function(v){v=v.replace(/["'\\s]/g,"").toLowerCase();return v.includes("cash")||v.includes("cod")})(String(context.selected_payment_id))`,
          event: 'cod_selected',
        },
        {
          // Digital: digital_payment, razor_pay, razorpay, online, upi  
          expression: `context.selected_payment_id && (function(v){v=v.replace(/["'\\s]/g,"").toLowerCase();return v.includes("digital")||v.includes("razor")||v.includes("online")||v.includes("upi")})(String(context.selected_payment_id))`,
          event: 'digital_selected',
        },
      ],
      transitions: {
        cod_selected: 'place_order_cod',
        digital_selected: 'place_order_digital',
        default: 'wait_payment_selection',
      },
    },

    // Place order with COD
    place_order_cod: {
      type: 'action',
      description: 'Create order with Cash on Delivery',
      actions: [
        {
          id: 'create_cod_order',
          executor: 'order',
          config: {
            type: 'parcel',
            paymentMethod: 'cash_on_delivery',
            pickupAddressPath: 'pickup_address',
            deliveryAddressPath: 'delivery_address',
            recipientPath: 'recipient_details',
            distancePath: 'distance',
            pricingPath: 'pricing',
            categoryPath: 'parcel_category_id',
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

    // Place order with digital payment
    place_order_digital: {
      type: 'action',
      description: 'Initiate digital payment',
      actions: [
        {
          id: 'create_digital_order',
          executor: 'order',
          config: {
            type: 'parcel',
            paymentMethod: 'digital_payment',
            pickupAddressPath: 'pickup_address',
            deliveryAddressPath: 'delivery_address',
            recipientPath: 'recipient_details',
            distancePath: 'distance',
            pricingPath: 'pricing',
            categoryPath: 'parcel_category_id',
          },
          output: 'order_result',
          retryOnError: true,
          maxRetries: 2,
        },
      ],
      transitions: {
        success: 'show_payment_gateway',
        error: 'order_failed',
      },
    },

    // Show payment gateway - triggers frontend Razorpay SDK or sends payment link on WhatsApp
    show_payment_gateway: {
      type: 'action',
      description: 'Open payment gateway or send payment link',
      actions: [
        {
          id: 'payment_gateway',
          executor: 'response',
          config: {
            // Channel-aware payment: WhatsApp gets a payment link, Web gets SDK trigger
            channelResponses: {
              whatsapp: {
                message: '💳 *Complete Payment*\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{pricing.total_charge}}\n\n🔗 Pay securely here:\n{{order_result.paymentLink}}\n\n⏱️ Complete payment within 10 minutes.\nAfter payment, you\'ll receive order confirmation automatically.',
                metadata: {
                  action: 'payment_link_sent',
                  orderId: '{{order_result.orderId}}',
                },
              },
              telegram: {
                message: '💳 *Complete Payment*\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{pricing.total_charge}}\n\n🔗 Pay securely here:\n{{order_result.paymentLink}}\n\n⏱️ Complete payment within 10 minutes.',
                metadata: {
                  action: 'payment_link_sent',
                  orderId: '{{order_result.orderId}}',
                },
              },
              default: {
                message: '💳 **Complete Payment**\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{pricing.total_charge}}\n\n🔗 Click below to pay securely:',
                metadata: {
                  action: 'open_payment_gateway',
                  payment_data: {
                    orderId: '{{order_result.orderId}}',
                    razorpayOrderId: '{{order_result.razorpayOrderId}}',
                    amount: '{{pricing.total_charge}}',
                    paymentLink: '{{order_result.paymentLink}}',
                    currency: 'INR',
                    name: 'Mangwale',
                    description: 'Parcel Delivery',
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
        default: 'wait_payment_result',
      },
    },

    // Wait for payment result from frontend
    wait_payment_result: {
      type: 'wait',
      description: 'Wait for payment completion',
      timeout: 300000, // 5 minutes timeout for payment
      onEntry: [],
      transitions: {
        user_message: 'check_payment_result', // Route to decision state
        timeout: 'check_cod_after_timeout',
        default: 'check_payment_result', // Handle payment callback events
      },
    },

    // Check the payment result message
    check_payment_result: {
      type: 'decision',
      description: 'Check if payment succeeded or failed',
      conditions: [
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
        payment_success: 'completed',
        payment_failed: 'check_cod_after_failure',
        cancelled: 'order_cancelled',
        maybe_paid: 'verify_payment_via_api',
        default: 'payment_still_waiting',
      },
    },

    // Verify payment status from PHP API when user claims they paid
    verify_payment_via_api: {
      type: 'action',
      description: 'Check order payment status from PHP backend',
      actions: [
        {
          id: 'check_order_status',
          executor: 'php_api',
          config: {
            action: 'get_order_details',
            token: '{{auth_token}}',
            orderId: '{{order_result.orderId}}',
          },
          output: '_order_status_check',
        },
      ],
      transitions: {
        default: 'evaluate_payment_status',
      },
    },

    // Evaluate if payment was actually received
    evaluate_payment_status: {
      type: 'decision',
      description: 'Check if PHP confirms payment was received',
      conditions: [
        {
          expression: 'context._order_status_check?.paymentStatus === "paid" || context._order_status_check?.payment_status === "paid"',
          event: 'confirmed_paid',
        },
        {
          expression: 'context._order_status_check?.orderStatus === "confirmed" || context._order_status_check?.order_status === "confirmed"',
          event: 'confirmed_paid',
        },
      ],
      transitions: {
        confirmed_paid: 'completed',
        default: 'payment_not_confirmed_yet',
      },
    },

    // Payment not yet confirmed on backend
    payment_not_confirmed_yet: {
      type: 'action',
      description: 'Tell user payment is not yet confirmed',
      actions: [
        {
          id: 'not_confirmed_msg',
          executor: 'response',
          config: {
            message: '⏳ Payment not yet confirmed.\n\nIf you have already paid, please wait a moment — it may take up to 1-2 minutes to process.\n\nIf not, tap below to pay:\n🔗 {{order_result.paymentLink}}',
            buttons: [
              { label: '🔄 Check Again', value: 'payment is done' },
              { label: '❌ Cancel', value: 'cancel' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_payment_result',
      },
    },

    // User sent irrelevant message while waiting for payment
    payment_still_waiting: {
      type: 'action',
      description: 'Acknowledge message and keep waiting for payment',
      actions: [
        {
          id: 'still_waiting_msg',
          executor: 'response',
          config: {
            message: '⏳ Waiting for your payment...\n\nOrder ID: #{{order_result.orderId}}\nAmount: ₹{{pricing.total_charge}}\n\nClick the button below to pay, or reply "cancel" to cancel.',
            metadata: {
              action: 'open_payment_gateway',
              payment_data: {
                orderId: '{{order_result.orderId}}',
                amount: '{{pricing.total_charge}}',
                paymentLink: '{{order_result.paymentLink}}',
              },
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_payment_result',
      },
    },

    // Check if COD is available before showing payment failure options
    check_cod_after_failure: {
      type: 'decision',
      description: 'Check COD availability before showing payment retry options',
      conditions: [
        {
          expression: "context.payment_methods_response?.methods?.some(m => m.type === 'cash')",
          event: 'cod_available',
        },
      ],
      transitions: {
        cod_available: 'payment_failed_with_cod',
        default: 'payment_failed_no_cod',
      },
    },

    payment_failed_with_cod: {
      type: 'action',
      description: 'Handle payment failure — COD available for this zone',
      actions: [
        {
          id: 'payment_error',
          executor: 'response',
          config: {
            message: '❌ **Payment Failed**\n\nYour payment could not be completed. The order has been saved.\n\nYou can retry payment or choose Cash on Delivery:',
            buttons: [
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '💵 Cash on Delivery', value: 'cod', action: 'switch_to_cod' },
              { label: '❌ Cancel Order', value: 'cancel', action: 'cancel_order' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'await_payment_retry',
      },
    },

    payment_failed_no_cod: {
      type: 'action',
      description: 'Handle payment failure — COD not available for this zone',
      actions: [
        {
          id: 'payment_error_no_cod',
          executor: 'response',
          config: {
            message: '❌ **Payment Failed**\n\nYour payment could not be completed. The order has been saved.\n\nPlease retry the payment:',
            buttons: [
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '❌ Cancel Order', value: 'cancel', action: 'cancel_order' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'await_payment_retry',
      },
    },

    await_payment_retry: {
      type: 'wait',
      description: 'Wait for user decision on payment retry',
      onEntry: [],
      transitions: {
        retry_payment: 'show_payment_gateway',
        switch_to_cod: 'switch_to_cod_payment',
        cancel_order: 'order_cancelled',
        user_message: 'handle_payment_retry_input',
        default: 'handle_payment_retry_input', // Handle button clicks
      },
    },

    handle_payment_retry_input: {
      type: 'action',
      description: 'Handle text input for payment retry',
      actions: [
        {
          id: 'interpret_retry',
          executor: 'llm',
          config: {
            systemPrompt: 'User needs to decide: retry payment, switch to COD, or cancel. Return one of: retry_payment, switch_to_cod, cancel_order',
            prompt: 'User said: "{{_user_message}}". What do they want?',
            temperature: 0.1,
            maxTokens: 20,
          },
          output: '_retry_decision',
        },
      ],
      transitions: {
        default: 'route_retry_decision',
      },
    },

    // Route LLM output _retry_decision to correct state
    route_retry_decision: {
      type: 'decision',
      description: 'Route payment retry decision from LLM',
      conditions: [
        { expression: "context._retry_decision === 'retry_payment'", event: 'retry_payment' },
        {
          expression: "context._retry_decision === 'switch_to_cod' && context.payment_methods_response?.methods?.some(m => m.type === 'cash')",
          event: 'use_cod',
        },
        { expression: "context._retry_decision === 'cancel_order'", event: 'cancel_payment' },
      ],
      transitions: {
        retry_payment: 'show_payment_gateway',
        use_cod: 'switch_to_cod_payment',
        cancel_payment: 'order_cancelled',
        default: 'await_payment_retry', // Unknown response — go back to retry prompt
      },
    },

    switch_to_cod_payment: {
      type: 'action',
      description: 'Switch order to Cash on Delivery',
      actions: [
        {
          id: 'cod_confirm',
          executor: 'response',
          config: {
            message: '✅ Payment method switched to **Cash on Delivery**.\n\nPay ₹{{pricing.total_charge}} when your parcel is delivered.',
            saveToContext: {
              payment_method: 'cod',
            },
          },
        },
      ],
      transitions: {
        default: 'completed',
      },
    },

    order_cancelled: {
      type: 'action',
      description: 'Cancel the order via PHP API and notify user',
      actions: [
        {
          id: 'cancel_php_order',
          executor: 'php_api',
          config: {
            action: 'cancel_order',
            token: '{{auth_token}}',
            orderId: '{{order_result.orderId}}',
            reason: 'Cancelled by customer via chat',
          },
          output: '_cancel_result',
        },
        {
          id: 'cancel',
          executor: 'response',
          config: {
            message: '❌ Order cancelled.\n\nWould you like to place a new order?',
            buttons: [
              { label: '📦 New Parcel', value: 'new_parcel', action: 'new_order' },
              { label: '🏠 Home', value: 'home', action: 'home' },
            ],
          },
        },
      ],
      transitions: {
        default: 'finish',
      },
    },

    // Check if COD is available after payment timeout
    check_cod_after_timeout: {
      type: 'decision',
      description: 'Check COD availability after payment timeout',
      conditions: [
        {
          expression: "context.payment_methods_response?.methods?.some(m => m.type === 'cash')",
          event: 'cod_available',
        },
      ],
      transitions: {
        cod_available: 'payment_timeout_with_cod',
        default: 'payment_timeout_no_cod',
      },
    },

    payment_timeout_with_cod: {
      type: 'action',
      description: 'Payment timed out — COD available for this zone',
      actions: [
        {
          id: 'timeout_msg',
          executor: 'response',
          config: {
            message: '⏰ **Payment Timeout**\n\nPayment session expired. Your order has been saved.\n\nWhat would you like to do?',
            buttons: [
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '💵 Cash on Delivery', value: 'cod', action: 'switch_to_cod' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel_order' },
            ],
          },
        },
      ],
      transitions: {
        default: 'await_payment_retry',
      },
    },

    payment_timeout_no_cod: {
      type: 'action',
      description: 'Payment timed out — COD not available for this zone',
      actions: [
        {
          id: 'timeout_msg_no_cod',
          executor: 'response',
          config: {
            message: '⏰ **Payment Timeout**\n\nPayment session expired. Your order has been saved.\n\nWould you like to retry the payment?',
            buttons: [
              { label: '🔄 Retry Payment', value: 'retry_payment', action: 'retry_payment' },
              { label: '❌ Cancel', value: 'cancel', action: 'cancel_order' },
            ],
          },
        },
      ],
      transitions: {
        default: 'await_payment_retry',
      },
    },

    // Success!
    completed: {
      type: 'action',
      description: 'Order placed successfully',
      actions: [
        {
          id: 'success',
          executor: 'response',
          config: {
            message: '🎉 **Order Confirmed!**\n\n📦 Order ID: #{{order_result.orderId}}\n📍 From: {{pickup_address.address}}\n📍 To: {{delivery_address.address}}\n👤 Recipient: {{recipient_details.name}}\n💰 Total: ₹{{pricing.total_charge}}\n⏱️ ETA: 30-45 minutes\n\n📍 Track your order:\n{{order_result.trackingUrl}}\n\nYou\'ll receive WhatsApp updates on each step!',
            buttons: [
              { label: '📍 Track Order', value: 'track', action: 'track_order' },
              { label: '🏠 Home', value: 'home', action: 'home' },
            ],
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'check_profile_question',
      },
    },

    // Progressive profile: Ask one quick question after successful order
    // NOTE: Uses 'post_parcel_order' context to avoid food-related questions
    check_profile_question: {
      type: 'action',
      description: 'Check if we should ask a profile question',
      actions: [
        {
          id: 'check_profile',
          executor: 'profile',
          config: {
            action: 'ask_question',
            context: 'post_parcel_order',
          },
          output: '_profile_question',
        },
      ],
      transitions: {
        question_asked: 'wait_profile_answer',
        skip: 'finish',
        default: 'finish',
      },
    },

    // Wait for profile answer (optional - user can skip)
    wait_profile_answer: {
      type: 'wait',
      description: 'Wait for profile answer',
      timeout: 30000, // 30 seconds, then skip
      onEntry: [],
      transitions: {
        default: 'save_profile_answer',
        timeout: 'finish', // Skip if user doesn't respond
      },
    },

    save_profile_answer: {
      type: 'action',
      description: 'Save profile answer',
      actions: [
        {
          id: 'save_answer',
          executor: 'profile',
          config: {
            action: 'save_answer',
          },
        },
        {
          id: 'thank_user',
          executor: 'response',
          config: {
            message: '✅ Thanks! That helps me give better recommendations.',
          },
        },
      ],
      transitions: {
        default: 'finish',
      },
    },

    finish: {
      type: 'end',
      description: 'Flow complete',
      actions: [],
      transitions: {},
    },

    // Error states — converted from terminal 'end' to recoverable 'action' states with retry buttons

    pickup_error: {
      type: 'action',
      description: 'Pickup address error — offer retry',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: '❌ Could not understand the pickup address.\n\n[BTN|🔄 Try Again|retry_pickup][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    delivery_error: {
      type: 'action',
      description: 'Delivery address error — offer retry',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: '❌ Could not understand the delivery address.\n\n[BTN|🔄 Try Again|retry_delivery][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    pickup_out_of_zone: {
      type: 'action',
      description: 'Pickup outside Nashik — offer different address',
      actions: [
        {
          id: 'zone_error',
          executor: 'response',
          config: {
            message: '❌ **Pickup location is outside Nashik.**\n\nWe currently deliver only within Nashik city.\n\n[BTN|📍 Try Different Address|retry_pickup][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    delivery_out_of_zone: {
      type: 'action',
      description: 'Delivery outside Nashik — offer different address',
      actions: [
        {
          id: 'zone_error',
          executor: 'response',
          config: {
            message: '❌ **Delivery location is outside Nashik.**\n\nWe currently deliver only within Nashik city.\n\n[BTN|📍 Try Different Address|retry_delivery][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    distance_error: {
      type: 'action',
      description: 'Distance calculation failed — offer restart',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: '❌ Could not calculate distance between the addresses.\n\n[BTN|🔄 Try Again|retry_from_start][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    category_error: {
      type: 'action',
      description: 'Failed to fetch vehicle categories — offer restart',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: '❌ Could not load available vehicles. Please try again.\n\n[BTN|🔄 Try Again|retry_from_start][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    pricing_error: {
      type: 'action',
      description: 'Pricing calculation failed — offer restart',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: '❌ Could not calculate the delivery price. Please try again.\n\n[BTN|🔄 Try Again|retry_from_start][BTN|❌ Cancel|cancel]',
          },
        },
      ],
      transitions: {
        default: 'parcel_error_recovery',
      },
    },

    // Shared recovery wait state for all parcel error states
    parcel_error_recovery: {
      type: 'wait',
      description: 'Wait for user retry or cancel after an error',
      actions: [],
      transitions: {
        retry_pickup: 'collect_pickup',
        retry_delivery: 'collect_delivery',
        retry_from_start: 'collect_pickup', // Restart from pickup for transient errors
        cancel: 'cancelled',
        default: 'cancelled',
      },
    },

    order_failed: {
      type: 'action',
      description: 'Order placement failed - offer retry or cancel',
      actions: [
        {
          id: 'error',
          executor: 'response',
          config: {
            message: "❌ I couldn't place your order. Please check your details and try again.",
            buttons: [
              { label: '🔄 Try Again', value: 'retry_order' },
              { label: '❌ Cancel', value: 'cancel' },
            ],
          },
        },
      ],
      transitions: {
        default: 'wait_order_retry',
      },
    },

    wait_order_retry: {
      type: 'wait',
      description: 'Wait for user to retry or cancel after order failure',
      actions: [],
      transitions: {
        retry_order: 'check_auth_before_order',
        cancel: 'cancelled',
        default: 'cancelled',
      },
    },

    cancelled: {
      type: 'end',
      description: 'User cancelled',
      actions: [
        {
          id: 'cancel',
          executor: 'response',
          config: {
            message: '❌ Order cancelled.\n\nHow else can I help you?',
            buttons: [
              { label: '📦 Send Parcel', value: 'parcel', action: 'send_parcel' },
              { label: '🍔 Order Food', value: 'food', action: 'order_food' },
              { label: '❓ Help', value: 'help', action: 'help' },
            ],
          },
        },
      ],
      transitions: {},
    },
  },

  initialState: 'check_trigger',
  finalStates: ['completed', 'cancelled'],
};
