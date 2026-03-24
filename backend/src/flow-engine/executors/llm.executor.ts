import { Injectable, Logger, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/services/llm.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';
import * as Handlebars from 'handlebars';

/**
 * LLM Executor
 * 
 * Generates AI responses using LLM (vLLM, OpenRouter, Groq, etc.)
 * 
 * ✨ NEW: Includes context injection for:
 * - Weather awareness (temperature, conditions)
 * - Meal time suggestions (breakfast, lunch, dinner)
 * - Festival greetings and special food
 * - Local knowledge (Nashik dishes, slang)
 */
@Injectable()
export class LlmExecutor implements ActionExecutor {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmExecutor.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
  ) {
    // Handlebars helpers (json, or, default, eq, ne) are registered globally
    // in flow-context.service.ts — do NOT re-register here
  }

  private interpolate(text: string, data: any): string {
    if (!text) return text;
    try {
      const template = Handlebars.compile(text);
      return template(data);
    } catch (e) {
      this.logger.warn(`Template interpolation failed: ${e.message}`);
      return text;
    }
  }

  private detectPreferredResponseLanguage(userMessage: string): 'en' | 'hi' | 'mr' | 'hinglish' {
    const msg = (userMessage || '').trim();
    const lower = msg.toLowerCase();

    // Explicit user constraints/preferences should always win.
    if (
      /(i\s*don't\s*know\s*hindi|i\s*do\s*not\s*know\s*hindi|dont\s*know\s*hindi|no\s*hindi|hindi\s+nahi\s+aati|hindi\s+nahi\s+ata|please\s*speak\s*english|speak\s*english|english\s*please|in\s*english)/i.test(
        msg,
      )
    ) {
      return 'en';
    }

    if (/(in\s*hindi|hindi\s*me|hindi\s*mein|हिंदी)/i.test(msg)) return 'hi';
    if (/(in\s*marathi|मराठी)/i.test(msg)) return 'mr';
    if (/(hinglish)/i.test(msg)) return 'hinglish';

    // If the user is writing in Devanagari, assume Hindi/Marathi.
    if (/\p{Script=Devanagari}/u.test(msg)) return 'hi';

    // Safe default.
    return 'en';
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      let prompt = config.prompt as string;
      let systemPrompt = config.systemPrompt as string;
      const temperature = config.temperature || 0.7;
      const maxTokens = config.maxTokens || 500;

      if (!prompt) {
        return {
          success: false,
          error: 'Prompt is required',
        };
      }

      // Interpolate variables in prompts
      prompt = this.interpolate(prompt, context.data);
      if (systemPrompt) {
        systemPrompt = this.interpolate(systemPrompt, context.data);
      }

      // Get user message early (needed for language selection)
      const userMessage = context.data._user_message || context.data.message || '';

      // 🌐 LANGUAGE DETECTION - Use stored preference or detect from message
      const storedLangPref = context.data.languagePreference as string | undefined;
      const detectedLang = storedLangPref || this.detectPreferredResponseLanguage(userMessage);
      const langMap: Record<string, string> = { en: 'English', hi: 'Hindi', mr: 'Marathi', hinglish: 'Hinglish' };
      const langName = langMap[detectedLang] || 'English';

      this.logger.log(`🌐 Language: ${langName} (${detectedLang}${storedLangPref ? ', from profile' : ', detected'}) for: "${userMessage.substring(0, 50)}..."`);

      // 🌤️ CONTEXT INJECTION - Weather, Time, Festivals, Local Knowledge
      // If enhanced context exists in flow data, inject it
      if (context.data.enhancedContext) {
        const ctx = context.data.enhancedContext as any;
        const contextBlock = `
== CURRENT CONTEXT (Nashik, ${new Date().toLocaleDateString('en-IN')}) ==
    Weather: ${ctx.weather?.temperature}°C, ${ctx.weather?.condition}
    Time: ${ctx.time?.timeOfDay} (${ctx.time?.mealTime})
    ${ctx.festival?.isToday ? `🎉 TODAY IS ${ctx.festival?.name || ctx.festival?.nameHindi}! Wish user and suggest: ${ctx.festival?.foods?.join(', ')}` : ''}
    ${ctx.festival?.daysAway && ctx.festival?.daysAway <= 3 ? `📅 ${ctx.festival?.name || ctx.festival?.nameHindi} in ${ctx.festival?.daysAway} days` : ''}
${ctx.weather?.isHot ? '🔥 Hot weather - suggest cold drinks: Lassi, Cold Coffee, Nimbu Pani' : ''}
${ctx.weather?.isCold ? '❄️ Cold weather - suggest hot items: Chai, Coffee, Soup, Pakode' : ''}
${ctx.weather?.isRainy ? '🌧️ Rainy - suggest: Pakode, Bhajiya, Maggi, Chai' : ''}

Suggested foods for ${ctx.time?.mealTime}: ${ctx.suggestions?.timeBased?.join(', ') || 'local favorites'}
`;
        if (systemPrompt) {
          systemPrompt += `\n${contextBlock}`;
        } else {
          systemPrompt = `You are a helpful AI assistant.\n${contextBlock}`;
        }
        this.logger.debug(`🌤️ Injected enhanced context (weather: ${ctx.weather?.temperature}°C, meal: ${ctx.time?.mealTime})`);
      }

      // 🧠 PERSONALIZATION INJECTION
      // If user preference context exists in session data, append it to system prompt
      if (context.data.userPreferenceContext) {
        const prefContext = context.data.userPreferenceContext as string;
        if (systemPrompt) {
          systemPrompt += `\n\n${prefContext}`;
        } else {
          systemPrompt = `You are a helpful AI assistant.\n\n${prefContext}`;
        }
        this.logger.debug(`🧠 Injected user preference context into system prompt`);
      }

      // 🎭 TONE & STYLE ENFORCEMENT - Explicitly enforce stored preferences
      const toneRules: string[] = [];
      const communicationTone = context.data.communicationTone as string | undefined;
      const emojiUsage = context.data.emojiUsage as string | undefined;

      if (communicationTone === 'formal') {
        toneRules.push('USE FORMAL, PROFESSIONAL LANGUAGE. No slang, no casual expressions, no abbreviations.');
      } else if (communicationTone === 'casual') {
        toneRules.push('Use casual, friendly language. Slang and informal expressions are welcome.');
      }

      if (emojiUsage === 'hate' || emojiUsage === 'none') {
        toneRules.push('DO NOT use any emojis in your response.');
      } else if (emojiUsage === 'love' || emojiUsage === 'frequent') {
        toneRules.push('Include 1-2 relevant emojis in your response.');
      }

      // Empathetic response if user is frustrated
      if (context.data._user_frustrated) {
        toneRules.push('The user is frustrated. Be EXTRA empathetic, acknowledge their issue, and provide a clear solution. Start with understanding their concern.');
      }

      if (toneRules.length > 0) {
        const toneBlock = `\n\n=== TONE & STYLE RULES ===\n${toneRules.join('\n')}`;
        if (systemPrompt) {
          systemPrompt += toneBlock;
        } else {
          systemPrompt = `You are a helpful AI assistant.${toneBlock}`;
        }
        this.logger.debug(`🎭 Injected ${toneRules.length} tone rules`);
      }

      // 🌍 LANGUAGE INSTRUCTION - Strong, explicit instruction based on detected language
      const languageInstruction = 'Respond in the same language as the user.';
      const langInstruction = `\n\n=== CRITICAL LANGUAGE INSTRUCTION ===\n${languageInstruction}\n\nUser's language: ${langName} (${detectedLang})\n\nYOU MUST REPLY IN THE SAME LANGUAGE AS THE USER!\nIf user writes "kaise hai", you MUST reply in Hinglish like "Mai badhiya hoon!"\nIf user writes "मुझे pizza चाहिए", you MUST reply in Hindi/Hinglish.\nIf user writes "tumcha naav kya aahe", you MUST reply in Marathi like "Majhe naav Chotu aahe!"\n\nNEVER reply in English if user spoke Hindi/Hinglish/Marathi!`;
      
      if (systemPrompt) {
        systemPrompt += langInstruction;
      } else {
        systemPrompt = `You are a helpful AI assistant.${langInstruction}`;
      }

      this.logger.debug(`Generating LLM response with prompt: ${prompt.substring(0, 100)}...`);

      // Build messages array
      const messages: any[] = [];

      // Add system prompt if provided
      if (systemPrompt) {
        messages.push({
          role: 'system',
          content: systemPrompt,
        });
      }

      // Add conversation history if available (skip if config.skipHistory is true)
      // skipHistory is useful for extraction tasks where conversation pollutes context
      if (context.data._conversation_history && !config.skipHistory) {
        messages.push(...context.data._conversation_history);
      }

      // Add current user message (if not already in history)
      if (userMessage) {
        messages.push({
          role: 'user',
          content: userMessage,
        });
      }

      // Add the prompt as a user instruction (NOT as assistant message!)
      // The prompt guides the LLM on what kind of response to generate
      // Example: 'Say "I can help you..."' should generate: "I can help you..."
      messages.push({
        role: 'user',
        content: `INSTRUCTION: ${prompt}\n\nGenerate the appropriate response now. Only output the response text, no explanation.`,
      });

      // Build LLM request with optional structured output
      const llmRequest: any = {
        messages,
        temperature,
        maxTokens,
        provider: config.provider || 'auto',
      };

      // Structured output: use vLLM guided decoding for reliable JSON
      if (config.parseJson && config.jsonSchema) {
        llmRequest.guidedJson = config.jsonSchema;
      } else if (config.parseJson) {
        llmRequest.responseFormat = { type: 'json_object' };
      }

      // Call LLM service (auto mode enables fallback to cloud when vLLM unavailable)
      const result = await this.llmService.chat(llmRequest);

      let response = result.content;

      // Strip outer quotes if the LLM wrapped the response in them
      if (response && typeof response === 'string') {
        response = response.trim();
        // Remove outer double quotes if present
        if (response.startsWith('"') && response.endsWith('"')) {
          response = response.slice(1, -1);
        }
        // Remove outer single quotes if present
        if (response.startsWith("'") && response.endsWith("'")) {
          response = response.slice(1, -1);
        }
      }

      // JSON Parsing Logic
      if (config.parseJson) {
        try {
          // Try to extract JSON from code blocks first
          const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                           response.match(/```\s*([\s\S]*?)\s*```/);
          
          const jsonString = jsonMatch ? jsonMatch[1] : response;
          
          // Clean up any potential non-JSON text if no code blocks were found
          // This is a simple heuristic: find the first { and last }
          const firstBrace = jsonString.indexOf('{');
          const lastBrace = jsonString.lastIndexOf('}');
          
          let finalJsonString = jsonString;
          if (firstBrace !== -1 && lastBrace !== -1) {
            finalJsonString = jsonString.substring(firstBrace, lastBrace + 1);
          }

          const parsedOutput = JSON.parse(finalJsonString);
          
          return {
            success: true,
            output: parsedOutput,
            event: 'success',
          };
        } catch (e) {
          this.logger.warn(`Failed to parse JSON from LLM response: ${e.message}`);
          // Fallback to raw response if parsing fails, but mark as error or just return raw?
          // If we return raw, the flow might break if it expects an object.
          // Let's return success: false to trigger error handling in flow
          return {
            success: false,
            error: `Failed to parse JSON: ${e.message}`,
            output: response
          };
        }
      }

      // Store response in context
      context.data._last_response = response;
      context.data._llm_model_used = result.model;

      // Update conversation history
      if (!context.data._conversation_history) {
        context.data._conversation_history = [];
      }
      context.data._conversation_history.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: response }
      );

      this.logger.debug(`LLM response generated: ${response.substring(0, 100)}...`);

      // Phase 2: Analyze user sentiment and record training data
      if (userMessage) {
        try {
          const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
            conversation_history: context.data._conversation_history || [],
            flow_stage: 'llm_interaction',
          });

          this.logger.debug(`😊 Sentiment: ${sentiment.emotion}, frustration: ${sentiment.frustration_score.toFixed(2)}`);

          // Record training data for LLM response quality
          await this.advancedLearning.recordTrainingData({
            message: userMessage,
            questionType: 'llm_query',
            actualClassification: true,
            predictedClassification: true,
            confidence: 0.85,
            flowContext: 'llm_conversation',
            language: this.detectLanguage(userMessage),
            userId: context._system?.userId || 'unknown',
            sessionId: context._system?.sessionId || 'unknown',
          });

          // If user is highly frustrated, add empathetic note to next response
          if (sentiment.frustration_score > 0.7) {
            this.logger.log(`🚨 High frustration detected (${sentiment.frustration_score.toFixed(2)})`);
            context.data._user_frustrated = true;
            context.data._frustration_score = sentiment.frustration_score;
          }
        } catch (error) {
          this.logger.warn(`Phase 2 analysis failed: ${error.message}`);
        }
      }

      return {
        success: true,
        output: response,
        // event: 'user_message', // REMOVED: Do not trigger user_message event automatically. Let the flow wait for actual user input.
      };
    } catch (error) {
      this.logger.error(`LLM execution failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/;
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  validate(config: Record<string, any>): boolean {
    return !!config.prompt;
  }
}
