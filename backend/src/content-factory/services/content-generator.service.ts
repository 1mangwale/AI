import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PromptService } from './prompt.service';
import { HookService } from './hook.service';
import { DataSyncService } from './data-sync.service';
import { LearningEngineService } from './learning-engine.service';
import {
  ContentGenerationRequest,
  ContentGenerationResult,
  ContentProvider,
  TrendingHook,
} from '../interfaces/content-factory.interfaces';

@Injectable()
export class ContentGeneratorService {
  private readonly logger = new Logger(ContentGeneratorService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly promptService: PromptService,
    private readonly hookService: HookService,
    private readonly dataSyncService: DataSyncService,
    private readonly learningEngine: LearningEngineService,
  ) {
    const apiKey = this.config.get('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      this.logger.log('Anthropic client initialized');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — Claude generation unavailable');
    }
  }

  async generateContent(request: ContentGenerationRequest): Promise<ContentGenerationResult> {
    const startTime = Date.now();

    // 1. Fetch active prompt
    const prompt = await this.promptService.getActivePrompt(request.contentType, request.platform);
    if (!prompt) {
      throw new Error(
        `No active prompt found for contentType="${request.contentType}" platform="${request.platform}"`,
      );
    }

    // Auto-fetch business data if requested and not manually provided
    if (request.autoFetchBusinessData && !request.businessData) {
      try {
        request.businessData = await this.dataSyncService.getBusinessContext();
      } catch (e: any) {
        this.logger.warn(`Auto-fetch business data failed: ${e.message}`);
      }
    }

    // 2. Resolve hook — use provided hookId, or suggest one
    let hook: TrendingHook | null = null;
    if (request.hookId) {
      hook = await this.hookService.getHookById(request.hookId);
    } else {
      hook = await this.hookService.suggestHook(request.platform);
    }

    // 3. Enrich with performance learnings
    let additionalInstructions = request.additionalInstructions || '';
    try {
      const learningInsights = await this.learningEngine.enrichPromptWithLearnings(
        request.contentType,
        request.platform,
      );
      if (learningInsights) {
        additionalInstructions = additionalInstructions + learningInsights;
      }
    } catch (e: any) {
      this.logger.warn(`Failed to enrich with learnings: ${e.message}`);
    }

    // 4. Interpolate user prompt template — condense business data to save tokens
    let businessDataStr = 'No specific data available';
    if (request.businessData) {
      const bd = request.businessData;
      const parts: string[] = [];
      if (bd.total_orders) parts.push(`${bd.total_orders} orders`);
      if (bd.total_revenue) parts.push(`₹${bd.total_revenue} revenue`);
      if (bd.avg_order_value) parts.push(`₹${bd.avg_order_value} avg order`);
      if (bd.new_users) parts.push(`${bd.new_users} new users`);
      if (bd.top_stores?.length) parts.push(`Top stores: ${bd.top_stores.slice(0, 5).join(', ')}`);
      if (bd.top_products?.length) parts.push(`Top items: ${bd.top_products.slice(0, 5).join(', ')}`);
      if (bd.orders_by_module) {
        const modules = Object.entries(bd.orders_by_module).map(([k, v]) => `${k}: ${v}`).join(', ');
        if (modules) parts.push(`By module: ${modules}`);
      }
      businessDataStr = parts.join('. ') || 'No specific data available';
    }

    const templateVars: Record<string, string> = {
      hook: hook?.hookText || '',
      business_data: businessDataStr,
      tone: request.tone || 'engaging',
      language: request.language || 'English',
      additional: additionalInstructions,
      vertical: 'all',
    };
    const userPrompt = this.interpolateTemplate(prompt.userPromptTemplate, templateVars);

    // 4. Route to provider — vLLM first for all types, Claude as fallback
    const provider: ContentProvider = 'vllm';
    let result: { content: string; costInr: number };

    this.logger.log(
      `Generating ${request.contentType} for ${request.platform} via ${provider} (Claude fallback ${this.anthropic ? 'available' : 'unavailable'})`,
    );

    // Thinking mode decision: use for complex creative types when model has enough context
    // Qwen3.5-4B-AWQ (4096 ctx) — thinking eats ~2000 tokens, leaving too little for output
    // Only enable thinking for models with >8k context (check max_model_len from /v1/models)
    const isComplexType = ['reel_script', 'carousel'].includes(request.contentType);
    const modelContextLen = 4096; // TODO: fetch from vLLM /v1/models dynamically
    const estimatedPromptChars = prompt.systemPrompt.length + userPrompt.length;
    const estimatedPromptTokens = Math.ceil(estimatedPromptChars / 3.5);
    // Thinking needs ~2000 extra tokens for reasoning; only enable if model has room
    const useThinking = isComplexType && modelContextLen >= 8192 && estimatedPromptTokens < (modelContextLen / 4);

    this.logger.log(
      `Content type=${request.contentType} promptChars=${estimatedPromptChars} ` +
      `estTokens=${estimatedPromptTokens} thinking=${useThinking}`,
    );

    result = await this.callVllm(prompt.systemPrompt, userPrompt, useThinking);

    // 5. Record hook usage if one was used
    if (hook) {
      await this.hookService.recordUsage(hook.id);
    }

    // 6. Parse structured JSON from LLM response
    const contentJson = this.parseJsonFromResponse(result.content);

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `Generation complete: provider=${provider} type=${request.contentType} ` +
        `duration=${durationMs}ms cost=₹${result.costInr.toFixed(4)}`,
    );

    return {
      contentJson,
      rawText: result.content,
      provider,
      costInr: result.costInr,
      durationMs,
      promptId: prompt.id,
      hookId: hook?.id || null,
    };
  }

  private async callClaude(
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<{ content: string; costInr: number }> {
    if (!this.anthropic) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    // Sonnet pricing: ~$3/M input tokens, ~$15/M output tokens → convert to INR (*85)
    const inputCostUsd = (response.usage.input_tokens / 1_000_000) * 3;
    const outputCostUsd = (response.usage.output_tokens / 1_000_000) * 15;
    const costInr = (inputCostUsd + outputCostUsd) * 85;

    this.logger.debug(
      `Claude response: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, cost ₹${costInr.toFixed(4)}`,
    );

    return { content, costInr };
  }

  private async callVllm(
    systemPrompt: string,
    userPrompt: string,
    enableThinking = false,
  ): Promise<{ content: string; costInr: number }> {
    try {
      const vllmUrl = this.config.get('VLLM_CHAT_ENDPOINT') || 'http://localhost:8002/v1/chat/completions';
      const vllmModel = this.config.get('VLLM_MODEL') || 'Qwen/Qwen3.5-4B';

      // Force non-thinking: prepend JSON-only instruction to system prompt
      const finalSystemPrompt = enableThinking
        ? systemPrompt
        : `IMPORTANT: Output ONLY valid JSON. No thinking, no explanation, no markdown fences. Start your response with { and end with }.\n\n${systemPrompt}`;

      this.logger.log(
        `vLLM call: model=${vllmModel} thinking=${enableThinking} ` +
        `sysLen=${finalSystemPrompt.length} userLen=${userPrompt.length} ` +
        `totalChars=${finalSystemPrompt.length + userPrompt.length}`,
      );

      const response = await fetch(vllmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: vllmModel,
          messages: [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: enableThinking ? 0.6 : 0.7,
          max_tokens: enableThinking ? 3000 : 2048,
          chat_template_kwargs: { enable_thinking: enableThinking },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`vLLM API error ${response.status}: ${errBody}`);
      }

      const data = await response.json();
      let content = data.choices?.[0]?.message?.content || '';

      // Strip thinking process if model outputs it (Qwen3.5 may think even with enable_thinking=false)
      content = this.stripThinkingOutput(content);

      return { content, costInr: 0 };
    } catch (error: any) {
      if (this.anthropic) {
        this.logger.warn(
          `vLLM call failed (${error.message}), falling back to Claude`,
        );
        return this.callClaude(systemPrompt, userPrompt, 2048);
      }
      this.logger.error(
        `vLLM call failed and ANTHROPIC_API_KEY not set — no fallback available: ${error.message}`,
      );
      throw new Error(`Content generation failed: vLLM unavailable and no Claude fallback configured`);
    }
  }

  private interpolateTemplate(
    template: string,
    vars: Record<string, string>,
  ): string {
    // Handle {{#if variable}}...{{/if}} conditional blocks
    let result = template.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_match, varName: string, blockContent: string) => {
        const value = vars[varName];
        return value ? blockContent : '';
      },
    );

    // Replace {{variable}} placeholders
    result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
      return vars[varName] !== undefined ? vars[varName] : '';
    });

    return result;
  }

  private stripThinkingOutput(content: string): string {
    // Qwen3.5 reasoning models may output "Thinking Process:" or "<think>...</think>" blocks
    // Strip these and extract the actual content (JSON)

    // Strip <think>...</think> blocks
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // If content starts with "Thinking Process:" — extract JSON after the thinking
    if (content.startsWith('Thinking')) {
      // Try to find JSON in a code block after thinking
      const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (fenceMatch) {
        return fenceMatch[1].trim();
      }
      // Try to find first { after thinking
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        return content.substring(firstBrace, lastBrace + 1);
      }
    }

    return content;
  }

  private parseJsonFromResponse(raw: string): Record<string, any> {
    // Try extracting from markdown code fences
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through to next strategy
      }
    }

    // Try finding first { to last }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.substring(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback: return raw text wrapped
    return { raw };
  }
}
