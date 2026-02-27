import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { PromptAbTestingService, ExperimentResultInput } from '../services/prompt-ab-testing.service';

/**
 * Prompt A/B Testing Controller
 * 
 * Endpoints for managing prompt experiments:
 * - Create/manage experiments
 * - View experiment statistics
 * - Record results (called internally by LLM service)
 */
@Controller('ai/experiments')
export class PromptAbTestingController {
  private readonly logger = new Logger(PromptAbTestingController.name);

  constructor(private readonly abTestingService: PromptAbTestingService) {}

  /**
   * List all experiments
   */
  @Get()
  async listExperiments(
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
  ) {
    const experiments = await this.abTestingService.listExperiments(
      tenantId ? parseInt(tenantId) : 1,
      status,
    );
    
    return {
      success: true,
      count: experiments.length,
      experiments,
    };
  }

  /**
   * Get experiment statistics
   */
  @Get(':id/stats')
  async getExperimentStats(@Param('id', ParseIntPipe) id: number) {
    const stats = await this.abTestingService.getExperimentStats(id);
    return {
      success: true,
      ...stats,
    };
  }

  /**
   * Get experiment details
   */
  @Get(':id')
  async getExperiment(@Param('id', ParseIntPipe) id: number) {
    const stats = await this.abTestingService.getExperimentStats(id);
    return {
      success: true,
      experiment: stats,
    };
  }

  /**
   * Create new experiment
   */
  @Post()
  async createExperiment(
    @Body() body: {
      name: string;
      description?: string;
      targetPromptName: string;
      trafficPercent?: number;
      sampleSizeTarget?: number;
      tenantId?: number;
      createdBy?: string;
      variants: Array<{
        name: string;
        template: string;
        temperature?: number;
        maxTokens?: number;
        weight?: number;
        isControl?: boolean;
      }>;
    },
  ) {
    if (!body.name || !body.targetPromptName || !body.variants?.length) {
      return {
        success: false,
        error: 'Missing required fields: name, targetPromptName, variants',
      };
    }

    if (body.variants.length < 2) {
      return {
        success: false,
        error: 'At least 2 variants are required (control + treatment)',
      };
    }

    const experiment = await this.abTestingService.createExperiment(body);
    
    this.logger.log(`Created experiment: ${body.name}`);
    
    return {
      success: true,
      experiment,
    };
  }

  /**
   * Start experiment
   */
  @Post(':id/start')
  @HttpCode(200)
  async startExperiment(@Param('id', ParseIntPipe) id: number) {
    await this.abTestingService.startExperiment(id);
    return {
      success: true,
      message: `Experiment ${id} started`,
    };
  }

  /**
   * Pause experiment
   */
  @Post(':id/pause')
  @HttpCode(200)
  async pauseExperiment(@Param('id', ParseIntPipe) id: number) {
    await this.abTestingService.pauseExperiment(id);
    return {
      success: true,
      message: `Experiment ${id} paused`,
    };
  }

  /**
   * Complete experiment
   */
  @Post(':id/complete')
  @HttpCode(200)
  async completeExperiment(
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { winnerVariantId?: number },
  ) {
    await this.abTestingService.completeExperiment(id, body?.winnerVariantId);
    return {
      success: true,
      message: `Experiment ${id} completed`,
    };
  }

  /**
   * Delete experiment
   */
  @Delete(':id')
  async deleteExperiment(@Param('id', ParseIntPipe) id: number) {
    await this.abTestingService.deleteExperiment(id);
    return {
      success: true,
      message: `Experiment ${id} deleted`,
    };
  }

  /**
   * Record experiment result (called internally)
   */
  @Post('results')
  @HttpCode(200)
  async recordResult(@Body() result: ExperimentResultInput) {
    await this.abTestingService.recordResult(result);
    return { success: true };
  }

  /**
   * Record user rating for a session
   */
  @Post('rating')
  @HttpCode(200)
  async recordRating(
    @Body() body: { sessionId: string; rating: number },
  ) {
    if (!body.sessionId || body.rating === undefined) {
      return { success: false, error: 'sessionId and rating required' };
    }
    
    if (body.rating < 1 || body.rating > 5) {
      return { success: false, error: 'rating must be between 1 and 5' };
    }

    await this.abTestingService.recordRating(body.sessionId, body.rating);
    return { success: true };
  }

  /**
   * Record escalation event
   */
  @Post('escalation')
  @HttpCode(200)
  async recordEscalation(@Body() body: { sessionId: string }) {
    if (!body.sessionId) {
      return { success: false, error: 'sessionId required' };
    }

    await this.abTestingService.recordEscalation(body.sessionId);
    return { success: true };
  }

  /**
   * Quick start experiment creation helper
   * Creates a simple A/B test with control and one variant
   */
  @Post('quick-create')
  async quickCreate(
    @Body() body: {
      name: string;
      targetPromptName: string;
      controlTemplate: string;
      variantTemplate: string;
      trafficPercent?: number;
    },
  ) {
    const experiment = await this.abTestingService.createExperiment({
      name: body.name,
      targetPromptName: body.targetPromptName,
      trafficPercent: body.trafficPercent || 20,
      variants: [
        {
          name: 'Control',
          template: body.controlTemplate,
          weight: 50,
          isControl: true,
        },
        {
          name: 'Variant A',
          template: body.variantTemplate,
          weight: 50,
          isControl: false,
        },
      ],
    });

    // Auto-start the experiment
    await this.abTestingService.startExperiment(experiment.id);

    return {
      success: true,
      experiment,
      message: 'Experiment created and started',
    };
  }
}
