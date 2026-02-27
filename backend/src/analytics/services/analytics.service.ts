import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ConversionFunnelService, FunnelMetrics } from './conversion-funnel.service';
import { IntentAccuracyService, IntentAccuracyReport } from './intent-accuracy.service';
import { ResponseTimeService, ResponseTimeReport } from './response-time.service';

/**
 * Main Analytics Service
 * 
 * Aggregates all analytics data and provides:
 * - Dashboard overview metrics
 * - Business KPIs (using conversation logs as proxy)
 * - Export functionality
 */

export interface DashboardOverview {
  // Business Metrics (from conversation data)
  conversationsToday: number;
  flowRunsToday: number;
  activeUsers: number;
  newUsers: number;
  
  // AI Performance
  messagesProcessed: number;
  averageResponseTime: number;
  intentAccuracy: number;
  
  // Funnel Summary
  conversionRate: number;
  topDropOffStage: string;
  psychologyLift: number;
  
  // Trends
  conversationsTrend: number; // % change from yesterday
  flowRunsTrend: number;
  responseTrend: number;
}

export interface TimeSeriesData {
  timestamp: Date;
  value: number;
}

export interface TopItem {
  id: string;
  name: string;
  count: number;
  category: string;
}

export interface FullAnalyticsReport {
  overview: DashboardOverview;
  funnel: FunnelMetrics;
  intentAccuracy: IntentAccuracyReport;
  responseTime: ResponseTimeReport;
  topIntents: TopItem[];
  hourlyConversations: TimeSeriesData[];
  generatedAt: Date;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly funnelService: ConversionFunnelService,
    private readonly intentService: IntentAccuracyService,
    private readonly responseTimeService: ResponseTimeService,
  ) {}

  /**
   * Get dashboard overview for quick glance
   */
  async getDashboardOverview(): Promise<DashboardOverview> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Get conversation counts from ConversationLog
      const conversationsToday = await this.prisma.conversationLog.count({
        where: {
          createdAt: { gte: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      const conversationsYesterday = await this.prisma.conversationLog.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      // Get flow runs
      const flowRunsToday = await this.prisma.flowRun.count({
        where: {
          startedAt: { gte: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      const flowRunsYesterday = await this.prisma.flowRun.count({
        where: {
          startedAt: { gte: yesterday, lt: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      // Get user counts
      const activeUsers = await this.prisma.user.count({
        where: {
          lastActiveAt: { gte: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      const newUsers = await this.prisma.user.count({
        where: {
          createdAt: { gte: today },
        },
      }).catch((err) => { this.logger.debug(`Query fallback: ${err.message}`); return 0; });

      // Get AI metrics
      const funnelMetrics = await this.funnelService.getFunnelMetrics('day');
      const responseTimeReport = await this.responseTimeService.getResponseTimeReport();
      const intentReport = await this.intentService.getAccuracyReport();

      // Calculate trends
      const conversationsTrend = conversationsYesterday > 0 
        ? ((conversationsToday - conversationsYesterday) / conversationsYesterday) * 100 
        : 0;
      const flowRunsTrend = flowRunsYesterday > 0 
        ? ((flowRunsToday - flowRunsYesterday) / flowRunsYesterday) * 100 
        : 0;

      return {
        conversationsToday,
        flowRunsToday,
        activeUsers,
        newUsers,
        messagesProcessed: intentReport.totalClassifications,
        averageResponseTime: Math.round(responseTimeReport.endToEnd.average),
        intentAccuracy: Math.round(intentReport.overallAccuracy * 10) / 10,
        conversionRate: Math.round(funnelMetrics.conversionRate * 10) / 10,
        topDropOffStage: funnelMetrics.topDropOffStage,
        psychologyLift: funnelMetrics.psychologyEffectiveness.lift,
        conversationsTrend: Math.round(conversationsTrend * 10) / 10,
        flowRunsTrend: Math.round(flowRunsTrend * 10) / 10,
        responseTrend: (() => {
          const avgToday = responseTimeReport.endToEnd.average;
          // Use p50 as baseline estimate for yesterday — if we have samples, trend is meaningful
          if (avgToday > 0 && responseTimeReport.endToEnd.sampleCount > 10) {
            // Positive = slower (worse), negative = faster (better)
            const baseline = responseTimeReport.endToEnd.p50;
            return baseline > 0 ? Math.round(((avgToday - baseline) / baseline) * 1000) / 10 : 0;
          }
          return 0;
        })(),
      };
    } catch (error) {
      this.logger.error(`Failed to get dashboard overview: ${error.message}`);
      return {
        conversationsToday: 0,
        flowRunsToday: 0,
        activeUsers: 0,
        newUsers: 0,
        messagesProcessed: 0,
        averageResponseTime: 0,
        intentAccuracy: 0,
        conversionRate: 0,
        topDropOffStage: 'unknown',
        psychologyLift: 0,
        conversationsTrend: 0,
        flowRunsTrend: 0,
        responseTrend: 0,
      };
    }
  }

  /**
   * Get full analytics report
   */
  async getFullReport(): Promise<FullAnalyticsReport> {
    const [overview, funnel, intentAccuracy, responseTime, topIntents, hourlyConversations] = 
      await Promise.all([
        this.getDashboardOverview(),
        this.funnelService.getFunnelMetrics('day'),
        this.intentService.getAccuracyReport(),
        this.responseTimeService.getResponseTimeReport(),
        this.getTopIntents(),
        this.getHourlyConversations(),
      ]);

    return {
      overview,
      funnel,
      intentAccuracy,
      responseTime,
      topIntents,
      hourlyConversations,
      generatedAt: new Date(),
    };
  }

  /**
   * Get top intents (from conversation logs)
   */
  async getTopIntents(limit: number = 10): Promise<TopItem[]> {
    try {
      // Get top intents using raw SQL for better reliability
      const results = await this.prisma.$queryRaw<{ intent: string; count: bigint }[]>`
        SELECT nlu_intent as intent, COUNT(*) as count
        FROM conversation_logs
        WHERE nlu_intent IS NOT NULL
        GROUP BY nlu_intent
        ORDER BY count DESC
        LIMIT ${limit}
      `.catch(() => []);

      return results.map(r => ({
        id: r.intent || 'unknown',
        name: r.intent || 'Unknown Intent',
        count: Number(r.count),
        category: 'intent',
      }));
    } catch (error) {
      this.logger.error(`Failed to get top intents: ${error.message}`);
      return [];
    }
  }

  /**
   * Get hourly conversation count for today
   */
  async getHourlyConversations(): Promise<TimeSeriesData[]> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const results = await this.prisma.$queryRaw<{ hour: number; count: bigint }[]>`
        SELECT 
          EXTRACT(HOUR FROM timestamp) as hour,
          COUNT(*) as count
        FROM conversation_logs
        WHERE timestamp >= ${today}
        GROUP BY EXTRACT(HOUR FROM timestamp)
        ORDER BY hour
      `.catch(() => []);

      // Fill in missing hours with 0
      const hourlyData: TimeSeriesData[] = [];
      const currentHour = new Date().getHours();
      
      for (let h = 0; h <= currentHour; h++) {
        const hourData = results.find(r => Number(r.hour) === h);
        const timestamp = new Date(today);
        timestamp.setHours(h);
        
        hourlyData.push({
          timestamp,
          value: hourData ? Number(hourData.count) : 0,
        });
      }

      return hourlyData;
    } catch (error) {
      this.logger.error(`Failed to get hourly conversations: ${error.message}`);
      return [];
    }
  }

  /**
   * Export analytics data as CSV
   */
  async exportToCSV(
    reportType: 'overview' | 'funnel' | 'intent' | 'response_time',
  ): Promise<string> {
    const report = await this.getFullReport();
    let csv = '';

    switch (reportType) {
      case 'overview':
        csv = 'Metric,Value\n';
        csv += `Conversations Today,${report.overview.conversationsToday}\n`;
        csv += `Flow Runs Today,${report.overview.flowRunsToday}\n`;
        csv += `Active Users,${report.overview.activeUsers}\n`;
        csv += `Conversion Rate,${report.overview.conversionRate}%\n`;
        csv += `Intent Accuracy,${report.overview.intentAccuracy}%\n`;
        csv += `Avg Response Time,${report.overview.averageResponseTime}ms\n`;
        break;
        
      case 'funnel':
        csv = 'Stage,Users,Percentage,Drop-off Rate\n';
        for (const stage of report.funnel.stages) {
          csv += `${stage.stage},${stage.count},${stage.percentage}%,${stage.dropOffRate}%\n`;
        }
        break;
        
      case 'intent':
        csv = 'Intent,Total,Correct,Accuracy,Avg Confidence\n';
        for (const intent of report.intentAccuracy.intentMetrics) {
          csv += `${intent.intent},${intent.totalClassifications},${intent.correctClassifications},${intent.accuracy.toFixed(1)}%,${intent.averageConfidence.toFixed(2)}\n`;
        }
        break;
        
      case 'response_time':
        csv = 'Component,P50 (ms),P95 (ms),P99 (ms),Average (ms)\n';
        csv += `End-to-End,${report.responseTime.endToEnd.p50},${report.responseTime.endToEnd.p95},${report.responseTime.endToEnd.p99},${report.responseTime.endToEnd.average.toFixed(0)}\n`;
        csv += `NLU,${report.responseTime.components.nlu.p50},${report.responseTime.components.nlu.p95},${report.responseTime.components.nlu.p99},${report.responseTime.components.nlu.average.toFixed(0)}\n`;
        csv += `LLM,${report.responseTime.components.llm.p50},${report.responseTime.components.llm.p95},${report.responseTime.components.llm.p99},${report.responseTime.components.llm.average.toFixed(0)}\n`;
        csv += `Search,${report.responseTime.components.search.p50},${report.responseTime.components.search.p95},${report.responseTime.components.search.p99},${report.responseTime.components.search.average.toFixed(0)}\n`;
        break;
    }

    return csv;
  }
}
