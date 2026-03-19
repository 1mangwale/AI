import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FlowContextService } from './flow-context.service';
import { ExecutorRegistryService } from './executor-registry.service';
import { InputValidatorService, ValidationResult } from './executors/input-validator.service';
import { SelfLearningService } from '../learning/services/self-learning.service';
import {
  FlowDefinition,
  FlowContext,
  FlowState,
  StateExecutionResult,
  FlowAction,
  ActionExecutionResult,
} from './types/flow.types';

/**
 * Executor Error for structured error handling
 */
export interface ExecutorError {
  executor: string;
  action?: string;
  state: string;
  message: string;
  code?: string;
  recoverable: boolean;
  retryable: boolean;
  timestamp: Date;
}

/**
 * State Machine Engine
 * 
 * Core engine that executes state transitions and actions
 * 
 * ENHANCED: Improved error handling with:
 * - Structured error types
 * - Error recovery strategies
 * - Retry with exponential backoff
 * - Error context preservation
 */
@Injectable()
export class StateMachineEngine {
  private readonly logger = new Logger(StateMachineEngine.name);
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 1000; // Base delay for exponential backoff

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: FlowContextService,
    private readonly executorRegistry: ExecutorRegistryService,
    private readonly inputValidator: InputValidatorService,
    @Optional() private readonly contextSchemaValidator?: any,  // ContextSchemaValidatorService
    @Optional() private readonly selfLearningService?: SelfLearningService,
  ) {}

  /**
   * Execute a single state
   */
  async executeState(
    flow: FlowDefinition,
    context: FlowContext,
    event?: string
  ): Promise<StateExecutionResult> {
    const currentStateName = context._system.currentState;
    const state = flow.states[currentStateName];

    if (!state) {
      return {
        nextState: null,
        context,
        completed: true,
        error: `State not found: ${currentStateName}`,
      };
    }

    this.logger.log(
      `📋 Executing state: ${currentStateName} (type: ${state.type})`
    );

    // 🐛 FIX: Validate state type - warn about unsupported types
    const supportedTypes = ['action', 'decision', 'wait', 'end', 'final'];
    const unsupportedTypes = ['input', 'parallel'];

    if (unsupportedTypes.includes(state.type)) {
      this.logger.warn(
        `⚠️ State '${currentStateName}' uses unsupported type '${state.type}'. ` +
        `This state type is reserved for future use and will be treated as 'action'. ` +
        `Supported types: ${supportedTypes.join(', ')}`
      );
      // Treat as 'action' state for now
    }

    try {
      // 🎯 INTENT-AWARE FLOW INTERRUPTION (Phase 3)
      // Check if there's an interrupting intent before processing the state
      const intentInterrupt = this.contextService.get(context, '_intent_interrupt');
      const currentIntent = this.contextService.get(context, '_current_intent');
      const intentConfidence = this.contextService.get(context, '_intent_confidence') || 0;
      
      if (intentInterrupt && currentIntent) {
        this.logger.log(`🚨 Intent interrupt detected: ${currentIntent} (confidence: ${intentConfidence})`);
        
        // Handle special interrupt intents
        if (['cancel', 'stop', 'reset'].includes(currentIntent)) {
          // User wants to cancel - transition to flow end or error state
          this.logger.log(`🛑 User cancellation intent: ${currentIntent}`);
          this.contextService.set(context, '_flow_cancelled', true);
          this.contextService.set(context, '_cancel_reason', currentIntent);
          
          // Clear the interrupt flag so we don't loop
          this.contextService.set(context, '_intent_interrupt', false);
          
          // Look for a cancel transition or end state
          // 🐛 FIX BUG-4: Add parentheses to fix operator precedence
          // Without parentheses, custom cancel transitions are ignored
          const cancelState = state.transitions['cancel'] ||
                              state.transitions['cancelled'] ||
                              (flow.states['cancelled'] ? 'cancelled' : flow.finalStates[0]);
          
          return {
            nextState: cancelState || null,
            event: 'cancelled',
            context,
            completed: !cancelState, // Let cancel state execute its actions before marking complete
            metadata: { intentInterrupt: currentIntent }
          };
        }
        
        if (['help', 'menu', 'main_menu'].includes(currentIntent)) {
          // User wants help - set flag for flow to handle
          this.logger.log(`❓ Help intent detected: ${currentIntent}`);
          this.contextService.set(context, '_help_requested', true);
          // Don't fully interrupt, let the flow handle help gracefully
          this.contextService.set(context, '_intent_interrupt', false);
        }
        
        // For context-switch intents (e.g., user starts food order while in auth flow)
        // Flag it but continue - the FlowEngineService will handle starting a new flow
        if (!['cancel', 'stop', 'reset', 'help', 'menu', 'main_menu'].includes(currentIntent)) {
          this.logger.log(`🔄 Context switch intent: ${currentIntent} - flagging for flow engine`);
          this.contextService.set(context, '_pending_flow_switch', currentIntent);
          this.contextService.set(context, '_intent_interrupt', false);
        }
      }

      // 1. Execute onEntry actions - ONLY when first entering (no event)
      // When resuming with user input (event='user_message'), skip onEntry
      if (state.onEntry && state.onEntry.length > 0 && !event) {
        this.logger.debug(`Running ${state.onEntry.length} onEntry actions`);
        await this.executeActions(state.onEntry, context, currentStateName);
      }

      // 1.5. INPUT VALIDATION (GAP 3 Fix)
      // For wait states receiving user input, validate before processing
      if (state.type === 'wait' && event && state.validator) {
        const validationResult = await this.validateInput(state, context, currentStateName);
        
        if (!validationResult.valid) {
          this.logger.warn(`❌ Input validation failed in ${currentStateName}: ${validationResult.reason}`);
          
          // Track failure count
          const failureKey = `_validation_failures_${currentStateName}`;
          const failures = (this.contextService.get(context, failureKey) || 0) + 1;
          this.contextService.set(context, failureKey, failures);
          this.contextService.set(context, '_last_validation_error', validationResult.reason);
          
          // Check max failures
          const maxFailures = state.validator.maxFailures || 3;
          if (failures >= maxFailures) {
            this.logger.warn(`⚠️ Max validation failures (${maxFailures}) reached in ${currentStateName}`);
            
            // Transition to failure state if defined, otherwise stay
            const failState = state.validator.onInvalidTransition || state.transitions['validation_failed'];
            if (failState) {
              return {
                nextState: failState,
                event: 'validation_max_failures',
                context,
                completed: false, // Let fail state execute its actions before marking complete
                metadata: { validationFailures: failures }
              };
            }
          }
          
          // Return validation error - stay in current state
          return {
            nextState: null,
            event: 'validation_failed',
            context,
            completed: false,
            metadata: {
              validationError: validationResult.reason,
              suggestedResponse: validationResult.suggestedResponse || state.validator.errorMessage,
              failureCount: failures
            }
          };
        }
        
        // Validation passed - store extracted value if present
        if (validationResult.extractedValue !== undefined) {
          this.contextService.set(context, '_validated_input', validationResult.extractedValue);
        }
        
        // Reset failure counter on success
        this.contextService.set(context, `_validation_failures_${currentStateName}`, 0);
      }

      // 2. Execute main actions based on state type
      let triggeredEvent: string | undefined = event;

      // For 'wait' states:
      // - When first entering (no event): DON'T run actions (only onEntry prompts)
      // - When resuming with user input (event='user_message'): Run actions for validation
      // For 'action' states: ALWAYS run actions
      const shouldExecuteActions = 
        state.type === 'action' || 
        (state.type === 'wait' && event); // Wait states ONLY execute actions when resuming with event

      if (shouldExecuteActions && state.actions) {
        const results = await this.executeActions(state.actions, context, currentStateName);
        // Check if any action explicitly triggered an event
        // Pass state.type to allow different behavior for action vs wait states
        const actionEvent = this.findTriggeredEvent(results, state.type);
        this.logger.debug(`Action results events: ${JSON.stringify(results.map(r => ({ event: r.event, success: r.success })))}`);
        this.logger.debug(`actionEvent from findTriggeredEvent: ${actionEvent}, state.type: ${state.type}, incoming event: ${event}`);
        // For wait states resuming with user input: preserve user_message event
        // unless action returns a meaningful event (not 'default' or 'success')
        if (state.type === 'wait' && event) {
          // Keep the incoming event (e.g., 'user_message') unless action explicitly triggers different
          // Note: 'success' and 'default' are generic events - don't override user_message with them
          triggeredEvent = (actionEvent && actionEvent !== 'default' && actionEvent !== 'success') ? actionEvent : event;
        } else {
          triggeredEvent = actionEvent || event;
        }
        this.logger.debug(`Final triggeredEvent: ${triggeredEvent}`);
      } else if (state.type === 'decision' && state.conditions) {
        triggeredEvent = await this.evaluateConditions(state.conditions, context);
      } else if (state.type === 'end') {
        // End state - no actions needed
        triggeredEvent = 'completed';
      }

      // 3. Determine next state from transitions
      // For 'wait' states on first entry (no event): DON'T follow default transition - stay in state
      // This ensures the flow waits for user input before transitioning
      let nextState: string | null = null;
      
      if (state.type === 'wait' && !event) {
        // Wait state on initial entry - don't transition, wait for user input
        this.logger.debug(`Wait state '${currentStateName}' entered - waiting for user input, not following default transition`);
        nextState = null;
      } else {
        // Normal transition logic: try specific event, then fall back to 'default'
        nextState = state.transitions[triggeredEvent] 
          || (triggeredEvent !== 'default' && state.transitions['default']) 
          || null;
        this.logger.debug(`🔍 Transition: event="${triggeredEvent}" → nextState=${nextState || 'null'} (direct=${state.transitions[triggeredEvent] || 'none'}, default=${state.transitions['default'] || 'none'})`);
      }

      // 4. Execute onExit actions
      if (state.onExit && state.onExit.length > 0 && nextState) {
        this.logger.debug(`Running ${state.onExit.length} onExit actions`);
        await this.executeActions(state.onExit, context, currentStateName);
      }

      // 5. Check if flow is complete
      // ONLY mark completed when we have nowhere to go: no next state AND no pending transitions.
      // Do NOT mark completed when transitioning TO a final state — the final state may have
      // actions (e.g., order confirmation messages) that must execute first.
      const hasTransitions = state.transitions && Object.keys(state.transitions).length > 0;
      const completed = !nextState && !hasTransitions;

      this.logger.log(
        `✅ State complete: ${currentStateName} → ${nextState || 'STAY'} (event: ${triggeredEvent || 'none'}, completed: ${completed})`
      );

      // 🐛 FIX: Runtime context schema validation
      // Validate context data after state execution to catch data integrity issues
      if (this.contextSchemaValidator && flow.contextSchema) {
        try {
          const schemaName = this.getSchemaNameForFlow(flow);
          if (schemaName) {
            const validationResult = this.contextSchemaValidator.validate(
              schemaName,
              context.data,
              { strict: false, sanitize: false }
            );

            if (!validationResult.valid) {
              this.logger.warn(
                `⚠️ Context validation issues after state '${currentStateName}': ${validationResult.errors.join(', ')}`
              );
              // Log but don't fail - allow flow to continue
            } else if (validationResult.warnings && validationResult.warnings.length > 0) {
              this.logger.debug(
                `Context warnings after state '${currentStateName}': ${validationResult.warnings.join(', ')}`
              );
            }
          }
        } catch (err) {
          // Don't fail flow if validation crashes
          this.logger.error(`Context validation error: ${err.message}`);
        }
      }

      // 🎯 POSITIVE TRAINING SIGNAL: When a flow reaches a terminal success state,
      // confirm the original NLU classification was correct (fire-and-forget).
      if (completed && this.selfLearningService && this.isSuccessTerminalState(currentStateName, state)) {
        const originalIntent = context.data._nlu_intent || context.data.originalIntent || context.data.intent;
        if (originalIntent) {
          this.selfLearningService.trackPositiveOutcome({
            sessionId: context._system.sessionId,
            intent: originalIntent,
            flowId: context._system.flowId,
            completedSuccessfully: true,
          }).catch(() => {}); // fire-and-forget
        }
      }

      return {
        nextState: nextState || null,
        event: triggeredEvent,
        context,
        completed,
      };
    } catch (error) {
      this.logger.error(
        `Error executing state ${currentStateName}: ${error.message}`,
        error.stack
      );

      this.contextService.recordError(context, error.message);

      return {
        nextState: null,
        context,
        completed: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute multiple actions sequentially with enhanced error handling
   */
  private async executeActions(
    actions: FlowAction[],
    context: FlowContext,
    stateName?: string
  ): Promise<ActionExecutionResult[]> {
    const results: ActionExecutionResult[] = [];

    for (const action of actions) {
      try {
        // Interpolate config values
        const interpolatedConfig = this.contextService.interpolateObject(
          context,
          action.config
        );

        // Execute action with retry support
        const result = await this.executeActionWithRetry(
          action,
          interpolatedConfig,
          context,
          stateName
        );

        results.push(result);

        // Store output if specified
        if (action.output && result.output !== undefined) {
          this.contextService.set(context, action.output, result.output);
        }

        // Handle errors based on strategy
        if (!result.success) {
          const errorHandled = await this.handleExecutorError(
            action,
            result,
            context,
            stateName || 'unknown'
          );

          if (!errorHandled.continue) {
            throw new Error(errorHandled.message);
          }
        }
      } catch (error) {
        this.logger.error(
          `Action ${action.executor} threw error: ${error.message}`
        );

        // Record error in context
        this.recordExecutorError(context, {
          executor: action.executor,
          action: action.id,
          state: stateName || 'unknown',
          message: error.message,
          recoverable: action.onError === 'continue',
          retryable: action.onError === 'retry',
          timestamp: new Date(),
        });

        results.push({
          success: false,
          error: error.message,
        });

        // Re-throw if error strategy is 'fail'
        if (action.onError !== 'continue') {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Execute action with retry support and exponential backoff
   */
  private async executeActionWithRetry(
    action: FlowAction,
    config: Record<string, any>,
    context: FlowContext,
    stateName?: string
  ): Promise<ActionExecutionResult> {
    const maxRetries = action.retryCount || action.maxRetries || 0;
    const shouldRetry = action.onError === 'retry' || action.retryOnError;
    
    let lastError: Error | null = null;
    let attempts = 0;

    while (attempts <= maxRetries) {
      attempts++;
      
      try {
        const result = await this.executorRegistry.execute(
          action.executor,
          config,
          context
        );

        // If successful or not retrying on failure, return immediately
        if (result.success || !shouldRetry) {
          return result;
        }

        // Store error for potential retry
        lastError = new Error(result.error || 'Unknown error');
        
        if (attempts <= maxRetries) {
          const delay = this.RETRY_DELAY_MS * Math.pow(2, attempts - 1);
          this.logger.warn(
            `Action ${action.executor} failed (attempt ${attempts}/${maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${result.error}`
          );
          await this.sleep(delay);
        }
      } catch (error) {
        lastError = error;
        
        if (shouldRetry && attempts <= maxRetries) {
          const delay = this.RETRY_DELAY_MS * Math.pow(2, attempts - 1);
          this.logger.warn(
            `Action ${action.executor} threw error (attempt ${attempts}/${maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${error.message}`
          );
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }

    // All retries exhausted
    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
    };
  }

  /**
   * Handle executor error with structured response
   */
  private async handleExecutorError(
    action: FlowAction,
    result: ActionExecutionResult,
    context: FlowContext,
    stateName: string
  ): Promise<{ continue: boolean; message: string }> {
    const errorStrategy = action.onError || action.errorStrategy || 'fail';
    const errorMessage = result.error || 'Unknown executor error';

    // Record error
    this.recordExecutorError(context, {
      executor: action.executor,
      action: action.id,
      state: stateName,
      message: errorMessage,
      recoverable: errorStrategy === 'continue' || errorStrategy === 'skip',
      retryable: errorStrategy === 'retry',
      timestamp: new Date(),
    });

    switch (errorStrategy) {
      case 'continue':
      case 'skip':
        this.logger.warn(
          `Executor ${action.executor} failed but continuing: ${errorMessage}`
        );
        return { continue: true, message: errorMessage };

      case 'retry':
        // Retry was already handled in executeActionWithRetry
        this.logger.error(
          `Executor ${action.executor} failed after retries: ${errorMessage}`
        );
        return { continue: false, message: `Max retries exceeded: ${errorMessage}` };

      case 'fail':
      default:
        this.logger.error(
          `Executor ${action.executor} failed (strategy: fail): ${errorMessage}`
        );
        return { continue: false, message: errorMessage };
    }
  }

  /**
   * Record executor error in context for debugging and analytics
   */
  private recordExecutorError(context: FlowContext, error: ExecutorError): void {
    if (!context._system.errorHistory) {
      context._system.errorHistory = [];
    }

    context._system.errorHistory.push({
      state: error.state,
      error: `[${error.executor}] ${error.message}`,
      timestamp: error.timestamp,
    });

    // Also store last error for quick access
    context.data._lastError = {
      executor: error.executor,
      message: error.message,
      recoverable: error.recoverable,
      timestamp: error.timestamp.toISOString(),
    };
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute multiple actions sequentially
   * @deprecated Use executeActions with stateName parameter instead
   */

  /**
   * Evaluate conditions and return triggered event
   */
  private async evaluateConditions(
    conditions: Array<{ expression: string; event: string }>,
    context: FlowContext
  ): Promise<string | undefined> {
    for (const condition of conditions) {
      try {
        const result = this.contextService.evaluateExpression(
          context,
          condition.expression
        );

        if (result) {
          this.logger.debug(
            `Condition matched: ${condition.expression} → ${condition.event}`
          );
          return condition.event;
        }
      } catch (error) {
        this.logger.error(
          `Error evaluating condition: ${condition.expression}`,
          error
        );
      }
    }

    return undefined;
  }

  /**
   * Find if any action result triggered an event
   * For action states, infer 'success' if all actions succeed without explicit events
   * For wait states, only return explicit events (not inferred)
   */
  private findTriggeredEvent(results: ActionExecutionResult[], stateType?: string): string | undefined {
    // Check for explicit events, preferring specific events over generic ones.
    // Generic events ('default', 'success') from earlier actions should not mask
    // meaningful events ('address_valid', 'waiting_for_input', etc.) from later actions.
    const genericEvents = new Set(['default', 'success']);
    let firstGenericEvent: string | undefined;

    for (const result of results) {
      if (result.event) {
        if (!genericEvents.has(result.event)) {
          // Found a specific (non-generic) event — use it immediately
          return result.event;
        }
        // Track first generic event as fallback
        if (!firstGenericEvent) {
          firstGenericEvent = result.event;
        }
      }
    }

    // If only generic events were found, return the first one
    if (firstGenericEvent) {
      return firstGenericEvent;
    }
    
    // Only infer 'success' for action states (not wait states)
    // Wait states should preserve the incoming user_message event
    if (stateType === 'action') {
      const allSucceeded = results.length > 0 && results.every(r => r.success);
      if (allSucceeded) {
        return 'success';
      }
    }
    
    // Check if any action failed - always return 'error' for failures
    const anyFailed = results.some(r => r.success === false);
    if (anyFailed) {
      return 'error';
    }
    
    return undefined;
  }

  /**
   * Validate flow definition
   */
  validateFlow(flow: FlowDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check flow.states exists
    if (!flow.states || typeof flow.states !== 'object') {
      errors.push(`Flow states is missing or invalid (got: ${typeof flow.states})`);
      return { valid: false, errors };
    }

    // Check initial state exists
    if (!flow.states[flow.initialState]) {
      errors.push(`Initial state '${flow.initialState}' not found`);
    }

    // Check final states exist
    for (const finalState of flow.finalStates) {
      if (!flow.states[finalState]) {
        errors.push(`Final state '${finalState}' not found`);
      }
    }

    // Validate each state
    for (const [stateName, state] of Object.entries(flow.states)) {
      if (!state || typeof state !== 'object') {
        errors.push(`State '${stateName}' is invalid`);
        continue;
      }

      // Check transitions point to existing states
      if (state.transitions && typeof state.transitions === 'object') {
        for (const [event, nextState] of Object.entries(state.transitions)) {
          if (nextState && !flow.states[nextState]) {
            errors.push(
              `State '${stateName}' transition '${event}' points to non-existent state '${nextState}'`
            );
          }
        }
      }

      // Check executors exist
      const allActions = [
        ...(state.actions || []),
        ...(state.onEntry || []),
        ...(state.onExit || []),
      ];

      for (const action of allActions) {
        if (!this.executorRegistry.has(action.executor)) {
          errors.push(
            `State '${stateName}' uses unknown executor '${action.executor}'`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate user input against state validator configuration
   * GAP 3 Fix: Flow-level input validation
   */
  private async validateInput(
    state: FlowState,
    context: FlowContext,
    stateName: string
  ): Promise<ValidationResult> {
    if (!state.validator) {
      return { valid: true, input: '' };
    }

    this.logger.debug(`🔍 Validating input in state '${stateName}' (type: ${state.validator.type})`);

    try {
      const result = this.inputValidator.validate(state.validator, context);
      
      if (result.valid) {
        this.logger.debug(`✅ Input validation passed in ${stateName}`);
      } else {
        this.logger.debug(`❌ Input validation failed in ${stateName}: ${result.reason}`);
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error during input validation in ${stateName}: ${error.message}`);
      // Fail open - allow input through if validator errors
      return { valid: true, input: '' };
    }
  }

  /**
   * Map flow module/ID to context schema name
   */
  private getSchemaNameForFlow(flow: FlowDefinition): string | null {
    // Map based on flow module
    const moduleSchemaMap: Record<string, string> = {
      'food': 'food_order',
      'parcel': 'parcel',
      'general': 'base',
      'personalization': 'base',
      'gamification': 'base',
    };

    // Map based on flow ID (more specific)
    const flowIdSchemaMap: Record<string, string> = {
      'food_order_v1': 'food_order',
      'food_order_v2': 'food_order',
      'smart_food_order_v1': 'food_order',
      'auth_flow_v1': 'auth',
      'otp_verification_v1': 'auth',
      'address_management_v1': 'address',
      'add_address_v1': 'address',
      'parcel_booking_v1': 'parcel',
      'parcel_send_v1': 'parcel',
    };

    // Try flow ID first, then module, then base
    return flowIdSchemaMap[flow.id] || moduleSchemaMap[flow.module] || 'base';
  }

  /**
   * Determine if a terminal state represents a successful outcome.
   * Only returns true for clear success states — excludes cancellations,
   * errors, and failures to avoid false positive training signals.
   */
  private isSuccessTerminalState(stateName: string, state: FlowState): boolean {
    // Must be an end/final state type
    if (state.type !== 'end' && state.type !== 'final') {
      return false;
    }

    const lower = stateName.toLowerCase();

    // Explicit failure/cancel states — NOT a positive outcome
    const negativePatterns = [
      'cancel', 'fail', 'error', 'timeout', 'abort', 'reject',
      'expired', 'declined', 'denied',
    ];
    if (negativePatterns.some(p => lower.includes(p))) {
      return false;
    }

    // Explicit success states — positive outcome
    const positivePatterns = [
      'order_placed', 'order_confirmed', 'order_complete', 'order_success',
      'booking_confirmed', 'booking_complete', 'booking_success',
      'payment_success', 'payment_confirmed', 'payment_complete',
      'delivery_confirmed', 'parcel_booked',
      'success', 'completed', 'confirmed', 'done', 'finish',
    ];
    if (positivePatterns.some(p => lower.includes(p))) {
      return true;
    }

    // Generic END state — treat as success (most flows use END as the happy path)
    if (lower === 'end') {
      return true;
    }

    // Unknown terminal state — be conservative, don't signal
    return false;
  }
}
