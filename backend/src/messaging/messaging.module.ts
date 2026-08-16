import { Module, forwardRef, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HttpModule } from '@nestjs/axios';
import { SessionModule } from '../session/session.module';
import { DatabaseModule } from '../database/database.module';
import { FlowEngineModule } from '../flow-engine/flow-engine.module';
import { AgentsModule } from '../agents/agents.module';
import { NluModule } from '../nlu/nlu.module';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { SmsModule } from '../sms/sms.module';
// import { WhatsAppProvider } from './providers/whatsapp.provider'; // Disabled - configure API keys to enable
import { RCSProvider } from './providers/rcs.provider';
import { TelegramProvider } from './providers/telegram.provider';
import { SmsProvider } from './providers/sms.provider';
import { InstagramProvider } from './providers/instagram.provider';
import { MessagingService } from './services/messaging.service';
import { MessageGatewayService } from './services/message-gateway.service';
import { ContextRouterService } from './services/context-router.service';
import { CommandHandlerService } from './services/command-handler.service';
import { IntentRouterService } from './services/intent-router.service';
import { WhatsAppCloudService } from '../whatsapp/services/whatsapp-cloud.service';
import { WhatsAppOptOutService } from '../whatsapp/services/whatsapp-optout.service';
import { ChannelRendererService } from './services/channel-renderer.service';

/**
 * MessagingModule - Unified message handling across all channels
 * 
 * OLD (Legacy):
 * - MessagingService: Original WhatsApp/Telegram providers
 * 
 * NEW (Modern Architecture):
 * - MessageGatewayService: Single entry point for all 5 channels ✅
 * - ContextRouterService: Smart 5-step routing with SYNC support ✅
 * - CommandHandlerService: Command handling (cancel, help, menu) ✅
@ * - IndicBERTService: ML-based intent classification (95%+ accuracy) ✅
 * 
 * HYBRID ARCHITECTURE:
 * - SYNC channels (Web, Voice, Mobile): Direct routing, immediate response
 * - ASYNC channels (WhatsApp, Telegram): Redis pub/sub, fire-and-forget
 */
@Module({
  imports: [
    SessionModule,
    DatabaseModule, // For ConversationLoggerService
    NluModule, // ✨ NEW: For IndicBERTService (ML-based intent classification)
    PhpIntegrationModule, // 🔐 For PhpAuthService (auto-auth on WhatsApp/Telegram)
    PersonalizationModule, // 📦 For OrderSyncService (sync orders on auto-auth)
    forwardRef(() => FlowEngineModule), // For FlowEngineService
    forwardRef(() => AgentsModule), // For AgentOrchestratorService
    forwardRef(() => SmsModule), // For SmsProvider → SmsService (forwardRef: SmsModule→AgentsModule→MessagingModule)
    HttpModule.register({ timeout: 30000 }), // For WhatsAppCloudService
  ],
  providers: [
    // WhatsAppProvider, // Disabled - configure API keys to enable
    RCSProvider,
    TelegramProvider,
    SmsProvider,
    InstagramProvider,
    MessagingService,
    MessageGatewayService, // NEW: Unified gateway
    ContextRouterService, // NEW: Smart routing with SYNC support
    CommandHandlerService, // NEW: Command handling
    IntentRouterService, // NEW: Centralized intent-to-flow routing (GAP 1 fix)
    WhatsAppCloudService, // Direct WhatsApp Cloud API service
    WhatsAppOptOutService,
    ChannelRendererService, // Unified channel message renderer
  ],
  exports: [
    MessagingService,
    MessageGatewayService, // Export for use in controllers
    ContextRouterService,
    CommandHandlerService,
    IntentRouterService, // Export for testing and external use
    WhatsAppCloudService, // Export for direct WhatsApp access
    WhatsAppOptOutService,
    ChannelRendererService, // Export for use across modules
  ],
})
export class MessagingModule implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly messageGateway: MessageGatewayService,
    private readonly contextRouter: ContextRouterService,
  ) {}

  /**
   * Wire up ContextRouter to MessageGateway after module init
   * This avoids circular dependency issues
   */
  onModuleInit() {
    this.messageGateway.setContextRouter(this.contextRouter);
  }
}

