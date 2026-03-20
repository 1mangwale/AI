import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/services/llm.service';
import { UserPreferenceService } from './user-preference.service';

/**
 * Conversation Analyzer Service
 * 
 * Analyzes user conversations to extract:
 * - Food preferences (veg/non-veg, cuisines, spice level)
 * - Dietary restrictions (allergies, religious, health)
 * - Communication tone and style
 * - Personality traits
 * - Shopping behavior and interests
 * - Sentiment and satisfaction
 */
@Injectable()
export class ConversationAnalyzerService {
  private readonly logger = new Logger(ConversationAnalyzerService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly userPreferenceService: UserPreferenceService,
  ) {}

  /**
   * Analyze conversation to extract user preferences
   */
  async analyzeConversation(params: {
    userId: number;
    phone: string;
    conversationHistory: Array<{ role: string; content: string }>;
    context?: any;
  }): Promise<ConversationAnalysis> {
    const startTime = Date.now();

    try {
      // Build analysis prompt
      const prompt = this.buildAnalysisPrompt(params.conversationHistory);

      // Call LLM to analyze
      const response = await this.llmService.chat({
        messages: [
          {
            role: 'system',
            content: `You are an expert conversation analyst. Analyze user conversations to extract preferences, personality, and behavioral patterns.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        model: 'cyankiwi/Qwen3.5-4B-AWQ-4bit', // Local vLLM model
        temperature: 0.3,
        maxTokens: 2000,
        responseFormat: { type: 'json_object' }
      });

      // Parse LLM response
      const analysis = this.parseAnalysisResponse(response.content);

      this.logger.log(`Analyzed conversation for user ${params.userId} in ${Date.now() - startTime}ms`);

      return {
        userId: params.userId,
        phone: params.phone,
        ...analysis,
        analyzedAt: new Date(),
        processingTimeMs: Date.now() - startTime
      };

    } catch (error) {
      this.logger.error(`Failed to analyze conversation: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract specific insights from a single message
   */
  async extractMessageInsights(params: {
    userId: number;
    messageText: string;
    context?: any;
  }): Promise<MessageInsight[]> {
    const insights: MessageInsight[] = [];

    try {
      // Quick pattern matching for common insights
      const text = params.messageText.toLowerCase();

      // Dietary preferences
      if (text.match(/\b(veg|vegetarian|no meat|meatless)\b/)) {
        insights.push({
          type: 'food_preference',
          category: 'dietary',
          value: { preference: 'vegetarian' },
          confidence: 0.8,
          textExcerpt: params.messageText
        });
      }

      if (text.match(/\b(jain|no onion|no garlic)\b/)) {
        insights.push({
          type: 'food_preference',
          category: 'dietary',
          value: { restriction: 'jain', no_onion: true, no_garlic: true },
          confidence: 0.9,
          textExcerpt: params.messageText
        });
      }

      // Spice preferences
      const spiceMatch = text.match(/\b(mild|medium|spicy|extra spicy|less spicy|more spicy)\b/);
      if (spiceMatch) {
        insights.push({
          type: 'food_preference',
          category: 'taste',
          value: { spice_level: spiceMatch[1] },
          confidence: 0.85,
          textExcerpt: params.messageText
        });
      }

      // Tone detection
      if (text.includes('please') || text.includes('thank you') || text.includes('thanks')) {
        insights.push({
          type: 'tone_shift',
          category: 'behavioral',
          value: { tone: 'polite' },
          confidence: 0.7,
          textExcerpt: params.messageText
        });
      }

      // Complaints
      if (text.match(/\b(late|delay|slow|bad|terrible|worst|disappointed)\b/)) {
        insights.push({
          type: 'complaint',
          category: 'emotional',
          value: { sentiment: 'negative', issue: this.extractIssue(text) },
          confidence: 0.75,
          textExcerpt: params.messageText
        });
      }

      // Compliments
      if (text.match(/\b(good|great|excellent|amazing|love|best|perfect)\b/)) {
        insights.push({
          type: 'compliment',
          category: 'emotional',
          value: { sentiment: 'positive' },
          confidence: 0.7,
          textExcerpt: params.messageText
        });
      }

      return insights;

    } catch (error) {
      this.logger.error(`Failed to extract insights: ${error.message}`);
      return insights;
    }
  }

  /**
   * Analyze tone and communication style
   */
  analyzeTone(conversationHistory: Array<{ role: string; content: string }>): ToneAnalysis {
    const userMessages = conversationHistory.filter(m => m.role === 'user');
    const totalWords = userMessages.reduce((sum, m) => sum + m.content.split(' ').length, 0);
    const avgWordsPerMessage = totalWords / Math.max(userMessages.length, 1);

    let tone = 'neutral';
    let emojiCount = 0;
    let politeWords = 0;
    let urgentWords = 0;

    userMessages.forEach(msg => {
      const text = msg.content.toLowerCase();
      
      // Count emojis
      emojiCount += (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu) || []).length;
      
      // Polite indicators
      if (text.includes('please') || text.includes('thank') || text.includes('kindly')) politeWords++;
      
      // Urgent indicators
      if (text.includes('urgent') || text.includes('asap') || text.includes('quickly')) urgentWords++;
    });

    const emojiUsageRate = emojiCount / Math.max(userMessages.length, 1);

    // Determine tone
    if (politeWords > userMessages.length * 0.3) tone = 'polite';
    else if (urgentWords > 2) tone = 'direct';
    else if (emojiUsageRate > 1) tone = 'friendly';
    else if (avgWordsPerMessage > 20) tone = 'detailed';
    else if (avgWordsPerMessage < 5) tone = 'brief';

    return {
      tone,
      responseStyle: avgWordsPerMessage > 15 ? 'detailed' : avgWordsPerMessage < 8 ? 'brief' : 'conversational',
      emojiUsage: emojiUsageRate > 2 ? 'frequent' : emojiUsageRate > 0.5 ? 'moderate' : emojiUsageRate > 0 ? 'minimal' : 'none',
      avgWordsPerMessage: Math.round(avgWordsPerMessage),
      confidence: 0.7
    };
  }

  // ===================================
  // Methods merged from PreferenceExtractorService
  // ===================================

  /**
   * Extract preferences from a user message
   */
  async extractFromMessage(
    userId: number,
    message: string,
    conversationHistory?: string[],
  ): Promise<ExtractionResult> {
    this.logger.log(`Extracting preferences from: "${message}"`);

    try {
      // Build extraction prompt
      const systemPrompt = this.buildExtractionPrompt();
      const userPrompt = this.buildUserPrompt(message, conversationHistory);

      // Call LLM to extract preferences
      const response = await this.llmService.chat({
        model: 'cyankiwi/Qwen3.5-4B-AWQ-4bit', // Local vLLM model
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3, // Lower temperature for consistent extraction
        maxTokens: 500,
      });

      // Parse LLM response
      const result = this.parseExtractionResponse(response.content, message);

      // Store high-confidence preferences immediately
      await this.storeHighConfidencePreferences(userId, result.preferences);

      this.logger.log(`Extracted ${result.preferences.length} preferences`);
      return result;
    } catch (error) {
      this.logger.error(`Extraction failed: ${error.message}`);
      return { preferences: [], suggestedQuestions: [] };
    }
  }

  /**
   * Build system prompt for preference extraction
   */
  private buildExtractionPrompt(): string {
    return `You are a preference extraction AI for a food delivery and e-commerce platform in Nashik, India.

Your task: Analyze user messages to extract preferences about:

1. DIETARY PREFERENCES:
   - dietary_type: "veg", "non-veg", "vegan", "jain", "eggetarian"
   - spice_level: "mild", "medium", "hot", "extra-hot"
   - allergies: ["peanuts", "dairy", "gluten", "shellfish"]
   - favorite_cuisines: ["chinese", "italian", "indian", "mexican"]
   - disliked_ingredients: ["mushroom", "paneer", "coconut"]

2. SHOPPING BEHAVIOR:
   - price_sensitivity: "budget", "value", "premium"
   - order_frequency: "daily", "weekly", "monthly", "occasional"

3. COMMUNICATION STYLE:
   - communication_tone: "casual", "formal", "friendly"
   - language_preference: "en", "hi", "hinglish", "mr"

4. PERSONALITY TRAITS:
   - decisive: true/false (knows what they want vs exploratory)
   - health_conscious: true/false
   - impatient: true/false

IMPORTANT RULES:
- Only extract if you're confident (confidence > 0.7)
- Use exact values from the lists above
- Assign confidence score 0.0-1.0 based on clarity
- Return JSON format only

Response format:
{
  "preferences": [
    {
      "category": "dietary",
      "key": "dietary_type",
      "value": "veg",
      "confidence": 0.95,
      "shouldConfirm": false
    }
  ],
  "suggestedQuestions": [
    "Btw, spice level medium theek hai ya kam chahiye?"
  ]
}`;
  }

  /**
   * Build user prompt with context
   */
  private buildUserPrompt(message: string, history?: string[]): string {
    let prompt = `Extract preferences from this user message:\n\n"${message}"`;

    if (history && history.length > 0) {
      prompt += `\n\nRecent conversation context:\n${history.slice(-3).join('\n')}`;
    }

    return prompt;
  }

  /**
   * Parse LLM extraction response
   */
  private parseExtractionResponse(
    content: string,
    sourceMessage: string,
  ): ExtractionResult {
    try {
      // Extract JSON from response (LLM might add explanation)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { preferences: [], suggestedQuestions: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Add source to each preference
      const preferences = (parsed.preferences || []).map(pref => ({
        ...pref,
        source: sourceMessage,
      }));

      return {
        preferences,
        suggestedQuestions: parsed.suggestedQuestions || [],
      };
    } catch (error) {
      this.logger.warn(`Failed to parse extraction response: ${error.message}`);
      return { preferences: [], suggestedQuestions: [] };
    }
  }

  /**
   * Store high-confidence preferences immediately
   * Low-confidence preferences are stored as insights for later confirmation
   */
  async storeHighConfidencePreferences(
    userId: number,
    preferences: ExtractedPreference[],
  ): Promise<void> {
    for (const pref of preferences) {
      if (pref.confidence >= 0.85 && !pref.shouldConfirm) {
        // High confidence - update profile directly
        this.logger.log(
          `Storing high-confidence preference: ${pref.key} = ${pref.value} (${pref.confidence})`,
        );

        await this.userPreferenceService.updatePreference(
          userId,
          pref.key,
          pref.value,
          'inferred',
          pref.confidence,
        );
      } else if (pref.confidence >= 0.7) {
        // Medium confidence - store as insight for confirmation
        this.logger.log(
          `Storing insight for confirmation: ${pref.key} = ${pref.value} (${pref.confidence})`,
        );

        await this.userPreferenceService.updatePreference(
          userId,
          `pending_${pref.key}`, // Prefix with 'pending_'
          pref.value,
          'inferred',
          pref.confidence,
        );
      }
    }
  }

  /**
   * Generate confirmation question for pending preferences
   */
  async generateConfirmationQuestion(
    userId: number,
    preference: ExtractedPreference,
  ): Promise<string> {
    const templates = {
      dietary_type: {
        veg: 'Btw, vegetarian preference hai? Profile mein save kar loon?',
        'non-veg': 'Non-veg pasand hai? Agli baar yaad rakhunga',
        vegan: 'Vegan preference hai? Note kar leta hoon',
      },
      spice_level: {
        mild: 'Spice kam pasand hai lagta hai? Medium level set kar doon?',
        hot: 'Spicy lover! Profile mein hot spice level save karoon?',
      },
      price_sensitivity: {
        budget: 'Budget-friendly options pasand hain? Hamesha deals dikhaun?',
        premium: 'Premium quality important hai? High-end options prefer karoge?',
      },
      communication_tone: {
        casual: 'Casual friendly chat theek hai na?',
        formal: 'Formal tone prefer karte hain? Professional rehta hoon?',
      },
    };

    const template = templates[preference.key]?.[preference.value];
    if (template) {
      return template;
    }

    // Generic fallback
    return `${preference.key} set kar loon as ${preference.value}? Profile complete hoga`;
  }

  /**
   * Get pending preferences that need confirmation
   */
  async getPendingConfirmations(userId: number): Promise<ExtractedPreference[]> {
    // Get user insights with 'pending_' prefix
    const prefs = await this.userPreferenceService.getPreferences(userId);

    return prefs.recentInsights
      ?.filter(insight => insight.key.startsWith('pending_'))
      .map(insight => ({
        category: this.getCategoryFromKey(insight.key),
        key: insight.key.replace('pending_', ''),
        value: insight.value,
        confidence: insight.confidence,
        source: 'conversation',
        shouldConfirm: true,
      })) || [];
  }

  /**
   * Confirm a pending preference
   */
  async confirmPreference(
    userId: number,
    key: string,
    confirmed: boolean,
  ): Promise<void> {
    if (confirmed) {
      // Get the pending preference
      const prefs = await this.userPreferenceService.getPreferences(userId);
      const pending = prefs.recentInsights?.find(
        i => i.key === `pending_${key}`,
      );

      if (pending) {
        // Move to actual profile with higher confidence
        await this.userPreferenceService.updatePreference(
          userId,
          key,
          pending.value,
          'explicit', // User confirmed
          1.0, // Full confidence now
        );

        this.logger.log(`Preference confirmed: ${key} = ${pending.value}`);
      }
    } else {
      this.logger.log(`Preference rejected: ${key}`);
    }

    // Remove pending_ insight regardless
    // TODO: Implement insight deletion in UserPreferenceService
  }

  /**
   * Extract preferences from order data (behavioral analysis)
   */
  async extractFromOrder(
    userId: number,
    orderData: {
      items: any[];
      total: number;
      restaurant?: string;
      cuisine?: string;
    },
  ): Promise<void> {
    this.logger.log(`Extracting preferences from order (user ${userId})`);

    // Analyze items for dietary patterns
    const allVeg = orderData.items.every(item =>
      item.name?.toLowerCase().match(/veg|paneer|mushroom|vegetable/)
    );

    if (allVeg) {
      await this.userPreferenceService.updatePreference(
        userId,
        'dietary_type',
        'veg',
        'inferred',
        0.8,
      );
    }

    // Analyze price for sensitivity
    if (orderData.total < 300) {
      await this.userPreferenceService.updatePreference(
        userId,
        'price_sensitivity',
        'budget',
        'inferred',
        0.75,
      );
    } else if (orderData.total > 600) {
      await this.userPreferenceService.updatePreference(
        userId,
        'price_sensitivity',
        'premium',
        'inferred',
        0.75,
      );
    }

    // Extract favorite cuisine
    if (orderData.cuisine) {
      const prefs = await this.userPreferenceService.getPreferences(userId);
      const currentCuisines = prefs.favoriteCuisines || [];

      if (!currentCuisines.includes(orderData.cuisine)) {
        await this.userPreferenceService.updatePreference(
          userId,
          'favorite_cuisines',
          [...currentCuisines, orderData.cuisine],
          'inferred',
          0.7,
        );
      }
    }
  }

  /**
   * Extract communication style from message patterns
   */
  async analyzeMessageStyle(
    userId: number,
    messages: string[],
  ): Promise<void> {
    if (messages.length < 3) return; // Need at least 3 messages

    const avgLength = messages.reduce((sum, msg) => sum + msg.length, 0) / messages.length;
    const hasEmojis = messages.some(msg => /[\u{1F300}-\u{1F9FF}]/u.test(msg));
    const hasHindi = messages.some(msg => /[\u0900-\u097F]/.test(msg));
    const hasSlang = messages.some(msg =>
      /(bro|dude|yaar|bhai|boss)/i.test(msg)
    );

    // Determine tone
    let tone: string;
    if (hasSlang || hasEmojis) {
      tone = 'casual';
    } else if (avgLength > 100) {
      tone = 'formal';
    } else {
      tone = 'friendly';
    }

    await this.userPreferenceService.updatePreference(
      userId,
      'communication_tone',
      tone,
      'inferred',
      0.8,
    );

    // Determine language preference
    let language: string;
    if (hasHindi && !hasEmojis) {
      language = 'hi';
    } else if (hasHindi || hasSlang) {
      language = 'hinglish';
    } else {
      language = 'en';
    }

    await this.userPreferenceService.updatePreference(
      userId,
      'language_preference',
      language,
      'inferred',
      0.85,
    );
  }

  /**
   * Helper: Get category from preference key
   */
  private getCategoryFromKey(key: string): 'dietary' | 'shopping' | 'communication' | 'personality' {
    if (key.match(/dietary|spice|allerg|cuisine|ingredient/)) return 'dietary';
    if (key.match(/price|order|shopping/)) return 'shopping';
    if (key.match(/communication|tone|language/)) return 'communication';
    return 'personality';
  }

  /**
   * Build analysis prompt from conversation history
   */
  private buildAnalysisPrompt(conversationHistory: Array<{ role: string; content: string }>): string {
    const recentMessages = conversationHistory.slice(-20); // Last 20 messages
    
    let prompt = 'Analyze this conversation and extract user preferences and personality:\n\n';
    
    recentMessages.forEach((msg, i) => {
      prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    });

    prompt += '\nProvide detailed analysis in JSON format.';
    
    return prompt;
  }

  /**
   * Parse LLM analysis response
   */
  private parseAnalysisResponse(content: string): any {
    try {
      // Extract JSON from response (may have markdown formatting)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON found in LLM response, using defaults');
        return this.getDefaultAnalysis();
      }

      const analysis = JSON.parse(jsonMatch[0]);
      return analysis;

    } catch (error) {
      this.logger.error(`Failed to parse analysis: ${error.message}`);
      return this.getDefaultAnalysis();
    }
  }

  /**
   * Extract issue type from complaint text
   */
  private extractIssue(text: string): string {
    if (text.includes('late') || text.includes('delay')) return 'delivery_delay';
    if (text.includes('cold') || text.includes('quality')) return 'food_quality';
    if (text.includes('missing') || text.includes('wrong')) return 'wrong_items';
    if (text.includes('rude') || text.includes('behavior')) return 'service_quality';
    return 'other';
  }

  /**
   * Default analysis when parsing fails
   */
  private getDefaultAnalysis(): any {
    return {
      food_preferences: { confidence: 0 },
      dietary_restrictions: [],
      shopping_preferences: { confidence: 0 },
      communication_style: { tone: 'neutral' },
      personality_traits: {},
      behavioral_insights: {},
      sentiment: { overall: 'neutral', satisfaction_score: 3.0 },
      extracted_facts: [],
      insights: []
    };
  }
}

// Type definitions
export interface ConversationAnalysis {
  userId: number;
  phone: string;
  food_preferences?: {
    dietary_type?: string;
    spice_level?: string;
    cuisines?: string[];
    meal_types?: string[];
    confidence?: number;
  };
  dietary_restrictions?: string[];
  shopping_preferences?: {
    product_interests?: string[];
    brands?: string[];
    price_sensitivity?: string;
    confidence?: number;
  };
  communication_style?: {
    tone?: string;
    response_style?: string;
    emoji_usage?: string;
    language_proficiency?: string;
  };
  personality_traits?: {
    patience?: string;
    detail_oriented?: boolean;
    decisive?: boolean;
    price_conscious?: boolean;
    health_conscious?: boolean;
    brand_loyal?: boolean;
  };
  behavioral_insights?: {
    impulse_buyer?: boolean;
    planner?: boolean;
    comparison_shopper?: boolean;
    early_adopter?: boolean;
  };
  sentiment?: {
    overall?: string;
    satisfaction_score?: number;
    recent_complaints?: string[];
    recent_compliments?: string[];
  };
  extracted_facts?: Array<{
    fact: string;
    category: string;
    importance: number;
  }>;
  insights?: string[];
  analyzedAt?: Date;
  processingTimeMs?: number;
}

export interface MessageInsight {
  type: string;
  category: string;
  value: any;
  confidence: number;
  textExcerpt: string;
}

export interface ToneAnalysis {
  tone: string;
  responseStyle: string;
  emojiUsage: string;
  avgWordsPerMessage: number;
  confidence: number;
}

/**
 * Merged from PreferenceExtractorService:
 * Extracted preference types
 */
export interface ExtractedPreference {
  category: 'dietary' | 'shopping' | 'communication' | 'personality';
  key: string;
  value: any;
  confidence: number; // 0.0 - 1.0
  source: string; // The exact message that led to extraction
  shouldConfirm: boolean; // Should we ask user to confirm?
}

export interface ExtractionResult {
  preferences: ExtractedPreference[];
  suggestedQuestions: string[]; // Follow-up questions to gather more data
}
