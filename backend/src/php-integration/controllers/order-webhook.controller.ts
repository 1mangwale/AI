import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { VendorNotificationService } from '../services/vendor-notification.service';
import { OrderDatabaseService } from '../services/order-database.service';
import { RiderApiService } from '../services/rider-api.service';

/**
 * Order Status Types from PHP Backend
 */
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'handover'
  | 'picked_up'
  | 'delivered'
  | 'canceled'
  | 'refunded'
  | 'failed';

/**
 * Order Webhook Payload from PHP Backend
 */
export interface OrderWebhookPayload {
  event: 'order.created' | 'order.status_changed' | 'order.assigned' | 'order.payment';
  
  order: {
    id: number;
    order_id: string; // Display ID like #MNG-12345
    status: OrderStatus;
    previous_status?: OrderStatus;
    order_amount: number;
    delivery_charge: number;
    total_amount: number;
    payment_method: 'cod' | 'online' | 'wallet';
    payment_status: 'unpaid' | 'paid' | 'refunded';
    order_type: 'delivery' | 'pickup';
    scheduled_at?: string;
    created_at: string;
    updated_at: string;
  };
  
  customer: {
    id: number;
    name: string;
    phone: string;
    email?: string;
  };
  
  vendor: {
    id: number;
    store_name: string;
    phone: string;
    email?: string;
    zone_wise_topic?: string;
  };
  
  delivery_man?: {
    id: number;
    name: string;
    phone: string;
  };
  
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    price: number;
    total: number;
  }>;
  
  delivery_address?: {
    address: string;
    latitude?: number;
    longitude?: number;
    contact_person_name?: string;
    contact_person_number?: string;
  };
  
  // Processing time set by vendor (in minutes)
  processing_time?: number;
  
  timestamp: string;
}

/**
 * Order Webhook Controller
 * 
 * Receives webhooks from PHP backend when:
 * 1. New order is created (after payment)
 * 2. Order status changes
 * 3. Delivery man assigned/changed
 * 4. Payment status changes
 * 
 * Triggers notifications to:
 * - Vendors (new order, order confirmed by customer, etc.)
 * - Customers (order confirmed, preparing, out for delivery, delivered)
 * - Delivery men (new delivery assigned, order ready for pickup)
 */
@Controller('webhook/order')
export class OrderWebhookController {
  private readonly logger = new Logger(OrderWebhookController.name);
  private readonly webhookSecret: string;
  private riderQuestService: any = null;
  private adAttributionService: any = null;
  private messageService: any = null;
  private proactiveMessagingService: any = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly vendorNotificationService: VendorNotificationService,
    private readonly orderDatabaseService: OrderDatabaseService,
    private readonly riderApiService: RiderApiService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.webhookSecret = this.configService.get<string>(
      'ORDER_WEBHOOK_SECRET',
      'mangwale_webhook_secret_2024'
    );

