/**
 * Entity Resolution Service
 * 
 * INDUSTRY STANDARD APPROACH (Rasa, Dialogflow, Zomato, DoorDash)
 * 
 * This service bridges NLU output (raw slot values) with actual database entities.
 * 
 * NLU extracts WHAT the user said (language understanding)
 * Entity Resolution finds WHAT they meant (business logic)
 * 
 * Example:
 *   User: "dominos se peppy paneer pizza"
 *   NLU Output: { store_reference: "dominos", food_reference: "peppy paneer pizza" }
 *   Resolution Output: { store: { id: 123, name: "Domino's Nashik" }, items: [{ id: 456, name: "Peppy Paneer" }] }
 * 
 * Key Principles:
 * 1. NLU is LANGUAGE-aware, not BUSINESS-aware
 * 2. Entity Resolution uses OpenSearch for fuzzy matching
 * 3. User context (history, preferences) helps disambiguation
 * 4. Parallel resolution for speed
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';

// Input: Raw slot values extracted by NLU
export interface ExtractedSlots {
  food_reference?: string | string[];      // What user said about food
  store_reference?: string;                 // What user said about store/restaurant
  store_references?: Array<{ store: string; items: string[] }> | null;  // Multi-store orders
  location_reference?: string;              // What user said about location
  quantity?: number | string;               // Quantity mentioned
  time_reference?: string;                  // Time mentioned (abhi, 8pm, tomorrow)
  preference?: string[];                    // Preferences (spicy, no onion, etc.)
  price_reference?: string;                 // Budget/price mentioned
  person_reference?: string;                // Person name (for parcel)
  order_reference?: string;                 // Order ID or "last order"
  cart_items?: Array<{ name: string; quantity: number }>; // Pre-parsed cart items
}

// Output: Resolved entities from database/search
export interface ResolvedEntities {
  location?: ResolvedLocation;
  stores?: ResolvedStore[];
  items?: ResolvedItem[];
  order?: ResolvedOrder;
  person?: ResolvedPerson;
  resolutionConfidence: number;
  ambiguities?: string[];                   // What couldn't be resolved confidently
}

export interface ResolvedLocation {
  city?: string;
  area?: string;
  lat?: number;
  lng?: number;
  formatted_address?: string;
  source: 'user_saved' | 'geocoded' | 'inferred';
}

export interface ResolvedStore {
  id: number | string;
  name: string;
  slug?: string;
  rating?: number;
  distance_km?: number;
  delivery_time_mins?: number;
  is_open: boolean;
  match_score: number;                      // How well it matched the reference
  match_reason: string;                     // Why this store was selected
}

export interface ResolvedItem {
  id: number | string;
  name: string;
  description?: string;
  price: number;
  store_id: number | string;
  store_name?: string;
  category?: string;
  image?: string;
  available: boolean;
  match_score: number;
  match_reason: string;
}

export interface ResolvedOrder {
  id: string;
  status: string;
  items?: any[];
  store_name?: string;
  created_at?: Date;
}

export interface ResolvedPerson {
  name: string;
  phone?: string;
  address?: string;
  source: 'extracted' | 'contact_lookup';
}

// Resolution context for better disambiguation
export interface ResolutionContext {
  userId?: string;
  userLocation?: { lat: number; lng: number };
  userCity?: string;
  recentStores?: string[];                  // Recently ordered from
  favoriteItems?: string[];                 // Frequently ordered items
  activeFlowContext?: string;               // Current flow (food, parcel, etc.)
}

@Injectable()
export class EntityResolutionService {
  private readonly logger = new Logger(EntityResolutionService.name);
  private readonly searchApiUrl: string;
  private readonly phpBackendUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
  ) {
    this.searchApiUrl = this.configService.get('SEARCH_API_URL');
    this.phpBackendUrl = this.configService.get('PHP_BACKEND_URL');
    this.logger.log('🔍 Entity Resolution Service initialized (Industry-standard approach)');
  }

  /**
   * Main resolution method - resolves all slots in parallel
   * 
   * Industry Approach: Parallel resolution with fallback strategies
   * - Zomato: Uses Elasticsearch + user history for disambiguation
   * - DoorDash: ML-based entity linking with confidence scores
   * - Rasa: EntitySynonymMapper + custom actions
   */
  async resolve(
    slots: ExtractedSlots,
    context?: ResolutionContext,
  ): Promise<ResolvedEntities> {
    const startTime = Date.now();
    const result: ResolvedEntities = {
      resolutionConfidence: 0,
      ambiguities: [],
    };

    // Parallel resolution for speed (industry best practice)
    const resolutionPromises: Promise<void>[] = [];

    // 1. Resolve location first (needed for store filtering)
    if (slots.location_reference || context?.userLocation) {
      resolutionPromises.push(
        this.resolveLocation(slots.location_reference, context)
          .then(loc => { result.location = loc; })
          .catch(err => {
            this.logger.warn(`Location resolution failed: ${err.message}`);
            result.ambiguities?.push('location');
          })
      );
    }

    // Wait for location before store/item resolution (they depend on it)
    await Promise.all(resolutionPromises);

    // 2. Resolve stores and items in parallel
    const entityPromises: Promise<void>[] = [];

    if (slots.store_reference) {
      entityPromises.push(
        this.resolveStore(slots.store_reference, result.location, context)
          .then(stores => { result.stores = stores; })
          .catch(err => {
            this.logger.warn(`Store resolution failed: ${err.message}`);
            result.ambiguities?.push('store');
          })
      );
    }

    if (slots.food_reference) {
      entityPromises.push(
        this.resolveFood(slots.food_reference, result.stores?.[0]?.id, result.location, context)
          .then(items => { result.items = items; })
          .catch(err => {
            this.logger.warn(`Food resolution failed: ${err.message}`);
            result.ambiguities?.push('food');
          })
      );
    }

    if (slots.order_reference) {
      entityPromises.push(
        this.resolveOrder(slots.order_reference, context?.userId)
          .then(order => { result.order = order; })
          .catch(err => {
            this.logger.warn(`Order resolution failed: ${err.message}`);
            result.ambiguities?.push('order');
          })
      );
    }

    await Promise.all(entityPromises);

    // Calculate overall confidence
    result.resolutionConfidence = this.calculateConfidence(result, slots);

    const duration = Date.now() - startTime;
    this.logger.debug(
      `Entity resolution completed in ${duration}ms: ` +
      `stores=${result.stores?.length || 0}, items=${result.items?.length || 0}, ` +
      `confidence=${result.resolutionConfidence.toFixed(2)}`
    );

    return result;
  }

  /**
   * Resolve location reference to coordinates/city
   * 
   * Industry Approach:
   * - Check user's saved addresses first ("home", "office", "my place")
   * - Geocode explicit addresses
   * - Use user's current location as fallback
   */
  private async resolveLocation(
    reference: string | undefined,
    context?: ResolutionContext,
  ): Promise<ResolvedLocation | undefined> {
    // 1. Check for saved address references
    if (reference && context?.userId) {
      const savedMatch = await this.matchSavedAddress(reference, context.userId);
      if (savedMatch) {
        return {
          ...savedMatch,
          source: 'user_saved',
        };
      }
    }

    // 2. Use context location if available
    if (context?.userLocation) {
      return {
        lat: context.userLocation.lat,
        lng: context.userLocation.lng,
        city: context.userCity || this.configService.get('geo.defaultCity'),
        source: 'inferred',
      };
    }

    // 3. Try to geocode the reference
    if (reference) {
      try {
        const geocoded = await this.geocodeLocation(reference);
        if (geocoded) {
          return {
            ...geocoded,
            source: 'geocoded',
          };
        }
      } catch (error) {
        this.logger.warn(`Geocoding failed for "${reference}": ${error.message}`);
      }
    }

    // 4. Default to configured city
    return {
      city: this.configService.get('geo.defaultCity'),
      lat: this.configService.get('geo.defaultLatitude'),
      lng: this.configService.get('geo.defaultLongitude'),
      source: 'inferred',
    };
  }

  /**
   * Resolve store reference using OpenSearch
   * 
   * Industry Approach (Zomato/Swiggy):
   * - Fuzzy matching on store name + aliases
   * - Filter by location/delivery radius
   * - Boost by user's order history
   * - Consider open/close status
   */
  private async resolveStore(
    reference: string,
    location?: ResolvedLocation,
    context?: ResolutionContext,
  ): Promise<ResolvedStore[]> {
    try {
      // Build search query for OpenSearch
      const searchBody = {
        size: 5,
        query: {
          bool: {
            should: [
              // Fuzzy match on store name
              {
                match: {
                  name: {
                    query: reference,
                    fuzziness: 'AUTO',
                    boost: 2,
                  },
                },
              },
              // Match on aliases (dominos, domino's, domino)
              {
                match: {
                  'aliases': {
                    query: reference,
                    fuzziness: 'AUTO',
                    boost: 1.5,
                  },
                },
              },
              // Prefix match for partial names
              {
                prefix: {
                  'name.keyword': {
                    value: reference.toLowerCase(),
                    boost: 1,
                  },
                },
              },
            ],
            minimum_should_match: 1,
            filter: [],
          },
        },
        // Sort by relevance + distance
        sort: [
          { _score: 'desc' },
        ],
      };

      // Add location filter if available
      if (location?.lat && location?.lng) {
        (searchBody.query.bool.filter as any[]).push({
          geo_distance: {
            distance: '25km',
            location: {
              lat: location.lat,
              lon: location.lng,
            },
          },
        });

        // Add distance-based scoring
        searchBody.sort.push({
          _geo_distance: {
            location: {
              lat: location.lat,
              lon: location.lng,
            },
            order: 'asc',
            unit: 'km',
          },
        } as any);
      }

      // Boost stores user has ordered from before
      if (context?.recentStores?.length) {
        (searchBody.query.bool.should as any[]).push({
          terms: {
            'id': context.recentStores,
            boost: 3,
          },
        });
      }

      const response = await this.searchOpenSearch('stores', searchBody);
      
      if (!response?.hits?.hits?.length) {
        // Fallback to PHP API search
        return this.fallbackStoreSearch(reference, location);
      }

      return response.hits.hits.map((hit: any) => ({
        id: hit._source.id || hit._id,
        name: hit._source.name,
        slug: hit._source.slug,
        rating: hit._source.rating,
        distance_km: hit.sort?.[1], // Distance from geo sort
        delivery_time_mins: hit._source.delivery_time,
        is_open: hit._source.is_open ?? true,
        match_score: hit._score / (response.hits.max_score || 1),
        match_reason: `Matched "${reference}" with score ${hit._score.toFixed(2)}`,
      }));

    } catch (error) {
      this.logger.error(`Store resolution error: ${error.message}`);
      return this.fallbackStoreSearch(reference, location);
    }
  }

  /**
   * Resolve food reference using OpenSearch
   * 
   * Industry Approach (Zomato/DoorDash):
   * - Semantic search for food items (understands "paneer pizza" = "Peppy Paneer")
   * - Filter by store if specified
   * - Consider availability
   * - Boost by popularity/ratings
   */
  private async resolveFood(
    reference: string | string[],
    storeId?: number | string,
    location?: ResolvedLocation,
    context?: ResolutionContext,
  ): Promise<ResolvedItem[]> {
    const foodTerms = Array.isArray(reference) ? reference : [reference];
    const allItems: ResolvedItem[] = [];

    try {
      for (const term of foodTerms) {
        // Build search params for V3 Hybrid API (BM25 + KNN)
        const searchParams: Record<string, any> = {
          q: term,
          module_id: 4, // Food module
          size: 10,
          sort: 'relevance', // Hybrid score (BM25 + KNN)
        };

        // Add location for distance-based sorting
        if (location?.lat && location?.lng) {
          searchParams.lat = location.lat;
          searchParams.lon = location.lng;
          searchParams.max_distance = 25; // 25km radius
        }

        // Filter by store if specified
        if (storeId) {
          searchParams.store_id = storeId;
        }

        // Filter by availability
        searchParams.available = 'true';

        // Execute V3 Hybrid Search (BM25 + KNN with 2x vector boost)
        const response = await firstValueFrom(
          this.httpService.get(
            `${this.searchApiUrl}/search/hybrid/food`,
            { params: searchParams, timeout: 5000 }
          )
        );

      // Parse V3 API response format (V3 returns both items and stores)
      const items = response.data?.items || response.data?.results || response.data?.stores || [];
        if (items.length > 0) {
          const mappedItems = items.map((item: any) => ({
            id: item.id || item.item_id,
            name: item.name || item.title,
            description: item.description,
            price: item.price,
            store_id: item.store_id,
            store_name: item.store_name,
            category: item.category_name || item.category,
            image: item.image,
            available: item.available ?? true,
            match_score: item.score || 1,
            match_reason: `Hybrid match "${term}" (BM25 + semantic)`,
            distance_km: item.distance_km, // Available when lat/lon provided
          }));
          
          // Boost user's favorite items
          if (context?.favoriteItems?.length) {
            mappedItems.forEach((item: any) => {
              if (context.favoriteItems.includes(item.id)) {
                item.match_score *= 1.5; // 50% boost for favorites
                item.match_reason += ' [FAVORITE]';
              }
            });
            // Re-sort after boosting
            mappedItems.sort((a: any, b: any) => b.match_score - a.match_score);
          }
          
          allItems.push(...mappedItems);
        }
      }

      // Deduplicate by item ID
      const uniqueItems = Array.from(
        new Map(allItems.map(item => [item.id, item])).values()
      );

      return uniqueItems.slice(0, 15); // Limit results

    } catch (error) {
      this.logger.error(`Food resolution error: ${error.message}`);
      return this.fallbackFoodSearch(foodTerms, storeId);
    }
  }

  /**
   * Resolve order reference (order ID or "last order", "previous order")
   */
  private async resolveOrder(
    reference: string,
    userId?: string,
  ): Promise<ResolvedOrder | undefined> {
    if (!userId) return undefined;

    // Check if it's a "last order" type reference
    const lastOrderPatterns = [
      'last', 'previous', 'pichla', 'pehle', 'wala', 'same', 'repeat', 'dobara',
    ];
    const isLastOrder = lastOrderPatterns.some(p => 
      reference.toLowerCase().includes(p)
    );

    if (isLastOrder) {
      // Fetch user's most recent order
      try {
        const response = await firstValueFrom(
          this.httpService.get(`${this.phpBackendUrl}/api/v1/orders/recent`, {
            params: { user_id: userId, limit: 1 },
            timeout: 5000,
          })
        );

        if (response.data?.data?.[0]) {
          const order = response.data.data[0];
          return {
            id: order.id,
            status: order.status,
            items: order.items,
            store_name: order.store_name,
            created_at: new Date(order.created_at),
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch recent order: ${error.message}`);
      }
    }

    // Try to find by order ID
    const orderIdMatch = reference.match(/(?:ORD|MNG|#)?(\d{4,})/i);
    if (orderIdMatch) {
      try {
        const response = await firstValueFrom(
          this.httpService.get(`${this.phpBackendUrl}/api/v1/orders/${orderIdMatch[1]}`, {
            timeout: 5000,
          })
        );

        if (response.data?.data) {
          const order = response.data.data;
          return {
            id: order.id,
            status: order.status,
            items: order.items,
            store_name: order.store_name,
            created_at: new Date(order.created_at),
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch order by ID: ${error.message}`);
      }
    }

    return undefined;
  }

  /**
   * Match saved address references ("home", "office", "my place")
   */
  private async matchSavedAddress(
    reference: string,
    userId: string,
  ): Promise<Partial<ResolvedLocation> | null> {
    const lowerRef = reference.toLowerCase();
    
    // Common address type mappings
    const addressTypes: Record<string, string[]> = {
      'home': ['home', 'ghar', 'घर', 'my place', 'mera ghar'],
      'office': ['office', 'work', 'kaam', 'ऑफिस', 'daftar'],
      'other': ['friend', 'dost', 'relative', 'other'],
    };

    let matchedType: string | null = null;
    for (const [type, keywords] of Object.entries(addressTypes)) {
      if (keywords.some(k => lowerRef.includes(k))) {
        matchedType = type;
        break;
      }
    }

    if (!matchedType) return null;

    try {
      // Query user's saved addresses from PHP backend
      const response = await firstValueFrom(
        this.httpService.get(`${this.phpBackendUrl}/api/v1/user/addresses`, {
          params: { user_id: userId, type: matchedType },
          timeout: 5000,
        })
      );

      if (response.data?.data?.[0]) {
        const addr = response.data.data[0];
        return {
          lat: parseFloat(addr.latitude),
          lng: parseFloat(addr.longitude),
          formatted_address: addr.address,
          area: addr.area,
          city: addr.city,
        };
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch saved address: ${error.message}`);
    }

    return null;
  }

  /**
   * Geocode a location string to coordinates
   */
  private async geocodeLocation(address: string): Promise<Partial<ResolvedLocation> | null> {
    const googleApiKey = this.configService.get('GOOGLE_MAPS_API_KEY');
    if (!googleApiKey) {
      this.logger.warn('Google Maps API key not configured');
      return null;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: {
            address: `${address}, ${this.configService.get('geo.defaultCity', 'Nashik')}, Maharashtra, India`,
            key: googleApiKey,
          },
          timeout: 5000,
        })
      );

      if (response.data?.results?.[0]) {
        const result = response.data.results[0];
        return {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          formatted_address: result.formatted_address,
          city: this.extractCity(result.address_components),
        };
      }
    } catch (error) {
      this.logger.warn(`Geocoding failed: ${error.message}`);
    }

    return null;
  }

  private extractCity(components: any[]): string {
    const cityComponent = components?.find((c: any) => 
      c.types.includes('locality') || c.types.includes('administrative_area_level_2')
    );
    return cityComponent?.long_name || this.configService.get('geo.defaultCity', 'Nashik');
  }

  /**
   * Search OpenSearch via V3 API (no direct fallback)
   * @deprecated Use direct httpService.get with /search/hybrid endpoints
   */
  private async searchOpenSearch(index: string, body: any): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.searchApiUrl}/search/${index}`,
          body,
          { timeout: 5000 }
        )
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Search API query failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fallback store search via PHP API
   */
  private async fallbackStoreSearch(
    reference: string,
    location?: ResolvedLocation,
  ): Promise<ResolvedStore[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.phpBackendUrl}/api/v1/stores/search`, {
          params: {
            q: reference,
            lat: location?.lat,
            lng: location?.lng,
            limit: 5,
          },
          timeout: 5000,
        })
      );

      return (response.data?.data || []).map((store: any) => ({
        id: store.id,
        name: store.name,
        slug: store.slug,
        rating: store.rating,
        is_open: store.is_open ?? true,
        match_score: 0.7,
        match_reason: 'Matched via PHP API fallback',
      }));
    } catch (error) {
      this.logger.warn(`Fallback store search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fallback food search via PHP API
   */
  private async fallbackFoodSearch(
    terms: string[],
    storeId?: number | string,
  ): Promise<ResolvedItem[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.phpBackendUrl}/api/v1/items/search`, {
          params: {
            q: terms.join(' '),
            store_id: storeId,
            limit: 15,
          },
          timeout: 5000,
        })
      );

      return (response.data?.data || []).map((item: any) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price: item.price,
        store_id: item.store_id,
        store_name: item.store_name,
        category: item.category_name,
        image: item.image,
        available: item.available ?? true,
        match_score: 0.7,
        match_reason: 'Matched via PHP API fallback',
      }));
    } catch (error) {
      this.logger.warn(`Fallback food search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate overall resolution confidence
   */
  private calculateConfidence(result: ResolvedEntities, slots: ExtractedSlots): number {
    let totalSlots = 0;
    let resolvedSlots = 0;
    let scoreSum = 0;

    if (slots.store_reference) {
      totalSlots++;
      if (result.stores?.length) {
        resolvedSlots++;
        scoreSum += result.stores[0].match_score;
      }
    }

    if (slots.food_reference) {
      totalSlots++;
      if (result.items?.length) {
        resolvedSlots++;
        scoreSum += Math.max(...result.items.map(i => i.match_score));
      }
    }

    if (slots.location_reference) {
      totalSlots++;
      if (result.location) {
        resolvedSlots++;
        scoreSum += result.location.source === 'user_saved' ? 1.0 : 0.8;
      }
    }

    if (slots.order_reference) {
      totalSlots++;
      if (result.order) {
        resolvedSlots++;
        scoreSum += 1.0;
      }
    }

    if (totalSlots === 0) return 1.0;

    const resolutionRate = resolvedSlots / totalSlots;
    const avgScore = scoreSum / Math.max(resolvedSlots, 1);

    return (resolutionRate * 0.6) + (avgScore * 0.4);
  }

  /**
   * Get user's resolution context (history, preferences)
   * 
   * Industry Approach: Use user data for better disambiguation
   */
  async buildUserContext(userId?: string): Promise<ResolutionContext> {
    const context: ResolutionContext = {};

    if (!userId) return context;

    try {
      // Fetch user's recent orders for store preferences
      const recentOrders = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT store_id 
        FROM orders 
        WHERE user_id = ${userId} 
        ORDER BY created_at DESC 
        LIMIT 10
      `;
      context.recentStores = recentOrders.map(o => String(o.store_id));

      // Fetch user's frequently ordered items
      const frequentItems = await this.prisma.$queryRaw<any[]>`
        SELECT item_id, COUNT(*) as count 
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.user_id = ${userId}
        GROUP BY item_id
        ORDER BY count DESC
        LIMIT 20
      `;
      context.favoriteItems = frequentItems.map(i => String(i.item_id));

    } catch (error) {
      this.logger.warn(`Failed to build user context: ${error.message}`);
    }

    return context;
  }

  /**
   * Learn from successful entity resolution
   * When user completes an order, we know the resolution was correct
   * This helps improve future disambiguation
   */
  async learnFromSuccess(
    userId: string,
    query: string,
    resolvedStoreId?: number | string,
    resolvedItemIds?: (number | string)[],
  ): Promise<void> {
    try {
      // Store successful query-to-store mappings for this user
      if (resolvedStoreId) {
        await this.prisma.$executeRaw`
          INSERT INTO user_store_preferences (user_id, store_id, query_text, success_count, last_used)
          VALUES (${userId}, ${String(resolvedStoreId)}, ${query.toLowerCase()}, 1, NOW())
          ON CONFLICT (user_id, store_id, query_text)
          DO UPDATE SET success_count = user_store_preferences.success_count + 1, last_used = NOW()
        `.catch(() => {
          // Table might not exist, create it
          this.createPreferenceTables().catch(() => {});
        });
      }

      // Store successful query-to-item mappings
      if (resolvedItemIds?.length) {
        for (const itemId of resolvedItemIds) {
          await this.prisma.$executeRaw`
            INSERT INTO user_item_preferences (user_id, item_id, query_text, success_count, last_used)
            VALUES (${userId}, ${String(itemId)}, ${query.toLowerCase()}, 1, NOW())
            ON CONFLICT (user_id, item_id, query_text)
            DO UPDATE SET success_count = user_item_preferences.success_count + 1, last_used = NOW()
          `.catch(() => {});
        }
      }

      this.logger.debug(`📚 Learned from successful resolution for user ${userId}`);
    } catch (error) {
      this.logger.warn(`Failed to learn from success: ${error.message}`);
    }
  }

  /**
   * Get learned preferences for disambiguation
   */
  async getLearnedPreferences(
    userId: string,
    query: string,
  ): Promise<{ preferredStores: string[]; preferredItems: string[] }> {
    try {
      const queryLower = query.toLowerCase();
      
      // Find stores that matched similar queries for this user
      const preferredStores = await this.prisma.$queryRaw<any[]>`
        SELECT store_id, success_count
        FROM user_store_preferences
        WHERE user_id = ${userId}
          AND (query_text = ${queryLower} OR ${queryLower} LIKE '%' || query_text || '%')
        ORDER BY success_count DESC, last_used DESC
        LIMIT 5
      `.catch(() => []);

      // Find items that matched similar queries
      const preferredItems = await this.prisma.$queryRaw<any[]>`
        SELECT item_id, success_count
        FROM user_item_preferences
        WHERE user_id = ${userId}
          AND (query_text = ${queryLower} OR ${queryLower} LIKE '%' || query_text || '%')
        ORDER BY success_count DESC, last_used DESC
        LIMIT 10
      `.catch(() => []);

      return {
        preferredStores: preferredStores.map(p => p.store_id),
        preferredItems: preferredItems.map(p => p.item_id),
      };
    } catch (error) {
      return { preferredStores: [], preferredItems: [] };
    }
  }

  /**
   * Create preference tracking tables if they don't exist
   */
  private async createPreferenceTables(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS user_store_preferences (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          store_id VARCHAR(255) NOT NULL,
          query_text TEXT NOT NULL,
          success_count INTEGER DEFAULT 1,
          last_used TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, store_id, query_text)
        )
      `;

      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS user_item_preferences (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          item_id VARCHAR(255) NOT NULL,
          query_text TEXT NOT NULL,
          success_count INTEGER DEFAULT 1,
          last_used TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, item_id, query_text)
        )
      `;

      this.logger.log('✅ Created preference tracking tables');
    } catch (error) {
      this.logger.warn(`Failed to create preference tables: ${error.message}`);
    }
  }
}
