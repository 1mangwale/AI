/**
 * Address Management Flow
 * 
 * Handles:
 * - Viewing saved addresses
 * - Adding new addresses with location
 * - Saving addresses with labels (home, office, other)
 * 
 * Triggers:
 * - "manage_address" intent from NLU
 * - User shares location with "save as home/office"
 */

import { FlowDefinition } from '../types/flow.types';
import { TIMEOUT, TOKEN } from '../../config/flow.constants';

export const addressManagementFlow: FlowDefinition = {
  id: 'address-management',
  name: 'Address Management',
  description: 'View, add, and manage saved addresses',
  version: '1.0.0',
  trigger: 'manage_address',
  module: 'general',
  enabled: true,
  initialState: 'check_auth',
  finalStates: ['completed'],

  states: {
    // State 1: Check if user is authenticated
    check_auth: {
      type: 'decision',
      description: 'Check if user is authenticated',
      conditions: [
        {
          expression: 'context.authenticated === true',
          event: 'authenticated',
        },
        {
          expression: 'true',
          event: 'not_authenticated',
        },
      ],
      transitions: {
        authenticated: 'check_intent',
        not_authenticated: 'login_required',
      },
    },

    // State 2: Require login
    login_required: {
      type: 'action',
      description: 'Ask user to login first',
      actions: [
        {
          id: 'login_message',
          executor: 'response',
          config: {
            message: '🔐 Please login first to manage your addresses.\n\n[BTN|🔑 Login|__LOGIN__]',
          },
          output: '_last_response',
        },
        {
          id: 'set_pending',
          executor: 'session',
          config: {
            action: 'save', // Fixed: was 'set', should be 'save'
            data: {
              pendingAction: 'manage_address',
            },
          },
        },
      ],
      transitions: {
        default: 'completed',
      },
    },

    // State 3: Check what user wants to do
    check_intent: {
      type: 'decision',
      description: 'Determine if user wants to save, view, or add address',
      conditions: [
        // User wants to save with type (home/office)
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("save") || context._user_message.toLowerCase().includes("add")) && (context._user_message.toLowerCase().includes("home") || context._user_message.toLowerCase().includes("office"))',
          event: 'save_with_type',
        },
        // User wants to view addresses
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("show") || context._user_message.toLowerCase().includes("view") || context._user_message.toLowerCase().includes("list") || context._user_message.toLowerCase().includes("my addresses"))',
          event: 'view_addresses',
        },
        {
          expression: 'true',
          event: 'show_menu',
        },
      ],
      transitions: {
        save_with_type: 'extract_location',
        view_addresses: 'fetch_addresses',
        show_menu: 'show_menu',
      },
    },

    // State 4: Show address management menu
    show_menu: {
      type: 'action',
      description: 'Show address management options',
      actions: [
        {
          id: 'menu_message',
          executor: 'response',
          config: {
            message: '📍 **Address Management**\n\nWhat would you like to do?\n\n[BTN|📋 View My Addresses|view]\n[BTN|➕ Add New Address|add]\n\nOr share a Google Maps link to save an address.',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_choice',
      },
    },

    // State 5: Wait for user choice
    wait_for_choice: {
      type: 'wait',
      description: 'Wait for user to make a choice',
      transitions: {
        user_message: 'handle_choice',
        timeout: 'completed',
      },
      timeout: TIMEOUT.ADDRESS,
    },

    // State 6: Handle user choice
    handle_choice: {
      type: 'decision',
      description: 'Route based on user choice',
      conditions: [
        {
          expression: 'context._user_message === "view" || context._user_message.toLowerCase().includes("view")',
          event: 'view',
        },
        {
          expression: 'context._user_message === "add" || context._user_message.toLowerCase().includes("add")',
          event: 'add',
        },
        {
          expression: 'context._user_message && (context._user_message.includes("maps.") || context._user_message.includes("goo.gl"))',
          event: 'has_location',
        },
        {
          expression: 'true',
          event: 'default',
        },
      ],
      transitions: {
        view: 'fetch_addresses',
        add: 'ask_for_location',
        has_location: 'extract_location',
        default: 'show_menu',
      },
    },

    // State 7: Fetch addresses from backend
    fetch_addresses: {
      type: 'action',
      description: 'Fetch user addresses from PHP backend',
      actions: [
        {
          id: 'get_addresses',
          executor: 'php_api',
          config: {
            action: 'get_saved_addresses',
            token: '{{auth_token}}',
          },
          output: 'saved_addresses',
        },
      ],
      transitions: {
        default: 'display_addresses',
      },
    },

    // State 8: Display addresses
    display_addresses: {
      type: 'action',
      description: 'Format and display addresses',
      actions: [
        {
          id: 'format_addresses',
          executor: 'llm',
          config: {
            systemPrompt: 'Format addresses nicely. Use emojis: 🏠 Home, 🏢 Office, 📍 Other. Numbered list. If empty array or null, say "No addresses saved yet."',
            prompt: 'Addresses: {{json saved_addresses}}',
            temperature: 0.3,
            maxTokens: 300,
          },
          output: 'formatted_addresses',
        },
        {
          id: 'show_addresses',
          executor: 'response',
          config: {
            message: '{{formatted_addresses}}\n\n[BTN|➕ Add New Address|add]\n[BTN|🏠 Done|done]',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_post_view',
      },
    },

    // State 9: Wait after viewing
    wait_for_post_view: {
      type: 'wait',
      description: 'Wait for user action after viewing addresses',
      transitions: {
        user_message: 'handle_post_view',
        timeout: 'completed',
      },
      timeout: TIMEOUT.ADDRESS,
    },

    // State 10: Handle post-view action
    handle_post_view: {
      type: 'decision',
      description: 'Handle user action after viewing',
      conditions: [
        {
          expression: 'context._user_message === "add" || context._user_message.toLowerCase().includes("add")',
          event: 'add',
        },
        {
          expression: 'true',
          event: 'done',
        },
      ],
      transitions: {
        add: 'ask_for_location',
        done: 'completed',
      },
    },

    // State 11: Ask for location
    ask_for_location: {
      type: 'action',
      description: 'Ask user to share location',
      actions: [
        {
          id: 'location_prompt',
          executor: 'response',
          config: {
            message: `📍 **Add New Address**\n\nPlease share your location:\n\n[BTN|📍 Share Location|${TOKEN.LOCATION}]\n\nOr paste a Google Maps link.`,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_location',
      },
    },

    // State 12: Wait for location
    wait_for_location: {
      type: 'wait',
      description: 'Wait for user to share location',
      transitions: {
        user_message: 'extract_location',
        timeout: 'completed',
      },
      timeout: TIMEOUT.ADDRESS,
    },

    // State 13: Extract location from input
    extract_location: {
      type: 'action',
      description: 'Extract location from user input',
      actions: [
        {
          id: 'extract_addr',
          executor: 'address',
          config: {
            field: 'new_address',
            require_coordinates: true,
          },
          output: 'extraction_result',
        },
      ],
      transitions: {
        address_valid: 'determine_address_type',
        waiting_for_input: 'wait_for_location',
        default: 'ask_for_location',
      },
    },

    // State 14: Determine address type
    determine_address_type: {
      type: 'decision',
      description: 'Check if user already specified address type',
      conditions: [
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("home")',
          event: 'type_home',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("office")',
          event: 'type_office',
        },
        {
          expression: 'true',
          event: 'ask_type',
        },
      ],
      transitions: {
        type_home: 'set_type_home',
        type_office: 'set_type_office',
        ask_type: 'ask_address_type',
      },
    },

    // State 15: Set type home
    set_type_home: {
      type: 'action',
      description: 'Set address type to home',
      actions: [
        {
          id: 'set_home',
          executor: 'session',
          config: {
            action: 'save', // Fixed: was 'set'
            data: {
              address_type: 'home',
            },
          },
        },
      ],
      transitions: {
        default: 'save_address',
      },
    },

    // State 16: Set type office
    set_type_office: {
      type: 'action',
      description: 'Set address type to office',
      actions: [
        {
          id: 'set_office',
          executor: 'session',
          config: {
            action: 'save', // Fixed: was 'set'
            data: {
              address_type: 'office',
            },
          },
        },
      ],
      transitions: {
        default: 'save_address',
      },
    },

    // State 17: Ask for address type
    ask_address_type: {
      type: 'action',
      description: 'Prompt user for address type',
      actions: [
        {
          id: 'type_prompt',
          executor: 'response',
          config: {
            message: '🏷️ **Label this address**\n\nWhat type of address is this?\n\n[BTN|🏠 Home|home]\n[BTN|🏢 Office|office]\n[BTN|📍 Other|other]',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_type',
      },
    },

    // State 18: Wait for type selection
    wait_for_type: {
      type: 'wait',
      description: 'Wait for user to select address type',
      transitions: {
        user_message: 'capture_type',
        timeout: 'completed',
      },
      timeout: TIMEOUT.SHORT_INPUT,
    },

    // State 19: Capture address type
    capture_type: {
      type: 'action',
      description: 'Save selected address type',
      actions: [
        {
          id: 'save_type',
          executor: 'session',
          config: {
            action: 'save', // Fixed: was 'set'
            data: {
              address_type: '{{_user_message}}',
            },
          },
        },
      ],
      transitions: {
        default: 'save_address',
      },
    },

    // State 20: Save address to PHP backend
    save_address: {
      type: 'action',
      description: 'Save address to user profile',
      actions: [
        {
          id: 'save_addr',
          executor: 'php_api',
          config: {
            action: 'add_address',
            params: {
              latitude: '{{new_address.latitude}}',
              longitude: '{{new_address.longitude}}',
              address: '{{new_address.address}}',
              address_type: '{{address_type}}',
            },
          },
          output: 'save_result',
        },
      ],
      transitions: {
        default: 'check_save_result',
      },
    },

    // State 21: Check save result
    check_save_result: {
      type: 'decision',
      description: 'Check if save was successful',
      conditions: [
        {
          expression: 'context.save_result && context.save_result.success',
          event: 'success',
        },
        {
          expression: 'true',
          event: 'error',
        },
      ],
      transitions: {
        success: 'show_success',
        error: 'show_error',
      },
    },

    // State 22: Show success
    show_success: {
      type: 'action',
      description: 'Confirm address saved',
      actions: [
        {
          id: 'success_message',
          executor: 'response',
          config: {
            message: '✅ **Address saved!**\n\n📍 {{new_address.address}}\n\nYou can use this address for future orders.\n\n[BTN|🍔 Order Food|order_food]\n[BTN|📦 Send Parcel|parcel_booking]',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'completed',
      },
    },

    // State 23: Show error
    show_error: {
      type: 'action',
      description: 'Show error message',
      actions: [
        {
          id: 'error_message',
          executor: 'response',
          config: {
            message: '❌ Sorry, I couldn\'t save the address. Please try again later.\n\n[BTN|🔄 Try Again|add]',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_retry',
      },
    },

    // State 24: Wait for retry
    wait_for_retry: {
      type: 'wait',
      description: 'Wait for user to retry',
      transitions: {
        user_message: 'handle_choice',
        timeout: 'completed',
      },
      timeout: TIMEOUT.SHORT_INPUT,
    },

    // Final state
    completed: {
      type: 'end',
      description: 'Flow completed',
      transitions: {},
    },
  },
};

export default addressManagementFlow;
