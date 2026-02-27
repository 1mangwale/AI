import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { WeatherCampaignTriggerService } from '../services/weather-campaign-trigger.service';
import { FestivalCampaignService } from '../services/festival-campaign.service';
import { EventTriggerService } from '../services/event-trigger.service';

@Controller('mos/campaigns')
export class CampaignTriggerController {
  constructor(
    private readonly weather: WeatherCampaignTriggerService,
    private readonly festival: FestivalCampaignService,
    private readonly event: EventTriggerService,
  ) {}

  @Get('triggers')
  async getTriggers(@Query('type') type?: string) {
    return this.weather.getAllTriggers(type);
  }

  @Post('triggers')
  async createTrigger(@Body() body: {
    triggerType: string; triggerName: string; conditions: Record<string, any>;
    campaignTemplate: Record<string, any>; audienceFilter?: Record<string, any>;
    cooldownHours?: number; requiresApproval?: boolean;
  }) {
    return this.weather.createTrigger(body);
  }

  @Patch('triggers/:id')
  async updateTrigger(@Param('id') id: string, @Body() body: any) {
    return this.weather.updateTrigger(id, body);
  }

  @Get('trigger-history')
  async getTriggerHistory(@Query('limit') limit?: string) {
    return this.weather.getTriggerHistory(limit ? parseInt(limit) : 20);
  }

  @Get('festivals')
  async getUpcomingFestivals(@Query('days') days?: string) {
    return this.festival.getUpcomingFestivals(days ? parseInt(days) : 30);
  }

  @Get('festivals/calendar')
  async getFestivalCalendar() {
    return this.festival.getFullCalendar();
  }

  @Get('festivals/today')
  async getFestivalsToday() {
    return this.festival.getFestivalsToTriggerToday();
  }

  @Post('festivals')
  async createFestival(@Body() body: {
    name: string; date: string; preDays?: number;
    items?: string[]; message?: string;
  }) {
    return this.festival.createFestival(body);
  }

  @Patch('festivals/:id')
  async updateFestival(@Param('id') id: string, @Body() body: any) {
    return this.festival.updateFestival(id, body);
  }

  @Delete('festivals/:id')
  async deleteFestival(@Param('id') id: string) {
    const deleted = await this.festival.deleteFestival(id);
    return { deleted };
  }

  @Get('events')
  async getUpcomingEvents(@Query('days') days?: string) {
    return this.event.getUpcomingEvents(days ? parseInt(days) : 30);
  }

  @Get('events/to-trigger')
  async getEventsToTrigger() {
    return this.event.getEventsToTrigger();
  }

  @Post('events')
  async addEvent(@Body() body: {
    name: string; eventType: string; eventDate: string;
    eventTime?: string; campaignMessage?: string;
    suggestedItems?: string[]; sendBeforeHours?: number;
  }) {
    return this.event.addEvent(body);
  }

  @Get('events/history')
  async getEventHistory(@Query('limit') limit?: string) {
    return this.event.getEventHistory(limit ? parseInt(limit) : 20);
  }
}
