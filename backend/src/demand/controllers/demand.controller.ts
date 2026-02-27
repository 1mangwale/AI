import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { DemandForecastService } from '../services/demand-forecast.service';
import { DynamicPricingService } from '../services/dynamic-pricing.service';
import { SmartDiscountService } from '../services/smart-discount.service';

@Controller('mos/demand')
export class DemandController {
  constructor(
    private readonly forecast: DemandForecastService,
    private readonly pricing: DynamicPricingService,
    private readonly discount: SmartDiscountService,
  ) {}

  @Get('forecast')
  async getForecast(
    @Query('zoneId') zoneId?: string,
    @Query('date') date?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.forecast.getForecast(zoneId ? parseInt(zoneId) : null, targetDate);
  }

  @Get('forecast-vs-actual')
  async getForecastVsActual(
    @Query('zoneId') zoneId?: string,
    @Query('date') date?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.forecast.getForecastVsActual(zoneId ? parseInt(zoneId) : null, targetDate);
  }

  @Get('pricing-rules')
  async getPricingRules() {
    return this.pricing.getPricingRules();
  }

  @Post('pricing-rules')
  async createPricingRule(@Body() body: {
    ruleName: string;
    ruleType: string;
    zoneId?: number;
    conditions: Record<string, any>;
    action: Record<string, any>;
    priority?: number;
  }) {
    return this.pricing.createPricingRule(body);
  }

  @Patch('pricing-rules/:id')
  async updatePricingRule(
    @Param('id') id: string,
    @Body() body: Partial<{ ruleName: string; conditions: Record<string, any>; action: Record<string, any>; active: boolean; priority: number }>,
  ) {
    return this.pricing.updatePricingRule(id, body);
  }

  @Get('surges')
  async getActiveSurges() {
    return this.pricing.getActiveSurges();
  }

  @Get('discounts')
  async getDiscountROI(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.discount.getDiscountROI(startDate, endDate);
  }

  @Post('discounts/personalized/:userId')
  async getPersonalizedDiscount(@Param('userId') userId: string) {
    return this.discount.getPersonalizedDiscount(parseInt(userId));
  }
}
