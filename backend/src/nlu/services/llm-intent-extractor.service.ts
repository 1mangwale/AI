import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/services/llm.service';
import { PrismaService } from '../../database/prisma.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

export interface LlmIntentExtractionResult {
  intent: string;
  confidence: number;
  entities: Record<string, any>;
  tone: string;
  sentiment: string;
  urgency: number;
  reasoning: string; // Why LLM chose this intent
  needsClarification?: boolean; // If true, bot should ask user to clarify
  clarificationOptions?: string[]; // Suggested options to present to user
}

export interface LlmIntentContext {
  activeModule?: string; // 'food', 'ecommerce', 'parcel', etc.
  activeFlow?: string; // Current flow ID like 'food_order_v1'
  activeState?: string; // Current state in the flow state machine
  lastBotQuestion?: string; // What the bot asked before this message
  conversationHistory?: string[]; // Recent messages for context
}

@Injectable()
export class LlmIntentExtractorService {
  private readonly logger = new Logger(LlmIntentExtractorService.name);

  private static readonly CACHE_PREFIX = 'llm_intent:';
  private static readonly CACHE_TTL = 7200; // 2 hours

  constructor(
    private readonly llmService: LlmService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    if (this.redis) {
      this.logger.log('Redis available for LLM intent cache');
    }
  }

  /**
   * Use LLM to extract intent when NLU confidence is low
   * This is the fallback when IndicBERT/heuristics fail
   * 
   * @param text - User message
   * @param language - Language code
   * @param availableIntents - List of intents to choose from
   * @param context - Optional context about active flow/module
   */
  async extractIntent(
    text: string,
    language: string = 'en',
    availableIntents: string[],
    context?: LlmIntentContext,
  ): Promise<LlmIntentExtractionResult> {
    this.logger.log(`LLM fallback for: "${text}"${context?.activeModule ? ` (active: ${context.activeModule})` : ''}`);

    // Quick pattern-based check for chitchat before LLM (saves tokens)
    // Includes: Hinglish, seasonal greetings, pleasantries, follow-up responses
    const chitchatPatterns = [
      // Hinglish patterns
      /kaise\s*(hai|ho)/i,       // kaise hai, kaise ho
      /kya\s*(haal|chal)/i,      // kya haal, kya chal
      /kaisa\s*hai/i,            // kaisa hai
      /theek\s*(ho|hai)/i,       // theek ho, theek hai
      /sab\s*theek/i,            // sab theek
      /kya\s*kar\s*rahe/i,       // kya kar rahe ho
      /\bchotu\b/i,              // chotu (bot name)
      /\bre\s+chotu\b/i,         // re chotu
      /\bhey\s+chotu\b/i,        // hey chotu
      // Seasonal/festival greetings (respond as chitchat, not new greeting)
      /merry\s*christmas/i,      // merry christmas
      /happy\s*(new\s*year|diwali|holi|eid|rakhi|navratri)/i, // festivals
      /shubh\s*(diwali|holi|navratri)/i, // Hindi festivals
      // Pleasantries and thank-you
      /thank\s*(you|u)|thanks/i,  // thank you, thanks
      /good\s*(job|work|one)/i,   // good job
      /nice|cool|awesome|great|amazing|wonderful/i, // positive feedback
      /same\s*to\s*(you|u)/i,     // same to you
      /you\s*too/i,               // you too
      // Social questions
      /how\s*are\s*(you|u)/i,     // how are you
      /what'?s\s*up/i,            // what's up
      /wassup|sup\b/i,            // casual greetings
    ];

    for (const pattern of chitchatPatterns) {
      if (pattern.test(text)) {
        this.logger.log(`Matched chitchat pattern: ${pattern}`);
        return {
          intent: 'chitchat',
          confidence: 0.92,
          entities: {},
          tone: 'friendly',
          sentiment: 'positive',
          urgency: 0.1,
          reasoning: 'Chitchat/pleasantry pattern detected',
        };
      }
    }

    // Pattern-based check for restaurant/food browsing (before LLM)
    // These should go to browse_menu, NOT search_product
    const browseMenuPatterns = [
      // "What is open" queries - asking about restaurant availability
      /what('?s| is)?\s*(open|available)\s*(now|today|to\s*(order|eat))?/i,  // what is open now
      /which\s*(rest(aurant|ro)|shop|store)s?\s*(are|is)?\s*(open|available)/i, // which restaurants are open
      /any\s*(rest(aurant|ro)|shop|store)s?\s*(open|available)/i, // any restaurants open
      /\b(restro|restaurant)s?\s*(open|available|khula)/i, // restro open, restaurant available
      /kya\s*(open|khula)\s*(hai|h)/i, // kya open hai (Hinglish)
      /konsa\s*(rest(aurant|ro)|shop)\s*(open|khula)/i, // konsa restaurant open
      /kaun\s*sa\s*(rest(aurant|ro)|shop)\s*(open|khula)/i, // kaun sa restaurant open
      /show\s*(me\s*)?(open|available)\s*(rest(aurant|ro)|shop|store)s?/i, // show open restaurants
      /list\s*(open|available)\s*(rest(aurant|ro)|shop|store)s?/i, // list open restaurants
      // Menu browsing
      /show\s*(me\s*)?(the\s*)?(menu|food|options)/i, // show menu
      /menu\s*(dikha|show|batao)/i, // menu dikha (Hinglish)
      /kya\s*(mil|mileag)\s*(sakta|sakte)\s*(h|hai)/i, // kya mil sakta hai
      /what\s*(all\s*)?(can|do)\s*(i|you)\s*(get|order|have)/i, // what can I order
    ];

    for (const pattern of browseMenuPatterns) {
      if (pattern.test(text)) {
        this.logger.log(`Matched browse_menu pattern: ${pattern}`);
        return {
          intent: 'browse_menu',
          confidence: 0.90,
          entities: {},
          tone: 'neutral',
          sentiment: 'neutral',
          urgency: 0.5,
          reasoning: 'Restaurant/menu browsing pattern detected',
        };
      }
    }

    // Check Redis cache before making LLM call
    const cacheKey = `${LlmIntentExtractorService.CACHE_PREFIX}${text.toLowerCase().trim().slice(0, 100)}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.logger.log(`[LLM-CACHE] Hit for "${text.slice(0, 30)}..."`);
          return JSON.parse(cached) as LlmIntentExtractionResult;
        }
      } catch (cacheErr) {
        this.logger.warn(`[LLM-CACHE] Read error: ${cacheErr.message}`);
      }
    }

    let intentList = '';

    try {
      // Fetch intents from database (no enabled field in schema)
      const dbIntents = await this.prisma.intentDefinition.findMany();

      if (dbIntents.length > 0) {
        intentList = dbIntents.map((intent, i) => 
          `${i + 1}. ${intent.name}: ${intent.description || ''}`
        ).join('\n');
        this.logger.debug(`Loaded ${dbIntents.length} intents from database`);
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch intents from DB: ${error.message}. Using hardcoded fallback.`);
    }

