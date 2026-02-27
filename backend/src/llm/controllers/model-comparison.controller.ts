import {
  Controller,
  Get,
  Query,
  Logger,
} from '@nestjs/common';
import { LlmUsageTrackingService } from '../services/llm-usage-tracking.service';
import { PrismaService } from '../../database/prisma.service';

export interface ModelComparisonMetrics {
  modelId: string;
  modelName: string;
  provider: string;
  metrics: {
    totalRequests: number;
    successRate: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgTotalTokens: number;
    totalCost: number;
    avgCostPerRequest: number;
    errorRate: number;
    timeoutRate: number;
  };
  trends: {
    dailyRequests: number[];
    dailyLatency: number[];
    dailyErrorRate: number[];
  };
  lastUsed: Date | null;
}

/**
 * Model Performance Comparison Controller
 * 
 * Provides endpoints for comparing LLM model performance:
 * - Response times (avg, p50, p95, p99)
 * - Success/error rates
 * - Token usage
 * - Cost efficiency
 * - Trend analysis
 */
@Controller('ai/models/comparison')
export class ModelComparisonController {
  private readonly logger = new Logger(ModelComparisonController.name);

  constructor(
    private readonly usageService: LlmUsageTrackingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get comparison of all models
   */
  @Get()
  async getModelComparison(
    @Query('days') days?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<{ success: boolean; models: ModelComparisonMetrics[] }> {
    const daysNum = parseInt(days || '7', 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const whereClause: any = {
      createdAt: { gte: startDate },
    };
    if (tenantId) {
      whereClause.tenantId = parseInt(tenantId, 10);
    }

    // Get all unique models with their metrics
    const modelStats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        model_id as "modelId",
        COALESCE(model_name, model_id) as "modelName",
        provider,
        COUNT(*) as "totalRequests",
        COUNT(*) FILTER (WHERE status = 'success') as "successCount",
        COUNT(*) FILTER (WHERE status = 'error') as "errorCount",
        COUNT(*) FILTER (WHERE status = 'timeout') as "timeoutCount",
        AVG(latency_ms) as "avgLatency",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as "p50Latency",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as "p95Latency",
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as "p99Latency",
        AVG(input_tokens) as "avgInputTokens",
        AVG(output_tokens) as "avgOutputTokens",
        AVG(total_tokens) as "avgTotalTokens",
        SUM(cost) as "totalCost",
        MAX(created_at) as "lastUsed"
      FROM llm_model_usage
      WHERE created_at >= ${startDate}
      GROUP BY model_id, model_name, provider
      ORDER BY COUNT(*) DESC
    `;

    // Get daily trends for each model
    const dailyStats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        model_id as "modelId",
        DATE(created_at) as "date",
        COUNT(*) as "requests",
        AVG(latency_ms) as "avgLatency",
        COUNT(*) FILTER (WHERE status != 'success')::float / NULLIF(COUNT(*), 0) as "errorRate"
      FROM llm_model_usage
      WHERE created_at >= ${startDate}
      GROUP BY model_id, DATE(created_at)
      ORDER BY DATE(created_at)
    `;

    // Build response
    const models: ModelComparisonMetrics[] = modelStats.map((stat) => {
      const modelDailyStats = dailyStats.filter(d => d.modelId === stat.modelId);
      
      return {
        modelId: stat.modelId,
        modelName: stat.modelName,
        provider: stat.provider,
        metrics: {
          totalRequests: Number(stat.totalRequests),
          successRate: stat.totalRequests > 0 
            ? Number(stat.successCount) / Number(stat.totalRequests) 
            : 0,
          avgLatencyMs: Math.round(Number(stat.avgLatency) || 0),
          p50LatencyMs: Math.round(Number(stat.p50Latency) || 0),
          p95LatencyMs: Math.round(Number(stat.p95Latency) || 0),
          p99LatencyMs: Math.round(Number(stat.p99Latency) || 0),
          avgInputTokens: Math.round(Number(stat.avgInputTokens) || 0),
          avgOutputTokens: Math.round(Number(stat.avgOutputTokens) || 0),
          avgTotalTokens: Math.round(Number(stat.avgTotalTokens) || 0),
          totalCost: Number(stat.totalCost) || 0,
          avgCostPerRequest: stat.totalRequests > 0 
            ? Number(stat.totalCost) / Number(stat.totalRequests)
            : 0,
          errorRate: stat.totalRequests > 0 
            ? Number(stat.errorCount) / Number(stat.totalRequests)
            : 0,
          timeoutRate: stat.totalRequests > 0 
            ? Number(stat.timeoutCount) / Number(stat.totalRequests)
            : 0,
        },
        trends: {
          dailyRequests: modelDailyStats.map(d => Number(d.requests)),
          dailyLatency: modelDailyStats.map(d => Math.round(Number(d.avgLatency) || 0)),
          dailyErrorRate: modelDailyStats.map(d => Number(d.errorRate) || 0),
        },
        lastUsed: stat.lastUsed,
      };
    });

    return { success: true, models };
  }

  /**
   * Get detailed comparison between two models
   */
  @Get('head-to-head')
  async getHeadToHead(
    @Query('model1') model1: string,
    @Query('model2') model2: string,
    @Query('days') days?: string,
  ): Promise<{
    success: boolean;
    comparison: {
      model1: ModelComparisonMetrics;
      model2: ModelComparisonMetrics;
      winner: {
        latency: string;
        cost: string;
        reliability: string;
        overall: string;
      };
      recommendation: string;
    };
  }> {
    if (!model1 || !model2) {
      return {
        success: false,
        comparison: null as any,
      };
    }

    const daysNum = parseInt(days || '7', 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const stats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        model_id as "modelId",
        COALESCE(model_name, model_id) as "modelName",
        provider,
        COUNT(*) as "totalRequests",
        COUNT(*) FILTER (WHERE status = 'success') as "successCount",
        COUNT(*) FILTER (WHERE status = 'error') as "errorCount",
        COUNT(*) FILTER (WHERE status = 'timeout') as "timeoutCount",
        AVG(latency_ms) as "avgLatency",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as "p50Latency",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as "p95Latency",
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as "p99Latency",
        AVG(input_tokens) as "avgInputTokens",
        AVG(output_tokens) as "avgOutputTokens",
        AVG(total_tokens) as "avgTotalTokens",
        SUM(cost) as "totalCost",
        MAX(created_at) as "lastUsed"
      FROM llm_model_usage
      WHERE created_at >= ${startDate}
        AND model_id IN (${model1}, ${model2})
      GROUP BY model_id, model_name, provider
    `;

    if (stats.length < 2) {
      return {
        success: false,
        comparison: null as any,
      };
    }

    const model1Stats = stats.find(s => s.modelId === model1);
    const model2Stats = stats.find(s => s.modelId === model2);

    const buildMetrics = (stat: any): ModelComparisonMetrics => ({
      modelId: stat.modelId,
      modelName: stat.modelName,
      provider: stat.provider,
      metrics: {
        totalRequests: Number(stat.totalRequests),
        successRate: Number(stat.successCount) / Number(stat.totalRequests),
        avgLatencyMs: Math.round(Number(stat.avgLatency)),
        p50LatencyMs: Math.round(Number(stat.p50Latency)),
        p95LatencyMs: Math.round(Number(stat.p95Latency)),
        p99LatencyMs: Math.round(Number(stat.p99Latency)),
        avgInputTokens: Math.round(Number(stat.avgInputTokens)),
        avgOutputTokens: Math.round(Number(stat.avgOutputTokens)),
        avgTotalTokens: Math.round(Number(stat.avgTotalTokens)),
        totalCost: Number(stat.totalCost),
        avgCostPerRequest: Number(stat.totalCost) / Number(stat.totalRequests),
        errorRate: Number(stat.errorCount) / Number(stat.totalRequests),
        timeoutRate: Number(stat.timeoutCount) / Number(stat.totalRequests),
      },
      trends: { dailyRequests: [], dailyLatency: [], dailyErrorRate: [] },
      lastUsed: stat.lastUsed,
    });

    const m1 = buildMetrics(model1Stats);
    const m2 = buildMetrics(model2Stats);

    // Determine winners for each category
    const latencyWinner = m1.metrics.avgLatencyMs <= m2.metrics.avgLatencyMs ? model1 : model2;
    const costWinner = m1.metrics.avgCostPerRequest <= m2.metrics.avgCostPerRequest ? model1 : model2;
    const reliabilityWinner = m1.metrics.successRate >= m2.metrics.successRate ? model1 : model2;
    
    // Overall winner (weighted scoring)
    const score1 = 
      (m1.metrics.successRate * 0.4) + 
      ((1000 - m1.metrics.avgLatencyMs) / 1000 * 0.3) + 
      ((0.01 - m1.metrics.avgCostPerRequest) / 0.01 * 0.3);
    const score2 = 
      (m2.metrics.successRate * 0.4) + 
      ((1000 - m2.metrics.avgLatencyMs) / 1000 * 0.3) + 
      ((0.01 - m2.metrics.avgCostPerRequest) / 0.01 * 0.3);
    
    const overallWinner = score1 >= score2 ? model1 : model2;

    // Generate recommendation
    let recommendation = '';
    if (overallWinner === model1) {
      recommendation = `${m1.modelName} is recommended overall. `;
    } else {
      recommendation = `${m2.modelName} is recommended overall. `;
    }
    
    if (latencyWinner !== overallWinner) {
      const fasterModel = latencyWinner === model1 ? m1.modelName : m2.modelName;
      recommendation += `Consider ${fasterModel} if latency is critical.`;
    }

    return {
      success: true,
      comparison: {
        model1: m1,
        model2: m2,
        winner: {
          latency: latencyWinner,
          cost: costWinner,
          reliability: reliabilityWinner,
          overall: overallWinner,
        },
        recommendation,
      },
    };
  }

  /**
   * Get summary statistics for dashboard
   */
  @Get('summary')
  async getSummary(
    @Query('days') days?: string,
  ): Promise<{
    success: boolean;
    summary: {
      totalRequests: number;
      totalCost: number;
      avgLatency: number;
      successRate: number;
      topModel: string;
      topProvider: string;
      modelsUsed: number;
      costByProvider: Record<string, number>;
      requestsByProvider: Record<string, number>;
    };
  }> {
    const daysNum = parseInt(days || '7', 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const [aggregate, providerStats, modelCount] = await Promise.all([
      this.prisma.llmModelUsage.aggregate({
        where: { createdAt: { gte: startDate } },
        _count: true,
        _sum: { cost: true, latencyMs: true },
        _avg: { latencyMs: true },
      }),
      this.prisma.llmModelUsage.groupBy({
        where: { createdAt: { gte: startDate } },
        by: ['provider'],
        _count: true,
        _sum: { cost: true },
      }),
      this.prisma.llmModelUsage.groupBy({
        where: { createdAt: { gte: startDate } },
        by: ['modelId'],
      }),
    ]);

    const successCount = await this.prisma.llmModelUsage.count({
      where: {
        createdAt: { gte: startDate },
        status: 'success',
      },
    });

    const topProvider = providerStats.sort((a, b) => (b._count || 0) - (a._count || 0))[0];
    
    const topModelResult = await this.prisma.llmModelUsage.groupBy({
      where: { createdAt: { gte: startDate } },
      by: ['modelId', 'modelName'],
      _count: true,
      orderBy: { _count: { modelId: 'desc' } },
      take: 1,
    });

    const costByProvider: Record<string, number> = {};
    const requestsByProvider: Record<string, number> = {};
    providerStats.forEach(p => {
      costByProvider[p.provider] = Number(p._sum?.cost || 0);
      requestsByProvider[p.provider] = p._count || 0;
    });

    return {
      success: true,
      summary: {
        totalRequests: aggregate._count || 0,
        totalCost: Number(aggregate._sum?.cost || 0),
        avgLatency: Math.round(Number(aggregate._avg?.latencyMs || 0)),
        successRate: aggregate._count ? successCount / aggregate._count : 0,
        topModel: topModelResult[0]?.modelName || topModelResult[0]?.modelId || 'N/A',
        topProvider: topProvider?.provider || 'N/A',
        modelsUsed: modelCount.length,
        costByProvider,
        requestsByProvider,
      },
    };
  }

  /**
   * Get cost analysis by purpose/channel
   */
  @Get('cost-analysis')
  async getCostAnalysis(
    @Query('days') days?: string,
    @Query('groupBy') groupBy: 'purpose' | 'channel' | 'model' = 'model',
  ): Promise<{
    success: boolean;
    analysis: Array<{
      group: string;
      requests: number;
      totalCost: number;
      avgCost: number;
      avgTokens: number;
    }>;
  }> {
    const daysNum = parseInt(days || '7', 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const byField = groupBy === 'purpose' ? 'purpose' : 
                    groupBy === 'channel' ? 'channel' : 'modelId';

    const stats = await this.prisma.llmModelUsage.groupBy({
      where: { createdAt: { gte: startDate } },
      by: [byField as any],
      _count: true,
      _sum: { cost: true, totalTokens: true },
      _avg: { cost: true, totalTokens: true },
    });

    const analysis = stats.map((s: any) => ({
      group: s[byField] || 'unknown',
      requests: s._count || 0,
      totalCost: Number(s._sum?.cost || 0),
      avgCost: Number(s._avg?.cost || 0),
      avgTokens: Math.round(Number(s._avg?.totalTokens || 0)),
    }));

    // Sort by total cost descending
    analysis.sort((a, b) => b.totalCost - a.totalCost);

    return { success: true, analysis };
  }
}
