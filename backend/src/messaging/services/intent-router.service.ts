/**
 * IntentRouterService - Single Source of Truth for Intent-to-Flow Routing
 * 
 * This service centralizes ALL intent routing logic that was previously scattered across:
 * 1. context-router.service.ts (translateNluIntent, flowMapping)
 * 2. flow-engine.service.ts (findFlowByIntent)
 * 3. Individual flow definitions (trigger patterns)
 * 
 * ARCHITECTURE FIX: GAP 1 - Fragmented Intent Routing
 * NOW DATABASE-DRIVEN: Flow triggers loaded from flow_definitions table
 * 
 * Usage:
 *   const decision = await intentRouter.route(nluIntent, message, sessionContext);
 *   if (decision.flowId) {
 *     await flowEngine.startFlow(decision.flowId, ...);
 *   }
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SemanticFoodDetectorService } from '../../nlu/services/semantic-food-detector.service';
import { SemanticParcelDetectorService } from '../../nlu/services/semantic-parcel-detector.service';
import { FOOD_KEYWORDS_LIST } from '../../nlu/food-keywords.const';

/**
 * Flow trigger cache entry
 */
interface FlowTriggerCache {
  flowId: string;
  triggers: string[];     // ['order_food', 'browse_menu', 'search_food']
  priority: number;
  requiresAuth: boolean;
  enabled: boolean;
}

/**
 * Result of intent routing decision
 */
export interface RouteDecision {
  /** Original intent from NLU */
  originalIntent: string;
  
  /** Translated intent after applying rules */
  translatedIntent: string;
  
  /** Flow ID to start (null if no flow matches) */
  flowId: string | null;
  
  /** Whether an override was applied */
  overrideApplied: boolean;
  
  /** Reason for the routing decision */
  reason: string;
  
  /** Routing priority (for debugging) */
  priority: 'command' | 'keyword' | 'food_override' | 'intent_map' | 'fallback' | 'pattern';
  
  /** Confidence in this decision (0-1) */
  confidence: number;
}

/**
 * Session context needed for routing decisions
 */
export interface RoutingContext {
  /** Whether user has an active flow */
  hasActiveFlow: boolean;
  
  /** Current active flow ID */
  activeFlowId?: string;
  
  /** User is authenticated */
  isAuthenticated: boolean;
  
  /** Channel (whatsapp, telegram, web) */
  channel: string;
}

@Injectable()
export class IntentRouterService implements OnModuleInit {
  private readonly logger = new Logger(IntentRouterService.name);
  
  // Database-driven flow cache
  private flowCache: FlowTriggerCache[] = [];
  private flowMapping: Record<string, string> = {};
  private lastCacheUpdate = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute
  
  constructor(
    private readonly prisma: PrismaService,
    private readonly foodDetector: SemanticFoodDetectorService,
    private readonly parcelDetector: SemanticParcelDetectorService,
  ) {}
  
  async onModuleInit() {
    await this.refreshFlowCache();
    this.logger.log(`✅ Loaded ${this.flowCache.length} flow triggers from database`);
    this.logger.log(`✅ AI-powered food detection enabled (replacing ${this.FOOD_KEYWORDS.length} hardcoded keywords)`);
    this.logger.log(`✅ AI-powered parcel detection enabled (replacing ${this.P2P_PATTERNS.length} hardcoded P2P patterns)`);
  }
  
  // ========================================
  // COMMAND KEYWORDS (Highest Priority)
  // ========================================
  private readonly CANCEL_KEYWORDS = /^(cancel|stop|exit|quit|band|ruk|nahi|nhi|roko|रद्द|बंद|रुको)$/i;
  private readonly RESTART_KEYWORDS = /^(restart|reset|start over|fresh start|naya shuru|dobara|नया)$/i;
  private readonly HELP_KEYWORDS = /^(help|madad|sahayata|मदद|सहायता|\?)$/i;
  private readonly MENU_KEYWORDS = /^(menu|home|main|ghar|घर|मेनू)$/i;
  
