import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { UserPreferenceService, UserPreferences } from './user-preference.service';
import { UserContextService, UserOrderHistory } from '../user-context/user-context.service';

/**
 * User Interaction Pattern - tracks how user behaves in flows
 */
export interface UserInteractionPattern {
  userId: number;
  
  // Flow behavior
  averageStepsToCheckout: number;
  skipsBrowsingForReorder: boolean;
  prefersQuickReorder: boolean;
  usesVoiceCommands: boolean;
  
  // Decision patterns
  decisiveUser: boolean;  // Knows what they want quickly
  exploratoryUser: boolean;  // Likes to browse options
  priceComparator: boolean;  // Often compares prices
  
  // Abandonment signals
  abandonmentRate: number; // 0-1
  commonAbandonmentStates: string[];
  
  // Time patterns
  avgTimeOnDecision: number; // seconds
  peakOrderingHours: number[]; // [12, 13, 19, 20]
  
  // Content preferences  
  prefersDetailedInfo: boolean;
  prefersMinimalUI: boolean;
  clicksOnSuggestions: boolean;
}

/**
 * Flow Adaptation - how to modify flow for this user
 */
export interface FlowAdaptation {
  // Skip steps
  skipBrowsing: boolean;
  skipConfirmation: boolean;
  skipUpsells: boolean;
  
  // Show/hide features
  showQuickReorder: boolean;
  showPriceComparisons: boolean;
  showDetailedDescriptions: boolean;
  showSuggestions: boolean;
  
  // Modify prompts
  useShortPrompts: boolean;
  useCasualTone: boolean;
  includeEmojis: boolean;
  
  // Auto-actions
  autoSelectLastAddress: boolean;
  autoSelectLastPayment: boolean;
  prefillQuantities: boolean;
  
  // Upsell strategy
  upsellAggressiveness: 'none' | 'subtle' | 'moderate' | 'aggressive';
  
  // Special flows
  suggestReorder: boolean;
  offerSubscription: boolean;
}

/**
 * Merged from SmartDefaultsService:
 * Smart defaults for a specific flow/action
 */
export interface SmartDefaults {
  // Address defaults
  defaultAddress?: {
    id: number;
    fullAddress: string;
    lat: number;
    lng: number;
    zoneId?: number;
    label?: string; // Home, Work, etc.
    confidence: number; // 0-1 how confident we are this is the right choice
  };

  // Payment defaults
  defaultPayment?: {
    method: string; // 'cod', 'wallet', 'upi', 'card'
    walletBalance?: number;
    confidence: number;
  };

  // Food preferences defaults
  defaultQuantity?: number;
  defaultSpiceLevel?: string;
  suggestedItems?: Array<{
    itemId: number;
    itemName: string;
    reason: string; // "You ordered this 5 times before"
    lastOrderDate?: Date;
    frequency: number;
  }>;

  // Time defaults
  suggestedDeliveryTime?: string; // 'ASAP' or specific time
  usualOrderTime?: string; // "You usually order around 7 PM"

  // Store defaults
  preferredStores?: Array<{
    storeId: number;
    storeName: string;
    orderCount: number;
    avgRating?: number;
  }>;
}

/**
 * Context for making smart default decisions
 */
interface UserOrderContext {
  orderHistory: UserOrderHistory | null;
  frequentItems: Map<string, number>;
  frequentStores: Map<number, { name: string; count: number }>;
  typicalOrderTime: number; // hour of day
  typicalOrderValue: number;
}

/**
 * Adaptive Flow Service
 * 
 * Provides dynamic flow adaptations based on user behavior patterns.
 * This enables "smart" flows that learn and adapt to each user.
 * 
 * Key Features:
 * 1. Track user interaction patterns across sessions
 * 2. Identify decisive vs exploratory users
 * 3. Detect abandonment signals and intervene
 * 4. Personalize flow steps and prompts
 * 5. Auto-skip unnecessary steps for power users
 */
@Injectable()
export class AdaptiveFlowService {
  private readonly logger = new Logger(AdaptiveFlowService.name);
  
