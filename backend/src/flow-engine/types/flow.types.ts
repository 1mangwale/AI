/**
 * Flow Engine Type Definitions
 * 
 * Modern state machine-based flow system
 */

/**
 * Action to be executed in a state
 */
export interface FlowAction {
  id?: string; // Optional action ID for tracking
  executor: string; // Name of executor (nlu, llm, search, etc.)
  config: Record<string, any>; // Executor-specific configuration
  output?: string; // Context key to store result
  onError?: 'continue' | 'fail' | 'retry'; // Error handling strategy
  retryCount?: number; // Max retry attempts
  timeout?: number; // Execution timeout in ms
  retryOnError?: boolean; // Alias for compatibility
  maxRetries?: number; // Alias for retryCount
  errorStrategy?: 'fail' | 'skip' | 'retry'; // Alias for onError
}

/**
 * Condition for decision states
 */
export interface FlowCondition {
  expression: string; // JavaScript expression to evaluate
  event: string; // Event to emit if condition is true
}

/**
 * State definition in the flow
 *
 * Supported state types:
 * - 'action': Execute actions and transition based on results
 * - 'decision': Evaluate conditions to determine next state
 * - 'wait': Pause flow and wait for user input
 * - 'end': Terminal state - flow completes
 * - 'final': Alias for 'end' state
 *
 * Reserved for future use (currently treated as 'action'):
 * - 'input': Reserved for explicit input collection (future feature)
 * - 'parallel': Reserved for concurrent action execution (future feature)
 */
export interface FlowState {
  type: 'action' | 'decision' | 'parallel' | 'wait' | 'end' | 'input' | 'final';
  description?: string; // Optional description for documentation
  actions?: FlowAction[]; // Actions to execute in this state
  conditions?: FlowCondition[]; // Conditions to evaluate (for decision states)
  timeout?: number; // State timeout in ms
  onEntry?: FlowAction[]; // Actions to run when entering state
  onExit?: FlowAction[]; // Actions to run when exiting state
  transitions: {
    [event: string]: string; // event name → next state name
  };
  metadata?: Record<string, any>; // Additional state metadata
  
  // 🆕 Input Validation (GAP 3 fix - Flow-Level Input Validation)
  validator?: {
    type: 'regex' | 'intent' | 'custom' | 'keyword';
    // For regex: pattern to match
    pattern?: string;
    // For intent: expected intents that are valid in this state
    validIntents?: string[];
    // For keyword: keywords that indicate valid input
    validKeywords?: string[];
    // Custom validator executor name
    executor?: string;
    // Error message to show when validation fails
    errorMessage?: string;
    // State to transition to on validation failure
    onInvalidTransition?: string;
    // Maximum validation failures before escalation
    maxFailures?: number;
  };
  
  // Input configuration (for input states from YAML V2)
  inputConfig?: {
    variable: string;
    validation?: {
      pattern?: string;
      errorMessage?: string;
    };
    prompt?: string;
  };
}

/**
 * Complete flow definition
 */
export interface FlowDefinition {
  id: string;
  name: string;
  description?: string;
  module: 'food' | 'parcel' | 'ecommerce' | 'general' | 'personalization' | 'gamification' | 'vendor' | 'delivery' | 'customer';
  trigger?: string; // Intent that triggers this flow
  version?: string; // Flow version for A/B testing
  
  // State machine configuration
  states: {
    [stateName: string]: FlowState;
  };
  
  initialState: string; // Starting state
  finalStates: string[]; // Terminal states
  
  // Context schema (for validation)
  contextSchema?: Record<string, any>; // Simplified for Prisma JSON storage
  
  // Constants (for YAML V2 flows)
  constants?: Record<string, any>;
  
  // Flow metadata
  metadata?: {
    author?: string;
    tags?: string[];
    priority?: number;
    enabled?: boolean;
    [key: string]: any; // Allow additional custom metadata
  };
  
  // Database fields (populated when loaded from DB)
  enabled?: boolean; // Top-level enabled flag
  status?: string; // Flow status
  createdAt?: Date; // Creation timestamp
  updatedAt?: Date; // Last update timestamp
}

/**
 * Flow execution context (runtime data)
 */
export interface FlowContext {
  // User-collected data
  data: Record<string, any>;
  
  // System data
  _system: {
    flowId: string;
    flowRunId: string;
    sessionId: string;
    userId?: string;
    phoneNumber?: string;
    currentState: string;
    previousStates: string[];
    startedAt: Date;
    lastUpdatedAt: Date;
    attemptCount: number;
    errorHistory: Array<{
      state: string;
      error: string;
      timestamp: Date;
    }>;
  };
}

/**
 * Result of state execution
 */
export interface StateExecutionResult {
  nextState: string | null; // Next state to transition to
  event?: string; // Event that triggered transition
  context: FlowContext; // Updated context
  completed: boolean; // Is flow completed?
  error?: string; // Error message if failed
  output?: any; // State execution output
  metadata?: {
    intentInterrupt?: string; // Intent that caused interruption
    flowSwitch?: string; // Intent triggering a flow switch
    preserveState?: boolean; // Should preserve state for resumption
    // Validation-related metadata (state-machine.engine)
    validationFailures?: number;
    validationError?: string;
    suggestedResponse?: string;
    failureCount?: number;
  };
}

/**
 * Result of action execution
 */
export interface ActionExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  event?: string; // Event to emit after action
  // Opt-in: set false when a failure is a business rule, not a transient error.
  // executeActionWithRetry() then returns this result verbatim instead of
  // retrying and discarding `event`. No executor sets it except order.executor.
  retryable?: boolean;
  shouldTransition?: boolean; // Should transition immediately
  data?: Record<string, any>; // Additional data to pass
}

/**
 * Base interface for all executors
 */
export interface ActionExecutor {
  /**
   * Unique name of the executor
   */
  name: string;
  
  /**
   * Execute the action
   */
  execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult>;
  
  /**
   * Validate executor configuration
   */
  validate?(config: Record<string, any>): boolean;
}

/**
 * Flow run status
 */
export type FlowRunStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

/**
 * Flow execution options
 */
export interface FlowExecutionOptions {
  sessionId: string;
  userId?: string;
  phoneNumber?: string;
  initialContext?: Record<string, any>;
  module?: 'food' | 'parcel' | 'ecommerce' | 'general';
  metadata?: Record<string, any>;
  intent?: string; // Intent that triggered this flow
  intentConfidence?: number; // NLU confidence score
}

/**
 * Flow message processing result
 */
export interface FlowProcessingResult {
  flowRunId: string;
  currentState: string;
  response: string;
  completed: boolean;
  collectingData?: boolean;
  progress?: number; // 0-100 percentage
  buttons?: Array<{ id?: string; label: string; value: string; type?: string; metadata?: any }>;
  cards?: any[];
  metadata?: Record<string, any>;
}
