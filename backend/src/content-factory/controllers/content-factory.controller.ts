import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Logger } from '@nestjs/common';
import { ContentService } from '../services/content.service';
import { PromptService } from '../services/prompt.service';
import { HookService } from '../services/hook.service';
import { DataSyncService } from '../services/data-sync.service';
import { ContentCalendarService } from '../services/content-calendar.service';
import { ContentGenerationRequest } from '../interfaces/content-factory.interfaces';

@Controller('mos/content-factory')
export class ContentFactoryController {
  private readonly logger = new Logger(ContentFactoryController.name);

  constructor(
    private readonly contentService: ContentService,
    private readonly promptService: PromptService,
    private readonly hookService: HookService,
    private readonly dataSyncService: DataSyncService,
    private readonly calendarService: ContentCalendarService,
  ) {}

  // --- Content ---

  @Post('generate')
  async generate(@Body() body: ContentGenerationRequest) {
    try {
      return await this.contentService.generateAndSave(body);
    } catch (e: any) {
      this.logger.error(`Generate content failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Get('content')
  async listContent(
    @Query('status') status?: string,
    @Query('contentType') contentType?: string,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      return await this.contentService.listContent({
        status,
        contentType,
        platform,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
    } catch (e: any) {
      this.logger.error(`List content failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Get('content/:id')
  async getContent(@Param('id') id: string) {
    try {
      return await this.contentService.getById(id);
    } catch (e: any) {
      this.logger.error(`Get content ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Patch('content/:id')
  async updateContent(
    @Param('id') id: string,
    @Body() body: { title?: string; contentJson?: Record<string, any>; rawText?: string },
  ) {
    try {
      return await this.contentService.updateContent(id, body);
    } catch (e: any) {
      this.logger.error(`Update content ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Patch('content/:id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string; reviewNotes?: string },
  ) {
    try {
      return await this.contentService.updateStatus(id, body.status, body.reviewNotes);
    } catch (e: any) {
      this.logger.error(`Update status for ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Post('content/:id/regenerate')
  async regenerate(
    @Param('id') id: string,
    @Body() body: { additionalInstructions?: string },
  ) {
    try {
      return await this.contentService.regenerate(id, body.additionalInstructions);
    } catch (e: any) {
      this.logger.error(`Regenerate content ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Delete('content/:id')
  async deleteContent(@Param('id') id: string) {
    try {
      return await this.contentService.deleteContent(id);
    } catch (e: any) {
      this.logger.error(`Delete content ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Get('stats')
  async getStats() {
    try {
      return await this.contentService.getStats();
    } catch (e: any) {
      this.logger.error(`Get stats failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  // --- Prompts ---

  @Get('prompts')
  async listPrompts(@Query('contentType') contentType?: string) {
    try {
      return await this.promptService.listPrompts(contentType);
    } catch (e: any) {
      this.logger.error(`List prompts failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Post('prompts')
  async createPrompt(@Body() body: any) {
    try {
      return await this.promptService.createPrompt(body);
    } catch (e: any) {
      this.logger.error(`Create prompt failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Patch('prompts/:id')
  async updatePrompt(@Param('id') id: string, @Body() body: any) {
    try {
      return await this.promptService.updatePrompt(id, body);
    } catch (e: any) {
      this.logger.error(`Update prompt ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Post('prompts/:id/activate')
  async activatePrompt(@Param('id') id: string) {
    try {
      return await this.promptService.activateVersion(id);
    } catch (e: any) {
      this.logger.error(`Activate prompt ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  // --- Hooks ---

  @Get('hooks')
  async listHooks(
    @Query('platform') platform?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.hookService.listHooks({
        platform,
        category,
        limit: limit ? parseInt(limit) : undefined,
      });
    } catch (e: any) {
      this.logger.error(`List hooks failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Post('hooks')
  async createHook(@Body() body: any) {
    try {
      return await this.hookService.createHook(body);
    } catch (e: any) {
      this.logger.error(`Create hook failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Patch('hooks/:id')
  async updateHook(@Param('id') id: string, @Body() body: any) {
    try {
      return await this.hookService.updateHook(id, body);
    } catch (e: any) {
      this.logger.error(`Update hook ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  @Delete('hooks/:id')
  async deleteHook(@Param('id') id: string) {
    try {
      return await this.hookService.deleteHook(id);
    } catch (e: any) {
      this.logger.error(`Delete hook ${id} failed: ${e.message}`, e.stack);
      return { error: e.message };
    }
  }

  // ---- Data Sync ----

  @Post('sync/metrics')
  async syncMetrics(@Body() body: { date?: string }) {
    try {
      return await this.dataSyncService.syncDailyMetrics(body.date);
    } catch (e: any) {
      this.logger.error(`Sync metrics failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Post('sync/performers')
  async syncPerformers() {
    try {
      return await this.dataSyncService.syncTopPerformers();
    } catch (e: any) {
      this.logger.error(`Sync performers failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Post('sync/milestones')
  async syncMilestones() {
    try {
      return await this.dataSyncService.detectMilestones();
    } catch (e: any) {
      this.logger.error(`Detect milestones failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Post('sync/all')
  async syncAll() {
    try {
      const [metrics, performers, milestones] = await Promise.all([
        this.dataSyncService.syncDailyMetrics(),
        this.dataSyncService.syncTopPerformers(),
        this.dataSyncService.detectMilestones(),
      ]);
      return { metrics, performers, milestones };
    } catch (e: any) {
      this.logger.error(`Full sync failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Get('business/metrics')
  async getBusinessMetrics() {
    try {
      return await this.dataSyncService.getLatestMetrics();
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('business/performers')
  async getBusinessPerformers(@Query('category') category?: string) {
    try {
      return await this.dataSyncService.getTopPerformers(category);
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('business/milestones')
  async getBusinessMilestones(@Query('limit') limit?: string) {
    try {
      return await this.dataSyncService.getRecentMilestones(limit ? parseInt(limit, 10) : undefined);
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('business/context')
  async getBusinessContext() {
    try {
      return await this.dataSyncService.getBusinessContext();
    } catch (e: any) {
      return { error: e.message };
    }
  }

  // ---- Calendar ----

  @Post('calendar/schedule')
  async scheduleContent(@Body() body: { contentId: string; scheduledAt: string; platform: string }) {
    try {
      return await this.calendarService.scheduleContent(body.contentId, new Date(body.scheduledAt), body.platform);
    } catch (e: any) {
      this.logger.error(`Schedule content failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Post('calendar/unschedule/:id')
  async unscheduleContent(@Param('id') id: string) {
    try {
      return await this.calendarService.unscheduleContent(id);
    } catch (e: any) {
      this.logger.error(`Unschedule content failed: ${e.message}`);
      return { error: e.message };
    }
  }

  @Get('calendar')
  async getCalendar(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('platform') platform?: string,
  ) {
    try {
      return await this.calendarService.getCalendar(startDate, endDate, platform);
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('calendar/optimal-times')
  async getOptimalTimes(@Query('platform') platform: string, @Query('dayOfWeek') dayOfWeek?: string) {
    try {
      return await this.calendarService.getOptimalTimes(platform, dayOfWeek ? parseInt(dayOfWeek, 10) : undefined);
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('calendar/weekly-plan')
  async getWeeklyPlan(@Query('weekStartDate') weekStartDate: string) {
    try {
      return await this.calendarService.getWeeklyPlan(weekStartDate);
    } catch (e: any) {
      return { error: e.message };
    }
  }

  @Get('calendar/gaps')
  async getGaps(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    try {
      return await this.calendarService.getGaps(startDate, endDate);
    } catch (e: any) {
      return { error: e.message };
    }
  }
}
