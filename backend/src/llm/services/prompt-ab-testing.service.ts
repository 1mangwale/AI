import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface ExperimentVariantSelection {
  experimentId: number;
  variantId: number;
  variantName: string;
  template: string;
  temperature: number;
  maxTokens: number;
  modelPreference?: string;
  isControl: boolean;
}

export interface ExperimentResultInput {
  experimentId: number;
  variantId: number;
  sessionId: string;
  userMessage: string;
  intentDetected?: string;
  responseText: string;
  responseTimeMs: number;
  tokenCount: number;
  userRating?: number;
  wasEscalated?: boolean;
  goalCompleted?: boolean;
}

export interface ExperimentStats {
  experimentId: number;
  experimentName: string;
  status: string;
  variants: VariantStats[];
  winner?: string;
  confidence?: number;
}

export interface VariantStats {
  variantId: number;
  variantName: string;
  isControl: boolean;
  sampleCount: number;
  avgResponseTimeMs: number;
  avgTokens: number;
  avgRating: number | null;
  escalationRate: number;
  conversionRate: number | null;
}

/**
 * Prompt A/B Testing Service
 * 
 * Manages experiments for testing different prompt variations.
 * Uses weighted random selection for traffic allocation.
 * Tracks metrics and calculates statistical significance.
 * 
 * Usage:
 * 1. Create experiment with variants
 * 2. Call selectVariant() when generating LLM response
 * 3. Call recordResult() after getting response
 * 4. View stats via getExperimentStats()
 */
@Injectable()
export class PromptAbTestingService {
  private readonly logger = new Logger(PromptAbTestingService.name);
  
  // Cache active experiments for performance
  private experimentCache: Map<string, { experiments: any[]; cachedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(private readonly prisma: PrismaService) {
    this.logger.log('✅ Prompt A/B Testing Service initialized');
  }

  /**
   * Create a new A/B testing experiment
   */
  async createExperiment(data: {
    name: string;
    description?: string;
    targetPromptName: string;
    trafficPercent?: number;
    sampleSizeTarget?: number;
    confidenceLevel?: number;
    tenantId?: number;
    createdBy?: string;
    variants: Array<{
      name: string;
      template: string;
      temperature?: number;
      maxTokens?: number;
      modelPreference?: string;
      weight?: number;
      isControl?: boolean;
    }>;
  }): Promise<any> {
    // Validate weights sum to 100
    const totalWeight = data.variants.reduce((sum, v) => sum + (v.weight || 50), 0);
    if (Math.abs(totalWeight - 100) > 1) {
      this.logger.warn(`Variant weights sum to ${totalWeight}, normalizing to 100`);
    }

    const experiment = await this.prisma.promptExperiment.create({
      data: {
        name: data.name,
        description: data.description,
        targetPromptName: data.targetPromptName,
        trafficPercent: data.trafficPercent || 10,
        sampleSizeTarget: data.sampleSizeTarget || 1000,
        confidenceLevel: data.confidenceLevel || 0.95,
        tenantId: data.tenantId || 1,
        createdBy: data.createdBy,
        status: 'draft',
        variants: {
          create: data.variants.map((v, idx) => ({
            name: v.name,
            template: v.template,
            temperature: v.temperature || 0.7,
            maxTokens: v.maxTokens || 500,
            modelPreference: v.modelPreference,
            weight: Math.round((v.weight || 50) * 100 / totalWeight), // Normalize
            isControl: v.isControl || idx === 0, // First is control by default
          })),
        },
      },
      include: { variants: true },
    });

    this.logger.log(`📊 Created experiment "${data.name}" with ${data.variants.length} variants`);
    this.invalidateCache(data.targetPromptName);
    
    return experiment;
  }

  /**
   * Start an experiment
   */
  async startExperiment(experimentId: number): Promise<void> {
    const experiment = await this.prisma.promptExperiment.update({
      where: { id: experimentId },
      data: {
        status: 'running',
        startDate: new Date(),
      },
    });
    
    this.logger.log(`▶️ Started experiment ${experimentId}: "${experiment.name}"`);
    this.invalidateCache(experiment.targetPromptName);
  }

  /**
   * Pause an experiment
   */
  async pauseExperiment(experimentId: number): Promise<void> {
    const experiment = await this.prisma.promptExperiment.update({
      where: { id: experimentId },
      data: { status: 'paused' },
    });
    
    this.logger.log(`⏸️ Paused experiment ${experimentId}: "${experiment.name}"`);
    this.invalidateCache(experiment.targetPromptName);
  }

  /**
   * Complete an experiment
   */
  async completeExperiment(experimentId: number, winnerVariantId?: number): Promise<void> {
    const experiment = await this.prisma.promptExperiment.update({
      where: { id: experimentId },
      data: {
        status: 'completed',
        endDate: new Date(),
      },
    });
    
    this.logger.log(`✅ Completed experiment ${experimentId}: "${experiment.name}"`);
    this.invalidateCache(experiment.targetPromptName);
  }

  /**
   * Select a variant for a given prompt name
   * Uses weighted random selection among running experiments
   */
  async selectVariant(
    promptName: string,
    sessionId: string,
    tenantId = 1,
  ): Promise<ExperimentVariantSelection | null> {
    // Get active experiments for this prompt
    const experiments = await this.getActiveExperiments(promptName, tenantId);
    
    if (experiments.length === 0) {
      return null; // No active experiments, use default prompt
    }

    // Check if this session should be included (based on traffic percent)
    // Use consistent hashing so same session always gets same treatment
    const sessionHash = this.hashString(sessionId);
    
    for (const experiment of experiments) {
      // Check if session falls within traffic allocation
      if ((sessionHash % 100) >= experiment.trafficPercent) {
        continue; // This session is in the control group (no experiment)
      }

      // Select variant based on weights
      const variant = this.selectWeightedVariant(experiment.variants, sessionHash);
      
      if (variant) {
        return {
          experimentId: experiment.id,
          variantId: variant.id,
          variantName: variant.name,
          template: variant.template,
          temperature: variant.temperature,
          maxTokens: variant.maxTokens,
          modelPreference: variant.modelPreference,
          isControl: variant.isControl,
        };
      }
    }

    return null;
  }

  /**
   * Record experiment result
   */
  async recordResult(result: ExperimentResultInput): Promise<void> {
    try {
      await this.prisma.promptExperimentResult.create({
        data: {
          experimentId: result.experimentId,
          variantId: result.variantId,
          sessionId: result.sessionId,
          userMessage: result.userMessage,
          intentDetected: result.intentDetected,
          responseText: result.responseText,
          responseTimeMs: result.responseTimeMs,
          tokenCount: result.tokenCount,
          userRating: result.userRating,
          wasEscalated: result.wasEscalated || false,
          goalCompleted: result.goalCompleted,
        },
      });

      // Update variant aggregated metrics periodically (every 10 results)
      const count = await this.prisma.promptExperimentResult.count({
        where: { variantId: result.variantId },
      });
      
      if (count % 10 === 0) {
        await this.updateVariantMetrics(result.variantId);
      }
    } catch (error: any) {
      this.logger.error(`Failed to record experiment result: ${error.message}`);
    }
  }

  /**
   * Record user rating for a session
   */
  async recordRating(sessionId: string, rating: number): Promise<void> {
    // Find the most recent result for this session
    const result = await this.prisma.promptExperimentResult.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });

