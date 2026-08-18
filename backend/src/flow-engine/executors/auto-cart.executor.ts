import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

interface Measure {
  /** grams for weight, millilitres for volume, plain count for pieces */
  magnitude: number;
  kind: 'weight' | 'volume' | 'count';
  /** exactly what the customer said, for the message ("1 kg") */
  spoken: string;
}

interface ExtractedItem {
  name: string;
  quantity: number;
  /** Name with an inline measure token stripped ("1 kg malai paneer" -> "malai paneer") */
  matchName?: string;
  /** The size/weight the customer actually asked for, normalised. Null when they said none. */
  requested?: Measure | null;
}

interface CardItem {
  id: number | string;
  name: string;
  price: string | number;
  rawPrice?: number;
  storeId?: number;
  moduleId?: number;
  storeName?: string;
  storeLat?: number;
  storeLng?: number;
  [key: string]: any;
}

interface MatchedItem {
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
  extractedName: string;  // What user asked for
  matchScore: number;
  /** PHP variation format: [{"name": "...", "values": [{"label": "...", "optionPrice": "..."}]}] */
  variation?: any[];
  /** Add-on IDs selected by user */
  add_on_ids?: any[];
  /** Quantities for each selected add-on */
  add_on_qtys?: any[];
  /** Label of the size/weight option we actually selected ("1Kg"), when we selected one */
  variationLabel?: string | null;
  /** What the customer asked for, when they asked for a size ("1 kg") */
  requestedMeasure?: string | null;
  /** true when the customer named a size and this item has no option that matches it */
  unitUnverified?: boolean;
  /** Size options this item offers, when the customer named none: ["250gm - Rs200", ...] */
  sizeOptions?: string[];
}

/**
 * Auto Cart Executor
 * 
 * Automatically matches extracted items with quantities against search results
 * and builds a cart. This handles cases like "I want 2 pizzas and 3 burgers"
 * where we extract items+quantities first and then match them to real products.
 */
@Injectable()
export class AutoCartExecutor implements ActionExecutor {
  readonly name = 'auto_cart';
  private readonly logger = new Logger(AutoCartExecutor.name);

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const extractedItemsPath = config.extractedItemsPath || 'extracted_food.items';
      const searchResultsPath = config.searchResultsPath || 'search_results.cards';
      // 🆕 defaultQuantity: used when items are plain strings (express order path, e.g., "add 5 samosa from satyam")
      const defaultQuantity = parseInt(String(config.defaultQuantity || 1)) || 1;

      // Get extracted items from context
      const rawExtractedItems = this.getNestedValue(context.data, extractedItemsPath);
      const searchResults = this.getNestedValue(context.data, searchResultsPath) as CardItem[];

      // 🆕 Normalize: items may be plain strings ["samosa"] OR objects [{name, quantity}]
      // Normalize to ExtractedItem[] always
      const extractedItems: ExtractedItem[] = Array.isArray(rawExtractedItems)
        ? rawExtractedItems.map((item: any) =>
            typeof item === 'string'
              ? { name: item, quantity: defaultQuantity }
              : { name: item?.name || String(item), quantity: item?.quantity || defaultQuantity }
          )
        : [];

      // 📏 Attach the size/weight the customer asked for.
      // extracted_food.items is food_reference — names only — so the unit never
      // arrives here. It DOES survive in food_nlu.entities.item_quantities, which
      // MultiStoreSearchExecutor already reads; do the same, then fall back to a
      // measure written inline in the name ("1 kg malai paneer").
      // NOTE: the numeric from item_quantities feeds the MEASURE only, never the
      // cart quantity — "500 gm paneer" must add 1 pack of 500gm, not 500 packs.
      const itemQuantities: Array<{ item: string; quantity: string; unit?: string }> =
        (context.data as any)?.food_nlu?.entities?.item_quantities || [];
      for (const extracted of extractedItems) {
        const lowerName = String(extracted.name || '').toLowerCase().trim();
        let requested: Measure | null = null;

        const hit = itemQuantities.find((iq) => {
          const other = String(iq?.item || '').toLowerCase().trim();
          return !!other && (lowerName.includes(other) || other.includes(lowerName));
        });
        if (hit?.unit) {
          const n = parseFloat(String(hit.quantity));
          requested = this.normalizeMeasure(Number.isFinite(n) && n > 0 ? n : 1, hit.unit);
        }

        const inline = this.parseInlineMeasure(extracted.name);
        if (inline) {
          if (!requested) requested = inline.measure;
          if (inline.rest) extracted.matchName = inline.rest;
        }

        extracted.requested = requested;
        if (requested) {
          this.logger.debug(`📏 "${extracted.name}" -> requested ${requested.spoken} (${requested.magnitude} ${requested.kind})`);
        }
      }

