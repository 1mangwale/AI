import { Controller, Get, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { GamificationSettingsService } from '../services/gamification-settings.service';
import { GameRewardService } from '../services/game-reward.service';
import { TrainingSampleService } from '../services/training-sample.service';

/**
 * Gamification Stats Controller
 * 
 * Endpoints:
 * - GET /api/gamification/stats - Get dashboard statistics
 */
@Controller('gamification/stats')
export class GamificationStatsController {
  private readonly logger = new Logger(GamificationStatsController.name);

  constructor(
    private readonly settingsService: GamificationSettingsService,
    private readonly rewardService: GameRewardService,
    private readonly trainingSampleService: TrainingSampleService,
  ) {}

  /**
   * GET /api/gamification/stats
   * Returns comprehensive dashboard statistics
   */
  @Get()
  async getStats() {
    try {
      this.logger.log('📈 [GET /api/gamification/stats] Fetching dashboard statistics');
      const startTime = Date.now();

      // Fetch all stats in parallel for performance
      const [
        trainingSampleStats,
        systemEnabled,
        minConfidence,
      ] = await Promise.all([
        this.trainingSampleService.getTrainingSampleStats(),
        this.settingsService.getSetting('game_system_enabled'),
        this.settingsService.getSetting('min_confidence_auto_save'),
      ]);

      // Calculate auto-approval rate
      const autoApprovedCount = trainingSampleStats.autoApproved || 0;
      const totalApproved = trainingSampleStats.approved || 0;
      const autoApprovalRate = totalApproved > 0 
        ? ((autoApprovedCount / totalApproved) * 100).toFixed(1)
        : '0.0';

      // Calculate average confidence from approved samples
      const avgConfidence = await this.calculateAverageConfidence();

      return {
        success: true,
        data: {
          // Game statistics
          gamesPlayed: trainingSampleStats.total || 0,
          rewardsCredited: await this.getRewardsCredited(),
          activeUsers: await this.getActiveUserCount(),
          
          // Training sample statistics
          trainingSamples: {
            total: trainingSampleStats.total,
            pending: trainingSampleStats.pending,
            approved: trainingSampleStats.approved,
            rejected: trainingSampleStats.rejected,
            autoApproved: trainingSampleStats.autoApproved,
          },

          // System health metrics
          systemStatus: {
            enabled: systemEnabled === true || systemEnabled === 'true',
            autoApprovalRate: parseFloat(autoApprovalRate),
            avgConfidenceScore: avgConfidence,
            minConfidenceThreshold: parseFloat(minConfidence as string) || 0.85,
          },

          // Quick stats for dashboard cards
          summary: {
            totalGames: trainingSampleStats.total || 0,
            totalRewards: await this.getRewardsCredited(),
            activeUsers: await this.getActiveUserCount(),
            pendingReviews: trainingSampleStats.pending,
          },
        },
        meta: {
          timestamp: new Date(),
          cacheStatus: 'live', // Indicates data freshness
          responseTimeMs: Date.now() - startTime,
        },
      };
      
      this.logger.log(`✅ Stats retrieved successfully in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.logger.error(`❌ Failed to fetch gamification stats: ${error.message}`, error.stack);
      throw new HttpException(
        {
          success: false,
          error: 'Failed to fetch statistics',
          details: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get total rewards credited from game_sessions (if table exists)
   */
  private async getRewardsCredited(): Promise<number> {
    try {
      const result = await this.trainingSampleService['prisma'].$queryRaw<any[]>`
        SELECT COALESCE(SUM(reward_amount), 0) as total
        FROM game_sessions
        WHERE reward_amount > 0
      `;
      return parseFloat(result?.[0]?.total) || 0;
    } catch {
      // Table may not exist yet — return count of approved samples as proxy
      return 0;
    }
  }

  /**
   * Get distinct active users from training data contributions
   */
  private async getActiveUserCount(): Promise<number> {
    try {
      const result = await this.trainingSampleService['prisma'].$queryRaw<any[]>`
        SELECT COUNT(DISTINCT session_id) as count
        FROM nlu_training_data
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `;
      return parseInt(result?.[0]?.count) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Calculate average confidence from approved samples
   * @private
   */
  private async calculateAverageConfidence(): Promise<number> {
    try {
      const result = await this.trainingSampleService['prisma'].$queryRaw<any[]>`
        SELECT AVG(confidence) as avg_confidence
        FROM nlu_training_data
        WHERE review_status = 'approved'
      `;

      if (result && result[0] && result[0].avg_confidence) {
        return parseFloat(result[0].avg_confidence);
      }

      return 0;
    } catch (error) {
      this.logger.warn(`Failed to calculate average confidence: ${error.message}`);
      return 0;
    }
  }
}
