import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

/**
 * Asset Generation Executor
 *
 * Generates marketing assets (images via DALL-E 3, ad copy via local vLLM).
 */
@Injectable()
export class AssetGenerationExecutor implements ActionExecutor {
  readonly name = 'asset_generation';
  private readonly logger = new Logger(AssetGenerationExecutor.name);

  constructor(private readonly config: ConfigService) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;
    this.logger.log(`Asset generation action: ${action}`);

    try {
      if (action === 'generate_image') {
        return await this.generateImage(config);
      }

      if (action === 'generate_copy') {
        return await this.generateCopy(config);
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (error: any) {
      this.logger.error(`Asset generation failed: ${error.message}`, error.stack);
      return { success: false, error: error.message };
    }
  }

  private async generateImage(config: Record<string, any>): Promise<ActionExecutionResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const prompt = config.prompt as string || 'A professional food delivery advertisement';
    const size = config.size as string || '1024x1024';

    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not set, returning placeholder image');
      return {
        success: true,
        output: { url: 'https://placeholder.com/ad-image.png', provider: 'placeholder' },
        event: 'asset_generated',
      };
    }

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, size, n: 1 }),
    });

    const body = await res.json();
    if (!res.ok) {
      return { success: false, error: body.error?.message || 'DALL-E request failed' };
    }

    return {
      success: true,
      output: { url: body.data[0].url, provider: 'dalle3' },
      event: 'asset_generated',
    };
  }

  private async generateCopy(config: Record<string, any>): Promise<ActionExecutionResult> {
    const product = config.product || 'our product';
    const tone = config.tone || 'friendly';
    const platform = config.platform || 'WhatsApp';

    const res = await fetch('http://localhost:8002/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        messages: [
          {
            role: 'user',
            content: `Generate a short ad copy for ${product} in a ${tone} tone for ${platform}. Return JSON with "headline" and "body" fields only.`,
          },
        ],
        temperature: 0.8,
        max_tokens: 300,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    let headline = '';
    let body = '';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        headline = parsed.headline || '';
        body = parsed.body || '';
      }
    } catch {
      // Fallback: use raw text as body
      headline = text.split('\n')[0] || product;
      body = text;
    }

    return {
      success: true,
      output: { headline, body, provider: 'vllm' },
      event: 'copy_generated',
    };
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