      if (!extractedItems || extractedItems.length === 0) {
        return {
          success: false,
          error: 'No extracted items found',
          event: 'no_match',
        };
      }

      if (!searchResults || !Array.isArray(searchResults) || searchResults.length === 0) {
        return {
          success: false,
          error: 'No search results to match against',
          event: 'no_match',
        };
      }

      this.logger.log(`🛒 Auto-cart: Matching ${extractedItems.length} extracted items (defaultQty=${defaultQuantity}) against ${searchResults.length} search results`);

      // Match each extracted item to search results
      // 🏪 STORE AFFINITY: When user orders multiple items without specifying stores,
      // prefer items from the same restaurant (e.g., "roti and paneer sabji" → same store)
      const matchedItems: MatchedItem[] = [];
      const unmatchedItems: string[] = [];
      let totalPrice = 0;
      let preferredStoreId: number | string | null = null; // Set after first match for store affinity

      for (const extracted of extractedItems) {
        // Check for close matches (disambiguation needed)
        const closeMatches = this.findCloseMatches(extracted.matchName || extracted.name, searchResults, preferredStoreId);

        if (closeMatches.length > 1) {
          // Multiple similar items found — ask user to choose
          this.logger.log(`🤔 Multiple close matches for "${extracted.name}": ${closeMatches.map(m => `${m.card.name}@${m.card.storeName}(${m.score})`).join(', ')}`);

          return {
            success: true,
            output: {
              disambiguationNeeded: true,
              disambiguationItem: extracted.name,
              disambiguationQuantity: extracted.quantity || defaultQuantity,
              disambiguationOptions: closeMatches.slice(0, 5).map((m, idx) => ({
                id: `opt_${m.card.id}`,
                label: `${m.card.name} - ₹${this.parsePrice(m.card.price)} (${m.card.storeName || 'Unknown'})`,
                value: `select_item_${m.card.id}`,
                name: m.card.name,
                price: this.parsePrice(m.card.price),
                itemId: m.card.id,
                storeId: m.card.storeId,
                storeName: m.card.storeName,
                moduleId: m.card.moduleId,
                storeLat: m.card.storeLat,
                storeLng: m.card.storeLng,
                rawPrice: m.card.rawPrice,
                hasVariations: !!(m.card.food_variations && Array.isArray(m.card.food_variations) && m.card.food_variations.length > 0),
              })),
              // Save already matched items so we don't lose them
              alreadyMatched: matchedItems,
              message: `🤔 I found ${closeMatches.length} similar items for **"${extracted.name}"**. Which one did you mean?\n\n${closeMatches.slice(0, 5).map((m, idx) => `${idx + 1}. **${m.card.name}** (${m.card.storeName || ''}) - ₹${this.parsePrice(m.card.price)}`).join('\n')}`,
            },
            event: 'needs_disambiguation',
          };
        }

        const match = closeMatches.length === 1 ? { card: closeMatches[0].card, index: closeMatches[0].index, score: closeMatches[0].score } : this.findBestMatch(extracted.matchName || extracted.name, searchResults, preferredStoreId);
        
        if (match) {
          const quantity = extracted.quantity || 1;
          const sized = this.resolveVariation(match.card, extracted.requested || null);
          const price = sized.price;
          const itemTotal = price * quantity;

          matchedItems.push({
            itemIndex: match.index,
            itemId: match.card.id,
            itemName: match.card.name,
            quantity,
            price,
            rawPrice: match.card.rawPrice,
            storeId: match.card.storeId,
            moduleId: match.card.moduleId,
            storeName: match.card.storeName,
            storeLat: match.card.storeLat,
            storeLng: match.card.storeLng,
            extractedName: extracted.name,
            matchScore: match.score,
            variation: sized.variation,
            add_on_ids: [],
            add_on_qtys: [],
            variationLabel: sized.label,
            requestedMeasure: extracted.requested?.spoken || null,
            unitUnverified: sized.unitUnverified,
            sizeOptions: sized.sizeOptions,
          });
          
          // 🏪 Set store affinity after first successful match
          if (!preferredStoreId && match.card.storeId) {
            preferredStoreId = match.card.storeId;
            this.logger.log(`🏪 Store affinity set to: ${match.card.storeName} (ID: ${match.card.storeId})`);
          }
          
          totalPrice += itemTotal;
          this.logger.debug(`✅ Matched "${extracted.name}" (x${quantity}) → "${match.card.name}" @ ₹${price} [${match.card.storeName}]`);
        } else {
          unmatchedItems.push(extracted.name);
          this.logger.debug(`❌ No match found for "${extracted.name}"`);
        }
      }

