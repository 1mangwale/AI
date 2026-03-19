import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IndicBERTService } from './indicbert.service';
import { LlmIntentExtractorService, LlmIntentContext } from './llm-intent-extractor.service';
import { NluTrainingDataService } from './nlu-training-data.service';
import { SelfLearningService } from '../../learning/services/self-learning.service';
import { MistakeTrackerService, MistakeType } from '../../learning/services/mistake-tracker.service';
import { MetricsService } from '../../metrics/metrics.service';

interface IntentResult {
  intent: string;
  confidence: number;
  language: string;
  provider: 'indicbert' | 'llm' | 'heuristic' | 'heuristic-priority' | 'fallback';
  semanticSimilarItems?: string[]; // Food items found via semantic search
  needsClarification?: boolean;
  clarificationOptions?: string[];
}

@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly nluEnabled: boolean;
  private readonly llmFallbackEnabled: boolean;
  private readonly confidenceThreshold: number;
  private readonly llmTimeoutMs: number;

  // Provider-specific confidence thresholds: LLM results need higher confidence
  // than IndicBERT since LLM intent extraction is less calibrated
  private readonly providerThresholds: Record<string, number> = {
    'indicbert': 0.65,
    'llm': 0.75,
    'heuristic': 0.90,
    'heuristic-priority': 0.95,
    'fallback': 0.50,
  };

  // All 33 canonical intents + extras for LLM fallback (single source of truth)
  private static readonly AVAILABLE_INTENTS = [
    'greeting', 'chitchat', 'order_food', 'parcel_booking', 'search_product',
    'browse_menu', 'browse_category', 'browse_stores',
    'ask_recommendation', 'ask_famous', 'ask_fastest_delivery',
    'ask_price', 'ask_time',
    'add_to_cart', 'view_cart', 'remove_from_cart', 'update_quantity',
    'checkout', 'select_item',
    'track_order', 'order_history', 'cancel_order', 'repeat_order', 'manage_address', 'use_saved',
    'affirm', 'deny', 'confirm', 'cancel', 'restart', 'feedback',
    'help', 'complaint', 'support_request', 'login',
    'unknown',
  ];

  constructor(
    private readonly config: ConfigService,
    private readonly indicBERTService: IndicBERTService,
    private readonly llmIntentExtractor: LlmIntentExtractorService,
    @Optional() private readonly trainingDataService?: NluTrainingDataService,
    @Optional() private readonly selfLearningService?: SelfLearningService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly mistakeTracker?: MistakeTrackerService,
  ) {
    this.nluEnabled = this.config.get('NLU_AI_ENABLED', 'true') === 'true';
    this.llmFallbackEnabled = this.config.get('NLU_LLM_FALLBACK_ENABLED', 'true') === 'true';
    this.confidenceThreshold = parseFloat(this.config.get('NLU_CONFIDENCE_THRESHOLD', '0.65'));
    this.llmTimeoutMs = parseInt(this.config.get('NLU_LLM_TIMEOUT_MS', '10000'), 10);
  }

  /**
   * Get the confidence threshold for a given provider.
   * Falls back to the base confidenceThreshold (from env) if provider is unknown.
   */
  private getThreshold(provider: string): number {
    return this.providerThresholds[provider] ?? this.confidenceThreshold;
  }

  async classify(
    text: string,
    language: string = 'auto',
    context?: string,
    flowContext?: LlmIntentContext,
  ): Promise<IntentResult> {
    const stopTimer = this.metricsService?.startTimer();

    if (!this.nluEnabled) {
      this.logger.debug('NLU AI disabled, using heuristics');
      const result = this.heuristicClassify(text);
      if (stopTimer) this.metricsService.recordNluClassification(result.intent, result.confidence, 'heuristic', language, stopTimer());
      return result;
    }

    // ========================================
    // STEP 0: HIGH-PRIORITY HEURISTIC PRE-CHECK
    // Some patterns are so unambiguous that AI classification adds no value.
    // Running these first prevents IndicBERT/LLM from misclassifying them.
    // ========================================
    const priorityResult = this.priorityHeuristicCheck(text);
    if (priorityResult) {
      this.logger.log(`✓ Priority heuristic: ${priorityResult.intent} (${(priorityResult.confidence * 100).toFixed(0)}%)`);
      if (stopTimer) this.metricsService.recordNluClassification(priorityResult.intent, priorityResult.confidence, 'heuristic-priority', language, stopTimer());
      return { ...priorityResult, language, provider: 'heuristic-priority' };
    }

    // ========================================
    // NEW FLOW: AI-FIRST APPROACH
    // Step 1: IndicBERT v3 (PRIMARY - always try first)
    // Step 2: LLM Fallback (if IndicBERT confidence < threshold)
    // Step 3: Heuristics (LAST RESORT only if AI fails)
    // ========================================

    try {
      // Step 1: Call IndicBERT v3 NLU service on Mercury (7012)
      this.logger.debug(`Calling IndicBERT v3 for: "${text}"`);
      const result = await this.indicBERTService.classify(text);

      // Step 1.5: Apply post-classification correction for known misclassifications
      const corrected = this.applyPostClassificationCorrection(text, result.intent, result.confidence);

      if (corrected.intent && corrected.confidence >= this.getThreshold('indicbert')) {
        this.logger.log(`✓ IndicBERT v3: ${corrected.intent} (${(corrected.confidence * 100).toFixed(1)}%)${corrected.corrected ? ' [CORRECTED from ' + result.intent + ']' : ''}`);

        // Use SelfLearningService for proper routing (auto-approve/review/label-studio)
        if (this.selfLearningService) {
          this.selfLearningService.processPrediction({
            text,
            intent: corrected.intent,
            entities: result.entities || {},
            confidence: corrected.confidence,
            language: language,
            source: 'nlu',
          }).catch(err => this.logger.debug(`Training capture skipped: ${err.message}`));
        }
        
        if (stopTimer) this.metricsService.recordNluClassification(corrected.intent, corrected.confidence, 'indicbert', language, stopTimer());
        return {
          intent: corrected.intent,
          confidence: corrected.confidence,
          language: language, // Use detected language from above
          provider: 'indicbert',
        };
      }

      // IndicBERT returned result but low confidence - log it
      if (corrected.intent) {
        this.logger.debug(`IndicBERT v3 low confidence: ${corrected.intent} (${(corrected.confidence * 100).toFixed(1)}%) < threshold ${this.getThreshold('indicbert') * 100}%`);
      }

      // Step 2: LLM Fallback (if enabled and IndicBERT wasn't confident)
      if (this.llmFallbackEnabled) {
        this.logger.debug(`Trying LLM fallback for: "${text}"${flowContext?.activeFlow ? ` (flow: ${flowContext.activeFlow})` : ''}`);
        try {
          const llmResult = await Promise.race([
            this.llmIntentExtractor.extractIntent(text, language, IntentClassifierService.AVAILABLE_INTENTS, flowContext),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`LLM timeout after ${this.llmTimeoutMs}ms`)), this.llmTimeoutMs)),
          ]);

          if (llmResult.intent && llmResult.confidence >= this.getThreshold('llm')) {
            // Apply food override safety net for LLM results
            const safeResult = this.applyFoodOrderOverride(text, llmResult.intent, llmResult.confidence);
            this.logger.log(`✓ LLM: ${safeResult.intent} (${(safeResult.confidence * 100).toFixed(1)}%)${safeResult.overridden ? ' [FOOD OVERRIDE]' : ''}`);
            if (stopTimer) this.metricsService.recordNluClassification(safeResult.intent, safeResult.confidence, 'llm', language, stopTimer());

            // Use SelfLearningService for proper routing (auto-approve/review/label-studio)
            if (!llmResult.needsClarification && this.selfLearningService) {
              this.selfLearningService.processPrediction({
                text,
                intent: safeResult.intent,
                entities: llmResult.entities || {},
                confidence: safeResult.confidence,
                language: language,
                source: 'llm-fallback',
              }).catch(err => this.logger.warn(`Training capture failed: ${err.message}`));
            }

            return {
              intent: safeResult.intent,
              confidence: safeResult.confidence,
              language: language,
              provider: 'llm',
              // Propagate clarification data so context-router can surface "Did you mean?" buttons
              needsClarification: llmResult.needsClarification || false,
              clarificationOptions: llmResult.clarificationOptions || [],
            };
          }
        } catch (llmError) {
          this.logger.warn(`LLM fallback failed: ${llmError.message}`);
          // Log LLM failure as a mistake for pattern detection
          if (this.mistakeTracker) {
            this.mistakeTracker.logMistake({
              messageId: `llm_err_${Date.now()}`,
              sessionId: context || 'unknown',
              userMessage: text,
              predictedIntent: 'unknown',
              confidence: 0,
              mistakeType: MistakeType.FLOW_FAILURE,
              errorDetails: llmError.message,
            }).catch(() => {});
          }
        }
      }

      // Step 3: Heuristics as LAST RESORT (only if AI completely fails)
      this.logger.debug('AI classification failed, using heuristics as last resort');
      const heuristicResult = this.heuristicClassify(text);
      this.logger.log(`✓ Heuristic fallback: ${heuristicResult.intent} (${(heuristicResult.confidence * 100).toFixed(1)}%)`);
      if (stopTimer) this.metricsService.recordNluClassification(heuristicResult.intent, heuristicResult.confidence, 'heuristic', language, stopTimer());
      // Log low-confidence heuristic fallback as a mistake for pattern detection
      if (this.mistakeTracker && heuristicResult.confidence < 0.7) {
        this.mistakeTracker.logMistake({
          messageId: `heuristic_${Date.now()}`,
          sessionId: context || 'unknown',
          userMessage: text,
          predictedIntent: heuristicResult.intent,
          confidence: heuristicResult.confidence,
          mistakeType: MistakeType.LOW_CONFIDENCE,
        }).catch(() => {});
      }
      return heuristicResult;
      
    } catch (error) {
      this.logger.warn(`IndicBERT v3 call failed: ${error.message}, falling back to LLM/heuristics`);
      
      // Try LLM before falling back to heuristics
      if (this.llmFallbackEnabled) {
        try {
          const llmResult = await Promise.race([
            this.llmIntentExtractor.extractIntent(text, language, IntentClassifierService.AVAILABLE_INTENTS, flowContext),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`LLM timeout after ${this.llmTimeoutMs}ms`)), this.llmTimeoutMs)),
          ]);
          if (llmResult.intent && llmResult.confidence >= this.getThreshold('llm')) {
            this.logger.log(`✓ LLM (after IndicBERT failure): ${llmResult.intent}`);
            if (stopTimer) this.metricsService.recordNluClassification(llmResult.intent, llmResult.confidence, 'llm', language, stopTimer());
            return {
              intent: llmResult.intent,
              confidence: llmResult.confidence,
              language: language,
              provider: 'llm',
            };
          }
        } catch (llmError) {
          this.logger.warn(`LLM fallback also failed: ${llmError.message}`);
        }
      }
      
      const fallbackResult = this.heuristicClassify(text);
      if (stopTimer) this.metricsService.recordNluClassification(fallbackResult.intent, fallbackResult.confidence, 'heuristic', language, stopTimer());
      return fallbackResult;
    }
  }

  /**
   * Priority heuristic patterns that ALWAYS win over AI classification.
   * These cover common user queries that IndicBERT/LLM frequently misclassify.
   */
  private priorityHeuristicCheck(text: string): IntentResult | null {
    const t = text.toLowerCase().trim();

    // Cancel order — must come before order_history so "cancel my order" doesn't match there
    if (/\bcancel\b.*\border/i.test(t) ||
        /\border\b.*\bcancel/i.test(t) ||
        /\braddo?\b.*\border/i.test(t) ||   // Hindi: "raddh karo order"
        /\border\b.*\braddo?\b/i.test(t)) {
      return { intent: 'cancel_order', confidence: 0.95, language: 'auto', provider: 'heuristic-priority' };
    }

    // Order history (show/view past orders)
    if (/\border.*(history|list|past|previous)\b/i.test(t) ||
        /\bmy\s+orders?\b/i.test(t) ||
        /\b(show|view|see)\b.*\borders?\b/i.test(t) ||
        /\bpurane\b.*\border/i.test(t) ||
        /\bpichle\b.*\border/i.test(t) ||
        /\brecent\b.*\border/i.test(t)) {
      return { intent: 'order_history', confidence: 0.95, language: 'auto', provider: 'heuristic-priority' };
    }

    // Order tracking (active order status)
    if (/\btrack\b.*\border/i.test(t) ||
        /\border\b.*\bstatus/i.test(t) ||
        /\bdelivery\b.*\bstatus/i.test(t) ||
        /\bwhere\b.*\bmy\b.*\border/i.test(t) ||
        /\b(mera|mere)\b.*\border/i.test(t) ||
        /\b(check|get)\b.*\border\b.*\bstatus/i.test(t)) {
      return { intent: 'track_order', confidence: 0.95, language: 'auto', provider: 'heuristic-priority' };
    }

    // Wallet balance
    if (/\bwallet\b.*\bbalance/i.test(t) ||
        /\bbalance\b.*\bwallet/i.test(t) ||
        /\bcheck\b.*\bwallet/i.test(t) ||
        /\bmy\s+wallet\b/i.test(t) ||
        /\bwallet\b.*\b(kitna|kitne|kya|how\s+much)\b/i.test(t) ||
        /\bwallet\b.*\b(paisa|paise|money|amount)\b/i.test(t)) {
      return { intent: 'check_wallet', confidence: 0.95, language: 'auto', provider: 'heuristic-priority' };
    }

    // Greeting - only exact short greetings
    if (/^(hi|hello|hey|namaste|namaskar|good\s+(morning|afternoon|evening))$/i.test(t)) {
      return { intent: 'greeting', confidence: 0.95, language: 'auto', provider: 'heuristic-priority' };
    }

    // LOCATION: prefix — sent when user shares GPS location (WhatsApp or web)
    // Must not be classified as manage_address
    if (/^location:\s*-?\d+\.\d+,\s*-?\d+\.\d+$/i.test(t)) {
      return { intent: 'provide_location', confidence: 0.99, language: 'auto', provider: 'heuristic-priority' };
    }

    // Button action values — skip NLU entirely for known button patterns
    // These are sent by the frontend when users click cards/buttons
    if (/^item_\d+$/i.test(t)) {
      return { intent: 'select_item', confidence: 0.99, language: 'auto', provider: 'heuristic-priority' };
    }
    if (/^(browse_menu|skip_location|search_different|view_cart|show_cart)$/i.test(t)) {
      const buttonIntentMap: Record<string, string> = {
        browse_menu: 'browse_menu',
        skip_location: 'affirm',
        search_different: 'browse_menu',
        view_cart: 'view_cart',
        show_cart: 'view_cart',
      };
      const mapped = buttonIntentMap[t] || 'unknown';
      return { intent: mapped, confidence: 0.99, language: 'auto', provider: 'heuristic-priority' };
    }

    // Browse stores/restaurants — user wants to see restaurant list (MUST come before browse_menu)
    if (/show.*restaurant/i.test(t) ||
        /all.*restaurant/i.test(t) ||
        /list.*restaurant/i.test(t) ||
        /show.*resto(?!re)/i.test(t) ||
        /show.*restro/i.test(t) ||
        /which.*restaurant/i.test(t) ||
        /kitne.*restaurant/i.test(t) ||
        /kaun.*restaurant/i.test(t) ||
        /partner.*store/i.test(t) ||
        /partner.*restaurant/i.test(t) ||
        /all.*resto(?!re)/i.test(t) ||
        /all.*restro/i.test(t)) {
      return { intent: 'browse_stores', confidence: 0.92, language: 'auto', provider: 'heuristic-priority' };
    }

    // Browse menu / category queries
    if (/what.*categ/i.test(t) ||
        /what.*catog/i.test(t) ||
        /show.*categ/i.test(t) ||
        /what.*you.*have/i.test(t) ||
        /what.*menu/i.test(t) ||
        /show.*menu/i.test(t)) {
      return { intent: 'browse_menu', confidence: 0.92, language: 'auto', provider: 'heuristic-priority' };
    }

    // Conversational / capability questions → chitchat (goes to AI agent directly)
    // These should NOT waste time on IndicBERT classification - send straight to agent
    if (/what\s+(can|do)\s+you\s+(do|offer|help)/i.test(t) ||
        /what\s+can\s+you\s+do\s+for\s+me/i.test(t) ||
        /what\s+are\s+your\s+(capabilities|features|services)/i.test(t) ||
        /how\s+can\s+you\s+help/i.test(t) ||
        /\b(kya\s+kya\s+kar\s+sakte|tum\s+kya\s+kya|aap\s+kya\s+kya)\b/i.test(t) ||
        /tell\s+me\s+about\s+(yourself|your\s+services|mangwale)/i.test(t) ||
        /what\s+services/i.test(t) ||
        /who\s+are\s+you/i.test(t)) {
      return { intent: 'chitchat', confidence: 0.90, language: 'auto', provider: 'heuristic-priority' };
    }

    return null;
  }

  private heuristicClassify(text: string): IntentResult {
    const lowerText = text.toLowerCase().trim();
    this.logger.debug(`Heuristic check for: "${lowerText}"`);

    // Intent patterns (expandable)
    // NOTE: Order matters! More specific patterns should come first
    const patterns: Record<string, RegExp[]> = {
      // Repeat/reorder - MUST come before order_food to prevent false matches
      repeat_order: [
        /repeat.*order/i,
        /reorder/i,
        /last\s*order/i,
        /pichla\s*order/i,
        /same\s*order/i,
        /wahi\s*order/i,
        /dobara\s*order/i,
        /phir\s*se\s*order/i,
        /repeat\s*kardena/i,
        /repeat\s*kardo/i,
        /repeat\s*kar/i,
        /kal\s*wala\s*order/i,
        /kal\s*ka\s*order/i,
        /yesterday.*order/i,
        /previous\s*order/i,
        /fir\s*se\s*(wo|woh|wahi)\s*order/i,
        /wo(hi)?\s*order\s*(fir|phir)\s*se/i,
      ],
      // Clear cart - explicit cart clearing
      clear_cart: [
        /clear\s*(my)?\s*cart/i,
        /empty\s*(my)?\s*cart/i,
        /remove\s*all\s*(items)?/i,
        /cart\s*khali\s*karo/i,
        /cart\s*clear\s*karo/i,
      ],
      // Remove specific item from cart - MUST come before order_food
      remove_item: [
        /remove\s+.+\s*(from\s+)?cart/i,      // "remove dal fry from cart"
        /delete\s+.+\s*(from\s+)?cart/i,      // "delete burger from cart"
        /cart\s+se\s+.+\s*(hatao|nikalo)/i,   // "cart se pizza hatao"
        /.+\s+hatao\s*(cart\s+se)?/i,         // "pizza hatao cart se"
        /.+\s+nikalo\s*(cart\s+se)?/i,        // "burger nikalo cart se"
        /cancel\s+.+\s*(from\s+)?cart/i,      // "cancel pizza from cart"
        /.+\s+nahi\s+chahiye\s*(cart\s+me)?/i, // "pizza nahi chahiye cart me"
        /reduce\s+.+/i,                       // "reduce pizza quantity"
        /minus\s+.+/i,                        // "minus one burger"
        /.+\s+kam\s+karo/i,                   // "pizza kam karo"
      ],
      // Reset - full conversation reset
      reset: [
        /^reset$/i,
        /start\s*fresh/i,
        /start\s*over/i,
        /naya\s*shuru/i,
        /phir\s*se\s*shuru/i,
      ],
      // Chitchat patterns - seasonal greetings, pleasantries (NOT initial greetings)
      chitchat: [
        /merry\s*christmas/i,
        /happy\s*(new\s*year|diwali|holi|eid|rakhi|navratri)/i,
        /shubh\s*(diwali|holi|navratri)/i,
        /thank\s*(you|u)|thanks/i,
        /same\s*to\s*(you|u)/i,
        /you\s*too/i,
        /how\s*are\s*(you|u)/i,
        /what'?s\s*up/i,
        /wassup|sup\b/i,
        /kaise\s*(hai|ho)/i,
        /kya\s*(haal|chal)/i,
        /good\s*(job|work|one)/i,
        /nice|cool|awesome|great|amazing|wonderful/i,
        /chotu/i, // bot name
      ],
      // Initial greeting - only very short greetings
      greeting: [/^(hi|hello|hey|namaste|good morning|good afternoon|good evening)$/i],
      track_order: [
        /track.*order/i,
        /where.*order/i,
        /order.*status/i,
        /delivery.*status/i,
        /mera.*order/i,
        /aware.*order/i,
      ],
      order_history: [
        /order.*history/i,
        /my.*order/i,
        /show.*order/i,
        /past.*order/i,
        /previous.*order/i,
        /recent.*order/i,
        /purane.*order/i,     // Hindi: old orders
        /pichle.*order/i,     // Hindi: previous orders
      ],
      parcel_booking: [
        /send.*parcel/i,
        /book.*parcel/i,
        /courier/i,
        /package.*delivery/i,
        /bike\s*wala/i,
        /auto\s*wala/i,
        /ghar\s*se\s*(office|dukan)/i,
        /office\s*se\s*ghar/i,
        /pickup.*drop/i,
        /coolie/i,
      ],
      // Browse stores/restaurants - show other stores, different restaurants
      browse_stores: [
        /other.*resto/i,
        /other.*restro/i,
        /other.*restaurant/i,
        /other.*store/i,
        /other.*shop/i,
        /more.*store/i,
        /more.*resto/i,
        /more.*restro/i,
        /more.*restaurant/i,
        /different.*resto/i,
        /different.*restro/i,
        /different.*restaurant/i,
        /different.*store/i,
        /show.*store/i,
        /show.*resto/i,
        /show.*restro/i,
        /aur.*resto/i,
        /aur.*restaurant/i,
        /alag.*resto/i,
        /dusra.*resto/i,
        /partner.*restaurant/i,
        /all.*restaurant/i,
        /all.*store/i,
        /list.*restaurant/i,
        /list.*store/i,
        /browse.*store/i,
        /browse.*resto/i,
      ],
      // Browse menu - show menu, list items (MUST come before search_product)
      browse_menu: [
        /show.*menu/i,
        /menu.*dikhao/i,
        /what.*available/i,
        /kya.*hai.*menu/i,
        /menu.*kya\s*hai/i,
        /restaurant.*menu/i,
        /food.*options/i,
        /kya\s*milega/i,
        /what.*options/i,
        /list.*items/i,
        /what.*categ/i,        // "what all category you have", "what categories"
        /what.*catog/i,        // "what all catogery" (common misspelling)
        /show.*categ/i,        // "show categories"
        /browse.*categ/i,      // "browse categories"
        /categ.*list/i,        // "category list"
        /categ.*dikhao/i,      // "category dikhao"
        /what.*you.*have/i,    // "what all you have", "what do you have"
        /kya.*kya.*milta/i,    // "kya kya milta hai"
        /konsi.*categ/i,       // "konsi category"
        /kaun.*si.*categ/i,    // "kaun si category"
      ],
      search_product: [
        /search/i, /find/i, /looking for/i, /show me/i,
        /\b(buy|purchase|shop|shopping)\b/i,
        /\b(need|want|chahiye)\b.*(cover|phone|mobile|shoe|shirt|watch|bag|headphone|earphone|laptop|tablet|gadget|accessory|electronics|clothing|clothes|fashion|jewel)/i,
        /\b(mobile|phone)\s*(cover|case|screen|protector)/i,
        /\b(shoe|sneaker|sandal|slipper|boot|heel)s?\b/i,
        /\b(t-?shirt|shirt|jeans|jacket|dress|kurta|saree|lehenga)\b/i,
        /\b(watch|band|bracelet|necklace|ring|earring)\b/i,
        /\b(laptop|tablet|camera|speaker|headphone|earphone|charger|cable)\b/i,
        /\b(bag|backpack|purse|wallet|luggage|suitcase)\b/i,
        /\bi\s*need\s*a\b/i,
        /\bget\s*me\s*(a|some)\b/i,
        /\bwhere\s*(can|do)\s*(i|we)\s*(buy|get|find)\b/i,
        /\bdhoondo|dhundo|khojo|dikha(o|do)\s*(product|item)\b/i,
        /\bproduct|item\b.*\b(search|find|show|browse)\b/i,
      ],
      cancel_order: [/cancel.*order/i, /cancel/i],
      help: [/^help$/i, /^help me$/i, /^madad$/i, /^madad karo$/i, /^mujhe help chahiye$/i],
      complaint: [/complain/i, /refund/i, /wrong.*item/i, /damaged/i],
      // Manage address - add/change delivery address
      manage_address: [
        /change.*address/i,
        /new.*address/i,
        /address.*change/i,
        /pata.*badlo/i,
        /delivery.*address/i,
        /add.*address/i,
        /update.*address/i,
        /set.*location/i,
        /location.*change/i,
        /ghar.*pata/i,
        /office.*address/i,
      ],
      // Ask recommendation - food suggestions
      ask_recommendation: [
        /recommend/i,
        /suggest/i,
        /best.*dish/i,
        /famous.*item/i,
        /popular.*food/i,
        /what.*should.*order/i,
        /kya.*order.*karu/i,
        /acha.*kya.*hai/i,
        /specialty/i,
        /must.*try/i,
      ],
      // Checkout/confirm order
      checkout: [
        /checkout/i,
        /check\s*out/i,
        /place.*order/i,
        /confirm.*order/i,
        /order.*confirm/i,
        /order.*karo/i,
        /book.*order/i,
        /finalize/i,
        /proceed.*payment/i,
        /pay\s*now/i,
        /proceed.*checkout/i,
        /complete.*order/i,
        /order.*place/i,
        /\bpay\b/i,
        /payment\s*(karna|karo|kar)/i,
        /bill\s*pay/i,
        /order\s*finalize/i,
        /ready\s*to\s*(order|pay|checkout)/i,
        /done\s*ordering/i,
        /that'?s?\s*(all|it)/i,
        /bas\s*(itna|yahi)/i,
        /order\s*de\s*do/i,
      ],
      // View cart
      view_cart: [
        /show.*cart/i,
        /view.*cart/i,
        /cart.*dikhao/i,
        /my.*cart/i,
        /what.*in.*cart/i,
        /cart.*items/i,
        /cart.*kya.*hai/i,
      ],
      // Affirmations - yes, okay, proceed
      affirm: [
        /^(yes|yeah|yep|yup|ok|okay|sure|fine|alright|theek|thik|haan|ha|ji|achcha|accha)$/i,
        /^(proceed|continue|go ahead|aage badho)$/i,
      ],
      // Negations - no, cancel, stop
      deny: [
        /^(no|nope|nah|nahi|na|mat|cancel|stop|ruko)$/i,
        /don'?t.*want/i,
        /nahi.*chahiye/i,
      ],
      // Order food - comprehensive food keywords
      order_food: [
        /order.*food/i, /hungry/i, /eat/i, /khana/i, /khane/i,
        /pizza/i, /burger/i, /biryani/i, /paneer/i, /menu/i,
        /chicken/i, /mutton/i, /dal/i, /roti/i, /naan/i, /thali/i,
        /sandwich/i, /fries/i, /pasta/i, /noodles/i, /rice/i,
        /paratha/i, /kulcha/i, /soup/i, /starter/i, /dessert/i,
        /shake/i, /juice/i, /lassi/i, /coffee/i, /tea\b/i, 
        /manchurian/i, /tikka/i, /kebab/i, /curry/i, /masala/i, /momos/i,
        /egg/i, /aanda/i, /anda/i, /omelette/i, /omlet/i,
        /butter\s*chicken/i, /dal\s*makhani/i, /kadhi/i, /korma/i,
        /fried\s*rice/i, /veg\s*rice/i, /egg\s*rice/i, /pulao/i,
        /cafe/i, /restaurant/i, /hotel/i, /dhaba/i,
      ],
      login: [/login/i, /sign in/i, /auth/i, /register/i, /signup/i],
    };

    for (const [intent, regexes] of Object.entries(patterns)) {
      if (regexes.some((regex) => regex.test(lowerText))) {
        this.logger.debug(`Heuristic match found: ${intent}`);
        // Boost confidence for specific keywords to ensure they override LLM
        let confidence = 0.8;
        if (intent === 'order_food' && (lowerText.includes('paneer') || lowerText.includes('biryani') || lowerText.includes('pizza'))) {
            confidence = 0.95;
        }
        if (intent === 'chitchat') {
            confidence = 0.9; // High confidence for chitchat patterns
        }
        
        return {
          intent,
          confidence,
          language: 'en',
          provider: 'heuristic',
        };
      }
    }

    return {
      intent: 'unknown',
      confidence: 0.3,
      language: 'en',
      provider: 'heuristic',
    };
  }

  /**
   * Post-classification correction for known IndicBERT misclassifications.
   * 
   * The model sometimes confuses:
   * - search_product → view_cart (both deal with products/items)
   * - checkout → view_cart (both are cart-related)
   * - ecommerce product queries → view_cart
   * 
   * This applies smart keyword-based corrections when model confidence is below
   * the threshold, boosting accuracy for these commonly confused intents.
   */
  private applyPostClassificationCorrection(
    text: string,
    intent: string,
    confidence: number,
  ): { intent: string; confidence: number; corrected: boolean } {
    const lower = text.toLowerCase().trim();
    
    // Only apply corrections for low-confidence predictions (< threshold)
    // or for known problematic intent → intent confusions
    const isLowConfidence = confidence < this.confidenceThreshold;
    const isConfusedIntent = ['view_cart', 'chitchat', 'unknown'].includes(intent);
    
    // ========== PRODUCT KEYWORD detection (used for multiple corrections) ==========
    const productKeywords = /\b(covers?|cases?|protectors?|shoes?|sneakers?|sandals?|slippers?|boots?|heels?|shirts?|jeans|jackets?|dress(es)?|kurta|saree|lehenga|watch(es)?|bracelets?|necklaces?|rings?|earrings?|laptops?|tablets?|cameras?|speakers?|headphones?|earphones?|chargers?|cables?|bags?|backpacks?|purses?|wallets?|luggage|phones?|mobiles?|gadgets?|electronics?|jewel(le)?ry|fashion|power\s*banks?|screen\s*guards?)\b/i;
    const hasProductKeyword = productKeywords.test(lower);
    
    // ========== HIGH-CONFIDENCE overrides for known model confusions ==========
    // These apply even when confidence is high, because the model systematically
    // misclassifies certain patterns:
    
    // ask_offers + product keyword → search_product
    // "buy a mobile cover" → ask_offers (wrong) → should be search_product
    if (intent === 'ask_offers' && hasProductKeyword) {
      this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was ask_offers(${confidence.toFixed(2)}) → search_product (product keyword detected)`);
      return { intent: 'search_product', confidence: Math.max(confidence, 0.85), corrected: true };
    }
    
    // browse_menu + product keyword (non-food) → search_product
    // "shoes dikhao" → browse_menu (wrong, "dikhao" triggers menu) → should be search_product
    // "I want sandals" → browse_menu (wrong) → should be search_product
    // But NOT: "menu dikhao", "food options dikhao" which are legitimately browse_menu
    const foodMenuKeywords = /\b(menu|food|restaurant|resto|restro|khana|cuisine|dish|thali|breakfast|lunch|dinner|snack|cafe|hotel|dhaba|biryani|pizza|burger|paneer|chicken|mutton|dal|roti|naan)\b/i;
    if (intent === 'browse_menu' && hasProductKeyword && !foodMenuKeywords.test(lower)) {
      this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was browse_menu(${confidence.toFixed(2)}) → search_product (product keyword, not food)`);
      return { intent: 'search_product', confidence: Math.max(confidence, 0.85), corrected: true };
    }
    
    if (!isLowConfidence && !isConfusedIntent) {
      return { intent, confidence, corrected: false };
    }

    // ========== search_product correction ==========
    // "I need a mobile phone cover", "buy shoes online", "search for headphones"
    const searchPatterns = [
      /\b(search|find|looking\s+for|show\s+me|browse)\b/i,
      /\b(buy|purchase|shop|shopping|need|want|chahiye|lena\s+hai)\b.*\b(covers?|phones?|mobiles?|shoes?|shirts?|watch(es)?|bags?|headphones?|earphones?|laptops?|tablets?|gadgets?|accessories|electronics?|clothing|clothes|fashion|jewel(le)?ry|products?|items?)/i,
      /\b(mobile|phone)\s*(covers?|cases?|screen|protectors?)/i,
      /\b(shoes?|sneakers?|sandals?|boots?|heels?)s?\b/i,
      /\b(t-?shirts?|shirts?|jeans|jackets?|dress(es)?|kurta|saree|lehenga)\b.*\b(buy|order|need|want|chahiye)/i,
      /\b(laptops?|tablets?|cameras?|speakers?|headphones?|earphones?|chargers?)\b.*\b(buy|need|want|chahiye|order|dikhao)/i,
      /\bi\s+need\s+a\b/i,
      /\bget\s+me\s+(a|some)\b/i,
      /\bwhere\s+(can|do)\s+(i|we)\s+(buy|get|find)\b/i,
    ];
    
    if (intent !== 'search_product' && searchPatterns.some(p => p.test(lower))) {
      this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was ${intent}(${confidence.toFixed(2)}) → search_product`);
      return { intent: 'search_product', confidence: Math.max(confidence, 0.85), corrected: true };
    }

    // ========== checkout correction ==========
    // "checkout", "proceed to checkout", "place my order", "pay now"
    const checkoutPatterns = [
      /^checkout$/i,
      /^check\s*out$/i,
      /\bproceed\s*(to\s*)?(checkout|payment|pay)\b/i,
      /\bplace\s*(my\s*)?order\b/i,
      /\bcomplete\s*(my\s*)?order\b/i,
      /\bconfirm\s*(my\s*)?order\b/i,
      /\bpay\s*now\b/i,
      /\bready\s*to\s*(order|pay|checkout)\b/i,
      /\bdone\s*ordering\b/i,
      /\border\s*(place|confirm|finalize)\s*karo\b/i,
      /\bpayment\s*(karna|karo|kar)\b/i,
    ];
    
    if (intent !== 'checkout' && checkoutPatterns.some(p => p.test(lower))) {
      this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was ${intent}(${confidence.toFixed(2)}) → checkout`);
      return { intent: 'checkout', confidence: Math.max(confidence, 0.85), corrected: true };
    }

    // ========== greet → order_food correction ==========
    // Hindi greetings containing food words get misclassified as greet
    // "bhai biryani bhejo", "yaar pizza order karo" → greet (wrong) → should be order_food
    if (intent === 'greet' && isLowConfidence) {
      const foodOrderPattern = /\b(order|bhejo|karo|de\s*do|chahiye|manga|lao|do)\b/i;
      if (foodMenuKeywords.test(lower) && foodOrderPattern.test(lower)) {
        this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was greet(${confidence.toFixed(2)}) → order_food (food + action keywords)`);
        return { intent: 'order_food', confidence: Math.max(confidence, 0.80), corrected: true };
      }
    }

    // ========== track_order / order_status unification ==========
    // "mera order kahan hai", "order status", "where is my order" → track_order
    // These two intents overlap heavily — normalize to order_tracking flow trigger
    if (intent === 'order_status' && isLowConfidence) {
      const trackingKeywords = /\b(kahan|where|track|status|update|kitna\s*time|delivery|arriving|eta|pahunch)\b/i;
      if (trackingKeywords.test(lower)) {
        this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was order_status(${confidence.toFixed(2)}) → track_order`);
        return { intent: 'track_order', confidence: Math.max(confidence, 0.80), corrected: true };
      }
    }

    // ========== ask_price → search_product correction ==========
    // "kitne ka hai phone cover", "price of shoes" → ask_price (wrong) → search_product
    if (intent === 'ask_price' && hasProductKeyword) {
      this.logger.warn(`🔄 [POST-CORRECTION] "${text}" was ask_price(${confidence.toFixed(2)}) → search_product (product keyword)`);
      return { intent: 'search_product', confidence: Math.max(confidence, 0.80), corrected: true };
    }

    // ========== view_cart correction ==========
    // Only allow view_cart if there's actually a cart-related keyword
    if (intent === 'view_cart' && isLowConfidence) {
      const hasCartKeyword = /\bcart\b|\bbasket\b|\bbag\b|\border\s*summary\b|\bkya\s*(order\s*kiya|add\s*kiya)\b/i.test(lower);
      if (!hasCartKeyword) {
        // view_cart with no cart keyword and low confidence = probably wrong
        // Let it fall through to LLM/heuristic by keeping low confidence
        this.logger.debug(`🔄 [POST-CORRECTION] view_cart without cart keyword, keeping low confidence for fallback`);
        return { intent, confidence: Math.min(confidence, 0.3), corrected: true };
      }
    }

    return { intent, confidence, corrected: false };
  }

  /**
   * Safety net: Override parcel_booking to order_food when food keywords are detected
   * This prevents LLM from misclassifying "send me rice from cafe" as parcel delivery
   */
  private applyFoodOrderOverride(
    text: string, 
    intent: string, 
    confidence: number
  ): { intent: string; confidence: number; overridden: boolean } {
    if (intent !== 'parcel_booking') {
      return { intent, confidence, overridden: false };
    }

    const lowerText = text.toLowerCase();
    
    // Comprehensive food keywords
    const foodKeywords = [
      'paneer', 'biryani', 'chicken', 'mutton', 'dal', 'roti', 'naan', 'thali',
      'burger', 'pizza', 'sandwich', 'fries', 'pasta', 'noodles', 'rice',
      'paratha', 'kulcha', 'soup', 'starter', 'dessert', 'beverage', 'shake',
      'juice', 'lassi', 'coffee', 'tea', 'breakfast', 'lunch', 'dinner',
      'manchurian', 'tikka', 'kebab', 'curry', 'masala', 'momos',
      'egg', 'anda', 'aanda', 'omelette', 'omlet', 'pulao', 'khana', 'khane'
    ];

    const matchedKeyword = foodKeywords.find(k => lowerText.includes(k));
    
    if (!matchedKeyword) {
      return { intent, confidence, overridden: false };
    }

    // Check for explicit P2P delivery context (friend-to-friend, home-to-office)
    // These should remain as parcel_booking even with food keywords
    const hasExplicitP2PContext = 
      lowerText.includes('courier') ||
      lowerText.includes('pickup from my') ||
      lowerText.includes('from my home') ||
      lowerText.includes('to my friend') ||
      lowerText.includes('deliver to friend') ||
      lowerText.includes('ghar se') ||        // "from home" - P2P
      lowerText.includes('friend ko') ||
      lowerText.includes('dost ko') ||
      /\bse\b.*\btak\b|\bse\b.*\bparcel\b/i.test(lowerText);

    if (hasExplicitP2PContext) {
      this.logger.debug(`📦 Keeping parcel_booking for "${matchedKeyword}" due to P2P context`);
      return { intent, confidence, overridden: false };
    }

    // Food keyword found without P2P context → override to order_food
    this.logger.warn(`🍕 [FOOD_OVERRIDE] LLM classified as parcel_booking but found food keyword "${matchedKeyword}" → overriding to order_food`);
    return {
      intent: 'order_food',
      confidence: 0.95,
      overridden: true,
    };
  }
}
