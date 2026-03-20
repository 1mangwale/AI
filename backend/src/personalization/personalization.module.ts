import { Module } from '@nestjs/common';
import { ConversationAnalyzerService } from './conversation-analyzer.service';
import { UserProfilingService } from './user-profiling.service';
import { UserPreferenceService } from './user-preference.service';
import { ConversationEnrichmentService } from './conversation-enrichment.service';
import { ProgressiveProfileService } from './progressive-profile.service';
import { AdaptiveFlowService } from './adaptive-flow.service';
import { OrderSyncService } from './order-sync.service';
import { ProfileEnrichmentScheduler } from './profile-enrichment-scheduler.service';
import { BehavioralAnalyticsService } from './services/behavioral-analytics.service';
import { RecommendationEngineService } from './services/recommendation-engine.service';
import { CollectionsService } from './collections.service';
import { NluPreferenceExtractorService } from './nlu-preference-extractor.service';
import { ProfileContextBuilderService } from './profile-context-builder.service';
import { PersonalizationController } from './personalization.controller';
import { RecommendationsController } from './controllers/recommendations.controller';
import { CustomerIntelligenceController } from './controllers/customer-intelligence.controller';
import { LlmModule } from '../llm/llm.module';
import { DatabaseModule } from '../database/database.module';
import { UserContextModule } from '../user-context/user-context.module';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { StoresModule } from '../stores/stores.module';
import { SessionModule } from '../session/session.module';
import { RedisModule } from '../redis/redis.module';
import { ScheduleModule } from '@nestjs/schedule';

/**
 * Personalization Module
 * 
 * Provides AI-powered user profiling and search personalization
 * by analyzing conversations to extract preferences, dietary restrictions,
 * tone, and personality traits.
 * 
 * Architecture:
 * 1. ConversationAnalyzerService → Extracts insights using LLM (Qwen)
 * 2. UserProfilingService → Builds/updates user profiles in PostgreSQL
 * 3. UserPreferenceService → Provides preference context for agent prompts
 * 4. PersonalizationController → Exposes APIs for Search API integration
 * 5. OrderSyncService → Caches MySQL orders in PostgreSQL (10x faster)
 * 6. ProfileEnrichmentScheduler → Auto-refreshes stale profiles every 6 hours
 * 7. BehavioralAnalyticsService → RFM scoring, purchase pattern analysis
 * 8. RecommendationEngineService → AI-powered product recommendations
 * 
 * Data Flow:
 * conversation_messages → analyze → user_profiles → opensearch boosts
 * user_profiles → preference context → agent prompts
 * order_history → behavioral analytics → RFM segments → recommendations
 */
@Module({
  imports: [
    LlmModule,
    DatabaseModule,
    UserContextModule,
    PhpIntegrationModule,
    StoresModule,
    SessionModule,
    RedisModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [PersonalizationController, RecommendationsController, CustomerIntelligenceController],
  providers: [
    ConversationAnalyzerService,
    UserProfilingService,
    UserPreferenceService,
    ConversationEnrichmentService,
    ProgressiveProfileService,
    AdaptiveFlowService,
    OrderSyncService,
    ProfileEnrichmentScheduler,
    BehavioralAnalyticsService,
    RecommendationEngineService,
    CollectionsService,
    NluPreferenceExtractorService,
    ProfileContextBuilderService,
  ],
  exports: [
    ConversationAnalyzerService,
    UserProfilingService,
    UserPreferenceService,
    ConversationEnrichmentService,
    ProgressiveProfileService,
    AdaptiveFlowService,
    OrderSyncService,
    ProfileEnrichmentScheduler,
    BehavioralAnalyticsService,
    RecommendationEngineService,
    CollectionsService,
    NluPreferenceExtractorService,
    ProfileContextBuilderService,
  ],
})
export class PersonalizationModule {}