    // Resolve cross-module services lazily
    setTimeout(async () => {
      try {
        const { RiderQuestService } = await import('../../gamification/services/rider-quest.service');
        this.riderQuestService = this.moduleRef.get(RiderQuestService, { strict: false });
        if (this.riderQuestService) this.logger.log('RiderQuestService wired to order webhook');
      } catch { /* optional dependency */ }

      try {
        const { AdAttributionService } = await import('../../marketing/services/ad-attribution.service');
        this.adAttributionService = this.moduleRef.get(AdAttributionService, { strict: false });
        if (this.adAttributionService) this.logger.log('AdAttributionService wired to order webhook');
      } catch { /* optional dependency */ }

      try {
        const { MessageService } = await import('../../whatsapp/services/message.service');
        this.messageService = this.moduleRef.get(MessageService, { strict: false });
        if (this.messageService) this.logger.log('MessageService wired to order webhook');
      } catch { /* optional dependency */ }

      try {
        const { ProactiveMessagingService } = await import('../../broadcast/services/proactive-messaging.service');
        this.proactiveMessagingService = this.moduleRef.get(ProactiveMessagingService, { strict: false });
        if (this.proactiveMessagingService) this.logger.log('ProactiveMessagingService wired to order webhook');
      } catch { /* optional dependency */ }
    }, 2000);
  }

  /**
   * Main webhook endpoint for order events
   * POST /webhook/order
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleOrderWebhook(
    @Body() payload: OrderWebhookPayload,
    @Headers('x-webhook-secret') secret: string,
  ): Promise<{ success: boolean; message: string }> {
    // Validate webhook secret
    if (secret !== this.webhookSecret) {
      this.logger.warn(`⚠️ Invalid webhook secret received`);
      throw new UnauthorizedException('Invalid webhook secret');
    }

    this.logger.log(
      `📨 Order webhook received: ${payload.event} for order #${payload.order.id}`
    );

    try {
      // 🔄 ALWAYS update order cache for real-time access
      await this.updateOrderCache(payload);

      switch (payload.event) {
        case 'order.created':
          await this.handleNewOrder(payload);
          break;
          
        case 'order.status_changed':
          await this.handleStatusChange(payload);
          break;
          
        case 'order.assigned':
          await this.handleDeliveryAssignment(payload);
          break;
          
        case 'order.payment':
          await this.handlePaymentUpdate(payload);
          break;
          
        default:
          this.logger.warn(`Unknown event type: ${payload.event}`);
      }

      return { success: true, message: 'Webhook processed' };
    } catch (error) {
      this.logger.error(`❌ Webhook processing failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update order cache with webhook data (for fast lookups)
   */
  private async updateOrderCache(payload: OrderWebhookPayload): Promise<void> {
    try {
      await this.orderDatabaseService.updateCache(payload.order.id, {
        status: payload.order.status,
        storeName: payload.vendor?.store_name,
        totalAmount: payload.order.total_amount,
        paymentStatus: payload.order.payment_status,
        deliveryManId: payload.delivery_man?.id,
        deliveryManName: payload.delivery_man?.name,
        deliveryManPhone: payload.delivery_man?.phone,
        eta: payload.processing_time,
      });
    } catch (error) {
      this.logger.warn(`Failed to update order cache: ${error.message}`);
    }
  }

  /**
   * Handle new order creation
   * Triggered after payment is confirmed
   */
  private async handleNewOrder(payload: OrderWebhookPayload): Promise<void> {
    this.logger.log(`🆕 New order #${payload.order.id} - notifying vendor`);

    // Track UTM attribution if present in metadata
    await this.trackOrderAttribution(payload);

    // Safely handle items array
    const items = payload.items || [];
    
    // Prepare order notification payload
    const orderNotification = {
      orderId: payload.order.id,
      orderAmount: payload.order.total_amount,
      customerName: payload.customer?.name || 'Customer',
      customerPhone: payload.customer?.phone || '',
      itemsCount: items.length,
      itemsSummary: items.length > 0 
        ? items.map(i => `${i.quantity}x ${i.name}`).join(', ')
        : 'Order items',
      deliveryAddress: payload.delivery_address?.address,
      paymentMethod: payload.order.payment_method,
      scheduledAt: payload.order.scheduled_at,
      orderType: payload.order.order_type,
    };

    // Prepare vendor target
    const vendorTarget = {
      vendorId: payload.vendor.id,
      storeName: payload.vendor.store_name,
      vendorPhone: payload.vendor.phone,
      vendorEmail: payload.vendor.email,
      fcmTopics: payload.vendor.zone_wise_topic
        ? [payload.vendor.zone_wise_topic]
        : [],
    };

    // Send multi-channel notification
    const results = await this.vendorNotificationService.notifyVendorNewOrder(
      vendorTarget,
      orderNotification
    );

    this.logger.log(
      `✅ Vendor notification sent: ${JSON.stringify(results.map(r => ({
        channel: r.channel,
        success: r.success,
      })))}`
    );

    // Notify customer that order is being processed
    await this.notifyCustomerOrderReceived(payload);

    // Dispatch to Vega Rider API for rider assignment
    if (payload.order.order_type === 'delivery') {
      const dispatchResult = await this.riderApiService.dispatchOrder(payload);
      if (dispatchResult.success) {
        this.logger.log(`🚴 Order #${payload.order.id} dispatched to Rider API → ${dispatchResult.shipmentId}`);
      } else {
        this.logger.warn(`⚠️ Rider dispatch failed for order #${payload.order.id}: ${dispatchResult.message}`);
      }
    }

    // Track proactive message conversion
    await this.trackProactiveConversion(payload);
  }

  /**
   * Handle order status changes
   */
  private async handleStatusChange(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, vendor, delivery_man } = payload;
    
    this.logger.log(
      `🔄 Order #${order.id} status: ${order.previous_status} → ${order.status}`
    );

    // Notify based on new status
    switch (order.status) {
      case 'confirmed':
        // Vendor confirmed - notify customer
        await this.notifyCustomerOrderConfirmed(payload);
        break;
        
      case 'processing':
        // Vendor started preparing - notify customer with ETA
        await this.notifyCustomerOrderPreparing(payload);
        break;
        
      case 'handover':
        // Ready for pickup - notify delivery man
        if (delivery_man) {
          await this.notifyDeliveryManOrderReady(payload);
        }
        // Also notify customer
        await this.notifyCustomerOrderReady(payload);
        break;
        
      case 'picked_up':
        // Delivery man picked up - notify customer
        await this.notifyCustomerOrderPickedUp(payload);
        break;
        
      case 'delivered':
        // Order delivered - notify customer for feedback
        await this.notifyCustomerOrderDelivered(payload);
        // Wire rider quest progress on delivery
        await this.updateRiderQuestProgress(payload);
        break;
        
      case 'canceled':
        // Order canceled - notify all parties and cancel on Rider API
        await this.notifyOrderCanceled(payload);
        await this.riderApiService.cancelOrder(payload.order.id, 'Order cancelled');
        break;
    }
  }

  /**
   * Handle delivery man assignment
   */
  private async handleDeliveryAssignment(payload: OrderWebhookPayload): Promise<void> {
    if (!payload.delivery_man) return;

    this.logger.log(
      `🚴 Order #${payload.order.id} assigned to ${payload.delivery_man.name}`
    );

    // Notify delivery man about new assignment
    await this.notifyDeliveryManNewAssignment(payload);

    // Notify customer about delivery partner
    await this.notifyCustomerDeliveryAssigned(payload);
  }

  /**
   * Handle payment status updates
   */
  private async handlePaymentUpdate(payload: OrderWebhookPayload): Promise<void> {
    this.logger.log(
      `💳 Order #${payload.order.id} payment: ${payload.order.payment_status}`
    );

    if (payload.order.payment_status === 'paid') {
      // Payment confirmed - this triggers the order flow
      await this.handleNewOrder(payload);
    } else if (payload.order.payment_status === 'refunded') {
      // Refund processed - notify customer
      await this.notifyCustomerRefundProcessed(payload);
    }
  }

  // ========================================
  // Customer Notification Methods
  // ========================================

  private async notifyCustomerOrderReceived(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, vendor } = payload;
    this.logger.log(`📱 Notifying customer: Order received`);

    if (!this.messageService || !customer.phone) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `📦 *Order Received!*\n\n` +
        `Order ${order.order_id} placed with *${vendor.store_name}*.\n` +
        `💰 Total: ₹${order.total_amount}\n` +
        `💳 Payment: ${order.payment_method === 'cod' ? 'Cash on Delivery' : 'Paid Online'}\n\n` +
        `We're waiting for the restaurant to confirm your order.`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about order received: ${error.message}`);
    }
  }

  private async notifyCustomerOrderConfirmed(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, vendor } = payload;
    this.logger.log(`📱 Notifying customer: Order confirmed by ${vendor.store_name}`);

    if (!this.messageService || !customer.phone) return;

    try {
      const eta = payload.processing_time || 30;
      await this.messageService.sendTextMessage(customer.phone,
        `✅ *Order Confirmed!*\n\n` +
        `Order ${order.order_id} has been accepted by *${vendor.store_name}*.\n` +
        `⏱️ Estimated time: ${eta} minutes\n\n` +
        `We'll notify you when your order is being prepared!`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about confirmation: ${error.message}`);
    }
  }

  private async notifyCustomerOrderPreparing(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer } = payload;
    const eta = payload.processing_time || 30;
    this.logger.log(`📱 Notifying customer: Order preparing, ETA ${eta} mins`);

    if (!this.messageService || !customer.phone) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `👨‍🍳 *Your order is being prepared!*\n\n` +
        `Order ${order.order_id}\n` +
        `⏱️ Estimated ready in ${eta} minutes\n\n` +
        `We'll update you when it's ready for delivery!`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about preparation: ${error.message}`);
    }
  }

  private async notifyCustomerOrderReady(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, vendor } = payload;
    this.logger.log(`📱 Notifying customer: Order ready for pickup/delivery`);

    if (!this.messageService || !customer.phone) return;

    try {
      const message = order.order_type === 'pickup'
        ? `✅ *Your order is ready for pickup!*\n\n` +
          `Order ${order.order_id}\n` +
          `📍 Collect from: *${vendor.store_name}*\n\n` +
          `Please pick up at your earliest convenience.`
        : `✅ *Your order is ready!*\n\n` +
          `Order ${order.order_id}\n` +
          `A delivery partner will pick it up from *${vendor.store_name}* shortly.`;

      await this.messageService.sendTextMessage(customer.phone, message);
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about order ready: ${error.message}`);
    }
  }

  private async notifyCustomerOrderPickedUp(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, delivery_man } = payload;
    this.logger.log(`📱 Notifying customer: Order picked up by ${delivery_man?.name}`);

    if (!this.messageService || !customer.phone) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `🚴 *Your order is on the way!*\n\n` +
        `Order ${order.order_id}\n` +
        `${delivery_man?.name || 'Your delivery partner'} has picked up your order.\n\n` +
        `🔔 We'll let you know when it arrives!`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about pickup: ${error.message}`);
    }
  }

  private async notifyCustomerOrderDelivered(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer } = payload;
    this.logger.log(`📱 Notifying customer: Order delivered! Requesting feedback`);

    if (!this.messageService || !customer.phone) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `🎉 *Order Delivered!*\n\n` +
        `Order ${order.order_id} has been delivered.\n` +
        `💰 Total: ₹${order.total_amount}\n\n` +
        `How was your experience? Reply with:\n` +
        `⭐ 1-5 to rate\n\n` +
        `Thank you for ordering with Mangwale! 🙏`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about delivery: ${error.message}`);
    }
  }

  private async notifyCustomerDeliveryAssigned(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, delivery_man } = payload;
    this.logger.log(`📱 Notifying customer: Delivery partner assigned`);

    if (!this.messageService || !customer.phone || !delivery_man) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `🚴 *Delivery partner assigned!*\n\n` +
        `Order ${order.order_id}\n` +
        `${delivery_man.name} will deliver your order.\n` +
        `📞 Contact: ${delivery_man.phone}\n\n` +
        `We'll notify you once your order is picked up!`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about delivery assignment: ${error.message}`);
    }
  }

  private async notifyCustomerRefundProcessed(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer } = payload;
    this.logger.log(`📱 Notifying customer: Refund processed`);

    if (!this.messageService || !customer.phone) return;

    try {
      await this.messageService.sendTextMessage(customer.phone,
        `💸 *Refund Processed!*\n\n` +
        `Order ${order.order_id}\n` +
        `💰 Refund of ₹${order.total_amount} has been initiated.\n\n` +
        `The amount will be credited to your original payment method within 5-7 business days.\n\n` +
        `Thank you for your patience! 🙏`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify customer about refund: ${error.message}`);
    }
  }

  private async notifyOrderCanceled(payload: OrderWebhookPayload): Promise<void> {
    const { order, customer, vendor, delivery_man } = payload;
    this.logger.log(`📱 Notifying all parties: Order canceled`);

    if (!this.messageService) return;

    // Notify customer
    if (customer.phone) {
      try {
        await this.messageService.sendTextMessage(customer.phone,
          `❌ *Order Canceled*\n\n` +
          `Order ${order.order_id} has been canceled.\n` +
          (order.payment_status === 'paid'
            ? `💸 A refund of ₹${order.total_amount} will be processed shortly.\n\n`
            : '\n') +
          `We apologize for the inconvenience. You can place a new order anytime! 🙏`
        );
      } catch (error: any) {
        this.logger.warn(`Failed to notify customer about cancellation: ${error.message}`);
      }
    }

    // Notify delivery man if assigned
    if (delivery_man?.phone) {
      try {
        await this.messageService.sendTextMessage(delivery_man.phone,
          `⚠️ Order ${order.order_id} has been canceled.\n` +
          `No pickup needed from ${vendor.store_name}.`
        );
      } catch (error: any) {
        this.logger.warn(`Failed to notify delivery man about cancellation: ${error.message}`);
      }
    }
  }

  // ========================================
  // Delivery Man Notification Methods
  // ========================================

  private async notifyDeliveryManNewAssignment(payload: OrderWebhookPayload): Promise<void> {
    const { order, vendor, delivery_man, delivery_address } = payload;
    this.logger.log(`📱 Notifying delivery man: New order assigned`);

    if (!this.messageService || !delivery_man?.phone) return;

    try {
      await this.messageService.sendTextMessage(delivery_man.phone,
        `📦 *New Delivery Assigned!*\n\n` +
        `Order ${order.order_id}\n` +
        `🏪 Pickup: *${vendor.store_name}*\n` +
        (delivery_address ? `📍 Drop: ${delivery_address.address}\n` : '') +
        `💰 Order value: ₹${order.total_amount}\n` +
        (order.payment_method === 'cod' ? `💵 Collect COD: ₹${order.total_amount}\n` : '') +
        `\nPlease head to the restaurant for pickup.`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify delivery man about assignment: ${error.message}`);
    }
  }

  private async notifyDeliveryManOrderReady(payload: OrderWebhookPayload): Promise<void> {
    const { order, vendor, delivery_man } = payload;
    this.logger.log(`📱 Notifying delivery man: Order ready for pickup`);

    if (!this.messageService || !delivery_man?.phone) return;

    try {
      await this.messageService.sendTextMessage(delivery_man.phone,
        `✅ *Order Ready for Pickup!*\n\n` +
        `Order ${order.order_id} is ready at *${vendor.store_name}*.\n` +
        `Please collect it now.`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to notify delivery man about order ready: ${error.message}`);
    }
  }

  // ========================================
  // mOS Integration Methods
  // ========================================

  /**
   * Update rider quest progress when an order is delivered.
   * Finds all active delivery_count quests and increments progress.
   */
  private async updateRiderQuestProgress(payload: OrderWebhookPayload): Promise<void> {
    if (!this.riderQuestService || !payload.delivery_man?.id) return;

    try {
      const riderId = payload.delivery_man.id;
      // Get all active quests and update delivery-type ones
      const quests = await this.riderQuestService.getActiveQuests();
      for (const quest of quests) {
        if (quest.quest_type === 'delivery_count' || quest.quest_type === 'zone_bonus') {
          await this.riderQuestService.updateProgress(riderId, quest.id, 1);
        }
      }
      this.logger.log(`🏍️ Updated quest progress for rider ${riderId}`);
    } catch (error: any) {
      this.logger.warn(`Failed to update rider quest progress: ${error.message}`);
    }
  }

  /**
   * Track UTM attribution for orders from web/WhatsApp deep links.
   * Extracts utm_source, utm_medium, utm_campaign from order metadata.
   */
  private async trackOrderAttribution(payload: OrderWebhookPayload): Promise<void> {
    if (!this.adAttributionService) return;

    try {
      // Check for UTM params in order metadata (sent by PHP in the payload)
      const metadata = (payload as any).metadata || {};
      const utmSource = metadata.utm_source;
      const utmMedium = metadata.utm_medium;
      const utmCampaign = metadata.utm_campaign;

      if (!utmSource && !utmCampaign) return;

      await this.adAttributionService.trackAttribution(
        payload.order.id,
        {
          source: utmSource || 'direct',
          medium: utmMedium || 'none',
          campaign: utmCampaign || 'organic',
          content: metadata.utm_content,
        },
        payload.order.total_amount,
      );
      this.logger.log(`📊 UTM attribution tracked for order #${payload.order.id}: source=${utmSource}`);
    } catch (error: any) {
      this.logger.warn(`Failed to track order attribution: ${error.message}`);
    }
  }

  /**
   * Track if this order was influenced by a proactive WhatsApp message.
   */
  private async trackProactiveConversion(payload: OrderWebhookPayload): Promise<void> {
    if (!this.proactiveMessagingService || !payload.customer?.phone) return;

    try {
      const converted = await this.proactiveMessagingService.trackConversion(
        payload.customer.phone,
        payload.order.id,
      );
      if (converted) {
        this.logger.log(`📊 Proactive message conversion tracked for order #${payload.order.id}`);
      }
    } catch (error: any) {
      this.logger.warn(`Failed to track proactive conversion: ${error.message}`);
    }
  }

}
