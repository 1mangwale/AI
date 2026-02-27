import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmIntentExtractorService } from '../nlu/services/llm-intent-extractor.service';
import { NluTrainingDataService } from '../nlu/services/nlu-training-data.service';
import { SelfLearningService } from '../learning/services/self-learning.service';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import { performance } from 'perf_hooks';
import { AiMetricsLogger } from '../common/logging/ai-metrics.logger';

export interface NluClassificationResult {
  intent: string;
  confidence: number;
  entities?: any[];
  raw?: any;
  provider?: 'indicbert' | 'llm' | 'heuristic' | 'indicbert_fallback';
}

/**
 * Intent Translation Map - NLU v2 (Action-Based) → Backend (Module-Based)
 * 
 * NLU v2 uses industry-standard action-based intents (like Google Dialogflow, Rasa)
 * The backend expects module-specific intents for routing
 * 
 * This mapping layer bridges the two while keeping NLU clean
 */
const INTENT_TRANSLATION_MAP: Record<string, string> = {
  // Action-based → Module-based translation
  'place_order': 'order_food',       // Generic ordering → food module
  'send': 'parcel_booking',          // Send action → parcel module  
  'track': 'track_order',            // Track action → tracking module
  'search': 'search_product',        // Search action → search module
  
  // These remain unchanged (already match backend expectations)
  'confirm': 'confirm',
  'deny': 'deny',
  'cancel': 'cancel',
  'add_to_cart': 'add_to_cart',
  'checkout': 'checkout',
  'view_cart': 'view_cart',
  'remove_from_cart': 'remove_from_cart',
  'update_quantity': 'update_quantity',
  'select_item': 'select_item',
  'repeat_order': 'repeat_order',
  'use_saved': 'use_saved',
  'manage_address': 'manage_address',
  'ask_price': 'ask_price',
  'ask_time': 'ask_time',
  'help': 'help',
  'complaint': 'complaint',
  'greeting': 'greeting',
  'chitchat': 'chitchat',
  'feedback': 'feedback',
};

/**
 * NLU Client Service
 * 
 * Multi-tier intent classification:
 * 1. Try LOCAL IndicBERT NLU (fast, trained model)
 * 2. Fallback to LLM (vLLM, accurate but slower)
 * 3. Final fallback to heuristics (keyword patterns)
 * 
 * NO ADMIN BACKEND - All AI services are local!
 */
@Injectable()
export class NluClientService {
  private readonly logger = new Logger(NluClientService.name);
  private readonly primaryEndpoint: string;
  private readonly fallbackEndpoint: string;
  private currentEndpoint: string;
  private useFallback = false;
  private readonly enabled: boolean;
  private readonly llmFallbackEnabled: boolean;
  private readonly captureTrainingData: boolean;
  private axiosInstance: AxiosInstance;
  private readonly metricsLogger: AiMetricsLogger;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastPrimaryCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // Check primary every 30s when on fallback

  constructor(
    private configService: ConfigService,
    private llmIntentExtractor: LlmIntentExtractorService,
    private trainingDataService: NluTrainingDataService,
    @Optional() private selfLearningService: SelfLearningService,
  ) {
  // Mercury (GPU) is primary, Jupiter (CPU) is fallback
  this.primaryEndpoint =
    this.configService.get<string>('NLU_PRIMARY_ENDPOINT') ||
    this.configService.get<string>('NLU_ENDPOINT') ||
    'http://localhost:7010';
  this.fallbackEndpoint =
    this.configService.get<string>('NLU_FALLBACK_ENDPOINT') ||
    'http://localhost:7010';
  this.currentEndpoint = this.primaryEndpoint;
  this.captureTrainingData = this.configService.get('NLU_CAPTURE_TRAINING_DATA', 'true') === 'true';
  this.enabled = this.configService.get<boolean>('NLU_AI_ENABLED') !== false;
  this.llmFallbackEnabled = this.configService.get<boolean>('NLU_LLM_FALLBACK_ENABLED') !== false;
  this.metricsLogger = new AiMetricsLogger('nlu', this.configService);
    
    // Create optimized HTTP client for NLU service
    this.axiosInstance = this.createAxiosInstance(this.currentEndpoint);
    
    if (this.enabled) {
      this.logger.log(`✅ NLU Client initialized - Primary: ${this.primaryEndpoint}, Fallback: ${this.fallbackEndpoint}`);
      this.logger.log(`   Connection Pooling: Enabled (max: 30, free: 10)`);
      this.logger.log(`   Timeout: 5s`);
      if (this.llmFallbackEnabled) {
        this.logger.log(`✅ LLM fallback enabled for intent classification`);
      }
      
      // Initial health check
      this.checkPrimaryHealth();
    } else {
      this.logger.warn('⚠️  NLU AI disabled - using fallback heuristics');
    }
  }

