import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * Intent Accuracy Service
 * 
 * Tracks NLU model performance:
 * - Accuracy per intent
 * - Confidence distribution
 * - Low-confidence messages for review
 * - Confusion matrix
 */

export interface IntentMetrics {
  intent: string;
  totalClassifications: number;
  correctClassifications: number;
  accuracy: number;
  averageConfidence: number;
  lowConfidenceCount: number;
}

export interface ConfusionEntry {
  actual: string;
  predicted: string;
  count: number;
}

export interface IntentAccuracyReport {
  overallAccuracy: number;
  totalClassifications: number;
  intentMetrics: IntentMetrics[];
  topConfusedPairs: ConfusionEntry[];
  lowConfidenceMessages: {
    message: string;
    predicted: string;
    confidence: number;
    timestamp: Date;
  }[];
  confidenceDistribution: {
    range: string;
    count: number;
    percentage: number;
  }[];
}

@Injectable()
export class IntentAccuracyService {
  private readonly logger = new Logger(IntentAccuracyService.name);
  private readonly METRICS_KEY = 'analytics:intent';
  private readonly CONFIDENCE_THRESHOLD = 0.85;
  private readonly LOW_CONFIDENCE_THRESHOLD = 0.6;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('✅ IntentAccuracyService initialized with shared Redis');
  }

  /**
   * Record an intent classification result
   */
  async recordClassification(
    message: string,
    predictedIntent: string,
    confidence: number,
    actualIntent?: string, // If we know the true intent (from user correction)
  ): Promise<void> {
    try {
      const timestamp = Date.now();
      
      // Increment total count for predicted intent
      await this.redis.incr(`${this.METRICS_KEY}:${predictedIntent}:total`);
      
      // Track confidence sum for average calculation
      const currentSum = parseFloat(
        await this.redis.get(`${this.METRICS_KEY}:${predictedIntent}:confidence_sum`) || '0'
      );
      await this.redis.setex(
        `${this.METRICS_KEY}:${predictedIntent}:confidence_sum`,
        86400 * 7, // 7 days TTL
        (currentSum + confidence).toString()
      );
      
      // Track confidence distribution
      const bucket = this.getConfidenceBucket(confidence);
      await this.redis.incr(`${this.METRICS_KEY}:confidence:${bucket}`);
      
      // If low confidence, store for review
      if (confidence < this.LOW_CONFIDENCE_THRESHOLD) {
        await this.redis.incr(`${this.METRICS_KEY}:${predictedIntent}:low_confidence`);
        
        // Store low confidence message (keep last 100)
        const lowConfKey = `${this.METRICS_KEY}:low_confidence_messages`;
        const entry = JSON.stringify({
          message: message.substring(0, 200),
          predicted: predictedIntent,
          confidence,
          timestamp,
        });
        await this.redis.lpush(lowConfKey, entry);
        await this.redis.ltrim(lowConfKey, 0, 99);
      }
      
      // If actual intent provided (correction), track confusion
      if (actualIntent && actualIntent !== predictedIntent) {
        await this.redis.incr(
          `${this.METRICS_KEY}:confusion:${actualIntent}:${predictedIntent}`
        );
      } else if (!actualIntent && confidence >= this.CONFIDENCE_THRESHOLD) {
        // High confidence = likely correct
        await this.redis.incr(`${this.METRICS_KEY}:${predictedIntent}:correct`);
      }
      
    } catch (error) {
      this.logger.error(`Failed to record classification: ${error.message}`);
    }
  }

  /**
   * Record user correction (when they say "no, I meant...")
   */
  async recordCorrection(
    sessionId: string,
    originalIntent: string,
    correctedIntent: string,
    originalMessage: string,
  ): Promise<void> {
    try {
      // Track confusion
      await this.redis.incr(
        `${this.METRICS_KEY}:confusion:${correctedIntent}:${originalIntent}`
      );
      
      // Decrement correct count for original intent
      const currentCorrect = parseInt(
        await this.redis.get(`${this.METRICS_KEY}:${originalIntent}:correct`) || '0', 10
      );
      if (currentCorrect > 0) {
        await this.redis.set(
          `${this.METRICS_KEY}:${originalIntent}:correct`,
          (currentCorrect - 1).toString()
        );
      }
      
      // Store correction for training data
      const correctionKey = `${this.METRICS_KEY}:corrections`;
      const entry = JSON.stringify({
        message: originalMessage.substring(0, 200),
        original: originalIntent,
        corrected: correctedIntent,
        timestamp: Date.now(),
      });
      await this.redis.lpush(correctionKey, entry);
      await this.redis.ltrim(correctionKey, 0, 499); // Keep last 500
      
      this.logger.log(`Correction recorded: ${originalIntent} → ${correctedIntent}`);
    } catch (error) {
      this.logger.error(`Failed to record correction: ${error.message}`);
    }
  }

  /**
   * Get intent accuracy report
   */
  async getAccuracyReport(): Promise<IntentAccuracyReport> {
    try {
      // Get all tracked intents
      const intents = [
        'greeting', 'order_food', 'parcel_booking', 'search_product',
        'track_order', 'help', 'feedback', 'login', 'logout',
        'add_to_cart', 'view_cart', 'checkout', 'cancel',
      ];
      
      const intentMetrics: IntentMetrics[] = [];
      let totalClassifications = 0;
      let totalCorrect = 0;
      
      for (const intent of intents) {
        const total = parseInt(
          await this.redis.get(`${this.METRICS_KEY}:${intent}:total`) || '0', 10
        );
        const correct = parseInt(
          await this.redis.get(`${this.METRICS_KEY}:${intent}:correct`) || '0', 10
        );
        const confidenceSum = parseFloat(
          await this.redis.get(`${this.METRICS_KEY}:${intent}:confidence_sum`) || '0'
        );
        const lowConfidence = parseInt(
          await this.redis.get(`${this.METRICS_KEY}:${intent}:low_confidence`) || '0', 10
        );
        
        if (total > 0) {
          intentMetrics.push({
            intent,
            totalClassifications: total,
            correctClassifications: correct,
            accuracy: (correct / total) * 100,
            averageConfidence: confidenceSum / total,
            lowConfidenceCount: lowConfidence,
          });
          
          totalClassifications += total;
          totalCorrect += correct;
        }
      }
      
      // Sort by total classifications
      intentMetrics.sort((a, b) => b.totalClassifications - a.totalClassifications);
      
      // Get top confused pairs
      const confusionPairs: ConfusionEntry[] = [];
      for (const actual of intents) {
        for (const predicted of intents) {
          if (actual !== predicted) {
            const count = parseInt(
              await this.redis.get(`${this.METRICS_KEY}:confusion:${actual}:${predicted}`) || '0', 10
            );
            if (count > 0) {
              confusionPairs.push({ actual, predicted, count });
            }
          }
        }
      }
      confusionPairs.sort((a, b) => b.count - a.count);
      
      // Get low confidence messages
      const lowConfMessages = await this.redis.lrange(
        `${this.METRICS_KEY}:low_confidence_messages`, 0, 19
      );
      const lowConfidenceMessages = lowConfMessages.map(m => {
        const parsed = JSON.parse(m);
        return {
          ...parsed,
          timestamp: new Date(parsed.timestamp),
        };
      });
      
      // Get confidence distribution
      const buckets = ['0.0-0.3', '0.3-0.5', '0.5-0.7', '0.7-0.85', '0.85-1.0'];
      const distribution: { range: string; count: number; percentage: number }[] = [];
      let totalInBuckets = 0;
      
      for (const bucket of buckets) {
        const count = parseInt(
          await this.redis.get(`${this.METRICS_KEY}:confidence:${bucket}`) || '0', 10
        );
        totalInBuckets += count;
        distribution.push({ range: bucket, count, percentage: 0 });
      }
      
      // Calculate percentages
      for (const d of distribution) {
        d.percentage = totalInBuckets > 0 ? (d.count / totalInBuckets) * 100 : 0;
      }
      
      return {
        overallAccuracy: totalClassifications > 0 
          ? (totalCorrect / totalClassifications) * 100 
          : 0,
        totalClassifications,
        intentMetrics,
        topConfusedPairs: confusionPairs.slice(0, 10),
        lowConfidenceMessages,
        confidenceDistribution: distribution,
      };
    } catch (error) {
      this.logger.error(`Failed to get accuracy report: ${error.message}`);
      return {
        overallAccuracy: 0,
        totalClassifications: 0,
        intentMetrics: [],
        topConfusedPairs: [],
        lowConfidenceMessages: [],
        confidenceDistribution: [],
      };
    }
  }

  private getConfidenceBucket(confidence: number): string {
    if (confidence < 0.3) return '0.0-0.3';
    if (confidence < 0.5) return '0.3-0.5';
    if (confidence < 0.7) return '0.5-0.7';
    if (confidence < 0.85) return '0.7-0.85';
    return '0.85-1.0';
  }
}
