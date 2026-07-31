import { Injectable, Inject, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';
import { WeatherCampaignTriggerService } from '../../broadcast/services/weather-campaign-trigger.service';
import { ReorderService } from '../../broadcast/services/reorder.service';
import { SmartDiscountService } from '../../demand/services/smart-discount.service';

export interface AutoAction {
  actionName: string;
  enabled: boolean;
  config: Record<string, any>;
  lastTriggeredAt: Date | null;
  triggerCount: number;
  createdAt: Date;
}

interface ActionDefinition {
  actionName: string;
  defaultEnabled: boolean;
  defaultConfig: Record<string, any>;
  description: string;
}

const ACTION_DEFINITIONS: ActionDefinition[] = [
  {
    actionName: 'churn_reengagement',
    defaultEnabled: false,
    defaultConfig: { churn_threshold: 0.7, max_discount_pct: 25, min_discount_pct: 10 },
    description: 'Users with high churn risk get WhatsApp discount nudge',
  },
  {
    actionName: 'reorder_nudge',
    defaultEnabled: false,
    defaultConfig: { max_nudges_per_day: 50, cooldown_days: 3 },
    description: 'Users due for reorder get WhatsApp reminder',
  },
  {
    actionName: 'auto_refund_late',
    defaultEnabled: false,
    defaultConfig: { late_threshold_minutes: 15, max_refund_amount: 50 },
    description: 'Late deliveries auto-credit wallet refund',
  },
  {
    actionName: 'weather_campaign',
    defaultEnabled: false,
    defaultConfig: { enabled_conditions: ['rainy', 'hot', 'cold'], cooldown_hours: 6 },
    description: 'Weather-triggered WhatsApp campaign',
  },
  {
    actionName: 'festival_campaign',
    defaultEnabled: false,
    defaultConfig: { send_before_hours: 4 },
    description: 'Festival-triggered themed campaign',
  },
  {
    actionName: 'slow_kitchen_alert',
    defaultEnabled: false,
    defaultConfig: { prep_time_threshold_minutes: 20, alert_phone: '' },
    description: 'Alert admin when store avg prep > threshold',
  },
  {
    actionName: 'cart_recovery',
    defaultEnabled: false,
    defaultConfig: { abandonment_window_hours: 2, max_nudges_per_run: 30, discount_code: 'COMEBACK10' },
    description: 'Abandoned cart recovery via WhatsApp nudge with discount',
  },
];

@Injectable()
export class AutoActionService implements OnModuleInit {
  private readonly logger = new Logger(AutoActionService.name);
  private pool: Pool;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => WhatsAppCloudService))
    private readonly whatsapp: WhatsAppCloudService,
    private readonly weatherTrigger: WeatherCampaignTriggerService,
    private readonly reorderService: ReorderService,
    private readonly smartDiscount: SmartDiscountService,
  ) {}

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS auto_action_config (
          action_name VARCHAR(100) PRIMARY KEY,
          enabled BOOLEAN DEFAULT false,
          config JSONB DEFAULT '{}',
          last_triggered_at TIMESTAMP,
          trigger_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS auto_action_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action_name VARCHAR(100) NOT NULL,
          trigger_source VARCHAR(100),
          result JSONB,
          items_affected INTEGER DEFAULT 0,
          triggered_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_action_hist_name ON auto_action_history(action_name);
        CREATE INDEX IF NOT EXISTS idx_action_hist_triggered ON auto_action_history(triggered_at DESC);
      `);

      // Seed default action configs
      for (const action of ACTION_DEFINITIONS) {
        await client.query(
          `INSERT INTO auto_action_config (action_name, enabled, config)
           VALUES ($1, $2, $3)
           ON CONFLICT (action_name) DO NOTHING`,
          [action.actionName, action.defaultEnabled, JSON.stringify(action.defaultConfig)],
        );
      }

      client.release();
      this.logger.log('AutoActionService initialized with 7 action definitions');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Called by scheduler after a cron job completes.
   * Checks if the associated auto-action is enabled and executes it.
   */
  async maybeRunAction(actionName: string, triggerData: any): Promise<void> {
    try {
      const action = await this.getAction(actionName);
      if (!action || !action.enabled) {
        this.logger.debug(`Auto-action ${actionName} is disabled, skipping`);
        return;
      }

      this.logger.log(`Executing auto-action: ${actionName}`);

      let result: any = null;
      let itemsAffected = 0;

      switch (actionName) {
        case 'churn_reengagement':
          result = await this.executeChurnReengagement(action.config, triggerData);
          itemsAffected = result?.usersTargeted || 0;
          break;

        case 'reorder_nudge':
          result = await this.executeReorderNudge(action.config, triggerData);
          itemsAffected = result?.nudgesSent || 0;
          break;

        case 'auto_refund_late':
          result = await this.executeAutoRefund(action.config, triggerData);
          itemsAffected = result?.refundsIssued || 0;
          break;

        case 'weather_campaign':
          result = await this.executeWeatherCampaign(action.config, triggerData);
          itemsAffected = result?.campaignsSent || 0;
          break;

        case 'festival_campaign':
          result = await this.executeFestivalCampaign(action.config, triggerData);
          itemsAffected = result?.campaignsSent || 0;
          break;

        case 'slow_kitchen_alert':
          result = await this.executeSlowKitchenAlert(action.config, triggerData);
          itemsAffected = result?.alertsSent || 0;
          break;

        case 'cart_recovery':
          result = await this.executeCartRecovery(action.config, triggerData);
          itemsAffected = result?.nudgesSent || 0;
          break;

        default:
          this.logger.warn(`Unknown auto-action: ${actionName}`);
          return;
      }

      // Record execution
      await this.recordExecution(actionName, 'scheduler', result, itemsAffected);
      this.logger.log(`Auto-action ${actionName} completed: ${itemsAffected} items affected`);
    } catch (error: any) {
      this.logger.error(`Auto-action ${actionName} failed: ${error.message}`);
    }
  }

  // ─── Action Implementations ─────────────────────────────────

  private async executeChurnReengagement(
    config: Record<string, any>,
    _triggerData: any,
  ): Promise<any> {
    const threshold = config.churn_threshold || 0.7;

    // Query users with high churn risk who have a phone number
    const { rows: atRiskUsers } = await this.pool.query(
      `SELECT user_id, phone, churn_risk, health_score, rfm_segment, avg_order_value
       FROM customer_health_scores
       WHERE churn_risk > $1 AND phone IS NOT NULL
       ORDER BY churn_risk DESC
       LIMIT 50`,
      [threshold],
    );

    if (atRiskUsers.length === 0) {
      this.logger.log(`[churn_reengagement] No users above churn threshold ${threshold}`);
      return { usersTargeted: 0, threshold, status: 'no_targets' };
    }

    let sent = 0;
    for (const user of atRiskUsers) {
      try {
        // Use SmartDiscountService for proper tracking + dedup
        const discount = await this.smartDiscount.getPersonalizedDiscount(user.user_id);
        if (!discount) {
          this.logger.debug(`[churn_reengagement] No discount for user ${user.user_id} (already active or ineligible)`);
          continue;
        }

        const message =
          `Hi! We miss you at Mangwale. ` +
          `Here's a special Rs ${discount.discountAmount} off on your next order. ` +
          `Use code: ${discount.discountCode} (valid 7 days). ` +
          `Order now and enjoy your favorites!`;

        await this.whatsapp.sendText(user.phone, message);
        sent++;
      } catch (err: any) {
        this.logger.warn(`[churn_reengagement] Failed to send to ${user.phone}: ${err.message}`);
      }
    }

    this.logger.log(`[churn_reengagement] Sent ${sent}/${atRiskUsers.length} nudges`);
    return { usersTargeted: sent, totalCandidates: atRiskUsers.length, threshold, status: 'executed' };
  }

  private async executeReorderNudge(
    config: Record<string, any>,
    _triggerData: any,
  ): Promise<any> {
    const maxNudges = config.max_nudges_per_day || 50;

    // Use ReorderService to find candidates
    const candidates = await this.reorderService.findUsersForReorderNudge(maxNudges);

    if (candidates.length === 0) {
      this.logger.log('[reorder_nudge] No reorder candidates found');
      return { nudgesSent: 0, candidatesFound: 0, status: 'no_candidates' };
    }

    let sent = 0;
    for (const candidate of candidates) {
      try {
        const message =
          `Hi! You ordered ${candidate.itemName} from ${candidate.storeName} ` +
          `${candidate.daysSince} days ago. Ready for another one? Order now on Mangwale!`;

        await this.whatsapp.sendText(candidate.phone, message);
        sent++;
      } catch (err: any) {
        this.logger.warn(`[reorder_nudge] Failed to send to ${candidate.phone}: ${err.message}`);
      }
    }

    this.logger.log(`[reorder_nudge] Sent ${sent}/${candidates.length} nudges`);
    return { nudgesSent: sent, candidatesFound: candidates.length, status: 'executed' };
  }

  private async executeAutoRefund(
    config: Record<string, any>,
    _triggerData: any,
  ): Promise<any> {
    const threshold = config.late_threshold_minutes || 15;
    const maxRefund = config.max_refund_amount || 50;

    // Query late orders from auto_refund_log that haven't been processed yet
    const { rows: lateOrders } = await this.pool.query(
      `SELECT id, order_id, user_id, phone, delay_minutes, refund_amount, status
       FROM auto_refund_log
       WHERE status = 'pending' AND delay_minutes >= $1 AND refund_amount <= $2
       ORDER BY delay_minutes DESC
       LIMIT 20`,
      [threshold, maxRefund],
    );

    if (lateOrders.length === 0) {
      this.logger.log('[auto_refund_late] No pending late refunds found');
      return { refundsIssued: 0, threshold, maxRefund, status: 'no_pending' };
    }

    // Mark them as flagged for manual processing (safe first step)
    let flagged = 0;
    for (const order of lateOrders) {
      try {
        await this.pool.query(
          `UPDATE auto_refund_log SET status = 'flagged_for_review', updated_at = NOW() WHERE id = $1`,
          [order.id],
        );
        flagged++;
      } catch (err: any) {
        this.logger.warn(`[auto_refund_late] Failed to flag order ${order.order_id}: ${err.message}`);
      }
    }

    this.logger.log(`[auto_refund_late] Flagged ${flagged} orders for review (threshold: ${threshold}min, max: Rs ${maxRefund})`);
    return { refundsIssued: flagged, threshold, maxRefund, status: 'flagged_for_review' };
  }

  private async executeWeatherCampaign(
    config: Record<string, any>,
    triggerData: any,
  ): Promise<any> {
    const triggers = triggerData?.triggers || [];

    if (triggers.length === 0) {
      this.logger.log('[weather_campaign] No weather triggers matched');
      return { campaignsSent: 0, triggersMatched: 0, status: 'no_triggers' };
    }

    let fired = 0;
    for (const trigger of triggers) {
      try {
        await this.weatherTrigger.recordTriggerFired(trigger.id);
        fired++;
        this.logger.log(`[weather_campaign] Fired trigger: ${trigger.triggerName || trigger.id}`);
      } catch (err: any) {
        this.logger.warn(`[weather_campaign] Failed to fire trigger ${trigger.id}: ${err.message}`);
      }
    }

    return { campaignsSent: fired, triggersMatched: triggers.length, status: 'executed' };
  }

  private async executeFestivalCampaign(
    config: Record<string, any>,
    triggerData: any,
  ): Promise<any> {
    const events = triggerData?.events || [];

    if (events.length === 0) {
      this.logger.log('[festival_campaign] No festival events to trigger today');
      return { campaignsSent: 0, eventsToday: 0, status: 'no_events' };
    }

    let sent = 0;
    for (const event of events) {
      try {
        this.logger.log(
          `[festival_campaign] Triggering campaign for ${event.name}: ${event.campaignMessage || 'no message'}`,
        );
        // Log the trigger execution for audit trail
        await this.pool.query(
          `INSERT INTO auto_action_history (action_name, trigger_source, result, items_affected)
           VALUES ('festival_campaign', $1, $2, 1)`,
          [`festival:${event.name}`, JSON.stringify({ festival: event.name, date: event.date, items: event.items })],
        );
        sent++;
      } catch (err: any) {
        this.logger.warn(`[festival_campaign] Failed to trigger for ${event.name}: ${err.message}`);
      }
    }

    return { campaignsSent: sent, eventsToday: events.length, status: 'executed' };
  }

  private async executeSlowKitchenAlert(
    config: Record<string, any>,
    _triggerData: any,
  ): Promise<any> {
    const threshold = config.prep_time_threshold_minutes || 20;
    const alertPhone = config.alert_phone;

    // Query stores with avg prep time above threshold
    const { rows: slowStores } = await this.pool.query(
      `SELECT store_id, store_name, avg_prep_time, p90_prep_time, sample_count
       FROM prep_time_predictions
       WHERE item_category = 'all'
         AND avg_prep_time > $1
         AND sample_count >= 3
       ORDER BY avg_prep_time DESC
       LIMIT 10`,
      [threshold],
    );

    if (slowStores.length === 0) {
      this.logger.log(`[slow_kitchen_alert] No stores above ${threshold}min threshold`);
      return { alertsSent: 0, threshold, status: 'all_clear' };
    }

    const storeLines = slowStores.map(
      (s) => `- ${s.store_name}: avg ${Math.round(s.avg_prep_time)}min (p90: ${Math.round(s.p90_prep_time)}min, ${s.sample_count} orders)`,
    );

    const alertMessage =
      `Slow Kitchen Alert\n\n` +
      `${slowStores.length} store(s) above ${threshold}min avg prep time:\n` +
      storeLines.join('\n');

    let alertsSent = 0;
    if (alertPhone) {
      try {
        await this.whatsapp.sendText(alertPhone, alertMessage);
        alertsSent = 1;
        this.logger.log(`[slow_kitchen_alert] Alert sent to ${alertPhone}`);
      } catch (err: any) {
        this.logger.warn(`[slow_kitchen_alert] Failed to send alert to ${alertPhone}: ${err.message}`);
      }
    } else {
      this.logger.warn('[slow_kitchen_alert] No alert_phone configured, logging only');
    }

    this.logger.log(`[slow_kitchen_alert] ${slowStores.length} slow stores detected`);
    return {
      alertsSent,
      slowStores: slowStores.length,
      threshold,
      stores: slowStores.map((s) => ({ name: s.store_name, avgPrep: Math.round(s.avg_prep_time) })),
      status: alertPhone ? 'executed' : 'logged_only',
    };
  }

  private async executeCartRecovery(
    config: Record<string, any>,
    _triggerData: any,
  ): Promise<any> {
    const windowHours = config.abandonment_window_hours || 2;
    const maxNudges = config.max_nudges_per_run || 30;
    const discountCode = config.discount_code || 'COMEBACK10';

    // Query abandoned carts older than the abandonment window
    const { rows: abandonedCarts } = await this.pool.query(
      `SELECT id, phone_number, user_id, items, subtotal, total
       FROM whatsapp_orders
       WHERE status = 'cart'
         AND updated_at < NOW() - INTERVAL '1 hour' * $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [windowHours, maxNudges],
    );

    if (abandonedCarts.length === 0) {
      this.logger.log(`[cart_recovery] No abandoned carts older than ${windowHours}h`);
      return { nudgesSent: 0, cartsFound: 0, status: 'no_abandoned_carts' };
    }

    let sent = 0;
    for (const cart of abandonedCarts) {
      try {
        const items = cart.items || [];
        const itemSummary = items.length > 0
          ? items.slice(0, 3).map((i: any) => i.name || i.item_name || 'item').join(', ')
          : 'your items';
        const moreText = items.length > 3 ? ` and ${items.length - 3} more` : '';

        const message =
          `Hi! You left ${itemSummary}${moreText} in your cart on Mangwale. ` +
          `Complete your order now and use code ${discountCode} for a special discount! ` +
          `Total: Rs ${Math.round(cart.total || cart.subtotal || 0)}`;

        await this.whatsapp.sendText(cart.phone_number, message);
        sent++;
      } catch (err: any) {
        this.logger.warn(`[cart_recovery] Failed to nudge ${cart.phone_number}: ${err.message}`);
      }
    }

    this.logger.log(`[cart_recovery] Sent ${sent}/${abandonedCarts.length} nudges`);
    return { nudgesSent: sent, cartsFound: abandonedCarts.length, discountCode, status: 'executed' };
  }

  // ─── Public API Methods ───────────────────────────────────────

  async getAllActions(): Promise<AutoAction[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM auto_action_config ORDER BY action_name',
      );
      return result.rows.map(this.mapAction);
    } catch (error: any) {
      this.logger.error(`getAllActions failed: ${error.message}`);
      return [];
    }
  }

  async getAction(actionName: string): Promise<AutoAction | null> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM auto_action_config WHERE action_name = $1',
        [actionName],
      );
      return result.rows[0] ? this.mapAction(result.rows[0]) : null;
    } catch (error: any) {
      this.logger.error(`getAction failed: ${error.message}`);
      return null;
    }
  }

  async toggleAction(actionName: string): Promise<{ enabled: boolean } | null> {
    try {
      const result = await this.pool.query(
        `UPDATE auto_action_config SET enabled = NOT enabled WHERE action_name = $1 RETURNING enabled`,
        [actionName],
      );
      if (result.rows.length === 0) return null;
      return { enabled: result.rows[0].enabled };
    } catch (error: any) {
      this.logger.error(`toggleAction failed: ${error.message}`);
      return null;
    }
  }

  async updateActionConfig(
    actionName: string,
    newConfig: Record<string, any>,
  ): Promise<AutoAction | null> {
    try {
      const result = await this.pool.query(
        `UPDATE auto_action_config
         SET config = config || $1::jsonb
         WHERE action_name = $2
         RETURNING *`,
        [JSON.stringify(newConfig), actionName],
      );
      return result.rows[0] ? this.mapAction(result.rows[0]) : null;
    } catch (error: any) {
      this.logger.error(`updateActionConfig failed: ${error.message}`);
      return null;
    }
  }

  async getActionHistory(actionName: string, limit: number = 20): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM auto_action_history WHERE action_name = $1 ORDER BY triggered_at DESC LIMIT $2`,
        [actionName, limit],
      );
      return result.rows;
    } catch (error: any) {
      this.logger.error(`getActionHistory failed: ${error.message}`);
      return [];
    }
  }

  private async recordExecution(
    actionName: string,
    triggerSource: string,
    result: any,
    itemsAffected: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE auto_action_config
         SET last_triggered_at = NOW(), trigger_count = trigger_count + 1
         WHERE action_name = $1`,
        [actionName],
      );

      await this.pool.query(
        `INSERT INTO auto_action_history (action_name, trigger_source, result, items_affected)
         VALUES ($1, $2, $3, $4)`,
        [actionName, triggerSource, JSON.stringify(result), itemsAffected],
      );
    } catch (err: any) {
      this.logger.error(`Failed to record action execution: ${err.message}`);
    }
  }

  private mapAction(row: any): AutoAction {
    return {
      actionName: row.action_name,
      enabled: row.enabled,
      config: row.config || {},
      lastTriggeredAt: row.last_triggered_at,
      triggerCount: row.trigger_count || 0,
      createdAt: row.created_at,
    };
  }
}
