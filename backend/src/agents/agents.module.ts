import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SessionModule } from '../session/session.module';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { AuthModule } from '../auth/auth.module'; // ✨ Auth trigger for transaction intents
import { ZonesModule } from '../zones/zones.module'; // ✨ Zone detection for function executor
import { IntegrationsModule } from '../integrations/integrations.module'; // ✨ Optional integration clients + GooglePlaces
import { OrchestratorModule } from '../orchestrator/orchestrator.module'; // ✨ SearchOrchestrator for OpenSearch/PHP routing
import { MessagingModule } from '../messaging/messaging.module'; // ✨ For ChatWebController MessageGateway integration
import { LearningModule } from '../learning/learning.module'; // ✨ Self-learning mistake tracker
import { ReviewsModule } from '../reviews/reviews.module'; // ✨ Review intelligence
import { PricingModule } from '../pricing/pricing.module'; // ✨ Value proposition
import { AgentOrchestratorService } from './services/agent-orchestrator.service';
import { AgentRegistryService } from './services/agent-registry.service';
import { IntentRouterService } from './services/intent-router.service';
import { FunctionExecutorService } from './services/function-executor.service';
import { QueryParserService } from './services/query-parser.service';
import { FlowTestController } from './controllers/flow-test.controller';
import { ChatWebController } from './controllers/chat-web.controller';
import { VoiceController } from './controllers/voice.controller';
import { AnalyticsController } from './controllers/analytics.controller';
import { AgentsController } from './controllers/agents.controller';
import { AgentTestController } from './controllers/agent-test.controller';
import { NluClientService } from '../services/nlu-client.service';
import { AddressExtractionService } from './services/address-extraction.service';
import { AgentHandoffService } from './services/agent-handoff.service';
import { ConversationLoggerService } from '../database/conversation-logger.service';
import { NluModule } from '../nlu/nlu.module';
import { LlmModule } from '../llm/llm.module'; // ✨ Uses local vLLM service
import { SearchModule } from '../search/search.module';
import { FlowEngineModule } from '../flow-engine/flow-engine.module';
import { DatabaseModule } from '../database/database.module';
import { GamificationModule } from '../gamification/gamification.module'; // ✨ Gamification integration
import { PersonalizationModule } from '../personalization/personalization.module'; // ✨ Personalization integration
import { UserModule } from '../user/user.module'; // ✨ User sync service
import { SettingsModule } from '../settings/settings.module';
import { VoiceCharactersModule } from '../voice-characters/voice-characters.module'; // ✨ Voice character personas for chatbot // ✨ Settings service
import { VoiceModule } from '../voice/voice.module'; // ✨ Voice IVR pipeline integration
// Import agent implementations
import { FAQAgent } from './agents/faq.agent';
import { SearchAgent } from './agents/search.agent';
import { OrderAgent } from './agents/order.agent';
import { ComplaintsAgent } from './agents/complaints.agent';
import { BookingAgent } from './agents/booking.agent';
import { VendorAgent } from './agents/vendor.agent'; // ✨ B2B vendor agent
import { RiderAgent } from './agents/rider.agent'; // ✨ Delivery partner agent
import { AgentsService } from './services/agents.service';
import { EnhancedAgentToolsService } from './services/enhanced-agent-tools.service'; // ✨ Enhanced tools
import { LlmToolsService } from './services/llm-tools.service'; // ✨ LLM Tools for search, recommendations, compare prices
import { LanguageDetectionService } from './services/language-detection.service'; // ✨ Language detection for multilingual support
import { QuestionClassifierService } from './services/question-classifier.service'; // ✨ ML-based question detection
import { IntelligentResponseGenerator } from './services/intelligent-response.service'; // ✨ LLM-powered context-aware responses
import { ConversationDeduplicationService } from './services/conversation-memory.service'; // ✨ Conversation dedup + preference extraction
import { QuestionClassifierMetrics } from './services/metrics/question-classifier.metrics'; // ✨ Prometheus metrics for question classification
import { IntelligentResponseMetrics } from './services/metrics/intelligent-response.metrics'; // ✨ Prometheus metrics for response generation
import { ConversationMemoryMetrics } from './services/metrics/conversation-memory.metrics'; // ✨ Prometheus metrics for memory operations
import { SentimentAnalysisService } from './services/sentiment-analysis.service'; // ✨ Frustration detection and proactive support
import { ABTestingFrameworkService } from './services/ab-testing.service'; // ✨ A/B testing for feature comparison
import { AdvancedLearningService } from './services/advanced-learning.service'; // ✨ Fine-tuning on real conversation data
import { FlowDispatcherService } from './services/flow-dispatcher.service'; // ✨ Option A: Flow routing extracted from orchestrator
import { GameHandlerService } from './services/game-handler.service'; // ✨ Option A: Game logic extracted from orchestrator

