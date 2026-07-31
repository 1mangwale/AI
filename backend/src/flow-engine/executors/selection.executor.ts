import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

interface CardItem {
  id: number | string;
  name: string;
  price: string | number;
  rawPrice?: number;  // Numeric price for order
  storeId?: number;
  moduleId?: number;  // Module ID for PHP API
  storeName?: string;
  storeLat?: number;
  storeLng?: number;
  [key: string]: any;
}

interface SelectionResult {
  selectedItems: Array<{
    itemIndex: number;
    itemId: number | string;
    itemName: string;
    quantity: number;
    price: number;
    rawPrice?: number;
    storeId?: number;
    moduleId?: number;
    storeName?: string;
    storeLat?: number;
    storeLng?: number;
    variation?: Array<{ type: string; price: string }>;
    variationLabel?: string;
  }>;
  action: 'add_to_cart' | 'needs_variation' | 'search_more' | 'checkout' | 'cancel' | 'search_items' | 'view_cart' | 'ask_distance' | 'unknown';
  totalPrice: number;
  searchSuggestion?: string; // Items that weren't found - used to trigger re-search
  followUpResponse?: string; // Response for follow-up questions about results
}

/**
 * Selection Executor
 * 
 * Parses user selection from search results.
 * Handles formats:
 * - "Add X to cart" (from button click)
 * - "1" or "1,2,3" (item numbers)
 * - "1x2" (item 1, quantity 2)
 * - "first one" / "second item"
 * - "checkout" / "proceed"
 * - "cancel" / "no"
 */
@Injectable()
export class SelectionExecutor implements ActionExecutor {
  readonly name = 'selection';
  private readonly logger = new Logger(SelectionExecutor.name);

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const userMessage = (context.data._user_message || context.data.user_message) as string;
      // Check search_results first, fallback to recommendation_results or fast_delivery_results
      const searchResults = (context.data.search_results || context.data.recommendation_results || context.data.fast_delivery_results) as { cards?: CardItem[]; items?: CardItem[] };
      
      if (!userMessage) {
        return {
          success: false,
          error: 'No user message to parse',
          event: 'error',
        };
      }

      // ✅ Check if EntityResolutionService found new stores/items (architecturally correct)
      // If resolved_entities exists, it means the flow already determined this is a new search
      // EXCEPT when _selection_mode is set - that means flow explicitly detected a selection pattern
      if (context.data.resolved_entities && !context.data._selection_mode) {
        const hasNewStore = context.data.resolved_entities.stores?.length > 0;
        const hasNewItems = context.data.resolved_entities.items?.length > 0;
        
        if (hasNewStore || hasNewItems) {
          this.logger.log(
            `⚠️ EntityResolutionService detected new entities (stores: ${hasNewStore}, items: ${hasNewItems}). ` +
            `This should have been routed to search via check_resolution_result state. ` +
            `Returning search_items event as safeguard.`
          );
          return {
            success: true,
            event: 'search_items',
            data: {
              message: "Let me search for that!",
              resolved_entities: context.data.resolved_entities,
            },
          };
        }
      }
      
      // Log if we're in selection mode
      if (context.data._selection_mode) {
        this.logger.log(`✅ Selection mode active - processing user selection`);
      }

      const cards = searchResults?.cards || searchResults?.items || [];
      this.logger.debug(`Parsing selection from: "${userMessage}" with ${cards.length} items available`);

      const result = this.parseSelection(userMessage, cards);
      
      this.logger.log(`Selection result: action=${result.action}, items=${result.selectedItems.length}`);

      // Determine next event based on action
      let event = 'unknown';
      if (result.action === 'add_to_cart' && result.selectedItems.length > 0) {
        event = 'item_selected';
      } else if (result.action === 'checkout') {
        event = 'checkout';
      } else if (result.action === 'cancel') {
        event = 'cancel';
      } else if (result.action === 'search_more') {
        event = 'search_more';
      } else if (result.action === 'search_items') {
        // User requested specific items not in current results - trigger search for those
        event = 'search_items';
      } else if (result.action === 'view_cart') {
        event = 'view_cart';
      } else if (result.action === 'ask_distance') {
        // User asked about distance/location of displayed stores
        event = 'ask_distance';
      } else if (result.action === 'needs_variation') {
        // Item has variations (sizes/weights) - prompt user to choose
        event = 'needs_variation';
      } else {
        event = 'unclear';
      }

