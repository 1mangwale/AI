import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * Conversion Funnel Service
 * 
 * Tracks user progression through commerce funnel:
 * 1. Browse - User is exploring (search, view items)
 * 2. Consider - User shows interest (view details, compare)
 * 3. Decide - User makes choice (add to cart)
 * 4. Checkout - User starts payment
 * 5. Purchase - Order completed
 * 
 * Also tracks psychology trigger effectiveness at each stage.
 */

export interface FunnelStage {
  stage: string;
  count: number;
  percentage: number;
  dropOffRate: number;
}

export interface FunnelMetrics {
  stages: FunnelStage[];
  totalUsers: number;
  conversionRate: number;
  averageTimeToConvert: number; // in minutes
  topDropOffStage: string;
  psychologyEffectiveness: {
    withTriggers: number;  // Conversion rate with psychology
    withoutTriggers: number; // Conversion rate without
    lift: number;  // % improvement
  };
}

export interface SessionFunnel {
  sessionId: string;
  userId?: number;
  stage: string;
  enteredAt: Date;
  psychologyTriggersShown: number;
  converted: boolean;
}

@Injectable()
export class ConversionFunnelService {
  private readonly logger = new Logger(ConversionFunnelService.name);

  // In-memory tracking for real-time (Redis for persistence)
  private readonly FUNNEL_KEY = 'analytics:funnel';
  private readonly STAGE_ORDER = ['browse', 'consider', 'decide', 'checkout', 'purchase'];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('✅ ConversionFunnelService initialized with shared Redis');
  }

  /**
   * Record user entering a funnel stage
   */
  async recordStageEntry(
    sessionId: string,
    stage: string,
    userId?: number,
    psychologyTriggersShown: number = 0,
  ): Promise<void> {
    const timestamp = Date.now();
    const key = `${this.FUNNEL_KEY}:${sessionId}`;
    
    try {
      // Get existing funnel data
      const existingData = await this.redis.get(key);
      const funnelData = existingData ? JSON.parse(existingData) : {
        sessionId,
        userId,
        stages: {},
        psychologyTriggersShown: 0,
        startedAt: timestamp,
      };

      // Update stage
      funnelData.stages[stage] = timestamp;
      funnelData.psychologyTriggersShown = Math.max(
        funnelData.psychologyTriggersShown, 
        psychologyTriggersShown
      );
      funnelData.currentStage = stage;
      
      // Save with 24h TTL
      await this.redis.setex(key, 86400, JSON.stringify(funnelData));

      // Increment stage counter
      await this.redis.incr(`${this.FUNNEL_KEY}:count:${stage}`);
      
      this.logger.debug(`Funnel: ${sessionId} entered ${stage}`);
    } catch (error) {
      this.logger.error(`Failed to record funnel stage: ${error.message}`);
    }
  }

  /**
   * Record conversion (purchase completed)
   */
  async recordConversion(
    sessionId: string,
    orderId: string,
    orderValue: number,
  ): Promise<void> {
    const key = `${this.FUNNEL_KEY}:${sessionId}`;
    
    try {
      const existingData = await this.redis.get(key);
      if (!existingData) {
        this.logger.warn(`No funnel data for session: ${sessionId}`);
        return;
      }

      const funnelData = JSON.parse(existingData);
      funnelData.converted = true;
      funnelData.orderId = orderId;
      funnelData.orderValue = orderValue;
      funnelData.convertedAt = Date.now();
      funnelData.timeToConvert = funnelData.convertedAt - funnelData.startedAt;

      await this.redis.setex(key, 86400, JSON.stringify(funnelData));
      
      // Track with/without psychology
      if (funnelData.psychologyTriggersShown > 0) {
        await this.redis.incr(`${this.FUNNEL_KEY}:converted:with_psychology`);
      } else {
        await this.redis.incr(`${this.FUNNEL_KEY}:converted:without_psychology`);
      }
      
      await this.redis.incr(`${this.FUNNEL_KEY}:total_conversions`);
      
      this.logger.log(`Conversion recorded: ${sessionId} → ${orderId} (₹${orderValue})`);
    } catch (error) {
      this.logger.error(`Failed to record conversion: ${error.message}`);
    }
  }

  /**
   * Get funnel metrics for dashboard
   */
  async getFunnelMetrics(timeRange: 'day' | 'week' | 'month' = 'day'): Promise<FunnelMetrics> {
    try {
      // Get stage counts
      const stageCounts: Record<string, number> = {};
      for (const stage of this.STAGE_ORDER) {
        const count = await this.redis.get(`${this.FUNNEL_KEY}:count:${stage}`);
        stageCounts[stage] = parseInt(count || '0', 10);
      }

      const totalUsers = stageCounts['browse'] || 1;
      
      // Build funnel stages with drop-off
      const stages: FunnelStage[] = this.STAGE_ORDER.map((stage, idx) => {
        const count = stageCounts[stage];
        const prevCount = idx > 0 ? stageCounts[this.STAGE_ORDER[idx - 1]] : totalUsers;
        const percentage = (count / totalUsers) * 100;
        const dropOffRate = prevCount > 0 ? ((prevCount - count) / prevCount) * 100 : 0;
        
        return {
          stage,
          count,
          percentage: Math.round(percentage * 10) / 10,
          dropOffRate: Math.round(dropOffRate * 10) / 10,
        };
      });

      // Find top drop-off stage
      const topDropOffStage = stages.reduce((max, stage) => 
        stage.dropOffRate > max.dropOffRate ? stage : max
      ).stage;

      // Get psychology effectiveness
      const withPsychCount = parseInt(
        await this.redis.get(`${this.FUNNEL_KEY}:converted:with_psychology`) || '0', 10
      );
      const withoutPsychCount = parseInt(
        await this.redis.get(`${this.FUNNEL_KEY}:converted:without_psychology`) || '0', 10
      );
      const totalConversions = parseInt(
        await this.redis.get(`${this.FUNNEL_KEY}:total_conversions`) || '0', 10
      );

      // Estimate users with/without psychology (simplified)
      const usersWithPsych = withPsychCount > 0 ? totalUsers * 0.7 : 0; // Assume 70% saw triggers
      const usersWithoutPsych = totalUsers - usersWithPsych;

      const withTriggersRate = usersWithPsych > 0 
        ? (withPsychCount / usersWithPsych) * 100 
        : 0;
      const withoutTriggersRate = usersWithoutPsych > 0 
        ? (withoutPsychCount / usersWithoutPsych) * 100 
        : 0;
      const lift = withoutTriggersRate > 0 
        ? ((withTriggersRate - withoutTriggersRate) / withoutTriggersRate) * 100 
        : 0;

      return {
        stages,
        totalUsers,
        conversionRate: (stageCounts['purchase'] / totalUsers) * 100,
        averageTimeToConvert: 0, // TODO: Calculate from Redis data
        topDropOffStage,
        psychologyEffectiveness: {
          withTriggers: Math.round(withTriggersRate * 10) / 10,
          withoutTriggers: Math.round(withoutTriggersRate * 10) / 10,
          lift: Math.round(lift * 10) / 10,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get funnel metrics: ${error.message}`);
      return {
        stages: [],
        totalUsers: 0,
        conversionRate: 0,
        averageTimeToConvert: 0,
        topDropOffStage: 'unknown',
        psychologyEffectiveness: {
          withTriggers: 0,
          withoutTriggers: 0,
          lift: 0,
        },
      };
    }
  }

  /**
   * Get real-time funnel visualization data
   */
  async getRealTimeFunnel(): Promise<{ stage: string; users: number; trend: 'up' | 'down' | 'stable' }[]> {
    const metrics = await this.getFunnelMetrics('day');
    
    return metrics.stages.map(stage => ({
      stage: stage.stage,
      users: stage.count,
      trend: stage.dropOffRate < 20 ? 'up' : stage.dropOffRate > 40 ? 'down' : 'stable',
    }));
  }
}
