import { Module, forwardRef } from '@nestjs/common';
import { PaymentWebhookController } from './payment-webhook.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

/**
 * Payment Module
 *
 * Handles payment webhooks (Razorpay) and UPI deep link generation.
 * Sends WhatsApp notifications on payment capture/failure/refund.
 */
@Module({
  imports: [forwardRef(() => WhatsAppModule)],
  controllers: [PaymentWebhookController],
})
export class PaymentModule {}