      return {
        success: true,
        output: result,
        event,
      };
    } catch (error) {
      this.logger.error(`Selection parsing failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  private parseSelection(message: string, cards: CardItem[]): SelectionResult {
    const lowerMessage = message.toLowerCase().trim();
    const result: SelectionResult = {
      selectedItems: [],
      action: 'unknown',
      totalPrice: 0,
    };

    // Check for "item_XXXX" format (direct item ID from card button clicks)
    // Supports: "item_12345", "item_12345 x2", "item_12345 [500g]"
    const itemIdMatch = lowerMessage.match(/^item_(\d+)(?:\s+x(\d+))?(?:\s+\[([^\]]+)\])?$/i);
    if (itemIdMatch) {
      const itemId = itemIdMatch[1];
      const quantity = itemIdMatch[2] ? parseInt(itemIdMatch[2]) : 1;
      const variationLabel = itemIdMatch[3] || null;
      const matchedItem = this.findItemById(itemId, cards);
      if (matchedItem) {
        this.logger.log(`✅ Direct item ID match: item_${itemId} → "${matchedItem.itemName}"`);
        matchedItem.quantity = quantity;
        const card = cards[matchedItem.itemIndex];
        // food_variations may arrive as a JSON string from search results (same guard as search.executor)
        const rawFoodVariations = card.food_variations || [];
        const foodVariations = typeof rawFoodVariations === 'string' ? (() => { try { return JSON.parse(rawFoodVariations); } catch { return []; } })() : rawFoodVariations;
        const hasVariations = Array.isArray(foodVariations) && foodVariations.length > 0 && foodVariations.some((g: any) => g.values?.length > 0);

        if (variationLabel) {
          for (const group of foodVariations) {
            const matchedValue = (group.values || []).find(
              (v: any) => v.label?.toLowerCase() === variationLabel.toLowerCase()
            );
            if (matchedValue) {
              matchedItem.variation = [{ type: group.name, price: matchedValue.optionPrice || '0' }];
              matchedItem.variationLabel = variationLabel;
              const variationPrice = parseFloat(matchedValue.optionPrice || '0');
              if (variationPrice) {
                matchedItem.price = matchedItem.price + variationPrice;
                if (matchedItem.rawPrice) matchedItem.rawPrice = matchedItem.rawPrice + variationPrice;
              }
              break;
            }
          }
        } else if (hasVariations) {
          const allVariationOptions: Array<{ label: string; price: string; group: string }> = [];
          for (const group of foodVariations) {
            for (const val of (group.values || [])) {
              if (val.label) {
                allVariationOptions.push({ label: val.label, price: val.optionPrice || '0', group: group.name || group.type || 'Size' });
              }
            }
          }
          if (allVariationOptions.length > 0) {
            this.logger.log(`📦 Item "${matchedItem.itemName}" has ${allVariationOptions.length} variations — asking user to choose`);
            result.action = 'needs_variation';
            (result as any).variationItem = matchedItem;
            (result as any).variationOptions = allVariationOptions;
            (result as any).followUpResponse = `📦 **${matchedItem.itemName}** comes in different sizes:\n\n${
              allVariationOptions.map((v, i) => `${i + 1}. **${v.label}** ${parseFloat(v.price) > 0 ? `(+₹${v.price})` : '(included)'}`).join('\n')
            }\n\nWhich size would you like?`;
            return result;
          }
        }

        result.selectedItems.push(matchedItem);
        result.action = 'add_to_cart';
        result.totalPrice = matchedItem.price * matchedItem.quantity;
        return result;
      }
      this.logger.warn(`⚠️ item_${itemId} not found in ${cards.length} search result cards`);
    }

    // Check for "Add X to cart" format (legacy text-based, from WhatsApp or typed input)
    // Supports: "Add Paneer Tikka to cart", "Add Paneer Tikka to cart x2",
    //           "Add Paneer Tikka to cart [500g]", "Add Paneer Tikka to cart x2 [500g]"
    const addToCartMatch = lowerMessage.match(/^add\s+(.+)\s+to\s+cart(?:\s+x(\d+))?(?:\s+\[([^\]]+)\])?$/i);
    if (addToCartMatch) {
      const itemName = addToCartMatch[1].toLowerCase();
      const quantity = addToCartMatch[2] ? parseInt(addToCartMatch[2]) : 1;
      const variationLabel = addToCartMatch[3] || null;
      const matchedItem = this.findItemByName(itemName, cards);
      if (matchedItem) {
        matchedItem.quantity = quantity;
        const card = cards[matchedItem.itemIndex];
        // food_variations may arrive as a JSON string from search results (same guard as search.executor)
        const rawFoodVariations = card.food_variations || [];
        const foodVariations = typeof rawFoodVariations === 'string' ? (() => { try { return JSON.parse(rawFoodVariations); } catch { return []; } })() : rawFoodVariations;
        const hasVariations = Array.isArray(foodVariations) && foodVariations.length > 0 && foodVariations.some((g: any) => g.values?.length > 0);
        
        // If variation label provided, find matching variation from card data
        if (variationLabel) {
          for (const group of foodVariations) {
            const matchedValue = (group.values || []).find(
              (v: any) => v.label?.toLowerCase() === variationLabel.toLowerCase()
            );
            if (matchedValue) {
              matchedItem.variation = [{ type: group.name, price: matchedValue.optionPrice || '0' }];
              matchedItem.variationLabel = variationLabel;
              // Adjust price with variation
              const variationPrice = parseFloat(matchedValue.optionPrice || '0');
              if (variationPrice) {
                matchedItem.price = matchedItem.price + variationPrice;
                if (matchedItem.rawPrice) matchedItem.rawPrice = matchedItem.rawPrice + variationPrice;
              }
              break;
            }
          }
          // If no matching variation found in card data, still pass the label
          if (!matchedItem.variation) {
            matchedItem.variationLabel = variationLabel;
            this.logger.warn(`Variation label "${variationLabel}" not found in card data for ${itemName}`);
          }
        } else if (hasVariations) {
          // 📦 VARIATION PROMPT: Item has variations but user didn't specify one
          // Build variation options for user to choose from
          const allVariationOptions: Array<{ label: string; price: string; group: string }> = [];
          for (const group of foodVariations) {
            for (const val of (group.values || [])) {
              if (val.label) {
                allVariationOptions.push({
                  label: val.label,
                  price: val.optionPrice || '0',
                  group: group.name || group.type || 'Size',
                });
              }
            }
          }
          
          if (allVariationOptions.length > 0) {
            this.logger.log(`📦 Item "${matchedItem.itemName}" has ${allVariationOptions.length} variations — asking user to choose`);
            result.action = 'needs_variation';
            (result as any).variationItem = matchedItem;
            (result as any).variationOptions = allVariationOptions;
            (result as any).followUpResponse = `📦 **${matchedItem.itemName}** comes in different sizes:\n\n${
              allVariationOptions.map((v, i) => `${i + 1}. **${v.label}** ${parseFloat(v.price) > 0 ? `(+₹${v.price})` : '(included)'}`).join('\n')
            }\n\nWhich size would you like?`;
            return result;
          }
        }
        
        result.selectedItems.push(matchedItem);
        result.action = 'add_to_cart';
        result.totalPrice = matchedItem.price * matchedItem.quantity;
        return result;
      }
    }

    // Check for checkout intents
    if (this.isCheckoutIntent(lowerMessage)) {
      result.action = 'checkout';
      return result;
    }

    // Check for cancel intents
    if (this.isCancelIntent(lowerMessage)) {
      result.action = 'cancel';
      return result;
    }

    // Check for "show cart" / "view cart" intents
    if (this.isViewCartIntent(lowerMessage)) {
      result.action = 'view_cart';
      return result;
    }

    // 🆕 Check for distance/location follow-up questions about displayed results
    if (this.isDistanceQuestion(lowerMessage)) {
      result.action = 'ask_distance';
      result.followUpResponse = this.generateDistanceResponse(cards);
      this.logger.log(`Distance question detected - generating store distance info`);
      return result;
    }

    // Check for "search more" / "show more" intents
    if (this.isSearchMoreIntent(lowerMessage)) {
      result.action = 'search_more';
      return result;
    }

    // Check for restaurant/menu search intents (e.g., "inayat ka menu", "show dominos menu")
    const restaurantSearchResult = this.parseRestaurantSearchIntent(lowerMessage);
    if (restaurantSearchResult) {
      result.action = 'search_items';
      result.searchSuggestion = restaurantSearchResult;
      this.logger.log(`Restaurant menu search detected: ${restaurantSearchResult}`);
      return result;
    }

    // *** NEW: Parse multi-item natural language orders ***
    // "2 butter naan, one paneer tikka, one tandoori chicken"
    const multiItemResult = this.parseMultiItemNaturalLanguage(message, cards);
    if (multiItemResult.found.length > 0) {
      result.selectedItems = multiItemResult.found;
      result.action = 'add_to_cart';
      result.totalPrice = multiItemResult.found.reduce((sum, item) => sum + item.price * item.quantity, 0);
      
      // If some items weren't found, store them for potential re-search
      if (multiItemResult.notFound.length > 0) {
        result.searchSuggestion = multiItemResult.notFound.join(', ');
        this.logger.log(`Some requested items not found in current results: ${result.searchSuggestion}`);
      }
      return result;
    } else if (multiItemResult.notFound.length > 0) {
      // User requested specific items but NONE were found - trigger re-search
      result.action = 'search_items';
      result.searchSuggestion = multiItemResult.notFound.join(', ');
      this.logger.log(`Requested items not in results, suggest search: ${result.searchSuggestion}`);
      return result;
    }

    // Parse number-based selections: "1", "1,2,3", "1x2", "2 of first"
    const numberSelections = this.parseNumberSelections(lowerMessage, cards);
    if (numberSelections.length > 0) {
      result.selectedItems = numberSelections;
      result.action = 'add_to_cart';
      result.totalPrice = numberSelections.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return result;
    }

    // Parse ordinal selections: "first", "second", "last"
    const ordinalSelection = this.parseOrdinalSelection(lowerMessage, cards);
    if (ordinalSelection) {
      result.selectedItems.push(ordinalSelection);
      result.action = 'add_to_cart';
      result.totalPrice = ordinalSelection.price;
      return result;
    }

    // Try fuzzy name match as last resort
    const fuzzyMatch = this.fuzzyMatchItem(lowerMessage, cards);
    if (fuzzyMatch) {
      result.selectedItems.push(fuzzyMatch);
      result.action = 'add_to_cart';
      result.totalPrice = fuzzyMatch.price;
      return result;
    }

    return result;
  }

  private findItemById(id: string, cards: CardItem[]): SelectionResult['selectedItems'][0] | null {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (String(card.id) === id) {
        return {
          itemIndex: i,
          itemId: card.id,
          itemName: card.name,
          quantity: 1,
          price: this.parsePrice(card.price),
          rawPrice: card.rawPrice,
          storeId: card.storeId,
          moduleId: card.moduleId,
          storeName: card.storeName,
          storeLat: card.storeLat,
          storeLng: card.storeLng,
        };
      }
    }
    return null;
  }

  private findItemByName(name: string, cards: CardItem[]): SelectionResult['selectedItems'][0] | null {
    const lowerName = name.toLowerCase().trim();

    // Priority 1: Exact match
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardName = (card.name || '').toLowerCase().trim();
      if (cardName === lowerName) {
        return this.buildItemResult(card, i);
      }
    }

    // Priority 2: Card name starts with search term (e.g., "chicken pizza" matches "Chicken Pizza [Medium]")
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardName = (card.name || '').toLowerCase().trim();
      if (cardName.startsWith(lowerName)) {
        return this.buildItemResult(card, i);
      }
    }

    // Priority 3: Search term contains full card name (e.g., "add chicken pizza special" contains "chicken pizza")
    // Sort by longest card name first to prefer more specific matches
    const candidates = cards
      .map((card, i) => ({ card, index: i, name: (card.name || '').toLowerCase().trim() }))
      .filter(c => lowerName.includes(c.name) && c.name.length > 0)
      .sort((a, b) => b.name.length - a.name.length);

    if (candidates.length > 0) {
      return this.buildItemResult(candidates[0].card, candidates[0].index);
    }

    // Priority 4: Card name contains search term (e.g., "Chicken Tikka Pizza" contains "chicken pizza" → no, use word overlap)
    // Word-level overlap: prefer card with most matching words
    const searchWords = lowerName.split(/\s+/).filter(w => w.length > 2);
    if (searchWords.length > 0) {
      let bestMatch: { card: CardItem; index: number; score: number } | null = null;
      for (let i = 0; i < cards.length; i++) {
        const cardName = (cards[i].name || '').toLowerCase().trim();
        const cardWords = cardName.split(/\s+/);
        const matchCount = searchWords.filter(sw => cardWords.some(cw => cw.includes(sw) || sw.includes(cw))).length;
        const score = matchCount / searchWords.length;
        if (score >= 0.5 && (!bestMatch || score > bestMatch.score || (score === bestMatch.score && cardName.length > bestMatch.card.name.length))) {
          bestMatch = { card: cards[i], index: i, score };
        }
      }
      if (bestMatch) {
        return this.buildItemResult(bestMatch.card, bestMatch.index);
      }
    }

    return null;
  }

  private buildItemResult(card: CardItem, index: number): SelectionResult['selectedItems'][0] {
    return {
      itemIndex: index,
      itemId: card.id,
      itemName: card.name,
      quantity: 1,
      price: this.parsePrice(card.price),
      rawPrice: card.rawPrice,
      storeId: card.storeId,
      moduleId: card.moduleId,
      storeName: card.storeName,
      storeLat: card.storeLat,
      storeLng: card.storeLng,
    };
  }

  private parseNumberSelections(message: string, cards: CardItem[]): SelectionResult['selectedItems'] {
    const selections: SelectionResult['selectedItems'] = [];
    
    // Match patterns: "1", "1,2,3", "1 2 3", "1x2", "1 x 2", "2 of 1"
    // Simple number: just "1" or "2"
    const simpleNumber = message.match(/^\d+$/);
    if (simpleNumber) {
      const index = parseInt(simpleNumber[0]) - 1; // Convert to 0-based
      if (index >= 0 && index < cards.length) {
        const card = cards[index];
        selections.push({
          itemIndex: index,
          itemId: card.id,
          itemName: card.name,
          quantity: 1,
          price: this.parsePrice(card.price),
          rawPrice: card.rawPrice,
          storeId: card.storeId,
          moduleId: card.moduleId,
          storeName: card.storeName,
          storeLat: card.storeLat,
          storeLng: card.storeLng,
        });
      }
      return selections;
    }

    // Multiple numbers: "1,2,3" or "1 2 3"
    const multipleNumbers = message.match(/(\d+)[,\s]+/g);
    if (multipleNumbers) {
      const numbers = message.match(/\d+/g);
      if (numbers) {
        for (const num of numbers) {
          const index = parseInt(num) - 1;
          if (index >= 0 && index < cards.length) {
            const card = cards[index];
            selections.push({
              itemIndex: index,
              itemId: card.id,
              itemName: card.name,
              quantity: 1,
              price: this.parsePrice(card.price),
              rawPrice: card.rawPrice,
              storeId: card.storeId,
              moduleId: card.moduleId,
              storeName: card.storeName,
              storeLat: card.storeLat,
              storeLng: card.storeLng,
            });
          }
        }
        return selections;
      }
    }

    // Quantity format: "1x2" or "1 x 2" (item 1, quantity 2)
    const quantityMatch = message.match(/(\d+)\s*[xX×]\s*(\d+)/);
    if (quantityMatch) {
      const index = parseInt(quantityMatch[1]) - 1;
      const quantity = parseInt(quantityMatch[2]);
      if (index >= 0 && index < cards.length && quantity > 0) {
        const card = cards[index];
        selections.push({
          itemIndex: index,
          itemId: card.id,
          itemName: card.name,
          quantity,
          price: this.parsePrice(card.price),
          rawPrice: card.rawPrice,
          storeId: card.storeId,
          moduleId: card.moduleId,
          storeName: card.storeName,
          storeLat: card.storeLat,
          storeLng: card.storeLng,
        });
      }
      return selections;
    }

    return selections;
  }

  private parseOrdinalSelection(message: string, cards: CardItem[]): SelectionResult['selectedItems'][0] | null {
    const ordinalMap: Record<string, number> = {
      'first': 0, 'second': 1, 'third': 2, 'fourth': 3, 'fifth': 4,
      'sixth': 5, 'seventh': 6, 'eighth': 7, 'ninth': 8, 'tenth': 9,
      'last': cards.length - 1,
      '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4,
    };

    for (const [ordinal, index] of Object.entries(ordinalMap)) {
      if (message.includes(ordinal) && index >= 0 && index < cards.length) {
        const card = cards[index];
        return {
          itemIndex: index,
          itemId: card.id,
          itemName: card.name,
          quantity: 1,
          price: this.parsePrice(card.price),
          rawPrice: card.rawPrice,
          storeId: card.storeId,
          moduleId: card.moduleId,
          storeName: card.storeName,
          storeLat: card.storeLat,
          storeLng: card.storeLng,
        };
      }
    }

    return null;
  }

  private fuzzyMatchItem(message: string, cards: CardItem[]): SelectionResult['selectedItems'][0] | null {
    // Simple word overlap matching
    const words = message.split(/\s+/).filter(w => w.length > 2);
    
    let bestMatch: { index: number; score: number } | null = null;
    
    for (let i = 0; i < cards.length; i++) {
      const cardName = (cards[i].name || '').toLowerCase();
      const cardWords = cardName.split(/\s+/);
      
      let score = 0;
      for (const word of words) {
        if (cardWords.some(cw => cw.includes(word) || word.includes(cw))) {
          score++;
        }
      }
      
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { index: i, score };
      }
    }

    if (bestMatch && bestMatch.score >= 1) {
      const card = cards[bestMatch.index];
      return {
        itemIndex: bestMatch.index,
        itemId: card.id,
        itemName: card.name,
        quantity: 1,
        price: this.parsePrice(card.price),
        rawPrice: card.rawPrice,
        storeId: card.storeId,
        moduleId: card.moduleId,
        storeName: card.storeName,
        storeLat: card.storeLat,
        storeLng: card.storeLng,
      };
    }

    return null;
  }

  private isCheckoutIntent(message: string): boolean {
    const checkoutKeywords = ['checkout', 'proceed', 'pay', 'order now', 'place order', 'confirm order', 'done', 'that\'s all', 'finish'];
    return checkoutKeywords.some(k => message.includes(k));
  }

  private isCancelIntent(message: string): boolean {
    const cancelKeywords = ['cancel', 'no thanks', 'never mind', 'nevermind', 'stop', 'exit', 'quit'];
    return cancelKeywords.some(k => message.includes(k));
  }

  private isSearchMoreIntent(message: string): boolean {
    const searchMoreKeywords = ['more', 'show more', 'other', 'different', 'something else', 'search again'];
    // Don't match "show more" if it's actually "show my cart"
    if (this.isViewCartIntent(message)) return false;
    return searchMoreKeywords.some(k => message.includes(k));
  }

  private isViewCartIntent(message: string): boolean {
    const viewCartKeywords = ['show my cart', 'show cart', 'view cart', 'my cart', 'see cart', 'what\'s in my cart', 'whats in my cart', 'cart summary', 'check cart'];
    return viewCartKeywords.some(k => message.includes(k));
  }

  /**
   * Check if user is asking to search for a specific restaurant's menu
   * Examples: "inayat ka menu", "show dominos menu", "mcdonald's se kya milega"
   * Returns the restaurant name/search query, or null if not a restaurant search
   */
  private parseRestaurantSearchIntent(message: string): string | null {
    const patterns = [
      // Hindi: "[restaurant] ka menu" or "[restaurant] ki menu"
      /(.+?)\s+(ka|ki|ke)\s+(menu|khana|food|items|products)/i,
      // "menu of [restaurant]" or "menu from [restaurant]"
      /menu\s+(of|from|at)\s+(.+)/i,
      // "[restaurant] menu" or "show [restaurant] menu"
      /(show|dikhao|batao|dekho)?\s*(.+?)\s+menu/i,
      // "[restaurant] se kya milega" or "[restaurant] pe kya hai"
      /(.+?)\s+(se|pe|par|me|mein)\s+(kya|kaun|konsa|what)/i,
      // "[restaurant] ka/ke items/products"
      /(.+?)\s+(ka|ke|ki)\s+(items?|products?|food|khana)/i,
      // "what does [restaurant] have"
      /what\s+(does|do|can|is)\s+(.+?)\s+(have|sell|offer|serve)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        // Extract restaurant name from the match
        let restaurantName = match[1] || match[2];
        
        // Clean up the restaurant name
        restaurantName = restaurantName
          .replace(/^(show|dikhao|batao|dekho|see|open)\s+/i, '')
          .replace(/\s+(menu|khana|food|items?|products?)$/i, '')
          .trim();
        
        // Ignore if it's too short or common words
        if (restaurantName.length < 3) continue;
        const ignoreWords = ['the', 'a', 'an', 'me', 'mujhe', 'i', 'we', 'hum'];
        if (ignoreWords.includes(restaurantName.toLowerCase())) continue;
        
        this.logger.debug(`Detected restaurant menu search: "${restaurantName}" from message: "${message}"`);
        return restaurantName;
      }
    }
    
    return null;
  }

  /**
   * Parse multi-item natural language orders
   * Examples:
   * - "2 butter naan, one paneer tikka, one tandoori chicken"
   * - "I want 3 paneer tikka and 2 butter naan"
   * - "gimme two butter naan and a paneer"
   * 
   * Returns both found items and not-found item names for re-search
   */
  private parseMultiItemNaturalLanguage(message: string, cards: CardItem[]): {
    found: SelectionResult['selectedItems'];
    notFound: string[];
  } {
    const selections: SelectionResult['selectedItems'] = [];
    const notFoundItems: string[] = [];
    const lowerMessage = message.toLowerCase();
    
    // Word to number mapping
    const wordToNumber: Record<string, number> = {
      'a': 1, 'an': 1, 'one': 1, 'ek': 1,
      'two': 2, 'do': 2, 'double': 2,
      'three': 3, 'teen': 3, 'triple': 3,
      'four': 4, 'char': 4,
      'five': 5, 'panch': 5,
      'six': 6, 'cheh': 6,
      'seven': 7, 'saat': 7,
      'eight': 8, 'aath': 8,
      'nine': 9, 'nau': 9,
      'ten': 10, 'das': 10,
    };
    
    // Split by common separators: comma, "and", "aur", "&"
    const segments = lowerMessage.split(/[,&]|\s+and\s+|\s+aur\s+/);
    
    // If fewer than 2 segments with quantity patterns, this may not be a multi-item request
    const itemPatterns = segments.filter(seg => {
      const trimmed = seg.trim();
      return trimmed && (
        /^\d+\s+\w/.test(trimmed) || // starts with number
        Object.keys(wordToNumber).some(w => trimmed.startsWith(w + ' '))
      );
    });
    
    if (itemPatterns.length === 0 && segments.length < 2) {
      // Doesn't look like a multi-item request
      return { found: [], notFound: [] };
    }
    
    for (const segment of segments) {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment || trimmedSegment.length < 3) continue;
      
      // Skip common filler words
      if (/^(i want|gimme|give me|please|can i have|i need|order|get|i'll have|i would like)$/i.test(trimmedSegment)) continue;
      
      // Try to extract quantity and item name
      // Pattern: "[quantity] [item name]" or "[item name] x [quantity]"
      let quantity = 1;
      let itemPart = trimmedSegment;
      
      // Check for leading number: "2 butter naan"
      const leadingNumberMatch = trimmedSegment.match(/^(\d+)\s+(.+)/);
      if (leadingNumberMatch) {
        quantity = parseInt(leadingNumberMatch[1]);
        itemPart = leadingNumberMatch[2];
      } else {
        // Check for leading word number: "two butter naan", "one paneer tikka"
        const words = trimmedSegment.split(/\s+/);
        if (words.length > 1 && wordToNumber[words[0]]) {
          quantity = wordToNumber[words[0]];
          itemPart = words.slice(1).join(' ');
        }
      }
      
      // Check for trailing quantity: "butter naan x2"
      const trailingQuantityMatch = itemPart.match(/(.+?)\s*[xX×]\s*(\d+)$/);
      if (trailingQuantityMatch) {
        itemPart = trailingQuantityMatch[1].trim();
        quantity = parseInt(trailingQuantityMatch[2]);
      }
      
      // Skip if item part is too short
      if (itemPart.length < 3) continue;
      
      // Try to match item name against available cards
      const matchedItem = this.findBestMatchForItemName(itemPart, cards);
      if (matchedItem) {
        // Check if we already have this item, if so, update quantity
        const existingIndex = selections.findIndex(s => s.itemId === matchedItem.itemId);
        if (existingIndex >= 0) {
          selections[existingIndex].quantity += quantity;
        } else {
          selections.push({
            ...matchedItem,
            quantity,
          });
        }
      } else {
        // Item not found in current search results
        notFoundItems.push(itemPart);
      }
    }
    
    this.logger.debug(`Multi-item parse found ${selections.length} items: ${selections.map(s => `${s.quantity}x ${s.itemName}`).join(', ')}`);
    if (notFoundItems.length > 0) {
      this.logger.debug(`Items not found: ${notFoundItems.join(', ')}`);
    }
    
    return { found: selections, notFound: notFoundItems };
  }

  /**
   * Find best matching card for an item name using fuzzy matching
   */
  private findBestMatchForItemName(itemName: string, cards: CardItem[]): SelectionResult['selectedItems'][0] | null {
    const lowerItemName = itemName.toLowerCase().trim();
    const itemWords = lowerItemName.split(/\s+/).filter(w => w.length > 1);
    
    let bestMatch: { index: number; score: number; card: CardItem } | null = null;
    
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardName = (card.name || '').toLowerCase();
      const cardWords = cardName.split(/\s+/);
      
      // Calculate match score
      let score = 0;
      
      // Exact match
      if (cardName === lowerItemName) {
        score = 100;
      } else if (cardName.includes(lowerItemName) || lowerItemName.includes(cardName)) {
        // Substring match
        score = 50;
      } else {
        // Word overlap
        for (const word of itemWords) {
          if (cardWords.some(cw => cw.includes(word) || word.includes(cw))) {
            score += 10;
          }
        }
      }
      
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { index: i, score, card };
      }
    }
    
    if (bestMatch && bestMatch.score >= 10) {
      return {
        itemIndex: bestMatch.index,
        itemId: bestMatch.card.id,
        itemName: bestMatch.card.name,
        quantity: 1,
        price: this.parsePrice(bestMatch.card.price),
        rawPrice: bestMatch.card.rawPrice,
        storeId: bestMatch.card.storeId,
        moduleId: bestMatch.card.moduleId,
        storeName: bestMatch.card.storeName,
        storeLat: bestMatch.card.storeLat,
        storeLng: bestMatch.card.storeLng,
      };
    }
    
    return null;
  }

  private parsePrice(price: string | number): number {
    if (typeof price === 'number') return price;
    // Parse "₹310" or "Rs. 310" or just "310"
    const match = String(price).match(/[\d,]+\.?\d*/);
    if (match) {
      return parseFloat(match[0].replace(/,/g, ''));
    }
    return 0;
  }

  /**
   * Check if message is asking about distance/location of displayed results
   */
  private isDistanceQuestion(message: string): boolean {
    // Patterns for distance/location questions
    const distancePatterns = [
      /\b(how\s+far|distance|kitna\s+dur|dur\s+hai|kahan\s+hai|location|near\s+me|paas|nearest|closest)\b/i,
      /\b(which\s+(one\s+is|is)\s+(near|close|closest|nearest))/i,
      /\b(show\s+me.*?(far|distance|near))/i,
      /\b(from\s+me|mere\s+se|mujhse)\b/i,
      /\b(konsa\s+(paas|dur)|sabse\s+paas)\b/i,
    ];
    
    return distancePatterns.some(pattern => pattern.test(message));
  }

  /**
   * Generate a response showing distance info for displayed cards
   */
  private generateDistanceResponse(cards: CardItem[]): string {
    // Group cards by store and show distance info
    const storeMap = new Map<string, { name: string; distance?: number; items: string[] }>();
    
    for (const card of cards) {
      const storeName = card.storeName || 'Unknown Store';
      if (!storeMap.has(storeName)) {
        storeMap.set(storeName, {
          name: storeName,
          distance: card.distance as number | undefined,
          items: [],
        });
      }
      storeMap.get(storeName)!.items.push(card.name);
    }
    
    // Build response
    const stores = Array.from(storeMap.values());
    
    if (stores.length === 0) {
      return "I don't have distance information for these items. Share your location to see how far each store is.";
    }
    
    // Check if we have distance info
    const hasDistance = stores.some(s => s.distance !== undefined);
    
    if (!hasDistance) {
      return "📍 To see how far each store is from you, please share your location first. I'll then show you the distance to each store.";
    }
    
    // Sort by distance (nearest first)
    stores.sort((a, b) => (a.distance || 999) - (b.distance || 999));
    
    let response = "📍 **Distance to stores:**\n\n";
    for (const store of stores) {
      const distanceText = store.distance !== undefined 
        ? `${store.distance.toFixed(1)} km away`
        : 'distance unknown';
      response += `🏪 **${store.name}** - ${distanceText}\n`;
      response += `   📦 ${store.items.length} item${store.items.length > 1 ? 's' : ''} available\n\n`;
    }
    
    response += "\nWould you like to order from the nearest store?";
    return response;
  }
}
