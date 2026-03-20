import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ExtractedEntities } from '../interfaces/nlu.interfaces';

/**
 * LLM Client Service
 * Connects to vLLM (Qwen2.5-7B-Instruct-AWQ) for complex query parsing
 * Endpoint: http://192.168.0.156:8002/v1
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly llmEndpoint: string;
  private readonly modelName: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.llmEndpoint = this.config.get<string>('VLLM_ENDPOINT', 'http://192.168.0.156:8002/v1');
    this.modelName = this.config.get<string>('VLLM_MODEL', 'Qwen/Qwen2.5-7B-Instruct-AWQ');
    this.logger.log(`LLM Client initialized: ${this.llmEndpoint}`);
  }

  /**
   * Parse complex query using vLLM
   * Complex path: ~200ms for multi-filter queries
   */
  async parseComplexQuery(query: string, context?: any): Promise<ExtractedEntities> {
    const startTime = Date.now();
    const prompt = this.buildParsingPrompt(query, context);

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.llmEndpoint}/chat/completions`, {
          model: this.modelName,
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt(),
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,  // Low temperature for structured output
          max_tokens: 500,
          top_p: 0.95,
          chat_template_kwargs: { enable_thinking: false },  // Disable Qwen3.5 thinking mode
        }),
      );

      const latency = Date.now() - startTime;
      this.logger.debug(`vLLM parsing: ${latency}ms`);

      // Parse JSON response from LLM
      const content = response.data.choices[0].message.content;
      const parsed = this.extractJSON(content);

      return {
        ...parsed,
        confidence: parsed.confidence || 0.85,
        user_intent: parsed.user_intent || 'search',
      };
    } catch (error: any) {
      this.logger.error(`vLLM parsing failed: ${error.message}`);
      
      // Fallback: basic parsing
      return this.fallbackParsing(query);
    }
  }

  /**
   * Build parsing prompt for LLM
   */
  private buildParsingPrompt(query: string, context?: any): string {
    let prompt = `Parse this search query into structured filters for an Indian food delivery/grocery platform.

Query: "${query}"`;

    if (context) {
      prompt += `\nContext: ${JSON.stringify(context)}`;
    }

    prompt += `

Available filters:
- module_id: 4 (food/restaurants), 5 (grocery/shop), 13 (pharmacy), 6 (rooms/hotels), 8 (movies)
- query_text: Main search term (clean, normalized)
- veg: 1 (vegetarian), 0 (non-vegetarian)
- price_min, price_max: Number in rupees
- is_open: boolean (for "open now", "available")
- rating_min: 1-5
- category: Category name
- brand: Brand name
- tags: Array of tags ["organic", "gluten-free"]
- sort_by: "price", "rating", "distance", "popularity"
- use_current_location: boolean (for "near me", "nearby")
- entity_type: "item" or "store"

Examples:
"cheap veg biryani" → {"query_text": "biryani", "veg": 1, "price_max": 200, "module_id": 4, "user_intent": "search", "confidence": 0.9}
"grocery store near me" → {"module_id": 5, "entity_type": "store", "use_current_location": true, "user_intent": "search", "confidence": 0.95}
"medicine for fever" → {"query_text": "fever medicine", "module_id": 13, "category": "medicine", "user_intent": "search", "confidence": 0.85}
"5 star rated restaurants with veg food open now" → {"module_id": 4, "entity_type": "store", "veg": 1, "rating_min": 4.5, "is_open": true, "user_intent": "search", "confidence": 0.92}

Return ONLY valid JSON (no explanation, no markdown):`;

    return prompt;
  }

  /**
   * System prompt for query parsing
   */
  private getSystemPrompt(): string {
    return `You are a search query parser for a multi-module Indian e-commerce platform (food delivery, grocery, pharmacy, hotels, movies). 
Your task is to convert natural language queries into structured JSON filters.
Always return valid JSON only, no explanations.
Understand Hindi, English, and Hinglish queries.
Infer intent and extract all relevant filters.`;
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks)
   */
  private extractJSON(content: string): any {
    try {
      // Remove markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      
      return JSON.parse(jsonStr.trim());
    } catch (error: any) {
      this.logger.error(`Failed to parse LLM JSON: ${error.message}`);
      return {};
    }
  }

  /**
   * Fallback parsing when LLM fails
   */
  private fallbackParsing(query: string): ExtractedEntities {
    const lower = query.toLowerCase();
    
    return {
      query_text: query,
      veg: lower.includes('veg') && !lower.includes('non') ? 1 : undefined,
      is_open: lower.includes('open') ? true : undefined,
      use_current_location: lower.includes('near') ? true : undefined,
      user_intent: 'search',
      confidence: 0.5,
    };
  }

  /**
   * Generate a response from LLM (for reflection, planning, etc.)
   */
  async generateResponse(prompt: string, maxTokens: number = 500): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.llmEndpoint}/chat/completions`, {
          model: this.modelName,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: maxTokens,
          top_p: 0.95,
        }, { timeout: 30000 }),
      );

      return response.data.choices[0]?.message?.content || '';
    } catch (error: any) {
      this.logger.error(`LLM generate failed: ${error.message}`);
      return '';
    }
  }

  /**
   * Health check for vLLM service
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.llmEndpoint}/models`, { timeout: 5000 }),
      );
      return response.data.data?.length > 0;
    } catch (error: any) {
      this.logger.warn(`vLLM service health check failed: ${error.message}`);
      return false;
    }
  }
}
