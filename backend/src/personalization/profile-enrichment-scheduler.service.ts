import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { UserProfilingService } from './user-profiling.service';
import { ProgressiveProfileService } from './progressive-profile.service';

/**
 * Profile Enrichment Scheduler
 * 
 * Background job that automatically enriches stale user profiles:
 * - Runs every 6 hours
 * - Finds profiles not updated in last 24 hours
 * - Re-analyzes order history from MySQL
 * - Updates favorite items, cuisines, preferences
 * - Weekly reset of profile question counters
 * 
 * Benefits:
 * - Always fresh user profiles
 * - Better personalization
 * - Automatic discovery of new patterns
 */

@Injectable()
export class ProfileEnrichmentScheduler {
  private readonly logger = new Logger(ProfileEnrichmentScheduler.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentService: UserProfilingService,
    private readonly progressiveProfile: ProgressiveProfileService,
  ) {
    this.logger.log('✅ ProfileEnrichmentScheduler initialized');
  }

  /**
   * Cron job: Reset weekly question counters every Monday at midnight
   */
  @Cron('0 0 * * 1')
  async resetWeeklyCounters() {
    try {
      await this.progressiveProfile.resetWeeklyCounters();
      this.logger.log('✅ Weekly profile question counters reset');
    } catch (error) {
      this.logger.error(`Failed to reset weekly counters: ${error.message}`);
    }
  }

  /**
   * Cron job: Runs every 6 hours to refresh stale profiles
   */
  @Cron('0 */6 * * *')
  async enrichStaleProfiles() {
    if (this.isRunning) {
      this.logger.warn('⏭️ Enrichment already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('🔄 Starting scheduled profile enrichment...');

      // Find stale profiles (not updated in last 24 hours)
      const staleProfiles = await this.prisma.user_profiles.findMany({
        where: {
          updated_at: {
            lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
          },
        },
        select: {
          user_id: true,
          phone: true,
        },
        take: 100, // Batch size: 100 users per run
      });

      this.logger.log(`📊 Found ${staleProfiles.length} stale profiles to enrich`);

      if (staleProfiles.length === 0) {
        this.logger.log('✅ No stale profiles found, all up to date!');
        return;
      }

      // Enrich each profile
      let successCount = 0;
      let failCount = 0;

      for (const profile of staleProfiles) {
        try {
          await this.enrichmentService.enrichUserProfile({
            userId: profile.user_id,
            phone: profile.phone,
          });
          successCount++;
          
          // Log progress every 10 users
          if (successCount % 10 === 0) {
            this.logger.debug(`Progress: ${successCount}/${staleProfiles.length} profiles enriched`);
          }
        } catch (error) {
          this.logger.error(`Failed to enrich profile ${profile.user_id}: ${error.message}`);
          failCount++;
        }

        // Small delay to avoid overwhelming MySQL
        await this.sleep(100); // 100ms delay between users
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `✅ Enrichment complete: ${successCount} success, ${failCount} failed (${duration}s)`
      );
    } catch (error) {
      this.logger.error(`Scheduled enrichment failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manual trigger for testing/admin use
   */
  async triggerManualEnrichment(batchSize: number = 100): Promise<{
    processed: number;
    success: number;
    failed: number;
  }> {
    const startTime = Date.now();
    this.logger.log(`🔧 Manual enrichment triggered (batch size: ${batchSize})`);

    try {
      const staleProfiles = await this.prisma.user_profiles.findMany({
        where: {
          updated_at: {
            lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        select: {
          user_id: true,
          phone: true,
        },
        take: batchSize,
      });

      let successCount = 0;
      let failCount = 0;

      for (const profile of staleProfiles) {
        try {
          await this.enrichmentService.enrichUserProfile({
            userId: profile.user_id,
            phone: profile.phone,
          });
          successCount++;
        } catch (error) {
          failCount++;
        }
        await this.sleep(100);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`✅ Manual enrichment complete: ${successCount}/${staleProfiles.length} in ${duration}s`);

      return {
        processed: staleProfiles.length,
        success: successCount,
        failed: failCount,
      };
    } catch (error) {
      this.logger.error(`Manual enrichment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    isRunning: boolean;
    nextRun: string;
  } {
    // Next run is every 6 hours (0, 6, 12, 18)
    const now = new Date();
    const currentHour = now.getHours();
    const nextHour = Math.ceil((currentHour + 1) / 6) * 6;
    const nextRun = new Date(now);
    nextRun.setHours(nextHour % 24, 0, 0, 0);
    if (nextHour >= 24) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    return {
      isRunning: this.isRunning,
      nextRun: nextRun.toISOString(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
