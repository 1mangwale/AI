import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WebhookController } from './controllers/webhook.controller';
import { WhatsAppCommerceController } from './controllers/whatsapp-commerce.controller';
import { WhatsAppFlowController } from './controllers/whatsapp-flow.controller';
import { MessageService } from './services/message.service';
import { WhatsAppCloudService } from './services/whatsapp-cloud.service';
import { WhatsAppCatalogService } from './services/whatsapp-catalog.service';
import { WhatsAppOrderFlowService } from './services/whatsapp-order-flow.service';
import { WhatsAppFlowTokenService } from './services/whatsapp-flow-token.service';
import { WhatsAppQuickOrderService } from './services/whatsapp-quick-order.service';
import { WhatsAppFlowEncryptionService } from './services/whatsapp-flow-encryption.service';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SessionModule } from '../session/session.module';
import { AgentsModule } from '../agents/agents.module';
import { DatabaseModule } from '../database/database.module';
import { AsrModule } from '../asr/asr.module';
import { AdminModule } from '../admin/admin.module';

/**
 * WhatsAppModule - Multi-Channel Architecture
 * 
 * Routes WhatsApp messages through:
 * WhatsApp → WebhookController → AgentOrchestratorService → FlowEngine
 * 
 * Same architecture as Web Chat and Telegram for consistency.
 * 
 * Voice Support:
 * Audio messages → Download from Meta → ASR (Whisper) → Text → Same flow
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    PhpIntegrationModule,
    MessagingModule,
    SessionModule,
    AgentsModule,
    DatabaseModule,
    AsrModule, // For voice message transcription
    AdminModule,
  ],
  controllers: [WebhookController, WhatsAppCommerceController, WhatsAppFlowController],
  providers: [MessageService, WhatsAppCloudService, WhatsAppCatalogService, WhatsAppOrderFlowService, WhatsAppFlowTokenService, WhatsAppQuickOrderService, WhatsAppFlowEncryptionService],
  exports: [MessageService, WhatsAppCloudService, WhatsAppCatalogService, WhatsAppOrderFlowService, WhatsAppFlowTokenService, WhatsAppQuickOrderService, WhatsAppFlowEncryptionService],
})
export class WhatsAppModule {}


