import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, IsArray, IsBoolean } from 'class-validator';

export class ChatCompletionDto {
  @IsArray()
  @IsNotEmpty()
  messages: ChatMessage[];

  @IsOptional()
  @IsString()
  model?: string; // 'qwen8b', 'gpt-4', 'groq/llama3-70b'

  @IsOptional()
  @IsEnum(['vllm', 'openai', 'groq', 'huggingface', 'auto'])
  provider?: string = 'auto';

  @IsOptional()
  @IsNumber()
  temperature?: number = 0.7;

  @IsOptional()
  @IsNumber()
  maxTokens?: number = 2000;

  @IsOptional()
  @IsNumber()
  topP?: number = 0.9;

  @IsOptional()
  @IsBoolean()
  stream?: boolean = false;

  @IsOptional()
  functions?: FunctionDefinition[]; // Legacy format — use tools[] instead

  @IsOptional()
  tools?: ToolDefinition[]; // 2026 standard: tools API format

  @IsOptional()
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }; // Tool selection strategy

  @IsOptional()
  @IsString()
  userId?: string; // For tracking/analytics

  // vLLM Advanced Features
  @IsOptional()
  stop?: string | string[]; // Stop sequences

  @IsOptional()
  @IsNumber()
  topK?: number; // Top-K sampling (vLLM extra)

  @IsOptional()
  @IsNumber()
  repetitionPenalty?: number; // Repetition penalty (vLLM extra)

  @IsOptional()
  @IsNumber()
  presencePenalty?: number; // Presence penalty

  @IsOptional()
  @IsNumber()
  frequencyPenalty?: number; // Frequency penalty

  @IsOptional()
  guidedJson?: Record<string, any>; // JSON schema for guided decoding (vLLM extra)

  @IsOptional()
  guidedChoice?: string[]; // Choice constraint for guided decoding (vLLM extra)

  @IsOptional()
  guidedRegex?: string; // Regex pattern for guided decoding (vLLM extra)

  @IsOptional()
  responseFormat?: { type: 'json_object' | 'text' }; // JSON mode

  @IsOptional()
  @IsBoolean()
  logprobs?: boolean; // Include logprobs in response

  @IsOptional()
  @IsNumber()
  topLogprobs?: number; // Number of top logprobs to return (0-20)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string | null;
  name?: string; // For function messages (legacy)
  tool_call_id?: string; // For tool result messages
}

/** Legacy format — prefer ToolDefinition */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/** 2026 standard tools API format */
export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}
