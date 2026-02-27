import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchService } from '../../search/services/search.service';
import { EnhancedSearchService } from '../../search/services/enhanced-search.service';
import { SearchAIIntegrationService } from '../../search/services/search-ai-integration.service';
import { UserProfilingService } from '../../personalization/user-profiling.service';
import { SearchAnalyticsService } from '../../search/services/search-analytics.service';
import { QueryExpansionService } from '../../search/services/query-expansion.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';
import { resolveImageUrl } from '../../common/utils/image-url.util';
import { StoreScheduleService } from '../../stores/services/store-schedule.service';
import { NerEntityExtractorService } from '../../nlu/services/ner-entity-extractor.service';

/**
 * Search Executor
 * 
 * Searches OpenSearch for products (food, ecommerce)
 * 
 * Enhanced with v3 Search API features:
 * - Query Understanding (spell check, synonyms)
 * - Conversational Search (NLP entity extraction)
 * - Multi-stage Retrieval (ML reranking)
 * - Personalization (user history boost)
 */
@Injectable()
export class SearchExecutor implements ActionExecutor {
  readonly name = 'search';
  private readonly logger = new Logger(SearchExecutor.name);
  private readonly storageCdnUrl: string;

  constructor(
    private readonly searchService: SearchService,
    private readonly enhancedSearchService: EnhancedSearchService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
    @Optional() private readonly searchAI?: SearchAIIntegrationService,
    @Optional() private readonly userProfiling?: UserProfilingService,
    @Optional() private readonly searchAnalytics?: SearchAnalyticsService,
    @Optional() private readonly queryExpansion?: QueryExpansionService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly storeScheduleService?: StoreScheduleService,
    @Optional() private readonly nerExtractor?: NerEntityExtractorService,
  ) {
    this.storageCdnUrl = this.configService?.get<string>('storage.cdnUrl') || 'https://storage.mangwale.ai/mangwale/product';
  }

  /**
   * Enrich result cards with store open/closed status from StoreScheduleService.
   * Queries MySQL once per unique store (not once per card) to minimise latency.
   * Works for both food and ecom stores — all have 7-day schedule data.
   */
  private async enrichWithSchedule(cards: any[]): Promise<any[]> {
    if (!this.storeScheduleService || !cards?.length) return cards;

    // Collect unique store IDs
    const storeIds = [...new Set(
      cards.map(c => c.storeId || c.store_id).filter((id): id is number => !!id)
    )];

    // Query each store exactly once, in parallel
    const statusMap = new Map<number, { is_open: boolean; message: string }>();
    await Promise.all(storeIds.map(async (sid) => {
      try {
        const s = await this.storeScheduleService.isStoreOpen(sid);
        statusMap.set(sid, { is_open: s.is_open, message: s.message });
      } catch {
        // On error: omit status for this store (treated as unknown/open)
      }
    }));

    return cards.map(card => {
      const sid = card.storeId || card.store_id;
      const status = sid ? statusMap.get(sid) : undefined;
      if (!status) return card;
      return { ...card, isOpen: status.is_open, storeStatusMessage: status.message };
    });
  }

  /**
   * Build contextual filter quick-reply buttons based on the result set.
   * Uses natural-language values so they flow through the existing NLU/entity-resolution
   * pipeline (resolve_user_intent → check_resolution_result → re-search).
   * Only generates buttons that would meaningfully change results.
   */
  private buildFilterButtons(cards: any[], currentVeg?: string, currentRatingMin?: number): Array<{ label: string; value: string }> {
    if (!cards?.length) return [];

    const buttons: Array<{ label: string; value: string }> = [];

    // Veg filter: only show if both veg and non-veg items exist and no veg filter is active
    if (!currentVeg) {
      const hasVeg = cards.some(c => c.veg === 1 || c.veg === true || c.veg === '1');
      const hasNonVeg = cards.some(c => c.veg === 0 || c.veg === false || c.veg === '0');
      if (hasVeg && hasNonVeg) {
        buttons.push({ label: '🥦 Veg only', value: 'show veg only' });
      }
    }

    // Rating filter: only show if some items are 4+ rated and no rating filter active
    if (!currentRatingMin) {
      const hasTopRated = cards.some(c => parseFloat(c.rating || '0') >= 4.0);
      if (hasTopRated) {
        buttons.push({ label: '⭐ Top rated', value: 'show top rated options' });
      }
    }

    // Price filter: only show if price spread is meaningful (max > 1.5x min)
    const prices = cards.map(c => c.rawPrice || parseFloat((c.price || '₹0').replace('₹', '') || '0')).filter(p => p > 0);
    if (prices.length > 1) {
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      if (maxP > minP * 1.5) {
        const budgetMax = Math.round(minP + (maxP - minP) * 0.35);
        buttons.push({ label: `💰 Under ₹${budgetMax}`, value: `budget options under ${budgetMax} rupees` });
      }
    }

    return buttons;
  }

