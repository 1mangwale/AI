import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * Response Time Monitoring Service
 * 
 * Tracks latency across the system:
 * - End-to-end message processing time
 * - LLM provider latency (vLLM, Groq, OpenRouter)
 * - Search latency
 * - NLU classification latency
 * 
 * Stores percentiles (p50, p95, p99) for monitoring.
 */

export interface LatencyMetrics {
  component: string;
  p50: number;
  p95: number;
  p99: number;
  average: number;
  min: number;
  max: number;
  sampleCount: number;
}

export interface ProviderPerformance {
  provider: string;
  averageLatency: number;
  successRate: number;
  totalRequests: number;
  failedRequests: number;
  tokensPerSecond: number;
}

export interface ResponseTimeReport {
  endToEnd: LatencyMetrics;
  components: {
    nlu: LatencyMetrics;
    llm: LatencyMetrics;
    search: LatencyMetrics;
    database: LatencyMetrics;
  };
  llmProviders: ProviderPerformance[];
  slowestEndpoints: {
    endpoint: string;
    averageMs: number;
    callCount: number;
  }[];
  healthStatus: 'healthy' | 'degraded' | 'critical';
}

@Injectable()
export class ResponseTimeService {
  private readonly logger = new Logger(ResponseTimeService.name);
  private readonly METRICS_KEY = 'analytics:latency';

