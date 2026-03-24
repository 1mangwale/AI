/**
 * Agent System Types
 * 
 * Core type definitions for LLM-powered agent system
 */

export enum AgentType {
  SEARCH = 'search',
  ORDER = 'order',
  COMPLAINTS = 'complaints',
  BOOKING = 'booking',
  FAQ = 'faq',
  VENDOR = 'vendor',   // B2B vendor/restaurant owner agent
  RIDER = 'rider',     // Delivery partner agent
  FLOW = 'flow',       // Flow-based agent (state machine)
  CUSTOM = 'custom',
}

/**
 * Module Types (aligned with MySQL database module_type column)
 * These map to multiple module IDs via module-id-mapping.ts
 */
export enum ModuleType {
  GROCERY = 'grocery',   // Module IDs: 1, 2, 17, 18
  FOOD = 'food',         // Module IDs: 4, 6, 11, 15
  PHARMACY = 'pharmacy', // Module ID: 8
  ECOM = 'ecom',         // Module IDs: 5, 7, 9, 12, 13, 16
  PARCEL = 'parcel',     // Module IDs: 3, 10, 14, 20
}

/**
 * Function definition in OpenAI format
 */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, FunctionParameter>;
    required?: string[];
  };
}

/** 2026 standard tools API format */
export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

export interface FunctionParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: FunctionParameter;
  properties?: Record<string, FunctionParameter>;
}

/**
 * Tool call from LLM (2026 standard)
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * Function call from LLM (legacy — use ToolCall instead)
 */
export interface FunctionCall {
  name: string;
  arguments: string; // JSON string
}

/**
 * LLM Message format
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string | null;
  name?: string; // For function messages (legacy)
  tool_call_id?: string; // For tool result messages
  tool_calls?: ToolCall[]; // For assistant messages with tool calls
  /** @deprecated Use tool_calls instead */
  function_call?: FunctionCall;
}

/**
 * Agent execution context
 */
export interface AgentContext {
  phoneNumber: string;
  module: ModuleType;
  moduleId?: number; // Database module ID (1-20) for precise module targeting
  zoneId?: number; // Zone ID for zone-specific filtering
  language: string;
  session: any;
  message: string;
  imageUrl?: string;
  intent?: string;
  entities?: Record<string, any>;
  confidence?: number;
  // Context for intent classification (helps LLM understand conversation state)
  activeModule?: string; // Current active module: 'food', 'ecommerce', 'parcel'
  activeFlow?: string; // Current flow ID: 'food_order_v1', 'ecommerce_order_v1'
  lastBotMessage?: string; // What the bot last said (for contextual understanding)
}

/**
 * Agent execution result
 */
export interface AgentResult {
  response: string;
  functionsCalled?: string[];
  executionTime: number;
  tokensUsed?: number;
  cached?: boolean;
  metadata?: Record<string, any>; // Additional metadata (e.g., flow info)
  buttons?: Array<{
    id?: string;
    label: string;
    value: string;
    type?: string;
    metadata?: any;
  }>; // Quick reply buttons for user interaction
  cards?: Array<any>; // Cards for rich content display
}

/**
 * Tool/Function executor interface
 */
export interface FunctionExecutor {
  name: string;
  execute(args: Record<string, any>, context: AgentContext): Promise<any>;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  id: string;
  type: AgentType;
  name: string;
  description: string;
  modules: ModuleType[];
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  functions: FunctionDefinition[];
  enabled: boolean;
}

/**
 * Intent routing result
 */
export interface RoutingResult {
  agentId: string;
  agentType: AgentType;
  intent: string;
  entities: Record<string, any>;
  confidence: number;
  cached?: boolean;
  moduleId?: number; // Database module ID for precise targeting
  zoneId?: number; // Zone ID for zone-specific filtering
  raw?: Record<string, any>; // Raw classification data (clarification options, reasoning, etc.)
}
