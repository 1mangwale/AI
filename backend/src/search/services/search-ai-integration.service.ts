import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface SearchUnderstanding {
  intent: string;
  entities: Record<string, any>;
  filters: Record<string, any>;
  correctedQuery: string;
  confidence: number;
  suggestedSearch: Record<string, any>;
}

export interface ConversationalContext {
  previous_query?: string;
  previous_filters?: Record<string, any>;
  previous_results?: Array<{
    item_id: number;
    name: string;
    price: number;
  }>;
}

/**
 * Search AI Integration Service
 * 
 * Integrates with Search API's V3 NLU endpoints for intelligent search:
 * - Intent classification
 * - Entity extraction
 * - Query understanding
 * - Conversational search
 * - Filter recommendations
 */
@Injectable()
export class SearchAIIntegrationService {
  private readonly logger = new Logger(SearchAIIntegrationService.name);
  private readonly searchApiUrl: string;
  private readonly enabled: boolean;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.searchApiUrl = this.config.get('SEARCH_API_URL');
    this.enabled = !!this.searchApiUrl;
    
    if (!this.enabled) {
      this.logger.warn('⚠️  Search AI Integration disabled: SEARCH_API_URL not configured');
    } else {
      this.logger.log(`✅ Search AI Integration enabled (${this.searchApiUrl})`);
    }
  }

  /**
   * Understand natural language query using Search API's V3 AI
   * 
   * @example
   * Input: "Show me veg biryani under 200 rupees"
   * Output: {
   *   intent: "search_with_filters",
   *   entities: { item: "biryani", dietary: "vegetarian", max_price: 200 },
   *   filters: { veg: 1, max_price: 200 },
   *   suggestedSearch: { q: "biryani", veg: 1, max_price: 200, module_id: 4 }
   * }
   */
  async understandQuery(
    query: string,
    context: {
      module_id?: number;
      zone_id?: number;
      user_location?: { lat: number; lng: number };
      conversation_history?: string[];
      nluIntent?: string;
      nluConfidence?: number;
    } = {},
  ): Promise<SearchUnderstanding | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      this.logger.debug(`🧠 Understanding query: "${query}"${context.nluIntent ? ` (NLU hint: ${context.nluIntent}@${context.nluConfidence?.toFixed(2)})` : ''}`);

      const payload: Record<string, any> = {
        query,
        module_id: context.module_id || this.getModuleId(context),
        zone_id: context.zone_id,
        user_location: context.user_location,
        conversation_history: context.conversation_history?.slice(-3), // Last 3 messages
      };

      // Pass NLU intent hint so Search API can skip re-classification when intent is already known
      if (context.nluIntent && context.nluConfidence && context.nluConfidence >= 0.65) {
        payload.intent_hint = context.nluIntent;
        payload.intent_hint_confidence = context.nluConfidence;
      }

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.searchApiUrl}/v3/search/understand`,
          payload,
          { timeout: 3000 },
        ),
      );

      const data = response.data;
      
      this.logger.log(`✅ Query understood: intent="${data.intent}", confidence=${data.confidence}`);
      
      return {
        intent: data.intent,
        entities: data.entities || {},
        filters: data.filters || {},
        correctedQuery: data.corrected_query || query,
        confidence: data.confidence || 0,
        suggestedSearch: data.suggested_search || {},
      };
    } catch (error) {
      this.logger.warn(`Search AI understand failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Conversational search with context awareness
   * Handles follow-up queries like "cheaper ones", "show more", "vegetarian only"
   * 
   * @example
   * Previous: "biryani"
   * Current: "cheaper ones"
   * Output: Refines previous search with max_price filter
   */
  async conversationalSearch(
    query: string,
    conversationContext: ConversationalContext,
    searchContext: {
      module_id?: number;
      zone_id?: number;
    } = {},
  ): Promise<any> {
    if (!this.enabled) {
      return null;
    }

    try {
      this.logger.debug(`💬 Conversational search: "${query}"`);
      
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.searchApiUrl}/v3/search/conversational`,
          {
            query,
            context: conversationContext,
            module_id: searchContext.module_id || this.getModuleId(searchContext),
            zone_id: searchContext.zone_id,
          },
          { timeout: 5000 },
        ),
      );

      const data = response.data;
      
      this.logger.log(`✅ Conversational understanding: intent="${data.understanding?.intent}"`);
      
      return data;
    } catch (error) {
      this.logger.warn(`Conversational search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get module ID from context or intent
   */
  getModuleId(context: any): number {
    // Check explicit module_id
    if (context.module_id) {
      return context.module_id;
    }

    // Infer from intent
    const intent = context.classified_intent?.toLowerCase() || '';
    
    if (intent.includes('food') || intent.includes('order') || intent.includes('restaurant')) {
      return 4; // Food
    }
    
    if (intent.includes('parcel') || intent.includes('track') || intent.includes('delivery')) {
      return 3; // Parcel
    }
    
    if (intent.includes('shop') || intent.includes('ecom') || intent.includes('product')) {
      return 5; // Ecommerce
    }

    return 4; // Default to food
  }

  /**
   * Extract dietary filters from entities
   */
  extractDietaryFilters(entities: Record<string, any>): Record<string, any> {
    const filters: Record<string, any> = {};

    if (entities.dietary === 'vegetarian' || entities.veg === true) {
      filters.veg = 1;
    } else if (entities.dietary === 'non-vegetarian' || entities.veg === false) {
      filters.veg = 0;
    }

    if (entities.contains_egg !== undefined) {
      filters.contains_egg = entities.contains_egg ? 1 : 0;
    }

    return filters;
  }

  /**
   * Extract price filters from entities
   */
  extractPriceFilters(entities: Record<string, any>): Record<string, any> {
    const filters: Record<string, any> = {};

    if (entities.min_price) {
      filters.min_price = entities.min_price;
    }

    if (entities.max_price) {
      filters.max_price = entities.max_price;
    }

    // Handle "under X rupees" → max_price
    if (entities.price_limit) {
      filters.max_price = entities.price_limit;
    }

    // Handle "cheap" → max_price = 150
    if (entities.price_preference === 'cheap') {
      filters.max_price = 150;
    }

    // Handle "expensive" → min_price = 500
    if (entities.price_preference === 'expensive') {
      filters.min_price = 500;
    }

    return filters;
  }

  /**
   * Build search params from AI understanding
   */
  buildSearchParams(
    understanding: SearchUnderstanding,
    context: any = {},
  ): Record<string, any> {
    if (!context.zone_id) {
      this.logger.warn(`⚠️ buildSearchParams called without zone_id — search results may be inaccurate`);
    }

    const params: Record<string, any> = {
      q: understanding.correctedQuery,
      module_id: context.module_id || this.getModuleId(context),
      zone_id: context.zone_id,
      ...understanding.filters,
    };

    // Add location if available
    if (context.delivery_address?.latitude) {
      params.lat = context.delivery_address.latitude;
      params.lon = context.delivery_address.longitude;
    }

    // Add dietary filters
    const dietaryFilters = this.extractDietaryFilters(understanding.entities);
    Object.assign(params, dietaryFilters);

    // Add price filters
    const priceFilters = this.extractPriceFilters(understanding.entities);
    Object.assign(params, priceFilters);

    // Add store filter if specified
    if (understanding.entities.store_name && context.store_id) {
      params.store_id = context.store_id;
    }

    // Add category filter if specified
    if (understanding.entities.category_id) {
      params.category_id = understanding.entities.category_id;
    }

    return params;
  }
}
