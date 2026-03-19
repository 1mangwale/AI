/**
 * Self-Learning Service
 * 
 * Handles:
 * - High confidence (>=0.85 IndicBERT / >=0.90 LLM) → Auto-approve and train
 * - Medium confidence (0.7-0.85) → Human review
 * - Low confidence (<0.7) → Priority review + Label Studio
 */

import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { RetrainingCoordinatorService } from './retraining-coordinator.service';
import { MetricsService } from '../../metrics/metrics.service';

interface NLUPrediction {
  text: string;
  intent: string;
  confidence: number;
  entities: Array<{
    entity: string;
    value: string;
    confidence: number;
    start: number;
    end: number;
  }> | Record<string, any>;
  responseGenerated?: string;
  conversationId?: string;
  userId?: string;
  timestamp?: Date;
  source?: string;
  language?: string;
}

interface TrainingExample {
  id: string;
  text: string;
  intent: string;
  entities: Array<{ entity: string; value: string; start: number; end: number }>;
  confidence: number;
  status: 'auto_approved' | 'pending_review' | 'approved' | 'rejected' | 'sent_to_label_studio';
  approvedBy?: string;
  approvedAt?: Date;
}

@Injectable()
export class SelfLearningService {
  private readonly logger = new Logger(SelfLearningService.name);
  
  // Confidence thresholds (from config, unified across all services)
  // >= HIGH_CONFIDENCE: auto-approve for training
  // MEDIUM to HIGH: queue for human review
  // < MEDIUM: priority review + Label Studio
  private readonly HIGH_CONFIDENCE: number;
  private readonly MEDIUM_CONFIDENCE: number;
  
  // Label Studio config
  private readonly labelStudioUrl: string;
  private readonly labelStudioToken: string;
  private readonly labelStudioProject: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Optional() @Inject(forwardRef(() => RetrainingCoordinatorService))
    private readonly retrainingCoordinator?: RetrainingCoordinatorService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {
    this.HIGH_CONFIDENCE = parseFloat(this.configService.get('TRAINING_CONFIDENCE_HIGH', '0.85'));
    this.MEDIUM_CONFIDENCE = parseFloat(this.configService.get('TRAINING_CONFIDENCE_MEDIUM', '0.70'));
    this.labelStudioUrl = this.configService.get('LABEL_STUDIO_URL') || 'http://localhost:8080';
    this.labelStudioToken = this.configService.get('LABEL_STUDIO_TOKEN') || '';
    this.labelStudioProject = parseInt(this.configService.get('LABEL_STUDIO_PROJECT') || '1');
  }

  /**
   * Process NLU prediction for learning
   */
  async processPrediction(prediction: NLUPrediction): Promise<{
    action: 'auto_approved' | 'pending_review' | 'label_studio';
    message: string;
  }> {
    const { text, intent, confidence, entities, conversationId, userId } = prediction;
    
    // Check for duplicate
    const existing = await this.prisma.$queryRaw<any[]>`
      SELECT id FROM nlu_training_data 
      WHERE text = ${text} AND intent = ${intent}
      LIMIT 1
    `;
    
    if (existing.length > 0) {
      return { action: 'auto_approved', message: 'Duplicate - already in training data' };
    }

    // High confidence - Auto approve
    if (confidence >= this.HIGH_CONFIDENCE) {
      await this.autoApprove(prediction);
      this.metricsService?.recordSelfLearningAction('auto_approved');
      return { action: 'auto_approved', message: `Auto-approved with ${(confidence * 100).toFixed(1)}% confidence` };
    }

    // Medium confidence - Human review
    if (confidence >= this.MEDIUM_CONFIDENCE) {
      await this.queueForReview(prediction, 'normal');
      this.metricsService?.recordSelfLearningAction('pending_review');
      return { action: 'pending_review', message: `Queued for human review (${(confidence * 100).toFixed(1)}% confidence)` };
    }

    // Low confidence - Priority review + Label Studio
    await this.queueForReview(prediction, 'priority');
    await this.sendToLabelStudio(prediction);
    this.metricsService?.recordSelfLearningAction('label_studio');
    return { action: 'label_studio', message: `Sent to Label Studio for annotation (${(confidence * 100).toFixed(1)}% confidence)` };
  }

