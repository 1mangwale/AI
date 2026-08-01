import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntentClassifierService } from './intent-classifier.service';
import { EntityExtractorService } from './entity-extractor.service';
import { ToneAnalyzerService } from './tone-analyzer.service';
import { LlmIntentExtractorService } from './llm-intent-extractor.service';
import { NluTrainingDataService } from './nlu-training-data.service';
import { ConversationCaptureService } from '../../services/conversation-capture.service';
import { SelfLearningService } from '../../learning/services/self-learning.service';
import { ClassifyTextDto } from '../dto/classify-text.dto';
import { ClassificationResultDto } from '../dto/classification-result.dto';

@Injectable()
export class NluService {
  private readonly logger = new Logger(NluService.name);
  private readonly nluEnabled: boolean;
  private readonly confidenceThreshold: number;
  private readonly enableLlmFallback: boolean;
  private readonly captureTrainingData: boolean;
  private readonly trainingAutoApprove: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly intentClassifier: IntentClassifierService,
    private readonly entityExtractor: EntityExtractorService,
    private readonly toneAnalyzer: ToneAnalyzerService,
    private readonly llmIntentExtractor: LlmIntentExtractorService,
    private readonly trainingDataService: NluTrainingDataService,
    private readonly conversationCapture: ConversationCaptureService,
    @Optional() private readonly selfLearningService: SelfLearningService,
  ) {
    this.nluEnabled = this.config.get('NLU_AI_ENABLED', 'true') === 'true';
    this.confidenceThreshold = parseFloat(this.config.get('NLU_CONFIDENCE_THRESHOLD', '0.65'));
    this.enableLlmFallback = this.config.get('NLU_LLM_FALLBACK_ENABLED', 'true') === 'true';
    this.captureTrainingData = this.config.get('NLU_CAPTURE_TRAINING_DATA', 'true') === 'true';
    // Kill switch for unsupervised auto-approval of training samples (2026-08-01):
    // heuristic/IndicBERT predictions at >=0.85 were self-labelling the training
    // set during broken conversations. 'false' keeps capture but routes ALL
    // samples to human review.
    this.trainingAutoApprove = this.config.get('NLU_TRAINING_AUTO_APPROVE', 'true') === 'true';
    
    this.logger.log(`NLU Service initialized: enabled=${this.nluEnabled}, threshold=${this.confidenceThreshold}, llmFallback=${this.enableLlmFallback}`);
  }

  async classify(dto: ClassifyTextDto): Promise<ClassificationResultDto> {
    const startTime = Date.now();

    try {
      // Run intent classification, entity extraction, and tone analysis in parallel.
      // Entity extractor does not depend on the intent result (the intent param is unused),
      // so all three can run concurrently for significant latency reduction.
      const [intentResult, entities, toneResult] = await Promise.all([
        this.intentClassifier.classify(dto.text, dto.language, dto.context),
        this.entityExtractor.extract(dto.text, '', dto.language),
        this.toneAnalyzer.analyzeTone(dto.text, dto.language),
      ]);

      // Step 4: Capture training data - ENHANCED to capture all predictions for learning
      // Capture Strategy (unified thresholds):
      // - IndicBERT >= 0.85: Auto-approve (reliable predictions)
      // - LLM fallback >= 0.90: Auto-approve (high confidence LLM labels)
      // - Everything else >= 0.5: Capture for human review
      if (this.captureTrainingData && intentResult.confidence >= 0.5) {
        const isLlmFallback = intentResult.provider === 'llm';
        const autoApproveThreshold = isLlmFallback ? 0.90 : 0.85;
        const isHighConfidence = intentResult.confidence >= autoApproveThreshold;
        
        // Determine source and review status based on provider and confidence
        let source: 'nlu' | 'llm-fallback' = isLlmFallback ? 'llm-fallback' : 'nlu';
        let reviewStatus: 'pending' | 'approved' = 'pending';
        
        // Auto-approve high confidence IndicBERT predictions (they're reliable)
        if (this.trainingAutoApprove && !isLlmFallback && isHighConfidence) {
          reviewStatus = 'approved';
          this.logger.debug(`✨ Auto-approving high confidence IndicBERT prediction: ${intentResult.intent} (${intentResult.confidence.toFixed(2)})`);
        }
        
        await this.trainingDataService.captureTrainingSample({
          text: dto.text,
          intent: intentResult.intent,
          entities,
          tone: toneResult.tone,
          sentiment: toneResult.sentiment,
          confidence: intentResult.confidence,
          source,
          reviewStatus,
          language: dto.language || 'auto',
          userId: dto.userId,
          sessionId: dto.sessionId,
        }).catch(err => {
          this.logger.warn(`Failed to capture training data: ${err.message}`);
        });
      }

      const processingTimeMs = Date.now() - startTime;

      // Build classification result
      const result: ClassificationResultDto = {
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        entities,
        tone: toneResult.tone,
        sentiment: toneResult.sentiment,
        urgency: toneResult.urgency,
        language: intentResult.language,
        provider: intentResult.provider as any,
        processingTimeMs,
        semanticSimilarItems: (intentResult as any).semanticSimilarItems,
      };

      // Capture conversation for training (async, don't block)
      this.captureConversationAsync(dto, result).catch((err) =>
        this.logger.warn(`Failed to capture conversation: ${err.message}`)
      );

      // ✨ Self-Learning: Process prediction for confidence-based auto-approval
      this.processSelfLearning(dto, result).catch((err) =>
        this.logger.warn(`Self-learning processing failed: ${err.message}`)
      );

      this.logger.log(
        `Classified "${dto.text}" → ${intentResult.intent} (${intentResult.confidence.toFixed(2)}) | Tone: ${toneResult.tone} (urgency: ${toneResult.urgency.toFixed(2)}) | Provider: ${intentResult.provider} [${processingTimeMs}ms]`,
      );

      return result;
    } catch (error) {
      this.logger.error(`NLU classification failed: ${error.message}`, error.stack);

      // Fallback to basic heuristics
      return this.fallbackClassification(dto.text, Date.now() - startTime);
    }
  }

  private fallbackClassification(text: string, timeMs: number): ClassificationResultDto {
    const lowerText = text.toLowerCase().trim();

    // Simple keyword matching
    const intents = {
      greeting: ['hi', 'hello', 'hey', 'namaste', 'good morning'],
      track_order: ['track', 'order status', 'where is my order', 'delivery status'],
      parcel_booking: ['parcel', 'send package', 'courier', 'delivery'],
      search_product: ['search', 'find', 'show me', 'looking for', 'buy', 'purchase', 'need a', 'want a', 'shop', 'mobile cover', 'phone cover', 'shoes', 'headphone', 'laptop'],
      checkout: ['checkout', 'check out', 'place order', 'confirm order', 'pay now', 'proceed to payment', 'finalize', 'complete order', 'order karo'],
      view_cart: ['show cart', 'view cart', 'my cart', 'cart items', 'cart dikhao', 'what in cart'],
      help: ['help me', 'need support', 'having problem', 'facing issue'],
      order_food: ['order', 'food', 'hungry', 'eat', 'pizza', 'burger', 'biryani', 'paneer', 'menu'],
      login: ['login', 'sign in', 'auth', 'register', 'signup'],
    };

    for (const [intent, keywords] of Object.entries(intents)) {
      if (keywords.some((kw) => lowerText.includes(kw))) {
        return {
          intent,
          confidence: 0.5,
          entities: {},
          language: 'en',
          provider: 'fallback',
          processingTimeMs: timeMs,
        };
      }
    }

    // Enhanced fallback for unknown intents
    // Instead of just returning 'unknown', we can try to guide the user
    return {
      intent: 'unknown',
      confidence: 0.2,
      entities: {},
      language: 'en',
      provider: 'fallback',
      processingTimeMs: timeMs,
    };
  }

  /**
   * Captures conversation to PostgreSQL for training data collection
   * Runs asynchronously to not block NLU response
   */
  private async captureConversationAsync(
    dto: ClassifyTextDto,
    result: ClassificationResultDto
  ) {
    if (!this.captureTrainingData) {
      return;
    }

    // Extract module info from intent
    const { moduleId, moduleType } = this.extractModuleFromIntent(result.intent);

    await this.conversationCapture.captureConversation({
      sessionId: dto.sessionId || 'unknown',
      phoneNumber: dto.phoneNumber || dto.userId || 'unknown',
      userId: dto.userId ? parseInt(dto.userId, 10) : undefined,
      userMessage: dto.text,
      messageType: 'text',
      messageLanguage: result.language,
      nluIntent: result.intent,
      nluConfidence: result.confidence,
      nluModuleId: moduleId,
      nluModuleType: moduleType,
      nluProvider: result.provider,
      nluEntities: result.entities,
      nluTone: result.tone,
      nluProcessingTimeMs: result.processingTimeMs,
      conversationContext: dto.context,
      platform: 'whatsapp',
    });
  }

  /**
   * Extracts module_id and module_type from intent
   * 
   * Examples:
   * - intent.parcel.create → module_id=3, module_type='parcel'
   * - intent.food.item.search → module_id=4, module_type='food'
   * - intent.ecommerce.cart.add → module_id=5, module_type='ecommerce'
   */
  private extractModuleFromIntent(intent: string): {
    moduleId: number;
    moduleType: string;
  } {
    if (intent.includes('parcel')) {
      return { moduleId: 3, moduleType: 'parcel' };
    } else if (intent.includes('food')) {
      return { moduleId: 4, moduleType: 'food' };
    } else if (intent.includes('ecommerce') || intent.includes('shop')) {
      return { moduleId: 5, moduleType: 'ecommerce' };
    } else {
      // Default to food (most common)
      return { moduleId: 4, moduleType: 'food' };
    }
  }

  /**
   * ✨ Self-Learning Pipeline Integration
   * 
   * Processes NLU predictions for the self-learning system:
   * - High confidence (≥0.9) → Auto-approve for training
   * - Medium confidence (0.7-0.9) → Queue for human review
   * - Low confidence (<0.7) → Priority review + Label Studio
   */
  private async processSelfLearning(
    dto: ClassifyTextDto,
    result: ClassificationResultDto
  ): Promise<void> {
    if (!this.selfLearningService) {
      return; // Self-learning not available
    }

    // Skip common greetings and short messages
    const skipPatterns = ['hi', 'hello', 'hey', 'ok', 'yes', 'no', 'thanks', 'bye'];
    if (skipPatterns.includes(dto.text.trim().toLowerCase()) || dto.text.length < 3) {
      return;
    }

    // Skip unknown intents with very low confidence
    if (result.intent === 'unknown' && result.confidence < 0.3) {
      return;
    }

    try {
      const learningResult = await this.selfLearningService.processPrediction({
        text: dto.text,
        intent: result.intent,
        confidence: result.confidence,
        entities: Object.entries(result.entities || {}).map(([entity, value]) => ({
          entity,
          value: String(value),
          confidence: result.confidence,
          start: 0,
          end: dto.text.length,
        })),
        conversationId: dto.sessionId,
        userId: dto.userId,
        timestamp: new Date(),
      });

      this.logger.debug(
        `Self-learning: ${learningResult.action} - ${learningResult.message}`
      );
    } catch (error: any) {
      this.logger.warn(`Self-learning error: ${error.message}`);
    }
  }
}
