import { Injectable, Logger } from '@nestjs/common';
import { AgentContext, FunctionCall, FunctionDefinition, ToolDefinition, ToolCall, LLMMessage, AgentResult, AgentConfig } from '../types/agent.types';
import { FunctionExecutorService } from './function-executor.service';
import { LlmService } from '../../llm/services/llm.service';

/**
 * Base Agent Class
 * 
 * All specialized agents extend this class.
 * Provides core functionality for LLM-based function calling.
 */
@Injectable()
export abstract class BaseAgent {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly llmService: LlmService,
    protected readonly functionExecutor: FunctionExecutorService,
  ) {}

  /**
   * Get agent configuration
   */
  abstract getConfig(): AgentConfig;

  /**
   * Get system prompt for this agent
   */
  abstract getSystemPrompt(context: AgentContext): string;

  /**
   * Get available functions for this agent
   */
  abstract getFunctions(): FunctionDefinition[];

  /**
   * Execute agent with user message
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const functionsCalled: string[] = [];

    try {
      // Build conversation history
      let systemPrompt = this.getSystemPrompt(context);
      
      // 🧠 NEW: Inject user preference context if available
      if (context.session?.data?.userPreferenceContext) {
        systemPrompt += `\n\n${context.session.data.userPreferenceContext}`;
      }

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
        // Add session history
        ...(context.session?.history || []),
        // Add current message
        {
          role: 'user',
          content: context.message,
        },
      ];

      // Build tools from function definitions (2026 standard)
      const config = this.getConfig();
      const tools: ToolDefinition[] = this.getFunctions().map(fn => ({
        type: 'function' as const,
        function: fn,
      }));

      // Call LLM with tools
      let response = await this.llmService.chat({
        messages,
        tools,
        toolChoice: 'auto',
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

      // Handle tool calls (loop for multi-step agentic execution)
      let iterations = 0;
      const maxIterations = 5;

      while ((response.toolCalls?.length || response.functionCall) && iterations < maxIterations) {
        iterations++;

        // Get tool calls from response (prefer toolCalls, fallback to functionCall)
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = response.toolCalls
          ? response.toolCalls.map(tc => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }))
          : response.functionCall
            ? [{ id: `call_${Date.now()}`, name: response.functionCall.name, arguments: typeof response.functionCall.arguments === 'string' ? response.functionCall.arguments : JSON.stringify(response.functionCall.arguments) }]
            : [];

        // Add assistant message with tool_calls to history
        messages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          let functionArgs: any;
          try {
            functionArgs = JSON.parse(toolCall.arguments);
          } catch {
            this.logger.warn(`Failed to parse tool args for ${toolCall.name}, using empty object`);
            functionArgs = {};
          }

          this.logger.log(`Agent ${config.id} calling tool: ${toolCall.name}`, functionArgs);
          functionsCalled.push(toolCall.name);

          const functionResult = await this.functionExecutor.execute(
            toolCall.name,
            functionArgs,
            context,
          );

          // Add tool result message (2026 standard)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult),
          });
        }

        // Get next response from LLM
        response = await this.llmService.chat({
          messages,
          tools,
          toolChoice: 'auto',
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        });
      }

      const executionTime = Date.now() - startTime;

      return {
        response: response.content || 'I apologize, but I need more information to help you.',
        functionsCalled,
        executionTime,
        tokensUsed: response.usage?.totalTokens,
      };
    } catch (error) {
      this.logger.error(
        `Agent ${this.getConfig().id} execution error:`,
        error,
      );

      return {
        response: 'I apologize, but I encountered an error. Please try again or contact support.',
        functionsCalled,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate function arguments
   */
  protected validateFunctionArgs(
    functionDef: FunctionDefinition,
    args: Record<string, any>,
  ): boolean {
    const required = functionDef.parameters.required || [];

    for (const field of required) {
      if (!(field in args)) {
        this.logger.warn(
          `Missing required argument: ${field} in function ${functionDef.name}`,
        );
        return false;
      }
    }

    return true;
  }
}