  /**
   * Create Axios instance for given endpoint
   */
  private createAxiosInstance(baseURL: string): AxiosInstance {
    return axios.create({
      baseURL,
      timeout: 5000, // 5 second timeout (NLU is fast)
      
      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 30, // NLU is lightweight
        maxFreeSockets: 10,
        timeout: 10000,
        scheduling: 'fifo',
      }),
      
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=30, max=100',
      },
      
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /**
   * Check if primary NLU is healthy and switch back if possible
   */
  private async checkPrimaryHealth(): Promise<void> {
    if (!this.useFallback) return;
    
    const now = Date.now();
    if (now - this.lastPrimaryCheck < this.HEALTH_CHECK_INTERVAL) return;
    this.lastPrimaryCheck = now;
    
    try {
      const response = await axios.get(`${this.primaryEndpoint}/health`, { timeout: 2000 });
      if (response.status === 200) {
        this.logger.log(`✅ Primary NLU (Mercury) recovered - switching back`);
        this.useFallback = false;
        this.currentEndpoint = this.primaryEndpoint;
        this.axiosInstance = this.createAxiosInstance(this.primaryEndpoint);
      }
    } catch (err) {
      // Primary still down, continue using fallback
      this.logger.debug(`Primary NLU still unreachable: ${err.message || 'connection refused'}`);
    }
  }

  /**
   * Switch to fallback NLU server
   */
  private switchToFallback(): void {
    if (this.useFallback) return;
    
    this.logger.warn(`⚠️ Primary NLU (Mercury) unreachable - switching to fallback (Jupiter CPU)`);
    this.useFallback = true;
    this.currentEndpoint = this.fallbackEndpoint;
    this.axiosInstance = this.createAxiosInstance(this.fallbackEndpoint);
    this.lastPrimaryCheck = Date.now();
  }

  /**
   * Translate NLU v2 action-based intent to backend's module-based intent
   * 
   * This allows the NLU to remain clean/industry-standard while the backend
   * uses its existing module-specific routing logic.
   * 
   * @param nluIntent - The intent from NLU v2 (e.g., 'place_order', 'send', 'track')
   * @param entities - Extracted entities for context-aware translation
   * @returns Translated intent for backend routing
   */
  private translateIntent(nluIntent: string, entities?: any[]): string {
    // Direct translation lookup
    const translated = INTENT_TRANSLATION_MAP[nluIntent];
    if (translated) {
      if (translated !== nluIntent) {
        this.logger.debug(`🔄 Intent translated: ${nluIntent} → ${translated}`);
      }
      return translated;
    }
    
    // For unknown intents, return as-is (may be new or custom)
    return nluIntent;
  }

