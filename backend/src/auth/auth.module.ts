import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthTriggerService } from './auth-trigger.service';
import { CentralizedAuthService } from './centralized-auth.service';
import { AuthController } from './auth.controller';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { DatabaseModule } from '../database/database.module';
import { UserProfilingService } from '../personalization/user-profiling.service';
import { ConversationAnalyzerService } from '../personalization/conversation-analyzer.service';
import { UserPreferenceService } from '../personalization/user-preference.service';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [
    PhpIntegrationModule,
    DatabaseModule,
    HttpModule,
    LlmModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthTriggerService,
    CentralizedAuthService,
    UserProfilingService, // Direct provider, not via module to avoid circular deps
    ConversationAnalyzerService, // Required by UserProfilingService
    UserPreferenceService, // Required by ConversationAnalyzerService
  ],
  exports: [AuthTriggerService, CentralizedAuthService],
})
export class AuthModule {}
