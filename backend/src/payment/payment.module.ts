import { Module, forwardRef } from '@nestjs/common';
import { PaymentWebhookController } from './payment-webhook.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { FlowEngineModule } from '../flow-engine/flow-engine.module';

/**
 * Payment Module
 *
 * Handles payment webhooks (Razorpay) and UPI deep link generation.
 * Sends WhatsApp notifications on payment capture/failure/refund.
 * Bridges webhook events to the flow engine for order state transitions.
 */
@Module({
  imports: [
    forwardRef(() => WhatsAppModule),
    forwardRef(() => FlowEngineModule),
  ],
  controllers: [PaymentWebhookController],
})
export class PaymentModule {}