    // Fallback to hardcoded intents if DB is empty or failed
    if (!intentList) {
      const intentDescriptions = {
        // Core intents
        'order_food': 'User wants to order food/meals FROM A RESTAURANT (pizza, biryani, burger, etc.).',
        'browse_menu': 'User wants to SEE RESTAURANTS or MENUS. INCLUDES: "what is open now", "which restaurants are available", "show open restaurants", "show menu", "what can I order", "any restro open". Use for restaurant availability questions.',
        'browse_category': 'User wants to browse a specific food category like "pizza section", "biryani category", "chinese food dikhao", "desserts kya hai".',
        'browse_stores': 'User wants to see OTHER STORES/RESTAURANTS. INCLUDES: "other restro", "other restaurant", "more stores", "different shop", "aur restaurant dikhao", "partner restaurants", "all stores". Use when user asks to see other/different/more restaurants.',
        'ask_recommendation': 'User asking for RECOMMENDATIONS or BEST options: "best biryani", "konsa restaurant achha hai", "top rated food", "recommend karo", "suggest karo", "which is best", "nashik ki best misal". Use when user asks for quality/rating based suggestions.',
        'ask_famous': 'User asking about FAMOUS/POPULAR items: "sabse famous kya hai", "trending kya hai", "log kya khate hai", "popular dishes". Use for popularity-based queries.',
        'ask_fastest_delivery': 'User wants FAST/URGENT delivery: "jaldi khana chahiye", "kahan se jaldi milega", "fastest delivery", "urgent food", "abhi chahiye", "turant". Use for speed-based queries.',
        'ask_price': 'User asking about price/cost: "kitne ka hai", "price kya hai", "how much", "cost of", "rate batao".',
        'ask_time': 'User asking about delivery time/ETA: "kitna time lagega", "kab tak aayega", "delivery time", "how long".',
        'track_order': 'User asking about order location/status ("where is my order", "track delivery")',
        'cancel_order': 'User wants to cancel an existing order',
        'repeat_order': 'User wants to repeat a previous order ("repeat last order", "same as before")',
        'parcel_booking': 'User wants to send/book a parcel/courier/package. INCLUDES sending home-cooked food to friends/family ("send food to my friend", "pickup from home").',
        'search_product': 'User searching for SPECIFIC PRODUCTS in E-COMMERCE (groceries, electronics, clothing, accessories). NOT for restaurants or food ordering. Examples: "find headphones", "show me laptops", "looking for shoes".',
        // Cart & checkout
        'add_to_cart': 'User wants to add a specific item to their cart: "add this", "ye daal do", "add 2 paneer butter masala".',
        'view_cart': 'User wants to see their cart contents: "show cart", "my cart", "cart dikhao", "what is in my cart".',
        'remove_from_cart': 'User wants to remove a specific item from cart: "remove pizza from cart", "hatao", "cart se nikalo".',
        'update_quantity': 'User wants to change quantity of an item in cart: "increase to 3", "ek aur add karo", "quantity badhao".',
        'checkout': 'User ready to place order and pay: "checkout", "place order", "proceed to payment", "pay now", "order karo".',
        'select_item': 'User selecting a specific item from search results or menu: "this one", "number 2", "ye wala".',
        'use_saved': 'User wants to use a previously saved address/payment method: "use my home address", "saved address use karo".',
        // Confirmations & conversation control
        'affirm': 'User confirming/agreeing: "yes", "ok", "sure", "haan", "ji", "theek hai". Short affirmative responses.',
        'deny': 'User declining/refusing: "no", "nahi", "nope", "mat karo". Short negative responses.',
        'confirm': 'User explicitly confirming an action: "confirm", "yes confirm", "pakka". Stronger than affirm.',
        'cancel': 'User wants to cancel current action or conversation: "cancel", "ruko", "stop".',
        'restart': 'User wants to start over: "restart", "start fresh", "reset", "naya shuru karo".',
        'feedback': 'User giving feedback about service: "great service", "bahut acha", "not good", "need improvement".',
        // Support & auth
        'earn': 'User wants to play games, earn money, rewards, or see leaderboard',
        'help': 'User explicitly needs help/support/assistance with a specific problem. NOT for capability questions like "what can you do" (use chitchat for those).',
        'complaint': 'User complaining about service/product (wrong item, damaged, refund)',
        'support_request': 'User requesting customer support or wanting to talk to a human agent.',
        'greeting': 'User greeting (hi, hello, hey, namaste)',
        'chitchat': 'Casual conversation, small talk, pleasantries, OR capability questions: "how are you", "kaise hai", "what can you do", "what can you do for me", "what are your capabilities", "what services do you offer", "kya kya kar sakte ho", "merry christmas", "happy diwali", "thank you", "same to you", "what\'s up", "chotu" (bot name). Use for conversational questions about the bot itself.',
        'login': 'User wants to login, sign in, register, or check authentication status',
        'manage_address': 'User wants to add, save, view, or manage saved addresses. INCLUDES: "save this address as home", "add address", "show my addresses", "save this location as office", or when user shares location with request to save it.',
        'service_inquiry': 'User asking about available services, vehicles, categories, or pricing ("what vehicles do you have", "show categories")',
        // VENDOR intents (B2B - Restaurant/Store owners)
        'vendor_orders': 'VENDOR/STORE OWNER asking about their orders: "aaj kitne orders aaye?", "today\'s orders", "pending orders", "new orders". This is FOR vendors checking their incoming customer orders, NOT for customers.',
        'vendor_accept_order': 'VENDOR accepting an order: "order accept karo", "confirm order"',
        'vendor_reject_order': 'VENDOR rejecting an order: "order reject karo", "cancel from my side"',
        'vendor_mark_ready': 'VENDOR marking order ready: "order ready hai", "ready for pickup", "taiyaar hai"',
        'vendor_earnings': 'VENDOR checking earnings: "aaj ki kamai", "today\'s earnings", "meri kamai", "sales report"',
        'vendor_menu': 'VENDOR managing menu: "menu update", "disable item", "item band karo", "out of stock"',
        'vendor_login': 'VENDOR logging in: "vendor login", "store login", "restaurant login"',
        // RIDER intents (Delivery partners)
        'rider_orders': 'RIDER/DELIVERY PERSON checking assigned orders: "mere orders dikhao", "assigned deliveries", "my deliveries"',
        'rider_accept_delivery': 'RIDER accepting a delivery: "delivery accept karo", "accept karo"',
        'rider_pickup': 'RIDER confirming pickup: "pickup kar liya", "picked up", "restaurant se le liya"',
        'rider_delivered': 'RIDER confirming delivery complete: "delivery complete", "delivered", "pahuncha diya"',
        'rider_earnings': 'RIDER checking earnings: "meri kamai", "rider earning", "delivery earnings"',
        'rider_online': 'RIDER going online: "go online", "online karo", "start delivery"',
        'rider_offline': 'RIDER going offline: "go offline", "offline karo", "stop delivery"',
        'rider_login': 'RIDER logging in: "rider login", "delivery man login"',
        'needs_clarification': 'Message is AMBIGUOUS and could belong to MULTIPLE intents. Use ONLY when you genuinely cannot decide between 2+ intents.',
        'unknown': 'Message unclear or doesn\'t fit other intents'
      };

      intentList = availableIntents.map((intent, i) => 
        `${i + 1}. ${intent}: ${intentDescriptions[intent] || intent}`
      ).join('\n');
    }

