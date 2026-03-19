import { Controller, Get, Query, Logger, Post, Body, UseGuards, Inject, Optional } from '@nestjs/common';
import { AdminAuthGuard } from '../../admin/guards/admin-auth.guard';
import { Pool } from 'pg';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SearchAnalyticsService } from '../services/search-analytics.service';
import { firstValueFrom } from 'rxjs';

/**
 * Search Analytics Admin Controller
 *
 * Comprehensive search analytics for admin dashboard:
 * - Search volume trends
 * - Top queries (with/without results)
 * - Zero result queries (gap analysis)
 * - Performance metrics
 * - User search behavior
 * - Conversion tracking
 */

@Controller('admin/search/analytics')
@UseGuards(AdminAuthGuard)
export class SearchAnalyticsAdminController {
  private readonly logger = new Logger(SearchAnalyticsAdminController.name);
  private pool: Pool;
  private readonly searchApiUrl: string;

  constructor(
    private readonly analyticsService: SearchAnalyticsService,
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    const databaseUrl = process.env.DATABASE_URL ||
      'postgresql://mangwale_config:config_secure_pass_2024@mangwale_postgres:5432/headless_mangwale?schema=public';

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
    });

    this.searchApiUrl = this.configService?.get('SEARCH_API_URL');
    this.logger.log('✅ SearchAnalyticsAdminController initialized');
  }

  /**
   * Dashboard overview - key metrics
   * 
   * GET /admin/search/analytics/dashboard?days=7
   */
  @Get('dashboard')
  async getDashboard(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7');

    try {
      // Total searches
      const totalRes = await this.pool.query(
        `SELECT COUNT(*) as count FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'`,
      );
      const totalSearches = parseInt(totalRes.rows[0].count);

      // Unique users
      const usersRes = await this.pool.query(
        `SELECT COUNT(DISTINCT COALESCE(user_id, session_id)) as count 
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'`,
      );
      const uniqueUsers = parseInt(usersRes.rows[0].count);

      // Zero results
      const zeroRes = await this.pool.query(
        `SELECT COUNT(*) as count FROM search_logs 
         WHERE results_count = 0 
         AND created_at >= NOW() - INTERVAL '${daysNum} days'`,
      );
      const zeroResults = parseInt(zeroRes.rows[0].count);

      // Avg response time
      const timeRes = await this.pool.query(
        `SELECT 
           AVG(execution_time_ms) as avg_time,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY execution_time_ms) as p50,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms) as p95
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'`,
      );

      // Searches per user
      const searchesPerUser = uniqueUsers > 0 ? (totalSearches / uniqueUsers).toFixed(1) : 0;

      // Comparison with previous period
      const prevRes = await this.pool.query(
        `SELECT COUNT(*) as count FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum * 2} days'
         AND created_at < NOW() - INTERVAL '${daysNum} days'`,
      );
      const prevSearches = parseInt(prevRes.rows[0].count);
      const growthRate = prevSearches > 0 
        ? ((totalSearches - prevSearches) / prevSearches * 100).toFixed(1)
        : '0';

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          metrics: {
            totalSearches,
            uniqueUsers,
            searchesPerUser,
            zeroResults,
            zeroResultsRate: totalSearches > 0 
              ? ((zeroResults / totalSearches) * 100).toFixed(1) + '%' 
              : '0%',
          },
          performance: {
            avgResponseTimeMs: Math.round(parseFloat(timeRes.rows[0].avg_time) || 0),
            p50ResponseTimeMs: Math.round(parseFloat(timeRes.rows[0].p50) || 0),
            p95ResponseTimeMs: Math.round(parseFloat(timeRes.rows[0].p95) || 0),
          },
          trends: {
            growthRate: growthRate + '%',
            direction: parseFloat(growthRate) > 0 ? 'up' : parseFloat(growthRate) < 0 ? 'down' : 'flat',
          },
        },
      };
    } catch (error) {
      this.logger.error(`Dashboard query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Top queries with click-through data
   * 
   * GET /admin/search/analytics/top-queries?days=7&limit=20
   */
  @Get('top-queries')
  async getTopQueries(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const limitNum = parseInt(limit || '20');

    try {
      const result = await this.pool.query(
        `SELECT 
           query,
           COUNT(*) as search_count,
           AVG(results_count) as avg_results,
           AVG(execution_time_ms) as avg_time,
           COUNT(DISTINCT COALESCE(user_id, session_id)) as unique_users
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY query 
         ORDER BY search_count DESC 
         LIMIT $1`,
        [limitNum],
      );

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          queries: result.rows.map((r, idx) => ({
            rank: idx + 1,
            query: r.query,
            searchCount: parseInt(r.search_count),
            avgResults: Math.round(parseFloat(r.avg_results) || 0),
            avgTimeMs: Math.round(parseFloat(r.avg_time) || 0),
            uniqueUsers: parseInt(r.unique_users),
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Top queries failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Zero result queries (gap analysis)
   * 
   * GET /admin/search/analytics/zero-results?days=7&limit=20
   */
  @Get('zero-results')
  async getZeroResultQueries(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const limitNum = parseInt(limit || '20');

    try {
      const result = await this.pool.query(
        `SELECT 
           query,
           COUNT(*) as search_count,
           COUNT(DISTINCT COALESCE(user_id, session_id)) as unique_users,
           MIN(created_at) as first_seen,
           MAX(created_at) as last_seen
         FROM search_logs 
         WHERE results_count = 0
         AND created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY query 
         ORDER BY search_count DESC 
         LIMIT $1`,
        [limitNum],
      );

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          message: 'These queries returned no results - consider adding products or improving search',
          queries: result.rows.map((r, idx) => ({
            rank: idx + 1,
            query: r.query,
            searchCount: parseInt(r.search_count),
            uniqueUsers: parseInt(r.unique_users),
            firstSeen: r.first_seen,
            lastSeen: r.last_seen,
            priority: parseInt(r.search_count) > 10 ? 'high' : parseInt(r.search_count) > 5 ? 'medium' : 'low',
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Zero results query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search volume by hour/day
   * 
   * GET /admin/search/analytics/volume?days=7&granularity=day
   */
  @Get('volume')
  async getSearchVolume(
    @Query('days') days?: string,
    @Query('granularity') granularity?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const gran = granularity === 'hour' ? 'hour' : 'day';

    try {
      let query: string;
      if (gran === 'hour') {
        query = `
          SELECT 
            DATE_TRUNC('hour', created_at) as period,
            COUNT(*) as search_count,
            COUNT(DISTINCT COALESCE(user_id, session_id)) as unique_users
          FROM search_logs 
          WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
          GROUP BY DATE_TRUNC('hour', created_at)
          ORDER BY period ASC
        `;
      } else {
        query = `
          SELECT 
            DATE(created_at) as period,
            COUNT(*) as search_count,
            COUNT(DISTINCT COALESCE(user_id, session_id)) as unique_users
          FROM search_logs 
          WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
          GROUP BY DATE(created_at)
          ORDER BY period ASC
        `;
      }

      const result = await this.pool.query(query);

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          granularity: gran,
          volume: result.rows.map(r => ({
            period: r.period,
            searchCount: parseInt(r.search_count),
            uniqueUsers: parseInt(r.unique_users),
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Volume query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search type breakdown (keyword, semantic, hybrid)
   * 
   * GET /admin/search/analytics/types?days=7
   */
  @Get('types')
  async getSearchTypes(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7');

    try {
      const result = await this.pool.query(
        `SELECT 
           search_type,
           COUNT(*) as count,
           AVG(execution_time_ms) as avg_time,
           AVG(results_count) as avg_results
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY search_type
         ORDER BY count DESC`,
      );

      const total = result.rows.reduce((sum, r) => sum + parseInt(r.count), 0);

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          types: result.rows.map(r => ({
            type: r.search_type || 'unknown',
            count: parseInt(r.count),
            percentage: total > 0 ? ((parseInt(r.count) / total) * 100).toFixed(1) + '%' : '0%',
            avgTimeMs: Math.round(parseFloat(r.avg_time) || 0),
            avgResults: Math.round(parseFloat(r.avg_results) || 0),
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Types query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Performance metrics over time
   * 
   * GET /admin/search/analytics/performance?days=7
   */
  @Get('performance')
  async getPerformance(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7');

    try {
      const result = await this.pool.query(
        `SELECT 
           DATE(created_at) as date,
           AVG(execution_time_ms) as avg_time,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY execution_time_ms) as p50,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms) as p95,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY execution_time_ms) as p99,
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE execution_time_ms > 1000) as slow_queries
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
      );

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          dailyMetrics: result.rows.map(r => ({
            date: r.date,
            avgMs: Math.round(parseFloat(r.avg_time) || 0),
            p50Ms: Math.round(parseFloat(r.p50) || 0),
            p95Ms: Math.round(parseFloat(r.p95) || 0),
            p99Ms: Math.round(parseFloat(r.p99) || 0),
            totalQueries: parseInt(r.total),
            slowQueries: parseInt(r.slow_queries),
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Performance query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * User search patterns
   * 
   * GET /admin/search/analytics/user-patterns?days=7&limit=20
   */
  @Get('user-patterns')
  async getUserPatterns(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const limitNum = parseInt(limit || '20');

    try {
      const result = await this.pool.query(
        `SELECT 
           COALESCE(user_id, session_id) as user_identifier,
           COUNT(*) as search_count,
           COUNT(DISTINCT query) as unique_queries,
           AVG(results_count) as avg_results,
           MIN(created_at) as first_search,
           MAX(created_at) as last_search
         FROM search_logs 
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY COALESCE(user_id, session_id)
         HAVING COUNT(*) >= 3
         ORDER BY search_count DESC 
         LIMIT $1`,
        [limitNum],
      );

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          users: result.rows.map(r => ({
            userId: r.user_identifier,
            searchCount: parseInt(r.search_count),
            uniqueQueries: parseInt(r.unique_queries),
            avgResults: Math.round(parseFloat(r.avg_results) || 0),
            firstSearch: r.first_search,
            lastSearch: r.last_search,
            engagement: parseInt(r.search_count) > 20 ? 'high' : parseInt(r.search_count) > 10 ? 'medium' : 'low',
          })),
        },
      };
    } catch (error) {
      this.logger.error(`User patterns query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search query refinement analysis
   * Shows when users search multiple times in succession
   * 
   * GET /admin/search/analytics/refinements?days=7
   */
  @Get('refinements')
  async getSearchRefinements(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7');

    try {
      // Find sessions with multiple searches
      const result = await this.pool.query(
        `WITH session_searches AS (
           SELECT 
             session_id,
             query,
             created_at,
             results_count,
             LAG(query) OVER (PARTITION BY session_id ORDER BY created_at) as prev_query
           FROM search_logs 
           WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
           AND session_id IS NOT NULL
         )
         SELECT 
           prev_query as original_query,
           query as refined_query,
           COUNT(*) as refinement_count
         FROM session_searches
         WHERE prev_query IS NOT NULL 
         AND prev_query != query
         GROUP BY prev_query, query
         HAVING COUNT(*) >= 2
         ORDER BY refinement_count DESC
         LIMIT 20`,
      );

      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          refinements: result.rows.map(r => ({
            originalQuery: r.original_query,
            refinedQuery: r.refined_query,
            count: parseInt(r.refinement_count),
          })),
          insight: 'Shows how users refine their searches - consider improving original queries',
        },
      };
    } catch (error) {
      this.logger.error(`Refinements query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Export search logs for analysis
   * 
   * POST /admin/search/analytics/export
   * Body: { days: 7, format: 'json' }
   */
  @Post('export')
  async exportLogs(
    @Body() body: { days?: number; format?: string; limit?: number },
  ) {
    const { days = 7, format = 'json', limit = 10000 } = body;

    try {
      const result = await this.pool.query(
        `SELECT * FROM search_logs
         WHERE created_at >= NOW() - INTERVAL '${days} days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );

      return {
        success: true,
        data: {
          exportedAt: new Date(),
          period: `${days} days`,
          rowCount: result.rows.length,
          rows: result.rows,
        },
      };
    } catch (error) {
      this.logger.error(`Export failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Channel breakdown - searches grouped by platform (WhatsApp/Web/App)
   *
   * GET /admin/search/analytics/channels?days=7
   */
  @Get('channels')
  async getChannelBreakdown(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7');
    try {
      const channels = await this.analyticsService.getChannelBreakdown(daysNum);
      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          channels,
        },
      };
    } catch (error) {
      this.logger.error(`Channel breakdown failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Top queries filtered by channel/platform
   *
   * GET /admin/search/analytics/top-queries-by-channel?days=7&platform=whatsapp&limit=20
   */
  @Get('top-queries-by-channel')
  async getTopQueriesByChannel(
    @Query('days') days?: string,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const limitNum = parseInt(limit || '20');
    try {
      const queries = await this.analyticsService.getTopQueriesByChannel(daysNum, platform, limitNum);
      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          platform: platform || 'all',
          queries,
        },
      };
    } catch (error) {
      this.logger.error(`Top queries by channel failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Trending queries proxy - fetches from Search API ClickHouse analytics
   *
   * GET /admin/search/analytics/trending?days=7&module_id=4
   */
  @Get('trending')
  async getTrending(
    @Query('days') days?: string,
    @Query('module_id') moduleId?: string,
  ) {
    const daysNum = parseInt(days || '7');
    try {
      // Try to proxy to Search API ClickHouse-powered trending endpoint
      if (this.httpService) {
        try {
          const params: Record<string, any> = { window: `${daysNum}d` };
          if (moduleId) params.module_id = moduleId;

          const response = await firstValueFrom(
            this.httpService.get(`${this.searchApiUrl}/analytics/trending`, {
              params,
              timeout: 5000,
            }),
          );

          if (response.data) {
            return {
              success: true,
              source: 'clickhouse',
              data: response.data,
            };
          }
        } catch (proxyError) {
          this.logger.warn(`Search API trending proxy failed: ${proxyError.message}, falling back to PG`);
        }
      }

      // Fallback: compute trending from search_logs in PostgreSQL
      const result = await this.pool.query(
        `WITH current_period AS (
           SELECT query, COUNT(*) as current_count
           FROM search_logs
           WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
           GROUP BY query
           HAVING COUNT(*) >= 3
         ),
         previous_period AS (
           SELECT query, COUNT(*) as prev_count
           FROM search_logs
           WHERE created_at >= NOW() - INTERVAL '${daysNum * 2} days'
           AND created_at < NOW() - INTERVAL '${daysNum} days'
           GROUP BY query
         )
         SELECT
           c.query,
           c.current_count as count,
           COALESCE(p.prev_count, 0) as prev_count,
           CASE
             WHEN COALESCE(p.prev_count, 0) = 0 THEN 100
             ELSE ROUND(((c.current_count - p.prev_count)::numeric / p.prev_count * 100))
           END as trend_pct
         FROM current_period c
         LEFT JOIN previous_period p ON c.query = p.query
         ORDER BY
           CASE
             WHEN COALESCE(p.prev_count, 0) = 0 THEN c.current_count * 2
             ELSE c.current_count - p.prev_count
           END DESC
         LIMIT 30`,
      );

      return {
        success: true,
        source: 'postgresql',
        data: {
          period: `${daysNum} days`,
          queries: result.rows.map((r, idx) => ({
            rank: idx + 1,
            query: r.query,
            count: parseInt(r.count),
            prevCount: parseInt(r.prev_count),
            trendPct: parseInt(r.trend_pct),
            velocity: parseInt(r.trend_pct) > 20 ? 'rising' : parseInt(r.trend_pct) < -20 ? 'falling' : 'stable',
            module: 'food', // Default; PG doesn't store module
          })),
        },
      };
    } catch (error) {
      this.logger.error(`Trending query failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search volume broken down by channel over time
   *
   * GET /admin/search/analytics/volume-by-channel?days=7&granularity=day
   */
  @Get('volume-by-channel')
  async getVolumeByChannel(
    @Query('days') days?: string,
    @Query('granularity') granularity?: string,
  ) {
    const daysNum = parseInt(days || '7');
    const gran = granularity === 'hour' ? 'hour' : 'day';
    try {
      const volume = await this.analyticsService.getVolumeByChannel(daysNum, gran);
      return {
        success: true,
        data: {
          period: `${daysNum} days`,
          granularity: gran,
          volume,
        },
      };
    } catch (error) {
      this.logger.error(`Volume by channel failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