  // Cache patterns for quick access
  private patternCache = new Map<number, { pattern: UserInteractionPattern; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // ===================================
  // Merged from SmartDefaultsService
  // ===================================
  private defaultsCache = new Map<number, { defaults: SmartDefaults; timestamp: number }>();
  private readonly DEFAULTS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  constructor(
    private prisma: PrismaService,
    private userPreferenceService: UserPreferenceService,
    @Optional() private userContextService?: UserContextService,
  ) {}

  /**
   * Get flow adaptations for a user
   */
  async getFlowAdaptations(userId: number): Promise<FlowAdaptation> {
    try {
      const [pattern, preferences] = await Promise.all([
        this.getUserInteractionPattern(userId),
        this.userPreferenceService.getPreferences(userId),
      ]);

      return this.computeAdaptations(pattern, preferences);
    } catch (error) {
      this.logger.error(`Failed to get adaptations for user ${userId}: ${error.message}`);
      return this.getDefaultAdaptations();
    }
  }

  /**
   * Get user interaction pattern from database/cache
   */
  async getUserInteractionPattern(userId: number): Promise<UserInteractionPattern> {
    // Check cache
    const cached = this.patternCache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.pattern;
    }

    try {
      // Fetch interaction data
      const interactions = await this.prisma.user_interactions.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: 100, // Last 100 interactions
      });

      const pattern = this.analyzeInteractionPattern(userId, interactions);
      
      // Cache it
      this.patternCache.set(userId, { pattern, timestamp: Date.now() });
      