    // Build context section for the system prompt (flow/module info only — no user-supplied strings)
    let contextSection = '';
    const hasFlowContext = context?.activeModule || context?.activeFlow || context?.activeState;
    if (hasFlowContext) {
      contextSection = `\n\nCONVERSATION CONTEXT (very important):`;
      if (context.activeModule) {
        contextSection += `\n- User is currently in the "${context.activeModule}" module/flow`;
        if (context.activeModule === 'food') {
          contextSection += ` (ordering food from restaurants)`;
        } else if (context.activeModule === 'ecommerce') {
          contextSection += ` (shopping for products)`;
        } else if (context.activeModule === 'parcel') {
          contextSection += ` (booking parcel delivery)`;
        }
      }
      if (context.activeFlow) {
        contextSection += `\n- Active flow: ${context.activeFlow}`;
      }
      if (context.activeState) {
        contextSection += `\n- Current state: ${context.activeState}`;
      }
      contextSection += `\n\nIMPORTANT: If user's message is a RESPONSE to the bot's question, interpret it in that context!
- If bot asked "What do you want to eat?" and user says "kya khula hai" → browse_menu (0.9) NOT search_product
- If bot asked about food and user says "yes" or short answer → stay in food context
- Short replies like "yes", "no", "2", numbers, or single words during an active flow are almost always contextual responses (affirm/deny/select_item)`;
    }

