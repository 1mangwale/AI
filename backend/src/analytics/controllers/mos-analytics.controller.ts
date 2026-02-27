import { Controller, Get, Query } from '@nestjs/common';
import { OrderDissectionService } from '../services/order-dissection.service';
import { UnitEconomicsService } from '../services/unit-economics.service';

@Controller('mos')
export class MosAnalyticsController {
  constructor(
    private readonly orderDissection: OrderDissectionService,
    private readonly unitEconomics: UnitEconomicsService,
  ) {}

  /**
   * CEO Dashboard - The Vitals
   */
  @Get('dashboard')
  async getDashboard(@Query('date') date?: string) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const [dailyMetrics, hourlyVolume, revenueTrend, activeRiders] = await Promise.all([
      this.unitEconomics.getDailyMetrics(targetDate),
      this.orderDissection.getHourlyOrderVolume(targetDate),
      this.unitEconomics.getRevenueTrend(7),
      this.unitEconomics.getActiveRiderCount(targetDate),
    ]);

    return {
      date: targetDate,
      vitals: {
        ...dailyMetrics,
        activeRiders,
      },
      hourlyVolume,
      revenueTrend,
    };
  }

  /**
   * Operations - Order Timing Breakdown
   */
  @Get('operations/order-stats')
  async getOrderStats(
    @Query('date') date?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.orderDissection.getDailyOrderStats(targetDate, zoneId ? parseInt(zoneId) : undefined);
  }

  /**
   * Operations - Hourly Volume
   */
  @Get('operations/hourly-volume')
  async getHourlyVolume(
    @Query('date') date?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.orderDissection.getHourlyOrderVolume(targetDate, zoneId ? parseInt(zoneId) : undefined);
  }

  /**
   * Operations - Slow Orders
   */
  @Get('operations/slow-orders')
  async getSlowOrders(
    @Query('date') date?: string,
    @Query('threshold') threshold?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.orderDissection.getSlowOrders(targetDate, threshold ? parseInt(threshold) : 45);
  }

  /**
   * Operations - Store Performance
   */
  @Get('operations/store-performance')
  async getStorePerformance(
    @Query('date') date?: string,
    @Query('limit') limit?: string,
  ) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.orderDissection.getStorePerformance(targetDate, limit ? parseInt(limit) : 20);
  }

  /**
   * Monthly Comparison
   */
  @Get('operations/monthly')
  async getMonthlyComparison(@Query('months') months?: string) {
    return this.unitEconomics.getMonthlyComparison(months ? parseInt(months) : 3);
  }
}
