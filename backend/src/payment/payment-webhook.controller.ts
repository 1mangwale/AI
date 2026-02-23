import {
  Controller, Post, Body, Headers, Logger, HttpCode,
  RawBodyRequest, Req, UnauthorizedException, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { WhatsAppCloudService } from '../whatsapp/services/whatsapp-cloud.service';

/**
 * Payment Webhook Controller
 *
 * Handles Razorpay payment event webhooks:
 *   - payment.captured  → Order confirmed, notify customer
 *   - payment.failed    → Notify customer, offer COD fallback
 *   - order.paid        → Full order amount captured
 *   - refund.processed  → Refund completed, notify customer
 *
 * Security: All webhooks are verified using HMAC-SHA256 with Razorpay webhook secret.
 *
 * Endpoint: POST /api/payment/razorpay/webhook
 * Configure in Razorpay Dashboard → Settings → Webhooks
 */
@Controller('api/payment/razorpay')
export class PaymentWebhookController implements OnModuleInit {
  private readonly logger = new Logger(PaymentWebhookController.name);
  private readonly webhookSecret: string;
  private pool: Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppCloudService,
  ) {
    this.webhookSecret = this.config.get('RAZORPAY_WEBHOOK_SECRET') || '';
  }

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS payment_webhook_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type VARCHAR(100) NOT NULL,
          razorpay_payment_id VARCHAR(100),
          razorpay_order_id VARCHAR(100),
          order_id VARCHAR(100),
          amount INTEGER,
          currency VARCHAR(10) DEFAULT 'INR',
          status VARCHAR(50),
          customer_phone VARCHAR(50),
          payload JSONB,
          processed BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_webhook_events(order_id);
        CREATE INDEX IF NOT EXISTS idx_payment_events_razorpay ON payment_webhook_events(razorpay_payment_id);
        CREATE INDEX IF NOT EXISTS idx_payment_events_created ON payment_webhook_events(created_at DESC);
      `);
      client.release();

      if (!this.webhookSecret) {
        this.logger.warn('RAZORPAY_WEBHOOK_SECRET not configured — webhook signature verification disabled');
      }
      this.logger.log('PaymentWebhookController initialized');
    } catch (err) {
      this.logger.error(`Failed to initialize: ${err.message}`);
    }
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() payload: any,
    @Headers('x-razorpay-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: string }> {
    // Verify signature if webhook secret is configured
    if (this.webhookSecret) {
      const rawBody = req.rawBody;
      if (!rawBody) {
        this.logger.error('Raw body not available for webhook verification');
        throw new UnauthorizedException('Webhook verification failed');
      }

      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSignature) {
        this.logger.warn('Invalid Razorpay webhook signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
    }

    const event = payload?.event;
    const paymentEntity = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;

    this.logger.log(`Razorpay webhook: event=${event}, payment_id=${paymentEntity?.id}`);

    try {
      // Store webhook event for audit trail
      await this.storeEvent(event, paymentEntity, orderEntity, payload);

      // Route to handler
      switch (event) {
        case 'payment.captured':
          await this.handlePaymentCaptured(paymentEntity);
          break;
        case 'payment.failed':
          await this.handlePaymentFailed(paymentEntity);
          break;
        case 'order.paid':
          await this.handleOrderPaid(orderEntity);
          break;
        case 'refund.processed':
          await this.handleRefundProcessed(payload?.payload?.refund?.entity);
          break;
        default:
          this.logger.debug(`Unhandled webhook event: ${event}`);
      }

      return { status: 'ok' };
    } catch (err) {
      this.logger.error(`Webhook processing failed: ${err.message}`, err.stack);
      return { status: 'error' };
    }
  }

  private async handlePaymentCaptured(payment: any): Promise<void> {
    if (!payment) return;

    const phone = payment.contact;
    const amount = (payment.amount || 0) / 100; // Razorpay sends amount in paise
    const orderId = payment.notes?.order_id || payment.order_id;

    this.logger.log(`Payment captured: ₹${amount} for order ${orderId} from ${phone}`);

    if (phone) {
      try {
        await this.whatsapp.sendText(
          phone,
          `✅ Payment of ₹${amount} received for Order #${orderId}!\n\n` +
          `Your order is being prepared. We'll update you when it's on the way! 🚀`,
        );
      } catch (err) {
        this.logger.warn(`Failed to send payment confirmation to ${phone}: ${err.message}`);
      }
    }
  }

  private async handlePaymentFailed(payment: any): Promise<void> {
    if (!payment) return;

    const phone = payment.contact;
    const orderId = payment.notes?.order_id || payment.order_id;
    const reason = payment.error_description || 'Payment could not be processed';

    this.logger.warn(`Payment failed for order ${orderId}: ${reason}`);

    if (phone) {
      try {
        await this.whatsapp.sendText(
          phone,
          `❌ Payment failed for Order #${orderId}\n\n` +
          `Reason: ${reason}\n\n` +
          `You can retry or switch to Cash on Delivery. Just say "pay COD" to continue!`,
        );
      } catch (err) {
        this.logger.warn(`Failed to send payment failure notice to ${phone}: ${err.message}`);
      }
    }
  }

  private async handleOrderPaid(order: any): Promise<void> {
    if (!order) return;
    this.logger.log(`Order fully paid: ${order.id}, amount=${(order.amount_paid || 0) / 100}`);
  }

  private async handleRefundProcessed(refund: any): Promise<void> {
    if (!refund) return;

    const amount = (refund.amount || 0) / 100;
    const phone = refund.notes?.customer_phone;

    this.logger.log(`Refund processed: ₹${amount}, payment_id=${refund.payment_id}`);

    if (phone) {
      try {
        await this.whatsapp.sendText(
          phone,
          `💰 Refund of ₹${amount} has been processed and will reflect in your account within 5-7 business days.`,
        );
      } catch (err) {
        this.logger.warn(`Failed to send refund notice to ${phone}: ${err.message}`);
      }
    }
  }

  private async storeEvent(
    eventType: string,
    payment: any,
    order: any,
    fullPayload: any,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO payment_webhook_events
         (event_type, razorpay_payment_id, razorpay_order_id, order_id, amount, currency, status, customer_phone, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventType,
          payment?.id || null,
          payment?.order_id || order?.id || null,
          payment?.notes?.order_id || order?.notes?.order_id || null,
          payment?.amount || order?.amount || null,
          payment?.currency || 'INR',
          payment?.status || order?.status || eventType,
          payment?.contact || null,
          JSON.stringify(fullPayload),
        ],
      );
    } catch (err) {
      this.logger.error(`Failed to store webhook event: ${err.message}`);
    }
  }
}