    const systemPrompt = `You are an expert intent classifier for a delivery and e-commerce platform in India.

Available Intents:
${intentList}${contextSection}

Your task:
1. Classify the user's message into ONE of the above intents
2. Extract entities (location, product, order_id, phone, date, etc.)
3. Detect tone (happy, angry, urgent, neutral, frustrated, polite, confused)
4. Assess urgency (0.0 to 1.0)
5. Provide brief reasoning
6. If truly ambiguous, set needs_clarification=true and suggest options

Rules:
- Match queries like "I want pizza" → order_food (high confidence 0.85+)
- Match "where is my order" → track_order (high confidence 0.9+)
- CRITICAL FOR "kya khula hai" / "what is open" / "jo open ho":
  - If in FOOD context OR user recently discussed food → browse_menu (0.9)
  - If NO context and truly ambiguous → needs_clarification with confidence 0.5
- Do NOT classify "Cash on Delivery", "COD", or "Pay via Cash" as parcel_booking. These are payment methods.
- CRITICAL: If user shares a Google Maps link or location WITH a request to "save", "add", or label it as "home"/"office" → manage_address (0.9+)
- CRITICAL DISTINCTION: 
  - "Order food" / "I want pizza" = order_food (Restaurant -> User)
  - "Send food to friend" / "Pickup food from home" = parcel_booking (User -> User)
- Handle Hinglish and misspellings
- Be decisive for CLEAR matches (0.7-0.95 confidence)
- For AMBIGUOUS messages that could be multiple intents: use needs_clarification=true, confidence=0.5

Respond ONLY with valid JSON in this exact format:
{
  "intent": "intent_name",
  "confidence": 0.0-1.0,
  "entities": {"entity_type": "value"},
  "tone": "happy|angry|urgent|neutral|frustrated|polite|confused",
  "sentiment": "positive|negative|neutral",
  "urgency": 0.0-1.0,
  "reasoning": "brief explanation",
  "needs_clarification": false,
  "clarification_options": []
}

If needs_clarification=true, include options like:
"clarification_options": ["order_food: Are you looking for restaurants?", "search_product: Looking for products to buy?"]`;

