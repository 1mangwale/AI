import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { SessionService } from '../../session/session.service';
import { ConversationLoggerService } from '../../database/conversation-logger.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PhpAuthService } from '../../php-integration/services/php-auth.service';
import { OrderSyncService } from '../../personalization/order-sync.service';

/**
 * Input message structure for the gateway
 */
export interface MessageInput {
  identifier: string; // phone/userId/sessionId
  message: string;
  channel: 'whatsapp' | 'web' | 'telegram' | 'voice' | 'mobile' | 'instagram';
  metadata?: Record<string, any>;
  timestamp?: number;
}

/**
 * Response structure from the gateway (basic - for async channels)
 */
export interface MessageResponse {
  success: boolean;
  messageId: string;
  routedTo: string;
  error?: string;
}

/**
 * Response structure with content (for sync channels - Web, Voice, Mobile)
 */
export interface MessageResponseWithContent extends MessageResponse {
  response?: string;
  buttons?: Array<{ label: string; value: string; action?: string }>;
  cards?: any[];
  metadata?: Record<string, any>;
}

/**
 * Message event structure for Redis pub/sub
 */
export interface MessageEvent {
  messageId: string;
  identifier: string;
  message: string;
  channel: string;
  sessionId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

/**
 * MessageGateway - Single entry point for all channels
 * 
 * This service consolidates message handling from all 5 channels:
 * - WhatsApp (webhook)
 * - Web Chat (WebSocket)
 * - Telegram (webhook)
 * - Voice (Exotel/Nerve)
 * - Mobile App (REST)
 * 
 * Responsibilities:
 * 1. Normalize phone numbers and identifiers
 * 2. Deduplication (5-second window)
 * 3. Session management
 * 4. Conversation logging to PostgreSQL
 * 5. Route via ContextRouter (sync for Web/Voice/Mobile, async for WhatsApp/Telegram)
 */
@Injectable()
export class MessageGatewayService {
  private readonly logger = new Logger(MessageGatewayService.name);
  private readonly redis: Redis;
  private readonly redisPublisher: Redis;
  private readonly MESSAGE_CHANNEL = 'mangwale:messages';
  private readonly DEDUP_TTL = 2; // seconds - reduced from 5s for faster conversation flow
  private readonly DEDUP_PREFIX = 'dedup:';
  // Per-sender inbound flood limit. Separate concern from dedup above: dedup
  // drops the SAME message twice, this caps DIFFERENT messages from one sender.
  private readonly WA_RATE_PREFIX = 'wa:ratelimit:';
  private readonly WA_RATE_LIMIT: number;
  private readonly WA_RATE_WINDOW_MS: number;
  
  // Lazy-loaded ContextRouter to avoid circular dependency
  private contextRouter: any = null;

