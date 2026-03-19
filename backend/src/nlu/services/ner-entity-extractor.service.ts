/**
 * NER Entity Extractor Service
 * =============================
 * Uses trained NER model for entity extraction
 * Falls back to LLM if NER service unavailable
 */

import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, catchError, timeout } from 'rxjs';
import { LlmEntityExtractorService } from './llm-entity-extractor.service';

export interface NEREntity {
  text: string;
  label: string;
  start: number;
  end: number;
  confidence: number;
}

export interface NERExtractionResult {
  text: string;
  entities: NEREntity[];
  food_reference?: string[];
  store_reference?: string;
  quantity?: string;
  location_reference?: string;
  preference?: string[];
  processing_time_ms: number;
}

export interface ExtractedEntities {
  food_reference?: string[];
  store_reference?: string;
  store_references?: Array<{ store: string; items: string[] }> | null;  // Multi-store orders
  quantity?: string | number;
  item_quantities?: Array<{ item: string; quantity: string; unit?: string }> | null;  // Per-item quantities
  location_reference?: string;
  preference?: string[];
  original_text: string;
  _source: 'ner' | 'llm' | 'regex';
  _confidence: number;
  _processing_time_ms: number;
}

@Injectable()
export class NerEntityExtractorService implements OnModuleInit {
  private readonly logger = new Logger(NerEntityExtractorService.name);
  
