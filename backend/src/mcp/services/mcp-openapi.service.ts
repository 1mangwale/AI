import { Injectable, Logger } from '@nestjs/common';

/**
 * MCP OpenAPI Service
 *
 * Generates an OpenAPI 3.1 spec from the MCP tool definitions, enabling
 * ChatGPT GPT Actions, Gemini Extensions, and standard REST API clients
 * to consume Mangwale commerce capabilities without MCP session overhead.
 *
 * Each MCP tool maps to: POST /mcp/tools/{toolName}
 */
@Injectable()
export class McpOpenApiService {
  private readonly logger = new Logger(McpOpenApiService.name);
  private cachedSpec: any = null;

  private readonly BASE_URL = 'https://api.mangwale.com';

  /** Tools that do NOT require authentication */
  private readonly DISCOVERY_TOOLS = new Set([
    'search_restaurants',
    'get_restaurant_menu',
    'search_items',
    'check_serviceability',
    'get_coupons',
    'get_payment_methods',
    'get_categories',
    'conversational_search',
    'order_by_recipe',
  ]);

  /** Auth flow tools (no auth needed to call, but part of auth flow) */
  private readonly AUTH_TOOLS = new Set(['send_otp', 'verify_otp']);

  /**
   * All 19 MCP tool definitions — mirrors the ListToolsRequest handler
   * in mcp-server.service.ts. Kept in sync manually; if tools change,
   * update this array.
   */
  private getToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  }> {
    return [
      {
        name: 'search_restaurants',
        description:
          'Search for restaurants on Mangwale. Returns restaurant names, ratings, cuisine, delivery time, and distance.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g., "biryani", "pizza near me")' },
            lat: { type: 'number', description: 'Latitude of user location' },
            lng: { type: 'number', description: 'Longitude of user location' },
            radius_km: { type: 'number', description: 'Search radius in km (default: 10)' },
            veg_only: { type: 'boolean', description: 'Filter to vegetarian restaurants only' },
            cuisine: { type: 'string', description: 'Filter by cuisine type' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
        },
      },
      {
        name: 'get_restaurant_menu',
        description:
          'Get the full menu of a specific restaurant including all categories, items, prices, and availability.',
        inputSchema: {
          type: 'object',
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
          'Search for food items or products across all restaurants/stores. Supports food and e-commerce modules.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module (default: food)' },
            lat: { type: 'number', description: 'User latitude' },
            lng: { type: 'number', description: 'User longitude' },
            veg_only: { type: 'boolean', description: 'Vegetarian items only' },
            price_max: { type: 'number', description: 'Maximum price filter' },
            sort: { type: 'string', description: 'Sort: price_asc, price_desc, rating, distance' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'check_serviceability',
        description:
          'Check if Mangwale delivers to a specific location. Returns available services and payment methods.',
        inputSchema: {
          type: 'object',
          properties: {
            lat: { type: 'number', description: 'Latitude to check' },
            lng: { type: 'number', description: 'Longitude to check' },
          },
          required: ['lat', 'lng'],
        },
      },
      {
        name: 'get_coupons',
        description: 'Get available discount coupons. Pass auth_token for personalized coupons.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token for personalized coupons (optional)' },
          },
        },
      },
      {
        name: 'get_payment_methods',
        description: 'Get available payment methods (COD, digital payment, wallet).',
        inputSchema: {
          type: 'object',
          properties: {
            module: { type: 'string', enum: ['food', 'ecommerce', 'parcel'], description: 'Service module (default: food)' },
          },
        },
      },
      {
        name: 'get_categories',
        description: 'Get food or product categories. Optionally filter by store.',
        inputSchema: {
          type: 'object',
          properties: {
            module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module (default: food)' },
            store_id: { type: 'number', description: 'Store ID for menu categories (optional)' },
          },
        },
      },
      {
        name: 'conversational_search',
        description:
          'Context-aware conversational search. Handles follow-ups like "cheaper ones", "show more", "veg only".',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Current user query' },
            previous_query: { type: 'string', description: 'Previous search query for context' },
            previous_results: {
              type: 'array',
              items: {
                type: 'object',
                properties: { item_id: { type: 'number' }, name: { type: 'string' }, price: { type: 'number' } },
              },
              description: 'Results from previous search',
            },
            module: { type: 'string', enum: ['food', 'ecommerce'], description: 'Module (default: food)' },
            zone_id: { type: 'number', description: 'Zone ID for location-based search' },
          },
          required: ['query'],
        },
      },
      {
        name: 'order_by_recipe',
        description:
          'Order ingredients or dishes for a recipe/meal. Decomposes recipe into ingredients and finds matching items.',
        inputSchema: {
          type: 'object',
          properties: {
            recipe_or_meal: { type: 'string', description: 'Recipe or meal name' },
            servings: { type: 'number', description: 'Number of servings (default: 2)' },
            module: { type: 'string', enum: ['food', 'ecommerce'], description: 'food for dishes, ecommerce for ingredients' },
            lat: { type: 'number', description: 'User latitude' },
            lng: { type: 'number', description: 'User longitude' },
            veg_only: { type: 'boolean', description: 'Vegetarian options only' },
          },
          required: ['recipe_or_meal'],
        },
      },
      {
        name: 'send_otp',
        description: 'Send a one-time password to a phone number for authentication.',
        inputSchema: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Phone number with country code (e.g., "+919876543210")' },
          },
          required: ['phone'],
        },
      },
      {
        name: 'verify_otp',
        description: 'Verify OTP and get an auth_token for transactional tools.',
        inputSchema: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Phone number used in send_otp' },
            otp: { type: 'string', description: '6-digit OTP from SMS' },
          },
          required: ['phone', 'otp'],
        },
      },
      {
        name: 'add_to_cart',
        description: 'Add food items to the shopping cart. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number', description: 'Item ID' },
                  quantity: { type: 'number', description: 'Quantity (default: 1)' },
                },
                required: ['id'],
              },
              description: 'Items to add',
            },
            store_id: { type: 'number', description: 'Store ID' },
          },
          required: ['auth_token', 'items'],
        },
      },
      {
        name: 'place_order',
        description: 'Place a food order with delivery address and payment method. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            address_id: { type: 'number', description: 'Delivery address ID from get_addresses' },
            payment_method: { type: 'string', enum: ['cash_on_delivery', 'digital_payment', 'wallet'], description: 'Payment method' },
            coupon_code: { type: 'string', description: 'Coupon code (optional)' },
            order_note: { type: 'string', description: 'Special instructions (optional)' },
          },
          required: ['auth_token', 'address_id', 'payment_method'],
        },
      },
      {
        name: 'get_addresses',
        description: 'Get saved delivery addresses. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
          },
          required: ['auth_token'],
        },
      },
      {
        name: 'add_address',
        description: 'Add a new delivery address. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            address: { type: 'string', description: 'Full address text' },
            lat: { type: 'number', description: 'Latitude' },
            lng: { type: 'number', description: 'Longitude' },
            type: { type: 'string', enum: ['home', 'office', 'other'], description: 'Address type' },
            house: { type: 'string', description: 'House/flat number' },
            road: { type: 'string', description: 'Road/street name' },
            floor: { type: 'string', description: 'Floor number' },
          },
          required: ['auth_token', 'address', 'lat', 'lng'],
        },
      },
      {
        name: 'get_wallet_balance',
        description: 'Check wallet balance. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
          },
          required: ['auth_token'],
        },
      },
      {
        name: 'get_order_status',
        description: 'Get current status of a specific order. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            order_id: { type: 'number', description: 'Order ID to check' },
          },
          required: ['auth_token', 'order_id'],
        },
      },
      {
        name: 'get_order_history',
        description: 'Get past orders with optional module filter. Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            limit: { type: 'number', description: 'Max orders (default: 10)' },
            module: { type: 'string', enum: ['food', 'ecommerce', 'parcel'], description: 'Filter by module' },
          },
          required: ['auth_token'],
        },
      },
      {
        name: 'cancel_order',
        description: 'Cancel an eligible order (pending/failed only). Requires auth_token.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_token: { type: 'string', description: 'Bearer token from verify_otp' },
            order_id: { type: 'number', description: 'Order ID to cancel' },
            reason: { type: 'string', description: 'Cancellation reason (optional)' },
          },
          required: ['auth_token', 'order_id'],
        },
      },
    ];
  }

  /**
   * Generate or return cached OpenAPI 3.1 specification.
   */
  generateOpenApiSpec(): any {
    if (this.cachedSpec) return this.cachedSpec;

    const tools = this.getToolDefinitions();
    const paths: Record<string, any> = {};

    for (const tool of tools) {
      const isDiscovery = this.DISCOVERY_TOOLS.has(tool.name) || this.AUTH_TOOLS.has(tool.name);
      const requiresAuth = !isDiscovery;

      const operation: any = {
        operationId: tool.name,
        summary: tool.description,
        tags: [this.getToolTag(tool.name)],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: tool.inputSchema,
            },
          },
        },
        responses: {
          '200': {
            description: 'Tool execution result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'Tool-specific response. Check individual tool documentation for shape.',
                },
              },
            },
          },
          '400': {
            description: 'Invalid input parameters',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Unknown tool name',
          },
          '500': {
            description: 'Internal server error',
          },
        },
        // Gemini compatibility
        'x-google-backend': {
          address: `${this.BASE_URL}/mcp/tools/${tool.name}`,
        },
      };

      if (requiresAuth) {
        operation.security = [{ BearerAuth: [] }];
        operation.description =
          `${tool.description} Requires authentication — pass auth_token in the request body (obtained via send_otp + verify_otp).`;
      }

      paths[`/mcp/tools/${tool.name}`] = {
        post: operation,
      };
    }

    this.cachedSpec = {
      openapi: '3.1.0',
      info: {
        title: 'Mangwale Commerce API',
        version: '1.2.0',
        description:
          'Mangwale Commerce API — Search restaurants, browse menus, order food and products with delivery in Nashik, India. ' +
          'This API wraps MCP (Model Context Protocol) tools as standard REST endpoints for compatibility with ChatGPT GPT Actions, ' +
          'Google Gemini Extensions, and other OpenAPI consumers.\n\n' +
          '## Authentication\n' +
          'Discovery tools (search, browse) require no authentication. Transactional tools (cart, orders) require an `auth_token` ' +
          'obtained via the send_otp + verify_otp flow. Pass the token in the request body as `auth_token`.\n\n' +
          '## Available Services\n' +
          '- Food delivery from local restaurants\n' +
          '- E-commerce / grocery shopping\n' +
          '- Parcel delivery\n\n' +
          '## Coverage\n' +
          'Nashik, Maharashtra, India (expanding to more cities)',
        contact: {
          name: 'Mangwale Technologies',
          url: 'https://mangwale.com',
        },
      },
      servers: [
        {
          url: this.BASE_URL,
          description: 'Production',
          'x-google-backend': {
            address: this.BASE_URL,
          },
        },
      ],
      paths,
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Auth token obtained from verify_otp tool. Pass as Bearer token in Authorization header, or as auth_token in request body.',
          },
        },
      },
      tags: [
        { name: 'Discovery', description: 'Browse restaurants, search items, check coverage — no auth required' },
        { name: 'Authentication', description: 'Phone-based OTP authentication flow' },
        { name: 'Cart & Orders', description: 'Cart management and order placement — auth required' },
        { name: 'User', description: 'Addresses, wallet, order history — auth required' },
      ],
    };

    this.logger.log(`OpenAPI spec generated: ${tools.length} tools → ${Object.keys(paths).length} endpoints`);
    return this.cachedSpec;
  }

  /**
   * Get the list of valid tool names for validation.
   */
  getValidToolNames(): string[] {
    return this.getToolDefinitions().map((t) => t.name);
  }

  /**
   * Check if a tool requires authentication.
   */
  isAuthRequired(toolName: string): boolean {
    return !this.DISCOVERY_TOOLS.has(toolName) && !this.AUTH_TOOLS.has(toolName);
  }

  private getToolTag(name: string): string {
    if (this.DISCOVERY_TOOLS.has(name)) return 'Discovery';
    if (this.AUTH_TOOLS.has(name)) return 'Authentication';
    if (['add_to_cart', 'place_order'].includes(name)) return 'Cart & Orders';
    return 'User';
  }
}