      return pattern;
    } catch (error) {
      this.logger.warn(`Error fetching patterns for user ${userId}: ${error.message}`);
      return this.getDefaultPattern(userId);
    }
  }

  /**
   * Analyze raw interaction data to build pattern
   */
  private analyzeInteractionPattern(
    userId: number,
    interactions: any[]
  ): UserInteractionPattern {
    // Analyze interactions
    const clicks = interactions.filter(i => i.interaction_type === 'click');
    const selections = interactions.filter(i => i.interaction_type === 'selection');
    const searches = interactions.filter(i => i.interaction_type === 'search');
    const reorders = interactions.filter(i => i.interaction_type === 'reorder');

    // Calculate click-through on suggestions
    const suggestionClicks = clicks.filter(c => 
      c.metadata && (c.metadata as any).source === 'suggestion'
    );
    const clicksOnSuggestions = suggestionClicks.length / Math.max(clicks.length, 1) > 0.3;

    // Analyze interaction-based patterns (without session data)
    const completedInteractions = interactions.filter(i => i.interaction_type === 'checkout');
    const abandonedInteractions = interactions.filter(i => i.interaction_type === 'abandon');
    
    const totalInteractions = interactions.length;
    const completedCount = completedInteractions.length;
    const abandonedCount = abandonedInteractions.length;
    
    const avgSteps = completedCount > 0 ? 8 : 10; // Estimate based on completion
    const abandonmentRate = totalInteractions > 0 ? abandonedCount / totalInteractions : 0;

    // Determine user type based on interactions
    const avgDecisionTime = 30; // Default estimate
    const decisive = completedCount > abandonedCount && searches.length < selections.length * 2;
    const exploratory = searches.length > selections.length * 2;
    const priceComparator = interactions.filter(i => 
      i.interaction_type === 'view' && (i.metadata as any)?.view === 'price_comparison'
    ).length > 2;

    // Time analysis from interactions
    const orderHours: number[] = [];
    for (const interaction of interactions.filter(i => i.created_at)) {
      const hour = new Date(interaction.created_at).getHours();
      orderHours.push(hour);
    }
    const peakHours = this.findPeakHours(orderHours);

    // Get common abandonment states from metadata
    const abandonmentStates = abandonedInteractions
      .map(i => (i.metadata as any)?.state)
      .filter(Boolean);

    return {
      userId,
      averageStepsToCheckout: avgSteps,
      skipsBrowsingForReorder: reorders.length > completedCount * 0.3,
      prefersQuickReorder: reorders.length > 5,
      usesVoiceCommands: false,
      decisiveUser: decisive,
      exploratoryUser: exploratory,
      priceComparator,
      abandonmentRate,
      commonAbandonmentStates: [...new Set(abandonmentStates)].slice(0, 3),
      avgTimeOnDecision: avgDecisionTime,
      peakOrderingHours: peakHours,
      prefersDetailedInfo: exploratory || priceComparator,
      prefersMinimalUI: decisive && avgSteps < 6,
      clicksOnSuggestions,
    };
  }

  /**
   * Find peak ordering hours
   */
  private findPeakHours(hours: number[]): number[] {
    const counts = new Map<number, number>();
    for (const h of hours) {
      counts.set(h, (counts.get(h) || 0) + 1);
    }
    
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([hour]) => hour);
  }

  /**
   * Compute adaptations based on pattern and preferences
   */
  private computeAdaptations(
    pattern: UserInteractionPattern,
    preferences: UserPreferences
  ): FlowAdaptation {
    const { decisiveUser, exploratoryUser, priceComparator, abandonmentRate, 
            prefersQuickReorder, clicksOnSuggestions, prefersMinimalUI } = pattern;
    
    const tone = preferences.communicationTone || 'friendly';
    const emojiUsage = preferences.emojiUsage || 'moderate';
    const messageLength = preferences.messageLength || 'medium';

    return {
      // Skip steps for decisive/power users
      skipBrowsing: decisiveUser && prefersQuickReorder,
      skipConfirmation: decisiveUser && pattern.averageStepsToCheckout < 6,
      skipUpsells: decisiveUser || abandonmentRate > 0.5,

      // Show features based on behavior
      showQuickReorder: prefersQuickReorder,
      showPriceComparisons: priceComparator || exploratoryUser,
      showDetailedDescriptions: exploratoryUser || pattern.prefersDetailedInfo,
      showSuggestions: clicksOnSuggestions || exploratoryUser,

      // Prompt modifications
      useShortPrompts: messageLength === 'short' || prefersMinimalUI || decisiveUser,
      useCasualTone: tone === 'casual' || tone === 'friendly',
      includeEmojis: emojiUsage === 'love' || emojiUsage === 'moderate',

      // Auto-actions for power users
      autoSelectLastAddress: decisiveUser || prefersQuickReorder,
      autoSelectLastPayment: decisiveUser,
      prefillQuantities: prefersQuickReorder,

      // Upsell strategy based on abandonment and behavior
      upsellAggressiveness: abandonmentRate > 0.4 ? 'none' : 
                           decisiveUser ? 'subtle' :
                           exploratoryUser ? 'moderate' : 'subtle',

      // Special flows
      suggestReorder: prefersQuickReorder,
      offerSubscription: pattern.averageStepsToCheckout < 8 && abandonmentRate < 0.2,
    };
  }

  /**
   * Record a user interaction for future analysis
   */
  async recordInteraction(
    userId: number,
    type: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      await this.prisma.user_interactions.create({
        data: {
          user_id: userId,
          item_id: metadata.itemId || 0,  // Required field
          interaction_type: type,
          metadata: metadata as any,
          created_at: new Date(),
        },
      });

      // Invalidate cache
      this.patternCache.delete(userId);
    } catch (error) {
      this.logger.warn(`Failed to record interaction: ${error.message}`);
    }
  }

  /**
   * Check if we should intervene to prevent abandonment
   */
  async shouldIntervenePrevention(
    userId: number,
    currentState: string,
    timeInState: number // seconds
  ): Promise<{ shouldIntervene: boolean; intervention?: string }> {
    const pattern = await this.getUserInteractionPattern(userId);
    
    // Check if current state is a common abandonment point
    if (pattern.commonAbandonmentStates.includes(currentState)) {
      if (timeInState > pattern.avgTimeOnDecision * 2) {
        return {
          shouldIntervene: true,
          intervention: this.getInterventionMessage(currentState),
        };
      }
    }

    // Check for general stalling
    if (timeInState > 120 && pattern.abandonmentRate > 0.3) {
      return {
        shouldIntervene: true,
        intervention: "Need any help? I'm here to assist! 🙋",
      };
    }

    return { shouldIntervene: false };
  }

  /**
   * Get context-specific intervention message
   */
  private getInterventionMessage(state: string): string {
    const interventions: Record<string, string> = {
      'show_results': "Can't find what you're looking for? Try describing it differently, or I can show you popular items! 🍕",
      'confirm_address': "If your address looks correct, just say 'yes' to continue! Or tell me a different address.",
      'payment_selection': "Any payment method works! You can also pay cash on delivery if you prefer.",
      'cart_review': "Ready to order? Just say 'checkout' when you're ready! 🛒",
      'quantity_selection': "Just tell me the quantity you'd like, or select from the buttons above!",
    };
    
    return interventions[state] || "Still there? Let me know if you need any help! 😊";
  }

  /**
   * Get default adaptations for new users
   */
  private getDefaultAdaptations(): FlowAdaptation {
    return {
      skipBrowsing: false,
      skipConfirmation: false,
      skipUpsells: false,
      showQuickReorder: false,
      showPriceComparisons: false,
      showDetailedDescriptions: true,
      showSuggestions: true,
      useShortPrompts: false,
      useCasualTone: true,
      includeEmojis: true,
      autoSelectLastAddress: false,
      autoSelectLastPayment: false,
      prefillQuantities: false,
      upsellAggressiveness: 'subtle',
      suggestReorder: false,
      offerSubscription: false,
    };
  }

  /**
   * Get default pattern for users without history
   */
  private getDefaultPattern(userId: number): UserInteractionPattern {
    return {
      userId,
      averageStepsToCheckout: 10,
      skipsBrowsingForReorder: false,
      prefersQuickReorder: false,
      usesVoiceCommands: false,
      decisiveUser: false,
      exploratoryUser: true,
      priceComparator: false,
      abandonmentRate: 0,
      commonAbandonmentStates: [],
      avgTimeOnDecision: 30,
      peakOrderingHours: [12, 13, 19, 20],
      prefersDetailedInfo: true,
      prefersMinimalUI: false,
      clicksOnSuggestions: true,
    };
  }

  // ===================================
  // Methods merged from SmartDefaultsService
  // ===================================

  /**
   * Get smart defaults for a user in a specific context
   */
  async getSmartDefaults(
    userId: number,
    context?: {
      flowType?: string; // 'food_order', 'grocery', 'pharmacy'
      currentTime?: Date;
      searchQuery?: string;
    }
  ): Promise<SmartDefaults> {
    try {
      // Check cache
      const cached = this.defaultsCache.get(userId);
      if (cached && Date.now() - cached.timestamp < this.DEFAULTS_CACHE_TTL) {
        return this.adjustForContext(cached.defaults, context);
      }

      const orderContext = await this.buildUserOrderContext(userId);
      const defaults = await this.computeSmartDefaults(userId, orderContext);

      // Cache it
      this.defaultsCache.set(userId, { defaults, timestamp: Date.now() });

      return this.adjustForContext(defaults, context);
    } catch (error) {
      this.logger.error(`Failed to get smart defaults for user ${userId}: ${error.message}`);
      return this.getEmptyDefaults();
    }
  }

  /**
   * Build user's order context from history
   * Uses getUserContext which gets full order history via phone lookup
   */
  private async buildUserOrderContext(userId: number): Promise<UserOrderContext> {
    // Default empty context
    let orderHistory: UserOrderHistory | null = null;
    const frequentItems = new Map<string, number>();
    const frequentStores = new Map<number, { name: string; count: number }>();
    let typicalOrderTime = 19; // Default 7 PM
    let typicalOrderValue = 300;

    // Try to get phone from profile to fetch order history
    if (this.userContextService) {
      try {
        const profile = await this.prisma.user_profiles.findUnique({
          where: { user_id: userId },
        });

        if (profile?.phone) {
          // Use public getOrderHistoryByPhone method
          orderHistory = await this.userContextService.getOrderHistoryByPhone(profile.phone);
        }

        if (orderHistory) {
          // Process favorite items from history
          for (const item of orderHistory.favoriteItems || []) {
            frequentItems.set(item.itemName.toLowerCase(), item.orderCount);
          }

          // Process favorite stores from history
          for (const store of orderHistory.favoriteStores || []) {
            frequentStores.set(store.storeId, {
              name: store.storeName,
              count: store.orderCount
            });
          }

          // Calculate typical order time from recent orders
          const orderHours: number[] = [];
          for (const order of orderHistory.recentOrders || []) {
            if (order.createdAt) {
              const hour = new Date(order.createdAt).getHours();
              orderHours.push(hour);
            }
          }
          if (orderHours.length > 0) {
            typicalOrderTime = Math.round(orderHours.reduce((a, b) => a + b, 0) / orderHours.length);
          }

          // Use average order value from history
          if (orderHistory.avgOrderValue > 0) {
            typicalOrderValue = orderHistory.avgOrderValue;
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch order history: ${error.message}`);
      }
    }

    return {
      orderHistory,
      frequentItems,
      frequentStores,
      typicalOrderTime,
      typicalOrderValue,
    };
  }

  /**
   * Compute smart defaults from order context
   */
  private async computeSmartDefaults(
    userId: number,
    context: UserOrderContext
  ): Promise<SmartDefaults> {
    const defaults: SmartDefaults = {};
    const orderHistory = context.orderHistory;

    // 2. Suggested items - from favoriteItems in history
    const sortedItems = Array.from(context.frequentItems.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sortedItems.length > 0) {
      defaults.suggestedItems = sortedItems.map(([name, count], index) => {
        // Get matching favorite item from history if available
        const favoriteItem = orderHistory?.favoriteItems?.find(
          i => i.itemName.toLowerCase() === name
        );

        return {
          itemId: favoriteItem?.itemId || index,
          itemName: this.capitalizeWords(name),
          reason: count >= 5 ? `Ordered ${count} times` :
                  count >= 3 ? 'One of your favorites' :
                  'Recently ordered',
          lastOrderDate: orderHistory?.lastOrderDate || undefined,
          frequency: count,
        };
      });
    }

    // 3. Preferred stores - from favoriteStores in history
    const sortedStores = Array.from(context.frequentStores.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);

    if (sortedStores.length > 0) {
      defaults.preferredStores = sortedStores.map(([storeId, data]) => ({
        storeId,
        storeName: data.name,
        orderCount: data.count,
      }));
    }

    // 4. Typical order time
    defaults.usualOrderTime = this.formatTypicalTime(context.typicalOrderTime);

    // 5. Default quantity - use 1 as default (can't easily get from history)
    defaults.defaultQuantity = 1;

    // 6. Suggested delivery time based on current time
    const currentHour = new Date().getHours();
    if (Math.abs(currentHour - context.typicalOrderTime) < 2) {
      defaults.suggestedDeliveryTime = 'ASAP';
    }

    return defaults;
  }

  /**
   * Adjust defaults based on current context
   */
  private adjustForContext(
    defaults: SmartDefaults,
    context?: { flowType?: string; currentTime?: Date; searchQuery?: string }
  ): SmartDefaults {
    if (!context) return defaults;

    const adjusted = { ...defaults };
    const currentTime = context.currentTime || new Date();
    const currentHour = currentTime.getHours();

    // Time-based adjustments
    if (currentHour >= 6 && currentHour < 11) {
      // Morning - breakfast items
      adjusted.suggestedItems = defaults.suggestedItems?.filter(item =>
        this.isBreakfastItem(item.itemName)
      ) || adjusted.suggestedItems;
    } else if (currentHour >= 11 && currentHour < 15) {
      // Lunch time
      adjusted.suggestedItems = defaults.suggestedItems?.filter(item =>
        !this.isBreakfastItem(item.itemName)
      ) || adjusted.suggestedItems;
    }

    // Search query context - boost relevant items
    if (context.searchQuery) {
      const query = context.searchQuery.toLowerCase();
      adjusted.suggestedItems = defaults.suggestedItems?.sort((a, b) => {
        const aMatch = a.itemName.toLowerCase().includes(query) ? 1 : 0;
        const bMatch = b.itemName.toLowerCase().includes(query) ? 1 : 0;
        return bMatch - aMatch;
      });
    }

    return adjusted;
  }

  /**
   * Check if item is a breakfast item
   */
  private isBreakfastItem(name: string): boolean {
    const breakfastKeywords = ['poha', 'upma', 'idli', 'dosa', 'paratha', 'breakfast',
                               'omelette', 'toast', 'tea', 'coffee', 'chai', 'sandwich'];
    const lowerName = name.toLowerCase();
    return breakfastKeywords.some(k => lowerName.includes(k));
  }

  /**
   * Format typical order time for user message
   */
  private formatTypicalTime(hour: number): string {
    if (hour < 12) {
      return `${hour} AM`;
    } else if (hour === 12) {
      return '12 PM (noon)';
    } else {
      return `${hour - 12} PM`;
    }
  }

  /**
   * Capitalize words in item name
   */
  private capitalizeWords(str: string): string {
    return str.split(' ').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  /**
   * Get empty defaults for new users
   */
  private getEmptyDefaults(): SmartDefaults {
    return {
      defaultQuantity: 1,
      suggestedDeliveryTime: 'ASAP',
    };
  }

  /**
   * Get quick reorder suggestions
   */
  async getQuickReorderSuggestions(userId: number): Promise<{
    canQuickReorder: boolean;
    lastOrder?: {
      orderId: string;
      storeName: string;
      items: string[];
      totalAmount: number;
      orderDate: Date;
    };
    frequentOrders?: Array<{
      items: string[];
      storeName: string;
      frequency: number;
    }>;
  }> {
    if (!this.userContextService) {
      return { canQuickReorder: false };
    }

    try {
      // Get phone from profile
      const profile = await this.prisma.user_profiles.findUnique({
        where: { user_id: userId },
      });

      if (!profile?.phone) {
        return { canQuickReorder: false };
      }

      const orderHistory = await this.userContextService.getOrderHistoryByPhone(profile.phone);

      if (!orderHistory || orderHistory.recentOrders.length === 0) {
        return { canQuickReorder: false };
      }

      const lastOrder = orderHistory.recentOrders[0];

      // Group by items to find frequent order combinations
      const orderCombinations = new Map<string, { storeName: string; count: number }>();
      for (const order of orderHistory.recentOrders) {
        if (order.items && order.items.length > 0) {
          const key = order.items.sort().join('|');
          const existing = orderCombinations.get(key);
          if (existing) {
            existing.count++;
          } else {
            orderCombinations.set(key, {
              storeName: order.storeName || 'Unknown Store',
              count: 1
            });
          }
        }
      }

      // Find frequent combinations (ordered 2+ times)
      const frequentOrders = Array.from(orderCombinations.entries())
        .filter(([_, v]) => v.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3)
        .map(([items, data]) => ({
          items: items.split('|'),
          storeName: data.storeName,
          frequency: data.count,
        }));

      return {
        canQuickReorder: true,
        lastOrder: {
          orderId: String(lastOrder.orderId),
          storeName: lastOrder.storeName || 'Unknown Store',
          items: lastOrder.items || [],
          totalAmount: lastOrder.amount,
          orderDate: lastOrder.createdAt,
        },
        frequentOrders,
      };
    } catch (error) {
      this.logger.error(`Failed to get quick reorder suggestions: ${error.message}`);
      return { canQuickReorder: false };
    }
  }

  /**
   * Invalidate cache for a user (call after order completion)
   */
  invalidateCache(userId: number): void {
    this.defaultsCache.delete(userId);
    this.patternCache.delete(userId);
  }
}