/**
 * Agents Module
 * 
 * Provides intelligent agent system with:
 * - Flow management integration
 * - Intent classification and routing
 * - LLM-powered conversation handling (local vLLM)
 * - Function calling capabilities
 * - Web chat interface (via ConversationService)
 * - Voice transcription and synthesis (ASR/TTS proxy)
 * - Address extraction from multiple formats (Google Maps, coordinates, text, LLM)
 * - PostgreSQL conversation logging for training & analytics
 * - SearchOrchestrator for OpenSearch/PHP routing
 * 
 * NO ADMIN BACKEND - All services are local!
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5, // Increased for Google Maps short link resolution
    }),
    SessionModule,
    PhpIntegrationModule,
    AuthModule, // ✨ Auth trigger for transaction intents
    ZonesModule, // ✨ Zone detection for search functions
    IntegrationsModule, // ✨ Optional Payment & Routing clients
    OrchestratorModule, // ✨ SearchOrchestrator for intelligent routing
    forwardRef(() => MessagingModule), // ✨ For ChatWebController - MessageGateway (use forwardRef for circular dep)
    forwardRef(() => NluModule), // ✨ Local IndicBERT NLU (forwardRef for circular dep)
    forwardRef(() => LlmModule), // ✨ Local vLLM service (forwardRef for circular dep)
    forwardRef(() => SearchModule), // ✨ Search for product queries (forwardRef for circular dep)
    forwardRef(() => FlowEngineModule), // ✨ Modern State Machine Flow Engine (use forwardRef to avoid circular dependency)
    DatabaseModule, // ✨ For AgentsService to access Prisma
    GamificationModule, // ✨ Gamification integration
    PersonalizationModule, // ✨ Personalization integration
    UserModule, // ✨ User sync service
    SettingsModule, // ✨ Settings service
    VoiceCharactersModule, // ✨ Voice character personas for Mercury TTS
    LearningModule, // ✨ Self-learning mistake tracker
    ReviewsModule, // ✨ Review intelligence
    PricingModule, // ✨ Value proposition
    forwardRef(() => VoiceModule), // ✨ Voice IVR pipeline integration
  ],
  controllers: [
    FlowTestController,
    ChatWebController,
    VoiceController,
    AnalyticsController, // ✨ Conversation analytics & training data export
    AgentsController, // ✨ REST API for agent management
    AgentTestController, // ✨ Test endpoint for E2E testing
  ],
  providers: [
    AgentOrchestratorService,
    AgentRegistryService,
    IntentRouterService,
    QueryParserService,
    NluClientService,
    AddressExtractionService,
    FunctionExecutorService, // ✨ Re-enabled with proper dependencies
    ConversationLoggerService, // ✨ PostgreSQL conversation logging
    AgentsService, // ✨ Agent statistics and management
    AgentHandoffService, // ✨ Agent-to-agent handoff mechanism
    EnhancedAgentToolsService, // ✨ Google Places, Reviews, Self-learning tools
    LlmToolsService, // ✨ LLM Tools for search, recommendations, compare prices
    LanguageDetectionService, // ✨ Language detection for multilingual support
    QuestionClassifierService, // ✨ ML-based question classification (pattern + LLM hybrid)
    QuestionClassifierMetrics, // ✨ Prometheus metrics for question classification
    IntelligentResponseGenerator, // ✨ LLM-generated context-aware responses
    IntelligentResponseMetrics, // ✨ Prometheus metrics for response generation
    ConversationDeduplicationService, // ✨ Repeated question detection + preference extraction
    ConversationMemoryMetrics, // ✨ Prometheus metrics for conversation memory
    SentimentAnalysisService, // ✨ Phase 2: Frustration detection
    ABTestingFrameworkService, // ✨ Phase 2: A/B testing framework
    AdvancedLearningService, // ✨ Phase 2: Advanced learning on real data
    FlowDispatcherService, // ✨ Option A: Flow routing (extracted from orchestrator)
    GameHandlerService, // ✨ Option A: Game logic (extracted from orchestrator)
    // Agent implementations
    FAQAgent,
    SearchAgent,
    OrderAgent,
    ComplaintsAgent,
    BookingAgent,
    VendorAgent, // ✨ B2B vendor/restaurant owner agent
    RiderAgent, // ✨ Delivery partner agent
  ],
  exports: [
    AgentOrchestratorService,
    AgentRegistryService,
    IntentRouterService,
    ConversationLoggerService, // ✨ Export for use in ChatGateway
    AddressExtractionService, // ✨ Export for use in FlowEngine
    AgentHandoffService, // ✨ Export for agent handoff capability
    EnhancedAgentToolsService, // ✨ Export enhanced tools
    LlmToolsService, // ✨ Export LLM tools for other modules
    LanguageDetectionService, // ✨ Export for use in FlowEngine LlmExecutor
    QuestionClassifierService, // ✨ Export for use in AddressExecutor and other flow executors
    IntelligentResponseGenerator, // ✨ Export for generating intelligent responses
    ConversationDeduplicationService, // ✨ Export for memory-based context gathering
    SentimentAnalysisService, // ✨ Export Phase 2: Sentiment analysis
    ABTestingFrameworkService, // ✨ Export Phase 2: A/B testing
    AdvancedLearningService, // ✨ Export Phase 2: Advanced learning
    FlowDispatcherService, // ✨ Option A: Flow routing
    GameHandlerService, // ✨ Option A: Game logic
  ],
})
export class AgentsModule {}
