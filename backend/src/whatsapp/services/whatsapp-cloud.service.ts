import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  TextMessage,
  ImageMessage,
  VideoMessage,
  AudioMessage,
  DocumentMessage,
  LocationMessage,
  ContactMessage,
  InteractiveMessage,
  TemplateMessage,
  ReactionMessage,
  ButtonInteractive,
  ListInteractive,
  CTAUrlInteractive,
  LocationRequestInteractive,
  FlowInteractive,
  ProductInteractive,
  ProductListInteractive,
  ProductListSection,
  MessageResponse,
  ReplyButton,
  ListSection,
  TemplateComponent,
  WHATSAPP_CAPABILITIES,
} from '../interfaces/whatsapp-message-types.interface';

/**
 * Enhanced WhatsApp Cloud API Service (v24.0)
 * 
 * Supports all WhatsApp message types with proper typing and validation.
 * Multi-channel architecture compatible.
 */
@Injectable()
export class WhatsAppCloudService {
  private readonly logger = new Logger(WhatsAppCloudService.name);
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;

  // Rate limiter: token bucket (80 msgs/sec, well under Meta's 1000/sec)
  private rateLimitTokens = 80;
  private readonly RATE_LIMIT_CAPACITY = 80;
  private readonly RATE_LIMIT_REFILL_RATE = 80;
  private lastRefillTime = Date.now();

  // 24-hour session window
  private readonly SESSION_WINDOW_TTL = 25 * 60 * 60; // 25h (1h buffer)
  private readonly SESSION_WINDOW_KEY = 'wa:last_msg:';

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    this.phoneNumberId = this.configService.get('whatsapp.phoneNumberId');
    this.accessToken = this.configService.get('whatsapp.accessToken');
    this.apiVersion = this.configService.get('whatsapp.apiVersion') || 'v24.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;

