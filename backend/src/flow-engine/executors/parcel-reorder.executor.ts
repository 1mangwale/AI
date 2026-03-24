import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpParcelService } from '../../php-integration/services/parcel.service';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { SessionService } from '../../session/session.service';

/**
 * Parcel Reorder Executor
 *
 * Fetches the user's last parcel order and populates context for one-tap reorder.
 * Also manages saved recipients for quick selection.
 *
 * Actions:
 *   fetch_last_parcel — Load last parcel order into context
 *   get_saved_recipients — Return saved recipients for quick selection
 *   save_recipient — Save recipient after successful order
 *
 * Events:
 *   found → last order loaded, show summary
 *   no_history → no previous parcel orders
 *   error → API failure
 *   recipients_found → saved recipients available
 *   no_recipients → no saved recipients
 *   recipient_saved → recipient saved successfully
 */
@Injectable()
export class ParcelReorderExecutor implements ActionExecutor {
  readonly name = 'parcel_reorder';
  private readonly logger = new Logger(ParcelReorderExecutor.name);

  constructor(
    private readonly parcelService: PhpParcelService,
    private readonly sessionService: SessionService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;

    try {
      switch (action) {
        case 'fetch_last_parcel':
          return this.fetchLastParcel(context);
        case 'get_saved_recipients':
          return this.getSavedRecipients(context);
        case 'save_recipient':
          return this.saveRecipient(context);
        default:
          this.logger.warn(`Unknown parcel_reorder action: ${action}`);
          return { success: true, event: 'skip' };
      }
    } catch (error) {
      this.logger.error(`Parcel reorder error: ${error.message}`);
      return { success: false, event: 'error', output: { error: error.message } };
    }
  }

  /**
   * Fetch user's last parcel order and populate context for reorder
   */
  private async fetchLastParcel(context: FlowContext): Promise<ActionExecutionResult> {
    const authToken = context.data?.auth_token;

    if (!authToken) {
      this.logger.warn('No auth_token — cannot fetch order history');
      return { success: false, event: 'no_history' };
    }

    const lastOrder = await this.parcelService.getLastParcelOrder(authToken);

    if (!lastOrder) {
      this.logger.log('No previous parcel orders found');
      return { success: false, event: 'no_history' };
    }

    // Populate context with all data needed for reorder
    // Pickup address
    context.data.pickup_address = lastOrder.pickupAddress;
    context.data.pickup_latitude = lastOrder.pickupAddress.latitude;
    context.data.pickup_longitude = lastOrder.pickupAddress.longitude;
    context.data.pickup_location_text = lastOrder.pickupAddress.address;

    // Delivery address
    context.data.delivery_address = lastOrder.deliveryAddress;
    context.data.delivery_latitude = lastOrder.deliveryAddress.latitude;
    context.data.delivery_longitude = lastOrder.deliveryAddress.longitude;
    context.data.delivery_location_text = lastOrder.deliveryAddress.address;
    context.data.delivery_zone_id = lastOrder.deliveryAddress.zone_id;

    // Recipient
    context.data.recipient_details = {
      name: lastOrder.recipientName,
      phone: lastOrder.recipientPhone,
    };

    // Vehicle & payment
    context.data.parcel_category_id = lastOrder.vehicleId;
    context.data.payment_method = lastOrder.paymentMethod;
    context.data.reorder_distance = lastOrder.distance;
    context.data.reorder_order_id = lastOrder.orderId;
    context.data.reorder_amount = lastOrder.orderAmount;

    // Format summary for display
    const pickupShort = this.shortenAddress(lastOrder.pickupAddress.address);
    const deliveryShort = this.shortenAddress(lastOrder.deliveryAddress.address);
    const recipientLine = lastOrder.recipientName
      ? `👤 ${lastOrder.recipientName} (${lastOrder.recipientPhone})`
      : '';
    const paymentLabel = lastOrder.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : 'Digital Payment';

    context.data._reorder_summary = {
      pickup: pickupShort,
      delivery: deliveryShort,
      recipient: recipientLine,
      payment: paymentLabel,
      lastOrderId: lastOrder.orderId,
      lastAmount: lastOrder.orderAmount,
    };

    this.logger.log(`✅ Reorder data loaded: #${lastOrder.orderId} — ${pickupShort} → ${deliveryShort}`);

    return {
      success: true,
      event: 'found',
      output: context.data._reorder_summary,
    };
  }

  /**
   * Get saved recipients from session for quick selection
   */
  private async getSavedRecipients(context: FlowContext): Promise<ActionExecutionResult> {
    const sessionId = context._system?.sessionId;
    if (!sessionId) {
      return { success: true, event: 'no_recipients', output: { recipients: [] } };
    }

    // Check flow context first (injected at flow start from session), then fall back to session
    let savedRecipients = context.data._saved_recipients_from_session;

    if (!savedRecipients || !Array.isArray(savedRecipients) || savedRecipients.length === 0) {
      // Fall back to reading session directly (invalidate cache to get fresh data)
      if (sessionId) {
        this.sessionService.invalidateCache(sessionId);
        const session = await this.sessionService.getSession(sessionId);
        savedRecipients = session?.data?.saved_recipients;
      }
    }

    this.logger.log(`📋 getSavedRecipients: ${savedRecipients?.length || 0} recipients found`);

    if (!savedRecipients || !Array.isArray(savedRecipients) || savedRecipients.length === 0) {
      return { success: true, event: 'no_recipients', output: { recipients: [] } };
    }

    // Max 5 recipients, most recent first — pre-format for button rendering
    const recipients = savedRecipients.slice(0, 5);
    context.data._saved_recipients = recipients;
    context.data._saved_recipient_buttons = recipients.map(r => ({
      label: `${r.name} - ${r.phone}`,
      value: `saved_recipient:${r.name}:${r.phone}`,
    }));

    this.logger.log(`📋 Found ${recipients.length} saved recipients`);

    return {
      success: true,
      event: 'recipients_found',
      output: { recipients },
    };
  }

  /**
   * Save recipient after successful order for future quick selection
   */
  private async saveRecipient(context: FlowContext): Promise<ActionExecutionResult> {
    const sessionId = context._system?.sessionId;
    const recipient = context.data.recipient_details;

    if (!sessionId || !recipient?.name || !recipient?.phone) {
      return { success: true, event: 'skip' };
    }

    const session = await this.sessionService.getSession(sessionId);
    let savedRecipients: Array<{ name: string; phone: string }> = session?.data?.saved_recipients || [];

    // Remove duplicate (same phone number)
    savedRecipients = savedRecipients.filter(r => r.phone !== recipient.phone);

    // Add new recipient at the beginning
    savedRecipients.unshift({ name: recipient.name, phone: recipient.phone });

    // Keep max 5
    savedRecipients = savedRecipients.slice(0, 5);

    await this.sessionService.setData(sessionId, 'saved_recipients', savedRecipients);

    this.logger.log(`💾 Saved recipient: ${recipient.name} (${recipient.phone}) — total: ${savedRecipients.length}`);

    return {
      success: true,
      event: 'recipient_saved',
      output: { saved: true, total: savedRecipients.length },
    };
  }

  /**
   * Shorten address to ~50 chars for display
   */
  private shortenAddress(address: string): string {
    if (!address) return 'Unknown';
    if (address.length <= 50) return address;
    return address.substring(0, 47) + '...';
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