  // ========================================
  // FOOD KEYWORDS (DEPRECATED - kept for emergency fallback only)
  // ========================================
  // ⚠️ DEPRECATED: Now using AI-powered SemanticFoodDetectorService
  // This list is kept only as emergency fallback if AI detection fails
  // DO NOT ADD NEW KEYWORDS - improve AI model instead
  // List moved to src/nlu/food-keywords.const.ts so IntentClassifierService
  // can share it for the pre-LLM short-circuit (2026-08-01).
  private readonly FOOD_KEYWORDS = FOOD_KEYWORDS_LIST;
  
  // ========================================
  // P2P (Parcel) CONTEXT PATTERNS
  // ========================================
  // ⚠️ DEPRECATED: Now using AI-powered SemanticParcelDetectorService
  // This list is kept only for reference and emergency fallback
  // DO NOT ADD NEW PATTERNS - improve AI model instead
  private readonly P2P_PATTERNS = [
    'courier',
    'pickup from my',
    'from my home',
    'to my friend',
    'deliver to friend',
    'ghar se',        // "from home" in Hindi - P2P
    'friend ko',
    'dost ko',
  ];
  private readonly P2P_REGEX = /\bse\b.*\btak\b|\bse\b.*\bparcel\b/i;
  
  // Intents that should be overridden to order_food when food keywords present
  private readonly FOOD_OVERRIDE_INTENTS = [
    'parcel_booking',
    'search_product',  // Re-enabled: AI food detector distinguishes food vs e-commerce searches
    'manage_address',
    'send',
    'search',
    'checkout',       // NLU often misclassifies "order food" as checkout
    'order',          // Generic order intent
    'unknown',        // Fallback for unrecognized intents
  ];
  
  // ========================================
  // DATABASE-DRIVEN FLOW ROUTING
  // ========================================
  
  /**
   * Refresh flow cache from database
   * Updated to match actual flow_definitions table schema
   */
  private async refreshFlowCache(): Promise<void> {
    try {
      const flows = await this.prisma.$queryRaw<
        Array<{
          name: string;
          trigger_intents: string[] | null;
          priority: number | null;
          is_active: boolean | null;
        }>
      >`
        SELECT name, trigger_intents, priority, is_active
        FROM flow_definitions
        WHERE is_active = true
        ORDER BY priority DESC
      `;

      this.flowCache = flows.map((flow) => ({
        flowId: flow.name,  // Use name as flowId (e.g., 'food_order_v1')
        triggers: flow.trigger_intents || [],
        priority: flow.priority ?? 50,
        requiresAuth: false,  // Could add column later if needed
        enabled: flow.is_active ?? false,
      }));

      // Build a simple intent -> flowId mapping (highest-priority wins)
      const mapping: Record<string, string> = {};
      for (const flow of this.flowCache) {
        for (const trigger of flow.triggers) {
          if (!mapping[trigger]) {
            mapping[trigger] = flow.flowId;
          }
        }
      }
      this.flowMapping = mapping;

      this.lastCacheUpdate = Date.now();
    } catch (error) {
      this.logger.error(`Failed to refresh flow cache: ${error.message}`);
      // Keep existing cache if refresh fails
    }
  }

  /**
   * Find flow ID for intent (DB-driven, cached)
   */
  private async findFlowForIntent(intent: string, isAuthenticated: boolean): Promise<string | null> {
    // Refresh cache if stale
    if (Date.now() - this.lastCacheUpdate > this.CACHE_TTL) {
      await this.refreshFlowCache();
    }

    // Find matching flow (priority-sorted)
    for (const flow of this.flowCache) {
      if (flow.triggers.includes(intent)) {
        // 🔧 FIX: Do NOT skip auth-required flows here!
        // Flows like parcel_delivery_v1 have their own internal auth check 
        // (check_auth_before_flow state) which properly reads session data.
        // Skipping the flow here causes fallback to AgentOrchestrator which
        // has broken duplicate auth logic. Let the flow handle auth internally.
        if (flow.requiresAuth && !isAuthenticated) {
          this.logger.log(`⚠️ Flow ${flow.flowId} requires auth but user not authenticated - ALLOWING flow to handle auth internally`);
        }

        return flow.flowId;
      }
    }

    return null;
  }
  
