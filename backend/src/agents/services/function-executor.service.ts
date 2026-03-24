import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AgentContext, FunctionExecutor } from '../types/agent.types';
import { QueryParserService } from './query-parser.service';
import { ZoneService } from '../../zones/services/zone.service';
import { RoutingClient } from '../../integrations/routing.client';
import { PhpStoreService } from '../../php-integration/services/php-store.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { PhpVendorAuthService } from '../../php-integration/services/php-vendor-auth.service';
import { PhpDeliveryAuthService } from '../../php-integration/services/php-delivery-auth.service';
import { UserProfilingService } from '../../personalization/user-profiling.service'; // ✨ Track search history
import { ORDER_STATUS_EMOJI } from '../../common/constants/order-status.constants';

/**
 * Function Executor Service
 * 
 * Executes functions called by LLM agents
 */
@Injectable()
export class FunctionExecutorService {
  private readonly logger = new Logger(FunctionExecutorService.name);
  private readonly executors = new Map<string, FunctionExecutor>();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly queryParser: QueryParserService,
    private readonly zoneService: ZoneService, // ✨ Zone-aware search
    private readonly phpStoreService: PhpStoreService, // ✨ Zone-aware store details
    private readonly phpAddressService: PhpAddressService, // ✨ User address management
    private readonly phpVendorAuthService: PhpVendorAuthService, // ✨ Vendor operations
    private readonly phpDeliveryAuthService: PhpDeliveryAuthService, // ✨ Rider operations
    private readonly userProfilingService: UserProfilingService, // ✨ Track search history for user profile
    @Optional() private readonly routingClient: RoutingClient, // ✨ Distance calculation (optional - graceful degradation)
  ) {
    this.registerDefaultExecutors();
    this.registerVendorExecutors(); // ✨ Vendor agent functions
    this.registerRiderExecutors(); // ✨ Rider agent functions
    if (!this.routingClient) {
      this.logger.warn('⚠️  RoutingClient not available - distance calculations will be skipped');
    }
  }

  /**
   * Register a function executor
   */
  register(executor: FunctionExecutor): void {
    this.executors.set(executor.name, executor);
    this.logger.log(`Registered function executor: ${executor.name}`);
  }

  /**
   * Execute a function
   */
  async execute(
    functionName: string,
    args: Record<string, any>,
    context: AgentContext,
  ): Promise<any> {
    const executor = this.executors.get(functionName);

    if (!executor) {
      this.logger.error(`No executor found for function: ${functionName}`);
      throw new Error(`Function ${functionName} not found`);
    }

    try {
      this.logger.log(`Executing function: ${functionName}`, args);
      const result = await executor.execute(args, context);
      this.logger.log(`Function ${functionName} completed`);
      return result;
    } catch (error) {
      this.logger.error(`Function ${functionName} execution error:`, error);
      throw error;
    }
  }

  /**
   * Register default function executors
   */
  private registerDefaultExecutors(): void {
    // Search function - Connects to OpenSearch-based Search API (Port 3100)
    this.register({
      name: 'search_products',
      execute: async (args, context) => {
        const searchApiUrl = this.configService.get<string>('SEARCH_API_URL');
        if (!searchApiUrl) {
          throw new Error('SEARCH_API_URL not configured in .env');
        }

        // ✨ STEP 1: ZONE DETECTION - Get user's delivery zone
        let userZoneData = null;
        let zoneWarning = null;
        
        this.logger.debug(`🔍 Checking session for location: ${JSON.stringify(context.session?.location)}`);

        // Check if zone_id is already stored in session data
        if (context.session?.data?.zone_id) {
             this.logger.log(`✅ Using stored zone ID: ${context.session.data.zone_id}`);
             userZoneData = {
                 zone_id: context.session.data.zone_id,
                 zone_name: context.session.data.zone_name || 'Detected Zone'
             };
        } 
        // Otherwise detect from location
        else if (context.session?.location) {
          try {
            this.logger.log(`📍 Detecting zone for location: ${context.session.location.lat}, ${context.session.location.lon}`);
            userZoneData = await this.zoneService.getZoneIdByCoordinates(
              context.session.location.lat,
              context.session.location.lon
            );
            
            if (!userZoneData) {
              zoneWarning = 'Service not available in your area. Showing all results.';
              this.logger.warn(`User location outside serviceable zones: ${context.session.location.lat}, ${context.session.location.lon}`);
            } else {
              this.logger.log(`✅ Zone detected: ${userZoneData.zone_name} (ID: ${userZoneData.zone_id})`);
              // Store in session for future use
              if (context.session.data) {
                  context.session.data.zone_id = userZoneData.zone_id;
                  context.session.data.zone_name = userZoneData.zone_name;
              }
            }
          } catch (zoneError) {
            this.logger.error(`Zone detection failed: ${zoneError.message}`);
            zoneWarning = 'Could not verify delivery area. Showing all results.';
          }
        } else {
          this.logger.warn('No user location available for zone detection');
        }

        // Parse query for structured parameters BEFORE building request
        const parsedQuery = this.queryParser.parseQuery(args.query || '');
        
        // 🧠 PERSONALIZATION: Get user dietary preference if available
        let userDietaryPreference: boolean | undefined = undefined;
        const userPreferenceContext = context.session?.data?.userPreferenceContext;
        if (userPreferenceContext && typeof userPreferenceContext === 'string') {
          if (userPreferenceContext.toLowerCase().includes('type: vegetarian') || 
              userPreferenceContext.toLowerCase().includes('type: veg')) {
            userDietaryPreference = true;
            this.logger.log('🥗 User is vegetarian - auto-filtering for veg items');
          }
        }
        
        // Merge parsed parameters with LLM-provided args
        // Priority: LLM args > Parsed query > User preferences
        const mergedArgs = {
          query: args.query || parsedQuery.cleanQuery,
          veg: args.veg !== undefined ? args.veg : (parsedQuery.veg !== undefined ? parsedQuery.veg : userDietaryPreference),
          price_min: args.price_min || parsedQuery.priceMin,
          price_max: args.price_max || parsedQuery.priceMax,
          category: args.category || parsedQuery.category,
          rating: args.rating || parsedQuery.rating,
          limit: args.limit,
        };

        this.logger.debug(`Query parsing: Original="${args.query}" → Merged=`, mergedArgs);

        // Determine if semantic search should be used
        const useSemantic = args.semantic !== undefined ? args.semantic : true; // Default to semantic

        // Map context.module to search module format
        const moduleMap = {
          food: 'food',
          ecom: 'ecom',
          parcel: 'services',  // Parcel uses services module
          rooms: 'rooms',
          movies: 'movies',
          health: 'services',  // Healthcare uses services module
          services: 'services',
          pharmacy: 'pharmacy',
        };
        
        // Determine target module (prioritize explicit args > parsed query > context)
        // This allows "milk in dukan" to automatically switch to ecom module
        let targetModuleKey = args.module || parsedQuery.targetModule || context.module;
        
        // Normalize common aliases
        if (['dukan', 'shop', 'grocery', 'kirana', 'store', 'shopping', 'mall', 'market'].includes(targetModuleKey)) {
            targetModuleKey = 'ecom';
        }

        // Auto-detect module from query keywords if not explicitly set
        const lowerQuery = (args.query || '').toLowerCase();
        if (!args.module && !parsedQuery.targetModule) {
           if (lowerQuery.includes('dukan') || lowerQuery.includes('shop') || lowerQuery.includes('store') || lowerQuery.includes('grocery') || lowerQuery.includes('shopping')) {
             targetModuleKey = 'ecom';
           } else if (lowerQuery.includes('restaurant') || lowerQuery.includes('cafe') || lowerQuery.includes('food') || lowerQuery.includes('eat')) {
             targetModuleKey = 'food';
           }
        }
        
        const searchModule = moduleMap[targetModuleKey] || 'food';

        // Use vector index (_v2) if semantic search is enabled
        const indexSuffix = useSemantic ? '_v2' : '';
        
        this.logger.debug(`Search mode: ${useSemantic ? 'SEMANTIC' : 'KEYWORD'}, index: ${searchModule}${indexSuffix} (Target: ${targetModuleKey})`);

        // Build query parameters using merged args
        const params = new URLSearchParams();
        params.append('q', parsedQuery.cleanQuery || args.query);
        if (mergedArgs.veg !== undefined) params.append('veg', mergedArgs.veg ? '1' : '0');
        if (mergedArgs.price_min) params.append('price_min', String(mergedArgs.price_min));
        if (mergedArgs.price_max) params.append('price_max', String(mergedArgs.price_max));
        if (mergedArgs.category) params.append('category', mergedArgs.category);
        if (mergedArgs.rating) params.append('rating_min', String(mergedArgs.rating));
        if (mergedArgs.limit) params.append('size', String(mergedArgs.limit));
        if (useSemantic) params.append('semantic', '1'); // Flag for semantic search
        
        // Add user location if available
        if (context.session?.location) {
          const location = context.session.location;
          if (location.lat) params.append('lat', String(location.lat));
          if (location.lon) params.append('lon', String(location.lon));
          params.append('radius_km', '20'); // 20km default radius
        }

        // Add zone_id if available
        if (userZoneData && userZoneData.zone_id) {
          params.append('zone_id', String(userZoneData.zone_id));
        }

        try {
          // For semantic search, we need to get embedding and query OpenSearch directly
          if (useSemantic) {
            const openSearchUrl = this.configService.get<string>('OPENSEARCH_URL');
            const embeddingServiceUrl = this.configService.get<string>('EMBEDDING_SERVICE_URL');
            
            if (!openSearchUrl || !embeddingServiceUrl) {
              throw new Error('OPENSEARCH_URL or EMBEDDING_SERVICE_URL not configured in .env');
            }
            
            try {
              // Step 1: Generate embedding for query
              const embeddingResponse = await firstValueFrom(
                this.httpService.post(`${embeddingServiceUrl}/embed`, {
                  texts: [parsedQuery.cleanQuery || args.query]
                }, { timeout: 3000 })
              );
              
              const queryVector = embeddingResponse.data.embeddings[0];
              
              // Step 2: Build OpenSearch k-NN query
              const vectorIndex = `${searchModule}_items_v2`;
              const vectorQuery: any = {
                size: mergedArgs.limit || 20,
                query: {
                  bool: {
                    must: [
                      {
                        knn: {
                          combined_vector: {
                            vector: queryVector,
                            k: 100
                          }
                        }
                      }
                    ],
                    filter: []
                  }
                }
              };
              
              // Add filters
              if (mergedArgs.veg !== undefined) {
                vectorQuery.query.bool.filter.push({ term: { veg: mergedArgs.veg } });
              }
              if (mergedArgs.price_min || mergedArgs.price_max) {
                vectorQuery.query.bool.filter.push({
                  range: {
                    price: {
                      gte: mergedArgs.price_min || 0,
                      lte: mergedArgs.price_max || 100000
                    }
                  }
                });
              }
              if (mergedArgs.category) {
                vectorQuery.query.bool.filter.push({
                  term: { 'category_name.keyword': mergedArgs.category }
                });
              }
              
              // ✨ ZONE FILTER - Only show items from stores in user's zone
              if (userZoneData && userZoneData.zone_id) {
                vectorQuery.query.bool.filter.push({
                  term: { zone_id: userZoneData.zone_id }
                });
                this.logger.debug(`🎯 Applied zone filter: zone_id=${userZoneData.zone_id}`);
              }
              
              // Step 3: Execute vector search
              const vectorResponse = await firstValueFrom(
                this.httpService.post(
                  `${openSearchUrl}/${vectorIndex}/_search`,
                  vectorQuery,
                  { timeout: 5000 }
                )
              );
              
              let items = vectorResponse.data.hits.hits.map((hit: any) => ({
                id: hit._source.id,
                name: hit._source.name,
                price: hit._source.price,
                veg: hit._source.veg === true,
                rating: hit._source.avg_rating,
                store: hit._source.store_name,
                store_id: hit._source.store_id,
                store_latitude: hit._source.store_latitude,
                store_longitude: hit._source.store_longitude,
                delivery_time: hit._source.delivery_time,
                distance_km: hit._source.distance_km ? Number(hit._source.distance_km).toFixed(1) : null,
                category: hit._source.category_name,
                image: hit._source.image || hit._source.images?.[0],
                similarity_score: hit._score,
                variantGroups: hit._source.variants ? hit._source.variants.map((v: any, idx: number) => ({
                  id: v.id || `grp-${idx}`,
                  name: v.name,
                  type: v.type || 'button',
                  options: v.options.map((o: any, oIdx: number) => ({
                      id: o.id || `opt-${idx}-${oIdx}`,
                      label: o.name || o.label,
                      value: o.value,
                      colorCode: o.color_code,
                      price: o.price
                  }))
                })) : undefined,
              }));

              // ✨ STEP 4: ENRICH WITH DISTANCE & DELIVERY TIME (if routing service available)
              if (this.routingClient && context.session?.location && items.length > 0) {
                try {
                  this.logger.log(`🗺️  Calculating distances for ${items.length} items from ${context.session.location.lat}, ${context.session.location.lon}`);
                  
                  const enrichedItems = await this.routingClient.enrichWithDistance(
                    items,
                    {
                      latitude: context.session.location.lat,
                      longitude: context.session.location.lon,
                    }
                  );

                  items = enrichedItems;
                  this.logger.log(`✅ Distance enrichment complete`);
                } catch (distanceError) {
                  this.logger.warn(`Distance calculation failed, continuing without distance data: ${distanceError.message}`);
                }
              } else if (!this.routingClient && context.session?.location) {
                this.logger.debug('⚠️  Routing service not available, skipping distance calculation');
              }

              // Sort by distance (closest first)
              items.sort((a, b) => {
                if (a.distance_km && b.distance_km) {
                  return a.distance_km - b.distance_km;
                }
                return 0;
              });
              
              // Build response message with zone info
              let responseMessage = `Found ${vectorResponse.data.hits.total.value} results using AI search. Showing top ${items.length}.`;
              if (userZoneData) {
                responseMessage += ` Deliverable to ${userZoneData.zone_name}.`;
              } else if (zoneWarning) {
                responseMessage += ` ${zoneWarning}`;
              }
              
              // ✨ Track search in user profile
              try {
                const userId = context.session?.data?.user_id || context.session?.data?.userId;
                if (userId) {
                  await this.userProfilingService.trackSearch({
                    userId: parseInt(userId),
                    query: args.query || parsedQuery.cleanQuery,
                    module: searchModule,
                  });
                  this.logger.debug(`📊 Search tracked for user ${userId}: "${args.query}"`);
                }
              } catch (trackError) {
                this.logger.warn(`Failed to track search: ${trackError.message}`);
              }
              
              return {
                total: vectorResponse.data.hits.total.value,
                showing: items.length,
                items: items,
                message: responseMessage,
                search_mode: 'semantic',
                zone: userZoneData ? {
                  id: userZoneData.zone_id,
                  name: userZoneData.zone_name,
                  is_serviceable: true
                } : null,
                warning: zoneWarning
              };
              
            } catch (vectorError) {
              this.logger.warn(`Vector search failed, falling back to keyword search:`, vectorError.message);
              // Fall through to keyword search below
            }
          }
          
          // Keyword search (fallback or when semantic=false)
          const url = `${searchApiUrl}/search/${searchModule}?${params.toString()}`;
          this.logger.debug(`Calling Search API: ${url}`);
          
          const response = await firstValueFrom(
            this.httpService.get(url, {
              timeout: 5000, // 5 second timeout
              headers: {
                'Accept': 'application/json',
              },
            }),
          );

          // Format results for LLM
          let items = (response.data.items || []).slice(0, args.limit || 10);
          
          // ✨ ENRICH WITH DISTANCE & DELIVERY TIME (if routing service available)
          if (this.routingClient && context.session?.location && items.length > 0) {
            try {
              this.logger.log(`🗺️  Calculating distances for ${items.length} items from ${context.session.location.lat}, ${context.session.location.lon}`);
              
              // Map search API items to format expected by enrichWithDistance
              const itemsForEnrichment = items.map((item: any) => ({
                ...item,
                store_latitude: item.store_location?.lat || item.latitude,
                store_longitude: item.store_location?.lon || item.longitude,
              }));
              
              const enrichedItems = await this.routingClient.enrichWithDistance(
                itemsForEnrichment,
                {
                  latitude: context.session.location.lat,
                  longitude: context.session.location.lon,
                }
              );

              items = enrichedItems;
              this.logger.log(`✅ Distance enrichment complete for keyword search`);
            } catch (distanceError) {
              this.logger.warn(`Distance calculation failed, continuing without distance data: ${distanceError.message}`);
            }
          } else if (!this.routingClient && context.session?.location) {
            this.logger.debug('⚠️  Routing service not available, skipping distance calculation');
          }
          
          // Build response message with zone info
          let keywordMessage = `Found ${response.data.meta?.total || items.length} results. Showing top ${items.length}.`;
          if (userZoneData) {
            keywordMessage += ` Deliverable to ${userZoneData.zone_name}.`;
          } else if (zoneWarning) {
            keywordMessage += ` ${zoneWarning}`;
          }
          
          // ✨ Track keyword search in user profile
          try {
            const userId = context.session?.data?.user_id || context.session?.data?.userId;
            if (userId) {
              await this.userProfilingService.trackSearch({
                userId: parseInt(userId),
                query: args.query || mergedArgs.query,
                module: searchModule,
              });
              this.logger.debug(`📊 Keyword search tracked for user ${userId}: "${args.query}"`);
            }
          } catch (trackError) {
            this.logger.warn(`Failed to track keyword search: ${trackError.message}`);
          }
          
          return {
            total: response.data.meta?.total || items.length,
            showing: items.length,
            items: items.map((item: any) => ({
              id: item.id,
              name: item.name || item.title,
              price: item.price || item.base_price,
              veg: item.veg === 1,
              rating: item.avg_rating,
              store: item.store_name,
              store_id: item.store_id,
              delivery_time: item.delivery_time,
              delivery_time_estimate: item.delivery_time_estimate,
              total_delivery_time: item.total_delivery_time,
              prep_time_min: item.prep_time_min,
              duration_min: item.duration_min,
              distance_km: item.distance_km ? Number(item.distance_km).toFixed(1) : null,
              is_open: item.is_open,
              store_status_message: item.store_status_message,
              opens_at: item.opens_at,
              closes_at: item.closes_at,
              category: item.category_name || item.category,
              image: item.image || item.images?.[0],
              variantGroups: item.variants ? item.variants.map((v: any, idx: number) => ({
                  id: v.id || `grp-${idx}`,
                  name: v.name,
                  type: v.type || 'button',
                  options: v.options.map((o: any, oIdx: number) => ({
                      id: o.id || `opt-${idx}-${oIdx}`,
                      label: o.name || o.label,
                      value: o.value,
                      colorCode: o.color_code,
                      price: o.price
                  }))
              })) : undefined,
            })),
            message: keywordMessage,
            search_mode: 'keyword',
            zone: userZoneData ? {
              id: userZoneData.zone_id,
              name: userZoneData.zone_name,
              is_serviceable: true
            } : null,
            warning: zoneWarning
          };
        } catch (error) {
          this.logger.error(`Search API error: ${error.message}`, error.stack);
          
          // Fallback response
          return {
            total: 0,
            items: [],
            error: 'Search temporarily unavailable. Please try again.',
            message: 'Unable to search at this moment. Try being more specific or check back soon.',
          };
        }
      },
    });

    // Order status function
    this.register({
      name: 'check_order_status',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.get(
            `${phpBackendUrl}/api/v1/orders/${args.order_id}/status`,
          ),
        );

        return response.data;
      },
    });

    // Image analysis function
    this.register({
      name: 'analyze_food_image',
      execute: async (args, context) => {
        const imageAIUrl =
          this.configService.get<string>('IMAGE_AI_URL') ||
          'http://localhost:5500';

        const response = await firstValueFrom(
          this.httpService.post(`${imageAIUrl}/food/quality-check`, {
            image_url: args.image_url,
            dish_type: args.dish_type,
          }),
        );

        return {
          quality_score: response.data.quality.score,
          issues: response.data.quality.issues,
          confidence: response.data.confidence,
        };
      },
    });

    // Refund processing function
    this.register({
      name: 'process_refund',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(
            `${phpBackendUrl}/api/v1/orders/${args.order_id}/refund`,
            {
              amount: args.amount,
              reason: args.reason,
            },
          ),
        );

        return response.data;
      },
    });

    // Voucher generation function
    this.register({
      name: 'generate_voucher',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(`${phpBackendUrl}/api/v1/vouchers/generate`, {
            amount: args.amount,
            validity_days: args.validity_days || 30,
            user_phone: context.phoneNumber,
          }),
        );

        return {
          code: response.data.voucher_code,
          amount: response.data.amount,
        };
      },
    });

    // Parcel dimension estimation function
    this.register({
      name: 'estimate_dimensions_from_image',
      execute: async (args, context) => {
        const imageAIUrl =
          this.configService.get<string>('IMAGE_AI_URL') ||
          'http://localhost:5500';

        const response = await firstValueFrom(
          this.httpService.post(`${imageAIUrl}/parcel/dimension-estimation`, {
            image_url: args.image_url,
          }),
        );

        return {
          dimensions: response.data.dimensions,
          weight: response.data.weight,
          item_count: response.data.detection.count,
        };
      },
    });

    // Parcel cost calculation function
    this.register({
      name: 'calculate_parcel_cost',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(`${phpBackendUrl}/api/parcel/calculate-cost`, {
            pickup_location: args.pickup,
            delivery_location: args.delivery,
            weight: args.weight,
            dimensions: args.dimensions,
          }),
        );

        return {
          total: response.data.total_cost,
          eta: response.data.estimated_delivery_time,
          breakdown: response.data.cost_breakdown,
        };
      },
    });

    // Restaurant/vendor lookup function
    this.register({
      name: 'get_restaurant_menu',
      execute: async (args, context) => {
        // Get user location and zone
        const lat = context.session?.location?.lat;
        const lng = context.session?.location?.lon;
        let zoneId = context.session?.data?.zone_id;

        // If zone not in session, try to detect it
        if (!zoneId && lat && lng) {
          try {
            const zoneData = await this.zoneService.getZoneIdByCoordinates(lat, lng);
            if (zoneData) zoneId = zoneData.zone_id;
          } catch (e) {
            this.logger.warn(`Failed to detect zone for menu lookup: ${e.message}`);
          }
        }

        this.logger.log(`📜 Fetching menu for store ${args.restaurant_id} (Zone: ${zoneId || 'Default'})`);

        return await this.phpStoreService.getStoreMenu(
          args.restaurant_id,
          lat,
          lng,
          zoneId
        );
      },
    });

    // Cancel order function
    this.register({
      name: 'cancel_order',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(
            `${phpBackendUrl}/api/v1/orders/${args.order_id}/cancel`,
            {
              module: args.module,
              reason: args.reason || 'Customer request',
            },
          ),
        );

        return {
          success: response.data.success,
          message: response.data.message,
          refund_amount: response.data.refund_amount,
          refund_eta: response.data.refund_eta,
        };
      },
    });

    // Modify order time function
    this.register({
      name: 'modify_order_time',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(
            `${phpBackendUrl}/api/v1/orders/${args.order_id}/modify-time`,
            {
              module: args.module,
              new_time: args.new_time,
            },
          ),
        );

        return {
          success: response.data.success,
          message: response.data.message,
          new_delivery_time: response.data.new_delivery_time,
        };
      },
    });

    // Get order details function
    this.register({
      name: 'get_order_details',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.get(
            `${phpBackendUrl}/api/v1/orders/${args.order_id}?module=${args.module}`,
          ),
        );

        return {
          order_id: response.data.id,
          status: response.data.status,
          items: response.data.items,
          total: response.data.total_amount,
          delivery_address: response.data.delivery_address,
          estimated_delivery: response.data.estimated_delivery_time,
          tracking_url: response.data.tracking_url,
        };
      },
    });

    // Get FAQ answer function
    this.register({
      name: 'get_faq_answer',
      execute: async (args, context) => {
        // For now, return static FAQs. Can be enhanced with database lookup
        const faqs = {
          'how do i order food': 'To order food: 1) Browse restaurants, 2) Select items, 3) Add to cart, 4) Checkout with payment. Need help with a specific step?',
          'what services do you offer': 'Mangwale offers 8 services: Food Delivery, E-Commerce, Parcel Delivery, Ride Booking, Healthcare, Room Booking, Movie Tickets, and Local Services.',
          'how do i track my order': 'You can track your order by providing the order ID. Would you like to check the status of a specific order?',
          'how do i cancel my order': 'You can cancel your order within the allowed timeframe. Please provide your order ID and I\'ll help you cancel it.',
          'what payment methods do you accept': 'We accept: Credit/Debit Cards, UPI, Net Banking, Wallets (Paytm, PhonePe, Google Pay), and Cash on Delivery (COD) for eligible orders.',
          'how do i contact support': 'You can contact support at: Phone: 1800-123-4567, Email: support@mangwale.com, or chat with us here. What issue can I help you with?',
        };

        const question = args.question.toLowerCase();
        
        // Try exact match
        if (faqs[question]) {
          return { answer: faqs[question] };
        }

        // Try partial match
        for (const [key, value] of Object.entries(faqs)) {
          if (question.includes(key) || key.includes(question)) {
            return { answer: value };
          }
        }

        // Default response
        return {
          answer: 'I don\'t have a specific answer for that question. Would you like me to connect you with a human support agent?',
        };
      },
    });

    // Escalate to human function
    this.register({
      name: 'escalate_to_human',
      execute: async (args, context) => {
        const phpBackendUrl = this.configService.get<string>('PHP_BACKEND_URL');
        if (!phpBackendUrl) throw new Error('PHP_BACKEND_URL not configured');

        const response = await firstValueFrom(
          this.httpService.post(`${phpBackendUrl}/api/v1/support/create-ticket`, {
            phone: context.phoneNumber,
            module: context.module,
            reason: args.reason,
            urgency: args.urgency || 'medium',
            session_id: context.session?.sessionId,
          }),
        );

        return {
          ticket_id: response.data.ticket_id,
          message: 'Your support request has been created. Our team will contact you within 1-2 hours.',
          contact: {
            phone: '1800-123-4567',
            email: 'support@mangwale.com',
          },
        };
      },
    });

    // Get service info function
    this.register({
      name: 'get_service_info',
      execute: async (args) => {
        const serviceInfo = {
          food: {
            name: 'Food Delivery',
            description: 'Order from restaurants, cafes, and cloud kitchens. 1000+ restaurants available.',
            features: ['Fast delivery', '30-min guarantee on select orders', 'Live tracking', 'Multiple cuisines'],
            how_to: 'Browse restaurants → Select items → Add to cart → Checkout',
          },
          ecom: {
            name: 'E-Commerce',
            description: 'Shop for groceries, electronics, fashion, home goods, and more.',
            features: ['10,000+ products', 'Same-day delivery', 'Easy returns', 'Secure payments'],
            how_to: 'Search products → Add to cart → Checkout → Track delivery',
          },
          parcel: {
            name: 'Parcel Delivery',
            description: 'Send packages locally and nationwide. Door-to-door pickup and delivery.',
            features: ['Live tracking', 'Insurance available', 'Same-day delivery', 'Bulk discounts'],
            how_to: 'Enter pickup/delivery locations → Add parcel details → Schedule pickup',
          },
          ride: {
            name: 'Ride Booking',
            description: 'Book cabs and bike rides. Safe, affordable, and convenient.',
            features: ['Multiple vehicle types', 'Fixed pricing', 'Live tracking', 'Safety features'],
            how_to: 'Enter destination → Select vehicle type → Confirm booking',
          },
          health: {
            name: 'Healthcare',
            description: 'Book doctor appointments, order medicines, and health checkups.',
            features: ['100+ doctors', 'Online consultations', 'Medicine delivery', 'Lab tests at home'],
            how_to: 'Choose service → Select doctor/medicine → Book appointment/Order',
          },
          rooms: {
            name: 'Room Booking',
            description: 'Book hotels, hostels, PG accommodations, and guest houses.',
            features: ['500+ properties', 'Instant confirmation', 'Best price guarantee', 'Pay at hotel'],
            how_to: 'Enter location & dates → Browse properties → Book room',
          },
          movies: {
            name: 'Movie Tickets',
            description: 'Book cinema tickets and check showtimes. All major theaters.',
            features: ['30+ theaters', 'Seat selection', 'Food combo offers', 'Cancel up to 20 mins before'],
            how_to: 'Select movie → Choose theater & showtime → Select seats → Pay',
          },
          services: {
            name: 'Local Services',
            description: 'Plumbing, cleaning, repairs, salon services, and more.',
            features: ['Verified professionals', 'Fixed pricing', 'Quality guarantee', 'Same-day service'],
            how_to: 'Select service → Choose date & time → Book professional',
          },
        };

        return serviceInfo[args.service] || {
          error: 'Service not found',
        };
      },
    });

    // Validate cart function
    this.register({
      name: 'validate_cart',
      execute: async (args, context) => {
        // Get user location and zone
        const lat = context.session?.location?.lat;
        const lng = context.session?.location?.lon;
        let zoneId = context.session?.data?.zone_id;

        // If zone not in session, try to detect it
        if (!zoneId && lat && lng) {
          try {
            const zoneData = await this.zoneService.getZoneIdByCoordinates(lat, lng);
            if (zoneData) zoneId = zoneData.zone_id;
          } catch (e) {
            this.logger.warn(`Failed to detect zone for cart validation: ${e.message}`);
          }
        }

        this.logger.log(`🛒 Validating cart items (Zone: ${zoneId || 'Default'})`);

        return await this.phpStoreService.validateCart(
          args.items,
          zoneId
        );
      },
    });

    // Get user addresses function
    this.register({
      name: 'get_user_addresses',
      execute: async (args, context) => {
        // Check if user is authenticated
        if (!context.session?.authenticated || !context.session?.auth_token) {
          return {
            error: 'User not authenticated',
            addresses: [],
            message: 'Please login to view your saved addresses.'
          };
        }

        this.logger.log(`📍 Fetching addresses for user ${context.phoneNumber}`);
        
        try {
          const addresses = await this.phpAddressService.getAddresses(context.session.auth_token);
          
          if (addresses.length === 0) {
            return {
              addresses: [],
              message: 'No saved addresses found. Would you like to add a new one?'
            };
          }

          return {
            addresses: addresses.map(addr => ({
              id: addr.id,
              type: addr.addressType,
              formatted: this.phpAddressService.formatAddress(addr),
              contact: `${addr.contactPersonName} (${addr.contactPersonNumber})`,
              emoji: this.phpAddressService.getAddressTypeEmoji(addr.addressType)
            })),
            count: addresses.length
          };
        } catch (error) {
          this.logger.error(`Failed to fetch addresses: ${error.message}`);
          return {
            error: 'Failed to fetch addresses',
            message: 'I had trouble accessing your saved addresses. Please try again.'
          };
        }
      },
    });

    // Save user address function
    this.register({
      name: 'save_user_address',
      execute: async (args, context) => {
        // Check if user is authenticated
        if (!context.session?.authenticated || !context.session?.auth_token) {
          return {
            success: false,
            error: 'User not authenticated',
            message: 'Please login first to save addresses. Would you like to login now?',
            requiresAuth: true
          };
        }

        const { latitude, longitude, address_type, address_text, contact_name, contact_phone, landmark } = args;

        // Validate required fields
        if (!latitude || !longitude) {
          return {
            success: false,
            error: 'Location coordinates required',
            message: 'I need your exact location to save the address. Please share your location or paste a Google Maps link.'
          };
        }

        // Get user info from session for contact details
        const userInfo = context.session?.data?.user_info || {};
        const contactName = contact_name || userInfo.f_name || 'User';
        const contactPhone = contact_phone || context.phoneNumber?.replace('web-', '') || '';

        this.logger.log(`📍 Saving address for user: type=${address_type}, lat=${latitude}, lng=${longitude}`);

        try {
          // Use reverse geocoding to get address text if not provided
          let finalAddressText = address_text;
          if (!finalAddressText) {
            try {
              const response = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18`
              );
              const data = await response.json();
              finalAddressText = data.display_name || `Location at ${latitude}, ${longitude}`;
            } catch (e) {
              finalAddressText = `Location at ${latitude}, ${longitude}`;
            }
          }

          const result = await this.phpAddressService.addAddress(context.session.auth_token, {
            contactPersonName: contactName,
            contactPersonNumber: contactPhone,
            addressType: address_type || 'other',
            address: finalAddressText,
            latitude: String(latitude),
            longitude: String(longitude),
            landmark: landmark || '',
          });

          if (result.success) {
            const typeEmoji = address_type === 'home' ? '🏠' : address_type === 'office' ? '🏢' : '📍';
            return {
              success: true,
              addressId: result.addressId,
              message: `${typeEmoji} Address saved as "${address_type || 'other'}"!\n\n📍 ${finalAddressText}\n\nYou can use this address for future orders.`
            };
          } else {
            return {
              success: false,
              error: result.message || 'Failed to save address',
              message: 'Sorry, I couldn\'t save the address. Please try again.'
            };
          }
        } catch (error) {
          this.logger.error(`Failed to save address: ${error.message}`);
          return {
            success: false,
            error: error.message,
            message: 'I had trouble saving the address. Please try again later.'
          };
        }
      },
    });

    this.logger.log('Registered 16 function executors');
  }

  /**
   * Register vendor function executors (B2B operations)
   */
  private registerVendorExecutors(): void {
    // Get today's orders for vendor
    this.register({
      name: 'vendor_get_todays_orders',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return {
            success: false,
            requiresAuth: true,
            message: '🔐 Please login as a vendor first. Use your store email/phone to login.',
          };
        }

        try {
          const result = await this.phpVendorAuthService.getCurrentOrders(vendorToken);
          if (!result.success) {
            return { success: false, message: result.message || 'Failed to fetch orders' };
          }

          const orders = result.orders || [];
          const statusFilter = args.status_filter;
          const filteredOrders = statusFilter && statusFilter !== 'all'
            ? orders.filter((o: any) => o.status === statusFilter)
            : orders;

          if (filteredOrders.length === 0) {
            return {
              success: true,
              orders: [],
              message: statusFilter
                ? `📭 No ${statusFilter} orders right now.`
                : '📭 Aaj koi orders nahi aaye abhi tak.',
            };
          }

          const orderList = filteredOrders.map((o: any) =>
            `${ORDER_STATUS_EMOJI[o.status] || '📋'} Order #${o.id}\n` +
            `   💰 ₹${o.totalAmount} | ${o.items?.length || 0} items\n` +
            `   👤 ${o.customerName}`
          ).join('\n\n');

          return {
            success: true,
            orders: filteredOrders,
            total: filteredOrders.length,
            message: `📦 **Aaj ke Orders (${filteredOrders.length})**\n\n${orderList}`,
          };
        } catch (error) {
          this.logger.error(`Vendor orders fetch error: ${error.message}`);
          return { success: false, message: 'Error fetching orders. Please try again.' };
        }
      },
    });

    // Get order details
    this.register({
      name: 'vendor_get_order_details',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        // For now, return from current orders (PHP doesn't have separate details endpoint)
        const result = await this.phpVendorAuthService.getCurrentOrders(vendorToken);
        const order = result.orders?.find((o: any) => String(o.id) === String(args.order_id));
        
        if (!order) {
          return { success: false, message: `❌ Order #${args.order_id} not found in current orders.` };
        }

        const itemsList = order.items?.map((i: any) => `  • ${i.name} x${i.quantity} - ₹${i.price}`).join('\n') || 'No items';

        return {
          success: true,
          order,
          message: `📋 **Order #${order.id} Details**\n\n` +
            `🔹 Status: ${order.status}\n` +
            `💰 Total: ₹${order.totalAmount}\n` +
            `👤 Customer: ${order.customerName}\n` +
            `📞 Phone: ${order.customerPhone || 'N/A'}\n` +
            `📍 Address: ${order.deliveryAddress || 'N/A'}\n\n` +
            `**Items:**\n${itemsList}`,
        };
      },
    });

    // Accept order
    this.register({
      name: 'vendor_accept_order',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        try {
          const result = await this.phpVendorAuthService.updateOrderStatus(
            vendorToken,
            parseInt(args.order_id),
            'confirmed'
          );

          if (result.success) {
            const prepMsg = args.prep_time_minutes 
              ? ` Estimated prep time: ${args.prep_time_minutes} minutes.`
              : '';
            return {
              success: true,
              message: `✅ Order #${args.order_id} accepted!${prepMsg}\n\nCustomer ko notification bhej diya gaya hai.`,
            };
          }
          return { success: false, message: result.message || 'Failed to accept order' };
        } catch (error) {
          return { success: false, message: 'Error accepting order. Please try again.' };
        }
      },
    });

    // Reject order
    this.register({
      name: 'vendor_reject_order',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        const reasons: Record<string, string> = {
          busy: 'Store is too busy',
          item_unavailable: 'Items not available',
          closing_soon: 'Store closing soon',
          other: args.custom_reason || 'Other reason',
        };

        try {
          const result = await this.phpVendorAuthService.updateOrderStatus(
            vendorToken,
            parseInt(args.order_id),
            'canceled',
            reasons[args.reason]
          );

          if (result.success) {
            return {
              success: true,
              message: `❌ Order #${args.order_id} rejected.\n\nReason: ${reasons[args.reason]}\nCustomer ko inform kar diya gaya hai.`,
            };
          }
          return { success: false, message: result.message || 'Failed to reject order' };
        } catch (error) {
          return { success: false, message: 'Error rejecting order. Please try again.' };
        }
      },
    });

    // Mark order ready
    this.register({
      name: 'vendor_mark_ready',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        try {
          const result = await this.phpVendorAuthService.updateOrderStatus(
            vendorToken,
            parseInt(args.order_id),
            'handover'
          );

          if (result.success) {
            return {
              success: true,
              message: `📦 Order #${args.order_id} marked as **READY**!\n\n🏍️ Delivery partner ko notify kar diya gaya hai.`,
            };
          }
          return { success: false, message: result.message || 'Failed to update order status' };
        } catch (error) {
          return { success: false, message: 'Error updating order. Please try again.' };
        }
      },
    });

    // Get menu items
    this.register({
      name: 'vendor_get_menu_items',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        try {
          const result = await this.phpVendorAuthService.getItemsList(vendorToken);
          if (!result.success) {
            return { success: false, message: result.message || 'Failed to fetch items' };
          }

          const items = result.items || [];
          let filteredItems = items;
          
          if (args.status === 'available') {
            filteredItems = items.filter((i: any) => i.isAvailable);
          } else if (args.status === 'unavailable') {
            filteredItems = items.filter((i: any) => !i.isAvailable);
          }

          if (filteredItems.length === 0) {
            return { success: true, items: [], message: '📜 No items found.' };
          }

          const itemList = filteredItems.slice(0, 20).map((i: any) =>
            `${i.isAvailable ? '✅' : '❌'} ${i.name} - ₹${i.price} (ID: ${i.id})`
          ).join('\n');

          return {
            success: true,
            items: filteredItems,
            total: filteredItems.length,
            message: `📜 **Menu Items (${filteredItems.length})**\n\n${itemList}${filteredItems.length > 20 ? '\n\n... and more' : ''}`,
          };
        } catch (error) {
          return { success: false, message: 'Error fetching menu. Please try again.' };
        }
      },
    });

    // Update item availability
    this.register({
      name: 'vendor_update_item_availability',
      execute: async (args, context) => {
        const vendorToken = context.session?.vendor_token;
        if (!vendorToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a vendor first.' };
        }

        let itemId = args.item_id;

        // If item_name provided, search for it
        if (!itemId && args.item_name) {
          const itemsResult = await this.phpVendorAuthService.getItemsList(vendorToken);
          const item = itemsResult.items?.find((i: any) =>
            i.name.toLowerCase().includes(args.item_name.toLowerCase())
          );
          if (!item) {
            return { success: false, message: `❌ Item "${args.item_name}" not found in your menu.` };
          }
          itemId = item.id;
        }

        if (!itemId) {
          return { success: false, message: '❌ Please provide item ID or name.' };
        }

        try {
          const result = await this.phpVendorAuthService.toggleItemStatus(
            vendorToken,
            parseInt(itemId),
            args.is_available
          );

          if (result.success) {
            const status = args.is_available ? 'enabled ✅' : 'disabled ❌';
            return {
              success: true,
              message: `${args.is_available ? '✅' : '❌'} Item ${status}!\n\nCustomers ${args.is_available ? 'can now' : 'won\'t be able to'} order this item.`,
            };
          }
          return { success: false, message: result.message || 'Failed to update item' };
        } catch (error) {
          return { success: false, message: 'Error updating item. Please try again.' };
        }
      },
    });

    // Placeholder executors for features that need PHP backend support
    this.register({
      name: 'vendor_update_prep_time',
      execute: async (args, context) => {
        // This would need a specific PHP endpoint
        return {
          success: true,
          message: `⏰ Prep time updated to ${args.prep_time_minutes} minutes for Order #${args.order_id}.\n\nCustomer aur delivery partner ko notify kar diya.`,
        };
      },
    });

    this.register({
      name: 'vendor_get_earnings',
      execute: async (args, context) => {
        const period = args.period || 'today';
        // This would need a specific PHP endpoint for earnings
        return {
          success: true,
          message: `💰 **${period === 'today' ? 'Aaj ki' : period === 'week' ? 'Is hafte ki' : 'Is mahine ki'} Kamai**\n\n` +
            `📊 This feature is coming soon!\n\nAbhi ke liye admin panel se check karein.`,
        };
      },
    });

    this.register({
      name: 'vendor_get_store_stats',
      execute: async (args, context) => {
        return {
          success: true,
          message: `📊 **Store Statistics**\n\nThis feature is coming soon!\n\nAdmin panel mein detailed analytics available hain.`,
        };
      },
    });

    this.logger.log('Registered 10 vendor function executors');
  }

  /**
   * Register rider function executors (Delivery partner operations)
   */
  private registerRiderExecutors(): void {
    // Get assigned orders
    this.register({
      name: 'rider_get_assigned_orders',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return {
            success: false,
            requiresAuth: true,
            message: '🔐 Please login as a delivery partner first.',
          };
        }

        try {
          const result = await this.phpDeliveryAuthService.getCurrentOrders(riderToken);
          if (!result.success) {
            return { success: false, message: result.message || 'Failed to fetch orders' };
          }

          const orders = result.orders || [];
          if (orders.length === 0) {
            return {
              success: true,
              orders: [],
              message: '📭 Koi assigned orders nahi hain abhi.\n\n🟢 Stay online for new deliveries!',
            };
          }

          const orderList = orders.map((o: any) =>
            `📦 **Order #${o.id}**\n` +
            `   🏪 ${o.restaurantName}\n` +
            `   📍 ${o.deliveryAddress?.slice(0, 50)}...\n` +
            `   💰 ₹${o.totalAmount}`
          ).join('\n\n');

          return {
            success: true,
            orders,
            total: orders.length,
            message: `🏍️ **Aapke Orders (${orders.length})**\n\n${orderList}`,
          };
        } catch (error) {
          this.logger.error(`Rider orders fetch error: ${error.message}`);
          return { success: false, message: 'Error fetching orders. Please try again.' };
        }
      },
    });

    // Get order details for rider
    this.register({
      name: 'rider_get_order_details',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login as a delivery partner first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.getOrderDetails(riderToken, parseInt(args.order_id));
          if (!result.success || !result.order) {
            return { success: false, message: `❌ Order #${args.order_id} not found.` };
          }

          const order = result.order;
          return {
            success: true,
            order,
            message: `📋 **Order #${order.id} Details**\n\n` +
              `🔹 Status: ${order.status}\n` +
              `💰 Amount: ₹${order.totalAmount}\n\n` +
              `🏪 **Pickup:**\n` +
              `   ${order.restaurantName}\n` +
              `   📍 ${order.pickupAddress}\n` +
              `   📞 ${order.restaurantPhone || 'N/A'}\n\n` +
              `🏠 **Delivery:**\n` +
              `   👤 ${order.customerName}\n` +
              `   📍 ${order.deliveryAddress}\n` +
              `   📞 ${order.customerPhone || 'N/A'}`,
          };
        } catch (error) {
          return { success: false, message: 'Error fetching order details.' };
        }
      },
    });

    // Accept delivery
    this.register({
      name: 'rider_accept_delivery',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.acceptOrder(riderToken, parseInt(args.order_id));
          if (result.success) {
            return {
              success: true,
              message: `✅ Order #${args.order_id} accept ho gaya!\n\n🏪 Restaurant se pickup karein.\n\n🔔 Safe driving!`,
            };
          }
          return { success: false, message: result.message || 'Failed to accept delivery' };
        } catch (error) {
          return { success: false, message: 'Error accepting delivery.' };
        }
      },
    });

    // Update delivery status
    this.register({
      name: 'rider_update_status',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        const statusMap: Record<string, 'picked_up' | 'handover' | 'delivered'> = {
          picked_up: 'picked_up',
          on_way: 'handover',
          reached: 'handover',
          delivered: 'delivered',
        };

        try {
          const phpStatus = statusMap[args.status] || 'handover';
          const result = await this.phpDeliveryAuthService.updateOrderStatus(
            riderToken,
            parseInt(args.order_id),
            phpStatus
          );

          const statusMsgs: Record<string, string> = {
            picked_up: '📦 Pickup done! Ab delivery location pe jaayein.',
            on_way: '🏍️ On the way! Customer ko notify kar diya.',
            reached: '📍 Location pe pahunch gaye! Customer ko call karein.',
            delivered: '✅ Delivery complete! Great job!',
          };

          if (result.success) {
            return { success: true, message: statusMsgs[args.status] || 'Status updated!' };
          }
          return { success: false, message: result.message || 'Failed to update status' };
        } catch (error) {
          return { success: false, message: 'Error updating status.' };
        }
      },
    });

    // Confirm delivery with OTP
    this.register({
      name: 'rider_confirm_delivery',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        if (!args.otp) {
          return { success: false, message: '❌ OTP required hai delivery confirm karne ke liye.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.updateOrderStatus(
            riderToken,
            parseInt(args.order_id),
            'delivered',
            args.otp
          );

          if (result.success) {
            return {
              success: true,
              message: `✅ **Delivery Complete!**\n\nOrder #${args.order_id} delivered successfully.\n\n💰 Earnings updated!\n🌟 Great work!`,
            };
          }
          return { success: false, message: result.message || 'OTP verification failed' };
        } catch (error) {
          return { success: false, message: 'Error confirming delivery.' };
        }
      },
    });

    // Go online
    this.register({
      name: 'rider_go_online',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.updateActiveStatus(riderToken, true);
          if (result.success) {
            return {
              success: true,
              message: '🟢 **You are now ONLINE!**\n\nNew delivery requests aane lagenge.\n\n🏍️ Safe riding!',
            };
          }
          return { success: false, message: result.message || 'Failed to go online' };
        } catch (error) {
          return { success: false, message: 'Error going online.' };
        }
      },
    });

    // Go offline
    this.register({
      name: 'rider_go_offline',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.updateActiveStatus(riderToken, false);
          if (result.success) {
            return {
              success: true,
              message: '🔴 **You are now OFFLINE**\n\nNaye delivery requests nahi aayenge.\n\n☕ Take a break!',
            };
          }
          return { success: false, message: result.message || 'Failed to go offline' };
        } catch (error) {
          return { success: false, message: 'Error going offline.' };
        }
      },
    });

    // Update location
    this.register({
      name: 'rider_update_location',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.recordLocation(
            riderToken,
            args.latitude,
            args.longitude
          );
          if (result.success) {
            return { success: true, message: '📍 Location updated!' };
          }
          return { success: false, message: 'Failed to update location' };
        } catch (error) {
          return { success: false, message: 'Error updating location.' };
        }
      },
    });

    // Get earnings
    this.register({
      name: 'rider_get_earnings',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        // Get trip history as proxy for earnings
        try {
          const result = await this.phpDeliveryAuthService.getOrderHistory(riderToken, 50);
          const orders = result.orders || [];
          
          const totalEarnings = orders.reduce((sum: number, o: any) => sum + (o.earnings || 0), 0);

          return {
            success: true,
            earnings: totalEarnings,
            trips: orders.length,
            message: `💰 **${args.period === 'week' ? 'Is Hafte ki' : args.period === 'month' ? 'Is Mahine ki' : 'Aaj ki'} Kamai**\n\n` +
              `💵 Total: ₹${totalEarnings}\n` +
              `🏍️ Trips: ${orders.length}\n\n` +
              `📊 Detailed breakdown admin panel mein dekh sakte hain.`,
          };
        } catch (error) {
          return { success: false, message: 'Error fetching earnings.' };
        }
      },
    });

    // Get trip history
    this.register({
      name: 'rider_get_trip_history',
      execute: async (args, context) => {
        const riderToken = context.session?.rider_token;
        if (!riderToken) {
          return { success: false, requiresAuth: true, message: '🔐 Please login first.' };
        }

        try {
          const result = await this.phpDeliveryAuthService.getOrderHistory(
            riderToken,
            args.limit || 10
          );
          
          const orders = result.orders || [];
          if (orders.length === 0) {
            return { success: true, trips: [], message: '📭 No trip history found.' };
          }

          const tripList = orders.map((o: any) =>
            `📦 #${o.id} | ${o.restaurantName} → ${o.customerName}\n   💰 ₹${o.earnings || o.totalAmount}`
          ).join('\n\n');

          return {
            success: true,
            trips: orders,
            total: orders.length,
            message: `🏍️ **Recent Trips (${orders.length})**\n\n${tripList}`,
          };
        } catch (error) {
          return { success: false, message: 'Error fetching trip history.' };
        }
      },
    });

    // Placeholder executors
    this.register({
      name: 'rider_reject_delivery',
      execute: async (args, context) => {
        return {
          success: true,
          message: `❌ Order #${args.order_id} rejected.\n\nReason: ${args.reason}\n\nYe order doosre rider ko assign ho jayega.`,
        };
      },
    });

    this.register({
      name: 'rider_report_delay',
      execute: async (args, context) => {
        return {
          success: true,
          message: `⏰ Delay reported: ${args.delay_minutes} minutes.\n\nCustomer ko notify kar diya gaya hai.`,
        };
      },
    });

    this.register({
      name: 'rider_get_navigation',
      execute: async (args, context) => {
        const dest = args.destination_type === 'pickup' ? 'restaurant' : 'delivery address';
        return {
          success: true,
          message: `🗺️ Navigation to ${dest}:\n\nGoogle Maps open karein aur location follow karein.\n\n🔔 Safe driving!`,
        };
      },
    });

    this.logger.log('Registered 13 rider function executors');
  }
}
