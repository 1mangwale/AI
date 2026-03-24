export class ChatCompletionResultDto {
  id: string;
  model: string;
  provider: 'vllm' | 'ollama' | 'openai' | 'groq' | 'openrouter' | 'huggingface' | 'together' | 'deepseek' | 'gemini' | 'anthropic' | 'grok' | 'fallback';
  content: string;
  finishReason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'error';

  // Usage statistics
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  // Performance
  processingTimeMs: number;

  // Tool calls (2026 standard — preferred)
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string; // JSON string
    };
  }>;

  // Legacy function calling (backward compat — will be removed)
  functionCall?: {
    name: string;
    arguments: string | Record<string, any>;
  };

  // Logprobs (if requested)
  logprobs?: any;

  // Cost tracking
  estimatedCost?: number; // In USD
}