      // Build result message
      const message = this.buildCartMessage(matchedItems, unmatchedItems, totalPrice);

      // Determine event
      let event = 'no_match';
      if (matchedItems.length === extractedItems.length) {
        event = 'all_matched';
      } else if (matchedItems.length > 0) {
        event = 'partial_match';
      }

      // Always return success: true to avoid "Unknown executor error"
      // The event determines the next state (all_matched, partial_match, no_match)
      return {
        success: true, // Changed from matchedItems.length > 0 to avoid error handling
        output: {
          selectedItems: matchedItems,
          unmatchedItems,
          totalPrice,
          message,
          allMatched: matchedItems.length === extractedItems.length,
          // 📏 Items where the customer named a size this item cannot honour.
          // Surfaced in the message; exposed here so a flow can branch on it later.
          unitUnverifiedItems: matchedItems
            .filter((i) => i.unitUnverified)
            .map((i) => ({ itemName: i.itemName, requested: i.requestedMeasure })),
        },
        event,
      };
    } catch (error) {
      this.logger.error(`Auto-cart failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Find all close matches for an item (used for disambiguation)
   * Returns all matches within 15 points of the best score
   * 
   * 🏪 STORE AFFINITY: When preferredStoreId is set, items from that store get a +30 bonus.
   * This ensures "roti and paneer sabji" both come from the same restaurant.
   * 
   * 🎯 STRICTER MATCHING: Prevents false positives like "roti" matching "Chicken Momos with Roti"
   * by requiring the extracted item name to be the PRIMARY subject of the card name.
   */
  private findCloseMatches(
    itemName: string, 
    cards: CardItem[], 
    preferredStoreId?: number | string | null,
  ): Array<{ card: CardItem; index: number; score: number }> {
    const lowerItemName = itemName.toLowerCase().trim();
    const itemWords = lowerItemName.split(/\s+/).filter(w => w.length > 1);
    const allMatches: Array<{ card: CardItem; index: number; score: number }> = [];
    
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardName = (card.name || '').toLowerCase();
      const cardWords = cardName.split(/\s+/).filter(w => w.length > 1);
      
      let score = 0;
      
      // === SCORING TIERS ===
      if (cardName === lowerItemName) {
        // Exact match — highest score
        score = 100;
      } else if (this.isFuzzyMatch(cardName, lowerItemName)) {
        // Near-exact match (typo tolerance: "chiken biryani" ≈ "chicken biryani")
        score = 95;
      } else if (cardName.includes(lowerItemName)) {
        // Card name contains FULL extracted name (e.g., "paneer sabji" in "Paneer Sabji Masala")
        score = 80;
      } else if (lowerItemName.includes(cardName)) {
        // Extracted name contains FULL card name
        score = 60;
      } else {
        // Word overlap scoring — STRICTER than before
        let matchedWords = 0;
        let totalItemWords = itemWords.length;
        
        for (const word of itemWords) {
          if (cardWords.some(cw =>
            cw === word ||
            this.isFuzzyMatch(word, cw) ||
            (word.length >= 4 && (cw.includes(word) || word.includes(cw)))
          )) {
            matchedWords++;
          }
        }

        // 🎯 KEY FIX: Require at least 50% of extracted item words to match
        // This prevents "roti" (1 word) from matching "Chicken Momos with Roti" (only 1/4 card words match)
        if (matchedWords > 0 && totalItemWords > 0) {
          const matchRatio = matchedWords / totalItemWords;
          
          if (matchRatio >= 1.0) {
            // All extracted words found in card name
            score = 50 + (matchedWords * 10);
          } else if (matchRatio >= 0.5) {
            // At least half the words match
            score = 30 + (matchedWords * 10);
          } else {
            // Less than half — very weak match, only score if it's a key food word
            score = matchedWords * 8;
          }
        }
        
        // 🍕 Bonus for matching PRIMARY food keyword (the main dish type)
        // Only gives bonus if the keyword is a SIGNIFICANT part of the card name
        const keyWords = [
          'pizza', 'burger', 'biryani', 'naan', 'tikka', 'paneer', 'chicken', 'roti', 'dal', 'rice', 'momos',
          'chai', 'tea', 'coffee', 'lassi', 'samosa', 'pakora', 'dosa', 'idli', 'vada', 'pav', 'bhaji',
          'puri', 'paratha', 'kulcha', 'curry', 'masala', 'korma', 'vindaloo', 'thali', 'chole', 'rajma',
          'pulao', 'fried rice', 'noodles', 'manchurian', 'chowmein', 'roll', 'wrap', 'sandwich', 'salad',
          'misal', 'missal', 'vada pav', 'sabji', 'sabzi', 'bhurji', 'omelette', 'egg',
        ];
        for (const key of keyWords) {
          if (lowerItemName.includes(key) && cardName.includes(key)) {
            // 🎯 KEY FIX: Only give bonus if the keyword is LEADING/PRIMARY in the card name
            // "Roti" should match "Butter Roti" or "Roti" but NOT "Chicken Momos with Roti"
            const keyIndex = cardName.indexOf(key);
            const cardMainWords = cardWords.slice(0, 3).join(' '); // First 3 words = primary subject
            
            if (cardMainWords.includes(key) || keyIndex <= cardName.length * 0.5) {
              score += 15; // Key food word is primary part of card name
            } else {
              score += 5; // Key food word exists but is secondary (e.g., "...with Roti")
            }
          }
        }
      }
      
      // 🏪 STORE AFFINITY BONUS: When we've already matched one item from a store,
      // give a big bonus to other items from the same store
      if (preferredStoreId && card.storeId && String(card.storeId) === String(preferredStoreId)) {
        score += 30;
        this.logger.debug(`  🏪 Store affinity +30 for "${card.name}" (same store as previous match)`);
      }
      
      // 🎯 STRICTER THRESHOLD: Minimum 30 to prevent weak matches
      // Short single-word items (like "roti", "chai") need at least 25
      const threshold = lowerItemName.length <= 4 ? 25 : 30;
      if (score >= threshold) {
        allMatches.push({ card, index: i, score });
      }
    }
    
    // Sort by score descending
    allMatches.sort((a, b) => b.score - a.score);
    
    if (allMatches.length <= 1) return allMatches;
    
    // Return all matches within 15 points of the best score (close matches → disambiguation)
    const bestScore = allMatches[0].score;
    const closeMatches = allMatches.filter(m => m.score >= bestScore - 15);
    
    // 🏪 If there are close matches from DIFFERENT stores and we have a preferred store,
    // filter to only the preferred store's matches (user likely wants same-store)
    if (preferredStoreId && closeMatches.length > 1) {
      const sameStoreMatches = closeMatches.filter(m => 
        m.card.storeId && String(m.card.storeId) === String(preferredStoreId)
      );
      if (sameStoreMatches.length >= 1) {
        this.logger.log(`  🏪 Filtered ${closeMatches.length} close matches to ${sameStoreMatches.length} from preferred store`);
        return sameStoreMatches;
      }
    }
    
    return closeMatches;
  }

  /**
   * Find best matching card for an extracted item name
   * 🏪 STORE AFFINITY: Items from preferredStoreId get +30 bonus
   */
  private findBestMatch(
    itemName: string, 
    cards: CardItem[],
    preferredStoreId?: number | string | null,
  ): { card: CardItem; index: number; score: number } | null {
    const lowerItemName = itemName.toLowerCase().trim();
    const itemWords = lowerItemName.split(/\s+/).filter(w => w.length > 1);
    
    let bestMatch: { card: CardItem; index: number; score: number } | null = null;
    
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardName = (card.name || '').toLowerCase();
      const cardWords = cardName.split(/\s+/).filter(w => w.length > 1);
      
      let score = 0;
      
      // Exact match - highest score
      if (cardName === lowerItemName) {
        score = 100;
      }
      // Near-exact match (typo tolerance)
      else if (this.isFuzzyMatch(cardName, lowerItemName)) {
        score = 95;
      }
      // Card name contains full item name
      else if (cardName.includes(lowerItemName)) {
        score = 80;
      }
      // Item name contains full card name
      else if (lowerItemName.includes(cardName)) {
        score = 60;
      }
      // Word overlap — STRICTER matching
      else {
        let matchedWords = 0;
        let totalItemWords = itemWords.length;
        
        for (const word of itemWords) {
          if (cardWords.some(cw =>
            cw === word ||
            this.isFuzzyMatch(word, cw) ||
            (word.length >= 4 && (cw.includes(word) || word.includes(cw)))
          )) {
            matchedWords++;
          }
        }

        if (matchedWords > 0 && totalItemWords > 0) {
          const matchRatio = matchedWords / totalItemWords;
          if (matchRatio >= 1.0) {
            score = 50 + (matchedWords * 10);
          } else if (matchRatio >= 0.5) {
            score = 30 + (matchedWords * 10);
          } else {
            score = matchedWords * 8;
          }
        }

        // Bonus for matching primary food keywords
        const keyWords = [
          'pizza', 'burger', 'biryani', 'naan', 'tikka', 'paneer', 'chicken', 'roti', 'dal', 'rice', 'momos',
          'chai', 'tea', 'coffee', 'lassi', 'samosa', 'pakora', 'dosa', 'idli', 'vada', 'pav', 'bhaji',
          'puri', 'paratha', 'kulcha', 'curry', 'masala', 'korma', 'vindaloo', 'thali', 'chole', 'rajma',
          'pulao', 'fried rice', 'noodles', 'manchurian', 'chowmein', 'roll', 'wrap', 'sandwich', 'salad',
          'sabji', 'sabzi', 'bhurji', 'omelette', 'egg',
        ];
        for (const key of keyWords) {
          if (lowerItemName.includes(key) && cardName.includes(key)) {
            const cardMainWords = cardWords.slice(0, 3).join(' ');
            if (cardMainWords.includes(key)) {
              score += 15; // Primary food keyword match
            } else {
              score += 5; // Secondary mention
            }
          }
        }
      }
      
      // 🏪 Store affinity bonus
      if (preferredStoreId && card.storeId && String(card.storeId) === String(preferredStoreId)) {
        score += 30;
      }
      
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { card, index: i, score };
      }
    }
    
    // 🎯 STRICTER THRESHOLD: Require minimum 30 (was 15/20)
    const threshold = lowerItemName.length <= 4 ? 25 : 30;
    if (bestMatch && bestMatch.score >= threshold) {
      return bestMatch;
    }
    
    return null;
  }

  /**
   * Build user-friendly cart message
   *
   * 📏 Every line says what the price covers: the selected size when we could
   * select one, and an explicit caveat when the customer named a size this item
   * cannot honour. A weight is never silently accepted.
   */
  private buildCartMessage(
    matchedItems: MatchedItem[],
    unmatchedItems: string[],
    totalPrice: number
  ): string {
    if (matchedItems.length === 0) {
      return "Sorry, I couldn't find exact matches for your items. Please select from the options below.";
    }

    // Get store name from first item (all items should be from same store)
    const storeName = matchedItems[0]?.storeName;

    const lines: string[] = ['🛒 **Your Cart**\n'];

    // Show store prominently
    if (storeName) {
      lines.push(`📍 **From: ${storeName}**\n`);
    }

    for (const item of matchedItems) {
      const size = item.variationLabel ? ` (${item.variationLabel})` : '';
      lines.push(`${item.quantity}x ${item.itemName}${size} - ₹${(item.price * item.quantity).toFixed(0)}`);
    }

    lines.push(`\n**Total: ₹${totalPrice.toFixed(0)}**`);

    // 📏 Say what the price covers whenever it is not self-evident.
    const notes: string[] = [];
    for (const item of matchedItems) {
      if (item.unitUnverified) {
        const asked = item.requestedMeasure ? `**${item.requestedMeasure}**` : 'that size';
        if (item.sizeOptions?.length) {
          notes.push(
            `⚠️ **${item.itemName}** — you asked for ${asked}, which this store does not list. Available: ${item.sizeOptions.join(' · ')}. Tell me which one and I will update it.`,
          );
        } else {
          notes.push(
            `⚠️ **${item.itemName}** — you asked for ${asked}, but the store lists this item without any size or weight. ₹${item.price.toFixed(0)} is the price exactly as listed. Tell me if that is not what you wanted.`,
          );
        }
      } else if (!item.variationLabel && item.sizeOptions?.length) {
        notes.push(
          `ℹ️ **${item.itemName}** — ₹${item.price.toFixed(0)} is the default listing. Sizes: ${item.sizeOptions.join(' · ')}. Say a size and I will switch it.`,
        );
      }
    }
    if (notes.length) {
      lines.push('');
      lines.push(...notes);
    }

    if (unmatchedItems.length > 0) {
      lines.push(`\n⚠️ Couldn't find: ${unmatchedItems.join(', ')}`);
      lines.push('You can add them manually or search for alternatives.');
    }

    lines.push('\nShall I proceed to checkout?');

    return lines.join('\n');
  }

  /**
   * 📏 Normalise a spoken quantity+unit into a comparable magnitude.
   * Weight -> grams, volume -> millilitres, count -> pieces.
   * Returns null for units that say nothing about size ("plate", "packet").
   */
  private normalizeMeasure(value: number, unit: string): Measure | null {
    const u = String(unit || '').toLowerCase().trim().replace(/\./g, '');
    const spoken = `${value} ${unit}`.trim();
    const weight: Record<string, number> = {
      kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
      g: 1, gm: 1, gms: 1, gram: 1, grams: 1, gramme: 1, grammes: 1,
    };
    const volume: Record<string, number> = {
      l: 1000, ltr: 1000, ltrs: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000,
      ml: 1, mls: 1, millilitre: 1, milliliter: 1,
    };
    const count: Record<string, number> = {
      pc: 1, pcs: 1, piece: 1, pieces: 1, nos: 1, no: 1, unit: 1, units: 1,
      dozen: 12, dozens: 12,
    };
    if (weight[u] !== undefined) return { magnitude: value * weight[u], kind: 'weight', spoken };
    if (volume[u] !== undefined) return { magnitude: value * volume[u], kind: 'volume', spoken };
    if (count[u] !== undefined) return { magnitude: value * count[u], kind: 'count', spoken };
    return null;
  }

  /** 📏 Pull a measure written inside a name/label ("1 kg malai paneer", "250gm", "1Kg"). */
  private parseInlineMeasure(text: string): { measure: Measure; rest: string } | null {
    const s = String(text || '');
    const re = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|kilograms?|grams?|grammes?|gms?|g|mls?|millilitres?|milliliters?|litres?|liters?|ltrs?|l|dozens?|pcs?|pieces?|nos?)\b/i;
    const m = s.match(re);
    if (!m) return null;
    const value = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    const measure = this.normalizeMeasure(value, m[2]);
    if (!measure) return null;
    const rest = (s.slice(0, m.index) + s.slice((m.index || 0) + m[0].length))
      .replace(/\s+/g, ' ')
      .replace(/^[\s,\-]+|[\s,\-]+$/g, '')
      .trim();
    return { measure, rest };
  }

  /**
   * 📏 Decide which size/weight option of a card the customer actually gets, and
   * what the price therefore covers.
   *
   * Two option shapes exist in the catalogue, and they price differently — both
   * verified against Laravel:
   *  - food_variations `[{name, values:[{label, optionPrice}]}]` — optionPrice is
   *    ADDED to the base price (`Helpers::get_varient`, PlaceNewOrder.php:2617-2618).
   *    Selection payload is `[{name, values:{label:[chosen]}}]`.
   *  - legacy variations `[{type, price, stock}]` — price REPLACES the base
   *    (`Helpers::variation_price`). Selection payload is `[chosenOption]`.
   *
   * ⚠️ Laravel picks its branch by `module_type == 'food'`, not by which column is
   * populated, while the card collapses both columns into one `food_variations`
   * field (search.executor.ts card builder), so we can only pick by SHAPE.
   * Measured on prod 2026-08-18: 0 items populate both columns, and only 1 food
   * item + 3 parcel items of 18,415 carry the shape their module will not read —
   * for those the chat message can disagree with the cart, which recomputes
   * server-side (CartController::resolveCartPrice) and remains authoritative.
   * Closing it properly means carrying module_type on the card.
   *
   * Deliberately conservative: an option is only selected when the customer NAMED
   * a size. With no size named we leave `variation: []` exactly as before — the
   * price charged does not move — and instead list the sizes in the message so the
   * number on screen is never presented as covering a weight it does not cover.
   */
  private resolveVariation(
    card: CardItem,
    requested: Measure | null,
  ): { variation: any[]; label: string | null; price: number; unitUnverified: boolean; sizeOptions: string[] } {
    const base = this.parsePrice(card.price);
    const none = { variation: [] as any[], label: null as string | null, price: base, unitUnverified: false, sizeOptions: [] as string[] };

    const groups: any[] = Array.isArray(card.food_variations) ? card.food_variations : [];
    if (!groups.length) {
      // No options at all. If the customer named a size, we must not pretend the
      // flat price covers it.
      return { ...none, unitUnverified: !!requested };
    }

    const isFoodShape = groups.some((g) => Array.isArray(g?.values));

    if (isFoodShape) {
      const group = groups.find((g) => Array.isArray(g?.values) && g.values.length) || null;
      if (!group) return { ...none, unitUnverified: !!requested };
      const values: any[] = group.values;
      const sizeOptions = values.map(
        (v: any) => `${v.label} - ₹${(base + (parseFloat(String(v.optionPrice)) || 0)).toFixed(0)}`,
      );

      if (!requested) return { ...none, sizeOptions };

      const chosen = values.find((v: any) => this.labelMatches(v?.label, requested));
      if (!chosen) return { ...none, unitUnverified: true, sizeOptions };

      return {
        variation: [{ name: group.name, values: { label: [chosen.label] } }],
        label: String(chosen.label),
        price: base + (parseFloat(String(chosen.optionPrice)) || 0),
        unitUnverified: false,
        sizeOptions,
      };
    }

    // Legacy shape: {type, price, stock} — the option price REPLACES the base.
    const legacy = groups.filter((g) => g && g.type !== undefined);
    if (!legacy.length) return { ...none, unitUnverified: !!requested };
    const sizeOptions = legacy.map((v: any) => `${v.type} - ₹${(parseFloat(String(v.price)) || 0).toFixed(0)}`);

    if (!requested) return { ...none, sizeOptions };

    const chosen = legacy.find((v: any) => this.labelMatches(v?.type, requested));
    if (!chosen) return { ...none, unitUnverified: true, sizeOptions };

    return {
      variation: [chosen],
      label: String(chosen.type),
      price: parseFloat(String(chosen.price)) || base,
      unitUnverified: false,
      sizeOptions,
    };
  }

  /** 📏 Does an option label ("1Kg", "500Gm", "1000gm") mean the size the customer asked for? */
  private labelMatches(label: any, requested: Measure): boolean {
    const text = String(label ?? '').trim();
    if (!text) return false;
    const parsed = this.parseInlineMeasure(text);
    if (parsed) {
      return parsed.measure.kind === requested.kind &&
        Math.abs(parsed.measure.magnitude - requested.magnitude) < 0.001;
    }
    // No parseable measure in the label — compare literally, so odd labels like
    // "Full" simply do not match rather than matching by accident.
    return text.toLowerCase().replace(/\s+/g, '') === requested.spoken.toLowerCase().replace(/\s+/g, '');
  }

  /**
   * Parse price from string or number
   */
  private parsePrice(price: string | number): number {
    if (typeof price === 'number') return price;
    const match = String(price).match(/[\d,]+\.?\d*/);
    if (match) {
      return parseFloat(match[0].replace(/,/g, ''));
    }
    return 0;
  }

  /**
   * Levenshtein distance for fuzzy matching (handles typos like "chiken" → "chicken")
   */
  private levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = b[i - 1] === a[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Check if two words are fuzzy-similar (edit distance <= threshold)
   * Threshold scales with word length: 1 for short words, 2 for longer
   */
  private isFuzzyMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen < 3) return false; // Too short for fuzzy matching
    const threshold = maxLen <= 5 ? 1 : 2;
    return this.levenshtein(a, b) <= threshold;
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  validate(config: Record<string, any>): boolean {
    return true; // No required config
  }
}
