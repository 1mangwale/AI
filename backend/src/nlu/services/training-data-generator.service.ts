import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Training Data Generator - Creates HIGH-QUALITY NLU Training Data
 * 
 * CRITICAL: This service generates training data for IndicBERT.
 * Poor quality data = wrongly trained NLU = bad user experience.
 * 
 * DATA SOURCES (verified from actual OpenSearch - Dec 25, 2025):
 * 
 * SEMANTIC INDICES (with 768-dim item_vector + combined_text):
 * - `food_items_v4`: 8,004 items - HAS vectors, store_name, store_address, combined_text
 * - `ecom_items_v3`: 2,908 items - HAS vectors (but some missing store_name)
 * 
 * BASE INDICES (no vectors, more items but less data):
 * - `food_items`: 11,628 items - NO vectors, basic fields only
 * - `ecom_items`: 2,908 items - NO vectors
 * 
 * STORE INDICES:
 * - `food_stores`: 126 stores with name, address, rating, zone_id
 * - `ecom_stores`: 19 stores
 * 
 * SEARCH LOGS:
 * - `search-logs-*`: Real user search queries (only those with query_length > 2)
 * 
 * TRAINING FORMAT: JSONL with {"text": "...", "intent": "..."}
 * 
 * EXISTING INTENTS (from indicbert_training_v5.jsonl):
 * - order_food (173 examples) - User wants to order food
 * - track_order (86 examples) - User wants to track delivery
 * - greeting (85 examples) - Hello, hi, namaste
 * - chitchat (87 examples) - Thanks, bye, casual talk
 * - parcel_booking (195 examples) - Send parcel/courier
 * - manage_address (125 examples) - Add/change address
 * - cancel_order (32 examples) - Cancel an order
 * - help (23 examples) - Need assistance
 * - service_inquiry (28 examples) - What services available
 * - use_my_details (47 examples) - Use saved info
 * 
 * VALIDATION RULES:
 * 1. Text must be 2-200 characters
 * 2. Intent must be from known list
 * 3. No duplicate texts
 * 4. Entities must be valid JSON
 * 5. Language detection must be accurate
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * CORRECT ARCHITECTURE (Dec 25, 2025):
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * NLU's ONLY job: HIGH-LEVEL intent routing (6-8 intents max)
 * 
 * User: "biryani from Inayat Cafe" 
 *       ↓
 * NLU: "order_food" (high-level routing ONLY)
 *       ↓
 * Agent Orchestrator → Search Agent
 *       ↓
 * Search Agent → Devs/Search API (passes RAW message)
 *       ↓
 * Search Service QueryParser: "specific_item_specific_store"
 *       ↓
 * OpenSearch: 768-dim semantic KNN search on food_items_v4
 * 
 * ❌ WRONG: NLU tries to classify "store_menu", "item_from_store"
 * ✅ RIGHT: NLU just says "order_food", Search handles the rest
 * ═══════════════════════════════════════════════════════════════════════════
 */

// SIMPLIFIED HIGH-LEVEL INTENTS - NLU routes to agents, agents handle details
const VALID_INTENTS = [
  // PRIMARY ROUTING INTENTS (6 core)
  'order_food',           // → Search Agent → food module → 768-dim semantic search
  'search_product',       // → Search Agent → ecom module → semantic search
  'track_order',          // → Order Tracking Agent
  'parcel_booking',       // → Parcel Agent
  'greeting',             // → Conversational response
  'help',                 // → Help/Support flow
  
  // SECONDARY INTENTS (transactional states)
  'add_to_cart',          // Within order flow
  'checkout',             // Within order flow
  'cancel_order',         // Order management
  
  // CONVERSATIONAL
  'chitchat',             // Thanks, bye, casual
  'thanks',               // Gratitude
  'service_inquiry',      // What can you do?
  
  // SPECIAL
  'human_takeover',       // Request human agent
  'unknown',              // Fallback
];

export interface TrainingExample {
  text: string;
  intent: string;
  entities?: Array<{ entity: string; value: string; start?: number; end?: number }>;
  language?: string;
  source?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface GenerationStats {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  byIntent: Record<string, number>;
  bySource: Record<string, number>;
  byLanguage: Record<string, number>;
  errors: string[];
}

@Injectable()
export class TrainingDataGeneratorService implements OnModuleInit {
  private readonly logger = new Logger(TrainingDataGeneratorService.name);
  
