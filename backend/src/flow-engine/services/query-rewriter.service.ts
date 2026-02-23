import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/services/llm.service';
import { ChatCompletionDto } from '../../llm/dto/chat-completion.dto';

@Injectable()
export class QueryRewriterService {
  private readonly logger = new Logger(QueryRewriterService.name);

  constructor(private readonly llm: LlmService) {}

  /**
   * Rewrite a search query using conversation context.
   * Uses a small/fast LLM to enhance the query with context from recent messages.
   *
   * Examples:
   *   user said "veg only" earlier, now searches "biryani" → "veg biryani"
   *   user said "from inayat cafe" earlier, now searches "butter chicken" → "butter chicken inayat cafe"
   */
  async rewriteQuery(
    originalQuery: string,
    recentMessages: string[],
    userPreferences?: { dietaryPreference?: string; favoriteStores?: string[] },
  ): Promise<string> {
    // If no context or query is already detailed, return as-is
    if (!recentMessages?.length || originalQuery.length > 50) {
      return originalQuery;
    }

    try {
      const prompt = `You are a search query enhancer for a food delivery app. Given the user's recent conversation and their new search query, rewrite the query to include relevant context.

Recent messages:
${recentMessages.slice(-5).map((m, i) => `${i + 1}. "${m}"`).join('\n')}

${userPreferences?.dietaryPreference ? `User preference: ${userPreferences.dietaryPreference}` : ''}

New search query: "${originalQuery}"

Rules:
- Only add context that's clearly relevant to the search
- Keep the rewritten query short (max 6 words)
- If no context is relevant, return the original query unchanged
- Don't add location info (handled separately)
- Focus on: food preferences, store preferences, dietary restrictions

Rewritten query:`;

      const dto: ChatCompletionDto = {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 30,
        temperature: 0.1,
        provider: 'auto',
      };

      const result = await this.llm.chat(dto);

      const rewritten = result?.content?.trim()?.replace(/^["']|["']$/g, '') || originalQuery;

      // Sanity check: don't use rewrite if it's too long or empty
      if (!rewritten || rewritten.length > 60 || rewritten.length < 2) {
        return originalQuery;
      }

      this.logger.log(`Query rewrite: "${originalQuery}" → "${rewritten}"`);
      return rewritten;
    } catch (err) {
      this.logger.warn(`Query rewrite failed, using original: ${err.message}`);
      return originalQuery;
    }
  }
}