  constructor(
    private readonly sessionService: SessionService,
    private readonly conversationLogger: ConversationLoggerService,
    private readonly configService: ConfigService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly phpAuthService?: PhpAuthService,
    @Optional() private readonly orderSyncService?: OrderSyncService,
  ) {
    this.WA_RATE_LIMIT = Number(
      this.configService.get('WA_SENDER_RATE_LIMIT', 20),
    );
    this.WA_RATE_WINDOW_MS = Number(
      this.configService.get('WA_SENDER_RATE_WINDOW_MS', 60000),
    );

    // Initialize Redis clients
    const redisConfig = {
      host: this.configService.get('REDIS_HOST', 'redis'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    };

    this.redis = new Redis(redisConfig);
    this.redisPublisher = new Redis(redisConfig);

    this.logger.log('✅ MessageGateway initialized');
  }

  /**
   * Set the ContextRouter (called by module to avoid circular deps)
   */
  setContextRouter(router: any): void {
    this.contextRouter = router;
    this.logger.log('✅ ContextRouter connected to MessageGateway');
  }

  /**
   * Handle WhatsApp message
   * Normalizes phone number to E.164 format
   */
  async handleWhatsAppMessage(
    from: string,
    text: string,
    metadata?: any,
  ): Promise<MessageResponse> {
    const normalizedPhone = this.normalizePhoneNumber(from);
    
    return this.processMessage({
      identifier: normalizedPhone,
      message: text,
      channel: 'whatsapp',
      metadata: {
        ...metadata,
        rawPhone: from,
      },
    });
  }

  /**
   * Handle Web Chat (WebSocket) message - SYNC
   * Uses sessionId as identifier
   * Returns response WITH content for real-time display
   */
  async handleWebSocketMessage(
    sessionId: string,
    text: string,
    metadata?: any,
  ): Promise<MessageResponseWithContent> {
    // Read the actual platform from session instead of hardcoding 'web'
    const session = await this.sessionService.getSession(sessionId);
    const actualPlatform = session?.data?.platform || 'web';
    
    return this.processMessageSync({
      identifier: sessionId,
      message: text,
      channel: actualPlatform,  // Use actual platform from session
      metadata: {
        ...metadata,
        location: metadata?.location,
        action: metadata?.action,
        type: metadata?.type,
        value: metadata?.value, // Button value for flow transitions (e.g., 'popular', 'browse_menu')
      },
    });
  }

  /**
   * Handle Telegram message
   * Converts chatId to string identifier
   */
  async handleTelegramMessage(
    chatId: string | number,
    text: string,
    metadata?: any,
  ): Promise<MessageResponse> {
    return this.processMessage({
      identifier: `telegram:${chatId}`,
      message: text,
      channel: 'telegram',
      metadata: {
        ...metadata,
        rawChatId: chatId,
      },
    });
  }

  /**
   * Handle Instagram DM message
   * Uses Instagram-Scoped ID (IGSID) as identifier
   */
  async handleInstagramMessage(
    recipientId: string,
    text: string,
    metadata?: any,
  ): Promise<MessageResponse> {
    return this.processMessage({
      identifier: recipientId,
      message: text,
      channel: 'instagram',
      metadata: {
        ...metadata,
      },
    });
  }

  /**
   * Handle Voice message (Exotel/Nerve) - SYNC
   * Extracts phone from metadata, includes ASR confidence
   * Returns response WITH content for TTS
   */
  async handleVoiceMessage(
    callId: string,
    transcript: string,
    metadata?: any,
  ): Promise<MessageResponseWithContent> {
    const phone = metadata?.phone || metadata?.from;
    const normalizedPhone = phone ? this.normalizePhoneNumber(phone) : callId;

    return this.processMessageSync({
      identifier: normalizedPhone,
      message: transcript,
      channel: 'voice',
      metadata: {
        ...metadata,
        callId,
        asrConfidence: metadata?.confidence,
        language: metadata?.language,
      },
    });
  }

  /**
   * Handle Mobile App message - SYNC
   * Uses userId as identifier
   * Returns response WITH content for immediate display
   */
  async handleMobileMessage(
    userId: string,
    text: string,
    metadata?: any,
  ): Promise<MessageResponseWithContent> {
    return this.processMessageSync({
      identifier: userId,
      message: text,
      channel: 'mobile',
      metadata,
    });
  }

  /**
   * Core message processing pipeline
   * 
   * Steps:
   * 1. Deduplication check (5s window)
   * 2. Get/create session
   * 3. Update session with channel
   * 4. Log to PostgreSQL
   * 5. Publish to Redis pub/sub
   */
  private async processMessage(input: MessageInput): Promise<MessageResponse> {
    const startTime = Date.now();
    const messageId = `msg_${uuidv4()}`;

    // Record message received
    this.metricsService?.recordMessageReceived(input.channel);
    this.metricsService?.recordAsyncRouting(input.channel);

    try {
      // Step 1: Deduplication check
      if (await this.isDuplicate(input)) {
        this.logger.warn(`⚠️ Duplicate message blocked: ${input.identifier.substring(0, 10)}...`);
        this.metricsService?.recordDeduplication(input.channel);
        return {
          success: false,
          messageId,
          routedTo: 'dropped',
          error: 'Duplicate message',
        };
      }

      // Step 2: Get or create session
      let session = await this.sessionService.getSession(input.identifier);
      if (!session) {
        session = await this.sessionService.createSession(input.identifier);
      }

      // Step 2b: Auto-authenticate phone users (WhatsApp/Telegram)
      // This MUST happen before routing to ensure returning users are recognized
      await this.autoAuthenticatePhoneUser(input.identifier, input.channel, session);
      
      // Refresh session after potential auth update
      session = await this.sessionService.getSession(input.identifier);

      // Step 3: Update session with channel and metadata
      await this.sessionService.saveSession(input.identifier, {
        ...session,
        data: {
          ...session.data,
          platform: input.channel,
          lastMessageAt: new Date().toISOString(),
        },
      });

      // Step 4: Log to PostgreSQL
      await this.conversationLogger.logUserMessage({
        phone: input.identifier,
        messageText: input.message,
        platform: input.channel,
        sessionId: input.identifier, // Use identifier as sessionId
      });

      // Step 5: Publish to Redis pub/sub for routing
      const event: MessageEvent = {
        messageId,
        identifier: input.identifier,
        message: input.message,
        channel: input.channel,
        sessionId: input.identifier,
        timestamp: input.timestamp || Date.now(),
        metadata: input.metadata,
      };

      await this.publishToMessageBus(event);

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Message processed [${input.channel}] ${input.identifier.substring(0, 10)}... (${duration}ms)`,
      );

      // Record success metrics
      this.metricsService?.recordMessageProcessed(input.channel, 'default', 'success');
      this.metricsService?.recordProcessingDuration(input.channel, 'async', duration);
      this.metricsService?.recordRoute('message-bus', input.channel);

      return {
        success: true,
        messageId,
        routedTo: 'message-bus',
      };
    } catch (error) {
      this.logger.error(`❌ Message processing failed: ${error.message}`, error.stack);
      
      // Record error metrics
      this.metricsService?.recordMessageProcessed(input.channel, 'default', 'error');
      this.metricsService?.recordChannelError(input.channel, 'processing_error');

      return {
        success: false,
        messageId,
        routedTo: 'error',
        error: error.message,
      };
    }
  }

  /**
   * SYNC message processing pipeline - for Web, Voice, Mobile
   * Returns response WITH content for immediate display
   * 
   * Steps:
   * 1. Deduplication check (5s window)
   * 2. Get/create session
   * 3. Update session with channel
   * 4. Log to PostgreSQL
   * 5. Route SYNCHRONOUSLY via ContextRouter
   * 6. Return response with content
   */
  private async processMessageSync(input: MessageInput): Promise<MessageResponseWithContent> {
    const startTime = Date.now();
    const messageId = `msg_${uuidv4()}`;

    // Record message received
    this.metricsService?.recordMessageReceived(input.channel);
    this.metricsService?.recordSyncRouting(input.channel);

    try {
      // Step 1: Deduplication check (2s window)
      if (await this.isDuplicate(input)) {
        this.logger.warn(`⚠️ Duplicate message blocked: ${input.identifier.substring(0, 10)}... msg="${input.message?.substring(0, 20)}"`);
        this.metricsService?.recordDeduplication(input.channel);
        return {
          success: false,
          messageId,
          routedTo: 'dropped',
          error: 'Duplicate message',
        };
      }

      // Step 2: Get or create session
      let session = await this.sessionService.getSession(input.identifier);
      if (!session) {
        session = await this.sessionService.createSession(input.identifier);
      }

      // Step 3: Update session with channel and metadata
      await this.sessionService.saveSession(input.identifier, {
        ...session,
        data: {
          ...session.data,
          platform: input.channel,
          lastMessageAt: new Date().toISOString(),
        },
      });

      // Step 4: Log user message to PostgreSQL
      await this.conversationLogger.logUserMessage({
        phone: input.identifier,
        messageText: input.message,
        platform: input.channel,
        sessionId: input.identifier,
      });

      // Step 5: Route SYNCHRONOUSLY via ContextRouter
      const event: MessageEvent = {
        messageId,
        identifier: input.identifier,
        message: input.message,
        channel: input.channel,
        sessionId: input.identifier,
        timestamp: input.timestamp || Date.now(),
        metadata: input.metadata,
      };

      // Check if ContextRouter is available
      if (!this.contextRouter) {
        this.logger.error('❌ ContextRouter not connected! Using fallback response.');
        return {
          success: true,
          messageId,
          routedTo: 'fallback',
          response: "Hello! How can I help you today?",
          buttons: [
            { label: '🍕 Order Food', value: 'order_food' },
            { label: '📦 Book Parcel', value: 'book_parcel' },
            { label: '❓ Help', value: 'help' },
          ],
        };
      }

      // Get IMMEDIATE response from ContextRouter
      const routerResponse = await this.contextRouter.routeSync(event);

      // Defensive: ContextRouter should always return a RouterResponse,
      // but guard anyway to avoid crashing the chat API.
      if (!routerResponse || typeof routerResponse !== 'object') {
        const duration = Date.now() - startTime;
        this.logger.error(
          `❌ [SYNC] ContextRouter returned empty response [${input.channel}] ${input.identifier.substring(0, 10)}... (${duration}ms)`
        );

        this.metricsService?.recordMessageProcessed(input.channel, 'default', 'error');
        this.metricsService?.recordChannelError(input.channel, 'router_null_response');

        return {
          success: false,
          messageId,
          routedTo: 'error',
          error: 'ContextRouter returned empty response',
          response: "I'm sorry, something went wrong. Please try again.",
        };
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ [SYNC] Message processed [${input.channel}] ${input.identifier.substring(0, 10)}... (${duration}ms) → ${routerResponse.routedTo}`,
      );

      // Record success metrics
      this.metricsService?.recordMessageProcessed(input.channel, 'default', 'success');
      this.metricsService?.recordProcessingDuration(input.channel, routerResponse.routedTo, duration);
      this.metricsService?.recordRoute(routerResponse.routedTo, input.channel);

      // Step 6: Log bot response to PostgreSQL
      await this.conversationLogger.logBotMessage({
        phone: input.identifier,
        messageText: routerResponse.message,
        platform: input.channel,
        sessionId: input.identifier,
      });

      // Store in session for getBotMessages compatibility
      // Pass the object directly - storeBotMessage will JSON.stringify it
      await this.sessionService.storeBotMessage(input.identifier, {
        message: routerResponse.message,
        buttons: routerResponse.buttons,
        cards: routerResponse.cards,
        metadata: routerResponse.metadata,
        timestamp: Date.now(),
      });

      return {
        success: true,
        messageId,
        routedTo: routerResponse.routedTo,
        response: routerResponse.message,
        buttons: routerResponse.buttons,
        cards: routerResponse.cards,
        metadata: routerResponse.metadata,
      };
    } catch (error) {
      this.logger.error(`❌ Sync message processing failed: ${error.message}`, error.stack);

      // Record error metrics
      this.metricsService?.recordMessageProcessed(input.channel, 'default', 'error');
      this.metricsService?.recordChannelError(input.channel, 'sync_processing_error');

      return {
        success: false,
        messageId,
        routedTo: 'error',
        error: error.message,
        response: "I'm sorry, something went wrong. Please try again.",
      };
    }
  }

