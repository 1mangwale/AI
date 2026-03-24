import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VllmService } from './vllm.service';
import { OllamaService } from './ollama.service';
import { CloudLlmService } from './cloud-llm.service';
import { LlmUsageTrackingService } from './llm-usage-tracking.service';
import { ModelRegistryService } from './model-registry.service';
import { SmartModelRouterService, RoutingContext } from './smart-model-router.service';
import { ChatCompletionDto } from '../dto/chat-completion.dto';
import { ChatCompletionResultDto } from '../dto/chat-completion-result.dto';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly vllmService: VllmService,
    private readonly ollamaService: OllamaService,
    private readonly cloudLlmService: CloudLlmService,
    private readonly usageTracking: LlmUsageTrackingService,
    private readonly modelRegistry: ModelRegistryService,
    @Optional() private readonly smartRouter?: SmartModelRouterService,
  ) {}

  async chat(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    const startTime = Date.now();
    let result: ChatCompletionResultDto;
    let usedProvider = 'unknown';
    let usedModel = dto.model || 'unknown';
    let status: 'success' | 'error' | 'timeout' = 'success';
    let errorMessage: string | undefined;

    try {
      const provider = dto.provider || this.config.get('DEFAULT_CLOUD_PROVIDER') || 'auto';
      const enabledProviders = (this.config.get('ENABLED_LLM_PROVIDERS') || 'groq,openrouter').split(',');

      // Provider selection strategy
      // NOTE: Ollama is NOT available - using vLLM with Qwen2.5-7B as primary local LLM
      if (provider === 'vllm' || provider === 'auto') {
        this.logger.log(`Attempting vLLM (local ${this.config.get('VLLM_MODEL', 'Qwen')})`);
        const attemptStart = Date.now();
        try {
          result = await this.vllmService.chat(dto);
          usedProvider = 'vllm';
          usedModel = result.model || usedModel;
          await this.trackUsage(result, usedProvider, usedModel, startTime, dto);
          return result;
        } catch (error) {
          this.logger.warn(`vLLM failed: ${error.message}`);
          await this.trackAttemptFailure({
            provider: 'vllm',
            modelId: dto.model || usedModel,
            startTimeMs: attemptStart,
            dto,
            error,
          });
          if (provider === 'vllm') throw error;
        }
      }
      
      // Ollama provider removed - not available (using vLLM with Qwen instead)
      if (provider === 'ollama') {
        this.logger.warn('Ollama provider requested but not available - using vLLM instead');
        // Fall through to vLLM or cloud providers
      }

      // Cloud providers in priority order
      if ((provider === 'openrouter' || provider === 'auto') && enabledProviders.includes('openrouter')) {
        this.logger.log('Attempting OpenRouter (cloud)');
        const attemptStart = Date.now();
        try {
          result = await this.cloudLlmService.chatOpenRouter(dto);
          usedProvider = 'openrouter';
          usedModel = result.model || usedModel;
          await this.trackUsage(result, usedProvider, usedModel, startTime, dto);
          return result;
        } catch (error) {
          this.logger.warn(`OpenRouter failed: ${error.message}`);
          await this.trackAttemptFailure({
            provider: 'openrouter',
            modelId: dto.model || usedModel,
            startTimeMs: attemptStart,
            dto,
            error,
          });
          if (provider === 'openrouter') throw error;
        }
      }

      if ((provider === 'groq' || provider === 'auto') && enabledProviders.includes('groq')) {
        this.logger.log('Attempting Groq (cloud)');
        const attemptStart = Date.now();
        try {
          result = await this.cloudLlmService.chatGroq(dto);
          usedProvider = 'groq';
          usedModel = result.model || usedModel;
          await this.trackUsage(result, usedProvider, usedModel, startTime, dto);
          return result;
        } catch (error) {
          this.logger.warn(`Groq failed: ${error.message}`);
          await this.trackAttemptFailure({
            provider: 'groq',
            modelId: dto.model || usedModel,
            startTimeMs: attemptStart,
            dto,
            error,
          });
          if (provider === 'groq') throw error;
        }
      }

      if ((provider === 'openai' || provider === 'auto') && enabledProviders.includes('openai')) {
        this.logger.log('Attempting OpenAI (cloud)');
        const attemptStart = Date.now();
        try {
          result = await this.cloudLlmService.chatOpenAI(dto);
          usedProvider = 'openai';
          usedModel = result.model || usedModel;
          await this.trackUsage(result, usedProvider, usedModel, startTime, dto);
          return result;
        } catch (error) {
          this.logger.warn(`OpenAI failed: ${error.message}`);
          await this.trackAttemptFailure({
            provider: 'openai',
            modelId: dto.model || usedModel,
            startTimeMs: attemptStart,
            dto,
            error,
          });
          if (provider === 'openai') throw error;
        }
      }

      if (provider === 'huggingface' && enabledProviders.includes('huggingface')) {
        this.logger.log('Attempting HuggingFace Inference API');
        const attemptStart = Date.now();
        result = await this.cloudLlmService.chatHuggingFace(dto);
        usedProvider = 'huggingface';
        usedModel = result.model || usedModel;
        await this.trackUsage(result, usedProvider, usedModel, startTime, dto);
        return result;
      }

      throw new Error('No LLM provider available');
    } catch (error) {
      this.logger.error(`All LLM providers failed: ${error.message}`, error.stack);
      status = 'error';
      errorMessage = error.message;

      // Track the error
      await this.usageTracking.trackUsage({
        modelId: usedModel,
        modelName: usedModel,
        provider: usedProvider,
        userId: (dto as any).userId,
        sessionId: (dto as any).sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - startTime,
        cost: 0,
        purpose: (dto as any).purpose,
        channel: (dto as any).channel,
        status,
        errorMessage: errorMessage,
      });

      // Fallback response
      return {
        id: `fallback-${Date.now()}`,
        model: 'fallback',
        provider: 'fallback',
        content: 'I apologize, but I am temporarily unable to process your request. Please try again later.',
        finishReason: 'error',
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Streaming chat completion
   * For now, only supports vLLM provider
   */
  async chatStream(dto: ChatCompletionDto): Promise<any> {
    // Force vLLM provider for streaming
    const provider = dto.provider || 'vllm';
    
    if (provider === 'vllm' || provider === 'auto') {
      this.logger.log('Streaming with vLLM (local)');
      try {
        return await this.vllmService.chatStream(dto);
      } catch (error) {
        this.logger.error(`vLLM streaming failed: ${error.message}`, error.stack);
        throw error;
      }
    }
    
    // Cloud provider streaming not yet implemented
    throw new Error(`Streaming not supported for provider: ${provider}`);
  }

  private async trackUsage(
    result: ChatCompletionResultDto,
    provider: string,
    model_id: string,
    startTime: number,
    dto: ChatCompletionDto,
  ): Promise<void> {
    try {
      // Calculate cost from model registry
      const modelInfo = await this.modelRegistry.getModelInfo(model_id);
      const cost = this.calculateCost(result.usage, modelInfo);

      await this.usageTracking.trackUsage({
        modelId: model_id,
        modelName: result.model,
        provider,
        userId: (dto as any).userId,
        sessionId: (dto as any).sessionId,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        latencyMs: Date.now() - startTime,
        cost,
        purpose: (dto as any).purpose || 'chat',
        channel: (dto as any).channel,
        status: 'success',
      });
    } catch (error) {
      this.logger.error(`Failed to track usage: ${error.message}`);
      // Don't throw - tracking shouldn't break the main flow
    }
  }

  private async trackAttemptFailure(params: {
    provider: string;
    modelId: string;
    startTimeMs: number;
    dto: ChatCompletionDto;
    error: any;
  }): Promise<void> {
    try {
      await this.usageTracking.trackUsage({
        modelId: params.modelId,
        modelName: params.modelId,
        provider: params.provider,
        userId: (params.dto as any).userId,
        sessionId: (params.dto as any).sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - params.startTimeMs,
        cost: 0,
        purpose: (params.dto as any).purpose,
        channel: (params.dto as any).channel,
        status: 'error',
        errorMessage: params.error?.message || String(params.error),
        metadata: {
          attempt: true,
        },
      });
    } catch {
      // Usage tracking should never break provider fallback
    }
  }

  private calculateCost(usage: any, modelInfo: any): number {
    if (!modelInfo || modelInfo.pricing?.free) {
      return 0;
    }

    const inputCost = modelInfo.pricing?.prompt || 0;
    const outputCost = modelInfo.pricing?.completion || 0;

    // Pricing is usually per 1M tokens
    return (
      (usage.promptTokens / 1_000_000) * inputCost +
      (usage.completionTokens / 1_000_000) * outputCost
    );
  }

  async getAvailableModels(): Promise<any[]> {
    const models: any[] = [];

    // Check vLLM models
    try {
      const vllmModels = await this.vllmService.getModels();
      models.push(...vllmModels);
    } catch (error) {
      this.logger.debug('vLLM not available');
    }

    // Add cloud models if API keys exist
    if (this.config.get('OPENAI_API_KEY')) {
      models.push(
        { name: 'gpt-4', provider: 'openai', type: 'cloud', cost: 'paid' },
        { name: 'gpt-3.5-turbo', provider: 'openai', type: 'cloud', cost: 'paid' },
      );
    }

    if (this.config.get('GROQ_API_KEY')) {
      models.push(
        { name: 'llama-3.1-8b-instant', provider: 'groq', type: 'cloud', cost: 'free' },
        { name: 'llama3-70b-8192', provider: 'groq', type: 'cloud', cost: 'free' },
        { name: 'mixtral-8x7b-32768', provider: 'groq', type: 'cloud', cost: 'free' },
      );
    }

    if (this.config.get('OPENROUTER_API_KEY')) {
      models.push(
        { name: 'meta-llama/llama-3.2-3b-instruct:free', provider: 'openrouter', type: 'cloud', cost: 'free' },
        { name: 'google/gemma-2-9b-it:free', provider: 'openrouter', type: 'cloud', cost: 'free' },
        { name: 'microsoft/phi-3-mini-128k-instruct:free', provider: 'openrouter', type: 'cloud', cost: 'free' },
        { name: 'meta-llama/llama-3.1-70b-instruct', provider: 'openrouter', type: 'cloud', cost: 'paid' },
        { name: 'anthropic/claude-3-opus', provider: 'openrouter', type: 'cloud', cost: 'paid' },
      );
    }

    return models;
  }

  async estimateCost(tokens: number, model: string): Promise<number> {
    // Pricing per 1M tokens (approximate)
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4': { input: 30, output: 60 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
      'llama3-70b-8192': { input: 0.59, output: 0.79 },
      'mixtral-8x7b-32768': { input: 0.24, output: 0.24 },
      'qwen8b': { input: 0, output: 0 }, // Local - free
    };

    const modelPricing = pricing[model] || { input: 0, output: 0 };
    
    // Assume 50/50 input/output split
    const inputTokens = tokens / 2;
    const outputTokens = tokens / 2;

    return (
      (inputTokens / 1_000_000) * modelPricing.input +
      (outputTokens / 1_000_000) * modelPricing.output
    );
  }
}
