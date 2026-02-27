import { Controller, Get, Post, Patch, Param, Query, Body, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AssetGenerationService } from '../services/asset-generation.service';
import { AdExecutionService } from '../services/ad-execution.service';
import { ApprovalService } from '../../approval/services/approval.service';
import { AutoActionService } from '../../scheduler/services/auto-action.service';

@Controller('mos/action-engine')
export class ActionEngineController {
  private readonly logger = new Logger(ActionEngineController.name);
  private pool: Pool;

  constructor(
    private readonly assets: AssetGenerationService,
    private readonly executions: AdExecutionService,
    private readonly approvals: ApprovalService,
    private readonly autoActions: AutoActionService,
    private readonly config: ConfigService,
  ) {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });
  }

  // --- Assets ---

  @Get('assets')
  async listAssets(
    @Query('campaignId') campaignId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.assets.getAssets({
      campaignId,
      type,
      status,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('assets/stats')
  async getAssetStats() {
    return this.assets.getAssetStats();
  }

  @Get('assets/:id')
  async getAsset(@Param('id') id: string) {
    return this.assets.getAssetById(id);
  }

  @Post('assets/generate')
  async generateImage(
    @Body() body: { prompt: string; provider?: string; size?: string; quality?: string },
  ) {
    return this.assets.generateImage(body.prompt, body.provider, {
      size: body.size,
      quality: body.quality,
    });
  }

  @Post('assets/copy')
  async generateCopy(
    @Body() body: { product: string; tone: string; platform: string; language?: string },
  ) {
    return this.assets.generateCopy(body.product, body.tone, body.platform, body.language);
  }

  // --- Executions ---

  @Get('executions')
  async listExecutions(
    @Query('campaignId') campaignId?: string,
    @Query('platform') platform?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.executions.getExecutions({
      campaignId,
      platform,
      status,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('executions/stats')
  async getExecutionStats() {
    return this.executions.getExecutionStats();
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    return this.executions.getExecutionById(id);
  }

  @Post('executions')
  async createExecution(
    @Body() body: {
      campaignId?: string;
      platform: string;
      adType: string;
      assetId?: string;
      headline: string;
      bodyText: string;
      callToAction?: string;
      targetAudience?: Record<string, any>;
      budgetDaily?: number;
    },
  ) {
    return this.executions.createAd(body);
  }

  @Post('executions/:id/submit-approval')
  async submitForApproval(@Param('id') id: string) {
    return this.executions.submitForApproval(id);
  }

  @Post('executions/:id/approve')
  async approveExecution(
    @Param('id') id: string,
    @Body() body: { decidedBy: string; notes?: string },
  ) {
    return this.executions.approveAd(id, body.decidedBy, body.notes);
  }

  @Post('executions/:id/publish')
  async publishExecution(@Param('id') id: string) {
    return this.executions.publishAd(id);
  }

  @Patch('executions/:id/pause')
  async pauseExecution(@Param('id') id: string) {
    return this.executions.pauseAd(id);
  }

  @Patch('executions/:id/resume')
  async resumeExecution(@Param('id') id: string) {
    return this.executions.resumeAd(id);
  }

  @Post('executions/sync-performance')
  async syncPerformance() {
    return this.executions.syncPerformance();
  }

  // --- Campaign Triggers ---

  @Post('campaigns/trigger')
  async triggerCampaign(
    @Body() body: {
      name: string;
      product: string;
      platform?: string;
      tone?: string;
      dailyBudget?: number;
      adminPhone?: string;
    },
  ) {
    const headline = body.name;
    const bodyText = `Campaign for ${body.product}`;
    const platform = body.platform || 'meta';

    // Create ad draft
    const ad = await this.executions.createAd({
      platform,
      adType: 'campaign',
      headline,
      bodyText,
      budgetDaily: body.dailyBudget,
    });

    // Create approval request
    const approval = await this.approvals.createRequest({
      type: 'campaign_trigger',
      title: `Campaign: ${headline}`,
      description: `${body.tone || 'professional'} campaign for ${body.product} on ${platform}`,
      payload: {
        adId: ad.id, platform, product: body.product,
        tone: body.tone, adminPhone: body.adminPhone,
      },
      priority: 'normal',
      requestedBy: 'action-engine',
    });

    return {
      adId: ad.id,
      approvalId: approval.id,
      status: 'pending_approval',
      message: 'Campaign ad created and submitted for approval',
    };
  }

  // --- Cart Recovery ---

  @Get('campaigns/cart-recovery-stats')
  async getCartRecoveryStats() {
    try {
      const { rows: [stats] } = await this.pool.query(`
        SELECT
          COALESCE(SUM(items_affected), 0)::int AS "nudgesSent",
          COUNT(*)::int AS "totalRuns"
        FROM auto_action_history
        WHERE action_name = 'cart_recovery'
      `);

      const { rows: [conversions] } = await this.pool.query(`
        SELECT COUNT(*)::int AS count
        FROM whatsapp_orders
        WHERE status = 'confirmed'
          AND updated_at > created_at + INTERVAL '2 hours'
      `);

      const { rows: [discounts] } = await this.pool.query(`
        SELECT COUNT(*)::int AS count
        FROM discount_decisions
        WHERE redeemed = true AND reason = 'cart_recovery'
      `);

      return {
        nudgesSent: stats?.nudgesSent || 0,
        conversions: conversions?.count || 0,
        discountCodesUsed: discounts?.count || 0,
        totalRuns: stats?.totalRuns || 0,
      };
    } catch (error: any) {
      this.logger.warn(`Cart recovery stats query failed (tables may not exist yet): ${error.message}`);
      return { nudgesSent: 0, conversions: 0, discountCodesUsed: 0, totalRuns: 0 };
    }
  }

  @Post('campaigns/test-cart-recovery')
  async testCartRecovery(@Body() body: { phone: string }) {
    const phone = body.phone;
    if (!phone) {
      return { success: false, error: 'Phone number is required' };
    }

    try {
      // Find an abandoned cart for this phone, or report none found
      const { rows } = await this.pool.query(
        `SELECT id, phone_number, items, subtotal, total
         FROM whatsapp_orders
         WHERE phone_number = $1 AND status = 'cart'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [phone],
      );

      if (rows.length === 0) {
        return {
          success: false,
          error: `No abandoned cart found for ${phone}`,
          hint: 'Create a cart via WhatsApp commerce first, or the cart may already be confirmed',
        };
      }

      // Run the cart recovery action for this single user
      await this.autoActions.maybeRunAction('cart_recovery', { testPhone: phone });

      return {
        success: true,
        cartId: rows[0].id,
        items: rows[0].items,
        total: rows[0].total,
        message: `Cart recovery nudge triggered for ${phone}`,
      };
    } catch (error: any) {
      this.logger.error(`Test cart recovery failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @Get('flow-runs')
  async getFlowRuns(
    @Query('flowName') flowName?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (flowName) {
      conditions.push(`flow_name = $${idx++}`);
      params.push(flowName);
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = limit ? parseInt(limit) : 50;
    params.push(lim);

    const { rows } = await this.pool.query(
      `SELECT id, flow_name, session_id, status, context, started_at, completed_at, current_step
       FROM flow_runs ${where}
       ORDER BY started_at DESC
       LIMIT $${idx}`,
      params,
    );

    return rows.map((r: any) => ({
      id: r.id,
      flowName: r.flow_name,
      sessionId: r.session_id,
      status: r.status,
      context: r.context,
      currentStep: r.current_step,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }
}