  /**
   * Main routing method - Single entry point for all intent routing decisions
   * NOW ASYNC to support database lookups
   */
  async route(
    nluIntent: string,
    message: string,
    context: RoutingContext = { hasActiveFlow: false, isAuthenticated: false, channel: 'web' },
  ): Promise<RouteDecision> {
    const lowerText = message.toLowerCase().trim();
    
    // 🛒 CART OPERATION DETECTION - Pattern matching for cart actions (until NLU is retrained)
    // Skip if NLU already confidently classified as a non-cart intent
    const SKIP_CART_OVERRIDE_INTENTS = ['track_order', 'check_wallet', 'greeting', 'cancel', 'help'];
    const cartIntent = SKIP_CART_OVERRIDE_INTENTS.includes(nluIntent) ? null : this.detectCartIntent(message);
    if (cartIntent) {
      this.logger.log(`🛒 Cart operation detected via keywords: ${cartIntent} (NLU said: ${nluIntent})`);
      return {
        originalIntent: nluIntent,
        translatedIntent: cartIntent,
        flowId: 'food_order_v1', // Cart operations use food order flow
        overrideApplied: true,
        reason: 'Cart operation pattern match',
        priority: 'pattern',
        confidence: 0.95,
      };
    }
    
    // ========================================
    // STEP 1: Command Intent Override (Highest Priority)
    // Pass context to allow flow-aware command handling
    // ========================================
    const commandResult = this.checkCommandOverride(lowerText, nluIntent, context);
    if (commandResult) {
      return commandResult;
    }
    
    // ========================================
    // STEP 2: Translate common NLU intents
    // (Minimal translations - most intents used as-is)
    // Pass context so translations can be flow-aware
    // ========================================
    const translatedIntent = this.translateIntent(nluIntent, context, lowerText);
    
    // ========================================
    // STEP 3: Food Override Check
    // ========================================
    const foodOverrideResult = await this.checkFoodOverride(translatedIntent, lowerText, nluIntent, context);
    if (foodOverrideResult) {
      return foodOverrideResult;
    }
    
    // ========================================
    // STEP 4: Database-Driven Flow Mapping
    // ========================================
    const flowId = await this.findFlowForIntent(translatedIntent, context.isAuthenticated);
    
    if (flowId) {
      return {
        originalIntent: nluIntent,
        translatedIntent,
        flowId,
        overrideApplied: translatedIntent !== nluIntent,
        reason: `DB-matched ${translatedIntent} → ${flowId}`,
        priority: 'intent_map',
        confidence: 0.9,
      };
    }
    
    // ========================================
    // STEP 5: Keyword-Based Fallback
    // ========================================
    const keywordResult = await this.checkKeywordFallback(lowerText, nluIntent, context);
    if (keywordResult) {
      return keywordResult;
    }
    
    // ========================================
    // STEP 6: No Match - Return null flowId
    // ========================================
    return {
      originalIntent: nluIntent,
      translatedIntent,
      flowId: null,
      overrideApplied: false,
      reason: `No flow mapping for intent: ${translatedIntent}`,
      priority: 'fallback',
      confidence: 0.3,
    };
  }
  
