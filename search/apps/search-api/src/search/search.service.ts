import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import { ConfigService } from '@nestjs/config';
import { AnalyticsService } from '../modules/analytics.service';
import { EmbeddingService } from '../modules/embedding.service';
import { ModuleService } from './module.service';
import { SearchCacheService } from '../modules/cache.service';
import { ZoneService } from '../modules/zone.service';
import { ImageService } from '../modules/image.service';
import { QueryParserService } from './query-parser.service';
import * as mysql from 'mysql2/promise';

@Injectable()
export class SearchService {
  private storeScheduleCache: Map<string, any[]> = new Map();
  private scheduleCacheExpiry: Map<string, number> = new Map();

  /**
   * Public wrapper for findTopStoreMatch (for controller access)
   */
  async findStoreByNamePublic(query: string, filters: Record<string, any> = {}): Promise<{ storeId: number | null; storeName?: string; score?: number }> {
    return this.findTopStoreMatch(query, filters);
  }

  /**
   * Multi-index search with store boosting (Option B - Industry Standard)
   * Queries both stores and items simultaneously, boosts stores 10x
   * No hardcoded brand list needed - OpenSearch handles the ranking
   */
  async searchWithStoreBoosting(q: string, filters: Record<string, any>) {
    const moduleId = filters.module_id || filters.moduleId || 4;
    if (!filters.module_id && !filters.moduleId) {
      this.logger.warn('[searchWithStoreBoosting] No module_id provided, defaulting to food (4)');
    }
    
    // Determine indices based on module
    const itemsIndex = moduleId === 4 ? this.FOOD_ITEMS_INDEX : this.ECOM_ITEMS_INDEX;
    const storesIndex = moduleId === 4 ? this.FOOD_STORES_INDEX : this.ECOM_STORES_INDEX;
    
    const page = parseInt(filters.page as any) || 1;
    const size = Math.min(parseInt(filters.size as any) || 20, 100);
    const from = (page - 1) * size;

    try {
      // Build query that searches both indices
      const searchBody: any = {
        from: from,
        size: size * 2, // Get more results to ensure we have both stores and items
        query: {
          function_score: {
            query: {
              bool: {
                should: [
                  {
                    multi_match: {
                      query: q,
                      fields: ['name^3', 'description', 'store_name^2'],
                      type: 'best_fields',
                      fuzziness: 'AUTO'
                    }
                  }
                ],
                filter: [],
                must_not: this.buildTestStoreExclusionMultiIndex(itemsIndex, storesIndex)
              }
            },
            functions: [
              {
                // Boost stores 10x higher than items
                filter: { term: { _index: storesIndex } },
                weight: 10.0
              },
              {
                // Items get base score (1.0)
                filter: { term: { _index: itemsIndex } },
                weight: 1.0
              }
            ],
            score_mode: 'multiply',
            boost_mode: 'multiply'
          }
        },
        // Aggregate by index type
        aggs: {
          by_type: {
            terms: {
              field: '_index',
              size: 10
            }
          }
        }
      };

      // Apply filters
      const boolFilters = searchBody.query.function_score.query.bool.filter;
      
      // Status filters: item approved+active, store open+approved (where applicable)
      // store_status=1 (admin-approved) applied only to food modules (4,6) because
      // ecom stores (modules 2,5,7,13,16) currently have store_status=0 (pending admin approval)
      const isFoodModule = moduleId === 4 || moduleId === 6;
      const itemMustFilters: any[] = [
        { term: { _index: itemsIndex } },
        { term: { status: 1 } },
        { term: { is_approved: 1 } },
        { term: { store_active: 1 } },   // Store must be currently open (store-controlled flag)
      ];
      if (isFoodModule) {
        itemMustFilters.push({ term: { store_status: 1 } }); // Admin-approved food stores only
      }
      boolFilters.push({
        bool: {
          should: [
            { bool: { must: itemMustFilters } },
            {
              bool: {
                must: [
                  { term: { _index: storesIndex } },
                  { term: { status: true } }
                ]
              }
            }
          ]
        }
      });

      // Module ID filter - ensure items match the requested module
      // The food_items index contains ALL modules (4, 5, 13, etc.)
      // Without this filter, pet food (13) and ecom (5) items leak into food (4) results
      if (moduleId) {
        boolFilters.push({
          bool: {
            should: [
              // Items: filter by module_id
              {
                bool: {
                  must: [
                    { term: { _index: itemsIndex } },
                    { term: { module_id: moduleId } }
                  ]
                }
              },
              // Stores: always pass through (they don't have module_id the same way)
              { term: { _index: storesIndex } }
            ]
          }
        });
      }

      // Store ID filter - restrict items to a specific store, allow stores through
      if (filters.store_id) {
        boolFilters.push({
          bool: {
            should: [
              { bool: { must: [{ term: { _index: itemsIndex } }, { term: { store_id: parseInt(filters.store_id) } }] } },
              { term: { _index: storesIndex } }
            ]
          }
        });
      }

      // Veg filter - items use integer (1/0), stores use boolean (true/false)
      if (filters.veg === '1' || filters.veg === 'true' || filters.veg === 'veg') {
        boolFilters.push({
          bool: {
            should: [
              { bool: { must: [{ term: { _index: itemsIndex } }, { term: { veg: 1 } }] } },
              { bool: { must: [{ term: { _index: storesIndex } }, { term: { veg: true } }] } },
            ]
          }
        });
      } else if (filters.veg === '0' || filters.veg === 'false' || filters.veg === 'non-veg') {
        boolFilters.push({
          bool: {
            should: [
              { bool: { must: [{ term: { _index: itemsIndex } }, { term: { veg: 0 } }] } },
              { bool: { must: [{ term: { _index: storesIndex } }, { term: { non_veg: true } }] } },
            ]
          }
        });
      }

      // Price range (items only)
      if (filters.price_min) {
        boolFilters.push({
          bool: {
            should: [
              { term: { _index: storesIndex } },
              {
                bool: {
                  must: [
                    { term: { _index: itemsIndex } },
                    { range: { price: { gte: parseFloat(filters.price_min) } } }
                  ]
                }
              }
            ]
          }
        });
      }
      if (filters.price_max) {
        boolFilters.push({
          bool: {
            should: [
              { term: { _index: storesIndex } },
              {
                bool: {
                  must: [
                    { term: { _index: itemsIndex } },
                    { range: { price: { lte: parseFloat(filters.price_max) } } }
                  ]
                }
              }
            ]
          }
        });
      }

      // Zone filter
      if (filters.zone_id) {
        boolFilters.push({ term: { zone_id: parseInt(filters.zone_id) } });
      }

      // Store ID filter - filter items by specific store when store is resolved
      if (filters.store_id) {
        boolFilters.push({
          bool: {
            should: [
              // For items: filter by store_id
              {
                bool: {
                  must: [
                    { term: { _index: itemsIndex } },
                    { term: { store_id: parseInt(filters.store_id) } }
                  ]
                }
              },
              // For stores: filter by id
              {
                bool: {
                  must: [
                    { term: { _index: storesIndex } },
                    { term: { id: parseInt(filters.store_id) } }
                  ]
                }
              }
            ]
          }
        });
        this.logger.log(`🏪 [searchWithStoreBoosting] Filtering by store_id: ${filters.store_id}`);
      }

      // Execute multi-index search
      const response = await this.client.search({
        index: [storesIndex, itemsIndex],
        body: searchBody
      });

      const hits = response.body.hits.hits || [];
      
      // Separate stores and items
      const stores = hits
        .filter((h: any) => h._index === storesIndex)
        .slice(0, Math.min(size, 20)) // Respect requested size, cap at 20
        .map((h: any) => ({
          id: h._source.id,
          name: h._source.name,
          logo_url: h._source.logo_url || h._source.logo_fallback,
          rating: h._source.rating || 0,
          distance: h._source.distance,
          _score: h._score,
          _source: h._source
        }));

      const items = hits
        .filter((h: any) => h._index === itemsIndex)
        .slice(0, size) // Requested page size
        .map((h: any) => ({
          id: h._source.id,
          name: h._source.name,
          store_name: h._source.store_name,
          store_id: h._source.store_id,
          price: h._source.price,
          image_url: h._source.image_url || h._source.image_fallback,
          veg: h._source.veg,
          rating: h._source.rating || 0,
          _score: h._score,
          _source: h._source
        }));

      const total = response.body.hits.total?.value || 0;
      const totalStores = stores.length;
      const totalItems = total - totalStores;

      // NEW FEATURE: If no stores found by name match, extract unique stores from top items
      // This ensures "paneer tikka" shows stores that sell paneer tikka items
      let finalStores = stores;
      if (stores.length === 0 && items.length > 0) {
        const storeMap = new Map();
        items.forEach((item: any) => {
          if (item.store_id && item.store_name && !storeMap.has(item.store_id)) {
            storeMap.set(item.store_id, {
              id: item.store_id,
              name: item.store_name,
              logo_url: item._source?.store_logo_url || null,
              rating: item._source?.store_rating || 0,
              distance: item._source?.store_distance || null,
              _score: item._score * 0.8, // Slightly lower score since it's derived from items
              _source: {
                id: item.store_id,
                name: item.store_name,
                logo_url: item._source?.store_logo_url,
                cover_url: item._source?.store_cover_url,
                rating: item._source?.store_rating || 0,
                derived_from_items: true // Flag to indicate this is extracted from items
              }
            });
          }
        });
        finalStores = Array.from(storeMap.values()).slice(0, 20);
        this.logger.log(`🏪 Extracted ${finalStores.length} stores from ${items.length} items for query "${q}"`);
      }

      return {
        query: q,
        intent: finalStores.length > 0 ? 'store_first' : 'generic',
        stores: this.imageService.transformStoresWithImages(finalStores.map((s: any) => s._source || s)),
        items: this.imageService.transformItemsWithImages(items.map((i: any) => i._source || i)),
        meta: {
          total_stores: finalStores.length,
          total_items: totalItems,
          total: total,
          page: page,
          size: size,
          search_method: 'multi_index_boosting',
          stores_derived_from_items: stores.length === 0 && finalStores.length > 0
        },
        filters: filters
      };

    } catch (error: any) {
      this.logger.error(`[searchWithStoreBoosting] Error: ${error?.message || String(error)}`);
      throw error;
    }
  }

  /**
   * - specific_item_specific_store: find store by name, then search items within that store
   * - store_first: find store by name and return its menu
   * - generic: fallback to existing module-aware search
   * 
   * NEW: Uses multi-index boosting by default (Option B) - no hardcoded brands needed
   */
  async searchItemsByIntent(q: string, filters: Record<string, any>) {
    // Respect explicit store filter from caller; no intent parsing needed
    if (filters?.store_id) {
      return this.searchItemsByModule(q, filters);
    }

    // NEW APPROACH: Use multi-index search with store boosting
    // This replaces the hardcoded brand matching approach
    // OpenSearch automatically ranks stores higher (10x boost)
    if (q && q.trim()) {
      return this.searchWithStoreBoosting(q, filters);
    }

    // Fallback for empty query
    return this.searchItemsByModule(q, filters);
  }
  private client: Client;
  private readonly logger = new Logger(SearchService.name);
  private cacheEnabled: boolean;

  // Index names - food_items_prod has 768-dim vectors + complete store data
  private readonly FOOD_ITEMS_INDEX = 'food_items_v5';
  private readonly ECOM_ITEMS_INDEX = 'ecom_items_v2'; // concrete index — alias 'ecom_items' resolves to this; _index filter requires concrete name
  private readonly FOOD_STORES_INDEX = 'food_stores_prod'; // v6 includes status and active fields
  private readonly ECOM_STORES_INDEX = 'ecom_stores';

  // Zone configuration for multi-zone search
  // Maps zone_id to adjacent zone_ids for proximity boosting
  // Override via ZONE_NEIGHBORS_JSON env var for multi-city support
  private readonly ZONE_NEIGHBORS: Record<number, number[]>;

  // Zone proximity boost factors
  private readonly ZONE_BOOST_SAME = 3.0;     // 3x boost for same zone
  private readonly ZONE_BOOST_ADJACENT = 1.5; // 1.5x boost for adjacent zones

  // Test/demo store names to exclude from all search results
  private readonly TEST_STORE_NAMES = [
    'Tester', 'Test', 'Test Store', 'Demo', 'Demo Store',
    'Demo Restaurant', 'Test Restaurant', 'test III', 'testing009',
  ];

  constructor(
    private readonly config: ConfigService, 
    private readonly analytics: AnalyticsService,
    private readonly embeddingService: EmbeddingService,
    private readonly moduleService: ModuleService,
    private readonly cacheService: SearchCacheService,
    private readonly zoneService: ZoneService,
    private readonly imageService: ImageService,
    private readonly queryParser: QueryParserService
  ) {
    // Initialize zone neighbors from env or use Nashik defaults
    const defaultZoneNeighbors: Record<number, number[]> = {
      4: [2], 2: [4], 7: [4, 11], 8: [4, 12],
      9: [4], 10: [4], 11: [4, 7], 12: [4, 8],
    };
    try {
      const envZones = this.config.get<string>('ZONE_NEIGHBORS_JSON');
      this.ZONE_NEIGHBORS = envZones ? JSON.parse(envZones) : defaultZoneNeighbors;
    } catch {
      this.ZONE_NEIGHBORS = defaultZoneNeighbors;
    }

    this.cacheEnabled = this.config.get<string>('ENABLE_SEARCH_CACHE') !== 'false';
    const node = this.config.get<string>('OPENSEARCH_HOST') || 'http://localhost:9200';
    const username = this.config.get<string>('OPENSEARCH_USERNAME');
    const password = this.config.get<string>('OPENSEARCH_PASSWORD');
    this.client = new Client({
      node,
      auth: username && password ? { username, password } : undefined,
      ssl: { rejectUnauthorized: false },
    } as any);
  }

  /**
   * Build must_not clauses to exclude test/demo stores from search results.
   * For items index, filters on store_name.keyword. For stores index, filters on name.keyword.
   * When searching a single index, pass the appropriate field name.
   */
  private buildTestStoreExclusion(field: 'store_name.keyword' | 'name.keyword' = 'store_name.keyword'): any[] {
    return [{ terms: { [field]: this.TEST_STORE_NAMES } }];
  }

  /**
   * Build must_not clauses for multi-index queries (items + stores).
   * Excludes test stores from both indices using their respective field names.
   */
  private buildTestStoreExclusionMultiIndex(itemsIndex: string, storesIndex: string): any[] {
    return [
      {
        bool: {
          should: [
            // Exclude test items by store_name
            { bool: { must: [{ term: { _index: itemsIndex } }, { terms: { 'store_name.keyword': this.TEST_STORE_NAMES } }] } },
            // Exclude test stores by name
            { bool: { must: [{ term: { _index: storesIndex } }, { terms: { 'name.keyword': this.TEST_STORE_NAMES } }] } },
          ],
        },
      },
    ];
  }

  // Utility function to calculate distance between two coordinates using Haversine formula
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Get zone-aware boost factor for a result
   * @param resultZoneId - The zone_id of the search result (store or item)
   * @param userZoneId - The user's current zone_id (from filters)
   * @returns Boost multiplier (3.0 for same zone, 1.5 for adjacent, 1.0 for other)
   */
  private getZoneBoostFactor(resultZoneId: number | null | undefined, userZoneId: number | null | undefined): number {
    if (!userZoneId || !resultZoneId) {
      return 1.0; // No boost if zone info missing
    }

    if (resultZoneId === userZoneId) {
      return this.ZONE_BOOST_SAME; // 3x boost for same zone
    }

    const neighbors = this.ZONE_NEIGHBORS[userZoneId] || [];
    if (neighbors.includes(resultZoneId)) {
      return this.ZONE_BOOST_ADJACENT; // 1.5x boost for adjacent zones
    }

    return 1.0; // No boost for distant zones
  }

  /**
   * Build zone filter query for OpenSearch
   * Prefers same zone, includes adjacent zones with lower priority
   * @param userZoneId - The user's current zone_id
   * @param includeAdjacentZones - Whether to include adjacent zones in results
   * @returns OpenSearch bool query for zone filtering
   */
  private buildZoneFilter(userZoneId: number | null | undefined, includeAdjacentZones: boolean = true): any {
    if (!userZoneId) {
      return null; // No zone filtering if user zone unknown
    }

    if (!includeAdjacentZones) {
      // Strict zone filtering: only same zone
      return { term: { zone_id: userZoneId } };
    }

    // Include same zone + adjacent zones
    const neighbors = this.ZONE_NEIGHBORS[userZoneId] || [];
    const allowedZones = [userZoneId, ...neighbors];

    return { terms: { zone_id: allowedZones } };
  }

  // Time-based category boosting for meal times
  private getTimeBasedCategoryBoosts(): Map<number, number> {
    const now = new Date();
    const hour = now.getHours();
    const boosts = new Map<number, number>();

    // Breakfast time: 6 AM - 10 AM
    if (hour >= 6 && hour < 10) {
      boosts.set(4, 2.0);    // Breakfast
      boosts.set(837, 1.8);  // Bakery
      boosts.set(101, 1.8);  // Bakery & Desserts
      boosts.set(752, 1.5);  // Coffee
      boosts.set(742, 1.5);  // Tea
      boosts.set(9, 1.3);    // Beverages
    }
    // Lunch time: 12 PM - 3 PM
    else if (hour >= 12 && hour < 15) {
      boosts.set(815, 2.0);  // Thali
      boosts.set(147, 1.8);  // Biryani
      boosts.set(765, 1.8);  // Biryani
      boosts.set(9, 1.3);    // Beverages
    }
    // Dinner time: 7 PM - 11 PM
    else if (hour >= 19 && hour < 23) {
      boosts.set(147, 1.8);  // Biryani
      boosts.set(765, 1.8);  // Biryani
      boosts.set(815, 1.5);  // Thali
      boosts.set(9, 1.3);    // Beverages
    }
    // Evening snack time: 4 PM - 7 PM
    else if (hour >= 16 && hour < 19) {
      boosts.set(837, 1.5);  // Bakery
      boosts.set(101, 1.5);  // Bakery & Desserts
      boosts.set(752, 1.5);  // Coffee
      boosts.set(742, 1.5);  // Tea
      boosts.set(316, 1.3);  // Bubble Tea
    }

    return boosts;
  }

  // Utility function to calculate estimated travel time based on distance
  private calculateTravelTime(distanceKm: number): number {
    // Assuming average speed of 30 km/h in city traffic
    const averageSpeedKmh = 30;
    return Math.round((distanceKm / averageSpeedKmh) * 60); // Return minutes
  }

  /**
   * Fetch store schedules from MySQL database with caching
   */
  private async fetchStoreSchedules(storeIds: string[]): Promise<Map<string, any[]>> {
    const now = Date.now();
    const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    const schedulesByStore = new Map<string, any[]>();
    const storeIdsToFetch: string[] = [];

    // Check cache first
    for (const storeId of storeIds) {
      const cacheExpiry = this.scheduleCacheExpiry.get(storeId);
      if (cacheExpiry && now < cacheExpiry) {
        const cached = this.storeScheduleCache.get(storeId);
        if (cached) {
          schedulesByStore.set(storeId, cached);
        }
      } else {
        storeIdsToFetch.push(storeId);
      }
    }

    // Fetch from database if needed
    if (storeIdsToFetch.length > 0) {
      try {
        const connection = await mysql.createConnection({
          host: this.config.get<string>('MYSQL_HOST'),
          port: Number(this.config.get<string>('MYSQL_PORT', '3306')),
          user: this.config.get<string>('MYSQL_USER'),
          password: this.config.get<string>('MYSQL_PASSWORD'),
          database: this.config.get<string>('MYSQL_DATABASE'),
          connectTimeout: 5000,
        });

        const placeholders = storeIdsToFetch.map(() => '?').join(',');
        const [rows] = await connection.execute(
          `SELECT store_id, day, opening_time, closing_time FROM store_schedule WHERE store_id IN (${placeholders})`,
          storeIdsToFetch
        );

        await connection.end();

        // Group by store_id and cache
        (rows as any[]).forEach((row: any) => {
          const storeId = String(row.store_id);
          if (!schedulesByStore.has(storeId)) {
            schedulesByStore.set(storeId, []);
          }
          schedulesByStore.get(storeId)!.push({
            day: row.day,
            opening_time: row.opening_time,
            closing_time: row.closing_time
          });
        });

        // Update cache
        const expiryTime = now + CACHE_TTL;
        for (const storeId of storeIdsToFetch) {
          const schedule = schedulesByStore.get(storeId) || [];
          this.storeScheduleCache.set(storeId, schedule);
          this.scheduleCacheExpiry.set(storeId, expiryTime);
        }

        this.logger.debug(`[fetchStoreSchedules] Fetched schedules for ${storeIdsToFetch.length} stores from MySQL`);
      } catch (error: any) {
        this.logger.error(`[fetchStoreSchedules] MySQL error: ${error?.message || String(error)}`);
      }
    }

    return schedulesByStore;
  }

  /**
   * Calculate store timing status and display message
   * Returns status: 'open', 'closing_soon', 'closed'
   * Uses store_schedule from database, falls back to 10 AM - 10 PM
   * Supports MULTIPLE time slots per day (e.g., lunch 12-4pm, dinner 7-11pm)
   */
  private getStoreTimingStatus(store?: any): { status: string; message: string; minutesRemaining?: number; isOpen: boolean } {
    const now = new Date();
    
    // Use IST timezone (UTC+5:30)
    const istOffset = 5.5 * 60; // minutes
    const localOffset = now.getTimezoneOffset(); // minutes from UTC
    const istTime = new Date(now.getTime() + (istOffset + localOffset) * 60 * 1000);
    
    const currentHour = istTime.getHours();
    const currentMinute = istTime.getMinutes();
    const currentDay = istTime.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const currentTimeMinutes = currentHour * 60 + currentMinute;
    
    // Helper function to parse time string to minutes
    const parseTimeToMinutes = (timeStr: string): number => {
      const [h, m] = timeStr.split(':').map(s => parseInt(s, 10));
      return h * 60 + (m || 0);
    };
    
    // Helper function to format minutes to "HH:MM AM/PM"
    const formatTime = (minutes: number): string => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (h === 0) return `12:${m.toString().padStart(2, '0')} AM`;
      if (h < 12) return `${h}:${m.toString().padStart(2, '0')} AM`;
      if (h === 12) return `12:${m.toString().padStart(2, '0')} PM`;
      return `${h - 12}:${m.toString().padStart(2, '0')} PM`;
    };
    
    // Use store schedule data if available - can have MULTIPLE time slots per day
    let timeSlots: Array<{opening: number; closing: number}> = [];
    
    if (store?.schedule && Array.isArray(store.schedule) && store.schedule.length > 0) {
      const todaySchedules = store.schedule.filter((s: any) => s.day === currentDay);
      
      if (todaySchedules.length > 0) {
        // Parse all time slots for today
        todaySchedules.forEach((schedule: any) => {
          if (schedule.opening_time && schedule.closing_time) {
            const openingStr = typeof schedule.opening_time === 'string' 
              ? schedule.opening_time 
              : schedule.opening_time.toString();
            const closingStr = typeof schedule.closing_time === 'string'
              ? schedule.closing_time
              : schedule.closing_time.toString();
            
            timeSlots.push({
              opening: parseTimeToMinutes(openingStr),
              closing: parseTimeToMinutes(closingStr)
            });
          }
        });
        
        // Sort by opening time
        timeSlots.sort((a, b) => a.opening - b.opening);
        
        this.logger.debug(`[Timing] Store ${store.id || store.name}: day=${currentDay}, ${timeSlots.length} slots: ${timeSlots.map(s => formatTime(s.opening) + '-' + formatTime(s.closing)).join(', ')}`);
      }
    }
    
    // Fallback to single slot 10 AM - 10 PM
    if (timeSlots.length === 0) {
      timeSlots = [{ opening: 10 * 60, closing: 22 * 60 }];
    }
    
    // Check off_day if available
    const offDay = store?.off_day?.trim();
    if (offDay && offDay !== ' ' && offDay !== '') {
      const offDays = offDay.split(',').map((d: string) => parseInt(d.trim())).filter((d: number) => !isNaN(d));
      if (offDays.includes(currentDay)) {
        let nextDay = (currentDay + 1) % 7;
        let nextOpening = timeSlots[0].opening;
        
        if (store?.schedule && Array.isArray(store.schedule)) {
          const nextSchedules = store.schedule.filter((s: any) => s.day === nextDay);
          if (nextSchedules.length > 0 && nextSchedules[0].opening_time) {
            const timeStr = typeof nextSchedules[0].opening_time === 'string'
              ? nextSchedules[0].opening_time
              : nextSchedules[0].opening_time.toString();
            nextOpening = parseTimeToMinutes(timeStr);
          }
        }
        
        return {
          status: 'closed',
          message: `Opens tomorrow at ${formatTime(nextOpening)}`,
          isOpen: false
        };
      }
    }
    
    // Check if currently open in ANY time slot
    let currentSlot = timeSlots.find((slot: any) => 
      currentTimeMinutes >= slot.opening && currentTimeMinutes < slot.closing
    );
    
    const isOpen = !!currentSlot;
    
    if (!isOpen) {
      // Find next opening time (today or tomorrow)
      let nextSlot = timeSlots.find((slot: any) => slot.opening > currentTimeMinutes);
      
      if (nextSlot) {
        // Opens later today
        return {
          status: 'closed',
          message: `Opens at ${formatTime(nextSlot.opening)}`,
          isOpen: false
        };
      } else {
        // After all time slots today - show tomorrow's first opening
        let nextDay = (currentDay + 1) % 7;
        let nextOpening = timeSlots[0].opening;
        
        if (store?.schedule && Array.isArray(store.schedule)) {
          const nextSchedules = store.schedule.filter((s: any) => s.day === nextDay);
          if (nextSchedules.length > 0 && nextSchedules[0].opening_time) {
            const timeStr = typeof nextSchedules[0].opening_time === 'string'
              ? nextSchedules[0].opening_time
              : nextSchedules[0].opening_time.toString();
            nextOpening = parseTimeToMinutes(timeStr);
          }
        }
        
        return {
          status: 'closed',
          message: `Opens tomorrow at ${formatTime(nextOpening)}`,
          isOpen: false
        };
      }
    }
    
    // Currently open - calculate minutes until closing
    const minutesUntilClosing = currentSlot!.closing - currentTimeMinutes;
    
