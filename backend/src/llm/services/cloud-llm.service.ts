import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatCompletionDto } from '../dto/chat-completion.dto';
import { ChatCompletionResultDto } from '../dto/chat-completion-result.dto';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Model mapping for cloud providers
 * Maps local/vLLM models to equivalent cloud models
 */
const GROQ_MODEL_MAPPING: Record<string, string> = {
  // Qwen models -> use Llama 3.1
  'qwen/qwen2.5-7b-instruct-awq': 'llama-3.1-8b-instant',
  'qwen/qwen2.5-7b-instruct': 'llama-3.1-8b-instant',
  'qwen2.5-7b-instruct-awq': 'llama-3.1-8b-instant',
  // Default fast model for extraction tasks
  'default': 'llama-3.1-8b-instant',
};

const OPENROUTER_MODEL_MAPPING: Record<string, string> = {
  // Qwen models
  'qwen/qwen2.5-7b-instruct-awq': 'qwen/qwen-2.5-7b-instruct',
  'qwen/qwen2.5-7b-instruct': 'qwen/qwen-2.5-7b-instruct',
  'qwen2.5-7b-instruct-awq': 'qwen/qwen-2.5-7b-instruct',
  // Default
  'default': 'meta-llama/llama-3.1-8b-instruct:free',
};

const GEMINI_MODEL_MAPPING: Record<string, string> = {
  'default': 'gemini-2.0-flash',
  'quality': 'gemini-1.5-pro',
};

const CLAUDE_MODEL_MAPPING: Record<string, string> = {
  'default': 'claude-sonnet-4-20250514',
  'fast': 'claude-haiku-4-5-20251001',
};

const DEEPSEEK_MODEL_MAPPING: Record<string, string> = {
  'default': 'deepseek-chat',
  'reasoning': 'deepseek-reasoner',
};

const GROK_MODEL_MAPPING: Record<string, string> = {
  'default': 'grok-3-mini',
  'quality': 'grok-3',
};

@Injectable()
export class CloudLlmService {
  private readonly logger = new Logger(CloudLlmService.name);
  private openaiClient?: OpenAI;
  private groqClient?: OpenAI;
  private openrouterClient?: OpenAI;
  private geminiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private deepseekClient?: OpenAI;
  private grokClient?: OpenAI;

