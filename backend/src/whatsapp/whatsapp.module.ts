import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WebhookController } from "./controllers/webhook.controller";
import { WhatsAppCommerceController } from "./controllers/whatsapp-commerce.controller";
import { WhatsAppFlowController } from "./controllers/whatsapp-flow.controller";
import { WhatsAppCallingController } from "./controllers/whatsapp-calling.controller";
import { MessageService } from "./services/message.service";
import { WhatsAppCloudService } from "./services/whatsapp-cloud.service";
import { WhatsAppCatalogService } from "./services/whatsapp-catalog.service";
import { WhatsAppOrderFlowService } from "./services/whatsapp-order-flow.service";
import { WhatsAppFlowTokenService } from "./services/whatsapp-flow-token.service";
import { WhatsAppCallingExecutorService } from "./services/whatsapp-calling-executor.service";
import { WhatsAppCallingLiveExecutorService } from "./services/whatsapp-calling-live-executor.service";
import { WhatsAppCallingPermissionService } from "./services/whatsapp-calling-permission.service";
import { WhatsAppCallingReadinessService } from "./services/whatsapp-calling-readiness.service";
import { WhatsAppCallingSupportIntakeService } from "./services/whatsapp-calling-support-intake.service";
import { PhpIntegrationModule } from "../php-integration/php-integration.module";
import { MessagingModule } from "../messaging/messaging.module";
import { SessionModule } from "../session/session.module";
import { AgentsModule } from "../agents/agents.module";
import { DatabaseModule } from "../database/database.module";
import { AsrModule } from "../asr/asr.module";
import { AdminModule } from "../admin/admin.module";
import { ApprovalModule } from "../approval/approval.module";

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
    ApprovalModule,
  ],
  controllers: [
    WebhookController,
    WhatsAppCommerceController,
    WhatsAppFlowController,
    WhatsAppCallingController,
  ],
  providers: [
    MessageService,
    WhatsAppCloudService,
    WhatsAppCatalogService,
    WhatsAppOrderFlowService,
    WhatsAppFlowTokenService,
    WhatsAppCallingReadinessService,
    WhatsAppCallingPermissionService,
    WhatsAppCallingExecutorService,
    WhatsAppCallingLiveExecutorService,
    WhatsAppCallingSupportIntakeService,
  ],
  exports: [
    MessageService,
    WhatsAppCloudService,
    WhatsAppCatalogService,
    WhatsAppOrderFlowService,
    WhatsAppFlowTokenService,
    WhatsAppCallingReadinessService,
    WhatsAppCallingPermissionService,
    WhatsAppCallingExecutorService,
    WhatsAppCallingLiveExecutorService,
    WhatsAppCallingSupportIntakeService,
  ],
})
export class WhatsAppModule {}