  /**
   * Auto-approve high confidence predictions
   */
  private async autoApprove(prediction: NLUPrediction): Promise<void> {
    const id = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO nlu_training_data 
        (id, text, intent, entities, confidence, status, auto_approved_at, conversation_id, user_id, source)
      VALUES 
        (${id}::uuid, ${prediction.text}, ${prediction.intent}, ${JSON.stringify(prediction.entities)}::jsonb, 
         ${prediction.confidence}, 'auto_approved', NOW(), ${prediction.conversationId}, ${prediction.userId}, ${prediction.source || 'nlu'})
    `;
    
    this.logger.log(`Auto-approved: "${prediction.text}" → ${prediction.intent} (${prediction.confidence})`);
    
    // Track for auto-approve patterns
    await this.trackAutoApproval(prediction);
  }

  /**
   * Queue prediction for human review
   */
  private async queueForReview(prediction: NLUPrediction, priority: 'normal' | 'priority'): Promise<void> {
    const id = randomUUID();
    const priorityValue = priority === 'priority' ? 1 : 0;
    await this.prisma.$executeRaw`
      INSERT INTO nlu_training_data 
        (id, text, intent, entities, confidence, status, priority, conversation_id, user_id, source)
      VALUES 
        (${id}::uuid, ${prediction.text}, ${prediction.intent}, ${JSON.stringify(prediction.entities)}::jsonb, 
         ${prediction.confidence}, 'pending_review', ${priorityValue}, ${prediction.conversationId}, ${prediction.userId}, ${prediction.source || 'conversation'})
    `;
    
    this.logger.log(`Queued for ${priority} review: "${prediction.text}" → ${prediction.intent}`);
  }

  /**
   * Send to Label Studio for annotation
   */
  private async sendToLabelStudio(prediction: NLUPrediction): Promise<void> {
    if (!this.labelStudioToken) {
      this.logger.warn('Label Studio not configured - skipping');
      return;
    }

    try {
      // Create Label Studio task with simple data format
      const task = {
        data: {
          text: prediction.text,
          predicted_intent: prediction.intent,
          confidence: prediction.confidence,
          source: prediction.source || 'unknown',
          timestamp: new Date().toISOString()
        },
        predictions: [
          {
            model_version: 'chotu-nlu-v1',
            score: prediction.confidence,
            result: [
              {
                from_name: 'intent',
                to_name: 'text',
                type: 'choices',
                value: { choices: [prediction.intent] }
              }
            ]
          }
        ]
      };

      await firstValueFrom(
        this.httpService.post(
          `${this.labelStudioUrl}/api/projects/${this.labelStudioProject}/tasks`,
          task,
          {
            headers: {
              'Authorization': `Token ${this.labelStudioToken}`,
              'Content-Type': 'application/json'
            }
          }
        )
      );

      this.logger.log(`Sent to Label Studio: "${prediction.text}"`);
    } catch (error: any) {
      this.logger.error(`Label Studio error: ${error.message}`);
    }
  }

  /**
   * Track auto-approval patterns for model improvement
   */
  private async trackAutoApproval(prediction: NLUPrediction): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO auto_approval_stats (intent, count, avg_confidence, last_approved_at)
        VALUES (${prediction.intent}, 1, ${prediction.confidence}, NOW())
        ON CONFLICT (intent) DO UPDATE SET
          count = auto_approval_stats.count + 1,
          avg_confidence = (auto_approval_stats.avg_confidence * auto_approval_stats.count + ${prediction.confidence}) / (auto_approval_stats.count + 1),
          last_approved_at = NOW()
      `;
    } catch (error: any) {
      this.logger.warn(`trackAutoApproval failed for ${prediction.intent}: ${error.message}`);
    }
  }

  /**
   * Get pending reviews for admin
   */
  async getPendingReviews(
    priority?: 'all' | 'priority' | 'normal',
    limit: number = 50
  ): Promise<TrainingExample[]> {
    let results: any[];

    if (priority === 'priority') {
      results = await this.prisma.$queryRaw`
        SELECT * FROM nlu_training_data
        WHERE status = 'pending_review'
          AND priority = 'priority'
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
      `;
    } else if (priority === 'normal') {
      results = await this.prisma.$queryRaw`
        SELECT * FROM nlu_training_data
        WHERE status = 'pending_review'
          AND priority = 'normal'
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
      `;
    } else {
      results = await this.prisma.$queryRaw`
        SELECT * FROM nlu_training_data
        WHERE status = 'pending_review'
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return results;
  }

  /**
   * Approve training example (by admin)
   */
  async approveExample(
    exampleId: string,
    adminId: string,
    correctedIntent?: string,
    correctedEntities?: any[]
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE nlu_training_data 
      SET 
        status = 'approved',
        approved_by = ${adminId},
        approved_at = NOW(),
        intent = COALESCE(${correctedIntent}, intent),
        entities = COALESCE(${correctedEntities ? JSON.stringify(correctedEntities) : null}::jsonb, entities)
      WHERE id = ${exampleId}::uuid
    `;
    
    this.logger.log(`Example ${exampleId} approved by ${adminId}`);
  }

  /**
   * Reject training example
   */
  async rejectExample(exampleId: string, adminId: string, reason?: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE nlu_training_data 
      SET status = 'rejected', rejected_by = ${adminId}, rejection_reason = ${reason}, rejected_at = NOW()
      WHERE id = ${exampleId}::uuid
    `;
    
    this.logger.log(`Example ${exampleId} rejected by ${adminId}`);
  }

  /**
   * Export approved examples for training
   */
  async exportForTraining(format: 'rasa' | 'json' | 'spacy'): Promise<string> {
    const examples = await this.prisma.$queryRaw<any[]>`
      SELECT text, intent, entities 
      FROM nlu_training_data 
      WHERE status IN ('auto_approved', 'approved')
    `;

    if (format === 'rasa') {
      return this.formatForRasa(examples);
    } else if (format === 'spacy') {
      return this.formatForSpacy(examples);
    }
    
    return JSON.stringify(examples, null, 2);
  }

  private formatForRasa(examples: any[]): string {
    const grouped: Record<string, string[]> = {};
    
    for (const ex of examples) {
      if (!grouped[ex.intent]) grouped[ex.intent] = [];
      grouped[ex.intent].push(ex.text);
    }
    
    let output = 'version: "3.1"\n\nnlu:\n';
    
    for (const [intent, texts] of Object.entries(grouped)) {
      output += `- intent: ${intent}\n  examples: |\n`;
      for (const text of texts) {
        output += `    - ${text}\n`;
      }
      output += '\n';
    }
    
    return output;
  }

  private formatForSpacy(examples: any[]): string {
    const data = examples.map(ex => ({
      text: ex.text,
      entities: ex.entities?.map((e: any) => [e.start, e.end, e.entity]) || []
    }));
    
    return JSON.stringify(data, null, 2);
  }

  /**
   * Process low-confidence predictions for auto-approval.
   * Groups by input text — if same text classified identically ≥3 times
   * with confidence >0.70, auto-approves it as training data.
   */
  async processLowConfidencePredictions(): Promise<{
    reviewed: number;
    autoApproved: number;
    stillPending: number;
  }> {
    this.logger.log('🔍 Processing low-confidence predictions...');

    try {
      // Find texts that were classified identically ≥3 times with confidence 0.65-0.85
      const candidates = await this.prisma.$queryRaw<any[]>`
        SELECT text, intent, COUNT(*)::int as occurrences, AVG(confidence)::float as avg_conf
        FROM nlu_training_data
        WHERE status = 'pending_review'
          AND confidence >= 0.65
          AND confidence < ${this.HIGH_CONFIDENCE}
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY text, intent
        HAVING COUNT(*) >= 3 AND AVG(confidence) >= 0.70
        ORDER BY COUNT(*) DESC
        LIMIT 100
      `;

      let autoApproved = 0;

      for (const candidate of candidates) {
        // Auto-approve: consistent classification across multiple occurrences
        await this.prisma.$executeRaw`
          UPDATE nlu_training_data
          SET status = 'auto_approved', auto_approved_at = NOW()
          WHERE text = ${candidate.text} AND intent = ${candidate.intent} AND status = 'pending_review'
        `;
        autoApproved++;
        this.metricsService?.recordSelfLearningAction('auto_approved_batch');
      }

      // Count remaining pending
      const pendingResult = await this.prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int as cnt FROM nlu_training_data WHERE status = 'pending_review'
      `;
      const stillPending = pendingResult[0]?.cnt || 0;

      this.logger.log(`🔍 Low-confidence review: ${candidates.length} candidates, ${autoApproved} auto-approved, ${stillPending} still pending`);

      return { reviewed: candidates.length, autoApproved, stillPending };
    } catch (error) {
      this.logger.error(`❌ Low-confidence processing failed: ${error.message}`);
      return { reviewed: 0, autoApproved: 0, stillPending: 0 };
    }
  }

  /**
   * Automatic retraining check (Daily at 2 AM)
   * Checks if model needs retraining and delegates to RetrainingCoordinator
   */
  @Cron('0 2 * * *')
  async autoCheckAndRetrain(): Promise<void> {
    this.logger.log('🔄 Running automatic retraining check...');
    
    try {
      const check = await this.checkRetrainingNeeded();
      
      if (!check.needed) {
        this.logger.log(
          `✅ No retraining needed. New examples: ${check.newExamplesCount}`
        );
        return;
      }
      
      this.logger.log(
        `🎯 Retraining needed! Reason: ${check.reason}, ` +
        `New examples: ${check.newExamplesCount}`
      );
      
      // Delegate to RetrainingCoordinator (prevents race conditions with other triggers)
      if (this.retrainingCoordinator) {
        const result = await this.retrainingCoordinator.requestRetrain({
          source: 'self_learning',
          reason: check.reason || `${check.newExamplesCount} new training examples`,
          newExamplesCount: check.newExamplesCount,
          priority: check.newExamplesCount >= 200 ? 'high' : 'normal',
        });
        this.logger.log(`🎓 Coordinator response: ${result.reason}`);
      } else {
        this.logger.warn('⚠️ RetrainingCoordinator not available, skipping');
      }
      
    } catch (error) {
      this.logger.error(`❌ Auto-retraining check failed: ${error.message}`);
    }
  }

  /**
   * Sync approved annotations from Label Studio
   */
  @Cron(CronExpression.EVERY_HOUR)
  async syncFromLabelStudio(): Promise<void> {
    if (!this.labelStudioToken) return;

    try {
      // Get completed tasks
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.labelStudioUrl}/api/projects/${this.labelStudioProject}/tasks`,
          {
            headers: { 'Authorization': `Token ${this.labelStudioToken}` },
            params: { page_size: 100, filter: 'completed' }
          }
        )
      );

      const tasks = response.data.tasks || [];
      
      for (const task of tasks) {
        if (task.annotations?.length > 0) {
          const annotation = task.annotations[0];
          const result = annotation.result;
          
          // Extract intent and entities from annotation
          const intentChoice = result.find((r: any) => r.from_name === 'intent');
          const entityLabels = result.filter((r: any) => r.from_name === 'entity');
          
          const intent = intentChoice?.value?.choices?.[0] || task.data.predicted_intent;
          const entities = entityLabels.map((e: any) => ({
            entity: e.value.labels[0],
            value: e.value.text,
            start: e.value.start,
            end: e.value.end
          }));

          // Update in database
          await this.prisma.$executeRaw`
            UPDATE nlu_training_data 
            SET 
              intent = ${intent},
              entities = ${JSON.stringify(entities)}::jsonb,
              status = 'approved',
              approved_by = 'label_studio',
              approved_at = NOW()
            WHERE text = ${task.data.text} AND status = 'sent_to_label_studio'
          `;
        }
      }

      this.logger.log(`Synced ${tasks.length} annotations from Label Studio`);
    } catch (error: any) {
      this.logger.error(`Label Studio sync error: ${error.message}`);
    }
  }

  /**
   * Get learning statistics
   */
  async getStats(): Promise<{
    totalExamples: number;
    autoApproved: number;
    humanApproved: number;
    pendingReview: number;
    rejected: number;
    avgConfidence: number;
    topIntents: Array<{ intent: string; count: number }>;
  }> {
    const stats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE status = 'auto_approved')::int as auto_approved,
        COUNT(*) FILTER (WHERE status = 'approved')::int as human_approved,
        COUNT(*) FILTER (WHERE status = 'pending_review')::int as pending_review,
        COUNT(*) FILTER (WHERE status = 'rejected')::int as rejected,
        COALESCE(AVG(confidence), 0)::float as avg_confidence
      FROM nlu_training_data
    `;

    const topIntents = await this.prisma.$queryRaw<any[]>`
      SELECT intent, COUNT(*)::int as count
      FROM nlu_training_data
      WHERE status IN ('auto_approved', 'approved')
      GROUP BY intent
      ORDER BY count DESC
      LIMIT 10
    `;

    return {
      totalExamples: stats[0].total || 0,
      autoApproved: stats[0].auto_approved || 0,
      humanApproved: stats[0].human_approved || 0,
      pendingReview: stats[0].pending_review || 0,
      rejected: stats[0].rejected || 0,
      avgConfidence: stats[0].avg_confidence || 0,
      topIntents: topIntents.map(t => ({ intent: t.intent, count: t.count }))
    };
  }

  /**
   * Track a positive outcome from a successfully completed flow.
   * When a user completes a flow (e.g., order placed), this confirms
   * the original NLU intent classification was correct — boosting
   * confidence in that prediction for future training.
   */
  async trackPositiveOutcome(params: {
    sessionId: string;
    intent: string;
    flowId: string;
    completedSuccessfully: boolean;
  }): Promise<void> {
    const { sessionId, intent, flowId, completedSuccessfully } = params;

    if (!intent || !completedSuccessfully) return;

    try {
      // Mark any pending-review entries for this session+intent as auto-approved,
      // since the user successfully completed the flow — confirming the classification.
      const updated = await this.prisma.$executeRaw`
        UPDATE nlu_training_data
        SET status = 'auto_approved',
            auto_approved_at = NOW(),
            source = COALESCE(source, 'flow_completion')
        WHERE conversation_id = ${sessionId}
          AND intent = ${intent}
          AND status = 'pending_review'
      `;

      if (updated > 0) {
        this.logger.log(
          `Positive signal: ${updated} prediction(s) auto-approved for intent "${intent}" (flow: ${flowId}, session: ${sessionId})`,
        );
        this.metricsService?.recordSelfLearningAction('flow_confirmed');
      } else {
        this.logger.debug(
          `Positive signal logged for intent "${intent}" (flow: ${flowId}) — no pending predictions to confirm`,
        );
      }
    } catch (error: any) {
      // Non-critical — never block the flow
      this.logger.warn(`trackPositiveOutcome failed: ${error.message}`);
    }
  }

  /**
   * Check if model needs retraining
   */
  async checkRetrainingNeeded(): Promise<{
    needed: boolean;
    reason?: string;
    newExamplesCount: number;
  }> {
    // Get count of new approved examples since last training
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*) as new_count
      FROM nlu_training_data
      WHERE status IN ('auto_approved', 'approved')
      AND created_at > COALESCE(
        (SELECT MAX(trained_at) FROM model_training_history),
        '1970-01-01'::timestamp
      )
    `;

    const newCount = parseInt(result[0].new_count);
    
    // Check patterns that failed frequently
    const patterns = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*) as pattern_count
      FROM v_mistake_patterns
      WHERE occurrence_count >= 3
      AND first_seen > NOW() - INTERVAL '7 days'
    `;

    const failedPatterns = parseInt(patterns[0]?.pattern_count || '0');

    if (newCount >= 100 || failedPatterns >= 5) {
      return {
        needed: true,
        reason: newCount >= 100 
          ? `${newCount} new training examples available`
          : `${failedPatterns} new failure patterns detected`,
        newExamplesCount: newCount
      };
    }

    return { needed: false, newExamplesCount: newCount };
  }
}
