import { Injectable, Logger } from '@nestjs/common';
import * as client from 'prom-client';

/**
 * Prometheus Metrics Service
 * 
 * Centralizes all application metrics for observability.
 * Metrics follow the RED methodology:
 * - Rate: messages processed per second
 * - Errors: error counts by type
 * - Duration: latency histograms
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly register: client.Registry;

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE GATEWAY METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Total messages received by the gateway */
  public readonly messagesReceived: client.Counter<string>;

  /** Messages successfully processed */
  public readonly messagesProcessed: client.Counter<string>;

  /** Messages deduplicated (duplicates caught) */
  public readonly messagesDeduplicated: client.Counter<string>;

  /** Message processing latency */
  public readonly messageProcessingDuration: client.Histogram<string>;

  /** Current active sessions */
  public readonly activeSessions: client.Gauge<string>;

  // ═══════════════════════════════════════════════════════════════
  // ROUTING METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Messages routed through sync path (Web, Voice, Mobile) */
  public readonly syncRoutingCount: client.Counter<string>;

  /** Messages routed through async path (WhatsApp, Telegram) */
  public readonly asyncRoutingCount: client.Counter<string>;

  /** Routing decision latency */
  public readonly routingDecisionDuration: client.Histogram<string>;

  /** Routes taken (flow engine, agent, direct response, etc.) */
  public readonly routesTaken: client.Counter<string>;

  // ═══════════════════════════════════════════════════════════════
  // CHANNEL METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Channel-specific message counts */
  public readonly channelMessages: client.Counter<string>;

  /** Channel error counts */
  public readonly channelErrors: client.Counter<string>;

  /** Channel response latency */
  public readonly channelLatency: client.Histogram<string>;

  // ═══════════════════════════════════════════════════════════════
  // NLU/INTENT METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Intent classification counts */
  public readonly intentClassifications: client.Counter<string>;

  /** Intent confidence scores */
  public readonly intentConfidence: client.Histogram<string>;

  /** NLU processing duration */
  public readonly nluProcessingDuration: client.Histogram<string>;

  // ═══════════════════════════════════════════════════════════════
  // FLOW ENGINE METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Flow executions */
  public readonly flowExecutions: client.Counter<string>;

  /** Flow completion rate */
  public readonly flowCompletions: client.Counter<string>;

  /** Flow execution duration */
  public readonly flowDuration: client.Histogram<string>;

  /** Flow state transitions */
  public readonly flowStateTransitions: client.Counter<string>;

  /** Flow drop-offs by state */
  public readonly flowDropoffs: client.Counter<string>;

  /** Active flows by type */
  public readonly activeFlows: client.Gauge<string>;

  // ═══════════════════════════════════════════════════════════════
  // AGENT METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Agent invocations */
  public readonly agentInvocations: client.Counter<string>;

  /** Agent response latency */
  public readonly agentLatency: client.Histogram<string>;

  /** LLM token usage */
  public readonly llmTokensUsed: client.Counter<string>;

  // ═══════════════════════════════════════════════════════════════
  // MCP METRICS
  // ═══════════════════════════════════════════════════════════════

  /** MCP tool call counter */
  public readonly mcpToolCalls: client.Counter<string>;

  /** MCP tool execution duration */
  public readonly mcpToolDuration: client.Histogram<string>;

  /** MCP tool error counter */
  public readonly mcpToolErrors: client.Counter<string>;

  /** MCP active sessions gauge */
  public readonly mcpActiveSessions: client.Gauge<string>;

  // ═══════════════════════════════════════════════════════════════
  // SELF-LEARNING METRICS
  // ═══════════════════════════════════════════════════════════════

  /** Self-learning actions counter */
  public readonly selfLearningActions: client.Counter<string>;

  constructor() {
    this.register = new client.Registry();

    // Set default labels
    this.register.setDefaultLabels({
      app: 'mangwale-ai',
      env: process.env.NODE_ENV || 'development',
    });

    // Initialize all metrics
    this.messagesReceived = new client.Counter({
      name: 'mangwale_messages_received_total',
      help: 'Total number of messages received by the gateway',
      labelNames: ['channel', 'module'],
      registers: [this.register],
    });

    this.messagesProcessed = new client.Counter({
      name: 'mangwale_messages_processed_total',
      help: 'Total number of messages successfully processed',
      labelNames: ['channel', 'module', 'status'],
      registers: [this.register],
    });

    this.messagesDeduplicated = new client.Counter({
      name: 'mangwale_messages_deduplicated_total',
      help: 'Total number of duplicate messages caught',
      labelNames: ['channel'],
      registers: [this.register],
    });

    this.messageProcessingDuration = new client.Histogram({
      name: 'mangwale_message_processing_duration_seconds',
      help: 'Message processing latency in seconds',
      labelNames: ['channel', 'route'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.activeSessions = new client.Gauge({
      name: 'mangwale_active_sessions',
      help: 'Current number of active sessions',
      labelNames: ['channel'],
      registers: [this.register],
    });

    this.syncRoutingCount = new client.Counter({
      name: 'mangwale_sync_routing_total',
      help: 'Messages routed through synchronous path',
      labelNames: ['channel'],
      registers: [this.register],
    });

    this.asyncRoutingCount = new client.Counter({
      name: 'mangwale_async_routing_total',
      help: 'Messages routed through asynchronous path',
      labelNames: ['channel'],
      registers: [this.register],
    });

    this.routingDecisionDuration = new client.Histogram({
      name: 'mangwale_routing_decision_duration_seconds',
      help: 'Time taken to make routing decisions',
      labelNames: ['route_type'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
      registers: [this.register],
    });

    this.routesTaken = new client.Counter({
      name: 'mangwale_routes_taken_total',
      help: 'Routes taken by the context router',
      labelNames: ['route', 'channel'],
      registers: [this.register],
    });

    this.channelMessages = new client.Counter({
      name: 'mangwale_channel_messages_total',
      help: 'Messages by channel',
      labelNames: ['channel', 'direction'],
      registers: [this.register],
    });

    this.channelErrors = new client.Counter({
      name: 'mangwale_channel_errors_total',
      help: 'Errors by channel',
      labelNames: ['channel', 'error_type'],
      registers: [this.register],
    });

    this.channelLatency = new client.Histogram({
      name: 'mangwale_channel_latency_seconds',
      help: 'Response latency by channel',
      labelNames: ['channel'],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.register],
    });

    this.intentClassifications = new client.Counter({
      name: 'mangwale_intent_classifications_total',
      help: 'Intent classification counts',
      labelNames: ['intent', 'language'],
      registers: [this.register],
    });

    this.intentConfidence = new client.Histogram({
      name: 'mangwale_intent_confidence',
      help: 'Intent classification confidence scores',
      labelNames: ['intent'],
      buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
      registers: [this.register],
    });

    this.nluProcessingDuration = new client.Histogram({
      name: 'mangwale_nlu_processing_duration_seconds',
      help: 'NLU processing latency',
      labelNames: ['model'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [this.register],
    });

    this.flowExecutions = new client.Counter({
      name: 'mangwale_flow_executions_total',
      help: 'Flow engine executions',
      labelNames: ['flow_name', 'module'],
      registers: [this.register],
    });

    this.flowCompletions = new client.Counter({
      name: 'mangwale_flow_completions_total',
      help: 'Flow completions',
      labelNames: ['flow_name', 'status'],
      registers: [this.register],
    });

    this.flowDuration = new client.Histogram({
      name: 'mangwale_flow_duration_seconds',
      help: 'Flow execution duration',
      labelNames: ['flow_name'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
      registers: [this.register],
    });

    this.flowStateTransitions = new client.Counter({
      name: 'mangwale_flow_state_transitions_total',
      help: 'Flow state transitions for drop-off analysis',
      labelNames: ['flow_name', 'from_state', 'to_state'],
      registers: [this.register],
    });

    this.flowDropoffs = new client.Counter({
      name: 'mangwale_flow_dropoffs_total',
      help: 'Flow abandonments by state',
      labelNames: ['flow_name', 'state', 'reason'],
      registers: [this.register],
    });

    this.activeFlows = new client.Gauge({
      name: 'mangwale_active_flows',
      help: 'Current number of active flows',
      labelNames: ['flow_name', 'module'],
      registers: [this.register],
    });

    this.agentInvocations = new client.Counter({
      name: 'mangwale_agent_invocations_total',
      help: 'Agent invocation counts',
      labelNames: ['agent_type'],
      registers: [this.register],
    });

    this.agentLatency = new client.Histogram({
      name: 'mangwale_agent_latency_seconds',
      help: 'Agent response latency',
      labelNames: ['agent_type'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.register],
    });

    this.llmTokensUsed = new client.Counter({
      name: 'mangwale_llm_tokens_used_total',
      help: 'LLM tokens consumed',
      labelNames: ['model', 'type'],
      registers: [this.register],
    });

    // MCP metrics
    this.mcpToolCalls = new client.Counter({
      name: 'mangwale_mcp_tool_calls_total',
      help: 'MCP tool call counter',
      labelNames: ['tool', 'cached'],
      registers: [this.register],
    });

    this.mcpToolDuration = new client.Histogram({
      name: 'mangwale_mcp_tool_duration_seconds',
      help: 'MCP tool execution duration',
      labelNames: ['tool'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.mcpToolErrors = new client.Counter({
      name: 'mangwale_mcp_tool_errors_total',
      help: 'MCP tool error counter',
      labelNames: ['tool', 'error_type'],
      registers: [this.register],
    });

    this.mcpActiveSessions = new client.Gauge({
      name: 'mangwale_mcp_active_sessions',
      help: 'MCP active sessions by transport',
      labelNames: ['transport'],
      registers: [this.register],
    });

    this.selfLearningActions = new client.Counter({
      name: 'mangwale_self_learning_actions_total',
      help: 'Self-learning actions counter',
      labelNames: ['action'],
      registers: [this.register],
    });

    this.logger.log('📊 Prometheus metrics initialized');
  }

  /**
   * Initialize default Node.js metrics (CPU, memory, event loop)
   */
  initializeDefaultMetrics() {
    client.collectDefaultMetrics({
      register: this.register,
      prefix: 'mangwale_',
    });
    this.logger.log('📊 Default Node.js metrics enabled');
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  /**
   * Get content type for Prometheus
   */
  getContentType(): string {
    return this.register.contentType;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER METHODS FOR COMMON OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Record a message received
   */
  recordMessageReceived(channel: string, module: string = 'default') {
    this.messagesReceived.labels(channel, module).inc();
    this.channelMessages.labels(channel, 'inbound').inc();
  }

  /**
   * Record a message processed
   */
  recordMessageProcessed(
    channel: string,
    module: string = 'default',
    status: 'success' | 'error' = 'success',
  ) {
    this.messagesProcessed.labels(channel, module, status).inc();
  }

  /**
   * Record a deduplicated message
   */
  recordDeduplication(channel: string) {
    this.messagesDeduplicated.labels(channel).inc();
  }

  /**
   * Record message processing duration
   */
  recordProcessingDuration(channel: string, route: string, durationMs: number) {
    this.messageProcessingDuration
      .labels(channel, route)
      .observe(durationMs / 1000);
  }

  /**
   * Record sync routing
   */
  recordSyncRouting(channel: string) {
    this.syncRoutingCount.labels(channel).inc();
  }

  /**
   * Record async routing
   */
  recordAsyncRouting(channel: string) {
    this.asyncRoutingCount.labels(channel).inc();
  }

  /**
   * Record route taken
   */
  recordRoute(route: string, channel: string) {
    this.routesTaken.labels(route, channel).inc();
  }

  /**
   * Record channel error
   */
  recordChannelError(channel: string, errorType: string) {
    this.channelErrors.labels(channel, errorType).inc();
  }

  /**
   * Record intent classification
   */
  recordIntent(intent: string, confidence: number, language: string = 'auto') {
    this.intentClassifications.labels(intent, language).inc();
    this.intentConfidence.labels(intent).observe(confidence);
  }

  /**
   * Record NLU processing time
   */
  recordNluProcessing(model: string, durationMs: number) {
    this.nluProcessingDuration.labels(model).observe(durationMs / 1000);
  }

  /**
   * Record flow execution
   */
  recordFlowExecution(flowName: string, module: string = 'food') {
    this.flowExecutions.labels(flowName, module).inc();
  }

  /**
   * Record flow completion
   */
  recordFlowCompletion(
    flowName: string,
    status: 'completed' | 'abandoned' | 'error',
  ) {
    this.flowCompletions.labels(flowName, status).inc();
  }

  /**
   * Record flow state transition
   */
  recordFlowStateTransition(
    flowName: string,
    fromState: string,
    toState: string,
  ) {
    this.flowStateTransitions.labels(flowName, fromState, toState).inc();
  }

  /**
   * Record flow drop-off
   */
  recordFlowDropoff(
    flowName: string,
    state: string,
    reason: 'timeout' | 'user_cancel' | 'error' | 'unknown',
  ) {
    this.flowDropoffs.labels(flowName, state, reason).inc();
  }

  /**
   * Update active flow count
   */
  updateActiveFlowCount(flowName: string, module: string, count: number) {
    this.activeFlows.labels(flowName, module).set(count);
  }

  /**
   * Record flow duration
   */
  recordFlowDuration(flowName: string, durationMs: number) {
    this.flowDuration.labels(flowName).observe(durationMs / 1000);
  }

  /**
   * Record agent invocation
   */
  recordAgentInvocation(agentType: string, durationMs: number) {
    this.agentInvocations.labels(agentType).inc();
    this.agentLatency.labels(agentType).observe(durationMs / 1000);
  }

  /**
   * Record LLM token usage
   */
  recordTokenUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ) {
    this.llmTokensUsed.labels(model, 'input').inc(inputTokens);
    this.llmTokensUsed.labels(model, 'output').inc(outputTokens);
  }

  /**
   * Update active session count
   */
  updateActiveSessions(channel: string, count: number) {
    this.activeSessions.labels(channel).set(count);
  }

  /**
   * Create a timer for measuring operation duration
   */
  startTimer(): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const end = process.hrtime.bigint();
      return Number(end - start) / 1_000_000; // Return milliseconds
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // MCP CONVENIENCE METHODS
  // ═══════════════════════════════════════════════════════════════

  recordMcpToolCall(tool: string, durationMs: number, cached: boolean) {
    this.mcpToolCalls.labels(tool, String(cached)).inc();
    this.mcpToolDuration.labels(tool).observe(durationMs / 1000);
  }

  recordMcpToolError(tool: string, errorType: string) {
    this.mcpToolErrors.labels(tool, errorType).inc();
  }

  updateMcpSessions(transport: string, count: number) {
    this.mcpActiveSessions.labels(transport).set(count);
  }

  // ═══════════════════════════════════════════════════════════════
  // NLU CLASSIFICATION CONVENIENCE METHOD
  // ═══════════════════════════════════════════════════════════════

  recordNluClassification(
    intent: string,
    confidence: number,
    provider: string,
    language: string,
    durationMs: number,
  ) {
    this.intentClassifications.labels(intent, language).inc();
    this.intentConfidence.labels(intent).observe(confidence);
    this.nluProcessingDuration.labels(provider).observe(durationMs / 1000);
  }

  // ═══════════════════════════════════════════════════════════════
  // SELF-LEARNING CONVENIENCE METHOD
  // ═══════════════════════════════════════════════════════════════

  recordSelfLearningAction(action: string) {
    this.selfLearningActions.labels(action).inc();
  }
}
