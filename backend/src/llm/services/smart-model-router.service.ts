import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

/**
 * 🧠 Smart Model Router
 * 
 * Routes LLM requests to optimal model based on:
 * - Query complexity (simple greeting vs complex reasoning)
 * - Cost constraints (tenant budget, per-request limits)
 * - Quality requirements (high accuracy vs fast response)
 * - Model availability (failover, circuit breaker)
 * - Historical performance (latency, success rate)
 * 
 * Model Tiers:
 * - Tier 1 (Fast/Cheap): Qwen 7B, Phi-2 - for simple queries
 * - Tier 2 (Balanced): Qwen 32B, Mixtral - for moderate complexity
 * - Tier 3 (Quality): GPT-4, Claude - for complex reasoning
 * 
 * Routing Strategy:
 * - cost_optimized: Prefer cheaper models, only upgrade when needed
 * - quality_first: Prefer best models, fallback to cheaper if budget exceeded
 * - balanced: Balance cost and quality based on query complexity
 * - latency_optimized: Prefer fastest responding models
 */

export interface RoutingDecision {
  modelId: string;
  modelName: string;
  provider: string;
  endpoint: string;
  tier: number;
  estimatedCost: number;
  estimatedLatencyMs: number;
  reason: string;
  fallbackModels: string[];
}

export interface RoutingContext {
  query: string;
  intentConfidence?: number;
  intentType?: string;
  tenantId?: number;
  userId?: string;
  priority?: 'fast' | 'quality' | 'balanced';
  maxCost?: number;
  maxLatencyMs?: number;
  taskType?: 'extraction' | 'analysis' | 'creative' | 'reasoning' | 'classification' | 'generation';
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  tier: number;
  costPer1kTokens: number;
  avgLatencyMs: number;
  successRate: number;
  capabilities: string[];
  maxTokens: number;
  isActive: boolean;
  circuitBreakerOpen: boolean;
}

@Injectable()
export class SmartModelRouterService implements OnModuleInit {
  private readonly logger = new Logger(SmartModelRouterService.name);
  private pool: Pool;
  private modelProfiles: Map<string, ModelProfile> = new Map();
  private circuitBreakers: Map<string, { failures: number; openUntil: Date | null }> = new Map();

  // Default model profiles (loaded from DB in production)
  private readonly defaultProfiles: ModelProfile[] = [
    {
      id: 'qwen-local',
      name: this.configService.get<string>('VLLM_MODEL') || 'Qwen3.5-4B-AWQ',
      provider: 'vllm',
      endpoint: this.configService.get<string>('VLLM_CHAT_ENDPOINT') || `${this.configService.get<string>('VLLM_URL')}/v1/chat/completions`,
      tier: 1,
      costPer1kTokens: 0.0, // Free — local GPU
      avgLatencyMs: 300,
      successRate: 0.96,
      capabilities: ['general', 'hinglish', 'greeting', 'extraction', 'classification', 'function_calling'],
      maxTokens: 4096,
      isActive: true,
      circuitBreakerOpen: false,
    },
    {
      id: 'groq-mixtral',
      name: 'Mixtral 8x7B (Groq)',
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      tier: 2,
      costPer1kTokens: 0.003,
      avgLatencyMs: 150,
      successRate: 0.99,
      capabilities: ['general', 'reasoning', 'fast'],
      maxTokens: 32768,
      isActive: true,
      circuitBreakerOpen: false,
    },
    {
      id: 'openai-gpt4',
      name: 'GPT-4 Turbo',
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      tier: 3,
      costPer1kTokens: 0.03,
      avgLatencyMs: 800,
      successRate: 0.995,
      capabilities: ['general', 'reasoning', 'complex', 'function_calling'],
      maxTokens: 128000,
      isActive: true,
      circuitBreakerOpen: false,
    },
    {
      id: 'anthropic-claude',
      name: 'Claude 3 Sonnet',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      tier: 3,
      costPer1kTokens: 0.015,
      avgLatencyMs: 600,
      successRate: 0.995,
      capabilities: ['general', 'reasoning', 'complex', 'safety'],
      maxTokens: 200000,
      isActive: false, // Enable when key is added
      circuitBreakerOpen: false,
    },
    {
      id: 'gemini-flash',
      name: 'Gemini 2.0 Flash',
      provider: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      tier: 1,
      costPer1kTokens: 0.0005,
      avgLatencyMs: 300,
      successRate: 0.98,
      capabilities: ['general', 'vision', 'fast', 'extraction', 'classification'],
      maxTokens: 1048576,
      isActive: false, // Enable when key is added
      circuitBreakerOpen: false,
    },
    {
      id: 'gemini-pro',
      name: 'Gemini 1.5 Pro',
      provider: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      tier: 2,
      costPer1kTokens: 0.003,
      avgLatencyMs: 500,
      successRate: 0.97,
      capabilities: ['general', 'vision', 'reasoning', 'analysis', 'generation'],
      maxTokens: 2097152,
      isActive: false,
      circuitBreakerOpen: false,
    },
    {
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1',
      tier: 1,
      costPer1kTokens: 0.0002,
      avgLatencyMs: 400,
      successRate: 0.96,
      capabilities: ['general', 'analysis', 'extraction', 'classification'],
      maxTokens: 65536,
      isActive: false,
      circuitBreakerOpen: false,
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1',
      tier: 2,
      costPer1kTokens: 0.001,
      avgLatencyMs: 800,
      successRate: 0.95,
      capabilities: ['reasoning', 'analysis', 'complex'],
      maxTokens: 65536,
      isActive: false,
      circuitBreakerOpen: false,
    },
    {
      id: 'grok-mini',
      name: 'Grok 3 Mini',
      provider: 'grok',
      endpoint: 'https://api.x.ai/v1',
      tier: 1,
      costPer1kTokens: 0.0004,
      avgLatencyMs: 350,
      successRate: 0.97,
      capabilities: ['general', 'fast', 'extraction', 'creative'],
      maxTokens: 131072,
      isActive: false,
      circuitBreakerOpen: false,
    },
    {
      id: 'grok-3',
      name: 'Grok 3',
      provider: 'grok',
      endpoint: 'https://api.x.ai/v1',
      tier: 3,
      costPer1kTokens: 0.009,
      avgLatencyMs: 600,
      successRate: 0.97,
      capabilities: ['general', 'reasoning', 'creative', 'complex', 'generation'],
      maxTokens: 131072,
      isActive: false,
      circuitBreakerOpen: false,
    },
  ];