  private opensearchUrl: string;
  private outputDir: string;
  
  // Track seen texts to avoid duplicates
  private seenTexts = new Set<string>();
  
  // Track validation errors
  private validationErrors: string[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.opensearchUrl = this.config.get('OPENSEARCH_URL');
    this.outputDir = path.join(process.cwd(), 'training-data', 'generated');
  }

  async onModuleInit() {
    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    this.logger.log('📚 Training Data Generator initialized');
    this.logger.log(`📁 Output directory: ${this.outputDir}`);
  }

  /**
   * Validate a single training example
   */
  validateExample(example: TrainingExample): ValidationResult {
    const errors: string[] = [];
    
    // 1. Text validation
    if (!example.text || typeof example.text !== 'string') {
      errors.push('Text is required and must be a string');
    } else {
      const text = example.text.trim();
      if (text.length < 2) {
        errors.push(`Text too short: "${text}" (min 2 chars)`);
      }
      if (text.length > 200) {
        errors.push(`Text too long: ${text.length} chars (max 200)`);
      }
      // Check for garbage/invalid characters
      if (/^[\d\s\.,]+$/.test(text)) {
        errors.push(`Text appears to be just numbers/punctuation: "${text}"`);
      }
    }
    
    // 2. Intent validation
    if (!example.intent || typeof example.intent !== 'string') {
      errors.push('Intent is required and must be a string');
    } else if (!VALID_INTENTS.includes(example.intent)) {
      errors.push(`Unknown intent: "${example.intent}". Valid: ${VALID_INTENTS.join(', ')}`);
    }
    
    // 3. Check for duplicates
    const normalizedText = example.text?.toLowerCase().trim();
    if (normalizedText && this.seenTexts.has(normalizedText)) {
      errors.push(`Duplicate text: "${example.text}"`);
    }
    
    // 4. Entity validation (if present)
    if (example.entities) {
      if (!Array.isArray(example.entities)) {
        errors.push('Entities must be an array');
      } else {
        for (const entity of example.entities) {
          if (!entity.entity || !entity.value) {
            errors.push(`Invalid entity: ${JSON.stringify(entity)}`);
          }
        }
      }
    }
    
    return { valid: errors.length === 0, errors };
  }

  /**
   * Generate training data from OpenSearch food items
   * CAREFUL: Only generate for order_food intent
   */
  async generateFromFoodItems(): Promise<{ examples: TrainingExample[]; stats: GenerationStats }> {
    this.logger.log('🍕 Generating training data from food_items...');
    
    const stats: GenerationStats = {
      total: 0,
      valid: 0,
      invalid: 0,
      duplicates: 0,
      byIntent: {},
      bySource: {},
      byLanguage: {},
      errors: [],
    };
    
    const validExamples: TrainingExample[] = [];
    
    try {
      // Fetch food items from OpenSearch (CORRECT: food_items_v4 has vectors + store data)
      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/food_items_v4/_search`, {
          size: 5000,
          query: { 
            bool: {
              must: [
                { term: { status: 1 } },  // Only active items
                { term: { is_approved: 1 } }  // Only approved items
              ]
            }
          },
          _source: ['name', 'category_name', 'description', 'veg', 'price', 'store_name', 'store_address', 'combined_text', 'cuisine_type', 'meal_type'],
        }, { timeout: 30000 })
      );
      
      const hits = response.data.hits.hits;
      this.logger.log(`📦 Fetched ${hits.length} food items from OpenSearch`);
      
      for (const hit of hits) {
        const item = hit._source;
        const name = item.name?.trim();
        
        if (!name || name.length < 2) continue;
        
        // Generate CAREFUL variations - only clear order_food examples
        const variations = this.generateCarefulFoodVariations(name, item);
        
        for (const example of variations) {
          stats.total++;
          
          const validation = this.validateExample(example);
          if (validation.valid) {
            validExamples.push(example);
            this.seenTexts.add(example.text.toLowerCase().trim());
            stats.valid++;
            stats.byIntent[example.intent] = (stats.byIntent[example.intent] || 0) + 1;
            stats.bySource[example.source || 'unknown'] = (stats.bySource[example.source || 'unknown'] || 0) + 1;
            stats.byLanguage[example.language || 'unknown'] = (stats.byLanguage[example.language || 'unknown'] || 0) + 1;
          } else {
            stats.invalid++;
            if (validation.errors.some(e => e.includes('Duplicate'))) {
              stats.duplicates++;
            } else {
              stats.errors.push(...validation.errors.slice(0, 3)); // Limit errors
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to fetch food items: ${error.message}`);
      stats.errors.push(`OpenSearch error: ${error.message}`);
    }
    
