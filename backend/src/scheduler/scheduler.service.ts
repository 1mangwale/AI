import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { CustomerHealthService } from '../personalization/services/customer-health.service';
import { RiderTierService } from '../gamification/services/rider-tier.service';
import { PrepTimePredictionService } from '../analytics/services/prep-time-prediction.service';
import { CohortRetentionService } from '../analytics/services/cohort-retention.service';
import { ComplaintPatternService } from '../analytics/services/complaint-pattern.service';
import { DemandForecastService } from '../demand/services/demand-forecast.service';
import { ReorderService } from '../broadcast/services/reorder.service';
import { WeatherCampaignTriggerService } from '../broadcast/services/weather-campaign-trigger.service';
import { EventTriggerService } from '../broadcast/services/event-trigger.service';
import { AutoActionService } from './services/auto-action.service';
import { ProactiveMessagingService } from '../broadcast/services/proactive-messaging.service';
import { CartRecoveryService } from '../broadcast/services/cart-recovery.service';

export interface SchedulerJob {
  jobName: string;
  enabled: boolean;
  cronExpression: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  createdAt: Date;
}

interface JobDefinition {
  jobName: string;
  cronExpression: string;
  defaultEnabled: boolean;
  description: string;
}

const JOB_DEFINITIONS: JobDefinition[] = [
  { jobName: 'compute_health_scores', cronExpression: '0 2 * * *', defaultEnabled: true, description: 'Compute customer health scores (daily 2AM)' },
  { jobName: 'compute_rider_tiers', cronExpression: '0 3 * * *', defaultEnabled: true, description: 'Compute rider tier rankings (daily 3AM)' },
  { jobName: 'compute_prep_times', cronExpression: '0 4 * * *', defaultEnabled: true, description: 'Compute restaurant prep times (daily 4AM)' },
  { jobName: 'compute_cohorts', cronExpression: '0 5 * * 0', defaultEnabled: true, description: 'Compute retention cohorts (weekly Sun 5AM)' },
  { jobName: 'analyze_complaints', cronExpression: '0 6 * * *', defaultEnabled: true, description: 'Analyze complaint patterns (daily 6AM)' },
  { jobName: 'generate_demand_forecast', cronExpression: '0 1 * * *', defaultEnabled: true, description: 'Generate demand forecast (daily 1AM)' },
  { jobName: 'find_reorder_candidates', cronExpression: '0 10 * * *', defaultEnabled: true, description: 'Find reorder nudge candidates (daily 10AM)' },
  { jobName: 'check_weather_triggers', cronExpression: '0 */2 * * *', defaultEnabled: false, description: 'Check weather campaign triggers (every 2h)' },
  { jobName: 'check_event_triggers', cronExpression: '0 8 * * *', defaultEnabled: true, description: 'Check event campaign triggers (daily 8AM)' },
  { jobName: 'cart_recovery_scan', cronExpression: '*/30 * * * *', defaultEnabled: true, description: 'Detect abandoned carts (every 30 min)' },
  { jobName: 'cart_recovery_nudge', cronExpression: '*/15 * * * *', defaultEnabled: true, description: 'Send cart recovery nudges (every 15 min)' },
  { jobName: 'run_auto_refund', cronExpression: '0 11 * * *', defaultEnabled: false, description: 'Auto-refund late orders (daily 11AM)' },
  { jobName: 'proactive_lunch_suggestions', cronExpression: '0 30 11 * * *', defaultEnabled: true, description: 'Send lunch meal suggestions via WhatsApp (daily 11:30AM)' },
  { jobName: 'proactive_dinner_suggestions', cronExpression: '0 30 18 * * *', defaultEnabled: true, description: 'Send dinner meal suggestions via WhatsApp (daily 6:30PM)' },
];

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private pool: Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly customerHealth: CustomerHealthService,
    private readonly riderTier: RiderTierService,
    private readonly prepTime: PrepTimePredictionService,
    private readonly cohortRetention: CohortRetentionService,
    private readonly complaintPattern: ComplaintPatternService,
    private readonly demandForecast: DemandForecastService,
    private readonly reorder: ReorderService,
    private readonly weatherTrigger: WeatherCampaignTriggerService,
    private readonly eventTrigger: EventTriggerService,
    private readonly autoAction: AutoActionService,
    private readonly proactiveMessaging: ProactiveMessagingService,
    private readonly cartRecovery: CartRecoveryService,
  ) {}

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduler_config (
          job_name VARCHAR(100) PRIMARY KEY,
          enabled BOOLEAN DEFAULT true,
          cron_expression VARCHAR(50),
          last_run_at TIMESTAMP,
          last_status VARCHAR(20),
          last_error TEXT,
          run_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS scheduler_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_name VARCHAR(100) NOT NULL,
          status VARCHAR(20) NOT NULL,
          duration_ms INTEGER,
          result JSONB,
          error TEXT,
          started_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sched_hist_job ON scheduler_history(job_name);
        CREATE INDEX IF NOT EXISTS idx_sched_hist_started ON scheduler_history(started_at DESC);
      `);

      // Seed default job configs
      for (const job of JOB_DEFINITIONS) {
        await client.query(
          `INSERT INTO scheduler_config (job_name, enabled, cron_expression)
           VALUES ($1, $2, $3)
           ON CONFLICT (job_name) DO NOTHING`,
          [job.jobName, job.defaultEnabled, job.cronExpression],
        );
      }

      client.release();
      this.logger.log('SchedulerService initialized with 13 job definitions');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  // ─── Cron Jobs ────────────────────────────────────────────────

  @Cron('0 1 * * *', { name: 'generate_demand_forecast' })
  async cronGenerateDemandForecast() {
    await this.executeJob('generate_demand_forecast', async () => {
      const today = new Date().toISOString().slice(0, 10);
      return this.demandForecast.getForecast(null, today);
    });
  }

  @Cron('0 2 * * *', { name: 'compute_health_scores' })
  async cronComputeHealthScores() {
    await this.executeJob('compute_health_scores', async () => {
      const result = await this.customerHealth.computeAllHealthScores();
      await this.autoAction.maybeRunAction('churn_reengagement', result);
      return result;
    });
  }

  @Cron('0 3 * * *', { name: 'compute_rider_tiers' })
  async cronComputeRiderTiers() {
    await this.executeJob('compute_rider_tiers', async () => {
      return this.riderTier.computeAllTiers();
    });
  }

  @Cron('0 4 * * *', { name: 'compute_prep_times' })
  async cronComputePrepTimes() {
    await this.executeJob('compute_prep_times', async () => {
      const result = await this.prepTime.computePrepTimes();
      await this.autoAction.maybeRunAction('slow_kitchen_alert', result);
      return result;
    });
  }

  @Cron('0 5 * * 0', { name: 'compute_cohorts' })
  async cronComputeCohorts() {
    await this.executeJob('compute_cohorts', async () => {
      return this.cohortRetention.computeCohorts();
    });
  }

  @Cron('0 6 * * *', { name: 'analyze_complaints' })
  async cronAnalyzeComplaints() {
    await this.executeJob('analyze_complaints', async () => {
      return this.complaintPattern.analyzeComplaints();
    });
  }

  @Cron('0 10 * * *', { name: 'find_reorder_candidates' })
  async cronFindReorderCandidates() {
    await this.executeJob('find_reorder_candidates', async () => {
      const candidates = await this.reorder.findUsersForReorderNudge();
      await this.autoAction.maybeRunAction('reorder_nudge', { candidates });
      return { candidatesFound: candidates.length };
    });
  }

  @Cron('0 */2 * * *', { name: 'check_weather_triggers' })
  async cronCheckWeatherTriggers() {
    await this.executeJob('check_weather_triggers', async () => {
      // Use default weather check (Satna coordinates)
      const triggers = await this.weatherTrigger.checkWeatherTriggers({
        condition: 'clear',
        temperature: 30,
      });
      await this.autoAction.maybeRunAction('weather_campaign', { triggers });
      return { triggersFound: triggers.length };
    });
  }

  @Cron('0 8 * * *', { name: 'check_event_triggers' })
  async cronCheckEventTriggers() {
    await this.executeJob('check_event_triggers', async () => {
      const events = await this.eventTrigger.getEventsToTrigger();
      await this.autoAction.maybeRunAction('festival_campaign', { events });
      return { eventsFound: events.length };
    });
  }

  @Cron('*/30 * * * *', { name: 'cart_recovery_scan' })
  async cronCartRecoveryScan() {
    await this.executeJob('cart_recovery_scan', async () => {
      return this.cartRecovery.detectAbandonedCarts();
    });
  }

  @Cron('*/15 * * * *', { name: 'cart_recovery_nudge' })
  async cronCartRecoveryNudge() {
    await this.executeJob('cart_recovery_nudge', async () => {
      return this.cartRecovery.sendPendingNudges();
    });
  }

  @Cron('0 11 * * *', { name: 'run_auto_refund' })
  async cronRunAutoRefund() {
    await this.executeJob('run_auto_refund', async () => {
      await this.autoAction.maybeRunAction('auto_refund_late', {});
      return { status: 'triggered' };
    });
  }

  @Cron('30 11 * * *', { name: 'proactive_lunch_suggestions' })
  async cronProactiveLunch() {
    await this.executeJob('proactive_lunch_suggestions', async () => {
      const result = await this.proactiveMessaging.runMealTimeCampaign('lunch');
      return result;
    });
  }

  @Cron('30 18 * * *', { name: 'proactive_dinner_suggestions' })
  async cronProactiveDinner() {
    await this.executeJob('proactive_dinner_suggestions', async () => {
      const result = await this.proactiveMessaging.runMealTimeCampaign('dinner');
      return result;
    });
  }

  // ─── Job Execution Engine ─────────────────────────────────────

  private async executeJob(jobName: string, fn: () => Promise<any>): Promise<any> {
    // Check if job is enabled
    const isEnabled = await this.isJobEnabled(jobName);
    if (!isEnabled) {
      this.logger.debug(`Job ${jobName} is disabled, skipping`);
      return null;
    }

    const startTime = Date.now();
    this.logger.log(`Starting job: ${jobName}`);

    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      await this.recordJobRun(jobName, 'success', duration, result, null);
      this.logger.log(`Job ${jobName} completed in ${duration}ms`);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      await this.recordJobRun(jobName, 'error', duration, null, error.message);
      this.logger.error(`Job ${jobName} failed after ${duration}ms: ${error.message}`);
      return null;
    }
  }

  async isJobEnabled(jobName: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT enabled FROM scheduler_config WHERE job_name = $1',
        [jobName],
      );
      return result.rows[0]?.enabled ?? true;
    } catch {
      return true;
    }
  }

  private async recordJobRun(
    jobName: string,
    status: string,
    durationMs: number,
    result: any,
    error: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE scheduler_config
         SET last_run_at = NOW(), last_status = $1, last_error = $2, run_count = run_count + 1
         WHERE job_name = $3`,
        [status, error, jobName],
      );

      await this.pool.query(
        `INSERT INTO scheduler_history (job_name, status, duration_ms, result, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobName, status, durationMs, result ? JSON.stringify(result) : null, error],
      );
    } catch (err: any) {
      this.logger.error(`Failed to record job run: ${err.message}`);
    }
  }

  // ─── Public API Methods ───────────────────────────────────────

  async getAllJobs(): Promise<SchedulerJob[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM scheduler_config ORDER BY job_name',
      );
      return result.rows.map(this.mapJob);
    } catch (error: any) {
      this.logger.error(`getAllJobs failed: ${error.message}`);
      return [];
    }
  }

  async toggleJob(jobName: string): Promise<{ enabled: boolean } | null> {
    try {
      const result = await this.pool.query(
        `UPDATE scheduler_config SET enabled = NOT enabled WHERE job_name = $1 RETURNING enabled`,
        [jobName],
      );
      if (result.rows.length === 0) return null;
      return { enabled: result.rows[0].enabled };
    } catch (error: any) {
      this.logger.error(`toggleJob failed: ${error.message}`);
      return null;
    }
  }

  async runJobManually(jobName: string): Promise<any> {
    const jobRunners: Record<string, () => Promise<any>> = {
      compute_health_scores: () => this.customerHealth.computeAllHealthScores(),
      compute_rider_tiers: () => this.riderTier.computeAllTiers(),
      compute_prep_times: () => this.prepTime.computePrepTimes(),
      compute_cohorts: () => this.cohortRetention.computeCohorts(),
      analyze_complaints: () => this.complaintPattern.analyzeComplaints(),
      generate_demand_forecast: () => this.demandForecast.getForecast(null, new Date().toISOString().slice(0, 10)),
      find_reorder_candidates: async () => {
        const candidates = await this.reorder.findUsersForReorderNudge();
        return { candidatesFound: candidates.length };
      },
      check_weather_triggers: async () => {
        const triggers = await this.weatherTrigger.checkWeatherTriggers({ condition: 'clear', temperature: 30 });
        return { triggersFound: triggers.length };
      },
      check_event_triggers: async () => {
        const events = await this.eventTrigger.getEventsToTrigger();
        return { eventsFound: events.length };
      },
      cart_recovery_scan: async () => {
        return this.cartRecovery.detectAbandonedCarts();
      },
      cart_recovery_nudge: async () => {
        return this.cartRecovery.sendPendingNudges();
      },
      run_auto_refund: async () => {
        await this.autoAction.maybeRunAction('auto_refund_late', {});
        return { status: 'triggered' };
      },
      proactive_lunch_suggestions: async () => {
        return this.proactiveMessaging.runMealTimeCampaign('lunch');
      },
      proactive_dinner_suggestions: async () => {
        return this.proactiveMessaging.runMealTimeCampaign('dinner');
      },
    };

    const runner = jobRunners[jobName];
    if (!runner) {
      return { error: `Unknown job: ${jobName}` };
    }

    const startTime = Date.now();
    try {
      const result = await runner();
      const duration = Date.now() - startTime;
      await this.recordJobRun(jobName, 'manual_success', duration, result, null);
      return { status: 'success', duration, result };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      await this.recordJobRun(jobName, 'manual_error', duration, null, error.message);
      return { status: 'error', duration, error: error.message };
    }
  }

  async getJobHistory(jobName: string, limit: number = 20): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM scheduler_history WHERE job_name = $1 ORDER BY started_at DESC LIMIT $2`,
        [jobName, limit],
      );
      return result.rows;
    } catch (error: any) {
      this.logger.error(`getJobHistory failed: ${error.message}`);
      return [];
    }
  }

  private mapJob(row: any): SchedulerJob {
    return {
      jobName: row.job_name,
      enabled: row.enabled,
      cronExpression: row.cron_expression,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      runCount: row.run_count || 0,
      createdAt: row.created_at,
    };
  }
}
