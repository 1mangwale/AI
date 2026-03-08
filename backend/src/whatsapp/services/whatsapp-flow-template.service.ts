import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WhatsAppInteractiveMessage,
  WhatsAppInteractiveHeader,
  WhatsAppInteractiveBody,
  WhatsAppInteractiveFooter,
  WhatsAppButton,
  WhatsAppButtonAction,
  WhatsAppListAction,
  WhatsAppListSection,
  WhatsAppListRow,
  OrderTrackingData,
  ReturnRequestData,
  FeedbackData,
  ReorderData,
  RETURN_REASONS,
} from '../interfaces/flow-templates.interfaces';

/**
 * WhatsApp Flow Template Service
 *
 * Builds WhatsApp Cloud API interactive messages for common customer flows:
 * - Order Tracking: Status updates with action buttons
 * - Return Requests: Item selection with return reason list
 * - Feedback: Star rating collection after delivery
 * - Reorder: Quick reorder from previous order items
 *
 * These templates follow the WhatsApp Cloud API interactive message format:
 * - Button messages: Up to 3 reply buttons
 * - List messages: Sections with rows (up to 10 items)
 *
 * All messages respect WhatsApp character limits:
 * - Header text: 60 chars
 * - Body text: 1024 chars
 * - Footer text: 60 chars
 * - Button title: 20 chars
 * - List row title: 24 chars
 * - List row description: 72 chars
 */
@Injectable()
export class WhatsAppFlowTemplateService {
  private readonly logger = new Logger(WhatsAppFlowTemplateService.name);
  private readonly brandName: string;

  constructor(private readonly configService: ConfigService) {
    this.brandName = this.configService.get<string>('BRAND_NAME') || 'Mangwale';
  }

  // ============================================
  // ORDER TRACKING FLOW
  // ============================================

  /**
   * Build an order tracking interactive message with status and action buttons.
   * Buttons: Track Live, Contact Support, Rate Order (shown based on status)
   */
  getOrderTrackingFlow(data: OrderTrackingData): WhatsAppInteractiveMessage {
    const { orderId, status, eta, storeName, riderName, items } = data;

    // Build status message body
    const statusEmoji = this.getStatusEmoji(status);
    let bodyText = `${statusEmoji} *Order #${orderId}*\n`;
    bodyText += `Status: *${this.formatStatus(status)}*\n`;

    if (storeName) {
      bodyText += `Store: ${storeName}\n`;
    }

    if (riderName) {
      bodyText += `Rider: ${riderName}\n`;
    }

    if (eta) {
      bodyText += `ETA: ${eta}\n`;
    }

    if (items && items.length > 0) {
      bodyText += '\nItems:\n';
      for (const item of items.slice(0, 5)) {
        bodyText += `- ${item.name} x${item.qty}\n`;
      }
      if (items.length > 5) {
        bodyText += `...and ${items.length - 5} more items\n`;
      }
    }

    // Truncate body to WhatsApp limit
    bodyText = this.truncate(bodyText, 1024);

    // Build buttons based on order status
    const buttons: WhatsAppButton[] = [];

    if (['confirmed', 'preparing', 'picked_up', 'in_transit', 'out_for_delivery'].includes(status)) {
      buttons.push({
        type: 'reply',
        reply: { id: `track_live_${orderId}`, title: 'Track Live' },
      });
    }

    buttons.push({
      type: 'reply',
      reply: { id: `support_${orderId}`, title: 'Contact Support' },
    });

    if (status === 'delivered') {
      buttons.push({
        type: 'reply',
        reply: { id: `rate_${orderId}`, title: 'Rate Order' },
      });
    }

    // Max 3 buttons
    const limitedButtons = buttons.slice(0, 3);

    return this.buildInteractiveMessage(
      'button',
      { type: 'text', text: this.truncate(`Order Update`, 60) },
      { text: bodyText },
      { text: this.truncate(`${this.brandName} - Order Tracking`, 60) },
      { buttons: limitedButtons },
    );
  }

  // ============================================
  // RETURN REQUEST FLOW
  // ============================================

