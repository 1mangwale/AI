import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { VoiceWebhookController } from './controllers/voice-webhook.controller';
import { VoiceService } from './services/voice.service';
import { SessionModule } from '../session/session.module';
import { AgentsModule } from '../agents/agents.module';
import { DatabaseModule } from '../database/database.module';
import { AsrModule } from '../asr/asr.module';
import { TtsModule } from '../tts/tts.module';
import { MessagingModule } from '../messaging/messaging.module';

/**
 * VoiceModule - Voice IVR Channel
 * 
 * Routes voice calls through:
 * Phone Call → Twilio/Exotel → VoiceWebhookController → ASR → AgentOrchestrator → TTS → Response
 * 
 * Features:
 * - Inbound IVR calls
 * - Speech-to-Text via ASR service (Whisper)
 * - AI processing via FlowEngine
 * - Text-to-Speech via TTS service (XTTS)
 * - DTMF handling (keypad input)
 * 
 * Providers:
 * - Twilio (Global)
 * - Exotel (India)
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 60000, // Voice needs longer timeout
      maxRedirects: 5,
    }),
    SessionModule,
    forwardRef(() => AgentsModule), // For AgentOrchestratorService (forwardRef: circular dep)
    DatabaseModule,
    AsrModule,  // Speech-to-Text
    TtsModule,  // Text-to-Speech
    forwardRef(() => MessagingModule), // For ContextRouterService (forwardRef: circular via AgentsModule)
  ],
  controllers: [VoiceWebhookController],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
