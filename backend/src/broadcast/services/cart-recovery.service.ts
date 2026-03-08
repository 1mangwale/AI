import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Inject } from '@nestjs/common';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';

interface AbandonedCart {
  phone: string;
  cartItems: any[];
  cartValue: number;
  storeName: string;
  lastActivity: number; // epoch ms
}

export interface CartRecoveryRecord {
  id: string;
  phone: string;
  cartSnapshot: any;
  cartValue: number;
  storeName: string;
  nudgeCount: number;
  lastNudgeAt: Date | null;
  recovered: boolean;
  recoveredOrderId: string | null;
  createdAt: Date;
}

@Injectable()
export class CartRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(CartRecoveryService.name);
  private pool: Pool;

  // Nudge timing: minutes after cart abandonment
  private readonly NUDGE_DELAYS_MIN = [30, 120, 1440]; // 30min, 2hr, 24hr
  private readonly MAX_NUDGES = 3;
  private readonly ABANDONMENT_THRESHOLD_MIN = 30;
  private readonly RATE_LIMIT_MS = 100; // 10 msgs/sec

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly whatsappService?: WhatsAppCloudService,
  ) {}

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS cart_recovery_tracking (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) NOT NULL,
          cart_snapshot JSONB,
          cart_value DECIMAL(10,2) DEFAULT 0,
          store_name VARCHAR(255),
          nudge_count INTEGER DEFAULT 0,
          last_nudge_at TIMESTAMP,
          recovered BOOLEAN DEFAULT false,
          recovered_order_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT NOW(),
          expired_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cart_recovery_phone ON cart_recovery_tracking(phone);
        CREATE INDEX IF NOT EXISTS idx_cart_recovery_pending ON cart_recovery_tracking(recovered, nudge_count);
        CREATE INDEX IF NOT EXISTS idx_cart_recovery_created ON cart_recovery_tracking(created_at DESC);
      `);
      client.release();
      this.logger.log('CartRecoveryService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Scan Redis sessions for abandoned carts (items sitting >30 min without order).
   * Called by scheduler every 30 minutes.
   */
  async detectAbandonedCarts(): Promise<{ detected: number; skipped: number }> {
    const stats = { detected: 0, skipped: 0 };

    try {
      // Scan Redis for session keys
      const sessionKeys = await this.scanRedisKeys('session:*');
      const now = Date.now();
      const thresholdMs = this.ABANDONMENT_THRESHOLD_MIN * 60 * 1000;

      for (const key of sessionKeys) {
        try {
          const sessionData = await this.redis.get(key);
          if (!sessionData) continue;

          const session = JSON.parse(sessionData);
          const data = session.data || session;

          // Check if session has cart items
          const cartItems = data.cart_items || data.selected_items || [];
          if (!Array.isArray(cartItems) || cartItems.length === 0) continue;

          // Check if cart is old enough (last activity > threshold)
          const lastActivity = session.updatedAt || session.lastActivity || session.createdAt;
          const lastActivityMs = lastActivity ? new Date(lastActivity).getTime() : 0;

          if (!lastActivityMs || (now - lastActivityMs) < thresholdMs) {
            continue; // Cart is still active
          }

          // Check if session has a phone number
          const phone = data.phone || data._phone || key.replace('session:', '');
          if (!phone || phone.length < 10) continue;

          // Check if already tracked (avoid duplicates)
          const existing = await this.pool.query(
            `SELECT id FROM cart_recovery_tracking
             WHERE phone = $1 AND recovered = false AND created_at > NOW() - INTERVAL '48 hours'`,
            [phone],
          );
          if (existing.rows.length > 0) {
            stats.skipped++;
            continue;
          }

          // Calculate cart value
          const cartValue = cartItems.reduce((sum: number, item: any) => {
            const price = item.price || item.unit_price || 0;
            const qty = item.quantity || item.qty || 1;
            return sum + price * qty;
          }, 0);

          const storeName = cartItems[0]?.store_name || cartItems[0]?.storeName || data.store_name || 'Mangwale';

          // Insert tracking record
          await this.pool.query(
            `INSERT INTO cart_recovery_tracking (phone, cart_snapshot, cart_value, store_name)
             VALUES ($1, $2, $3, $4)`,
            [phone, JSON.stringify(cartItems), cartValue, storeName],
          );

          stats.detected++;
        } catch (err: any) {
          this.logger.debug(`Error processing session ${key}: ${err.message}`);
        }
      }

      this.logger.log(`Cart recovery scan: ${stats.detected} abandoned, ${stats.skipped} already tracked`);
      return stats;
    } catch (error: any) {
      this.logger.error(`detectAbandonedCarts failed: ${error.message}`);
      return stats;
    }
  }

  /**
   * Send pending recovery nudges based on timing rules.
   * Called by scheduler every 15 minutes.
   */
  async sendPendingNudges(): Promise<{ sent: number; failed: number }> {
    const stats = { sent: 0, failed: 0 };

    try {
      // Get pending recoveries (not recovered, under max nudges)
      const { rows } = await this.pool.query(
        `SELECT * FROM cart_recovery_tracking
         WHERE recovered = false
           AND nudge_count < $1
           AND (expired_at IS NULL OR expired_at > NOW())
           AND created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at ASC
         LIMIT 50`,
        [this.MAX_NUDGES],
      );

      const now = Date.now();

      for (const row of rows) {
        const record = this.mapRecord(row);
        const createdAtMs = record.createdAt.getTime();
        const nextNudgeDelay = this.NUDGE_DELAYS_MIN[record.nudgeCount] * 60 * 1000;

        // Check if enough time has passed for next nudge
        const referenceTime = record.lastNudgeAt?.getTime() || createdAtMs;
        if ((now - referenceTime) < nextNudgeDelay) continue;

        try {
          await this.sendNudge(record);
          stats.sent++;
          await this.delay(this.RATE_LIMIT_MS);
        } catch (err: any) {
          this.logger.error(`Failed nudge for ${record.phone}: ${err.message}`);
          stats.failed++;
        }
      }

      if (stats.sent > 0) {
        this.logger.log(`Cart recovery nudges: ${stats.sent} sent, ${stats.failed} failed`);
      }
      return stats;
    } catch (error: any) {
      this.logger.error(`sendPendingNudges failed: ${error.message}`);
      return stats;
    }
  }

  /**
   * Send a single recovery nudge via WhatsApp.
   */
  private async sendNudge(record: CartRecoveryRecord): Promise<void> {
    if (!this.whatsappService) {
      this.logger.warn('WhatsAppCloudService not available — skipping nudge');
      return;
    }

    const nudgeIndex = record.nudgeCount; // 0, 1, 2
    const cartItems = record.cartSnapshot || [];
    const itemNames = cartItems
      .slice(0, 3)
      .map((item: any) => item.name || item.item_name || 'item')
      .join(', ');
    const itemCount = cartItems.length;

    const messages = [
      // Nudge 1 (30 min): Friendly reminder
      `Hi! You left ${itemCount} item${itemCount > 1 ? 's' : ''} in your cart (${itemNames}). Complete your order now for quick delivery! 🛒`,
      // Nudge 2 (2 hr): Urgency
      `Your cart from ${record.storeName} is still waiting! Order now before items run out. Tap below to continue. ⏰`,
      // Nudge 3 (24 hr): Last chance
      `Last reminder! Your ${itemNames} cart (Rs ${record.cartValue}) will expire soon. Don't miss out! 🔔`,
    ];

    const message = messages[nudgeIndex] || messages[0];

    // Send as interactive button message
    await this.whatsappService.sendButtons(record.phone, {
      body: message,
      buttons: [
        { id: 'resume_cart', title: 'Complete Order' },
      ],
    });

    // Update tracking record
    await this.pool.query(
      `UPDATE cart_recovery_tracking
       SET nudge_count = nudge_count + 1, last_nudge_at = NOW()
       WHERE id = $1`,
      [record.id],
    );
  }

  /**
   * Mark a cart as recovered when user completes an order.
   * Called from OrderExecutor after successful order placement.
   */
  async markRecovered(phone: string, orderId: string): Promise<boolean> {
    try {
      const normalizedPhone = this.normalizePhone(phone);

      const result = await this.pool.query(
        `UPDATE cart_recovery_tracking
         SET recovered = true, recovered_order_id = $1
         WHERE phone = $2 AND recovered = false AND created_at > NOW() - INTERVAL '48 hours'
         RETURNING id`,
        [orderId, normalizedPhone],
      );

      if (result.rows.length > 0) {
        this.logger.log(`Cart recovery: ${normalizedPhone} recovered → order ${orderId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      this.logger.error(`markRecovered failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get recovery stats for admin dashboard.
   */
  async getRecoveryStats(days = 7): Promise<{
    totalAbandoned: number;
    totalNudgesSent: number;
    totalRecovered: number;
    recoveryRate: number;
    revenueRecovered: number;
    pendingRecoveries: number;
  }> {
    try {
      const { rows } = await this.pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(nudge_count) as total_nudges,
           COUNT(*) FILTER (WHERE recovered = true) as recovered,
           COALESCE(SUM(cart_value) FILTER (WHERE recovered = true), 0) as revenue_recovered,
           COUNT(*) FILTER (WHERE recovered = false AND nudge_count < $1) as pending
         FROM cart_recovery_tracking
         WHERE created_at > NOW() - INTERVAL '${days} days'`,
        [this.MAX_NUDGES],
      );

      const row = rows[0];
      const total = parseInt(row.total) || 0;
      const recovered = parseInt(row.recovered) || 0;

      return {
        totalAbandoned: total,
        totalNudgesSent: parseInt(row.total_nudges) || 0,
        totalRecovered: recovered,
        recoveryRate: total > 0 ? Math.round((recovered / total) * 100 * 10) / 10 : 0,
        revenueRecovered: parseFloat(row.revenue_recovered) || 0,
        pendingRecoveries: parseInt(row.pending) || 0,
      };
    } catch (error: any) {
      this.logger.error(`getRecoveryStats failed: ${error.message}`);
      return {
        totalAbandoned: 0,
        totalNudgesSent: 0,
        totalRecovered: 0,
        recoveryRate: 0,
        revenueRecovered: 0,
        pendingRecoveries: 0,
      };
    }
  }

  /**
   * Get pending recovery records for admin view.
   */
  async getPendingRecoveries(limit = 20): Promise<CartRecoveryRecord[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT * FROM cart_recovery_tracking
         WHERE recovered = false AND nudge_count < $1 AND created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at DESC
         LIMIT $2`,
        [this.MAX_NUDGES, limit],
      );
      return rows.map(this.mapRecord);
    } catch (error: any) {
      this.logger.error(`getPendingRecoveries failed: ${error.message}`);
      return [];
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async scanRedisKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  private normalizePhone(phone: string): string {
    const cleaned = phone.replace(/[^\d]/g, '');
    return cleaned.startsWith('91') ? cleaned : `91${cleaned}`;
  }

  private mapRecord(row: any): CartRecoveryRecord {
    return {
      id: row.id,
      phone: row.phone,
      cartSnapshot: typeof row.cart_snapshot === 'string' ? JSON.parse(row.cart_snapshot) : row.cart_snapshot,
      cartValue: parseFloat(row.cart_value) || 0,
      storeName: row.store_name,
      nudgeCount: row.nudge_count || 0,
      lastNudgeAt: row.last_nudge_at,
      recovered: row.recovered,
      recoveredOrderId: row.recovered_order_id,
      createdAt: row.created_at,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
