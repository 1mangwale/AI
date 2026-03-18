import { Controller, Get, Post, Body, Query, Logger, HttpCode, Param, Delete, Headers, UnauthorizedException, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminAuthGuard } from '../../admin/guards/admin-auth.guard';
import { SessionService } from '../../session/session.service';
import { MessageService } from '../services/message.service';
import { AgentOrchestratorService } from '../../agents/services/agent-orchestrator.service';
import { ConversationLoggerService } from '../../database/conversation-logger.service';
import { ConfigService } from '@nestjs/config';
import { Platform } from '../../common/enums/platform.enum';
import { AsrService } from '../../asr/services/asr.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { MessageGatewayService } from '../../messaging/services/message-gateway.service';
import { WhatsAppCloudService } from '../services/whatsapp-cloud.service';
import * as crypto from 'crypto';
import { Request } from 'express';
import { normalizePhoneNumber } from '../../common/utils/helpers';

@SkipThrottle()
@Controller('webhook/whatsapp')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly verifyToken: string;
  private readonly accessToken: string;
  private readonly graphApiVersion: string;
  private readonly appSecret: string;

  constructor(
    private sessionService: SessionService,
    private messageService: MessageService,
    private agentOrchestratorService: AgentOrchestratorService,
    private conversationLogger: ConversationLoggerService,
    private configService: ConfigService,
    private asrService: AsrService,
    private httpService: HttpService,
    private messageGateway: MessageGatewayService,
    private whatsappCloudService: WhatsAppCloudService,
  ) {
    this.verifyToken = this.configService.get('whatsapp.verifyToken');
    this.accessToken = this.configService.get('whatsapp.accessToken');
    this.graphApiVersion = this.configService.get('whatsapp.apiVersion') || 'v24.0';
    this.appSecret = this.configService.get('WHATSAPP_APP_SECRET', '');
    this.logger.log(`✅ Webhook Controller initialized (API ${this.graphApiVersion}, Voice Support)`);
  }

  @Get('session/:phoneNumber')
  @UseGuards(AdminAuthGuard)
  async getSession(@Param('phoneNumber') phoneNumber: string): Promise<any> {
    const session = await this.sessionService.getSession(phoneNumber);
    return session || { message: 'No session found' };
  }

  @Delete('session/:phoneNumber')
  @UseGuards(AdminAuthGuard)
  async deleteSession(@Param('phoneNumber') phoneNumber: string): Promise<any> {
    await this.sessionService.deleteSession(phoneNumber);
    this.logger.log(`🗑️ Session deleted for ${phoneNumber}`);
    return { status: 'ok', message: 'Session deleted', phoneNumber };
  }

  @Get('messages/:phoneNumber')
  @UseGuards(AdminAuthGuard)
  async getBotMessages(@Param('phoneNumber') phoneNumber: string): Promise<any> {
    const messages = await this.sessionService.getBotMessages(phoneNumber);
    return { phoneNumber, messages, count: messages.length };
  }

  @Get('sessions')
  @UseGuards(AdminAuthGuard)
  async getAllSessions(): Promise<any> {
    const sessions = await this.sessionService.getAllSessions();
    return { total: sessions.length, sessions };
  }

  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): Promise<string> {
    this.logger.log(`🔐 Webhook verification: mode=${mode}`);

    if (mode === 'subscribe' && token === this.verifyToken) {
      this.logger.log('✅ Webhook verified successfully');
      return challenge;
    }

    this.logger.warn('❌ Webhook verification failed');
    throw new Error('Forbidden');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Body() payload: any,
    @Headers('x-hub-signature-256') hubSignature: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: string }> {
    // Verify WhatsApp webhook signature (HMAC-SHA256) — MANDATORY
    // These checks must be outside try-catch so NestJS returns proper 401
    if (!this.appSecret) {
      this.logger.error('WHATSAPP_APP_SECRET not configured — rejecting all webhooks for security');
      throw new UnauthorizedException('Webhook signature verification not configured');
    }

    if (!hubSignature) {
      this.logger.warn('Missing WhatsApp webhook signature - rejecting');
      throw new UnauthorizedException('Missing webhook signature');
    }

    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      this.logger.error('Raw body not available — ensure rawBody: true in NestFactory.create()');
      throw new UnauthorizedException('Webhook verification failed');
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(hubSignature),
    )) {
      this.logger.warn('Invalid WhatsApp webhook signature - rejecting');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    try {
      this.logger.debug('Webhook received');
      this.logger.debug(`📋 Payload structure: ${JSON.stringify(payload, null, 2)}`);

      if (!payload.entry?.[0]?.changes?.[0]?.value) {
        this.logger.warn('Invalid webhook payload structure');
        return { status: 'ignored' };
      }

      const value = payload.entry[0].changes[0].value;
      this.logger.debug(`📋 Value: ${JSON.stringify(value, null, 2)}`);

      if (value.messages) {
        this.logger.log(`📩 Found ${value.messages.length} messages`);
        for (const message of value.messages) {
          await this.handleIncomingMessage(message);
        }
      }

      // Handle delivery status updates (sent, delivered, read, failed)
      if (value.statuses) {
        for (const status of value.statuses) {
          if (status.status === 'failed') {
            const errorCode = status.errors?.[0]?.code || 'unknown';
            const errorTitle = status.errors?.[0]?.title || 'Unknown error';
            this.logger.error(
              `❌ WhatsApp message delivery failed to ${status.recipient_id}: ` +
              `code=${errorCode}, error="${errorTitle}", messageId=${status.id}`,
            );
          } else {
            this.logger.debug(`📬 Status update: ${status.status} for ${status.recipient_id}`);
          }
        }
      }

      return { status: 'ok' };
    } catch (error) {
      this.logger.error('Error processing webhook:', error);
      return { status: 'error' };
    }
  }

  private async handleIncomingMessage(message: any): Promise<void> {
    try {
      const messageId = message.id;
      // Normalize to E.164 (+91...) so session keys match MessageGatewayService
      const from = normalizePhoneNumber(message.from) || message.from;
      const type = message.type;

      this.logger.log(`📩 Message from ${from}: ${type}`);

      // Record inbound timestamp for 24h session window tracking
      this.whatsappCloudService.recordInboundMessage(from).catch(() => {});

      // Mark as read via Cloud API (shows blue ticks immediately)
      this.whatsappCloudService.markAsRead(messageId).catch(() => {});
      
      // Show typing indicator while processing
      this.whatsappCloudService.sendTypingIndicator(from, true).catch(() => {});

      let session = await this.sessionService.getSession(from);
      if (!session) {
        session = await this.sessionService.createSession(from);
      }

      // Set platform for this session to WhatsApp for channel-aware replies
      await this.sessionService.setData(from, 'platform', Platform.WHATSAPP);

      await this.routeMessage(from, type, message, session.currentStep);
    } catch (error) {
      this.logger.error(`Error handling message:`, error);
    }
  }

  private async routeMessage(from: string, type: string, message: any, currentStep: string): Promise<void> {
    try {
      let messageText = '';
      let locationData: { latitude: number; longitude: number } | null = null;
      
      // Handle different message types
      if (type === 'audio') {
        // 🎤 VOICE MESSAGE - Transcribe using ASR
        this.logger.log(`🎤 Voice message from ${from} - transcribing...`);
        messageText = await this.handleVoiceMessage(message, from);
        if (!messageText) {
          await this.messageService.sendTextMessage(from, "🎤 Sorry, I couldn't understand your voice message. Please try again or type your message.");
          return;
        }
        this.logger.log(`🎤 Transcribed: "${messageText}"`);
      } else if (type === 'location') {
        // 📍 LOCATION MESSAGE - Extract coordinates
        locationData = {
          latitude: message.location?.latitude,
          longitude: message.location?.longitude,
        };
        messageText = `LOCATION:${locationData.latitude},${locationData.longitude}`;
        this.logger.log(`📍 Location from ${from}: ${locationData.latitude}, ${locationData.longitude}`);
      } else if (type === 'image' || type === 'video' || type === 'document' || type === 'sticker') {
        // 📷 MEDIA MESSAGE — acknowledge but can't process yet
        this.logger.log(`📷 Media message (${type}) from ${from}`);
        const mediaId = message[type]?.id;
        const caption = message[type]?.caption || '';
        if (caption) {
          // If image has a caption, treat caption as the message text
          messageText = caption;
          this.logger.log(`📷 Media caption: "${caption}" — processing as text`);
        } else {
          await this.messageService.sendTextMessage(
            from,
            `I received your ${type}, but I can only process text and voice messages right now. Please type your request instead.`,
          );
          return;
        }
      } else if (type === 'order') {
        // 🛒 WHATSAPP ORDER — customer sent cart from product catalog
        this.logger.log(`🛒 Order message from ${from}`);
        const orderData = message.order;
        if (orderData?.product_items) {
          messageText = `ORDER:${JSON.stringify(orderData.product_items)}`;
          (message as any)._buttonAction = 'whatsapp_order';
          (message as any)._buttonValue = JSON.stringify(orderData);
          this.logger.log(`🛒 Order with ${orderData.product_items.length} items`);
        } else {
          messageText = 'I want to place an order';
        }
      } else if (type === 'interactive') {
        // 🔘 INTERACTIVE MESSAGE - Button or List selection
        const interactive = message.interactive;
        if (interactive?.type === 'button_reply') {
          // Button click - use ID as action, title as display
          const buttonId = interactive.button_reply?.id || '';
          const buttonTitle = interactive.button_reply?.title || '';
          messageText = buttonTitle || buttonId;
          // Store button ID for proper routing (action & value metadata)
          (message as any)._buttonAction = buttonId;
          (message as any)._buttonValue = buttonId;
          this.logger.log(`🔘 Button click: id="${buttonId}", title="${buttonTitle}"`);
        } else if (interactive?.type === 'list_reply') {
          // List selection - use ID for item matching, title as fallback
          const listId = interactive.list_reply?.id || '';
          const listTitle = interactive.list_reply?.title || '';
          // Store list ID for proper routing
          (message as any)._buttonAction = listId;
          (message as any)._buttonValue = listId;
          // For food items, ID uses item_ID format (e.g., "item_10201")
          // Pass the item_ID directly as the message so the flow engine handles it
          // consistently with web (where card buttons also send "item_10201")
          if (listId.startsWith('item_')) {
            messageText = listId; // e.g., "item_10201" — matches web behavior
            this.logger.log(`📋 List selection (item): id="${listId}", title="${listTitle}"`);
          } else if (/^\d+$/.test(listId)) {
            // Legacy numeric ID — prefix with item_ for consistency
            messageText = `item_${listId}`;
            (message as any)._buttonAction = `item_${listId}`;
            (message as any)._buttonValue = `item_${listId}`;
            this.logger.log(`📋 List selection (numeric item): id="${listId}" → "item_${listId}", title="${listTitle}"`);
          } else {
            // For regular list options (like menu choices), use title
            messageText = listTitle || listId;
            this.logger.log(`📋 List selection (option): id="${listId}", title="${listTitle}"`);
          }
        } else if (interactive?.type === 'nfm_reply') {
          // 📋 WhatsApp Flow completion — user completed a Flow form
          let flowResponseData: Record<string, any> = {};
          try {
            flowResponseData = JSON.parse(interactive.nfm_reply?.response_json || '{}');
          } catch (e) {
            this.logger.warn('Failed to parse nfm_reply response_json');
          }
          const flowBody = interactive.nfm_reply?.body || '';
          messageText = flowBody || 'FLOW_COMPLETED';
          (message as any)._buttonAction = 'flow_response';
          (message as any)._buttonValue = JSON.stringify(flowResponseData);
          (message as any)._flowResponseData = flowResponseData;
          this.logger.log(`📋 WhatsApp Flow response: body="${flowBody}", data=${JSON.stringify(flowResponseData).substring(0, 200)}`);
        } else {
          messageText = interactive?.button_reply?.title || interactive?.list_reply?.title || '';
        }
      } else {
        // Extract text from other message types
        messageText = message.text?.body || '';
      }
      
      this.logger.log(`💬 WhatsApp message from ${from}: "${messageText}"`);

      // Get session data for user info
      const session = await this.sessionService.getSession(from);
      const userId = session?.data?.user_id;
      
      // 📍 Save location to session if it's a location message
      if (locationData) {
        await this.sessionService.setData(from, 'location', {
          lat: locationData.latitude,
          lng: locationData.longitude,
        });
        await this.sessionService.setData(from, 'lastLocationUpdate', Date.now());
        this.logger.log(`📍 Saved location to session: ${locationData.latitude}, ${locationData.longitude}`);
      }
      
      // MessageGateway handles conversation logging — no need to duplicate here

      // 🎯 UNIFIED ARCHITECTURE: Route through MessageGateway (Phase 1 refactor)
      this.logger.log(`🚀 Processing WhatsApp message through MessageGateway`);
      const isFlowResponse = (message as any)._buttonAction === 'flow_response';
      const result = await this.messageGateway.handleWhatsAppMessage(from, messageText, {
        messageId: message.id,
        // Map WhatsApp 'interactive' type → 'button_click' so ContextRouter skips NLU
        // Flow responses get special 'flow_response' type
        type: isFlowResponse ? 'flow_response' : (type === 'interactive' ? 'button_click' : message.type),
        isVoice: type === 'audio',
        location: locationData, // Pass location data to message gateway
        // Forward button/list IDs as action & value for proper ContextRouter routing
        action: (message as any)._buttonAction,
        value: (message as any)._buttonValue,
        // WhatsApp Flow response data (parsed from nfm_reply.response_json)
        ...(isFlowResponse && { flowResponseData: (message as any)._flowResponseData }),
      });
      
      this.logger.log(`✅ MessageGateway result: ${JSON.stringify(result)}`);

      // Response is handled by ContextRouter → MessagingService
      // No manual sending required anymore
      if (!result.success) {
        this.logger.error(`❌ Message processing failed: ${result.error}`);
      }
    } catch (error) {
      this.logger.error(`Error routing message:`, error);
      await this.messageService.sendTextMessage(
        from,
        "❌ Something went wrong. Please try again.",
      );
    }
  }

  /**
   * Handle voice message from WhatsApp
   * Downloads audio from Meta API and transcribes using ASR
   */
  private async handleVoiceMessage(message: any, from: string): Promise<string> {
    try {
      const audioId = message.audio?.id;
      if (!audioId) {
        this.logger.warn(`No audio ID in voice message`);
        return '';
      }

      // 1. Get media URL from Meta API
      const mediaUrl = await this.getWhatsAppMediaUrl(audioId);
      if (!mediaUrl) {
        this.logger.error(`Failed to get media URL for audio: ${audioId}`);
        return '';
      }

      // 2. Download audio from Meta (requires auth header)
      const audioBuffer = await this.downloadWhatsAppMedia(mediaUrl);
      if (!audioBuffer) {
        this.logger.error(`Failed to download audio: ${audioId}`);
        return '';
      }

      // 3. Transcribe using ASR service (with 15s timeout to avoid blocking if Mercury ASR is down)
      const transcription = await Promise.race([
        this.asrService.transcribe({
          audioData: audioBuffer,
          language: 'auto', // Auto-detect Hindi or English
          provider: 'auto',
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ASR transcription timed out after 15s')), 15000)),
      ]);

      this.logger.log(`🎤 Transcription complete: "${transcription.text}" (confidence: ${transcription.confidence}, language: ${transcription.language})`);

      // Check ASR confidence — reject low-quality transcriptions
      const confidenceThreshold = parseFloat(this.configService?.get('ASR_CONFIDENCE_THRESHOLD', '0.5') || '0.5');
      if (transcription.confidence !== undefined && transcription.confidence < confidenceThreshold) {
        this.logger.warn(`🎤 Low ASR confidence ${transcription.confidence} < ${confidenceThreshold} — rejecting transcription`);
        return '';
      }

      return transcription.text || '';
    } catch (error) {
      this.logger.error(`Voice message handling failed: ${error.message}`, error.stack);
      return '';
    }
  }

  /**
   * Get media URL from WhatsApp Media API
   */
  private async getWhatsAppMediaUrl(mediaId: string): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `https://graph.facebook.com/${this.graphApiVersion}/${mediaId}`,
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          },
        ),
      );
      return response.data?.url || null;
    } catch (error) {
      this.logger.error(`Failed to get media URL: ${error.message}`);
      return null;
    }
  }

  /**
   * Download media from WhatsApp CDN (requires auth)
   */
  private async downloadWhatsAppMedia(url: string): Promise<Buffer | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
          responseType: 'arraybuffer',
        }),
      );
      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error(`Failed to download media: ${error.message}`);
      return null;
    }
  }
}

