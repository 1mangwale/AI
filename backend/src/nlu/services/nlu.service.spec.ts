import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NluService } from './nlu.service';
import { IntentClassifierService } from './intent-classifier.service';
import { EntityExtractorService } from './entity-extractor.service';
import { ToneAnalyzerService } from './tone-analyzer.service';
import { LlmIntentExtractorService } from './llm-intent-extractor.service';
import { NluTrainingDataService } from './nlu-training-data.service';
import { ConversationCaptureService } from '../../services/conversation-capture.service';
import { ClassifyTextDto } from '../dto/classify-text.dto';

describe('NluService', () => {
  let service: NluService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        NLU_AI_ENABLED: 'true',
        NLU_CONFIDENCE_THRESHOLD: '0.7',
        NLU_LLM_FALLBACK_ENABLED: 'true',
        NLU_CAPTURE_TRAINING_DATA: 'true',
      };
      return config[key] ?? defaultValue;
    }),
  };

  const mockIntentClassifier = {
    classify: jest.fn(),
  };

  const mockEntityExtractor = {
    extract: jest.fn(),
  };

  const mockToneAnalyzer = {
    analyzeTone: jest.fn(),
  };

  const mockLlmIntentExtractor = {
    extractIntent: jest.fn(),
  };

  const mockTrainingDataService = {
    captureTrainingSample: jest.fn().mockResolvedValue(undefined),
  };

  const mockConversationCapture = {
    captureConversation: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NluService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: IntentClassifierService, useValue: mockIntentClassifier },
        { provide: EntityExtractorService, useValue: mockEntityExtractor },
        { provide: ToneAnalyzerService, useValue: mockToneAnalyzer },
        { provide: LlmIntentExtractorService, useValue: mockLlmIntentExtractor },
        { provide: NluTrainingDataService, useValue: mockTrainingDataService },
        { provide: ConversationCaptureService, useValue: mockConversationCapture },
      ],
    }).compile();

    service = module.get<NluService>(NluService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });
  });

  describe('classify', () => {
    const baseDto: ClassifyTextDto = {
      text: 'Hello, I want to order food',
      language: 'en',
      sessionId: 'session123',
      userId: 'user123',
    };

    beforeEach(() => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'order_food',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      mockEntityExtractor.extract.mockResolvedValue({
        food_type: 'pizza',
      });

      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'neutral',
        sentiment: 'positive',
        urgency: 0.3,
      });

      mockConversationCapture.captureConversation.mockResolvedValue(undefined);
    });

    it('should classify text successfully', async () => {
      const result = await service.classify(baseDto);

      expect(result).toBeDefined();
      expect(result.intent).toBe('order_food');
      expect(result.confidence).toBe(0.9);
      expect(result.entities).toEqual({ food_type: 'pizza' });
      expect(result.tone).toBe('neutral');
      expect(result.sentiment).toBe('positive');
    });

    it('should call intent classifier with correct params', async () => {
      await service.classify(baseDto);

      expect(mockIntentClassifier.classify).toHaveBeenCalledWith(
        baseDto.text,
        baseDto.language,
        baseDto.context,
      );
    });

    it('should extract entities', async () => {
      await service.classify(baseDto);

      expect(mockEntityExtractor.extract).toHaveBeenCalledWith(
        baseDto.text,
        '',
        'en',
      );
    });

    it('should analyze tone', async () => {
      await service.classify(baseDto);

      expect(mockToneAnalyzer.analyzeTone).toHaveBeenCalledWith(
        baseDto.text,
        baseDto.language,
      );
    });

    it('should capture training data for LLM fallback results', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.8,
        language: 'en',
        provider: 'llm',
      });

      await service.classify(baseDto);

      expect(mockTrainingDataService.captureTrainingSample).toHaveBeenCalled();
    });

    it('should not capture training data for low confidence LLM results', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.3,
        language: 'en',
        provider: 'llm',
      });

      await service.classify(baseDto);

      expect(mockTrainingDataService.captureTrainingSample).not.toHaveBeenCalled();
    });

    it('should capture and auto-approve training data for high confidence non-LLM providers', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify(baseDto);

      // High confidence IndicBERT predictions (>=0.85) are captured with auto-approve
      expect(mockTrainingDataService.captureTrainingSample).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'nlu',
          reviewStatus: 'approved',
        }),
      );
    });

    it('should capture conversation async', async () => {
      await service.classify(baseDto);

      // Give time for async capture
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalled();
    });

    it('should include processing time in result', async () => {
      const result = await service.classify(baseDto);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return fallback classification on error', async () => {
      mockIntentClassifier.classify.mockRejectedValue(new Error('API error'));

      const result = await service.classify({ ...baseDto, text: 'order food' });

      expect(result.provider).toBe('fallback');
      expect(result.intent).toBe('order_food');
    });
  });

  describe('Fallback Classification', () => {
    beforeEach(() => {
      mockIntentClassifier.classify.mockRejectedValue(new Error('API error'));
    });

    it('should classify greetings', async () => {
      const result = await service.classify({ text: 'Hello there' } as ClassifyTextDto);

      expect(result.intent).toBe('greeting');
      expect(result.provider).toBe('fallback');
    });

    it('should classify track order', async () => {
      const result = await service.classify({ text: 'Where is my order?' } as ClassifyTextDto);

      expect(result.intent).toBe('track_order');
    });

    it('should classify parcel booking', async () => {
      const result = await service.classify({ text: 'I want to send a parcel' } as ClassifyTextDto);

      expect(result.intent).toBe('parcel_booking');
    });

    it('should classify product search', async () => {
      const result = await service.classify({ text: 'Search for shoes' } as ClassifyTextDto);

      expect(result.intent).toBe('search_product');
    });

    it('should classify help requests', async () => {
      const result = await service.classify({ text: 'I need support' } as ClassifyTextDto);

      expect(result.intent).toBe('help');
    });

    it('should classify food orders', async () => {
      const result = await service.classify({ text: 'I want to order pizza' } as ClassifyTextDto);

      expect(result.intent).toBe('order_food');
    });

    it('should classify food-related keywords', async () => {
      const foodKeywords = ['hungry', 'biryani', 'burger', 'paneer', 'menu'];
      
      for (const keyword of foodKeywords) {
        const result = await service.classify({ text: `I want ${keyword}` } as ClassifyTextDto);
        expect(result.intent).toBe('order_food');
      }
    });

    it('should classify login requests', async () => {
      const result = await service.classify({ text: 'I want to login' } as ClassifyTextDto);

      expect(result.intent).toBe('login');
    });

    it('should return unknown for unrecognized text', async () => {
      const result = await service.classify({ text: 'xyzabc random text' } as ClassifyTextDto);

      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0.2);
    });

    it('should be case insensitive', async () => {
      const result = await service.classify({ text: 'HELLO THERE' } as ClassifyTextDto);

      expect(result.intent).toBe('greeting');
    });
  });

  describe('Module Extraction from Intent', () => {
    beforeEach(() => {
      mockEntityExtractor.extract.mockResolvedValue({});
      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0,
      });
      mockConversationCapture.captureConversation.mockResolvedValue(undefined);
    });

    it('should extract parcel module', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'intent.parcel.create',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify({ text: 'send parcel' } as ClassifyTextDto);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          nluModuleId: 3,
          nluModuleType: 'parcel',
        }),
      );
    });

    it('should extract food module', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'intent.food.order',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify({ text: 'order food' } as ClassifyTextDto);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          nluModuleId: 4,
          nluModuleType: 'food',
        }),
      );
    });

    it('should extract ecommerce module', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'intent.ecommerce.cart.add',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify({ text: 'add to cart' } as ClassifyTextDto);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          nluModuleId: 5,
          nluModuleType: 'ecommerce',
        }),
      );
    });

    it('should extract shop as ecommerce module', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'intent.shop.browse',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify({ text: 'browse shop' } as ClassifyTextDto);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          nluModuleId: 5,
          nluModuleType: 'ecommerce',
        }),
      );
    });

    it('should default to food module for unknown intents', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });

      await service.classify({ text: 'hello' } as ClassifyTextDto);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockConversationCapture.captureConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          nluModuleId: 4,
          nluModuleType: 'food',
        }),
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle conversation capture failures gracefully', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });
      mockEntityExtractor.extract.mockResolvedValue({});
      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0,
      });
      mockConversationCapture.captureConversation.mockRejectedValue(
        new Error('Database error'),
      );

      // Should not throw
      const result = await service.classify({ text: 'hello' } as ClassifyTextDto);

      expect(result).toBeDefined();
      expect(result.intent).toBe('greeting');
    });

    it('should handle training data capture failures gracefully', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.8,
        language: 'en',
        provider: 'llm',
      });
      mockEntityExtractor.extract.mockResolvedValue({});
      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0,
      });
      mockTrainingDataService.captureTrainingSample.mockRejectedValue(
        new Error('Database error'),
      );
      mockConversationCapture.captureConversation.mockResolvedValue(undefined);

      // Should not throw
      const result = await service.classify({ text: 'hello' } as ClassifyTextDto);

      expect(result).toBeDefined();
      expect(result.intent).toBe('greeting');
    });

    it('should handle entity extraction failures', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });
      mockEntityExtractor.extract.mockRejectedValue(new Error('Extraction error'));

      const result = await service.classify({ text: 'hello' } as ClassifyTextDto);

      expect(result.provider).toBe('fallback');
    });

    it('should handle tone analysis failures', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });
      mockEntityExtractor.extract.mockResolvedValue({});
      mockToneAnalyzer.analyzeTone.mockRejectedValue(new Error('Analysis error'));

      const result = await service.classify({ text: 'hello' } as ClassifyTextDto);

      expect(result.provider).toBe('fallback');
    });
  });

  describe('Classification Result Format', () => {
    beforeEach(() => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'order_food',
        confidence: 0.9,
        language: 'en',
        provider: 'indicbert',
      });
      mockEntityExtractor.extract.mockResolvedValue({ food: 'pizza' });
      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'happy',
        sentiment: 'positive',
        urgency: 0.5,
      });
      mockConversationCapture.captureConversation.mockResolvedValue(undefined);
    });

    it('should return all required fields', async () => {
      const result = await service.classify({
        text: 'Order pizza',
      } as ClassifyTextDto);

      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('entities');
      expect(result).toHaveProperty('language');
      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('processingTimeMs');
    });

    it('should include tone and sentiment when available', async () => {
      const result = await service.classify({
        text: 'Order pizza',
      } as ClassifyTextDto);

      expect(result.tone).toBe('happy');
      expect(result.sentiment).toBe('positive');
      expect(result.urgency).toBe(0.5);
    });

    it('should include detected language', async () => {
      const result = await service.classify({
        text: 'Order pizza',
      } as ClassifyTextDto);

      expect(result.language).toBe('en');
    });
  });

  describe('Language Support', () => {
    beforeEach(() => {
      mockEntityExtractor.extract.mockResolvedValue({});
      mockToneAnalyzer.analyzeTone.mockResolvedValue({
        tone: 'neutral',
        sentiment: 'neutral',
        urgency: 0,
      });
      mockConversationCapture.captureConversation.mockResolvedValue(undefined);
    });

    it('should pass language to classifier', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'hi',
        provider: 'indicbert',
      });

      await service.classify({
        text: 'नमस्ते',
        language: 'hi',
      } as ClassifyTextDto);

      expect(mockIntentClassifier.classify).toHaveBeenCalledWith(
        'नमस्ते',
        'hi',
        undefined,
      );
    });

    it('should handle auto language detection', async () => {
      mockIntentClassifier.classify.mockResolvedValue({
        intent: 'greeting',
        confidence: 0.9,
        language: 'auto',
        provider: 'indicbert',
      });

      const result = await service.classify({
        text: 'Hello',
      } as ClassifyTextDto);

      expect(result.language).toBe('auto');
    });
  });
});
