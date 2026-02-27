import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { SocialTrendService } from '../services/social-trend.service';
import { AdAttributionService } from '../services/ad-attribution.service';

@Controller('mos/marketing')
export class MarketingController {
  constructor(
    private readonly trends: SocialTrendService,
    private readonly attribution: AdAttributionService,
  ) {}

  // ── Social Trends ──

  @Get('trends')
  async getTrends(
    @Query('platform') platform?: string,
    @Query('days') days?: string,
  ) {
    return this.trends.getRecentTrends(platform, days ? parseInt(days) : 7);
  }

  @Get('trends/suggestions')
  async getTrendingSuggestions() {
    return this.trends.getTrendingSuggestions();
  }

  @Post('trends/fetch')
  async fetchTrends(
    @Query('platform') platform?: string,
    @Query('query') query?: string,
  ) {
    if (platform === 'instagram') {
      return this.trends.fetchInstagramTrends(query ? [query] : undefined);
    }
    // Default to YouTube
    return this.trends.fetchYouTubeTrends(query);
  }

  @Post('trends/:id/processed')
  async markTrendProcessed(@Param('id') id: string) {
    return this.trends.markProcessed(id);
  }

  // ── Campaigns ──

  @Get('campaigns')
  async getCampaigns() {
    const { campaigns } = await this.attribution.getCampaignROI();
    return campaigns;
  }

  @Post('campaigns')
  async createCampaign(
    @Body()
    body: {
      platform: string;
      name: string;
      budget: number;
      extCampaignId?: string;
      startDate?: string;
      endDate?: string;
    },
  ) {
    return this.attribution.createCampaign(body);
  }

  @Patch('campaigns/:id/spend')
  async updateCampaignSpend(
    @Param('id') id: string,
    @Body() body: { spend: number; impressions: number; clicks: number },
  ) {
    return this.attribution.updateCampaignSpend(
      id,
      body.spend,
      body.impressions,
      body.clicks,
    );
  }

  @Get('campaigns/:id/roi')
  async getCampaignROI(@Param('id') id: string) {
    return this.attribution.getCampaignROI(id);
  }

  // ── Attribution ──

  @Get('attribution')
  async getAttributionReport(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.attribution.getAttributionReport(startDate, endDate);
  }

  @Post('attribution')
  async trackAttribution(
    @Body()
    body: {
      orderId: number;
      utmSource: string;
      utmMedium: string;
      utmCampaign: string;
      utmContent?: string;
      revenue: number;
    },
  ) {
    return this.attribution.trackAttribution(
      body.orderId,
      {
        source: body.utmSource,
        medium: body.utmMedium,
        campaign: body.utmCampaign,
        content: body.utmContent,
      },
      body.revenue,
    );
  }

  // ── Overview ──

  @Get('overview')
  async getOverview() {
    return this.attribution.getOverview();
  }
}