  constructor(private readonly configService: ConfigService) {
    this.logger.log('🧠 SmartModelRouterService initializing...');
  }

  async onModuleInit() {
    const databaseUrl = this.configService.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@mangwale_postgres:5432/headless_mangwale?schema=public';

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
    });

    try {
      const client = await this.pool.connect();

      // Create model routing tables
      await client.query(`
        -- Model performance metrics
        CREATE TABLE IF NOT EXISTS model_performance (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          model_id VARCHAR(50) NOT NULL,
          request_count INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          total_cost DECIMAL(10, 6) DEFAULT 0,
          avg_latency_ms INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          last_updated TIMESTAMP DEFAULT NOW(),
          UNIQUE(model_id)
        );

        CREATE INDEX IF NOT EXISTS idx_model_perf_model ON model_performance(model_id);

        -- Routing decisions log for analysis
        CREATE TABLE IF NOT EXISTS routing_decisions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id INTEGER,
          user_id VARCHAR(100),
          model_id VARCHAR(50) NOT NULL,
          query_complexity VARCHAR(20),
          priority VARCHAR(20),
          decision_reason TEXT,
          actual_latency_ms INTEGER,
          actual_cost DECIMAL(10, 6),
          was_successful BOOLEAN,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_routing_tenant ON routing_decisions(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_routing_model ON routing_decisions(model_id);
        CREATE INDEX IF NOT EXISTS idx_routing_created ON routing_decisions(created_at);

        -- Tenant model preferences
        CREATE TABLE IF NOT EXISTS tenant_model_preferences (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id INTEGER NOT NULL,
          strategy VARCHAR(30) DEFAULT 'balanced', -- cost_optimized, quality_first, balanced, latency_optimized
          max_cost_per_request DECIMAL(10, 6) DEFAULT 0.1,
          max_daily_cost DECIMAL(10, 2) DEFAULT 10.0,
          preferred_models TEXT[], -- Array of model IDs in preference order
          blocked_models TEXT[], -- Models to never use
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tenant_id)
        );
      `);

      client.release();

      // Load model profiles
      this.loadDefaultProfiles();

      this.logger.log('✅ SmartModelRouterService initialized');
    } catch (error: any) {
      this.logger.error(`❌ Failed to initialize: ${error.message}`);
      this.loadDefaultProfiles();
    }
  }

  private loadDefaultProfiles(): void {
    this.modelProfiles.clear();
    for (const profile of this.defaultProfiles) {
      this.modelProfiles.set(profile.id, profile);
      this.circuitBreakers.set(profile.id, { failures: 0, openUntil: null });
    }
  }

  /**
   * Route a request to the optimal model
   */
  async routeRequest(context: RoutingContext): Promise<RoutingDecision> {
    const complexity = this.analyzeComplexity(context);
    const strategy = await this.getTenantStrategy(context.tenantId);
    const availableModels = this.getAvailableModels(strategy.blockedModels);

    // If taskType is specified, filter by capability first
    if (context.taskType) {
      const capableModel = this.selectByCapability(availableModels, context.taskType, context);
      if (capableModel) {
        return {
          modelId: capableModel.id,
          modelName: capableModel.name,
          provider: capableModel.provider,
          endpoint: capableModel.endpoint,
          tier: capableModel.tier,
          estimatedCost: this.estimateCost(capableModel, context.query),
          estimatedLatencyMs: capableModel.avgLatencyMs,
          reason: `Task-type routing: Selected ${capableModel.name} for ${context.taskType} task`,
          fallbackModels: this.getFallbackModels(capableModel, availableModels).map(m => m.id),
        };
      }
    }

    let selectedModel: ModelProfile | null = null;
    let reason = '';

    switch (strategy.strategy) {
      case 'cost_optimized':
        selectedModel = this.selectCostOptimized(availableModels, complexity, context);
        reason = `Cost-optimized: Selected ${selectedModel?.name} for ${complexity} complexity query`;
        break;

      case 'quality_first':
        selectedModel = this.selectQualityFirst(availableModels, complexity, context);
        reason = `Quality-first: Selected ${selectedModel?.name} for best accuracy`;
        break;

      case 'latency_optimized':
        selectedModel = this.selectLatencyOptimized(availableModels, complexity, context);
        reason = `Latency-optimized: Selected ${selectedModel?.name} for fastest response`;
        break;

      case 'balanced':
      default:
        selectedModel = this.selectBalanced(availableModels, complexity, context);
        reason = `Balanced: Selected ${selectedModel?.name} for ${complexity} complexity query`;
        break;
    }

    if (!selectedModel) {
      // Fallback to first available
      selectedModel = availableModels[0];
      reason = 'Fallback: No suitable model found, using default';
    }

    // Get fallback models
    const fallbacks = this.getFallbackModels(selectedModel, availableModels);

    return {
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      provider: selectedModel.provider,
      endpoint: selectedModel.endpoint,
      tier: selectedModel.tier,
      estimatedCost: this.estimateCost(selectedModel, context.query),
      estimatedLatencyMs: selectedModel.avgLatencyMs,
      reason,
      fallbackModels: fallbacks.map(m => m.id),
    };
  }

  /**
   * Analyze query complexity
   */
  private analyzeComplexity(context: RoutingContext): 'simple' | 'moderate' | 'complex' {
    const { query, intentConfidence, intentType } = context;

    // Simple queries
    if (intentConfidence && intentConfidence > 0.9) {
      if (['greeting', 'goodbye', 'thanks', 'menu'].includes(intentType || '')) {
        return 'simple';
      }
    }

    // Complex queries
    const complexIndicators = [
      query.length > 200,
      query.includes('compare'),
      query.includes('explain'),
      query.includes('why'),
      query.includes('how'),
      query.includes('recommend'),
      /\d+.*options?|choose.*from/i.test(query),
    ];

    if (complexIndicators.filter(Boolean).length >= 2) {
      return 'complex';
    }

    // Check for reasoning requirements
    if (intentConfidence && intentConfidence < 0.7) {
      return 'complex'; // Unclear intent needs better model
    }

    return 'moderate';
  }

  /**
   * Get tenant's routing strategy
   */
  private async getTenantStrategy(tenantId?: number): Promise<{
    strategy: string;
    maxCost: number;
    blockedModels: string[];
    preferredModels: string[];
  }> {
    if (!tenantId) {
      return {
        strategy: 'balanced',
        maxCost: 0.1,
        blockedModels: [],
        preferredModels: [],
      };
    }

    try {
      const result = await this.pool.query(
        `SELECT strategy, max_cost_per_request, blocked_models, preferred_models
         FROM tenant_model_preferences WHERE tenant_id = $1`,
        [tenantId],
      );

      if (result.rows.length > 0) {
        return {
          strategy: result.rows[0].strategy,
          maxCost: parseFloat(result.rows[0].max_cost_per_request),
          blockedModels: result.rows[0].blocked_models || [],
          preferredModels: result.rows[0].preferred_models || [],
        };
      }
    } catch (error) {
      // Use defaults
    }

    return {
      strategy: 'balanced',
      maxCost: 0.1,
      blockedModels: [],
      preferredModels: [],
    };
  }

  /**
   * Get available models (not blocked, circuit breaker closed)
   */
  private getAvailableModels(blockedModels: string[]): ModelProfile[] {
    const available: ModelProfile[] = [];

    for (const [id, profile] of this.modelProfiles) {
      if (!profile.isActive) continue;
      if (blockedModels.includes(id)) continue;

      // Check circuit breaker
      const cb = this.circuitBreakers.get(id);
      if (cb?.openUntil && cb.openUntil > new Date()) continue;

      available.push(profile);
    }

    return available.sort((a, b) => a.tier - b.tier);
  }

  /**
   * Cost-optimized selection
   */
  private selectCostOptimized(
    models: ModelProfile[],
    complexity: string,
    context: RoutingContext,
  ): ModelProfile | null {
    // Start with cheapest tier that can handle complexity
    const minTier = complexity === 'complex' ? 2 : 1;

    const filtered = models.filter(m => m.tier >= minTier);
    filtered.sort((a, b) => a.costPer1kTokens - b.costPer1kTokens);

    // Check cost constraints
    for (const model of filtered) {
      const estimatedCost = this.estimateCost(model, context.query);
      if (!context.maxCost || estimatedCost <= context.maxCost) {
        return model;
      }
    }

    return filtered[0] || null;
  }

  /**
   * Quality-first selection
   */
  private selectQualityFirst(
    models: ModelProfile[],
    complexity: string,
    context: RoutingContext,
  ): ModelProfile | null {
    // Start with highest tier
    const sorted = [...models].sort((a, b) => b.tier - a.tier);

    // For complex queries, prefer tier 3
    if (complexity === 'complex') {
      const tier3 = sorted.find(m => m.tier === 3);
      if (tier3) return tier3;
    }

    return sorted[0] || null;
  }

  /**
   * Latency-optimized selection
   */
  private selectLatencyOptimized(
    models: ModelProfile[],
    complexity: string,
    context: RoutingContext,
  ): ModelProfile | null {
    const minTier = complexity === 'complex' ? 2 : 1;
    const filtered = models.filter(m => m.tier >= minTier);

    filtered.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);

    // Check latency constraints
    for (const model of filtered) {
      if (!context.maxLatencyMs || model.avgLatencyMs <= context.maxLatencyMs) {
        return model;
      }
    }

    return filtered[0] || null;
  }

  /**
   * Balanced selection
   */
  private selectBalanced(
    models: ModelProfile[],
    complexity: string,
    context: RoutingContext,
  ): ModelProfile | null {
    // Calculate score for each model
    const scored = models.map(model => {
      let score = 0;

      // Tier match bonus
      const targetTier = complexity === 'simple' ? 1 : complexity === 'moderate' ? 2 : 3;
      score += (3 - Math.abs(model.tier - targetTier)) * 10;

      // Success rate bonus
      score += model.successRate * 50;

      // Cost penalty (normalized)
      score -= model.costPer1kTokens * 100;

      // Latency penalty (normalized)
      score -= (model.avgLatencyMs / 1000) * 10;

      return { model, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.model || null;
  }

  /**
   * Get fallback models
   */
  private getFallbackModels(selected: ModelProfile, available: ModelProfile[]): ModelProfile[] {
    return available
      .filter(m => m.id !== selected.id)
      .sort((a, b) => {
        // Prefer same tier, then lower tier, then higher tier
        const tierDiffA = Math.abs(a.tier - selected.tier);
        const tierDiffB = Math.abs(b.tier - selected.tier);
        return tierDiffA - tierDiffB;
      })
      .slice(0, 3);
  }

  /**
   * Estimate cost for a query
   */
  private estimateCost(model: ModelProfile, query: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    const inputTokens = Math.ceil(query.length / 4);
    const outputTokens = 500; // Assume average output

    return ((inputTokens + outputTokens) / 1000) * model.costPer1kTokens;
  }

  /**
   * Record routing decision outcome
   */
  async recordOutcome(
    modelId: string,
    tenantId: number | undefined,
    latencyMs: number,
    cost: number,
    success: boolean,
    complexity: string,
    reason: string,
  ): Promise<void> {
    try {
      // Update model performance
      await this.pool.query(
        `INSERT INTO model_performance (model_id, request_count, total_tokens, total_cost, avg_latency_ms, success_count, failure_count)
         VALUES ($1, 1, 0, $2, $3, $4, $5)
         ON CONFLICT (model_id) DO UPDATE SET
           request_count = model_performance.request_count + 1,
           total_cost = model_performance.total_cost + $2,
           avg_latency_ms = (model_performance.avg_latency_ms * model_performance.request_count + $3) / (model_performance.request_count + 1),
           success_count = model_performance.success_count + $4,
           failure_count = model_performance.failure_count + $5,
           last_updated = NOW()`,
        [modelId, cost, latencyMs, success ? 1 : 0, success ? 0 : 1],
      );

      // Log routing decision
      await this.pool.query(
        `INSERT INTO routing_decisions (tenant_id, model_id, query_complexity, decision_reason, actual_latency_ms, actual_cost, was_successful)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, modelId, complexity, reason, latencyMs, cost, success],
      );

      // Update circuit breaker
      if (!success) {
        this.handleFailure(modelId);
      } else {
        this.handleSuccess(modelId);
      }
    } catch (error: any) {
      this.logger.error(`Failed to record outcome: ${error.message}`);
    }
  }

  /**
   * Handle model failure (circuit breaker)
   */
  private handleFailure(modelId: string): void {
    const cb = this.circuitBreakers.get(modelId);
    if (cb) {
      cb.failures++;
      if (cb.failures >= 5) {
        // Open circuit breaker for 60 seconds
        cb.openUntil = new Date(Date.now() + 60000);
        this.logger.warn(`⚠️ Circuit breaker opened for ${modelId}`);
      }
    }
  }

  /**
   * Handle model success (reset circuit breaker)
   */
  private handleSuccess(modelId: string): void {
    const cb = this.circuitBreakers.get(modelId);
    if (cb) {
      cb.failures = Math.max(0, cb.failures - 1);
      cb.openUntil = null;
    }
  }

  /**
   * Select model based on task type capabilities
   */
  selectByCapability(
    models: ModelProfile[],
    taskType: string,
    context: RoutingContext,
  ): ModelProfile | null {
    // Filter models that have the required capability
    const capable = models.filter(m => m.capabilities.includes(taskType));

    if (capable.length === 0) {
      // Fallback to general capability
      return models.filter(m => m.capabilities.includes('general'))[0] || null;
    }

    // Use balanced selection among capable models
    const complexity = this.analyzeComplexity(context);
    return this.selectBalanced(capable, complexity, context);
  }

  /**
   * Get all model profiles with current status
   */
  getModelProfiles(): Array<ModelProfile & { circuitBreakerStatus: { failures: number; openUntil: Date | null } }> {
    return Array.from(this.modelProfiles.values()).map(profile => ({
      ...profile,
      circuitBreakerStatus: this.circuitBreakers.get(profile.id) || { failures: 0, openUntil: null },
    }));
  }

  /**
   * Get routing statistics
   */
  async getStats(): Promise<{
    modelUsage: Array<{ modelId: string; requests: number; avgLatency: number; successRate: number }>;
    costByTenant: Array<{ tenantId: number; totalCost: number }>;
    routingDecisions: Array<{ complexity: string; count: number }>;
  }> {
    try {
      const modelUsage = await this.pool.query(
        `SELECT model_id, request_count, avg_latency_ms,
                CASE WHEN request_count > 0 
                     THEN success_count::float / request_count 
                     ELSE 0 END as success_rate
         FROM model_performance
         ORDER BY request_count DESC`,
      );

      const costByTenant = await this.pool.query(
        `SELECT tenant_id, SUM(actual_cost) as total_cost
         FROM routing_decisions
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY tenant_id
         ORDER BY total_cost DESC
         LIMIT 20`,
      );

      const routingDecisions = await this.pool.query(
        `SELECT query_complexity, COUNT(*) as count
         FROM routing_decisions
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY query_complexity`,
      );

      return {
        modelUsage: modelUsage.rows.map(r => ({
          modelId: r.model_id,
          requests: parseInt(r.request_count),
          avgLatency: parseInt(r.avg_latency_ms),
          successRate: parseFloat((parseFloat(r.success_rate) * 100).toFixed(2)),
        })),
        costByTenant: costByTenant.rows.map(r => ({
          tenantId: r.tenant_id,
          totalCost: parseFloat(r.total_cost),
        })),
        routingDecisions: routingDecisions.rows.map(r => ({
          complexity: r.query_complexity,
          count: parseInt(r.count),
        })),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get stats: ${error.message}`);
      return {
        modelUsage: [],
        costByTenant: [],
        routingDecisions: [],
      };
    }
  }
}
