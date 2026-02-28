import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpToolsService } from './mcp-tools.service';
import { McpCacheService } from './mcp-cache.service';
import { MetricsService } from '../../metrics/metrics.service';

/**
 * MCP Server Service
 *
 * Wraps the @modelcontextprotocol/sdk Server and registers all Mangwale
 * commerce tools. The controller handles HTTP transport (SSE + POST).
 *
 * Tools exposed (17 total):
 * Discovery (no auth):
 * - search_restaurants, get_restaurant_menu, search_items
 * - check_serviceability, get_coupons, get_payment_methods, get_categories
 * Auth:
 * - send_otp, verify_otp
 * Transactional (auth required):
 * - add_to_cart, place_order, get_addresses, add_address
 * - get_wallet_balance, get_order_status, get_order_history, cancel_order
 */
@Injectable()
export class McpServerService implements OnModuleInit {
  private readonly logger = new Logger(McpServerService.name);

  // TTLs for cacheable discovery tools (seconds)
  private readonly CACHE_TTLS: Record<string, number> = {
    search_restaurants: 300,   // 5 min
    get_restaurant_menu: 180,  // 3 min
    search_items: 300,         // 5 min
    get_coupons: 600,          // 10 min
    get_payment_methods: 600,  // 10 min
    get_categories: 600,       // 10 min
    conversational_search: 60, // 1 min
  };

  constructor(
    private readonly tools: McpToolsService,
    private readonly cache: McpCacheService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    this.logger.log('MCP Server Service initialized — 18 tools registered');
  }

