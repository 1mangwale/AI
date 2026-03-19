import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalVendorService, GooglePlaceResult } from '../../search/services/external-vendor.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';

/**
 * External Search Executor
 * 
 * Searches Google Places for vendors/restaurants not in our database
 * Used when internal search returns no results
 */
@Injectable()
export class ExternalSearchExecutor implements ActionExecutor {
  readonly name = 'external_search';
  private readonly logger = new Logger(ExternalSearchExecutor.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly externalVendorService: ExternalVendorService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      // Get search query - support multiple sources
      let query = config.query as string;
      
      // Resolve template variables like {{_failure_analysis.restaurant_name}}
      if (query?.includes('{{')) {
        query = this.resolveTemplate(query, context);
      }
      
      // Fallback to queryPath or user message
      if (!query && config.queryPath) {
        query = this.getNestedValue(context.data, config.queryPath);
      }
      if (!query) {
        query = context.data._user_message || context.data.extracted_food?.search_query;
      }

      if (!query) {
        return {
          success: false,
          error: 'No search query provided',
          event: 'error'
        };
      }

      // Get location from context or config
      const location = config.location || context.data.location || context.data.delivery_address;
      const city = config.city || context.data.city || this.configService.get('geo.defaultCity', 'Nashik');
      const type = config.type || 'restaurant';
      const radius = config.radius || 10000;

      this.logger.log(`🔍 External search: "${query}" in ${city}`);

      // Perform external search
      const searchResult = await this.externalVendorService.searchExternalVendor(query, {
        location: location ? { lat: location.lat, lng: location.lng } : undefined,
        city,
        type,
        radius,
      });

      if (!searchResult.success || searchResult.results.length === 0) {
        this.logger.warn(`No external results for: "${query}"`);
        return {
          success: false,
          output: {
            query,
            results: [],
            message: `Could not find "${query}" on Google Maps. Please provide the exact address.`
          },
          event: 'not_found'
        };
      }

      // Format results for flow context
      const results = searchResult.results;
      const formattedResults = this.formatResultsForContext(results);
      
      // Generate UI-friendly cards
      const cards = results.slice(0, 3).map((place, index) => ({
        id: place.place_id,
        name: place.name,
        description: place.address,
        rating: place.rating ? `⭐ ${place.rating}` : undefined,
        reviews: place.user_ratings_total ? `${place.user_ratings_total} reviews` : undefined,
        distance: place.distance_km ? `${place.distance_km} km` : undefined,
        maps_link: place.maps_link,
        action: {
          type: 'select',
          label: `Select ${index + 1}`,
          value: `select_external_${index + 1}`,
          payload: {
            place_id: place.place_id,
            name: place.name,
            address: place.address,
            lat: place.lat,
            lng: place.lng,
          }
        }
      }));

      // Generate chat message
      const chatMessage = this.externalVendorService.formatResultsForChat(results, query);

      this.logger.log(`✅ Found ${results.length} external results for: "${query}"`);

      // Phase 2: Record search interaction
      await this.recordSearchInteraction(context, query, results.length > 0);

      return {
        success: true,
        output: {
          query,
          results: formattedResults,
          cards,
          chatMessage,
          topResult: formattedResults[0] || null,
          hasResults: results.length > 0,
          count: results.length,
        },
        event: 'found'
      };
    } catch (error) {
      this.logger.error(`External search failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error'
      };
    }
  }

  /**
   * Format Google Places results for flow context
   */
  private formatResultsForContext(results: GooglePlaceResult[]): any[] {
    return results.map((place, index) => ({
      index: index + 1,
      place_id: place.place_id,
      name: place.name,
      address: place.address,
      formatted_address: place.formatted_address,
      lat: place.lat,
      lng: place.lng,
      rating: place.rating,
      user_ratings_total: place.user_ratings_total,
      maps_link: place.maps_link,
      distance_km: place.distance_km,
      // Pre-formatted for LLM
      display: `${index + 1}. ${place.name} - ${place.address}${place.rating ? ` (⭐${place.rating})` : ''}`,
    }));
  }

  /**
   * Resolve handlebars-style template variables
   */
  private resolveTemplate(template: string, context: FlowContext): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const value = this.getNestedValue(context.data, path.trim());
      return value ?? '';
    });
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Phase 2: Record search interaction for training
   */
  private async recordSearchInteraction(context: FlowContext, query: string, hasResults: boolean): Promise<void> {
    try {
      const userMessage = context.data._user_message || query;
      
      const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
        conversation_history: context.data._conversation_history || [],
        flow_stage: 'external_search',
      });

      await this.advancedLearning.recordTrainingData({
        message: userMessage,
        questionType: 'search_external',
        actualClassification: hasResults,
        predictedClassification: hasResults,
        confidence: hasResults ? 0.8 : 0.3,
        flowContext: 'external_search',
        language: this.detectLanguage(userMessage),
        userId: context._system?.userId || 'unknown',
        sessionId: context._system?.sessionId || 'unknown',
      });

      if (!hasResults && sentiment.frustration_score > 0.6) {
        this.logger.log(`😤 External search frustration: No results for "${query}", frustration: ${sentiment.frustration_score.toFixed(2)}`);
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
}
