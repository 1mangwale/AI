import { FlowState } from '../../../types/flow.types';
import { MODULE_ID, SEARCH } from '../../../../config/flow.constants';

/**
 * Food Order Flow — Cart And Selection States
 * Auto-extracted from food-order.flow.ts
 */
export const cartAndSelectionStates: Record<string, FlowState> = {
    describe_item: {
      type: 'wait',
      description: 'Show full description of the first search result item',
      onEntry: [
        {
          id: 'show_description',
          executor: 'response',
          config: {
            message: '📖 **{{search_results.cards.0.name}}**\n\n{{search_results.cards.0.description}}\n\n💰 Price: {{search_results.cards.0.price}}  |  🏪 {{search_results.cards.0.storeName}}',
            buttons: [
              { id: 'btn_add', label: 'Add to Cart', value: 'add {{search_results.cards.0.name}}' },
              { id: 'btn_back', label: 'Back to Results', value: 'show results' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        default: 'resolve_user_intent',
      },
    },

    resolve_user_intent: {
      type: 'action',
      description: 'Extract and resolve entities (stores, items) using OpenSearch to determine if this is a new search or selection',
      actions: [
        {
          id: 'extract_entities',
          executor: 'nlu',
          config: {},
          output: 'food_nlu',
        },
        {
          id: 'resolve_entities',
          executor: 'entity_resolution',
          config: {
            store_reference: '{{food_nlu.entities.store_reference}}',
            food_reference: '{{food_nlu.entities.food_reference}}',
          },
          output: 'resolved_entities',
        },
      ],
      transitions: {
        success: 'check_resolution_result',
        resolved: 'check_resolution_result',  // entity_resolution executor emits 'resolved' (non-generic event)
        error: 'process_selection',  // Fallback to selection on error
      },
    },

    check_resolution_result: {
      type: 'decision',
      description: 'Route based on entity resolution results from OpenSearch. PRIORITY: Button actions > Selection patterns > Entity search!',
      conditions: [
        {
          // 🔄 Quick Reorder: user confirmed "Add All to Cart" from the reorder preview screen
          expression: `/quick reorder confirm/i.test(context._user_message?.trim() || '')`,
          event: 'quick_reorder',
        },
        {
          // "what's open", "kya khula hai", "open now" → show open-only results
          expression: `/\\b(open now|open|khula|available|kya khula|what.*open|which.*open|abhi.*open)\\b/i.test(context._user_message?.trim() || '')`,
          event: 'open_now_requested',
        },
        {
          // Case -4: Detect describe / "tell me more" when user is looking at results
          // Triggers ONLY when search results are visible — prevents false-positives in other states
          expression: `context.search_results?.cards?.length > 0 && /\\b(describe|tell me more|what.?s in|more about|ingredients|details|explain|more info|what is it)\\b/i.test(context._user_message?.trim() || '')`,
          event: 'describe_requested',
        },
        {
          // Case -3: HIGHEST PRIORITY - Detect "browse menu" / "browse categories" button click
          expression: `/^(browse_menu|browse\\s+menu|browse\\s+categories|categories)$/i.test(context._user_message?.trim()) || context.food_nlu?.intent === 'browse_menu' || context.food_nlu?.intent === 'browse_category'`,
          event: 'browse_detected',
        },
        {
          // Case -2.5: Detect "search different" button click
          expression: `/^(search_different|search\\s+different|search\\s+more|new\\s+search)$/i.test(context._user_message?.trim())`,
          event: 'search_different',
        },
        {
          // Case -2: Detect category button click (cat_N format) - stale button safety
          // 🔧 FIX: Category buttons now use 'cat_5' prefix to avoid numeric item-selection conflict
          // Even if user clicks a stale category button while in show_results, it routes correctly
          expression: `/^cat_\\d+$/i.test(context._user_message?.trim())`,
          event: 'category_selected',
        },
        {
          // Case 0: HIGHEST PRIORITY - Detect selection patterns (item_ID, numbers, add to cart)
          // MUST be checked before checkout/view_cart because NLU can misclassify "item_10201" as view_cart
          // Matches: "item_12345" (card button click), "1", "2", "add 1 to cart", "first one", "add paneer to cart", etc.
          expression: `/^item_\\d+/i.test(context._user_message?.trim()) || /^(add\\s+)?\\d+(\\s*,\\s*\\d+)*\\s*(to\\s+cart)?$/i.test(context._user_message?.trim()) || /^(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(\\s+one)?$/i.test(context._user_message?.trim()) || /^add\\s+.+\\s+to\\s+(my\\s+)?cart$/i.test(context._user_message?.trim()) || /^select\\s+(\\d+|all)/i.test(context._user_message?.trim())`,
          event: 'selection_detected',
        },
        {
          // Case 1: Detect "checkout" button click or intent
          // Matches: "checkout", "place order", "order now", etc.
          // GUARD: Exclude item_ID patterns
          expression: `!(/^item_\\d+/i.test(context._user_message?.trim())) && (/^(checkout|place\\s+order|order\\s+now|proceed\\s+to\\s+(checkout|payment))$/i.test(context._user_message?.trim()) || context.food_nlu?.intent === 'checkout')`,
          event: 'checkout_detected',
        },
        {
          // Case 2: Detect "view cart" / "show cart" button click or intent
          // Matches: "show cart", "view cart", "my cart", "cart", "view_cart" etc.
          // GUARD: Exclude item_ID patterns to prevent NLU misclassification from hijacking selections
          expression: `!(/^item_\\d+/i.test(context._user_message?.trim())) && (/^(show\\s+cart|view\\s+cart|view_cart|my\\s+cart|cart|see\\s+cart|open\\s+cart)$/i.test(context._user_message?.trim()) || context.food_nlu?.intent === 'view_cart')`,
          event: 'view_cart_detected',
        },
        {
          // Case 1: Store resolved by OpenSearch → New search with store filter
          expression: 'context.resolved_entities?.stores && context.resolved_entities.stores.length > 0',
          event: 'store_resolved',
        },
        {
          // Case 2: Store mentioned but NOT found in OpenSearch → Clarify
          expression: 'context.food_nlu?.entities?.store_reference && (!context.resolved_entities?.stores || context.resolved_entities.stores.length === 0)',
          event: 'store_not_found',
        },
        {
          // Case 3: New food items detected (different from current results) → New search
          expression: 'context.resolved_entities?.items && context.resolved_entities.items.length > 0',
          event: 'items_resolved',
        },
      ],
      transitions: {
        open_now_requested: 'show_open_now',
        describe_requested: 'describe_item',                  // 🆕 "Tell me more" → show item description
        browse_detected: 'check_show_collections',              // 🔧 FIX: Route through personalization gate (was show_categories)
        search_different: 'ask_what_to_eat',                   // 🔧 New search from results
        checkout_detected: 'check_auth_for_checkout',       // 🔧 FIX: Direct route to checkout
        view_cart_detected: 'show_current_cart',             // 🔧 FIX: Direct route to cart view
        category_selected: 'search_by_category',            // 🔧 FIX: cat_N button click → category search
        selection_detected: 'clear_entities_for_selection',  // 🆕 Clear resolved_entities first
        store_resolved: 'search_food',
        store_not_found: 'prepare_restaurant_search_from_results',  // 🔧 FIX: Search by store name instead of dead-ending
        items_resolved: 'search_food',
        // Case 4: No new entities → Regular selection from existing results
        default: 'process_selection',
      },
    },

    clear_entities_for_selection: {
      type: 'action',
      description: 'Clear resolved_entities when selection is explicitly detected to prevent re-search',
      actions: [
        {
          id: 'clear_resolved_entities',
          executor: 'response',
          config: {
            event: 'cleared',
            saveToContext: {
              resolved_entities: null,  // Clear the entities
              _selection_mode: true,    // Flag that we're in selection mode
            },
          },
        },
      ],
      transitions: {
        cleared: 'process_selection',
        default: 'process_selection',
      },
    },

    process_selection: {
      type: 'action',
      description: 'Parse selected items and quantities using selection executor',
      actions: [
        {
          id: 'parse_selection',
          executor: 'selection',
          config: {
            // Selection executor will parse user message and match against search_results
          },
          output: 'selection_result',
        },
      ],
      transitions: {
        item_selected: 'add_to_cart',
        checkout: 'check_auth_for_checkout',
        cancel: 'check_trigger',
        search_more: 'search_food',
        search_items: 'search_requested_items', // User requested specific items not in results
        view_cart: 'show_current_cart',  // 🆕 Show cart when user asks
        ask_distance: 'show_distance_info',  // 🆕 User asked about distance
        needs_variation: 'prompt_variation_selection',  // 📦 Item has size/weight variations
        needs_addon: 'prompt_addon_selection',          // 🍟 Item has add-ons available
        unclear: 'clarify_selection',
        error: 'show_results',
      },
    },

    confirm_selection: {
      type: 'action',
      description: 'Show cart and ask for confirmation',
      actions: [
        {
          id: 'show_cart',
          executor: 'llm',
          config: {
            systemPrompt: 'You are showing the cart. List items, quantities, prices, and total.',
            prompt: `Show the cart summary:
Items in cart: {{selected_items.length}}
Total items value: ₹{{pricing.itemsTotal}}

Ask if they want to:
1. Proceed to checkout
2. Add more items
3. Cancel order`,
            temperature: 0.7,
            maxTokens: 200,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'check_cart_action',
      },
    },

    disambiguate_items: {
      type: 'action',
      description: 'Show disambiguation message listing similar items, then show product cards for selection',
      actions: [
        {
          id: 'show_disambiguation_msg',
          executor: 'response',
          config: {
            message: '{{auto_cart_result.message}}',
            saveToContext: {
              _disambiguation_qty: '{{auto_cart_result.disambiguationQuantity}}',
            },
          },
        },
      ],
      transitions: {
        // Route to existing show_results which displays product cards for manual selection
        default: 'show_results',
      },
    },

    clarify_selection: {
      type: 'wait', // Changed from 'action' to wait for user input
      description: 'Ask user to clarify their selection',
      actions: [
        {
          id: 'clarify_prompt',
          executor: 'response',
          config: {
            message: '{{#if (eq platform "web")}}Please select an item by clicking the "ADD" button below, or type the item name to add it to your cart.{{else}}I didn\'t quite understand your selection. Please:\n- Type a number (1, 2, 3) to select an item\n- Type "Add [item name] to cart"\n- Or say "checkout" when ready{{/if}}',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'process_selection',
        default: 'process_selection',
      },
    },

    check_auto_select: {
      type: 'decision',
      description: 'Check if extracted_food has EXPLICIT items to auto-add to cart',
      conditions: [
        {
          // ✅ VALIDATION: Only auto-cart if:
          // 1. Items extracted with quantity >= 1
          // 2. User's original message contained EACH food name (validates ALL items, not just first)
          // 3. OR Restaurant context exists (e.g., "ganesh ka paneer")
          // This prevents auto-cart on hallucinated items!
          expression: `
            context.extracted_food?.items &&
            context.extracted_food.items.length > 0 &&
            (
              // Case A: Items are proper {name, quantity} objects (from LLM multi-item extraction)
              context.extracted_food.items[0]?.quantity >= 1 ||
              // Case B: Items are plain strings from food_reference (express order path like "add 5 samosa from satyam")
              // String items always have a truthy string value — auto_cart uses defaultQuantity from NLU
              context.extracted_food.items.some(function(i) { return typeof i === 'string' ? i.length > 0 : !!(i && i.name); })
            ) &&
            (
              // Verify user message contains extracted item names (ALL items, not just first)
              (context._user_message && context.extracted_food.items.every(function(item) {
                var name = typeof item === 'string' ? item : item.name;
                if (!name) return false;
                var msg = context._user_message.toLowerCase();
                var words = name.toLowerCase().split(' ');
                // At least the first word of each extracted item must appear in user message
                return words.some(function(w) { return w.length > 2 && msg.indexOf(w) >= 0; });
              })) ||
              // OR user explicitly mentioned restaurant (e.g., "ganesh ka paneer", "5 samosa from satyam")
              (context.extracted_food?.restaurant && context.extracted_food.restaurant !== null && context.extracted_food.restaurant !== "null")
            )
          `,
          event: 'auto_select',
        }
      ],
      transitions: {
        auto_select: 'auto_match_items',
        default: 'show_results',  // Vague query → show results for manual selection
      },
    },

    auto_match_items: {
      type: 'action',
      description: 'Match extracted items with quantities against search results and add to cart',
      actions: [
        {
          id: 'match_and_add',
          executor: 'auto_cart',  // New executor that matches items and sets cart
          config: {
            extractedItemsPath: 'extracted_food.items',
            searchResultsPath: 'search_results.cards',
            // 🆕 Pass quantity from NLU (e.g., "5" in "add 5 samosa") as default for string items
            defaultQuantity: '{{express_order_detection.quantity || nlu_result.entities.quantity || 1}}',
          },
          output: 'auto_cart_result',
        },
      ],
      transitions: {
        all_matched: 'confirm_auto_cart',      // All items matched - show confirmation
        partial_match: 'confirm_auto_cart',    // Some matched - show what we found
        needs_disambiguation: 'disambiguate_items',  // Multiple similar items - ask user to choose
        no_match: 'show_results',              // Nothing matched - show results for manual selection
        error: 'show_results',
      },
    },

    confirm_auto_cart: {
      type: 'wait',
      description: 'Show auto-added items and ask for confirmation',
      onEntry: [
        {
          id: 'show_cart_confirmation',
          executor: 'response',
          config: {
            // Enhanced message for express orders showing delivery info - payment shown later in checkout
            message: '{{auto_cart_result.message}}{{#if _delivery_address_type}}\n\n📍 Delivery: {{_delivery_address_type}}{{/if}}\n\n**Ready to proceed to checkout?**',
            // Show cart items as cards for mobile-friendly display
            cardsPath: 'auto_cart_result.selectedItems',
            buttons: [
              { id: 'btn_confirm', label: 'Proceed to Checkout', value: 'checkout' },
              { id: 'btn_modify', label: 'Modify Cart', value: 'show cart' }
            ],
            saveToContext: {
              cart_items: '{{auto_cart_result.selectedItems}}',
              selected_items: '{{auto_cart_result.selectedItems}}',
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'handle_auto_cart_response',
        default: 'handle_auto_cart_response',
      },
    },

    handle_auto_cart_response: {
      type: 'action',
      description: 'Use NLU to classify user response to auto-cart',
      actions: [
        {
          id: 'classify_auto_cart_response',
          executor: 'nlu_condition',
          config: {
            intents: ['confirm_checkout', 'confirm_action', 'checkout'],
            minConfidence: 0.5,
          },
          output: 'checkout_check',
        },
      ],
      transitions: {
        matched: 'check_auth_for_checkout',
        not_matched: 'check_cart_modify_intent',
        default: 'check_auth_for_checkout',
      },
    },

    check_cart_modify_intent: {
      type: 'action',
      description: 'Check if user wants to modify cart via NLU',
      actions: [
        {
          id: 'classify_cart_modify',
          executor: 'nlu_condition',
          config: {
            intents: ['modify_cart', 'remove_item', 'view_cart'],
            minConfidence: 0.5,
          },
          output: 'cart_modify_check',
        },
      ],
      transitions: {
        matched: 'show_current_cart',
        not_matched: 'check_auth_for_checkout',
        default: 'check_auth_for_checkout',
      },
    },

    prompt_addon_selection: {
      type: 'wait',
      description: 'Show add-ons for selected item',
      onEntry: [
        {
          id: 'show_addons',
          executor: 'response',
          config: {
            message: '🍟 **Add-ons available:**\n\n{{#each selection_result.addonOptions}}• {{this.name}} — ₹{{this.price}}\n{{/each}}\n\nType add-on names/numbers to select, or skip:',
            buttons: [
              { id: 'btn_skip_addon', label: 'No add-ons', value: 'skip_addon' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_addon: 'add_to_cart',
        user_message: 'save_addon_selection',
        default: 'add_to_cart',
      },
    },

    save_addon_selection: {
      type: 'action',
      description: 'Parse add-on selection and build add_on_ids/add_on_qtys for cart',
      actions: [
        {
          id: 'save_addons',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              _pending_addon_selection: '{{_user_message}}',
            },
          },
          output: '_addon_saved',
        },
      ],
      transitions: {
        default: 'add_to_cart',
      },
    },

    prompt_variation_selection: {
      type: 'wait',
      description: 'Show item size/weight variations for user to choose',
      onEntry: [
        {
          id: 'show_variations',
          executor: 'response',
          config: {
            message: '{{selection_result.followUpResponse}}',
            quickReplies: '{{#each selection_result.variationOptions}}{"label": "{{this.label}}", "value": "variation:{{this.label}}:{{this.optionPrice}}"}{{#unless @last}},{{/unless}}{{/each}}',
          },
          output: '_last_response',
        },
        {
          id: 'save_variation_context',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              _pending_variation_item: '{{selection_result.variationItem}}',
              _pending_variation_options: '{{selection_result.variationOptions}}',
            },
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'process_variation_selection',
        default: 'process_selection',
      },
    },

    process_variation_selection: {
      type: 'action',
      description: 'Parse selected variation, build PHP format, update pending item price',
      actions: [
        {
          id: 'apply_variation',
          executor: 'response',
          config: {
            skipResponse: true,
            // The variation quick-reply value is encoded as "variation:<label>:<optionPrice>"
            // We parse it here by saving the raw message for the selection executor to handle.
            // The selection executor reads _pending_variation_item and _pending_variation_options
            // together with _user_message to match and build the PHP variation array.
            saveToContext: {
              _variation_raw_selection: '{{_user_message}}',
            },
          },
          output: '_variation_saved',
        },
      ],
      transitions: {
        default: 'process_selection',
      },
    },

    check_cart_action: {
      type: 'action',
      description: 'Use NLU to determine next step',
      actions: [
        {
          id: 'classify_cart_next',
          executor: 'nlu_condition',
          config: {
            intents: ['confirm_checkout', 'confirm_action'],
            minConfidence: 0.5,
          },
          output: 'cart_next_check',
        },
      ],
      transitions: {
        matched: 'upsell_offer',
        not_matched: 'check_cart_add_more',
        default: 'confirm_selection',
      },
    },

    handle_cart_action: {
      type: 'action',
      description: 'Use NLU to classify cart action intent',
      actions: [
        {
          id: 'classify_cart_action',
          executor: 'nlu_condition',
          config: {
            intents: ['confirm_checkout', 'confirm_action', 'checkout'],
            minConfidence: 0.5,
          },
          output: 'cart_action_check',
        },
      ],
      transitions: {
        matched: 'check_auth_for_checkout',
        not_matched: 'check_add_more_intent',
        default: 'process_selection',
      },
    },

    check_cart_add_more: {
      type: 'action',
      description: 'Check if user wants to add more',
      actions: [
        {
          id: 'classify_add',
          executor: 'nlu_condition',
          config: {
            intents: ['add_more_items', 'browse_menu', 'search_product'],
            minConfidence: 0.5,
          },
          output: 'cart_add_check',
        },
      ],
      transitions: {
        matched: 'search_food',
        not_matched: 'check_cart_cancel',
        default: 'confirm_selection',
      },
    },

    add_to_cart: {
      type: 'action', // Changed to action - routes based on cart_manager result
      description: 'Add selected items to cart',
      onEntry: [],
      actions: [
        {
          id: 'manage_cart',
          executor: 'cart_manager',
          config: {
            operation: 'add',
            newItemsPath: 'selection_result.selectedItems',
          },
          output: 'cart_update_result',
        },
      ],
      transitions: {
        items_added: 'cart_add_success', // Successful add
        store_conflict: 'handle_store_conflict', // Different store conflict
        no_items: 'clarify_selection', // No items to add - ask for clarification
        default: 'cart_add_success', // Fallback
      },
    },

    cart_add_success: {
      type: 'wait', // Wait for user input after showing cart confirmation
      description: 'Show cart confirmation and wait for next action',
      onEntry: [
        {
          id: 'confirm_cart',
          executor: 'response',
          config: {
            message: `✅ Added to cart!\n\n🛒 {{cart_update_result.cartSummary}}\n\nAdd more of the same, add a different item, or checkout.`,
            responseType: 'cart_update',
            // Build cart cards from cart items for web display (use cart_items which is in card format)
            cardsPath: 'cart_update_result.cart_items',
            buttons: [
              { id: 'btn_checkout', label: 'Checkout', value: 'checkout' },
              { id: 'btn_repeat', label: '+1 Same Item', value: 'repeat_last_item' },
              { id: 'btn_add_more', label: 'Add Different', value: 'add more food' },
            ],
            // Save the cart state (cart_data is raw format for cart operations)
            saveToContext: {
              cart_items: '{{cart_update_result.cart_data}}',
              cart_display: '{{cart_update_result.cart_items}}',
              selected_items: '{{cart_update_result.cart_data}}',
              cart_total: '{{cart_update_result.totalPrice}}',
              cart_store_id: '{{cart_update_result.storeId}}',
              cart_store_name: '{{cart_update_result.storeName}}',
            },
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        repeat_last_item: 'add_to_cart',       // 🆕 Re-add same item — selection_result still in context
        user_message: 'handle_post_cart_input',
        default: 'handle_post_cart_input',
      },
    },

    check_remove_item_intent: {
      type: 'action',
      description: 'Check if user wants to remove a specific item from cart',
      actions: [
        {
          id: 'classify_remove_item',
          executor: 'nlu_condition',
          config: {
            intents: ['remove_item'],
            minConfidence: 0.5,
          },
          output: 'remove_item_check',
        },
      ],
      transitions: {
        matched: 'find_item_to_remove',
        not_matched: 'check_clear_cart_intent',
        default: 'process_selection',
      },
    },

    find_item_to_remove: {
      type: 'action',
      description: 'Extract item name from user message and remove from cart',
      actions: [
        {
          id: 'remove_item_action',
          executor: 'cart_manager',
          config: {
            operation: 'remove',
            // No itemId or itemIndex - cart_manager will extract from user message
          },
          output: 'remove_result',
        },
      ],
      transitions: {
        item_removed: 'show_remove_success',
        cart_empty: 'show_cart_empty_after_remove',
        item_not_found: 'remove_item_not_found',
        error: 'remove_item_not_found',
        default: 'remove_item_not_found',
      },
    },

    show_remove_success: {
      type: 'wait',
      description: 'Show removal success and wait for next action',
      onEntry: [
        {
          id: 'remove_success_response',
          executor: 'response',
          config: {
            message: '✅ {{remove_result.message}}\n\n🛒 Your cart now has {{remove_result.cart_items.length}} item(s) - ₹{{remove_result.totalPrice}}\n\nWhat would you like to do next?',
            buttons: [
              { id: 'btn_checkout', label: 'Checkout', value: 'checkout' },
              { id: 'btn_add', label: 'Add More', value: 'add_more' },
              { id: 'btn_cart', label: 'View Cart', value: 'view_cart' }
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_cart_action',
        checkout: 'check_auth_for_checkout',
        add_more: 'show_results',
        view_cart: 'show_current_cart',
        default: 'handle_cart_action',
      },
    },

    check_clear_cart_intent: {
      type: 'action',
      description: 'Check if user wants to clear entire cart',
      actions: [
        {
          id: 'classify_clear_cart',
          executor: 'nlu_condition',
          config: {
            intents: ['clear_cart'],
            minConfidence: 0.5,
          },
          output: 'clear_cart_check',
        },
      ],
      transitions: {
        matched: 'clear_cart_state',
        not_matched: 'process_selection',
        default: 'process_selection',
      },
    },

    clear_cart_and_add_new: {
      type: 'action',
      description: 'Clear cart and add items from new restaurant',
      onEntry: [],
      actions: [
        {
          id: 'clear_old_cart',
          executor: 'cart_manager',
          config: {
            operation: 'clear',
          },
          output: 'clear_result',
        },
        {
          id: 'add_new_items',
          executor: 'cart_manager',
          config: {
            operation: 'add',
            // Use the conflicting items saved from the store conflict
            // These were saved in cart_update_result.conflictingItems when store_conflict was triggered
            newItemsPath: 'cart_update_result.conflictingItems',
          },
          output: 'cart_update_result',
        },
      ],
      transitions: {
        items_added: 'cart_add_success',
        default: 'cart_add_success',
      },
    },

    clear_cart_state: {
      type: 'action',
      description: 'Clear the cart and start fresh',
      actions: [
        {
          id: 'clear_cart_action',
          executor: 'response',
          config: {
            message: '🗑️ Cart cleared! What would you like to order?',
            saveToContext: {
              cart_items: [],
              selected_items: [],
              auto_selected_items: [],
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'search_food',
      },
    },

    show_current_cart: {
      type: 'action',
      description: 'Show what is currently in the cart',
      actions: [
        {
          id: 'build_cart_display',
          executor: 'cart_manager',
          config: {
            operation: 'validate',
          },
          output: 'cart_validation',
        },
        {
          id: 'display_cart',
          executor: 'response',
          config: {
            message: '{{#if cart_validation.cart_items.length}}🛒 **Your Cart:**\n\n**Total: ₹{{cart_validation.totalPrice}}** ({{cart_validation.totalItems}} items)\n\nWhat would you like to do?{{else}}🛒 Your cart is empty!\n\nBrowse items above and add what you like.{{/if}}',
            cardsPath: 'cart_display',
            buttons: [
              { id: 'btn_add_more', label: 'Add More Items', value: 'add_more' },
              { id: 'btn_checkout', label: 'Checkout', value: 'checkout' },
              { id: 'btn_clear', label: 'Clear Cart', value: 'clear_cart' }
            ],
            saveToContext: {
              cart_display: '{{cart_validation.cart_items}}',
            },
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'wait_for_cart_action',
      },
    },

    wait_cart_review: {
      type: 'wait',
      description: 'Wait for user to confirm, modify, or cancel after seeing cart review',
      onEntry: [],
      actions: [],
      transitions: {
        user_message: 'suggest_upsells',   // Any free text → try upsells before address
        proceed:      'suggest_upsells',
        modify_cart:  'show_current_cart',
        cancel:       'cancelled',
        default:      'suggest_upsells',
      },
    },

    check_post_cart_search: {
      type: 'action',
      description: 'Check if user wants to search/add more',
      actions: [
        {
          id: 'classify_search',
          executor: 'nlu_condition',
          config: {
            intents: ['add_more_items', 'browse_menu', 'search_product'],
            minConfidence: 0.5,
          },
          output: 'post_cart_search_check',
        },
      ],
      transitions: {
        matched: 'search_food',
        not_matched: 'check_post_cart_view',
        default: 'process_selection',
      },
    },

    show_cart_empty_after_remove: {
      type: 'wait',
      description: 'Cart is empty after removal',
      onEntry: [
        {
          id: 'cart_empty_response',
          executor: 'response',
          config: {
            message: '✅ {{remove_result.message}}\n\n🛒 Your cart is now empty.\n\nWhat would you like to order?',
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'search_food',
        default: 'search_food',
      },
    },

    order_cancelled: {
      type: 'action',
      description: 'Confirm order cancellation',
      actions: [
        {
          id: 'cancel_msg',
          executor: 'response',
          config: {
            message: '❌ Order cancelled. No worries!\n\nAnything else I can help you with?',
            buttons: [
              { id: 'btn_browse', label: 'Browse Food', value: 'show me food' },
              { id: 'btn_home', label: 'Home', value: 'go home' },
            ],
          },
        }
      ],
      transitions: {
        user_message: 'understand_request',
      }
    },

    wait_for_cart_action: {
      type: 'wait',
      description: 'Wait for user to choose add more, checkout, or clear',
      onEntry: [],
      actions: [],
      transitions: {
        user_message: 'check_cart_input_type',  // 🔧 FIX: detect item_ID before NLU cascade
        checkout: 'check_auth_for_checkout',
        add_more: 'show_results',
        clear_cart: 'clear_cart_state',
        default: 'check_cart_input_type',
      },
    },

    check_cart_input_type: {
      type: 'decision',
      description: 'Route item_ID button clicks to process_selection; everything else to cart action handler',
      conditions: [
        {
          expression: `/^item_\\d+/i.test(context._user_message?.trim())`,
          event: 'item_selected',
        },
      ],
      transitions: {
        item_selected: 'process_selection',
        default: 'handle_cart_action',
      },
    },

    check_add_more_intent: {
      type: 'action',
      description: 'Check if user wants to add more items',
      actions: [
        {
          id: 'classify_add_more',
          executor: 'nlu_condition',
          config: {
            intents: ['add_more_items', 'browse_menu', 'search_product'],
            minConfidence: 0.5,
          },
          output: 'add_more_check',
        },
      ],
      transitions: {
        matched: 'show_results',
        not_matched: 'check_remove_item_intent',
        default: 'process_selection',
      },
    },

    remove_item_not_found: {
      type: 'wait',
      description: 'Tell user the item was not found in cart',
      actions: [
        {
          id: 'not_found_response',
          executor: 'response',
          config: {
            message: '❌ Sorry, I couldn\'t find that item in your cart. Here\'s your current cart:',
          },
          output: '_last_response',
        },
      ],
      transitions: {
        default: 'show_current_cart',
      },
    },

    search_requested_items: {
      type: 'action',
      description: 'Search for specific items user requested that were not in current results',
      actions: [
        {
          id: 'search_items',
          executor: 'search',
          config: {
            query: '{{selection_result.searchSuggestion}}',
            type: 'food',
            limit: 10,
          },
          output: 'search_results',
        },
      ],
      transitions: {
        items_found: 'show_results',
        no_items: 'no_results',
        error: 'show_results',
      },
    },

    handle_store_conflict: {
      type: 'wait',
      description: 'Ask user whether to clear cart and switch to new restaurant',
      onEntry: [
        {
          id: 'show_conflict',
          executor: 'response',
          config: {
            message: `⚠️ {{cart_update_result.message}}\n\nYou have items from **{{cart_update_result.currentStoreName}}** in your cart.`,
            responseType: 'store_conflict',
            buttons: [
              { id: 'btn_clear_and_add', label: 'Clear & Add New', value: 'clear and add new' },
              { id: 'btn_keep_cart', label: 'Keep My Cart', value: 'keep cart' },
              { id: 'btn_view_cart', label: 'View Cart', value: 'view cart' },
            ],
            // Save conflict info for later use
            saveToContext: {
              cart_conflict_new_store: '{{cart_update_result.newStoreName}}',
              cart_conflict_items: '{{cart_update_result.conflictingItems}}',
            },
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        user_message: 'resolve_store_conflict',
        default: 'resolve_store_conflict',
      },
    },

    resolve_store_conflict: {
      type: 'decision',
      description: 'Route user choice for store conflict',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().includes("clear") || context._user_message?.toLowerCase().includes("switch") || context._user_message?.toLowerCase().includes("new")',
          event: 'clear_and_add',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("keep") || context._user_message?.toLowerCase().includes("no")',
          event: 'keep_cart',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("view") || context._user_message?.toLowerCase().includes("cart")',
          event: 'view_cart',
        },
      ],
      transitions: {
        clear_and_add: 'clear_cart_and_add_new',
        keep_cart: 'show_current_cart',
        view_cart: 'show_current_cart',
        default: 'handle_store_conflict', // Re-ask if unclear
      },
    },

    handle_post_cart_input: {
      type: 'action',
      description: 'Use NLU to classify post-cart action intent',
      actions: [
        {
          id: 'classify_post_cart',
          executor: 'nlu_condition',
          config: {
            intents: ['confirm_checkout', 'confirm_action', 'checkout'],
            minConfidence: 0.5,
          },
          output: 'post_cart_checkout_check',
        },
      ],
      transitions: {
        matched: 'check_auth_for_checkout',
        not_matched: 'check_post_cart_clear',
        default: 'process_selection',
      },
    },

    check_post_cart_view: {
      type: 'action',
      description: 'Check if user wants to view cart',
      actions: [
        {
          id: 'classify_view_cart',
          executor: 'nlu_condition',
          config: {
            intents: ['view_cart'],
            minConfidence: 0.5,
          },
          output: 'post_cart_view_check',
        },
      ],
      transitions: {
        matched: 'show_current_cart',
        not_matched: 'process_selection',
        default: 'process_selection',
      },
    },

    check_cart_cancel: {
      type: 'action',
      description: 'Check if user wants to cancel',
      actions: [
        {
          id: 'classify_cancel',
          executor: 'nlu_condition',
          config: {
            intents: ['cancel_flow', 'cancel_order'],
            minConfidence: 0.5,
          },
          output: 'cart_cancel_check',
        },
      ],
      transitions: {
        matched: 'cancelled',
        not_matched: 'confirm_selection',
        default: 'confirm_selection',
      },
    },

    check_post_cart_clear: {
      type: 'action',
      description: 'Check if user wants to clear cart',
      actions: [
        {
          id: 'classify_clear',
          executor: 'nlu_condition',
          config: {
            intents: ['clear_cart'],
            minConfidence: 0.5,
          },
          output: 'post_cart_clear_check',
        },
      ],
      transitions: {
        matched: 'clear_cart_state',
        not_matched: 'check_post_cart_search',
        default: 'process_selection',
      },
    },

    prepare_restaurant_search_from_results: {
      type: 'action',
      description: 'Save restaurant name from NLU and redirect to restaurant food search',
      actions: [
        {
          id: 'save_restaurant_name',
          executor: 'response',
          config: {
            skipResponse: true,
            saveToContext: {
              'extracted_food.restaurant': '{{food_nlu.entities.store_reference}}',
              'extracted_food.search_query': '{{_user_message}}',
            },
            event: 'ready',
          },
        },
      ],
      transitions: {
        ready: 'search_food_with_restaurant',
        default: 'search_food_with_restaurant',
      },
    },

    show_distance_info: {
      type: 'wait',
      description: 'Show distance information for stores in search results',
      onEntry: [
        {
          id: 'display_distance',
          executor: 'response',
          config: {
            message: '{{selection_result.followUpResponse}}',
            buttons: [
              { id: 'btn_nearest', label: 'Order from Nearest', value: 'nearest store' },
              { id: 'btn_back', label: 'Back to Results', value: 'show results' },
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

    suggest_upsells: {
      type: 'action',
      description: 'Fetch frequently-bought-together items for upsell before checkout',
      actions: [
        {
          id: 'track_cart_for_recs',
          executor: 'recommendation',
          config: { action: 'track_add_to_cart', moduleId: MODULE_ID.FOOD },
          output: '_rec_tracking',
        },
        {
          id: 'fetch_upsells',
          executor: 'recommendation',
          config: { action: 'get_upsells', limit: SEARCH.UPSELL_LIMIT, moduleId: MODULE_ID.FOOD },
          output: 'upsell_results',
        },
      ],
      conditions: [
        {
          expression: 'context.upsell_results && context.upsell_results.count > 0',
          event: 'items_found',
        },
      ],
      transitions: {
        items_found: 'show_upsell_offer',
        no_items:    'collect_address',   // No upsells → proceed directly
        error:       'collect_address',
        default:     'collect_address',
      },
    },

    show_upsell_offer: {
      type: 'wait',
      description: 'Show upsell suggestions — user can add or skip',
      onEntry: [
        {
          id: 'display_upsells',
          executor: 'response',
          config: {
            message: '✨ **You might also like:**\nOther customers often add these with their order! 👇',
            cardsPath: 'upsell_results.cards',
            buttons: [
              { id: 'btn_skip_upsell', label: 'No thanks, checkout', value: 'skip_upsell' },
            ],
          },
          output: '_last_response',
        },
      ],
      actions: [],
      transitions: {
        skip_upsell:  'collect_address',
        user_message: 'collect_address',  // Any text → proceed
        default:      'collect_address',
      },
    },

    upsell_offer: {
      type: 'action',
      description: 'Suggest add-ons',
      actions: [
        {
          id: 'suggest_addon',
          executor: 'llm',
          config: {
            systemPrompt: 'You are a helpful waiter. Suggest a drink or dessert to go with the order. Be brief.',
            prompt: 'User ordered {{selected_items.length}} items. Suggest a Coke, Lassi, or Gulab Jamun. Ask "Would you like to add a dessert or drink?"',
            temperature: 0.6,
            maxTokens: 80,
          },
          output: '_last_response',
        },
      ],
      transitions: {
        user_message: 'handle_upsell',
      },
    },

    handle_upsell: {
      type: 'decision',
      description: 'Check if user accepted upsell',
      conditions: [
        {
          expression: 'context._user_message?.toLowerCase().includes("no") || context._user_message?.toLowerCase().includes("skip")',
          event: 'declined',
        },
        {
          expression: 'context._user_message?.toLowerCase().includes("yes") || context._user_message?.toLowerCase().includes("add")',
          event: 'accepted',
        }
      ],
      transitions: {
        declined: 'collect_address',
        accepted: 'add_upsell_item', // Simplified: In real app, would search/add specific item
        default: 'collect_address',
      },
    },

    add_upsell_item: {
      type: 'action',
      description: 'Acknowledge upsell and continue to address',
      actions: [
        {
          id: 'ack_upsell',
          executor: 'response',
          config: {
            message: '✅ Great choice! We\'ll add that to your order. Now let\'s get your delivery address.',
          },
        }
      ],
      transitions: {
        success: 'collect_address',
      },
    },

};