  // Thresholds for health status
  private readonly P95_THRESHOLD_HEALTHY = 3000; // 3s
  private readonly P95_THRESHOLD_DEGRADED = 5000; // 5s

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('✅ ResponseTimeService initialized with shared Redis');
  }

  /**
   * Record a latency measurement
   */
  async recordLatency(
    component: string,
    latencyMs: number,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      const timestamp = Date.now();
      const key = `${this.METRICS_KEY}:${component}:samples`;
      
      // Store sample (keep last 1000 per component)
      const entry = JSON.stringify({
        latency: latencyMs,
        timestamp,
        ...metadata,
      });
      await this.redis.lpush(key, entry);
      await this.redis.ltrim(key, 0, 999);
      
      // Update running stats
      await this.redis.incr(`${this.METRICS_KEY}:${component}:count`);
      
      const currentSum = parseFloat(
        await this.redis.get(`${this.METRICS_KEY}:${component}:sum`) || '0'
      );
      await this.redis.setex(
        `${this.METRICS_KEY}:${component}:sum`,
        86400, // 24h TTL
        (currentSum + latencyMs).toString()
      );
      
      // Track min/max
      const currentMin = parseFloat(
        await this.redis.get(`${this.METRICS_KEY}:${component}:min`) || String(Number.MAX_VALUE)
      );
      const currentMax = parseFloat(
        await this.redis.get(`${this.METRICS_KEY}:${component}:max`) || '0'
      );
      
      if (latencyMs < currentMin) {
        await this.redis.set(`${this.METRICS_KEY}:${component}:min`, latencyMs.toString());
      }
      if (latencyMs > currentMax) {
        await this.redis.set(`${this.METRICS_KEY}:${component}:max`, latencyMs.toString());
      }
      
    } catch (error) {
      this.logger.error(`Failed to record latency: ${error.message}`);
    }
  }

  /**
   * Record LLM provider request
   */
  async recordLLMRequest(
    provider: string,
    latencyMs: number,
    success: boolean,
    tokens?: number,
  ): Promise<void> {
    try {
      const key = `${this.METRICS_KEY}:llm:${provider}`;
      
      await this.redis.incr(`${key}:total`);
      if (!success) {
        await this.redis.incr(`${key}:failed`);
      }
      
      if (success) {
        // Track latency only for successful requests
        await this.recordLatency(`llm:${provider}`, latencyMs);
        
        // Track tokens per second
        if (tokens && latencyMs > 0) {
          const tps = (tokens / latencyMs) * 1000;
          const currentTpsSum = parseFloat(
            await this.redis.get(`${key}:tps_sum`) || '0'
          );
          const currentTpsCount = parseInt(
            await this.redis.get(`${key}:tps_count`) || '0', 10
          );
          await this.redis.set(`${key}:tps_sum`, (currentTpsSum + tps).toString());
          await this.redis.set(`${key}:tps_count`, (currentTpsCount + 1).toString());
        }
      }
    } catch (error) {
      this.logger.error(`Failed to record LLM request: ${error.message}`);
    }
  }

  /**
   * Get latency metrics for a component
   */
  async getLatencyMetrics(component: string): Promise<LatencyMetrics> {
    try {
      const key = `${this.METRICS_KEY}:${component}:samples`;
      const samples = await this.redis.lrange(key, 0, 999);
      
      if (samples.length === 0) {
        return {
          component,
          p50: 0,
          p95: 0,
          p99: 0,
          average: 0,
          min: 0,
          max: 0,
          sampleCount: 0,
        };
      }
      
      const latencies = samples
        .map(s => JSON.parse(s).latency)
        .filter(l => typeof l === 'number')
        .sort((a, b) => a - b);
      
      const count = latencies.length;
      
      return {
        component,
        p50: latencies[Math.floor(count * 0.5)] || 0,
        p95: latencies[Math.floor(count * 0.95)] || 0,
        p99: latencies[Math.floor(count * 0.99)] || 0,
        average: latencies.reduce((a, b) => a + b, 0) / count,
        min: latencies[0],
        max: latencies[count - 1],
        sampleCount: count,
      };
    } catch (error) {
      this.logger.error(`Failed to get latency metrics: ${error.message}`);
      return {
        component,
        p50: 0,
        p95: 0,
        p99: 0,
        average: 0,
        min: 0,
        max: 0,
        sampleCount: 0,
      };
    }
  }

  /**
   * Get full response time report
   */
  async getResponseTimeReport(): Promise<ResponseTimeReport> {
    try {
      // Get component metrics
      const endToEnd = await this.getLatencyMetrics('end_to_end');
      const nlu = await this.getLatencyMetrics('nlu');
      const llm = await this.getLatencyMetrics('llm');
      const search = await this.getLatencyMetrics('search');
      const database = await this.getLatencyMetrics('database');
      
      // Get LLM provider performance
      const providers = ['vllm', 'groq', 'openrouter', 'huggingface'];
      const llmProviders: ProviderPerformance[] = [];
      
      for (const provider of providers) {
        const key = `${this.METRICS_KEY}:llm:${provider}`;
        const total = parseInt(
          await this.redis.get(`${key}:total`) || '0', 10
        );
        
        if (total > 0) {
          const failed = parseInt(
            await this.redis.get(`${key}:failed`) || '0', 10
          );
          const metrics = await this.getLatencyMetrics(`llm:${provider}`);
          const tpsSum = parseFloat(
            await this.redis.get(`${key}:tps_sum`) || '0'
          );
          const tpsCount = parseInt(
            await this.redis.get(`${key}:tps_count`) || '1', 10
          );
          
          llmProviders.push({
            provider,
            averageLatency: metrics.average,
            successRate: ((total - failed) / total) * 100,
            totalRequests: total,
            failedRequests: failed,
            tokensPerSecond: tpsSum / tpsCount,
          });
        }
      }
      
      // Sort by average latency
      llmProviders.sort((a, b) => a.averageLatency - b.averageLatency);
      
      // Determine health status
      let healthStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
      if (endToEnd.p95 > this.P95_THRESHOLD_DEGRADED) {
        healthStatus = 'critical';
      } else if (endToEnd.p95 > this.P95_THRESHOLD_HEALTHY) {
        healthStatus = 'degraded';
      }
      
      return {
        endToEnd,
        components: {
          nlu,
          llm,
          search,
          database,
        },
        llmProviders,
        slowestEndpoints: [], // TODO: Track by endpoint
        healthStatus,
      };
    } catch (error) {
      this.logger.error(`Failed to get response time report: ${error.message}`);
      return {
        endToEnd: { component: 'end_to_end', p50: 0, p95: 0, p99: 0, average: 0, min: 0, max: 0, sampleCount: 0 },
        components: {
          nlu: { component: 'nlu', p50: 0, p95: 0, p99: 0, average: 0, min: 0, max: 0, sampleCount: 0 },
          llm: { component: 'llm', p50: 0, p95: 0, p99: 0, average: 0, min: 0, max: 0, sampleCount: 0 },
          search: { component: 'search', p50: 0, p95: 0, p99: 0, average: 0, min: 0, max: 0, sampleCount: 0 },
          database: { component: 'database', p50: 0, p95: 0, p99: 0, average: 0, min: 0, max: 0, sampleCount: 0 },
        },
        llmProviders: [],
        slowestEndpoints: [],
        healthStatus: 'healthy',
      };
    }
  }

  /**
   * Get real-time latency for monitoring
   */
  async getRealTimeLatency(): Promise<{ component: string; current: number; trend: 'up' | 'down' | 'stable' }[]> {
    const components = ['end_to_end', 'nlu', 'llm', 'search'];
    const results: { component: string; current: number; trend: 'up' | 'down' | 'stable' }[] = [];
    
    for (const component of components) {
      const metrics = await this.getLatencyMetrics(component);
      
      // Determine trend based on p50 vs average
      let trend: 'up' | 'down' | 'stable' = 'stable';
      if (metrics.p50 > metrics.average * 1.2) {
        trend = 'up'; // Getting slower
      } else if (metrics.p50 < metrics.average * 0.8) {
        trend = 'down'; // Getting faster
      }
      
      results.push({
        component,
        current: Math.round(metrics.p50),
        trend,
      });
    }
    
    return results;
  }
}
