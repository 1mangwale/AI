import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import axios from 'axios';
import * as crypto from 'crypto';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';

/**
 * Order Notification Payload
 */
export interface OrderNotificationPayload {
  orderId: number;
  orderAmount: number;
  customerName: string;
  customerPhone?: string;
  itemsCount: number;
  itemsSummary: string;
  deliveryAddress?: string;
  paymentMethod: 'cod' | 'online' | 'wallet';
  scheduledAt?: string;
  orderType: 'delivery' | 'pickup';
}

/**
 * Vendor Notification Target
 */
export interface VendorNotificationTarget {
  vendorId: number;
  storeName: string;
  vendorPhone: string;
  vendorEmail?: string;
  fcmTopics?: string[];
  preferredLanguage?: 'en' | 'hi' | 'mr';
}

/**
 * Notification Result
 */
export interface NotificationResult {
  success: boolean;
  channel: 'fcm' | 'whatsapp' | 'voice' | 'sms';
  sentAt: Date;
  messageId?: string;
  error?: string;
}

/**
 * Vendor Notification Service
 * 
 * Multi-channel notification system for vendors:
 * 1. FCM Push (via zone_wise_topic)
 * 2. WhatsApp Message
 * 3. Voice Call IVR (via Nerve System on Mercury)
 * 4. SMS (fallback)
 */
@Injectable()
export class VendorNotificationService {
  private readonly logger = new Logger(VendorNotificationService.name);
  
  private readonly whatsappServiceUrl: string;
  private readonly nerveServiceUrl: string;
  private readonly fcmServerKey: string;

