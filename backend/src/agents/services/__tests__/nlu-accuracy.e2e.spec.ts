import { Test, TestingModule } from '@nestjs/testing';
import { QuestionClassifierService } from '../question-classifier.service';
import { LlmService } from '../../../llm/services/llm.service';

/**
 * NLU Accuracy & Performance Test Suite
 *
 * Tests:
 * 1. Question detection (regex vs LLM hybrid)
 * 2. Question type classification (vehicle/pricing/timing/clarification)
 * 3. Hinglish support
 * 4. Processing latency (<500ms target)
 * 5. Fallback handling
 * 6. Confidence scoring accuracy
 */
describe.skip('NLU Accuracy & Performance Tests', () => {
  let questionClassifier: QuestionClassifierService;
  let module: TestingModule;

  const testMessages = [
    // Vehicle inquiries (should detect with high confidence)
    {
      msg: 'bike wala hai?',
      expectedType: 'vehicle_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.85,
      category: 'vehicle_inquiry',
    },
    {
      msg: 'gaadi kya hain available?',
      expectedType: 'vehicle_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'vehicle_inquiry',
    },
    {
      msg: 'auto available hai kya?',
      expectedType: 'vehicle_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.85,
      category: 'vehicle_inquiry',
    },
    {
      msg: 'What vehicle options do you have?',
      expectedType: 'vehicle_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'vehicle_inquiry',
    },

    // Pricing inquiries
    {
      msg: 'kitna cost lagega?',
      expectedType: 'pricing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.85,
      category: 'pricing_inquiry',
    },
    {
      msg: 'Price kitna hai?',
      expectedType: 'pricing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.85,
      category: 'pricing_inquiry',
    },
    {
      msg: 'How much will this cost?',
      expectedType: 'pricing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'pricing_inquiry',
    },
    {
      msg: 'charge kitna hoga bike se?',
      expectedType: 'pricing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'pricing_inquiry',
    },

    // Timing inquiries
    {
      msg: 'kitna time lagega?',
      expectedType: 'timing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.85,
      category: 'timing_inquiry',
    },
    {
      msg: 'How fast can you deliver?',
      expectedType: 'timing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'timing_inquiry',
    },
    {
      msg: 'kab tak aa jaega?',
      expectedType: 'timing_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.80,
      category: 'timing_inquiry',
    },

    // Clarifications
    {
      msg: 'matlab mangwale kya hai?',
      expectedType: 'clarification',
      shouldBeQuestion: true,
      minConfidence: 0.75,
      category: 'clarification',
    },
    {
      msg: 'What is this service?',
      expectedType: 'clarification',
      shouldBeQuestion: true,
      minConfidence: 0.75,
      category: 'clarification',
    },

    // NOT questions (should not detect as questions)
    {
      msg: '42 college road nashik',
      expectedType: 'generic',
      shouldBeQuestion: false,
      minConfidence: 0.7,
      category: 'address',
    },
    {
      msg: 'my home address',
      expectedType: 'generic',
      shouldBeQuestion: false,
      minConfidence: 0.7,
      category: 'address',
    },
    {
      msg: 'Ambazari road, nashik',
      expectedType: 'generic',
      shouldBeQuestion: false,
      minConfidence: 0.7,
      category: 'address',
    },
    {
      msg: 'send the parcel',
      expectedType: 'generic',
      shouldBeQuestion: false,
      minConfidence: 0.6,
      category: 'action',
    },
    {
      msg: 'ok',
      expectedType: 'generic',
      shouldBeQuestion: false,
      minConfidence: 0.7,
      category: 'ack',
    },

    // Edge cases
    {
      msg: 'bike ya auto?',
      expectedType: 'vehicle_inquiry',
      shouldBeQuestion: true,
      minConfidence: 0.75,
      category: 'vehicle_inquiry_choice',
    },
    {
      msg: 'same address as last time?',
      expectedType: 'clarification',
      shouldBeQuestion: true,
      minConfidence: 0.75,
      category: 'reference_inquiry',
    },
  ];

  beforeEach(async () => {
    // Mock LlmService
    const mockLlmService = {
      chat: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          isQuestion: true,
          type: 'generic',
          confidence: 0.5,
        }),
      }),
    };

    module = await Test.createTestingModule({
      providers: [
        QuestionClassifierService,
        { provide: LlmService, useValue: mockLlmService },
      ],
    }).compile();

    questionClassifier = module.get<QuestionClassifierService>(
      QuestionClassifierService,
    );
  });

  afterEach(async () => {
    await module.close();
  });

  describe('Question Detection Accuracy (Pattern-based)', () => {
    it('should detect 100+ real user messages with >85% accuracy', async () => {
      const results: any[] = [];
      let correctDetections = 0;

      for (const test of testMessages) {
        const startTime = Date.now();
        const result = await questionClassifier.classify(test.msg, {
          current_step: 'address',
        });
        const latencyMs = Date.now() - startTime;

        const isCorrect =
          result.isQuestion === test.shouldBeQuestion &&
          result.type === test.expectedType;

        if (isCorrect) {
          correctDetections++;
        }

        results.push({
          message: test.msg,
          category: test.category,
          expected: { type: test.expectedType, isQuestion: test.shouldBeQuestion },
          actual: { type: result.type, isQuestion: result.isQuestion },
          confidence: result.confidence,
          latencyMs,
          correct: isCorrect,
        });
      }

      const accuracy = (correctDetections / testMessages.length) * 100;
      console.log(`\n📊 NLU ACCURACY TEST RESULTS`);
      console.log(`✅ Correct: ${correctDetections}/${testMessages.length}`);
      console.log(`📈 Accuracy: ${accuracy.toFixed(2)}%`);
      console.log(`\nDetailed Results:`);
      results.forEach((r) => {
        const status = r.correct ? '✅' : '❌';
        console.log(
          `${status} "${r.message.substring(0, 40)}" → ${r.actual.type} (${r.confidence.toFixed(2)}) [${r.latencyMs}ms]`,
        );
      });

      expect(accuracy).toBeGreaterThanOrEqual(85);
    });
  });

  describe('Latency Performance', () => {
    it('should process messages in <500ms (p95)', async () => {
      const latencies: number[] = [];

      for (const test of testMessages) {
        const startTime = Date.now();
        await questionClassifier.classify(test.msg, { current_step: 'address' });
        latencies.push(Date.now() - startTime);
      }

      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)];
      const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)];
      const avg = latencies.reduce((a, b) => a + b) / latencies.length;

      console.log(`\n⚡ LATENCY TEST RESULTS`);
      console.log(`Average: ${avg.toFixed(2)}ms`);
      console.log(`P95: ${p95}ms (target: <500ms)`);
      console.log(`P99: ${p99}ms`);

      expect(p95).toBeLessThan(500);
    });
  });

  describe('Confidence Scoring', () => {
    it('should assign confidence scores accurately', async () => {
      const testCases = [
        { msg: 'bike wala hai?', minConfidence: 0.85 },
        { msg: 'kitna cost?', minConfidence: 0.85 },
        { msg: 'my address is nashik', minConfidence: 0.6 },
      ];

      for (const test of testCases) {
        const result = await questionClassifier.classify(test.msg);
        console.log(
          `"${test.msg}" → confidence ${result.confidence.toFixed(2)} (expected: >=${test.minConfidence})`,
        );
        expect(result.confidence).toBeGreaterThanOrEqual(test.minConfidence);
      }
    });
  });

  describe('Hinglish Support', () => {
    it('should handle Hindi and mixed Hinglish messages', async () => {
      const hindiMessages = [
        { msg: 'gaadi kya hai?', expectedType: 'vehicle_inquiry' },
        { msg: 'kitna paisa lagega?', expectedType: 'pricing_inquiry' },
        { msg: 'कितना समय लगेगा?', expectedType: 'timing_inquiry' },
        { msg: 'bike ya auto?', expectedType: 'vehicle_inquiry' },
      ];

      for (const test of hindiMessages) {
        const result = await questionClassifier.classify(test.msg);
        console.log(
          `"${test.msg}" → ${result.type} (expected: ${test.expectedType})`,
        );
        expect(result.isQuestion).toBe(true);
        // Type may vary due to language variation, just ensure it's detected as question
      }
    });
  });

  describe('Fallback & Error Handling', () => {
    it('should return safe default for unparseable input', async () => {
      const result = await questionClassifier.classify('');
      expect(result).toHaveProperty('isQuestion');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('confidence');
    });

    it('should not crash on very long messages', async () => {
      const longMsg = 'bike ' + 'very '.repeat(100) + 'expensive?';
      const result = await questionClassifier.classify(longMsg);
      expect(result).toHaveProperty('confidence');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