  /**
   * Create a new MCP Server instance with all tools registered.
   * Each SSE connection gets its own Server + Transport pair.
   */
  createServer(): Server {
    const server = new Server(
      {
        name: 'mangwale-commerce',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerToolHandlers(server);
    return server;
  }

  private registerToolHandlers(server: Server): void {
    // ── List Tools ──────────────────────────────────────────────
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_restaurants',
          description:
            'Search for restaurants on Mangwale. Returns restaurant names, ratings, cuisine, delivery time, and distance. Use this when the user wants to find a place to eat.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query (e.g., "biryani", "pizza near me", "veg restaurants")' },
              lat: { type: 'number', description: 'Latitude of user location (e.g., 19.9975)' },
              lng: { type: 'number', description: 'Longitude of user location (e.g., 73.7898)' },
              radius_km: { type: 'number', description: 'Search radius in km (default: 10)' },
              veg_only: { type: 'boolean', description: 'Filter to vegetarian restaurants only' },
              cuisine: { type: 'string', description: 'Filter by cuisine type (e.g., "Chinese", "South Indian")' },
              limit: { type: 'number', description: 'Max results (default: 10)' },
            },
          },
        },
        {
          name: 'get_restaurant_menu',
          description:
            'Get the full menu of a specific restaurant including all categories, items, prices, and availability. Use this after the user selects a restaurant.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              store_id: { type: 'number', description: 'Restaurant ID from search results' },
              lat: { type: 'number', description: 'User latitude (for delivery estimate)' },
              lng: { type: 'number', description: 'User longitude (for delivery estimate)' },
            },
            required: ['store_id'],
          },
        },
        {
          name: 'search_items',
          description:
            'Search for specific food items or products across all restaurants/stores. Returns item name, price, store, and rating. Supports food and e-commerce modules.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'What to search for (e.g., "chicken biryani", "running shoes")' },
              module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module: "food" for restaurants, "ecommerce" for shopping (default: food)' },
              lat: { type: 'number', description: 'User latitude' },
              lng: { type: 'number', description: 'User longitude' },
              veg_only: { type: 'boolean', description: 'Vegetarian items only (food module)' },
              price_max: { type: 'number', description: 'Maximum price filter' },
              sort: { type: 'string', description: 'Sort by: "price_asc", "price_desc", "rating", "distance"' },
              limit: { type: 'number', description: 'Max results (default: 10)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'check_serviceability',
          description:
            'Check if Mangwale delivers to a specific location. Returns whether the area is serviceable, available services (food, parcel, shopping), and payment methods.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              lat: { type: 'number', description: 'Latitude to check' },
              lng: { type: 'number', description: 'Longitude to check' },
            },
            required: ['lat', 'lng'],
          },
        },
        {
          name: 'get_coupons',
          description:
            'Get available discount coupons. Returns coupon codes, discount amounts, and minimum purchase requirements. Pass auth_token for personalized coupons.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token for personalized coupons (optional)' },
            },
          },
        },
        {
          name: 'add_to_cart',
          description:
            'Add food items to the shopping cart. Requires authentication. Use send_otp + verify_otp first to get an auth_token.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number', description: 'Item ID from search results' },
                    quantity: { type: 'number', description: 'Quantity to add (default: 1)' },
                  },
                  required: ['id'],
                },
                description: 'Items to add to cart',
              },
              store_id: { type: 'number', description: 'Store ID (items must be from same store)' },
            },
            required: ['auth_token', 'items'],
          },
        },
        {
          name: 'place_order',
          description:
            'Place a food order. Requires items in cart (use add_to_cart first), a delivery address, and payment method. Returns order ID and confirmation.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              address_id: { type: 'number', description: 'Delivery address ID from get_addresses' },
              payment_method: {
                type: 'string',
                enum: ['cash_on_delivery', 'digital_payment', 'wallet'],
                description: 'Payment method',
              },
              coupon_code: { type: 'string', description: 'Coupon code to apply (optional)' },
              order_note: { type: 'string', description: 'Special instructions for the order (optional)' },
            },
            required: ['auth_token', 'address_id', 'payment_method'],
          },
        },
        {
          name: 'get_addresses',
          description:
            'Get the user\'s saved delivery addresses. Each address has an ID that can be used with place_order.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            },
            required: ['auth_token'],
          },
        },
        {
          name: 'get_wallet_balance',
          description:
            'Check the user\'s Mangwale wallet balance. Can be used as payment method if sufficient balance.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            },
            required: ['auth_token'],
          },
        },
        {
          name: 'send_otp',
          description:
            'Send a one-time password to a phone number for authentication. The user will receive an SMS with a 6-digit OTP. Use verify_otp next.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              phone: { type: 'string', description: 'Phone number with country code (e.g., "+919876543210")' },
            },
            required: ['phone'],
          },
        },
        {
          name: 'verify_otp',
          description:
            'Verify the OTP sent to the user\'s phone and get an auth_token. The auth_token is needed for cart, order, and payment operations.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              phone: { type: 'string', description: 'Phone number used in send_otp' },
              otp: { type: 'string', description: '6-digit OTP from SMS' },
            },
            required: ['phone', 'otp'],
          },
        },
        {
          name: 'get_order_status',
          description:
            'Get the current status and details of a specific order. Returns status, payment info, and amounts. Requires auth_token — use send_otp + verify_otp first.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              order_id: { type: 'number', description: 'Order ID to check' },
            },
            required: ['auth_token', 'order_id'],
          },
        },
        {
          name: 'get_order_history',
          description:
            'Get the user\'s past orders. Returns order IDs, amounts, statuses, and dates. Filter by module (food, ecommerce, parcel). Requires auth_token.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              limit: { type: 'number', description: 'Max number of orders to return (default: 10)' },
              module: { type: 'string', enum: ['food', 'ecommerce', 'parcel'], description: 'Filter by service type (default: all)' },
            },
            required: ['auth_token'],
          },
        },
        {
          name: 'cancel_order',
          description:
            'Cancel an order. Checks eligibility first — only pending/failed orders can be cancelled. Requires auth_token.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              order_id: { type: 'number', description: 'Order ID to cancel' },
              reason: { type: 'string', description: 'Cancellation reason (optional)' },
            },
            required: ['auth_token', 'order_id'],
          },
        },
        {
          name: 'add_address',
          description:
            'Add a new delivery address for the user. Returns the address ID which can be used with place_order. Requires auth_token.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
              address: { type: 'string', description: 'Full address text (e.g., "123 Main St, Nashik")' },
              lat: { type: 'number', description: 'Latitude of the address' },
              lng: { type: 'number', description: 'Longitude of the address' },
              type: { type: 'string', enum: ['home', 'office', 'other'], description: 'Address type (default: other)' },
              house: { type: 'string', description: 'House/flat number (optional)' },
              road: { type: 'string', description: 'Road/street name (optional)' },
              floor: { type: 'string', description: 'Floor number (optional)' },
            },
            required: ['auth_token', 'address', 'lat', 'lng'],
          },
        },
        {
          name: 'get_payment_methods',
          description:
            'Get available payment methods (COD, digital payment, wallet). No authentication required. Useful before placing an order.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              module: { type: 'string', enum: ['food', 'ecommerce', 'parcel'], description: 'Service module (default: food)' },
            },
          },
        },
        {
          name: 'get_categories',
          description:
            'Get food or product categories. Optionally filter by a specific store to see its menu categories. No authentication required.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module type (default: food)' },
              store_id: { type: 'number', description: 'Store ID to get menu categories for (optional)' },
            },
          },
        },
        {
          name: 'conversational_search',
          description:
            'Context-aware conversational search. Handles follow-up queries like "cheaper ones", "show more", "vegetarian only" by refining previous search results. Use this for multi-turn search conversations.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Current user query (e.g., "cheaper ones", "show veg only")' },
              previous_query: { type: 'string', description: 'Previous search query for context' },
              previous_results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    item_id: { type: 'number' },
                    name: { type: 'string' },
                    price: { type: 'number' },
                  },
                },
                description: 'Results from previous search (for refinement)',
              },
              module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module (default: food)' },
              zone_id: { type: 'number', description: 'Zone ID for location-based search' },
            },
            required: ['query'],
          },
        },
      ],
    }));

    // ── Call Tool ────────────────────────────────────────────────
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      this.logger.log(`MCP tool call: ${name} ${JSON.stringify(args || {}).slice(0, 200)}`);
      const startTime = Date.now();

      try {
        let result: any;

        // Check cache for cacheable discovery tools
        const cacheTtl = this.CACHE_TTLS[name];
        if (cacheTtl) {
          const cacheKey = this.cache.buildKey(name, args as any);
          const cached = await this.cache.get(cacheKey);
          if (cached) {
            this.logger.debug(`MCP cache hit: ${name}`);
            const elapsed = Date.now() - startTime;
            await this.cache.logToolCall(name, args, elapsed, true);
            this.metrics?.recordMcpToolCall(name, elapsed, true);
            return { content: [{ type: 'text' as const, text: JSON.stringify(cached, null, 2) }] };
          }
        }

        switch (name) {
          case 'search_restaurants':
            result = await this.tools.searchRestaurants(args as any);
            break;
          case 'get_restaurant_menu':
            result = await this.tools.getRestaurantMenu(args as any);
            break;
          case 'search_items':
            result = await this.tools.searchItems(args as any);
            break;
          case 'check_serviceability':
            result = await this.tools.checkServiceability(args as any);
            break;
          case 'get_coupons':
            result = await this.tools.getCoupons(args as any);
            break;
          case 'add_to_cart':
            result = await this.tools.addToCart(args as any);
            break;
          case 'place_order':
            result = await this.tools.placeOrder(args as any);
            break;
          case 'get_addresses':
            result = await this.tools.getAddresses(args as any);
            break;
          case 'get_wallet_balance':
            result = await this.tools.getWalletBalance(args as any);
            break;
          case 'send_otp':
            result = await this.tools.sendOtp(args as any);
            break;
          case 'verify_otp':
            result = await this.tools.verifyOtp(args as any);
            break;
          case 'get_order_status':
            result = await this.tools.getOrderStatus(args as any);
            break;
          case 'get_order_history':
            result = await this.tools.getOrderHistory(args as any);
            break;
          case 'cancel_order':
            result = await this.tools.cancelOrder(args as any);
            break;
          case 'add_address':
            result = await this.tools.addAddress(args as any);
            break;
          case 'get_payment_methods':
            result = await this.tools.getPaymentMethods(args as any);
            break;
          case 'get_categories':
            result = await this.tools.getCategories(args as any);
            break;
          case 'conversational_search':
            result = await this.tools.conversationalSearch(args as any);
            break;
          default:
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}. Use tools/list to see available tools.` }) }],
              isError: true,
            };
        }

        // Cache cacheable results
        if (cacheTtl && result && !result.error) {
          const cacheKey = this.cache.buildKey(name, args as any);
          await this.cache.set(cacheKey, result, cacheTtl);
        }

        const elapsed = Date.now() - startTime;
        await this.cache.logToolCall(name, args, elapsed, true);
        this.metrics?.recordMcpToolCall(name, elapsed, false);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - startTime;
        await this.cache.logToolCall(name, args, elapsed, false);
        const errorType = err.message?.includes('401') ? 'auth' : err.message?.includes('ECONNREFUSED') ? 'connection' : 'runtime';
        this.metrics?.recordMcpToolError(name, errorType);
        this.logger.error(`MCP tool ${name} failed: ${err.message}`, err.stack);

        // Provide helpful hints based on error type
        let hint = '';
        const msg = err.message || '';
        if (msg.includes('401') || msg.includes('Unauthenticated') || msg.includes('auth')) {
          hint = ' Hint: Use send_otp + verify_otp to get an auth_token first.';
        } else if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
          hint = ' Hint: The service may be temporarily unavailable. Try again in a moment.';
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: msg + hint }) }],
          isError: true,
        };
      }
    });
  }
}
