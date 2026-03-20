import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PostAnalytics } from '../interfaces/content-factory.interfaces';

@Injectable()
export class AnalyticsCollectorService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsCollectorService.name);
  private pool: Pool;

  private facebookToken: string | null = null;
  private linkedinToken: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const dbUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: dbUrl, max: 3 });

    this.facebookToken = this.config.get('FACEBOOK_PAGE_ACCESS_TOKEN') || null;
    this.linkedinToken = this.config.get('LINKEDIN_ACCESS_TOKEN') || null;

    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS post_analytics (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content_piece_id UUID NOT NULL,
          platform VARCHAR(50) NOT NULL,
          impressions INTEGER DEFAULT 0,
          reach INTEGER DEFAULT 0,
          likes INTEGER DEFAULT 0,
          comments INTEGER DEFAULT 0,
          shares INTEGER DEFAULT 0,
          saves INTEGER DEFAULT 0,
          clicks INTEGER DEFAULT 0,
          engagement_rate DECIMAL(8,4) DEFAULT 0,
          video_views INTEGER DEFAULT 0,
          avg_watch_time_sec DECIMAL(8,2) DEFAULT 0,
          raw_metrics JSONB DEFAULT '{}',
          source VARCHAR(20) NOT NULL DEFAULT 'manual',
          collected_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_post_analytics_content ON post_analytics(content_piece_id);
        CREATE INDEX IF NOT EXISTS idx_post_analytics_platform ON post_analytics(platform);
        CREATE INDEX IF NOT EXISTS idx_post_analytics_collected ON post_analytics(collected_at DESC);
      `);
      this.logger.log('AnalyticsCollectorService initialized — post_analytics table ready');
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Manual entry — for pasting metrics from Instagram/LinkedIn dashboards
  // ---------------------------------------------------------------------------

  async manualEntry(
    contentPieceId: string,
    platform: string,
    metrics: {
      impressions?: number;
      reach?: number;
      likes?: number;
      comments?: number;
      shares?: number;
      saves?: number;
      clicks?: number;
      videoViews?: number;
      avgWatchTimeSec?: number;
    },
  ): Promise<PostAnalytics> {
    const impressions = metrics.impressions || 0;
    const reach = metrics.reach || 0;
    const likes = metrics.likes || 0;
    const comments = metrics.comments || 0;
    const shares = metrics.shares || 0;
    const saves = metrics.saves || 0;
    const clicks = metrics.clicks || 0;
    const videoViews = metrics.videoViews || 0;
    const avgWatchTimeSec = metrics.avgWatchTimeSec || 0;

    const totalEngagements = likes + comments + shares + saves + clicks;
    const engagementRate = impressions > 0 ? (totalEngagements / impressions) * 100 : 0;

    const result = await this.pool.query(
      `INSERT INTO post_analytics
        (content_piece_id, platform, impressions, reach, likes, comments, shares, saves, clicks, engagement_rate, video_views, avg_watch_time_sec, raw_metrics, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'manual')
       RETURNING *`,
      [contentPieceId, platform, impressions, reach, likes, comments, shares, saves, clicks, engagementRate, videoViews, avgWatchTimeSec, JSON.stringify(metrics)],
    );

    this.logger.log(`Manual analytics entry for content ${contentPieceId} on ${platform}: engagement_rate=${engagementRate.toFixed(2)}%`);
    return this.mapRow(result.rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Instagram Graph API collection
  // ---------------------------------------------------------------------------

  async collectInstagramMetrics(contentPieceId: string, externalPostId: string): Promise<PostAnalytics | null> {
    if (!this.facebookToken) {
      this.logger.warn('FACEBOOK_PAGE_ACCESS_TOKEN not set — cannot collect Instagram metrics');
      return null;
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/v22.0/${externalPostId}/insights?metric=impressions,reach,likes,comments,shares,saved,video_views&access_token=${this.facebookToken}`,
        { signal: AbortSignal.timeout(10000) },
      );

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Instagram API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const metricsMap: Record<string, number> = {};
      for (const item of data.data || []) {
        metricsMap[item.name] = item.values?.[0]?.value || 0;
      }

      const impressions = metricsMap.impressions || 0;
      const reach = metricsMap.reach || 0;
      const likes = metricsMap.likes || 0;
      const comments = metricsMap.comments || 0;
      const shares = metricsMap.shares || 0;
      const saves = metricsMap.saved || 0;
      const videoViews = metricsMap.video_views || 0;

      const totalEngagements = likes + comments + shares + saves;
      const engagementRate = impressions > 0 ? (totalEngagements / impressions) * 100 : 0;

      const result = await this.pool.query(
        `INSERT INTO post_analytics
          (content_piece_id, platform, impressions, reach, likes, comments, shares, saves, clicks, engagement_rate, video_views, raw_metrics, source)
         VALUES ($1, 'instagram', $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, 'api')
         RETURNING *`,
        [contentPieceId, impressions, reach, likes, comments, shares, saves, engagementRate, videoViews, JSON.stringify(data.data)],
      );

      this.logger.log(`Collected Instagram metrics for ${contentPieceId}: impressions=${impressions}, engagement=${engagementRate.toFixed(2)}%`);
      return this.mapRow(result.rows[0]);
    } catch (error: any) {
      this.logger.error(`Instagram metrics collection failed for ${contentPieceId}: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // LinkedIn API collection
  // ---------------------------------------------------------------------------

  async collectLinkedInMetrics(contentPieceId: string, externalPostId: string): Promise<PostAnalytics | null> {
    if (!this.linkedinToken) {
      this.logger.warn('LINKEDIN_ACCESS_TOKEN not set — cannot collect LinkedIn metrics');
      return null;
    }

    try {
      const res = await fetch(
        `https://api.linkedin.com/v2/socialActions/${externalPostId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.linkedinToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`LinkedIn API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const likes = data.likesSummary?.totalLikes || 0;
      const comments = data.commentsSummary?.totalFirstLevelComments || 0;
      const shares = data.shareCount || 0;

      // LinkedIn doesn't provide impressions directly via this endpoint
      // Using likes+comments+shares as a proxy for engagement
      const totalEngagements = likes + comments + shares;

      const result = await this.pool.query(
        `INSERT INTO post_analytics
          (content_piece_id, platform, impressions, reach, likes, comments, shares, saves, clicks, engagement_rate, raw_metrics, source)
         VALUES ($1, 'linkedin', 0, 0, $2, $3, $4, 0, 0, 0, $5, 'api')
         RETURNING *`,
        [contentPieceId, likes, comments, shares, JSON.stringify(data)],
      );

      this.logger.log(`Collected LinkedIn metrics for ${contentPieceId}: likes=${likes}, comments=${comments}, shares=${shares}`);
      return this.mapRow(result.rows[0]);
    } catch (error: any) {
      this.logger.error(`LinkedIn metrics collection failed for ${contentPieceId}: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch collection for all posted content with external IDs
  // ---------------------------------------------------------------------------

  async collectAllPostedContent(): Promise<{ collected: number; failed: number }> {
    let collected = 0;
    let failed = 0;

    try {
      const result = await this.pool.query(
        `SELECT cpl.content_piece_id, cpl.platform, cpl.external_post_id
         FROM content_publish_log cpl
         WHERE cpl.publish_status = 'published'
           AND cpl.external_post_id IS NOT NULL
           AND cpl.content_piece_id NOT IN (
             SELECT pa.content_piece_id FROM post_analytics pa
             WHERE pa.source = 'api' AND pa.collected_at > NOW() - INTERVAL '12 hours'
           )`,
      );

      for (const row of result.rows) {
        try {
          let analytics: PostAnalytics | null = null;

          if (row.platform === 'instagram') {
            analytics = await this.collectInstagramMetrics(row.content_piece_id, row.external_post_id);
          } else if (row.platform === 'linkedin') {
            analytics = await this.collectLinkedInMetrics(row.content_piece_id, row.external_post_id);
          }

          if (analytics) {
            collected++;
          } else {
            failed++;
          }
        } catch (error: any) {
          this.logger.warn(`Failed to collect metrics for ${row.content_piece_id}: ${error.message}`);
          failed++;
        }
      }
    } catch (error: any) {
      this.logger.error(`collectAllPostedContent failed: ${error.message}`);
    }

    this.logger.log(`Batch analytics collection: ${collected} collected, ${failed} failed`);
    return { collected, failed };
  }

  // ---------------------------------------------------------------------------
  // Read helpers
  // ---------------------------------------------------------------------------

  async getAnalytics(contentPieceId: string): Promise<PostAnalytics[]> {
    const result = await this.pool.query(
      'SELECT * FROM post_analytics WHERE content_piece_id = $1 ORDER BY collected_at DESC',
      [contentPieceId],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  async getTopPerforming(platform?: string, metric?: string, limit?: number): Promise<PostAnalytics[]> {
    const orderBy = metric || 'engagement_rate';
    const validColumns = ['engagement_rate', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'video_views'];
    const sortColumn = validColumns.includes(orderBy) ? orderBy : 'engagement_rate';

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (platform) {
      conditions.push(`platform = $${idx++}`);
      params.push(platform);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const queryLimit = limit || 20;

    const result = await this.pool.query(
      `SELECT DISTINCT ON (content_piece_id) *
       FROM post_analytics
       ${where}
       ORDER BY content_piece_id, collected_at DESC`,
      params,
    );

    // Sort by the requested metric in application code (since DISTINCT ON requires matching ORDER BY)
    const rows = result.rows
      .map(r => this.mapRow(r))
      .sort((a, b) => {
        const aVal = (a as any)[this.snakeToCamel(sortColumn)] || 0;
        const bVal = (b as any)[this.snakeToCamel(sortColumn)] || 0;
        return bVal - aVal;
      })
      .slice(0, queryLimit);

    return rows;
  }

  async getSummary(): Promise<Record<string, any>> {
    try {
      const result = await this.pool.query(`
        SELECT
          COUNT(DISTINCT content_piece_id) as total_tracked,
          COUNT(*) as total_entries,
          AVG(engagement_rate) as avg_engagement_rate,
          SUM(impressions) as total_impressions,
          SUM(reach) as total_reach,
          SUM(likes) as total_likes,
          SUM(comments) as total_comments,
          SUM(shares) as total_shares,
          SUM(saves) as total_saves,
          SUM(clicks) as total_clicks,
          SUM(video_views) as total_video_views
        FROM post_analytics
      `);

      const row = result.rows[0] || {};

      // Per-platform breakdown
      const platformResult = await this.pool.query(`
        SELECT
          platform,
          COUNT(DISTINCT content_piece_id) as tracked_posts,
          AVG(engagement_rate) as avg_engagement_rate,
          SUM(impressions) as total_impressions,
          SUM(likes) as total_likes
        FROM post_analytics
        GROUP BY platform
      `);

      return {
        totalTrackedPosts: parseInt(row.total_tracked) || 0,
        totalEntries: parseInt(row.total_entries) || 0,
        avgEngagementRate: parseFloat(row.avg_engagement_rate) || 0,
        totalImpressions: parseInt(row.total_impressions) || 0,
        totalReach: parseInt(row.total_reach) || 0,
        totalLikes: parseInt(row.total_likes) || 0,
        totalComments: parseInt(row.total_comments) || 0,
        totalShares: parseInt(row.total_shares) || 0,
        totalSaves: parseInt(row.total_saves) || 0,
        totalClicks: parseInt(row.total_clicks) || 0,
        totalVideoViews: parseInt(row.total_video_views) || 0,
        byPlatform: platformResult.rows.map(r => ({
          platform: r.platform,
          trackedPosts: parseInt(r.tracked_posts) || 0,
          avgEngagementRate: parseFloat(r.avg_engagement_rate) || 0,
          totalImpressions: parseInt(r.total_impressions) || 0,
          totalLikes: parseInt(r.total_likes) || 0,
        })),
      };
    } catch (error: any) {
      this.logger.error(`getSummary failed: ${error.message}`);
      return { totalTrackedPosts: 0, totalEntries: 0, avgEngagementRate: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Row mapper
  // ---------------------------------------------------------------------------

  private mapRow(row: any): PostAnalytics {
    return {
      id: row.id,
      contentPieceId: row.content_piece_id,
      platform: row.platform,
      impressions: parseInt(row.impressions) || 0,
      reach: parseInt(row.reach) || 0,
      likes: parseInt(row.likes) || 0,
      comments: parseInt(row.comments) || 0,
      shares: parseInt(row.shares) || 0,
      saves: parseInt(row.saves) || 0,
      clicks: parseInt(row.clicks) || 0,
      engagementRate: parseFloat(row.engagement_rate) || 0,
      videoViews: parseInt(row.video_views) || 0,
      avgWatchTimeSec: parseFloat(row.avg_watch_time_sec) || 0,
      rawMetrics: row.raw_metrics || {},
      source: row.source,
      collectedAt: row.collected_at,
    };
  }

  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }
}