    try {
      // Build user message: include lastBotQuestion in user role (not system) for security
      // This prevents user-supplied content from being treated as system instructions
      let userMessage = text;
      if (context?.lastBotQuestion) {
        userMessage = `[Bot previously asked: "${context.lastBotQuestion}"]\nUser reply: ${text}`;
      }

      const response = await this.llmService.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        // Auto mode: try vLLM first, fallback to cloud (Groq/OpenRouter)
        provider: 'auto',
        temperature: 0.2, // Very low for consistent classification
        maxTokens: 200,
      });

      // Parse LLM response
      const result = this.parseLlmResponse(response.content);

      this.logger.log(
        `LLM extracted: ${result.intent} (${result.confidence.toFixed(2)}) - ${result.reasoning}`,
      );

      // Cache successful LLM result in Redis
      if (this.redis) {
        try {
          await this.redis.setex(cacheKey, LlmIntentExtractorService.CACHE_TTL, JSON.stringify(result));
          this.logger.debug(`[LLM-CACHE] Stored for "${text.slice(0, 30)}..." (TTL: ${LlmIntentExtractorService.CACHE_TTL}s)`);
        } catch (cacheErr) {
          this.logger.warn(`[LLM-CACHE] Write error: ${cacheErr.message}`);
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`LLM intent extraction failed: ${error.message}`);
      
      // Ultimate fallback
      return {
        intent: 'unknown',
        confidence: 0.1,
        entities: {},
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0.5,
        reasoning: 'LLM extraction failed',
      };
    }
  }

  /**
   * Parse LLM JSON response with error handling
   */
  private parseLlmResponse(content: string): LlmIntentExtractionResult {
    try {
      // Remove markdown code blocks if present
      const cleanedContent = content
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();

      const parsed = JSON.parse(cleanedContent);

      return {
        intent: parsed.intent || 'unknown',
        confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
        entities: parsed.entities || {},
        tone: parsed.tone || 'neutral',
        sentiment: parsed.sentiment || 'neutral',
        urgency: Math.min(Math.max(parsed.urgency || 0.5, 0), 1),
        reasoning: parsed.reasoning || 'No reasoning provided',
        needsClarification: parsed.needs_clarification || false,
        clarificationOptions: parsed.clarification_options || [],
      };
    } catch (error) {
      this.logger.warn(`Failed to parse LLM response: ${error.message}`);
      this.logger.debug(`Raw content: ${content}`);

      // Try to extract intent from natural language response
      const intent = this.extractIntentFromNaturalLanguage(content);

      return {
        intent,
        confidence: 0.6,
        entities: {},
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0.5,
        reasoning: 'Parsed from natural language response',
      };
    }
  }

  /**
   * Fallback: Extract intent from natural language LLM response
   */
  private extractIntentFromNaturalLanguage(content: string): string {
    const lowerContent = content.toLowerCase();

    const intentKeywords: Record<string, string[]> = {
      order_food: ['order', 'food', 'restaurant', 'menu'],
      track_order: ['track', 'status', 'delivery', 'where'],
      cancel_order: ['cancel', 'refund'],
      search_product: ['search', 'find', 'looking'],
      parcel_booking: ['parcel', 'courier', 'send'],
      support_request: ['help', 'support', 'assist'],
      complaint: ['complaint', 'problem', 'issue'],
    };

    for (const [intent, keywords] of Object.entries(intentKeywords)) {
      if (keywords.some(kw => lowerContent.includes(kw))) {
        return intent;
      }
    }

    return 'unknown';
  }
}