  /**
   * Extract FOOD/PREF entities from user query via Mercury NER (non-blocking).
   * Returns { vegFilter, refinedQuery } — both may be undefined if NER fails/times-out.
   * NER runs with a 3s timeout so it never delays a search by more than that.
   */
  private async extractSearchEntities(query: string): Promise<{ vegFilter?: 1 | 0; refinedQuery?: string }> {
    if (!this.nerExtractor) return {};
    try {
      const entities = await Promise.race([
        this.nerExtractor.extract(query),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('NER timeout')), 3000)),
      ]);

      const result: { vegFilter?: 1 | 0; refinedQuery?: string } = {};

      // PREF → veg filter
      if (entities.preference?.length) {
        const pref = entities.preference.join(' ').toLowerCase();
        if (pref.includes('veg') && !pref.includes('non-veg') && !pref.includes('nonveg')) {
          result.vegFilter = 1;
        } else if (pref.includes('non-veg') || pref.includes('nonveg')) {
          result.vegFilter = 0;
        }
      }

      // FOOD → use as refined query when the raw query is conversational (has stop-words)
      // e.g. "I want biryani near station" → refinedQuery = "biryani"
      const foodRefs = entities.food_reference;
      if (foodRefs?.length) {
        const foodStr = foodRefs.join(' ').toLowerCase();
        // Only refine if NER extracted a distinct food term and query is longer (conversational)
        const queryWords = query.trim().split(/\s+/).length;
        if (queryWords >= 4 && foodStr.length >= 3) {
          result.refinedQuery = foodStr;
        }
      }

      if (result.vegFilter !== undefined || result.refinedQuery) {
        this.logger.log(`🏷️ NER extracted: vegFilter=${result.vegFilter}, refinedQuery="${result.refinedQuery}" from "${query}"`);
      }

      return result;
    } catch (err) {
      this.logger.debug(`NER extraction skipped: ${err.message}`);
      return {};
    }
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radius of the earth in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /**
   * Fuzzy string matching using Levenshtein distance
   * Returns true if similarity is above threshold
   */
  private fuzzyMatch(str1: string, str2: string, threshold: number = 0.6): boolean {
    if (!str1 || !str2) return false;
    
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    // Exact match
    if (s1 === s2) return true;
    
    // Contains match ("inayat" matches "inayat cafe")
    if (s1.includes(s2) || s2.includes(s1)) return true;
    
    // Word-level match ("inayat cafe" matches if any word matches)
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    for (const w1 of words1) {
      for (const w2 of words2) {
        if (w1 === w2 && w1.length > 2) return true;
      }
    }
    
    // Levenshtein distance for close matches
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return true;
    
    const distance = this.levenshteinDistance(s1, s2);
    const similarity = 1 - distance / maxLen;
    
    return similarity >= threshold;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    
    if (m === 0) return n;
    if (n === 0) return m;
    
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // deletion
          dp[i][j - 1] + 1,     // insertion
          dp[i - 1][j - 1] + cost  // substitution
        );
      }
    }
    
    return dp[m][n];
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const type = config.type || 'search';
      const index = config.index as string || 'food_items';

      // Handle Category Fetching
      if (type === 'categories') {
        const limit = config.limit || 8;
        this.logger.debug(`Fetching popular categories from ${index}`);

        const categories = await this.searchService.getPopularCategories(index, limit);

        this.logger.debug(`Fetched categories: ${JSON.stringify(categories)}`);

        return {
          success: true,
          output: categories,
          event: 'success'
        };
      }

      // Handle Category Browsing (get items by category_id)
      if (type === 'category_items') {
        // 🔧 FIX: Strip 'cat_' prefix added by display_categories to avoid numeric item-selection conflict
        const rawCategoryId = String(config.categoryId || '').replace(/^cat_/i, '');
        const categoryId = Number(rawCategoryId);
        if (!categoryId || isNaN(categoryId)) {
          this.logger.warn(`Invalid categoryId: ${config.categoryId}`);
          return { success: false, output: [], event: 'no_items' };
        }

        const moduleId = index.includes('ecom') ? 5 : 4;
        const size = config.size || config.limit || 10;
        const zone_id = config.zone_id || context.data.zone_id;
        const lat = config.lat ? parseFloat(config.lat) : undefined;
        const lon = config.lng ? parseFloat(config.lng) : undefined;

        this.logger.log(`📋 Category browse: categoryId=${categoryId}, moduleId=${moduleId}, zone=${zone_id}`);

        const items = await this.searchService.getCategoryItems(categoryId, moduleId, {
          zone_id: zone_id ? Number(zone_id) : undefined,
          lat, lon, size,
        });

        if (!items.length) {
          return { success: true, output: { items: [], total: 0, hasResults: false, cards: [] }, event: 'no_items' };
        }

        // Filter test data first
        const filtered = this.filterTestData(items);

        // Use MinIO CDN URL for images (S3 bucket is inaccessible)
        const getImageUrl = (item: any): string | undefined => resolveImageUrl(item, this.storageCdnUrl);

        // Build cards in same format as standard search (lines ~995-1046)
        const cards = filtered.slice(0, size).map((item: any) => {
          const foodVariations = item.food_variations || item.variations || [];
          const parsedVariations = typeof foodVariations === 'string' ? (() => { try { return JSON.parse(foodVariations); } catch { return []; } })() : foodVariations;

          return {
            id: item.id,
            name: item.name || item.description?.substring(0, 50),
            description: item.description || item.category_name,
            price: item.price ? `₹${item.price}` : undefined,
            rawPrice: item.price,
            image: getImageUrl(item),
            rating: item.avg_rating || '0.0',
            deliveryTime: item.delivery_time || '30-45 min',
            category: item.category_name,
            storeName: item.store_name,
            storeId: item.store_id,
            moduleId: item.module_id || moduleId,
            veg: item.veg,
            cardType: 'food',
            has_variant: Array.isArray(parsedVariations) && parsedVariations.length > 0 ? 1 : (item.has_variant || 0),
            food_variations: Array.isArray(parsedVariations) ? parsedVariations : [],
            action: {
              label: 'Add +',
              value: `item_${item.id}`,
            },
          };
        });

        const output = {
          items: filtered,
          total: filtered.length,
          hasResults: cards.length > 0,
          cards,
        };

        this.logger.log(`📋 Category browse: ${cards.length} items (cards) for category ${categoryId}`);
        if (output.cards) {
          output.cards = await this.enrichWithSchedule(output.cards);
        }
        return {
          success: true,
          output,
          event: cards.length > 0 ? 'items_found' : 'no_items',
        };
      }

      // Handle Standard Search
      // Support both direct query and queryPath (read from context)
      let query = config.query as string;
      if (!query && config.queryPath) {
        query = context.data[config.queryPath] || context.data._user_message;
      }
      
      // 🔧 FIX: Handle cases where query is an array (e.g., from LLM extraction)
      // Convert ["pizza", "burger"] → "pizza burger"
      if (Array.isArray(query)) {
        query = query.join(' ');
        this.logger.log(`🔄 Converted array query to string: "${query}"`);
      }
      
      // 🔧 FIX: Handle comma-separated queries from Handlebars array rendering
      // "pizza,burger star boys" → "pizza burger star boys"
      if (typeof query === 'string' && query.includes(',')) {
        const originalQuery = query;
        query = query.split(',').map(s => s.trim()).join(' ');
        if (originalQuery !== query) {
          this.logger.log(`🔄 Normalized comma-separated query: "${originalQuery}" → "${query}"`);
        }
      }
      
      // 🔍 Query preprocessing: transliteration, spelling correction, synonym expansion
      if (query && this.queryExpansion) {
        try {
          const expanded = await this.queryExpansion.expandQuery(query);
          if (expanded.expanded !== expanded.original) {
            this.logger.log(`🔍 Query expanded: "${query}" → "${expanded.expanded}" (corrections: ${expanded.corrections.join(', ') || 'none'}, synonyms: ${expanded.synonyms.length})`);
            query = expanded.expanded;
          }
        } catch (err) {
          this.logger.debug(`Query expansion failed (non-fatal): ${err.message}`);
        }
      }

      const limit = config.limit || config.size || 10;
      const filters = config.filters ? [...config.filters] : [];
      const lat = config.lat;
      const lng = config.lng;
      const zone_id = config.zone_id || context.data.zone_id; // ✅ Get zone_id from config or context
      const radius = config.radius || '5km';  // Default 5km radius for nearby results
      const useIntentSearch = config.useIntentSearch || config.intentSearch || false;
      const useSmartSearch = config.useSmartSearch || config.smartSearch || false;
      const queryMode = config.queryMode as string; // 'multi-term', 'recommendation'
      const openNowMode = !!config.open_now;
      const userId = context.data._user_id || context.data.userId || context.data.user_id;
      const platform = context.data.platform || 'unknown';

      // 🎯 SMART RECOMMENDATION & MULTI-TERM MODE
      // recommendation: Time-of-day aware terms + user history + personalization + diversity
      // multi-term: Same as before but now WITH personalization (was missing before)
      if ((queryMode === 'recommendation' || queryMode === 'multi-term') && query) {
        
        // 🕐 Generate search terms based on mode
        let searchTerms: string[];
        if (queryMode === 'recommendation') {
          searchTerms = this.getTimeAwareSearchTerms();
          this.logger.log(`🕐 Recommendation mode - time-based terms: [${searchTerms.join(', ')}]`);
        } else {
          searchTerms = query.split(/\s+/).filter(t => t.length > 2);
          this.logger.log(`🎯 Multi-term search mode for: "${query}"`);
        }

        // 👤 USER PERSONALIZATION: Load profile, apply filters, get boosts
        let userProfile = null;
        let personalizationBoosts: any = null;
        if (userId && this.userProfiling) {
          try {
            userProfile = await this.userProfiling.getProfile(Number(userId));
            if (userProfile) {
              this.logger.log(`👤 Personalizing recommendations for user ${userId}`);

              // Apply dietary filter
              const dietType = (userProfile.food_preferences?.dietary_type || userProfile.dietary_type || '').toLowerCase();
              const isVegProfile = ['vegetarian','veg','vegan','jain','eggetarian'].includes(dietType);
              if (isVegProfile && !filters.find((f: any) => f.field === 'veg')) {
                filters.push({ field: 'veg', operator: 'equals', value: 1 });
                this.logger.log(`🥗 Applied veg filter from user profile (dietary_type: ${dietType})`);
              }

              // Get boosts for reranking
              personalizationBoosts = await this.userProfiling.getPersonalizationBoosts(Number(userId), index);

              // Prepend user's favorite categories as priority search terms
              if (queryMode === 'recommendation' && userProfile.favorite_categories?.length > 0) {
                try {
                  const catNames = await this.getCategoryNames(userProfile.favorite_categories);
                  if (catNames.length > 0) {
                    searchTerms = [...catNames.slice(0, 3), ...searchTerms];
                    this.logger.log(`⭐ Prepended favorite categories: [${catNames.join(', ')}]`);
                  }
                } catch (e) {
                  this.logger.debug(`Could not resolve category names: ${e.message}`);
                }
              }
            }
          } catch (error) {
            this.logger.warn(`⚠️ Failed to fetch user profile: ${error.message}`);
          }
        }

        // 🥗 NLU PREFERENCE: Apply veg filter from current message preference
        if (!filters.find(f => f.field === 'veg')) {
          const nluPreference = context.data._user_food_preference || context.data.dietary_preference || context.data.extracted_food?.preference;
          const prefStr = Array.isArray(nluPreference) ? nluPreference.join(' ').toLowerCase() : String(nluPreference || '').toLowerCase();
          if (prefStr.includes('veg') && !prefStr.includes('non-veg') && !prefStr.includes('nonveg')) {
            filters.push({ field: 'veg', operator: 'equals', value: 1 });
            this.logger.log('🥗 Applied vegetarian filter from NLU preference (recommendation mode)');
          }
        }

        const termsToSearch = searchTerms.slice(0, 7); // Up to 7 terms for variety
        const resultsPerTerm = Math.ceil(limit / Math.min(termsToSearch.length, 5));
        const allItems: any[] = [];
        const seenIds = new Set<string | number>();
        
        // 🔧 FIX: Always include module_id=4 filter for food recommendations
        if (index.includes('food') && !filters.find(f => f.field === 'module_id')) {
          filters.push({ field: 'module_id', operator: 'equals', value: 4 });
        }

        if (filters.length > 0) {
          this.logger.log(`🔍 Recommendation filters: ${JSON.stringify(filters)}`);
        }

        // Search each term separately for diversity
        for (const term of termsToSearch) {
          try {
            this.logger.log(`  🔎 Searching for: "${term}"`);
            const termResults = await this.searchService.search({
              query: term,
              index: 'food_items',
              searchType: 'hybrid',
              limit: resultsPerTerm,
              filters,  // 🔧 FIX: Pass veg preference + module_id filters
              platform,
            });
            
            const items = (termResults.results || []).map((hit: any) => ({
              id: hit.id,
              ...hit.source,
            }));
            for (const item of items) {
              const itemId = item.id || item.item_id;
              if (!seenIds.has(itemId)) {
                seenIds.add(itemId);
                allItems.push(item);
              }
            }
            this.logger.log(`    ✅ Got ${items.length} items, total unique: ${allItems.length}`);
          } catch (err) {
            this.logger.warn(`    ⚠️ Term "${term}" failed: ${err.message}`);
          }
        }

        // ⭐ PERSONALIZATION RERANKING (was missing for multi-term before!)
        if (personalizationBoosts && allItems.length > 0) {
          const { itemBoosts = {}, categoryBoosts = {}, storeBoosts = {} } = personalizationBoosts;
          const hasBoosts = Object.keys(itemBoosts).length > 0 || Object.keys(categoryBoosts).length > 0 || Object.keys(storeBoosts).length > 0;
          
          if (hasBoosts) {
            for (let i = 0; i < allItems.length; i++) {
              let boostScore = 1.0;
              const itemId = String(allItems[i].id || allItems[i].item_id);
              const categoryId = String(allItems[i].category_id || '');
              const storeId = String(allItems[i].store_id || '');
              
              if (itemBoosts[itemId]) boostScore *= itemBoosts[itemId];       // 3x favorite item
              if (categoryBoosts[categoryId]) boostScore *= categoryBoosts[categoryId]; // 2x favorite category
              if (storeBoosts[storeId]) boostScore *= storeBoosts[storeId];   // 2.5x favorite store
              
              allItems[i]._personalization_score = boostScore;
              allItems[i]._original_rank = i;
            }
            
            allItems.sort((a, b) => {
              if (b._personalization_score !== a._personalization_score) {
                return b._personalization_score - a._personalization_score;
              }
              return a._original_rank - b._original_rank;
            });
            
            const boostedCount = allItems.filter(i => i._personalization_score > 1.0).length;
            if (boostedCount > 0) {
              this.logger.log(`⭐ Personalization: boosted ${boostedCount} items in recommendation results`);
            }
          }
        }
        
        // 🍔 Module safety net: filter out non-food items (defense-in-depth)
        if (index.includes('food')) {
          const NON_FOOD_CATEGORIES = ['dog food', 'cat food', 'pet food', 'bird food', 'fish food', 'animal feed', 'pet supplies', 'pet care'];
          const NON_FOOD_STORES = ['fins aquarium', 'pet shop', 'pet store', 'aquarium'];
          const beforeFilter = allItems.length;
          const filtered = allItems.filter((item: any) => {
            const moduleId = Number(item.module_id);
            const category = String(item.category_name || item.category || '').toLowerCase();
            const storeName = String(item.store_name || item.storeName || '').toLowerCase();
            const itemName = String(item.name || '').toLowerCase();
            // Module filter
            if (moduleId && moduleId !== 4 && moduleId !== 17) return false;
            // Non-food category/store filter
            if (NON_FOOD_CATEGORIES.some(c => category.includes(c))) return false;
            if (NON_FOOD_STORES.some(s => storeName.includes(s))) return false;
            if (itemName.includes('dog food') || itemName.includes('cat food') || itemName.includes('pet food')) return false;
            return true;
          });
          if (beforeFilter !== filtered.length) {
            this.logger.log(`🔒 Recommendation filter: ${beforeFilter} → ${filtered.length} (removed ${beforeFilter - filtered.length} non-food/pet items)`);
          }
          allItems.length = 0;
          allItems.push(...filtered);
        }

        // Diversify by store and limit
        const diversified = this.diversifyByStore(allItems, limit);
        
        this.logger.log(`🎯 ${queryMode} complete: ${diversified.length} items from ${
          new Set(diversified.map(i => i.store_id || i.storeId)).size
        } stores`);
        
        // Format results for UI
        const result = this.formatHybridSearchResults(diversified, limit);

        // Enrich cards with store open/closed status
        if (result.output?.cards) {
          result.output.cards = await this.enrichWithSchedule(result.output.cards);
          // Float open restaurants before closed (stable: preserves personalization rank within each group)
          if (result.output.cards?.length > 0) {
            result.output.cards = [
              ...result.output.cards.filter((c: any) => c.isOpen !== false),
              ...result.output.cards.filter((c: any) => c.isOpen === false),
            ];
          }
        }

        // For recommendation mode, add time-aware greeting to output
        if (queryMode === 'recommendation' && result.output) {
          const { emoji, greeting, mealType } = SearchExecutor.getTimeAwareGreeting();
          result.output._greeting = `${emoji} ${greeting}! ${mealType} ke liye kuch tasty items:`;
          result.output._mealType = mealType;
        }

        // Always set headerMessage for show_results template
        if (result.output && !result.output.headerMessage) {
          const count = result.output.cards?.length ?? 0;
          result.output.headerMessage = openNowMode
            ? `🟢 ${count} restaurants open right now!`
            : count > 0 ? `Found ${count} options nearby 🍴` : `No results found nearby`;
        }

        return result;
      }

      // ✅ Log location parameters for debugging
      this.logger.log(
        `🌍 Location params: lat=${lat}, lng=${lng}, zone_id=${zone_id}, radius=${radius}`
      );

      // Log filters for debugging
      if (filters.length > 0) {
        this.logger.log(`🔍 Search filters from config: ${JSON.stringify(filters)}`);
      }

      if (!query) {
        context.data._friendly_error = 'What would you like to search for? Try typing a dish name like "pizza" or "biryani".';
        return {
          success: false,
          error: 'Search query is required',
        };
      }

      // 🎯 PERSONALIZATION: Fetch user profile and apply preferences
      let userProfile = null;
      if (userId && this.userProfiling) {
        try {
          userProfile = await this.userProfiling.getProfile(Number(userId));
          if (userProfile) {
            this.logger.log(`👤 Applying personalization for user ${userId}`);
            
            // Apply dietary preferences as filters
            const dietType = (userProfile.food_preferences?.dietary_type || userProfile.dietary_type || '').toLowerCase();
            const isVegProfile = ['vegetarian','veg','vegan','jain','eggetarian'].includes(dietType);
            if (isVegProfile && !filters.find((f: any) => f.field === 'veg')) {
              filters.push({ field: 'veg', operator: 'equals', value: 1 });
              this.logger.log(`🥗 Applied veg filter from user profile (dietary_type: ${dietType})`);
            }
            
            // Get personalization boosts (favorite items, categories, stores)
            const boosts = await this.userProfiling.getPersonalizationBoosts(Number(userId), index);
            if (Object.keys(boosts.itemBoosts).length > 0) {
              this.logger.log(`⭐ Personalization boosts: ${Object.keys(boosts.itemBoosts).length} favorite items`);
              context.data._personalization_boosts = boosts;
            }
          }
        } catch (error) {
          this.logger.warn(`⚠️ Failed to fetch user profile: ${error.message}`);
        }
      }

      // 🥗 NLU PREFERENCE: Apply veg filter from NLU-extracted preference (e.g., "i am vegetarian")
      // This catches preferences from the CURRENT message, not just user profile
      if (!filters.find(f => f.field === 'veg')) {
        const nluPreference = context.data._user_food_preference || context.data.dietary_preference || context.data.extracted_food?.preference;
        const prefStr = Array.isArray(nluPreference) ? nluPreference.join(' ').toLowerCase() : String(nluPreference || '').toLowerCase();
        if (prefStr.includes('veg') && !prefStr.includes('non-veg') && !prefStr.includes('nonveg')) {
          filters.push({ field: 'veg', operator: 'equals', value: 1 });
          this.logger.log('🥗 Applied vegetarian filter from NLU preference entity');
        }
      }

      // 🏷️ NER ENTITY EXTRACTION: Run Mercury NER in parallel with query expansion
      // Extracts PREF (veg/non-veg) and FOOD (dish name) from conversational queries.
      // Runs non-blocking with a 3s timeout — never delays search meaningfully.
      // Only apply NER veg filter if no veg filter already set by NLU/profile.
      {
        const nerEntities = await this.extractSearchEntities(query);
        if (nerEntities.vegFilter !== undefined && !filters.find(f => f.field === 'veg')) {
          filters.push({ field: 'veg', operator: 'equals', value: nerEntities.vegFilter });
          this.logger.log(`🏷️ NER: Applied veg=${nerEntities.vegFilter} filter from PREF entity`);
        }
        if (nerEntities.refinedQuery) {
          query = nerEntities.refinedQuery;
          this.logger.log(`🏷️ NER: Refined query to "${query}" from FOOD entity`);
        }
      }

      // 🧠 V3 SEARCH INTEGRATION: Use AI understanding for complex queries
      const hasComplexFilters = /\b(cheap|veg|non[- ]?veg|under|below|above|near|around|fastest|quick)\b/i.test(query);
      
      if (hasComplexFilters && this.searchAI && !useSmartSearch) {
        try {
          this.logger.log(`✨ Detected complex query, using V3 understanding: "${query}"`);
          
          const understanding = await this.searchAI.understandQuery(query, {
            module_id: index.includes('food') ? 4 : 5,
            zone_id: zone_id || context.data.zone_id,
            user_location: lat && lng ? { lat: parseFloat(String(lat)), lng: parseFloat(String(lng)) } : undefined,
          });
          
          if (understanding && understanding.confidence > 0.7) {
            // Use AI-refined query
            query = understanding.correctedQuery || query;
            
            // Merge AI-extracted filters
            const aiFilters = understanding.filters || {};
            if (aiFilters.veg !== undefined) {
              filters.push({ field: 'veg', operator: 'equals', value: aiFilters.veg ? 1 : 0 });
            }
            if (aiFilters.max_price) {
              filters.push({ field: 'price', operator: 'lte', value: aiFilters.max_price });
            }
            if (aiFilters.min_price) {
              filters.push({ field: 'price', operator: 'gte', value: aiFilters.min_price });
            }
            if (aiFilters.category) {
              filters.push({ field: 'category', operator: 'equals', value: aiFilters.category });
            }
            
            this.logger.log(`✅ V3 enhanced: "${query}" with ${Object.keys(aiFilters).length} filters (confidence: ${understanding.confidence})`);
          }
        } catch (error) {
          this.logger.warn(`⚠️ V3 understanding failed: ${error.message}`);
        }
      }

      // 🚀 NEW: Use Smart Search (v3 API with all enhanced features)
      // - Spell correction (chiken → chicken)
      // - Synonym expansion (murgi → chicken murgi murga)
      // - Conversational NLP (cheap veg pizza under 300)
      // - Multi-stage ML reranking
      // - Personalization
      if (useSmartSearch) {
        this.logger.log(`🎯 Using SMART search for: "${query}"`);
        
        // ✅ Check for RESOLVED store from EntityResolutionService (architecturally correct)
        const resolvedStore = context.data.resolved_entities?.stores?.[0];
        if (resolvedStore?.id) {
          this.logger.log(
            `🏪 Using RESOLVED store from EntityResolutionService: ${resolvedStore.name} ` +
            `(ID: ${resolvedStore.id}, match_score: ${resolvedStore.match_score}, ` +
            `reason: ${resolvedStore.match_reason})`
          );
        }
        
        // Extract store_id from filters if present
        let storeFilter = filters.find((f: any) => f.field === 'store_id');
        const storeNameFilter = filters.find((f: any) => f.field === 'store_name');
        const vegFilter = filters.find((f: any) => f.field === 'veg');

        // Strip "store_" prefix from button values (e.g. "store_123" → 123)
        if (storeFilter && typeof storeFilter.value === 'string' && storeFilter.value.startsWith('store_')) {
          storeFilter = { ...storeFilter, value: parseInt(storeFilter.value.replace('store_', ''), 10) };
        }
        
        // 🏪 SMART STORE RESOLUTION: Use EntityResolutionService result first, then fallback
        let resolvedStoreId: number | undefined = resolvedStore?.id as number || storeFilter?.value as number;
        let storeResolutionStatus: 'exact' | 'similar' | 'not_found' = resolvedStore?.id ? 'exact' : 'exact';
        let similarStores: any[] = [];
        let requestedStoreName: string | undefined = resolvedStore?.name || context.data.resolved_store_context?.requested_store_name;
        
        if (!resolvedStoreId && storeNameFilter?.value) {
          requestedStoreName = String(storeNameFilter.value);
          this.logger.log(`🏪 Resolving store name "${requestedStoreName}" to store_id for smart search...`);
          
          try {
            const storeResult = await this.searchService.findStoreByName(requestedStoreName, {
              module_id: context.data.module_id || (index.includes('food') ? 4 : 5),
            });
            
            if (storeResult.storeId) {
              resolvedStoreId = storeResult.storeId;
              storeResolutionStatus = 'exact';
              this.logger.log(`✅ Resolved "${requestedStoreName}" → store_id: ${resolvedStoreId} (${storeResult.storeName})`);
            } else {
              // Try to find similar stores for suggestions
              storeResolutionStatus = 'not_found';
              this.logger.warn(`⚠️ Could not resolve store "${requestedStoreName}" - trying to find similar stores`);
              
              try {
                // Search for stores with fuzzy matching
                const fuzzyStoreResult = await this.searchService.search({
                  index: 'stores',
                  query: requestedStoreName,
                  limit: 3,
                  filters: [],
                });
                
                if (fuzzyStoreResult.results?.length > 0) {
                  similarStores = fuzzyStoreResult.results.map((s: any) => ({
                    id: s.id || s.source?.id,
                    name: s.source?.name || s.name,
                    rating: s.source?.rating,
                  }));
                  storeResolutionStatus = 'similar';
                  this.logger.log(`📋 Found ${similarStores.length} similar stores: ${similarStores.map(s => s.name).join(', ')}`);
                }
              } catch (fuzzyErr) {
                this.logger.debug(`Fuzzy store search failed: ${fuzzyErr.message}`);
              }
              
              // 📊 Track the not-found store for business intelligence
              this.trackNotFoundStore(requestedStoreName, userId, lat, lng, platform).catch(() => {});
            }
          } catch (err) {
            storeResolutionStatus = 'not_found';
            this.logger.warn(`⚠️ Store resolution failed: ${err.message}`);
          }
        }
        
        const smartResult = await this.enhancedSearchService.smartSearch(query, {
          moduleId: index.includes('food') ? 4 : undefined,
          size: limit, // EnhancedSearchService handles over-fetching for store filtering
          storeId: resolvedStoreId,
          veg: vegFilter?.value as string,
          userId: userId ? Number(userId) : undefined,
          zone_id: zone_id, // ✅ Pass zone_id for location-based search
          lat: typeof lat === 'string' ? parseFloat(lat) : lat,
          lng: typeof lng === 'string' ? parseFloat(lng) : lng,
        });
        
        // 🔧 SAFETY NET: EnhancedSearchService now handles store filtering (see GAP_ANALYSIS_ARCHITECTURE.md)
        // This is a backup in case store filter wasn't applied properly
        let filteredItems = smartResult.items;
        if (resolvedStoreId && filteredItems.length > 0) {
          const beforeCount = filteredItems.length;
          filteredItems = filteredItems.filter((item: any) => {
            const itemStoreId = item.store_id || item.storeId;
            return itemStoreId === resolvedStoreId || 
                   String(itemStoreId) === String(resolvedStoreId);
          });
          const afterCount = filteredItems.length;
          
          if (beforeCount !== afterCount) {
            this.logger.log(`📋 Safety net filter applied: ${beforeCount} → ${afterCount} results (store_id: ${resolvedStoreId})`);
          }
          
          // If no results after filtering, search specifically for that store
          if (afterCount === 0) {
            this.logger.warn(`⚠️ No results for store ${resolvedStoreId}, trying store-specific search...`);
            
            try {
              // Use the v2 items endpoint which properly filters by store_id
              const storeItems = await this.searchService.search({
                index: 'food_items',
                query: query,
                limit: limit,
                filters: [{ field: 'store_id', operator: 'equals', value: resolvedStoreId }],
              });
              filteredItems = (storeItems.results || []).map((item: any) => ({
                id: item.id,
                ...item.source,
              }));
              this.logger.log(`✅ Store-specific search returned ${filteredItems.length} items`);
            } catch (err) {
              this.logger.warn(`Store-specific search failed: ${err.message}`);
            }
          }
        }
        
        // Module safety net: Search API now handles module_id filtering at OpenSearch level,
        // but we keep this as defense-in-depth to prevent cross-module data leaks
        if (index.includes('food')) {
          const beforeModuleFilter = filteredItems.length;
          filteredItems = filteredItems.filter((item: any) =>
            !item.module_id || item.module_id === 4 || String(item.module_id) === '4'
          );
          if (beforeModuleFilter !== filteredItems.length) {
            this.logger.log(`🔒 Module safety net: filtered ${beforeModuleFilter} → ${filteredItems.length} (removed non-food module items)`);
          }
        }

        // 🧹 TEST DATA FILTER: Remove test stores, placeholder items, and demo data
        filteredItems = this.filterTestData(filteredItems);

        // Update smartResult with diversified items (show items from multiple stores, not just one)
        smartResult.items = this.diversifyByStore(filteredItems, limit);

        // Track search event for analytics
        this.enhancedSearchService.trackEvent({
          type: 'search',
          query: query,
          userId: userId ? Number(userId) : undefined,
          moduleId: index.includes('food') ? 4 : undefined,
          metadata: {
            searchType: smartResult.searchType,
            intent: smartResult.query.intent,
            resultsCount: smartResult.items.length,
          },
        }).catch(() => {}); // Non-blocking

        // Pass store resolution info to format method
        const storeResolution = {
          status: storeResolutionStatus,
          requestedName: requestedStoreName,
          resolvedId: resolvedStoreId,
          similarStores: similarStores,
        };

        return this.formatSmartSearchResults(smartResult, limit, storeResolution);
      }

      // If useIntentSearch is enabled, use the Search API v2 which handles
      // queries like "pizza from Inayat" automatically
      if (useIntentSearch) {
        this.logger.log(`🧠 Using intent-aware search for: "${query}"`);
        
        // Extract store_id from filters if present
        const storeFilter = filters.find((f: any) => f.field === 'store_id' || f.field === 'store_name');
        const storeId = storeFilter?.value;
        
        const results = await this.searchService.searchWithIntent(query, {
          module_id: index.includes('food') ? 4 : undefined,
          store_id: typeof storeId === 'number' ? storeId : undefined,
          lat: typeof lat === 'string' ? parseFloat(lat) : lat,
          lng: typeof lng === 'string' ? parseFloat(lng) : lng,
          radius_km: parseFloat(radius) || 10,
          size: limit,
          semantic: true,
          platform,
        });

        const formatted = this.formatSearchResults(results, limit);
        if (formatted.output?.cards) {
          formatted.output.cards = await this.enrichWithSchedule(formatted.output.cards);
          // Float open restaurants before closed (stable: preserves personalization rank within each group)
          if (formatted.output.cards?.length > 0) {
            formatted.output.cards = [
              ...formatted.output.cards.filter((c: any) => c.isOpen !== false),
              ...formatted.output.cards.filter((c: any) => c.isOpen === false),
            ];
          }
        }
        if (formatted.output && !formatted.output.headerMessage) {
          const count = formatted.output.cards?.length ?? 0;
          formatted.output.headerMessage = count > 0
            ? `Found ${count} options nearby 🍴`
            : `No results found nearby`;
        }
        return formatted;
      }

      // 🆕 STORE-FIRST RESOLUTION: When searching food_items with no store filter,
      // check if the query itself is a store name. This handles cases like
      // user typing just "tushar" which is actually "Tushar Misal" restaurant.
      const hasStoreFilter = filters.some((f: any) => f.field === 'store_name' || f.field === 'store_id');
      if (index.includes('food_items') && !hasStoreFilter) {
        const queryWords = query.trim().split(/\s+/);
        // Common food words that should NOT trigger store lookup
        const commonFoodWords = new Set([
          'pizza', 'burger', 'biryani', 'naan', 'tikka', 'paneer', 'chicken', 'mutton',
          'rice', 'dal', 'curry', 'sabzi', 'roti', 'paratha', 'dosa', 'idli', 'vada',
          'samosa', 'momos', 'noodles', 'thali', 'chai', 'tea', 'coffee', 'lassi',
          'juice', 'shake', 'pav', 'bhaji', 'misal', 'missal', 'sandwich', 'roll',
          'cake', 'pastry', 'ice cream', 'kulfi', 'gulab jamun', 'jalebi', 'falooda',
          'chowmein', 'fried rice', 'manchurian', 'soup', 'salad', 'wrap',
          'popular', 'food', 'menu', 'items', 'best', 'cheap', 'nearby', 'veg', 'nonveg',
        ]);
        
        // Only check if query is 1-2 words and not a common food word
        const isLikelyNotFood = queryWords.length <= 2 && 
          !queryWords.every(w => commonFoodWords.has(w.toLowerCase()));
        
        if (isLikelyNotFood) {
          try {
            const storeCheck = await this.searchService.findStoreByName(query, { module_id: context.data.module_id || (index.includes('food') ? 4 : 5) });
            if (storeCheck.storeId && storeCheck.score >= 300) {
              this.logger.log(`🏪 Store-first match: "${query}" → ${storeCheck.storeName} (ID: ${storeCheck.storeId}, score: ${storeCheck.score})`);
              // Add store_id filter and change query to broad menu search
              filters.push({
                field: 'store_id',
                operator: 'equals',
                value: storeCheck.storeId,
              });
              // Search for all items from this store (broad query)
              query = 'popular food items menu';
              this.logger.log(`📍 Redirected to store menu search for ${storeCheck.storeName}`);
            }
          } catch (err) {
            this.logger.debug(`Store-first check failed (non-critical): ${err.message}`);
          }
        }
      }

      // Add geo-location filter if coordinates provided
      if (lat && lng) {
        // Parse coordinates if they're strings (from Handlebars interpolation)
        const parsedLat = typeof lat === 'string' ? parseFloat(lat) : lat;
        const parsedLng = typeof lng === 'string' ? parseFloat(lng) : lng;
        
        if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
          this.logger.log(`📍 Adding geo-distance filter: lat=${parsedLat}, lng=${parsedLng}, radius=${radius}`);
          // Use 'store_location' for food_items_v3, 'location' for other indices
          const geoField = index.includes('food_items') ? 'store_location' : 'location';
          filters.push({
            field: geoField,
            operator: 'geo_distance',
            value: { lat: parsedLat, lon: parsedLng, distance: radius }
          });
        } else {
          this.logger.warn(`⚠️ Invalid location coordinates: lat=${lat}, lng=${lng}`);
        }
      }

      // 🔧 SMART STORE RESOLUTION: Convert store_name filter to store_id for better accuracy
      const storeNameFilterIdx = filters.findIndex((f: any) => f.field === 'store_name');
      let resolvedStoreId: number | null = null;
      let resolvedStoreName: string | null = null;
      
      if (storeNameFilterIdx >= 0 && filters[storeNameFilterIdx].value) {
        const storeName = String(filters[storeNameFilterIdx].value);
        this.logger.log(`🏪 Resolving store name "${storeName}" to store_id...`);
        
        try {
          // Use dedicated store search endpoint for accurate resolution
          const storeResult = await this.searchService.findStoreByName(storeName, {
            module_id: context.data.module_id || (index.includes('food') ? 4 : 5),
          });
          
          if (storeResult.storeId) {
            resolvedStoreId = storeResult.storeId;
            resolvedStoreName = storeResult.storeName || storeName;
            this.logger.log(`✅ Resolved "${storeName}" → store_id: ${resolvedStoreId} (${resolvedStoreName})`);
            
            // Replace store_name filter with store_id filter for precise matching
            filters[storeNameFilterIdx] = {
              field: 'store_id',
              operator: 'equals',
              value: resolvedStoreId,
            };
          } else {
            this.logger.warn(`⚠️ Could not resolve store "${storeName}" - will use fuzzy name matching`);
          }
        } catch (err) {
          this.logger.warn(`⚠️ Store resolution failed: ${err.message} - will use fuzzy name matching`);
        }
      }

      // Log all filters before search
      this.logger.log(`🔍 Final search filters: ${JSON.stringify(filters)}`);
      this.logger.debug(`Searching ${index} for: "${query}"`);

      // 🍔 Determine if this is a food search (used for module filtering and query expansion)
      const isFoodSearch = index.includes('food');

      // 🍔 GENERIC FOOD QUERY EXPANSION: When the query is just "food" or other super-generic category
      // words, the search API returns pet food, beauty products etc. because "Cat Food", "Dog Food"
      // literally contain "food". Expand to "popular items" which returns actual restaurant items.
      if (isFoodSearch && !resolvedStoreId) {
        const genericFoodWords = new Set(['food', 'foods', 'khana', 'khaana', 'snack', 'snacks', 'drink', 'drinks', 'meal', 'meals', 'nashta', 'breakfast', 'lunch', 'dinner', 'tiffin']);
        const queryLower = query.trim().toLowerCase();
        if (genericFoodWords.has(queryLower)) {
          this.logger.log(`🍽️ Generic food query "${query}" detected — expanding to "popular items" for better restaurant results`);
          query = 'popular items';
        }
      }

      // MODULE FILTERING: Request 2x buffer for diversity algorithm and post-filtering.
      // Search API now handles module_id filtering at OpenSearch level, so 6x is no longer needed.
      const searchLimit = isFoodSearch ? limit * 2 : limit * 2;

      // Perform search
      const results = await this.searchService.search({
        index,
        query,
        limit: searchLimit,
        filters,
        platform,
      });

      // Flatten results for easier template access - extract source and add id
      let flattenedItems = (results.results || []).map((item: any) => ({
        id: item.id,
        ...item.source, // Spread all source fields (title, mrp, brand, category, etc.)
      }));

      // 🍔 MODULE FILTER: For food searches, only include items from food/restaurant module (module_id=4)
      // This filters out pet food (module_id=5,13), beauty products, grocery items etc.
      if (isFoodSearch) {
        const beforeModuleFilter = flattenedItems.length;
        flattenedItems = flattenedItems.filter((item: any) => {
          const moduleId = Number(item.module_id);
          return moduleId === 4 || moduleId === 17; // 4=Food, 17=Food (alternate)
        });
        const afterModuleFilter = flattenedItems.length;
        if (beforeModuleFilter !== afterModuleFilter) {
          this.logger.log(`🍔 Module filter (food only): ${beforeModuleFilter} → ${afterModuleFilter} results (removed ${beforeModuleFilter - afterModuleFilter} non-food items)`);
        }
      }

      // 🐕 NON-FOOD CATEGORY FILTER: Remove pet food, animal supplies etc. that are mis-categorized as food
      if (isFoodSearch) {
        const NON_FOOD_CATEGORIES = ['dog food', 'cat food', 'pet food', 'bird food', 'fish food', 'animal feed', 'pet supplies', 'pet care'];
        const NON_FOOD_STORES = ['fins aquarium', 'pet shop', 'pet store', 'aquarium'];
        const beforeCatFilter = flattenedItems.length;
        flattenedItems = flattenedItems.filter((item: any) => {
          const category = String(item.category_name || item.category || '').toLowerCase();
          const storeName = String(item.store_name || item.storeName || '').toLowerCase();
          const itemName = String(item.name || '').toLowerCase();
          const isNonFoodCategory = NON_FOOD_CATEGORIES.some(c => category.includes(c));
          const isNonFoodStore = NON_FOOD_STORES.some(s => storeName.includes(s));
          const isNonFoodItem = itemName.includes('dog food') || itemName.includes('cat food') || itemName.includes('pet food');
          return !isNonFoodCategory && !isNonFoodStore && !isNonFoodItem;
        });
        if (beforeCatFilter !== flattenedItems.length) {
          this.logger.log(`🐕 Non-food filter: ${beforeCatFilter} → ${flattenedItems.length} (removed ${beforeCatFilter - flattenedItems.length} pet/non-food items)`);
        }
      }

      // 🧹 TEST DATA FILTER: Remove test stores, placeholder items, and demo data
      flattenedItems = this.filterTestData(flattenedItems);

      // 🔧 POST-FILTER: Ensure restaurant filter is applied (in case OpenSearch filter failed)
      // Use resolved store_id if available, otherwise fall back to fuzzy store_name matching
      if (resolvedStoreId) {
        const beforeCount = flattenedItems.length;
        flattenedItems = flattenedItems.filter((item: any) => {
          return item.store_id === resolvedStoreId || 
                 String(item.store_id) === String(resolvedStoreId);
        });
        const afterCount = flattenedItems.length;
        if (beforeCount !== afterCount) {
          this.logger.log(`📋 Post-filter by store_id: ${beforeCount} → ${afterCount} results (store_id: ${resolvedStoreId})`);
        }
      } else {
        // Fallback to fuzzy store_name matching if store_id resolution failed
        const originalStoreNameFilter = filters.find((f: any) => f.field === 'store_name');
        if (originalStoreNameFilter && originalStoreNameFilter.value) {
          const targetStore = String(originalStoreNameFilter.value).toLowerCase();
          const beforeCount = flattenedItems.length;
          flattenedItems = flattenedItems.filter((item: any) => {
            const storeName = (item.store_name || '').toLowerCase();
            // Fuzzy match: check if store name contains target or vice versa
            return storeName.includes(targetStore) || targetStore.includes(storeName) ||
                   this.fuzzyMatch(storeName, targetStore, 0.6); // 60% similarity threshold
          });
          const afterCount = flattenedItems.length;
          if (beforeCount !== afterCount) {
            this.logger.log(`📋 Post-filter by fuzzy name: ${beforeCount} → ${afterCount} results (filter: "${originalStoreNameFilter.value}")`);
          }
        }
      }

      // ⭐ PERSONALIZATION RERANKING: Apply user preference boosts to reorder results
      // Uses boosts fetched earlier from user profiling (favorite items, categories, stores)
      const personalizationBoosts = context.data._personalization_boosts;
      if (personalizationBoosts && flattenedItems.length > 0) {
        const { itemBoosts = {}, categoryBoosts = {}, storeBoosts = {} } = personalizationBoosts;
        const hasBoosts = Object.keys(itemBoosts).length > 0 || Object.keys(categoryBoosts).length > 0 || Object.keys(storeBoosts).length > 0;
        
        if (hasBoosts) {
          // Score each item with personalization boost
          flattenedItems = flattenedItems.map((item: any, idx: number) => {
            let boostScore = 1.0; // Base score
            const itemId = String(item.id || item.item_id);
            const categoryId = String(item.category_id || '');
            const storeId = String(item.store_id || '');
            
            // Favorite item boost (3x)
            if (itemBoosts[itemId]) boostScore *= itemBoosts[itemId];
            // Favorite category boost (2x)
            if (categoryBoosts[categoryId]) boostScore *= categoryBoosts[categoryId];
            // Favorite store boost (2.5x)
            if (storeBoosts[storeId]) boostScore *= storeBoosts[storeId];
            
            return { ...item, _personalization_score: boostScore, _original_rank: idx };
          });
          
          // Sort by personalization score (higher = better), keeping original order for equal scores
          flattenedItems.sort((a: any, b: any) => {
            if (b._personalization_score !== a._personalization_score) {
              return b._personalization_score - a._personalization_score;
            }
            return a._original_rank - b._original_rank;
          });
          
          const boostedCount = flattenedItems.filter((i: any) => i._personalization_score > 1.0).length;
          if (boostedCount > 0) {
            this.logger.log(`⭐ Personalization: boosted ${boostedCount} items based on user preferences`);
          }
        }
      }

      // Diversify results across multiple stores (for discovery/browse mode)
      // If no store filter is applied, show variety from different restaurants
      if (!resolvedStoreId) {
        flattenedItems = this.diversifyByStore(flattenedItems, limit);
      } else {
        // Store filter applied - just slice
        flattenedItems = flattenedItems.slice(0, limit);
      }

      // Get user location for distance calculation
      const parsedUserLat = typeof lat === 'string' ? parseFloat(lat) : lat;
      const parsedUserLng = typeof lng === 'string' ? parseFloat(lng) : lng;
      const hasUserLocation = !isNaN(parsedUserLat) && !isNaN(parsedUserLng);

      const output: any = {
        items: flattenedItems,
        total: results.total || 0,
        hasResults: flattenedItems.length > 0,
      };

      // Use MinIO CDN URL for images (S3 bucket is inaccessible)
      const getImageUrl = (item: any): string | undefined => resolveImageUrl(item, this.storageCdnUrl);

      // Always generate UI cards for product results
      if (output.hasResults) {
        output.cards = flattenedItems.slice(0, 10).map((item: any) => {
          // Search API returns most fields nested in _source — fall back to _source for fields not at top level
          const src = item._source || {};
          // Calculate distance from user if we have coordinates
          const storeLat = item.store_location?.lat || item.store_latitude || src.store_latitude || src.store_location?.lat;
          const storeLng = item.store_location?.lon || item.store_longitude || src.store_longitude || src.store_location?.lon;
          let distanceKm: number | undefined;
          let distanceText: string | undefined;

          if (hasUserLocation && storeLat && storeLng) {
            distanceKm = this.calculateDistance(parsedUserLat, parsedUserLng, storeLat, storeLng);
            distanceText = distanceKm < 1
              ? `${Math.round(distanceKm * 1000)}m away`
              : `${distanceKm.toFixed(1)}km away`;
          }

          const itemMrp = item.mrp || src.mrp;
          const itemPrice = item.price || src.price;
          const foodVariations = item.food_variations || src.food_variations || [];
          const parsedVariations = typeof foodVariations === 'string' ? (() => { try { return JSON.parse(foodVariations); } catch { return []; } })() : foodVariations;

          return {
            id: item.id,
            name: item.title || item.name || src.name,
            description: item.description || item.category || src.category,
            price: itemMrp ? `₹${itemMrp}` : (itemPrice ? `₹${itemPrice}` : undefined),
            rawPrice: itemMrp || itemPrice,
            image: getImageUrl(item),
            rating: (() => { const r = parseFloat(item.rating || item.avg_rating || src.avg_rating || '0'); return r > 0 ? r.toFixed(1) : undefined; })(),
            deliveryTime: item.delivery_time || src.delivery_time || '30-45 min',
            brand: item.brand || src.brand,
            category: item.category || item.category_name || src.category_name,
            storeName: item.store_name || src.store_name,
            storeId: item.store_id || src.store_id,
            moduleId: item.module_id || src.module_id,
            storeLat,
            storeLng,
            distanceKm,
            distance: distanceText,
            veg: item.veg ?? src.veg,
            cardType: index === 'stores' ? 'store' : (index?.includes('ecom') ? 'product' : 'food'),
            has_variant: (() => {
              if (index === 'stores') return 0;
              if (Array.isArray(parsedVariations) && parsedVariations.length > 0) return 1;
              return item.has_variant || src.has_variant || 0;
            })(),
            food_variations: index === 'stores' ? [] : (Array.isArray(parsedVariations) ? parsedVariations : []),
            action: {
              label: index === 'stores' ? 'View Menu' : 'Add +',
              value: index === 'stores' ? `store_${item.id || src.id}` : `item_${item.id || src.id}`,
            }
          };
        });
        
        // Sort by distance if available (closest first)
        if (hasUserLocation) {
          output.cards.sort((a: any, b: any) => {
            if (a.distanceKm === undefined) return 1;
            if (b.distanceKm === undefined) return -1;
            return a.distanceKm - b.distanceKm;
          });
        }
      }

      this.logger.debug(`Found ${output.total} results`);

      // Phase 2: Record search interaction for training
      await this.recordSearchInteraction(context, query, output.hasResults);

      // Determine event based on results
      const event = output.hasResults ? 'items_found' : 'no_items';

      // Set friendly error for no results so response executor can show a helpful message
      if (!output.hasResults) {
        const COMMON_ALTERNATIVES = ['biryani', 'pizza', 'thali', 'burger', 'paneer', 'roti'];
        const suggestions = COMMON_ALTERNATIVES.filter(s => !query.toLowerCase().includes(s)).slice(0, 3).join(', ');
        context.data._friendly_error = `Couldn't find anything for *"${query}"* nearby 😔\n\nTry searching for: ${suggestions}, or browse our categories below.`;
        output.zeroResultQuery = query;
      }

      // Enrich cards with store open/closed status
      if (output.cards) {
        output.cards = await this.enrichWithSchedule(output.cards);
        // Float open restaurants before closed (stable: preserves personalization rank within each group)
        if (output.cards?.length > 0) {
          output.cards = [
            ...output.cards.filter((c: any) => c.isOpen !== false),
            ...output.cards.filter((c: any) => c.isOpen === false),
          ];
        }
        // 🟢 OPEN NOW MODE: Filter to only open restaurants if flag set
        if (openNowMode && output.cards?.length > 0) {
          const before = output.cards.length;
          output.cards = output.cards.filter((c: any) => c.isOpen !== false);
          output.totalItems = output.cards.length;
          output.openNowFiltered = true;
          output.headerMessage = `🟢 ${output.cards.length} restaurants open right now!`;
          this.logger.log(`🟢 Open-now filter: ${before} → ${output.cards.length} restaurants`);
        }
        // Build contextual filter buttons based on result set
        if (!openNowMode) {
          const vegFilterEntry = filters?.find((f: any) => f.field === 'veg');
          const ratingFilterEntry = filters?.find((f: any) => f.field === 'rating_min');
          output.filterButtons = this.buildFilterButtons(
            output.cards,
            vegFilterEntry?.value as string | undefined,
            ratingFilterEntry?.value as number | undefined,
          );
        }
        // Store result count for friendly message interpolation
        output.totalItems = output.cards.length;
        // Always set headerMessage so show_results {{search_results.headerMessage}} has a value
        if (!output.headerMessage) {
          output.headerMessage = output.cards.length > 0
            ? `Found ${output.cards.length} options nearby 🍴`
            : `No results found nearby`;
        }
      }

      // Fallback: ensure headerMessage is always set even when output.cards is undefined (zero results path)
      if (!output.headerMessage) {
        output.headerMessage = `No results found nearby`;
      }

      // Log with location for geographic insights (non-blocking)
      if (this.searchAnalytics && lat && lng) {
        this.searchAnalytics.logSearch({
          query,
          searchType: useSmartSearch ? 'smart' : 'standard',
          filters: filters.reduce((acc: Record<string, any>, f: any) => { acc[f.field] = f.value; return acc; }, {}),
          resultsCount: output.totalItems ?? output.cards?.length ?? 0,
          executionTimeMs: 0,
          sessionId: context.data._session_id || context.data.sessionId,
          userId: userId,
          platform,
          lat: typeof lat === 'string' ? parseFloat(lat) : lat,
          lon: typeof lng === 'string' ? parseFloat(String(lng)) : (lng as number),
        }).catch(() => {});
      }

      return {
        success: true,
        output,
        event,
      };
    } catch (error) {
      this.logger.error(`Search execution failed: ${error.message}`, error.stack);

      // Set user-friendly error for the response executor
      context.data._friendly_error = 'Sorry, search is temporarily unavailable. Please try again in a moment.';

      // On error (like timeout), return no_items event so flow can proceed to external vendor search
      return {
        success: false,
        error: error.message,
        event: 'no_items', // Allow flow to handle gracefully via show_restaurant_not_found → external vendor
        output: {
          hasResults: false,
          items: [],
          stores: [],
          message: `Search failed: ${error.message}`,
        },
      };
    }
  }

  validate(config: Record<string, any>): boolean {
    if (config.type === 'categories') return true;
    if (config.type === 'category_items') return !!config.categoryId;
    return !!(config.query || config.queryPath);
  }

  /**
   * Format search results into the standard output format with UI cards
   */
  /**
   * Format Hybrid/Multi-term Search results for flow output
   * 
   * Used for recommendations and diverse discovery searches
   */
  private formatHybridSearchResults(items: any[], limit: number): ActionExecutionResult {
      // S3 bucket and storage CDN for images
      const S3_BASE = 'https://s3.ap-south-1.amazonaws.com/mangwale/product';
      const STORAGE_CDN = this.storageCdnUrl;

      // Helper to get proper image URL — always normalize to filename for frontend fallback
      const getImageUrl = (item: any): string | undefined => {
        let imageUrl = item.image || item.images?.[0] || item.image_url;
        if (!imageUrl) imageUrl = item.image_full_url || item.image_fallback_url;
        if (!imageUrl) return undefined;
        let filename = imageUrl;
        if (filename.startsWith('http://') || filename.startsWith('https://')) {
          try { const p = filename.split('/'); filename = p[p.length - 1] || filename; } catch { /* keep */ }
        }
        if (filename.startsWith('/product/')) filename = filename.replace('/product/', '');
        else if (filename.startsWith('product/')) filename = filename.replace('product/', '');
        return `https://mangwale.s3.ap-south-1.amazonaws.com/product/${filename}`;
      };

    const output: any = {
      items: items,
      total: items.length,
      hasResults: items.length > 0,
    };

    // Generate UI cards
    if (output.hasResults) {
      output.cards = items.slice(0, limit).map((item: any) => ({
        id: item.id || item.item_id,
        name: item.name || item.title || item.item_name,
        description: item.description || item.category_name || item.category,
        price: item.price ? `₹${item.price}` : (item.mrp ? `₹${item.mrp}` : undefined),
        rawPrice: item.price || item.mrp,
        image: getImageUrl(item),
        rating: (() => { const r = parseFloat(item.rating || item.avg_rating || '0'); return r > 0 ? r.toFixed(1) : undefined; })(),
        deliveryTime: item.delivery_time || '30-45 min',
        brand: item.brand,
        category: item.category_name || item.category,
        storeName: item.store_name,
        storeId: item.store_id || item.storeId,
        moduleId: item.module_id,
        storeLat: item.store_location?.lat || item.store_latitude,
        storeLng: item.store_location?.lon || item.store_longitude,
        veg: item.veg,
        has_variant: item.has_variant || 0,
        food_variations: item.food_variations || [],
        action: {
          label: 'Add +',
          value: `item_${item.id}`
        }
      }));
    }

    const event = output.hasResults ? 'items_found' : 'no_items';

    this.logger.log(`📦 Hybrid search formatted: ${output.cards?.length || 0} cards from ${
      new Set((output.cards || []).map((c: any) => c.storeId)).size
    } stores`);

    return {
      success: true,
      output,
      event,
    };
  }

  private formatSearchResults(results: any, limit: number): ActionExecutionResult {
      // S3 bucket and storage CDN for images
      const S3_BASE = 'https://s3.ap-south-1.amazonaws.com/mangwale/product';
      const STORAGE_CDN = this.storageCdnUrl;

      // Helper to get proper image URL — always normalize to filename for frontend fallback
      const getImageUrl = (item: any): string | undefined => {
        let imageUrl = item.image || item.images?.[0] || item.image_url;
        if (!imageUrl) imageUrl = item.image_full_url || item.image_fallback_url;
        if (!imageUrl) return undefined;
        let filename = imageUrl;
        if (filename.startsWith('http://') || filename.startsWith('https://')) {
          try { const p = filename.split('/'); filename = p[p.length - 1] || filename; } catch { /* keep */ }
        }
        if (filename.startsWith('/product/')) filename = filename.replace('/product/', '');
        else if (filename.startsWith('product/')) filename = filename.replace('product/', '');
        return `https://mangwale.s3.ap-south-1.amazonaws.com/product/${filename}`;
      };

    // Flatten results
    const flattenedItems = (results.results || []).map((item: any) => ({
      id: item.id,
      ...(item.source || item),
    }));

    const output: any = {
      items: flattenedItems,
      total: results.total || 0,
      hasResults: flattenedItems.length > 0,
    };

    // Generate UI cards
    if (output.hasResults) {
      output.cards = flattenedItems.slice(0, limit).map((item: any) => ({
        id: item.id,
        name: item.title || item.name,
        description: item.description || item.category,
        price: item.mrp ? `₹${item.mrp}` : (item.price ? `₹${item.price}` : undefined),
        rawPrice: item.mrp || item.price,
        image: getImageUrl(item),
        rating: (() => { const r = parseFloat(item.rating || item.avg_rating || '0'); return r > 0 ? r.toFixed(1) : undefined; })(),
        deliveryTime: item.delivery_time || '30-45 min',
        brand: item.brand,
        category: item.category || item.category_name,
        storeName: item.store_name,
        storeId: item.store_id,
        moduleId: item.module_id,
        storeLat: item.store_location?.lat || item.store_latitude,
        storeLng: item.store_location?.lon || item.store_longitude,
        veg: item.veg,
        has_variant: item.has_variant || 0,
        food_variations: item.food_variations || [],
        action: {
          label: 'Add +',
          value: `item_${item.id}`
        }
      }));
    }

    const event = output.hasResults ? 'items_found' : 'no_items';

    return {
      success: true,
      output,
      event,
    };
  }

  /**
   * Phase 2: Record search interaction for training
   */
  private async recordSearchInteraction(context: FlowContext, query: string, hasResults: boolean): Promise<void> {
    try {
      const userMessage = context.data._user_message || query;
      
      const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
        conversation_history: context.data._conversation_history || [],
        flow_stage: 'product_search',
      });

      await this.advancedLearning.recordTrainingData({
        message: userMessage,
        questionType: 'product_search',
        actualClassification: hasResults,
        predictedClassification: hasResults,
        confidence: hasResults ? 0.85 : 0.3,
        flowContext: 'product_search',
        language: this.detectLanguage(userMessage),
        userId: context._system?.userId || 'unknown',
        sessionId: context._system?.sessionId || 'unknown',
      });

      if (!hasResults && sentiment.frustration_score > 0.6) {
        this.logger.log(`😤 Search frustration: No results for "${query}", frustration: ${sentiment.frustration_score.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.warn(`Phase 2 search tracking failed: ${error.message}`);
    }
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/;
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  /**
   * Format Smart Search results for flow output
   * 
   * Includes enhanced query understanding info and NLP entities
   */
  private formatSmartSearchResults(
    smartResult: import('../../search/services/enhanced-search.service').SmartSearchResult,
    limit: number,
    storeResolution?: {
      status: 'exact' | 'similar' | 'not_found';
      requestedName?: string;
      resolvedId?: number;
      similarStores?: any[];
    }
  ): ActionExecutionResult {
    // S3 bucket and storage CDN for images
    const S3_BASE = 'https://s3.ap-south-1.amazonaws.com/mangwale/product';
    const STORAGE_CDN = this.storageCdnUrl;
    
    // Helper to get proper image URL — always normalize to filename for frontend fallback
    const getImageUrl = (item: any): string | undefined => {
      let imageUrl = item.image || item.images?.[0] || item.image_url;
      if (!imageUrl) imageUrl = item.image_full_url || item.image_fallback_url;
      if (!imageUrl) return undefined;
      let filename = imageUrl;
      if (filename.startsWith('http://') || filename.startsWith('https://')) {
        try { const p = filename.split('/'); filename = p[p.length - 1] || filename; } catch { /* keep */ }
      }
      if (filename.startsWith('/product/')) filename = filename.replace('/product/', '');
      else if (filename.startsWith('product/')) filename = filename.replace('product/', '');
      return `https://mangwale.s3.ap-south-1.amazonaws.com/product/${filename}`;
    };

    // Use diversification if available (already diversified in execute), otherwise just slice
    const items = smartResult.items.slice(0, limit);
    const hasResults = items.length > 0;

    const output: any = {
      items,
      total: smartResult.total,
      hasResults,
      
      // Enhanced query info (for debugging and UX)
      queryInfo: {
        original: smartResult.query.original,
        understood: smartResult.query.understood,
        expanded: smartResult.query.expanded,
        intent: smartResult.query.intent,
        confidence: smartResult.query.confidence,
        searchType: smartResult.searchType,
      },
      
      // Applied filters from NLP (for UX display)
      appliedFilters: smartResult.filters,
      
      // NLP response (for conversational UX)
      nlpResponse: smartResult.nlp?.response || null,
    };

    // Generate UI cards
    if (hasResults) {
      output.cards = items.map((item: any) => ({
        id: item.id,
        name: item.name || item.title,
        description: item.description || item.category_name,
        price: item.price ? `₹${item.price}` : undefined,
        rawPrice: item.price,
        image: getImageUrl(item),
        rating: (() => { const r = parseFloat(item.avg_rating || item.rating || '0'); return r > 0 ? r.toFixed(1) : undefined; })(),
        deliveryTime: item.delivery_time || '30-45 min',
        category: item.category_name || item.category,
        storeName: item.store_name,
        storeId: item.store_id,
        moduleId: item.module_id,
        // Store coordinates for distance calculation (critical for checkout flow)
        storeLat: item.store_location?.lat || item.store_latitude,
        storeLng: item.store_location?.lon || item.store_longitude,
        veg: item.veg,
        // Reranking signals (from multi-stage)
        signals: item._signals,
        action: {
          label: 'Add +',
          value: `item_${item.id}`
        }
      }));
    }

    // Include store resolution info for flow to handle "not found" cases
    if (storeResolution) {
      output.storeResolution = storeResolution;
    }

    const event = hasResults ? 'items_found' : 'no_items';

    this.logger.log(
      `🎯 Smart Search Results: ${items.length}/${smartResult.total} items ` +
      `(type: ${smartResult.searchType}, intent: ${smartResult.query.intent}, ${smartResult.latencyMs}ms)`
    );

    return {
      success: true,
      output,
      event,
    };
  }

  /**
   * Track stores that users request but don't exist in our database
   * This helps business development identify restaurants to onboard
   */
  private async trackNotFoundStore(
    storeName: string,
    userId?: string,
    lat?: number | string,
    lng?: number | string,
    platform?: string,
  ): Promise<void> {
    try {
      // Log for analytics/monitoring
      this.logger.log(`📊 STORE_NOT_FOUND_TRACKING: "${storeName}" requested by user ${userId || 'anonymous'}`);
      
      // Track via analytics service if available
      if (this.searchAnalytics) {
        await this.searchAnalytics.logSearch({
          query: storeName,
          searchType: 'store_not_found',
          filters: {
            requestedStore: storeName,
            lat: lat ? parseFloat(String(lat)) : undefined,
            lng: lng ? parseFloat(String(lng)) : undefined,
          },
          resultsCount: 0,
          executionTimeMs: 0,
          userId: userId,
          platform: platform,
        });
      }
    } catch (error) {
      // Non-blocking - don't fail the search
      this.logger.debug(`Store tracking failed: ${error.message}`);
    }
  }

  /**
   * Get time-of-day aware search terms for smart recommendations
   * Returns food terms that match what people typically eat at different times
   * Includes Nashik-local favorites (misal pav, vada pav, poha, sabudana)
   */
  private getTimeAwareSearchTerms(): string[] {
    const hour = new Date().getHours(); // Server time (IST on our server)
    
    if (hour >= 6 && hour < 11) {
      // 🌅 BREAKFAST (6 AM - 11 AM)
      return ['poha', 'paratha', 'idli', 'dosa', 'sandwich', 'omelette', 'chai', 'sabudana'];
    } else if (hour >= 11 && hour < 15) {
      // 🌞 LUNCH (11 AM - 3 PM)
      return ['thali', 'biryani', 'paneer', 'chicken', 'rice', 'dal', 'roti', 'misal'];
    } else if (hour >= 15 && hour < 18) {
      // 🍿 SNACKS (3 PM - 6 PM)
      return ['samosa', 'momos', 'pizza', 'burger', 'vada', 'sandwich', 'chai', 'maggi'];
    } else if (hour >= 18 && hour < 23) {
      // 🌙 DINNER (6 PM - 11 PM)
      return ['biryani', 'chicken', 'paneer', 'pizza', 'burger', 'noodles', 'thali', 'curry'];
    } else {
      // 🌃 LATE NIGHT (11 PM - 6 AM)
      return ['pizza', 'burger', 'sandwich', 'maggi', 'noodles', 'momos', 'rolls', 'shawarma'];
    }
  }

  /**
   * Get the time-of-day greeting for recommendation messages
   */
  static getTimeAwareGreeting(): { emoji: string; greeting: string; mealType: string } {
    const hour = new Date().getHours();
    
    if (hour >= 6 && hour < 11) {
      return { emoji: '🌅', greeting: 'Good morning', mealType: 'breakfast' };
    } else if (hour >= 11 && hour < 15) {
      return { emoji: '🌞', greeting: 'Lunch time', mealType: 'lunch' };
    } else if (hour >= 15 && hour < 18) {
      return { emoji: '🍿', greeting: 'Snack time', mealType: 'snacks' };
    } else if (hour >= 18 && hour < 23) {
      return { emoji: '🌙', greeting: 'Dinner time', mealType: 'dinner' };
    } else {
      return { emoji: '🌃', greeting: 'Late night cravings', mealType: 'late night food' };
    }
  }

  /**
   * Resolve category IDs to category names for search terms
   */
  private async getCategoryNames(categoryIds: number[]): Promise<string[]> {
    try {
      // Search for items in these categories and extract unique category names
      const names: string[] = [];
      for (const catId of categoryIds.slice(0, 3)) {
        const results = await this.searchService.search({
          query: '*',
          index: 'food_items',
          searchType: 'hybrid',
          limit: 1,
          filters: [{ field: 'category_id', value: catId }],
        } as any);
        
        if (results.results?.length > 0) {
          const catName = results.results[0].source?.category_name;
          if (catName && !names.includes(catName)) {
            names.push(catName);
          }
        }
      }
      return names;
    } catch (error) {
      this.logger.debug(`Category name resolution failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Diversify search results across multiple stores
   * Instead of showing 10 items from 1 store, show items from multiple stores
   * This provides better user experience when browsing (not searching for specific store)
   * 
   * Algorithm:
   * 1. Group items by store
   * 2. Round-robin pick from each store to ensure variety
   * 3. Fill remaining slots with highest-scored items
   */
  /**
   * Filter out test/demo data from search results
   * Removes placeholder items, test stores, and demo categories
   */
  private filterTestData(items: any[]): any[] {
    const TEST_STORE_NAMES = ['tester', 'test store', 'demo', 'demo store', 'test restaurant'];
    const TEST_ITEM_NAMES = ['item', 'test item', 'test product', 'demo item'];
    const TEST_CATEGORIES = ['abc', 'test', 'demo'];
    
    const beforeCount = items.length;
    const filtered = items.filter((item: any) => {
      const storeName = (item.store_name || item.storeName || '').toLowerCase().trim();
      const itemName = (item.name || item.title || '').toLowerCase().trim();
      const category = (item.category_name || item.category || '').toLowerCase().trim();
      const description = (item.description || '').toLowerCase();
      
      // Exclude test stores (exact match)
      if (TEST_STORE_NAMES.includes(storeName)) return false;
      
      // Exclude placeholder item names (exact match)
      if (TEST_ITEM_NAMES.includes(itemName)) return false;
      
      // Exclude test categories (exact match)
      if (TEST_CATEGORIES.includes(category)) return false;
      
      // Exclude items explicitly marked as not for sale
      if (description.includes('not for sale')) return false;
      
      return true;
    });
    
    if (beforeCount !== filtered.length) {
      this.logger.log(`🧹 Test data filter: ${beforeCount} → ${filtered.length} results (removed ${beforeCount - filtered.length} test items)`);
    }
    
    return filtered;
  }

  private diversifyByStore(items: any[], limit: number, maxPerStore: number = 3): any[] {
    if (items.length <= limit) return items;
    
    // Group items by store_id
    const storeGroups: Map<number, any[]> = new Map();
    for (const item of items) {
      const storeId = item.store_id || item.storeId || 0;
      if (!storeGroups.has(storeId)) {
        storeGroups.set(storeId, []);
      }
      storeGroups.get(storeId)!.push(item);
    }
    
    this.logger.log(`🎯 Diversifying results: ${items.length} items from ${storeGroups.size} stores, limit=${limit}, maxPerStore=${maxPerStore}`);
    
    // If only 1 store, no diversification needed
    if (storeGroups.size <= 1) {
      return items.slice(0, limit);
    }
    
    const diversified: any[] = [];
    const storeIterators = Array.from(storeGroups.entries()).map(([storeId, storeItems]) => ({
      storeId,
      items: storeItems,
      index: 0,
      count: 0, // How many items we've taken from this store
    }));
    
    // Round-robin pick from each store
    while (diversified.length < limit) {
      let pickedAny = false;
      
      for (const store of storeIterators) {
        if (diversified.length >= limit) break;
        if (store.count >= maxPerStore) continue; // Skip if we've taken enough from this store
        if (store.index >= store.items.length) continue; // Skip if no more items
        
        diversified.push(store.items[store.index]);
        store.index++;
        store.count++;
        pickedAny = true;
      }
      
      // If no progress, we've exhausted stores under maxPerStore limit
      // Fill remaining with any available items
      if (!pickedAny) {
        for (const store of storeIterators) {
          while (diversified.length < limit && store.index < store.items.length) {
            diversified.push(store.items[store.index]);
            store.index++;
          }
        }
        break;
      }
    }
    
    const storesInResult = new Set(diversified.map(i => i.store_id || i.storeId)).size;
    this.logger.log(`✅ Diversification complete: ${diversified.length} items from ${storesInResult} stores`);
    
    return diversified;
  }
}