  /**
   * Build a return request interactive message with item selection and reason list.
   * Uses list message type with sections for items and reasons.
   */
  getReturnRequestFlow(data: ReturnRequestData): WhatsAppInteractiveMessage {
    const { orderId, items, storeName } = data;

    let bodyText = `*Return Request - Order #${orderId}*\n\n`;
    bodyText += `Select the item(s) you want to return and the reason.\n`;
    if (storeName) {
      bodyText += `Store: ${storeName}\n`;
    }

    bodyText = this.truncate(bodyText, 1024);

    // Build sections
    const sections: WhatsAppListSection[] = [];

    // Section 1: Items to return
    const itemRows: WhatsAppListRow[] = items.slice(0, 7).map((item) => ({
      id: `return_item_${orderId}_${item.id}`,
      title: this.truncate(item.name, 24),
      description: this.truncate(
        `Qty: ${item.quantity} | Rs ${item.price.toFixed(2)}`,
        72,
      ),
    }));

    sections.push(
      this.buildListSection('Select Item', itemRows),
    );

    // Section 2: Return reasons
    const reasonRows: WhatsAppListRow[] = Object.entries(RETURN_REASONS).map(
      ([id, description]) => ({
        id: `return_reason_${orderId}_${id}`,
        title: this.truncate(description, 24),
        description: this.truncate(`Select this reason`, 72),
      }),
    );

    sections.push(
      this.buildListSection('Return Reason', reasonRows),
    );

    return this.buildInteractiveMessage(
      'list',
      { type: 'text', text: this.truncate('Return Request', 60) },
      { text: bodyText },
      { text: this.truncate(`${this.brandName} - Returns`, 60) },
      { button: 'Select Item & Reason', sections },
    );
  }

  // ============================================
  // FEEDBACK FLOW
  // ============================================

  /**
   * Build a feedback interactive message with rating buttons.
   * Uses button message with star rating options.
   */
  getFeedbackFlow(data: FeedbackData): WhatsAppInteractiveMessage {
    const { orderId, storeName, deliveryTime } = data;

    let bodyText = `*How was your order from ${storeName}?*\n\n`;
    bodyText += `Order #${orderId}\n`;

    if (deliveryTime) {
      bodyText += `Delivered in: ${deliveryTime}\n`;
    }

    bodyText += `\nPlease rate your experience:`;
    bodyText = this.truncate(bodyText, 1024);

    const buttons: WhatsAppButton[] = [
      {
        type: 'reply',
        reply: {
          id: `feedback_${orderId}_good`,
          title: 'Great!',
        },
      },
      {
        type: 'reply',
        reply: {
          id: `feedback_${orderId}_ok`,
          title: 'It was okay',
        },
      },
      {
        type: 'reply',
        reply: {
          id: `feedback_${orderId}_bad`,
          title: 'Not satisfied',
        },
      },
    ];

    return this.buildInteractiveMessage(
      'button',
      { type: 'text', text: this.truncate('Rate Your Order', 60) },
      { text: bodyText },
      { text: this.truncate(`${this.brandName} - Feedback`, 60) },
      { buttons },
    );
  }

  // ============================================
  // REORDER FLOW
  // ============================================