    if (result) {
      await this.prisma.promptExperimentResult.update({
        where: { id: result.id },
        data: { userRating: rating },
      });
    }
  }

  /**
   * Record escalation (user asked for human)
   */
  async recordEscalation(sessionId: string): Promise<void> {
    const result = await this.prisma.promptExperimentResult.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });

    if (result) {
      await this.prisma.promptExperimentResult.update({
        where: { id: result.id },
        data: { wasEscalated: true },
      });
    }
  }

  /**
   * Get experiment statistics with statistical significance
   */
  async getExperimentStats(experimentId: number): Promise<ExperimentStats> {
    const experiment = await this.prisma.promptExperiment.findUnique({
      where: { id: experimentId },
      include: {
        variants: true,
        results: true,
      },
    });

    if (!experiment) {
      throw new Error(`Experiment ${experimentId} not found`);
    }

    const variantStats: VariantStats[] = [];
    
    for (const variant of experiment.variants) {
      const results = experiment.results.filter(r => r.variantId === variant.id);
      const sampleCount = results.length;
      
      if (sampleCount === 0) {
        variantStats.push({
          variantId: variant.id,
          variantName: variant.name,
          isControl: variant.isControl,
          sampleCount: 0,
          avgResponseTimeMs: 0,
          avgTokens: 0,
          avgRating: null,
          escalationRate: 0,
          conversionRate: null,
        });
        continue;
      }

      const avgResponseTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0) / sampleCount;
      const avgTokens = results.reduce((sum, r) => sum + r.tokenCount, 0) / sampleCount;
      
      const ratedResults = results.filter(r => r.userRating !== null);
      const avgRating = ratedResults.length > 0
        ? ratedResults.reduce((sum, r) => sum + (r.userRating || 0), 0) / ratedResults.length
        : null;
      
      const escalationRate = results.filter(r => r.wasEscalated).length / sampleCount;
      
      const goalResults = results.filter(r => r.goalCompleted !== null);
      const conversionRate = goalResults.length > 0
        ? goalResults.filter(r => r.goalCompleted).length / goalResults.length
        : null;

      variantStats.push({
        variantId: variant.id,
        variantName: variant.name,
        isControl: variant.isControl,
        sampleCount,
        avgResponseTimeMs: Math.round(avgResponseTimeMs),
        avgTokens: Math.round(avgTokens),
        avgRating,
        escalationRate,
        conversionRate,
      });
    }

    // Determine winner based on metrics
    const { winner, confidence } = this.calculateWinner(variantStats, Number(experiment.confidenceLevel));

    return {
      experimentId: experiment.id,
      experimentName: experiment.name,
      status: experiment.status,
      variants: variantStats,
      winner,
      confidence,
    };
  }

  /**
   * Get all experiments for admin dashboard
   */
  async listExperiments(tenantId = 1, status?: string): Promise<any[]> {
    const where: any = { tenantId };
    if (status) where.status = status;

    return this.prisma.promptExperiment.findMany({
      where,
      include: {
        variants: true,
        _count: { select: { results: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Delete an experiment
   */
  async deleteExperiment(experimentId: number): Promise<void> {
    const experiment = await this.prisma.promptExperiment.findUnique({
      where: { id: experimentId },
    });
    
    if (!experiment) return;

    await this.prisma.promptExperiment.delete({
      where: { id: experimentId },
    });
    
    this.invalidateCache(experiment.targetPromptName);
    this.logger.log(`🗑️ Deleted experiment ${experimentId}`);
  }

  // === Private Helper Methods ===

  private async getActiveExperiments(promptName: string, tenantId: number): Promise<any[]> {
    const cacheKey = `${tenantId}:${promptName}`;
    const cached = this.experimentCache.get(cacheKey);
    
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.experiments;
    }

    const experiments = await this.prisma.promptExperiment.findMany({
      where: {
        targetPromptName: promptName,
        tenantId,
        status: 'running',
      },
      include: { variants: true },
    });

    this.experimentCache.set(cacheKey, {
      experiments,
      cachedAt: Date.now(),
    });

    return experiments;
  }

  private selectWeightedVariant(variants: any[], sessionHash: number): any {
    if (variants.length === 0) return null;
    
    // Use session hash for consistent assignment
    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
    const selection = (sessionHash % totalWeight);
    
    let cumulative = 0;
    for (const variant of variants) {
      cumulative += variant.weight;
      if (selection < cumulative) {
        return variant;
      }
    }
    
    return variants[0]; // Fallback
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  private async updateVariantMetrics(variantId: number): Promise<void> {
    const results = await this.prisma.promptExperimentResult.findMany({
      where: { variantId },
    });

    if (results.length === 0) return;

    const avgResponseTime = Math.round(
      results.reduce((sum, r) => sum + r.responseTimeMs, 0) / results.length
    );
    const avgTokens = Math.round(
      results.reduce((sum, r) => sum + r.tokenCount, 0) / results.length
    );
    
    const ratedResults = results.filter(r => r.userRating !== null);
    const avgUserRating = ratedResults.length > 0
      ? ratedResults.reduce((sum, r) => sum + (r.userRating || 0), 0) / ratedResults.length
      : null;

    const goalResults = results.filter(r => r.goalCompleted !== null);
    const conversionRate = goalResults.length > 0
      ? goalResults.filter(r => r.goalCompleted).length / goalResults.length
      : null;

    await this.prisma.promptVariant.update({
      where: { id: variantId },
      data: {
        totalSamples: results.length,
        avgResponseTime,
        avgTokens,
        avgUserRating,
        conversionRate,
      },
    });
  }

  private calculateWinner(
    variants: VariantStats[],
    confidenceLevel: number,
  ): { winner?: string; confidence?: number } {
    // Need at least 2 variants with sufficient samples
    const viable = variants.filter(v => v.sampleCount >= 100);
    if (viable.length < 2) {
      return {};
    }

    const control = viable.find(v => v.isControl);
    const treatments = viable.filter(v => !v.isControl);
    
    if (!control || treatments.length === 0) {
      return {};
    }

    // Use escalation rate as primary metric (lower is better)
    // Could also use rating or conversion rate based on experiment goals
    let bestTreatment: VariantStats | null = null;
    let bestImprovement = 0;

    for (const treatment of treatments) {
      const improvement = control.escalationRate - treatment.escalationRate;
      if (improvement > bestImprovement) {
        bestImprovement = improvement;
        bestTreatment = treatment;
      }
    }

    if (!bestTreatment) {
      return { winner: control.variantName, confidence: 0.5 };
    }

    // Simplified significance test (would use proper z-test in production)
    const pooledN = control.sampleCount + bestTreatment.sampleCount;
    const effectSize = Math.abs(control.escalationRate - bestTreatment.escalationRate);
    
    // Rough confidence based on sample size and effect size
    const confidence = Math.min(
      0.99,
      0.5 + (pooledN / 2000) * 0.3 + (effectSize * 10) * 0.2
    );

    if (confidence >= confidenceLevel) {
      return {
        winner: bestTreatment.escalationRate < control.escalationRate
          ? bestTreatment.variantName
          : control.variantName,
        confidence,
      };
    }

    return { confidence }; // Not enough confidence yet
  }

  private invalidateCache(promptName: string): void {
    for (const key of this.experimentCache.keys()) {
      if (key.endsWith(`:${promptName}`)) {
        this.experimentCache.delete(key);
      }
    }
  }
}
