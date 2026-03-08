import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class AdExecutionService implements OnModuleInit {
  private readonly logger = new Logger(AdExecutionService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS ad_executions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id UUID,
          platform VARCHAR(30) NOT NULL,
          ad_type VARCHAR(30) NOT NULL,
          asset_id UUID,
          headline TEXT,
          body_text TEXT,
          call_to_action VARCHAR(50),
          target_audience JSONB DEFAULT '{}',
          budget_daily DECIMAL(10,2),
          status VARCHAR(20) DEFAULT 'draft',
          ext_ad_id VARCHAR(100),
          performance JSONB DEFAULT '{}',
          approval_id UUID,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        -- Add campaign_id if table was created before this column existed
        ALTER TABLE ad_executions ADD COLUMN IF NOT EXISTS campaign_id UUID;
        CREATE INDEX IF NOT EXISTS idx_executions_status ON ad_executions(status);
        CREATE INDEX IF NOT EXISTS idx_executions_platform ON ad_executions(platform);
        CREATE INDEX IF NOT EXISTS idx_executions_campaign ON ad_executions(campaign_id);
      `);
      client.release();
      this.logger.log('AdExecutionService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async createAd(dto: {
    campaignId?: string;
    platform: string;
    adType: string;
    assetId?: string;
    headline: string;
    bodyText: string;
    callToAction?: string;
    targetAudience?: Record<string, any>;
    budgetDaily?: number;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO ad_executions
       (campaign_id, platform, ad_type, asset_id, headline, body_text, call_to_action, target_audience, budget_daily)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        dto.campaignId || null,
        dto.platform,
        dto.adType,
        dto.assetId || null,
        dto.headline,
        dto.bodyText,
        dto.callToAction || null,
        JSON.stringify(dto.targetAudience || {}),
        dto.budgetDaily || null,
      ],
    );
    this.logger.log(`Ad created: ${result.rows[0].id} on ${dto.platform}`);
    return this.mapRow(result.rows[0]);
  }

  async submitForApproval(adId: string): Promise<any> {
    const ad = await this.getExecutionById(adId);
    if (!ad) {
      throw new Error(`Ad execution ${adId} not found`);
    }

    // Create approval request in the shared approval_requests table
    const approvalResult = await this.pool.query(
      `INSERT INTO approval_requests (type, title, description, payload, priority, requested_by)
       VALUES ('ad_publish', $1, $2, $3, 'normal', 'action-engine')
       RETURNING *`,
      [
        `Approve ad: ${ad.headline || ad.adType}`,
        `${ad.platform} ${ad.adType} ad with daily budget ${ad.budgetDaily || 'N/A'} INR`,
        JSON.stringify({ adId, platform: ad.platform, adType: ad.adType, headline: ad.headline }),
      ],
    );
    const approvalId = approvalResult.rows[0].id;

    // Update ad status
    await this.pool.query(
      `UPDATE ad_executions SET status = 'pending_approval', approval_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [approvalId, adId],
    );

    this.logger.log(`Ad ${adId} submitted for approval (${approvalId})`);
    return {
      adId,
      approvalId,
      status: 'pending_approval',
    };
  }

  async approveAd(adId: string, decidedBy: string, notes?: string): Promise<any> {
    // Update approval_requests
    const ad = await this.getExecutionById(adId);
    if (!ad) {
      throw new Error(`Ad execution ${adId} not found`);
    }

    if (ad.approvalId) {
      await this.pool.query(
        `UPDATE approval_requests
         SET status = 'approved', decided_by = $1, decided_at = NOW(), decision_notes = $2, updated_at = NOW()
         WHERE id = $3`,
        [decidedBy, notes || null, ad.approvalId],
      );
    }

    // Update ad status
    const result = await this.pool.query(
      `UPDATE ad_executions SET status = 'approved', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [adId],
    );

    this.logger.log(`Ad ${adId} approved by ${decidedBy}`);
    return this.mapRow(result.rows[0]);
  }

  async publishAd(adId: string): Promise<any> {
    const ad = await this.getExecutionById(adId);
    if (!ad) {
      throw new Error(`Ad execution ${adId} not found`);
    }

    let extAdId: string | null = null;

    if (ad.platform === 'meta' || ad.platform === 'facebook' || ad.platform === 'instagram') {
      try {
        const accessToken = this.config.get('FACEBOOK_ACCESS_TOKEN');
        if (!accessToken) {
          this.logger.warn('FACEBOOK_ACCESS_TOKEN not configured, simulating publish');
          extAdId = `sim_meta_${Date.now()}`;
        } else {
          // Meta Marketing API - create ad
          const adAccountId = this.config.get('META_AD_ACCOUNT_ID') || 'act_placeholder';
          const response = await fetch(
            `https://graph.facebook.com/v18.0/${adAccountId}/ads`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token: accessToken,
                name: ad.headline,
                status: 'ACTIVE',
              }),
            },
          );

          if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Meta API error ${response.status}: ${errBody}`);
          }

          const data = await response.json();
          extAdId = data.id;
        }
      } catch (error: any) {
        this.logger.error(`Meta publish failed: ${error.message}`);
        extAdId = `sim_meta_${Date.now()}`;
      }
    } else if (ad.platform === 'google') {
      this.logger.warn('Google Ads API not yet integrated, marking as simulated');
      extAdId = `sim_google_${Date.now()}`;
    } else {
      extAdId = `sim_${ad.platform}_${Date.now()}`;
    }

    // Mark simulated executions explicitly in performance JSONB
    const isSimulated = extAdId?.startsWith('sim_') || false;
    const performanceUpdate = isSimulated
      ? JSON.stringify({ simulated: true, simulatedAt: new Date().toISOString() })
      : '{}';

    const result = await this.pool.query(
      `UPDATE ad_executions SET status = 'live', ext_ad_id = $1, performance = performance || $3::jsonb, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [extAdId, adId, performanceUpdate],
    );

    this.logger.log(`Ad ${adId} published on ${ad.platform} (ext: ${extAdId})`);
    return this.mapRow(result.rows[0]);
  }

  async pauseAd(adId: string): Promise<any> {
    const result = await this.pool.query(
      `UPDATE ad_executions SET status = 'paused', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [adId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Ad execution ${adId} not found`);
    }
    this.logger.log(`Ad ${adId} paused`);
    return this.mapRow(result.rows[0]);
  }

  async resumeAd(adId: string): Promise<any> {
    const result = await this.pool.query(
      `UPDATE ad_executions SET status = 'live', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [adId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Ad execution ${adId} not found`);
    }
    this.logger.log(`Ad ${adId} resumed`);
    return this.mapRow(result.rows[0]);
  }

  async syncPerformance(adId?: string): Promise<any> {
    // Placeholder: In production, pull metrics from Meta/Google APIs
    if (adId) {
      const ad = await this.getExecutionById(adId);
      if (!ad) {
        throw new Error(`Ad execution ${adId} not found`);
      }

      // Simulated metrics for development
      const mockPerformance = {
        impressions: Math.floor(Math.random() * 10000),
        clicks: Math.floor(Math.random() * 500),
        spend: parseFloat((Math.random() * 1000).toFixed(2)),
        conversions: Math.floor(Math.random() * 50),
        ctr: parseFloat((Math.random() * 5).toFixed(2)),
        lastSynced: new Date().toISOString(),
      };

      await this.pool.query(
        `UPDATE ad_executions SET performance = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(mockPerformance), adId],
      );

      this.logger.log(`Performance synced for ad ${adId}`);
      return { adId, performance: mockPerformance };
    }

    // Sync all live ads
    const liveAds = await this.pool.query(
      `SELECT id FROM ad_executions WHERE status = 'live'`,
    );

    const results: any[] = [];
    for (const row of liveAds.rows) {
      const result = await this.syncPerformance(row.id);
      results.push(result);
    }

    this.logger.log(`Performance synced for ${results.length} live ads`);
    return { synced: results.length, results };
  }

  async getExecutions(filters?: {
    campaignId?: string;
    platform?: string;
    status?: string;
    limit?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters?.campaignId) {
      conditions.push(`campaign_id = $${paramIdx++}`);
      params.push(filters.campaignId);
    }
    if (filters?.platform) {
      conditions.push(`platform = $${paramIdx++}`);
      params.push(filters.platform);
    }
    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;

    const result = await this.pool.query(
      `SELECT * FROM ad_executions ${where} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      [...params, limit],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  async getExecutionById(id: string): Promise<any | null> {
    const result = await this.pool.query(
      'SELECT * FROM ad_executions WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async getExecutionStats(): Promise<any> {
    const [total, byPlatform, byStatus, budgetResult] = await Promise.all([
      this.pool.query('SELECT COUNT(*)::int AS count FROM ad_executions'),
      this.pool.query(
        'SELECT platform, COUNT(*)::int AS count FROM ad_executions GROUP BY platform ORDER BY count DESC',
      ),
      this.pool.query(
        'SELECT status, COUNT(*)::int AS count FROM ad_executions GROUP BY status ORDER BY count DESC',
      ),
      this.pool.query(
        'SELECT COALESCE(SUM(budget_daily), 0)::float AS total_daily_budget FROM ad_executions WHERE status = \'live\'',
      ),
    ]);

    return {
      total: total.rows[0].count,
      byPlatform: byPlatform.rows,
      byStatus: byStatus.rows,
      totalDailyBudget: budgetResult.rows[0].total_daily_budget,
    };
  }

  private mapRow(row: any): any {
    return {
      id: row.id,
      campaignId: row.campaign_id,
      platform: row.platform,
      adType: row.ad_type,
      assetId: row.asset_id,
      headline: row.headline,
      bodyText: row.body_text,
      callToAction: row.call_to_action,
      targetAudience: row.target_audience,
      budgetDaily: row.budget_daily ? parseFloat(row.budget_daily) : null,
      status: row.status,
      extAdId: row.ext_ad_id,
      performance: row.performance,
      approvalId: row.approval_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