    this.logger.log(`✅ WhatsApp Cloud Service initialized (API ${this.apiVersion}, rate limiter + 24h window)`);
  }

  // ============================================
  // TEXT MESSAGES
  // ============================================

  /**
   * Send plain text message
   */
  async sendText(to: string, text: string, options?: {
    previewUrl?: boolean;
    replyToMessageId?: string;
  }): Promise<MessageResponse> {
    // Validate length
    if (text.length > WHATSAPP_CAPABILITIES.maxTextLength) {
      this.logger.warn(`Text truncated from ${text.length} to ${WHATSAPP_CAPABILITIES.maxTextLength} chars`);
      text = text.substring(0, WHATSAPP_CAPABILITIES.maxTextLength);
    }

    const message: TextMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: text,
        preview_url: options?.previewUrl,
      },
    };

    if (options?.replyToMessageId) {
      message.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(message);
  }

  // ============================================
  // MEDIA MESSAGES
  // ============================================

  /**
   * Send image message
   */
  async sendImage(to: string, image: { id?: string; url?: string; caption?: string }): Promise<MessageResponse> {
    const message: ImageMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        ...(image.id ? { id: image.id } : { link: image.url }),
        caption: image.caption?.substring(0, WHATSAPP_CAPABILITIES.maxCaptionLength),
      },
    };
    return this.sendMessage(message);
  }

  /**
   * Send video message
   */
  async sendVideo(to: string, video: { id?: string; url?: string; caption?: string }): Promise<MessageResponse> {
    const message: VideoMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: {
        ...(video.id ? { id: video.id } : { link: video.url }),
        caption: video.caption?.substring(0, WHATSAPP_CAPABILITIES.maxCaptionLength),
      },
    };
    return this.sendMessage(message);
  }

  /**
   * Send audio message
   */
  async sendAudio(to: string, audio: { id?: string; url?: string }): Promise<MessageResponse> {
    const message: AudioMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: audio.id ? { id: audio.id } : { link: audio.url },
    };
    return this.sendMessage(message);
  }

  /**
   * Send document message
   */
  async sendDocument(to: string, doc: { 
    id?: string; 
    url?: string; 
    filename: string; 
    caption?: string 
  }): Promise<MessageResponse> {
    const message: DocumentMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: {
        ...(doc.id ? { id: doc.id } : { link: doc.url }),
        filename: doc.filename,
        caption: doc.caption?.substring(0, WHATSAPP_CAPABILITIES.maxCaptionLength),
      },
    };
    return this.sendMessage(message);
  }

  // ============================================
  // LOCATION MESSAGES
  // ============================================

  /**
   * Send location message
   */
  async sendLocation(to: string, location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  }): Promise<MessageResponse> {
    const message: LocationMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'location',
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.name?.substring(0, 256),
        address: location.address?.substring(0, 256),
      },
    };
    return this.sendMessage(message);
  }

  // ============================================
  // CONTACT MESSAGES
  // ============================================

  /**
   * Send contact card
   */
  async sendContact(to: string, contact: {
    name: string;
    phone: string;
    email?: string;
  }): Promise<MessageResponse> {
    const message: ContactMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'contacts',
      contacts: [{
        name: { formatted_name: contact.name },
        phones: [{ phone: contact.phone }],
        ...(contact.email ? { emails: [{ email: contact.email }] } : {}),
      }],
    };
    return this.sendMessage(message);
  }

  // ============================================
  // INTERACTIVE MESSAGES
  // ============================================

  /**
   * Send interactive button message (max 3 buttons)
   */
  async sendButtons(to: string, options: {
    body: string;
    buttons: Array<{ id: string; title: string }>;
    header?: string;
    footer?: string;
  }): Promise<MessageResponse> {
    if (options.buttons.length > WHATSAPP_CAPABILITIES.maxButtonCount) {
      throw new Error(`Max ${WHATSAPP_CAPABILITIES.maxButtonCount} buttons allowed`);
    }

    const interactive: ButtonInteractive = {
      type: 'button',
      body: { text: options.body },
      action: {
        buttons: options.buttons.map((btn): ReplyButton => ({
          type: 'reply',
          reply: {
            id: btn.id.substring(0, 256),
            title: btn.title.substring(0, WHATSAPP_CAPABILITIES.maxButtonTitleLength),
          },
        })),
      },
    };

    if (options.header) {
      interactive.header = { type: 'text', text: options.header.substring(0, 60) };
    }
    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  /**
   * Send interactive list message
   */
  async sendList(to: string, options: {
    body: string;
    buttonText: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    header?: string;
    footer?: string;
  }): Promise<MessageResponse> {
    const sections: ListSection[] = options.sections.map(section => ({
      title: section.title?.substring(0, 24),
      rows: section.rows.map(row => ({
        id: row.id.substring(0, 200),
        title: row.title.substring(0, WHATSAPP_CAPABILITIES.maxListRowTitleLength),
        description: row.description?.substring(0, WHATSAPP_CAPABILITIES.maxListRowDescriptionLength),
      })),
    }));

    const interactive: ListInteractive = {
      type: 'list',
      body: { text: options.body },
      action: {
        button: options.buttonText.substring(0, 20),
        sections,
      },
    };

    if (options.header) {
      interactive.header = { type: 'text', text: options.header.substring(0, 60) };
    }
    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  /**
   * Send CTA URL button
   */
  async sendCTAButton(to: string, options: {
    body: string;
    buttonText: string;
    url: string;
    header?: string;
    footer?: string;
  }): Promise<MessageResponse> {
    const interactive: CTAUrlInteractive = {
      type: 'cta_url',
      body: { text: options.body },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: options.buttonText.substring(0, 20),
          url: options.url,
        },
      },
    };

    if (options.header) {
      interactive.header = { type: 'text', text: options.header.substring(0, 60) };
    }
    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  /**
   * Send location request
   */
  async sendLocationRequest(to: string, body: string): Promise<MessageResponse> {
    const interactive: LocationRequestInteractive = {
      type: 'location_request_message',
      body: { text: body },
      action: { name: 'send_location' },
    };

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  /**
   * Send WhatsApp Flow
   */
  async sendFlow(to: string, options: {
    body: string;
    flowId: string;
    flowToken: string;
    ctaText: string;
    screen?: string;
    data?: Record<string, any>;
    header?: string;
    footer?: string;
  }): Promise<MessageResponse> {
    const interactive: FlowInteractive = {
      type: 'flow',
      body: { text: options.body },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: options.flowToken,
          flow_id: options.flowId,
          flow_cta: options.ctaText.substring(0, 20),
          flow_action: options.screen ? 'navigate' : 'data_exchange',
          ...(options.screen ? {
            flow_action_payload: {
              screen: options.screen,
              data: options.data,
            },
          } : {}),
        },
      },
    };

    if (options.header) {
      interactive.header = { type: 'text', text: options.header.substring(0, 60) };
    }
    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  // ============================================
  // PRODUCT MESSAGES (Native Catalog)
  // ============================================

  /**
   * Send single product message (SPM)
   * Shows one product card with image, price, description from Meta catalog
   */
  async sendProduct(to: string, options: {
    catalogId: string;
    productRetailerId: string;
    body?: string;
    footer?: string;
  }): Promise<MessageResponse> {
    const interactive: ProductInteractive = {
      type: 'product',
      action: {
        catalog_id: options.catalogId,
        product_retailer_id: options.productRetailerId,
      },
    };

    if (options.body) {
      interactive.body = { text: options.body.substring(0, 1024) };
    }
    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  /**
   * Send multi-product message (MPM)
   * Shows up to 30 products grouped in sections with images, prices from Meta catalog
   */
  async sendProductList(to: string, options: {
    catalogId: string;
    sections: ProductListSection[];
    header: string;
    body: string;
    footer?: string;
  }): Promise<MessageResponse> {
    const interactive: ProductListInteractive = {
      type: 'product_list',
      header: { type: 'text', text: options.header.substring(0, 60) },
      body: { text: options.body.substring(0, 1024) },
      action: {
        catalog_id: options.catalogId,
        sections: options.sections.slice(0, 10), // Max 10 sections
      },
    };

    if (options.footer) {
      interactive.footer = { text: options.footer.substring(0, 60) };
    }

    const message: InteractiveMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive,
    };

    return this.sendMessage(message);
  }

  // ============================================
  // TEMPLATE MESSAGES
  // ============================================

  /**
   * Send template message
   */
  async sendTemplate(to: string, options: {
    name: string;
    language: string;
    components?: TemplateComponent[];
  }): Promise<MessageResponse> {
    const message: TemplateMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: options.name,
        language: { code: options.language },
        components: options.components,
      },
    };

    return this.sendMessage(message);
  }

  // ============================================
  // REACTIONS
  // ============================================

  /**
   * Send reaction to a message
   */
  async sendReaction(to: string, messageId: string, emoji: string): Promise<MessageResponse> {
    const message: ReactionMessage = {
      messaging_product: 'whatsapp',
      to,
      type: 'reaction',
      reaction: {
        message_id: messageId,
        emoji,
      },
    };

    return this.sendMessage(message);
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(to: string, messageId: string): Promise<MessageResponse> {
    return this.sendReaction(to, messageId, '');
  }

  // ============================================
  // STATUS UPDATES
  // ============================================

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<boolean> {
    try {
      await this.sendToApi({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
      return true;
    } catch (error) {
      this.logger.debug(`Could not mark message as read: ${messageId}`);
      return false;
    }
  }

  /**
   * Send typing indicator
   * Note: WhatsApp Cloud API does not support typing indicators as a message type.
   * This is a no-op to prevent error noise in logs.
   */
  async sendTypingIndicator(to: string, typing: boolean = true): Promise<boolean> {
    // WhatsApp Cloud API doesn't support 'typing' message type
    // Valid types: AUDIO, CONTACTS, DOCUMENT, GIF, IMAGE, INTERACTIVE, LINK_PREVIEW, LOCATION, PIN, REACTION, STICKER, TEMPLATE, TEXT, VIDEO
    this.logger.debug(`Typing indicator for ${to}: ${typing ? 'on' : 'off'} (no-op, unsupported by API)`);
    return false;
  }

  // ============================================
  // MEDIA UPLOAD
  // ============================================

  /**
   * Upload media to WhatsApp servers
   * Returns media ID for use in messages
   */
  async uploadMedia(file: Buffer, mimeType: string, filename?: string): Promise<string> {
    try {
      const formData = new FormData();
      // Use ArrayBuffer for proper Blob compatibility
      const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
      formData.append('file', new Blob([arrayBuffer], { type: mimeType }), filename || 'media');
      formData.append('type', mimeType);
      formData.append('messaging_product', 'whatsapp');

      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/media`, formData, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }),
      );

      return response.data.id;
    } catch (error) {
      this.logger.error(`Failed to upload media: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get media URL from WhatsApp servers
   */
  async getMediaUrl(mediaId: string): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.apiVersion}/${mediaId}`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }),
      );

      return response.data.url;
    } catch (error) {
      this.logger.error(`Failed to get media URL: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download media from WhatsApp CDN
   */
  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(mediaUrl, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
          responseType: 'arraybuffer',
        }),
      );

      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error(`Failed to download media: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // INTERNAL HELPERS
  // ============================================

  private async sendMessage(message: any): Promise<MessageResponse> {
    // 24-hour window check for non-template messages
    const isTemplate = message.type === 'template';
    if (!isTemplate && message.to) {
      const withinWindow = await this.isWithin24hWindow(message.to);
      if (!withinWindow) {
        this.logger.warn(`⏰ 24h window expired for ${message.to} — non-template message blocked. Use template instead.`);
        throw new Error(`24-hour messaging window expired for ${message.to}. Use a template message.`);
      }
    }

    // Rate limiting
    await this.acquireRateLimitToken();

    return this.sendToApi(message);
  }

  private async sendToApi(payload: any): Promise<any> {
    try {
      this.logger.debug(`📤 WhatsApp API payload: ${JSON.stringify(payload).substring(0, 500)}`);

      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/messages`, payload, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }),
      );

      this.logger.log(`✅ Message sent to ${payload.to || 'API'} - Response: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      const errorData = error.response?.data?.error || error.message;
      this.logger.error(`❌ WhatsApp API error: ${JSON.stringify(errorData)}`);
      throw error;
    }
  }

  // ============================================
  // RATE LIMITING
  // ============================================

  /**
   * Token bucket rate limiter — blocks until a token is available
   */
  private async acquireRateLimitToken(): Promise<void> {
    this.refillTokens();

    if (this.rateLimitTokens >= 1) {
      this.rateLimitTokens -= 1;
      return;
    }

    // Wait and retry with exponential backoff (max 5 retries)
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = Math.min(100 * Math.pow(2, attempt), 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
      this.refillTokens();
      if (this.rateLimitTokens >= 1) {
        this.rateLimitTokens -= 1;
        return;
      }
    }

    this.logger.warn('Rate limit exhausted after 5 retries — sending anyway');
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    this.rateLimitTokens = Math.min(
      this.RATE_LIMIT_CAPACITY,
      this.rateLimitTokens + elapsed * this.RATE_LIMIT_REFILL_RATE,
    );
    this.lastRefillTime = now;
  }

  // ============================================
  // 24-HOUR SESSION WINDOW
  // ============================================

  /**
   * Record inbound message timestamp (call from webhook controller)
   */
  async recordInboundMessage(phoneNumber: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setex(
        `${this.SESSION_WINDOW_KEY}${phoneNumber}`,
        this.SESSION_WINDOW_TTL,
        String(Date.now()),
      );
    } catch (err) {
      this.logger.debug(`Failed to record inbound timestamp: ${err.message}`);
    }
  }

  /**
   * Check if phone number is within the 24-hour messaging window
   */
  async isWithin24hWindow(phoneNumber: string): Promise<boolean> {
    if (!this.redis) return true; // If no Redis, allow (fail open)
    try {
      const timestamp = await this.redis.get(`${this.SESSION_WINDOW_KEY}${phoneNumber}`);
      if (!timestamp) return false;

      const ageMs = Date.now() - parseInt(timestamp, 10);
      return ageMs < 24 * 60 * 60 * 1000; // 24 hours in ms
    } catch (err) {
      this.logger.debug(`Failed to check 24h window: ${err.message}`);
      return true; // Fail open
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get channel capabilities
   */
  getCapabilities() {
    return WHATSAPP_CAPABILITIES;
  }

  /**
   * Validate phone number format
   */
  validatePhoneNumber(phone: string): string {
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, '');
    
    // Add country code if missing (assume India)
    if (cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    
    return cleaned;
  }
}
