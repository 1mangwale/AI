import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmEntityExtractorService, LlmExtractedEntities } from './llm-entity-extractor.service';
import { NerEntityExtractorService, ExtractedEntities as NerExtractedEntities } from './ner-entity-extractor.service';

interface Entity {
  type: string;
  value: string;
  confidence: number;
  startIndex?: number;
  endIndex?: number;
}

/**
 * Slot-Based Entity Extractor Service (Industry Standard Approach)
 * 
 * ARCHITECTURE PRINCIPLE (following Rasa, Dialogflow, Zomato, DoorDash):
 * - NLU extracts SLOTS (what user said) NOT RESOLVED ENTITIES
 * - Entity Resolution Service maps slots to actual database entities via OpenSearch
 * 
 * This service extracts RAW REFERENCES (slots) from user text:
 * - food_reference: What user said about food ("peppy paneer pizza", "biryani")
 * - store_reference: What user said about store ("dominos", "that chinese place")
 * - location_reference: What user said about location ("nashik", "home", "office")
 * - quantity: Numbers/amounts
 * - time_reference: Time expressions
 * - preference: User preferences
 * 
 * IMPORTANT: This service does NOT:
 * - Know which stores exist in database
 * - Know which menu items are available
 * - Resolve references to actual entities (that's EntityResolutionService's job)
 * 
 * Slot Types (for NLU SLOTS_MODEL training):
 * - food_reference: Any food/dish mention
 * - store_reference: Any store/restaurant mention
 * - location_reference: Any location mention
 * - quantity: Numbers, amounts
 * - time_reference: Time expressions
 * - preference: Preferences (spicy, no onion, etc.)
 * - price_reference: Budget mentions
 * - person_reference: Person names
 * - order_reference: Order ID or "last order" type references
 * - phone: Phone numbers
 * - email: Email addresses
 */
