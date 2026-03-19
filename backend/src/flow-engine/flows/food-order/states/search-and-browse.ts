import { FlowState } from '../../../types/flow.types';
import { MODULE_ID, SEARCH, TOKEN } from '../../../../config/flow.constants';

/**
 * Food Order Flow — Search And Browse States
 * Auto-extracted from food-order.flow.ts
 */
export const searchAndBrowseStates: Record<string, FlowState> = {
    greet_user: {
      type: 'wait',
      description: 'Welcome user and ask what they want to order',
      onEntry: [
        {
          id: 'welcome_message',
          executor: 'response',
          config: {
            message: 'Hey {{user_name}}! 😋 What would you like to eat today?',
            quickReplies: [
              { label: '🍕 Pizza', value: 'pizza' },
              { label: '🍛 Biryani', value: 'biryani' },
              { label: '🥘 Thali', value: 'thali' },
              { label: '🍔 Burger', value: 'burger' },
            ],
          },
        },
      ],
      transitions: {
        browse_menu: 'check_show_collections',  // Direct route for browse_menu button click
        view_cart: 'show_current_cart',          // Direct route for view_cart button click
        checkout: 'check_auth_for_checkout',     // Direct route for checkout button click
        quick_order: 'check_quick_order_flow',   // Quick Order WhatsApp Flow
        user_message: 'understand_request',      // User typed something → NLU
        default: 'understand_request',           // Fallback for any other events
      },
    },

    understand_request: {
      type: 'action',
      description: 'Extract food intent and entities using NLU',
      actions: [
        {
          id: 'analyze_request',
          executor: 'nlu',
          config: {
            extractEntities: true,
          },
          output: 'food_nlu',
        },
        {
          // Map NLU entities to extracted_food format for downstream states
          id: 'map_nlu_to_extracted_food',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              extracted_food: {
                // Use NLU extracted entities
                items: '{{food_nlu.entities.food_reference || []}}',
                restaurant: '{{food_nlu.entities.store_reference || null}}',
                search_query: '{{#each food_nlu.entities.food_reference}}{{this}} {{/each}}',
                // 🥗 Auto-populate special_instructions from NER preference
                // e.g., "no tarri", "extra spicy", "no onions" → sent as restaurant note
                special_instructions: '{{food_nlu.entities.preference || null}}',
                // 🥗 Propagate food preference (veg/non-veg) from NLU to search
                preference: '{{food_nlu.entities.preference || _user_food_preference || null}}',
              },
              // 🥗 Also save preference at top level for SearchExecutor to read
              _user_food_preference: '{{food_nlu.entities.preference || _user_food_preference || null}}',
              // 🥗 Auto-set order_note from NER preference so it flows to PHP
              order_note: '{{food_nlu.entities.preference || null}}',
            },
          },
        },
      ],
      transitions: {
        // Always check if we have a search query first before searching
        quick_reorder: 'load_reorder_cart',            // 🔄 One-tap repeat last order
        success: 'check_search_query_exists',
        order_food: 'check_search_query_exists',
        search_product: 'check_search_query_exists',
        browse_menu: 'check_show_collections',        // 🔧 FIX: Browse menu → smart collections gate
        browse_category: 'check_show_collections',  // 🔧 FIX: Route through personalization gate (was show_categories)
        browse_stores: 'show_partner_stores',  // User wants to see other stores/restaurants
        ask_recommendation: 'show_recommendations',
        ask_famous: 'show_recommendations',
        ask_fastest_delivery: 'search_fastest_delivery',
        check_availability: 'show_open_now',
        add_to_cart: 'process_selection',           // 🔧 FIX: Handle add-to-cart intent directly
        view_cart: 'show_current_cart',              // 🔧 FIX: Handle view cart intent
        checkout: 'check_auth_for_checkout',         // 🔧 FIX: Handle checkout intent
        default: 'check_search_query_exists',
      },
    },

    load_reorder_cart: {
      type: 'action',
      description: 'Pre-populate cart from last order so user skips search and goes straight to checkout',
      actions: [
        {
          id: 'refresh_auth_reorder',
          executor: 'session',
          config: { action: 'refresh_auth' },
          output: '_auth_reorder',
        },
        {
          id: 'populate_reorder_cart',
          executor: 'quick_reorder',
          config: {},
          output: 'cart_prefill',
        },
      ],
      transitions: {
        success: 'reorder_check_multi_store',
        no_items: 'reorder_no_history',
        no_auth: 'check_auth_for_checkout',
        error: 'show_recommendations',
        default: 'reorder_check_multi_store',
      },
    },

    reorder_check_multi_store: {
      type: 'decision',
      description: 'Check if reorder items come from multiple stores',
      conditions: [
        {
          expression: '(() => { const ids = new Set((context.cart_items || []).map(i => i.storeId || i.store_id)); return ids.size > 1; })()',
          event: 'multi_store',
        },
      ],
      transitions: {
        multi_store: 'reorder_store_select',
        default: 'show_current_cart',
      },
    },

    reorder_store_select: {
      type: 'wait',
      description: 'Let user pick which store to reorder from',
      onEntry: [
        {
          id: 'build_store_options',
          executor: 'response',
          config: {
            message: '🔄 Your recent orders span multiple restaurants. Which one would you like to reorder from?',
            buttonsFromContext: {
              source: 'cart_items',
              groupBy: 'storeId',
              labelField: 'storeName',
              prefix: '🏪 ',
              maxButtons: 3,
            },
          },
          output: '_store_select_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'reorder_filter_to_store',
        default: 'reorder_filter_to_store',
      },
    },

    reorder_filter_to_store: {
      type: 'action',
      description: 'Keep only items from the selected store in cart',
      actions: [
        {
          id: 'filter_store_items',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              _reorder_store_filter: '{{_user_message}}',
            },
          },
        },
      ],
      transitions: {
        default: 'show_current_cart',
      },
    },

    reorder_no_history: {
      type: 'wait',
      description: 'No previous orders found, suggest browsing',
      onEntry: [
        {
          id: 'no_history_msg',
          executor: 'response',
          config: {
            message: '🔄 No recent orders found! Let me help you find something delicious.',
            buttons: [
              { id: 'btn_browse', label: 'Browse Menu', value: 'browse_menu' },
              { id: 'btn_search', label: 'Search Food', value: 'order_food' },
            ],
          },
        },
      ],
      transitions: {
        browse_menu: 'check_show_collections',
        order_food: 'check_search_query_exists',
        user_message: 'check_search_query_exists',
        default: 'check_search_query_exists',
      },
    },

    check_search_query_exists: {
      type: 'decision',
      description: 'Check if NLU extracted specific food items or restaurant, or if query is vague',
      conditions: [
        {
          // 🏪🏪 MULTI-STORE: If NLU detected multiple stores (e.g., "paneer from ganesh and gulkand from dagu teli")
          // store_references is an array of {store, items} extracted by LLM
          expression: 'context.food_nlu?.entities?.store_references && Array.isArray(context.food_nlu.entities.store_references) && context.food_nlu.entities.store_references.length >= 2',
          event: 'multi_store',
        },
        {
          // If user mentioned a restaurant (with or without food items), go to restaurant search
          // NLU extracts store_reference for restaurant names like "haldirams", "dominos", "inayat cafe"
          // 🔒 SAFETY: Exclude common words that are NOT restaurant names
          // Pattern: store_reference exists AND is not in blocklist AND is not too short (less than 3 chars)
          expression: `(context.food_nlu?.entities?.store_reference || context.extracted_food?.restaurant) && 
                       !["order", "food", "khana", "khaana", "eat", "want", "need", "send", "give", "menu", "show", "list", "what", "can", "i", "me", "my", "the", "a", "an", "delivery", "deliver", "home", "office", "ghar", "karo", "do", "please", "jaldi", "abhi", "fast", "quick", "now", "today", "tomorrow", "kuch", "something", "anything", "best", "famous", "popular", "good", "tasty", "cheap", "nearby", "near", "close", "around", "any", "other", "store", "restro", "restaurant", "shop", "dukan", "more", "different", "aur", "alag", "dusra", "koi", "bhi", "hotel", "cafe", "dhaba", "browse", "search", "find", "look", "category", "categories", "open", "check", "tell", "suggest", "recommend"].includes((context.food_nlu?.entities?.store_reference || context.extracted_food?.restaurant || "").toLowerCase()) &&
                       (context.food_nlu?.entities?.store_reference || context.extracted_food?.restaurant || "").length >= 3`,
          event: 'restaurant_only',
        },
        {
          // SMART: If NLU extracted specific food items, proceed to search
          // food_reference contains actual food names like ["pizza", "biryani", "burger"]
          // 🔒 FILTER: Exclude vague generic terms that are NOT specific food items
          expression: `context.food_nlu?.entities?.food_reference && Array.isArray(context.food_nlu.entities.food_reference) && context.food_nlu.entities.food_reference.length > 0 &&
                       !context.food_nlu.entities.food_reference.every(ref => ["food", "khana", "khaana", "eat", "order", "item", "items", "menu", "something", "anything", "kuch", "order_food"].includes(String(ref).toLowerCase()))`,
          event: 'has_food_items',
        },
        {
          // SMART: If extracted_food.items has specific food items from NLU mapping
          // 🔒 FILTER: Same vague term filter applied
          expression: `context.extracted_food?.items && Array.isArray(context.extracted_food.items) && context.extracted_food.items.length > 0 &&
                       !context.extracted_food.items.every(ref => ["food", "khana", "khaana", "eat", "order", "item", "items", "menu", "something", "anything", "kuch", "order_food"].includes(String(ref).toLowerCase()))`,
          event: 'has_food_items',
        }
        // DEFAULT: If NLU couldn't extract any food entities, query is vague → show recommendations
      ],
      transitions: {
        multi_store: 'multi_store_search',               // 🏪🏪 Multiple stores detected → parallel search
        restaurant_only: 'search_food_with_restaurant',  // Has restaurant, search for it
        has_food_items: 'merge_nlu_with_llm',            // Has specific food, search for it
        default: 'ask_what_to_eat',                         // No entities = vague query → ask user what they want
      },
    },

    merge_nlu_with_llm: {
      type: 'action',
      description: 'Merge NLU entities with LLM extraction, preferring NLU for food items',
      actions: [
        {
          id: 'merge_entities',
          executor: 'response',
          config: {
            // Build search query from NLU food_reference if available, else use LLM
            saveToContext: {
              _nlu_food_reference: '{{food_nlu.entities.food_reference}}',
              _nlu_restaurant: '{{food_nlu.entities.store_reference}}',
              _llm_search_query: '{{extracted_food.search_query}}',
              _llm_restaurant: '{{extracted_food.restaurant}}',
            },
            event: 'merged',
          },
        },
      ],
      transitions: {
        merged: 'build_search_query',
        default: 'build_search_query',
      },
    },

    ask_what_to_eat: {
      type: 'wait',
      description: 'Ask user what specific food they want when query is vague',
      onEntry: [
        {
          id: 'ask_food_choice',
          executor: 'response',
          config: {
            message: '{{#if _location_just_received}}📍 Got your location! Now let me find the best options nearby...\n\n{{/if}}What would you like to order today? 🍽️\n\nYou can:\n• Tell me a dish name (e.g., "biryani", "pizza", "burger")\n• Browse the menu\n• See popular items',
            responseType: 'text',
            buttons: [
              { id: 'btn_popular', label: 'Popular items', value: 'popular' },
              { id: 'btn_browse', label: 'Browse menu', value: 'browse_menu' },
              { id: 'btn_surprise', label: 'Surprise me', value: 'surprise' }
            ],
            // Clear the flag after showing
            saveToContext: {
              _location_just_received: false,
            },
          },
          output: '_last_response',
        }
      ],
      actions: [],
      transitions: {
        user_message: 'route_food_choice',  // 🔧 FIX: Route through decision node to handle button clicks
        default: 'route_food_choice',
      },
    },

    build_search_query: {
      type: 'action',
      description: 'Build final search query using NLU food_reference if available',
      actions: [
        {
          id: 'build_query',
          executor: 'response',
          config: {
            // Merge NLU and LLM - prefer NLU for both food and restaurant
            saveToContext: {
              // For search query: prefer NLU food_reference, fallback to LLM search_query
              'extracted_food.search_query': '{{_nlu_food_reference || _llm_search_query || "food"}}',
              // For restaurant: ALWAYS prefer NLU store_reference (it's more accurate)
              'extracted_food.restaurant': '{{_nlu_restaurant || _llm_restaurant}}',
            },
            event: 'success',
          },
        },
      ],
      transitions: {
        updated: 'check_restaurant_filter',
        success: 'check_restaurant_filter',
        default: 'check_restaurant_filter',
      },
    },

    route_food_choice: {
      type: 'decision',
      description: 'Route food choice based on button value or user text',
      conditions: [
        {
          expression: '/^(browse_menu|browse\\s+menu|browse\\s+categories|categories)$/i.test(context._user_message?.trim()) || context._user_message?.trim() === "browse_menu"',
          event: 'browse_menu',
        },
        {
          expression: '/^(popular|popular\\s+items|trending)$/i.test(context._user_message?.trim()) || context._user_message?.trim() === "popular"',
          event: 'popular',
        },
        {
          expression: '/^(surprise|surprise\\s+me)$/i.test(context._user_message?.trim()) || context._user_message?.trim() === "surprise"',
          event: 'surprise',
        },
        {
          expression: '/^(cancel|exit|quit|bye)$/i.test(context._user_message?.trim())',
          event: 'cancel',
        },
      ],
      transitions: {
        browse_menu: 'check_show_collections',
        popular: 'show_recommendations',
        surprise: 'show_recommendations',
        cancel: 'cancelled',
        default: 'process_specific_food',  // User typed specific food → NLU extraction
      },
    },

    process_specific_food: {
      type: 'action',
      description: 'Extract food details from user response using NLU',
      actions: [
        {
          id: 'extract_from_nlu',
          executor: 'nlu',
          config: {
            input: '{{_user_message}}',
            extractEntities: true,
          },
          output: 'food_nlu',
        },
        {
          // Map NLU entities to extracted_food format
          id: 'map_entities',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              extracted_food: {
                items: '{{food_nlu.entities.food_reference || []}}',
                restaurant: '{{food_nlu.entities.store_reference || null}}',
                quantity: '{{food_nlu.entities.quantity || 1}}',
                search_query: '{{_user_message}}',
              },
            },
          },
        },
      ],
      transitions: {
        // Check if we have a valid search query before proceeding
        success: 'check_search_query_exists',
        default: 'check_search_query_exists',
      },
    },

    check_restaurant_filter: {
      type: 'decision',
      description: 'Check if user specified a restaurant to filter by',
      conditions: [
        {
          // If restaurant was extracted, use filtered search
          expression: 'context.extracted_food?.restaurant && context.extracted_food.restaurant !== "null" && context.extracted_food.restaurant !== null',
          event: 'has_restaurant',
        }
      ],
      transitions: {
        has_restaurant: 'search_food_with_restaurant',
        default: 'search_food',
      },
    },

    search_food: {
      type: 'action',
      description: 'Smart search with spell correction, synonyms, and ML reranking',
      actions: [
        {
          id: 'search_items',
          executor: 'search',
          config: {
            index: 'food_items',
            query: '{{extracted_food.search_query}}',
            size: SEARCH.RESULT_LIMIT,
            module_id: MODULE_ID.FOOD,
            fields: ['name', 'category_name', 'description', 'store_name'],
            formatForUi: true,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            radius: SEARCH.DEFAULT_RADIUS,
            useSmartSearch: true,
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'check_auto_select',  // Check if we should auto-select based on extracted quantities
        no_items: 'analyze_no_results',
        error: 'analyze_no_results', // Handle search errors gracefully
      },
    },

    search_food_with_restaurant: {
      type: 'action',
      description: 'Smart search for food items filtered by restaurant name',
      actions: [
        {
          id: 'search_items_restaurant',
          executor: 'search',
          config: {
            index: 'food_items',
            // If no specific items requested, use "popular food" as fallback
            query: '{{#if extracted_food.search_query}}{{extracted_food.search_query}}{{else}}popular food items menu{{/if}}',
            size: SEARCH.FALLBACK_RESULT_LIMIT,
            fields: ['name', 'category_name', 'description', 'store_name'],
            formatForUi: true,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            radius: SEARCH.FALLBACK_RADIUS,
            filters: [
              { field: 'store_name', operator: 'contains', value: '{{extracted_food.restaurant}}' }
            ],
            useSmartSearch: true,
          },
          output: 'search_results',
          // On error (timeout), continue to show_restaurant_not_found instead of failing
          onError: 'continue',
        },
      ],
      transitions: {
        // For express orders with items, go directly to auto-cart
        items_found: 'check_auto_select',
        no_items: 'show_restaurant_not_found',
        error: 'show_restaurant_not_found',
        default: 'show_restaurant_not_found', // Fallback for any unknown event
      },
    },

    multi_store_search: {
      type: 'action',
      description: 'Search items across multiple stores in parallel using store_references from NLU',
      actions: [
        {
          id: 'search_all_stores',
          executor: 'multi_store_search',
          config: {
            // store_references will be read from context.food_nlu.entities.store_references
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'multi_store_show_results',
        no_items: 'multi_store_no_results',
        error: 'multi_store_no_results',
        default: 'multi_store_no_results',
      },
    },

    show_results: {
      type: 'wait',
      description: 'Display food items to user and wait for selection',
      onEntry: [
        {
          id: 'display_items',
          executor: 'response',
          config: {
            message: '{{search_results.headerMessage || "Here are the results:"}}',
            cardsPath: 'search_results.cards',
            buttonsPath: 'search_results.filterButtons',
            buttons: [
              { id: 'btn_view_cart', label: 'View Cart', value: 'show cart' },
              { id: 'btn_browse', label: 'Browse Categories', value: 'browse_menu' },
              { id: 'btn_describe', label: 'More Info', value: 'describe_first_item' },
            ],
            // WhatsApp Business API: max 3 quick reply buttons, no dynamic filter chips
            channelResponses: {
              whatsapp: {
                message: '{{search_results.headerMessage || "Here are the results:"}}',
                buttonsPath: '',   // Override to disable dynamic filter chips on WhatsApp
                buttons: [
                  { id: 'btn_view_cart', label: 'Cart', value: 'show cart' },
                  { id: 'btn_browse', label: 'Browse', value: 'browse_menu' },
                  { id: 'btn_describe', label: 'More Info', value: 'describe_first_item' },
                ],
              },
            },
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        category_selected: 'search_by_category',  // 🔧 FIX: stale cat_N button click → re-search category
        describe_first_item: 'describe_item',     // User wants full description of first result
        user_message: 'resolve_user_intent',      // ✅ First resolve entities using Search API
        default: 'resolve_user_intent',
      },
    },

    multi_store_show_results: {
      type: 'wait',
      description: 'Display search results from multiple stores with store labels',
      onEntry: [
        {
          id: 'show_multi_store_items',
          executor: 'response',
          config: {
            message: '🏪 I found items from **{{search_results.storesFound}}** stores:\n\n{{#each search_results.storeSummaries}}{{this}}\n{{/each}}{{#if search_results.ecomSuggestions.length}}\n\n🛍️ Some items are available in our **Shop** section — say "search [item] in shop" to find them{{/if}}\n\nTap **Add +** to add items from any store to your cart:',
            cardsPath: 'search_results.cards',
            buttons: [
              { id: 'btn_view_cart', label: 'View Cart', value: 'show cart' },
              { id: 'btn_browse', label: 'Browse Categories', value: 'browse_menu' },
              { id: 'btn_alternatives', label: 'Find Alternatives', value: 'find alternatives for closed stores' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        // Note: button clicks arrive as user_message event (button value stored in _user_message)
        // checkout/view_cart routing is handled by resolve_user_intent → check_resolution_result
        user_message: 'resolve_user_intent',
        default: 'resolve_user_intent',
      },
    },

    analyze_no_results: {
      type: 'action',
      description: 'Check if user asked for specific restaurant not in DB',
      actions: [
        {
          id: 'analyze_failure',
          executor: 'llm',
          config: {
            systemPrompt: 'Analyze if the user requested a specific restaurant or item that was not found.',
            prompt: 'User query: "{{extracted_food.search_query}}". Did they mention a specific restaurant name? Return JSON: {"specific_restaurant": true/false, "restaurant_name": "name if found"}',
            temperature: 0.1,
            maxTokens: 50,
            parseJson: true
          },
          output: '_failure_analysis',
        }
      ],
      transitions: {
        success: 'check_custom_offer',
        error: 'no_results',
      }
    },

    no_results: {
      type: 'wait',
      description: 'No food items found',
      onEntry: [
        {
          id: 'no_results_message',
          executor: 'response',
          config: {
            message: 'Maaf kijiye, "{{original_food_query || _user_message}}" ke liye kuch nahi mila. 😕\n\nAap try kar sakte hain:\n• Missal Pav\n• Biryani\n• Vada Pav\n\nKya order karna chahte ho?',
            responseType: 'text',
            buttons: [
              { id: 'btn_missal', label: 'Missal Pav', value: 'missal pav' },
              { id: 'btn_biryani', label: 'Biryani', value: 'biryani' },
              { id: 'btn_browse', label: 'Browse Menu', value: 'browse_menu' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'understand_request',
        browse_menu: 'check_show_collections',
        default: 'understand_request',
      },
    },

    multi_store_no_results: {
      type: 'action',
      description: 'Handle case where multi-store search found no items - fall back to generic search',
      actions: [
        {
          id: 'multi_store_fallback',
          executor: 'response',
          config: {
            message: '😅 I couldn\'t find items from those specific stores. Let me search more broadly...',
            saveToContext: {
              // Fall back to first store reference for regular search
              'extracted_food.restaurant': '{{food_nlu.entities.store_reference}}',
              'extracted_food.search_query': '{{_user_message}}',
            },
            event: 'fallback',
          },
        },
      ],
      transitions: {
        fallback: 'search_food_with_restaurant',
        default: 'search_food_with_restaurant',
      },
    },

    show_restaurant_not_found: {
      type: 'action',
      description: 'Tell user restaurant was not found and try Google Places search',
      actions: [
        // First, try searching Google Places for the restaurant
        {
          id: 'external_search_auto',
          executor: 'external_search',
          config: {
            query: '{{extracted_food.restaurant}}',
            city: '{{or location.city "Nashik"}}',
            type: 'restaurant',
            radius: SEARCH.EXTERNAL_RADIUS_METERS,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
          },
          output: 'external_search_results',
        }
      ],
      transitions: {
        // If Google Places found results, show them
        found: 'show_external_vendor_found',
        // If not found anywhere, offer custom pickup
        not_found: 'offer_custom_pickup_manual',
        error: 'offer_custom_pickup_manual',
      },
    },

    clarify_store_not_found: {
      type: 'wait',
      description: 'Store mentioned by user was not found - show available options',
      onEntry: [
        {
          executor: 'response',
          config: {
            message: '❓ I couldn\'t find a store named "{{food_nlu.entities.store_reference}}". Here are the available options:',
            cardsPath: 'search_results.cards',  // Show current results
            buttons: [
              { id: 'btn_select', label: 'Choose from above', value: 'select from results' },
              { id: 'btn_new_search', label: 'Try different search', value: 'new search' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'process_selection',
        default: 'process_selection',
      },
    },

    search_external_vendor: {
      type: 'action',
      description: 'Search Google Places for the restaurant not in our database',
      actions: [
        {
          id: 'external_search',
          executor: 'external_search',
          config: {
            query: '{{_failure_analysis.restaurant_name}}',
            location: '{{or location.city "Nashik"}}',
            type: 'restaurant',
            radius: SEARCH.EXTERNAL_RADIUS_METERS,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
          },
          output: 'external_search_results',
        }
      ],
      transitions: {
        found: 'show_external_results',
        not_found: 'offer_custom_pickup',
        error: 'offer_custom_pickup',
      }
    },

    show_external_results: {
      type: 'wait',
      description: 'Display Google Places results to user',
      actions: [
        {
          id: 'display_external',
          executor: 'response',
          config: {
            message: '{{external_search_results.chatMessage}}',
            dynamicMetadata: {
              cards: 'external_search_results.cards'
            }
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'handle_external_selection',
        select_external: 'confirm_external_pickup', // Direct selection from card
        default: 'handle_external_selection',
      }
    },

    show_external_vendor_found: {
      type: 'wait',
      description: 'Show Google Places results and offer custom pickup',
      onEntry: [
        {
          id: 'display_google_result',
          executor: 'response',
          config: {
            message: `⚠️ **"{{extracted_food.restaurant}}" is not a Mangwale partner restaurant.**\n\nBut don't worry! I found it on Google Maps:\n\n📍 **{{external_search_results.topResult.name}}**\n📌 {{external_search_results.topResult.address}}\n{{#if external_search_results.topResult.rating}}⭐ {{external_search_results.topResult.rating}}{{/if}}\n\n🏍️ **Custom Pickup Available!**\nI can send a rider to pick up your order and deliver it to you.\n\n💡 *Note: Menu & prices not available. You'll need to tell us what to order.*`,
            buttons: [
              { id: 'btn_pickup_here', label: 'Yes, pickup here', value: 'yes order from {{external_search_results.topResult.name}}' },
              { id: 'btn_partners', label: 'Show Partners', value: 'show me partner restaurants' },
              { id: 'btn_different', label: 'Search Elsewhere', value: 'search for different restaurant' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_external_vendor_response',
        default: 'handle_external_vendor_response',
      },
    },

    handle_external_vendor_response: {
      type: 'action',
      description: 'Parse if user wants to order from external vendor',
      actions: [
        {
          id: 'parse_external_response',
          executor: 'llm',
          config: {
            systemPrompt: 'Determine if the user wants to order from the suggested external vendor.',
            prompt: 'User said: "{{user_message}}". Vendor: "{{external_search_results.topResult.name}}". Did they agree to order from there? Return JSON: {"confirmed": true/false, "wants_different": true/false}',
            temperature: 0.1,
            maxTokens: 50,
            parseJson: true
          },
          output: '_external_vendor_response',
        }
      ],
      transitions: {
        success: 'check_external_vendor_confirmation',
        error: 'understand_request',
      }
    },

    check_external_vendor_confirmation: {
      type: 'decision',
      description: 'Route based on user confirmation',
      conditions: [
        {
          expression: 'context._external_vendor_response?.confirmed === true',
          event: 'confirmed',
        },
        {
          expression: 'context._external_vendor_response?.wants_different === true',
          event: 'different',
        }
      ],
      transitions: {
        confirmed: 'setup_external_vendor_pickup',
        different: 'understand_request',
        default: 'understand_request',
      }
    },

    setup_external_vendor_pickup: {
      type: 'wait',
      description: 'Show external vendor details and offer parcel order options',
      onEntry: [
        {
          id: 'show_vendor_options',
          executor: 'response',
          config: {
            saveToContext: {
              'is_custom_order': true,
              'is_external_vendor': true,
              'external_vendor': {
                'name': '{{external_search_results.topResult.name}}',
                'address': '{{external_search_results.topResult.address}}',
                'lat': '{{external_search_results.topResult.lat}}',
                'lng': '{{external_search_results.topResult.lng}}',
                'maps_link': '{{external_search_results.topResult.maps_link}}',
                'place_id': '{{external_search_results.topResult.place_id}}'
              }
            },
            message: `⚠️ **Not a Mangwale Partner**\n\n📍 **{{external_search_results.topResult.name}}**\n📌 {{external_search_results.topResult.address}}\n🗺️ [View on Google Maps]({{external_search_results.topResult.maps_link}})\n\n🏍️ **Custom Pickup Service:**\nWe'll send a rider to this location to pick up your order.\n\n💡 *You'll need to call the store to place your order, or tell us what to pick up.*`,
            buttons: [
              { id: 'btn_create_parcel', label: 'Create Pickup Order', value: 'create parcel pickup' },
              { id: 'btn_partners', label: 'Show Partners', value: 'show partner restaurants' },
              { id: 'btn_call', label: 'Get Contact Info', value: 'call store' },
              { id: 'btn_different', label: 'Search Elsewhere', value: 'search different place' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_external_vendor_action',
        default: 'handle_external_vendor_action',
      }
    },

    handle_external_vendor_action: {
      type: 'action',
      description: 'Parse what user wants to do with external vendor',
      actions: [
        {
          id: 'parse_action',
          executor: 'llm',
          config: {
            prompt: 'User said: "{{user_message}}". What do they want? Options: 1) create_parcel - create pickup/delivery order, 2) share_details - share vendor info, 3) call_store - call the store, 4) search_different - look for different place. Return JSON: {"action": "create_parcel|share_details|call_store|search_different"}',
            temperature: 0.1,
            maxTokens: 30,
            parseJson: true
          },
          output: '_vendor_action',
        }
      ],
      transitions: {
        success: 'route_external_vendor_action',
        error: 'setup_external_vendor_pickup',
      }
    },

    route_external_vendor_action: {
      type: 'decision',
      conditions: [
        { expression: 'context._vendor_action?.action === "create_parcel"', event: 'create_parcel' },
        { expression: 'context._vendor_action?.action === "share_details"', event: 'share_details' },
        { expression: 'context._vendor_action?.action === "call_store"', event: 'call_store' },
        { expression: 'context._vendor_action?.action === "search_different"', event: 'search_different' },
      ],
      transitions: {
        create_parcel: 'confirm_parcel_delivery_address',
        share_details: 'share_external_vendor_details',
        call_store: 'show_store_contact',
        search_different: 'understand_request',
        default: 'setup_external_vendor_pickup',
      }
    },

    share_external_vendor_details: {
      type: 'wait',
      description: 'Share external vendor details that user can forward',
      onEntry: [
        {
          id: 'share_msg',
          executor: 'response',
          config: {
            message: `📍 **Store Details**\n\n🏪 **{{external_vendor.name}}**\n📌 {{external_vendor.address}}\n\n🗺️ Google Maps: {{external_vendor.maps_link}}\n\n_Copy and share this with friends!_`,
            buttons: [
              { id: 'btn_create', label: 'Create Pickup Order', value: 'create parcel pickup' },
              { id: 'btn_back', label: 'Back', value: 'go back' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_external_vendor_action',
        default: 'handle_external_vendor_action',
      }
    },

    show_store_contact: {
      type: 'wait',
      description: 'Show store contact info',
      onEntry: [
        {
          id: 'contact_msg',
          executor: 'response',
          config: {
            message: `📞 **Contact {{external_vendor.name}}**\n\n📌 {{external_vendor.address}}\n\n💡 You can find their contact number on Google Maps:\n🗺️ {{external_vendor.maps_link}}`,
            buttons: [
              { id: 'btn_create', label: 'Create Pickup Order', value: 'create parcel pickup' },
              { id: 'btn_back', label: 'Back', value: 'go back' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_external_vendor_action',
        default: 'handle_external_vendor_action',
      }
    },

    handle_parcel_address_confirmation: {
      type: 'action',
      description: 'Parse user confirmation for parcel delivery',
      actions: [
        {
          id: 'parse_confirm',
          executor: 'llm',
          config: {
            prompt: 'User said: "{{user_message}}". Did they: 1) confirm the delivery address, 2) want to change address, or 3) cancel? Return JSON: {"action": "confirm|change|cancel"}',
            temperature: 0.1,
            maxTokens: 30,
            parseJson: true
          },
          output: '_parcel_confirm',
        }
      ],
      transitions: {
        success: 'route_parcel_confirmation',
        error: 'confirm_parcel_delivery_address',
      }
    },

    route_parcel_confirmation: {
      type: 'decision',
      conditions: [
        { expression: 'context._parcel_confirm?.action === "confirm"', event: 'confirm' },
        { expression: 'context._parcel_confirm?.action === "change"', event: 'change' },
        { expression: 'context._parcel_confirm?.action === "cancel"', event: 'cancel' },
      ],
      transitions: {
        confirm: 'create_simple_parcel_order',
        change: 'ask_new_delivery_address',
        cancel: 'order_cancelled',
        default: 'confirm_parcel_delivery_address',
      }
    },

    confirm_parcel_delivery_address: {
      type: 'wait',
      description: 'Confirm user delivery address for parcel pickup',
      onEntry: [
        {
          id: 'confirm_delivery',
          executor: 'response',
          config: {
            message: `🏍️ **Parcel Pickup Order**\n\n📦 **Pickup:** {{external_vendor.name}}\n📌 {{external_vendor.address}}\n\n🏠 **Deliver to:** {{or delivery_address.formatted_address location.formatted_address "Your current location"}}\n\n✅ Confirm delivery address?`,
            buttons: [
              { id: 'btn_confirm', label: 'Confirm & Create', value: 'confirm delivery address' },
              { id: 'btn_change', label: 'Change Address', value: 'change address' },
              { id: 'btn_cancel', label: 'Cancel', value: 'cancel' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_parcel_address_confirmation',
        location: 'save_parcel_delivery_location',
        default: 'handle_parcel_address_confirmation',
      }
    },

    save_parcel_delivery_location: {
      type: 'action',
      description: 'Save GPS location for parcel delivery',
      actions: [
        {
          id: 'save_delivery_loc',
          executor: 'response',
          config: {
            saveToContext: {
              'parcel_delivery_location': {
                'lat': '{{location.lat}}',
                'lng': '{{location.lng}}',
                'address': '{{or location.address location.formatted_address "Shared location"}}',
              }
            },
            message: '📍 Delivery location saved! Creating your order...',
          },
        }
      ],
      transitions: {
        success: 'create_simple_parcel_order',
      }
    },

    create_simple_parcel_order: {
      type: 'action',
      description: 'Create simple parcel pickup-drop order',
      actions: [
        {
          id: 'create_order',
          executor: 'response',
          config: {
            saveToContext: {
              'order_type': 'parcel_pickup',
              'order_status': 'created',
              'parcel_order': {
                'pickup': {
                  'name': '{{external_vendor.name}}',
                  'address': '{{external_vendor.address}}',
                  'lat': '{{external_vendor.lat}}',
                  'lng': '{{external_vendor.lng}}',
                },
                'drop': {
                  'address': '{{or parcel_delivery_location.address delivery_address.formatted_address location.formatted_address}}',
                  'lat': '{{or parcel_delivery_location.lat delivery_address.lat location.lat}}',
                  'lng': '{{or parcel_delivery_location.lng delivery_address.lng location.lng}}',
                },
                'created_at': '{{now}}',
              }
            },
            message: `🎉 **Parcel Order Created!**\n\n📦 **Pickup From:**\n🏪 {{external_vendor.name}}\n📌 {{external_vendor.address}}\n\n🏠 **Deliver To:**\n📍 {{or parcel_delivery_location.address delivery_address.formatted_address location.formatted_address "Your location"}}\n\n⏱️ **Estimated:** 30-45 minutes\n\n🏍️ Our delivery partner will:\n1️⃣ Go to the pickup location\n2️⃣ Collect your order (you can call to place order)\n3️⃣ Deliver it to you\n\n💰 **Payment:** Cash on delivery\n\n📞 You'll receive a call when rider is assigned!`,
            buttons: [
              { id: 'btn_track', label: 'Track Order', value: 'track my order' },
              { id: 'btn_call_store', label: 'Call Store Now', value: 'call store' },
              { id: 'btn_home', label: 'Home', value: 'go to home' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'understand_request',
      }
    },

    offer_custom_pickup: {
      type: 'wait',
      description: 'Offer to pick up from the specific restaurant via parcel service',
      actions: [
        {
          id: 'offer_custom_message',
          executor: 'llm',
          config: {
            systemPrompt: 'You are a helpful assistant. The user wanted food from a specific place we don\'t partner with.',
            prompt: `User wanted: {{extracted_food.search_query}}.
Restaurant "{{_failure_analysis.restaurant_name}}" is not in our partner list.
However, offer to send a rider to pick up the order if they place it directly with the restaurant.
Ask: "Would you like me to send a rider to pick it up for you?"`,
            temperature: 0.7,
            maxTokens: 100,
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'handle_custom_pickup_response',
        default: 'handle_custom_pickup_response',
      }
    },

    offer_custom_pickup_manual: {
      type: 'wait',
      description: 'Offer manual address entry for custom pickup',
      actions: [
        {
          id: 'custom_pickup_msg',
          executor: 'response',
          config: {
            message: `❌ **"{{extracted_food.restaurant}}" is not available**\n\nThis restaurant is neither a Mangwale partner nor found on Google Maps.\n\n🏍️ **Custom Pickup Option:**\nYou can still order from ANY place! Just:\n\n1️⃣ Share the **location/address** of the restaurant\n2️⃣ Tell us what to **order**\n3️⃣ We'll pick it up & deliver!\n\n📍 Share the pickup location below:`,
            buttons: [
              { id: 'btn_share_location', label: 'Share Location', value: TOKEN.LOCATION },
              { id: 'btn_browse', label: 'Partner Restaurants', value: 'show me partner restaurants' },
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

    handle_custom_pickup_location: {
      type: 'action',
      description: 'Parse user-provided pickup location/address',
      actions: [
        {
          id: 'geocode_address',
          executor: 'external_search',
          config: {
            query: '{{user_message}}',
            city: '{{or location.city "Nashik"}}',
            type: 'establishment',
            radius: SEARCH.EXTERNAL_RADIUS_METERS,
          },
          output: 'custom_pickup_search',
        }
      ],
      transitions: {
        found: 'confirm_custom_pickup_location',
        not_found: 'request_exact_location',
        error: 'request_exact_location',
      }
    },

    save_custom_pickup_location: {
      type: 'action',
      description: 'Save GPS location shared by user for custom pickup',
      actions: [
        {
          id: 'save_gps_location',
          executor: 'response',
          config: {
            saveToContext: {
              'is_custom_order': true,
              'custom_pickup_location': {
                'lat': '{{location.lat}}',
                'lng': '{{location.lng}}',
                'address': '{{or location.address "Custom pickup location"}}',
                'source': 'gps'
              }
            },
            message: '📍 Got your pickup location!\n\n📝 Now tell me what you\'d like me to order from there.\n\n💡 Example: "2 butter chicken, 3 naan, 1 dal makhani"',
          },
        }
      ],
      transitions: {
        user_message: 'capture_custom_order_items',
      }
    },

    confirm_custom_pickup_location: {
      type: 'wait',
      description: 'Confirm the parsed pickup address with user',
      actions: [
        {
          id: 'confirm_location',
          executor: 'response',
          config: {
            message: '📍 I found this location:\n\n**{{custom_pickup_search.topResult.name}}**\n{{custom_pickup_search.topResult.address}}\n\nIs this correct?',
            buttons: [
              { id: 'btn_yes', label: 'Yes, this is it', value: 'yes correct' },
              { id: 'btn_no', label: 'No, try again', value: 'no wrong location' },
              { id: 'btn_share', label: 'Share GPS Location', value: TOKEN.LOCATION },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_location_confirmation',
        location: 'save_custom_pickup_location',
        default: 'handle_location_confirmation',
      }
    },

    handle_custom_pickup_response: {
      type: 'decision',
      description: 'Check if user wants custom pickup',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().includes("yes") || context._user_message?.toLowerCase().includes("sure") || context._user_message?.toLowerCase().includes("please")',
          event: 'accepted',
        }
      ],
      transitions: {
        accepted: 'collect_custom_pickup_details',
        default: 'no_results', // If they say no, just show generic alternatives
      }
    },

    extract_custom_pickup: {
      type: 'action',
      description: 'Extract pickup location',
      actions: [
        {
          id: 'extract_pickup_loc',
          executor: 'address', // Use address executor to resolve location
          config: {
            field: 'custom_pickup_location',
            prompt: 'Resolving pickup location...',
            useUserMessage: true, 
          },
          output: 'custom_pickup_location',
        },
        {
          id: 'set_custom_flag',
          executor: 'response',
          config: {
            saveToContext: {
              'is_custom_order': true,
              'custom_item_details': '{{extracted_food.search_query}}' // Default to search query
            }
          }
        }
      ],
      transitions: {
        address_valid: 'collect_address', // Reuse standard address collection for drop
        error: 'collect_custom_pickup_details', // Retry
      }
    },

    finalize_custom_pickup_location: {
      type: 'action',
      description: 'Save confirmed custom pickup location',
      actions: [
        {
          id: 'save_confirmed_location',
          executor: 'response',
          config: {
            saveToContext: {
              'is_custom_order': true,
              'custom_pickup_location': {
                'name': '{{custom_pickup_search.topResult.name}}',
                'address': '{{custom_pickup_search.topResult.address}}',
                'lat': '{{custom_pickup_search.topResult.lat}}',
                'lng': '{{custom_pickup_search.topResult.lng}}',
                'maps_link': '{{custom_pickup_search.topResult.maps_link}}',
                'source': 'search'
              }
            },
            message: '✅ Location saved!\n\n📝 What would you like me to order from **{{custom_pickup_search.topResult.name}}**?\n\n💡 Example: "2 pizzas, 1 coke, garlic bread"',
          },
        }
      ],
      transitions: {
        user_message: 'capture_custom_order_items',
      }
    },

    capture_custom_order_items: {
      type: 'action',
      description: 'Parse user-specified items for custom pickup order',
      actions: [
        {
          id: 'parse_items',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract food items and quantities from user message. Be generous with interpretation.',
            prompt: 'User said: "{{user_message}}". Extract items and quantities as JSON: {"items": [{"name": "item name", "quantity": 1, "notes": "any special notes"}], "has_items": true/false}',
            temperature: 0.1,
            maxTokens: 200,
            parseJson: true
          },
          output: 'custom_order_items',
        }
      ],
      transitions: {
        success: 'check_custom_items_captured',
        error: 'ask_custom_items_again',
      }
    },

    check_custom_items_captured: {
      type: 'decision',
      conditions: [
        {
          expression: 'context.custom_order_items?.has_items === true && context.custom_order_items?.items?.length > 0',
          event: 'has_items',
        }
      ],
      transitions: {
        has_items: 'confirm_custom_order',
        default: 'ask_custom_items_again',
      }
    },

    handle_custom_order_confirmation: {
      type: 'action',
      description: 'Parse user confirmation for custom order',
      actions: [
        {
          id: 'parse_confirm',
          executor: 'llm',
          config: {
            prompt: 'User said: "{{user_message}}". Did they: 1) Confirm order, 2) Want to edit, or 3) Cancel? Return JSON: {"action": "confirm|edit|cancel"}',
            temperature: 0.1,
            maxTokens: 30,
            parseJson: true
          },
          output: '_custom_order_action',
        }
      ],
      transitions: {
        success: 'route_custom_order_action',
        error: 'confirm_custom_order',
      }
    },

    route_custom_order_action: {
      type: 'decision',
      conditions: [
        { expression: 'context._custom_order_action?.action === "confirm"', event: 'confirm' },
        { expression: 'context._custom_order_action?.action === "edit"', event: 'edit' },
        { expression: 'context._custom_order_action?.action === "cancel"', event: 'cancel' },
      ],
      transitions: {
        confirm: 'create_custom_order',
        edit: 'ask_custom_items_again',
        cancel: 'order_cancelled',
        default: 'confirm_custom_order',
      }
    },

    confirm_custom_order: {
      type: 'wait',
      description: 'Show order summary for custom pickup',
      actions: [
        {
          id: 'show_summary',
          executor: 'response',
          config: {
            message: '📋 **Custom Order Summary**\n\n🏪 **Pickup from:** {{or custom_pickup_location.name external_search_results.topResult.name}}\n📍 {{or custom_pickup_location.address external_search_results.topResult.address}}\n\n🛒 **Items:**\n{{#each custom_order_items.items}}• {{quantity}}x {{name}}{{#if notes}} ({{notes}}){{/if}}\n{{/each}}\n\n📦 **Delivery to:** {{or delivery_address.formatted_address location.formatted_address "Your location"}}\n\n💰 Price will be confirmed after pickup.\n\nConfirm to proceed?',
            buttons: [
              { id: 'btn_confirm', label: 'Confirm Order', value: 'confirm custom order' },
              { id: 'btn_edit', label: 'Edit Items', value: 'edit items' },
              { id: 'btn_cancel', label: 'Cancel', value: 'cancel order' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'handle_custom_order_confirmation',
        default: 'handle_custom_order_confirmation',
      }
    },

    place_custom_order: {
      type: 'action',
      description: 'Create custom pickup order',
      actions: [
        {
          id: 'create_custom_order',
          executor: 'order',
          config: {
            type: 'parcel', // Treat as parcel
            pickupAddressPath: 'custom_pickup_location',
            deliveryAddressPath: 'delivery_address',
            pricingPath: 'pricing',
            detailsPath: 'custom_item_details', // Pass item name as details
            isCustomFood: true,
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

    create_custom_order: {
      type: 'action',
      description: 'Create parcel order for custom pickup',
      actions: [
        {
          id: 'create_parcel',
          executor: 'response',
          config: {
            message: '🎉 **Order Created!**\n\nOur delivery partner will:\n1️⃣ Pick up from {{or custom_pickup_location.name external_search_results.topResult.name}}\n2️⃣ Collect your items\n3️⃣ Deliver to you\n\n📞 You\'ll receive a call to confirm the order amount.\n\n🔔 Track your order for live updates!',
            saveToContext: {
              'order_type': 'custom_pickup',
              'order_status': 'pending_partner',
            },
            buttons: [
              { id: 'btn_track', label: 'Track Order', value: 'track my order' },
              { id: 'btn_home', label: 'Back to Home', value: 'go to home' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'understand_request',
      }
    },

    show_partner_stores: {
      type: 'action',
      description: 'Search for partner stores nearby',
      actions: [
        {
          id: 'search_partner_stores',
          executor: 'search',
          config: {
            index: 'stores',
            query: '*',
            size: SEARCH.STORE_LIMIT,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            radius: SEARCH.FALLBACK_RADIUS,
            fields: ['name', 'address', 'category', 'rating'],
            formatForUi: true,
          },
          output: 'partner_store_results',
        },
      ],
      transitions: {
        items_found: 'display_partner_stores',
        no_items: 'no_partner_stores_found',
        error: 'show_recommendations',
        default: 'display_partner_stores',
      },
    },

    display_partner_stores: {
      type: 'wait',
      description: 'Show partner stores and wait for selection',
      onEntry: [
        {
          id: 'show_store_list',
          executor: 'response',
          config: {
            message: '🏪 Here are Mangwale partner restaurants near you:\n\nTap on any store to see their menu!',
            responseType: 'cards',
            dynamicMetadata: {
              cards: 'partner_store_results.cards'
            },
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'check_store_click',
        item_selected: 'handle_store_selection',
        default: 'check_store_click',
      },
    },

    check_store_click: {
      type: 'decision',
      description: 'Route store card clicks vs free text',
      conditions: [
        {
          expression: '/^store_\\d+$/i.test(context._user_message?.trim() || "")',
          event: 'store_clicked',
        },
      ],
      transitions: {
        store_clicked: 'handle_store_selection',
        default: 'understand_request',
      },
    },

    no_partner_stores_found: {
      type: 'wait',
      description: 'No partner stores found nearby',
      onEntry: [
        {
          id: 'no_stores_msg',
          executor: 'response',
          config: {
            message: '😔 No partner restaurants found in your area yet.\n\nWe are expanding soon! In the meantime, try these popular items:',
            responseType: 'text',
          },
          output: '_last_response',
        }
      ],
      transitions: {
        default: 'show_recommendations',
      },
    },

    handle_store_selection: {
      type: 'action',
      description: 'User selected a store, search for their menu items',
      actions: [
        {
          id: 'extract_store_id',
          executor: 'response',
          config: {
            saveToContext: {
              _selected_store_id: '{{_user_message}}',
            },
          },
          output: '_extract_result',
        },
        {
          id: 'search_store_items',
          executor: 'search',
          config: {
            index: 'food_items',
            query: '*',
            size: SEARCH.RESULT_LIMIT,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            filters: [{ field: 'store_id', operator: 'equals', value: '{{_selected_store_id}}' }],
            fields: ['name', 'store_name', 'category', 'price'],
            formatForUi: true,
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'show_results',
        no_items: 'show_recommendations',
        default: 'show_results',
      },
    },

    show_categories: {
      type: 'action',
      description: 'Show food categories for user to browse',
      actions: [
        {
          id: 'get_categories',
          executor: 'search',
          config: {
            type: 'categories',
            index: 'food_items',
            limit: SEARCH.CATEGORY_LIMIT,
          },
          output: 'category_results',
        },
      ],
      transitions: {
        success: 'display_categories',
        error: 'show_recommendations',  // Fallback to recommendations
        default: 'display_categories',
      },
    },

    show_open_now: {
      type: 'action',
      description: 'Show only currently open restaurants with time-appropriate items',
      actions: [
        {
          id: 'search_open_now',
          executor: 'search',
          config: {
            type: 'search',
            index: 'food_items',
            queryMode: 'recommendation',  // Uses time-of-day search terms
            open_now: true,               // SearchExecutor will filter to open stores only
            limit: SEARCH.STORE_LIMIT,
          },
          output: 'search_results',
        },
      ],
      transitions: {
        success: 'show_results',
        error: 'show_recommendations',
        default: 'show_results',
      },
    },

    check_show_collections: {
      type: 'decision',
      description: 'Route browse to personalized collections for logged-in users',
      conditions: [
        {
          expression: `context.authenticated === true && !!context.user_id`,
          event: 'has_profile',
        },
      ],
      transitions: {
        has_profile: 'browse_collections',
        default: 'show_categories',
      },
    },

    browse_collections: {
      type: 'action',
      description: 'Load smart personalized food collections for user',
      actions: [
        {
          id: 'load_collections',
          executor: 'collections',
          config: { limit: 4 },
          output: 'user_collections',
        },
      ],
      transitions: {
        success: 'display_collections',
        error: 'show_categories',
        default: 'show_categories',
      },
    },

    display_collections: {
      type: 'wait',
      description: 'Show personalised collections and wait for user tap',
      onEntry: [
        {
          id: 'show_collections',
          executor: 'response',
          config: {
            message: 'What are you in the mood for? 😋',
            responseType: 'buttons',
            buttonsPath: 'user_collections',
            buttonConfig: { labelPath: 'title', valuePath: 'query' },
          },
        },
      ],
      transitions: {
        // 🔧 FIX: Route through route_food_choice so typed food names (e.g., "misal")
        // go through entity extraction (process_specific_food) before check_search_query_exists.
        // Previously went directly to check_search_query_exists which had no entities populated.
        user_message: 'route_food_choice',
        default: 'route_food_choice',
      },
    },

    display_categories: {
      type: 'wait',
      description: 'Show categories and wait for selection',
      onEntry: [
        {
          id: 'show_category_list',
          executor: 'response',
          config: {
            message: '📋 Choose a category to explore:',
            responseType: 'buttons',
            buttonsPath: 'category_results',
            buttonConfig: { labelPath: 'name', valuePath: 'id', valuePrefix: 'cat_' },
          },
        }
      ],
      transitions: {
        user_message: 'route_category_input',
        default: 'route_category_input',
      },
    },

    route_category_input: {
      type: 'decision',
      description: 'Detect whether user clicked a category button or typed a free-text query',
      conditions: [
        {
          // Category button click: cat_N format
          expression: `/^cat_\\d+$/i.test(context._user_message?.trim())`,
          event: 'category_button',
        },
        {
          // Browse/category intent — show categories again
          expression: `/^(browse_menu|browse\\s+menu|browse\\s+categories|categories|back)$/i.test(context._user_message?.trim())`,
          event: 'browse_again',
        },
      ],
      transitions: {
        category_button: 'search_by_category',  // cat_N → category endpoint
        browse_again: 'show_categories',         // browse → re-show categories
        default: 'save_text_search_from_browse', // free text → treat as search query
      },
    },

    search_by_category: {
      type: 'action',
      description: 'Search items in selected category',
      actions: [
        {
          id: 'search_category_items',
          executor: 'search',
          config: {
            type: 'category_items',
            index: 'food_items',
            categoryId: '{{_user_message}}',
            size: 10,
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            zone_id: '{{zone_id}}',
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'show_results',
        no_items: 'no_results',
        error: 'no_results',
        default: 'show_results',
      },
    },

    show_recommendations: {
      type: 'action',
      description: 'Show time-aware personalized recommendations',
      actions: [
        {
          id: 'get_recommendations',
          executor: 'search',
          config: {
            index: 'food_items',
            // 🕐 recommendation mode: auto-generates time-of-day terms + user history
            query: 'recommendation',
            queryMode: 'recommendation',
            size: 10,
            fields: ['name', 'category_name', 'description', 'store_name'],
            formatForUi: true,
            sortBy: 'rating',
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            radius: '15km',
          },
          output: 'recommendation_results',
        },
      ],
      transitions: {
        items_found: 'display_recommendations',
        no_items: 'show_categories',
        error: 'show_categories',
      },
    },

    display_recommendations: {
      type: 'wait',
      description: 'Show recommended items as cards',
      onEntry: [
        {
          id: 'show_recs',
          executor: 'response',
          config: {
            message: '{{#if _location_just_received}}📍 Got your location!\n\n{{/if}}{{#if recommendation_results._greeting}}{{recommendation_results._greeting}}{{else}}🎉 Yeh dekho popular items:{{/if}}\n\nKisi bhi item pe tap karo order karne ke liye! 👇',
            cardsPath: 'recommendation_results.cards',
            buttons: [
              { id: 'btn_view_cart', label: 'View Cart', value: 'show cart' },
              { id: 'btn_browse', label: 'Browse Categories', value: 'browse_menu' },
              { id: 'btn_search', label: 'Search', value: 'search_different' },
            ],
            saveToContext: {
              _location_just_received: false,
            },
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'copy_recs_to_search_results',
        item_selected: 'process_selection',
        default: 'copy_recs_to_search_results',
      }
    },

    copy_recs_to_search_results: {
      type: 'action',
      description: 'Copy recommendation_results to search_results for selection processing',
      actions: [
        {
          id: 'copy_recs',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              search_results: '{{recommendation_results}}',
            },
          },
        },
      ],
      transitions: {
        success: 'resolve_user_intent',
        default: 'resolve_user_intent',
      },
    },

    no_recommendations: {
      type: 'wait',
      description: 'No recommendations available - show categories instead',
      actions: [
        {
          id: 'no_recs_msg',
          executor: 'response',
          config: {
            message: '🍽️ Hamare paas bahut kuch hai! Choose karo kya khana hai:\n\n• 🍕 Pizza\n• 🍔 Burger\n• 🍛 Biryani\n• 🥟 Momos\n• 🥪 Sandwich\n\nYa fir directly bolo kya chahiye!',
            responseType: 'text',
            buttons: [
              { id: 'btn_pizza', label: 'Pizza', value: 'pizza' },
              { id: 'btn_biryani', label: 'Biryani', value: 'biryani' },
              { id: 'btn_burger', label: 'Burger', value: 'burger' },
              { id: 'btn_momos', label: 'Momos', value: 'momos' },
            ],
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'understand_request',
        pizza: 'process_specific_food',
        biryani: 'process_specific_food',
        burger: 'process_specific_food',
        momos: 'process_specific_food',
        default: 'understand_request',
      }
    },

    search_fastest_delivery: {
      type: 'action',
      description: 'Search for nearby restaurants sorted by delivery time',
      actions: [
        {
          id: 'search_fast_delivery',
          executor: 'search',
          config: {
            index: 'food_items',
            query: 'recommendation',
            queryMode: 'recommendation',
            size: 10,
            fields: ['name', 'category_name', 'description', 'store_name'],
            formatForUi: true,
            sortBy: 'delivery_time',
            lat: '{{location.lat}}',
            lng: '{{location.lng}}',
            radius: SEARCH.DEFAULT_RADIUS,
          },
          output: 'fast_delivery_results',
        },
      ],
      transitions: {
        items_found: 'show_fast_delivery_results',
        no_items: 'show_recommendations',
        error: 'show_recommendations',
      },
    },

    copy_fast_delivery_to_search_results: {
      type: 'action',
      description: 'Copy fast_delivery_results to search_results for selection processing',
      actions: [
        {
          id: 'copy_fast',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              search_results: '{{fast_delivery_results}}',
            },
          },
        },
      ],
      transitions: {
        success: 'resolve_user_intent',
        default: 'resolve_user_intent',
      },
    },

    show_fast_delivery_results: {
      type: 'wait',
      description: 'Show restaurants with fastest delivery',
      onEntry: [
        {
          id: 'show_fast_options',
          executor: 'response',
          config: {
            message: '⚡ Here are the fastest delivery options near you! These restaurants can deliver quickly:',
            dynamicMetadata: {
              cards: 'fast_delivery_results.cards'
            }
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'copy_fast_delivery_to_search_results',
        item_selected: 'process_selection',
        default: 'copy_fast_delivery_to_search_results',
      }
    },

    handle_external_selection: {
      type: 'action',
      description: 'Parse user selection from external results',
      actions: [
        {
          id: 'parse_external_selection',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract which external vendor the user selected. Results: {{external_search_results.places}}',
            prompt: 'User said: "{{user_message}}". Which vendor did they select? Return JSON: {"selected_index": 0, "vendor_name": "name", "selected": true/false}',
            temperature: 0.1,
            maxTokens: 80,
            parseJson: true
          },
          output: '_external_selection',
        }
      ],
      transitions: {
        success: 'check_external_selection',
        error: 'show_external_results',
      }
    },

    check_external_selection: {
      type: 'decision',
      description: 'Validate external selection',
      conditions: [
        {
          expression: 'context._external_selection?.selected === true',
          event: 'selected',
        }
      ],
      transitions: {
        selected: 'confirm_external_pickup',
        default: 'offer_custom_pickup', // Fallback to manual pickup offer
      }
    },

    confirm_external_pickup: {
      type: 'action',
      description: 'Set up custom pickup from selected external vendor',
      actions: [
        {
          id: 'set_external_vendor',
          executor: 'response',
          config: {
            saveToContext: {
              'is_custom_order': true,
              'is_external_vendor': true,
              'external_vendor_name': '{{external_search_results.topResult.name}}',
              'external_vendor_address': '{{external_search_results.topResult.address}}',
              'external_vendor_location': {
                'lat': '{{external_search_results.topResult.lat}}',
                'lng': '{{external_search_results.topResult.lng}}'
              },
              'maps_link': '{{external_search_results.topResult.mapsLink}}',
              'custom_pickup_location': {
                'name': '{{external_search_results.topResult.name}}',
                'address': '{{external_search_results.topResult.address}}',
                'lat': '{{external_search_results.topResult.lat}}',
                'lng': '{{external_search_results.topResult.lng}}'
              }
            }
          }
        },
        {
          id: 'confirm_external_message',
          executor: 'llm',
          config: {
            systemPrompt: 'You are confirming a pickup order. Be enthusiastic and brief.',
            prompt: `Great choice! User selected {{or external_vendor_name external_search_results.topResult.name}}.
Address: {{or external_vendor_address external_search_results.topResult.address}}
Distance: {{or external_search_results.topResult.distance "nearby"}}

Tell them we'll send a rider to pick up their order. Ask what specific items they want from this place.`,
            temperature: 0.7,
            maxTokens: 120,
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'collect_external_order_items',
      }
    },

    collect_external_order_items: {
      type: 'action',
      description: 'Record what items user wants from external vendor',
      actions: [
        {
          id: 'save_items',
          executor: 'response',
          config: {
            saveToContext: {
              'custom_item_details': '{{user_message}}'
            }
          }
        }
      ],
      transitions: {
        success: 'collect_address', // Continue to normal address collection
      }
    },

    ask_custom_items_again: {
      type: 'wait',
      description: 'Ask user to specify items again',
      actions: [
        {
          id: 'ask_items',
          executor: 'response',
          config: {
            message: '📝 I couldn\'t catch the items. Please tell me exactly what you want to order.\n\n💡 Example: "2 butter chicken, 3 naan, 1 dal fry, 2 coke"',
          },
        }
      ],
      transitions: {
        user_message: 'capture_custom_order_items',
        default: 'capture_custom_order_items',
      }
    },

    save_text_search_from_browse: {
      type: 'action',
      description: 'User typed a food/restaurant name while browsing categories — treat as search',
      actions: [
        {
          id: 'save_browse_query',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              extracted_food: {
                items: [],
                restaurant: null,
                search_query: '{{_user_message}}',
              },
              original_food_query: '{{_user_message}}',
            },
            event: 'saved',
          },
        },
      ],
      transitions: {
        saved: 'search_food',
        default: 'search_food',
      },
    },

    check_custom_offer: {
      type: 'decision',
      description: 'Decide if we should offer custom pickup',
      conditions: [
        {
          expression: 'context._failure_analysis?.specific_restaurant === true',
          event: 'search_external', // First try Google Places search
        }
      ],
      transitions: {
        search_external: 'search_external_vendor', // NEW: Search Google Places first
        default: 'no_results',
      }
    },

    collect_custom_pickup_details: {
      type: 'wait',
      description: 'Ask for pickup location details',
      actions: [
        {
          id: 'ask_pickup_details',
          executor: 'llm',
          config: {
            systemPrompt: 'You are arranging a custom pickup.',
            prompt: 'Ask for the pickup location (Restaurant Name & Area) and what item they are ordering. Be brief.',
            temperature: 0.6,
            maxTokens: 80,
          },
          output: '_last_response',
        }
      ],
      transitions: {
        user_message: 'extract_custom_pickup',
        default: 'extract_custom_pickup',
      }
    },

};