    if (minutesUntilClosing <= 10) {
      return {
        status: 'closing_very_soon',
        message: `Closing in ${minutesUntilClosing} min`,
        minutesRemaining: minutesUntilClosing,
        isOpen: true
      };
    } else if (minutesUntilClosing <= 30) {
      return {
        status: 'closing_soon',
        message: `Closing in ${minutesUntilClosing} min`,
        minutesRemaining: minutesUntilClosing,
        isOpen: true
      };
    } else if (minutesUntilClosing <= 60) {
      return {
        status: 'open',
        message: `Closes at ${formatTime(currentSlot!.closing)}`,
        minutesRemaining: minutesUntilClosing,
        isOpen: true
      };
    } else {
      return {
        status: 'open',
        message: `Open until ${formatTime(currentSlot!.closing)}`,
        minutesRemaining: minutesUntilClosing,
        isOpen: true
      };
    }
  }

  // Utility function to recalculate delivery time by adding travel time
  private recalculateDeliveryTime(originalDeliveryTime: string, travelTimeMinutes: number): string {
    if (!originalDeliveryTime || typeof originalDeliveryTime !== 'string') {
      return originalDeliveryTime;
    }

    // Parse the original delivery time (e.g., "30-40 min" or "45 min")
    const timeMatch = originalDeliveryTime.match(/(\d+)(?:-(\d+))?\s*min/i);
    if (!timeMatch) {
      return originalDeliveryTime;
    }

    const minTime = parseInt(timeMatch[1], 10);
    const maxTime = timeMatch[2] ? parseInt(timeMatch[2], 10) : minTime;

    const newMinTime = minTime + travelTimeMinutes;
    const newMaxTime = maxTime + travelTimeMinutes;

    return `${newMinTime}-${newMaxTime} min`;
  }

  // Utility function to get store names by IDs
  private async getStoreNames(storeIds: string[], module: string): Promise<Record<string, string>> {
    if (!storeIds.length) return {};

    // For module_id based search, search all store indices
    const storeAliases = module === 'all' || !module 
      ? this.getAllStoreIndices()
      : (() => {
          if (module === 'food') return ['food_stores'];
          if (module === 'ecom') return ['ecom_stores'];
          this.logger.warn(`[getStores] Unknown module '${module}', searching all store indices`);
          return this.getAllStoreIndices();
        })();
    
    const storeNames: Record<string, string> = {};
    
    // Search all store indices in parallel
    const results = await Promise.all(
      storeAliases.map(alias =>
        this.client.mget({
          index: alias,
        body: { ids: storeIds }
        }).catch(() => ({ body: { docs: [] } }))
      )
    );

    // Combine results from all indices
    for (const response of results) {
      for (const doc of response.body.docs || []) {
        if (doc.found && doc._source?.name) {
          storeNames[doc._id] = doc._source.name;
          // Also map by the numeric ID from the source
          if (doc._source?.id) {
            storeNames[String(doc._source.id)] = doc._source.name;
          }
        }
      }
    }

    // Fallback to MySQL for stores not found in OpenSearch
    const missingStoreIds = storeIds.filter(id => !storeNames[id] && !storeNames[String(id)]);
    if (missingStoreIds.length > 0) {
      this.logger.debug(`[getStoreNames] ${missingStoreIds.length} stores not found in OpenSearch, fetching from MySQL`);
      try {
        const mysqlStoreNames = await this.moduleService.getStoreNames(missingStoreIds);
        for (const [storeId, storeName] of mysqlStoreNames.entries()) {
          if (storeName) {
            storeNames[storeId] = storeName;
            // Also map by numeric ID
            const numericId = String(storeId);
            if (numericId !== storeId) {
              storeNames[numericId] = storeName;
            }
          }
        }
        this.logger.debug(`[getStoreNames] Fetched ${Object.keys(storeNames).length - (storeIds.length - missingStoreIds.length)} store names from MySQL`);
      } catch (error: any) {
        this.logger.warn(`[getStoreNames] Failed to fetch store names from MySQL: ${error?.message || String(error)}`);
      }
    }

    return storeNames;
  }

  // Utility function to get store details (including delivery time) by IDs
  private async getStoreDetails(storeIds: string[], module: string): Promise<Record<string, any>> {
    if (!storeIds.length) return {};

    // For module_id based search, search all store indices
    const storeAliases = module === 'all' || !module 
      ? this.getAllStoreIndices()
      : (() => {
          if (module === 'food') return ['food_stores'];
          if (module === 'ecom') return ['ecom_stores'];
          this.logger.warn(`[getStores] Unknown module '${module}', searching all store indices`);
          return this.getAllStoreIndices();
        })();
    
    const storeDetails: Record<string, any> = {};
    
    // Search all store indices in parallel
    const results = await Promise.all(
      storeAliases.map(alias =>
        this.client.mget({
          index: alias,
          body: { ids: storeIds }
        }).catch(() => ({ body: { docs: [] } }))
      )
    );

    // Combine results from all indices
    for (const response of results) {
      for (const doc of response.body.docs || []) {
        if (doc.found && doc._source) {
          const storeId = doc._id;
          const numericId = String(doc._source.id);
          const details = {
            name: doc._source.name,
            slug: doc._source.slug,
            logo: doc._source.logo,
            cover_photo: doc._source.cover_photo,
            rating: doc._source.rating,
            avg_rating: doc._source.avg_rating,
            delivery_time: doc._source.delivery_time,
            latitude: doc._source.latitude,
            longitude: doc._source.longitude,
            location: doc._source.location,
            module_id: doc._source.module_id,
            active: doc._source.active,
            status: doc._source.status,
            veg: doc._source.veg,
            non_veg: doc._source.non_veg,
            featured: doc._source.featured,
            order_count: doc._source.order_count,
            zone_id: doc._source.zone_id,
          };
          storeDetails[storeId] = details;
          storeDetails[numericId] = details;
        }
      }
    }
    
    return storeDetails;
  }

  // Helper method to get item index for a module
  private getItemIndex(module: 'food' | 'ecom'): string {
    return module === 'food' ? this.FOOD_ITEMS_INDEX : this.ECOM_ITEMS_INDEX;
  }

  // Helper method to get store index for a module
  private getStoreIndex(module: 'food' | 'ecom'): string {
    return module === 'food' ? this.FOOD_STORES_INDEX : this.ECOM_STORES_INDEX;
  }

  // Optimized category search for fast loading and scroll pagination
  async searchCategory(module: 'food' | 'ecom', filters: Record<string, string>) {
    const alias = this.getItemIndex(module);

    const categoryId = filters?.category_id;
    if (!categoryId) {
      throw new Error('category_id is required');
    }

    const must: any[] = [];
    const filterClauses: any[] = [];

    // Category filter (primary filter for fast querying)
    filterClauses.push({ term: { category_id: Number(categoryId) } });

    // Status filter (only active items)
    filterClauses.push({ term: { status: 1 } });

    // Vegetarian filter
    const veg = filters?.veg;
    if (veg === '1' || veg === 'true') {
      filterClauses.push({ term: { veg: 1 } });
    } else if (veg === '0' || veg === 'false') {
      filterClauses.push({ term: { veg: 0 } });
    }

    // Price range filters
    const priceMin = filters?.price_min ? Number(filters.price_min) : undefined;
    const priceMax = filters?.price_max ? Number(filters.price_max) : undefined;
    if (priceMin !== undefined || priceMax !== undefined) {
      const range: any = {};
      if (priceMin !== undefined && !Number.isNaN(priceMin)) range.gte = priceMin;
      if (priceMax !== undefined && !Number.isNaN(priceMax)) range.lte = priceMax;
      if (Object.keys(range).length) {
        filterClauses.push({ range: { price: range } });
      }
    }

    // Brand filter (for e-commerce)
    if (module === 'ecom' && typeof filters?.brand === 'string' && filters.brand.trim().length) {
      const brands = filters.brand
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (brands.length) filterClauses.push({ terms: { 'brand.keyword': brands } });
    }

    // Geo parameters
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    // Treat lat=0, lon=0 as no location (invalid coordinates)
    // Only food module supports geo features currently
    const supportsGeo = ['food', 'grocery'].includes(module);
    const hasGeo = supportsGeo && lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon) &&
                   !(lat === 0 && lon === 0);

    // Geo radius filter
    if (hasGeo && radiusKm && !Number.isNaN(radiusKm)) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, store_location: { lat, lon } } });
    }

    // Zone validation - DISABLED for items as they don't have zone_id indexed
    /*
    if (hasGeo) {
      try {
        const zoneId = await this.zoneService.getZoneId(lat, lon);
        if (zoneId) {
          filterClauses.push({ term: { zone_id: zoneId } });
          this.logger.debug(`[searchCategory] Applied zone filter: zone_id=${zoneId}`);
        }
      } catch (error) {
        this.logger.warn(`[searchCategory] Failed to get zone ID: ${(error as any)?.message || String(error)}`);
      }
    }
    */

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 50)); // Max 50 for performance
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort order
    const sortOrder = filters?.sort || (hasGeo ? 'distance' : 'popularity');
    let sort: any[] = [];

    switch (sortOrder) {
      case 'distance':
        if (hasGeo) {
          sort = [{ _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } }];
        } else {
          sort = [{ order_count: { order: 'desc' } }];
        }
        break;
      case 'price_asc':
        sort = [{ price: { order: 'asc' } }];
        break;
      case 'price_desc':
        sort = [{ price: { order: 'desc' } }];
        break;
      case 'rating':
        sort = [{ avg_rating: { order: 'desc' } }, { order_count: { order: 'desc' } }];
        break;
      case 'popularity':
      default:
        sort = [{ order_count: { order: 'desc' } }, { avg_rating: { order: 'desc' } }];
        break;
    }

    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
        },
      },
      size,
      from,
      sort,
      _source: [
        'id', 'name', 'title', 'description', 'image', 'images', 'slug', 'price', 'base_price', 'veg', 'brand',
        'category_id', 'category_name', 'category', 'store_id', 'avg_rating', 'order_count', 'store_location',
        'module_id', 'rating_count', 'available_time_starts', 'available_time_ends',
        'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved',
        'is_halal', 'is_visible', 'organic', 'maximum_cart_quantity', 'unit_id', 'zone_id', 'store_name'
      ],
      script_fields: hasGeo ? {
        distance_km: {
          script: {
            source: "if (!doc.containsKey('store_location') || doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
            params: { lat, lon },
          },
        },
      } : undefined,
    };

    // Execute search
    let res = await this.client.search({ index: alias, body });
    let hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; _score?: number; sort?: any[] }>;

    // Fallback: If no results found with radius filter, try without radius filter (but keep sorting by distance)
    if (hits.length === 0 && hasGeo && radiusKm) {
      this.logger.log(`[searchCategory] No results within ${radiusKm}km, retrying without radius filter`);
      
      // Remove geo_distance filter
      const fallbackFilterClauses = filterClauses.filter(f => !f.geo_distance);
      
      const fallbackBody = {
        ...body,
        query: {
          bool: {
            must: must.length ? must : [{ match_all: {} }],
            filter: fallbackFilterClauses,
          },
        },
      };

      res = await this.client.search({ index: alias, body: fallbackBody });
      hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; _score?: number; sort?: any[] }>;
    }

    // Get store names for items
    const storeIds = [...new Set(hits.map(h => h._source?.store_id).filter(Boolean))] as string[];
    const storeNames = await this.getStoreNames(storeIds, module);
    const storeDetails = await this.getStoreDetails(storeIds, module);

    // Map results with store information and delivery times
    const items = hits.map(h => {
      const source = h._source || {};
      // Extract distance from script_fields or sort array
      let distance = (h.fields as any)?.distance_km?.[0];
      
      // If not in script_fields, check sort array (when using _geo_distance sort)
      // Note: OpenSearch _geo_distance sort returns distance in meters even when unit: 'km' is specified
      if (distance === undefined || distance === null) {
        if (h.sort && Array.isArray(h.sort) && h.sort.length > 0) {
          const sortDistance = h.sort[0];
          if (typeof sortDistance === 'number' && !Number.isNaN(sortDistance)) {
            // If distance is > 1000, it's likely in meters (local searches are typically < 1000 km)
            // Convert to kilometers
            if (sortDistance > 1000) {
              distance = sortDistance / 1000.0;
            } else {
              distance = sortDistance;
            }
          }
        }
      }
      
      // Ensure distance from script_fields is also in km (it should be, but double-check)
      // If script_fields returned a value > 1000, it might be in meters, convert to km
      if (distance !== undefined && distance !== null && distance > 1000 && h.fields?.distance_km?.[0] === distance) {
        distance = distance / 1000.0;
      }
      
      // If still no distance and we have geo coordinates, calculate manually
      let calculatedDistance = distance;
      if ((calculatedDistance === undefined || calculatedDistance === null) && hasGeo && source.store_location) {
        const storeLoc = source.store_location;
        if (storeLoc?.lat && storeLoc?.lon) {
          const storeLat = parseFloat(String(storeLoc.lat));
          const storeLon = parseFloat(String(storeLoc.lon));
          if (!Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
            calculatedDistance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
          }
        }
      }

      // Get store details for delivery time
      const storeId = String(source.store_id);
      const storeDetail = storeDetails[storeId];
      let deliveryTime = storeDetail?.delivery_time || null;
      
      // Recalculate delivery time if distance is available
      if (calculatedDistance && deliveryTime) {
        const travelTimeMinutes = this.calculateTravelTime(calculatedDistance);
        deliveryTime = this.recalculateDeliveryTime(deliveryTime, travelTimeMinutes);
      }

      return { 
        id: h._id, 
        score: h._score, 
        distance_km: calculatedDistance,
        store_name: source.store_id ? storeNames[String(source.store_id)] : null,
        delivery_time: deliveryTime,
        ...source 
      };
    });

    // Get category information
    let categoryInfo = null;
    try {
      const catAlias = module === 'food' ? 'food_categories' : 'ecom_categories';
      const catRes = await this.client.get({ index: catAlias, id: categoryId });
      if (catRes.body.found) {
        categoryInfo = {
          id: catRes.body._id,
          name: catRes.body._source?.name,
          slug: catRes.body._source?.slug,
        };
      }
    } catch (error) {
      console.warn('Failed to fetch category info:', error);
    }

    return {
      module,
      category_id: Number(categoryId),
      category: categoryInfo,
      filters: {
        ...filters,
        sort: sortOrder,
        has_geo: hasGeo,
      },
      items,
      meta: {
        total: res.body.hits?.total?.value ?? 0,
        page,
        size,
        total_pages: Math.ceil((res.body.hits?.total?.value ?? 0) / size),
        has_more: page * size < (res.body.hits?.total?.value ?? 0),
      },
    };
  }

  // Optimized category-based store search for fast loading and scroll pagination
  async searchStoresCategory(module: 'food' | 'ecom', filters: Record<string, string>) {
    const storeAlias = this.getStoreIndex(module);
    const itemAlias = this.getItemIndex(module);
    const catAlias = module === 'food' ? 'food_categories' : 'ecom_categories';

    const categoryId = filters?.category_id;
    if (!categoryId) {
      throw new Error('category_id is required');
    }

    // First, find all items in this category
    const itemQuery = {
      query: {
        bool: {
          must: [
            { term: { category_id: Number(categoryId) } },
            { term: { status: 1 } } // Only active items
          ]
        }
      },
      size: 1000, // Get all items in category
      _source: ['store_id']
    };

    const itemRes = await this.client.search({ index: itemAlias, body: itemQuery });
    const itemHits = itemRes.body.hits?.hits || [];
    
    if (itemHits.length === 0) {
      return {
        module,
        category_id: Number(categoryId),
        category: null,
        filters: { ...filters },
        stores: [],
        meta: {
          total: 0,
          page: 1,
          size: 20,
          total_pages: 0,
          has_more: false,
        },
      };
    }

    // Get unique store IDs from items
    const storeIds = [...new Set(itemHits.map((hit: any) => hit._source?.store_id).filter(Boolean))] as string[];
    
    if (storeIds.length === 0) {
      return {
        module,
        category_id: Number(categoryId),
        category: null,
        filters: { ...filters },
        stores: [],
        meta: {
          total: 0,
          page: 1,
          size: 20,
          total_pages: 0,
          has_more: false,
        },
      };
    }

    // Build store search query
    const must: any[] = [];
    const filterClauses: any[] = [];

    // Store ID filter (primary filter)
    filterClauses.push({ terms: { id: storeIds } });

    // Status filters (only active AND approved stores) - stores use boolean fields
    filterClauses.push({ term: { status: true } });
    filterClauses.push({ term: { active: true } });

    // Vegetarian filter - stores use boolean fields
    const veg = filters?.veg;
    if (veg === '1' || veg === 'true') {
      filterClauses.push({ term: { veg: true } });
    } else if (veg === '0' || veg === 'false') {
      filterClauses.push({ term: { veg: false } });
    }

    // Brand filter (for e-commerce)
    if (module === 'ecom' && typeof filters?.brand === 'string' && filters.brand.trim().length) {
      const brands = filters.brand
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (brands.length) filterClauses.push({ terms: { 'brand.keyword': brands } });
    }

    // Delivery time filter — uses delivery_time_minutes (numeric) if available,
    // falls back to regex on delivery_time.keyword (avoids fielddata on text fields)
    const deliveryTimeMax = filters?.delivery_time_max ? Number(filters.delivery_time_max) : undefined;
    if (deliveryTimeMax !== undefined && !Number.isNaN(deliveryTimeMax)) {
      filterClauses.push({
        range: {
          delivery_time_minutes: { lte: deliveryTimeMax },
        },
      });
    }

    // Geo parameters
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    // Geo radius filter
    if (hasGeo && radiusKm && !Number.isNaN(radiusKm)) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, location: { lat, lon } } });
    }

    // Zone-aware filtering and boosting
    let userZoneId: number | null = null;
    if (hasGeo) {
      try {
        userZoneId = await this.zoneService.getZoneId(lat, lon);
        if (userZoneId) {
          // Add zone filter: prefer same zone + adjacent zones
          const zoneFilter = this.buildZoneFilter(userZoneId, true);
          if (zoneFilter) {
            filterClauses.push(zoneFilter);
            this.logger.debug(`[searchStoresCategory] Zone filter applied: user zone ${userZoneId} + adjacent zones`);
          }
        }
      } catch (error) {
        this.logger.warn(`[searchStoresCategory] Failed to get zone ID: ${(error as any)?.message || String(error)}`);
      }
    }

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 50)); // Max 50 for performance
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort order
    const sortOrder = filters?.sort || (hasGeo ? 'distance' : 'popularity');
    let sort: any[] = [];

    switch (sortOrder) {
      case 'distance':
        if (hasGeo) {
          sort = [{ _geo_distance: { location: { lat, lon }, order: 'asc', unit: 'km' } }];
        } else {
          sort = [{ order_count: { order: 'desc' } }];
        }
        break;
      case 'rating':
        sort = [{ order_count: { order: 'desc' } }]; // Use order_count as proxy for rating
        break;
      case 'delivery_time':
        sort = [{ order_count: { order: 'desc' } }]; // Can't sort by delivery_time text field
        break;
      case 'popularity':
      default:
        sort = [{ order_count: { order: 'desc' } }];
        break;
    }

    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
        },
      },
      size,
      from,
      sort,
      _source: [
        'id', 'name', 'slug', 'phone', 'email',
        'logo', 'cover_photo', 'image', 'images',
        'address', 'location', 'latitude', 'longitude',
        'rating', 'avg_rating', 'rating_count', 'order_count',
        'delivery_time', 'active', 'open', 'veg', 'non_veg',
        'featured', 'zone_id', 'module_id'
      ],
      script_fields: hasGeo ? {
        distance_km: {
          script: {
            source: "if (!doc.containsKey('location') || doc['location'].size() == 0) return null; doc['location'].arcDistance(params.lat, params.lon) / 1000.0",
            params: { lat, lon },
          },
        },
      } : undefined,
    };

    // Execute search
    const res = await this.client.search({ index: storeAlias, body });
    const hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; _score?: number }>;

    // Map results with distance, zone boost, and recalculated delivery times
    const stores = hits.map(h => {
      const source = h._source || {};
      let distance = (h.fields as any)?.distance_km?.[0];
      
      // Calculate distance if location is provided and not already calculated
      if (hasGeo && !distance) {
        // Try different location field formats
        let storeLat: number | undefined;
        let storeLon: number | undefined;
        
        if (source.latitude && source.longitude) {
          storeLat = parseFloat(source.latitude);
          storeLon = parseFloat(source.longitude);
        } else if (source.location?.lat && source.location?.lon) {
          storeLat = parseFloat(source.location.lat);
          storeLon = parseFloat(source.location.lon);
        }
        
        if (storeLat && storeLon) {
          distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
        }
      }

      // Apply zone-aware score boosting
      let finalScore = h._score;
      if (userZoneId && source.zone_id) {
        const zoneBoost = this.getZoneBoostFactor(source.zone_id, userZoneId);
        if (zoneBoost > 1.0) {
          finalScore = (finalScore || 0) * zoneBoost;
          this.logger.debug(`[searchStoresCategory] Store ${h._id} zone boost: ${zoneBoost}x (zone ${source.zone_id} vs user ${userZoneId})`);
        }
      }

      // Recalculate delivery time if distance is available
      let recalculatedDeliveryTime = source.delivery_time;
      if (distance && source.delivery_time) {
        const travelTime = this.calculateTravelTime(distance);
        recalculatedDeliveryTime = this.recalculateDeliveryTime(source.delivery_time, travelTime);
      }

      return { 
        id: h._id, 
        score: finalScore, 
        original_score: h._score,
        distance_km: distance ?? 0,
        delivery_time: recalculatedDeliveryTime,
        ...source,
        // Ensure required fields have safe defaults for Flutter
        phone: source.phone || null,
        email: source.email || null,
        active: source.active !== undefined ? source.active : true,
        open: source.open !== undefined ? source.open : 1,
        veg: source.veg !== undefined ? source.veg : null,
        non_veg: source.non_veg !== undefined ? source.non_veg : null,
        featured: source.featured !== undefined ? source.featured : 0,
        rating_count: source.rating_count || source.order_count || 0,
        avg_rating: source.avg_rating || source.rating || 0,
        rating: source.rating || source.avg_rating || 0,
      };
    });

    // Get category information
    let categoryInfo = null;
    try {
      const catRes = await this.client.get({ index: catAlias, id: categoryId });
      if (catRes.body.found) {
        categoryInfo = {
          id: catRes.body._id,
          name: catRes.body._source?.name,
          slug: catRes.body._source?.slug,
        };
      }
    } catch (error) {
      console.warn('Failed to fetch category info:', error);
    }

    return {
      module,
      category_id: Number(categoryId),
      category: categoryInfo,
      filters: {
        ...filters,
        sort: sortOrder,
        has_geo: hasGeo,
      },
      stores,
      meta: {
        total: res.body.hits?.total?.value ?? 0,
        page,
        size,
        total_pages: Math.ceil((res.body.hits?.total?.value ?? 0) / size),
        has_more: page * size < (res.body.hits?.total?.value ?? 0),
      },
    };
  }

  async health() {
    const info = await this.client.cluster.health();
    return info.body;
  }

  /**
   * Get frequently bought together recommendations for an item
   * @param storeId - Optional store ID to filter recommendations to items from the same store
   */
  async getFrequentlyBoughtTogether(itemId: string, moduleId: number, limit = 5, storeId?: string) {
    this.logger.log(`Getting recommendations for item ${itemId} in module ${moduleId}${storeId ? ` (store ${storeId})` : ''}`);

    try {
      // Get the index for this module
      const indexName = moduleId === 4 ? this.FOOD_ITEMS_INDEX : moduleId === 5 ? this.ECOM_ITEMS_INDEX : null;
      if (!indexName) {
        throw new BadRequestException('Invalid module_id. Only modules 4 (food) and 5 (ecom) supported.');
      }

      // Fetch the item from OpenSearch to get its frequently_with data
      const response = await this.client.get({
        index: indexName,
        id: itemId,
      });

      const item = response.body._source;
      let frequentlyWith = item.frequently_with || [];

      if (frequentlyWith.length === 0) {
        return {
          item_id: itemId,
          item_name: item.name || item.title,
          module_id: moduleId,
          store_id: storeId || item.store_id,
          recommendations: [],
          meta: {
            total_recommendations: 0,
            message: 'No frequently bought together data available for this item'
          }
        };
      }

      // Filter by store if storeId is provided
      if (storeId) {
        const storeIdNum = Number(storeId);
        const targetStoreId = Number.isNaN(storeIdNum) ? storeId : storeIdNum;
        
        // Fetch all recommended items first to check their store_id
        const allRecommendedIds = frequentlyWith.map((r: any) => r.item_id.toString());
        const allDetailsResponse = await this.client.mget({
          index: indexName,
          body: { ids: allRecommendedIds },
        });

        // Filter to only items from the same store
        const sameStoreRecommendations = frequentlyWith.filter((rec: any, index: number) => {
          const itemDoc = allDetailsResponse.body.docs[index];
          if (itemDoc.found) {
            return itemDoc._source.store_id === targetStoreId;
          }
          return false;
        });

        frequentlyWith = sameStoreRecommendations;

        if (frequentlyWith.length === 0) {
          return {
            item_id: itemId,
            item_name: item.name || item.title,
            module_id: moduleId,
            store_id: storeId,
            recommendations: [],
            meta: {
              total_recommendations: 0,
              message: `No recommendations found from store ${storeId}`
            }
          };
        }
      }

      // Limit to requested count
      const limitedRecommendations = frequentlyWith.slice(0, limit);

      // Fetch details for recommended items
      const recommendedItemIds = limitedRecommendations.map((r: any) => r.item_id);
      const detailsResponse = await this.client.mget({
        index: indexName,
        body: {
          ids: recommendedItemIds.map((id: number) => id.toString()),
        },
      });

      // Combine recommendations with item details
      const recommendations = limitedRecommendations.map((rec: any, index: number) => {
        const itemDoc = detailsResponse.body.docs[index];
        if (itemDoc.found) {
          const itemData = itemDoc._source;
          return {
            item_id: rec.item_id,
            item_name: rec.item_name || itemData.name || itemData.title,
            times_together: rec.times_together,
            image: itemData.image || itemData.images?.[0],
            price: itemData.price || itemData.base_price,
            veg: itemData.veg,
            avg_rating: itemData.avg_rating,
            store_id: itemData.store_id,
            store_name: itemData.store_name,
          };
        }
        return {
          item_id: rec.item_id,
          item_name: rec.item_name,
          times_together: rec.times_together,
        };
      });

      // Calculate total times bought together
      const totalTimesTogether = frequentlyWith.reduce((sum: number, r: any) => sum + r.times_together, 0);

      return {
        item_id: itemId,
        item_name: item.name || item.title,
        module_id: moduleId,
        store_id: storeId || item.store_id,
        recommendations,
        meta: {
          total_recommendations: recommendations.length,
          based_on_orders: totalTimesTogether,
          store_filtered: !!storeId,
        }
      };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        throw new BadRequestException(`Item ${itemId} not found in module ${moduleId}`);
      }
      this.logger.error(`Error fetching recommendations: ${error.message}`);
      throw error;
    }
  }

  /**
   * Semantic search using vector embeddings with native KNN
   * Uses food_items_prod (768-dim vectors + complete store data) for food
   * Uses ecom_items for e-commerce
   */
  async semanticSearch(
    module: 'food' | 'ecom',
    query: string,
    filters: Record<string, string>
  ) {
    // Use food_items_prod with 768-dim vectors and complete store data
    const vectorIndex = module === 'food' ? 'food_items_v5' : 'ecom_items';
    
    // Select appropriate model: food model for food module, general for ecom
    const modelType = module === 'food' ? 'food' : 'general';
    
    this.logger.log(`🔍 Semantic search (KNN): "${query}" in ${vectorIndex} using ${modelType} model`);

    // Generate embedding for the query with appropriate model
    const embedding = await this.embeddingService.generateEmbedding(query, modelType);
    if (!embedding) {
      this.logger.warn('Failed to generate embedding, falling back to keyword search');
      return this.search(module, query, filters);
    }

    // Build filter clauses (same as regular search but without status filter)
    const filterClauses: any[] = [];

    // Veg filter
    const veg = filters?.veg;
    const vegStr = String(veg);
    if (vegStr === '1' || vegStr === 'true' || vegStr === 'veg') {
      filterClauses.push({ term: { veg: 1 } });
    } else if (vegStr === '0' || vegStr === 'false' || vegStr === 'non-veg') {
      filterClauses.push({ term: { veg: 0 } });
    }

    // Category filter
    const categoryId = filters?.category_id;
    if (categoryId) {
      const num = Number(categoryId);
      filterClauses.push({ term: { category_id: Number.isNaN(num) ? categoryId : num } });
    }

    // Price range
    const priceMin = filters?.price_min ? Number(filters.price_min) : undefined;
    const priceMax = filters?.price_max ? Number(filters.price_max) : undefined;
    if (priceMin !== undefined || priceMax !== undefined) {
      const range: any = {};
      if (priceMin !== undefined && !Number.isNaN(priceMin)) range.gte = priceMin;
      if (priceMax !== undefined && !Number.isNaN(priceMax)) range.lte = priceMax;
      if (Object.keys(range).length) {
        filterClauses.push({ range: { price: range } });
      }
    }

    // Geo filter
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);
    
    if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm)) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, store_location: { lat, lon } } });
    }

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Build native KNN query with filters
    // OpenSearch KNN uses L2 distance (lower is better)
    const body: any = {
      size,
      from,
      query: {
        bool: {
          must: [
            {
              knn: {
                item_vector: {
                  vector: embedding,
                  k: Math.min(size * 3, 100) // Fetch more candidates for better accuracy
                }
              }
            }
          ],
          filter: filterClauses
        }
      },
      _source: {
        excludes: ['item_vector'] // Don't return the 384-dim vector in response
      }
    };

    // Add geo sorting if location is provided
    if (hasGeo) {
      body.sort = [
        '_score', // First by semantic similarity
        { _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } }
      ];
      body.script_fields = {
        distance_km: {
          script: {
            source: `
              if (doc['store_location'].size() == 0) {
                return 0;
              }
              def loc = doc['store_location'].value;
              return doc['store_location'].arcDistance(params.lat, params.lon) / 1000;
            `,
            params: { lat, lon }
          }
        }
      };
    }

    this.logger.debug(`Native KNN search query: ${JSON.stringify(body, null, 2).substring(0, 500)}`);

    try {
      const response = await this.client.search({
        index: vectorIndex,
        body
      });

      const items = response.body.hits?.hits?.map((hit: any) => {
        const item: any = { ...hit._source };
        item.score = hit._score; // KNN score (L2 distance, lower is better)
        if (hit.fields?.distance_km) {
          item.distance_km = hit.fields.distance_km[0];
        }
        return item;
      }) || [];

      this.logger.log(`✅ Native KNN search returned ${items.length} items`);

      return {
        module,
        q: query,
        semantic_search: true,
        knn_search: true,
        filters,
        items: this.imageService.transformItemsWithImages(items),
        facets: {},
        meta: {
          total: response.body.hits?.total?.value ?? 0,
          page,
          size,
          total_pages: Math.ceil((response.body.hits?.total?.value ?? 0) / size),
          has_more: page * size < (response.body.hits?.total?.value ?? 0),
        },
      };
    } catch (error: any) {
      this.logger.error(`Native KNN search error: ${error.message}`);
      // Fallback to keyword search
      this.logger.log('Falling back to keyword search');
      return this.search(module, query, filters);
    }
  }

  async search(module: 'food' | 'ecom' | 'rooms' | 'services' | 'movies', q: string, filters: Record<string, string>) {
    const startTime = Date.now();
    
    // Try cache first if enabled
    if (this.cacheEnabled) {
      const cacheKey = this.cacheService.buildCacheKey({ module, q, ...filters });
      const cached = await this.cacheService.get(cacheKey);
      
      if (cached) {
        const latency = Date.now() - startTime;
        this.logger.log(`🚀 Cache HIT: module=${module}, q="${q}", latency=${latency}ms`);
        
        // Recalculate timing for cached stores (timing is dynamic based on current time)
        if (cached.stores && Array.isArray(cached.stores)) {
          cached.stores.forEach((store: any) => {
            const timingInfo = this.getStoreTimingStatus(store);
            store.timing_status = timingInfo.status;
            store.timing_message = timingInfo.message;
            store.is_open = timingInfo.isOpen;
            if (timingInfo.minutesRemaining !== undefined) {
              store.minutes_until_closing = timingInfo.minutesRemaining;
            }
          });
        }
        
        return cached;
      }
    }
    
    // Execute search
    const results = await this.executeSearch(module, q, filters, startTime);
    
    // Cache results if enabled
    if (this.cacheEnabled && results) {
      const cacheKey = this.cacheService.buildCacheKey({ module, q, ...filters });
      
      // Dynamic TTL based on query type
      let ttl = 300; // Default 5 minutes
      
      if (!q || q.trim() === '') {
        ttl = 600; // 10 min for browse queries
      } else if (results.meta?.total > 100) {
        ttl = 900; // 15 min for popular queries
      } else if (filters?.lat && filters?.lon) {
        ttl = 60; // 1 min for geo queries (location-sensitive)
      }
      
      await this.cacheService.set(cacheKey, results, ttl);
    }
    
    return results;
  }

  private async executeSearch(module: 'food' | 'ecom' | 'rooms' | 'services' | 'movies', q: string, filters: Record<string, string>, startTime: number) {
    let alias: string;
    switch (module) {
      case 'food': alias = this.FOOD_ITEMS_INDEX; break;
      case 'ecom': alias = this.ECOM_ITEMS_INDEX; break;
      case 'rooms': alias = 'rooms_index'; break;
      case 'services': alias = 'services_index'; break;
      case 'movies': alias = 'movies_catalog'; break;
      default: alias = this.FOOD_ITEMS_INDEX;
    }
    const must: any[] = [];
    const filterClauses: any[] = [];
    if (q && q.trim()) {
      if (module === 'movies') {
      must.push({
        multi_match: {
          query: q,
            fields: ['title^4','description^2','genre^2','cast^1'],
          type: 'best_fields',
          operator: 'and',
          fuzziness: 'AUTO',
          lenient: true,
        },
      });
      } else {
        must.push({
          bool: {
            should: [
              // Exact match gets highest priority
              { term: { 'name.keyword': { value: q, boost: 15 } } },
              { term: { slug: { value: q.toLowerCase(), boost: 12 } } },
              
              // Word boundary match (e.g., "pan" as a whole word, not substring)
              { match: { name: { query: q, operator: 'and', boost: 10 } } },
              
              // Phrase match gets high priority
              { match_phrase: { name: { query: q, boost: 8 } } },
              { match_phrase: { slug: { query: q.toLowerCase(), boost: 6 } } },
              { match_phrase: { category_name: { query: q, boost: 7 } } },
              
              // Partial matches with AND operator (stricter)
              { multi_match: {
                query: q,
                fields: ['name^3', 'description^1', 'category_name^2'],
                type: 'best_fields',
                operator: 'and',
                fuzziness: 'AUTO',
                lenient: true,
              }},
              
              // Wildcard matches for partial text (lower boost to prevent substring dominance)
              { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 0.5 } } },
              { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 0.3 } } },
            ],
            minimum_should_match: 1,
        },
      });
      }
    }
    // Parse common filters (veg, category_id, price range)
    // Enhanced veg/non-veg filtering: supports 'veg', 'non-veg', or 'all'
    const veg = filters?.veg;
    if (veg === '1' || veg === 'true' || veg === 'veg') {
      filterClauses.push({ term: { veg: 1 } });
    } else if (veg === '0' || veg === 'false' || veg === 'non-veg') {
      filterClauses.push({ term: { veg: 0 } });
    }
    // If veg === 'all' or undefined, no filter is applied (show both)
    const categoryId = filters?.category_id;
    if (categoryId) {
      const num = Number(categoryId);
      filterClauses.push({ term: { category_id: Number.isNaN(num) ? categoryId : num } });
    }
    // Services category (string): allow filtering by `category` keyword
    if (module === 'services' && typeof filters?.category === 'string' && filters.category.trim().length) {
      filterClauses.push({ term: { 'category.keyword': filters.category } });
    }
    // Movies genre (string): allow filtering by `genre` keyword
    if (module === 'movies' && typeof filters?.genre === 'string' && filters.genre.trim().length) {
      filterClauses.push({ term: { 'genre.keyword': filters.genre } });
    }
    const priceMin = filters?.price_min ? Number(filters.price_min) : undefined;
    const priceMax = filters?.price_max ? Number(filters.price_max) : undefined;
    if (priceMin !== undefined || priceMax !== undefined) {
      const range: any = {};
      if (priceMin !== undefined && !Number.isNaN(priceMin)) range.gte = priceMin;
      if (priceMax !== undefined && !Number.isNaN(priceMax)) range.lte = priceMax;
      if (Object.keys(range).length) {
        const priceField = module === 'services' ? 'base_price' : 'price';
        filterClauses.push({ range: { [priceField]: range } });
      }
    }

    // rating_min filter (items have avg_rating)
    const ratingMin = filters?.rating_min ? Number(filters.rating_min) : undefined;
    if (ratingMin !== undefined && !Number.isNaN(ratingMin)) {
      filterClauses.push({ range: { avg_rating: { gte: ratingMin } } });
    }

    // open_now filter (items only; compares current server time to available_time_* if present)
    const openNow = (filters?.open_now === '1' || filters?.open_now === 'true');
    let nowMin: number | undefined;
    if (openNow && module === 'food') {
      const now = new Date();
      nowMin = now.getHours() * 60 + now.getMinutes();
      // DISABLED: Requires available_time_starts/ends as keyword or integer fields (needs reindex)
      // filterClauses.push({
      //   script: {
      //     script: {
      //       source:
      //         "def s = doc['available_time_starts'].size()==0 ? null : doc['available_time_starts'].value;" +
      //         "def e = doc['available_time_ends'].size()==0 ? null : doc['available_time_ends'].value;" +
      //         "if (s == null || e == null) return true;" +
      //         "def sh = Integer.parseInt(s.substring(0,2)); def sm = Integer.parseInt(s.substring(3,5));" +
      //         "def eh = Integer.parseInt(e.substring(0,2)); def em = Integer.parseInt(e.substring(3,5));" +
      //         "def start = sh*60+sm; def end = eh*60+em; def nowm = params.nowMin;" +
      //         "if (end >= start) { return nowm >= start && nowm <= end; } else { return nowm >= start || nowm <= end; }",
      //       params: { nowMin },
      //       lang: 'painless',
      //     },
      //   },
      // });
    }

    // geo params for items (for both food and ecom; uses store_location field). Movies items typically don't have store_location.
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);
    const supportsItemGeo = module !== 'movies';
    const appliedGeoRadiusFilter = supportsItemGeo && hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm);
    if (appliedGeoRadiusFilter) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, store_location: { lat, lon } } });
    }

    // ecom brand filter (comma-separated)
    if (module === 'ecom' && typeof filters?.brand === 'string' && filters.brand.trim().length) {
      const brands = filters.brand
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (brands.length) filterClauses.push({ terms: { 'brand.keyword': brands } });
    }

    // store_id filter (single store) - for searching within a specific store
    const storeId = filters?.store_id;
    if (storeId) {
      const num = Number(storeId);
      filterClauses.push({ term: { store_id: Number.isNaN(num) ? storeId : num } });
    }

    // store_ids filter (multiple stores) - for multi-store comparison
    if (typeof filters?.store_ids === 'string' && filters.store_ids.trim().length) {
      const storeIds = filters.store_ids
        .split(',')
        .map(s => s.trim())
        .map(s => {
          const num = Number(s);
          return Number.isNaN(num) ? s : num;
        })
        .filter(Boolean);
      if (storeIds.length) filterClauses.push({ terms: { store_id: storeIds } });
    }

  // DISABLED: status field not populated in current index — needs re-sync from PHP
  // if (module === 'food' || module === 'ecom') {
  //   filterClauses.push({ term: { status: 1 } }); // Only active items
  // }

  const baseQuery: any = { bool: { must: must.length ? must : [{ match_all: {} }], filter: filterClauses, must_not: this.buildTestStoreExclusion('store_name.keyword') } };

  // pagination
  const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
  const page = Math.max(1, Number(filters?.page ?? 1) || 1);
  const from = (page - 1) * size;

    const aggsConfig: any = (module === 'food' || module === 'ecom')
      ? {
          veg: { terms: { field: 'veg', size: 2 } },
          category_id: { terms: { field: 'category_id', size: 20 } },
          price_ranges: {
            range: {
              field: 'price',
              ranges: [
                { to: 100 },
                { from: 100, to: 300 },
                { from: 300, to: 1000 },
                { from: 1000 },
              ],
            },
          },
          ...(module === 'ecom' ? { brand: { terms: { field: 'brand.keyword', size: 20 } } } : {}),
        } : module === 'movies' ? {
          // For movies, expose genre facet when available
          genre: { terms: { field: 'genre.keyword', size: 20 } },
        } : module === 'services' ? {
          // For services, show category facet and base_price ranges
          category: { terms: { field: 'category.keyword', size: 20 } },
          price_ranges: {
            range: {
              field: 'base_price',
              ranges: [
                { to: 500 },
                { from: 500, to: 1000 },
                { from: 1000, to: 2000 },
                { from: 2000 },
              ],
            },
          },
        } : {
          // rooms minimal aggs if needed later
        };

    const useFnScore = module === 'food' || (supportsItemGeo && hasGeo) || ratingMin !== undefined;
  const body: any = {
      query: useFnScore ? {
        function_score: {
          query: baseQuery,
          functions: [
            ...(supportsItemGeo && hasGeo ? [{
              gauss: {
                store_location: { origin: { lat, lon }, scale: '2km', offset: '0km', decay: 0.5 },
              },
              weight: 3,
            }] : []),
            // Boost popular items
            { field_value_factor: { field: 'order_count', modifier: 'sqrt', factor: 0.05, missing: 0 } },
            // Boost higher-rated items
            { field_value_factor: { field: 'avg_rating', modifier: 'none', factor: 1.0, missing: 0 } },
            // Prefer currently open items (Food) - DISABLED: Text fields don't support doc[] access
            // ...(module === 'food' ? [{
            //   filter: { script: { script: {
            //     source:
            //       "def s = doc['available_time_starts'].size()==0 ? null : doc['available_time_starts'].value;" +
            //       "def e = doc['available_time_ends'].size()==0 ? null : doc['available_time_ends'].value;" +
            //       "if (s == null || e == null) return false;" +
            //       "def sh = Integer.parseInt(s.substring(0,2)); def sm = Integer.parseInt(s.substring(3,5));" +
            //       "def eh = Integer.parseInt(e.substring(0,2)); def em = Integer.parseInt(e.substring(3,5));" +
            //       "def start = sh*60+sm; def end = eh*60+em; def now = params.nowMin;" +
            //       "if (end >= start) { return now >= start && now <= end; } else { return now >= start || now <= end; }",
            //     params: { nowMin: nowMin ?? (new Date().getHours()*60 + new Date().getMinutes()) },
            //     lang: 'painless',
            //   }}},
            //   weight: 1.5,
            // }] : []),
          ],
          score_mode: 'sum',
          boost_mode: 'sum',
        },
      } : baseQuery,
      size,
      from,
      aggs: aggsConfig,
      _source: [
        'id','name','title','description','image','images','slug','price','base_price','veg','brand','attributes','category_id','category_name','category','store_id',
        'avg_rating','order_count','store_location','module_id','rating_count','available_time_starts','available_time_ends',
        'genre','cast','duration_min','pricing_model','visit_fee',
        'discount','discount_type','status','tax','tax_type','stock','recommended','is_approved',
        'is_halal','is_visible','organic','maximum_cart_quantity','unit_id','zone_id','store_name'
      ],
      script_fields: (supportsItemGeo && hasGeo) ? {
        distance_km: {
          script: {
            source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
            params: { lat, lon },
          },
        },
      } : undefined,
    };

    // Enhanced item search: Always search for items by name, category, and store, then merge and sort results
    let res: any;
    let aggRes: any;
    let stores: any[] = [];

    // Search for stores directly if query is present
    if (q && q.trim() && (module === 'food' || module === 'ecom')) {
      const storeAlias = module === 'food' ? 'food_stores' : 'ecom_stores';
      const storeSearchBody: any = {
        query: {
          bool: {
            should: [
              { match_phrase: { name: { query: q, boost: 10 } } },
              { match: { name: { query: q, boost: 5 } } },
              { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } }
            ],
            minimum_should_match: 1,
            filter: [
              { term: { status: true } } // Only active stores (boolean field)
            ],
            must_not: this.buildTestStoreExclusion('name.keyword'),
          }
        },
        size: 20 // Limit to top 20 stores
      };

      // Add geo sorting if available
      if (hasGeo) {
        storeSearchBody.sort = [
          { _geo_distance: { location: { lat, lon }, order: 'asc', unit: 'km' } }
        ];
        storeSearchBody.script_fields = {
          distance_km: {
            script: {
              source: "if (doc['location'].size() == 0) return null; doc['location'].arcDistance(params.lat, params.lon) / 1000.0",
              params: { lat, lon },
            },
          },
        };
      }

      try {
        const storeRes = await this.client.search({ index: storeAlias, body: storeSearchBody });
        stores = (storeRes.body.hits?.hits || []).map((h: any) => {
          const source = h._source;
          let distance = (h.fields as any)?.distance_km?.[0];
          
          // Fallback distance calculation
          if (hasGeo && !distance && source.location?.lat && source.location?.lon) {
             distance = this.calculateDistance(lat!, lon!, parseFloat(source.location.lat), parseFloat(source.location.lon));
          }

          return {
            id: h._id,
            ...source,
            distance_km: distance
          };
        });
      } catch (e) {
        this.logger.warn(`Failed to search stores: ${(e as any).message}`);
      }
    }
    
    if (q && q.trim() && (module === 'food' || module === 'ecom')) {
      const storeAlias = module === 'food' ? 'food_stores' : 'ecom_stores';
      const catAlias = module === 'food' ? 'food_categories' : 'ecom_categories';
      let allItems: Array<{ _id: string; _source: any; fields?: any; _score?: number; matchType: string }> = [];
      
      try {
        // 1. Item name matches (main search)
        const itemNameRes = await this.client.search({ index: alias, body });
        const nameMatches = (itemNameRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'name' }));
        allItems.push(...nameMatches);
        
        // 2. Category matches
        const catRes = await this.client.search({
          index: catAlias,
          body: {
            query: {
              bool: {
                should: [
                  { match: { name: { query: q, boost: 3 } } },
                  { match_phrase_prefix: { name: { query: q, boost: 2 } } },
                  { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 100,
            _source: ['id'],
          },
        }).catch(() => ({ body: { hits: { hits: [] } } }));

        const matchingCategoryIds = (catRes.body.hits?.hits || []).map((hit: any) => hit._id);
        
        if (matchingCategoryIds.length > 0) {
          // Find items in these categories
          const itemsInCategoriesRes = await this.client.search({
            index: alias,
            body: {
              query: {
                bool: {
                  must: [
                    { terms: { category_id: matchingCategoryIds } },
                    { term: { status: 1 } } // Only active items
                  ],
                  filter: filterClauses,
                  must_not: this.buildTestStoreExclusion('store_name.keyword'),
                }
              },
              size: 1000,
              _source: body._source,
              script_fields: hasGeo ? {
                distance_km: {
                  script: {
                    source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                    params: { lat, lon },
                  },
                },
              } : undefined,
            },
          }).catch(() => ({ body: { hits: { hits: [] } } }));
          
          const categoryMatches = (itemsInCategoriesRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'category' }));
          allItems.push(...categoryMatches);
        }

        // 3. Store name matches
        const storeRes = await this.client.search({
          index: storeAlias,
          body: {
            query: {
              bool: {
                should: [
                  { multi_match: { query: q, fields: ['name^3', 'slug^2'], type: 'best_fields' } },
                  { multi_match: { query: q, fields: ['name^2'], type: 'phrase_prefix' } },
                  { prefix: { slug: { value: q.toLowerCase() } } },
                  { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
                ],
                minimum_should_match: 1,
                must_not: this.buildTestStoreExclusion('name.keyword'),
              },
            },
            size: 100,
            _source: ['id'],
          },
        }).catch(() => ({ body: { hits: { hits: [] } } }));

        const matchingStoreIds = (storeRes.body.hits?.hits || []).map((hit: any) => hit._id);
        
        if (matchingStoreIds.length > 0) {
          // Find items from these stores
          const itemsFromStoresRes = await this.client.search({
            index: alias,
            body: {
              query: {
                bool: {
                  must: [
                    { terms: { store_id: matchingStoreIds } },
                    { term: { status: 1 } } // Only active items
                  ],
                  filter: filterClauses,
                  must_not: this.buildTestStoreExclusion('store_name.keyword'),
                }
              },
              size: 1000,
              _source: body._source,
              script_fields: hasGeo ? {
                distance_km: {
                  script: {
                    source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                    params: { lat, lon },
                  },
                },
              } : undefined,
            },
          }).catch(() => ({ body: { hits: { hits: [] } } }));
          
          const storeMatches = (itemsFromStoresRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'store' }));
          allItems.push(...storeMatches);
        }

        // Remove duplicates and sort by match type priority with proper scoring
        const seenItems = new Set<string>();
        const sortedItems: Array<{ _id: string; _source: any; fields?: any; _score?: number; matchType: string }> = [];
        
        // Priority order: name > category > store
        const matchTypeOrder = { 'name': 1, 'category': 2, 'store': 3 };
        const matchTypeScore = { 'name': 1000, 'category': 100, 'store': 10 };
        
        allItems
          .sort((a, b) => {
            const aOrder = matchTypeOrder[a.matchType as keyof typeof matchTypeOrder] || 999;
            const bOrder = matchTypeOrder[b.matchType as keyof typeof matchTypeOrder] || 999;
            
            if (aOrder !== bOrder) {
              return aOrder - bOrder;
            }
            
            // Within same match type, sort by score
            return (b._score || 0) - (a._score || 0);
          })
          .forEach(item => {
            if (!seenItems.has(item._id)) {
              seenItems.add(item._id);
              // Apply match type scoring
              const baseScore = item._score || 0;
              const matchTypeBoost = matchTypeScore[item.matchType as keyof typeof matchTypeScore] || 1;
              item._score = baseScore + matchTypeBoost;
              sortedItems.push(item);
            }
          });
        
        // Use the enhanced results
        res = {
          body: {
            hits: {
              total: { value: sortedItems.length },
              hits: sortedItems
            },
            aggregations: itemNameRes.body.aggregations
          }
        };
        
        // Get aggregations from the main search
        const aggOnly: any = { query: body.query, size: 0, aggs: body.aggs };
        aggRes = await this.client.search({ index: alias, body: aggOnly });
        
      } catch (error) {
        console.warn('Enhanced item search failed:', error);
        // Fallback to original search
        const aggOnly: any = { query: body.query, size: 0, aggs: body.aggs };
        [res, aggRes] = await Promise.all([
      this.client.search({ index: alias, body }),
          this.client.search({ index: alias, body: aggOnly }),
        ]);
      }
    } else {
      // Run main search and a dedicated aggregation query in parallel (for consistent facets)
      const aggOnly: any = { query: body.query, size: 0, aggs: body.aggs };
      [res, aggRes] = await Promise.all([
        this.client.search({ index: alias, body }),
        this.client.search({ index: alias, body: aggOnly }),
      ]);
    }
    
    // Geo fallback: if radius filter excluded everything, retry without the hard radius filter
    try {
      const total0 = res?.body?.hits?.total?.value ?? 0;
      if (appliedGeoRadiusFilter && total0 === 0) {
        const filterNoGeo = filterClauses.filter((f: any) => !('geo_distance' in f));
        const baseQueryNoGeo: any = { bool: { must: must.length ? must : [{ match_all: {} }], filter: filterNoGeo } };
        const queryNoGeo = useFnScore ? {
          function_score: {
            query: baseQueryNoGeo,
            functions: [
              ...(supportsItemGeo && hasGeo ? [{ gauss: { store_location: { origin: { lat, lon }, scale: '2km', offset: '0km', decay: 0.5 } }, weight: 3 }] : []),
              { field_value_factor: { field: 'order_count', modifier: 'sqrt', factor: 0.05, missing: 0 } },
              { field_value_factor: { field: 'avg_rating', modifier: 'none', factor: 1.0, missing: 0 } },
              // DISABLED: Text fields don't support doc[] access
              // ...(module === 'food' ? [{
              //   filter: { script: { script: {
              //     source:
              //       "def s = doc['available_time_starts'].size()==0 ? null : doc['available_time_starts'].value;" +
              //       "def e = doc['available_time_ends'].size()==0 ? null : doc['available_time_ends'].value;" +
              //       "if (s == null || e == null) return false;" +
              //       "def sh = Integer.parseInt(s.substring(0,2)); def sm = Integer.parseInt(s.substring(3,5));" +
              //       "def eh = Integer.parseInt(e.substring(0,2)); def em = Integer.parseInt(e.substring(3,5));" +
              //       "def start = sh*60+sm; def end = eh*60+em; def now = params.nowMin;" +
              //       "if (end >= start) { return now >= start && now <= end; } else { return now >= start || now <= end; }",
              //     params: { nowMin: nowMin ?? (new Date().getHours()*60 + new Date().getMinutes()) },
              //     lang: 'painless',
              //   }}},
              //   weight: 1.5,
              // }] : []),
            ],
            score_mode: 'sum',
            boost_mode: 'sum',
          },
        } : baseQueryNoGeo;

        const bodyNoGeo: any = { ...body, query: queryNoGeo };
        const aggNoGeo: any = { query: queryNoGeo, size: 0, aggs: body.aggs };
        [res, aggRes] = await Promise.all([
          this.client.search({ index: alias, body: bodyNoGeo }),
          this.client.search({ index: alias, body: aggNoGeo }),
        ]);
      }
    } catch {}
    const hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; _score?: number }>;
    let aggs = (aggRes.body as any).aggregations || res.body.aggregations || {};
    const facets: any = {};
    if (aggs.veg?.buckets) {
      facets.veg = aggs.veg.buckets.map((b: any) => ({ value: b.key, count: b.doc_count }));
    }
    if (aggs.category_id?.buckets) {
      facets.category_id = aggs.category_id.buckets.map((b: any) => ({ value: b.key, count: b.doc_count }));
    }
    if (aggs.price_ranges?.buckets) {
      facets.price = aggs.price_ranges.buckets.map((b: any) => ({ key: b.key, from: b.from, to: b.to, count: b.doc_count }));
    }
    if (aggs.brand?.buckets) {
      facets.brand = aggs.brand.buckets.map((b: any) => ({ value: b.key, count: b.doc_count }));
    }
    if (aggs.genre?.buckets) {
      facets.genre = aggs.genre.buckets.map((b: any) => ({ value: b.key, count: b.doc_count }));
    }
    if (aggs.category?.buckets) {
      facets.category = aggs.category.buckets.map((b: any) => ({ value: b.key, count: b.doc_count }));
    }
      // Get store names and delivery times for items
      const storeIds = [...new Set(hits.map(h => h._source?.store_id).filter(Boolean))] as string[];
      const storeNames = await this.getStoreNames(storeIds, module);
      const storeDetails = await this.getStoreDetails(storeIds, module);

      let items = hits.map(h => {
        const { matchType, ...cleanHit } = h as any;
        const source = h._source || {};
        const distance = (h.fields as any)?.distance_km?.[0];
        
        // Calculate distance if location is provided and not already calculated
        let calculatedDistance = distance;
        if (hasGeo && !calculatedDistance && source.store_location?.lat && source.store_location?.lon) {
          calculatedDistance = this.calculateDistance(lat!, lon!, source.store_location.lat, source.store_location.lon);
        }

        // Get store details for delivery time
        const storeId = String(source.store_id);
        const storeDetail = storeDetails[storeId];
        let deliveryTime = storeDetail?.delivery_time || null;
        
        // Recalculate delivery time if distance is available
        if (calculatedDistance && deliveryTime) {
          const travelTimeMinutes = this.calculateTravelTime(calculatedDistance);
          deliveryTime = this.recalculateDeliveryTime(deliveryTime, travelTimeMinutes);
        }

        return { 
          id: h._id, 
          score: h._score, 
          distance_km: calculatedDistance,
          store_name: source.store_id ? storeNames[String(source.store_id)] : null,
          delivery_time: deliveryTime,
          ...source 
        };
      });


    // Optional lightweight re-ranking (heuristic) when requested
    const doRerank = filters?.rerank === '1';
    if (doRerank && items.length > 1) {
      items = items
        .map(it => {
          const boost = (Number(it.avg_rating || 0) * 0.5) + (Number(it.order_count || 0) * 0.01);
          return { ...it, score: Number(it.score || 0) + boost };
        })
        .sort((a,b) => (Number(b.score||0) - Number(a.score||0)));
    }

    // Enrich category facets with labels from categories index
    if (Array.isArray(facets.category_id) && facets.category_id.length) {
      const ids = facets.category_id.map((b: any) => String(b.value));
      try {
        const catIndex = module === 'food' ? 'food_categories' : module === 'ecom' ? 'ecom_categories' : module === 'rooms' ? 'rooms_categories' : module === 'services' ? 'services_categories' : 'movies_categories';
        const mget = await this.client.mget({ index: catIndex, body: { ids } });
        const map: Record<string, string> = {};
        for (const d of (mget.body.docs || [])) {
          if (d.found) map[String(d._id)] = d._source?.name || String(d._id);
        }
        facets.category_id = facets.category_id.map((b: any) => ({ ...b, label: map[String(b.value)] || String(b.value) }));
      } catch {}
    }

    const response = {
      module,
      q,
      filters,
      stores: this.imageService.transformStoresWithImages(stores),
      items: this.imageService.transformItemsWithImages(items),
      facets,
      meta: { total: res.body.hits?.total?.value ?? hits.length },
    };
    
    // Log search performance
    const latency = Date.now() - startTime;
    this.logger.log(`Search: module=${module}, q="${q || '(browse)'}", total=${response.meta.total}, items=${items.length}, latency=${latency}ms`);
    
    // best-effort analytics
    this.analytics.logSearch({
      module,
      q: q || '',
      lat,
      lon,
      size,
      page,
      filters,
      total: response.meta.total,
      section: 'items',
    }).catch(() => {});
    
    return response;
  }

  /**
   * UNIFIED SEARCH: Module-aware search with cross-module support
   * Supports: single module, multiple modules, module types, or global search
   */
  async unifiedSearch(q: string, filters: Record<string, string>) {
    this.logger.log(`🚀 unifiedSearch CALLED: q="${q}", filters=${JSON.stringify(filters)}`);
    
    // Parse module parameters
    const moduleId = filters?.module_id ? Number(filters.module_id) : undefined;
    const moduleIdsStr = filters?.module_ids;
    const moduleIds = moduleIdsStr 
      ? moduleIdsStr.split(',').map(id => Number(id.trim())).filter(id => !Number.isNaN(id))
      : undefined;
    let moduleType = filters?.module_type || filters?.module;
    if (moduleType === 'ecom') moduleType = 'ecommerce';

    // Category validation: if category_id is provided, module_id is required
    const categoryId = filters?.category_id;
    if (categoryId && !moduleId) {
      throw new BadRequestException(
        'category_id requires module_id parameter (categories are module-scoped, not globally unique)'
      );
    }

    // Validate category belongs to module if both provided.
    // IMPORTANT: This uses MySQL; in environments without MySQL connectivity we should not 500.
    if (categoryId && moduleId) {
      try {
        const isValid = await this.moduleService.validateCategoryModule(Number(categoryId), moduleId);
        if (!isValid) {
          throw new BadRequestException(
            `Category ${categoryId} does not exist in module ${moduleId}`
          );
        }
      } catch (error: any) {
        // If it's a BadRequestException, rethrow. Otherwise, skip validation to avoid 500.
        if (error instanceof BadRequestException) throw error;
        this.logger.warn(`[unifiedSearch] Category validation skipped (MySQL unavailable): ${error?.message || String(error)}`);
      }
    }

    // Resolve which modules to search (MySQL-backed). Fall back to common mappings if DB is unavailable.
    let modules: any[] = [];
    try {
      modules = await this.moduleService.resolveModules({
        module_id: moduleId,
        module_ids: moduleIds,
        module_type: moduleType,
      });
    } catch (error: any) {
      this.logger.warn(`[unifiedSearch] Module resolution failed (MySQL unavailable): ${error?.message || String(error)}; using fallback modules`);

      const typeMap: Record<number, string> = {
        4: 'food',
        5: 'ecommerce',
        6: 'grocery',
      };
      const nameMap: Record<number, string> = {
        4: 'Food',
        5: 'Shop',
        6: 'Grocery',
      };

      const ids = moduleId ? [moduleId] : (moduleIds && moduleIds.length ? moduleIds : undefined);
      const fallbackIds = ids && ids.length ? ids : [4, 5];
      const now = new Date();
      modules = fallbackIds.map((id) => ({
        id,
        module_type: typeMap[id] || 'food',
        name: nameMap[id] || `Module ${id}`,
        slug: `module-${id}`,
        description: null,
        icon: null,
        status: 1,
        opensearch_index: null,
        created_at: now,
        updated_at: now,
      }));
    }

    if (modules.length === 0) {
      return {
        q,
        filters,
        modules: [],
        items: [],
        meta: { total: 0, page: 1, size: 0, total_pages: 0, searching_modules: [] },
      };
    }

    this.logger.log(`🔍 Unified search: "${q}" across ${modules.length} modules: ${modules.map(m => m.name).join(', ')}`);

    // Check if semantic search is requested
    const useSemantic = filters?.semantic === '1' || filters?.semantic === 'true';

    // Get indices for all modules
    const indices = this.moduleService.getIndicesForModules(modules, 'items');
    this.logger.debug(`Searching indices: ${indices.join(', ')}`);

    // Remove duplicates - if multiple modules share an index
    const uniqueIndices = [...new Set(indices)];

    // Build search query with module filtering
    const must: any[] = [];
    const filterClauses: any[] = [];

    // Add module_id filter to restrict to selected modules
    const moduleIdList = modules.map(m => m.id);
    filterClauses.push({ terms: { module_id: moduleIdList } });

    // Query text
    if (q && q.trim()) {
      const shouldClauses: any[] = [
        // Exact match gets highest priority
        { term: { 'name.keyword': { value: q, boost: 15 } } },
        { term: { slug: { value: q.toLowerCase(), boost: 12 } } },
        
        // Word boundary match (whole word)
        { match: { name: { query: q, operator: 'and', boost: 10 } } },
        
        // Phrase match gets high priority
        { match_phrase: { name: { query: q, boost: 8 } } },
        { match_phrase: { slug: { query: q.toLowerCase(), boost: 6 } } },
        { match_phrase: { category_name: { query: q, boost: 7 } } },
        
        // Partial matches
        { multi_match: {
          query: q,
          fields: ['name^3', 'description^1', 'category_name^2'],
          type: 'best_fields',
          operator: 'and',
          fuzziness: 'AUTO',
          lenient: true,
        }},
        
        // Wildcard matches for partial text (lower boost)
        { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 0.5 } } },
        { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 0.3 } } },
      ];

      // Apply time-based category boosting for food module
      const hasFoodModule = modules.some(m => m.module_type === 'food');
      if (hasFoodModule) {
        const categoryBoosts = this.getTimeBasedCategoryBoosts();
        if (categoryBoosts.size > 0) {
          categoryBoosts.forEach((boost, categoryId) => {
            shouldClauses.push({
              term: { category_id: { value: categoryId, boost } }
            });
          });
          this.logger.debug(`Applied time-based boosts to ${categoryBoosts.size} categories`);
        }
      }

      must.push({
        bool: {
          should: shouldClauses,
          minimum_should_match: 1,
        },
      });
    }

    // Veg filter
    const veg = filters?.veg;
    if (veg === '1' || veg === 'true' || veg === 'veg') {
      filterClauses.push({ term: { veg: 1 } });
    } else if (veg === '0' || veg === 'false' || veg === 'non-veg') {
      filterClauses.push({ term: { veg: 0 } });
    }

    // Category filter (already validated above)
    if (categoryId) {
      filterClauses.push({ term: { category_id: Number(categoryId) } });
    }

    // Price range
    const priceMin = filters?.price_min ? Number(filters.price_min) : undefined;
    const priceMax = filters?.price_max ? Number(filters.price_max) : undefined;
    if (priceMin !== undefined || priceMax !== undefined) {
      const range: any = {};
      if (priceMin !== undefined && !Number.isNaN(priceMin)) range.gte = priceMin;
      if (priceMax !== undefined && !Number.isNaN(priceMax)) range.lte = priceMax;
      if (Object.keys(range).length) {
        filterClauses.push({ range: { price: range } });
      }
    }

    // Rating filter
    const ratingMin = filters?.rating_min ? Number(filters.rating_min) : undefined;
    if (ratingMin !== undefined && !Number.isNaN(ratingMin)) {
      filterClauses.push({ range: { avg_rating: { gte: ratingMin } } });
    }

    // Trending filter
    const trending = filters?.trending;
    if (trending === '1' || trending === 'true') {
      filterClauses.push({ term: { is_trending: true } });
    }

    // Quality score filter
    const minQuality = filters?.min_quality ? Number(filters.min_quality) : undefined;
    if (minQuality !== undefined && !Number.isNaN(minQuality)) {
      filterClauses.push({ range: { quality_score: { gte: minQuality } } });
    }

    // Store filters - for searching within specific stores
    const storeId = filters?.store_id;
    if (storeId) {
      const num = Number(storeId);
      filterClauses.push({ term: { store_id: Number.isNaN(num) ? storeId : num } });
    }

    // Multiple stores filter
    if (typeof filters?.store_ids === 'string' && filters.store_ids.trim().length) {
      const storeIds = filters.store_ids
        .split(',')
        .map(s => s.trim())
        .map(s => {
          const num = Number(s);
          return Number.isNaN(num) ? s : num;
        })
        .filter(Boolean);
      if (storeIds.length) filterClauses.push({ terms: { store_id: storeIds } });
    }

    // Geo parameters
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    // Geo radius filter
    if (hasGeo && radiusKm && !Number.isNaN(radiusKm)) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, store_location: { lat, lon } } });
    }

    // Zone handling
    // IMPORTANT: Do NOT hard-filter items by derived zone_id from lat/lon.
    // Zone metadata may be missing/inconsistent in some indices and would hide results.
    // If strict zone filtering is desired, it should be passed explicitly as a filter.
    if (hasGeo) {
      try {
        const derivedZoneId = await this.zoneService.getZoneId(lat, lon);
        if (derivedZoneId) {
          this.logger.debug(`[unifiedSearch] Derived zone_id=${derivedZoneId} from (${lat}, ${lon}) (not applied as hard filter)`);
        }
      } catch (error) {
        this.logger.warn(`[unifiedSearch] Failed to derive zone ID: ${(error as any)?.message || String(error)}`);
      }
    }

    // Zone filter (future enhancement - requires zone mapping in items)
    const zoneId = filters?.zone_id;
    if (zoneId) {
      // Note: This requires items to have zone_id field
      // filterClauses.push({ term: { zone_id: Number(zoneId) } });
      this.logger.warn('Zone filtering not yet implemented in unified search');
    }

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort order
    const sortOrder = filters?.sort || (hasGeo ? 'distance' : 'relevance');
    let sort: any[] = [];

    switch (sortOrder) {
      case 'distance':
        if (hasGeo) {
          sort = [{ _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } }];
        } else {
          // Fallback to rating if no geo coordinates
          sort = [{ avg_rating: { order: 'desc', missing: 0 } }, { _score: { order: 'desc' } }];
        }
        break;
      case 'price_asc':
        sort = [{ price: { order: 'asc', missing: '_last' } }];
        break;
      case 'price_desc':
        sort = [{ price: { order: 'desc', missing: '_last' } }];
        break;
      case 'rating':
        sort = [{ avg_rating: { order: 'desc', missing: 0 } }, { _score: { order: 'desc' } }];
        break;
      case 'popularity':
        // Use order_count if available, fallback to avg_rating
        sort = [
          { order_count: { order: 'desc', missing: 0 } }, 
          { avg_rating: { order: 'desc', missing: 0 } }, 
          { _score: { order: 'desc' } }
        ];
        break;
      case 'quality':
        // Sort by quality_score
        sort = [
          { quality_score: { order: 'desc', missing: 0 } },
          { avg_rating: { order: 'desc', missing: 0 } },
          { _score: { order: 'desc' } }
        ];
        break;
      case 'trending':
        // Sort by trending_score
        sort = [
          { trending_score: { order: 'desc', missing: 0 } },
          { is_trending: { order: 'desc' } },
          { _score: { order: 'desc' } }
        ];
        break;
      case 'relevance':
      default:
        // Default: sort by relevance score
        sort = [{ _score: { order: 'desc' } }, { avg_rating: { order: 'desc', missing: 0 } }];
        break;
    }

    // Build query body
    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
          must_not: this.buildTestStoreExclusion('store_name.keyword'),
        },
      },
      size,
      from,
      sort,
      _source: [
        'id', 'name', 'title', 'description', 'image', 'images', 'slug', 'price', 'base_price', 'veg', 'brand',
        'category_id', 'category_name', 'category', 'store_id', 'avg_rating', 'store_location',
        'module_id', 'rating_count', 'available_time_starts', 'available_time_ends', 'store_name', 'zone_id',
        'order_count', 'review_count', 'trending_score', 'is_trending', 'quality_score', 'popularity_score',
        'frequently_with', 'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended',
        'is_approved', 'is_halal', 'is_visible', 'organic', 'maximum_cart_quantity', 'unit_id'
      ],
      script_fields: hasGeo ? {
        distance_km: {
          script: {
            source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
            params: { lat, lon },
          },
        },
      } : undefined,
    };

    this.logger.debug(`Unified search query: ${JSON.stringify(body, null, 2).substring(0, 500)}`);

    // Execute search across all indices
    // Use msearch for multiple indices or single search if only one unique index
    let allItems: any[] = [];
    let totalHits = 0;
    let stores: any[] = [];

    // Search for stores directly if query is present
      if (q && q.trim()) {
        const storeIndices: string[] = [];
        if (modules.some(m => m.module_type === 'food')) storeIndices.push('food_stores');
        if (modules.some(m => m.module_type === 'ecommerce' || m.module_type === 'ecom' || m.module_type === 'grocery')) {
          storeIndices.push('ecom_stores');
        }
      
      if (storeIndices.length > 0) {
        const storeSearchBody: any = {
          query: {
            bool: {
              should: [
                { match_phrase: { name: { query: q, boost: 10 } } },
                { match: { name: { query: q, boost: 5 } } },
                { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } }
              ],
              minimum_should_match: 1,
              filter: [
                { term: { status: true } } // Only active stores (boolean field)
              ]
            }
          },
          size: 20 // Limit to top 20 stores
        };

        // Add geo sorting if available
        if (hasGeo) {
          storeSearchBody.sort = [
            { _geo_distance: { location: { lat, lon }, order: 'asc', unit: 'km' } }
          ];
          storeSearchBody.script_fields = {
            distance_km: {
              script: {
                source: "if (doc['location'].size() == 0) return null; doc['location'].arcDistance(params.lat, params.lon) / 1000.0",
                params: { lat, lon },
              },
            },
          };
        }

        try {
          // Search all store indices
          const storeSearches: any[] = [];
          storeIndices.forEach(index => {
            storeSearches.push({ index });
            storeSearches.push(storeSearchBody);
          });

          const msearchRes = await this.client.msearch({ body: storeSearches });
          const responses = msearchRes.body.responses || [];

          responses.forEach((res: any) => {
            if (!res.error) {
              const hits = res.hits?.hits || [];
              hits.forEach((h: any) => {
                const source = h._source;
                let distance = (h.fields as any)?.distance_km?.[0];
                
                // Fallback distance calculation
                if (hasGeo && !distance && source.location?.lat && source.location?.lon) {
                   distance = this.calculateDistance(lat!, lon!, parseFloat(source.location.lat), parseFloat(source.location.lon));
                }

                stores.push({
                  id: h._id,
                  ...source,
                  distance_km: distance
                });
              });
            }
          });
          
          // Sort combined stores by distance or score
          if (hasGeo) {
            stores.sort((a, b) => (a.distance_km || Infinity) - (b.distance_km || Infinity));
          } else {
            stores.sort((a, b) => (b._score || 0) - (a._score || 0));
          }
          
          // Limit to top 20
          stores = stores.slice(0, 20);
          
        } catch (e) {
          this.logger.warn(`Failed to search stores in unified search: ${(e as any).message}`);
        }
      }
    }

    try {
      if (uniqueIndices.length === 1) {
        // Single index search
        const res = await this.client.search({ index: uniqueIndices[0], body });
        const hits = res.body.hits?.hits || [];
        allItems = hits.map((h: any) => ({
          ...h._source,
          id: h._id,
          score: h._score,
          distance_km: h.fields?.distance_km?.[0],
        }));
        totalHits = res.body.hits?.total?.value ?? 0;
      } else {
        // Multi-index search using msearch
        const searches: any[] = [];
        uniqueIndices.forEach(index => {
          searches.push({ index });
          searches.push(body);
        });

        const msearchRes = await this.client.msearch({ body: searches });
        const responses = msearchRes.body.responses || [];

        responses.forEach((res: any, idx: number) => {
          if (!res.error) {
            const hits = res.hits?.hits || [];
            hits.forEach((h: any) => {
              allItems.push({
                ...h._source,
                id: h._id,
                score: h._score,
                distance_km: h.fields?.distance_km?.[0],
              });
            });
            totalHits += res.hits?.total?.value ?? 0;
          } else {
            this.logger.error(`Search error on index ${uniqueIndices[idx]}: ${res.error?.reason}`);
          }
        });

        // Sort combined results
        if (sortOrder === 'distance' && hasGeo) {
          allItems.sort((a, b) => (a.distance_km || Infinity) - (b.distance_km || Infinity));
        } else if (sortOrder === 'price_asc') {
          allItems.sort((a, b) => (a.price || 0) - (b.price || 0));
        } else if (sortOrder === 'price_desc') {
          allItems.sort((a, b) => (b.price || 0) - (a.price || 0));
        } else if (sortOrder === 'rating') {
          allItems.sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0));
        } else {
          // Default sort by avg_rating for popularity/relevance
          allItems.sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0));
        }

        // Apply pagination to combined results
        allItems = allItems.slice(from, from + size);
      }

      // Enrich items with module names
      const moduleMap = new Map(modules.map(m => [m.id, m]));
      allItems = allItems.map(item => {
        const module = moduleMap.get(item.module_id);
        return {
          ...item,
          module_name: module?.name || `Module ${item.module_id}`,
          module_type: module?.module_type,
        };
      });

      // Calculate distance if not already calculated and geo params provided
      if (hasGeo) {
        allItems = allItems.map(item => {
          if (!item.distance_km && item.store_location?.lat && item.store_location?.lon) {
            item.distance_km = this.calculateDistance(
              lat!,
              lon!,
              item.store_location.lat,
              item.store_location.lon
            );
          }
          return item;
        });
      }

      this.logger.log(`✅ Unified search returned ${allItems.length} items from ${totalHits} total`);

      return {
        q,
        filters: {
          ...filters,
          module_ids: moduleIdList,
          searching_modules: modules.map(m => ({ id: m.id, name: m.name, type: m.module_type })),
        },
        modules: modules.map(m => ({
          id: m.id,
          name: m.name,
          type: m.module_type,
          slug: m.slug,
        })),
        stores,
        items: allItems,
        meta: {
          total: totalHits,
          page,
          size,
          total_pages: Math.ceil(totalHits / size),
          has_more: page * size < totalHits,
          searched_indices: uniqueIndices,
          searching_modules: modules.map(m => m.name),
        },
      };
      } catch (error: any) {
        this.logger.error(`❌ Unified search error (returning empty response): ${error?.message || String(error)}`, error?.stack);

        // Never 500 for unified search; return empty payload so the UI can still function.
        // Keep the response shape stable.
        const safeSize = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
        const safePage = Math.max(1, Number(filters?.page ?? 1) || 1);

        return {
          q,
          filters: {
            ...filters,
            module_ids: (Array.isArray((filters as any)?.module_ids) ? (filters as any).module_ids : undefined),
            searching_modules: [],
          },
          modules: (Array.isArray(modules) ? modules : []).map((m: any) => ({
            id: m?.id,
            name: m?.name,
            type: m?.module_type,
            slug: m?.slug,
          })),
          stores: [],
          items: [],
          meta: {
            total: 0,
            page: safePage,
            size: safeSize,
            total_pages: 0,
            has_more: false,
            searched_indices: [],
            searching_modules: [],
          },
        };
      }
  }

  async searchStores(module: 'food' | 'ecom' | 'rooms' | 'services' | 'movies', q: string, filters: Record<string, string>) {
    let alias: string;
    switch (module) {
      case 'food': alias = 'food_stores'; break;
      case 'ecom': alias = 'ecom_stores'; break;
      case 'rooms': alias = 'rooms_stores'; break;
      case 'services': alias = 'services_stores'; break;
      case 'movies': alias = 'movies_showtimes'; break;
      default:
        this.logger.warn(`[searchStores] Unexpected module '${module}', defaulting to food_stores`);
        alias = 'food_stores';
    }
    const must: any[] = [];
    const filterClauses: any[] = [];

    if (q && q.trim()) {
      must.push({
        bool: {
          should: [
            // Exact match gets highest priority
            { term: { name: { value: q, boost: 10 } } },
            { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
            // Phrase match gets high priority
            { match_phrase: { name: { query: q, boost: 6 } } },
            { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
            // Partial matches
            { multi_match: {
          query: q,
              fields: ['name^3', 'slug^2', 'address'],
          type: 'best_fields',
          operator: 'and',
          fuzziness: 'AUTO',
            }},
            // Wildcard matches for partial text
            { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
            { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    // geo params
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    if (hasGeo && radiusKm && !Number.isNaN(radiusKm)) {
      filterClauses.push({
        geo_distance: {
          distance: `${radiusKm}km`,
          location: { lat, lon },
        },
      });
    }

    // Zone-aware filtering and boosting
    let userZoneId: number | null = null;
    if (hasGeo) {
      try {
        userZoneId = await this.zoneService.getZoneId(lat, lon);
        if (userZoneId) {
          // Add zone filter: prefer same zone + adjacent zones
          const zoneFilter = this.buildZoneFilter(userZoneId, true);
          if (zoneFilter) {
            filterClauses.push(zoneFilter);
            this.logger.debug(`[searchStores] Zone filter applied: user zone ${userZoneId} + adjacent zones`);
          }
        }
      } catch (error) {
        this.logger.warn(`[searchStores] Failed to get zone ID: ${(error as any)?.message || String(error)}`);
      }
    }

    // Status filters (only active AND approved stores) - stores use boolean fields
    filterClauses.push({ term: { status: true } });
    filterClauses.push({ term: { active: true } });
    this.logger.debug(`[searchStores] Applied status=true, active=true filter`);

    // Veg/Non-Veg filter - stores use boolean fields
    const vegFilter = filters?.veg;
    if (vegFilter === '1' || vegFilter === 'veg' || vegFilter === 'true') {
      filterClauses.push({ term: { veg: true } });
      this.logger.debug(`[searchStores] Applied VEG filter`);
    } else if (vegFilter === '0' || vegFilter === 'non-veg' || vegFilter === 'false') {
      filterClauses.push({ term: { non_veg: true } });
      this.logger.debug(`[searchStores] Applied NON-VEG filter`);
    }
    // If vegFilter is not set or is 'all', show all stores (no filter)

    // Delivery time filter for stores — uses delivery_time_minutes (numeric) if mapped
    const deliveryTimeMax = filters?.delivery_time_max ? Number(filters.delivery_time_max) : undefined;
    if (deliveryTimeMax !== undefined && !Number.isNaN(deliveryTimeMax)) {
      filterClauses.push({
        range: {
          delivery_time_minutes: { lte: Math.floor(deliveryTimeMax) },
        },
      });
    }

    // pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort order
    const sortOrder = filters?.sort || (hasGeo ? 'distance' : 'popularity');

    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
          must_not: this.buildTestStoreExclusion('name.keyword'),
        },
      },
      size,
      from,
      sort: hasGeo
        ? [{
            _geo_distance: {
              location: { lat, lon },
              order: 'asc',
              unit: 'km',
              mode: 'min',
              distance_type: 'arc',
              ignore_unmapped: true,
            },
          }]
        : [{ order_count: { order: 'desc' } }],
      // Ensure _source fields are included when using script_fields
      _source: [
        // Identity & Basic Info
        'name','slug','phone','email',
        // Images
        'logo','cover_photo','image','images',
        // Location
        'address','location','latitude','longitude',
        // Ratings & Orders
        'rating','avg_rating','rating_count','order_count',
        // Operational Info
        'delivery_time','active','open','veg','non_veg',
        // Business Info
        'featured','zone_id','module_id','discount',
        // Module-specific
        'theater_name',
      ],
      script_fields: hasGeo
        ? {
            distance_km: {
              script: {
                source: "if (doc['location'].size() == 0) return null; doc['location'].arcDistance(params.lat, params.lon) / 1000.0",
                params: { lat, lon },
              },
            },
          }
        : undefined,
    };

    // Enhanced store search: Always search for stores by name, category, and items, then merge and sort results
    let res: any;
    let hits: Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number }> = [];
    
    if (q && q.trim()) {
      let allStores: Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number; matchType: string }> = [];
      const itemAlias = this.getItemIndex(module as 'food' | 'ecom');
      const catAlias = module === 'food' ? 'food_categories' : module === 'ecom' ? 'ecom_categories' : 'food_categories';
      
      try {
        // 1. Store name matches (initial search)
        const initialRes = await this.client.search({ index: alias, body });
        const nameMatches = (initialRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'name' }));
        allStores.push(...nameMatches);
        
        // 2. Category matches
        const catRes = await this.client.search({
          index: catAlias,
          body: {
            query: {
              bool: {
                should: [
                  { match: { name: { query: q, boost: 3 } } },
                  { match_phrase_prefix: { name: { query: q, boost: 2 } } },
                  { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 100,
            _source: ['id'],
          },
        }).catch(() => ({ body: { hits: { hits: [] } } }));

        const matchingCategoryIds = (catRes.body.hits?.hits || []).map((hit: any) => hit._id);
        
        if (matchingCategoryIds.length > 0) {
          // Find items in these categories first
          const itemsInCategoriesRes = await this.client.search({
            index: itemAlias,
            body: {
              query: {
                bool: {
                  must: [
                    { terms: { category_id: matchingCategoryIds } },
                    { term: { status: 1 } } // Only active items
                  ]
                }
              },
              size: 1000,
              _source: ['store_id'],
            },
          }).catch(() => ({ body: { hits: { hits: [] } } }));

          const storeIdsFromCategories = new Set<string>();
          (itemsInCategoriesRes.body.hits?.hits || []).forEach((hit: any) => {
            if (hit._source?.store_id) {
              storeIdsFromCategories.add(String(hit._source.store_id));
            }
          });

          if (storeIdsFromCategories.size > 0) {
            // Find stores that have items in these categories
            const storeRes = await this.client.search({
              index: alias,
              body: {
                query: {
                  bool: {
                    must: [
                      { terms: { id: Array.from(storeIdsFromCategories) } }
                    ],
                    filter: filterClauses,
                  },
                },
                size: 100,
                _source: [
                  'id', 'name', 'slug', 'phone', 'email',
                  'logo', 'cover_photo', 'image', 'images',
                  'address', 'location', 'latitude', 'longitude',
                  'rating', 'avg_rating', 'rating_count', 'order_count',
                  'delivery_time', 'active', 'open', 'veg', 'non_veg',
                  'featured', 'zone_id', 'module_id'
                ],
              },
            }).catch(() => ({ body: { hits: { hits: [] } } }));
            
            const categoryMatches = (storeRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'category' }));
            allStores.push(...categoryMatches);
          }
        }

        // 3. Item matches
        const itemRes = await this.client.search({
          index: itemAlias,
          body: {
            query: {
              bool: {
                should: [
                  { multi_match: { query: q, fields: ['name^3', 'category_name^2'], type: 'best_fields' } },
                  { multi_match: { query: q, fields: ['name^2'], type: 'phrase_prefix' } },
                  { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 1000,
            _source: ['store_id'],
          },
        }).catch(() => ({ body: { hits: { hits: [] } } }));

        const matchingStoreIds = new Set<string>();
        (itemRes.body.hits?.hits || []).forEach((hit: any) => {
          if (hit._source?.store_id) {
            matchingStoreIds.add(String(hit._source.store_id));
          }
        });

        if (matchingStoreIds.size > 0) {
          const storeRes = await this.client.search({
            index: alias,
            body: {
              query: {
                bool: {
                  must: [{ terms: { id: Array.from(matchingStoreIds) } }],
                  filter: filterClauses,
                },
              },
              size: 100,
              _source: [
                'id', 'name', 'slug', 'phone', 'email',
                'logo', 'cover_photo', 'image', 'images',
                'address', 'location', 'latitude', 'longitude',
                'rating', 'avg_rating', 'rating_count', 'order_count',
                'delivery_time', 'active', 'open', 'veg', 'non_veg',
                'featured', 'zone_id', 'module_id'
              ],
            },
          }).catch(() => ({ body: { hits: { hits: [] } } }));
          
          const itemMatches = (storeRes.body.hits?.hits || []).map((h: any) => ({ ...h, matchType: 'item' }));
          allStores.push(...itemMatches);
        }

        // Remove duplicates and sort by match type priority with proper scoring
        const seenStores = new Set<string>();
        const sortedStores: Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number; matchType: string; distance_km?: number }> = [];
        
        // Priority order: name > item (store name matches first, then stores with matching items)
        const matchTypeOrder = { 'name': 1, 'item': 2, 'category': 3 };
        
        // Calculate distances for all stores if geo is available
        allStores.forEach((store: any) => {
          if (hasGeo && !store.distance_km) {
            const src = store._source || {};
            let storeLat: number | undefined;
            let storeLon: number | undefined;
            
            if (src.latitude && src.longitude) {
              storeLat = parseFloat(src.latitude);
              storeLon = parseFloat(src.longitude);
            } else if (src.location?.lat && src.location?.lon) {
              storeLat = parseFloat(src.location.lat);
              storeLon = parseFloat(src.location.lon);
            }
            
            if (storeLat && storeLon) {
              store.distance_km = this.calculateDistance(lat!, lon!, storeLat, storeLon);
            }
          }
        });

        // Apply zone-aware score boosting
        if (userZoneId) {
          allStores.forEach((store: any) => {
            const storeZoneId = store._source?.zone_id;
            const zoneBoost = this.getZoneBoostFactor(storeZoneId, userZoneId);
            if (zoneBoost > 1.0) {
              store.zone_boost = zoneBoost;
              store.original_score = store._score || 0;
              store._score = (store._score || 0) * zoneBoost;
              this.logger.debug(`[searchStores] Store ${store._id} zone boost: ${zoneBoost}x (zone ${storeZoneId} vs user ${userZoneId})`);
            }
          });
        }
        
        allStores
          .sort((a: any, b: any) => {
            // First: Sort by match type priority (name > item > category)
            const aOrder = matchTypeOrder[a.matchType as keyof typeof matchTypeOrder] || 999;
            const bOrder = matchTypeOrder[b.matchType as keyof typeof matchTypeOrder] || 999;
            
            if (aOrder !== bOrder) {
              return aOrder - bOrder;
            }
            
            // Second: Within same match type, sort by score (higher is better)
            const scoreDiff = (b._score || 0) - (a._score || 0);
            if (Math.abs(scoreDiff) > 0.01) {
              return scoreDiff;
            }
            
            // Third: Sort by distance (closer is better) if geo is available
            if (hasGeo && sortOrder === 'distance') {
              const aDist = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
              const bDist = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
              return aDist - bDist;
            }
            
            // Fallback: Sort by popularity
            return (b._source?.order_count || 0) - (a._source?.order_count || 0);
          })
          .forEach((store: any) => {
            if (!seenStores.has(store._id)) {
              seenStores.add(store._id);
              sortedStores.push(store);
            }
          });
        
        hits = sortedStores;
        res = {
          body: {
            hits: {
              total: { value: sortedStores.length },
              hits: sortedStores
            }
          }
        };
        
      } catch (error) {
        console.warn('Enhanced store search failed:', error);
        // Fallback to original search
        res = await this.client.search({ index: alias, body });
        hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number }>;
      }
    } else {
      // No query, use original search
      res = await this.client.search({ index: alias, body });
      hits = (res.body.hits?.hits || []) as Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number }>;
    }
    
    const items = hits.map(h => {
      const src: any = h._source || {};
      let distance = (h.fields && (h.fields as any).distance_km && (h.fields as any).distance_km[0]) ?? undefined;
      
      // Calculate distance if location is provided and not already calculated
      if (hasGeo && !distance) {
        // Try different location field formats
        let storeLat: number | undefined;
        let storeLon: number | undefined;
        
        if (src.latitude && src.longitude) {
          storeLat = parseFloat(src.latitude);
          storeLon = parseFloat(src.longitude);
        } else if (src.location?.lat && src.location?.lon) {
          storeLat = parseFloat(src.location.lat);
          storeLon = parseFloat(src.location.lon);
        }
        
        if (storeLat && storeLon) {
          distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
        }
      }

      // Recalculate delivery time if distance is available
      let deliveryTime = src.delivery_time;
      if (distance && src.delivery_time) {
        const travelTimeMinutes = this.calculateTravelTime(distance);
        deliveryTime = this.recalculateDeliveryTime(src.delivery_time, travelTimeMinutes);
      }
      
      // Remove matchType from the response
      const { matchType, ...cleanHit } = h as any;
      
      return { 
        id: h._id, 
        score: h._score, 
        distance_km: distance ?? 0, 
        ...src,
        delivery_time: deliveryTime, // Updated delivery time
        // Ensure required fields have safe defaults for Flutter
        phone: src.phone || null,
        email: src.email || null,
        active: src.active !== undefined ? src.active : true,
        open: src.open !== undefined ? src.open : 1,
        veg: src.veg !== undefined ? src.veg : null,
        non_veg: src.non_veg !== undefined ? src.non_veg : null,
        featured: src.featured !== undefined ? src.featured : 0,
        rating_count: src.rating_count || src.order_count || 0,
        avg_rating: src.avg_rating || src.rating || 0,
        rating: src.rating || src.avg_rating || 0,
      };
    });
    const response = {
      module,
      q,
      filters,
      stores: items,
      meta: { total: res.body.hits?.total?.value ?? items.length },
    };
    // best-effort analytics
    this.analytics.logSearch({
      module,
      q: q || '',
      lat,
      lon,
      size,
      page,
      filters,
      total: response.meta.total,
      section: 'stores',
    }).catch(() => {});
    return response;
  }

  async suggest(module: 'food' | 'ecom' | 'rooms' | 'services' | 'movies', q: string, filters: Record<string, string>) {
    const minLen = 2;
    if (!q || q.trim().length < minLen) {
      return { module, q, items: [], stores: [], categories: [] };
    }
    const size = Math.max(1, Math.min(Number(filters?.size ?? 50) || 50, 50));
    const lat = filters?.lat ? Number(filters.lat) : undefined;
    const lon = filters?.lon ? Number(filters.lon) : undefined;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    let itemAlias: string, storeAlias: string, catAlias: string;
    switch (module) {
      case 'food': 
        itemAlias = this.FOOD_ITEMS_INDEX; storeAlias = this.FOOD_STORES_INDEX; catAlias = 'food_categories'; 
        break;
      case 'ecom': 
        itemAlias = this.ECOM_ITEMS_INDEX; storeAlias = this.ECOM_STORES_INDEX; catAlias = 'ecom_categories'; 
        break;
      case 'rooms': 
        itemAlias = 'rooms_index'; storeAlias = 'rooms_stores'; catAlias = 'rooms_categories'; 
        break;
      case 'services': 
        itemAlias = 'services_index'; storeAlias = 'services_stores'; catAlias = 'services_categories'; 
        break;
      case 'movies':
        itemAlias = 'movies_catalog'; storeAlias = 'movies_showtimes'; catAlias = 'movies_categories';
        break;
      default: 
        itemAlias = this.FOOD_ITEMS_INDEX; storeAlias = this.FOOD_STORES_INDEX; catAlias = 'food_categories';
    }

    const itemQuery: any = module === 'movies' ? {
      dis_max: {
        queries: [
          { multi_match: { query: q, type: 'best_fields', fields: ['title.ngram^5','genre.ngram^3','cast.ngram^2'], lenient: true } },
          { multi_match: { query: q, type: 'phrase_prefix', fields: ['title^4', 'genre^2', 'description'], lenient: true } },
        ],
      },
    } : {
      bool: {
        should: [
          // Exact match gets highest priority
          { term: { name: { value: q, boost: 15 } } },
          { term: { slug: { value: q.toLowerCase(), boost: 12 } } },
          
          // Word boundary match (whole word)
          { match: { name: { query: q, operator: 'and', boost: 10 } } },
          
          // Phrase match gets high priority
          { match_phrase: { name: { query: q, boost: 8 } } },
          { match_phrase: { slug: { query: q.toLowerCase(), boost: 6 } } },
          { match_phrase: { category_name: { query: q, boost: 7 } } },
          
          // Partial matches
          { multi_match: { query: q, type: 'best_fields', fields: ['name^4', 'category_name^2'] } },
          // phrase_prefix only on text fields (name, description), not keyword fields (category_name)
          { multi_match: { query: q, type: 'phrase_prefix', fields: ['name^3', 'description'] } },
          
          // Wildcard with lower boost
          { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 0.5 } } },
        ],
        minimum_should_match: 1,
      },
    };
    // Wrap item query to exclude test/demo stores
    const itemQueryWithExclusion: any = {
      bool: {
        must: [itemQuery],
        must_not: this.buildTestStoreExclusion('store_name.keyword'),
      },
    };
    const itemBody: any = {
      query: (module !== 'movies' && hasGeo) ? {
        function_score: {
          query: itemQueryWithExclusion,
          functions: [{ gauss: { store_location: { origin: { lat, lon }, scale: '2km', offset: '0km', decay: 0.5 } }, weight: 2 }],
          score_mode: 'multiply',
          boost_mode: 'sum',
        },
      } : itemQueryWithExclusion,
      size,
      _source: ['id', 'name', 'title', 'slug', 'image', 'images', 'price', 'base_price', 'veg', 'category_id', 'category_name', 'category', 'store_id', 'store_name', 'store_location', 'genre', 'cast', 'module_id', 'description', 'available_time_starts', 'available_time_ends', 'rating_count', 'avg_rating', 'order_count', 'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 'is_halal', 'is_visible', 'organic', 'zone_id', 'unit_id', 'maximum_cart_quantity', 'attributes'],
      script_fields: (module !== 'movies' && hasGeo) ? {
        distance_km: { script: { source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0", params: { lat, lon } } },
      } : undefined,
    };

    const storeQuery: any = {
      bool: {
        should: [
          // Exact match gets highest priority
          { term: { name: { value: q, boost: 10 } } },
          { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
          // Phrase match gets high priority
          { match_phrase: { name: { query: q, boost: 6 } } },
          { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
          // Partial matches
          { multi_match: { query: q, type: 'best_fields', fields: ['name^4', 'slug^2'] } },
          { multi_match: { query: q, type: 'phrase_prefix', fields: ['name^3'] } },
          { prefix: { slug: { value: q.toLowerCase(), boost: 2 } } },
          { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
        ],
        minimum_should_match: 1,
      },
    };
    const storeBody: any = {
      query: {
        bool: {
          must: [storeQuery],
          must_not: this.buildTestStoreExclusion('name.keyword'),
        },
      },
      size,
      sort: hasGeo ? [{ _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km', mode: 'min', distance_type: 'arc', ignore_unmapped: true } }] : [{ order_count: { order: 'desc' } }],
      _source: ['name', 'slug', 'logo', 'cover_photo', 'image', 'images', 'store_location', 'order_count', 'delivery_time', 'rating', 'veg', 'non_veg', 'food_type'],
      script_fields: hasGeo ? { distance_km: { script: { source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0", params: { lat, lon } } } } : undefined,
    };

    const catBody: any = {
      query: {
        bool: {
          should: [
            { match: { name: { query: q, boost: 3 } } },
            { match_phrase_prefix: { name: { query: q, boost: 2 } } },
            { prefix: { slug: q.toLowerCase() } },
            { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
          ],
          minimum_should_match: 1,
        },
      },
      size,
      _source: ['name', 'slug', 'parent_id', 'image'],
    };

    const [itemRes, storeRes, catRes] = await Promise.all([
      this.client.search({ index: itemAlias, body: itemBody }).catch((err) => {
        this.logger.error(`Item search failed for index ${itemAlias}: ${err.message}`, err.stack);
        return { body: { hits: { hits: [] } } } as any;
      }),
      this.client.search({ index: storeAlias, body: storeBody }).catch((err) => {
        this.logger.error(`Store search failed for index ${storeAlias}: ${err.message}`, err.stack);
        return { body: { hits: { hits: [] } } } as any;
      }),
      this.client.search({ index: catAlias, body: catBody }).catch((err) => {
        this.logger.error(`Category search failed for index ${catAlias}: ${err.message}`, err.stack);
        return { body: { hits: { hits: [] } } } as any;
      }),
    ]);

    // Get store names and details for items
    const itemStoreIds = [...new Set((itemRes.body.hits?.hits || []).map((h: any) => h._source?.store_id).filter(Boolean))] as string[];
    const storeNames = await this.getStoreNames(itemStoreIds, module);
    const storeDetails = await this.getStoreDetails(itemStoreIds, module);

    const allItems = (itemRes.body.hits?.hits || []).map((h: any) => {
      const source = h._source || {};
      const distance = h.fields?.distance_km?.[0];
      
      // Calculate distance if location is provided and not already calculated
      let calculatedDistance = distance;
      if (hasGeo && !calculatedDistance && source.store_location?.lat && source.store_location?.lon) {
        calculatedDistance = this.calculateDistance(lat!, lon!, source.store_location.lat, source.store_location.lon);
      }

      // Get store details for delivery time
      const storeId = String(source.store_id);
      const storeDetail = storeDetails[storeId];
      let deliveryTime = storeDetail?.delivery_time || null;
      
      // Recalculate delivery time if distance is available
      if (calculatedDistance && deliveryTime) {
        const travelTimeMinutes = this.calculateTravelTime(calculatedDistance);
        deliveryTime = this.recalculateDeliveryTime(deliveryTime, travelTimeMinutes);
      }

      return { 
        id: h._id, 
        distance_km: calculatedDistance,
        store_name: source.store_id ? storeNames[String(source.store_id)] : null,
        delivery_time: deliveryTime,
        ...source 
      };
    });
    
    const allStores = (storeRes.body.hits?.hits || []).map((h: any) => {
      const source = h._source || {};
      let distance = h.fields?.distance_km?.[0];
      
      // Calculate distance if location is provided and not already calculated
      if (hasGeo && !distance && source.latitude && source.longitude) {
        distance = this.calculateDistance(lat!, lon!, parseFloat(source.latitude), parseFloat(source.longitude));
      }

      // Recalculate delivery time if distance is available
      let deliveryTime = source.delivery_time;
      if (distance && source.delivery_time) {
        const travelTimeMinutes = this.calculateTravelTime(distance);
        deliveryTime = this.recalculateDeliveryTime(source.delivery_time, travelTimeMinutes);
      }

      return { 
        id: h._id, 
        distance_km: distance,
        delivery_time: deliveryTime,
        ...source 
      };
    });
    
    const allCategories = (catRes.body.hits?.hits || []).map((h: any) => ({ id: h._id, ...h._source }));

    // Get distinct items by name (keep first occurrence)
    const seenItemNames = new Set<string>();
    const items = allItems.filter((item: any) => {
      if (seenItemNames.has(item.name)) {
        return false;
      }
      seenItemNames.add(item.name);
      return true;
    });

    // Get distinct stores by name (keep first occurrence)
    const seenStoreNames = new Set<string>();
    const stores = allStores.filter((store: any) => {
      if (seenStoreNames.has(store.name)) {
        return false;
      }
      seenStoreNames.add(store.name);
      return true;
    });

    // Get distinct categories by name (keep first occurrence)
    const seenCategoryNames = new Set<string>();
    const categories = allCategories.filter((category: any) => {
      if (seenCategoryNames.has(category.name)) {
        return false;
      }
      seenCategoryNames.add(category.name);
      return true;
    });

    // Add timing status to stores
    stores.forEach((store: any) => {
      const timingInfo = this.getStoreTimingStatus(store);
      store.timing_status = timingInfo.status;
      store.timing_message = timingInfo.message;
      store.is_open = timingInfo.isOpen;
      if (timingInfo.minutesRemaining !== undefined) {
        store.minutes_until_closing = timingInfo.minutesRemaining;
      }
    });

    return { 
      module, 
      q, 
      items: this.imageService.transformItemsWithImages(items), 
      stores: this.imageService.transformStoresWithImages(stores), 
      categories: this.imageService.transformCategoriesWithImages(categories) 
    };
  }

  // Lightweight natural-language search agent
  async searchAgent(prompt: string, params: Record<string, string>) {
    // Try Admin AI NLU first (optional), then fallback to local rules
    let parsed = undefined as any;
    try {
      const adminNlu = this.config.get<string>('ADMIN_AI_NLU_URL');
      if (adminNlu && prompt && prompt.trim().length) {
        const resp = await fetch(adminNlu, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt, context: { params } }) });
        if (resp.ok) {
          const j = await resp.json();
          parsed = this.normalizeAdminNlu(j, params);
        }
      }
    } catch {}
    if (!parsed) parsed = this.parseAgentPrompt(prompt, params);
  
  let filters: Record<string, string> = {};
    if (parsed.lat != null && parsed.lon != null) {
      filters.lat = String(parsed.lat);
      filters.lon = String(parsed.lon);
      if (parsed.radius_km != null) filters.radius_km = String(parsed.radius_km);
    }
    if (parsed.open_now) filters.open_now = 'true';
    if (parsed.veg) filters.veg = 'true';
    if (parsed.rating_min != null) filters.rating_min = String(parsed.rating_min);
    if (parsed.price_min != null) filters.price_min = String(parsed.price_min);
    if (parsed.price_max != null) filters.price_max = String(parsed.price_max);
    if (parsed.category_id != null) filters.category_id = String(parsed.category_id);
    if (parsed.brand && parsed.brand.length) filters.brand = parsed.brand.join(',');

    // Handle store_name - look up store_id if store_name is provided
    if (parsed.store_name && !parsed.store_id) {
      try {
        const storeAlias = parsed.module === 'food' ? 'food_stores' : parsed.module === 'ecom' ? 'ecom_stores' : 'food_stores';
        const storeSearchRes = await this.client.search({
          index: storeAlias,
          body: {
            query: {
              bool: {
                should: [
                  { match_phrase: { name: { query: parsed.store_name, boost: 5 } } },
                  { match: { name: { query: parsed.store_name, boost: 3, fuzziness: 'AUTO' } } },
                  { wildcard: { name: { value: `*${parsed.store_name.toLowerCase()}*` } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 1,
            _source: ['id', 'name'],
          },
        });

        if (storeSearchRes.body.hits?.hits?.length > 0) {
          const foundStore = storeSearchRes.body.hits.hits[0];
          parsed.store_id = String(foundStore._source.id || foundStore._id);
          parsed.store_name_found = foundStore._source.name;
          this.logger.log(`Agent: Resolved store "${parsed.store_name}" to ID ${parsed.store_id} (${parsed.store_name_found})`);
        } else {
          this.logger.warn(`Agent: Could not find store matching "${parsed.store_name}"`);
        }
      } catch (error: any) {
        this.logger.error(`Agent: Error looking up store: ${error.message}`);
      }
    }

    // Add store_id filter if found
    if (parsed.store_id) {
      filters.store_id = String(parsed.store_id);
    }

    const q = parsed.q || '';
    if (parsed.target === 'stores') {
      const res = await this.searchStores(parsed.module, q, filters);
      return { plan: parsed, result: res };
    } else {
      // Items search with progressive relaxation if nothing found
      let res = await this.search(parsed.module, q, filters);
      const relaxed: string[] = [];
      if ((res?.meta?.total ?? 0) === 0) {
        // 1) Drop open_now
        if (filters.open_now) {
          const { open_now, ...rest } = filters;
          const r1 = await this.search(parsed.module, q, rest);
          if ((r1?.meta?.total ?? 0) > 0) { res = r1; relaxed.push('open_now'); }
          else { filters = rest; relaxed.push('open_now'); res = r1; }
        }
      }
      if ((res?.meta?.total ?? 0) === 0) {
        // 2) Drop veg
        if (filters.veg) {
          const { veg, ...rest } = filters;
          const r2 = await this.search(parsed.module, q, rest);
          if ((r2?.meta?.total ?? 0) > 0) { res = r2; relaxed.push('veg'); }
          else { filters = rest; relaxed.push('veg'); res = r2; }
        }
      }
      if ((res?.meta?.total ?? 0) === 0) {
        // 3) Drop rating/price constraints (but NOT store_id - keep store context)
        const { rating_min, price_min, price_max, ...rest } = filters as any;
        if (rating_min || price_min || price_max) {
          const r3 = await this.search(parsed.module, q, rest);
          if ((r3?.meta?.total ?? 0) > 0) { res = r3; if (rating_min) relaxed.push('rating_min'); if (price_min) relaxed.push('price_min'); if (price_max) relaxed.push('price_max'); }
          else { filters = rest; if (rating_min) relaxed.push('rating_min'); if (price_min) relaxed.push('price_min'); if (price_max) relaxed.push('price_max'); res = r3; }
        }
      }
      if (relaxed.length) (parsed as any).relaxed = relaxed;
      return { plan: parsed, result: res };
    }
  }

  private normalizeAdminNlu(nlu: any, params: Record<string, string>) {
    const text = String(nlu?.text || '').trim();
    const module = (['food','ecom','rooms','services','movies'] as const).includes(nlu?.module) ? nlu.module : 'food';
    const target = (nlu?.target === 'stores') ? 'stores' : 'items';
    const ent = nlu?.entities || {};
    const lat = params?.lat ? Number(params.lat) : undefined;
    const lon = params?.lon ? Number(params.lon) : undefined;
    const radius_km = params?.radius_km ? Number(params.radius_km) : (ent.radius_km ?? undefined);
    const plan = {
      module,
      target,
      q: text || String(nlu?.query || ''),
      lat,
      lon,
      radius_km,
      open_now: !!(ent.open_now ?? nlu?.open_now),
      veg: !!(ent.veg ?? nlu?.veg),
      rating_min: ent.rating_min != null ? Number(ent.rating_min) : undefined,
      price_min: ent.price_min != null ? Number(ent.price_min) : undefined,
      price_max: ent.price_max != null ? Number(ent.price_max) : undefined,
      brand: Array.isArray(ent.brand) ? ent.brand.map(String) : (ent.brand ? [String(ent.brand)] : []),
      category_id: ent.category_id != null ? Number(ent.category_id) : undefined,
    };
    return plan;
  }

  private parseAgentPrompt(prompt: string, params: Record<string, string>) {
    const text = (prompt || '').trim();
    const lc = text.toLowerCase();
    // Module detection
    let module: 'food' | 'ecom' | 'rooms' | 'services' | 'movies' = 'food';
    if (/\b(room|rooms|stay|hotel|accommodation|booking|check\s*in|check\s*out)\b/.test(lc)) module = 'rooms';
    if (/\b(service|services|spa|massage|cleaning|repair|appointment)\b/.test(lc)) module = 'services';
    if (/\b(movie|movies|cinema|film|theatre|theater|showtime|showtimes)\b/.test(lc)) module = 'movies';
    if (/\b(shop|store|grocery|mart|electronics|fashion|milk|chocolate|detergent|snack|snacks)\b/.test(lc)) module = 'ecom';
    if (/\b(food|restaurant|meal|biryani|pizza|paneer|thali|dosa|burger)\b/.test(lc)) module = 'food';

    // Target: items or stores
  let target: 'items' | 'stores' = 'items';
    if (/\b(restaurant|restaurants|places|shops|stores|nearby stores|nearby restaurants|hotels|service providers)\b/.test(lc)) target = 'stores';
  if (module === 'movies' && /\b(showtime|showtimes|theatre|theater|cinema)\b/.test(lc)) target = 'stores';

    // Store name extraction - detect patterns like "go to X", "at X", "from X"
    let store_name: string | undefined;
    let store_id: string | undefined;
    const storePatterns = [
      /(?:go to|visit|from|at)\s+([a-z0-9\s]+?)(?:\s+and\s+|\s+to\s+|$)/i,
      /(?:in|inside)\s+([a-z0-9\s]+?)(?:\s+and\s+|\s+to\s+|$)/i,
    ];
    
    for (const pattern of storePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const potentialStoreName = match[1].trim();
        // Filter out common stop words that might be captured
        if (potentialStoreName && 
            !/^(order|search|find|show|get|menu|items|store|restaurant|shop)$/i.test(potentialStoreName) &&
            potentialStoreName.length > 2) {
          store_name = potentialStoreName;
          break;
        }
      }
    }

    // Geo
    const lat = params?.lat ? Number(params.lat) : undefined;
    const lon = params?.lon ? Number(params.lon) : undefined;
    let radius_km: number | undefined;
    if (/\bnear\s*me|nearby|closest|around\b/.test(lc)) {
      radius_km = Number(params?.radius_km ?? 5) || 5;
    }

    // Common filters
    const open_now = /\b(open now|currently open|open)\b/.test(lc) && module === 'food';
    const veg = /\b(veg|vegetarian|only veg|pure veg)\b/.test(lc);

    // Rating
    let rating_min: number | undefined;
    const mRating = lc.match(/(\d(?:\.\d)?)\+\s*stars?|rating\s*(?:above|over|>=?)\s*(\d(?:\.\d)?)/);
    if (mRating) rating_min = Number(mRating[1] || mRating[2]);
    if (/\b(4\+|4.0\+|four star)\b/.test(lc)) rating_min = rating_min ?? 4;

    // Price
    let price_min: number | undefined;
    let price_max: number | undefined;
    const mUnder = lc.match(/\b(under|below|less than)\s*(\d{2,5})\b/);
    if (mUnder) price_max = Number(mUnder[2]);
    const mBetween = lc.match(/\b(between|from)\s*(\d{2,5})\s*(?:to|and|-)\s*(\d{2,5})\b/);
    if (mBetween) { price_min = Number(mBetween[2]); price_max = Number(mBetween[3]); }
    const mAbove = lc.match(/\b(above|over|greater than)\s*(\d{2,5})\b/);
    if (mAbove) price_min = Number(mAbove[2]);

    // Brand (simple dictionary; can be expanded or driven by Admin AI later)
    const brandDict = ['amul','nestle','dabur','colgate','britannia','cadbury','pepsico','parle','maggie','tata','fortune','aashirvaad','surfexcel','tide','sensodyne','himalaya'];
    const brand = brandDict.filter(b => new RegExp(`\\b${b}\\b`, 'i').test(text));

    // Extract free-text query by removing known cues and store name patterns
    let q = text
      .replace(/\b(open now|near\s*me|nearby|closest|around|veg|vegetarian)\b/gi,'')
      .replace(/\b(under|below|less than|above|over|greater than|between|from|to|and)\b\s*\d{1,6}(?:\s*(?:to|and|-)\s*\d{1,6})?/gi,'')
      .replace(/(?:go to|visit|from|at|in|inside)\s+[a-z0-9\s]+?(?:\s+and\s+)/gi, ' and ')
      .replace(/\b(order|search|find|show|get)\b/gi, '')
      .trim();

    // Synonyms expansion (lightweight): apply to query string
    const synonyms: Array<[RegExp, string]> = [
      [/\bdahi\b/gi, 'curd'],
      [/\bcurd\b/gi, 'dahi'],
      [/\bchips\b/gi, 'namkeen'],
      [/\bcookies\b/gi, 'biscuits'],
      [/\bsoft drink\b/gi, 'cold drink'],
      [/\btooth paste\b/gi, 'toothpaste'],
    ];
    let qExpanded = q;
    for (const [pattern, repl] of synonyms) {
      qExpanded = qExpanded.replace(pattern, m => `${m} ${repl}`);
    }

    // Heuristic defaults
  if (!qExpanded && module === 'food' && target === 'items') qExpanded = 'food';
  if (!qExpanded && module === 'ecom' && target === 'items') qExpanded = brand[0] || '';
  if (!qExpanded && module === 'movies') qExpanded = 'movies';

  return { 
      module, 
      target, 
      q: qExpanded, 
      lat, 
      lon, 
      radius_km, 
      open_now, 
      veg, 
      rating_min, 
      price_min, 
      price_max, 
      brand,
      store_name,
      store_id,
    } as {
      module: 'food'|'ecom'|'rooms'|'services'|'movies', target: 'items'|'stores', q: string,
      lat?: number, lon?: number, radius_km?: number,
      open_now?: boolean, veg?: boolean, rating_min?: number, price_min?: number, price_max?: number,
      brand?: string[];
      category_id?: number;
      store_name?: string;
      store_id?: string;
    };
  }

  // ASR proxy to Admin AI
  async asrTranscribe(buffer: Buffer, mime: string): Promise<string> {
    const asrUrl = this.config.get<string>('ADMIN_AI_ASR_URL');
    if (!asrUrl) return '';
    try {
      const form = new FormData();
      const filename = `audio.${(mime || '').split('/')[1] || 'wav'}`;
      // @ts-ignore Node18+: Blob/FormData available via undici
      form.append('file', new Blob([buffer]), filename);

      // 20s timeout to avoid hanging requests
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20_000);
      try {
        const resp = await fetch(asrUrl, { method: 'POST', body: form as any, signal: controller.signal } as any);
        if (!resp.ok) return '';
        const j = await resp.json().catch(()=>({} as any));
        return String(j.text || j.transcript || '');
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      // Swallow upstream errors to avoid 500s; caller will return { text: '' }
      // eslint-disable-next-line no-console
      console.warn('ASR upstream failed:', (err as any)?.message || err);
      return '';
    }
  }

  /**
   * Get all item indices that may contain data
   * Returns list of all item indices to search
   */
  private getAllItemIndices(): string[] {
    return [this.FOOD_ITEMS_INDEX, this.ECOM_ITEMS_INDEX, 'rooms_index', 'services_index', 'movies_catalog'];
  }

  /**
   * Get all store indices that may contain data
   */
  private getAllStoreIndices(): string[] {
    return [this.FOOD_STORES_INDEX, this.ECOM_STORES_INDEX, 'rooms_stores', 'services_stores', 'movies_showtimes'];
  }

  /**
   * Find the best matching store for a given free-text query.
   * Returns top store_id (numeric) with its score if found, else null.
   */
  private async findTopStoreMatch(query: string, filters: Record<string, any>): Promise<{ storeId: number | null; storeName?: string; score?: number }> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return { storeId: null };
    }

    const storeIndices = this.getAllStoreIndices();
    const lat = filters?.lat;
    const lon = filters?.lon;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    const hasGeo = lat !== undefined && lon !== undefined && !Number.isNaN(lat) && !Number.isNaN(lon);

    const storeBody: any = {
      query: {
        bool: {
          should: [
            // Exact matches (highest priority)
            { term: { 'name.keyword': { value: trimmed, boost: 20, case_insensitive: true } } },
            { term: { 'slug.keyword': { value: trimmed.toLowerCase(), boost: 18 } } },
            // Very close matches
            { match: { name: { query: trimmed, boost: 15, operator: 'and' } } },
            { match: { slug: { query: trimmed.toLowerCase(), boost: 12, operator: 'and' } } },
            { match_phrase: { name: { query: trimmed, boost: 10, slop: 0 } } },
            { match_phrase: { slug: { query: trimmed.toLowerCase(), boost: 8, slop: 0 } } },
            // Partial word matches for single-word queries
            { prefix: { name: { value: trimmed.toLowerCase(), boost: 7 } } },
            { prefix: { slug: { value: trimmed.toLowerCase(), boost: 6 } } },
            // Fuzzy matches
            { multi_match: {
              query: trimmed,
              fields: ['name^5', 'slug^3', 'address^1'],
              type: 'best_fields',
              operator: 'or',
              fuzziness: 'AUTO',
            }},
            { wildcard: { name: { value: `*${trimmed.toLowerCase()}*`, boost: 3 } } },
            { wildcard: { slug: { value: `*${trimmed.toLowerCase()}*`, boost: 2 } } },
          ],
          minimum_should_match: 1,
        },
      },
      size: 5,
      _source: ['id', 'name'],
    };

    // Always filter for active stores only
    storeBody.query.bool.filter = [
      { term: { status: true } },
      { term: { active: true } },
    ];

    if (filters?.module_id) {
      storeBody.query.bool.filter.push({ term: { module_id: Number(filters.module_id) } });
    }

    if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm)) {
      storeBody.query.bool.filter.push({
        geo_distance: {
          distance: `${radiusKm}km`,
          location: { lat, lon },
        },
      });
    }

    try {
      const storeResults = await Promise.all(
        storeIndices.map(index =>
          this.client.search({ index, body: storeBody }).catch(() => ({ body: { hits: { hits: [] } } }))
        )
      );

      let best: { storeId: number | null; storeName?: string; score?: number } = { storeId: null };
      for (const res of storeResults) {
        for (const hit of res.body.hits?.hits || []) {
          const id = hit._source?.id ?? hit._id;
          const numericId = id !== undefined ? Number(id) : NaN;
          if (!Number.isNaN(numericId)) {
            if (!best.score || (hit._score || 0) > (best.score || 0)) {
              best = {
                storeId: numericId,
                storeName: hit._source?.name,
                score: hit._score,
              };
            }
          }
        }
      }
      return best;
    } catch (error: any) {
      this.logger.warn(`[findTopStoreMatch] Failed to search stores: ${error?.message || String(error)}`);
      return { storeId: null };
    }
  }

  /**
   * Get all category indices that may contain data
   */
  private getAllCategoryIndices(): string[] {
    return ['food_categories', 'ecom_categories', 'rooms_categories', 'services_categories', 'movies_categories'];
  }

  /**
   * NEW: Suggest API with module_id/store_id/category_id support
   * Returns items, stores, and categories with intent-based prioritization
   */
  async suggestByModule(
    q: string,
    filters: {
      module_id?: number;
      store_id?: number;
      category_id?: number;
      lat?: number;
      lon?: number;
      size?: number;
    }
  ) {
    // Validate category belongs to module if both provided
    if (filters?.category_id && filters?.module_id) {
      const isValid = await this.moduleService.validateCategoryModule(Number(filters.category_id), filters.module_id);
      if (!isValid) {
        throw new BadRequestException(
          `Category ${filters.category_id} does not exist in module ${filters.module_id}`
        );
      }
    }

    const minLen = 2;
    if (!q || q.trim().length < minLen) {
      return { q, intent: 'generic', items: [], stores: [], categories: [] };
    }

    // Parse query intent using query parser
    const parsed = this.queryParser.parse(q);
    this.logger.debug(`[suggestByModule] Query: \"${q}\" | Intent: ${parsed.intent}`);
    
    const size = Math.max(1, Math.min(Number(filters?.size ?? 5) || 5, 50));
    const lat = filters?.lat;
    const lon = filters?.lon;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    // Build filter clauses
    const filterClauses: any[] = [];
    
    if (filters?.module_id) {
      filterClauses.push({ term: { module_id: Number(filters.module_id) } });
    }
    
    if (filters?.store_id) {
      filterClauses.push({ term: { store_id: Number(filters.store_id) } });
    }
    
    if (filters?.category_id) {
      filterClauses.push({ term: { category_id: Number(filters.category_id) } });
    }

    // Generate embedding for semantic search enhancement
    let embedding: number[] | null = null;
    try {
      const modelType = filters?.module_id === 4 ? 'food' : 'general';
      embedding = await this.embeddingService.generateEmbedding(q, modelType);
      if (embedding) {
        this.logger.debug(`✅ Generated embedding for suggestion: "${q}"`);
      }
    } catch (error) {
      this.logger.warn(`Failed to generate embedding for suggestion: ${(error as Error).message}`);
    }

    // Items query - prefer keyword for suggestions, use embedding for fallback/typos
    const itemQuery: any = {
      bool: {
        should: [
          // Keyword queries (high priority for exact/prefix matches)
          { term: { name: { value: q, boost: 10 } } },
          { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
          { match_phrase: { name: { query: q, boost: 6 } } },
          { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
          { multi_match: { query: q, type: 'best_fields', fields: ['name^4', 'category_name^2', 'description'] } },
          { multi_match: { query: q, type: 'phrase_prefix', fields: ['name^3', 'description'] } },
          { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
        ],
        minimum_should_match: 1,
      },
    };

    // When embedding available, add KNN as extra context (helps with typos and synonyms)
    // Add popularity and rating boosting functions for better ranking
    const rankingFunctions = [
      // Boost by order count (log scale to avoid extreme values)
      { 
        field_value_factor: { 
          field: 'order_count', 
          modifier: 'log1p', 
          factor: 0.5, 
          missing: 0 
        } 
      },
      // Boost by average rating
      { 
        field_value_factor: { 
          field: 'avg_rating', 
          modifier: 'sqrt', 
          factor: 1.5, 
          missing: 0 
        } 
      },
      // Boost recommended items
      {
        filter: { term: { recommended: 1 } },
        weight: 1.3
      }
    ];

    const testStoreExclusion = this.buildTestStoreExclusion('store_name.keyword');
    const itemBody: any = embedding ? {
      query: hasGeo ? {
        function_score: {
          query: {
            bool: {
              should: [
                { knn: { item_vector: { vector: embedding, k: size * 5 } } }, // KNN for semantic similarity
                itemQuery // Keyword queries
              ],
              minimum_should_match: 1,
              filter: filterClauses,
              must_not: testStoreExclusion,
            },
          },
          functions: [
            ...rankingFunctions,
            { gauss: { store_location: { origin: { lat, lon }, scale: '2km', offset: '0km', decay: 0.5 } }, weight: 2 }
          ],
          score_mode: 'sum',
          boost_mode: 'multiply',
        },
      } : {
        function_score: {
          query: {
            bool: {
              should: [
                { knn: { item_vector: { vector: embedding, k: size * 5 } } }, // KNN for semantic similarity
                itemQuery // Keyword queries
              ],
              minimum_should_match: 1,
              filter: filterClauses,
              must_not: testStoreExclusion,
            },
          },
          functions: rankingFunctions,
          score_mode: 'sum',
          boost_mode: 'multiply',
        },
      },
      size: size * 3,
      _source: ['id', 'name', 'slug', 'image', 'images', 'price', 'base_price', 'veg', 'category_id', 'category_name', 'store_id', 'store_name', 'store_location', 'module_id', 'description', 'available_time_starts', 'available_time_ends', 'rating_count', 'avg_rating', 'order_count', 'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 'is_halal', 'is_visible', 'organic', 'zone_id', 'unit_id', 'maximum_cart_quantity', 'attributes'],
      script_fields: hasGeo ? {
        distance_km: { script: { source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0", params: { lat, lon } } },
      } : undefined,
    } : {
      query: hasGeo ? {
        function_score: {
          query: {
            bool: {
              must: [itemQuery],
              filter: filterClauses,
              must_not: testStoreExclusion,
            },
          },
          functions: [
            ...rankingFunctions,
            { gauss: { store_location: { origin: { lat, lon }, scale: '2km', offset: '0km', decay: 0.5 } }, weight: 2 }
          ],
          score_mode: 'sum',
          boost_mode: 'multiply',
        },
      } : {
        function_score: {
          query: {
            bool: {
              must: [itemQuery],
              filter: filterClauses,
              must_not: testStoreExclusion,
            },
          },
          functions: rankingFunctions,
          score_mode: 'sum',
          boost_mode: 'multiply',
        },
      },
      size: size * 3, // Fetch more items (3x requested) to ensure variety across multiple stores
      _source: ['id', 'name', 'slug', 'image', 'images', 'price', 'base_price', 'veg', 'category_id', 'category_name', 'store_id', 'store_name', 'store_location', 'module_id', 'description', 'available_time_starts', 'available_time_ends', 'rating_count', 'avg_rating', 'order_count', 'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 'is_halal', 'is_visible', 'organic', 'zone_id', 'unit_id', 'maximum_cart_quantity', 'attributes'],
      script_fields: hasGeo ? {
        distance_km: { script: { source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0", params: { lat, lon } } },
      } : undefined,
    };

    // Stores query
    const storeQuery: any = {
      bool: {
        should: [
          { term: { name: { value: q, boost: 10 } } },
          { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
          { match_phrase: { name: { query: q, boost: 6 } } },
          { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
          { multi_match: { query: q, type: 'best_fields', fields: ['name^4', 'slug^2', 'address'] } },
          { multi_match: { query: q, type: 'phrase_prefix', fields: ['name^3'] } },
          { prefix: { slug: { value: q.toLowerCase(), boost: 2 } } },
          { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
        ],
        minimum_should_match: 1,
      },
    };

    const storeFilterClauses: any[] = [];
    if (filters?.module_id) {
      storeFilterClauses.push({ term: { module_id: Number(filters.module_id) } });
    }

    const storeBody: any = {
      query: {
        bool: {
          must: [storeQuery],
          filter: storeFilterClauses,
          must_not: this.buildTestStoreExclusion('name.keyword'),
        },
      },
      size: size * 2, // Fetch more stores to ensure we have enough after distance calculation and sorting
      sort: [{ order_count: { order: 'desc' } }], // Always use popularity sort, we'll sort by distance manually
      _source: ['name', 'slug', 'logo', 'cover_photo', 'image', 'images', 'location', 'latitude', 'longitude', 'order_count', 'delivery_time', 'rating', 'module_id', 'veg', 'non_veg', 'food_type'],
      script_fields: undefined, // Don't use script_fields, calculate distance manually
    };

    // Categories query
    const catFilterClauses: any[] = [];
    if (filters?.module_id) {
      catFilterClauses.push({ term: { module_id: Number(filters.module_id) } });
    }

    const catBody: any = {
      query: {
        bool: {
          must: [{
            bool: {
              should: [
                { match: { name: { query: q, boost: 3 } } },
                { match_phrase_prefix: { name: { query: q, boost: 2 } } },
                { prefix: { slug: q.toLowerCase() } },
                { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
              ],
              minimum_should_match: 1,
            },
          }],
          filter: catFilterClauses,
        },
      },
      size,
      _source: ['name', 'slug', 'parent_id', 'module_id', 'image'],
    };

    // Execute parallel searches
    const itemIndices = this.getAllItemIndices();
    const storeIndices = this.getAllStoreIndices();
    const catIndices = this.getAllCategoryIndices();

    const [itemResults, storeResults, catResults] = await Promise.all([
      Promise.all(itemIndices.map(index => 
        this.client.search({ index, body: itemBody }).catch(() => ({ body: { hits: { hits: [] } } }))
      )),
      Promise.all(storeIndices.map(index => 
        this.client.search({ index, body: storeBody }).catch(() => ({ body: { hits: { hits: [] } } }))
      )),
      Promise.all(catIndices.map(index => 
        this.client.search({ index, body: catBody }).catch(() => ({ body: { hits: { hits: [] } } }))
      )),
    ]);

    // Combine all item results
    const allItems: any[] = [];
    itemResults.forEach(res => {
      const hits = res.body.hits?.hits || [];
      hits.forEach((h: any) => {
        const source = h._source || {};
        let distance = h.fields?.distance_km?.[0];
        
        // Calculate distance manually if lat/lon are provided and distance not already calculated
        if (hasGeo && !distance && source.store_location) {
          let storeLat: number | undefined;
          let storeLon: number | undefined;
          
          if (source.store_location?.lat && source.store_location?.lon) {
            storeLat = parseFloat(String(source.store_location.lat));
            storeLon = parseFloat(String(source.store_location.lon));
          } else if (Array.isArray(source.store_location) && source.store_location.length === 2) {
            // GeoJSON format: [lon, lat]
            storeLon = parseFloat(String(source.store_location[0]));
            storeLat = parseFloat(String(source.store_location[1]));
          }
          
          if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
            distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
          }
        }
        
        allItems.push({
          id: h._id,
          distance_km: distance,
          ...source,
        });
      });
    });

    // Combine all store results
    const allStores: any[] = [];
    storeResults.forEach(res => {
      const hits = res.body.hits?.hits || [];
      hits.forEach((h: any) => {
        const source = h._source || {};
        let distance = h.fields?.distance_km?.[0];
        
        // Calculate distance manually if lat/lon are provided and distance not already calculated
        if (hasGeo && !distance) {
          let storeLat: number | undefined;
          let storeLon: number | undefined;
          
          // Try different location field formats
          if (source.latitude && source.longitude) {
            storeLat = parseFloat(String(source.latitude));
            storeLon = parseFloat(String(source.longitude));
          } else if (source.location?.lat && source.location?.lon) {
            storeLat = parseFloat(String(source.location.lat));
            storeLon = parseFloat(String(source.location.lon));
          } else if (Array.isArray(source.location) && source.location.length === 2) {
            // GeoJSON format: [lon, lat]
            storeLon = parseFloat(String(source.location[0]));
            storeLat = parseFloat(String(source.location[1]));
          }
          
          if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
            distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
          }
        }
        
        // Build store object with explicit logo field handling
        // Note: In OpenSearch, logo is stored as 'image' field (from sync script: s.logo as image)
        const storeObj: any = {
          id: h._id,
          distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? Infinity : undefined),
          ...source,
        };
        
        // Map image field to logo (since sync script stores logo as image in OpenSearch)
        // Priority: logo field (if exists) > image field > null
        if (storeObj.logo === undefined || storeObj.logo === null) {
          storeObj.logo = storeObj.image || null;
        }
        // Ensure logo field always exists (even if null)
        if (storeObj.logo === undefined) {
          storeObj.logo = null;
        }
        
        allStores.push(storeObj);
      });
    });

    // Combine all category results
    const allCategories: any[] = [];
    catResults.forEach(res => {
      const hits = res.body.hits?.hits || [];
      hits.forEach((h: any) => {
        allCategories.push({
          id: h._id,
          ...h._source,
        });
      });
    });

    // Deduplicate by name (but keep items from different stores)
    const seenItemKeys = new Set<string>();
    let items = allItems.filter((item: any) => {
      // Create unique key: name + store_id to allow same dish from different stores
      const key = `${item.name?.toLowerCase()}_${item.store_id}`;
      if (seenItemKeys.has(key)) return false;
      seenItemKeys.add(key);
      return true;
    });
    
    // Sort items by distance if lat/lon are provided
    if (hasGeo) {
      items.sort((a, b) => {
        const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
        const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
        if (distA !== distB) {
          return distA - distB;
        }
        // If distances are equal, sort by popularity
        return (b.order_count || 0) - (a.order_count || 0);
      });
    } else {
      // Sort by popularity when no geo
      items.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
    }
    
    // Keep up to size * 3 items for now, we'll apply intent-based limits later
    items = items.slice(0, size * 3);

    const seenStoreNames = new Set<string>();
    let stores = allStores.filter((store: any) => {
      if (seenStoreNames.has(store.name)) return false;
      seenStoreNames.add(store.name);
      return true;
    });
    
    // Sort stores by distance if lat/lon are provided
    if (hasGeo) {
      stores.sort((a, b) => {
        const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
        const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
        if (distA !== distB) {
          return distA - distB;
        }
        // If distances are equal, sort by popularity
        return (b.order_count || 0) - (a.order_count || 0);
      });
    } else {
      // Sort by popularity when no geo
      stores.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
    }
    
    // Keep more stores for now, we'll apply intent-based limits later
    stores = stores.slice(0, size * 3);

    const seenCategoryNames = new Set<string>();
    let categories = allCategories.filter((category: any) => {
      if (seenCategoryNames.has(category.name)) return false;
      seenCategoryNames.add(category.name);
      return true;
    }).slice(0, size);

    // ============================================
    // INTENT-BASED PRIORITIZATION
    // ============================================
    // Adjust result sizes based on detected intent
    let itemsLimit = size;
    let storesLimit = size;
    let categoriesLimit = size;

    if (parsed.intent === 'store_first') {
      // User likely looking for a store/restaurant
      this.logger.debug(`[suggestByModule] Store intent detected - prioritizing stores`);
      storesLimit = Math.min(size * 2, 10); // Show more stores
      itemsLimit = Math.max(Math.floor(size * 0.6), 3); // Fewer items
      categoriesLimit = Math.max(Math.floor(size * 0.4), 2); // Fewer categories
    } else if (parsed.intent === 'specific_item_specific_store') {
      // User looking for specific item from specific store
      this.logger.debug(`[suggestByModule] Specific item+store intent detected`);
      itemsLimit = size;
      storesLimit = Math.max(Math.floor(size * 0.5), 2);
      categoriesLimit = 0; // Don't show categories for specific queries
    } else {
      // Generic search - balanced results
      this.logger.debug(`[suggestByModule] Generic intent - balanced results`);
    }

    // Apply intent-based limits
    items = items.slice(0, itemsLimit);
    stores = stores.slice(0, storesLimit);
    categories = categories.slice(0, categoriesLimit);

    // ============================================
    // FALLBACK LOGIC: Cross-entity search
    // ============================================
    // If any entity type is empty, search related entities and find connections
    
    // 1. If stores are empty, find stores via items and categories
    if (stores.length === 0 && (items.length > 0 || categories.length > 0)) {
      this.logger.debug(`[suggestByModule] Stores empty, searching via items/categories`);
      const storeIdsFromItems = new Set<string>();
      const storeIdsFromCategories = new Set<string>();
      
      // Get store IDs from items
      if (items.length > 0) {
        items.forEach((item: any) => {
          if (item.store_id) {
            storeIdsFromItems.add(String(item.store_id));
          }
        });
        this.logger.debug(`[suggestByModule] Found ${storeIdsFromItems.size} unique store IDs from items: ${Array.from(storeIdsFromItems).slice(0, 10).join(', ')}`);
      }
      
      // Get store IDs from categories (via items in those categories)
      if (categories.length > 0) {
        const categoryIds = categories.map((cat: any) => String(cat.id));
        try {
          const categoryItemsBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { category_id: categoryIds } },
                  { term: { status: 1 } }
                ]
              }
            },
            size: 100,
            _source: ['store_id'],
          };
          
          if (filters?.module_id) {
            categoryItemsBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
          }
          
          const categoryItemsResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: categoryItemsBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          categoryItemsResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._source?.store_id) {
                storeIdsFromCategories.add(String(hit._source.store_id));
              }
            });
          });
        } catch (error: any) {
          this.logger.warn(`[suggestByModule] Failed to find stores via categories: ${error?.message || String(error)}`);
        }
      }
      
      // Combine store IDs and fetch stores
      const allStoreIds = [...new Set([...storeIdsFromItems, ...storeIdsFromCategories])];
      this.logger.debug(`[suggestByModule] Searching for ${allStoreIds.length} stores in ${storeIndices.length} indices: ${storeIndices.join(', ')}`);
      if (allStoreIds.length > 0) {
        try {
          // For fallback, don't filter by module_id since items already have the correct module_id
          // The stores serving those items should be the correct ones
          const fallbackStoreFilterClauses: any[] = [];
          // Only add module_id filter if explicitly provided and we want to be strict
          // But for fallback, we'll trust that stores serving items with module_id are correct
          
          const fallbackStoreBody: any = {
            query: {
              bool: {
                must: [{ terms: { id: allStoreIds } }],
                filter: fallbackStoreFilterClauses.length > 0 ? fallbackStoreFilterClauses : undefined,
              },
            },
            size: size * 2,
            sort: [{ order_count: { order: 'desc' } }],
            _source: ['name', 'slug', 'logo', 'cover_photo', 'image', 'images', 'location', 'latitude', 'longitude', 'order_count', 'delivery_time', 'rating', 'module_id', 'veg', 'non_veg', 'food_type'],
          };
          
          this.logger.debug(`[suggestByModule] Fallback store query: ${JSON.stringify(fallbackStoreBody.query).substring(0, 200)}`);
          
          const fallbackStoreResults = await Promise.all(
            storeIndices.map(async (index) => {
              try {
                const result = await this.client.search({ index, body: fallbackStoreBody });
                this.logger.debug(`[suggestByModule] Index ${index}: found ${result.body.hits?.total?.value || 0} stores`);
                return result;
              } catch (err: any) {
                this.logger.warn(`[suggestByModule] Search failed on index ${index}: ${err?.message || String(err)}`);
                return { body: { hits: { hits: [] } } };
              }
            })
          );
          
          const fallbackStores: any[] = [];
          fallbackStoreResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            hits.forEach((h: any) => {
              const source = h._source || {};
              let distance: number | undefined;
              
              if (hasGeo) {
                let storeLat: number | undefined;
                let storeLon: number | undefined;
                
                if (source.latitude && source.longitude) {
                  storeLat = parseFloat(String(source.latitude));
                  storeLon = parseFloat(String(source.longitude));
                } else if (source.location?.lat && source.location?.lon) {
                  storeLat = parseFloat(String(source.location.lat));
                  storeLon = parseFloat(String(source.location.lon));
                } else if (Array.isArray(source.location) && source.location.length === 2) {
                  storeLon = parseFloat(String(source.location[0]));
                  storeLat = parseFloat(String(source.location[1]));
                }
                
                if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
                  distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
                }
              }
              
              const storeObj: any = {
                id: h._id,
                distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? Infinity : undefined),
                ...source,
              };
              
              if (storeObj.logo === undefined || storeObj.logo === null) {
                storeObj.logo = storeObj.image || null;
              }
              
              fallbackStores.push(storeObj);
            });
          });
          
          // Deduplicate fallback stores
          // Note: For fallback stores, we trust the item-store relationship
          // If items have store_id, those stores are valid regardless of store's module_id
          const seenFallbackStoreNames = new Set<string>();
          this.logger.debug(`[suggestByModule] Found ${fallbackStores.length} fallback stores before deduplication`);
          stores = fallbackStores.filter((store: any) => {
            if (seenFallbackStoreNames.has(store.name)) return false;
            seenFallbackStoreNames.add(store.name);
            return true;
          });
          this.logger.debug(`[suggestByModule] After deduplication: ${stores.length} stores`);
          
          if (hasGeo) {
            stores.sort((a, b) => {
              const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
              const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
              if (distA !== distB) return distA - distB;
              return (b.order_count || 0) - (a.order_count || 0);
            });
          } else {
            stores.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
          }
          
          stores = stores.slice(0, size);
          this.logger.debug(`[suggestByModule] Found ${stores.length} stores via items/categories fallback`);
        } catch (error: any) {
          this.logger.warn(`[suggestByModule] Failed to fetch fallback stores: ${error?.message || String(error)}`);
        }
      }
    }
    
    // 2. If categories are empty, find categories via items and stores
    if (categories.length === 0 && (items.length > 0 || stores.length > 0)) {
      this.logger.debug(`[suggestByModule] Categories empty, searching via items/stores`);
      const categoryIdsFromItems = new Set<string>();
      const categoryIdsFromStores = new Set<string>();
      
      // Get category IDs from items
      if (items.length > 0) {
        items.forEach((item: any) => {
          if (item.category_id) {
            categoryIdsFromItems.add(String(item.category_id));
          }
        });
      }
      
      // Get category IDs from stores (via items in those stores)
      if (stores.length > 0) {
        const storeIds = stores.map((store: any) => String(store.id));
        try {
          const storeItemsBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { store_id: storeIds } },
                  { term: { status: 1 } }
                ]
              }
            },
            size: 100,
            _source: ['category_id'],
          };
          
          if (filters?.module_id) {
            storeItemsBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
          }
          
          const storeItemsResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: storeItemsBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          storeItemsResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._source?.category_id) {
                categoryIdsFromStores.add(String(hit._source.category_id));
              }
            });
          });
        } catch (error: any) {
          this.logger.warn(`[suggestByModule] Failed to find categories via stores: ${error?.message || String(error)}`);
        }
      }
      
      // Combine category IDs and fetch categories
      const allCategoryIds = [...new Set([...categoryIdsFromItems, ...categoryIdsFromStores])];
      if (allCategoryIds.length > 0) {
        try {
          const fallbackCatBody: any = {
            query: {
              bool: {
                must: [{ terms: { id: allCategoryIds } }],
                filter: catFilterClauses,
              },
            },
            size,
            _source: ['name', 'slug', 'parent_id', 'module_id', 'image'],
          };
          
          const fallbackCatResults = await Promise.all(
            catIndices.map(index => 
              this.client.search({ index, body: fallbackCatBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          const fallbackCategories: any[] = [];
          fallbackCatResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            hits.forEach((h: any) => {
              fallbackCategories.push({
                id: h._id,
                ...h._source,
              });
            });
          });
          
          // Deduplicate fallback categories
          const seenFallbackCategoryNames = new Set<string>();
          categories = fallbackCategories.filter((category: any) => {
            if (seenFallbackCategoryNames.has(category.name)) return false;
            seenFallbackCategoryNames.add(category.name);
            return true;
          }).slice(0, size);
          
          this.logger.debug(`[suggestByModule] Found ${categories.length} categories via items/stores fallback`);
        } catch (error: any) {
          this.logger.warn(`[suggestByModule] Failed to fetch fallback categories: ${error?.message || String(error)}`);
        }
      }
    }
    
    // 3. If items are empty, find items via stores and categories
    if (items.length === 0 && (stores.length > 0 || categories.length > 0)) {
      this.logger.debug(`[suggestByModule] Items empty, searching via stores/categories`);
      const itemFilters: any[] = [];
      
      // Add store filter if stores found
      if (stores.length > 0) {
        const storeIds = stores.map((store: any) => String(store.id));
        itemFilters.push({ terms: { store_id: storeIds } });
      }
      
      // Add category filter if categories found
      if (categories.length > 0) {
        const categoryIds = categories.map((cat: any) => String(cat.id));
        itemFilters.push({ terms: { category_id: categoryIds } });
      }
      
      if (itemFilters.length > 0) {
        try {
          const fallbackItemBody: any = {
            query: {
              bool: {
                must: itemFilters.length === 1 ? itemFilters[0] : { bool: { should: itemFilters, minimum_should_match: 1 } },
                filter: filterClauses,
              },
            },
            size: size * 2,
            _source: ['name', 'slug', 'image', 'images', 'price', 'base_price', 'veg', 'category_id', 'category_name', 'store_id', 'store_location', 'module_id', 'description', 'available_time_starts', 'available_time_ends', 'rating_count', 'avg_rating', 'order_count', 'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 'is_halal', 'organic'],
            script_fields: hasGeo ? {
              distance_km: { script: { source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0", params: { lat, lon } } },
            } : undefined,
          };
          
          const fallbackItemResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: fallbackItemBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          const fallbackItems: any[] = [];
          fallbackItemResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            hits.forEach((h: any) => {
              const source = h._source || {};
              let distance = h.fields?.distance_km?.[0];
              
              if (hasGeo && !distance && source.store_location) {
                let storeLat: number | undefined;
                let storeLon: number | undefined;
                
                if (source.store_location?.lat && source.store_location?.lon) {
                  storeLat = parseFloat(String(source.store_location.lat));
                  storeLon = parseFloat(String(source.store_location.lon));
                } else if (Array.isArray(source.store_location) && source.store_location.length === 2) {
                  storeLon = parseFloat(String(source.store_location[0]));
                  storeLat = parseFloat(String(source.store_location[1]));
                }
                
                if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
                  distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
                }
              }
              
              fallbackItems.push({
                id: h._id,
                distance_km: distance,
                ...source,
              });
            });
          });
          
          // Deduplicate and sort fallback items
          const seenFallbackItemNames = new Set<string>();
          items = fallbackItems.filter((item: any) => {
            if (seenFallbackItemNames.has(item.name)) return false;
            seenFallbackItemNames.add(item.name);
            return true;
          });
          
          if (hasGeo) {
            items.sort((a, b) => {
              const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
              const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
              if (distA !== distB) return distA - distB;
              return 0;
            });
          }
          
          items = items.slice(0, size);
          this.logger.debug(`[suggestByModule] Found ${items.length} items via stores/categories fallback`);
        } catch (error: any) {
          this.logger.warn(`[suggestByModule] Failed to fetch fallback items: ${error?.message || String(error)}`);
        }
      }
    }

    // Fetch store logos from database if not available in OpenSearch (after all fallback logic)
    // Check all stores - if logo is null, undefined, or empty string, fetch from database
    const storeIdsNeedingLogo = stores
      .filter((store: any) => !store.logo || store.logo === null || store.logo === '')
      .map((store: any) => String(store.id));
    
    if (storeIdsNeedingLogo.length > 0) {
      this.logger.debug(`[suggestByModule] Fetching logos from database for ${storeIdsNeedingLogo.length} stores`);
      try {
        const logoMap = await this.moduleService.getStoreLogos(storeIdsNeedingLogo);
        // Update stores with logos from database
        stores.forEach((store: any) => {
          if (!store.logo || store.logo === null || store.logo === '') {
            const logo = logoMap.get(String(store.id));
            if (logo && logo !== null && logo !== '') {
              store.logo = logo;
              this.logger.debug(`[suggestByModule] Set logo for store ${store.id}: ${logo.substring(0, 50)}...`);
            } else {
              // Ensure logo is explicitly null if not found
              store.logo = null;
            }
          }
        });
        this.logger.debug(`[suggestByModule] Successfully fetched logos for stores`);
      } catch (error: any) {
        this.logger.warn(`[suggestByModule] Failed to fetch store logos from database: ${error?.message || String(error)}`);
        // Ensure all stores have logo field set to null on error
        stores.forEach((store: any) => {
          if (!store.logo || store.logo === null || store.logo === '') {
            store.logo = null;
          }
        });
      }
    }

    // Fetch store schedules from MySQL database
    this.logger.debug(`[suggestByModule] About to fetch schedules for ${stores.length} stores`);
    if (stores.length > 0) {
      try {
        const storeIds = stores.map((s: any) => String(s.id)).filter(Boolean);
        this.logger.debug(`[suggestByModule] Store IDs to fetch: ${storeIds.join(', ')}`);
        if (storeIds.length > 0) {
          const schedulesByStore = await this.fetchStoreSchedules(storeIds);
          
          // Attach schedule data to stores
          stores.forEach((store: any) => {
            const storeId = String(store.id);
            if (schedulesByStore.has(storeId)) {
              store.schedule = schedulesByStore.get(storeId);
              this.logger.debug(`[suggestByModule] Store ${storeId} has ${store.schedule.length} schedule entries`);
            }
          });
          
          this.logger.debug(`[suggestByModule] Attached schedules to ${schedulesByStore.size} stores`);
        }
      } catch (error: any) {
        this.logger.error(`[suggestByModule] Failed to fetch store schedules: ${error?.message || String(error)}`, error.stack);
      }
    }

    // Add timing status to each store BEFORE image transformation
    stores.forEach((store: any) => {
      const timingInfo = this.getStoreTimingStatus(store);
      store.timing_status = timingInfo.status;
      store.timing_message = timingInfo.message;
      store.is_open = timingInfo.isOpen;
      if (timingInfo.minutesRemaining !== undefined) {
        store.minutes_until_closing = timingInfo.minutesRemaining;
      }
    });

    // Populate store_name for items that don't have it (indexing issue - some items missing store_name)
    const itemStoreIds = [...new Set(items.map((item: any) => String(item.store_id)).filter(Boolean))];
    if (itemStoreIds.length > 0) {
      try {
        // Build a map of store_id -> store_name from the stores we already have
        const storeNameMap = new Map<string, string>();
        stores.forEach((store: any) => {
          if (store.id && store.name) {
            storeNameMap.set(String(store.id), store.name);
          }
        });

        // For items whose stores aren't in the results, fetch store names from OpenSearch
        const missingStoreIds = itemStoreIds.filter(id => !storeNameMap.has(id));
        if (missingStoreIds.length > 0) {
          const storeIndices = this.getAllStoreIndices();
          const storeNameResults = await Promise.all(
            storeIndices.map(index =>
              this.client.search({
                index,
                body: {
                  query: { terms: { id: missingStoreIds } },
                  size: missingStoreIds.length,
                  _source: ['name']
                }
              }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );

          storeNameResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._id && hit._source?.name) {
                storeNameMap.set(String(hit._id), hit._source.name);
              }
            });
          });
        }

        // Apply store names to items
        items.forEach((item: any) => {
          if (item.store_id && !item.store_name) {
            const storeName = storeNameMap.get(String(item.store_id));
            if (storeName) {
              item.store_name = storeName;
            }
          }
        });

        this.logger.debug(`[suggestByModule] Populated store_name for ${items.filter((i: any) => i.store_name).length}/${items.length} items`);
      } catch (error: any) {
        this.logger.warn(`[suggestByModule] Failed to populate store names for items: ${error?.message || String(error)}`);
      }
    }

    this.logger.debug(`[suggestByModule] Final results: ${items.length} items, ${stores.length} stores, ${categories.length} categories (intent: ${parsed.intent})`);

    // ============================================
    // BRAND VALIDATION FOR UNREGISTERED BRANDS
    // ============================================
    // If user searched for a known international brand (KFC, Dominos, etc.)
    // but we found no matching stores, inform them it's not available
    let brandNotFound: { brand: string; message: string } | undefined;
    
    if (parsed.isBrandSearch && parsed.detectedBrand && stores.length === 0) {
      const brandName = parsed.detectedBrand.charAt(0).toUpperCase() + parsed.detectedBrand.slice(1);
      brandNotFound = {
        brand: brandName,
        message: `${brandName} is not currently available as a Mangwale partner in your area. Try searching for similar local restaurants!`
      };
      this.logger.debug(`[suggestByModule] Brand "${parsed.detectedBrand}" detected but not registered as a partner`);
    }

    return { 
      q, 
      intent: parsed.intent,
      detected_brand: parsed.detectedBrand,
      is_brand_search: parsed.isBrandSearch || false,
      brand_not_found: brandNotFound,
      items: this.imageService.transformItemsWithImages(items), 
      stores: this.imageService.transformStoresWithImages(stores), 
      categories: this.imageService.transformCategoriesWithImages(categories) 
    };
  }

  /**
   * NEW: Items search with module_id/store_id/category_id support
   */
  async searchItemsByModule(
    q: string,
    filters: {
      module_id?: number;
      store_id?: number;
      category_id?: number;
      veg?: string;
      price_min?: number;
      price_max?: number;
      rating_min?: number;
      lat?: number;
      lon?: number;
      radius_km?: number;
      semantic?: boolean | string;
      page?: number;
      size?: number;
      sort?: string;
    }
  ) {
    // Validate category belongs to module if both provided
    if (filters?.category_id && filters?.module_id) {
      const isValid = await this.moduleService.validateCategoryModule(Number(filters.category_id), filters.module_id);
      if (!isValid) {
        // Check if category exists in another module
        const correctModuleId = await this.moduleService.getModuleIdForCategory(Number(filters.category_id));
        if (correctModuleId) {
          this.logger.warn(`[searchItemsByModule] Category ${filters.category_id} belongs to module ${correctModuleId}, not ${filters.module_id}. Switching module context.`);
          filters.module_id = correctModuleId;
        } else {
          throw new BadRequestException(
            `Category ${filters.category_id} does not exist in module ${filters.module_id}`
          );
        }
      }
    }

    const must: any[] = [];
    const filterClauses: any[] = [];

    // Module filter
    if (filters?.module_id) {
      filterClauses.push({ term: { module_id: Number(filters.module_id) } });
    }

    // Store filter
    if (filters?.store_id) {
      filterClauses.push({ term: { store_id: Number(filters.store_id) } });
    }

    // Category filter - include child categories (subcategories)
    let categoryIdsForFilter: number[] = [];
    if (filters?.category_id) {
      try {
        categoryIdsForFilter = await this.moduleService.getCategoryWithChildren(
          Number(filters.category_id),
          filters?.module_id
        );
        if (categoryIdsForFilter.length > 0) {
          if (categoryIdsForFilter.length === 1) {
            filterClauses.push({ term: { category_id: categoryIdsForFilter[0] } });
          } else {
            filterClauses.push({ terms: { category_id: categoryIdsForFilter } });
          }
          this.logger.debug(`[searchItemsByModule] Including ${categoryIdsForFilter.length} categories (parent + children) for category_id ${filters.category_id}`);
        } else {
          // Fallback to just the parent category if children lookup fails
          filterClauses.push({ term: { category_id: Number(filters.category_id) } });
        }
      } catch (error: any) {
        this.logger.warn(`[searchItemsByModule] Failed to get child categories for ${filters.category_id}: ${error?.message || String(error)}. Using parent category only.`);
        filterClauses.push({ term: { category_id: Number(filters.category_id) } });
      }
    }

    // Query text
    if (q && q.trim()) {
      must.push({
        bool: {
          should: [
            { term: { name: { value: q, boost: 10 } } },
            { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
            { match_phrase: { name: { query: q, boost: 6 } } },
            { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
            { match: { store_name: { query: q, boost: 7, operator: 'and' } } },
            { multi_match: {
              query: q,
              fields: ['name^3', 'description^1', 'category_name^2', 'store_name^2'],
              type: 'best_fields',
              operator: 'and',
              fuzziness: 'AUTO',
              lenient: true,
            }},
            { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
            { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    // Item status/approval + store open/approved filter
    filterClauses.push({ term: { status: 1 } });
    filterClauses.push({ term: { is_approved: 1 } });
    filterClauses.push({ term: { store_active: 1 } }); // Store must be currently open
    // Admin-approved store filter: only for food modules (ecom stores all have store_status=0 pending approval)
    const moduleIdNum = filters?.module_id ? Number(filters.module_id) : null;
    if (moduleIdNum === 4 || moduleIdNum === 6) {
      filterClauses.push({ term: { store_status: 1 } });
    }

    // Veg filter
    const veg = filters?.veg;
    if (veg === '1' || veg === 'true' || veg === 'veg') {
      filterClauses.push({ term: { veg: 1 } });
    } else if (veg === '0' || veg === 'false' || veg === 'non-veg') {
      filterClauses.push({ term: { veg: 0 } });
    }

    // Price range
    const priceMin = filters?.price_min;
    const priceMax = filters?.price_max;
    if (priceMin !== undefined || priceMax !== undefined) {
      const range: any = {};
      if (priceMin !== undefined && !Number.isNaN(priceMin)) range.gte = priceMin;
      if (priceMax !== undefined && !Number.isNaN(priceMax)) range.lte = priceMax;
      if (Object.keys(range).length) {
        filterClauses.push({ range: { price: range } });
      }
    }

    // Rating filter
    const ratingMin = filters?.rating_min;
    if (ratingMin !== undefined && !Number.isNaN(ratingMin)) {
      filterClauses.push({ range: { avg_rating: { gte: ratingMin } } });
    }

    // Geo filter
    const lat = filters?.lat;
    const lon = filters?.lon;
    const radiusKm = filters?.radius_km ? Number(filters.radius_km) : undefined;
    // Treat lat=0, lon=0 as no location (invalid coordinates)
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon) && 
                   !(lat === 0 && lon === 0);
    
    if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm)) {
      filterClauses.push({ geo_distance: { distance: `${radiusKm}km`, store_location: { lat, lon } } });
    }

    // Zone-aware filtering (items have zone_id indexed)
    let userZoneId: number | null = null;
    if (hasGeo) {
      try {
        userZoneId = await this.zoneService.getZoneId(lat, lon);
        if (userZoneId) {
          // Add zone filter: prefer same zone + adjacent zones
          const zoneFilter = this.buildZoneFilter(userZoneId, true);
          if (zoneFilter) {
            filterClauses.push(zoneFilter);
            this.logger.debug(`[searchItemsByModule] Zone filter applied: user zone ${userZoneId} + adjacent zones`);
          }
        }
      } catch (error) {
        this.logger.warn(`[searchItemsByModule] Failed to get zone ID: ${(error as any)?.message || String(error)}`);
      }
    }

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort
    const sortOrder = filters?.sort || (hasGeo ? 'distance' : 'popularity');
    let sort: any[] = [];

    switch (sortOrder) {
      case 'distance':
        if (hasGeo) {
          sort = [{ _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } }];
        } else {
          sort = [{ order_count: { order: 'desc' } }];
        }
        break;
      case 'price_asc':
        sort = [{ price: { order: 'asc' } }];
        break;
      case 'price_desc':
        sort = [{ price: { order: 'desc' } }];
        break;
      case 'rating':
        sort = [{ avg_rating: { order: 'desc' } }, { order_count: { order: 'desc' } }];
        break;
      case 'popularity':
      default:
        sort = [{ order_count: { order: 'desc' } }, { avg_rating: { order: 'desc' } }];
        break;
    }

    // Check for semantic search
    const semanticValue = filters?.semantic;
    const useSemantic = semanticValue === true || String(semanticValue) === '1' || String(semanticValue) === 'true';
    
    if (useSemantic && q && q.trim()) {
      // Use semantic search
      const embedding = await this.embeddingService.generateEmbedding(q);
      if (embedding) {
        const body: any = {
          size,
          from,
          query: {
            bool: {
              must: [{
                knn: {
                  item_vector: {
                    vector: embedding,
                    k: Math.min(size * 3, 100),
                  },
                },
              }],
              filter: filterClauses,
              must_not: this.buildTestStoreExclusion('store_name.keyword'),
            },
          },
          sort: hasGeo ? [
            '_score',
            { _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } },
          ] : ['_score'],
          _source: {
            excludes: ['item_vector'],
          },
        };

        if (hasGeo) {
          body.script_fields = {
            distance_km: {
              script: {
                source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                params: { lat, lon },
              },
            },
          };
        }

        const itemIndices = this.getAllItemIndices();
        const results = await Promise.all(
          itemIndices.map(index => {
            // Check if index supports geo features (food_items_prod has complete store data with geo)
            const supportsGeo = index === this.FOOD_ITEMS_INDEX;
            let indexBody = body;
            
            if (!supportsGeo && hasGeo) {
              indexBody = { ...body };
              // Remove geo sort, keep score sort
              indexBody.sort = ['_score'];
              // Remove script_fields
              indexBody.script_fields = undefined;
              // Remove geo_distance filter
              if (indexBody.query?.bool?.filter) {
                indexBody.query.bool.filter = indexBody.query.bool.filter.filter((f: any) => !f.geo_distance);
              }
            }
            
            return this.client.search({ index, body: indexBody }).catch(() => ({ body: { hits: { hits: [], total: { value: 0 } } } }));
          })
        );

        let allItems: any[] = [];
        let totalHits = 0;

        results.forEach(res => {
          const hits = res.body.hits?.hits || [];
          totalHits += res.body.hits?.total?.value ?? 0;
          hits.forEach((h: any) => {
            allItems.push({
              id: h._id,
              score: h._score,
              distance_km: h.fields?.distance_km?.[0],
              ...h._source,
            });
          });
        });

        // Sort and paginate
        if (sortOrder === 'distance' && hasGeo) {
          allItems.sort((a, b) => (a.distance_km || Infinity) - (b.distance_km || Infinity));
        }
        allItems = allItems.slice(from, from + size);

        // Get store names
        const storeIds = [...new Set(allItems.map(item => item.store_id).filter(Boolean))];
        const storeNames = await this.getStoreNames(storeIds, 'all'); // Search all store indices

        const items = allItems.map(item => ({
          ...item,
          store_name: item.store_id ? storeNames[String(item.store_id)] : null,
        }));

        return {
          q,
          filters,
          items: this.imageService.transformItemsWithImages(items),
          meta: {
            total: totalHits,
            page,
            size,
            total_pages: Math.ceil(totalHits / size),
            has_more: page * size < totalHits,
          },
        };
      }
    }

    // Regular keyword search
    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
          must_not: this.buildTestStoreExclusion('store_name.keyword'),
        },
      },
      size,
      from,
      sort,
      _source: [
        'id', 'name', 'slug', 'image', 'images', 'price', 'base_price', 
        'veg', 'category_id', 'category_name', 'store_id', 'store_location', 
        'module_id', 'description', 'available_time_starts', 'available_time_ends',
        'rating_count', 'avg_rating', 'order_count', 'discount', 'discount_type',
        'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved',
        'is_halal', 'is_visible', 'organic', 'maximum_cart_quantity', 'unit_id',
        'zone_id', 'store_name', 'brand', 'attributes'
      ],
      script_fields: hasGeo
        ? {
            distance_km: {
              script: {
                source: "if (!doc.containsKey('store_location') || doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                params: { lat, lon },
              },
            },
          }
        : undefined,
    };

    this.logger.log(`[searchItemsByModule] Query body: ${JSON.stringify(body)}`);

    const itemIndices = this.getAllItemIndices();
    this.logger.log(`[searchItemsByModule] Searching in indices: ${itemIndices.join(', ')}`);
    const results = await Promise.all(
      itemIndices.map(async (index) => {
        try {
          // Check if index supports geo features (food_items_prod has complete store data with geo)
          const supportsGeo = index === this.FOOD_ITEMS_INDEX;
          // Check if index supports order_count (food_items_prod and ecom_items)
          const supportsOrderCount = index === this.FOOD_ITEMS_INDEX || index === this.ECOM_ITEMS_INDEX;
          
          let indexBody = body;
          
          if (!supportsGeo && hasGeo) {
             indexBody = { ...body };
             // Remove geo sort if present
             if (sortOrder === 'distance') {
                 if (supportsOrderCount) {
                    indexBody.sort = [{ order_count: { order: 'desc', missing: 0 } }];
                 } else {
                    indexBody.sort = ['_score'];
                 }
             }
             // Remove script_fields
             indexBody.script_fields = undefined;
             // Remove geo_distance filter
             if (indexBody.query?.bool?.filter) {
                 const newFilters = indexBody.query.bool.filter.filter((f: any) => !f.geo_distance);
                 indexBody.query = {
                     ...indexBody.query,
                     bool: {
                         ...indexBody.query.bool,
                         filter: newFilters
                     }
                 };
             }
          }

          const res = await this.client.search({ index, body: indexBody });
          this.logger.debug(`[searchItemsByModule] Index ${index}: found ${res.body.hits?.total?.value || 0} hits`);
          return res;
        } catch (err: any) {
          this.logger.error(`[searchItemsByModule] Search failed for index ${index}: ${err.message}`, err.stack);
          return { body: { hits: { hits: [], total: { value: 0 } } } };
        }
      })
    );

    let allItems: any[] = [];
    let totalHits = 0;

    results.forEach(res => {
      const hits = res.body.hits?.hits || [];
      totalHits += res.body.hits?.total?.value ?? 0;
      hits.forEach((h: any) => {
        // Extract distance from script_fields or sort array
        let distance = h.fields?.distance_km?.[0];
        
        // If not in script_fields, check sort array (when using _geo_distance sort)
        if (distance === undefined || distance === null) {
          if (h.sort && Array.isArray(h.sort) && h.sort.length > 0) {
            // Sort array contains distance values
            // Note: OpenSearch _geo_distance sort may return meters even when unit: 'km' is specified
            const sortDistance = h.sort[0];
            if (typeof sortDistance === 'number') {
              // If distance is > 1000, it's likely in meters (local searches are typically < 1000 km)
              // Convert to kilometers
              if (sortDistance > 1000) {
                distance = sortDistance / 1000.0;
              } else {
                distance = sortDistance;
              }
            }
          }
        }
        
        // Ensure distance from script_fields is also in km (it should be, but double-check)
        if (distance !== undefined && distance !== null && distance > 1000 && h.fields?.distance_km?.[0] === distance) {
          // If script_fields returned a value > 1000, it might be in meters, convert to km
          distance = distance / 1000.0;
        }
        
        // If still no distance and we have geo coordinates, calculate manually
        if ((distance === undefined || distance === null) && hasGeo && h._source?.store_location) {
          const storeLoc = h._source.store_location;
          if (storeLoc?.lat && storeLoc?.lon) {
            const storeLat = parseFloat(String(storeLoc.lat));
            const storeLon = parseFloat(String(storeLoc.lon));
            if (!Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
              distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
            }
          }
        }
        
        allItems.push({
          id: h._id,
          score: h._score,
          distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? undefined : undefined),
          ...h._source,
        });
      });
    });

    this.logger.log(`[searchItemsByModule] Initial search total hits: ${totalHits}. hasGeo: ${hasGeo}, radiusKm: ${radiusKm}`);

    // Fallback: If no results found with radius filter, try without radius filter
    if (totalHits === 0 && hasGeo && radiusKm) {
      this.logger.log(`[searchItemsByModule] No results within ${radiusKm}km, retrying without radius filter`);
      
      const fallbackResults = await Promise.all(
        itemIndices.map(async (index) => {
          try {
            // Determine if this index supports geo features
            // food_items_prod has complete store data with store_location properly mapped
            const supportsGeo = index === this.FOOD_ITEMS_INDEX; 
            const supportsOrderCount = index === this.FOOD_ITEMS_INDEX || index === this.ECOM_ITEMS_INDEX;
            this.logger.debug(`[searchItemsByModule] Fallback for index ${index}. Supports geo: ${supportsGeo}`);
            
            const indexBody = {
              ...body,
              query: {
                bool: {
                  must: must.length ? must : [{ match_all: {} }],
                  filter: filterClauses.filter(f => !f.geo_distance),
                },
              },
            };

            // If index doesn't support geo, remove geo sort and script fields to avoid errors
            if (!supportsGeo) {
               // Use default sort (popularity) instead of geo distance
               if (supportsOrderCount) {
                   indexBody.sort = [{ order_count: { order: 'desc', missing: 0 } }]; 
               } else {
                   indexBody.sort = ['_score'];
               }
               indexBody.script_fields = undefined;
            }

            const res = await this.client.search({ index, body: indexBody });
            this.logger.debug(`[searchItemsByModule] Fallback Index ${index}: found ${res.body.hits?.total?.value || 0} hits`);
            return res;
          } catch (err: any) {
            this.logger.warn(`[searchItemsByModule] Fallback search failed for index ${index}: ${err.message}`);
            return { body: { hits: { hits: [], total: { value: 0 } } } };
          }
        })
      );
      
      // Reset and repopulate
      allItems = [];
      totalHits = 0;
      
      fallbackResults.forEach(res => {
        const hits = res.body.hits?.hits || [];
        totalHits += res.body.hits?.total?.value ?? 0;
        hits.forEach((h: any) => {
          // Extract distance from script_fields or sort array
          let distance = h.fields?.distance_km?.[0];
          
          // If not in script_fields, check sort array (when using _geo_distance sort)
          if (distance === undefined || distance === null) {
            if (h.sort && Array.isArray(h.sort) && h.sort.length > 0) {
              const sortDistance = h.sort[0];
              if (typeof sortDistance === 'number') {
                if (sortDistance > 1000) {
                  distance = sortDistance / 1000.0;
                } else {
                  distance = sortDistance;
                }
              }
            }
          }
          
          if (distance !== undefined && distance !== null && distance > 1000 && h.fields?.distance_km?.[0] === distance) {
            distance = distance / 1000.0;
          }
          
          if ((distance === undefined || distance === null) && hasGeo && h._source?.store_location) {
            const storeLoc = h._source.store_location;
            if (storeLoc?.lat && storeLoc?.lon) {
              const storeLat = parseFloat(String(storeLoc.lat));
              const storeLon = parseFloat(String(storeLoc.lon));
              if (!Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
                distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
              }
            }
          }
          
          allItems.push({
            id: h._id,
            score: h._score,
            distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? undefined : undefined),
            ...h._source,
          });
        });
      });
    }

    // Enhanced sorting with priority: 1) Item name matches, 2) Store name matches, 3) Distance
    // First, mark items by their match type
    const itemIdsFromNameSearch = new Set(allItems.map(item => item.id));
    
    // If we have a query, also search stores and get their items (second priority)
    if (q && q.trim() && !filters?.store_id) {
      try {
        const storeIndices = this.getAllStoreIndices();
        const storeBody: any = {
          query: {
            bool: {
              should: [
                { match: { name: { query: q, boost: 10, operator: 'and' } } },
                { match: { slug: { query: q.toLowerCase(), boost: 8, operator: 'and' } } },
                { match_phrase: { name: { query: q, boost: 6 } } },
                { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                { multi_match: {
                  query: q,
                  fields: ['name^3', 'slug^2', 'address'],
                  type: 'best_fields',
                  operator: 'or',
                  fuzziness: 'AUTO',
                }},
                { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
              ],
              minimum_should_match: 1,
            },
          },
          size: 50,
          _source: ['id'],
        };
        
        if (filters?.module_id) {
          storeBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
        }
        
        if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm)) {
          if (!storeBody.query.bool.filter) {
            storeBody.query.bool.filter = [];
          }
          storeBody.query.bool.filter.push({
            geo_distance: {
              distance: `${radiusKm}km`,
              location: { lat, lon },
            },
          });
        }
        
        const storeResults = await Promise.all(
          storeIndices.map(index => 
            this.client.search({ index, body: storeBody }).catch(() => ({ body: { hits: { hits: [] } } }))
          )
        );
        
        const matchingStoreIds = new Set<string>();
        const storeScores = new Map<string, number>();
        storeResults.forEach(res => {
          (res.body.hits?.hits || []).forEach((hit: any) => {
            const storeId = hit._source?.id || hit._id;
            if (storeId) {
              const idStr = String(storeId);
              matchingStoreIds.add(idStr);
              // Store the max score for this store
              const currentScore = storeScores.get(idStr) || 0;
              storeScores.set(idStr, Math.max(currentScore, hit._score || 0));
            }
          });
        });
        
        if (matchingStoreIds.size > 0) {
          // Get items from these stores (but exclude items already found by name)
          const storeFilterClauses = [...filterClauses];
          storeFilterClauses.push({ terms: { store_id: Array.from(matchingStoreIds).map(id => Number(id)) } });

          const storeItemMustClauses: any[] = [];
          if (q && q.trim()) {
            storeItemMustClauses.push({
              bool: {
                should: [
                  { match: { name: { query: q, boost: 10, operator: 'and' } } },
                  { match: { slug: { query: q.toLowerCase(), boost: 8, operator: 'and' } } },
                  { match_phrase: { name: { query: q, boost: 6 } } },
                  { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                  { match: { store_name: { query: q, boost: 7, operator: 'and' } } },
                  { multi_match: {
                    query: q,
                    fields: ['name^3', 'description^1', 'category_name^2', 'store_name^2'],
                    type: 'best_fields',
                    operator: 'and',
                    fuzziness: 'AUTO',
                    lenient: true,
                  }},
                  { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                  { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
                ],
                minimum_should_match: 1,
              },
            });
          }
          
          const itemsFromStoresBody: any = {
            query: {
              bool: {
                must: storeItemMustClauses.length > 0 ? storeItemMustClauses : [{ match_all: {} }],
                filter: storeFilterClauses,
              },
            },
            size: size * 2,
            _source: [
              'id', 'name', 'description', 'image', 'images', 'slug', 'price', 'base_price', 'veg', 'brand',
              'category_id', 'category_name', 'store_id', 'store_name', 'avg_rating', 'order_count', 'store_location',
              'module_id', 'rating_count', 'available_time_starts', 'available_time_ends',
              'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 
              'is_halal', 'is_visible', 'organic', 'maximum_cart_quantity', 'unit_id', 'zone_id', 'attributes',
            ],
            script_fields: hasGeo ? {
              distance_km: {
                script: {
                  source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                  params: { lat, lon },
                },
              },
            } : undefined,
          };
          
          const itemsFromStoresResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: itemsFromStoresBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          itemsFromStoresResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            hits.forEach((h: any) => {
              // Skip if already found by item name search
              if (itemIdsFromNameSearch.has(h._id)) {
                return;
              }
              
              let distance = h.fields?.distance_km?.[0];
              
              if (distance === undefined || distance === null) {
                if (h.sort && Array.isArray(h.sort) && h.sort.length > 0) {
                  const sortDistance = h.sort[0];
                  if (typeof sortDistance === 'number') {
                    if (sortDistance > 1000) {
                      distance = sortDistance / 1000.0;
                    } else {
                      distance = sortDistance;
                    }
                  }
                }
              }
              
              if (distance !== undefined && distance !== null && distance > 1000 && h.fields?.distance_km?.[0] === distance) {
                distance = distance / 1000.0;
              }
              
              if ((distance === undefined || distance === null) && hasGeo && h._source?.store_location) {
                const storeLoc = h._source.store_location;
                if (storeLoc?.lat && storeLoc?.lon) {
                  const storeLat = parseFloat(String(storeLoc.lat));
                  const storeLon = parseFloat(String(storeLoc.lon));
                  if (!Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
                    distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
                  }
                }
              }
              
              // Use the store's match score as the item's score
              const storeScore = storeScores.get(String(h._source.store_id)) || 0;
              
              allItems.push({
                id: h._id,
                score: storeScore, // Use store match score directly
                matchType: 'store_name', // Second priority
                distance_km: distance !== undefined && distance !== null ? distance : undefined,
                ...h._source,
              });
            });
          });
        }
      } catch (error: any) {
        this.logger.warn(`[searchItemsByModule] Failed to search stores: ${error?.message || String(error)}`);
      }
    }
    
    // Mark items from name search
    allItems.forEach(item => {
      if (!item.matchType) {
        item.matchType = itemIdsFromNameSearch.has(item.id) ? 'item_name' : 'none';
      }
    });

    // Apply zone-aware score boosting
    if (userZoneId) {
      allItems.forEach(item => {
        const zoneBoost = this.getZoneBoostFactor(item.zone_id, userZoneId);
        if (zoneBoost > 1.0) {
          // Apply zone boost to score
          item.zone_boost = zoneBoost;
          item.original_score = item.score || 0;
          item.score = (item.score || 0) * zoneBoost;
          this.logger.debug(`[searchItemsByModule] Item ${item.id} zone boost: ${zoneBoost}x (zone ${item.zone_id} vs user ${userZoneId})`);
        }
      });
    }
    
    // Sort with proper priority: 1) Match type (item_name > store_name), 2) Score (with zone boost), 3) Distance
    const matchTypePriority = { 'item_name': 1, 'store_name': 1, 'none': 3 };
    
    allItems.sort((a, b) => {
      // First: Sort by match type priority
      const aPriority = matchTypePriority[a.matchType as keyof typeof matchTypePriority] || 999;
      const bPriority = matchTypePriority[b.matchType as keyof typeof matchTypePriority] || 999;
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      // Second: Within same match type, sort by score (higher is better)
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (Math.abs(scoreDiff) > 0.01) {
        return scoreDiff;
      }
      
      // Third: Sort by distance (closer is better) if geo is available
      if (hasGeo && sortOrder === 'distance') {
        const aDist = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
        const bDist = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
        return aDist - bDist;
      }
      
      // Fallback: Sort by other criteria
      if (sortOrder === 'price_asc') {
        return (a.price || 0) - (b.price || 0);
      } else if (sortOrder === 'price_desc') {
        return (b.price || 0) - (a.price || 0);
      } else if (sortOrder === 'rating') {
        return (b.avg_rating || 0) - (a.avg_rating || 0);
      } else {
        // Default: popularity (order_count + rating)
        return (b.order_count || 0) - (a.order_count || 0);
      }
    });

    // Apply pagination
    allItems = allItems.slice(from, from + size);

    // If no items found and we have a query, try searching for stores and categories, then return their items
    if (allItems.length === 0 && q && q.trim()) {
      try {
        this.logger.debug(`[searchItemsByModule] Items empty, searching via stores/categories for query: ${q}`);
        
        const matchingStoreIds = new Set<string>();
        const matchingCategoryIds = new Set<string>();
        
        // Only search stores if store_id filter is not provided (if store_id is provided, we should only search within that store)
        if (!filters?.store_id) {
          // Search for stores matching the query
          const storeIndices = this.getAllStoreIndices();
          const storeBody: any = {
            query: {
              bool: {
                should: [
                  { match: { name: { query: q, boost: 10, operator: 'and' } } },
                  { match: { slug: { query: q.toLowerCase(), boost: 8, operator: 'and' } } },
                  { match_phrase: { name: { query: q, boost: 6 } } },
                  { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                  { multi_match: {
                    query: q,
                    fields: ['name^3', 'slug^2', 'address'],
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                  }},
                  { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                  { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 50, // Limit to top 50 stores
            _source: ['id'],
          };
          
          // Add module filter if provided
          if (filters?.module_id) {
            storeBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
          }
          
          // Add geo filter if provided
          if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm)) {
            if (!storeBody.query.bool.filter) {
              storeBody.query.bool.filter = [];
            }
            storeBody.query.bool.filter.push({
              geo_distance: {
                distance: `${radiusKm}km`,
                location: { lat, lon },
              },
            });
          }
          
          const storeResults = await Promise.all(
            storeIndices.map(index => 
              this.client.search({ index, body: storeBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          storeResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              // Try _source.id first (the actual store ID), then fallback to _id
              const storeId = hit._source?.id || hit._id;
              if (storeId) {
                matchingStoreIds.add(String(storeId));
              }
            });
          });
          
          this.logger.debug(`[searchItemsByModule] Found ${matchingStoreIds.size} stores matching query: ${Array.from(matchingStoreIds).slice(0, 10).join(', ')}`);
        } else {
          // If store_id is provided, use it directly
          matchingStoreIds.add(String(filters.store_id));
          this.logger.debug(`[searchItemsByModule] Using provided store_id: ${filters.store_id}`);
        }
        
        // Only search categories if category_id filter is not provided (if category_id is provided, we should only search within that category)
        if (!filters?.category_id) {
          // Search for categories matching the query
          const catIndices = this.getAllCategoryIndices();
          const categoryBody: any = {
            query: {
              bool: {
                should: [
                  { match: { name: { query: q, boost: 10, operator: 'and' } } },
                  { match: { slug: { query: q.toLowerCase(), boost: 8, operator: 'and' } } },
                  { match_phrase: { name: { query: q, boost: 6 } } },
                  { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                  { multi_match: {
                    query: q,
                    fields: ['name^3', 'slug^2'],
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                  }},
                  { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                  { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 50, // Limit to top 50 categories
            _source: ['id'],
          };
          
          // Add module filter if provided
          if (filters?.module_id) {
            categoryBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
          }
          
          const categoryResults = await Promise.all(
            catIndices.map(index => 
              this.client.search({ index, body: categoryBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          categoryResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              // Try _source.id first (the actual category ID), then fallback to _id
              const categoryId = hit._source?.id || hit._id;
              if (categoryId) {
                matchingCategoryIds.add(String(categoryId));
              }
            });
          });
          
          this.logger.debug(`[searchItemsByModule] Found ${matchingCategoryIds.size} categories matching query: ${Array.from(matchingCategoryIds).slice(0, 10).join(', ')}`);
        } else {
          // If category_id is provided, use it directly
          matchingCategoryIds.add(String(filters.category_id));
          this.logger.debug(`[searchItemsByModule] Using provided category_id: ${filters.category_id}`);
        }
        
        // If we found stores or categories, search for items
        if (matchingStoreIds.size > 0 || matchingCategoryIds.size > 0) {
          const itemBody: any = {
            query: {
              bool: {
                must: [],
                filter: filterClauses.filter(f => {
                  // Remove store_id and category_id filters if present since we're searching by store_ids/category_ids
                  return !(f.term && (f.term.store_id || f.term.category_id));
                }),
              },
            },
            size: size * 2, // Get more items to ensure we have enough after filtering
            from: 0,
            sort: hasGeo ? [
              { _geo_distance: { store_location: { lat, lon }, order: 'asc', unit: 'km' } }
            ] : [{ order_count: { order: 'desc' } }],
            _source: [
              'name', 'description', 'image', 'images', 'slug', 'price', 'base_price', 'veg', 'brand',
              'category_id', 'category_name', 'store_id', 'avg_rating', 'order_count', 'store_location',
              'module_id', 'rating_count', 'available_time_starts', 'available_time_ends',
              'discount', 'discount_type', 'status', 'tax', 'tax_type', 'stock', 'recommended', 'is_approved', 'is_halal', 'organic',
            ],
            script_fields: hasGeo ? {
              distance_km: {
                script: {
                  source: "if (doc['store_location'].size() == 0) return null; doc['store_location'].arcDistance(params.lat, params.lon) / 1000.0",
                  params: { lat, lon },
                },
              },
            } : undefined,
          };
          
          // Build must clause with store_ids and/or category_ids
          const mustClauses: any[] = [];
          
          if (matchingStoreIds.size > 0) {
            const storeIdNumbers = Array.from(matchingStoreIds).map(id => Number(id)).filter(id => !Number.isNaN(id));
            mustClauses.push({ terms: { store_id: storeIdNumbers } });
          }
          
          if (matchingCategoryIds.size > 0) {
            const categoryIdNumbers = Array.from(matchingCategoryIds).map(id => Number(id)).filter(id => !Number.isNaN(id));
            mustClauses.push({ terms: { category_id: categoryIdNumbers } });
          }
          
          // If we have both stores and categories, use should (OR) logic
          if (mustClauses.length > 1) {
            itemBody.query.bool.should = mustClauses;
            itemBody.query.bool.minimum_should_match = 1;
          } else if (mustClauses.length === 1) {
            itemBody.query.bool.must = mustClauses;
          }
          
          // Add module filter if provided
          if (filters?.module_id) {
            if (!itemBody.query.bool.filter) {
              itemBody.query.bool.filter = [];
            }
            itemBody.query.bool.filter.push({ term: { module_id: Number(filters.module_id) } });
          }
          
          // If store_id was provided, ensure we only get items from that store
          if (filters?.store_id) {
            if (!itemBody.query.bool.filter) {
              itemBody.query.bool.filter = [];
            }
            itemBody.query.bool.filter.push({ term: { store_id: Number(filters.store_id) } });
          }
          
          // If category_id was provided, ensure we only get items from that category and its children
          if (filters?.category_id) {
            if (!itemBody.query.bool.filter) {
              itemBody.query.bool.filter = [];
            }
            // Use the already computed categoryIdsForFilter if available, otherwise compute it
            let fallbackCategoryIds = categoryIdsForFilter.length > 0 
              ? categoryIdsForFilter 
              : await this.moduleService.getCategoryWithChildren(Number(filters.category_id), filters?.module_id).catch(() => [Number(filters.category_id)]);
            
            if (fallbackCategoryIds.length === 1) {
              itemBody.query.bool.filter.push({ term: { category_id: fallbackCategoryIds[0] } });
            } else if (fallbackCategoryIds.length > 1) {
              itemBody.query.bool.filter.push({ terms: { category_id: fallbackCategoryIds } });
            } else {
              itemBody.query.bool.filter.push({ term: { category_id: Number(filters.category_id) } });
            }
          }
          
          this.logger.debug(`[searchItemsByModule] Fallback item query: ${JSON.stringify(itemBody.query).substring(0, 300)}`);
          
          const itemIndices = this.getAllItemIndices();
          const fallbackResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: itemBody }).catch(() => ({ body: { hits: { hits: [], total: { value: 0 } } } }))
            )
          );
          
          let fallbackItems: any[] = [];
          let fallbackTotalHits = 0;
          
          fallbackResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            fallbackTotalHits += res.body.hits?.total?.value ?? 0;
            hits.forEach((h: any) => {
              // Extract distance from script_fields or sort array
              let distance = h.fields?.distance_km?.[0];
              
              // If not in script_fields, check sort array (when using _geo_distance sort)
              if (distance === undefined || distance === null) {
                if (h.sort && Array.isArray(h.sort) && h.sort.length > 0) {
                  const sortDistance = h.sort[0];
                  if (typeof sortDistance === 'number') {
                    // If distance is > 1000, it's likely in meters (local searches are typically < 1000 km)
                    // Convert to kilometers
                    if (sortDistance > 1000) {
                      distance = sortDistance / 1000.0;
                    } else {
                      distance = sortDistance;
                    }
                  }
                }
              }
              
              // Ensure distance from script_fields is also in km (it should be, but double-check)
              if (distance !== undefined && distance !== null && distance > 1000 && h.fields?.distance_km?.[0] === distance) {
                // If script_fields returned a value > 1000, it might be in meters, convert to km
                distance = distance / 1000.0;
              }
              
              // If still no distance and we have geo coordinates, calculate manually
              if ((distance === undefined || distance === null) && hasGeo && h._source?.store_location) {
                const storeLoc = h._source.store_location;
                if (storeLoc?.lat && storeLoc?.lon) {
                  const storeLat = parseFloat(String(storeLoc.lat));
                  const storeLon = parseFloat(String(storeLoc.lon));
                  if (!Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
                    distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
                  }
                }
              }
              
              fallbackItems.push({
                id: h._id,
                score: h._score,
                distance_km: distance !== undefined && distance !== null ? distance : undefined,
                ...h._source,
              });
            });
          });
          
          this.logger.debug(`[searchItemsByModule] Found ${fallbackItems.length} fallback items before sorting/pagination`);
          
          // Sort and paginate fallback items
          if (sortOrder === 'distance' && hasGeo) {
            fallbackItems.sort((a, b) => (a.distance_km || Infinity) - (b.distance_km || Infinity));
          } else if (sortOrder === 'price_asc') {
            fallbackItems.sort((a, b) => (a.price || 0) - (b.price || 0));
          } else if (sortOrder === 'price_desc') {
            fallbackItems.sort((a, b) => (b.price || 0) - (a.price || 0));
          } else if (sortOrder === 'rating') {
            fallbackItems.sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0));
          } else {
            // Default: popularity
            fallbackItems.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
          }
          
          // Apply pagination
          fallbackItems = fallbackItems.slice(from, from + size);
          
          this.logger.debug(`[searchItemsByModule] Returning ${fallbackItems.length} fallback items after pagination`);
          
          // Get store names
          const fallbackStoreIds = [...new Set(fallbackItems.map(item => item.store_id).filter(Boolean))];
          const fallbackStoreNames = await this.getStoreNames(fallbackStoreIds, 'all');
          
          const items = fallbackItems.map(item => ({
            ...item,
            store_name: item.store_id ? fallbackStoreNames[String(item.store_id)] : null,
          }));
          
          // Log analytics
          this.analytics.logSearch({
            module: filters?.module_id ? String(filters.module_id) : 'all',
            q: q || '',
            lat,
            lon,
            size,
            page,
            filters,
            total: fallbackTotalHits,
            section: 'items',
          }).catch(() => {});
          
          return {
            q,
            filters,
            items: this.imageService.transformItemsWithImages(items),
            meta: {
              total: fallbackTotalHits,
              page,
              size,
              total_pages: Math.ceil(fallbackTotalHits / size),
              has_more: page * size < fallbackTotalHits,
            },
          };
        }
      } catch (error: any) {
        this.logger.warn(`[searchItemsByModule] Store/category fallback search failed: ${error?.message || String(error)}`);
        // Continue with empty results
      }
    }

    // Get store names and details (including location for distance calculation)
    const storeIds = [...new Set(allItems.map(item => item.store_id).filter(Boolean))];
    const storeNames = await this.getStoreNames(storeIds, 'all'); // Search all store indices
    const storeDetails = await this.getStoreDetails(storeIds, 'all'); // Get store locations

    const items = allItems.map(item => {
      let distanceKm = item.distance_km;
      
      // If item doesn't have distance_km but has store_id and we have geo coordinates,
      // try to calculate distance from store location
      if ((distanceKm === undefined || distanceKm === null || distanceKm === 0) && hasGeo && item.store_id) {
        const storeDetail = storeDetails[String(item.store_id)];
        if (storeDetail) {
          // Try location.lat/lon first, then latitude/longitude
          let storeLat: number | undefined;
          let storeLon: number | undefined;
          
          if (storeDetail.location?.lat && storeDetail.location?.lon) {
            storeLat = parseFloat(String(storeDetail.location.lat));
            storeLon = parseFloat(String(storeDetail.location.lon));
          } else if (storeDetail.latitude && storeDetail.longitude) {
            storeLat = parseFloat(String(storeDetail.latitude));
            storeLon = parseFloat(String(storeDetail.longitude));
          }
          
          if (storeLat && storeLon && !Number.isNaN(storeLat) && !Number.isNaN(storeLon)) {
            distanceKm = this.calculateDistance(lat!, lon!, storeLat, storeLon);
            // Also add store_location to the item for consistency
            if (!item.store_location) {
              item.store_location = { lat: storeLat, lon: storeLon };
            }
          }
        }
      }
      
      // Use existing store_name from item, only use lookup as fallback
      const storeName = item.store_name || (item.store_id ? storeNames[String(item.store_id)] : null);
      
      return {
        ...item,
        distance_km: distanceKm,
        store_name: storeName,
      };
    });

    // Log analytics
    this.analytics.logSearch({
      module: filters?.module_id ? String(filters.module_id) : 'all',
      q: q || '',
      lat,
      lon,
      size,
      page,
      filters,
      total: totalHits,
      section: 'items',
    }).catch(() => {});

    // If store_id filter was applied from query parsing, get store details
    let resolvedStore = null;
    const originalQuery = (filters as any)?._original_query || q;
    
    // Log for debugging
    this.logger.log(`[searchItemsByModule] DEBUG: q="${q}", filters._original_query="${(filters as any)?._original_query}", originalQuery="${originalQuery}", store_id=${filters?.store_id}`);
    
    if (filters?.store_id && originalQuery && originalQuery.trim()) {
      this.logger.log(`[searchItemsByModule] ✓ Condition met - attempting to resolve store`);
      try {
        const storeDetail = storeDetails[String(filters.store_id)];
        this.logger.log(`[searchItemsByModule] StoreDetail lookup: found=${!!storeDetail}, name=${storeDetail?.name}`);
        if (storeDetail) {
          this.logger.log(`✅ [searchItemsByModule] Resolved store: ${storeDetail.name} (ID: ${filters.store_id})`);
          resolvedStore = {
            id: filters.store_id,
            name: storeDetail.name || storeNames[String(filters.store_id)],
            type: 'exact_match',
            confidence: 0.95,
            logo: storeDetail.logo,
            logo_full_url: storeDetail.logo ? `https://storage.mangwale.ai/mangwale/store/${storeDetail.logo}` : null,
            rating: storeDetail.rating,
            avg_rating: storeDetail.avg_rating,
            delivery_time: storeDetail.delivery_time,
            module_id: storeDetail.module_id,
            active: storeDetail.active,
            status: storeDetail.status,
            veg: storeDetail.veg,
            non_veg: storeDetail.non_veg,
            featured: storeDetail.featured,
            location: storeDetail.location,
            latitude: storeDetail.latitude,
            longitude: storeDetail.longitude,
          };
        } else {
          this.logger.warn(`[searchItemsByModule] Store details not found for store_id=${filters.store_id}`);
        }
      } catch (error: any) {
        this.logger.debug(`Failed to get resolved store details: ${error.message}`);
      }
    }

    return {
      q,
      filters: { ...filters, _original_query: undefined }, // Remove internal flag from response
      resolved_store: resolvedStore,
      items: this.imageService.transformItemsWithImages(items),
      meta: {
        total: totalHits,
        page,
        size,
        total_pages: Math.ceil(totalHits / size),
        has_more: page * size < totalHits,
      },
    };
  }

  /**
   * NEW: Stores search with module_id and category_id support
   * Enhanced: Searches stores by name, categories they serve, and items they have
   * If category_id is provided, returns stores that serve items in that category
   */
  async searchStoresByModule(
    q: string,
    filters: {
      module_id?: number;
      category_id?: number;
      store_id?: number;
      lat?: number;
      lon?: number;
      radius_km?: number;
      delivery_time_max?: number;
      page?: number;
      size?: number;
      sort?: string;
      veg?: string;
    }
  ): Promise<{
    q: string;
    filters: any;
    stores: any[];
    meta: {
      total: number;
      page: number;
      size: number;
      total_pages: number;
      has_more: boolean;
    };
  }> {
    this.logger.log(`🔍 [searchStoresByModule] START: q="${q}", filters=${JSON.stringify(filters)}`);

    // Try cache first if enabled
    const startTime = Date.now();
    this.logger.log(`[searchStoresByModule] Cache check: cacheEnabled=${this.cacheEnabled}`);
    if (this.cacheEnabled) {
      const cacheKey = this.cacheService.buildCacheKey({ q, ...filters });
      this.logger.log(`[searchStoresByModule] Checking cache with key: ${cacheKey.substring(0, 100)}...`);
      const cached = await this.cacheService.get(cacheKey);
      
      if (cached) {
        const latency = Date.now() - startTime;
        this.logger.log(`🚀 [searchStoresByModule] Cache HIT: q="${q}", latency=${latency}ms`);
        
        // CRITICAL: Recalculate timing for cached stores (timing is dynamic based on current time)
        // We need to fetch schedules for these stores before recalculating
        if (cached.stores && Array.isArray(cached.stores) && cached.stores.length > 0) {
          const storeIds = cached.stores.map((s: any) => s.id || s.store_id).filter(Boolean);
          if (storeIds.length > 0) {
            try {
              const schedulesByStore = await this.fetchStoreSchedules(storeIds);
              cached.stores.forEach((store: any) => {
                const storeId = String(store.id || store.store_id);
                const schedule = schedulesByStore.get(storeId);
                if (schedule) {
                  store.schedule = schedule;
                }
                const timingInfo = this.getStoreTimingStatus(store);
                store.timing_status = timingInfo.status;
                store.timing_message = timingInfo.message;
                store.is_open = timingInfo.isOpen;
                if (timingInfo.minutesRemaining !== undefined) {
                  store.minutes_until_closing = timingInfo.minutesRemaining;
                }
              });
            } catch (error) {
              this.logger.warn(`[searchStoresByModule] Failed to fetch schedules for cached stores: ${(error as any)?.message}`);
            }
          }
        }
        
        return cached;
      }
    }

    // Validate category belongs to module if both provided
    if (filters?.category_id && filters?.module_id) {
      this.logger.debug(`[searchStoresByModule] Validating category ${filters.category_id} belongs to module ${filters.module_id}`);
      const isValid = await this.moduleService.validateCategoryModule(Number(filters.category_id), filters.module_id);
      if (!isValid) {
        // Check if category exists in another module
        const correctModuleId = await this.moduleService.getModuleIdForCategory(Number(filters.category_id));
        if (correctModuleId) {
          this.logger.warn(`[searchStoresByModule] Category ${filters.category_id} belongs to module ${correctModuleId}, not ${filters.module_id}. Switching module context.`);
          filters.module_id = correctModuleId;
        } else {
          this.logger.warn(`[searchStoresByModule] Category ${filters.category_id} does not exist in module ${filters.module_id}`);
          throw new BadRequestException(
            `Category ${filters.category_id} does not exist in module ${filters.module_id}`
          );
        }
      }
      this.logger.debug(`[searchStoresByModule] Category validation passed`);
    }

    // Get the correct store indices based on module_id
    let storeIndices: string[] = [];
    let itemIndices: string[] = [];
    let catIndices: string[] = [];

    if (filters?.module_id) {
      this.logger.log(`[searchStoresByModule] Fetching module ${filters.module_id} from database`);
      let module: any = null;
      try {
        module = await this.moduleService.getModuleById(filters.module_id);
      } catch (error: any) {
        this.logger.warn(`[searchStoresByModule] Failed to fetch module from database: ${error?.message || String(error)}. Using fallback mapping.`);
      }
      
      if (!module) {
        // Fallback: Use common module_id to module_type mappings
        const moduleTypeMap: Record<number, string> = {
          4: 'food',
          5: 'ecommerce',
          6: 'grocery',
        };
        const moduleType = moduleTypeMap[filters.module_id] || 'food';
        this.logger.log(`[searchStoresByModule] Using fallback mapping: module_id=${filters.module_id} -> module_type=${moduleType}`);
        
        // Use module_type to determine indices
        if (moduleType === 'food') {
          storeIndices = [this.FOOD_STORES_INDEX];
          itemIndices = [this.FOOD_ITEMS_INDEX];
          catIndices = ['food_categories'];
        } else if (moduleType === 'ecommerce' || moduleType === 'grocery') {
          storeIndices = ['ecom_stores'];
          itemIndices = ['ecom_items'];
          catIndices = ['ecom_categories'];
        } else {
          storeIndices = [`${moduleType}_stores`];
          itemIndices = [`${moduleType}_items`];
          catIndices = [`${moduleType}_categories`];
        }
        this.logger.log(`[searchStoresByModule] Using fallback indices: stores=[${storeIndices.join(',')}], items=[${itemIndices.join(',')}], categories=[${catIndices.join(',')}]`);
      } else {
        this.logger.log(`[searchStoresByModule] Module found: id=${module.id}, name=${module.name}, type=${module.module_type}`);
        
        storeIndices = [this.moduleService.getIndexForModule(module, 'stores')];
        itemIndices = [this.moduleService.getIndexForModule(module, 'items')];
        // For categories, we need to determine the category index based on module type
        const moduleType = module.module_type;
        if (moduleType === 'food') {
          catIndices = ['food_categories'];
        } else if (moduleType === 'ecommerce' || moduleType === 'grocery') {
          catIndices = ['ecom_categories'];
        } else {
          catIndices = [`${moduleType}_categories`];
        }
        this.logger.log(`[searchStoresByModule] Using module-specific indices: stores=[${storeIndices.join(',')}], items=[${itemIndices.join(',')}], categories=[${catIndices.join(',')}]`);
      }
    } else {
      // No module_id, search all indices
      storeIndices = this.getAllStoreIndices();
      itemIndices = this.getAllItemIndices();
      catIndices = this.getAllCategoryIndices();
      this.logger.log(`[searchStoresByModule] No module_id provided, searching all indices: stores=[${storeIndices.join(',')}]`);
    }

    const must: any[] = [];
    const filterClauses: any[] = [];

    // Module filter
    if (filters?.module_id) {
      filterClauses.push({ term: { module_id: Number(filters.module_id) } });
    }

    // Store filter
    if (filters?.store_id) {
      filterClauses.push({ term: { id: Number(filters.store_id) } });
    }

    // Category filter: If category_id is provided, we need to find stores that serve items in this category
    // This is handled in the enhanced search logic below, not as a direct filter on stores

    // Query text
    if (q && q.trim()) {
      must.push({
        bool: {
          should: [
            // Exact keyword matches (highest priority)
            { term: { 'name.keyword': { value: q, boost: 20, case_insensitive: true } } },
            { term: { 'slug.keyword': { value: q.toLowerCase(), boost: 18 } } },
            // Very close matches
            { match: { name: { query: q, boost: 15, operator: 'and' } } },
            { match: { slug: { query: q.toLowerCase(), boost: 12, operator: 'and' } } },
            { match_phrase: { name: { query: q, boost: 10, slop: 0 } } },
            { match_phrase: { slug: { query: q.toLowerCase(), boost: 8, slop: 0 } } },
            // Partial/prefix matches for single-word queries
            { prefix: { name: { value: q.toLowerCase(), boost: 7 } } },
            { prefix: { slug: { value: q.toLowerCase(), boost: 6 } } },
            // Fuzzy matches
            { match: { name: { query: q, boost: 5, fuzziness: 'AUTO' } } },
            { multi_match: {
              query: q,
              fields: ['name^4', 'slug^3', 'address^1'],
              type: 'best_fields',
              operator: 'and',
              fuzziness: 'AUTO',
            }},
            { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
            { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    // Geo filter
    const lat = filters?.lat;
    const lon = filters?.lon;
    const radiusKm = filters?.radius_km;
    const hasGeo = lat !== undefined && !Number.isNaN(lat) && lon !== undefined && !Number.isNaN(lon);

    // Zone handling
    // IMPORTANT: Do NOT hard-filter stores by derived zone_id from lat/lon.
    // In some environments the stores index may not have reliable zone_id values,
    // which would hide all stores when the user taps "Located".
    // If a caller wants strict zone filtering, they must pass filters.zone_id explicitly.
    if (hasGeo) {
      try {
        const derivedZoneId = await this.zoneService.getZoneId(lat, lon);
        if (derivedZoneId) {
          this.logger.debug(`[searchStoresByModule] Derived zone_id=${derivedZoneId} from (${lat}, ${lon}) (not applied as hard filter)`);
        }
      } catch (error) {
        this.logger.warn(`[searchStoresByModule] Failed to derive zone ID: ${(error as any)?.message || String(error)}`);
      }
    }

    this.logger.log(`[searchStoresByModule] Geo params: lat=${lat}, lon=${lon}, radius_km=${radiusKm}, hasGeo=${hasGeo}`);

    // Only apply geo_distance filter if radius_km is explicitly provided
    // Otherwise, just use geo sorting without filtering
    if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm) && radiusKm > 0) {
      filterClauses.push({
        geo_distance: {
          distance: `${radiusKm}km`,
          location: { lat, lon },
        },
      });
      this.logger.log(`[searchStoresByModule] Applied geo_distance filter: ${radiusKm}km from (${lat}, ${lon})`);
    } else if (hasGeo) {
      this.logger.log(`[searchStoresByModule] Geo coordinates provided but no radius_km, will sort by distance only (no filtering)`);
    }

    // Status filters - Only show active AND approved stores (stores use boolean fields)
    filterClauses.push({ term: { status: true } });
    filterClauses.push({ term: { active: true } });
    this.logger.debug(`[searchStoresByModule] Applied status=true, active=true filter`);

    // Veg/Non-Veg filter - stores use boolean fields
    const vegFilter = filters?.veg;
    const mustNotClauses: any[] = [
      // Exclude test/demo stores
      ...this.buildTestStoreExclusion('name.keyword'),
    ];

    if (vegFilter === 'pure_veg' || vegFilter === 'pure-veg') {
      // Pure Veg ONLY: veg=true AND non_veg!=true (excludes restaurants that also serve non-veg)
      filterClauses.push({ term: { veg: true } });
      mustNotClauses.push({ term: { non_veg: true } });
      this.logger.debug(`[searchStoresByModule] Applied PURE VEG filter (veg=true, non_veg!=true)`);
    } else if (vegFilter === '1' || vegFilter === 'veg' || vegFilter === 'true') {
      // Veg: must have veg=true (includes restaurants that also serve non-veg)
      filterClauses.push({ term: { veg: true } });
      this.logger.debug(`[searchStoresByModule] Applied VEG filter`);
    } else if (vegFilter === '0' || vegFilter === 'non-veg' || vegFilter === 'false') {
      // Non-veg: must have non_veg=true (can also have veg=true)
      filterClauses.push({ term: { non_veg: true } });
      this.logger.debug(`[searchStoresByModule] Applied NON-VEG filter`);
    }
    // If vegFilter is not set or is 'all', show all stores (no filter)

    // Pagination
    const size = Math.max(1, Math.min(Number(filters?.size ?? 20) || 20, 100));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const from = (page - 1) * size;

    // Sort
    // When lat/lon are provided but no radius_km, we'll sort by popularity first
    // then manually sort by distance after fetching results (to handle cases where location field might not be geo_point)
    const sortOrder = filters?.sort || (hasGeo && radiusKm ? 'distance' : 'popularity');
    let sort: any[] = [];

    // Only use _geo_distance sort if radius_km is provided (meaning we're filtering by distance)
    // Otherwise, sort by popularity and we'll manually sort by distance later
    if (hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm) && radiusKm > 0) {
      // When filtering by radius, use geo_distance sort
      sort = [{
        _geo_distance: {
          location: { lat, lon },
          order: 'asc',
          unit: 'km',
          mode: 'min',
          distance_type: 'arc',
          ignore_unmapped: true,
        },
      }];
    } else if (hasGeo && filters?.sort === 'distance') {
      // User explicitly requested distance sort, try geo_distance but with fallback
      sort = [{
        _geo_distance: {
          location: { lat, lon },
          order: 'asc',
          unit: 'km',
          mode: 'min',
          distance_type: 'arc',
          ignore_unmapped: true,
        },
      }];
    } else {
      // Default: sort by popularity
      sort = [{ order_count: { order: 'desc' } }];
    }

    const body: any = {
      query: {
        bool: {
          must: must.length ? must : [{ match_all: {} }],
          filter: filterClauses,
          must_not: mustNotClauses.length > 0 ? mustNotClauses : undefined,
        },
      },
      size,
      from,
      sort,
      _source: [
        'id', 'name', 'slug', 'phone', 'email',
        'logo', 'cover_photo', 'image', 'images',
        'address', 'location', 'latitude', 'longitude',
        'rating', 'avg_rating', 'rating_count', 'order_count',
        'delivery_time', 'status', 'active', 'open', 'veg', 'non_veg',
        'featured', 'zone_id', 'module_id',
      ],
      script_fields: (hasGeo && (radiusKm !== undefined || filters?.sort === 'distance')) ? {
        distance_km: {
          script: {
            source: "if (doc['location'].size() == 0) return null; try { return doc['location'].arcDistance(params.lat, params.lon) / 1000.0; } catch (e) { return null; }",
            params: { lat, lon },
          },
        },
      } : undefined,
    };

    // Enhanced store search: Always search for stores by name, category, and items, then merge and sort results
    let allStores: Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number; matchType: string }> = [];
    let totalHits = 0;
    
    // If category_id is provided, find stores that serve items in this category and its children
    if (filters?.category_id) {
      const categoryId = Number(filters.category_id);
      
      // Get all child categories (subcategories) recursively
      let categoryIdsWithChildren: number[] = [];
      try {
        categoryIdsWithChildren = await this.moduleService.getCategoryWithChildren(categoryId, filters?.module_id);
        this.logger.debug(`[searchStoresByModule] Including ${categoryIdsWithChildren.length} categories (parent + children) for category_id ${categoryId}`);
      } catch (error: any) {
        this.logger.warn(`[searchStoresByModule] Failed to get child categories for ${categoryId}: ${error?.message || String(error)}. Using parent category only.`);
        categoryIdsWithChildren = [categoryId];
      }
      
      // Find all items in this category and its children
      const itemsInCategoryBody: any = {
        query: {
          bool: {
            must: [
              categoryIdsWithChildren.length === 1
                ? { term: { category_id: categoryIdsWithChildren[0] } }
                : { terms: { category_id: categoryIdsWithChildren } },
              { term: { status: 1 } } // Only active items
            ]
          }
        },
        size: 1000,
        _source: ['store_id'],
      };
      
      // Apply strict filtering: filter items by module_id if provided
      if (filters?.module_id) {
        itemsInCategoryBody.query.bool.must.push({ term: { module_id: Number(filters.module_id) } });
      }
      
      // When finding stores via category_id, use module-specific indices if module_id is provided for strict filtering
      // Otherwise search in all item indices
      const itemIndicesForCategory = filters?.module_id ? itemIndices : this.getAllItemIndices();
      this.logger.debug(`[searchStoresByModule] Searching for items via category_id in ${itemIndicesForCategory.length} indices: ${itemIndicesForCategory.join(', ')}`);
      
      const itemsInCategoryResults = await Promise.all(
        itemIndicesForCategory.map(index => 
          this.client.search({ index, body: itemsInCategoryBody }).catch(() => ({ body: { hits: { hits: [] } } }))
        )
      );

      const storeIdsFromCategory = new Set<string>();
      itemsInCategoryResults.forEach(res => {
        (res.body.hits?.hits || []).forEach((hit: any) => {
          if (hit._source?.store_id) {
            storeIdsFromCategory.add(String(hit._source.store_id));
          }
        });
      });

      this.logger.debug(`[searchStoresByModule] Found ${storeIdsFromCategory.size} unique store IDs from items in category ${categoryId} (with ${categoryIdsWithChildren.length} categories including children)`);

      if (storeIdsFromCategory.size > 0) {
        // Find stores that have items in this category
        // Don't filter by module_id in the query - we'll filter after fetching (strict filtering)
        // This allows us to find stores that serve items in the specified category
        const categoryStoreFilterClauses = filterClauses.filter(f => {
          // Remove module_id filter, but keep other filters like geo filters
          return !(f.term && f.term.module_id);
        });
        
        const storeResBody: any = {
          query: {
            bool: {
              must: [
                { terms: { id: Array.from(storeIdsFromCategory) } }
              ],
              filter: categoryStoreFilterClauses.length > 0 ? categoryStoreFilterClauses : undefined,
              must_not: mustNotClauses.length > 0 ? mustNotClauses : undefined,
            },
          },
          size: 1000,
          _source: [
            'id', 'name', 'slug', 'phone', 'email',
            'logo', 'cover_photo', 'image', 'images',
            'address', 'location', 'latitude', 'longitude',
            'rating', 'avg_rating', 'rating_count', 'order_count',
            'delivery_time', 'active', 'open', 'veg', 'non_veg',
            'featured', 'zone_id', 'module_id'
          ],
        };
        
        // Don't use geo_distance sort - we'll sort manually by distance later
        // This prevents OpenSearch from filtering out results when location field isn't a geo_point
        storeResBody.sort = [{ order_count: { order: 'desc' } }];
        storeResBody.script_fields = undefined;
        
        // If query is provided, also filter stores by name matching the query
        if (q && q.trim()) {
          storeResBody.query.bool.must.push({
            bool: {
              should: [
                { term: { name: { value: q, boost: 10 } } },
                { term: { slug: { value: q.toLowerCase(), boost: 8 } } },
                { match_phrase: { name: { query: q, boost: 6 } } },
                { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                { multi_match: {
                  query: q,
                  fields: ['name^3', 'slug^2', 'address'],
                  type: 'best_fields',
                  operator: 'and',
                  fuzziness: 'AUTO',
                }},
                { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
              ],
              minimum_should_match: 1,
            },
          });
        }
        
        // When finding stores via category_id, search in all store indices
        // We'll filter stores by module_id after fetching (strict filtering)
        const storeIndicesForCategory = this.getAllStoreIndices();
        this.logger.debug(`[searchStoresByModule] Searching for stores via category_id in ${storeIndicesForCategory.length} indices: ${storeIndicesForCategory.join(', ')}`);
        
        const storeResults = await Promise.all(
          storeIndicesForCategory.map(index => 
            this.client.search({ index, body: storeResBody }).catch(() => ({ body: { hits: { hits: [], total: { value: 0 } } } }))
          )
        );
        
        storeResults.forEach(res => {
          const hits = res.body.hits?.hits || [];
          totalHits += res.body.hits?.total?.value ?? 0;
          hits.forEach((h: any) => {
            allStores.push({ ...h, matchType: q && q.trim() ? 'category_name' : 'category' });
          });
        });
        
        this.logger.debug(`[searchStoresByModule] Found ${allStores.length} stores via category_id ${categoryId} (totalHits: ${totalHits})`);
      } else {
        this.logger.warn(`[searchStoresByModule] No stores found for category_id ${categoryId} - no items found in this category`);
      }
    } else if (!q || !q.trim()) {
      // No query and no category_id - return all stores matching filters (module_id, store_id)
      this.logger.log(`[searchStoresByModule] No query provided, returning all stores matching filters: module_id=${filters?.module_id}, store_id=${filters?.store_id}`);
      
      const allStoresBody: any = {
        query: {
          bool: {
            must: [],
            filter: filterClauses.length > 0 ? filterClauses : undefined,
            must_not: mustNotClauses.length > 0 ? mustNotClauses : undefined,
          },
        },
        size: 1000,
        _source: [
          'id', 'name', 'slug', 'phone', 'email',
          'logo', 'cover_photo', 'image', 'images',
          'address', 'location', 'latitude', 'longitude',
          'rating', 'avg_rating', 'rating_count', 'order_count',
          'delivery_time', 'active', 'open', 'veg', 'non_veg',
          'featured', 'zone_id', 'module_id'
        ],
      };
      
      // If no filters, return all stores (match_all)
      if (filterClauses.length === 0 && (!filters?.module_id && !filters?.store_id)) {
        allStoresBody.query = { match_all: {} };
      }
      
      // Don't use geo_distance sort - we'll sort manually by distance later
      allStoresBody.sort = [{ order_count: { order: 'desc' } }];
      allStoresBody.script_fields = undefined;
      
      const allStoresResults = await Promise.all(
        storeIndices.map(index => 
          this.client.search({ index, body: allStoresBody }).catch(() => ({ body: { hits: { hits: [], total: { value: 0 } } } }))
        )
      );
      
      allStoresResults.forEach(res => {
        const hits = res.body.hits?.hits || [];
        totalHits += res.body.hits?.total?.value ?? 0;
        hits.forEach((h: any) => {
          allStores.push({ ...h, matchType: 'name' });
        });
      });
      
      this.logger.debug(`[searchStoresByModule] Found ${allStores.length} stores without query (totalHits: ${totalHits})`);
      
      // If module_id is provided, also find stores via items in that module
      if (filters?.module_id && allStores.length === 0) {
        this.logger.debug(`[searchStoresByModule] No stores found directly, searching for stores via items in module ${filters.module_id}`);
        
        const itemsInModuleBody: any = {
          query: {
            bool: {
              must: [
                { term: { module_id: Number(filters.module_id) } },
                { term: { status: 1 } }
              ]
            }
          },
          size: 1000,
          _source: ['store_id'],
        };
        
        const itemIndicesForModule = filters?.module_id ? itemIndices : this.getAllItemIndices();
        const itemsInModuleResults = await Promise.all(
          itemIndicesForModule.map(index => 
            this.client.search({ index, body: itemsInModuleBody }).catch(() => ({ body: { hits: { hits: [] } } }))
          )
        );
        
        const storeIdsFromItems = new Set<string>();
        itemsInModuleResults.forEach(res => {
          (res.body.hits?.hits || []).forEach((hit: any) => {
            if (hit._source?.store_id) {
              storeIdsFromItems.add(String(hit._source.store_id));
            }
          });
        });
        
        if (storeIdsFromItems.size > 0) {
          const storesViaItemsBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { id: Array.from(storeIdsFromItems) } }
                ],
                filter: filterClauses.filter(f => !(f.term && f.term.module_id)),
                must_not: mustNotClauses.length > 0 ? mustNotClauses : undefined,
              },
            },
            size: 1000,
            _source: [
              'id', 'name', 'slug', 'phone', 'email',
              'logo', 'cover_photo', 'image', 'images',
              'address', 'location', 'latitude', 'longitude',
              'rating', 'avg_rating', 'rating_count', 'order_count',
              'delivery_time', 'active', 'open', 'veg', 'non_veg',
              'featured', 'zone_id', 'module_id'
            ],
            sort: [{ order_count: { order: 'desc' } }],
          };
          
          const allStoreIndicesForModule = this.getAllStoreIndices();
          const storesViaItemsResults = await Promise.all(
            allStoreIndicesForModule.map(index => 
              this.client.search({ index, body: storesViaItemsBody }).catch(() => ({ body: { hits: { hits: [], total: { value: 0 } } } }))
            )
          );
          
          storesViaItemsResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            totalHits += res.body.hits?.total?.value ?? 0;
            hits.forEach((h: any) => {
              allStores.push({ ...h, matchType: 'item' });
            });
          });
          
          this.logger.debug(`[searchStoresByModule] Found ${allStores.length} stores via items in module ${filters.module_id} (totalHits: ${totalHits})`);
        }
      }
    } else if (q && q.trim()) {
      // No category_id, but has query - use enhanced search
      this.logger.log(`[searchStoresByModule] Enhanced search: query="${q}", searching ${storeIndices.length} store indices`);
      try {
        // Use the indices determined at the beginning of the method
        
        // Create a body without geo_distance sort for initial search (we'll sort by distance manually later)
        // This prevents OpenSearch from filtering out results when location field isn't a geo_point
        const initialSearchBody: any = {
          ...body,
          sort: [{ order_count: { order: 'desc' } }], // Use popularity sort for initial search
          script_fields: undefined, // Don't use script_fields in initial search
        };
        
        // 1. Store name matches (initial search)
        this.logger.debug(`[searchStoresByModule] Step 1: Searching stores by name matching "${q}"`);
        const initialResults = await Promise.all(
          storeIndices.map(async (index) => {
            try {
              this.logger.debug(`[searchStoresByModule] Searching index ${index} for stores matching "${q}"`);
              const result = await this.client.search({ index, body: initialSearchBody });
              this.logger.log(`[searchStoresByModule] Index ${index}: found ${result.body.hits?.total?.value || 0} stores matching "${q}"`);
              return result;
            } catch (err: any) {
              // Handle index not found gracefully - this is expected if indices don't exist yet
              if (err?.message?.includes('index_not_found') || err?.message?.includes('no such index')) {
                this.logger.debug(`[searchStoresByModule] Index ${index} does not exist yet (this is OK if data hasn't been indexed)`);
              } else {
                this.logger.error(`[searchStoresByModule] Search failed on index ${index}: ${err?.message || String(err)}`);
              }
              return { body: { hits: { hits: [], total: { value: 0 } } } };
            }
          })
        );
        
        initialResults.forEach(res => {
          const hits = res.body.hits?.hits || [];
          totalHits += res.body.hits?.total?.value ?? 0;
          hits.forEach((h: any) => {
            allStores.push({ ...h, matchType: 'name' });
          });
        });
        
        // 2. Category matches - find categories matching the query
        const catBody: any = {
          query: {
            bool: {
              should: [
                { match: { name: { query: q, boost: 3 } } },
                { match_phrase_prefix: { name: { query: q, boost: 2 } } },
                { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
              ],
              minimum_should_match: 1,
            },
          },
          size: 100,
          _source: ['id'],
        };
        
        // Add module filter to category search if provided
        if (filters?.module_id) {
          catBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
        }
        
        const catResults = await Promise.all(
          catIndices.map(index => 
            this.client.search({ index, body: catBody }).catch(() => ({ body: { hits: { hits: [] } } }))
          )
        );

        const matchingCategoryIds = new Set<string>();
        catResults.forEach(res => {
          (res.body.hits?.hits || []).forEach((hit: any) => {
            if (hit._id) matchingCategoryIds.add(String(hit._id));
          });
        });
        
        if (matchingCategoryIds.size > 0) {
          // Find items in these categories
          const itemsInCategoriesBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { category_id: Array.from(matchingCategoryIds) } },
                  { term: { status: 1 } } // Only active items
                ]
              }
            },
            size: 1000,
            _source: ['store_id'],
          };
          
          // Add module filter if provided
          if (filters?.module_id) {
            itemsInCategoriesBody.query.bool.must.push({ term: { module_id: Number(filters.module_id) } });
          }
          
          const itemsInCategoriesResults = await Promise.all(
            itemIndices.map(index => 
              this.client.search({ index, body: itemsInCategoriesBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );

          const storeIdsFromCategories = new Set<string>();
          itemsInCategoriesResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._source?.store_id) {
                storeIdsFromCategories.add(String(hit._source.store_id));
              }
            });
          });

          if (storeIdsFromCategories.size > 0) {
            // Find stores that have items in these categories
            const storeResBody: any = {
              query: {
                bool: {
                  must: [
                    { terms: { id: Array.from(storeIdsFromCategories) } }
                  ],
                  filter: filterClauses,
                  must_not: mustNotClauses.length > 0 ? mustNotClauses : undefined,
                },
              },
              size: 100,
              _source: [
                'id', 'name', 'slug', 'phone', 'email',
                'logo', 'cover_photo', 'image', 'images',
                'address', 'location', 'latitude', 'longitude',
                'rating', 'avg_rating', 'rating_count', 'order_count',
                'delivery_time', 'active', 'open', 'veg', 'non_veg',
                'featured', 'zone_id', 'module_id'
              ],
            };
            
            // Don't use geo_distance sort in enhanced search - we'll sort manually by distance later
            // This prevents OpenSearch from filtering out results when location field isn't a geo_point
            storeResBody.sort = [{ order_count: { order: 'desc' } }];
            storeResBody.script_fields = undefined;
            
            const storeResults = await Promise.all(
              storeIndices.map(index => 
                this.client.search({ index, body: storeResBody }).catch(() => ({ body: { hits: { hits: [] } } }))
              )
            );
            
            storeResults.forEach(res => {
              (res.body.hits?.hits || []).forEach((h: any) => {
                allStores.push({ ...h, matchType: 'category' });
              });
            });
          }
        }

        // 3. Item matches - find items matching the query
        const itemBody: any = {
          query: {
            bool: {
              should: [
                { multi_match: { query: q, fields: ['name^3', 'category_name^2'], type: 'best_fields' } },
                { multi_match: { query: q, fields: ['name^2'], type: 'phrase_prefix' } },
                { wildcard: { name: { value: `*${q.toLowerCase()}*` } } },
              ],
              minimum_should_match: 1,
            },
          },
          size: 1000,
          _source: ['store_id'],
        };
        
        // Add module filter if provided
        if (filters?.module_id) {
          itemBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
        }
        
        const itemResults = await Promise.all(
          itemIndices.map(index => 
            this.client.search({ index, body: itemBody }).catch(() => ({ body: { hits: { hits: [] } } }))
          )
        );

        const matchingStoreIds = new Set<string>();
        itemResults.forEach(res => {
          (res.body.hits?.hits || []).forEach((hit: any) => {
            if (hit._source?.store_id) {
              matchingStoreIds.add(String(hit._source.store_id));
            }
          });
        });

        if (matchingStoreIds.size > 0) {
          const storeResBody: any = {
            query: {
              bool: {
                must: [{ terms: { id: Array.from(matchingStoreIds) } }],
                filter: filterClauses,
              },
            },
            size: 100,
            _source: [
              'id', 'name', 'slug', 'phone', 'email',
              'logo', 'cover_photo', 'image', 'images',
              'address', 'location', 'latitude', 'longitude',
              'rating', 'avg_rating', 'rating_count', 'order_count',
              'delivery_time', 'active', 'open', 'veg', 'non_veg',
              'featured', 'zone_id', 'module_id'
            ],
          };
          
          // Don't use geo_distance sort in enhanced search - we'll sort manually by distance later
          // This prevents OpenSearch from filtering out results when location field isn't a geo_point
          storeResBody.sort = [{ order_count: { order: 'desc' } }];
          storeResBody.script_fields = undefined;
          
          const storeResults = await Promise.all(
            storeIndices.map(index => 
              this.client.search({ index, body: storeResBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          storeResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((h: any) => {
              allStores.push({ ...h, matchType: 'item' });
            });
          });
        }

        // Remove duplicates and sort by match type priority with proper scoring
        const seenStores = new Set<string>();
        const sortedStores: Array<{ _id: string; _source: any; fields?: any; sort?: any[]; _score?: number; matchType: string }> = [];
        
        // Priority order: name > category > item
        const matchTypeOrder = { 'name': 1, 'category': 2, 'item': 3 };
        const matchTypeScore = { 'name': 1000, 'category': 100, 'item': 10 };
        
        allStores
          .sort((a, b) => {
            const aOrder = matchTypeOrder[a.matchType as keyof typeof matchTypeOrder] || 999;
            const bOrder = matchTypeOrder[b.matchType as keyof typeof matchTypeOrder] || 999;
            
            if (aOrder !== bOrder) {
              return aOrder - bOrder;
            }
            
            // Within same match type, sort by score
            return (b._score || 0) - (a._score || 0);
          })
          .forEach(store => {
            if (!seenStores.has(store._id)) {
              seenStores.add(store._id);
              // Apply match type scoring
              const baseScore = store._score || 0;
              const matchTypeBoost = matchTypeScore[store.matchType as keyof typeof matchTypeScore] || 1;
              store._score = baseScore + matchTypeBoost;
              sortedStores.push(store);
            }
          });
        
        allStores = sortedStores;
        totalHits = sortedStores.length;
        
      } catch (error: any) {
        this.logger.error(`Enhanced store search failed: ${error?.message || String(error)}`, error?.stack);
        // Fallback to original search
        const results = await Promise.all(
          storeIndices.map(index => 
            this.client.search({ index, body }).catch((err: any) => {
              this.logger.warn(`Search failed on index ${index}: ${err?.message || String(err)}`);
              return { body: { hits: { hits: [], total: { value: 0 } } } };
            })
          )
        );
        
        allStores = [];
        results.forEach((res: any, idx: number) => {
          const hits = res.body.hits?.hits || [];
          totalHits += res.body.hits?.total?.value ?? 0;
          this.logger.debug(`Index ${storeIndices[idx]}: found ${hits.length} stores`);
          hits.forEach((h: any) => {
            allStores.push({ ...h, matchType: 'name' });
          });
        });
      }
    } else {
      // No query and no category_id, use simple search
      this.logger.log(`[searchStoresByModule] Simple search: no query, no category_id, searching ${storeIndices.length} indices`);
      
      // Create a body without geo_distance sort when radius_km is not provided
      // This prevents OpenSearch from filtering out results when location field isn't a geo_point
      const simpleSearchBody: any = {
        ...body,
      };
      
      // Only use geo_distance sort if radius_km is provided
      if (!(hasGeo && radiusKm !== undefined && !Number.isNaN(radiusKm) && radiusKm > 0) && !(hasGeo && filters?.sort === 'distance')) {
        simpleSearchBody.sort = [{ order_count: { order: 'desc' } }];
        simpleSearchBody.script_fields = undefined;
      }
      
      this.logger.debug(`[searchStoresByModule] Search query body: ${JSON.stringify(simpleSearchBody, null, 2).substring(0, 1000)}`);
      
      const results = await Promise.all(
        storeIndices.map(async (index) => {
          try {
            this.logger.debug(`[searchStoresByModule] Searching index: ${index}`);
            const result = await this.client.search({ index, body: simpleSearchBody });
            this.logger.log(`[searchStoresByModule] Index ${index}: found ${result.body.hits?.total?.value || 0} total, ${result.body.hits?.hits?.length || 0} in response`);
            return result;
          } catch (err: any) {
            this.logger.error(`[searchStoresByModule] Search failed on index ${index}: ${err?.message || String(err)}`, err?.stack);
            return { body: { hits: { hits: [], total: { value: 0 } } } };
          }
        })
      );
      
      results.forEach((res: any, idx: number) => {
        const hits = res.body.hits?.hits || [];
        const indexTotal = res.body.hits?.total?.value ?? 0;
        totalHits += indexTotal;
        this.logger.log(`[searchStoresByModule] Index ${storeIndices[idx]}: ${hits.length} hits (total: ${indexTotal})`);
        hits.forEach((h: any) => {
          allStores.push({ ...h, matchType: 'name' });
        });
      });
    }
    
    this.logger.log(`[searchStoresByModule] Total stores found: ${allStores.length} (totalHits: ${totalHits})`);
    
    // Process and format stores
    let stores = allStores.map(h => {
      const src: any = h._source || {};
      let distance = (h.fields && (h.fields as any).distance_km && (h.fields as any).distance_km[0]) ?? undefined;
      
      // Always calculate distance if location is provided (even if already calculated from script_fields)
      // This ensures we have distance for all stores when lat/lon are provided
      if (hasGeo) {
        // If not already calculated, calculate it manually
        if (!distance) {
          let storeLat: number | undefined;
          let storeLon: number | undefined;
          
          // Try different location field formats
          if (src.latitude && src.longitude) {
            storeLat = parseFloat(String(src.latitude));
            storeLon = parseFloat(String(src.longitude));
          } else if (src.location?.lat && src.location?.lon) {
            storeLat = parseFloat(String(src.location.lat));
            storeLon = parseFloat(String(src.location.lon));
          } else if (Array.isArray(src.location) && src.location.length === 2) {
            // GeoJSON format: [lon, lat]
            storeLon = parseFloat(String(src.location[0]));
            storeLat = parseFloat(String(src.location[1]));
          }
          
          if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
            distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
          }
        }
      }

      // Recalculate delivery time if distance is available
      let deliveryTime = src.delivery_time;
      if (distance !== undefined && distance !== null && src.delivery_time) {
        const travelTimeMinutes = this.calculateTravelTime(distance);
        deliveryTime = this.recalculateDeliveryTime(src.delivery_time, travelTimeMinutes);
      }
      
      // Format address with distance: "{distance_km}km | {address}"
      let formattedAddress = src.address || null;
      if (hasGeo && distance !== undefined && distance !== null && !Number.isNaN(distance) && distance !== Infinity) {
        const distanceStr = distance.toFixed(2);
        if (src.address) {
          formattedAddress = `${distanceStr}km | ${src.address}`;
        } else {
          formattedAddress = `${distanceStr}km`;
        }
      }
      
      // Ensure cover_photo is included (use image as fallback if cover_photo doesn't exist)
      let coverPhoto = src.cover_photo || null;
      if (!coverPhoto && src.image) {
        coverPhoto = src.image;
      }
      
      return { 
        id: h._id, 
        score: h._score, 
        distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? Infinity : 0), 
        ...src,
        address: formattedAddress, // Use formatted address
        cover_photo: coverPhoto, // Ensure cover_photo is included
        delivery_time: deliveryTime,
        matchType: h.matchType || 'name', // Preserve matchType from hit object
        // Ensure required fields have safe defaults
        phone: src.phone || null,
        email: src.email || null,
        active: src.active !== undefined ? src.active : true,
        open: src.open !== undefined ? src.open : 1,
        veg: src.veg !== undefined ? src.veg : null,
        non_veg: src.non_veg !== undefined ? src.non_veg : null,
        featured: src.featured !== undefined ? src.featured : 0,
        rating_count: src.rating_count || src.order_count || 0,
        avg_rating: src.avg_rating || src.rating || 0,
        rating: src.rating || src.avg_rating || 0,
      };
    });

    // Sort combined results
    // IMPORTANT UX RULE:
    // - If the user typed a query (q), keep relevance ordering (name/category/item priority).
    // - Only sort by distance when explicitly requested via sort=distance, or when browsing (no q).
    const hasQuery = !!(q && q.trim());
    const explicitSort = typeof filters?.sort === 'string' && filters.sort.trim().length ? filters.sort.trim() : undefined;

    if (hasGeo && explicitSort === 'distance') {
      // User explicitly requested distance ordering.
      stores.sort((a, b) => {
        const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
        const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
        if (distA !== distB) return distA - distB;
        return (b.order_count || 0) - (a.order_count || 0);
      });
    } else if (!hasQuery) {
      // Browsing mode: sort by proximity if we have geo, otherwise popularity.
      if (hasGeo) {
        stores.sort((a, b) => {
          const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
          const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
          if (distA !== distB) return distA - distB;
          return (b.order_count || 0) - (a.order_count || 0);
        });
      } else if (sortOrder === 'popularity') {
        stores.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
      }
    }

    // Apply strict filtering: if module_id is provided, prioritize stores with matching module_id
    // But keep stores found via items in that module, even if store's module_id differs
    // This handles cases where items in module 5 are served by stores with module_id=6
    if (filters?.module_id) {
      const requestedModuleId = Number(filters.module_id);
      const beforeFilterCount = stores.length;
      
      // Separate stores by matchType and module_id
      const storesWithMatchingModuleId = stores.filter((store: any) => {
        if (store.module_id !== undefined && store.module_id !== null) {
          return Number(store.module_id) === requestedModuleId;
        }
        return false;
      });
      
      // Keep stores found via items in the specified module, even if store's module_id differs
      // This is because if items in module 5 exist, stores serving them are relevant
      const storesFromItems = stores.filter((store: any) => {
        return store.matchType === 'item' || store.matchType === 'category';
      });
      
      // Combine: stores with matching module_id + stores found via items in that module
      const combinedStoreIds = new Set<string>();
      storesWithMatchingModuleId.forEach((store: any) => {
        combinedStoreIds.add(String(store.id));
      });
      storesFromItems.forEach((store: any) => {
        combinedStoreIds.add(String(store.id));
      });
      
      stores = stores.filter((store: any) => {
        return combinedStoreIds.has(String(store.id));
      });
      
      // Update totalHits to reflect filtered count
      totalHits = stores.length;
      this.logger.debug(`[searchStoresByModule] Filtered stores by module_id ${requestedModuleId}: ${beforeFilterCount} -> ${stores.length} (kept ${storesWithMatchingModuleId.length} with matching module_id, ${storesFromItems.length} from items/categories)`);
    }
    
    if (filters?.store_id) {
      const requestedStoreId = Number(filters.store_id);
      const beforeFilterCount = stores.length;
      stores = stores.filter((store: any) => {
        const storeId = store.id ? Number(store.id) : null;
        return storeId === requestedStoreId;
      });
      // Update totalHits to reflect filtered count
      totalHits = stores.length;
      this.logger.debug(`[searchStoresByModule] Filtered stores by store_id ${requestedStoreId}: ${beforeFilterCount} -> ${stores.length}`);
    }


    // Fallback for geo radius filtering:
    // If the caller sent radius_km (the UI does by default when "Located"),
    // and we found zero stores, retry without radius filtering so users still see stores.
    // Keep distance ordering in the retry.
    const radiusKmForFallback = typeof (filters as any)?.radius_km === 'number' ? (filters as any).radius_km : undefined;
    const alreadyRetriedWithoutRadius = Boolean((filters as any)?.__radius_fallback);
    if (!alreadyRetriedWithoutRadius && stores.length === 0 && hasGeo && radiusKmForFallback !== undefined && !Number.isNaN(radiusKmForFallback) && radiusKmForFallback > 0) {
      this.logger.warn(`[searchStoresByModule] 0 stores within radius_km=${radiusKmForFallback}; retrying without radius filter (distance sort)`);
      const { radius_km: _omitRadius, __radius_fallback: _omitFlag, ...rest } = (filters as any);
      return this.searchStoresByModule(q, { ...rest, sort: 'distance', __radius_fallback: true });
    }
    // If no stores found and we have a query, try searching for items and categories, then return stores that serve them
    if (stores.length === 0 && q && q.trim()) {
      try {
        this.logger.debug(`[searchStoresByModule] Stores empty, searching via items/categories for query: ${q}`);
        
        const matchingStoreIds = new Set<string>();
        const matchingCategoryIds = new Set<string>();
        
        // Only search categories if category_id filter is not provided (if category_id is provided, we should only search within that category)
        if (!filters?.category_id) {
          // Search for categories matching the query
          const categoryBody: any = {
            query: {
              bool: {
                should: [
                  { match: { name: { query: q, boost: 10, operator: 'and' } } },
                  { match: { slug: { query: q.toLowerCase(), boost: 8, operator: 'and' } } },
                  { match_phrase: { name: { query: q, boost: 6 } } },
                  { match_phrase: { slug: { query: q.toLowerCase(), boost: 5 } } },
                  { multi_match: {
                    query: q,
                    fields: ['name^3', 'slug^2'],
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                  }},
                  { wildcard: { name: { value: `*${q.toLowerCase()}*`, boost: 2 } } },
                  { wildcard: { slug: { value: `*${q.toLowerCase()}*`, boost: 1.5 } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 50, // Limit to top 50 categories
            _source: ['id'],
          };
          
          // Add module filter if provided
          if (filters?.module_id) {
            categoryBody.query.bool.filter = [{ term: { module_id: Number(filters.module_id) } }];
          }
          
          const categoryResults = await Promise.all(
            catIndices.map(index => 
              this.client.search({ index, body: categoryBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          categoryResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              // Try _source.id first (the actual category ID), then fallback to _id
              const categoryId = hit._source?.id || hit._id;
              if (categoryId) {
                matchingCategoryIds.add(String(categoryId));
              }
            });
          });
          
          this.logger.debug(`[searchStoresByModule] Found ${matchingCategoryIds.size} categories matching query: ${Array.from(matchingCategoryIds).slice(0, 10).join(', ')}`);
        } else {
          // If category_id is provided, use it and its children
          try {
            const categoryIdsWithChildren = await this.moduleService.getCategoryWithChildren(
              Number(filters.category_id),
              filters?.module_id
            );
            categoryIdsWithChildren.forEach(id => matchingCategoryIds.add(String(id)));
            this.logger.debug(`[searchStoresByModule] Using provided category_id ${filters.category_id} with ${categoryIdsWithChildren.length - 1} child categories (total: ${categoryIdsWithChildren.length})`);
          } catch (error: any) {
            this.logger.warn(`[searchStoresByModule] Failed to get child categories: ${error?.message || String(error)}. Using parent category only.`);
            matchingCategoryIds.add(String(filters.category_id));
          }
        }
        
        // Search for items matching the query
        // Split query into words for better matching (e.g., "Elaichi/Cardamom Powder 25g" -> ["Elaichi", "Cardamom", "Powder"])
        const queryWords = q.split(/[\s\/\-_]+/).filter(word => word.length > 0 && !/^\d+$/.test(word)); // Remove pure numbers
        const cleanQuery = queryWords.join(' ');
        
        const itemBody: any = {
          query: {
            bool: {
              should: [
                // Exact phrase match
                { match_phrase: { name: { query: q, boost: 10 } } },
                // Match all words (but more flexible)
                { match: { name: { query: cleanQuery, boost: 8, operator: 'or' } } },
                // Match individual words
                ...queryWords.map((word: string) => ({ 
                  match: { name: { query: word, boost: 5, operator: 'or' } } 
                })),
                // Multi-match across fields
                { multi_match: {
                  query: cleanQuery,
                  fields: ['name^3', 'category_name^2', 'description'],
                  type: 'best_fields',
                  operator: 'or',
                  fuzziness: 'AUTO',
                }},
                // Wildcard matches
                { wildcard: { name: { value: `*${q.toLowerCase().replace(/[\/\-_]/g, '*')}*`, boost: 3 } } },
                ...queryWords.map((word: string) => ({ 
                  wildcard: { name: { value: `*${word.toLowerCase()}*`, boost: 2 } } 
                })),
              ],
              minimum_should_match: 1,
            },
          },
          size: 500, // Increased limit to find more items
          _source: ['store_id', 'category_id'],
        };
        
        // Apply strict filtering: filter items by module_id and category_id if provided
        const itemFilterClauses: any[] = [];
        
        // Filter by module_id if provided (strict filtering)
        if (filters?.module_id) {
          itemFilterClauses.push({ term: { module_id: Number(filters.module_id) } });
        }
        
        // Filter items by categories (matchingCategoryIds already includes parent + children if category_id was provided)
        if (matchingCategoryIds.size > 0) {
          const categoryIdNumbers = Array.from(matchingCategoryIds).map(id => Number(id)).filter(id => !Number.isNaN(id));
          if (categoryIdNumbers.length === 1) {
            itemFilterClauses.push({ term: { category_id: categoryIdNumbers[0] } });
          } else {
            itemFilterClauses.push({ terms: { category_id: categoryIdNumbers } });
          }
        }
        
        if (itemFilterClauses.length > 0) {
          itemBody.query.bool.filter = itemFilterClauses;
        }
        
        // For fallback, use module-specific indices if module_id is provided for strict filtering
        // Otherwise search in all item indices
        const fallbackItemIndices = filters?.module_id ? itemIndices : this.getAllItemIndices();
        this.logger.debug(`[searchStoresByModule] Searching for items in ${fallbackItemIndices.length} indices: ${fallbackItemIndices.join(', ')}`);
        
        const itemResults = await Promise.all(
          fallbackItemIndices.map(index => 
            this.client.search({ index, body: itemBody }).catch(() => ({ body: { hits: { hits: [] } } }))
          )
        );
        
        itemResults.forEach(res => {
          (res.body.hits?.hits || []).forEach((hit: any) => {
            if (hit._source?.store_id) {
              matchingStoreIds.add(String(hit._source.store_id));
            }
            // Also collect category IDs from items
            if (hit._source?.category_id && !filters?.category_id) {
              matchingCategoryIds.add(String(hit._source.category_id));
            }
          });
        });
        
        this.logger.debug(`[searchStoresByModule] Found ${matchingStoreIds.size} store IDs from items: ${Array.from(matchingStoreIds).slice(0, 10).join(', ')}`);
        
        // If we found very few stores, also try searching for just the first significant word
        // This helps when the full query is too specific (e.g., "Elaichi/Cardamom Powder 25g" -> search for "Elaichi")
        if (matchingStoreIds.size < 3 && queryWords.length > 0) {
          const firstWord = queryWords[0]; // Get the first significant word
          this.logger.debug(`[searchStoresByModule] Found only ${matchingStoreIds.size} stores, also searching for first word: ${firstWord}`);
          
          const firstWordItemBody: any = {
            query: {
              bool: {
                should: [
                  { match: { name: { query: firstWord, boost: 5, operator: 'or' } } },
                  { wildcard: { name: { value: `*${firstWord.toLowerCase()}*`, boost: 3 } } },
                ],
                minimum_should_match: 1,
              },
            },
            size: 200,
            _source: ['store_id', 'category_id'],
          };
          
          // Apply strict filtering: filter by module_id and category_id if provided
          const firstWordFilterClauses: any[] = [];
          
          // Filter by module_id if provided (strict filtering)
          if (filters?.module_id) {
            firstWordFilterClauses.push({ term: { module_id: Number(filters.module_id) } });
          }
          
          if (filters?.category_id) {
            // Include child categories (subcategories)
            let firstWordCategoryIds: number[] = [];
            try {
              firstWordCategoryIds = await this.moduleService.getCategoryWithChildren(
                Number(filters.category_id),
                filters?.module_id
              );
            } catch (error: any) {
              this.logger.warn(`[searchStoresByModule] Failed to get child categories for first word search: ${error?.message || String(error)}`);
              firstWordCategoryIds = [Number(filters.category_id)];
            }
            
            if (firstWordCategoryIds.length === 1) {
              firstWordFilterClauses.push({ term: { category_id: firstWordCategoryIds[0] } });
            } else {
              firstWordFilterClauses.push({ terms: { category_id: firstWordCategoryIds } });
            }
          }
          
          if (firstWordFilterClauses.length > 0) {
            firstWordItemBody.query.bool.filter = firstWordFilterClauses;
          }
          
          // Use module-specific indices if module_id is provided for strict filtering
          const firstWordItemIndices = filters?.module_id ? itemIndices : this.getAllItemIndices();
          
          const firstWordItemResults = await Promise.all(
            firstWordItemIndices.map(index => 
              this.client.search({ index, body: firstWordItemBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          firstWordItemResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._source?.store_id) {
                matchingStoreIds.add(String(hit._source.store_id));
              }
            });
          });
          
          this.logger.debug(`[searchStoresByModule] After first word search, found ${matchingStoreIds.size} store IDs: ${Array.from(matchingStoreIds).slice(0, 10).join(', ')}`);
        }
        
        // If we found categories but no stores from items, find stores via categories
        if (matchingCategoryIds.size > 0 && matchingStoreIds.size === 0) {
          const categoryItemsBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { category_id: Array.from(matchingCategoryIds).map(id => Number(id)).filter(id => !Number.isNaN(id)) } },
                  { term: { status: 1 } }
                ],
                filter: []
              }
            },
            size: 1000,
            _source: ['store_id'],
          };
          
          // Apply strict filtering: filter by module_id if provided
          if (filters?.module_id) {
            categoryItemsBody.query.bool.filter.push({ term: { module_id: Number(filters.module_id) } });
          }
          
          // Use module-specific indices if module_id is provided for strict filtering
          const categoryItemIndices = filters?.module_id ? itemIndices : this.getAllItemIndices();
          
          const categoryItemsResults = await Promise.all(
            categoryItemIndices.map(index => 
              this.client.search({ index, body: categoryItemsBody }).catch(() => ({ body: { hits: { hits: [] } } }))
            )
          );
          
          categoryItemsResults.forEach(res => {
            (res.body.hits?.hits || []).forEach((hit: any) => {
              if (hit._source?.store_id) {
                matchingStoreIds.add(String(hit._source.store_id));
              }
            });
          });
          
          this.logger.debug(`[searchStoresByModule] Found ${matchingStoreIds.size} store IDs from categories: ${Array.from(matchingStoreIds).slice(0, 10).join(', ')}`);
        }
        
        // If we found stores, fetch them
        if (matchingStoreIds.size > 0) {
          const storeIdNumbers = Array.from(matchingStoreIds).map(id => Number(id)).filter(id => !Number.isNaN(id));
          
          // For fallback, don't filter by module_id in the query
          // We'll filter stores by module_id after fetching (strict filtering)
          // This allows us to find stores that serve items in the specified module
          const fallbackStoreFilterClauses = filterClauses.filter(f => {
            // Remove module_id filter, but keep other filters like geo filters
            return !(f.term && f.term.module_id);
          });
          
          const fallbackStoreBody: any = {
            query: {
              bool: {
                must: [
                  { terms: { id: storeIdNumbers } }
                ],
                filter: fallbackStoreFilterClauses.length > 0 ? fallbackStoreFilterClauses : undefined,
              },
            },
            size: size * 2, // Get more stores to ensure we have enough after filtering
            sort: [{ order_count: { order: 'desc' } }],
            _source: [
              'id', 'name', 'slug', 'phone', 'email',
              'logo', 'cover_photo', 'image', 'images',
              'address', 'location', 'latitude', 'longitude',
              'rating', 'avg_rating', 'rating_count', 'order_count',
              'delivery_time', 'active', 'open', 'veg', 'non_veg',
              'featured', 'zone_id', 'module_id'
            ],
          };
          
          this.logger.debug(`[searchStoresByModule] Fallback store query: ${JSON.stringify(fallbackStoreBody.query).substring(0, 200)}`);
          
          // For fallback, search in all store indices to find stores that serve items in the specified module
          // We'll filter stores by module_id after fetching (strict filtering)
          const fallbackStoreIndices = this.getAllStoreIndices();
          this.logger.debug(`[searchStoresByModule] Searching for stores in ${fallbackStoreIndices.length} indices: ${fallbackStoreIndices.join(', ')}`);
          
          const fallbackStoreResults = await Promise.all(
            fallbackStoreIndices.map(async (index) => {
              try {
                const result = await this.client.search({ index, body: fallbackStoreBody });
                this.logger.debug(`[searchStoresByModule] Index ${index}: found ${result.body.hits?.total?.value || 0} fallback stores`);
                return result;
              } catch (err: any) {
                this.logger.warn(`[searchStoresByModule] Search failed on index ${index}: ${err?.message || String(err)}`);
                return { body: { hits: { hits: [] } } };
              }
            })
          );
          
          const fallbackStores: any[] = [];
          fallbackStoreResults.forEach(res => {
            const hits = res.body.hits?.hits || [];
            totalHits += res.body.hits?.total?.value ?? 0;
            hits.forEach((h: any) => {
              const source = h._source || {};
              let distance: number | undefined;
              
              if (hasGeo) {
                let storeLat: number | undefined;
                let storeLon: number | undefined;
                
                if (source.latitude && source.longitude) {
                  storeLat = parseFloat(String(source.latitude));
                  storeLon = parseFloat(String(source.longitude));
                } else if (source.location?.lat && source.location?.lon) {
                  storeLat = parseFloat(String(source.location.lat));
                  storeLon = parseFloat(String(source.location.lon));
                } else if (Array.isArray(source.location) && source.location.length === 2) {
                  storeLon = parseFloat(String(source.location[0]));
                  storeLat = parseFloat(String(source.location[1]));
                }
                
                if (storeLat !== undefined && !Number.isNaN(storeLat) && storeLon !== undefined && !Number.isNaN(storeLon)) {
                  distance = this.calculateDistance(lat!, lon!, storeLat, storeLon);
                }
              }
              
              // Recalculate delivery time if distance is available
              let deliveryTime = source.delivery_time;
              if (distance !== undefined && distance !== null && source.delivery_time) {
                const travelTimeMinutes = this.calculateTravelTime(distance);
                deliveryTime = this.recalculateDeliveryTime(source.delivery_time, travelTimeMinutes);
              }
              
              // Format address with distance: "{distance_km}km | {address}"
              let formattedAddress = source.address || null;
              if (hasGeo && distance !== undefined && distance !== null && !Number.isNaN(distance) && distance !== Infinity) {
                const distanceStr = distance.toFixed(2);
                if (source.address) {
                  formattedAddress = `${distanceStr}km | ${source.address}`;
                } else {
                  formattedAddress = `${distanceStr}km`;
                }
              }
              
              // Ensure cover_photo is included (use image as fallback if cover_photo doesn't exist)
              let coverPhoto = source.cover_photo || null;
              if (!coverPhoto && source.image) {
                coverPhoto = source.image;
              }
              
              const storeObj: any = {
                id: h._id,
                score: h._score,
                distance_km: distance !== undefined && distance !== null ? distance : (hasGeo ? Infinity : undefined),
                ...source,
                address: formattedAddress, // Use formatted address
                cover_photo: coverPhoto, // Ensure cover_photo is included
                delivery_time: deliveryTime,
                matchType: 'item', // Mark as found via items
                // Ensure required fields have safe defaults
                phone: source.phone || null,
                email: source.email || null,
                active: source.active !== undefined ? source.active : true,
                open: source.open !== undefined ? source.open : 1,
                veg: source.veg !== undefined ? source.veg : null,
                non_veg: source.non_veg !== undefined ? source.non_veg : null,
                featured: source.featured !== undefined ? source.featured : 0,
                rating_count: source.rating_count || source.order_count || 0,
                avg_rating: source.avg_rating || source.rating || 0,
                rating: source.rating || source.avg_rating || 0,
              };
              
              fallbackStores.push(storeObj);
            });
          });
          
          // Deduplicate fallback stores
          // Note: For fallback stores, we don't filter by module_id since we're finding stores via items
          // The items might be in different modules, but the stores serving those items are still relevant
          // If the user wants module-specific results, they should search for items in that module directly
          const seenFallbackStoreIds = new Set<string>();
          this.logger.debug(`[searchStoresByModule] Found ${fallbackStores.length} fallback stores before deduplication`);
          stores = fallbackStores.filter((store: any) => {
            // Deduplicate
            if (seenFallbackStoreIds.has(String(store.id))) return false;
            seenFallbackStoreIds.add(String(store.id));
            return true;
          });
          this.logger.debug(`[searchStoresByModule] After deduplication: ${stores.length} stores`);
          
          // Sort fallback stores
          if (hasGeo) {
            stores.sort((a, b) => {
              const distA = a.distance_km !== undefined && a.distance_km !== null ? a.distance_km : Infinity;
              const distB = b.distance_km !== undefined && b.distance_km !== null ? b.distance_km : Infinity;
              if (distA !== distB) return distA - distB;
              return (b.order_count || 0) - (a.order_count || 0);
            });
          } else {
            stores.sort((a, b) => (b.order_count || 0) - (a.order_count || 0));
          }
          
          this.logger.debug(`[searchStoresByModule] Found ${stores.length} stores via items/categories fallback`);
          // Note: Fallback stores are marked with matchType: 'item' and will be kept by the main filtering logic
          // even if their module_id doesn't match, because they serve items in the specified module
          
          // Apply filtering again for fallback stores (they were added after initial filtering)
          if (filters?.module_id) {
            const requestedModuleId = Number(filters.module_id);
            const beforeFilterCount = stores.length;
            
            // Separate stores by matchType and module_id
            const storesWithMatchingModuleId = stores.filter((store: any) => {
              if (store.module_id !== undefined && store.module_id !== null) {
                return Number(store.module_id) === requestedModuleId;
              }
              return false;
            });
            
            // Keep stores found via items in the specified module, even if store's module_id differs
            const storesFromItems = stores.filter((store: any) => {
              return store.matchType === 'item' || store.matchType === 'category';
            });
            
            // Combine: stores with matching module_id + stores found via items in that module
            const combinedStoreIds = new Set<string>();
            storesWithMatchingModuleId.forEach((store: any) => {
              combinedStoreIds.add(String(store.id));
            });
            storesFromItems.forEach((store: any) => {
              combinedStoreIds.add(String(store.id));
            });
            
            stores = stores.filter((store: any) => {
              return combinedStoreIds.has(String(store.id));
            });
            
            // Update totalHits to reflect filtered count
            totalHits = stores.length;
            this.logger.debug(`[searchStoresByModule] Filtered fallback stores by module_id ${requestedModuleId}: ${beforeFilterCount} -> ${stores.length} (kept ${storesWithMatchingModuleId.length} with matching module_id, ${storesFromItems.length} from items/categories)`);
          }
        }
      } catch (error: any) {
        this.logger.warn(`[searchStoresByModule] Items/categories fallback search failed: ${error?.message || String(error)}`);
        // Continue with empty results
      }
    }

    // Fetch store addresses and cover_photos from database if not available in OpenSearch
    const storeIdsNeedingData = stores
      .filter((store: any) => {
        // Fetch if address is missing/null or cover_photo is missing/null
        const needsAddress = !store.address || store.address === null || (hasGeo && !store.address.includes('|'));
        const needsCoverPhoto = !store.cover_photo || store.cover_photo === null;
        return needsAddress || needsCoverPhoto;
      })
      .map((store: any) => String(store.id));
    
    if (storeIdsNeedingData.length > 0) {
      try {
        const dataMap = await this.moduleService.getStoreAddressesAndCoverPhotos(storeIdsNeedingData);
        // Update stores with addresses and cover_photos from database
        stores.forEach((store: any) => {
          const storeData = dataMap.get(String(store.id));
          if (storeData) {
            // Update address - format with distance if available
            if (storeData.address) {
              if (hasGeo && store.distance_km !== undefined && store.distance_km !== null && !Number.isNaN(store.distance_km) && store.distance_km !== Infinity) {
                const distanceStr = store.distance_km.toFixed(2);
                store.address = `${distanceStr}km | ${storeData.address}`;
              } else {
                store.address = storeData.address;
              }
            } else if (hasGeo && store.distance_km !== undefined && store.distance_km !== null && !Number.isNaN(store.distance_km) && store.distance_km !== Infinity) {
              // If no address but has distance, show just distance
              const distanceStr = store.distance_km.toFixed(2);
              store.address = `${distanceStr}km`;
            }
            
            // Update cover_photo
            if (storeData.cover_photo) {
              store.cover_photo = storeData.cover_photo;
            } else if (!store.cover_photo && store.image) {
              // Use image as fallback if cover_photo doesn't exist
              store.cover_photo = store.image;
            }
          }
        });
        this.logger.debug(`[searchStoresByModule] Successfully fetched addresses/cover_photos for ${storeIdsNeedingData.length} stores`);
      } catch (error: any) {
        this.logger.warn(`[searchStoresByModule] Failed to fetch store addresses/cover_photos from database: ${error?.message || String(error)}`);
      }
    }

    // Apply pagination
    const paginatedStores = stores.slice(from, from + size);

    // Fetch store schedules from MySQL for paginated stores
    const storeIds = paginatedStores.map((s: any) => s.id || s.store_id).filter(Boolean);
    if (storeIds.length > 0) {
      try {
        const schedules = await this.fetchStoreSchedules(storeIds);
        this.logger.debug(`[searchStoresByModule] Fetched schedules for ${schedules.size} stores, attaching to ${paginatedStores.length} paginated stores`);
        // Attach schedule data to each store
        paginatedStores.forEach((store: any) => {
          const storeId = String(store.id || store.store_id);
          if (storeId && schedules.has(storeId)) {
            store.schedule = schedules.get(storeId);
            this.logger.debug(`[searchStoresByModule] Attached ${store.schedule?.length || 0} schedule entries to store ${storeId}`);
          } else {
            this.logger.warn(`[searchStoresByModule] No schedule found for store ${storeId}`);
          }
        });
      } catch (error: any) {
        this.logger.warn(`[searchStoresByModule] Failed to fetch store schedules: ${error?.message || String(error)}`);
      }
    }

    // Add timing status to paginated stores
    paginatedStores.forEach((store: any) => {
      const timingInfo = this.getStoreTimingStatus(store);
      store.timing_status = timingInfo.status;
      store.timing_message = timingInfo.message;
      store.is_open = timingInfo.isOpen;
      if (timingInfo.minutesRemaining !== undefined) {
        store.minutes_until_closing = timingInfo.minutesRemaining;
      }
      // Debug: Log the assignment for store 228
      if (store.id === 228 || store.store_id === 228) {
        this.logger.debug(`[AFTER ASSIGNMENT] Store 228 timing_message: "${store.timing_message}"`);
      }
    });

    // Log analytics
    this.analytics.logSearch({
      module: filters?.module_id ? String(filters.module_id) : 'all',
      q: q || '',
      lat,
      lon,
      size,
      page,
      filters,
      total: totalHits,
      section: 'stores',
    }).catch(() => {});

    const response = {
      q,
      filters,
      stores: this.imageService.transformStoresWithImages(paginatedStores),
      meta: {
        total: totalHits,
        page,
        size,
        total_pages: Math.ceil(totalHits / size),
        has_more: page * size < totalHits,
      },
    };

    this.logger.log(`[searchStoresByModule] END: Returning ${paginatedStores.length} stores (page ${page}/${Math.ceil(totalHits / size)}, total: ${totalHits})`);
    
    // Cache results if enabled
    if (this.cacheEnabled) {
      const cacheKey = this.cacheService.buildCacheKey({ q, ...filters });
      
      // Dynamic TTL based on query type
      let ttl = 300; // Default 5 minutes
      
      if (!q || q.trim() === '') {
        ttl = 600; // 10 min for browse queries
      } else if (totalHits > 100) {
        ttl = 900; // 15 min for popular queries
      } else if (filters?.lat && filters?.lon) {
        ttl = 60; // 1 min for geo queries (location-sensitive)
      }
      
      await this.cacheService.set(cacheKey, response, ttl);
      this.logger.debug(`[searchStoresByModule] Cached results with TTL: ${ttl}s`);
    }
    
    return response;
  }
  // ============================================
  // MISSING METHODS - Added Feb 5, 2026
  // ============================================

  /**
   * Get item details by ID
   */
  async getItemDetailsById(id: string, moduleId?: number): Promise<any> {
    const index = moduleId === 5 ? this.ECOM_ITEMS_INDEX : this.FOOD_ITEMS_INDEX;
    try {
      const response = await this.client.get({
        index,
        id,
      });
      return response.body._source;
    } catch (error: any) {
      if (error?.statusCode === 404) {
        return null;
      }
      this.logger.error(`[getItemDetailsById] Error: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Get store details by ID
   */
  async getStoreDetailsById(id: string): Promise<any> {
    try {
      // Try food stores first
      try {
        const response = await this.client.get({
          index: this.FOOD_STORES_INDEX,
          id,
        });
        return response.body._source;
      } catch {
        // Try ecom stores
        const response = await this.client.get({
          index: this.ECOM_STORES_INDEX,
          id,
        });
        return response.body._source;
      }
    } catch (error: any) {
      if (error?.statusCode === 404) {
        return null;
      }
      this.logger.error(`[getStoreDetailsById] Error: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Get store by ID (alias for getStoreDetailsById)
   */
  async getStoreById(id: string | number): Promise<any> {
    return this.getStoreDetailsById(String(id));
  }

  /**
   * Hybrid search combining BM25 + KNN
   */
  async hybridSearch(module: 'food' | 'ecom', q: string, filters: Record<string, string>): Promise<any> {
    // Use searchWithStoreBoosting which already does hybrid search
    const moduleId = module === 'food' ? 4 : 5;
    return this.searchWithStoreBoosting(q, { ...filters, module_id: moduleId });
  }

  /**
   * Get zone ID from lat/lon coordinates
   */
  getZoneIdFromLocation(lat: number, lon: number): number | null {
    if (!lat || !lon) return null;
    const zoneId = this.zoneService?.getZoneId(lat, lon);
    return zoneId || null;
  }

  /**
   * Multi-stage search with re-ranking
   */
  async searchWithMultiStage(q: string, filters: Record<string, any> = {}, userId?: string): Promise<any> {
    const module_id = filters.module_id || 4;
    const zone_id = filters.zone_id;
    const lat = filters.lat;
    const lon = filters.lon;
    const size = filters.size || 20;
    
    // Stage 1: Broad search
    const stage1Results = await this.searchWithStoreBoosting(q, {
      ...filters,
      module_id,
      zone_id,
      size: size * 3, // Get 3x results for re-ranking
    });

    // Stage 2: Re-rank by relevance + distance if lat/lon provided
    let items = stage1Results.items || [];
    
    if (lat && lon && items.length > 0) {
      items = items.map((item: any) => {
        const itemLat = item.lat || item.store_lat;
        const itemLon = item.lon || item.store_lon;
        if (itemLat && itemLon) {
          const distance = this.calculateDistance(lat, lon, itemLat, itemLon);
          item.distance_km = distance;
          item.combined_score = (item._score || 1) / (1 + distance * 0.1);
        } else {
          item.combined_score = item._score || 1;
        }
        return item;
      });
      
      items.sort((a: any, b: any) => (b.combined_score || 0) - (a.combined_score || 0));
    }

    // Return top N results
    return {
      ...stage1Results,
      items: items.slice(0, size),
    };
  }
}