  /**
   * Classify user message using Admin Backend's trained NLU model
   * 
   * @param text - User message text
   * @param context - Optional context (user_id, session_id, etc.)
   * @returns Classification result with intent and confidence
   */
  async classify(text: string, context?: Record<string, any>): Promise<NluClassificationResult> {
    if (!text || text.trim().length === 0) {
      return {
        intent: 'unknown',
        confidence: 0,
        raw: { error: 'empty_text' }
      };
    }

    // 🔥 EARLY VENDOR/RIDER DETECTION - Check before any AI/LLM
    // These are high-priority B2B intents that need fast routing
    const vendorRiderResult = this.checkVendorRiderPatterns(text);
    if (vendorRiderResult) {
      this.logger.log(`🏪 Vendor/Rider intent detected: ${vendorRiderResult.intent} (${vendorRiderResult.confidence.toFixed(2)})`);
      return vendorRiderResult;
    }

    // If NLU AI is disabled or Admin Backend unavailable, use fallback
    if (!this.enabled) {
      return this.fallbackClassify(text);
    }

    // Check if primary should be retried
    if (this.useFallback) {
      this.checkPrimaryHealth();
    }

    try {
      const startTime = performance.now();
      const requestId = `nlu_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      const response = await this.axiosInstance.post('/classify', { text });
      const latency = performance.now() - startTime;
      const result = response.data;
      
      // NLU v2 returns: { intent, confidence, entities, embedding, normalized_text, version }
      // Note: v2 uses 'confidence' not 'intent_conf', 'entities' not 'slots'
      const rawIntent = result.intent || 'unknown';
      const confidence = result.confidence ?? result.intent_conf ?? 0;
      const entities = result.entities || result.slots || [];
      
      // 🔄 TRANSLATE: Action-based intent → Module-based intent for backend routing
      const translatedIntent = this.translateIntent(rawIntent, entities);
      
      this.logger.debug(
        `📊 NLU v2: "${text.substring(0, 50)}..." → raw: ${rawIntent}, translated: ${translatedIntent}, ` +
        `confidence: ${confidence.toFixed(2)}, entities: ${entities.length}, latency: ${latency.toFixed(2)}ms`
      );

      // Log to metrics system
      await this.metricsLogger.logRequest({
        service: 'nlu',
        operation: 'classify',
        requestId,
        input: { text },
        result: {
          intent: translatedIntent,
          rawIntent: rawIntent,
          confidence,
          entities,
        },
        metrics: {
          startTime,
          endTime: performance.now(),
          latency: Math.round(latency),
        },
        quality: {
          confidence,
          intent: translatedIntent,
        },
      });

      // If confidence is too low, try LLM fallback
      if ((!rawIntent || rawIntent === 'default' || confidence < 0.5) && this.llmFallbackEnabled) {
        this.logger.log(`🤖 NLU v2 confidence ${confidence} too low, trying LLM fallback...`);
        const llmResult = await this.llmFallbackClassify(text, context);
        return this.applyFoodOverride(text, llmResult);
      }

      // If LLM fallback is disabled, use heuristics
      if (!rawIntent || rawIntent === 'default' || confidence < 0.5) {
        this.logger.debug(`Using heuristics (LLM fallback disabled)`);
        return this.fallbackClassify(text);
      }

      // OVERRIDE: If the model misclassifies obvious greetings, fix it
      const lowerText = text.toLowerCase().trim();
      const greetingPattern = /^(hi|hello|hey|namaste|hola|good morning|good evening|good afternoon|howdy|sup|greetings|yo|hii|hiii|helloo|heyy|what'?s\s*up|wassup|how are you|how r u|how are u|how r you|hru)\b/;
      
      const matchesPattern = greetingPattern.test(lowerText);
      const isParcelOrTrack = (translatedIntent === 'parcel_booking' || translatedIntent === 'track_order');
      
      if (isParcelOrTrack && matchesPattern) {
        this.logger.warn(`⚠️  NLU misclassified greeting "${text}" as ${translatedIntent} - overriding to greeting`);
        return {
          intent: 'greeting', 
          confidence: 0.95, 
          entities: entities,
          raw: { ...result, rawIntent, translatedIntent, overridden: true, latency, provider: 'indicbert' }
        };
      }

      // OVERRIDE: Support/help/customer care should go to FAQ agent
      if (translatedIntent === 'parcel_booking' && 
          /\b(help|support|customer care|customer service|assist|problem|issue)\b/i.test(lowerText)) {
        this.logger.warn(`⚠️  NLU misclassified support request "${text}" as parcel order - overriding to support`);
        return {
          intent: 'support', 
          confidence: 0.95, 
          entities: entities,
          raw: { ...result, rawIntent, translatedIntent, overridden: true, latency, provider: 'indicbert' }
        };
      }

      const finalResult = this.applyFoodOverride(text, {
        intent: translatedIntent,
        confidence: confidence,
        entities: entities,
        raw: { ...result, rawIntent, translatedIntent, latency, provider: 'indicbert' }
      });

      // ✨ Self-Learning: Process prediction for confidence-based auto-approval
      this.processSelfLearning(text, finalResult, context).catch((err) =>
        this.logger.warn(`Self-learning processing failed: ${err.message}`)
      );

      return finalResult;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // If we haven't tried fallback yet, try switching to fallback NLU server
      if (!this.useFallback) {
        this.logger.warn(`Primary NLU failed: ${errorMsg} - trying fallback server`);
        this.switchToFallback();
        
        try {
          const startTime = performance.now();
          const response = await this.axiosInstance.post('/classify', { text });
          const latency = performance.now() - startTime;
          const result = response.data;
          
          this.logger.log(`✅ Fallback NLU succeeded in ${latency.toFixed(2)}ms`);
          
          // Also apply translation to fallback results
          const rawIntent = result.intent || 'unknown';
          const translatedIntent = this.translateIntent(rawIntent, result.entities);
          
          return this.applyFoodOverride(text, {
            intent: translatedIntent,
            confidence: result.confidence ?? result.intent_conf ?? 0,
            entities: result.entities || result.slots || [],
            raw: { ...result, latency, provider: 'indicbert_fallback' }
          });
        } catch (fallbackError) {
          const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          this.logger.error(`Fallback NLU also failed: ${fallbackMsg}`);
        }
      }
      
      this.logger.error(`NLU classification failed: ${errorMsg}, using heuristic fallback`);
      
      // Log error to metrics
      await this.metricsLogger.logRequest({
        service: 'nlu',
        operation: 'classify',
        input: { text },
        error: {
          message: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        },
        metrics: {
          startTime: performance.now(),
          endTime: performance.now(),
          latency: 0,
        },
      });
      
      // Try LLM fallback if enabled
      if (this.llmFallbackEnabled) {
        const llmResult = await this.llmFallbackClassify(text, context);
        return this.applyFoodOverride(text, llmResult);
      }
      
      // Final fallback to heuristics
      return this.fallbackClassify(text);
    }
  }

  /**
   * LLM fallback for intent classification
   * Uses vLLM to extract intent when IndicBERT fails
   * Also captures training data for improving IndicBERT
   * 
   * @param text - User message
   * @param context - Optional context with active module/flow info
   */
  private async llmFallbackClassify(text: string, context?: Record<string, any>): Promise<NluClassificationResult> {
    try {
      const availableIntents = [
        // Customer intents (all 33 canonical + extras)
        'greeting', 'chitchat', 'order_food', 'parcel_booking', 'search_product',
        'browse_menu', 'browse_category', 'browse_stores',
        'ask_recommendation', 'ask_famous', 'ask_fastest_delivery', 'ask_price', 'ask_time',
        'add_to_cart', 'view_cart', 'remove_from_cart', 'update_quantity',
        'checkout', 'select_item',
        'track_order', 'cancel_order', 'repeat_order', 'manage_address', 'use_saved',
        'affirm', 'deny', 'confirm', 'cancel', 'restart', 'feedback',
        'help', 'complaint', 'support_request', 'login', 'earn',
        'needs_clarification',
        // Vendor intents (restaurant/store owners)
        'vendor_orders',        // "aaj kitne orders aaye?", "today's orders"
        'vendor_accept_order',  // "order accept karo", "confirm order"
        'vendor_reject_order',  // "order reject karo", "cancel order"
        'vendor_mark_ready',    // "order ready hai", "ready for pickup"
        'vendor_earnings',      // "aaj ki kamai", "today's earnings"
        'vendor_menu',          // "menu dikhao", "disable item"
        'vendor_login',         // "vendor login", "store login"
        // Rider intents (delivery partners)
        'rider_orders',         // "mere orders dikhao", "assigned deliveries"
        'rider_accept_delivery',// "delivery accept karo"
        'rider_pickup',         // "pickup kar liya", "picked up"
        'rider_delivered',      // "delivery complete", "delivered"
        'rider_earnings',       // "meri kamai", "today's earnings"
        'rider_online',         // "online karo", "go online"
        'rider_offline',        // "offline karo", "go offline"
        'rider_login',          // "rider login", "delivery man login"
        'unknown',
      ];

      // Build LLM context from the passed context
      const llmContext = context ? {
        activeModule: context.activeModule || context.module,
        activeFlow: context.activeFlow || context.flowId,
        lastBotQuestion: context.lastBotMessage || context.lastBotQuestion,
        // Pass user type hint if available
        userType: context.userType || context.session?.userType,
      } : undefined;

      const llmResult = await this.llmIntentExtractor.extractIntent(text, 'auto', availableIntents, llmContext);
      
      this.logger.log(
        `🤖 LLM Fallback: "${text.substring(0, 50)}..." → ${llmResult.intent} ` +
        `(${llmResult.confidence.toFixed(2)}) | Reasoning: ${llmResult.reasoning}` +
        `${llmResult.needsClarification ? ' [NEEDS CLARIFICATION]' : ''}`
      );

      // Capture LLM results as training data for IndicBERT (skip clarification)
      if (this.captureTrainingData && llmResult.confidence >= 0.5 && !llmResult.needsClarification) {
        await this.trainingDataService.captureTrainingSample({
          text,
          intent: llmResult.intent,
          entities: llmResult.entities || {},
          tone: llmResult.tone,
          sentiment: llmResult.sentiment,
          confidence: llmResult.confidence,
          source: 'llm-fallback',
          reviewStatus: 'pending',
          language: 'auto',
        }).catch(err => {
          this.logger.warn(`Failed to capture training data: ${err.message}`);
        });
      }

      return {
        intent: llmResult.needsClarification ? 'needs_clarification' : llmResult.intent,
        confidence: llmResult.confidence,
        entities: Object.keys(llmResult.entities).length > 0 ? [llmResult.entities] : [],
        provider: 'llm',
        raw: {
          tone: llmResult.tone,
          sentiment: llmResult.sentiment,
          urgency: llmResult.urgency,
          reasoning: llmResult.reasoning,
          needsClarification: llmResult.needsClarification,
          clarificationOptions: llmResult.clarificationOptions,
        }
      };
    } catch (llmError) {
      this.logger.warn(`LLM fallback failed: ${llmError.message}, using heuristics`);
      return this.fallbackClassify(text);
    }
  }

  /**
   * Fallback heuristic classification when AI is unavailable
   * 
   * Uses comprehensive keyword matching for common intents.
   * This ensures the system keeps working even if Admin Backend is down.
   * 
   * UPDATED: Enhanced patterns for better food/parcel/support detection
   */
  private fallbackClassify(text: string): NluClassificationResult {
    const lower = text.toLowerCase().trim();

    // ========== VENDOR INTENTS (B2B - Store/Restaurant Owners) ==========
    // Check vendor patterns FIRST for vendor-specific keywords
    if (/aaj\s*(ke|kitne)\s*orders?|today'?s?\s*orders?|pending\s*orders?|new\s*orders?|orders?\s*(aaye|aayi|aai)|kitne\s*orders?/.test(lower)) {
      return { intent: 'vendor_orders', confidence: 0.90, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/order\s*accept|accept\s*(karo|kar|order)|confirm\s*order/.test(lower)) {
      return { intent: 'vendor_accept_order', confidence: 0.90, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/order\s*reject|reject\s*(karo|kar|order)|cancel\s*from\s*my\s*side/.test(lower)) {
      return { intent: 'vendor_reject_order', confidence: 0.90, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/order\s*ready|ready\s*(hai|ho\s*gaya)|taiyaar\s*hai|ready\s*for\s*pickup/.test(lower)) {
      return { intent: 'vendor_mark_ready', confidence: 0.90, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/aaj\s*ki\s*kamai|today'?s?\s*earning|meri\s*kamai|my\s*earning|revenue|sales\s*report/.test(lower)) {
      return { intent: 'vendor_earnings', confidence: 0.85, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/menu\s*(update|edit|change)|item\s*(band|disable|enable|update)|disable\s*item|enable\s*item|out\s*of\s*stock/.test(lower)) {
      return { intent: 'vendor_menu', confidence: 0.85, raw: { source: 'fallback_heuristic_vendor' } };
    }
    if (/vendor\s*login|store\s*login|restaurant\s*login|dukaan\s*login/.test(lower)) {
      return { intent: 'vendor_login', confidence: 0.90, raw: { source: 'fallback_heuristic_vendor' } };
    }
    
    // ========== RIDER INTENTS (Delivery Partners) ==========
    if (/mere\s*(assigned\s*)?orders?|my\s*(assigned\s*)?deliver(y|ies)|deliveries\s*dikhao|assigned\s*orders?/.test(lower)) {
      return { intent: 'rider_orders', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/delivery\s*accept|accept\s*delivery|accept\s*karo/.test(lower)) {
      return { intent: 'rider_accept_delivery', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/pickup\s*(kar\s*liya|done|complete)|picked\s*up|restaurant\s*se\s*le\s*liya/.test(lower)) {
      return { intent: 'rider_pickup', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/deliver(y|ed)\s*(complete|done|ho\s*gaya)|pahuncha\s*diya|customer\s*ko\s*de\s*diya/.test(lower)) {
      return { intent: 'rider_delivered', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/meri\s*kamai|rider\s*earning|delivery\s*earning|aaj\s*ki\s*delivery/.test(lower)) {
      return { intent: 'rider_earnings', confidence: 0.85, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/go\s*online|online\s*(karo|ho|hona)|start\s*delivery|duty\s*start/.test(lower)) {
      return { intent: 'rider_online', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/go\s*offline|offline\s*(karo|ho|hona)|stop\s*delivery|duty\s*(end|khatam)/.test(lower)) {
      return { intent: 'rider_offline', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }
    if (/rider\s*login|delivery\s*(man|boy|person)\s*login|deliveryman\s*login/.test(lower)) {
      return { intent: 'rider_login', confidence: 0.90, raw: { source: 'fallback_heuristic_rider' } };
    }

    // ========== SEARCH PRODUCT ==========
    // Patterns: "search for pizza", "find burger", "look for", etc.
    if (/search|find|look.*for|dhundo|khojo/.test(lower)) {
      return { intent: 'search_product', confidence: 0.95, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== PARCEL DELIVERY - P2P FOOD CHECK ==========
    // Check for explicit "send" + "food" context BEFORE generic food check
    if (/send.*food|deliver.*food.*to.*friend|pickup.*food|food.*pickup|ghar.*se.*food|home.*cooked/.test(lower)) {
       return { intent: 'parcel_booking', confidence: 0.85, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== FOOD ORDERING - HIGHEST PRIORITY ==========
    // Patterns: "i want food", "hungry", "order pizza", "food chahiye", etc.
    if (/food|hungry|eat|pizza|burger|biryani|restaurant|dinner|lunch|breakfast|snacks|chinese|italian|order.*food|khana|khane|bhukh|mangwao|mangwana|khilao|order.*pizza|order.*burger/.test(lower)) {
      return { intent: 'order_food', confidence: 0.78, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== PARCEL DELIVERY ==========
    // Patterns: "send parcel", "delivery", "courier", "pickup", etc.
    if (/parcel|delivery|courier|send|pickup|bhejni|bhejwana|bhejwao|package|document|urgent.*delivery|same.*day|bike.*delivery|pickup.*and.*delivery/.test(lower)) {
      return { intent: 'parcel_booking', confidence: 0.78, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== TRACK ORDER ==========
    // Patterns: "where is my order", "track", "status", "location", etc.
    if (/track|where.*order|where.*parcel|order.*status|delivery.*status|location|kahan.*hai|kahan.*pahunch|status.*kya.*hai|order.*update/.test(lower)) {
      return { intent: 'track_order', confidence: 0.78, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== BROWSE MENU ==========
    // Patterns: "show menu", "what items", "restaurants", etc.
    if (/menu|show|browse|items|restaurants|options|cuisines|dikhao|dikhaye|kya.*kya.*milta|what.*do.*you.*have|available.*food|see.*restaurants/.test(lower)) {
      return { intent: 'browse_menu', confidence: 0.78, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== SUPPORT / HELP ==========
    // Patterns: "help", "problem", "complaint", "refund", "cancel", "rider", "delivery person", etc.
    if (/help|support|problem|issue|complaint|refund|cancel|wrong|not.*working|galat|madad|customer.*care|cancel.*order|rider|delivery.*person|connect.*rider|talk.*to.*rider|call.*rider|driver|delivery.*boy|courier.*boy/.test(lower)) {
      return { intent: 'support_request', confidence: 0.78, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== GREETING ==========
    // Patterns: "hi", "hello", "hey", "namaste", etc.
    if (/^(hi|hello|hey|namaste|hola|good.*morning|good.*evening|start|kaise.*ho|howdy)\b/.test(lower)) {
      return { intent: 'greeting', confidence: 0.85, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== GENERIC ORDER (Fallback for "order" without context) ==========
    if (/order|buy|purchase|book|place.*order|chahiye/.test(lower)) {
      return { intent: 'create_order', confidence: 0.65, raw: { source: 'fallback_heuristic_enhanced' } };
    }

    // ========== UNKNOWN ==========
    return { intent: 'unknown', confidence: 0.35, raw: { source: 'fallback_heuristic_enhanced' } };
  }

  /**
   * Analyze message with more details (entities, tone, etc.)
   * 
   * Uses local IndicBERT's /classify endpoint which includes tone and entities
   */
  async analyze(text: string, context?: Record<string, any>): Promise<any> {
    if (!this.enabled) {
      return this.classify(text, context);
    }

    try {
      const response = await this.axiosInstance.post('/classify', { text });
      const result = response.data;
      
      // NLU v2 uses 'confidence' and 'entities', also apply translation
      const rawIntent = result.intent || 'unknown';
      const translatedIntent = this.translateIntent(rawIntent, result.entities);
      
      return {
        intent: translatedIntent,
        rawIntent: rawIntent,
        confidence: result.confidence ?? result.intent_conf ?? 0,
        tone: result.tone,
        toneConfidence: result.tone_conf,
        entities: result.entities || result.slots || [],
        embedding: result.embedding,
        provider: 'indicbert'
      };
    } catch (error) {
      this.logger.error(`NLU analyze failed: ${error}`);
      return this.classify(text, context);
    }
  }

  /**
   * OVERRIDE: Fix common misclassifications where food items are treated as parcels
   * e.g. "paneer bhejo" -> should be order_food, not parcel_booking (colloquial Hindi)
   * 
   * NOTE: With NLU v2's better training, this should rarely trigger.
   * Keeping as safety net but should be deprecated once model accuracy improves.
   */
  private applyFoodOverride(text: string, result: NluClassificationResult): NluClassificationResult {
    const lowerText = text.toLowerCase();
    
    // Strong food indicators that should almost never be "parcel" in this context
    const foodKeywords = [
      'paneer', 'biryani', 'chicken', 'mutton', 'dal', 'roti', 'naan', 'thali', 
      'burger', 'pizza', 'sandwich', 'fries', 'pasta', 'noodles', 'rice', 
      'paratha', 'kulcha', 'soup', 'starter', 'dessert', 'beverage', 'shake', 
      'juice', 'lassi', 'coffee', 'tea', 'breakfast', 'lunch', 'dinner',
      'manchurian', 'tikka', 'kebab', 'curry', 'masala', 'momos'
    ];

    // Hindi food keywords that NLU may not recognize
    const hindiFoodKeywords = [
      'aanda', 'anda', 'andaa', 'egg',       // Eggs
      'murgi', 'murga', 'kukad', 'kombdi',   // Chicken
      'bakra', 'bakri', 'gosht', 'gost',     // Mutton/Meat
      'machli', 'machhi',                     // Fish
      'sabzi', 'sabji', 'bhaji',             // Vegetables
      'chawal', 'bhaat',                      // Rice
      'doodh', 'dudh',                        // Milk
      'dahi',                                 // Curd
      'ghee', 'makhan',                       // Ghee/Butter
      'alu', 'aloo',                          // Potato
      'bhurji', 'omlet', 'aamlet', 'omelette' // Egg dishes
    ];

    // Check for Hindi food + chahiye pattern (e.g., "aanda chahiye", "murgi chahiye")
    // This handles NLU misclassifying Hindi food orders as repeat_order
    const hasChahiyePattern = /chahiye|chaiye|mangta|mangti|lao|dena|dedo/i.test(lowerText);
    if (hasChahiyePattern && (result.intent === 'repeat_order' || result.confidence < 0.6)) {
      const matchedHindiFood = hindiFoodKeywords.find(k => lowerText.includes(k));
      if (matchedHindiFood) {
        this.logger.warn(`🥚 [HINDI_FOOD_FIX] NLU classified "${text}" as ${result.intent} (${result.confidence.toFixed(2)}) - found Hindi food keyword "${matchedHindiFood}" + chahiye pattern - overriding to order_food`);
        return {
          ...result,
          intent: 'order_food',
          confidence: 0.95,
          entities: [
            ...(result.entities || []),
            { type: 'item', value: matchedHindiFood, start: lowerText.indexOf(matchedHindiFood), end: lowerText.indexOf(matchedHindiFood) + matchedHindiFood.length, confidence: 0.9 }
          ],
          raw: { ...result.raw, overridden: true, originalIntent: result.intent, overrideReason: `hindi_food_chahiye_${matchedHindiFood}` }
        };
      }
    }

    // If intent is parcel_booking but text contains food keywords
    if (result.intent === 'parcel_booking') {
      const matchedKeyword = foodKeywords.find(k => lowerText.includes(k));
      
      if (matchedKeyword) {
        // CRITICAL EXCEPTION: If user explicitly mentions P2P delivery context (addresses, persons),
        // keep as parcel_booking. This handles "send homemade paneer to friend" scenarios.
        // BUT "paneer bhejo" alone should be food order (colloquial Hindi usage)
        const hasExplicitP2PContext = 
          lowerText.includes('courier') || 
          lowerText.includes('pickup from my') || 
          lowerText.includes('from my home') ||
          lowerText.includes('to my friend') ||
          lowerText.includes('deliver to friend') ||
          lowerText.includes('ghar se') ||           // "from home"
          lowerText.includes('friend ko') ||         // "to friend"
          lowerText.includes('dost ko') ||           // "to friend" (Hindi)
          /\bse\b.*\btak\b|\bse\b.*\bparcel\b/i.test(lowerText);  // "from X to Y" pattern
        
        // If explicit P2P context exists with food, keep as parcel
        if (hasExplicitP2PContext) {
          this.logger.debug(`📦 Keeping parcel_booking for "${matchedKeyword}" due to explicit P2P context: "${text}"`);
          return result;
        }
        
        // Food + bhejo/send without P2P context = food order (colloquial usage)
        this.logger.warn(`⚠️  [SAFETY NET] NLU classified "${text}" as parcel_booking (found "${matchedKeyword}") - overriding to order_food`);
        return {
          ...result,
          intent: 'order_food',
          confidence: 0.98, // High confidence override
          raw: { ...result.raw, overridden: true, originalIntent: 'parcel_booking', overrideReason: `food_keyword_${matchedKeyword}` }
        };
      }
    }
    
    return result;
  }

  /**
   * Health check - test if local IndicBERT NLU is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.axiosInstance.get('/healthz', {
        timeout: 3000,
      });
      
      const data = response.data;
      this.logger.debug(`NLU Health: encoder_loaded=${data.encoder_loaded}, intent_loaded=${data.intent_loaded}`);
      return data.encoder_loaded === true;
    } catch (err) {
      this.logger.debug(`NLU health check failed: ${err.message || 'connection error'}`);
      return false;
    }
  }

  /**
   * Process self-learning for classification result
   * Captures predictions for training data improvement
   */
  private async processSelfLearning(
    text: string,
    result: NluClassificationResult,
    context?: Record<string, any>,
  ): Promise<void> {
    if (!this.selfLearningService) return;

    try {
      // Handle entities - can be array, object, or undefined
      let entitiesArray: any[] = [];
      if (Array.isArray(result.entities)) {
        entitiesArray = result.entities;
      } else if (result.entities && typeof result.entities === 'object') {
        // Convert object to array format
        entitiesArray = Object.entries(result.entities).map(([key, value]) => ({
          entity: key,
          value: value,
          confidence: result.confidence,
          start: 0,
          end: 0,
        }));
      }

      await this.selfLearningService.processPrediction({
        text,
        intent: result.intent,
        confidence: result.confidence,
        entities: entitiesArray.map((e: any) => ({
          entity: e.entity || e.type || 'unknown',
          value: e.value || '',
          confidence: e.confidence || result.confidence,
          start: e.start || 0,
          end: e.end || 0,
        })),
        userId: context?.user_id || context?.userId,
        conversationId: context?.session_id || context?.sessionId,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.warn(`Self-learning failed: ${error.message}`);
    }
  }

  /**
   * Fast pattern matching for vendor/rider intents
   * These bypass NLU/LLM for immediate routing
   */
  private checkVendorRiderPatterns(text: string): NluClassificationResult | null {
    const lower = text.toLowerCase().trim();

    // ========== VENDOR INTENTS (B2B - Store/Restaurant Owners) ==========
    if (/aaj\s*(ke|kitne)\s*orders?|today'?s?\s*orders?|pending\s*orders?|new\s*orders?|orders?\s*(aaye|aayi|aai)|kitne\s*orders?/.test(lower)) {
      return { intent: 'vendor_orders', confidence: 0.92, raw: { source: 'vendor_pattern' } };
    }
    if (/order\s*accept|accept\s*(karo|kar|order)|confirm\s*order|order.*confirm/.test(lower)) {
      return { intent: 'vendor_accept_order', confidence: 0.92, raw: { source: 'vendor_pattern' } };
    }
    if (/order\s*reject|reject\s*(karo|kar|order)|cancel\s*from\s*my\s*side/.test(lower)) {
      return { intent: 'vendor_reject_order', confidence: 0.92, raw: { source: 'vendor_pattern' } };
    }
    if (/order\s*ready|ready\s*(hai|ho\s*gaya)|taiyaar\s*hai|ready\s*for\s*pickup/.test(lower)) {
      return { intent: 'vendor_mark_ready', confidence: 0.92, raw: { source: 'vendor_pattern' } };
    }
    if (/aaj\s*ki\s*kamai|today'?s?\s*earning|meri\s*kamai|my\s*earning|revenue|sales\s*report/.test(lower)) {
      return { intent: 'vendor_earnings', confidence: 0.88, raw: { source: 'vendor_pattern' } };
    }
    if (/menu\s*(update|edit|change)|item\s*(band|disable|enable|update)|disable\s*item|enable\s*item|out\s*of\s*stock/.test(lower)) {
      return { intent: 'vendor_menu', confidence: 0.88, raw: { source: 'vendor_pattern' } };
    }
    if (/vendor\s*login|store\s*login|restaurant\s*login|dukaan\s*login/.test(lower)) {
      return { intent: 'vendor_login', confidence: 0.92, raw: { source: 'vendor_pattern' } };
    }
    
    // ========== RIDER INTENTS (Delivery Partners) ==========
    if (/mere\s*(assigned\s*)?orders?|my\s*(assigned\s*)?deliver(y|ies)|deliveries\s*dikhao|assigned\s*orders?/.test(lower)) {
      return { intent: 'rider_orders', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/delivery\s*accept|accept\s*delivery|accept\s*karo/.test(lower)) {
      return { intent: 'rider_accept_delivery', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/pickup\s*(kar\s*liya|done|complete)|picked\s*up|restaurant\s*se\s*le\s*liya/.test(lower)) {
      return { intent: 'rider_pickup', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/deliver(y|ed)\s*(complete|done|ho\s*gaya)|pahuncha\s*diya|customer\s*ko\s*de\s*diya/.test(lower)) {
      return { intent: 'rider_delivered', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/meri\s*kamai|rider\s*earning|delivery\s*earning|aaj\s*ki\s*delivery/.test(lower)) {
      return { intent: 'rider_earnings', confidence: 0.88, raw: { source: 'rider_pattern' } };
    }
    if (/go\s*online|online\s*(karo|ho|hona)|start\s*delivery|duty\s*start/.test(lower)) {
      return { intent: 'rider_online', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/go\s*offline|offline\s*(karo|ho|hona)|stop\s*delivery|duty\s*(end|khatam)/.test(lower)) {
      return { intent: 'rider_offline', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }
    if (/rider\s*login|delivery\s*(man|boy|person)\s*login|deliveryman\s*login/.test(lower)) {
      return { intent: 'rider_login', confidence: 0.92, raw: { source: 'rider_pattern' } };
    }

    return null;
  }}