    this.logger.log(`✅ Generated ${validExamples.length} valid examples from food items`);
    return { examples: validExamples, stats };
  }

  /**
   * Generate CAREFUL variations for a food item
   * Only create clear, unambiguous training examples
   */
  private generateCarefulFoodVariations(
    name: string, 
    item: { category_name?: string; veg?: number; price?: number; store_name?: string }
  ): TrainingExample[] {
    const examples: TrainingExample[] = [];
    
    // Skip items with very short or very long names
    if (name.length < 3 || name.length > 50) return examples;
    
    // Skip items that look like test data or garbage
    if (/^test|^demo|^\d+$/i.test(name)) return examples;
    
    // Template variations - ONLY clear order_food patterns
    // Avoid ambiguous phrases that could be other intents
    
    // English - clear order phrases
    const enTemplates = [
      `Order ${name}`,
      `I want ${name}`,
      `Get me ${name}`,
      `${name} please`,
    ];
    
    // Hindi/Hinglish - clear order phrases  
    const hiTemplates = [
      `${name} chahiye`,
      `${name} order karo`,
      `mujhe ${name} do`,
      `ek ${name} mangwa do`,
    ];
    
    // Only add if name looks like food (basic sanity check)
    const looksLikeFood = /paneer|chicken|biryani|pizza|burger|roti|dal|rice|curry|masala|thali|pav|vada|dosa|idli|samosa|pakoda|paratha|naan|kulcha|lassi|juice|tea|coffee|shake|sweet|mithai|halwa|gulab|rasgulla|momos|chowmein|noodles|pasta|sandwich|wrap|roll|fries|soup|salad|manchurian|chilli|fried|gravy|butter|tandoori|kebab|tikka|korma|pulao|khichdi|misal|pohe|sabudana|bhaji|bhakri/i;
    
    if (looksLikeFood.test(name) || (item.category_name && item.category_name !== 'abc')) {
      // Add English variations
      for (const template of enTemplates) {
        examples.push({
          text: template,
          intent: 'order_food',
          entities: [{ entity: 'food_item', value: name }],
          language: 'en',
          source: 'opensearch_food',
        });
      }
      
      // Add Hindi/Hinglish variations
      for (const template of hiTemplates) {
        examples.push({
          text: template,
          intent: 'order_food',
          entities: [{ entity: 'food_item', value: name }],
          language: 'hi',
          source: 'opensearch_food',
        });
      }
    } else {
      // For less certain items, only add 2 clear variations
      examples.push({
        text: `Order ${name}`,
        intent: 'order_food',
        entities: [{ entity: 'food_item', value: name }],
        language: 'en',
        source: 'opensearch_food',
      });
      examples.push({
        text: `${name} chahiye`,
        intent: 'order_food',
        entities: [{ entity: 'food_item', value: name }],
        language: 'hi',
        source: 'opensearch_food',
      });
    }
    
    return examples;
  }

