import { Controller, Get, Post, Query, Param } from '@nestjs/common';
import { BehavioralAnalyticsService } from '../services/behavioral-analytics.service';

@Controller('mos/customers')
export class CustomerIntelligenceController {
  constructor(private readonly healthService: BehavioralAnalyticsService) {}

  @Get('health')
  async getHealthScoreBoard(
    @Query('segment') segment?: string,
    @Query('minHealth') minHealth?: string,
    @Query('maxHealth') maxHealth?: string,
    @Query('minChurnRisk') minChurnRisk?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.healthService.getHealthScoreBoard({
      segment,
      minHealth: minHealth ? parseInt(minHealth) : undefined,
      maxHealth: maxHealth ? parseInt(maxHealth) : undefined,
      minChurnRisk: minChurnRisk ? parseFloat(minChurnRisk) : undefined,
      sortBy,
      sortOrder,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  @Get('churn-risk')
  async getChurnRiskList(
    @Query('threshold') threshold?: string,
    @Query('limit') limit?: string,
  ) {
    return this.healthService.getChurnRiskList(
      threshold ? parseFloat(threshold) : 0.5,
      limit ? parseInt(limit) : 20,
    );
  }

  @Get('segments')
  async getSegmentDistribution() {
    return this.healthService.getSegmentDistribution();
  }

  @Get('health-distribution')
  async getHealthDistribution() {
    return this.healthService.getHealthDistribution();
  }

  @Get(':userId/health')
  async getUserHealth(@Param('userId') userId: string) {
    return this.healthService.computeHealthScore(parseInt(userId));
  }

  @Post('compute-health')
  async computeAllHealth() {
    return this.healthService.computeAllHealthScores();
  }
}