  /**
   * Translate common NLU intents to backend intents
   * Context-aware: some translations are skipped when a flow is active
   * Text-aware: disambiguates ambiguous NLU intents using keyword patterns
   */
  private translateIntent(
    nluIntent: string,
    context: RoutingContext = { hasActiveFlow: false, isAuthenticated: false, channel: 'web' },
    lowerText = '',
  ): string {
    // Static translations that always apply
    const alwaysTranslate: Record<string, string> = {
      'place_order': 'order_food',
      'order': 'order_food',         // Generic order intent
      'send': 'parcel_booking',
      'track': 'track_order',
      'search': 'search_product',
      'refund_request': 'request_refund', // NLU model uses refund_request, handler uses request_refund
    };

    if (alwaysTranslate[nluIntent]) {
      return alwaysTranslate[nluIntent];
    }

    // Text-based disambiguation for payment_issue:
    // NLU overloads this for wallet queries, loyalty queries, and actual payment failures.
    if (nluIntent === 'payment_issue') {
      const transferKeywords = /\b(transfer|convert|redeem|exchange)\b/;
      const loyaltyKeywords = /\b(loyalty|points?|reward|earn|cashback)\b/;
      const walletKeywords = /\b(wallet|balance|rupee|₹|money|cash|credit|fund|recharge)\b/;
      // Check transfer+loyalty combo first (most specific)
      if (transferKeywords.test(lowerText) && loyaltyKeywords.test(lowerText)) return 'transfer_points';
      if (loyaltyKeywords.test(lowerText)) return 'check_loyalty_points';
      if (walletKeywords.test(lowerText)) return 'check_wallet';
      // "payment" or "pay" without wallet/loyalty context — keep as payment_issue
    }

    // Heuristic override: wallet/balance queries that NLU misclassifies
    // "wallet balance" often lands on payment_issue — override to check_wallet
    if (nluIntent !== 'check_wallet') {
      const walletBalanceKeywords = /\bwallet\s*(balance|amount|kitna|mein|paisa|paise|funds?)?\b|\b(balance|kitna)\s*(wallet|mein)\b/i;
      if (walletBalanceKeywords.test(lowerText) && /wallet/i.test(lowerText)) return 'check_wallet';
    }

    // Heuristic override: availability/open-now queries (NLU v8 lacks check_availability intent)
    // Maps to check_availability so context-router can handle open-now store search
    if (nluIntent !== 'check_availability') {
      const openNowKeywords = /\b(khula|khule|open|available|available)\b.*(hai|hain|kya|abhi|now)\b|\b(kya|konse?).*(khula|open|available)\b|\bopen\s*now\b|\babhi.*khula\b/i;
      if (openNowKeywords.test(lowerText)) return 'check_availability';
    }

    // Heuristic override: dietary preference updates (NLU v8 lacks update_preference intent)
    if (nluIntent !== 'update_preference') {
      const prefKeywords = /\b(main|mera|meri|i\s+am|i'm)\s+(veg|vegetarian|non.?veg|jain|halal)\b|\bveg\s+(hoon|hu|hai|rehta|rehti)\b|\b(set|change|update).*(preference|diet|filter)\b|\bonly\s+veg\b/i;
      if (prefKeywords.test(lowerText)) return 'update_preference';
    }

    // Text-based disambiguation for view_cart → view_wishlist
    // NLU sometimes maps "view wishlist" to view_cart; disambiguate by text
    if (nluIntent === 'view_cart') {
      const wishlistKeywords = /\b(wishlist|wish.?list|saved.?items?|favourite|favorite|liked)\b/;
      if (wishlistKeywords.test(lowerText)) return 'view_wishlist';
    }

    // Context-sensitive translations: ONLY apply when NO active flow
    // When a flow is active, 'checkout' should remain 'checkout' so the flow
    // state machine can handle it properly (e.g., transition to payment)
    if (!context.hasActiveFlow) {
      const noFlowTranslations: Record<string, string> = {
        'checkout': 'order_food',  // Only translate checkout→order_food when starting fresh
      };
      if (noFlowTranslations[nluIntent]) {
        return noFlowTranslations[nluIntent];
      }
    }

    return nluIntent;
  }
  
  /**
   * Check for command intent overrides (cancel, restart, help, menu)
   * Now accepts context to skip menu override when in active transactional flow
   */
  private checkCommandOverride(text: string, originalIntent: string, context: RoutingContext): RouteDecision | null {
    if (this.CANCEL_KEYWORDS.test(text)) {
      this.logger.log(`🎯 Command override: "${text}" → cancel (was: ${originalIntent})`);
      return {
        originalIntent,
        translatedIntent: 'cancel',
        flowId: null, // Commands don't start flows
        overrideApplied: true,
        reason: 'Explicit cancel command detected',
        priority: 'command',
        confidence: 1.0,
      };
    }
    
    if (this.RESTART_KEYWORDS.test(text)) {
      this.logger.log(`🎯 Command override: "${text}" → restart (was: ${originalIntent})`);
      return {
        originalIntent,
        translatedIntent: 'restart',
        flowId: null,
        overrideApplied: true,
        reason: 'Explicit restart command detected',
        priority: 'command',
        confidence: 1.0,
      };
    }
    
    // NOTE: 'help' keyword removed from command overrides - now routed to AI agent for natural conversation
    // Only exact 'help' commands are handled, and they go to the agent, not a hardcoded response
    
    // For menu keywords, check if user is in an active transactional flow
    // Skip menu override during checkout, OTP verification, address selection, etc.
    // "home" could mean address selection, not "go to main menu"
    if (this.MENU_KEYWORDS.test(text)) {
      // Transactional flows where "home" might mean address/location, not menu
      const transactionalFlows = ['food_order_v1', 'parcel_booking_v1'];
      const inTransactionalFlow = context.hasActiveFlow && 
        context.activeFlowId && 
        transactionalFlows.includes(context.activeFlowId);
      
      if (inTransactionalFlow) {
        this.logger.log(`🚫 Skipping menu override: "${text}" - user in active transactional flow: ${context.activeFlowId}`);
        return null; // Let the flow handle "home" as address selection
      }
      
      this.logger.log(`🎯 Command override: "${text}" → menu (was: ${originalIntent})`);
      return {
        originalIntent,
        translatedIntent: 'menu',
        flowId: null, // Menu is handled by command handler
        overrideApplied: true,
        reason: 'Explicit menu command detected',
        priority: 'command',
        confidence: 1.0,
      };
    }
    
    return null;
  }
  
  /**
   * Check if food keywords should override the current intent
   * NOW USES: AI-powered semantic detection (replaces 70+ hardcoded keywords)
   * Handles cases like "send egg rice to home" which NLU classifies as parcel_booking
   */
  private async checkFoodOverride(translatedIntent: string, text: string, originalIntent: string, context: RoutingContext): Promise<RouteDecision | null> {
    // Only apply to specific intents that might be misclassified
    if (!this.FOOD_OVERRIDE_INTENTS.includes(translatedIntent)) {
      return null;
    }

    // Check for P2P (parcel) context — keyword check first (fast, no network)
    const lowerText = text.toLowerCase();
    const parcelHints = ['parcel', 'courier', 'pickup', 'package'];
    const hasParcelContext = parcelHints.some(k => lowerText.includes(k)) ||
      /\bse\b.*\btak\b|\bfrom\b.*\bto\b.*\bdeliver/i.test(text);

    if (!hasParcelContext) {
      // No parcel keywords — skip expensive AI parcel detection
    } else {
      try {
        const parcelDetection = await this.parcelDetector.detectParcel(text, { skipCache: false });
        if (parcelDetection.isParcel && parcelDetection.confidence > 0.7) {
          this.logger.log(
            `📦 Parcel Context Detected: "${text.substring(0, 40)}..." ` +
            `(confidence: ${parcelDetection.confidence.toFixed(2)}, method: ${parcelDetection.method}) ` +
            `→ keeping intent: ${translatedIntent}`
          );
          return null;
        }
      } catch (err) {
        this.logger.warn(`Parcel detection failed in food override: ${err.message}`);
      }
    }

    // Try AI-powered food detection first
    try {
      const foodDetection = await this.foodDetector.detectFood(text, { skipCache: false });

      if (foodDetection.isFood && foodDetection.confidence > 0.7) {
        const foodFlowId = await this.findFlowForIntent('order_food', context.isAuthenticated);
        const items = foodDetection.detectedItems?.join(', ') || 'food items';

        this.logger.log(
          `🍕 AI Food Override: "${text.substring(0, 40)}..." detected as food ` +
          `(${items}, confidence: ${foodDetection.confidence.toFixed(2)}, method: ${foodDetection.method}) ` +
          `→ order_food (was: ${translatedIntent})`
        );

        return {
          originalIntent,
          translatedIntent: 'order_food',
          flowId: foodFlowId,
          overrideApplied: true,
          reason: `AI detected food: ${items} (${foodDetection.confidence.toFixed(2)} confidence, ${foodDetection.method})`,
          priority: 'food_override',
          confidence: 0.85,
        };
      }
    } catch (err) {
      this.logger.warn(`AI food detection failed in override: ${err.message}`);
    }

    // Fallback: check against comprehensive FOOD_KEYWORDS list
    // This catches cases where AI detection is unavailable or returns low confidence
    const matchedFoodKeywords = this.FOOD_KEYWORDS.filter(k => lowerText.includes(k));
    if (matchedFoodKeywords.length > 0) {
      const foodFlowId = await this.findFlowForIntent('order_food', context.isAuthenticated);

      this.logger.log(
        `🍕 Keyword Food Override: "${text.substring(0, 40)}..." matched food keywords: [${matchedFoodKeywords.join(', ')}] ` +
        `→ order_food (was: ${translatedIntent})`
      );

      return {
        originalIntent,
        translatedIntent: 'order_food',
        flowId: foodFlowId,
        overrideApplied: true,
        reason: `Food keywords detected: ${matchedFoodKeywords.join(', ')}`,
        priority: 'food_override',
        confidence: 0.80,
      };
    }

    return null;
  }
  
  /**
   * Keyword-based fallback when no intent mapping found
   * NOW ENHANCED: Uses AI-powered semantic detection for food queries
   */
  private async checkKeywordFallback(text: string, originalIntent: string, context: RoutingContext): Promise<RouteDecision | null> {
    // AI-powered food detection (for unknown/ambiguous intents)
    if (originalIntent === 'unknown' || originalIntent === 'unsure' || originalIntent === 'default') {
      try {
        const foodDetection = await this.foodDetector.detectFood(text);
        if (foodDetection.isFood && foodDetection.confidence > 0.6) {
          const foodFlowId = await this.findFlowForIntent('order_food', context.isAuthenticated);
          this.logger.log(
            `🤖 AI fallback: "${text.substring(0, 40)}..." → food ` +
            `(confidence: ${foodDetection.confidence.toFixed(2)}, method: ${foodDetection.method})`
          );
          return {
            originalIntent,
            translatedIntent: 'order_food',
            flowId: foodFlowId,
            overrideApplied: true,
            reason: `AI detected food: ${foodDetection.detectedItems?.join(', ') || 'items'} (${foodDetection.confidence.toFixed(2)})`,
            priority: 'fallback',
            confidence: foodDetection.confidence,
          };
        }
      } catch (error) {
        this.logger.warn(`AI food detection failed in fallback: ${error.message}`);
      }
    }
    
    // Login keywords
    if (/\b(login|sign\s*in|signin|authenticate|verify\s*phone|otp)\b/i.test(text)) {
      const loginFlowId = await this.findFlowForIntent('login', context.isAuthenticated);
      return {
        originalIntent,
        translatedIntent: 'login',
        flowId: loginFlowId,
        overrideApplied: true,
        reason: 'Login keyword detected in message',
        priority: 'keyword',
        confidence: 0.8,
      };
    }
    
    // Help/service inquiry keywords → route to AI agent (not hardcoded flow)
    // These are conversational questions about the platform that AI should handle naturally
    const helpPatterns = [
      'what is mangwale', 'tell me about', 'your services', 'what can you do',
      'what do you do', 'how does it work', 'about mangwale',
      'mangwale kya hai', 'kya kar sakte ho',
    ];
    if (helpPatterns.some(p => text.includes(p))) {
      return {
        originalIntent,
        translatedIntent: 'chitchat',
        flowId: null, // No flow - let AI agent handle naturally
        overrideApplied: true,
        reason: 'Service inquiry - routed to AI agent for natural response',
        priority: 'keyword',
        confidence: 0.85,
      };
    }
    
    // Greeting keywords (for unknown/default intents)
    if (originalIntent === 'unknown' || originalIntent === 'default') {
      const greetingPatterns = /^(hi|hello|hey|namaste|namaskar|good\s*(morning|afternoon|evening))$/i;
      if (greetingPatterns.test(text)) {
        return {
          originalIntent,
          translatedIntent: 'greeting',
          flowId: 'greeting_v1',
          overrideApplied: true,
          reason: 'Greeting keyword detected',
          priority: 'keyword',
          confidence: 0.7,
        };
      }
    }
    
    // Food keyword fallback (DEPRECATED - AI detection above should catch this)
    const hasFoodKeyword = this.FOOD_KEYWORDS.some(k => text.includes(k));
    if (hasFoodKeyword && originalIntent !== 'order_food') {
      const foodFlowId = await this.findFlowForIntent('order_food', context.isAuthenticated);
      this.logger.warn(`⚠️ Using deprecated keyword fallback (AI detection missed this - investigate!)`);
      return {
        originalIntent,
        translatedIntent: 'order_food',
        flowId: foodFlowId,
        overrideApplied: true,
        reason: 'Legacy keyword fallback (AI missed detection)',
        priority: 'keyword',
        confidence: 0.6,
      };
    }
    
    return null;
  }
  
  /**
   * Check if an intent is a command intent (handled by CommandHandlerService)
   */
  isCommandIntent(intent: string): boolean {
    return ['cancel', 'restart', 'menu'].includes(intent);
  }
  
  /**
   * Get flow ID for an intent (simple lookup, no translation/override)
   */
  getFlowIdForIntent(intent: string): string | null {
    return this.flowMapping[intent] || null;
  }
  
  /**
   * 🛒 Detect cart operation intents via pattern matching
   * This supplements NLU for cart operations until the model is retrained with new data
   */
  private detectCartIntent(message: string): string | null {
    if (!message) return null;
    
    const lowerMsg = message.toLowerCase().trim();
    
    // Remove from cart patterns (Hindi/Hinglish/English)
    const removePatterns = [
      /\b(remove|delete|hatao|nikalo|hata\s*do|nikal\s*do)\b.*\b(cart|basket)\b/i,
      /\b(cart|basket)\b.*\b(remove|delete|hatao|nikalo|hata\s*do|nikal\s*do)\b/i,
      /\b(cart\s*se|basket\s*se)\s*(remove|hatao|nikalo|delete)/i,
    ];
    
    for (const pattern of removePatterns) {
      if (pattern.test(lowerMsg)) {
        return 'remove_from_cart';
      }
    }
    
    // Clear cart patterns
    const clearPatterns = [
      /\b(clear|empty|khaali|khali)\s*(karo|kar\s*do)?\s*(cart|basket)?\b/i,
      /\b(cart|basket)\s*(khaali|khali|clear|empty)\s*(karo|kar\s*do)?\b/i,
      /\b(sab|all)\s*(hatao|remove|delete|nikalo)\s*(cart\s*se|from\s*cart)?\b/i,
    ];
    
    for (const pattern of clearPatterns) {
      if (pattern.test(lowerMsg)) {
        return 'view_cart';
      }
    }
    
    // Add to cart patterns
    const addPatterns = [
      /\badd\s+.+\s+to\s+(my\s+)?cart\b/i,
      /\bcart\s*(mein|me|mai)\s+(add|daal|dal|rakh)\b/i,
      /\b(daal|dal|rakh|rakho)\s+(cart|basket)\s*(mein|me|mai)?\b/i,
    ];
    
    for (const pattern of addPatterns) {
      if (pattern.test(lowerMsg)) {
        return 'add_to_cart';
      }
    }
    
    // View cart patterns
    // ⚠️ Do NOT include 'order' here — "show my order" means order history, not cart
    const viewPatterns = [
      /\b(show|dikhao|dekho|check)\s*(my|mera|meri)?\s*(cart|basket)\b/i,
      /\b(cart|basket)\s*(dikhao|dekho|show|check)\b/i,
      /\b(mera|my)\s*(cart|basket)\b/i,
      /\b(cart|basket)\s*(mein|me)\s*(kya|what)\s*(hai|is)\b/i,
    ];
    
    for (const pattern of viewPatterns) {
      if (pattern.test(lowerMsg)) {
        return 'view_cart';
      }
    }
    
    return null;
  }
  
  /**
   * Get all registered intents and their flow mappings (for debugging)
   */
  getAllMappings(): Record<string, string> {
    return { ...this.flowMapping };
  }
  
  /**
   * Get all food keywords (for testing)
   */
  getFoodKeywords(): string[] {
    return [...this.FOOD_KEYWORDS];
  }
}