  constructor(private readonly config: ConfigService) {
    // Initialize OpenAI client
    const openaiKey = this.config.get('OPENAI_API_KEY');
    if (openaiKey) {
      this.openaiClient = new OpenAI({ apiKey: openaiKey });
    }

    // Initialize Groq client (uses OpenAI SDK)
    const groqKey = this.config.get('GROQ_API_KEY');
    if (groqKey) {
      this.groqClient = new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
    }

    // Initialize OpenRouter client (uses OpenAI SDK)
    const openrouterKey = this.config.get('OPENROUTER_API_KEY');
    if (openrouterKey) {
      this.openrouterClient = new OpenAI({
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    }

    // Gemini (uses OpenAI-compatible API)
    const geminiKey = this.config.get('GEMINI_API_KEY');
    if (geminiKey) {
      this.geminiClient = new OpenAI({
        apiKey: geminiKey,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      });
    }

    // Anthropic Claude (native SDK)
    const anthropicKey = this.config.get('ANTHROPIC_API_KEY');
    if (anthropicKey) {
      this.anthropicClient = new Anthropic({ apiKey: anthropicKey });
    }

    // DeepSeek (uses OpenAI-compatible API)
    const deepseekKey = this.config.get('DEEPSEEK_API_KEY');
    if (deepseekKey) {
      this.deepseekClient = new OpenAI({
        apiKey: deepseekKey,
        baseURL: 'https://api.deepseek.com/v1',
      });
    }

    // xAI Grok (uses OpenAI-compatible API)
    const grokKey = this.config.get('XAI_API_KEY');
    if (grokKey) {
      this.grokClient = new OpenAI({
        apiKey: grokKey,
        baseURL: 'https://api.x.ai/v1',
      });
    }
  }

  /**
   * Map a model ID to Groq-compatible model
   */
  private mapToGroqModel(model?: string): string {
    if (!model) return GROQ_MODEL_MAPPING['default'];
    const lowerModel = model.toLowerCase();
    return GROQ_MODEL_MAPPING[lowerModel] || GROQ_MODEL_MAPPING['default'];
  }

  /**
   * Map a model ID to OpenRouter-compatible model
   */
  private mapToOpenRouterModel(model?: string): string {
    if (!model) return OPENROUTER_MODEL_MAPPING['default'];
    const lowerModel = model.toLowerCase();
    return OPENROUTER_MODEL_MAPPING[lowerModel] || OPENROUTER_MODEL_MAPPING['default'];
  }

  /**
   * Build tools params for OpenAI-compatible providers
   */
  private buildToolsParams(dto: ChatCompletionDto): Record<string, any> {
    const params: Record<string, any> = {};
    if (dto.tools && dto.tools.length > 0) {
      params.tools = dto.tools;
      params.tool_choice = dto.toolChoice || 'auto';
    } else if (dto.functions && dto.functions.length > 0) {
      // Auto-convert legacy functions to tools format
      params.tools = dto.functions.map(fn => ({ type: 'function', function: fn }));
      params.tool_choice = 'auto';
    }
    return params;
  }

  /**
   * Extract tool calls from OpenAI-compatible response choice
   */
  private extractToolCalls(choice: any): { toolCalls?: ChatCompletionResultDto['toolCalls']; functionCall?: ChatCompletionResultDto['functionCall']; finishReason: string } {
    const result: any = { finishReason: choice.finish_reason || 'stop' };

    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
      result.functionCall = {
        name: result.toolCalls[0].function.name,
        arguments: result.toolCalls[0].function.arguments,
      };
      result.finishReason = 'tool_calls';
    }

    return result;
  }

  async chatOpenAI(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.openaiClient) {
      throw new Error('OpenAI API key not configured');
    }

    const startTime = Date.now();

    try {
      const completion = await this.openaiClient.chat.completions.create({
        model: dto.model || 'gpt-3.5-turbo',
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        top_p: dto.topP,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'openai',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateOpenAICost(
          completion.usage?.total_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`OpenAI chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatGroq(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.groqClient) {
      throw new Error('Groq API key not configured');
    }

    const startTime = Date.now();
    const mappedModel = this.mapToGroqModel(dto.model);
    
    this.logger.debug(`Groq model mapping: ${dto.model} → ${mappedModel}`);

    try {
      const completion = await this.groqClient.chat.completions.create({
        model: mappedModel,
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'groq',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateGroqCost(
          completion.usage?.prompt_tokens || 0,
          completion.usage?.completion_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`Groq chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatOpenRouter(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.openrouterClient) {
      throw new Error('OpenRouter API key not configured');
    }

    const startTime = Date.now();
    const mappedModel = this.mapToOpenRouterModel(dto.model);
    
    this.logger.debug(`OpenRouter model mapping: ${dto.model} → ${mappedModel}`);

    try {
      const completion = await this.openrouterClient.chat.completions.create({
        model: mappedModel,
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'openrouter',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateOpenRouterCost(
          completion.usage?.prompt_tokens || 0,
          completion.usage?.completion_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`OpenRouter chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatHuggingFace(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    // TODO: Implement HuggingFace Inference API
    throw new Error('HuggingFace not yet implemented');
  }

  async chatGemini(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.geminiClient) {
      throw new Error('Gemini API key not configured');
    }

    const startTime = Date.now();
    const mappedModel = this.mapToGeminiModel(dto.model);

    this.logger.debug(`Gemini model mapping: ${dto.model} → ${mappedModel}`);

    try {
      const completion = await this.geminiClient.chat.completions.create({
        model: mappedModel,
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'gemini',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateGeminiCost(
          completion.usage?.prompt_tokens || 0,
          completion.usage?.completion_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`Gemini chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatClaude(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic API key not configured');
    }

    const startTime = Date.now();
    const model = CLAUDE_MODEL_MAPPING[dto.model?.toLowerCase() || ''] || CLAUDE_MODEL_MAPPING['default'];

    this.logger.debug(`Claude model mapping: ${dto.model} → ${model}`);

    try {
      // Convert messages format: separate system from user/assistant
      const systemMessage = dto.messages.find(m => m.role === 'system')?.content || '';
      const messages = dto.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const response = await this.anthropicClient.messages.create({
        model,
        max_tokens: dto.maxTokens || 4096,
        system: systemMessage,
        messages,
        temperature: dto.temperature,
      });

      const textBlock = response.content.find(c => c.type === 'text');
      const content = textBlock && textBlock.type === 'text' ? textBlock.text : '';

      return {
        id: response.id,
        model: response.model,
        provider: 'anthropic',
        content,
        finishReason: response.stop_reason as any,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateClaudeCost(
          response.usage.input_tokens,
          response.usage.output_tokens,
          response.model,
        ),
      };
    } catch (error) {
      this.logger.error(`Claude chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatDeepSeek(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.deepseekClient) {
      throw new Error('DeepSeek API key not configured');
    }

    const startTime = Date.now();
    const mappedModel = this.mapToDeepSeekModel(dto.model);

    this.logger.debug(`DeepSeek model mapping: ${dto.model} → ${mappedModel}`);

    try {
      const completion = await this.deepseekClient.chat.completions.create({
        model: mappedModel,
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'deepseek',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateDeepSeekCost(
          completion.usage?.prompt_tokens || 0,
          completion.usage?.completion_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`DeepSeek chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async chatGrok(dto: ChatCompletionDto): Promise<ChatCompletionResultDto> {
    if (!this.grokClient) {
      throw new Error('Grok API key not configured');
    }

    const startTime = Date.now();
    const mappedModel = this.mapToGrokModel(dto.model);

    this.logger.debug(`Grok model mapping: ${dto.model} → ${mappedModel}`);

    try {
      const completion = await this.grokClient.chat.completions.create({
        model: mappedModel,
        messages: dto.messages as any,
        temperature: dto.temperature,
        max_tokens: dto.maxTokens,
        ...this.buildToolsParams(dto),
      });

      const choice = completion.choices[0];
      const toolInfo = this.extractToolCalls(choice);

      return {
        id: completion.id,
        model: completion.model,
        provider: 'grok',
        content: choice.message?.content || '',
        finishReason: toolInfo.finishReason as any,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
        processingTimeMs: Date.now() - startTime,
        estimatedCost: this.calculateGrokCost(
          completion.usage?.prompt_tokens || 0,
          completion.usage?.completion_tokens || 0,
          completion.model,
        ),
        ...toolInfo.toolCalls ? { toolCalls: toolInfo.toolCalls, functionCall: toolInfo.functionCall } : {},
      };
    } catch (error) {
      this.logger.error(`Grok chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private calculateOpenAICost(tokens: number, model: string): number {
    const pricing: Record<string, number> = {
      'gpt-4': 0.00003, // per 1K tokens (average)
      'gpt-3.5-turbo': 0.000001, // per 1K tokens (average)
    };

    const rate = pricing[model] || 0.000001;
    return (tokens / 1000) * rate;
  }

  private calculateGroqCost(
    promptTokens: number,
    completionTokens: number,
    model: string,
  ): number {
    // Groq pricing (per 1M tokens)
    const pricing: Record<string, { input: number; output: number }> = {
      'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
      'llama3-70b-8192': { input: 0.59, output: 0.79 },
      'mixtral-8x7b-32768': { input: 0.24, output: 0.24 },
    };

    const rate = pricing[model] || { input: 0.05, output: 0.08 };

    return (
      (promptTokens / 1_000_000) * rate.input +
      (completionTokens / 1_000_000) * rate.output
    );
  }

  private calculateOpenRouterCost(
    promptTokens: number,
    completionTokens: number,
    model: string,
  ): number {
    // OpenRouter free models = $0
    if (model.includes(':free')) {
      return 0;
    }

    // Paid models pricing (per 1M tokens) - varies by model
    const pricing: Record<string, { input: number; output: number }> = {
      'meta-llama/llama-3.1-70b-instruct': { input: 0.52, output: 0.75 },
      'anthropic/claude-3-opus': { input: 15, output: 75 },
      'openai/gpt-4-turbo': { input: 10, output: 30 },
    };

    const rate = pricing[model] || { input: 0.1, output: 0.3 };

    return (
      (promptTokens / 1_000_000) * rate.input +
      (completionTokens / 1_000_000) * rate.output
    );
  }

  private mapToGeminiModel(model?: string): string {
    if (!model) return GEMINI_MODEL_MAPPING['default'];
    return GEMINI_MODEL_MAPPING[model.toLowerCase()] || GEMINI_MODEL_MAPPING['default'];
  }

  private mapToDeepSeekModel(model?: string): string {
    if (!model) return DEEPSEEK_MODEL_MAPPING['default'];
    return DEEPSEEK_MODEL_MAPPING[model.toLowerCase()] || DEEPSEEK_MODEL_MAPPING['default'];
  }

  private mapToGrokModel(model?: string): string {
    if (!model) return GROK_MODEL_MAPPING['default'];
    return GROK_MODEL_MAPPING[model.toLowerCase()] || GROK_MODEL_MAPPING['default'];
  }

  private calculateGeminiCost(promptTokens: number, completionTokens: number, model: string): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'gemini-2.0-flash': { input: 0.10, output: 0.40 },
      'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    };
    const rate = pricing[model] || { input: 0.10, output: 0.40 };
    return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  }

  private calculateClaudeCost(promptTokens: number, completionTokens: number, model: string): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    };
    const rate = pricing[model] || { input: 3.00, output: 15.00 };
    return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  }

  private calculateDeepSeekCost(promptTokens: number, completionTokens: number, model: string): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'deepseek-chat': { input: 0.14, output: 0.28 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 },
    };
    const rate = pricing[model] || { input: 0.14, output: 0.28 };
    return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  }

  private calculateGrokCost(promptTokens: number, completionTokens: number, model: string): number {
    const pricing: Record<string, { input: number; output: number }> = {
      'grok-3-mini': { input: 0.30, output: 0.50 },
      'grok-3': { input: 3.00, output: 15.00 },
    };
    const rate = pricing[model] || { input: 0.30, output: 0.50 };
    return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  }
}
