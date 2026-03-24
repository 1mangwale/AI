import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FlowEngineService } from './flow-engine.service';
import { FlowContextService } from './flow-context.service';
import { StateMachineEngine } from './state-machine.engine';
import { ExecutorRegistryService } from './executor-registry.service';
import { InputValidatorService } from './executors/input-validator.service';
// Type alias for cleaner imports
const ExecutorRegistry = ExecutorRegistryService;

// Executors
import { LlmExecutor } from './executors/llm.executor';
import { NluExecutor } from './executors/nlu.executor';
import { SearchExecutor } from './executors/search.executor';
import { AddressExecutor } from './executors/address.executor';
import { DistanceExecutor } from './executors/distance.executor';
import { ZoneExecutor } from './executors/zone.executor';
import { PricingExecutor } from './executors/pricing.executor';
import { OrderExecutor } from './executors/order.executor';
import { ResponseExecutor } from './executors/response.executor';
import { GameExecutor } from './executors/game.executor';
import { ParcelExecutor } from './executors/parcel.executor';
import { PreferenceExecutor } from './executors/preference.executor';
import { AuthExecutor } from './executors/auth.executor';
import { PhpApiExecutor } from './executors/php-api.executor';
import { SessionExecutor } from './executors/session.executor';
import { InventoryExecutor } from './executors/inventory.executor';
import { ExternalSearchExecutor } from './executors/external-search.executor';
import { SelectionExecutor } from './executors/selection.executor';
import { ComplexOrderParserExecutor } from './executors/complex-order-parser.executor';
import { GroupOrderSearchExecutor } from './executors/group-order-search.executor';
import { ValuePropositionExecutor } from './executors/value-proposition.executor';
import { AutoCartExecutor } from './executors/auto-cart.executor';
import { AdaptiveExecutor } from './executors/adaptive.executor';
import { CartManagerExecutor } from './executors/cart-manager.executor';
import { ProfileExecutor } from './executors/profile.executor';
import { EntityResolutionExecutor } from './executors/entity-resolution.executor';
import { SavedAddressSelectorExecutor } from './executors/saved-address-selector.executor';
import { MultiStoreSearchExecutor } from './executors/multi-store-search.executor';
// 🚀 AGENTIC AI EXECUTORS (Week 2-3 Transformation)
import { NluConditionExecutor } from './executors/nlu-condition.executor';
import { PureNerExecutor } from './executors/pure-ner.executor';
import { AgentExecutor } from './executors/agent.executor';
import { CollectionsExecutor } from './executors/collections.executor';
import { QuickReorderExecutor } from './executors/quick-reorder.executor';
import { ParcelReorderExecutor } from './executors/parcel-reorder.executor';
import { RecommendationExecutor } from './executors/recommendation.executor';
// Phase 4: mOS Action Engine Executors
import { AssetGenerationExecutor } from './executors/asset-generation.executor';
import { AdExecutionExecutor } from './executors/ad-execution.executor';
import { ApprovalGateExecutor } from './executors/approval-gate.executor';
import { WhatsAppNotifyExecutor } from './executors/whatsapp-notify.executor';
import { BroadcastExecutor } from './executors/broadcast.executor';
// Support
import { SupportTicketExecutor } from './executors/support-ticket.executor';
// Phase 7: Voice & RAG
import { VoiceExecutor } from './executors/voice.executor';
import { QueryRewriterService } from './services/query-rewriter.service';
// Game executors disabled - Prisma schema mismatch
// import { GameScorerExecutor } from './executors/game-scorer.executor';
// import { RewardPointsExecutor } from './executors/reward-points.executor';
import { FlowInitializerService } from './services/flow-initializer.service';
// import { YamlFlowLoaderService } from './services/yaml-flow-loader.service'; // ❌ DISABLED - Conflicts with TypeScript flows
import { YamlV2FlowLoaderService } from './services/yaml-v2-flow-loader.service';
import { FlowVersionManagerService } from './services/flow-version-manager.service';
import { MultiFieldExtractorService } from './services/multi-field-extractor.service';
import { ContextSchemaValidatorService } from './services/context-schema-validator.service';
import { FlowBuilderController } from './controllers/flow-builder.controller';
import { FlowsController } from './flows.controller';

