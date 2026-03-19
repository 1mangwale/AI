import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { LlmService } from '../../llm/services/llm.service';
import { NluService } from '../../nlu/services/nlu.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Tool definition for agentic execution
 */
interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * Tool execution result
 */
interface ToolResult {
  tool: string;
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * Agent Executor
 * 
 * LLM-powered agent that dynamically decides which tools to call.
 * This is the core of agentic AI - the LLM orchestrates the entire pipeline
 * by reasoning about what tools to use and in what order.
 * 
 * Implements ReAct (Reasoning + Acting) pattern:
 * 1. Thought: LLM reasons about what to do
 * 2. Action: LLM decides which tool to call
 * 3. Observation: Tool result is fed back to LLM
 * 4. Repeat until task is complete
 * 
 * Usage in flows:
 * ```typescript
 * {
 *   executor: 'agent',
 *   config: {
 *     task: 'Process user food order request',
 *     tools: ['classify_intent', 'extract_entities', 'search_items', 'add_to_cart'],
 *     maxIterations: 5,
 *     context: {
 *       user_id: '{{_system.userId}}',
 *       phone: '{{_system.phoneNumber}}'
 *     }
 *   },
 *   output: 'agent_result'
 * }
 * ```
 */
@Injectable()
export class AgentExecutor implements ActionExecutor {
  readonly name = 'agent';
  private readonly logger = new Logger(AgentExecutor.name);
  private readonly nerUrl: string;
  private readonly searchUrl: string;

  // Available tools registry
  private readonly toolRegistry: Map<string, AgentTool> = new Map();

  constructor(
    private readonly llmService: LlmService,
    private readonly nluService: NluService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.nerUrl = this.configService.get('NER_URL', 'http://localhost:7011');
    this.searchUrl = this.configService.get('SEARCH_API_URL');
    
    // Register available tools
    this.registerTools();
  }