  /**
   * Check if message is duplicate within 2-second window
   * Uses Redis with TTL for automatic cleanup
   * 
   * 🔧 FIX: Skip dedup for button clicks - buttons like "1", "2" are often reused
   * across different flow states (e.g., pickup address "1" then delivery address "1").
   * The ChatGateway already has its own dedup to prevent true double-clicks.
   */
  /**
   * Per-sender inbound flood limit for WhatsApp.
   *
   * Returns true when this sender has exceeded WA_SENDER_RATE_LIMIT messages
   * inside the current WA_SENDER_RATE_WINDOW_MS window, and the caller should
   * drop the message.
   *
   * Keyed on the sender's phone number, NOT on req.ip. Inbound WhatsApp is
   * delivered by Meta's servers, so every customer on the platform shares one
   * source address (verified: 9,397/9,397 webhook hits arrive from the traefik
   * bridge 172.30.0.2). An IP bucket here is a global bucket.
   *
   * Fixed window, not sliding: one INCR plus one conditional EXPIRE, so a
   * flood costs one Redis round-trip per message. A sender can burst up to 2x
   * the limit across a window boundary; that is an acceptable trade for the
   * simplicity, because this is an abuse cap and not a billing quota.
   *
   * Fails OPEN. Redis also holds every session, so a Redis outage already
   * means the flow engine is dead; failing closed would silence the bot for
   * everyone rather than protect anything. Same posture as
   * WhatsAppOptOutService.isOptedOut().
   */
  async checkWaSenderRateLimit(phone: string): Promise<boolean> {
    if (!phone || this.WA_RATE_LIMIT <= 0) return false;

    // digits-only, matching WhatsAppOptOutService.key(), so +919999999999 /
    // 919999999999 / 9999999999 cannot become three different buckets.
    const digits = phone.replace(/\D/g, '');
    if (!digits) return false;

    const window = Math.floor(Date.now() / this.WA_RATE_WINDOW_MS);
    const key = `${this.WA_RATE_PREFIX}${digits}:${window}`;

    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        // +1s so the window cannot expire during its own final second.
        await this.redis.expire(
          key,
          Math.ceil(this.WA_RATE_WINDOW_MS / 1000) + 1,
        );
      }
      return count > this.WA_RATE_LIMIT;
    } catch (error) {
      this.logger.warn(
        `Rate-limit check failed, allowing message through: ${error?.message}`,
      );
      return false;
    }
  }

  private async isDuplicate(input: MessageInput): Promise<boolean> {
    // Skip dedup for button clicks - they can legitimately repeat the same value
    // in different flow states (e.g., address selection "1" for pickup then "1" for delivery)
    if (input.metadata?.type === 'button_click') {
      this.logger.debug(`⏭️ Skipping dedup for button_click: "${input.message?.substring(0, 20)}"`);
      return false;
    }
    
    const hash = this.generateMessageHash(input);
    const key = `${this.DEDUP_PREFIX}${hash}`;

    this.logger.debug(`🔍 Dedup check: msg="${input.message?.substring(0, 20)}", key=${key.substring(0, 40)}...`);

    const exists = await this.redis.get(key);

    if (exists) {
      this.logger.debug(`⚠️ Dedup HIT: found existing key for "${input.message?.substring(0, 20)}"`);
      return true;
    }

    // Set with TTL (automatically expires after 2 seconds)
    await this.redis.setex(key, this.DEDUP_TTL, '1');
    this.logger.debug(`✅ Dedup MISS: set key for "${input.message?.substring(0, 20)}"`);
    return false;
  }

  /**
   * Generate hash for deduplication
   * Hash = identifier + message + timestamp (5s window)
   */
  private generateMessageHash(input: MessageInput): string {
    const timestamp = input.timestamp || Date.now();
    const window = Math.floor(timestamp / (this.DEDUP_TTL * 1000));
    const data = `${input.identifier}:${input.message}:${window}`;

    // Simple hash using Buffer
    return createHash('sha256').update(data).digest('hex').substring(0, 32);
  }

  /**
   * Publish message event to Redis pub/sub
   * Includes retry logic with exponential backoff
   */
  private async publishToMessageBus(event: MessageEvent): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const published = await this.redisPublisher.publish(
          this.MESSAGE_CHANNEL,
          JSON.stringify(event),
        );

        if (published > 0) {
          this.logger.debug(`📤 Published to ${this.MESSAGE_CHANNEL}: ${event.messageId}`);
          return;
        }

        this.logger.warn(`⚠️ No subscribers on ${this.MESSAGE_CHANNEL}`);
        return;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          throw new Error(`Failed to publish after ${maxRetries} attempts: ${error.message}`);
        }

        // Exponential backoff: 100ms, 200ms, 400ms
        const delay = Math.pow(2, attempt) * 50;
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.logger.warn(`⚠️ Retry ${attempt}/${maxRetries} publishing to Redis...`);
      }
    }
  }

  /**
   * Normalize phone number to E.164 format
   * Examples:
   * - 9923383838 → +919923383838
   * - 919923383838 → +919923383838
   * - +919923383838 → +919923383838 (unchanged)
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters
    let digits = phone.replace(/\D/g, '');

    // Add country code if missing (assuming India +91)
    if (digits.length === 10) {
      digits = '91' + digits;
    }

    // Ensure it starts with country code (91 for India)
    if (!digits.startsWith('91') && digits.length === 12) {
      // If 12 digits but doesn't start with 91, might be another country
      // Keep as is
    } else if (digits.length === 10) {
      digits = '91' + digits;
    }

    // Return with + prefix (E.164 format)
    return '+' + digits;
  }

  /**
   * Auto-authenticate users on phone-based platforms (WhatsApp, Telegram)
   * This is called before routing to ensure returning users are authenticated
   * 
   * For new users: Marks session as is_new_user=true for onboarding flow
   * For existing users: Auto-logs them in with token from PHP backend
   *                     Also checks profile completeness to determine if onboarding is needed
   */
  private async autoAuthenticatePhoneUser(
    phone: string,
    channel: string,
    session: any,
  ): Promise<void> {
    // Only for phone-based platforms
    if (channel !== 'whatsapp' && channel !== 'telegram') {
      return;
    }

    // Skip if already authenticated AND onboarding is already completed
    // This preserves the session state after onboarding flow completes
    if (session?.data?.auth_token && session?.data?.onboarding_completed === true) {
      this.logger.log(`✅ User ${phone.substring(0, 10)}... already authenticated and onboarding complete`);
      return;
    }

    // Skip if we don't have phpAuthService
    if (!this.phpAuthService) {
      this.logger.warn(`⚠️ PhpAuthService not available, skipping auto-auth`);
      return;
    }

    try {
      this.logger.log(`🔐 Checking if user exists for auto-auth: ${phone}`);
      
      // Check if user exists - this now also attempts auto-login
      const userCheck = await this.phpAuthService.checkUserExists(phone);
      
      if (userCheck.exists && userCheck.data) {
        // EXISTING USER - checkUserExists already did auto-login
        this.logger.log(`✅ Existing user found: ${userCheck.data.f_name || 'Unknown'} (ID: ${userCheck.data.id})`);
        
        // Preserve existing session values if onboarding was already completed via flow
        // This handles the case where flow just set onboarding_completed: true
        const sessionOnboardingComplete = session?.data?.onboarding_completed === true;
        const sessionProfileCompleteness = session?.data?.profile_completeness;
        
        // Check profile completeness to decide if onboarding is needed
        // Users with <70% profile should still go through profile enhancement
        let profileComplete: boolean = sessionOnboardingComplete === true;
        let profileCompleteness = sessionProfileCompleteness || 100;
        
        // Only check PostgreSQL if we don't have onboarding already marked complete
        if (!sessionOnboardingComplete) {
          try {
            const profile = await this.checkUserProfileCompleteness(phone, userCheck.data.id);
            profileCompleteness = profile.completeness;
            profileComplete = profile.completeness >= 70;
            this.logger.log(`📊 Profile completeness: ${profileCompleteness}% (${profileComplete ? 'complete' : 'needs enhancement'})`);
          } catch (profileError) {
            this.logger.warn(`⚠️ Could not check profile completeness: ${profileError.message}`);
          }
        } else {
          this.logger.log(`📊 Using session values: profile_completeness=${profileCompleteness}, onboarding_completed=true`);
        }
        
        // If we got a token from checkUserExists, use it
        if (userCheck.data.token) {
          // Store auth data in session
          await this.sessionService.saveSession(phone, {
            ...session,
            data: {
              ...session.data,
              auth_token: userCheck.data.token,
              authenticated: true,
              user_id: userCheck.data.id,
              user_name: userCheck.data.f_name,
              user_phone: userCheck.data.phone || phone,
              is_new_user: false,
              onboarding_completed: profileComplete,
              profile_completeness: profileCompleteness,
            },
          });
          
          this.logger.log(`🎉 Auto-authenticated user ${userCheck.data.f_name || phone} on ${channel}`);
          
          // 📦 Async: Sync order history from MySQL → PostgreSQL for fast access
          if (this.orderSyncService && userCheck.data.token && userCheck.data.id) {
            this.orderSyncService.syncUserOrders(userCheck.data.id, userCheck.data.token)
              .catch(err => this.logger.warn(`⚠️ Order sync failed (non-blocking): ${err.message}`));
          }
        } else {
          // User exists but no token - try explicit auto-login
          const authResult = await this.phpAuthService.autoLogin(phone);
          
          if (authResult.success && authResult.data) {
            await this.sessionService.saveSession(phone, {
              ...session,
              data: {
                ...session.data,
                auth_token: authResult.data.token,
                authenticated: true,
                user_id: authResult.data.id,
                user_name: authResult.data.f_name,
                user_phone: authResult.data.phone,
                is_new_user: false,
                onboarding_completed: profileComplete,
                profile_completeness: profileCompleteness,
              },
            });
            
            this.logger.log(`🎉 Auto-authenticated user ${authResult.data.f_name || phone} on ${channel}`);
          } else {
            // User exists but auto-login API failed
            // Still mark as authenticated since we verified the user exists via MySQL
            // This allows them to order food without re-authenticating
            await this.sessionService.saveSession(phone, {
              ...session,
              data: {
                ...session.data,
                authenticated: true, // User is verified via MySQL lookup
                is_new_user: false,
                user_id: userCheck.data.id,
                user_name: userCheck.data.f_name,
                user_phone: userCheck.data.phone || phone,
                onboarding_completed: profileComplete,
                profile_completeness: profileCompleteness,
              },
            });
            this.logger.warn(`⚠️ Auto-login API failed but user verified via MySQL: ${userCheck.data.f_name} (ID: ${userCheck.data.id})`);
          }
        }
      } else {
        // NEW USER - Mark for onboarding
        // 🔧 FIX (2026-08-01): a phone that is not in MySQL yet may STILL have
        // completed chat onboarding (registration only happens at first order).
        // This branch used to write onboarding_completed: false on EVERY message,
        // clobbering the flag the onboarding flow just saved — the user was
        // re-onboarded in an endless loop until they typed an order sentence.
        const chatOnboarded = session?.data?.onboarding_completed === true;
        this.logger.log(`🆕 New user on ${channel}: ${phone}${chatOnboarded ? ' (chat onboarding already done — preserving)' : ''}`);
        await this.sessionService.saveSession(phone, {
          ...session,
          data: {
            ...session.data,
            is_new_user: true,
            onboarding_completed: chatOnboarded,
            profile_completeness: chatOnboarded ? (session?.data?.profile_completeness ?? 70) : 0,
          },
        });
      }
    } catch (error) {
      this.logger.error(`❌ Auto-auth check failed: ${error.message}`);
      // Don't fail the message - continue without auth
    }
  }

  /**
   * Check user profile completeness from PostgreSQL
   * Returns completeness percentage (0-100)
   */
  private async checkUserProfileCompleteness(
    phone: string,
    userId: number,
  ): Promise<{ completeness: number; missingFields: string[] }> {
    try {
      // Query PostgreSQL for user profile completeness
      // Use the conversation logger's pool since it already has PostgreSQL connection
      const pool = this.conversationLogger.getPool();
      if (!pool) {
        return { completeness: 100, missingFields: [] }; // Assume complete if can't check
      }
      
      const result = await pool.query(
        `SELECT 
          profile_completeness,
          dietary_type,
          favorite_cuisines,
          price_sensitivity,
          allergies
        FROM user_profiles 
        WHERE user_id = $1 OR phone = $2
        LIMIT 1`,
        [userId, phone]
      );
      
      if (result.rows.length === 0) {
        // No profile exists - needs onboarding
        return { completeness: 0, missingFields: ['dietary_type', 'favorite_cuisines', 'price_sensitivity'] };
      }
      
      const profile = result.rows[0];
      const missingFields: string[] = [];
      
      if (!profile.dietary_type) missingFields.push('dietary_type');
      if (!profile.favorite_cuisines || Object.keys(profile.favorite_cuisines).length === 0) {
        missingFields.push('favorite_cuisines');
      }
      if (!profile.price_sensitivity) missingFields.push('price_sensitivity');
      
      return {
        completeness: profile.profile_completeness || 0,
        missingFields,
      };
    } catch (error) {
      this.logger.warn(`Could not query profile completeness: ${error.message}`);
      return { completeness: 100, missingFields: [] }; // Assume complete on error
    }
  }

  /**
   * Graceful shutdown - close Redis connections
   */
  async onModuleDestroy() {
    await this.redis.quit();
    await this.redisPublisher.quit();
    this.logger.log('🔴 MessageGateway shut down');
  }
}
