import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';

export interface TrainingDataSample {
  text: string;
  intent: string;
  entities: Record<string, any>;
  tone?: string;
  sentiment?: string;
  confidence: number;
  source: 'nlu' | 'llm-fallback' | 'manual';
  reviewStatus: 'pending' | 'approved' | 'rejected';
  userId?: string;
  sessionId?: string;
  language: string;
}

@Injectable()
export class NluTrainingDataService {
  private readonly logger = new Logger(NluTrainingDataService.name);
  private readonly labelStudioUrl: string;
  private readonly labelStudioApiKey: string;
  private readonly labelStudioProjectId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.labelStudioUrl = this.config.get('LABEL_STUDIO_URL', 'http://localhost:8080');
    this.labelStudioApiKey = this.config.get('LABEL_STUDIO_API_KEY', '');
    this.labelStudioProjectId = this.config.get('LABEL_STUDIO_PROJECT', '1');
  }

  /**
   * Save training sample to database AND Label Studio
   * This implements the continuous learning loop
   */
  async captureTrainingSample(sample: TrainingDataSample): Promise<void> {
    try {
      // 0. Filter out spam/common short messages
      const ignoredTexts = ['hi', 'hello', 'hey', 'ok', 'yes', 'no', 'thanks', 'thank you', 'bye'];
      if (ignoredTexts.includes(sample.text.trim().toLowerCase()) || sample.text.length < 2) {
        return;
      }

      // 1. Check for duplicates (Deduplication) using Prisma ORM
      const existing = await this.prisma.nluTrainingData.findUnique({
        where: { text: sample.text },
        select: { id: true },
      });
      
      if (existing) {
        this.logger.debug(`Skipping duplicate training sample: "${sample.text}"`);
        return;
      }

      // 2. Auto-approve high confidence samples (Auto-Training)
      // Unified threshold: LLM fallback >= 0.90 auto-approved
      if (sample.confidence >= 0.90 && sample.source === 'llm-fallback') {
        sample.reviewStatus = 'approved';
        this.logger.log(`✨ Auto-approved high confidence LLM sample: "${sample.text}" (${sample.intent}, conf=${sample.confidence.toFixed(2)})`);
      }

      // 3. Save to database for immediate access
      await this.saveToDatabase(sample);

      // 4. Send to Label Studio for human review (Only if pending and not auto-approved)
      if (sample.source === 'llm-fallback' && sample.reviewStatus === 'pending') {
        await this.sendToLabelStudio(sample);
      }

      this.logger.log(
        `Captured training sample: ${sample.intent} (${sample.source}) - "${sample.text.substring(0, 50)}..."`,
      );
    } catch (error) {
      this.logger.error(`Failed to capture training sample: ${error.message}`);
      // Don't throw - training data capture is non-critical
    }
  }

  /**
   * Save to PostgreSQL for analytics and batch export
   */
  private async saveToDatabase(sample: TrainingDataSample): Promise<void> {
    // Now using Prisma ORM with NluTrainingData model
    try {
      // Map reviewStatus to the status column format used by SelfLearningService
      const statusValue = sample.reviewStatus === 'approved' ? 'approved' : 
                         sample.reviewStatus === 'pending' ? 'pending_review' : 
                         sample.reviewStatus;
      
      await this.prisma.nluTrainingData.create({
        data: {
          text: sample.text,
          intent: sample.intent,
          entities: sample.entities || {},
          tone: sample.tone || null,
          sentiment: sample.sentiment || null,
          confidence: sample.confidence,
          source: sample.source,
          reviewStatus: sample.reviewStatus,
          userId: sample.userId || null,
          sessionId: sample.sessionId || null,
          language: sample.language,
        },
      });
      
      // Also set the status column for SelfLearningService compatibility
      await this.prisma.$executeRaw`
        UPDATE nlu_training_data 
        SET status = ${statusValue}
        WHERE text = ${sample.text}
      `;
    } catch (error: any) {
      // Ignore unique constraint violations (duplicates)
      if (error.code === 'P2002') {
        this.logger.debug(`Duplicate training sample ignored: "${sample.text.substring(0, 30)}..."`);
        return;
      }
      throw error;
    }
  }

  /**
   * Send to Label Studio for human annotation/review
   */
  private async sendToLabelStudio(sample: TrainingDataSample): Promise<void> {
    if (!this.labelStudioApiKey) {
      this.logger.debug('Label Studio API key not configured, skipping');
      return;
    }

    try {
      const task = {
        data: {
          text: sample.text,
          language: sample.language,
          suggested_intent: sample.intent,
          suggested_entities: sample.entities,
          suggested_tone: sample.tone,
          llm_confidence: sample.confidence,
          source: sample.source,
        },
        annotations: [
          {
            result: [
              {
                value: {
                  start: 0,
                  end: sample.text.length,
                  text: sample.text,
                  labels: [sample.intent],
                },
                from_name: 'intent',
                to_name: 'text',
                type: 'labels',
              },
            ],
          },
        ],
      };

      await firstValueFrom(
        this.httpService.post(
          `${this.labelStudioUrl}/api/projects/${this.labelStudioProjectId}/tasks`,
          task,
          {
            headers: {
              Authorization: `Token ${this.labelStudioApiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      this.logger.debug('Sent sample to Label Studio for review');
    } catch (error) {
      this.logger.warn(`Label Studio submission failed: ${error.message}`);
    }
  }

  /**
   * Get pending training samples for admin review
   */
  async getPendingSamples(limit: number = 100): Promise<any[]> {
    return this.prisma.nluTrainingData.findMany({
      where: { reviewStatus: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Approve training sample (admin action)
   */
  async approveSample(sampleId: string): Promise<void> {
    await this.prisma.nluTrainingData.update({
      where: { id: sampleId },
      data: { reviewStatus: 'approved' },
    });

    this.logger.log(`Training sample ${sampleId} approved`);
  }

  /**
   * Get count of samples needing review
   */
  async getPendingCount(): Promise<number> {
    return this.prisma.nluTrainingData.count({
      where: { reviewStatus: 'pending' },
    });
  }

  /**
   * Export approved training data for model retraining
   */
  async exportForTraining(
    startDate?: Date,
    endDate?: Date,
  ): Promise<{ text: string; intent: string; entities: any }[]> {
    const samples = await this.prisma.nluTrainingData.findMany({
      where: {
        reviewStatus: 'approved',
        ...(startDate && { createdAt: { gte: startDate } }),
        ...(endDate && { createdAt: { lte: endDate } }),
      },
      select: {
        text: true,
        intent: true,
        entities: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return samples.map(s => ({
      text: s.text,
      intent: s.intent,
      entities: typeof s.entities === 'string' ? JSON.parse(s.entities) : s.entities,
    }));
  }

  /**
   * Capture user feedback/correction for learning
   * When user corrects the system (e.g., "I meant X not Y"), we capture it
   */
  async captureFeedback(
    originalText: string,
    predictedIntent: string,
    correctedIntent: string,
    userId?: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      // Check if we already have this sample
      const existing = await this.prisma.nluTrainingData.findUnique({
        where: { text: originalText },
      });

      if (existing) {
        // Update with corrected intent and mark as approved (user-verified)
        await this.prisma.nluTrainingData.update({
          where: { id: existing.id },
          data: {
            intent: correctedIntent,
            reviewStatus: 'approved',
            source: 'manual', // User correction = manual verification
          },
        });
        this.logger.log(`📝 Updated training sample with user correction: "${originalText}" → ${correctedIntent}`);
      } else {
        // Create new corrected sample
        await this.prisma.nluTrainingData.create({
          data: {
            text: originalText,
            intent: correctedIntent,
            entities: {},
            confidence: 1.0, // User correction = 100% confidence
            source: 'manual',
            reviewStatus: 'approved',
            userId,
            sessionId,
            language: 'auto',
          },
        });
        this.logger.log(`✨ Created new training sample from user correction: "${originalText}" → ${correctedIntent}`);
      }

      // Log the correction for analytics
      this.logger.log(`🔄 Feedback captured: predicted=${predictedIntent}, corrected=${correctedIntent}`);
    } catch (error) {
      this.logger.error(`Failed to capture feedback: ${error.message}`);
    }
  }

  /**
   * Capture implicit feedback from successful order completion
   * If user completes order after entity resolution, that resolution was correct
   */
  async captureSuccessfulResolution(
    query: string,
    resolvedIntent: string,
    resolvedEntities: Record<string, any>,
    userId?: string,
  ): Promise<void> {
    try {
      const existing = await this.prisma.nluTrainingData.findUnique({
        where: { text: query },
      });

      if (existing && existing.reviewStatus === 'pending') {
        // Promote to approved since order was successful
        await this.prisma.nluTrainingData.update({
          where: { id: existing.id },
          data: { reviewStatus: 'approved' },
        });
        this.logger.log(`✅ Promoted training sample to approved (successful order): "${query}"`);
      } else if (!existing) {
        // Create new approved sample from successful order
        await this.prisma.nluTrainingData.create({
          data: {
            text: query,
            intent: resolvedIntent,
            entities: resolvedEntities,
            confidence: 0.95,
            source: 'nlu',
            reviewStatus: 'approved',
            userId,
            language: 'auto',
          },
        });
        this.logger.log(`✨ Created approved training sample from successful order: "${query}"`);
      }
    } catch (error) {
      this.logger.error(`Failed to capture successful resolution: ${error.message}`);
    }
  }

  /**
   * Get training statistics for dashboard
   */
  async getTrainingStats(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    bySource: Record<string, number>;
    byIntent: Record<string, number>;
    recentSamples: any[];
  }> {
    const [total, pending, approved, rejected] = await Promise.all([
      this.prisma.nluTrainingData.count(),
      this.prisma.nluTrainingData.count({ where: { reviewStatus: 'pending' } }),
      this.prisma.nluTrainingData.count({ where: { reviewStatus: 'approved' } }),
      this.prisma.nluTrainingData.count({ where: { reviewStatus: 'rejected' } }),
    ]);

    // Get counts by source
    const sourceGroups = await this.prisma.nluTrainingData.groupBy({
      by: ['source'],
      _count: { id: true },
    });
    const bySource: Record<string, number> = {};
    sourceGroups.forEach(g => { bySource[g.source] = g._count.id; });

    // Get counts by intent (top 10)
    const intentGroups = await this.prisma.nluTrainingData.groupBy({
      by: ['intent'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });
    const byIntent: Record<string, number> = {};
    intentGroups.forEach(g => { byIntent[g.intent] = g._count.id; });

    // Get recent samples
    const recentSamples = await this.prisma.nluTrainingData.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        text: true,
        intent: true,
        confidence: true,
        source: true,
        reviewStatus: true,
        createdAt: true,
      },
    });

    return { total, pending, approved, rejected, bySource, byIntent, recentSamples };
  }

  /**
   * Export training data in JSONL format for model retraining
   */
  async exportAsJsonl(startDate?: Date, endDate?: Date): Promise<string> {
    const samples = await this.exportForTraining(startDate, endDate);
    return samples.map(s => JSON.stringify({
      text: s.text,
      intent: s.intent,
      entities: s.entities,
    })).join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // FALLBACK ANALYSIS & AUGMENTATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Analyze NLU fallback patterns — finds low-confidence and fallback samples,
   * aggregates by provider and intent, and extracts common bigram patterns.
   */
  async getFallbackAnalysis(
    days: number = 7,
    limit: number = 50,
  ): Promise<{
    totalFallbacks: number;
    byProvider: Record<string, number>;
    byIntent: Array<{ intent: string; count: number; avgConfidence: number }>;
    commonPatterns: Array<{ pattern: string; count: number }>;
    recentSamples: any[];
  }> {
    const sinceDate = new Date(Date.now() - days * 86400000);

    // Get fallback/low-confidence samples
    const samples = await this.prisma.nluTrainingData.findMany({
      where: {
        createdAt: { gte: sinceDate },
        OR: [
          { confidence: { lt: 0.65 } },
          { source: 'llm-fallback' },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Aggregate by provider
    const byProvider: Record<string, number> = {};
    for (const s of samples) {
      byProvider[s.source] = (byProvider[s.source] || 0) + 1;
    }

    // Aggregate by intent with avg confidence
    const intentMap = new Map<string, { count: number; totalConf: number }>();
    for (const s of samples) {
      const entry = intentMap.get(s.intent) || { count: 0, totalConf: 0 };
      entry.count++;
      entry.totalConf += s.confidence;
      intentMap.set(s.intent, entry);
    }
    const byIntent = Array.from(intentMap.entries())
      .map(([intent, { count, totalConf }]) => ({
        intent,
        count,
        avgConfidence: totalConf / count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Extract common bigram patterns from texts
    const bigramCount = new Map<string, number>();
    for (const s of samples) {
      const words = s.text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        bigramCount.set(bigram, (bigramCount.get(bigram) || 0) + 1);
      }
    }
    const commonPatterns = Array.from(bigramCount.entries())
      .filter(([, count]) => count >= 2)
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      totalFallbacks: samples.length,
      byProvider,
      byIntent,
      commonPatterns,
      recentSamples: samples.slice(0, limit).map(s => ({
        id: s.id,
        text: s.text,
        intent: s.intent,
        confidence: s.confidence,
        source: s.source,
        createdAt: s.createdAt,
      })),
    };
  }

  /**
   * Weekly augmentation job: identify bottom 5 intents by confidence
   * and generate 20 synthetic samples each via vLLM.
   */
  async generateWeeklyAugmentation(): Promise<{
    intentsTargeted: string[];
    totalGenerated: number;
    totalSaved: number;
  }> {
    this.logger.log('🎯 Running weekly NLU augmentation...');

    // Find the 5 weakest intents by average confidence in the last 7 days
    const weakIntents = await this.prisma.$queryRaw<any[]>`
      SELECT intent, AVG(confidence)::float as avg_conf, COUNT(*)::int as sample_count
      FROM nlu_training_data
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND confidence > 0
      GROUP BY intent
      HAVING COUNT(*) >= 3
      ORDER BY AVG(confidence) ASC
      LIMIT 5
    `;

    if (weakIntents.length === 0) {
      this.logger.log('No weak intents found for augmentation');
      return { intentsTargeted: [], totalGenerated: 0, totalSaved: 0 };
    }

    const intentsTargeted: string[] = [];
    let totalGenerated = 0;
    let totalSaved = 0;

    for (const weak of weakIntents) {
      this.logger.log(`🎯 Augmenting "${weak.intent}" (avg_conf=${weak.avg_conf.toFixed(2)}, samples=${weak.sample_count})`);
      intentsTargeted.push(weak.intent);

      try {
        const result = await this.generateAugmentationData(weak.intent, 20, 'hinglish');
        totalGenerated += result.generated;

        // Save generated samples as pending_review
        for (const sample of result.samples) {
          try {
            await this.prisma.nluTrainingData.create({
              data: {
                text: sample.text,
                intent: sample.intent,
                entities: {},
                confidence: 0.0, // synthetic — needs review
                source: 'manual',
                reviewStatus: 'pending',
                language: 'hinglish',
              },
            });
            totalSaved++;
          } catch (err: any) {
            if (err.code !== 'P2002') { // ignore duplicates
              this.logger.debug(`Failed to save augmented sample: ${err.message}`);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`Augmentation failed for "${weak.intent}": ${err.message}`);
      }
    }

    this.logger.log(`🎯 Weekly augmentation complete: ${intentsTargeted.length} intents, ${totalGenerated} generated, ${totalSaved} saved`);
    return { intentsTargeted, totalGenerated, totalSaved };
  }

  /**
   * Generate synthetic augmentation data for weak intents using vLLM.
   * Calls the local vLLM server to produce paraphrased training samples.
   */
  async generateAugmentationData(
    intent: string,
    count: number = 10,
    language: string = 'en',
  ): Promise<{ samples: Array<{ text: string; intent: string }>; generated: number }> {
    const vllmUrl = this.config.get('VLLM_URL', 'http://localhost:8002');

    // Get existing samples for this intent as context
    const existing = await this.prisma.nluTrainingData.findMany({
      where: { intent, reviewStatus: 'approved' },
      take: 10,
      select: { text: true },
    });

    const exampleTexts = existing.map(e => e.text).join('\n- ');
    const langHint = language === 'hi' ? 'Hindi (Devanagari script)' :
                     language === 'hinglish' ? 'Hinglish (Hindi written in English)' :
                     'English';

    const prompt = `Generate ${count} unique, natural user messages in ${langHint} for the intent "${intent}" in a food delivery / e-commerce chatbot.

Existing examples:
- ${exampleTexts || 'No examples available'}

Rules:
- Each message should be 3-15 words
- Vary vocabulary, phrasing, and formality
- Include common misspellings and informal language
- Return ONLY a JSON array of strings, nothing else

Output:`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${vllmUrl}/v1/completions`,
          {
            model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
            prompt,
            max_tokens: 1024,
            temperature: 0.8,
            top_p: 0.9,
          },
          { timeout: 30000 },
        ),
      );

      const text = response.data?.choices?.[0]?.text || '[]';
      // Extract JSON array from response (LLM might wrap it in markdown)
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        this.logger.warn('vLLM augmentation: could not parse JSON array from response');
        return { samples: [], generated: 0 };
      }

      const generated: string[] = JSON.parse(jsonMatch[0]);
      const samples = generated
        .filter(t => typeof t === 'string' && t.length > 2)
        .slice(0, count)
        .map(t => ({ text: t.trim(), intent }));

      this.logger.log(`Generated ${samples.length} augmentation samples for intent "${intent}"`);
      return { samples, generated: samples.length };
    } catch (err) {
      this.logger.error(`Augmentation generation failed: ${err.message}`);
      return { samples: [], generated: 0 };
    }
  }
}
