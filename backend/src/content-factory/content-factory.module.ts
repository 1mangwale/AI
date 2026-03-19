import { Module } from '@nestjs/common';
import { PromptService } from './services/prompt.service';
import { HookService } from './services/hook.service';
import { ContentGeneratorService } from './services/content-generator.service';
import { ContentService } from './services/content.service';
import { DataSyncService } from './services/data-sync.service';
import { ContentCalendarService } from './services/content-calendar.service';
import { ContentFactoryController } from './controllers/content-factory.controller';

@Module({
  providers: [PromptService, HookService, ContentGeneratorService, ContentService, DataSyncService, ContentCalendarService],
  controllers: [ContentFactoryController],
  exports: [ContentService, ContentGeneratorService, HookService, PromptService, DataSyncService, ContentCalendarService],
})
export class ContentFactoryModule {}