@Injectable()
export class EntityExtractorService {
  private readonly logger = new Logger(EntityExtractorService.name);
  private readonly useLlmExtraction: boolean;
  private readonly llmFallbackThreshold: number;
  private readonly useNerExtraction: boolean;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly llmEntityExtractor?: LlmEntityExtractorService,
    @Optional() private readonly nerEntityExtractor?: NerEntityExtractorService,
  ) {
    this.useLlmExtraction = this.config.get('LLM_ENTITY_EXTRACTION_ENABLED', 'true') === 'true';
    this.llmFallbackThreshold = parseFloat(this.config.get('LLM_ENTITY_FALLBACK_THRESHOLD', '0.6'));
    this.useNerExtraction = this.config.get('NER_ENTITY_EXTRACTION_ENABLED', 'true') === 'true';
    this.logger.log(`🔧 EntityExtractor initialized (NER: ${this.useNerExtraction ? 'enabled' : 'disabled'}, LLM: ${this.useLlmExtraction ? 'enabled' : 'disabled'})`);
  }

  // REMOVED: Hardcoded FOOD_ITEMS list
  // Food items are now resolved via OpenSearch, not hardcoded
  // NLU extracts the RAW TEXT as food_reference, EntityResolutionService resolves it
  
  // Common food category words (for detecting food context, NOT for exact matching)
  // These help identify food-related context, actual items come from OpenSearch
  private readonly FOOD_CONTEXT_WORDS = [
    'food', 'khana', 'khaana', 'nashta', 'breakfast', 'lunch', 'dinner',
    'snack', 'drink', 'dessert', 'sweet', 'mithai', 'meal', 'order',
  ];

  // Restaurant name patterns (including Hindi patterns)
  private readonly RESTAURANT_PATTERNS = [
    // English patterns
    /(?:from\s+)([A-Z][a-zA-Z\s]+?)(?:\s+restaurant|\s+hotel|\s+cafe|\s+dhaba)?(?:\s|,|$)/i,
    /(?:at\s+)([A-Z][a-zA-Z\s]+?)(?:\s+restaurant|\s+hotel|\s+cafe|\s+dhaba)?(?:\s|,|$)/i,
    
    // Hindi patterns with cafe/restaurant/dhaba suffix: "inayat cafe se", "hotel taj se"
    /([a-zA-Z][a-zA-Z\s]*?)\s*(?:cafe|hotel|restaurant|dhaba)\s+se\b/i,
    
    // Multi-word names with "se": "bhagat tarachand se bhej do"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+se\s+(?:bhej|manga|lao|order)/i,
    
    // Generic "X se bhej/order" pattern - capture longer names
    /([a-zA-Z][a-zA-Z]+(?:\s+[a-zA-Z]+)*?)\s+se\s+(?:bhej|manga|lao|order)/i,
    
    // Multi-word name at end: "from bhagat tarachand"
    /(?:from|se)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*$/i,
  ];
  
  // Words that are NOT restaurant names (action verbs, common words)
  private readonly NON_RESTAURANT_WORDS = [
    'the', 'a', 'my', 'your', 'this', 'that', 'i', 'we', 'me', 'mujhe',
    'order', 'bhej', 'manga', 'lao', 'karo', 'do', 'ghar', 'home', 'office',
    'jaldi', 'abhi', 'please', 'chahiye', 'want', 'need',
    // Common words that are NOT restaurant names
    'any', 'other', 'store', 'restro', 'restaurant', 'shop', 'dukan',
    'more', 'different', 'aur', 'alag', 'dusra', 'koi', 'bhi',
    'food', 'khana', 'khaana', 'eat', 'send', 'give', 'menu', 'show', 'list',
    'what', 'can', 'delivery', 'deliver', 'fast', 'quick', 'now', 'today',
    'tomorrow', 'kuch', 'something', 'anything', 'best', 'famous', 'popular',
    'good', 'tasty', 'cheap', 'nearby', 'near', 'close', 'around',
  ];

  // Hindi number words mapping
  private readonly HINDI_NUMBERS: Record<string, number> = {
    'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'panch': 5,
    'chhah': 6, 'chha': 6, 'saat': 7, 'aath': 8, 'nau': 9, 'das': 10,
    'gyarah': 11, 'barah': 12, 'dozen': 12,
  };

  /**
   * Extract ALL entities from text - captures maximum data for training
   * 
   * Strategy: Hybrid NER + Regex + LLM
   * 1. Try NER first if available (most accurate for Hindi/Hinglish)
   * 2. Fast regex extraction (sub-millisecond)
   * 3. If regex confidence is low or key entities missing, use LLM
   * 4. Merge results, preferring NER > LLM > Regex for food/store
   */
  async extract(
    text: string,
    intent: string,
    language: string = 'en',
    context?: { activeModule?: string; lastBotQuestion?: string },
  ): Promise<Record<string, any>> {
    const startTime = Date.now();
    
    // 🏪🏪 Preserve store_references from NER even if overall NER confidence is low
    // NER calls LLM detectMultiStoreHint which is the ONLY source of store_references
    let nerStoreReferences: any[] | null = null;
    
    // Step 0: Try NER extraction first (best for multilingual)
    if (this.useNerExtraction && this.nerEntityExtractor?.isAvailable()) {
      try {
        const nerResult = await this.nerEntityExtractor.extract(text);
        
        // Save store_references regardless of confidence — they come from a separate LLM call
        if (nerResult.store_references && Array.isArray(nerResult.store_references) && nerResult.store_references.length >= 2) {
          nerStoreReferences = nerResult.store_references;
          this.logger.debug(`🏪🏪 Preserved store_references from NER (confidence: ${nerResult._confidence?.toFixed(2)}): ${JSON.stringify(nerStoreReferences)}`);
        }
        
        if (nerResult._confidence >= 0.7) {
          // Also run regex to get other entities (phone, email, etc.)
          const regexEntities = await this.extractWithRegex(text);
          const merged = this.mergeNerWithRegex(nerResult, regexEntities, text);
          this.logger.log(
            `🎯 NER extraction for "${text.substring(0, 30)}..." ` +
            `(confidence: ${nerResult._confidence.toFixed(2)}, ${Date.now() - startTime}ms)`
          );
          return merged;
        }
      } catch (error) {
        this.logger.debug(`NER extraction failed, falling back to regex: ${error.message}`);
      }
    }
    
    // Step 1: Fast regex extraction
    const regexEntities = await this.extractWithRegex(text);
    
    // Step 2: Check if we need LLM enhancement
    const needsLlm = this.shouldUseLlm(text, regexEntities);
    
    if (needsLlm && this.useLlmExtraction && this.llmEntityExtractor) {
      try {
        // 10-second timeout: LLM cold start can cause 60-90s hangs; fail fast and use regex
        const llmEntities = await Promise.race([
          this.llmEntityExtractor.extract(text, context),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('LLM entity extraction timeout (10s)')), 10000),
          ),
        ]) as Awaited<ReturnType<typeof this.llmEntityExtractor.extract>>;
        
        if (llmEntities.confidence >= this.llmFallbackThreshold) {
          // 🏪🏪 Inject store_references from NER if LLM didn't provide them
          if (nerStoreReferences && !llmEntities.store_references) {
            llmEntities.store_references = nerStoreReferences;
            this.logger.log(`🏪🏪 Injected NER store_references into LLM merge path`);
          }
          
          // Merge LLM results with regex results
          const merged = this.mergeEntities(regexEntities, llmEntities);
          this.logger.log(
            `🧠 LLM-enhanced extraction for "${text.substring(0, 30)}..." ` +
            `(regex: ${Object.keys(regexEntities).length} fields, ` +
            `llm: ${llmEntities.confidence.toFixed(2)} conf, ` +
            `merged: ${Object.keys(merged).length} fields, ` +
            `${Date.now() - startTime}ms)`
          );
          return merged;
        }
      } catch (error) {
        this.logger.warn(`LLM entity extraction failed, using regex only: ${error.message}`);
      }
    }
    
    // Log extraction for debugging
    if (Object.keys(regexEntities).length > 0) {
      this.logger.debug(`Extracted slots from "${text.substring(0, 50)}...": ${JSON.stringify(regexEntities)}`);
    }
    
    // 🏪🏪 Inject NER store_references into regex-only fallback path
    if (nerStoreReferences && !regexEntities.store_references) {
      regexEntities.store_references = nerStoreReferences;
      this.logger.log(`🏪🏪 Injected NER store_references into regex-only path`);
    }
    
    return regexEntities;
  }

  /**
   * Determine if we should use LLM for this extraction
   */
  private shouldUseLlm(text: string, regexEntities: Record<string, any>): boolean {
    // Always use LLM for food-related intents without food_reference
    if (!regexEntities.food_reference || regexEntities.food_reference.length === 0) {
      // Check if text looks like a food order
      const foodIndicators = [
        'order', 'want', 'chahiye', 'hai', 'milega', 'do', 'have',
        'eat', 'khana', 'from', 'se', 'pizza', 'biryani', 'momos'
      ];
      if (foodIndicators.some(w => text.toLowerCase().includes(w))) {
        return true;
      }
    }
    
    // Use LLM if text contains Hindi helper verbs that might confuse regex
    const hindiHelpers = ['hai', 'hain', 'kya', 'chahiye', 'milega'];
    if (hindiHelpers.some(w => text.toLowerCase().includes(w))) {
      return true;
    }
    
    // Use LLM for longer texts (more context needed)
    if (text.split(' ').length > 6) {
      return true;
    }
    
    return false;
  }

  /**
   * Merge regex and LLM entities, preferring LLM for key fields
   */
  private mergeEntities(
    regexEntities: Record<string, any>,
    llmEntities: LlmExtractedEntities
  ): Record<string, any> {
    const merged = { ...regexEntities };
    
    // Prefer LLM for food_reference (more intelligent)
    if (llmEntities.food_reference && llmEntities.food_reference.length > 0) {
      merged.food_reference = llmEntities.food_reference;
      merged.product_name = llmEntities.food_reference.length === 1 
        ? llmEntities.food_reference[0] 
        : llmEntities.food_reference;
    }
    
    // Prefer LLM for store_reference
    if (llmEntities.store_reference) {
      merged.store_reference = llmEntities.store_reference;
      merged.restaurant_name = llmEntities.store_reference;
    }
    
    // Prefer LLM for quantity (handles "do" as Hindi 2 correctly)
    if (llmEntities.quantity) {
      merged.quantity = llmEntities.quantity;
    }
    
    // Add preferences if LLM found them
    if (llmEntities.preference && llmEntities.preference.length > 0) {
      merged.preference = llmEntities.preference;
    }
    
    // Add location from LLM if not in regex
    if (llmEntities.location_reference && !merged.location_reference) {
      merged.location_reference = llmEntities.location_reference;
      merged.location = llmEntities.location_reference;
    }
    
    // Propagate multi-store references from LLM
    if (llmEntities.store_references && Array.isArray(llmEntities.store_references) && llmEntities.store_references.length >= 2) {
      merged.store_references = llmEntities.store_references;
    }
    
    // Add LLM reasoning for debugging
    if (llmEntities.reasoning) {
      merged._llm_reasoning = llmEntities.reasoning;
      merged._llm_confidence = llmEntities.confidence;
    }
    
    return merged;
  }

  /**
   * Merge NER results with regex entities
   * Strategy: Use best of both - NER is preferred when reliable, regex fills gaps
   * Validation: Check that extracted entities make sense in context
   */
  private mergeNerWithRegex(
    nerResult: NerExtractedEntities,
    regexEntities: Record<string, any>,
    originalText: string = ''
  ): Record<string, any> {
    const merged: Record<string, any> = { ...regexEntities };
    
    // Common words that should NOT be treated as stores
    const invalidStoreWords = [
      'show', 'cart', 'menu', 'order', 'remove', 'add', 'cancel', 'track',
      'home', 'office', 'ghar', 'location', 'address', 'payment', 'pay',
      'item', 'items', 'food', 'khana', 'product', 'status',
      // Browse-related words that are NOT restaurant names
      'any', 'other', 'store', 'shop', 'restaurant', 'restro', 'dukan',
      'more', 'different', 'aur', 'alag', 'dusra', 'koi', 'bhi',
      'nearby', 'near', 'close', 'paas', 'nazdeek', 'here', 'there',
      'yahan', 'wahan', 'local', 'famous', 'best', 'good', 'cheap',
      'fast', 'quick', 'jaldi', 'partner', 'available', 'open'
    ];
    
    // Store extraction: Validate and prefer whichever found valid store
    if (nerResult.store_reference) {
      const storeLower = nerResult.store_reference.toLowerCase();
      // Only accept NER store if it's not a common word
      if (!invalidStoreWords.includes(storeLower)) {
        merged.store_reference = nerResult.store_reference;
        merged.restaurant_name = nerResult.store_reference;
      }
    }
    // If NER store was invalid or missing, regex result is already in merged from spread
    
    // Also validate regex store_reference 
    if (merged.store_reference && invalidStoreWords.includes(merged.store_reference.toLowerCase())) {
      delete merged.store_reference;
      delete merged.restaurant_name;
    }
    
    // Food extraction: Validate NER results against store reference
    // If NER returns partial words (e.g., "mom" from "momos"), prefer regex
    const storeRef = merged.store_reference?.toLowerCase() || '';
    // 🔧 FIX (2026-08-01): message text with the store phrase removed ONCE.
    // If a dish token still appears here, the user named the dish separately
    // from the store ("mala Tushar Misal madhun misal pahije" → dish "misal"
    // must survive even though it is a substring of store "Tushar Misal").
    const textMinusStore = storeRef
      ? (originalText || '').toLowerCase().replace(storeRef, ' ')
      : (originalText || '').toLowerCase();
    if (nerResult.food_reference && nerResult.food_reference.length > 0) {
      // Common action words that should NOT be in food names
      const invalidFoodPrefixes = ['remove', 'add', 'order', 'cancel', 'show', 'get'];
      
      // Validate NER food results
      const validNerFood = nerResult.food_reference.filter((f: string) => {
        const fLower = f.toLowerCase();
        // Skip if food is subset of store (e.g., "momo" when store is "wow momo")
        // — unless the dish ALSO appears outside the store phrase
        if (storeRef && storeRef.includes(fLower) && !textMinusStore.includes(fLower)) {
          this.logger.debug(`Skipping NER food "${f}" - subset of store "${storeRef}"`);
          return false;
        }
        // Skip very short extractions (< 3 chars) - likely errors
        if (fLower.length < 3) {
          this.logger.debug(`Skipping NER food "${f}" - too short`);
          return false;
        }
        // Skip if starts with action word (e.g., "remove paneer")
        if (invalidFoodPrefixes.some(p => fLower.startsWith(p + ' '))) {
          this.logger.debug(`Skipping NER food "${f}" - starts with action word`);
          return false;
        }
        return true;
      });
      
      if (validNerFood.length > 0) {
        merged.food_reference = validNerFood;
        merged.product_name = validNerFood.length === 1 ? validNerFood[0] : validNerFood;
      }
      // If no valid NER food, keep regex results (already in merged from spread)
    }
    
    // Post-process: Remove weight/measure unit words from food_reference
    // NER sometimes tags unit abbreviations (grm, gm, kg) as FOOD tokens
    if (merged.food_reference && Array.isArray(merged.food_reference)) {
      const unitOnlyWords = ['grm', 'gram', 'grams', 'gm', 'g', 'kg', 'ml', 'liter', 'litre', 'liters', 'litres',
                             'piece', 'pc', 'pcs', 'plate', 'plates', 'packet', 'packets', 'box', 'boxes',
                             'cup', 'cups', 'glass', 'glasses', 'bowl', 'bowls', 'serve', 'serving', 'servings'];
      merged.food_reference = merged.food_reference.filter((f: string) => !unitOnlyWords.includes(f.toLowerCase().trim()));
      if (merged.food_reference.length > 0) {
        merged.product_name = merged.food_reference.length === 1 ? merged.food_reference[0] : merged.food_reference;
      }
    }

    // Post-process: Remove store words from food_reference
    if (merged.store_reference && merged.food_reference && Array.isArray(merged.food_reference)) {
      const storeLower = merged.store_reference.toLowerCase();
      const storeWords = storeLower.split(/\s+/).filter((w: string) => w.length > 2);
      
      merged.food_reference = merged.food_reference.map((f: string) => {
        let fLower = f.toLowerCase();
        // 🔧 FIX (2026-08-01): if the dish name appears in the message outside
        // the store phrase, keep it intact — stripping shared tokens here used
        // to turn "misal" into "" when the store was "Tushar Misal"
        if (fLower.length > 2 && textMinusStore.includes(fLower)) {
          return fLower;
        }
        for (const sw of storeWords) {
          fLower = fLower.replace(new RegExp(`\\b${sw}\\b`, 'gi'), '').trim();
          fLower = fLower.replace(/\s+/g, ' ').trim();
        }
        return fLower;
      }).filter((f: string) => f.length > 2 && (textMinusStore.includes(f) || !storeWords.includes(f)));
      
      // Update product_name
      if (merged.food_reference.length > 0) {
        merged.product_name = merged.food_reference.length === 1 
          ? merged.food_reference[0] 
          : merged.food_reference;
      }
    }
    
    // NER wins for quantity (usually accurate)
    if (nerResult.quantity) {
      merged.quantity = nerResult.quantity;
    }
    
    // NER wins for location
    if (nerResult.location_reference) {
      merged.location_reference = nerResult.location_reference;
      merged.location = nerResult.location_reference;
    }
    
    // NER wins for preference — with Nashik food instruction correction
    if (nerResult.preference && nerResult.preference.length > 0) {
      // Fix common BERT subword truncations in food instructions
      // MuRIL tokenizes "tarri" → ["tar","##ri"], PREF label may stop at "tar"
      const nashikFoodFixes: Record<string, string> = {
        'no tar': 'no tarri',
        'extra tar': 'extra tarri',
        'less tar': 'less tarri',
        'bina tar': 'bina tarri',
        'with tar': 'with tarri',
      };
      merged.preference = nerResult.preference.map((p: string) => {
        const lower = p.toLowerCase().trim();
        return nashikFoodFixes[lower] || p;
      });
    }
    
    // Post-process: Fix split instruction phrases (e.g., NER returns PREF="no" + FOOD="tarri")
    // Scan original text for "no/extra/less + instruction_noun" patterns and reassemble them
    if (originalText) {
      // Words that act as instruction modifiers
      const instrModifiers = 'no|extra|less|bina|without|with|thoda|kam|jyada|aur';
      // Words that are instruction targets (not standalone food orders)
      const instrNouns = 'tarri|onion|garlic|mirchi|chilli|spice|masala|sugar|salt|chatni|chutney|lemon|nimbu|kanda|lehsun';
      const instrPattern = new RegExp(`\\b(${instrModifiers})\\s+(${instrNouns})\\b`, 'gi');
      const detectedInstructions: string[] = [];
      let instrMatch: RegExpExecArray | null;
      while ((instrMatch = instrPattern.exec(originalText)) !== null) {
        detectedInstructions.push(instrMatch[0].toLowerCase().trim());
      }

      if (detectedInstructions.length > 0) {
        // Remove the instruction nouns from food_reference (they're not food to order)
        const instrNounSet = new Set(detectedInstructions.map(i => i.split(/\s+/).pop()!));
        if (merged.food_reference && Array.isArray(merged.food_reference)) {
          merged.food_reference = merged.food_reference.filter(
            (f: string) => !instrNounSet.has(f.toLowerCase().trim())
          );
          if (merged.food_reference.length > 0) {
            merged.product_name = merged.food_reference.length === 1
              ? merged.food_reference[0]
              : merged.food_reference;
          }
        }
        // Replace orphaned prefix-only preference entries (e.g., "no") with full instructions
        const orphanPrefixes = new Set(['no', 'extra', 'less', 'bina', 'without', 'with', 'thoda', 'kam', 'jyada']);
        if (merged.preference && Array.isArray(merged.preference)) {
          merged.preference = merged.preference.filter(
            (p: string) => !orphanPrefixes.has(p.toLowerCase().trim())
          );
        } else {
          merged.preference = [];
        }
        for (const inst of detectedInstructions) {
          if (!merged.preference.some((p: string) => p.toLowerCase() === inst)) {
            merged.preference.push(inst);
          }
        }
        this.logger.debug(`🥗 Instruction fix: detected "${detectedInstructions.join(', ')}" from text, updated preference`);
      }
    }

    // 🏪🏪 Propagate multi-store references from NER (detected by detectMultiStoreHint)
    if (nerResult.store_references && Array.isArray(nerResult.store_references) && nerResult.store_references.length >= 2) {
      merged.store_references = nerResult.store_references;
    }
    
    // Add source metadata
    merged._source = 'ner';
    merged._ner_confidence = nerResult._confidence;
    
    return merged;
  }

  /**
   * Original regex-based extraction (fast path)
   */
  private async extractWithRegex(text: string): Promise<Record<string, any>> {
    // 🔧 Marathi → Hindi normalization (2026-08-01): the regex pattern zoo below
    // (store "X se ...", desire "chahiye", etc.) only knows Hindi/English. Map
    // Marathi postpositions/verbs to Hindi equivalents so Marathi orders parse:
    // "mala Tushar Misal madhun misal pahije" → "Tushar Misal se misal chahiye".
    text = text
      .replace(/^\s*(?:mala|amhala)\s+/i, '')
      .replace(/\b(?:madhun|madun|kadun)\b/gi, ' se ')
      .replace(/मधून|मधुन|कडून/g, ' se ')
      .replace(/\b(?:pahije|paahije|pahijet)\b/gi, 'chahiye')
      .replace(/पाहिजे|हवी आहे|हवा आहे|हवे आहे/g, 'chahiye')
      .replace(/\s+/g, ' ')
      .trim();

    const entities: Record<string, any> = {};

    // ALWAYS extract all entity types (for training data collection)
    // This ensures we capture maximum information regardless of intent
    // Note: These are SLOTS (raw references), not resolved entities
    // EntityResolutionService will resolve these to actual database records

    // 1. Food/Product references (slots - will be resolved by EntityResolutionService)
    let products = this.extractFoodItems(text);

    // 2. Store/Restaurant reference (slot - will be resolved by EntityResolutionService)
    const restaurant = this.extractRestaurantName(text);
    if (restaurant) {
      entities.store_reference = restaurant;
      entities.restaurant_name = restaurant; // Legacy support
      
      // Post-process: Remove food items that include the restaurant name or its words
      const restaurantLower = restaurant.toLowerCase();
      const restaurantWords = restaurantLower.split(/\s+/).filter(w => w.length > 2);
      // 🔧 Positional guard (2026-08-01): a dish that shares a token with the
      // store name ("misal" @ "Tushar Misal") must survive when the user said
      // it AGAIN outside the store name. Compare against the text minus the
      // first store-name occurrence.
      const textMinusStore = text.toLowerCase().replace(restaurantLower, ' ');
      products = products.map(p => {
        let pLower = p.toLowerCase();
        if (pLower.length > 2 && textMinusStore.includes(pLower)) {
          return pLower; // dish independently present outside the store name — keep intact
        }
        // Remove restaurant words from the food item
        for (const rw of restaurantWords) {
          // Remove restaurant word if it appears as a separate word
          pLower = pLower.replace(new RegExp(`\\b${rw}\\b`, 'gi'), '').trim();
          // Clean up double spaces
          pLower = pLower.replace(/\s+/g, ' ').trim();
        }
        return pLower;
      }).filter(p => {
        // Filter out empty or very short results
        if (p.length <= 2) return false;
        // Filter out if the cleaned result is just a restaurant word
        // (unless it also appears outside the store name — then it's the dish)
        if (restaurantWords.includes(p) && !textMinusStore.includes(p)) return false;
        return true;
      });
      // Deduplicate
      products = [...new Set(products)];
    }
    
    if (products.length > 0) {
      // ALWAYS return as array for consistent flow handling
      entities.food_reference = products;
      entities.product_name = products.length === 1 ? products[0] : products; // Legacy: single or array
    }

    // 3. Quantity (simple)
    const quantity = this.extractQuantity(text);
    if (quantity) entities.quantity = quantity;

    // 3b. Cart items (structured for complex orders)
    const cartItems = this.extractCartItems(text);
    if (cartItems.length > 0) {
      entities.cart_items = cartItems;
    }

    // 4. Phone number
    const phone = this.extractPhoneNumber(text);
    if (phone) entities.phone = phone;

    // 5. Email
    const email = this.extractEmail(text);
    if (email) entities.email = email;

    // 6. Location/Address reference (slot - may need geocoding resolution)
    const location = this.extractLocation(text);
    if (location) {
      entities.location_reference = location;
      entities.location = location; // Legacy support
    }

    // 7. Order ID
    const orderId = this.extractOrderId(text);
    if (orderId) entities.order_id = orderId;

    // 8. Date
    const date = this.extractDate(text);
    if (date) entities.date = date;

    // 9. Time
    const time = this.extractTime(text);
    if (time) entities.time = time;

    // 10. Price/Amount
    const price = this.extractPrice(text);
    if (price) entities.price = price;

    // 11. Person name (for parcel/delivery)
    const personName = this.extractPersonName(text);
    if (personName) entities.person_name = personName;

    // 12. Urgency level
    const urgency = this.extractUrgency(text);
    if (urgency) entities.urgency = urgency;

    // 13. Delivery type (home/office)
    const deliveryType = this.extractDeliveryType(text);
    if (deliveryType) entities.delivery_type = deliveryType;

    // 14. Pickup and delivery locations for parcel
    const parcelLocations = this.extractParcelLocations(text);
    if (parcelLocations.pickup) entities.pickup_location = parcelLocations.pickup;
    if (parcelLocations.delivery) entities.delivery_location = parcelLocations.delivery;

    // 15. Vehicle type for parcel/ride
    const vehicleType = this.extractVehicleType(text);
    if (vehicleType) entities.vehicle_type = vehicleType;

    // 16. Action requests (payment link, otp, etc.)
    const actionRequest = this.extractActionRequest(text);
    if (actionRequest) entities.action_request = actionRequest;

    // Log extraction for debugging (show slot names)
    if (Object.keys(entities).length > 0) {
      this.logger.debug(`Extracted slots from "${text.substring(0, 50)}...": ${JSON.stringify(entities)}`);
    }

    return entities;
  }

  /**
   * Extract food/product references from text as SLOTS
   * Returns raw text references - EntityResolutionService will resolve to actual items
   * This is the industry-standard approach (like Rasa, Dialogflow)
   */
  private extractFoodItems(text: string): string[] {
    const lowerText = text.toLowerCase();
    const found: string[] = [];
    
    // Words that indicate restaurant/location context, not food
    const restaurantWords = ['hotel', 'cafe', 'restaurant', 'dhaba', 'store', 'shop'];
    
    // Location words that should NOT be extracted as food
    const locationWords = ['ghar', 'home', 'office', 'dukan', 'school', 'college', 'hospital', 'station'];
    
    // Transport/parcel words that should NOT be extracted as food
    const transportWords = ['bike', 'auto', 'car', 'tempo', 'coolie', 'wala', 'wali'];
    
    // Action words to remove from extractions
    const actionWords = ['order', 'chahiye', 'mangwao', 'lao', 'do', 'dena', 'want', 'need', 'bhej', 'bhejo'];
    
    // ✅ Hindi helper verbs to remove from food names
    const hindiSuffixes = ['hai', 'hain', 'ho', 'tha', 'the', 'thi', 'ka', 'ki', 'ke', 'ko', 'me', 'mein', 'kya'];
    
    // ✅ FIX: English filler words that should be removed from food names
    // "show me pizza" should extract "pizza" not "me pizza"
    const englishFillerWords = ['me', 'my', 'some', 'the', 'a', 'an', 'any', 'please', 'just', 'only'];
    
    // Words to skip entirely
    const skipWords = [...restaurantWords, ...locationWords, ...transportWords, 
                       'payment', 'link', 'otp', 'bill', 'receipt', 'send', 'kardo', 'kar'];

    // Pattern 1: Items after order keywords
    // e.g., "2 paneer tikka order karo" -> "paneer tikka"
    // e.g., "butter chicken chahiye" -> "butter chicken"
    // e.g., "i want to eat anda burjji" -> "anda burjji"
    // e.g., "do you have tushar misal" -> "tushar misal"
    const orderPatterns = [
      // ✅ "show me X" / "find me X" / "get me X" - common English browsing patterns
      // e.g., "show me pizza" -> "pizza", "find me biryani" -> "biryani"
      /(?:show|find|get|give)\s+me\s+(.+?)(?:\s+(?:near|nearby|in|at|from|please)|\s*$)/gi,
      // ✅ "do you have X" / "is there X" - availability check (extract as potential store+food)
      /(?:do you have|is there|have you got|got any)\s+(.+?)(?:\s+(?:available|in stock|\?)|[?]|\s*$)/gi,
      // ✅ "want to eat X" / "like to eat X" / "want to have X" - MUST come first (more specific)
      /(?:want|like|need)\s+to\s+(?:eat|have|order|get)\s+(.+?)(?:\s+(?:and|aur|,|please|from|se)|\s*$)/gi,
      // ✅ "khana hai X" / "khana chahiye X" - Hindi patterns
      /(?:khana|peena)\s+(?:hai|chahiye|chaiye)\s+(.+?)(?:\s+(?:and|aur|,|please|from|se)|\s*$)/gi,
      // Original patterns - ✅ Removed "do" to avoid capturing English "do you"
      /(?:order|chahiye|mangwao|lao|dena)\s+(.+?)(?:\s+(?:and|aur|,|please|from|se)|\s*$)/gi,
      // ✅ "do" only when NOT followed by "you" (Hindi "do X" = give X)
      /\bdo\s+(?!you\b)(.+?)(?:\s+(?:and|aur|,|please|from|se)|\s*$)/gi,
      // ✅ "want X" but NOT "want to" (excluded via negative lookahead)
      /(?:want|need)\s+(?!to\s+(?:eat|have|order|get))(?:a|some)?\s*(.+?)(?:\s+(?:and|,|please|from|se)|\s*$)/gi,
      /(?:mujhe|chahiye)\s+(.+?)(?:\s+(?:bhej|manga|order|and|aur)|\s*$)/gi,
    ];

    for (const pattern of orderPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        let item = match[1]?.trim();
        if (item && item.length > 2 && item.length < 50) {
          // Filter out restaurant-related extractions
          const hasRestaurantWord = restaurantWords.some(w => item.toLowerCase().includes(w));
          const isSkipWord = skipWords.some(w => item.toLowerCase() === w);
          // Remove action words from extraction
          for (const aw of actionWords) {
            item = item.replace(new RegExp(`\\b${aw}\\b`, 'gi'), '').trim();
          }
          // ✅ Remove Hindi helper verbs from end of food names
          for (const suffix of hindiSuffixes) {
            item = item.replace(new RegExp(`\\s+${suffix}\\s*$`, 'gi'), '').trim();
          }
          // ✅ FIX: Remove English filler words from food names
          // "me pizza" -> "pizza", "some biryani" -> "biryani"
          for (const filler of englishFillerWords) {
            item = item.replace(new RegExp(`^${filler}\\s+`, 'gi'), '').trim();
            item = item.replace(new RegExp(`\\s+${filler}$`, 'gi'), '').trim();
          }
          // ✅ Also remove "to" if it's left over
          item = item.replace(/^\bto\b\s*/i, '').trim();
          if (!hasRestaurantWord && !isSkipWord && item.length > 2 && !found.includes(item.toLowerCase())) {
            found.push(item.toLowerCase());
          }
        }
      }
    }
    
    // Pattern 2: "HINDI_NUMBER + [UNIT] + FOOD" pattern (stop at restaurant name or other cues)
    // e.g., "saat momos Wow Momo se" -> extract "momos"
    // e.g., "ek plate missal pav" -> skip "plate" (unit), extract "missal pav"
    // Strategy: Match Hindi number + optional unit word + immediately following word(s), up to 2 words max
    // ✅ Exclude "do you" (English phrase, not Hindi "do" = 2)
    // ✅ FIXED: Added optional unit-word group so "ek plate missal pav" → "missal pav" not "plate missal"
    const hindiNumRegex = /\b(ek|teen|char|paanch|panch|chhah|chha|saat|aath|nau|das|gyarah|barah)\s+(?:(?:plate|plates|kg|g|gm|grm|gram|grams|piece|pc|pieces|packet|packets|glass|bowl|cup|box|serve|serving|servings)\s+)?([a-z]+(?:\s+[a-z]+)?)\b/gi;
    // ✅ Separate pattern for "do" that excludes "do you" (English)
    const hindiDoRegex = /\bdo\s+(?!you\b)(?:(?:plate|plates|kg|g|gm|grm|gram|grams|piece|pc|pieces|packet|packets|glass|bowl|cup|box|serve|serving|servings)\s+)?([a-z]+(?:\s+[a-z]+)?)\b/gi;
    let match;
    
    // Process "do" separately with English exclusion
    while ((match = hindiDoRegex.exec(lowerText)) !== null) {
      let item = match[1]?.trim();
      const itemWords = item.split(/\s+/);
      const cleanedWords = itemWords.filter(w => 
        !restaurantWords.some(rw => w === rw || rw.includes(w) || w.includes(rw))
      );
      item = cleanedWords.join(' ').trim();
      
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.toLowerCase() === w.toLowerCase());
        const isSkipWord = skipWords.some(w => item.split(/\s+/).some(word => w === word));
        if (!hasRestaurantWord && !isSkipWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Process other Hindi numbers
    while ((match = hindiNumRegex.exec(lowerText)) !== null) {
      let item = match[2]?.trim();
      // Split into words and filter out restaurant-related words
      const itemWords = item.split(/\s+/);
      // Only keep words that are likely food (not restaurant names)
      const cleanedWords = itemWords.filter(w => 
        !restaurantWords.some(rw => w === rw || rw.includes(w) || w.includes(rw))
      );
      item = cleanedWords.join(' ').trim();
      
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.toLowerCase() === w.toLowerCase());
        const isSkipWord = skipWords.some(w => item.split(/\s+/).some(word => w === word));
        if (!hasRestaurantWord && !isSkipWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Pattern 2b: "DIGIT + [UNIT] + FOOD" pattern
    // e.g., "2 paneer tikka", "10 momos", "400 grm gulkand" -> "gulkand"
    // ✅ FIXED: Optional unit-word skip so "400 grm gulkand" → food="gulkand" not "grm gulkand"
    const digitFoodPattern = /(\d+)\s+(?:(?:plate|plates|kg|g|gm|grm|gram|grams|piece|pc|pieces|packet|packets|glass|bowl|cup|box|serve|serving|servings)\s+)?([a-z]+(?:\s+[a-z]+)?(?:\s+[a-z]+)?)(?=\s+(?:and|aur|from|se\b|order|chahiye|,|[A-Z])|$)/gi;
    while ((match = digitFoodPattern.exec(lowerText)) !== null) {
      let item = match[2]?.trim();
      // If item has multiple words, check if last word looks like restaurant
      const itemWords = item.split(/\s+/);
      const cleanedWords = itemWords.filter(w => 
        !restaurantWords.some(rw => w === rw || rw.includes(w) || w.includes(rw))
      );
      item = cleanedWords.join(' ').trim();
      
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        const isSkipWord = skipWords.some(w => item.split(/\s+/).some(word => w === word));
        if (!hasRestaurantWord && !isSkipWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Pattern 3: Food before "se" (when ordering from restaurant)
    // e.g., "paneer tikka inayat se" - extract "paneer tikka"
    // But NOT "inayat cafe se" (that's a restaurant)
    const beforeSePattern = /([a-z][a-z\s]{2,20}?)\s+(?:[a-z]+\s+)?se\s+(?:bhej|manga|order|lao)/gi;
    while ((match = beforeSePattern.exec(lowerText)) !== null) {
      const item = match[1]?.trim();
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Pattern 3b: "FOOD RESTAURANT se order/karo/bhej" with capitalized restaurant
    // e.g., "paneer butter masala Punjabi Kitchen se order karo"
    // Strategy: Look for lowercase food words followed by Capitalized words (restaurant) then "se"
    const foodRestaurantSePattern = /^([a-z][a-z\s]{2,30}?)\s+(?:[A-Z][a-zA-Z\s]+?\s+)?se\s+(?:order|karo|bhej|manga|lao)/i;
    const foodRestSeMatch = text.match(foodRestaurantSePattern);
    if (foodRestSeMatch && foodRestSeMatch[1]) {
      let item = foodRestSeMatch[1].trim().toLowerCase();
      // Clean trailing words that might be start of restaurant name
      const words = item.split(/\s+/);
      // Remove words that are likely restaurant starters (single capital word at end)
      while (words.length > 1) {
        const lastWord = words[words.length - 1];
        // If last word is a common food suffix, keep it
        const foodSuffixes = ['masala', 'curry', 'tikka', 'paneer', 'chicken', 'rice', 'biryani', 'naan', 'roti', 'dal'];
        if (foodSuffixes.some(f => lastWord.includes(f))) break;
        // If last word starts with capital in original, it's likely restaurant
        const originalPos = text.toLowerCase().indexOf(lastWord);
        if (originalPos > 0 && text[originalPos] === text[originalPos].toUpperCase()) {
          words.pop();
        } else {
          break;
        }
      }
      item = words.join(' ').trim();
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Hindi pronoun/prefix words to strip from food extractions
    const hindiPrefixes = ['mujhe', 'hume', 'humko', 'mereko', 'chahiye', 'chaiye', 'i want', 'want', 'give me', 'get me', 'please', 'jaldi', 'abhi', 'turant', 'urgent'];
    
    // Common connector words that are NOT food items
    const connectorWords = ['and', 'aur', 'or', 'ya', 'with', 'ke', 'ka', 'ki', 'se', 'me', 'the', 'a', 'an', 'jaldi', 'abhi', 'please'];
    
    // Pattern 4: FOOD "from" RESTAURANT (critical pattern!)
    // e.g., "paneer tikka from inayat cafe" -> "paneer tikka"
    // e.g., "2 paneer tikka, 3 butter naan and 1 dal makhani from inayat cafe" -> all items
    const beforeFromMatch = lowerText.match(/^(.+?)\s+from\s+/i);
    if (beforeFromMatch && beforeFromMatch[1]) {
      let itemsPart = beforeFromMatch[1].trim();
      
      // Extract individual items (handles "2 X, 3 Y and 1 Z" format)
      const itemPattern = /(?:\d+\s+)?([a-z][a-z\s]+?)(?=\s*(?:,|and|aur|\d+|from|$))/gi;
      let itemMatch;
      while ((itemMatch = itemPattern.exec(itemsPart)) !== null) {
        let item = itemMatch[1].trim();
        // Remove Hindi prefixes
        for (const prefix of hindiPrefixes) {
          if (item.toLowerCase().startsWith(prefix + ' ')) {
            item = item.substring(prefix.length + 1).trim();
          }
        }
        // Skip if item is a common connector word
        if (connectorWords.includes(item.toLowerCase())) {
          continue;
        }
        if (item && item.length > 2) {
          const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
          if (!hasRestaurantWord && !found.includes(item)) {
            found.push(item);
          }
        }
      }
      
      // Fallback: simple extraction if pattern didn't match
      if (found.length === 0) {
        let item = itemsPart;
        // Remove Hindi prefixes
        for (const prefix of hindiPrefixes) {
          if (item.toLowerCase().startsWith(prefix + ' ')) {
            item = item.substring(prefix.length + 1).trim();
          }
        }
        if (item && item.length > 2 && !connectorWords.includes(item.toLowerCase())) {
          const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
          if (!hasRestaurantWord && !found.includes(item)) {
            found.push(item);
          }
        }
      }
    }
    
    // Pattern 5: Hindi "mujhe X chahiye Y se" or "mujhe X chahiye"
    // e.g., "mujhe paneer tikka chahiye inayat cafe se" -> "paneer tikka"
    const hindiChahiyeMatch = lowerText.match(/(?:mujhe|hume|humko|mereko)\s+(.+?)\s+(?:chahiye|chaiye|do|dena|bhejo)/i);
    if (hindiChahiyeMatch && hindiChahiyeMatch[1]) {
      const item = hindiChahiyeMatch[1].trim();
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }

    // Pattern 5b: "QTY FOOD STORE se bhej/order" - quantity first, then food, then store
    // e.g., "3 momos wow momo se bhej do" -> food="momos", store="wow momo"
    // e.g., "5 bucket kfc se lao" -> food="bucket", store="kfc"
    // Strategy: FOOD is single word (most common), STORE is 1-2 words
    const qtyFoodStoreSePattern = /^(\d+)\s+(\w+)\s+(\w+(?:\s+\w+)?)\s+se\s+(?:bhej|order|manga|lao)(?:\s+(?:do|de|karo))?\s*$/i;
    const qtyFoodStoreSeMatch = lowerText.match(qtyFoodStoreSePattern);
    if (qtyFoodStoreSeMatch && qtyFoodStoreSeMatch[2]) {
      // Extract food (group 2) - single word
      let item = qtyFoodStoreSeMatch[2].trim();
      // Skip if it's a unit word
      const unitWords = ['piece', 'pieces', 'pc', 'pcs', 'plate', 'plates', 'kg', 'g', 'gm'];
      if (!unitWords.includes(item.toLowerCase()) && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
          this.logger.debug(`Extracted food from "QTY FOOD STORE se" pattern: "${item}"`);
        }
      }
    }

    // Pattern 5c: "FOOD chahiye STORE se" - food before chahiye, store after
    // e.g., "biryani chahiye paradise se" -> "biryani"
    // e.g., "mujhe biryani chahiye paradise se" -> "biryani"
    const foodChahiyeMatch = lowerText.match(/(?:mujhe\s+)?([a-z]+(?:\s+[a-z]+)?)\s+(?:chahiye|chaiye|mangta|mangti)\s+\w+(?:\s+\w+)?\s+se\b/i);
    if (foodChahiyeMatch && foodChahiyeMatch[1]) {
      const item = foodChahiyeMatch[1].trim();
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Pattern 6: FOOD "at" RESTAURANT
    // e.g., "paneer tikka at inayat cafe" -> "paneer tikka"
    const beforeAtPattern = /^([a-z][a-z\s]{2,30}?)\s+at\s+/i;
    const beforeAtMatch = lowerText.match(beforeAtPattern);
    if (beforeAtMatch && beforeAtMatch[1]) {
      let item = beforeAtMatch[1].trim();
      // Remove Hindi prefixes
      for (const prefix of hindiPrefixes) {
        if (item.toLowerCase().startsWith(prefix + ' ')) {
          item = item.substring(prefix.length + 1).trim();
        }
      }
      if (item && item.length > 2) {
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item)) {
          found.push(item);
        }
      }
    }
    
    // Pattern 7: Implicit food order (conversational)
    // Just the food name at start of sentence
    // e.g., "paneer tikka please", "butter chicken", "biryani chahiye"
    if (found.length === 0) {
      // Try to extract leading food-like words (2-4 words at start)
      // ✅ Added "hai/hain/ho" to stop words so "misal hai" captures just "misal"
      const leadingMatch = lowerText.match(/^([a-z][a-z\s]{2,30}?)(?:\s+(?:please|from|at|se|bhej|order|chahiye|hai|hain|ho|kya)|$)/i);
      if (leadingMatch && leadingMatch[1]) {
        let item = leadingMatch[1].trim();
        // ✅ Also remove trailing Hindi helper verbs
        item = item.replace(/\s+(hai|hain|ho|tha|the|thi|ka|ki|ke|ko|me|mein|kya)\s*$/gi, '').trim();
        // Skip if it's just a greeting or command
        const greetings = ['hi', 'hello', 'hey', 'good morning', 'good evening', 'good night', 'namaste'];
        const commands = ['show', 'find', 'search', 'look', 'get', 'give', 'track', 'where'];
        const isGreeting = greetings.some(g => item.startsWith(g));
        const isCommand = commands.some(c => item.startsWith(c));
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        
        if (!isGreeting && !isCommand && !hasRestaurantWord && item.length > 2) {
          found.push(item);
          this.logger.debug(`Extracted food from Pattern 7 (implicit): "${item}"`);
        }
      }
    }
    
    // Pattern 8: "I want X and Y" pattern (without quantities)
    // e.g., "I want butter chicken and paneer butter masala" -> ["butter chicken", "paneer butter masala"]
    const wantAndPattern = /(?:i\s+)?want\s+(.+?)\s+and\s+(.+?)(?:\s+from|\s+at|\s*$)/i;
    const wantAndMatch = lowerText.match(wantAndPattern);
    if (wantAndMatch) {
      const items = [wantAndMatch[1]?.trim(), wantAndMatch[2]?.trim()].filter(Boolean);
      for (let item of items) {
        // Clean leading articles/pronouns
        item = item.replace(/^(a|an|the|some)\s+/i, '').trim();
        if (item && item.length > 2 && !found.includes(item)) {
          const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
          if (!hasRestaurantWord) {
            found.push(item);
          }
        }
      }
    }
    
    // Pattern 9: "RESTAURANT ka/ke/ki FOOD" pattern (Hindi possessive)
    // e.g., "ganesh sweet ka paneer 1kg" -> extract "paneer"
    // e.g., "dominos ka pizza" -> extract "pizza"
    // e.g., "inayat cafe ki biryani" -> extract "biryani"
    const kaPattern = /\b(?:[a-z]+\s*)+\s+(?:ka|ke|ki)\s+([a-z][a-z\s]*?)(?:\s+\d|$|\s+(?:order|chahiye|bhej|manga|please))/gi;
    let kaMatch;
    while ((kaMatch = kaPattern.exec(lowerText)) !== null) {
      let item = kaMatch[1]?.trim();
      if (item && item.length > 2) {
        // Remove trailing quantity/unit words
        item = item.replace(/\s*\d+\s*(?:kg|g|gm|gram|piece|pc|plate)?\s*$/i, '').trim();
        const hasRestaurantWord = restaurantWords.some(w => item.includes(w));
        if (!hasRestaurantWord && !found.includes(item) && item.length > 2) {
          found.push(item);
          this.logger.debug(`Extracted food from "X ka Y" pattern: "${item}"`);
        }
      }
    }

    // Pattern 10: "STORE FOOD QUANTITY" without "ka" (English-style)
    // e.g., "Ganesh paneer 1kg" -> extract "paneer"
    // e.g., "dominos pizza large" -> extract "pizza"
    // First word is likely store name, middle word(s) are food, last is quantity/size
    if (found.length === 0) {
      // Match: WORD FOOD_WORD(s) [QUANTITY/SIZE]
      const storeFoodQtyPattern = /^([a-z]+)\s+([a-z][a-z\s]+?)\s*(\d+\s*(?:kg|g|gm|gram|piece|pc|plate|pieces)?|small|medium|large|regular)?$/i;
      const sfqMatch = lowerText.match(storeFoodQtyPattern);
      if (sfqMatch && sfqMatch[2]) {
        let foodItem = sfqMatch[2].trim();
        // Remove trailing quantity if it got included
        foodItem = foodItem.replace(/\s*\d+\s*(?:kg|g|gm|gram|piece|pc|plate|pieces)?\s*$/i, '').trim();
        const hasRestaurantWord = restaurantWords.some(w => foodItem.includes(w));
        if (!hasRestaurantWord && foodItem.length > 2 && !found.includes(foodItem)) {
          found.push(foodItem);
          this.logger.debug(`Extracted food from "STORE FOOD QTY" pattern: "${foodItem}"`);
        }
      }
    }

    // Pattern 11: "QUANTITY FOOD RESTAURANT" without 'from'/'se' (direct ordering)
    // e.g., "2 butter naan bhagat tarachand" -> extract "butter naan"
    // Last word(s) are likely restaurant name
    if (found.length === 0) {
      // Check if last 1-2 words could be a restaurant name (proper nouns)
      const words = lowerText.split(/\s+/);
      if (words.length >= 3) {
        const firstWord = words[0];
        // If first word is a number, food is between number and restaurant
        if (/^\d+$/.test(firstWord) || Object.keys(this.HINDI_NUMBERS).includes(firstWord)) {
          // Take middle words as food, skip last 1-2 words (restaurant)
          // Heuristic: restaurant names are usually 1-2 words at end
          const numRestaurantWords = words.length >= 5 ? 2 : 1;
          const foodWords = words.slice(1, words.length - numRestaurantWords);
          const foodItem = foodWords.join(' ').trim();
          const hasRestaurantWord = restaurantWords.some(w => foodItem.includes(w));
          if (!hasRestaurantWord && foodItem.length > 2 && !found.includes(foodItem)) {
            found.push(foodItem);
            this.logger.debug(`Extracted food from "QTY FOOD RESTAURANT" pattern: "${foodItem}"`);
          }
        }
      }
    }

    // Pattern 12: "FOOD QUANTITY and FOOD QUANTITY... RESTAURANT" (complex multi-item order)
    // e.g., "paneer butter masala 1 and 1 rice jeera and 2 butter roti greenfield"
    // Food items are before quantities, restaurant is at the end
    if (lowerText.includes(' and ') || lowerText.includes(' aur ')) {
      // Try to extract items in "FOOD QTY" format (including first item which has no preceding 'and')
      // First, extract items that are followed by "QTY and"
      const foodQtyPattern = /([a-z][a-z\s]+?)\s+(\d+)\s+(?:and|aur)/gi;
      let fqMatch;
      while ((fqMatch = foodQtyPattern.exec(lowerText)) !== null) {
        let foodItem = fqMatch[1]?.trim();
        // Remove leading connectors
        foodItem = foodItem.replace(/^(and|aur)\s+/i, '').trim();
        const hasRestaurantWord = restaurantWords.some(w => foodItem.includes(w));
        if (!hasRestaurantWord && foodItem.length > 2 && !found.includes(foodItem)) {
          found.push(foodItem);
          this.logger.debug(`Extracted food from "FOOD QTY and..." pattern: "${foodItem}"`);
        }
      }
      
      // Also extract items in "and QTY FOOD" format (items after 'and')
      const andQtyFoodPattern = /(?:and|aur)\s+(\d+)\s+([a-z][a-z\s]+?)(?=\s+(?:and|aur|\d+|$))/gi;
      let aqfMatch;
      while ((aqfMatch = andQtyFoodPattern.exec(lowerText)) !== null) {
        let foodItem = aqfMatch[2]?.trim();
        const hasRestaurantWord = restaurantWords.some(w => foodItem.includes(w));
        if (!hasRestaurantWord && foodItem.length > 2 && !found.includes(foodItem)) {
          found.push(foodItem);
          this.logger.debug(`Extracted food from "...and QTY FOOD" pattern: "${foodItem}"`);
        }
      }
      
      // Also extract the last item before restaurant (no trailing 'and')
      // e.g., "2 butter roti greenfield" - extract "butter roti"
      const lastItemPattern = /(?:and|aur)\s+(\d+)\s+([a-z][a-z\s]+?)\s+([a-z]+)\s*$/i;
      const lastMatch = lowerText.match(lastItemPattern);
      if (lastMatch && lastMatch[2]) {
        let foodItem = lastMatch[2].trim();
        const hasRestaurantWord = restaurantWords.some(w => foodItem.includes(w));
        if (!hasRestaurantWord && foodItem.length > 2 && !found.includes(foodItem)) {
          found.push(foodItem);
          this.logger.debug(`Extracted food from "...and QTY FOOD RESTAURANT" pattern: "${foodItem}"`);
        }
      }
    }

    // Pattern 13: Availability queries - "FOOD milega/available/hai"
    // e.g., "paneer milega?" -> "paneer"
    // e.g., "pizza hai kya?" -> "pizza"
    // e.g., "biryani available?" -> "biryani"
    const availabilityPatterns = [
      /^([a-z][a-z\s]{2,20}?)\s+(?:milega|milegi|milte|milti|available|hai|hain)\s*\??$/i,
      /^([a-z][a-z\s]{2,20}?)\s+(?:mil|mila)\s+(?:jayega|jayegi|sakta|sakti)\s*\??$/i,
      /^(?:kya|is|do you have)\s+([a-z][a-z\s]{2,20}?)\s+(?:available|hai|milega|milti)\s*\??$/i,
      /^([a-z][a-z\s]{2,20}?)\s+(?:hai|hain)\s*(?:kya)?\s*\??$/i,
    ];
    
    for (const pattern of availabilityPatterns) {
      const match = lowerText.match(pattern);
      if (match && match[1]) {
        const item = match[1].trim();
        if (item.length > 2 && !found.includes(item)) {
          found.push(item);
          this.logger.debug(`Extracted food from availability pattern: "${item}"`);
        }
      }
    }

    // Final cleanup: Remove leading "and"/"aur"/urgency words from any extracted items
    const urgencyWords = ['jaldi', 'abhi', 'turant', 'urgent', 'asap', 'please'];
    const locationFilterWords = ['ghar', 'home', 'office', 'dukan', 'school', 'bike', 'auto', 'car', 'wala', 'wali'];
    const actionFilterWords = ['payment', 'link', 'otp', 'bill', 'receipt', 'send', 'kardo', 'kar', 'bhej', 'bhejo'];
    // Unit words that should be removed from food item names
    const unitWords = ['grams', 'gram', 'kg', 'g', 'gm', 'piece', 'pieces', 'pc', 'pcs', 'plate', 'plates', 
                       'packet', 'packets', 'box', 'boxes', 'small', 'medium', 'large', 'regular', 'half', 'full'];
    
    // Hindi number words that should be stripped from food names
    const hindiNumberWords = ['ek', 'do', 'teen', 'char', 'paanch', 'panch', 'chhah', 'chha', 
                              'saat', 'aath', 'nau', 'das', 'gyarah', 'barah'];
    
    // Generic food context words that should NOT be extracted as specific items
    // These indicate "I want food" generically, not a specific dish
    const genericFoodWords = ['food', 'khana', 'khaana', 'meal', 'snack', 'breakfast', 'lunch', 'dinner', 
                              'nashta', 'order', 'something', 'anything', 'kuch', 'to order', 'to  food', 'order food'];
    
    const cleaned = found.map(item => {
      let cleanItem = item.replace(/^(and|aur)\s+/i, '').trim();
      // Also remove trailing "and"/"aur"
      cleanItem = cleanItem.replace(/\s+(and|aur)$/i, '').trim();
      // Remove leading Hindi number words (e.g., "teen chai" -> "chai", "ek samosa" -> "samosa")
      for (const hn of hindiNumberWords) {
        cleanItem = cleanItem.replace(new RegExp(`^${hn}\\s+`, 'i'), '').trim();
      }
      // Remove leading unit words (e.g., "grams paneer" -> "paneer")
      for (const uw of unitWords) {
        cleanItem = cleanItem.replace(new RegExp(`^${uw}\\s+`, 'i'), '').trim();
      }
      // Remove trailing action verbs (e.g., "bucket lao" -> "bucket")
      const trailingActionWords = ['lao', 'bhej', 'bhejo', 'order', 'manga', 'karo', 'kar', 'do', 'de', 'dena', 'dijiye', 'dedo'];
      for (const aw of trailingActionWords) {
        cleanItem = cleanItem.replace(new RegExp(`\\s+${aw}$`, 'i'), '').trim();
      }
      // Remove leading urgency words
      cleanItem = cleanItem.replace(/\s+(and|aur)$/i, '').trim();
      // Remove leading urgency words
      for (const uw of urgencyWords) {
        cleanItem = cleanItem.replace(new RegExp(`^${uw}\\s+`, 'i'), '').trim();
      }
      // Remove "to" prefix (from "to order food" -> "order food" -> skip)
      cleanItem = cleanItem.replace(/^to\s+/i, '').trim();
      return cleanItem;
    }).filter(item => {
      // Filter out items that are location/transport words
      if (item.length <= 2) return false;
      const words = item.toLowerCase().split(/\s+/);
      // If any word in the item is a location/transport word and it's a single word, skip it
      if (words.length === 1 && locationFilterWords.includes(words[0])) return false;
      // If item contains action words like payment/link/otp, skip it (not food)
      for (const aw of actionFilterWords) {
        if (item.toLowerCase().includes(aw)) return false;
      }
      // If item contains urgency words as standalone, skip it
      for (const uw of urgencyWords) {
        if (item.toLowerCase() === uw || item.toLowerCase().startsWith(uw + ',')) return false;
      }
      // Filter out generic food words that are not specific dishes
      if (genericFoodWords.includes(item.toLowerCase())) return false;
      return true;
    });

    // Deduplicate
    const deduped = [...new Set(cleaned)];
    
    // Merge overlapping items (e.g., "paneer" + "butter masala" -> "paneer butter masala")
    return this.mergeOverlappingFoodItems(deduped, text);
  }
  
  /**
   * Merge overlapping food items
   * e.g., ["paneer", "butter masala"] when original text has "paneer butter masala"
   */
  private mergeOverlappingFoodItems(items: string[], originalText: string): string[] {
    if (items.length <= 1) return items;
    
    const lowerText = originalText.toLowerCase();
    const merged: string[] = [];
    const used = new Set<number>();
    
    // Sort by length (longest first) to prefer complete items
    const sorted = [...items].sort((a, b) => b.length - a.length);
    
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      
      let current = sorted[i];
      
      // Check if any other items can be combined with this one
      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(j)) continue;
        
        const other = sorted[j];
        
        // Check if "other + current" or "current + other" appears in original text
        const combined1 = `${other} ${current}`;
        const combined2 = `${current} ${other}`;
        
        if (lowerText.includes(combined1)) {
          current = combined1;
          used.add(j);
        } else if (lowerText.includes(combined2)) {
          current = combined2;
          used.add(j);
        } else if (current.includes(other) || other.includes(current)) {
          // One is substring of other, keep the longer one
          used.add(j);
        }
      }
      
      merged.push(current);
      used.add(i);
    }
    
    return [...new Set(merged)];
  }

  /**
   * Extract restaurant name
   */
  private extractRestaurantName(text: string): string | null {
    const lowerText = text.toLowerCase();
    
    // Common words to skip (not restaurant names)
    // ✅ FIX: Added common English verbs like 'show', 'give', 'get', 'find', 'search', 'please'
    // These get incorrectly matched as store names when followed by 'me' (misinterpreted as Hindi 'mein')
    const skipWords = ['mujhe', 'ghar', 'abhi', 'jaldi', 'aur', 'and', 'the', 'a', 'an', 'is', 'are', 'from', 'to', 
                       'payment', 'pay', 'link', 'otp', 'bill', 'receipt', 'office', 'home', 'school',
                       // English command verbs that should never be restaurant names
                       'show', 'give', 'get', 'find', 'search', 'please', 'help', 'want', 'need', 'order',
                       'send', 'bring', 'fetch', 'make', 'let', 'tell', 'have', 'can', 'will', 'would', 'could'];
    
    // Pattern 0: "NAME restro/resto se" - common Hindi shortform for restaurant
    // e.g., "demo restro se" -> "demo restro"
    const restroMatch = lowerText.match(/(\w+)\s+(restro|resto)\s+se\b/i);
    if (restroMatch && restroMatch[1]) {
      const name = restroMatch[1].trim();
      if (!skipWords.includes(name) && name.length > 2) {
        return `${name} restro`;
      }
    }
    
    // Pattern 1: Look for "NAME cafe/hotel/restaurant se" 
    // The NAME should be a single word NOT in our food list
    // e.g., "inayat cafe se" -> "inayat cafe"
    const venueTypes = ['cafe', 'hotel', 'restaurant', 'dhaba'];
    for (const venue of venueTypes) {
      const pattern = new RegExp(`(\\w+)\\s+${venue}\\s+se\\b`, 'i');
      const match = lowerText.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Skip if name is a common word (food items resolved by EntityResolutionService)
        if (!skipWords.includes(name) && name.length > 2) {
          return `${name} ${venue}`;
        }
      }
    }
    
    // Pattern 2: "hotel/cafe NAME se" - venue type before name
    // e.g., "hotel taj se" -> "hotel taj"
    for (const venue of venueTypes) {
      const pattern = new RegExp(`${venue}\\s+(\\w+(?:\\s+\\w+)?)\\s+se\\b`, 'i');
      const match = lowerText.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Return the venue + name (resolution happens in EntityResolutionService)
        return `${venue} ${name}`;
      }
    }
    
    // Pattern 3: "NAME se khana/mangwana/order/bhej" - name before "se" + action verb
    // e.g., "inayat se khana mangwana hai" -> "inayat"
    // e.g., "momo magic se order karna hai" -> "momo magic"
    // Common food words that should NOT be treated as restaurant names
    const commonFoodWords = [
      'chai', 'coffee', 'dosa', 'idli', 'vada', 'samosa', 'biryani', 'pizza', 'burger',
      'momos', 'noodles', 'paratha', 'roti', 'naan', 'thali', 'paneer', 'chicken', 'mutton',
      'rice', 'dal', 'curry', 'sabzi', 'lassi', 'juice', 'shake', 'tea'
    ];
    
    // Pattern 3a: "NAME se FOOD bhej/manga do/de" - Hindi order pattern
    // CRITICAL: This pattern handles "dominos se paneer tikka bhej do" -> extract "dominos"
    // The pattern: STORE se FOOD ACTION_VERB HELPER_VERB
    const seActionMatch = lowerText.match(/^(\w+(?:\s+\w+)?)\s+se\s+.+?\s+(?:bhej|manga|lao|order|send)(?:\s+(?:do|de|dena|karo|kar|dijiye))?\s*$/i);
    if (seActionMatch && seActionMatch[1]) {
      let name = seActionMatch[1].trim();
      // Skip if it's a common food word or skip word
      if (!skipWords.includes(name.toLowerCase()) && 
          !commonFoodWords.includes(name.toLowerCase()) && 
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "NAME se FOOD bhej do" pattern: "${name}"`);
        return name;
      }
    }
    
    // Pattern 3b: "NAME se FOOD chahiye/manga" - desire pattern without helper verb
    // e.g., "haldirams se namkeen chahiye" -> "haldirams"
    // e.g., "mcd se burger chahiye" -> "mcd"
    // e.g., "dominos se pizza manga do" -> "dominos"
    const seFoodMatch = lowerText.match(/^(\w+(?:\s+\w+)?)\s+se\s+\w+(?:\s+\w+)?\s+(?:chahiye|chaiye|mangado|manga|do|de|dedo|dijiye|dena|lao|bhejo)\b/i);
    if (seFoodMatch && seFoodMatch[1]) {
      let name = seFoodMatch[1].trim();
      if (!skipWords.includes(name.toLowerCase()) && 
          !commonFoodWords.includes(name.toLowerCase()) && 
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "NAME se FOOD chahiye" pattern: "${name}"`);
        return name;
      }
    }
    
    // Pattern 3c: "NAME se khana/mangwana/order/bhej" - action verb patterns
    const seKhanaMatch = lowerText.match(/(\w+(?:\s+\w+)?)\s+se\s+(?:khana|khaana|mangwana|mangana|order|bhej|lana|lena|lao)/i);
    if (seKhanaMatch && seKhanaMatch[1]) {
      let name = seKhanaMatch[1].trim();
      // Remove any leading skip words like "mujhe", "ghar" etc.
      const nameWords = name.split(/\s+/);
      // Filter out skip words AND common food words
      const filteredWords = nameWords.filter(word => 
        !skipWords.includes(word.toLowerCase()) && 
        !commonFoodWords.includes(word.toLowerCase())
      );
      name = filteredWords.join(' ').trim();
      
      // Only return if we have a meaningful name left (not just food words)
      if (name.length > 2 && filteredWords.length > 0) {
        return name;
      }
    }

    // Pattern 3d: "QTY FOOD STORE se bhej/order/manga" - quantity first, then food, then store
    // e.g., "3 momos wow momo se bhej do" -> "wow momo"
    const qtyFoodStoreSe = lowerText.match(/^\d+\s+\w+(?:\s+\w+)?\s+(\w+(?:\s+\w+)?)\s+se\s+(?:bhej|order|manga|lao)(?:\s+(?:do|de|karo))?\s*$/i);
    if (qtyFoodStoreSe && qtyFoodStoreSe[1]) {
      const name = qtyFoodStoreSe[1].trim();
      if (!skipWords.includes(name.toLowerCase()) && 
          !commonFoodWords.includes(name.toLowerCase()) && 
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "QTY FOOD STORE se" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 3e: "FOOD chahiye STORE se" - food first, then desire, then store with "se"
    // e.g., "biryani chahiye paradise se" -> "paradise"
    // e.g., "mujhe biryani chahiye paradise se" -> "paradise"
    const foodChahiyeStoreSe = lowerText.match(/(?:mujhe\s+)?[\w]+(?:\s+\w+)?\s+(?:chahiye|chaiye|mangta|mangti)\s+(\w+(?:\s+\w+)?)\s+se\b/i);
    if (foodChahiyeStoreSe && foodChahiyeStoreSe[1]) {
      const name = foodChahiyeStoreSe[1].trim();
      if (!skipWords.includes(name.toLowerCase()) && 
          !commonFoodWords.includes(name.toLowerCase()) && 
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "FOOD chahiye STORE se" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 3f: "NAME se [QTY] [UNIT] FOOD" - bare order without action verb
    // e.g., "tushar se 4 plate missal" -> "tushar"
    // e.g., "dominos se pizza" -> "dominos"
    // e.g., "tushar se missal" -> "tushar"
    // e.g., "dagu teli se, ek 400 grm gulkand ghar bhej dena" -> "dagu teli"
    // FIXED: Allow comma/punctuation after "se" (se, ek ... pattern)
    // FIXED: Added grm/grms to unit word list
    const seBareFoodMatch = lowerText.match(/^(\w+(?:\s+\w+)?)\s+se[,\s]\s*(?:(?:\d+|ek|do|teen|char|paanch|panch|chhah|saat|aath|nau|das)\s+)?(?:(?:plate|plates|kg|g|gm|grm|gram|grams|piece|pc|pieces|packet|packets|glass|bowl|cup|box|serve|serving|servings)\s+)?\w/i);
    if (seBareFoodMatch && seBareFoodMatch[1]) {
      const name = seBareFoodMatch[1].trim();
      // Guard: skip if captured name contains unit words (e.g., "ek plate" → not a store)
      const unitWords = ['plate', 'plates', 'kg', 'g', 'gm', 'grm', 'gram', 'grams', 'piece', 'pc', 'pieces', 'packet', 'packets', 'glass', 'bowl', 'cup', 'box', 'serve', 'serving', 'servings'];
      const hindiNumbers = ['ek', 'do', 'teen', 'char', 'paanch', 'panch', 'chhah', 'saat', 'aath', 'nau', 'das', 'gyarah', 'barah'];
      const nameWords = name.split(/\s+/);
      if (!skipWords.includes(name.toLowerCase()) &&
          !commonFoodWords.includes(name.toLowerCase()) &&
          !hindiNumbers.includes(name.toLowerCase()) &&
          !nameWords.some(w => unitWords.includes(w.toLowerCase())) &&
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "NAME se [QTY] FOOD" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 4: "from NAME NAME" at end - multi-word restaurant name (case insensitive)
    // e.g., "from bhagat tarachand" or "from Bhagat Tarachand"
    const fromEndMatch = text.match(/from\s+([a-z]+(?:\s+[a-z]+)+)\s*$/i);
    if (fromEndMatch && fromEndMatch[1]) {
      const name = fromEndMatch[1].trim();
      // Make sure it's not common words
      if (!['my home', 'the shop', 'a restaurant'].includes(name.toLowerCase())) {
        return name;
      }
    }
    
    // Pattern 5: "from NAME" anywhere (single word or multi-word)
    // e.g., "paneer tikka from inayat" -> "inayat"
    const fromMatch = text.match(/from\s+([a-z]+(?:\s+[a-z]+)?)/i);
    if (fromMatch && fromMatch[1]) {
      const name = fromMatch[1].trim();
      // Only skip common words (food items resolved by EntityResolutionService)
      if (!skipWords.includes(name.toLowerCase()) && name.length > 2) {
        return name;
      }
    }

    // Pattern 5b: "FOOD of STORENAME [delivered/send/...]" - common English ordering pattern
    // e.g., "missal pav of tushar delivered at home" → "tushar"
    // e.g., "1 plate pizza of dominos delivered" → "dominos"
    // e.g., "special misal of tushar misal send" → "tushar misal"
    const ofDeliveryMatch = text.match(/\bof\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:deliver|send|bhej|lao|order)/i);
    if (ofDeliveryMatch && ofDeliveryMatch[1]) {
      const name = ofDeliveryMatch[1].trim();
      if (!skipWords.includes(name.toLowerCase()) &&
          !commonFoodWords.includes(name.toLowerCase()) &&
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "of NAME delivery" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 5c: "of STORENAME" at end of sentence (no delivery verb needed)
    // e.g., "1 plate missal pav of tushar" → "tushar"
    // e.g., "order special misal of tushar" → "tushar"
    const ofEndMatch = text.match(/\bof\s+([a-z]+(?:\s+[a-z]+)?)\s*$/i);
    if (ofEndMatch && ofEndMatch[1]) {
      const name = ofEndMatch[1].trim();
      if (!skipWords.includes(name.toLowerCase()) &&
          !commonFoodWords.includes(name.toLowerCase()) &&
          name.length > 2) {
        this.logger.debug(`Extracted restaurant from "of NAME$" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 6: Capitalized proper noun "NAME se bhej/order" 
    const capitalMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+se\s+(?:bhej|order|manga)/);
    if (capitalMatch && capitalMatch[1]) {
      const name = capitalMatch[1].trim();
      // Just check length (food items resolved by EntityResolutionService)
      if (name.length > 2) {
        return name;
      }
    }

    // Pattern 7: "NAME ka/ki" pattern - possessive indicating brand/restaurant ownership
    // e.g., "dominos ka pizza" -> "dominos", "mcd ki burger" -> "mcd"
    const kaKiMatch = text.match(/\b([a-z]+(?:'s)?)\s+(?:ka|ki|ke)\s+\w+/i);
    if (kaKiMatch && kaKiMatch[1]) {
      const name = kaKiMatch[1].trim().replace(/'s$/i, '');
      // Skip only common words (food items resolved by EntityResolutionService)
      if (!skipWords.includes(name.toLowerCase()) && name.length > 2) {
        return name;
      }
    }

    // Pattern 8: "NAME FOOD QUANTITY" without "ka" (English-style)
    // e.g., "Ganesh paneer 1kg" -> "Ganesh"
    // e.g., "dominos pizza large" -> "dominos"
    // e.g., "Hotel tushar" -> "Hotel tushar" (venue + name = full restaurant name)
    // First word is likely store name
    // ✅ Skip if second word is a Hindi helper verb (availability pattern)
    // ✅ FIX: When first word is a venue type (hotel/cafe/etc.), combine with second word
    const hindiHelperVerbs = ['hai', 'hain', 'ho', 'tha', 'the', 'thi', 'kya', 'milega', 'milegi', 'milte', 'milti', 'available', 'chahiye', 'chaiye'];
    const storeFoodQtyPattern = /^([a-z]+)\s+([a-z]+)(?:\s+[a-z]+)?\s*(?:\d+\s*(?:kg|g|gm|gram|piece|pc|plate|pieces)?|small|medium|large|regular)?$/i;
    const sfqMatch = text.match(storeFoodQtyPattern);
    if (sfqMatch && sfqMatch[1] && sfqMatch[2]) {
      const name = sfqMatch[1].trim();
      const secondWord = sfqMatch[2].trim().toLowerCase();
      // Skip if second word is a Hindi helper verb (this is likely an availability query, not a store order)
      if (hindiHelperVerbs.includes(secondWord)) {
        // Don't extract as restaurant - let food patterns handle it
      } else if (venueTypes.includes(name.toLowerCase())) {
        // First word is a venue type (hotel, cafe, restaurant, dhaba)
        // Combine venue + second word as the FULL restaurant name
        // e.g., "Hotel tushar" → "Hotel tushar" (not just "Hotel")
        const fullName = `${name} ${sfqMatch[2].trim()}`;
        this.logger.debug(`Extracted restaurant from "VENUE NAME" pattern: "${fullName}"`);
        return fullName;
      } else if (!skipWords.includes(name.toLowerCase()) && name.length > 2) {
        this.logger.debug(`Extracted restaurant from "STORE FOOD QTY" pattern: "${name}"`);
        return name;
      }
    }

    // Pattern 9: "QUANTITY FOOD RESTAURANT" without 'from'/'se' (direct ordering)
    // e.g., "2 butter naan bhagat tarachand" -> "bhagat tarachand"
    // Last 1-2 words are restaurant name
    const words = lowerText.split(/\s+/);
    if (words.length >= 3) {
      const firstWord = words[0];
      // If first word is a number, last word(s) are likely restaurant
      if (/^\d+$/.test(firstWord)) {
        // Check if last 2 words could be multi-word restaurant name
        // Don't extract if last word looks like a quantity/unit
        const lastWord = words[words.length - 1];
        const secondLast = words.length >= 4 ? words[words.length - 2] : null;
        
        if (!/^\d+$/.test(lastWord) && !['kg', 'g', 'gm', 'gram', 'plate', 'piece'].includes(lastWord)) {
          // Check if 2-word restaurant name
          if (secondLast && !/^\d+$/.test(secondLast) && 
              !['and', 'aur', 'kg', 'g', 'gm', 'plate'].includes(secondLast) &&
              !skipWords.includes(secondLast)) {
            const restaurantName = `${secondLast} ${lastWord}`;
            this.logger.debug(`Extracted restaurant from "QTY FOOD RESTAURANT" pattern: "${restaurantName}"`);
            return restaurantName;
          }
          // Single word restaurant
          if (!skipWords.includes(lastWord) && lastWord.length > 2) {
            this.logger.debug(`Extracted restaurant from "QTY FOOD RESTAURANT" pattern: "${lastWord}"`);
            return lastWord;
          }
        }
      }
    }

    // Pattern 10: "FOOD QUANTITY and... RESTAURANT" (complex multi-item order)
    // e.g., "paneer butter masala 1 and 1 rice jeera and 2 butter roti greenfield" -> "greenfield"
    // Restaurant is the last word when there are multiple "and" patterns
    if (lowerText.includes(' and ')) {
      const lastWord = words[words.length - 1];
      if (!skipWords.includes(lastWord) && 
          !/^\d+$/.test(lastWord) && 
          !['kg', 'g', 'gm', 'gram', 'plate', 'piece'].includes(lastWord) &&
          lastWord.length > 2) {
        // Make sure it's not a food item (doesn't have "and QTY" before it)
        const lastFewWords = words.slice(-3).join(' ');
        if (!/\d+\s+\w+$/.test(lastFewWords) || words.length > 6) {
          this.logger.debug(`Extracted restaurant from multi-item order: "${lastWord}"`);
          return lastWord;
        }
      }
    }

    // REMOVED: Hardcoded known brands (Pattern 8)
    // Brand names are now resolved via EntityResolutionService using OpenSearch
    // This allows dynamic brand discovery and fuzzy matching

    // Check for "Demo restaurant" pattern (test data)
    const demoMatch = text.match(/demo\s+restaurant/i);
    if (demoMatch) return 'Demo restaurant';

    return null;
  }

  /**
   * Extract quantity (numbers + units) including Hindi numbers
   */
  private extractQuantity(text: string): string | null {
    const lowerText = text.toLowerCase();
    
    // Hindi numbers sorted by priority (longest first to avoid "do" matching in "bhej do")
    // Also need to avoid matching "do" when it's part of action phrases like "bhej do", "kar do"
    const actionPhrases = ['bhej do', 'kar do', 'de do', 'bata do', 'la do', 'bhejo', 'karo', 'dedo', 'batado', 'lado'];
    
    // ✅ English phrases where "do" is NOT a Hindi number
    const doEnglishPhrases = ['do you', 'do they', 'do we', 'do i', 'do not', "don't", 'do it'];
    
    // Check for Hindi number words at the START of text or after common prefixes
    // Pattern: Hindi number followed by a food word (not part of action verb)
    const hindiNumberPriority = [
      ['gyarah', 11], ['barah', 12], ['paanch', 5], ['chhah', 6], ['saat', 7], 
      ['aath', 8], ['teen', 3], ['char', 4], ['panch', 5], ['chha', 6],
      ['das', 10], ['nau', 9], ['ek', 1], ['do', 2], ['dozen', 12]
    ] as const;
    
    for (const [word, num] of hindiNumberPriority) {
      // For "do" specifically, make sure it's not part of action phrases OR English phrases
      if (word === 'do') {
        // Check if "do" is part of English phrase (e.g., "do you have")
        const isEnglishPhrase = doEnglishPhrases.some(phrase => lowerText.startsWith(phrase) || lowerText.includes(` ${phrase}`));
        if (isEnglishPhrase) {
          continue; // Skip "do" if it's an English phrase
        }
        
        // Check if "do" is part of action phrase
        const isActionPhrase = actionPhrases.some(phrase => lowerText.includes(phrase));
        if (isActionPhrase) {
          // Only match "do" if it's at the start followed by a word
          const startMatch = lowerText.match(new RegExp(`^${word}\\s+[a-z]`, 'i'));
          if (startMatch) {
            return String(num);
          }
          continue; // Skip "do" if it's an action phrase
        }
      }
      
      // Match Hindi number followed by a noun (food item)
      const regex = new RegExp(`(?:^|\\s)${word}\\s+([a-z])`, 'i');
      if (regex.test(lowerText)) {
        return String(num);
      }
    }

    const patterns = [
      /(\d+)\s*(?:plate|plates|piece|pieces|serving|servings|nos?|number)/i,
      /(\d+)\s*(?:kg|gram|gm|g|liter|litre|l|ml)/i,
      /(\d+)\s+(?:of|items?|qty)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }

    // Extract all numbers for multi-item orders
    const numbers = text.match(/\b(\d{1,3})\b/g);
    if (numbers && numbers.length > 0) {
      // Return first number if single, or comma-separated if multiple
      return numbers.length === 1 ? numbers[0] : numbers.join(',');
    }

    return null;
  }

  /**
   * Extract multiple quantities with their associated items
   * Returns structured cart data for complex orders
   */
  // Action words that should be removed from product names
  private readonly ACTION_WORDS = [
    'bhej', 'bhejo', 'manga', 'mangwao', 'lao', 'do', 'dena', 'order', 'karo', 'karwa',
    'chahiye', 'want', 'need', 'please', 'jaldi', 'abhi', 'from', 'se', 'pe', 'par',
    'ghar', 'home', 'office', 'aur', 'and', 'with', 'also',
  ];
  
  // Restaurant words to exclude from food items
  private readonly RESTAURANT_WORDS = ['hotel', 'cafe', 'restaurant', 'dhaba', 'store', 'shop'];
  
  extractCartItems(text: string): Array<{ product: string; quantity: number }> {
    const items: Array<{ product: string; quantity: number }> = [];
    const lowerText = text.toLowerCase();
    
    // ✅ Skip "do you" (English phrase, not Hindi "do" = 2)
    const doEnglishPhrases = ['do you', 'do they', 'do we', 'do i', 'do not', "don't", 'do it'];
    const isDoEnglish = doEnglishPhrases.some(phrase => lowerText.startsWith(phrase) || lowerText.includes(` ${phrase}`));
    
    // Transport/parcel related words - these are not food items
    const transportWords = ['bike', 'auto', 'car', 'tempo', 'coolie', 'wala', 'wali', 'rickshaw', 'cab', 'taxi'];
    // Location words - these are not food items
    const locationWords = ['ghar', 'home', 'office', 'dukan', 'school', 'college', 'station', 'airport'];
    // Action words to skip
    const actionSkipWords = ['chaheye', 'chahiye', 'chahte', 'karo', 'kardo', 'bhejo', 'bhej', 'send', 'book'];
    
    // Pattern 1: "X product" or "X product and Y product2"
    // e.g., "2 paneer tikka and 4 roti"
    // ✅ Exclude "do" when it's an English phrase
    const hindiNumbersPattern = isDoEnglish 
      ? /(\d+|ek|teen|char|paanch|chhah|saat|aath|nau|das)\s+([a-z\s]+?)(?=(?:\s+and\s+|\s+aur\s+|,|$|\s+\d|\s+ek|\s+do|\s+from|\s+se\b))/gi
      : /(\d+|ek|do|teen|char|paanch|chhah|saat|aath|nau|das)\s+([a-z\s]+?)(?=(?:\s+and\s+|\s+aur\s+|,|$|\s+\d|\s+ek|\s+do|\s+from|\s+se\b))/gi;
    
    let match;
    while ((match = hindiNumbersPattern.exec(lowerText)) !== null) {
      const qtyStr = match[1];
      let product = match[2].trim();
      
      // Remove action words from product name
      for (const word of this.ACTION_WORDS) {
        product = product.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').trim();
      }
      // Also remove actionSkipWords specific to cart extraction
      for (const word of actionSkipWords) {
        product = product.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').trim();
      }
      // Clean up extra spaces
      product = product.replace(/\s+/g, ' ').trim();
      
      // Skip if product is now empty or too short
      if (product.length < 2) continue;
      
      // Skip if product looks like a restaurant name
      if (this.RESTAURANT_WORDS.some(w => product.includes(w))) continue;
      
      // Skip if product contains transport-related words (not food)
      if (transportWords.some(w => product.includes(w))) continue;
      
      // Skip if product contains location words (not food)
      if (locationWords.some(w => product.includes(w))) continue;
      
      // Convert quantity
      let qty = parseInt(qtyStr);
      if (isNaN(qty)) {
        qty = this.HINDI_NUMBERS[qtyStr.toLowerCase()] || 1;
      }
      
      // Add product if it looks valid (resolution happens in EntityResolutionService)
      // No hardcoded food list check - just ensure minimum length
      if (product.length > 2) {
        items.push({ product, quantity: qty });
      }
    }
    
    // Pattern 2: "I want X and Y" (without quantities - default to qty=1)
    // e.g., "I want butter chicken and paneer butter masala"
    if (items.length === 0) {
      const wantAndPattern = /(?:i\s+)?(?:want|need|order)\s+(.+?)\s+(?:and|aur)\s+(.+?)(?:\s+from|\s+at|\s+se|\s*$)/i;
      const wantMatch = lowerText.match(wantAndPattern);
      if (wantMatch) {
        const rawItems = [wantMatch[1]?.trim(), wantMatch[2]?.trim()].filter(Boolean);
        for (let product of rawItems) {
          // Clean leading articles/pronouns
          product = product.replace(/^(a|an|the|some)\s+/i, '').trim();
          // Remove action words
          for (const word of this.ACTION_WORDS) {
            product = product.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').trim();
          }
          product = product.replace(/\s+/g, ' ').trim();
          
          if (product && product.length > 2) {
            if (!this.RESTAURANT_WORDS.some(w => product.includes(w))) {
              items.push({ product, quantity: 1 });
            }
          }
        }
      }
    }
    
    return items;
  }

  /**
   * Extract urgency level
   */
  private extractUrgency(text: string): string | null {
    if (/jaldi|abhi|turant|urgent|asap|immediately|quick|fast/i.test(text)) {
      return 'urgent';
    }
    return null;
  }

  /**
   * Extract delivery location type
   */
  private extractDeliveryType(text: string): string | null {
    if (/ghar\s*(?:pe|par|me)|home|residence/i.test(text)) return 'home';
    if (/office|workplace|work/i.test(text)) return 'office';
    if (/hotel|hostel/i.test(text)) return 'hotel';
    return null;
  }

  private extractOrderId(text: string): string | null {
    // Match patterns like: ORD123, #12345, order 456, MNG-12345, order id 12345
    const patterns = [
      /(?:order|ord)\s*(?:id|number|no\.?)?\s*[:=]?\s*(\d{3,10})/i,
      /(?:#|mng[-_]?)\s*(\d{3,10})/i,
      /(?:booking|parcel)\s*(?:id|number|no\.?)?\s*[:=]?\s*(\d{3,10})/i,
      /\bid\s*[:=]?\s*(\d{3,10})/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  private extractPhoneNumber(text: string): string | null {
    // Indian phone numbers: 10 digits starting with 6-9
    const patterns = [
      /(?:\+91[\s-]?)?([6-9]\d{9})\b/,
      /(?:\+91[\s-]?)?(\d{10})\b/,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  private extractEmail(text: string): string | null {
    const match = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    return match ? match[0] : null;
  }

  private extractLocation(text: string): string | null {
    // City names
    const cities = [
      'mumbai', 'delhi', 'bangalore', 'bengaluru', 'pune', 'hyderabad',
      'chennai', 'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'surat',
      'kanpur', 'nagpur', 'indore', 'bhopal', 'patna', 'vadodara',
      'ghaziabad', 'ludhiana', 'agra', 'nashik', 'faridabad', 'meerut',
      'rajkot', 'varanasi', 'srinagar', 'aurangabad', 'dhanbad', 'amritsar',
    ];

    const lowerText = text.toLowerCase();
    
    // Check for cities
    const foundCity = cities.find((city) => lowerText.includes(city));
    if (foundCity) return foundCity;

    // Check for address patterns
    const addressPatterns = [
      /(?:near|opposite|beside|behind)\s+([A-Za-z\s]+?)(?:\s|,|$)/i,
      /(?:sector|block|lane|gali|street)\s*[-#]?\s*(\d+[A-Za-z]?)/i,
    ];

    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }

    return null;
  }

  /**
   * Extract date references
   */
  private extractDate(text: string): string | null {
    const patterns = [
      /(?:today|aaj|abhi)/i,
      /(?:tomorrow|kal|kl)/i,
      /(?:yesterday|parso)/i,
      /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
      /(\d{1,2})\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i,
      /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }
    return null;
  }

  /**
   * Extract time references
   */
  private extractTime(text: string): string | null {
    const patterns = [
      /(\d{1,2})\s*(?::\s*\d{2})?\s*(?:am|pm|baje)/i,
      /(?:morning|evening|afternoon|night|subah|shaam|dopahar|raat)/i,
      /(?:in|after)\s+(\d+)\s*(?:hour|hr|minute|min)/i,
      /(?:jaldi|turant|asap|abhi)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }
    return null;
  }

  /**
   * Extract price/money amounts
   */
  private extractPrice(text: string): string | null {
    const patterns = [
      /(?:rs\.?|₹|inr)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/i,
      /(\d+(?:,\d{3})*)\s*(?:rupees?|rs|₹)/i,
      /(\d+)\s*(?:hundred|hazaar|thousand|lakh)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }
    return null;
  }

  /**
   * Extract person names (for parcel/delivery)
   */
  private extractPersonName(text: string): string | null {
    const patterns = [
      /(?:send to|deliver to|naam|name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:recipient|receiver)\s*:?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:mera naam|my name is)\s+([A-Z][a-z]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Filter out common words
        if (!['the', 'a', 'my', 'your', 'me', 'please'].includes(name.toLowerCase())) {
          return name;
        }
      }
    }
    return null;
  }

  private extractProductName(text: string): string | null {
    // Extract text after "search", "find", "looking for"
    const patterns = [
      /(?:search|find|looking for|show me|dhundho|dikhao)\s+(.+)/i,
      /(?:want|chahiye|do)\s+(.+?)(?:\s+please)?$/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  /**
   * Extract pickup and delivery locations for parcel/ride
   * Handles patterns like "ghar se office", "office se dukan", etc.
   */
  private extractParcelLocations(text: string): { pickup: string | null; delivery: string | null } {
    const lowerText = text.toLowerCase();
    
    // Common location labels (saved addresses)
    const locationLabels = ['ghar', 'home', 'office', 'dukan', 'shop', 'school', 'college', 'hospital'];
    
    // Pattern: "X se Y" (from X to Y)
    const sePattern = /(\w+)\s+se\s+(\w+)/gi;
    let match;
    while ((match = sePattern.exec(lowerText)) !== null) {
      const from = match[1].toLowerCase();
      const to = match[2].toLowerCase();
      
      // Check if both are valid location types
      const fromIsLocation = locationLabels.includes(from);
      const toIsLocation = locationLabels.includes(to);
      
      if (fromIsLocation && toIsLocation) {
        return { pickup: from, delivery: to };
      } else if (fromIsLocation) {
        return { pickup: from, delivery: to };
      } else if (toIsLocation) {
        return { pickup: null, delivery: to };
      }
    }
    
    // Pattern: "from X to Y" 
    const fromToPattern = /from\s+(\w+)\s+to\s+(\w+)/i;
    const fromToMatch = lowerText.match(fromToPattern);
    if (fromToMatch) {
      return { pickup: fromToMatch[1], delivery: fromToMatch[2] };
    }
    
    // Check for delivery to home/office
    if (/ghar\s*(bhej|par|pe|me)/i.test(lowerText)) {
      return { pickup: null, delivery: 'home' };
    }
    if (/office\s*(bhej|par|pe|me)/i.test(lowerText)) {
      return { pickup: null, delivery: 'office' };
    }
    
    return { pickup: null, delivery: null };
  }

  /**
   * Extract vehicle type for parcel/ride
   * Handles patterns like "bike wala", "auto chahiye", etc.
   */
  private extractVehicleType(text: string): string | null {
    const lowerText = text.toLowerCase();
    
    // Vehicle patterns
    const patterns: [RegExp, string][] = [
      [/bike\s*wala|bike\s*chahiye|bike\s*bhejo|two\s*wheeler/i, 'bike'],
      [/auto\s*wala|auto\s*chahiye|auto\s*bhejo|auto\s*rickshaw/i, 'auto'],
      [/car\s*wala|car\s*chahiye|cab|taxi/i, 'car'],
      [/tempo\s*wala|tempo\s*chahiye|truck|loading/i, 'tempo'],
      [/coolie|porter|manual/i, 'coolie'],
    ];
    
    for (const [pattern, vehicle] of patterns) {
      if (pattern.test(lowerText)) {
        return vehicle;
      }
    }
    
    return null;
  }

  /**
   * Extract action requests (payment link, otp, etc.)
   * Handles patterns like "payment ka link bhejo", "otp send karo"
   */
  private extractActionRequest(text: string): string | null {
    const lowerText = text.toLowerCase();
    
    // Action patterns
    const patterns: [RegExp, string][] = [
      [/payment\s*(ka|ke|ki)?\s*link\s*(bhej|send|karo|do)/i, 'payment_link'],
      [/pay\s*link\s*(bhej|send|karo|do)/i, 'payment_link'],
      [/otp\s*(bhej|send|karo|do)/i, 'send_otp'],
      [/bill\s*(bhej|send|karo|do|dikhao)/i, 'show_bill'],
      [/receipt\s*(bhej|send|karo|do)/i, 'send_receipt'],
      [/invoice\s*(bhej|send|karo|do)/i, 'send_invoice'],
      [/location\s*(bhej|send|share)/i, 'share_location'],
      [/track\s*link/i, 'track_link'],
    ];
    
    for (const [pattern, action] of patterns) {
      if (pattern.test(lowerText)) {
        return action;
      }
    }
    
    return null;
  }
}
