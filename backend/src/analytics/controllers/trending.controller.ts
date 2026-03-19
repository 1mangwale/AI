import { Controller, Get, Query, Optional, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { firstValueFrom } from 'rxjs';

interface TrendingQuery {
  query: string;
  count: number;
  trend: number;
  module: string;
  velocity: 'rising' | 'stable' | 'falling';
}

interface TrendingProduct {
  product_id: string;
  name: string;
  category: string;
  orders: number;
  trend: number;
  revenue: number;
}

interface TrendingLocation {
  location: string;
  top_queries: string[];
  total_searches: number;
  change: number;
}

@ApiTags('trending')
@Controller('trending')
export class TrendingController {
  private readonly logger = new Logger(TrendingController.name);
  private readonly searchApiUrl: string;

  constructor(
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.searchApiUrl = this.configService?.get<string>('SEARCH_API_URL');
  }

  private rangeToWindow(range: string): string {
    const map: Record<string, string> = { '1h': '1h', '24h': '1d', '7d': '7d', '30d': '30d' };
    return map[range] || range;
  }

  private async fetchClickHouseTrending(window: string, module?: string): Promise<any[]> {
    if (!this.httpService) return [];
    try {
      const params: Record<string, any> = { window };
      if (module && module !== 'all') params.module = module;
      const response = await firstValueFrom(
        this.httpService.get(`${this.searchApiUrl}/analytics/trending`, { params, timeout: 5000 })
      );
      return response.data?.rows || [];
    } catch (err) {
      this.logger.warn(`ClickHouse trending fetch failed: ${err.message}`);
      return [];
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get all trending data' })
  @ApiQuery({ name: 'range', required: false, description: 'Time range (1h, 24h, 7d, 30d)' })
  @ApiResponse({ status: 200, description: 'Trending data retrieved' })
  async getTrendingData(@Query('range') range: string = '24h') {
    const queries = await this.getTrendingQueries(range);
    const products = await this.getTrendingProducts(range);
    const locations = await this.getTrendingLocations(range);

    return {
      queries,
      products,
      locations,
      range,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('queries')
  @ApiOperation({ summary: 'Get trending search queries from ClickHouse' })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'module', required: false })
  @ApiResponse({ status: 200, description: 'Trending queries retrieved' })
  async getTrendingQueries(
    @Query('range') range: string = '24h',
    @Query('limit') limit: number = 20,
    @Query('module') module?: string,
  ): Promise<TrendingQuery[]> {
    const rows = await this.fetchClickHouseTrending(this.rangeToWindow(range), module);
    return rows.slice(0, Number(limit)).map(r => ({
      query: r.q,
      count: r.count || 0,
      trend: r.count || 0,
      module: r.module || 'Food',
      velocity: r.count > 50 ? 'rising' : r.count > 10 ? 'stable' : 'falling',
    }));
  }

  @Get('products')
  @ApiOperation({ summary: 'Get popular products by clicks, cart adds and orders from ClickHouse' })
  @ApiQuery({ name: 'hours', required: false, description: 'Lookback hours (default: 24)' })
  @ApiQuery({ name: 'module_id', required: false, description: '4=food, 5=ecom (default: 4)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Popular products retrieved from ClickHouse click_events' })
  async getTrendingProducts(
    @Query('hours') hours: string = '24',
    @Query('module_id') moduleId: string = '4',
    @Query('limit') limit: string = '20',
  ): Promise<any> {
    if (this.httpService) {
      try {
        const response = await firstValueFrom(
          this.httpService.get(`${this.searchApiUrl}/v2/analytics/popular-products`, {
            params: { hours, module_id: moduleId, limit },
            timeout: 5000,
          })
        );
        return response.data;
      } catch (err) {
        this.logger.warn(`Popular products from ClickHouse failed: ${err.message}`);
      }
    }

    return {
      products: [],
      hours: parseInt(hours),
      module_id: parseInt(moduleId),
      count: 0,
      source: 'unavailable',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('locations')
  @ApiOperation({ summary: 'Get trending by location' })
  @ApiQuery({ name: 'range', required: false })
  @ApiResponse({ status: 200, description: 'Location trends retrieved' })
  async getTrendingLocations(
    @Query('range') range: string = '24h',
  ): Promise<TrendingLocation[]> {
    return [];
  }

  @Get('peak-hours')
  @ApiOperation({ summary: 'Get peak usage hours from ClickHouse search events' })
  @ApiQuery({ name: 'range', required: false })
  @ApiResponse({ status: 200, description: 'Peak hours data retrieved' })
  async getPeakHours(@Query('range') range: string = '24h') {
    const rows = await this.fetchClickHouseTrending(this.rangeToWindow(range));

    const todLabels: Record<string, string> = {
      morning: '06:00 - 12:00',
      afternoon: '12:00 - 17:00',
      evening: '17:00 - 21:00',
      night: '21:00 - 06:00',
    };

    const buckets: Record<string, number> = {};
    for (const r of rows) {
      const tod = r.time_of_day || 'afternoon';
      buckets[tod] = (buckets[tod] || 0) + (r.count || 0);
    }

    const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
    const peakHours = Object.entries(buckets).map(([tod, count]) => ({
      hour: todLabels[tod] || tod,
      label: tod.charAt(0).toUpperCase() + tod.slice(1),
      percent: Math.round((count / total) * 100),
      requests: count,
    })).sort((a, b) => b.requests - a.requests);

    return { peak_hours: peakHours, range };
  }

  @Get('module-distribution')
  @ApiOperation({ summary: 'Get search volume by module from ClickHouse' })
  @ApiQuery({ name: 'range', required: false })
  @ApiResponse({ status: 200, description: 'Module distribution retrieved' })
  async getModuleDistribution(@Query('range') range: string = '24h') {
    const rows = await this.fetchClickHouseTrending(this.rangeToWindow(range));

    const moduleColors: Record<string, string> = {
      food: '#f97316', ecom: '#3b82f6', parcel: '#8b5cf6', ride: '#22c55e', health: '#ef4444',
    };

    const moduleMap: Record<string, number> = {};
    for (const r of rows) {
      const mod = (r.module || 'food').toLowerCase();
      moduleMap[mod] = (moduleMap[mod] || 0) + (r.count || 0);
    }

    const total = Object.values(moduleMap).reduce((a, b) => a + b, 0) || 1;
    const distribution = Object.entries(moduleMap).map(([mod, count]) => ({
      module: mod.charAt(0).toUpperCase() + mod.slice(1),
      percent: Math.round((count / total) * 100),
      count,
      color: moduleColors[mod] || '#6b7280',
    })).sort((a, b) => b.count - a.count);

    return { distribution, range };
  }

  @Get('real-time')
  @ApiOperation({ summary: 'Get real-time trending queries from ClickHouse (last 1 hour)' })
  @ApiResponse({ status: 200, description: 'Real-time data retrieved' })
  async getRealTimeTrends() {
    const now = new Date();
    const rows = await this.fetchClickHouseTrending('1h');

    if (rows.length > 0) {
      const totalSearches = rows.reduce((sum, r) => sum + (r.count || 0), 0);
      return {
        current_searches_per_minute: Math.round(totalSearches / 60),
        total_searches_last_hour: totalSearches,
        active_sessions: 0,
        orders_in_progress: 0,
        top_query_now: rows[0]?.q || null,
        top_queries: rows.slice(0, 10).map(r => ({ query: r.q, count: r.count })),
        busiest_location: null,
        timestamp: now.toISOString(),
        source: 'clickhouse',
      };
    }

    return {
      current_searches_per_minute: 0,
      total_searches_last_hour: 0,
      active_sessions: 0,
      orders_in_progress: 0,
      top_query_now: null,
      top_queries: [],
      busiest_location: null,
      timestamp: now.toISOString(),
      source: 'unavailable',
    };
  }
}