  /**
   * Generate training data from search logs
   * CAREFUL: Only use logs with actual search queries
   */
  async generateFromSearchLogs(): Promise<{ examples: TrainingExample[]; stats: GenerationStats }> {
    this.logger.log('🔍 Generating training data from search logs...');
    
    const stats: GenerationStats = {
      total: 0,
      valid: 0,
      invalid: 0,
      duplicates: 0,
      byIntent: {},
      bySource: {},
      byLanguage: {},
      errors: [],
    };
    
    const validExamples: TrainingExample[] = [];
    
    try {
      // Fetch search logs with actual queries (query_length > 2)
      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/search-logs-*/_search`, {
          size: 2000,
          query: {
            bool: {
              must: [
                { range: { query_length: { gt: 2 } } }  // Only logs with actual queries
              ]
            }
          },
          _source: ['query', 'total_results', 'has_results'],
          aggs: {
            unique_queries: {
              terms: {
                field: 'query.keyword',
                size: 1000,
              }
            }
          }
        }, { timeout: 30000 })
      );
      
      // Get unique queries from aggregation
      const uniqueQueries = response.data.aggregations?.unique_queries?.buckets || [];
      this.logger.log(`📊 Found ${uniqueQueries.length} unique search queries`);
      
      for (const bucket of uniqueQueries) {
        const query = bucket.key?.trim();
        if (!query || query.length < 2 || query.length > 100) continue;
        
        // Skip queries that look like garbage
        if (/^[\d\s\.,]+$/.test(query)) continue;
        
        // Determine intent from search query
        // MOST search queries are for food/products
        const intent = this.inferIntentFromSearchQuery(query);
        
        const example: TrainingExample = {
          text: query,
          intent,
          language: this.detectLanguage(query),
          source: 'search_logs',
        };
        
        stats.total++;
        const validation = this.validateExample(example);
        
        if (validation.valid) {
          validExamples.push(example);
          this.seenTexts.add(query.toLowerCase().trim());
          stats.valid++;
          stats.byIntent[intent] = (stats.byIntent[intent] || 0) + 1;
          stats.bySource['search_logs'] = (stats.bySource['search_logs'] || 0) + 1;
          stats.byLanguage[example.language || 'unknown'] = (stats.byLanguage[example.language || 'unknown'] || 0) + 1;
        } else {
          stats.invalid++;
          if (validation.errors.some(e => e.includes('Duplicate'))) {
            stats.duplicates++;
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to fetch search logs: ${error.message}`);
      stats.errors.push(`Search logs error: ${error.message}`);
    }
    