  /**
   * Build a reorder interactive message showing previous order items.
   * Uses list message for item selection with quick reorder option.
   */
  getReorderFlow(data: ReorderData): WhatsAppInteractiveMessage | { flow: any; body: string } {
    const { lastOrder } = data;

    // If WA_FLOW_REORDER_ID is set, use WhatsApp Flow CTA instead of list message
    const reorderFlowId = this.configService.get<string>('WA_FLOW_REORDER_ID');
    if (reorderFlowId) {
      return {
        flow: {
          flowId: reorderFlowId,
          flowType: 'quick_reorder',
          ctaText: 'Quick Reorder',
          body: `Reorder from ${lastOrder.storeName} — ${lastOrder.items.length} items, Rs ${lastOrder.total.toFixed(2)}`,
        },
        body: `Tap below to quickly reorder from ${lastOrder.storeName}`,
      };
    }

    // Fallback: standard list-based reorder
    let bodyText = `*Reorder from ${lastOrder.storeName}*\n\n`;
    bodyText += `Your last order (#${lastOrder.id}):\n`;

    for (const item of lastOrder.items.slice(0, 5)) {
      bodyText += `- ${item.name} x${item.quantity} - Rs ${item.price.toFixed(2)}\n`;
    }

    if (lastOrder.items.length > 5) {
      bodyText += `...and ${lastOrder.items.length - 5} more items\n`;
    }

    bodyText += `\nTotal: Rs ${lastOrder.total.toFixed(2)}`;
    bodyText += `\nOrdered: ${this.formatDate(lastOrder.orderedAt)}`;
    bodyText = this.truncate(bodyText, 1024);

    // Build sections
    const sections: WhatsAppListSection[] = [];

    // Section 1: Quick actions
    const actionRows: WhatsAppListRow[] = [
      {
        id: `reorder_all_${lastOrder.id}`,
        title: 'Reorder All Items',
        description: this.truncate(
          `${lastOrder.items.length} items | Rs ${lastOrder.total.toFixed(2)}`,
          72,
        ),
      },
    ];

    sections.push(
      this.buildListSection('Quick Reorder', actionRows),
    );

    // Section 2: Individual items to add
    const itemRows: WhatsAppListRow[] = lastOrder.items.slice(0, 9).map((item) => ({
      id: `reorder_item_${lastOrder.id}_${item.id}`,
      title: this.truncate(item.name, 24),
      description: this.truncate(
        `Rs ${item.price.toFixed(2)} x${item.quantity}`,
        72,
      ),
    }));

    sections.push(
      this.buildListSection('Select Items', itemRows),
    );

    return this.buildInteractiveMessage(
      'list',
      { type: 'text', text: this.truncate('Quick Reorder', 60) },
      { text: bodyText },
      { text: this.truncate(`${this.brandName} - Reorder`, 60) },
      { button: 'View Items', sections },
    );
  }

  // ============================================
  // MESSAGE BUILDERS
  // ============================================

  /**
   * Build a WhatsApp interactive message of the specified type.
   * Handles both button and list message formats.
   */
  buildInteractiveMessage(
    type: 'button' | 'list',
    header: WhatsAppInteractiveHeader | null,
    body: WhatsAppInteractiveBody,
    footer: WhatsAppInteractiveFooter | null,
    action: WhatsAppButtonAction | WhatsAppListAction,
  ): WhatsAppInteractiveMessage {
    const message: WhatsAppInteractiveMessage = {
      type,
      body,
      action,
    };

    if (header) {
      message.header = header;
    }

    if (footer) {
      message.footer = footer;
    }

    return message;
  }

  /**
   * Build a list section with title and rows.
   * Enforces WhatsApp character limits on titles and descriptions.
   */
  buildListSection(title: string, rows: WhatsAppListRow[]): WhatsAppListSection {
    return {
      title: this.truncate(title, 24),
      rows: rows.map((row) => ({
        id: row.id.slice(0, 200), // Max 200 chars for ID
        title: this.truncate(row.title, 24),
        description: row.description
          ? this.truncate(row.description, 72)
          : undefined,
      })),
    };
  }

  // ============================================
  // FORMAT HELPERS
  // ============================================

  /**
   * Get a status emoji for the order status.
   */
  private getStatusEmoji(status: string): string {
    const emojiMap: Record<string, string> = {
      pending: '🕐',
      confirmed: '✅',
      preparing: '👨‍🍳',
      ready: '📦',
      picked_up: '🏍️',
      in_transit: '🚴',
      out_for_delivery: '🛵',
      delivered: '🎉',
      cancelled: '❌',
      refunded: '💰',
    };

    return emojiMap[status] || '📋';
  }

  /**
   * Format a status string for display.
   */
  private formatStatus(status: string): string {
    const statusMap: Record<string, string> = {
      pending: 'Pending',
      confirmed: 'Confirmed',
      preparing: 'Being Prepared',
      ready: 'Ready for Pickup',
      picked_up: 'Picked Up',
      in_transit: 'In Transit',
      out_for_delivery: 'Out for Delivery',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
    };

    return statusMap[status] || status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
  }

  /**
   * Format a date string for display.
   */
  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Truncate a string to a maximum length, adding ellipsis if needed.
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}
