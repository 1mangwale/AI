import * as crypto from 'crypto';
import { OrderEventsWebhookController } from './order-events-webhook.controller';

describe('OrderEventsWebhookController', () => {
  let controller: OrderEventsWebhookController;
  let orchestrationService: Record<string, jest.Mock>;

  const WEBHOOK_SECRET = 'test_webhook_secret';
  const RAZORPAY_SECRET = 'rzp_webhook_secret_test';

  beforeEach(() => {
    orchestrationService = {
      onPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
      onRiderLocationUpdate: jest.fn().mockResolvedValue(undefined),
      assignRider: jest.fn().mockResolvedValue(undefined),
      startRiderSearch: jest.fn().mockResolvedValue(undefined),
      onVendorResponse: jest.fn().mockResolvedValue(undefined),
      handleOrderPickedUp: jest.fn().mockResolvedValue(undefined),
      handleOrderDelivered: jest.fn().mockResolvedValue(undefined),
      handleRiderReachedPickup: jest.fn().mockResolvedValue(undefined),
      handleRiderReachedDelivery: jest.fn().mockResolvedValue(undefined),
    };

    const configService = {
      get: (key: string, defaultVal?: string) => {
        const map: Record<string, string> = {
          ORDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
          RAZORPAY_WEBHOOK_SECRET: RAZORPAY_SECRET,
        };
        return map[key] ?? defaultVal;
      },
    };

    const securityAlerts = {
      logSecurityEvent: jest.fn().mockResolvedValue(undefined),
      reportAnomaly: jest.fn().mockResolvedValue(undefined),
      paymentWebhookSignatureFailure: jest.fn(),
    };

    // Direct instantiation to avoid NestJS module resolution of all transitive deps
    controller = new OrderEventsWebhookController(
      configService as any,
      orchestrationService as any,
      securityAlerts as any,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // Helpers
  function signRazorpay(body: object): string {
    return crypto
      .createHmac('sha256', RAZORPAY_SECRET)
      .update(JSON.stringify(body))
      .digest('hex');
  }

  function makePaymentPayload(paymentId = 'pay_test123', orderId = '999') {
    return {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 15000, // ₹150 in paise
            method: 'upi',
            notes: { mangwale_order_id: orderId },
          },
        },
      },
    };
  }

  // ─── Payment Webhook ───────────────────────────────────────
  describe('handlePaymentWebhook', () => {
    it('should process valid payment with correct signature', async () => {
      const payload = makePaymentPayload();
      const sig = signRazorpay(payload);

      const result = await controller.handlePaymentWebhook(payload as any, sig);
      expect(result.status).toBe('processed');
      expect(orchestrationService.onPaymentConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 999,
          paymentId: 'pay_test123',
          paymentMethod: 'online',
          amount: 150,
        }),
      );
    });

    it('should reject payment with invalid signature', async () => {
      const payload = makePaymentPayload();
      await expect(
        controller.handlePaymentWebhook(payload as any, 'invalid_sig'),
      ).rejects.toThrow('Invalid signature');
    });

    it('should reject payment with empty signature', async () => {
      const payload = makePaymentPayload();
      await expect(
        controller.handlePaymentWebhook(payload as any, ''),
      ).rejects.toThrow('Invalid signature');
    });

    it('should be idempotent — skip duplicate payment IDs', async () => {
      const payload = makePaymentPayload('pay_dup_001');
      const sig = signRazorpay(payload);

      const r1 = await controller.handlePaymentWebhook(payload as any, sig);
      expect(r1.status).toBe('processed');

      const r2 = await controller.handlePaymentWebhook(payload as any, sig);
      expect(r2.status).toBe('duplicate');

      // onPaymentConfirmed should only be called once
      expect(orchestrationService.onPaymentConfirmed).toHaveBeenCalledTimes(1);
    });

    it('should ignore non-captured events', async () => {
      const payload = { event: 'payment.failed', payload: { payment: { entity: {} } } };
      const sig = signRazorpay(payload);

      const result = await controller.handlePaymentWebhook(payload as any, sig);
      expect(result.status).toBe('ignored');
    });

    it('should ignore payment missing mangwale_order_id', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: 'pay_no_order', amount: 5000, method: 'card', notes: {} },
          },
        },
      };
      const sig = signRazorpay(payload);

      const result = await controller.handlePaymentWebhook(payload as any, sig);
      expect(result.status).toBe('ignored');
    });
  });

  // ─── Tracking Webhook ──────────────────────────────────────
  describe('handleTrackingWebhook', () => {
    it('should reject invalid webhook secret', async () => {
      await expect(
        controller.handleTrackingWebhook(
          { event: 'status.changed', data: { status: 'picked_up' }, order_id: '100' } as any,
          'wrong_secret',
        ),
      ).rejects.toThrow('Invalid webhook secret');
    });

    it('should process status change with valid secret', async () => {
      const result = await controller.handleTrackingWebhook(
        { event: 'status.changed', data: { status: 'picked_up' }, order_id: '100' } as any,
        WEBHOOK_SECRET,
      );
      expect(result.status).toBe('processed');
      expect(orchestrationService.handleOrderPickedUp).toHaveBeenCalledWith(100);
    });

    it('should be idempotent for tracking events', async () => {
      const payload = { event: 'status.changed', data: { status: 'delivered' }, order_id: '200' };

      await controller.handleTrackingWebhook(payload as any, WEBHOOK_SECRET);
      const r2 = await controller.handleTrackingWebhook(payload as any, WEBHOOK_SECRET);

      expect(r2.status).toBe('duplicate');
      expect(orchestrationService.handleOrderDelivered).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Nerve Callback ────────────────────────────────────────
  describe('handleNerveCallback', () => {
    it('should reject callback without webhook secret', async () => {
      await expect(
        controller.handleNerveCallback(
          { event: 'completed', order_id: 100, vendor_id: 5, dtmf_digits: '120' } as any,
          '' as any,
        ),
      ).rejects.toThrow('Invalid webhook secret');
    });

    it('should process vendor accept with valid secret', async () => {
      const result = await controller.handleNerveCallback(
        { event: 'completed', order_id: 100, vendor_id: 5, dtmf_digits: '120' } as any,
        WEBHOOK_SECRET,
      );
      expect(result.status).toBe('processed');
      expect(orchestrationService.onVendorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 100,
          vendorId: 5,
          accepted: true,
        }),
      );
    });
  });

  // ─── PHP Webhook ───────────────────────────────────────────
  describe('handlePhpOrderWebhook', () => {
    it('should reject invalid secret', async () => {
      await expect(
        controller.handlePhpOrderWebhook(
          { event: 'order.payment', order: { id: 1, status: 'confirmed' } } as any,
          'bad_secret',
        ),
      ).rejects.toThrow('Invalid webhook secret');
    });

    it('should process confirmed payment', async () => {
      const result = await controller.handlePhpOrderWebhook(
        {
          event: 'order.payment',
          order: { id: 42, status: 'confirmed', payment_method: 'cod', total_amount: 200 },
        } as any,
        WEBHOOK_SECRET,
      );
      expect(result.status).toBe('processed');
      expect(orchestrationService.onPaymentConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 42, paymentMethod: 'cod', amount: 200 }),
      );
    });
  });
});