// Dependencies
import { DatabaseModule } from '../database/database.module';
import { SessionModule } from '../session/session.module';
import { LlmModule } from '../llm/llm.module';
import { NluModule } from '../nlu/nlu.module';
import { SearchModule } from '../search/search.module';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { AgentsModule } from '../agents/agents.module';
import { GamificationModule } from '../gamification/gamification.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { OrderModule } from '../order/order.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { AuthModule } from '../auth/auth.module';
import { ContextModule } from '../context/context.module';
import { StoresModule } from '../stores/stores.module';
import { ContextEnhancerService } from './services/context-enhancer.service';
import { PricingValidatorService } from '../common/validators/pricing.validator';
import { AuthValidatorService } from '../common/validators/auth.validator';
import { AddressValidatorService } from '../common/validators/address.validator';
import { BroadcastModule } from '../broadcast/broadcast.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { SupportModule } from '../support/support.module';
import { LearningModule } from '../learning/learning.module';

@Module({
  imports: [
    HttpModule,  // For HttpService in PureNerExecutor
    DatabaseModule,
    SessionModule,
    LlmModule,
    NluModule,
    SearchModule,
    PhpIntegrationModule,
    GamificationModule,
    PersonalizationModule,
    OrderModule,
    PricingModule,
    ProfilesModule,
    AuthModule, // For CentralizedAuthService in AuthExecutor
    ContextModule, // ✨ User Context (Weather, Festivals, City Knowledge)
    StoresModule, // Store schedule/open-closed status
    forwardRef(() => AgentsModule), // Use forwardRef to avoid circular dependency
    forwardRef(() => BroadcastModule), // For BroadcastExecutor
    forwardRef(() => WhatsAppModule), // For WhatsAppNotifyExecutor
    SupportModule, // For SupportTicketExecutor
    LearningModule, // For SelfLearningService (positive training signals on flow completion)
  ],
  controllers: [FlowBuilderController, FlowsController],
  providers: [
    // Core services
    FlowEngineService,
    FlowContextService,
    StateMachineEngine,
    ExecutorRegistryService,
    InputValidatorService, // GAP 3 Fix: Flow-level input validation
    ContextSchemaValidatorService, // GAP 5 Fix: Context schema validation
    FlowInitializerService, // Auto-load flows on startup
    PricingValidatorService, // 🔒 SECURITY: Server-side pricing validation
    AuthValidatorService, // 🔒 SECURITY: User authentication validation
    AddressValidatorService, // 🔒 DATA QUALITY: Address validation to prevent delivery failures
    // YamlFlowLoaderService, // ❌ DISABLED - Legacy YAML v1 flows conflict with TypeScript flows
    YamlV2FlowLoaderService, // Load YAML V2 flows (vendor/driver)
    FlowVersionManagerService, // A/B testing and version control
    ContextEnhancerService, // ✨ Context enhancement for personalized responses
    MultiFieldExtractorService, // ✨ Extract multiple fields in one turn

    // Executors
    LlmExecutor,
    NluExecutor,
    SearchExecutor,
    AddressExecutor,
    DistanceExecutor,
    ZoneExecutor,
    PricingExecutor,
    OrderExecutor,
    ResponseExecutor,
    GameExecutor,
    ParcelExecutor,
    PreferenceExecutor,
    AuthExecutor,
    PhpApiExecutor,
    SessionExecutor,
    InventoryExecutor,
    ExternalSearchExecutor,
    SelectionExecutor,
    ComplexOrderParserExecutor,
    GroupOrderSearchExecutor,
    ValuePropositionExecutor,
    AutoCartExecutor,
    AdaptiveExecutor,
    CartManagerExecutor,
    ProfileExecutor, // Progressive profile collection
    EntityResolutionExecutor, // ✨ Resolve NLU slots to database entities
    SavedAddressSelectorExecutor, // ✨ Auto-select saved address (home/office) from user message
    MultiStoreSearchExecutor, // 🏪 Search items across multiple stores in parallel
    // 🚀 AGENTIC AI EXECUTORS
    NluConditionExecutor, // Replace .includes() with ML-based conditions
    PureNerExecutor, // Pure ML entity extraction (no regex fallback)
    AgentExecutor, // LLM tool-use agent for dynamic orchestration
    CollectionsExecutor, // Smart personalised collections for home screen
    QuickReorderExecutor, // 🔄 One-tap repeat last food order
    ParcelReorderExecutor, // 🔄 One-tap repeat last parcel order
    RecommendationExecutor, // 🎯 Recommendation tracking & upsells
    // GameScorerExecutor, // Disabled - Prisma schema mismatch
    // RewardPointsExecutor, // Disabled - Prisma schema mismatch
    // Phase 4: mOS Action Engine Executors
    AssetGenerationExecutor,
    AdExecutionExecutor,
    ApprovalGateExecutor,
    WhatsAppNotifyExecutor,
    BroadcastExecutor,
    // Support
    SupportTicketExecutor,
    // Phase 7: Voice & RAG
    VoiceExecutor,
    QueryRewriterService,
  ],
  exports: [
    FlowEngineService,
    FlowContextService,
    ExecutorRegistryService,
    // YamlFlowLoaderService, // ❌ DISABLED
    YamlV2FlowLoaderService,
    ContextEnhancerService, // ✨ For use in other modules
    FlowVersionManagerService,
    MultiFieldExtractorService, // ✨ Export for use in flow executors
  ],
})
export class FlowEngineModule {
  constructor(
    private readonly executorRegistry: ExecutorRegistryService,
    private readonly multiFieldExtractor: MultiFieldExtractorService,
    // Inject all executors
    private readonly llmExecutor: LlmExecutor,
    private readonly nluExecutor: NluExecutor,
    private readonly searchExecutor: SearchExecutor,
    private readonly addressExecutor: AddressExecutor,
    private readonly distanceExecutor: DistanceExecutor,
    private readonly zoneExecutor: ZoneExecutor,
    private readonly pricingExecutor: PricingExecutor,
    private readonly orderExecutor: OrderExecutor,
    private readonly responseExecutor: ResponseExecutor,
    private readonly gameExecutor: GameExecutor,
    private readonly parcelExecutor: ParcelExecutor,
    private readonly preferenceExecutor: PreferenceExecutor,
    private readonly authExecutor: AuthExecutor,
    private readonly phpApiExecutor: PhpApiExecutor,
    private readonly sessionExecutor: SessionExecutor,
    private readonly inventoryExecutor: InventoryExecutor,
    private readonly externalSearchExecutor: ExternalSearchExecutor,
    private readonly selectionExecutor: SelectionExecutor,
    private readonly complexOrderParserExecutor: ComplexOrderParserExecutor,
    private readonly groupOrderSearchExecutor: GroupOrderSearchExecutor,
    private readonly valuePropositionExecutor: ValuePropositionExecutor,
    private readonly autoCartExecutor: AutoCartExecutor,
    private readonly adaptiveExecutor: AdaptiveExecutor,
    private readonly cartManagerExecutor: CartManagerExecutor,
    private readonly profileExecutor: ProfileExecutor,
    private readonly entityResolutionExecutor: EntityResolutionExecutor,
    private readonly savedAddressSelectorExecutor: SavedAddressSelectorExecutor,
    private readonly multiStoreSearchExecutor: MultiStoreSearchExecutor,
    // 🚀 AGENTIC AI EXECUTORS
    private readonly nluConditionExecutor: NluConditionExecutor,
    private readonly pureNerExecutor: PureNerExecutor,
    private readonly agentExecutor: AgentExecutor,
    private readonly collectionsExecutor: CollectionsExecutor,
    private readonly quickReorderExecutor: QuickReorderExecutor,
    private readonly parcelReorderExecutor: ParcelReorderExecutor,
    private readonly recommendationExecutor: RecommendationExecutor,
    // private readonly gameScorerExecutor: GameScorerExecutor, // Disabled
    // private readonly rewardPointsExecutor: RewardPointsExecutor, // Disabled
    // Phase 4: mOS Action Engine Executors
    private readonly assetGenerationExecutor: AssetGenerationExecutor,
    private readonly adExecutionExecutor: AdExecutionExecutor,
    private readonly approvalGateExecutor: ApprovalGateExecutor,
    private readonly whatsAppNotifyExecutor: WhatsAppNotifyExecutor,
    private readonly broadcastExecutor: BroadcastExecutor,
    // Support
    private readonly supportTicketExecutor: SupportTicketExecutor,
    // Phase 7: Voice
    private readonly voiceExecutor: VoiceExecutor,
  ) {
    // Register all executors
    this.executorRegistry.register(llmExecutor);
    this.executorRegistry.register(nluExecutor);
    this.executorRegistry.register(searchExecutor);
    this.executorRegistry.register(addressExecutor);
    this.executorRegistry.register(distanceExecutor);
    this.executorRegistry.register(zoneExecutor);
    this.executorRegistry.register(pricingExecutor);
    this.executorRegistry.register(orderExecutor);
    this.executorRegistry.register(responseExecutor);
    this.executorRegistry.register(gameExecutor);
    this.executorRegistry.register(parcelExecutor);
    this.executorRegistry.register(preferenceExecutor);
    this.executorRegistry.register(authExecutor);
    this.executorRegistry.register(phpApiExecutor);
    this.executorRegistry.register(sessionExecutor);
    this.executorRegistry.register(inventoryExecutor);
    this.executorRegistry.register(externalSearchExecutor);
    this.executorRegistry.register(selectionExecutor);
    this.executorRegistry.register(complexOrderParserExecutor);
    this.executorRegistry.register(groupOrderSearchExecutor);
    this.executorRegistry.register(valuePropositionExecutor);
    this.executorRegistry.register(autoCartExecutor);
    this.executorRegistry.register(adaptiveExecutor);
    this.executorRegistry.register(cartManagerExecutor);
    this.executorRegistry.register(profileExecutor);
    this.executorRegistry.register(entityResolutionExecutor);
    this.executorRegistry.register(savedAddressSelectorExecutor);
    this.executorRegistry.register(multiStoreSearchExecutor);
    // 🚀 AGENTIC AI EXECUTORS
    this.executorRegistry.register(nluConditionExecutor);
    this.executorRegistry.register(pureNerExecutor);
    this.executorRegistry.register(agentExecutor);
    this.executorRegistry.register(collectionsExecutor);
    this.executorRegistry.register(quickReorderExecutor);
    this.executorRegistry.register(parcelReorderExecutor);
    this.executorRegistry.register(recommendationExecutor);
    // this.executorRegistry.register(gameScorerExecutor); // Disabled
    // this.executorRegistry.register(rewardPointsExecutor); // Disabled
    // Phase 4: mOS Action Engine Executors
    this.executorRegistry.register(assetGenerationExecutor);
    this.executorRegistry.register(adExecutionExecutor);
    this.executorRegistry.register(approvalGateExecutor);
    this.executorRegistry.register(whatsAppNotifyExecutor);
    this.executorRegistry.register(broadcastExecutor);
    // Support
    this.executorRegistry.register(supportTicketExecutor);
    // Phase 7: Voice
    this.executorRegistry.register(voiceExecutor);
  }
}
