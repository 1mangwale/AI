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

    // 4. Interpolate user prompt template
    const templateVars: Record<string, string> = {
      hook: hook?.hookText || '',
      business_data: request.businessData
        ? JSON.stringify(request.businessData)
        : 'No specific data available',
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

    result = await this.callVllm(prompt.systemPrompt, userPrompt);

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
  ): Promise<{ content: string; costInr: number }> {
    try {
      const response = await fetch('http://localhost:8002/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`vLLM API error ${response.status}: ${errBody}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

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
