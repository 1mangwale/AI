/**
 * Mistake Tracker Service
 * 
 * Tracks conversation failures and patterns to enable self-learning.
 * Key features:
 * 1. Log mistakes (wrong intent, missed entities, flow failures)
 * 2. Detect patterns (same mistake 3+ times)
 * 3. Alert for priority retraining
 * 4. Prevent repeated mistakes
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import { LogCollectorService } from '../../healing/services/log-collector.service';
import { createHash, randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';

export enum MistakeType {
  WRONG_INTENT = 'wrong_intent',
  MISSED_ENTITY = 'missed_entity',
  BAD_RESPONSE = 'bad_response',
  FLOW_FAILURE = 'flow_failure',
  LOW_CONFIDENCE = 'low_confidence',
  USER_CORRECTION = 'user_correction',
  VOICE_TRANSCRIPTION = 'voice_transcription',
}

export interface MistakeLog {
  messageId: string;
  sessionId: string;
  phoneNumber?: string;
  userMessage: string;
  predictedIntent: string;
  actualIntent?: string;
  confidence: number;
  mistakeType: MistakeType;
  errorDetails?: string;
  userFeedback?: string;
  flowId?: string;
  flowState?: string;
}

export interface MistakePattern {
  messageHash: string;
  mistakeType: string;
  occurrenceCount: number;
  sampleMessages: string[];
  predictedIntents: string[];
  actualIntents: string[];
  firstOccurrence: Date;
  lastOccurrence: Date;
}

export interface MistakeSummary {
  totalMistakes: number;
  byType: Record<MistakeType, number>;
  unresolvedCount: number;
  topPatterns: MistakePattern[];
  recentMistakes: MistakeLog[];
}

@Injectable()
export class MistakeTrackerService {
  private readonly logger = new Logger(MistakeTrackerService.name);
  
  // In-memory cache of known mistake patterns (for quick lookup)
  private knownPatterns: Map<string, MistakePattern> = new Map();

  private readonly webhookUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logCollector: LogCollectorService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly httpService?: HttpService,
  ) {
    this.webhookUrl = this.configService?.get('ALERT_WEBHOOK_URL', '') || '';
    this.loadKnownPatterns();
  }

  /**
   * Log a conversation mistake
   */
  async logMistake(data: MistakeLog): Promise<void> {
    try {
      const messageHash = this.hashMessage(data.userMessage);
      
      await this.prisma.$executeRaw`
        INSERT INTO conversation_mistakes (
          message_id, session_id, phone_number, message_hash,
          user_message, predicted_intent, actual_intent,
          confidence, mistake_type, source,
          created_at
        ) VALUES (
          ${data.messageId}, ${data.sessionId}, ${data.phoneNumber || null},
          ${messageHash}, ${data.userMessage}, ${data.predictedIntent},
          ${data.actualIntent || null}, ${data.confidence}, ${data.mistakeType},
          ${data.flowId || 'unknown'},
          NOW()
        )
      `;

      this.logger.warn(
        `Mistake logged: ${data.mistakeType} | Intent: ${data.predictedIntent} → ${data.actualIntent || 'unknown'} | Confidence: ${data.confidence}`
      );

      // Check for patterns
      await this.checkForPatterns(messageHash, data.mistakeType);
    } catch (error) {
      this.logger.error(`Failed to log mistake: ${error.message}`);
    }
  }

  /**
   * Log when user corrects the bot
   */
  async logUserCorrection(
    sessionId: string,
    originalMessage: string,
    botUnderstanding: string,
    userCorrection: string
  ): Promise<void> {
    await this.logMistake({
      messageId: `correction_${Date.now()}`,
      sessionId,
      userMessage: originalMessage,
      predictedIntent: botUnderstanding,
      actualIntent: userCorrection,
      confidence: 0,
      mistakeType: MistakeType.USER_CORRECTION,
      userFeedback: `User said: "${userCorrection}"`,
    });
  }

  /**
   * Check if same mistake pattern exists
   */
  private async checkForPatterns(messageHash: string, mistakeType: string): Promise<void> {
    try {
      const similar = await this.prisma.$queryRaw<any[]>`
        SELECT COUNT(*) as count, 
               array_agg(DISTINCT predicted_intent) as intents
        FROM conversation_mistakes
        WHERE message_hash = ${messageHash}
          AND mistake_type = ${mistakeType}
          AND created_at > NOW() - INTERVAL '7 days'
          AND is_resolved = false
      `;

      const count = parseInt(similar[0]?.count || '0');

      if (count >= 3) {
        // Pattern detected! Alert for retraining
        await this.alertForRetraining(messageHash, mistakeType, count, similar[0]?.intents || []);
      }
    } catch (error) {
      this.logger.error(`Pattern check failed: ${error.message}`);
    }
  }

  /**
   * Alert when same mistake happens 3+ times
   */
  private async alertForRetraining(
    messageHash: string,
    mistakeType: string,
    count: number,
    intents: string[]
  ): Promise<void> {
    // Check if already alerted
    if (this.knownPatterns.has(messageHash)) {
      return;
    }

    this.logger.error(
      `🚨 REPEATED MISTAKE PATTERN DETECTED!\n` +
      `Hash: ${messageHash}\n` +
      `Occurrences: ${count}\n` +
      `Intents: ${intents.join(', ')}\n` +
      `ACTION REQUIRED: Add training samples for this pattern`
    );

    try {
      await this.logCollector.logBackendError(
        'Repeated mistake pattern detected (needs retraining)',
        undefined,
        {
          component: 'MistakeTrackerService',
          messageHash,
          mistakeType,
          occurrences: count,
          predictedIntents: intents,
        },
      );
    } catch (error) {
      // Healing should never block core learning flow
      this.logger.debug(`Failed to push mistake pattern to healing: ${error?.message || error}`);
    }

    // Store in known patterns
    this.knownPatterns.set(messageHash, {
      messageHash,
      mistakeType: 'repeated',
      occurrenceCount: count,
      sampleMessages: [],
      predictedIntents: intents,
      actualIntents: [],
      firstOccurrence: new Date(),
      lastOccurrence: new Date(),
    });

    // Send webhook notification to admin
    if (this.webhookUrl && this.httpService) {
      try {
        await firstValueFrom(this.httpService.post(this.webhookUrl, {
          text: `🚨 *Repeated NLU Mistake Pattern*\nHash: \`${messageHash}\`\nOccurrences: ${count}\nIntents: ${intents.join(', ')}\n*Action required:* Add training samples for this pattern`,
        }, { timeout: 5000 }));
      } catch (webhookErr) {
        this.logger.debug(`Webhook notification failed: ${webhookErr?.message}`);
      }
    }
  }

  /**
   * Get common mistake patterns for analysis
   */
  async getCommonPatterns(days: number = 30, limit: number = 50): Promise<MistakePattern[]> {
    try {
      const results = await this.prisma.$queryRaw<any[]>`
        SELECT 
          message_hash,
          mistake_type,
          COUNT(*) as occurrence_count,
          array_agg(DISTINCT user_message) as sample_messages,
          array_agg(DISTINCT predicted_intent) as predicted_intents,
          array_agg(DISTINCT actual_intent) FILTER (WHERE actual_intent IS NOT NULL) as actual_intents,
          MIN(created_at) as first_occurrence,
          MAX(created_at) as last_occurrence
        FROM conversation_mistakes
        WHERE created_at > NOW() - INTERVAL '${days} days'
          AND is_resolved = false
        GROUP BY message_hash, mistake_type
        HAVING COUNT(*) >= 2
        ORDER BY occurrence_count DESC
        LIMIT ${limit}
      `;

      return results.map(r => ({
        messageHash: r.message_hash,
        mistakeType: r.mistake_type,
        occurrenceCount: parseInt(r.occurrence_count),
        sampleMessages: (r.sample_messages || []).slice(0, 5),
        predictedIntents: r.predicted_intents || [],
        actualIntents: r.actual_intents || [],
        firstOccurrence: r.first_occurrence,
        lastOccurrence: r.last_occurrence,
      }));
    } catch (error) {
      this.logger.error(`Failed to get patterns: ${error.message}`);
      return [];
    }
  }

  /**
   * Get mistake summary for dashboard
   */
  async getSummary(days: number = 7): Promise<MistakeSummary> {
    try {
      // Total mistakes
      const totalResult = await this.prisma.$queryRaw<any[]>`
        SELECT COUNT(*) as total FROM conversation_mistakes
        WHERE created_at > NOW() - INTERVAL '${days} days'
      `;

      // By type
      const byTypeResult = await this.prisma.$queryRaw<any[]>`
        SELECT mistake_type, COUNT(*) as count
        FROM conversation_mistakes
        WHERE created_at > NOW() - INTERVAL '${days} days'
        GROUP BY mistake_type
      `;

      // Unresolved
      const unresolvedResult = await this.prisma.$queryRaw<any[]>`
        SELECT COUNT(*) as count FROM conversation_mistakes
        WHERE is_resolved = false
      `;

      // Top patterns
      const topPatterns = await this.getCommonPatterns(days, 10);

      // Recent mistakes
      const recentResult = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM conversation_mistakes
        WHERE created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 20
      `;

      const byType: Record<MistakeType, number> = {} as any;
      for (const row of byTypeResult) {
        byType[row.mistake_type as MistakeType] = parseInt(row.count);
      }

      return {
        totalMistakes: parseInt(totalResult[0]?.total || '0'),
        byType,
        unresolvedCount: parseInt(unresolvedResult[0]?.count || '0'),
        topPatterns,
        recentMistakes: recentResult.map(r => ({
          messageId: r.message_id,
          sessionId: r.session_id,
          phoneNumber: r.phone_number,
          userMessage: r.user_message,
          predictedIntent: r.predicted_intent,
          actualIntent: r.actual_intent,
          confidence: parseFloat(r.confidence),
          mistakeType: r.mistake_type,
        })),
      };
    } catch (error) {
      this.logger.error(`Failed to get summary: ${error.message}`);
      return {
        totalMistakes: 0,
        byType: {} as any,
        unresolvedCount: 0,
        topPatterns: [],
        recentMistakes: [],
      };
    }
  }

  /**
   * Mark a mistake as resolved
   */
  async resolveMistake(messageId: string, resolution: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE conversation_mistakes SET
          is_resolved = true,
          resolution_notes = ${resolution},
          resolved_at = NOW()
        WHERE message_id = ${messageId}
      `;
      
      this.logger.log(`Resolved mistake: ${messageId}`);
    } catch (error) {
      this.logger.error(`Failed to resolve mistake: ${error.message}`);
    }
  }

  /**
   * Resolve all mistakes matching a pattern
   */
  async resolvePattern(messageHash: string, resolution: string): Promise<number> {
    try {
      const result = await this.prisma.$executeRaw`
        UPDATE conversation_mistakes SET
          is_resolved = true,
          resolution_notes = ${resolution},
          resolved_at = NOW()
        WHERE message_hash = ${messageHash}
          AND is_resolved = false
      `;

      this.knownPatterns.delete(messageHash);
      this.logger.log(`Resolved pattern ${messageHash}`);
      
      return result as number;
    } catch (error) {
      this.logger.error(`Failed to resolve pattern: ${error.message}`);
      return 0;
    }
  }

  /**
   * Check if this is a known mistake pattern (for prevention)
   */
  isKnownPattern(message: string): MistakePattern | null {
    const hash = this.hashMessage(message);
    return this.knownPatterns.get(hash) || null;
  }

  /**
   * Load known patterns into memory
   */
  private async loadKnownPatterns(): Promise<void> {
    try {
      const patterns = await this.getCommonPatterns(30, 100);
      
      for (const pattern of patterns) {
        if (pattern.occurrenceCount >= 3) {
          this.knownPatterns.set(pattern.messageHash, pattern);
        }
      }

      this.logger.log(`Loaded ${this.knownPatterns.size} known mistake patterns`);
    } catch (error) {
      this.logger.error(`Failed to load patterns: ${error.message}`);
    }
  }

  /**
   * Hash message for pattern matching
   */
  private hashMessage(message: string): string {
    // Normalize: lowercase, remove punctuation, trim
    const normalized = message
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Daily job: Generate training samples from mistakes
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async generateTrainingSamples(): Promise<void> {
    this.logger.log('Generating training samples from mistakes...');

    try {
      // Get unresolved mistakes with user corrections
      const corrections = await this.prisma.$queryRaw<any[]>`
        SELECT user_message, actual_intent, COUNT(*) as count
        FROM conversation_mistakes
        WHERE mistake_type = 'user_correction'
          AND actual_intent IS NOT NULL
          AND is_resolved = false
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY user_message, actual_intent
        HAVING COUNT(*) >= 2
      `;

      // Add to training samples
      for (const correction of corrections) {
        const id = randomUUID();
        await this.prisma.$executeRaw`
          INSERT INTO nlu_training_data (
            id, text, intent, source, confidence, created_at
          ) VALUES (
            ${id},
            ${correction.user_message},
            ${correction.actual_intent},
            'user_correction',
            1.0,
            NOW()
          )
          ON CONFLICT (text) DO NOTHING
        `;

        // Mark as resolved
        await this.prisma.$executeRaw`
          UPDATE conversation_mistakes SET
            is_resolved = true,
            resolution_notes = 'Added to training data'
          WHERE user_message = ${correction.user_message}
            AND actual_intent = ${correction.actual_intent}
            AND mistake_type = 'user_correction'
        `;
      }

      this.logger.log(`Generated ${corrections.length} training samples from user corrections`);
    } catch (error) {
      this.logger.error(`Training sample generation failed: ${error.message}`);
    }
  }

  /**
   * Refresh known patterns (hourly)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshPatterns(): Promise<void> {
    await this.loadKnownPatterns();
  }
}
