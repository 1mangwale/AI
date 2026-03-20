import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { UserProfilingService } from './user-profiling.service';
import { ProgressiveProfileService } from './progressive-profile.service';
import { ConversationAnalyzerService } from './conversation-analyzer.service';
import { MetricsService } from '../metrics/metrics.service';

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

  private isBatchRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentService: UserProfilingService,
    private readonly progressiveProfile: ProgressiveProfileService,
    private readonly conversationAnalyzer: ConversationAnalyzerService,
    private readonly metricsService: MetricsService,
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

      this.metricsService.recordEnrichmentRun('scheduled');

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
   * Cron job: Runs at 2 AM daily to batch-analyze conversations
   * for users with incomplete profiles using LLM (vLLM).
   */
  @Cron('0 2 * * *')
  async batchAnalyzeConversations(): Promise<void> {
    if (this.isBatchRunning) {
      this.logger.warn('Batch analysis already running, skipping...');
      return;
    }

    this.isBatchRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting batch conversation analysis...');
      this.metricsService.recordEnrichmentRun('batch_llm');

      // 1. Find users with incomplete profiles that haven't been analyzed recently
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const eligibleProfiles = await this.prisma.user_profiles.findMany({
        where: {
          profile_completeness: { lt: 50 },
          OR: [
            { last_conversation_analyzed: null },
            { last_conversation_analyzed: { lt: sevenDaysAgo } },
          ],
        },
        select: {
          user_id: true,
          phone: true,
        },
        take: 100, // Control GPU cost per night
      });

      this.logger.log(`Found ${eligibleProfiles.length} eligible profiles for batch analysis`);

      if (eligibleProfiles.length === 0) {
        this.logger.log('No eligible profiles for batch analysis');
        return;
      }

      let successCount = 0;
      let failCount = 0;
      const batchSize = 20;

      // 2. Process in batches of 20
      for (let i = 0; i < eligibleProfiles.length; i += batchSize) {
        const batch = eligibleProfiles.slice(i, i + batchSize);

        for (const profile of batch) {
          try {
            // 2a. Fetch last 24h of conversation messages
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const messages = await this.prisma.conversationMessage.findMany({
              where: {
                userId: String(profile.user_id),
                createdAt: { gte: oneDayAgo },
              },
              select: {
                role: true,
                content: true,
                sender: true,
                message: true,
                messageText: true,
              },
              orderBy: { createdAt: 'asc' },
              take: 50, // Cap messages per user
            });

            // 2b. Skip if no recent messages
            if (messages.length === 0) {
              // Still update timestamp so we don't re-check daily
              await this.prisma.user_profiles.update({
                where: { user_id: profile.user_id },
                data: { last_conversation_analyzed: new Date() },
              });
              continue;
            }

            // Normalize messages to { role, content } format
            const conversationHistory = messages.map((m) => ({
              role: m.role || m.sender || 'user',
              content: m.content || m.message || m.messageText || '',
            })).filter((m) => m.content.length > 0);

            if (conversationHistory.length === 0) {
              await this.prisma.user_profiles.update({
                where: { user_id: profile.user_id },
                data: { last_conversation_analyzed: new Date() },
              });
              continue;
            }

            // 2c. Call ConversationAnalyzerService
            const analysis = await this.conversationAnalyzer.analyzeConversation({
              userId: profile.user_id,
              phone: profile.phone || '',
              conversationHistory,
            });

            // 2d. Update user_profiles with results
            const updateData: any = {
              last_conversation_analyzed: new Date(),
            };

            if (analysis.personality_traits) {
              updateData.personality_traits = analysis.personality_traits;
            }

            if (analysis.communication_style?.tone) {
              updateData.communication_tone = analysis.communication_style.tone.substring(0, 20);
            }

            await this.prisma.user_profiles.update({
              where: { user_id: profile.user_id },
              data: updateData,
            });

            successCount++;

            // 2e. Log progress every 10 users
            if (successCount % 10 === 0) {
              this.logger.debug(`Batch analysis progress: ${successCount} users analyzed`);
            }
          } catch (error) {
            // Per-user try/catch so one failure doesn't stop the batch
            this.logger.error(
              `Batch analysis failed for user ${profile.user_id}: ${error.message}`,
            );

            // Still update timestamp to avoid retrying immediately
            try {
              await this.prisma.user_profiles.update({
                where: { user_id: profile.user_id },
                data: { last_conversation_analyzed: new Date() },
              });
            } catch (_) {
              // ignore update failure
            }

            failCount++;
          }
        }

        // Small delay between batches to avoid GPU overload
        if (i + batchSize < eligibleProfiles.length) {
          await this.sleep(2000); // 2s between batches of 20
        }
      }

      // 3. Log summary
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `Batch analysis complete: ${successCount} users analyzed, ${failCount} failed (${duration}s)`,
      );
    } catch (error) {
      this.logger.error(`Batch conversation analysis failed: ${error.message}`);
    } finally {
      this.isBatchRunning = false;
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
