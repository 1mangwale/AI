import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpStoreService } from '../../php-integration/services/php-store.service';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { SearchOrchestrator, NLUOutput } from '../../orchestrator/search.orchestrator';
import { SessionService } from '../../session/session.service';
import { LlmService } from '../../llm/services/llm.service';
import { AddressExtractionService } from './address-extraction.service';

/**
 * Tool definition for LLM function calling
 */
export interface LlmTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  formatted?: string; // Human-readable formatted result
}

/**
 * LLM Tools Service
 * 
 * Provides tool definitions and execution for LLM function calling.
 * Tools can search food, get recommendations, compare prices, etc.
 * 
 * The LLM can decide whether to:
 * 1. Call a tool directly (for simple queries)
 * 2. Trigger a flow (for transactional operations)
 */
@Injectable()
export class LlmToolsService {
  private readonly logger = new Logger(LlmToolsService.name);
  private readonly tools: Map<string, LlmTool> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly phpStoreService: PhpStoreService,
    private readonly phpAddressService: PhpAddressService,
    private readonly searchOrchestrator: SearchOrchestrator,
    private readonly sessionService: SessionService,
    private readonly llmService: LlmService,
    private readonly addressExtractionService: AddressExtractionService,
  ) {
    this.registerTools();
    this.logger.log('🔧 LLM Tools Service initialized with tools:', Array.from(this.tools.keys()));
  }

  /**
   * Register all available tools
   */
  private registerTools(): void {
    // 1. Search Food Tool
    this.tools.set('search_food', {
      name: 'search_food',
      description: 'Search for food items, dishes, or restaurants. Use this when user asks about food availability, wants to find specific dishes, or browse food options.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "pizza", "biryani", "chinese food", "burger near me")',
          },
          category: {
            type: 'string',
            description: 'Food category to filter by',
            enum: ['pizza', 'biryani', 'burger', 'chinese', 'indian', 'south_indian', 'fast_food', 'desserts', 'beverages'],
          },
          price_range: {
            type: 'string',
            description: 'Price range filter',
            enum: ['budget', 'mid', 'premium'],
          },
          veg_only: {
            type: 'string',
            description: 'Filter for vegetarian items only',
            enum: ['true', 'false'],
          },
        },
        required: ['query'],
      },
    });

    // 2. Get Recommendations Tool
    this.tools.set('get_recommendations', {
      name: 'get_recommendations',
      description: 'Get personalized food recommendations based on user preferences, order history, time of day, and weather. Use when user asks "what should I eat?", "suggest something", or wants recommendations.',
      parameters: {
        type: 'object',
        properties: {
          preference: {
            type: 'string',
            description: 'User food preference',
            enum: ['veg', 'non_veg', 'any'],
          },
          mood: {
            type: 'string',
            description: 'Mood-based recommendation',
            enum: ['comfort', 'healthy', 'light', 'heavy', 'spicy', 'sweet'],
          },
          budget: {
            type: 'string',
            description: 'Budget preference',
            enum: ['budget', 'mid', 'premium', 'any'],
          },
          cuisine: {
            type: 'string',
            description: 'Preferred cuisine type',
            enum: ['indian', 'chinese', 'italian', 'fast_food', 'south_indian', 'street_food', 'any'],
          },
        },
        required: [],
      },
    });

    // 3. Compare Prices Tool
    this.tools.set('compare_prices', {
      name: 'compare_prices',
      description: 'Compare prices of a food item across different restaurants. Use when user asks "where is X cheapest?", "compare prices", or wants to find best deals.',
      parameters: {
        type: 'object',
        properties: {
          item: {
            type: 'string',
            description: 'Food item to compare (e.g., "paneer butter masala", "margherita pizza")',
          },
          max_results: {
            type: 'string',
            description: 'Maximum number of restaurants to compare',
          },
        },
        required: ['item'],
      },
    });

    // 4. Check Restaurant Status Tool
    this.tools.set('check_restaurant_status', {
      name: 'check_restaurant_status',
      description: 'Check if a restaurant is open, their delivery time, and current offers. Use when user asks about a specific restaurant.',
      parameters: {
        type: 'object',
        properties: {
          restaurant_name: {
            type: 'string',
            description: 'Name of the restaurant',
          },
          restaurant_id: {
            type: 'string',
            description: 'Restaurant ID if known',
          },
        },
        required: ['restaurant_name'],
      },
    });

    // 5. Get Popular Items Tool
    this.tools.set('get_popular_items', {
      name: 'get_popular_items',
      description: 'Get trending/popular food items in the area. Use for "what\'s popular", "trending food", "bestsellers".',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Category to get popular items from',
          },
          limit: {
            type: 'string',
            description: 'Number of items to return',
          },
        },
        required: [],
      },
    });

    // 6. Extract Address / Location Tool
    this.tools.set('extract_address', {
      name: 'extract_address',
      description: 'Extract location/address from user input. Supports: Google Maps URLs (short links like maps.app.goo.gl/xxx, full URLs), raw coordinates (lat,lng), text addresses, area names. Use when user shares a Google Maps link, coordinates, or location text.',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'User input containing location - can be Google Maps URL, coordinates like "19.96, 73.75", or text address like "Nashik Road, near station"',
          },
          city: {
            type: 'string',
            description: 'City context for geocoding (default: Nashik)',
          },
        },
        required: ['input'],
      },
    });

    // 7. Save Address Tool
    this.tools.set('save_user_address', {
      name: 'save_user_address',
      description: 'Save a location/address for the user. Use when user wants to save an address as home, office, or other. Requires coordinates (latitude, longitude) and address type.',
      parameters: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            description: 'Latitude coordinate of the address',
          },
          longitude: {
            type: 'number',
            description: 'Longitude coordinate of the address',
          },
          address_type: {
            type: 'string',
            enum: ['home', 'office', 'other'],
            description: 'Type of address - home, office, or other',
          },
          address_text: {
            type: 'string',
            description: 'Human-readable address text (optional - will be reverse geocoded if not provided)',
          },
          landmark: {
            type: 'string',
            description: 'Nearby landmark for easier identification',
          },
        },
        required: ['latitude', 'longitude', 'address_type'],
      },
    });
  }

  /**
   * Get all tool definitions formatted for LLM
   */
  getToolDefinitions(): LlmTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a tool by name
   */
  async executeTool(
    toolName: string,
    params: Record<string, any>,
    sessionId: string,
  ): Promise<ToolResult> {
    this.logger.log(`🔧 Executing tool: ${toolName}`, params);

    const session = await this.sessionService.getSession(sessionId);
    const zoneId = session?.data?.zoneId;
    const lat = session?.data?.location?.lat;
    const lng = session?.data?.location?.lng;

    try {
      switch (toolName) {
        case 'search_food':
          return this.searchFood(params, zoneId, lat, lng);

        case 'get_recommendations':
          return this.getRecommendations(params, session, zoneId);

        case 'compare_prices':
          return this.comparePrices(params, zoneId);

        case 'check_restaurant_status':
          return this.checkRestaurantStatus(params, zoneId, lat, lng);

        case 'get_popular_items':
          return this.getPopularItems(params, zoneId);

        case 'extract_address':
          return this.extractAddress(params, sessionId);

        case 'save_user_address':
          return this.saveUserAddress(params, sessionId, session);

        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`,
          };
      }
    } catch (error) {
      this.logger.error(`Tool execution failed: ${toolName}`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Search for food items
   */
  private async searchFood(
    params: Record<string, any>,
    zoneId?: number,
    lat?: number,
    lng?: number,
  ): Promise<ToolResult> {
    const { query, category, price_range, veg_only } = params;

    try {
      // Use SearchOrchestrator for intelligent routing
      const nluOutput: NLUOutput = {
        module_id: 4, // Food module
        module_type: 'food',
        intent: 'intent.item.search',
        entities: {
          query,
          category,
          price_range,
          veg_only: veg_only === 'true',
        },
        confidence: 1.0,
        text: query,
      };

      const result = await this.searchOrchestrator.route(nluOutput, {
        zoneId,
        lat,
        lng,
      });

      // Format results for user
      const items = result.data?.data || result.data?.items || [];
      const formatted = this.formatSearchResults(items, query);

      return {
        success: true,
        data: {
          items: items.slice(0, 10), // Limit to 10 results
          total: items.length,
          source: result.source,
        },
        formatted,
      };
    } catch (error) {
      // Fallback to PHP search
      const phpResult = await this.phpStoreService.searchItems(query, zoneId);
      const items = phpResult?.data || [];

      return {
        success: true,
        data: {
          items: items.slice(0, 10),
          total: items.length,
          source: 'php_fallback',
        },
        formatted: this.formatSearchResults(items, query),
      };
    }
  }

  /**
   * Get personalized recommendations
   */
  private async getRecommendations(
    params: Record<string, any>,
    session: any,
    zoneId?: number,
  ): Promise<ToolResult> {
    const { preference, mood, budget, cuisine } = params;

    // Get user's order history for better recommendations
    const orderHistory = session?.data?.orderHistory || [];
    const lastOrders = orderHistory.slice(-5);

    // Get time-based context
    const hour = new Date().getHours();
    let mealTime = 'snacks';
    if (hour >= 6 && hour < 11) mealTime = 'breakfast';
    else if (hour >= 11 && hour < 15) mealTime = 'lunch';
    else if (hour >= 15 && hour < 18) mealTime = 'snacks';
    else if (hour >= 18 && hour < 22) mealTime = 'dinner';
    else mealTime = 'late_night';

    // Build recommendation query
    let searchQuery = '';
    if (cuisine && cuisine !== 'any') {
      searchQuery = cuisine;
    } else if (mood) {
      // Map mood to search terms
      const moodMap = {
        comfort: 'biryani dal rice',
        healthy: 'salad grilled',
        light: 'soup sandwich',
        heavy: 'thali combo meal',
        spicy: 'spicy chicken masala',
        sweet: 'dessert ice cream',
      };
      searchQuery = moodMap[mood] || mood;
    } else {
      // Default based on meal time
      const timeMap = {
        breakfast: 'poha idli dosa paratha',
        lunch: 'thali biryani rice',
        snacks: 'samosa chaat pakoda',
        dinner: 'curry roti dal',
        late_night: 'pizza burger',
      };
      searchQuery = timeMap[mealTime] || 'popular';
    }

    // Search for recommendations
    const result = await this.searchFood({ query: searchQuery, veg_only: preference === 'veg' ? 'true' : 'false' }, zoneId);

    // Add recommendation context
    const recommendations = result.data?.items || [];
    const formatted = this.formatRecommendations(recommendations, mealTime, mood);

    return {
      success: true,
      data: {
        recommendations: recommendations.slice(0, 5),
        context: {
          mealTime,
          mood,
          preference,
          basedOn: lastOrders.length > 0 ? 'order_history' : 'time_and_preferences',
        },
      },
      formatted,
    };
  }

  /**
   * Compare prices across restaurants
   */
  private async comparePrices(
    params: Record<string, any>,
    zoneId?: number,
  ): Promise<ToolResult> {
    const { item, max_results = '5' } = params;
    const limit = parseInt(max_results) || 5;

    // Search for the item across restaurants
    const result = await this.searchFood({ query: item }, zoneId);
    const items = result.data?.items || [];

    // Group by store and sort by price
    const byStore = new Map<string, any>();
    for (const foodItem of items) {
      const storeId = foodItem.store_id || foodItem.restaurant_id;
      const storeName = foodItem.store_name || foodItem.restaurant_name || 'Unknown';
      const price = parseFloat(foodItem.price) || 0;

      if (!byStore.has(storeId) || price < byStore.get(storeId).price) {
        byStore.set(storeId, {
          store_id: storeId,
          store_name: storeName,
          item_name: foodItem.name,
          price,
          rating: foodItem.rating,
          delivery_time: foodItem.delivery_time,
        });
      }
    }

    // Sort by price and limit
    const compared = Array.from(byStore.values())
      .sort((a, b) => a.price - b.price)
      .slice(0, limit);

    const formatted = this.formatPriceComparison(compared, item);

    return {
      success: true,
      data: {
        item,
        comparisons: compared,
        cheapest: compared[0],
      },
      formatted,
    };
  }

  /**
   * Check restaurant status
   */
  private async checkRestaurantStatus(
    params: Record<string, any>,
    zoneId?: number,
    lat?: number,
    lng?: number,
  ): Promise<ToolResult> {
    const { restaurant_name, restaurant_id } = params;

    let storeDetails: any = null;

    if (restaurant_id) {
      storeDetails = await this.phpStoreService.getStoreDetails(
        parseInt(restaurant_id),
        lat,
        lng,
        zoneId,
      );
    } else {
      // Search for restaurant by name
      const searchResult = await this.phpStoreService.searchStores(restaurant_name, zoneId);
      const stores = searchResult?.data || [];
      if (stores.length > 0) {
        storeDetails = stores[0];
      }
    }

    if (!storeDetails) {
      return {
        success: false,
        error: `Restaurant "${restaurant_name}" not found`,
        formatted: `Sorry, I couldn't find "${restaurant_name}" in your area. Would you like to search for similar restaurants?`,
      };
    }

    const formatted = this.formatRestaurantStatus(storeDetails);

    return {
      success: true,
      data: storeDetails,
      formatted,
    };
  }

  /**
   * Get popular items
   */
  private async getPopularItems(
    params: Record<string, any>,
    zoneId?: number,
  ): Promise<ToolResult> {
    const { category, limit = '5' } = params;
    const maxItems = parseInt(limit) || 5;

    // Search for popular items
    const query = category || 'popular bestseller trending';
    const result = await this.searchFood({ query }, zoneId);
    const items = (result.data?.items || []).slice(0, maxItems);

    const formatted = this.formatPopularItems(items);

    return {
      success: true,
      data: {
        items,
        category: category || 'all',
      },
      formatted,
    };
  }

  // ============ Formatting Helpers ============

  private formatSearchResults(items: any[], query: string): string {
    if (!items || items.length === 0) {
      return `No results found for "${query}". Would you like to try a different search?`;
    }

    const lines = [`🔍 Found ${items.length} results for "${query}":\n`];
    
    for (let i = 0; i < Math.min(5, items.length); i++) {
      const item = items[i];
      const price = item.price ? `₹${item.price}` : '';
      const rating = item.rating ? `⭐ ${item.rating}` : '';
      const store = item.store_name || item.restaurant_name || '';
      
      lines.push(`${i + 1}. **${item.name}** ${price} ${rating}`);
      if (store) lines.push(`   📍 ${store}`);
    }

    if (items.length > 5) {
      lines.push(`\n... and ${items.length - 5} more items`);
    }

    lines.push('\nWould you like to order any of these?');
    return lines.join('\n');
  }

  private formatRecommendations(items: any[], mealTime: string, mood?: string): string {
    if (!items || items.length === 0) {
      return `I couldn't find recommendations right now. What would you like to eat?`;
    }

    const moodEmoji = mood ? {
      comfort: '🍲',
      healthy: '🥗',
      light: '🥪',
      heavy: '🍛',
      spicy: '🌶️',
      sweet: '🍰',
    }[mood] || '🍽️' : '🍽️';

    const lines = [`${moodEmoji} Here are my recommendations for ${mealTime}:\n`];
    
    for (let i = 0; i < Math.min(5, items.length); i++) {
      const item = items[i];
      const price = item.price ? `₹${item.price}` : '';
      const rating = item.rating ? `⭐ ${item.rating}` : '';
      
      lines.push(`${i + 1}. **${item.name}** ${price} ${rating}`);
    }

    lines.push('\nWant me to add any of these to your order?');
    return lines.join('\n');
  }

  private formatPriceComparison(comparisons: any[], item: string): string {
    if (!comparisons || comparisons.length === 0) {
      return `I couldn't find "${item}" across multiple restaurants. Would you like to search for something else?`;
    }

    const lines = [`💰 Price comparison for "${item}":\n`];
    
    for (let i = 0; i < comparisons.length; i++) {
      const c = comparisons[i];
      const best = i === 0 ? ' 🏆 BEST PRICE' : '';
      const rating = c.rating ? `⭐ ${c.rating}` : '';
      const time = c.delivery_time ? `⏱️ ${c.delivery_time} min` : '';
      
      lines.push(`${i + 1}. **${c.store_name}**: ₹${c.price}${best}`);
      lines.push(`   ${rating} ${time}`);
    }

    const savings = comparisons.length > 1 
      ? `\n💡 You can save ₹${(comparisons[comparisons.length - 1].price - comparisons[0].price).toFixed(0)} by ordering from ${comparisons[0].store_name}!`
      : '';

    lines.push(savings);
    lines.push('\nWould you like to order from the cheapest option?');
    return lines.join('\n');
  }

  private formatRestaurantStatus(store: any): string {
    const name = store.name || store.store_name || 'Restaurant';
    const isOpen = store.open || store.is_open || store.active;
    const status = isOpen ? '🟢 Open' : '🔴 Closed';
    const rating = store.rating ? `⭐ ${store.rating}` : '';
    const deliveryTime = store.delivery_time || store.avg_delivery_time;
    const timeStr = deliveryTime ? `⏱️ ${deliveryTime} min delivery` : '';
    const minOrder = store.min_order || store.minimum_order;
    const minStr = minOrder ? `📦 Min order: ₹${minOrder}` : '';

    const lines = [
      `🏪 **${name}** ${status}`,
      rating,
      timeStr,
      minStr,
    ].filter(Boolean);

    if (store.offers || store.discount) {
      lines.push(`🎁 ${store.offers || store.discount}`);
    }

    if (!isOpen) {
      lines.push('\nWould you like me to notify you when they open?');
    } else {
      lines.push('\nWould you like to see their menu?');
    }

    return lines.join('\n');
  }

  private formatPopularItems(items: any[]): string {
    if (!items || items.length === 0) {
      return `🔥 No trending items right now. What are you in the mood for?`;
    }

    const lines = [`🔥 Trending right now:\n`];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const price = item.price ? `₹${item.price}` : '';
      const rating = item.rating ? `⭐ ${item.rating}` : '';
      const store = item.store_name || item.restaurant_name || '';
      
      lines.push(`${i + 1}. **${item.name}** ${price} ${rating}`);
      if (store) lines.push(`   📍 ${store}`);
    }

    lines.push('\nWant to try any of these?');
    return lines.join('\n');
  }

  /**
   * Decide whether to use a tool or trigger a flow
   * Returns 'tool' if query can be answered with a tool
   * Returns 'flow' if query requires transactional flow
   */
  async decideToolVsFlow(
    message: string,
    sessionId: string,
  ): Promise<{
    decision: 'tool' | 'flow' | 'chat';
    toolName?: string;
    toolParams?: Record<string, any>;
    flowId?: string;
    reason: string;
  }> {
    // Patterns for tool usage
    const toolPatterns = {
      search_food: [
        /\b(show|find|search|get|list|where.*(?:can|to).*(?:get|find|buy))\b.*\b(food|pizza|biryani|burger|chinese|indian|restaurant)/i,
        /\b(what|which)\b.*\b(restaurants?|places?)\b.*\b(have|sell|serve)/i,
        /\b(is|are)\b.*\b(available|open)/i,
      ],
      get_recommendations: [
        /\b(suggest|recommend|what.?(?:should|can|to))\b.*\b(eat|order|try)/i,
        /\b(i.?(?:am|m)|feeling)\b.*\b(hungry|bored|like)/i,
        /\bsuggest(?:ion|s)?\b/i,
        /\bwhat.?(?:s|is)\b.*\b(good|popular|trending)/i,
      ],
      compare_prices: [
        /\b(compare|cheapest|lowest|best.?price|price.?comparison)/i,
        /\bwhere.*\b(cheap|less|afford)/i,
        /\b(which|what).*\b(restaurant|place).*\b(cheap|afford|budget)/i,
      ],
      check_restaurant_status: [
        /\b(is|are)\b.*\b(open|closed|available)\b/i,
        /\b(check|status|hours?|timing|delivery.?time)\b.*\b(restaurant|store|shop)/i,
      ],
      get_popular_items: [
        /\b(popular|trending|bestseller|top.?rated|famous)\b/i,
        /\bwhat.?(?:s|is)\b.*\b(everyone|people)\b.*\b(ordering|eating)/i,
      ],
    };

    // Patterns for flow triggers
    const flowPatterns = {
      'food-order': [
        /\b(order|book|buy|get)\b.*\b(food|pizza|biryani|burger)/i,
        /\b(add|cart|checkout|pay)/i,
        /\bi.?(?:want|need|like|ll)\b.*\b(to)?\b.*\b(order|eat)/i,
      ],
      'parcel-booking': [
        /\b(send|courier|parcel|delivery|ship)/i,
        /\b(pick.?up|drop|deliver)\b.*\b(package|parcel|item)/i,
      ],
    };

    // Check tool patterns
    for (const [toolName, patterns] of Object.entries(toolPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          // Extract parameters from message
          const params = this.extractToolParams(toolName, message);
          return {
            decision: 'tool',
            toolName,
            toolParams: params,
            reason: `Matched tool pattern for ${toolName}`,
          };
        }
      }
    }

    // Check flow patterns
    for (const [flowId, patterns] of Object.entries(flowPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          return {
            decision: 'flow',
            flowId,
            reason: `Matched flow pattern for ${flowId}`,
          };
        }
      }
    }

    // Default to chat (let LLM handle conversationally)
    return {
      decision: 'chat',
      reason: 'No specific tool or flow pattern matched',
    };
  }

  /**
   * Extract tool parameters from message
   */
  private extractToolParams(toolName: string, message: string): Record<string, any> {
    const params: Record<string, any> = {};
    const lowerMsg = message.toLowerCase();

    switch (toolName) {
      case 'search_food':
        // Extract food item from message
        const foodMatch = message.match(/(?:find|search|get|show|order)\s+(.+?)(?:\s+(?:near|from|at|in))?$/i);
        params.query = foodMatch?.[1] || message;
        
        // Check for veg preference
        if (/\b(veg|vegetarian)\b/i.test(message)) {
          params.veg_only = 'true';
        }
        break;

      case 'get_recommendations':
        if (/\b(veg|vegetarian)\b/i.test(message)) params.preference = 'veg';
        if (/\b(non.?veg|chicken|mutton|fish)\b/i.test(message)) params.preference = 'non_veg';
        if (/\b(spicy|hot)\b/i.test(message)) params.mood = 'spicy';
        if (/\b(healthy|light|salad)\b/i.test(message)) params.mood = 'healthy';
        if (/\b(sweet|dessert)\b/i.test(message)) params.mood = 'sweet';
        break;

      case 'compare_prices':
        const itemMatch = message.match(/(?:compare|cheapest|price)\s+(?:for\s+)?(.+?)(?:\s+(?:across|in|at))?$/i);
        params.item = itemMatch?.[1] || message.replace(/compare|cheapest|price|for|across|in|at/gi, '').trim();
        break;

      case 'check_restaurant_status':
        const restaurantMatch = message.match(/(?:is|check)\s+(.+?)\s+(?:open|closed|available|status)/i);
        params.restaurant_name = restaurantMatch?.[1] || message;
        break;

      case 'get_popular_items':
        if (/\b(pizza)\b/i.test(message)) params.category = 'pizza';
        if (/\b(biryani)\b/i.test(message)) params.category = 'biryani';
        if (/\b(burger)\b/i.test(message)) params.category = 'burger';
        if (/\b(dessert|sweet)\b/i.test(message)) params.category = 'desserts';
        break;

      case 'extract_address':
        params.input = message;
        params.city = this.configService.get('geo.defaultCity', 'Nashik');
        break;
    }

    return params;
  }

  /**
   * Extract address/location from user input
   * Supports: Google Maps URLs, coordinates, text addresses
   */
  private async extractAddress(
    params: Record<string, any>,
    sessionId: string,
  ): Promise<ToolResult> {
    const { input, city } = params;
    
    this.logger.log(`📍 Extracting address from: "${input?.substring(0, 100)}..."`);

    try {
      const result = await this.addressExtractionService.extractAddress(input, { city });

      if (result.success && result.address) {
        // Save to session for later use
        if (result.address.latitude && result.address.longitude) {
          await this.sessionService.setData(sessionId, {
            location: {
              lat: result.address.latitude,
              lng: result.address.longitude,
            },
            location_address: result.address.address,
            lastLocationUpdate: Date.now(),
          });
        }

        return {
          success: true,
          data: {
            address: result.address.address,
            latitude: result.address.latitude,
            longitude: result.address.longitude,
            source: result.address.source,
            confidence: result.address.confidence || 1.0,
          },
          formatted: `📍 Location: ${result.address.address}\nCoordinates: ${result.address.latitude}, ${result.address.longitude}`,
        };
      }

      return {
        success: false,
        error: result.error || 'Could not extract address',
        formatted: result.clarificationPrompt || 'Please share a valid location - you can paste a Google Maps link, type coordinates, or describe the area.',
      };
    } catch (error) {
      this.logger.error('Address extraction failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Save user address to their account
   * Requires authentication
   */
  private async saveUserAddress(
    params: Record<string, any>,
    sessionId: string,
    session: any,
  ): Promise<ToolResult> {
    const { latitude, longitude, address_type, address_text, landmark } = params;
    
    this.logger.log(`📍 Saving address: type=${address_type}, lat=${latitude}, lng=${longitude}`);

    // Check authentication
    if (!session?.authenticated || !session?.auth_token) {
      return {
        success: false,
        error: 'User not authenticated',
        formatted: '🔐 Please login first to save addresses. Would you like to login now?',
      };
    }

    // Validate coordinates
    if (!latitude || !longitude) {
      return {
        success: false,
        error: 'Missing coordinates',
        formatted: '📍 I need your exact location to save the address. Please share your location or paste a Google Maps link.',
      };
    }

    try {
      // Get address text via reverse geocoding if not provided
      let finalAddressText = address_text;
      if (!finalAddressText) {
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18`,
            { headers: { 'User-Agent': 'MangwaleAI/1.0' } }
          );
          const data = await response.json();
          finalAddressText = data.display_name || `Location at ${latitude}, ${longitude}`;
        } catch (e) {
          finalAddressText = `Location at ${latitude}, ${longitude}`;
        }
      }

      // Get user info for contact details
      const userInfo = session?.data?.user_info || {};
      const contactName = userInfo.f_name || 'User';
      const contactPhone = session?.data?.phone || sessionId.replace('web-', '') || '';

      const result = await this.phpAddressService.addAddress(session.auth_token, {
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
          data: {
            addressId: result.addressId,
            addressType: address_type,
            address: finalAddressText,
          },
          formatted: `${typeEmoji} **Address saved as "${address_type || 'other'}"!**\n\n📍 ${finalAddressText}\n\nYou can use this address for future orders.`,
        };
      }

      return {
        success: false,
        error: result.message || 'Failed to save address',
        formatted: 'Sorry, I couldn\'t save the address. Please try again.',
      };
    } catch (error) {
      this.logger.error('Save address failed:', error);
      return {
        success: false,
        error: error.message,
        formatted: 'I had trouble saving the address. Please try again later.',
      };
    }
  }
}