    this.logger.log(`✅ Generated ${validExamples.length} valid examples from search logs`);
    return { examples: validExamples, stats };
  }

  /**
   * CAREFULLY infer intent from search query
   * Default to search_product (safe) rather than order_food
   */
  private inferIntentFromSearchQuery(query: string): string {
    const lowerQuery = query.toLowerCase();
    
    // Track order patterns - very specific
    if (/^(track|where|status|kahan|कहाँ|कहां).*order/i.test(lowerQuery)) {
      return 'track_order';
    }
    
    // Cancel patterns - very specific
    if (/^cancel|refund/i.test(lowerQuery)) {
      return 'cancel_order';
    }
    
    // Help patterns
    if (/^help|problem|issue/i.test(lowerQuery)) {
      return 'help';
    }
    
    // For product searches, use search_product (safer than order_food)
    // The user is SEARCHING, not necessarily ordering
    return 'search_product';
  }

  /**
   * Generate base intent patterns (non-food intents)
   * These are essential for balanced training
   */
  generateBasePatterns(): TrainingExample[] {
    this.logger.log('📝 Generating base intent patterns...');
    
    const patterns: TrainingExample[] = [];
    
    // GREETING patterns
    const greetings = [
      { text: 'Hi', lang: 'en' },
      { text: 'Hello', lang: 'en' },
      { text: 'Hey', lang: 'en' },
      { text: 'Good morning', lang: 'en' },
      { text: 'Good evening', lang: 'en' },
      { text: 'Namaste', lang: 'hi' },
      { text: 'नमस्ते', lang: 'hi' },
      { text: 'hi chotu', lang: 'en' },
      { text: 'hello chotu', lang: 'en' },
    ];
    
    for (const g of greetings) {
      patterns.push({ text: g.text, intent: 'greeting', language: g.lang, source: 'base_patterns' });
    }
    
    // TRACK ORDER patterns
    const trackPatterns = [
      { text: 'Where is my order', lang: 'en' },
      { text: 'Track my order', lang: 'en' },
      { text: 'Order status', lang: 'en' },
      { text: 'When will my order arrive', lang: 'en' },
      { text: 'mera order kahan hai', lang: 'hi' },
      { text: 'order track karo', lang: 'hi' },
      { text: 'kab tak aayega', lang: 'hi' },
      { text: 'delivery status batao', lang: 'hi' },
      { text: 'rider kahan hai', lang: 'hi' },
    ];
    
    for (const t of trackPatterns) {
      patterns.push({ text: t.text, intent: 'track_order', language: t.lang, source: 'base_patterns' });
    }
    
    // CANCEL ORDER patterns
    const cancelPatterns = [
      { text: 'Cancel my order', lang: 'en' },
      { text: 'I want to cancel', lang: 'en' },
      { text: 'Cancel order', lang: 'en' },
      { text: 'order cancel karo', lang: 'hi' },
      { text: 'cancel kar do', lang: 'hi' },
      { text: 'nahi chahiye ab', lang: 'hi' },
    ];
    
    for (const c of cancelPatterns) {
      patterns.push({ text: c.text, intent: 'cancel_order', language: c.lang, source: 'base_patterns' });
    }
    
    // CHITCHAT patterns
    const chitchatPatterns = [
      { text: 'Thank you', lang: 'en' },
      { text: 'Thanks', lang: 'en' },
      { text: 'Bye', lang: 'en' },
      { text: 'Goodbye', lang: 'en' },
      { text: 'धन्यवाद', lang: 'hi' },
      { text: 'shukriya', lang: 'hi' },
      { text: 'Merry Christmas', lang: 'en' },
      { text: 'Happy New Year', lang: 'en' },
    ];
    
    for (const ch of chitchatPatterns) {
      patterns.push({ text: ch.text, intent: 'chitchat', language: ch.lang, source: 'base_patterns' });
    }
    
    // HELP patterns
    const helpPatterns = [
      { text: 'Help', lang: 'en' },
      { text: 'I need help', lang: 'en' },
      { text: 'What can you do', lang: 'en' },
      { text: 'help chahiye', lang: 'hi' },
      { text: 'kya kar sakte ho', lang: 'hi' },
      { text: 'madad karo', lang: 'hi' },
    ];
    
    for (const h of helpPatterns) {
      patterns.push({ text: h.text, intent: 'help', language: h.lang, source: 'base_patterns' });
    }
    
    // PARCEL BOOKING patterns
    const parcelPatterns = [
      { text: 'Send a parcel', lang: 'en' },
      { text: 'Book courier', lang: 'en' },
      { text: 'I want to send a package', lang: 'en' },
      { text: 'parcel bhejni hai', lang: 'hi' },
      { text: 'courier book karo', lang: 'hi' },
      { text: 'saman bhejni hai', lang: 'hi' },
    ];
    
    for (const p of parcelPatterns) {
      patterns.push({ text: p.text, intent: 'parcel_booking', language: p.lang, source: 'base_patterns' });
    }
    
    // NOTE: Store-specific patterns (store_menu, item_from_store) are NOT needed here!
    // The Search service's QueryParser handles these automatically:
    //   - "Biryani from Inayat" → QueryParser detects "specific_item_specific_store"
    //   - "Show Inayat menu" → QueryParser detects "store_first" pattern
    // NLU should just classify these as "order_food" and pass to Search Agent
    
    // HUMAN TAKEOVER patterns
    const humanPatterns = [
      { text: 'Talk to human', lang: 'en' },
      { text: 'Connect me to agent', lang: 'en' },
      { text: 'Real person please', lang: 'en' },
      { text: 'insaan se baat karo', lang: 'hi' },
      { text: 'agent se connect karo', lang: 'hi' },
    ];
    
    for (const hp of humanPatterns) {
      patterns.push({ text: hp.text, intent: 'human_takeover', language: hp.lang, source: 'base_patterns' });
    }
    
    this.logger.log(`📝 Generated ${patterns.length} base patterns`);
    return patterns;
  }

  // ==================== REMOVED METHODS ====================
  // generateFromStores() - REMOVED
  // generateItemFromStorePatterns() - REMOVED
  //
  // REASON: Search service's QueryParser already handles these patterns!
  // NLU just needs to route "order_food" → Search Agent, which passes
  // the RAW message to Search API where QueryParser classifies:
  //   - "Biryani from Inayat" → specific_item_specific_store
  //   - "Show Inayat menu" → store_first
  //   - "Biryani" → generic (semantic search)
  // ============================================================

  /**
   * Generate FULL training dataset with validation
   * 
   * SIMPLIFIED ARCHITECTURE:
   * This generator focuses on HIGH-LEVEL routing intents only:
   *   - order_food: "paneer butter masala chahiye" → Search Agent
   *   - track_order: "mera order kahan hai" → Order Agent
   *   - parcel_booking: "courier bhejni hai" → Parcel Agent
   * 
   * Store-specific parsing is handled by Search service's QueryParser,
   * NOT by NLU classification.
   */
  async generateFullDataset(): Promise<{
    success: boolean;
    outputFile: string;
    stats: GenerationStats;
    warnings: string[];
  }> {
    this.logger.log('🚀 Starting VALIDATED training data generation...');
    
    // Reset state
    this.seenTexts.clear();
    this.validationErrors = [];
    
    const allExamples: TrainingExample[] = [];
    const warnings: string[] = [];
    
    const combinedStats: GenerationStats = {
      total: 0,
      valid: 0,
      invalid: 0,
      duplicates: 0,
      byIntent: {},
      bySource: {},
      byLanguage: {},
      errors: [],
    };
    
    // 1. Generate from food items
    const foodResult = await this.generateFromFoodItems();
    allExamples.push(...foodResult.examples);
    this.mergeStats(combinedStats, foodResult.stats);
    
    // 2. Generate from search logs
    const searchResult = await this.generateFromSearchLogs();
    allExamples.push(...searchResult.examples);
    this.mergeStats(combinedStats, searchResult.stats);
    
    // NOTE: generateFromStores() and generateItemFromStorePatterns() REMOVED
    // Search service's QueryParser handles store-specific patterns automatically
    
    // 3. Generate base patterns (important for balance!)
    const basePatterns = this.generateBasePatterns();
    for (const pattern of basePatterns) {
      const validation = this.validateExample(pattern);
      if (validation.valid && !this.seenTexts.has(pattern.text.toLowerCase().trim())) {
        allExamples.push(pattern);
        this.seenTexts.add(pattern.text.toLowerCase().trim());
        combinedStats.valid++;
        combinedStats.byIntent[pattern.intent] = (combinedStats.byIntent[pattern.intent] || 0) + 1;
        combinedStats.bySource['base_patterns'] = (combinedStats.bySource['base_patterns'] || 0) + 1;
      }
    }
    
    // 6. Validate intent balance
    const intentCounts = combinedStats.byIntent;
    const avgCount = Object.values(intentCounts).reduce((a, b) => a + b, 0) / Object.keys(intentCounts).length;
    
    for (const [intent, count] of Object.entries(intentCounts)) {
      if (count > avgCount * 10) {
        warnings.push(`⚠️ Intent "${intent}" is over-represented: ${count} examples (avg: ${avgCount.toFixed(0)})`);
      }
      if (count < 10) {
        warnings.push(`⚠️ Intent "${intent}" is under-represented: ${count} examples (min recommended: 10)`);
      }
    }
    
    // 4. Write output file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(this.outputDir, `nlu_training_${timestamp}.jsonl`);
    
    // Write JSONL (one JSON per line - IndicBERT format)
    const jsonlContent = allExamples.map(ex => JSON.stringify({
      text: ex.text,
      intent: ex.intent,
      // Only include entities if present
      ...(ex.entities && ex.entities.length > 0 ? { entities: ex.entities } : {}),
    })).join('\n');
    
    fs.writeFileSync(outputFile, jsonlContent);
    
    // 5. Write detailed summary
    const summaryFile = path.join(this.outputDir, `nlu_training_${timestamp}_summary.json`);
    fs.writeFileSync(summaryFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      outputFile,
      totalExamples: allExamples.length,
      stats: combinedStats,
      warnings,
      validIntents: VALID_INTENTS,
      intentDistribution: Object.entries(intentCounts)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .map(([intent, count]) => ({ intent, count, percentage: ((count as number) / allExamples.length * 100).toFixed(1) + '%' })),
    }, null, 2));
    
    this.logger.log(`✅ Training data saved to ${outputFile}`);
    this.logger.log(`📊 Total: ${allExamples.length} examples across ${Object.keys(intentCounts).length} intents`);
    
    if (warnings.length > 0) {
      this.logger.warn(`⚠️ ${warnings.length} warnings - check summary file`);
    }
    
    return {
      success: true,
      outputFile,
      stats: combinedStats,
      warnings,
    };
  }

  /**
   * Merge stats from multiple sources
   */
  private mergeStats(target: GenerationStats, source: GenerationStats): void {
    target.total += source.total;
    target.valid += source.valid;
    target.invalid += source.invalid;
    target.duplicates += source.duplicates;
    target.errors.push(...source.errors.slice(0, 10)); // Limit errors
    
    for (const [key, value] of Object.entries(source.byIntent)) {
      target.byIntent[key] = (target.byIntent[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(source.bySource)) {
      target.bySource[key] = (target.bySource[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(source.byLanguage)) {
      target.byLanguage[key] = (target.byLanguage[key] || 0) + value;
    }
  }

  /**
   * Simple language detection
   */
  private detectLanguage(text: string): string {
    if (/[\u0900-\u097F]/.test(text)) {
      return 'hi';
    }
    const hinglishWords = ['chahiye', 'karo', 'hai', 'kya', 'kahan', 'batao', 'do', 'mangwa', 'mujhe'];
    for (const word of hinglishWords) {
      if (text.toLowerCase().includes(word)) {
        return 'hi';
      }
    }
    return 'en';
  }

  /**
   * Get statistics about available data sources
   */
  async getDataSourceStats(): Promise<{
    foodItems: { count: number; sampleNames: string[] };
    searchLogs: { count: number; uniqueQueries: number; sampleQueries: string[] };
    existingTraining: { count: number; intents: string[] };
  }> {
    let foodItems = { count: 0, sampleNames: [] as string[] };
    let searchLogs = { count: 0, uniqueQueries: 0, sampleQueries: [] as string[] };
    let existingTraining = { count: 0, intents: [] as string[] };
    
    try {
      // Count food items (use v4 with vectors)
      const foodResponse = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/food_items_v4/_search`, {
          size: 5,
          query: { match_all: {} },
          _source: ['name'],
        }, { timeout: 5000 })
      );
      foodItems.count = foodResponse.data.hits.total.value;
      foodItems.sampleNames = foodResponse.data.hits.hits.map((h: any) => h._source.name);
    } catch (e) {
      this.logger.warn('Could not fetch food items stats');
    }
    
    try {
      // Count search logs with queries
      const logResponse = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/search-logs-*/_search`, {
          size: 0,
          query: { range: { query_length: { gt: 2 } } },
          aggs: {
            unique_queries: { cardinality: { field: 'query.keyword' } },
            sample_queries: { terms: { field: 'query.keyword', size: 5 } }
          }
        }, { timeout: 5000 })
      );
      searchLogs.count = logResponse.data.hits.total.value;
      searchLogs.uniqueQueries = logResponse.data.aggregations?.unique_queries?.value || 0;
      searchLogs.sampleQueries = logResponse.data.aggregations?.sample_queries?.buckets?.map((b: any) => b.key) || [];
    } catch (e) {
      this.logger.warn('Could not fetch search logs stats');
    }
    
    // Check existing training data
    const existingFile = path.join(process.cwd(), 'training-data', 'indicbert_training_v5.jsonl');
    if (fs.existsSync(existingFile)) {
      const lines = fs.readFileSync(existingFile, 'utf-8').split('\n').filter(l => l.trim());
      existingTraining.count = lines.length;
      const intents = new Set<string>();
      for (const line of lines.slice(0, 500)) {
        try {
          const obj = JSON.parse(line);
          if (obj.intent) intents.add(obj.intent);
        } catch {}
      }
      existingTraining.intents = Array.from(intents);
    }
    
    return { foodItems, searchLogs, existingTraining };
  }

  /**
   * Preview generated data WITHOUT saving - for review
   */
  async previewGeneration(limit: number = 50): Promise<{
    samples: TrainingExample[];
    estimatedTotal: number;
    intentBreakdown: Record<string, number>;
  }> {
    this.logger.log('👁️ Generating preview (not saving)...');
    
    this.seenTexts.clear();
    const samples: TrainingExample[] = [];
    const intentBreakdown: Record<string, number> = {};
    
    // Get a small sample from food items
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.opensearchUrl}/food_items_v4/_search`, {
          size: 10,
          query: { bool: { must: [{ term: { status: 1 } }] } },  // v4 may not have is_approved
          _source: ['name', 'category_name', 'store_name', 'combined_text'],
        }, { timeout: 10000 })
      );
      
      for (const hit of response.data.hits.hits) {
        const variations = this.generateCarefulFoodVariations(hit._source.name, hit._source);
        for (const v of variations.slice(0, 2)) { // Only 2 per item
          samples.push(v);
          intentBreakdown[v.intent] = (intentBreakdown[v.intent] || 0) + 1;
        }
      }
    } catch (e) {}
    
    // Add some base patterns
    const basePatterns = this.generateBasePatterns();
    for (const p of basePatterns.slice(0, 20)) {
      samples.push(p);
      intentBreakdown[p.intent] = (intentBreakdown[p.intent] || 0) + 1;
    }
    
    return {
      samples: samples.slice(0, limit),
      estimatedTotal: samples.length * 100, // Rough estimate
      intentBreakdown,
    };
  }
}
