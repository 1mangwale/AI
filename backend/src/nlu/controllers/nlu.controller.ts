import { Controller, Post, Body, Get, Query, Logger, HttpCode, HttpStatus, Optional } from '@nestjs/common';
import { NluService } from '../services/nlu.service';
import { EntityExtractorService } from '../services/entity-extractor.service';
import { NerEntityExtractorService } from '../services/ner-entity-extractor.service';
import { NluTrainingDataService } from '../services/nlu-training-data.service';
import { ClassifyTextDto } from '../dto/classify-text.dto';
import { ClassificationResultDto } from '../dto/classification-result.dto';
import { SemanticFoodDetectorService } from '../services/semantic-food-detector.service';
import { IndicBERTService } from '../services/indicbert.service';

@Controller('nlu')
export class NluController {
  private readonly logger = new Logger(NluController.name);

  constructor(
    private readonly nluService: NluService,
    private readonly entityExtractor: EntityExtractorService,
    private readonly foodDetector: SemanticFoodDetectorService,
    private readonly indicBertService: IndicBERTService,
    @Optional() private readonly nerExtractor?: NerEntityExtractorService,
    @Optional() private readonly trainingDataService?: NluTrainingDataService,
  ) {}

  @Post('classify')
  async classify(
    @Body() dto: ClassifyTextDto,
  ): Promise<ClassificationResultDto> {
    this.logger.log(`NLU classification request: "${dto.text}"`);
    return this.nluService.classify(dto);
  }

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  async extractEntities(@Body() dto: ClassifyTextDto): Promise<{ entities: Record<string, any> }> {
    const classification = await this.nluService.classify(dto);
    return { entities: classification.entities || {} };
  }

  @Post('food-detect')
  @HttpCode(HttpStatus.OK)
  async detectFood(
    @Body() dto: ClassifyTextDto,
  ): Promise<{ isFood: boolean; confidence: number; method?: string; detectedItems?: string[] }> {
    const result = await this.foodDetector.detectFood(dto.text);

    return {
      isFood: result.isFood,
      confidence: result.confidence,
      method: result.method,
      detectedItems: result.detectedItems,
    };
  }

  @Get('intents')
  async getAvailableIntents(): Promise<{ intents: string[] }> {
    return {
      intents: [
        'greeting',
        'track_order',
        'parcel_booking',
        'search_product',
        'cancel_order',
        'help',
        'complaint',
        'unknown',
      ],
    };
  }

  /**
   * Extract entities using NER model and resolve against Search service
   */
  @Post('extract-and-resolve')
  @HttpCode(HttpStatus.OK)
  async extractAndResolve(@Body() dto: ClassifyTextDto): Promise<any> {
    if (!this.nerExtractor) {
      return { error: 'NER service not available' };
    }
    
    const startTime = Date.now();
    const result = await this.nerExtractor.extractAndResolve(dto.text);
    
    return {
      ...result,
      total_processing_time_ms: Date.now() - startTime,
    };
  }

  /**
   * Get NER service status
   */
  @Get('ner/status')
  async getNerStatus(): Promise<any> {
    if (!this.nerExtractor) {
      return { available: false, error: 'NER service not configured' };
    }
    
    return this.nerExtractor.getStatus();
  }

  /**
   * Get NLU fallback analysis — low-confidence and fallback samples
   */
  @Get('fallback-analysis')
  async getFallbackAnalysis(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ): Promise<any> {
    if (!this.trainingDataService) {
      return { error: 'Training data service not available' };
    }
    return this.trainingDataService.getFallbackAnalysis(
      days ? parseInt(days, 10) : 7,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Generate augmentation data for weak intents using vLLM
   */
  @Post('generate-augmentation')
  @HttpCode(HttpStatus.OK)
  async generateAugmentation(
    @Body() dto: { intent: string; count?: number; language?: string },
  ): Promise<any> {
    if (!this.trainingDataService) {
      return { error: 'Training data service not available' };
    }
    if (!dto.intent) {
      return { error: 'intent is required' };
    }
    return this.trainingDataService.generateAugmentationData(
      dto.intent,
      dto.count || 10,
      dto.language || 'en',
    );
  }

  @Get('health')
  async health(): Promise<{
    status: string;
    nluEnabled: boolean;
    upstream?: {
      info: Record<string, any> | null;
      health: Awaited<ReturnType<IndicBERTService['healthCheck']>>;
    };
  }> {
    const nluEnabled = process.env.NLU_AI_ENABLED === 'true';
    const [upstreamHealth, upstreamInfo] = await Promise.all([
      this.indicBertService.healthCheck(),
      this.indicBertService.getInfo(),
    ]);

    return {
      status: 'ok',
      nluEnabled,
      upstream: {
        info: upstreamInfo,
        health: upstreamHealth,
      },
    };
  }
}
