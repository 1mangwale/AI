import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * Retraining Request
 */
export interface RetrainingRequest {
  source: string; // 'self_learning', 'correction_tracker', 'mistake_tracker', 'manual'
  reason: string;
  newExamplesCount?: number;
  priority?: 'low' | 'normal' | 'high';
  metadata?: Record<string, any>;
}

/**
 * Retraining Response
 */
export interface RetrainingResponse {
  accepted: boolean;
  reason: string;
  jobId?: string;
  estimatedTime?: number;
}

/**
 * Retraining Coordinator Service
 * 
 * Centralized service to coordinate retraining requests from multiple sources.
 * Prevents race conditions when multiple services try to trigger retraining simultaneously.
 * 
 * Features:
 * - Cooldown period to prevent duplicate requests
 * - Priority-based queuing
 * - Single point of contact for training server
 */
@Injectable()
export class RetrainingCoordinatorService {
  private readonly logger = new Logger(RetrainingCoordinatorService.name);
  private readonly trainingServerUrl: string;
  private readonly cooldownMs: number = 30 * 60 * 1000; // 30 minutes cooldown
  private lastRetrainingRequest: number = 0;
  private isRetrainingInProgress: boolean = false;

  private readonly webhookUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.trainingServerUrl = this.configService.get(
      'TRAINING_SERVER_URL',
      'http://localhost:8082',
    );
    this.webhookUrl = this.configService.get('ALERT_WEBHOOK_URL', '');
    this.logger.log(`🎓 Retraining Coordinator initialized`);
    this.logger.log(`   Training Server: ${this.trainingServerUrl}`);
  }

  /**
   * Request retraining (with cooldown and coordination)
   */
  async requestRetrain(request: RetrainingRequest): Promise<RetrainingResponse> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRetrainingRequest;

    // Check cooldown
    if (timeSinceLastRequest < this.cooldownMs && (!request.priority || request.priority === 'low')) {
      const remainingMinutes = Math.ceil((this.cooldownMs - timeSinceLastRequest) / 60000);
      return {
        accepted: false,
        reason: `Cooldown active. Retraining was requested ${Math.floor(timeSinceLastRequest / 60000)} minutes ago. Please wait ${remainingMinutes} more minutes.`,
      };
    }

    // Check if training is already in progress
    if (this.isRetrainingInProgress) {
      return {
        accepted: false,
        reason: 'A training job is already in progress. Please wait for it to complete.',
      };
    }

    // Check training server health
    try {
      const healthCheck = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/health`, { timeout: 5000 }),
      );
      if (healthCheck.data?.status !== 'ok') {
        return {
          accepted: false,
          reason: 'Training server is not healthy',
        };
      }
    } catch (error) {
      return {
        accepted: false,
        reason: `Training server is not available: ${error.message}`,
      };
    }

    // Check training server status
    try {
      const statusResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/status`, { timeout: 5000 }),
      );

      if (statusResponse.data?.active_training_jobs > 0) {
        this.isRetrainingInProgress = true;
        return {
          accepted: false,
          reason: 'A training job is already running on the server',
        };
      }
    } catch (error) {
      this.logger.warn(`Could not check training server status: ${error.message}`);
    }

    // All checks passed - trigger retraining
    this.logger.log(
      `🎓 Triggering retraining: ${request.reason} (source: ${request.source}, priority: ${request.priority || 'normal'})`,
    );

    try {
      this.isRetrainingInProgress = true;
      this.lastRetrainingRequest = now;

      // Step 1: Export training data from DB to training server
      let dataFile = 'nlu_final_v3.jsonl'; // fallback
      try {
        const exportResponse = await firstValueFrom(
          this.httpService.post(`${this.trainingServerUrl}/export-from-db`, {}, { timeout: 60000 }),
        );
        if (exportResponse.data?.status === 'success' && exportResponse.data?.file) {
          const exportedPath: string = exportResponse.data.file;
          dataFile = exportedPath.split('/').pop() || dataFile;
          this.logger.log(`Exported training data to ${dataFile} (${exportResponse.data.samples} samples)`);
        }
      } catch (exportErr) {
        this.logger.warn(`Export from DB failed: ${exportErr.message}. Using fallback file: ${dataFile}`);
      }

      // Step 2: Trigger training
      const trainingResponse = await firstValueFrom(
        this.httpService.post(
          `${this.trainingServerUrl}/train`,
          {
            data_file: dataFile,
            output_name: `indicbert_v${Date.now()}`,
            epochs: 5,
            batch_size: 16,
            learning_rate: 3e-5,
            triggered_by: request.source,
            notes: request.reason,
            priority: request.priority || 'normal',
          },
          { timeout: 10000 },
        ),
      );

      const jobId = trainingResponse.data?.job_id;
      const estimatedTime = trainingResponse.data?.estimated_time;

      this.logger.log(`✅ Retraining job started: ${jobId}`);
      this.notifyRetrainingStarted(request, jobId).catch(() => {});

      // Poll for training completion asynchronously (don't block the response)
      this.pollAndFinalize(jobId, request, dataFile).catch((err) => {
        this.logger.error(`Training poll/finalize failed for job ${jobId}: ${err.message}`);
        this.isRetrainingInProgress = false;
      });

      return {
        accepted: true,
        reason: `Retraining job started: ${jobId}`,
        jobId,
        estimatedTime,
      };
    } catch (error) {
      this.isRetrainingInProgress = false;
      this.logger.error(`❌ Failed to trigger retraining: ${error.message}`);
      this.notifyRetrainingFailed(request, error.message).catch(() => {});
      return {
        accepted: false,
        reason: `Failed to trigger retraining: ${error.message}`,
      };
    }
  }

  /**
   * Check if retraining is in progress
   */
  isTrainingInProgress(): boolean {
    return this.isRetrainingInProgress;
  }

  /**
   * Get time until cooldown expires
   */
  getCooldownRemaining(): number {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRetrainingRequest;
    const remaining = this.cooldownMs - timeSinceLastRequest;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Poll training server for job completion, then record history and auto-deploy if better
   */
  private async pollAndFinalize(jobId: string, request: RetrainingRequest, dataFile: string): Promise<void> {
    try {
      const result = await this.waitForTraining(jobId);

      if (result.success) {
        this.logger.log(`✅ Training job ${jobId} completed with accuracy: ${result.accuracy}`);

        // Record in model_training_history
        await this.recordTrainingHistory(jobId, dataFile, request, result.accuracy);

        // Auto-deploy if accuracy is acceptable
        if (result.accuracy !== undefined) {
          await this.autoDeployIfBetter(jobId, result.accuracy);
        }
      } else {
        this.logger.warn(`❌ Training job ${jobId} failed or timed out`);
        this.notifyRetrainingFailed(request, 'Training job failed or timed out').catch(() => {});
      }
    } finally {
      this.isRetrainingInProgress = false;
    }
  }

  /**
   * Wait for training job to complete by polling the training server
   */
  private async waitForTraining(jobId: string, maxWaitMs = 600000): Promise<{ success: boolean; accuracy?: number }> {
    const pollInterval = 15000; // 15 seconds
    let elapsed = 0;
    while (elapsed < maxWaitMs) {
      try {
        const status = await this.checkJobStatus(jobId);
        if (status.state === 'completed') return { success: true, accuracy: status.accuracy };
        if (status.state === 'failed') return { success: false };
      } catch {
        // Transient error — keep polling
      }
      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;
    }
    return { success: false }; // timeout
  }

  /**
   * Check a training job's status on the training server
   */
  private async checkJobStatus(jobId: string): Promise<{ state: string; accuracy?: number }> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.trainingServerUrl}/jobs/${jobId}`, { timeout: 10000 }),
    );
    return {
      state: response.data?.state || response.data?.status || 'unknown',
      accuracy: response.data?.accuracy,
    };
  }

  /**
   * Record training run in model_training_history table
   */
  private async recordTrainingHistory(
    jobId: string,
    dataFile: string,
    request: RetrainingRequest,
    accuracy?: number,
  ): Promise<void> {
    try {
      const modelVersion = `indicbert_v${jobId}`;
      const accValue = accuracy ?? 0;
      const notes = `${request.reason} (data: ${dataFile})`;

      await this.prisma.$executeRaw`
        INSERT INTO model_training_history
          (id, model_name, model_version, training_samples, accuracy, triggered_by, notes, status, trained_at, is_active, created_at)
        VALUES
          (gen_random_uuid(), 'chotu-nlu', ${modelVersion}, ${request.newExamplesCount ?? 0}, ${accValue},
           ${request.source}, ${notes}, 'completed', NOW(), false, NOW())
      `;
      this.logger.log(`📝 Recorded training history for job ${jobId} (accuracy: ${accValue})`);
    } catch (err) {
      this.logger.error(`Failed to record training history: ${err.message}`);
    }
  }

  /**
   * Auto-deploy the new model if its accuracy is acceptable compared to the current active model.
   * Deploys if new accuracy >= current accuracy - 0.02 (2% tolerance).
   * Otherwise, alerts via webhook and keeps the current model.
   */
  private async autoDeployIfBetter(jobId: string, newAccuracy: number): Promise<void> {
    try {
      // Get current active model's accuracy
      const activeModels = await this.prisma.$queryRaw<Array<{ accuracy: number; model_version: string }>>`
        SELECT accuracy, model_version FROM model_training_history
        WHERE is_active = true AND model_name = 'chotu-nlu'
        ORDER BY trained_at DESC
        LIMIT 1
      `;

      const currentAccuracy = activeModels.length > 0 ? Number(activeModels[0].accuracy) : 0;
      const currentVersion = activeModels.length > 0 ? activeModels[0].model_version : 'none';
      const modelVersion = `indicbert_v${jobId}`;

      this.logger.log(
        `📊 Comparing models: new=${newAccuracy.toFixed(4)} vs current=${currentAccuracy.toFixed(4)} (threshold: ${(currentAccuracy - 0.02).toFixed(4)})`,
      );

      if (newAccuracy >= currentAccuracy - 0.02) {
        // Deploy: tell training server to activate the new model
        try {
          await firstValueFrom(
            this.httpService.post(
              `${this.trainingServerUrl}/deploy`,
              { job_id: jobId, model_version: modelVersion },
              { timeout: 30000 },
            ),
          );
        } catch (deployErr) {
          this.logger.error(`Deploy API call failed: ${deployErr.message}`);
          return;
        }

        // Update is_active flags in DB: deactivate old, activate new
        await this.prisma.$executeRaw`
          UPDATE model_training_history SET is_active = false
          WHERE is_active = true AND model_name = 'chotu-nlu'
        `;
        await this.prisma.$executeRaw`
          UPDATE model_training_history SET is_active = true
          WHERE model_version = ${modelVersion} AND model_name = 'chotu-nlu'
        `;

        this.logger.log(`🚀 Auto-deployed model ${modelVersion} (accuracy: ${newAccuracy.toFixed(4)}, replacing ${currentVersion})`);

        // Notify success
        if (this.webhookUrl) {
          await firstValueFrom(
            this.httpService.post(this.webhookUrl, {
              text: `🚀 NLU Model Auto-Deployed`,
              attachments: [{
                color: '#36A64F',
                title: `New Model: ${modelVersion}`,
                fields: [
                  { title: 'New Accuracy', value: `${(newAccuracy * 100).toFixed(2)}%`, short: true },
                  { title: 'Previous Accuracy', value: `${(currentAccuracy * 100).toFixed(2)}%`, short: true },
                  { title: 'Previous Model', value: currentVersion, short: true },
                ],
              }],
            }, { timeout: 5000 }),
          ).catch(() => {});
        }
      } else {
        // New model is worse — alert and keep current
        this.logger.warn(
          `⚠️ New model ${modelVersion} (${newAccuracy.toFixed(4)}) is worse than current ${currentVersion} (${currentAccuracy.toFixed(4)}). Skipping deploy.`,
        );

        if (this.webhookUrl) {
          await firstValueFrom(
            this.httpService.post(this.webhookUrl, {
              text: `⚠️ NLU Model NOT Deployed — Accuracy Regression`,
              attachments: [{
                color: '#FF9900',
                title: `Rejected Model: ${modelVersion}`,
                fields: [
                  { title: 'New Accuracy', value: `${(newAccuracy * 100).toFixed(2)}%`, short: true },
                  { title: 'Current Accuracy', value: `${(currentAccuracy * 100).toFixed(2)}%`, short: true },
                  { title: 'Threshold', value: `${((currentAccuracy - 0.02) * 100).toFixed(2)}%`, short: true },
                ],
              }],
            }, { timeout: 5000 }),
          ).catch(() => {});
        }
      }
    } catch (err) {
      this.logger.error(`Auto-deploy check failed: ${err.message}`);
    }
  }

  /**
   * Notify webhook that retraining has started
   */
  private async notifyRetrainingStarted(request: RetrainingRequest, jobId: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      await firstValueFrom(
        this.httpService.post(this.webhookUrl, {
          text: `🎓 NLU Retraining Started`,
          attachments: [{
            color: '#36A64F',
            title: `Training Job: ${jobId}`,
            fields: [
              { title: 'Source', value: request.source, short: true },
              { title: 'Priority', value: request.priority || 'normal', short: true },
              { title: 'Reason', value: request.reason, short: false },
            ],
          }],
        }, { timeout: 5000 }),
      );
    } catch (err) {
      this.logger.debug(`Retraining start webhook failed: ${err.message}`);
    }
  }

  /**
   * Notify webhook that retraining has failed
   */
  private async notifyRetrainingFailed(request: RetrainingRequest, errorMsg: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      await firstValueFrom(
        this.httpService.post(this.webhookUrl, {
          text: `❌ NLU Retraining Failed`,
          attachments: [{
            color: '#FF0000',
            title: `Source: ${request.source}`,
            text: errorMsg,
            fields: [
              { title: 'Reason', value: request.reason, short: false },
            ],
          }],
        }, { timeout: 5000 }),
      );
    } catch (err) {
      this.logger.debug(`Retraining failure webhook failed: ${err.message}`);
    }
  }
}