  /**
   * Register all available tools for the agent
   */
  private registerTools(): void {
    // Intent Classification
    this.toolRegistry.set('classify_intent', {
      name: 'classify_intent',
      description: 'Classify the user message intent (place_order, track_order, cancel, help, etc.). Use this first to understand what the user wants.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The user message to classify' },
        },
        required: ['text'],
      },
    });

    // Entity Extraction
    this.toolRegistry.set('extract_entities', {
      name: 'extract_entities',
      description: 'Extract entities like FOOD items, STORE names, QTY (quantities), LOC (locations), and preferences from text. Returns food_items with qty pairing.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to extract entities from' },
        },
        required: ['text'],
      },
    });

    // Search Items
    this.toolRegistry.set('search_items', {
      name: 'search_items',
      description: 'Search for food items or products. Returns matching items with prices, ratings, and availability.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (food name, cuisine, etc.)' },
          store_id: { type: 'string', description: 'Optional: limit search to specific store' },
          category: { type: 'string', description: 'Optional: filter by category (veg, non-veg, etc.)' },
        },
        required: ['query'],
      },
    });

    // Search Stores
    this.toolRegistry.set('search_stores', {
      name: 'search_stores',
      description: 'Search for restaurants/stores by name or cuisine type.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Store name or cuisine type' },
          location: { type: 'string', description: 'Optional: area/locality for filtering' },
        },
        required: ['query'],
      },
    });

    // Get User Preferences
    this.toolRegistry.set('get_user_preferences', {
      name: 'get_user_preferences',
      description: 'Get user favorites, dietary preferences, order history, and saved addresses.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'User ID' },
          include: { type: 'string', description: 'What to include: favorites, dietary, addresses, history' },
        },
        required: ['user_id'],
      },
    });

    // Add to Cart
    this.toolRegistry.set('add_to_cart', {
      name: 'add_to_cart',
      description: 'Add items to user cart. Requires item_id and quantity.',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'string', description: 'JSON array of items: [{"item_id": 123, "qty": 2}]' },
          store_id: { type: 'string', description: 'Store ID for the items' },
        },
        required: ['items', 'store_id'],
      },
    });

    // Get Cart
    this.toolRegistry.set('get_cart', {
      name: 'get_cart',
      description: 'Get current cart contents for the user.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'User ID' },
        },
        required: ['user_id'],
      },
    });

    // Check Delivery
    this.toolRegistry.set('check_delivery', {
      name: 'check_delivery',
      description: 'Check delivery availability, ETA, and charges for a store to a location.',
      parameters: {
        type: 'object',
        properties: {
          store_id: { type: 'string', description: 'Store ID' },
          address_id: { type: 'string', description: 'User address ID' },
        },
        required: ['store_id', 'address_id'],
      },
    });

    // Generate Response
    this.toolRegistry.set('generate_response', {
      name: 'generate_response',
      description: 'Generate a natural language response to the user. Use after gathering all needed information.',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Summary of what was done and results' },
          tone: { type: 'string', description: 'Response tone: friendly, professional, casual' },
          include_buttons: { type: 'string', description: 'Whether to suggest action buttons' },
        },
        required: ['context'],
      },
    });

    this.logger.log(`Registered ${this.toolRegistry.size} agent tools`);
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const userMessage = (context.data._user_message || context.data.user_message) as string;
    const task = config.task || 'Process user request';
    const enabledTools = config.tools || Array.from(this.toolRegistry.keys());
    const maxIterations = config.maxIterations || 5;
    const additionalContext = config.context || {};

    if (!userMessage) {
      return {
        success: false,
        error: 'No user message for agent to process',
      };
    }

    try {
      // Build tool descriptions for enabled tools only
      const toolDescriptions = enabledTools
        .map((name: string) => {
          const tool = this.toolRegistry.get(name);
          if (!tool) return null;
          return `${tool.name}: ${tool.description}\nParameters: ${JSON.stringify(tool.parameters)}`;
        })
        .filter(Boolean)
        .join('\n\n');

      // Agent execution loop (ReAct pattern)
      const executionHistory: Array<{ thought: string; action: string; observation: any }> = [];
      let iterations = 0;
      let finalResult: any = null;
      let suggestedNextState = 'continue';

      while (iterations < maxIterations) {
        iterations++;

        // Build prompt for LLM to decide next action
        const prompt = this.buildAgentPrompt(
          task,
          userMessage,
          toolDescriptions,
          executionHistory,
          additionalContext,
          context
        );

        // Get LLM decision
        const llmResponse = await this.llmService.chat({
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3, // Lower temperature for more consistent tool selection
          maxTokens: 500,
        });

        const decision = this.parseAgentDecision(llmResponse.content);

        this.logger.debug(
          `Agent iteration ${iterations}: thought="${decision.thought?.substring(0, 50)}...", action=${decision.action}`
        );

        // Check if agent is done
        if (decision.action === 'FINISH' || decision.action === 'finish') {
          finalResult = {
            response: decision.response || decision.observation,
            thought: decision.thought,
            executionHistory,
          };
          suggestedNextState = decision.nextState || 'complete';
          break;
        }

        // Execute the chosen tool
        const toolResult = await this.executeTool(
          decision.action,
          decision.actionInput,
          context
        );

        executionHistory.push({
          thought: decision.thought || '',
          action: `${decision.action}(${JSON.stringify(decision.actionInput)})`,
          observation: toolResult.success ? toolResult.result : `Error: ${toolResult.error}`,
        });
      }

      // If we hit max iterations, generate a fallback response
      if (!finalResult) {
        this.logger.warn(`Agent hit max iterations (${maxIterations})`);
        finalResult = {
          response: "I'm still working on your request. Let me help you step by step.",
          thought: 'Max iterations reached',
          executionHistory,
          incomplete: true,
        };
      }

      return {
        success: true,
        output: {
          ...finalResult,
          iterations,
          tools_used: executionHistory.map(h => h.action),
        },
        event: suggestedNextState,
      };
    } catch (error) {
      this.logger.error(`Agent execution failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Build the agent prompt for LLM decision making
   */
  private buildAgentPrompt(
    task: string,
    userMessage: string,
    toolDescriptions: string,
    history: Array<{ thought: string; action: string; observation: any }>,
    additionalContext: any,
    context: FlowContext
  ): string {
    let prompt = `Task: ${task}

User Message: "${userMessage}"

Available Tools:
${toolDescriptions}

`;

    if (additionalContext && Object.keys(additionalContext).length > 0) {
      prompt += `Context:
${JSON.stringify(additionalContext, null, 2)}

`;
    }

    if (history.length > 0) {
      prompt += `Previous Actions:
`;
      for (const step of history) {
        prompt += `Thought: ${step.thought}
Action: ${step.action}
Observation: ${JSON.stringify(step.observation)}

`;
      }
    }

    prompt += `Based on the above, decide the next action.

Respond in this exact format:
Thought: [your reasoning about what to do next]
Action: [tool_name OR "FINISH" if task is complete]
Action Input: [JSON object with tool parameters OR null if FINISH]
Response: [Only if Action is FINISH - the response to send to user]
Next State: [Only if Action is FINISH - suggested next flow state: complete, checkout, show_options, etc.]`;

    return prompt;
  }

  /**
   * Get system prompt for agent LLM
   */
  private getSystemPrompt(): string {
    return `You are an AI agent for a food delivery app called Mangwale.
Your job is to understand user requests and use the available tools to fulfill them.

Guidelines:
1. Always start by classifying the intent if unclear
2. Extract entities (food, store, quantity) from user messages
3. Search for items/stores when user mentions specific names
4. Use user preferences to personalize recommendations
5. Be helpful and conversational in responses
6. If user is ready to order, guide them to checkout
7. If information is missing, ask clarifying questions

Available languages: English, Hindi, Hinglish (Hindi+English mix)
Always respond in the same language the user uses.`;
  }

  /**
   * Parse LLM response into structured decision
   */
  private parseAgentDecision(response: string): {
    thought?: string;
    action: string;
    actionInput?: any;
    observation?: string;
    response?: string;
    nextState?: string;
  } {
    try {
      // Extract components using regex
      const thoughtMatch = response.match(/Thought:\s*(.+?)(?=\nAction:|$)/s);
      const actionMatch = response.match(/Action:\s*(\w+)/);
      const inputMatch = response.match(/Action Input:\s*(\{.+?\}|\[.+?\]|null)/s);
      const responseMatch = response.match(/Response:\s*(.+?)(?=\nNext State:|$)/s);
      const nextStateMatch = response.match(/Next State:\s*(\w+)/);

      return {
        thought: thoughtMatch?.[1]?.trim(),
        action: actionMatch?.[1]?.trim() || 'FINISH',
        actionInput: inputMatch?.[1] && inputMatch[1] !== 'null' 
          ? JSON.parse(inputMatch[1]) 
          : {},
        response: responseMatch?.[1]?.trim(),
        nextState: nextStateMatch?.[1]?.trim(),
      };
    } catch (error) {
      this.logger.warn(`Failed to parse agent decision: ${error.message}`);
      return {
        action: 'FINISH',
        response: response.trim(),
      };
    }
  }

  /**
   * Execute a tool with given parameters
   */
  private async executeTool(
    toolName: string,
    params: any,
    context: FlowContext
  ): Promise<ToolResult> {
    try {
      switch (toolName.toLowerCase()) {
        case 'classify_intent':
          return await this.executeClassifyIntent(params, context);

        case 'extract_entities':
          return await this.executeExtractEntities(params);

        case 'search_items':
          return await this.executeSearchItems(params);

        case 'search_stores':
          return await this.executeSearchStores(params);

        case 'get_user_preferences':
          return await this.executeGetUserPreferences(params, context);

        case 'add_to_cart':
          return { tool: toolName, success: true, result: { added: true, params } };

        case 'get_cart':
          return { tool: toolName, success: true, result: context.data._cart || { items: [] } };

        case 'check_delivery':
          return { tool: toolName, success: true, result: { available: true, eta: '30-40 mins' } };

        case 'generate_response':
          return { tool: toolName, success: true, result: params.context };

        default:
          return { tool: toolName, success: false, error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      return { tool: toolName, success: false, error: error.message };
    }
  }

  /**
   * Tool: Classify Intent
   */
  private async executeClassifyIntent(params: any, context: FlowContext): Promise<ToolResult> {
    const result = await this.nluService.classify({
      text: params.text,
      sessionId: context._system.sessionId,
    });

    return {
      tool: 'classify_intent',
      success: true,
      result: {
        intent: result.intent,
        confidence: result.confidence,
        entities: result.entities,
      },
    };
  }

  /**
   * Tool: Extract Entities via NER
   */
  private async executeExtractEntities(params: any): Promise<ToolResult> {
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.nerUrl}/extract`,
        { text: params.text },
        { timeout: 5000 }
      )
    );

    return {
      tool: 'extract_entities',
      success: true,
      result: {
        entities: response.data.entities,
        food_items: response.data.food_items,
        store_reference: response.data.store_reference,
        food_reference: response.data.food_reference,
      },
    };
  }

  /**
   * Tool: Search Items
   */
  private async executeSearchItems(params: any): Promise<ToolResult> {
    const searchParams = new URLSearchParams({
      q: params.query,
      module_id: '4', // Food module
    });
    if (params.store_id) searchParams.set('store_id', params.store_id);
    if (params.category) searchParams.set('category', params.category);

    const response = await firstValueFrom(
      this.httpService.get(
        `${this.searchUrl}/search?${searchParams}`,
        { timeout: 5000 }
      )
    );

    return {
      tool: 'search_items',
      success: true,
      result: {
        total: response.data.meta?.total || 0,
        items: response.data.items?.slice(0, 5) || [],
      },
    };
  }

  /**
   * Tool: Search Stores
   */
  private async executeSearchStores(params: any): Promise<ToolResult> {
    const searchParams = new URLSearchParams({
      q: params.query,
      type: 'store',
    });
    if (params.location) searchParams.set('location', params.location);

    const response = await firstValueFrom(
      this.httpService.get(
        `${this.searchUrl}/search?${searchParams}`,
        { timeout: 5000 }
      )
    );

    return {
      tool: 'search_stores',
      success: true,
      result: {
        total: response.data.meta?.total || 0,
        stores: response.data.stores?.slice(0, 5) || [],
      },
    };
  }

  /**
   * Tool: Get User Preferences
   */
  private async executeGetUserPreferences(params: any, context: FlowContext): Promise<ToolResult> {
    // Pull from context if available
    const preferences = context.data._user_preferences || context.data.userProfile || {};

    return {
      tool: 'get_user_preferences',
      success: true,
      result: {
        favorites: preferences.favoriteItems || [],
        dietary: preferences.dietaryPreferences || 'none',
        addresses: preferences.savedAddresses || [],
        recentOrders: preferences.recentOrders || [],
      },
    };
  }

  validate(config: Record<string, any>): boolean {
    // Validate tools if specified
    if (config.tools && Array.isArray(config.tools)) {
      for (const tool of config.tools) {
        if (!this.toolRegistry.has(tool)) {
          this.logger.warn(`Unknown tool specified: ${tool}`);
        }
      }
    }
    return true;
  }
}