  /**
   * Pilot gate. Fail-closed by design: unless VENDOR_NOTIFY_ALLOWLIST_REQUIRED
   * is the literal string 'false', a vendor phone must hash-match
   * VENDOR_NOTIFY_ALLOWED_VENDOR_HASHES or NO channel fires (FCM, WhatsApp, voice).
   * Empty allowlist + required = nobody is notified. That is the safe state.
   * Same sha256 scheme as WhatsAppCloudService so one hash works in both places.
   */
  private readonly notifyAllowlistRequired: boolean;
  private readonly notifyAllowedVendorHashes: Set<string>;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly whatsappCloudService: WhatsAppCloudService,
  ) {
    this.whatsappServiceUrl = this.configService.get<string>(
      'WHATSAPP_SERVICE_URL',
      'http://localhost:3200'
    );
    this.nerveServiceUrl = this.configService.get<string>(
      'NERVE_SERVICE_URL',
      'http://localhost:7100'
    );
    this.fcmServerKey = this.configService.get<string>('FCM_SERVER_KEY', '');

    this.notifyAllowlistRequired =
      this.configService.get<string>('VENDOR_NOTIFY_ALLOWLIST_REQUIRED') !== 'false';
    this.notifyAllowedVendorHashes = this.parseHashAllowlist(
      this.configService.get<string>('VENDOR_NOTIFY_ALLOWED_VENDOR_HASHES') || '',
    );

    this.logger.log(`✅ VendorNotificationService initialized`);
    this.logger.log(`   Nerve System: ${this.nerveServiceUrl}`);
    this.logger.log(
      `   Pilot gate: required=${this.notifyAllowlistRequired} ` +
      `allowlisted=${this.notifyAllowedVendorHashes.size}`
    );
  }

  /**
   * sha256 of the recipient in every shape a phone can arrive in
   * (raw, digits-only, 91-normalised, +E164). Mirrors
   * WhatsAppCloudService.recipientHashes so a single hash covers both gates.
   */
  private recipientHashes(to: string): string[] {
    const raw = String(to || '').trim();
    if (!raw) return [];

    const digits = raw.replace(/\D+/g, '');
    const candidates = new Set<string>([raw]);
    if (digits) {
      candidates.add(digits);
      const normalized = digits.length === 10 ? `91${digits}` : digits;
      candidates.add(normalized);
      candidates.add(`+${normalized}`);
    }

    return Array.from(candidates).map((value) =>
      crypto.createHash('sha256').update(value).digest('hex'),
    );
  }

  private parseHashAllowlist(raw: string): Set<string> {
    return new Set(
      String(raw || '')
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => /^[a-f0-9]{64}$/.test(entry)),
    );
  }

  private isVendorAllowed(phone: string): boolean {
    if (!this.notifyAllowlistRequired) return true;
    if (this.notifyAllowedVendorHashes.size === 0) return false;
    return this.recipientHashes(phone).some((hash) =>
      this.notifyAllowedVendorHashes.has(hash),
    );
  }

  private blockedResult(channel: NotificationResult['channel']): NotificationResult {
    return {
      success: false,
      channel,
      sentAt: new Date(),
      error: 'vendor_not_allowlisted',
    };
  }

  /**
   * Send new order notification to vendor
   */
  async notifyVendorNewOrder(
    vendor: VendorNotificationTarget,
    order: OrderNotificationPayload
  ): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];

    this.logger.log(
      `📦 Notifying vendor ${vendor.storeName} about new order #${order.orderId}`
    );

    if (!this.isVendorAllowed(vendor.vendorPhone)) {
      this.logger.warn(
        `🚫 Vendor ${vendor.vendorId} not allowlisted — all channels skipped for order #${order.orderId}`
      );
      return [
        this.blockedResult('fcm'),
        this.blockedResult('whatsapp'),
        this.blockedResult('voice'),
      ];
    }

    // Step 1: Send FCM Push (immediate)
    const fcmResult = await this.sendFcmNotification(vendor, order);
    results.push(fcmResult);

    // Step 2: Send WhatsApp (immediate)
    const whatsappResult = await this.sendWhatsAppNotification(vendor, order);
    results.push(whatsappResult);

    // Step 3: Make Voice Call via Nerve System
    const voiceResult = await this.sendVoiceNotification(vendor, order);
    results.push(voiceResult);

    return results;
  }

  /**
   * Send FCM Push Notification
   */
  private async sendFcmNotification(
    vendor: VendorNotificationTarget,
    order: OrderNotificationPayload
  ): Promise<NotificationResult> {
    try {
      const topic = vendor.fcmTopics?.[0] || `zone_${vendor.vendorId}_store`;
      this.logger.log(`📲 Sending FCM to topic: ${topic}`);

      if (!this.fcmServerKey) {
        return {
          success: false,
          channel: 'fcm',
          sentAt: new Date(),
          error: 'FCM not configured',
        };
      }

      const message = {
        to: `/topics/${topic}`,
        notification: {
          title: `🔔 New Order #${order.orderId}`,
          body: `${order.itemsCount} items - ₹${order.orderAmount}`,
          sound: 'default',
        },
        data: {
          type: 'new_order',
          order_id: order.orderId.toString(),
          order_amount: order.orderAmount.toString(),
        },
        priority: 'high',
      };

      const response = await axios.post(
        'https://fcm.googleapis.com/fcm/send',
        message,
        {
          headers: {
            Authorization: `key=${this.fcmServerKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return {
        success: response.data.success === 1,
        channel: 'fcm',
        sentAt: new Date(),
        messageId: response.data.message_id,
      };
    } catch (error) {
      this.logger.error(`❌ FCM notification failed: ${error.message}`);
      return {
        success: false,
        channel: 'fcm',
        sentAt: new Date(),
        error: error.message,
      };
    }
  }

  /**
   * Send WhatsApp notification
   */
  private async sendWhatsAppNotification(
    vendor: VendorNotificationTarget,
    order: OrderNotificationPayload
  ): Promise<NotificationResult> {
    try {
      this.logger.log(`📱 Sending WhatsApp to vendor: ${vendor.vendorPhone}`);

      const message = this.formatWhatsAppOrderMessage(vendor, order);

      // Send through WhatsAppCloudService, not a bare axios POST. The old path
      // built `${WHATSAPP_SERVICE_URL}/api/whatsapp/send`, which resolves to
      // https://graph.facebook.com/v24.0/api/whatsapp/send — a route that exists
      // nowhere. Going through the service also inherits its fail-closed
      // outbound allowlist.
      const response = await this.whatsappCloudService.sendText(
        vendor.vendorPhone,
        message,
      );

      return {
        success: Boolean(response?.messages?.[0]?.id),
        channel: 'whatsapp',
        sentAt: new Date(),
        messageId: response?.messages?.[0]?.id,
      };
    } catch (error) {
      this.logger.error(`❌ WhatsApp notification failed: ${error.message}`);
      return {
        success: false,
        channel: 'whatsapp',
        sentAt: new Date(),
        error: error.message,
      };
    }
  }

  /**
   * Make IVR voice call via Nerve System (Mercury)
  * Calls the Nerve System vendor confirmation endpoint
   */
  async sendVoiceNotification(
    vendor: VendorNotificationTarget,
    order: OrderNotificationPayload
  ): Promise<NotificationResult> {
    try {
      this.logger.log(`📞 Making IVR call to vendor: ${vendor.vendorPhone} via Nerve System`);

      const response = await firstValueFrom(
        this.httpService.post(`${this.nerveServiceUrl}/api/nerve/vendor-order-confirmation`, {
          order_id: order.orderId,
          vendor_id: vendor.vendorId,
          vendor_phone: vendor.vendorPhone,
          vendor_name: vendor.storeName,
          order_amount: order.orderAmount || 0,
          language: vendor.preferredLanguage || 'hi',
        }, { timeout: 30000 })
      );

      const callId = `VC_${order.orderId}_${Date.now()}`;
      
      return {
        success: response.data?.success === true || response.data?.call_sid,
        channel: 'voice',
        sentAt: new Date(),
        messageId: response.data?.call_sid || callId,
        error: response.data?.error,
      };
    } catch (error) {
      this.logger.error(`❌ Voice notification failed: ${error.message}`);
      return {
        success: false,
        channel: 'voice',
        sentAt: new Date(),
        error: error.message,
      };
    }
  }

  /**
   * Format WhatsApp message
   */
  private formatWhatsAppOrderMessage(
    vendor: VendorNotificationTarget,
    order: OrderNotificationPayload
  ): string {
    const lang = vendor.preferredLanguage || 'hi';

    const templates = {
      en: `🔔 *NEW ORDER #${order.orderId}*

📍 *${vendor.storeName}*

*Items:* ${order.itemsSummary}
*Total:* ₹${order.orderAmount}
*Payment:* ${(order.paymentMethod || 'COD').toUpperCase()}
*Customer:* ${order.customerName}

⏰ Please confirm within 5 minutes!`,

      hi: `🔔 *नया ऑर्डर #${order.orderId}*

📍 *${vendor.storeName}*

*आइटम:* ${order.itemsSummary}
*कुल:* ₹${order.orderAmount}
*भुगतान:* ${(order.paymentMethod || 'COD').toUpperCase()}
*ग्राहक:* ${order.customerName}

⏰ कृपया 5 मिनट में पुष्टि करें!`,

      mr: `🔔 *नवीन ऑर्डर #${order.orderId}*

📍 *${vendor.storeName}*

*आयटम:* ${order.itemsSummary}
*एकूण:* ₹${order.orderAmount}
*पेमेंट:* ${(order.paymentMethod || 'COD').toUpperCase()}
*ग्राहक:* ${order.customerName}

⏰ कृपया 5 मिनिटांत पुष्टी करा!`,
    };

    return templates[lang] || templates.hi;
  }

  /**
   * Notify vendor about order status changes
   */
  async notifyVendorOrderUpdate(
    vendor: VendorNotificationTarget,
    orderId: number,
    status: string,
    details: string
  ): Promise<NotificationResult> {
    if (!this.isVendorAllowed(vendor.vendorPhone)) {
      this.logger.warn(
        `🚫 Vendor ${vendor.vendorId} not allowlisted — update for order #${orderId} skipped`
      );
      return this.blockedResult('whatsapp');
    }

    try {
      const message = `📦 Order #${orderId} Update\n\nStatus: ${status}\n${details}`;

      const response = await this.whatsappCloudService.sendText(
        vendor.vendorPhone,
        message,
      );

      return {
        success: Boolean(response?.messages?.[0]?.id),
        channel: 'whatsapp',
        sentAt: new Date(),
        messageId: response?.messages?.[0]?.id,
      };
    } catch (error) {
      this.logger.error(`❌ Order update notification failed: ${error.message}`);
      return {
        success: false,
        channel: 'whatsapp',
        sentAt: new Date(),
        error: error.message,
      };
    }
  }
}