  private nerServiceUrl: string;
  private searchServiceUrl: string;
  private nerAvailable = false;
  private previousNerAvailable: boolean | null = null;
  private healthCheckInterval: NodeJS.Timeout;
  
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @Optional() private readonly llmExtractor?: LlmEntityExtractorService,
  ) {
    this.nerServiceUrl = this.configService.get('NER_SERVICE_URL', 'http://localhost:7011');
    this.searchServiceUrl = this.configService.get('SEARCH_API_URL');
  }

  async onModuleInit() {
    await this.checkNerHealth();

    // Warmup: send a real inference request so the GPU model is loaded into memory.
    // This prevents 60-90s cold-start latency on the first real user request.
    if (this.nerAvailable) {
      this.extractWithNer('chai order karna hai').catch(() => {});
    }

    // Periodic health check every 30 seconds (fast recovery when NER comes back).
    // Also re-warms the GPU if the service restarted.
    this.healthCheckInterval = setInterval(async () => {
      const wasAvailable = this.nerAvailable;
      await this.checkNerHealth();
      if (this.nerAvailable && !wasAvailable) {
        // Service just came back — warmup immediately
        this.extractWithNer('chai order karna hai').catch(() => {});
      }
    }, 30000);
  }

  onModuleDestroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }

  /**
   * Check if NER service is available
   */
  private async checkNerHealth(): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.nerServiceUrl}/health`).pipe(
          timeout(5000),
          catchError(() => {
            throw new Error('NER service unavailable');
          }),
        ),
      );
      
      this.nerAvailable = response.data?.model_loaded === true;

      // Only log on status change
      if (this.nerAvailable !== this.previousNerAvailable) {
        if (this.nerAvailable) {
          this.logger.log('NER service status changed: available');
        } else {
          this.logger.warn('NER service status changed: unavailable, using LLM fallback');
        }
        this.previousNerAvailable = this.nerAvailable;
      }

      return this.nerAvailable;
    } catch (error) {
      this.nerAvailable = false;
      // Only log on status change
      if (this.previousNerAvailable !== false) {
        this.logger.warn('NER service status changed: unavailable, using LLM fallback');
        this.previousNerAvailable = false;
      }
      return false;
    }
  }

  /**
   * Main extraction method - uses NER model with LLM fallback
   */
  async extract(text: string): Promise<ExtractedEntities> {
    const startTime = Date.now();
    
    // Try NER first if available
    if (this.nerAvailable) {
      try {
        const result = await this.extractWithNer(text);
        
        // 🏪🏪 MULTI-STORE DETECTION: If message hints at multiple stores,
        // also call LLM to extract store_references + item_quantities (NER can't do this yet)
        let storeReferences: Array<{ store: string; items: string[] }> | null = null;
        let itemQuantities: Array<{ item: string; quantity: string; unit?: string }> | null = null;
        if (this.llmExtractor && this.detectMultiStoreHint(text)) {
          try {
            this.logger.log(`🏪🏪 Multi-store message detected, calling LLM for store_references...`);
            const llmResult = await this.llmExtractor.extract(text);
            storeReferences = llmResult.store_references || null;
            itemQuantities = llmResult.item_quantities || null;
            if (storeReferences) {
              this.logger.log(`🏪🏪 LLM extracted store_references: ${JSON.stringify(storeReferences)}`);
            }
            if (itemQuantities) {
              this.logger.log(`📦 LLM extracted item_quantities: ${JSON.stringify(itemQuantities)}`);
            }
          } catch (err) {
            this.logger.warn(`LLM multi-store extraction failed: ${err.message}`);
          }
        }

        return {
          food_reference: result.food_reference,
          store_reference: result.store_reference,
          store_references: storeReferences,
          quantity: result.quantity,
          item_quantities: itemQuantities,
          location_reference: result.location_reference,
          preference: result.preference,
          original_text: text,
          _source: 'ner',
          _confidence: this.calculateOverallConfidence(result.entities),
          _processing_time_ms: Date.now() - startTime,
        };
      } catch (error) {
        this.logger.warn(`NER extraction failed: ${error.message}, falling back to LLM`);
        this.nerAvailable = false;
      }
    }
    
    // Fallback to LLM — 10-second timeout to prevent cold-start hangs (vLLM can take 60-90s)
    if (this.llmExtractor) {
      try {
        const llmResult = await Promise.race([
          this.llmExtractor.extract(text),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('LLM NER fallback timeout (10s)')), 10000),
          ),
        ]) as Awaited<ReturnType<typeof this.llmExtractor.extract>>;
        
        return {
          food_reference: llmResult.food_reference,
          store_reference: llmResult.store_reference,
          store_references: llmResult.store_references || null,  // Propagate multi-store extraction
          quantity: llmResult.quantity,
          item_quantities: llmResult.item_quantities || null,  // Propagate per-item quantities
          location_reference: llmResult.location_reference,
          preference: llmResult.preference,
          original_text: text,
          _source: 'llm',
          _confidence: llmResult.confidence || 0.7,
          _processing_time_ms: Date.now() - startTime,
        };
      } catch (error) {
        this.logger.error(`LLM extraction also failed: ${error.message}`);
        throw error;
      }
    }
    
    // No extraction available
    throw new Error('No entity extraction service available');
  }

  /**
   * Extract using NER service
   */
  private async extractWithNer(text: string): Promise<NERExtractionResult> {
    // Use Axios-level timeout (actually aborts socket) instead of RxJS timeout()
    // which only unsubscribes from the observable but leaves the HTTP connection open.
    const response = await firstValueFrom(
      this.httpService.post(`${this.nerServiceUrl}/extract`, {
        text,
        return_tokens: false,
      }, {
        timeout: 8000,  // Axios socket timeout — kills the connection after 8s
      }).pipe(
        catchError((error) => {
          throw new Error(`NER request failed: ${error.message}`);
        }),
      ),
    );

    return response.data;
  }

  /**
   * Batch extract for multiple texts
   */
  async extractBatch(texts: string[]): Promise<ExtractedEntities[]> {
    if (this.nerAvailable) {
      try {
        const response = await firstValueFrom(
          this.httpService.post(`${this.nerServiceUrl}/extract/batch`, {
            texts,
          }).pipe(
            timeout(30000),
          ),
        );
        
        return response.data.results.map((result: NERExtractionResult) => ({
          food_reference: result.food_reference,
          store_reference: result.store_reference,
          quantity: result.quantity,
          location_reference: result.location_reference,
          preference: result.preference,
          original_text: result.text,
          _source: 'ner' as const,
          _confidence: this.calculateOverallConfidence(result.entities),
          _processing_time_ms: result.processing_time_ms,
        }));
      } catch (error) {
        this.logger.warn('Batch NER failed, falling back to individual extraction');
      }
    }
    
    // Fallback to individual extraction
    return Promise.all(texts.map(text => this.extract(text)));
  }

  /**
   * Calculate overall confidence from entity confidences
   */
  private calculateOverallConfidence(entities: NEREntity[]): number {
    if (!entities || entities.length === 0) {
      return 1.0; // No entities needed, so confidence is high
    }
    
    const confidences = entities.map(e => e.confidence);
    return confidences.reduce((a, b) => a + b, 0) / confidences.length;
  }

  /**
   * Check if NER is available
   */
  isAvailable(): boolean {
    return this.nerAvailable;
  }

  /**
   * Get service status
   */
  async getStatus(): Promise<{
    available: boolean;
    url: string;
    labels?: string[];
    device?: string;
  }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.nerServiceUrl}/health`).pipe(
          timeout(5000),
        ),
      );
      
      return {
        available: response.data?.model_loaded || false,
        url: this.nerServiceUrl,
        labels: response.data?.labels,
        device: response.data?.device,
      };
    } catch {
      return {
        available: false,
        url: this.nerServiceUrl,
      };
    }
  }

  /**
   * Report extraction to data collector for training
   */
  async reportForTraining(text: string, entities: ExtractedEntities): Promise<void> {
    const dataCollectorUrl = this.configService.get('NER_DATA_COLLECTOR_URL', 'http://localhost:7012');
    
    try {
      await firstValueFrom(
        this.httpService.post(`${dataCollectorUrl}/collect/llm`, {
          text,
          llm_output: {
            store_reference: entities.store_reference,
            food_reference: entities.food_reference,
            quantity: entities.quantity,
            location_reference: entities.location_reference,
            preference: entities.preference,
          },
          source: entities._source,
        }).pipe(
          timeout(5000),
          catchError(() => {
            // Silent fail - data collection is optional
            return [];
          }),
        ),
      );
    } catch {
      // Ignore data collection errors
    }
  }

  /**
   * Search and validate store name against Search service
   * Returns the best matching store from the database
   */
  async resolveStore(storeName: string): Promise<{
    id: string;
    name: string;
    matched: boolean;
    confidence: number;
  } | null> {
    if (!storeName) return null;
    
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchServiceUrl}/search`, {
          params: { q: storeName, limit: 5 },
        }).pipe(
          timeout(3000),
          catchError(() => {
            throw new Error('Store search failed');
          }),
        ),
      );
      
      // Search returns { stores: [...], items: [...], ... }
      const stores = response.data?.stores || [];
      if (stores.length > 0) {
        const match = stores[0];
        return {
          id: match.id || match._id || '',
          name: match.name || storeName,
          matched: true,
          confidence: 0.9,
        };
      }
      
      return { id: '', name: storeName, matched: false, confidence: 0 };
    } catch (error) {
      this.logger.debug(`Store search failed for: ${storeName}`);
      return null;
    }
  }

  /**
   * Search and validate food item against Search service
   * Returns matching menu items from the database
   * 
   * IMPORTANT: If storeId is provided, search is scoped to that store only!
   * This ensures "missal from tushar" returns Tushar's menu items, not any store.
   */
  async resolveFood(
    foodItems: string[], 
    storeId?: string | number,
  ): Promise<Array<{
    query: string;
    id: string;
    name: string;
    storeId: string;
    storeName: string;
    price: number;
    matched: boolean;
  }>> {
    if (!foodItems?.length) return [];
    
    const results = await Promise.all(
      foodItems.map(async (food) => {
        try {
          // Build search params - scope to store if provided
          const params: Record<string, any> = { q: food, limit: 5 };
          if (storeId) {
            params.store_id = storeId;
            this.logger.debug(`Searching "${food}" in store ${storeId}`);
          }
          
          const response = await firstValueFrom(
            this.httpService.get(`${this.searchServiceUrl}/search`, {
              params,
            }).pipe(
              timeout(3000),
              catchError(() => {
                throw new Error('Food search failed');
              }),
            ),
          );
          
          // Search returns { items: [...], stores: [...], ... }
          const items = response.data?.items || [];
          if (items.length > 0) {
            const match = items[0];
            return {
              query: food,
              id: String(match.id || match._id || ''),
              name: match.name || food,
              storeId: String(match.store_id || match.storeId || ''),
              storeName: match.store_name || '',
              price: match.price || 0,
              matched: true,
            };
          }
          
          return { query: food, id: '', name: food, storeId: '', storeName: '', price: 0, matched: false };
        } catch {
          return { query: food, id: '', name: food, storeId: '', storeName: '', price: 0, matched: false };
        }
      }),
    );
    
    return results;
  }

  /**
   * Extract entities and resolve them against search service
   * 
   * ARCHITECTURE FIX (Jan 2026):
   * - Resolve store FIRST to get store ID
   * - Then resolve food items SCOPED to that store
   * - This ensures "missal from tushar" gets Tushar's menu items, not any store's
   */
  async extractAndResolve(text: string): Promise<ExtractedEntities & {
    resolved_store?: { id: string; name: string; matched: boolean; confidence: number } | null;
    resolved_food?: Array<{ query: string; id: string; name: string; storeId: string; storeName: string; price: number; matched: boolean }>;
    parsed_quantity?: number | null;
    total_processing_time_ms?: number;
  }> {
    const startTime = Date.now();
    const entities = await this.extract(text);
    
    // Step 1: Resolve store FIRST (we need store ID to scope food search)
    let resolvedStore: { id: string; name: string; matched: boolean; confidence: number } | null = null;
    if (entities.store_reference) {
      resolvedStore = await this.resolveStore(entities.store_reference);
    }
    
    // Step 2: Resolve food items - SCOPED to store if we have one
    let resolvedFood: Array<{ query: string; id: string; name: string; storeId: string; storeName: string; price: number; matched: boolean }> = [];
    if (entities.food_reference?.length) {
      const storeIdFilter = resolvedStore?.matched ? resolvedStore.id : undefined;
      resolvedFood = await this.resolveFood(entities.food_reference, storeIdFilter);
    }
    
    // Step 3: Parse quantity to number
    let parsedQuantity: number | null = null;
    if (entities.quantity) {
      const qty = parseInt(String(entities.quantity), 10);
      parsedQuantity = isNaN(qty) ? null : qty;
    }
    
    return {
      ...entities,
      resolved_store: resolvedStore,
      resolved_food: resolvedFood,
      parsed_quantity: parsedQuantity,
      total_processing_time_ms: Date.now() - startTime,
    };
  }

  /**
   * Detect if the user message hints at ordering from multiple stores.
   * Patterns:
   * - "X from store1 and Y from store2"
   * - "X se store1 aur Y se store2"  (Hinglish)
   * - "from store1 ... from store2" (multiple "from" keywords)
   * - "store1 + store2"
   */
  private detectMultiStoreHint(text: string): boolean {
    const lower = text.toLowerCase();
    
    // Count store indicator keywords: "from", "se" (Hindi for "from")
    const fromMatches = (lower.match(/\bfrom\b/g) || []).length;
    const seMatches = (lower.match(/\bse\b/g) || []).length;
    
    // If "from" or "se" appears 2+ times, likely multi-store
    if (fromMatches >= 2 || seMatches >= 2 || (fromMatches + seMatches) >= 2) {
      return true;
    }
    
    // Check for "and...from" or "aur...se" patterns (item from store1 AND item from store2)
    if (/\b(and|aur|or|ya|plus|\+)\b.*\b(from|se)\b/i.test(lower) && /\b(from|se)\b.*\b(and|aur|or|ya|plus|\+)\b/i.test(lower)) {
      return true;
    }
    
    // "store1 + store2" with plus sign
    if (/\bfrom\b.+\+.+\bfrom\b/i.test(lower) || /\+/.test(lower) && /\bfrom\b|\bse\b/i.test(lower)) {
      return true;
    }
    
    return false;
  }
}
