import { Injectable, Logger, OnModuleInit, Inject, forwardRef, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from '../../redis/redis.module';
import { SessionService } from '../../session/session.service';
import { SessionSyncService } from '../../session/services/session-sync.service';
import { CommandHandlerService, IntentClassification } from './command-handler.service';
import { MessageEvent } from './message-gateway.service';
import { FlowEngineService } from '../../flow-engine/flow-engine.service';
import { AgentOrchestratorService } from '../../agents/services/agent-orchestrator.service';
import { IndicBERTService } from '../../nlu/services/indicbert.service';
import { IntentClassifierService } from '../../nlu/services/intent-classifier.service';
import { ModuleType } from '../../agents/types/agent.types';
import { MessagingService } from './messaging.service';
import { Platform } from '../../common/enums/platform.enum';
import { MetricsService } from '../../metrics/metrics.service';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';
import { IntentRouterService, RouteDecision } from './intent-router.service';
import { SearchAnalyticsService } from '../../search/services/search-analytics.service';
import { PhpOrderService } from '../../php-integration/services/php-order.service';
import { PhpWishlistService } from '../../php-integration/services/php-wishlist.service';
import { PhpLoyaltyService } from '../../php-integration/services/php-loyalty.service';
import { PhpReviewService } from '../../php-integration/services/php-review.service';
import { PhpCouponService } from '../../php-integration/services/php-coupon.service';
import { UserPreferenceService } from '../../personalization/user-preference.service';

/**
 * Router Response - returned for SYNC channels (Web, Voice, Mobile)
 */
export interface RouterResponse {
  message: string;
  buttons?: Array<{ label: string; value: string; action?: string }>;
  cards?: any[];
  metadata?: Record<string, any>;
  routedTo: 'command' | 'flow' | 'agent' | 'greeting' | 'direct';
  intent?: IntentClassification;
}

/**
 * ContextRouter Service
 * 
 * Smart routing logic that decides where to send each message:
 * 
 * 5-Step Routing Process:
 * 1. User Type Detection (if not cached)
 * 2. ALWAYS Run NLU (no bypass!)
 * 3. Check for Command Intents (cancel, help, etc.) - HIGHEST PRIORITY
 * 4. Continue Active Flow (with intent awareness)
 * 5. Start New Flow or Fallback to Agent
 * 
 * HYBRID ARCHITECTURE:
 * - ASYNC channels (WhatsApp, Telegram): Use Redis pub/sub, fire-and-forget
 * - SYNC channels (Web, Voice, Mobile): Use routeSync() for immediate response
 */
@Injectable()
export class ContextRouterService implements OnModuleInit {
  private readonly logger = new Logger(ContextRouterService.name);
  private readonly MESSAGE_CHANNEL = 'mangwale:messages';
  private readonly ROUTE_DEDUP_TTL = 10; // seconds - prevent duplicate processing of same messageId
  private readonly ROUTE_DEDUP_PREFIX = 'route_lock:';

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionSyncService: SessionSyncService,
    private readonly commandHandler: CommandHandlerService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => FlowEngineService))
    private readonly flowEngineService: FlowEngineService,
    @Inject(forwardRef(() => AgentOrchestratorService))
    private readonly agentOrchestrator: AgentOrchestratorService,
    private readonly messagingService: MessagingService,
    private readonly intentRouter: IntentRouterService,
    @Inject(REDIS_SUBSCRIBER) private readonly redis: Redis,
    @Inject(REDIS_CLIENT) private readonly redisDedup: Redis,
    @Optional() private readonly whatsappService?: WhatsAppCloudService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly indicBertService?: IndicBERTService,
    @Optional() private readonly intentClassifierService?: IntentClassifierService,
    @Optional() private readonly searchAnalytics?: SearchAnalyticsService,
    @Optional() private readonly phpOrderService?: PhpOrderService,
    @Optional() private readonly phpWishlistService?: PhpWishlistService,
    @Optional() private readonly phpLoyaltyService?: PhpLoyaltyService,
    @Optional() private readonly phpReviewService?: PhpReviewService,
    @Optional() private readonly phpCouponService?: PhpCouponService,
    @Optional() private readonly userPreferenceService?: UserPreferenceService,
  ) {
    this.logger.log('✅ ContextRouter initialized with shared Redis');
  }

  /**
   * Safely preview any value without assuming string methods exist.
   */
  private preview(value: unknown, length: number = 30): string {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.substring(0, length);
    } catch {
      return '<unserializable>';
    }
  }

  async onModuleInit() {
    // Subscribe to message bus
    await this.redis.subscribe(this.MESSAGE_CHANNEL);

    this.redis.on('message', async (channel, message) => {
      if (channel === this.MESSAGE_CHANNEL) {
        try {
          const event: MessageEvent = JSON.parse(message);
          await this.route(event);
        } catch (error) {
          this.logger.error(`❌ Error routing message: ${error.message}`, error.stack);
        }
      }
    });

    this.logger.log(`✅ ContextRouter subscribed to ${this.MESSAGE_CHANNEL}`);
  }

  /**
   * Main routing logic - 5 steps (ASYNC - for WhatsApp/Telegram)
   * Used when messages come via Redis pub/sub
   */
  async route(event: MessageEvent): Promise<void> {
    const startTime = Date.now();

    this.logger.log(
      `📨 [ASYNC] Routing message [${event.channel}] ${this.preview(event.identifier, 10)}... "${this.preview(event.message, 30)}..."`,
    );

    try {
      // 🔒 DEDUP GUARD: Acquire a lock on this messageId so only ONE subscriber processes it.
      // This prevents duplicate sends when multiple backend instances subscribe to the same
      // Redis pub/sub channel (e.g., dev + production, or after a restart with stale connections).
      const lockKey = `${this.ROUTE_DEDUP_PREFIX}${event.messageId}`;
      const acquired = await this.redisDedup.set(lockKey, '1', 'EX', this.ROUTE_DEDUP_TTL, 'NX');
      if (!acquired) {
        this.logger.warn(`⚠️ [DEDUP] Skipping duplicate route for messageId=${event.messageId} — already being processed by another instance`);
        return;
      }

      // Get session
      const session = await this.sessionService.getSession(event.identifier);
      if (!session) {
        this.logger.warn(`⚠️ Session not found for ${event.identifier}`);
        return;
      }

      // Use shared routing logic
      const response = await this.routeInternal(event, session);

      // For async channels, send response via MessagingService
      await this.sendAsyncResponse(event, response);
      
      this.logRoutingDecision(response.routedTo, startTime);
    } catch (error) {
      this.logger.error(`❌ Routing failed: ${error.message}`, error.stack);
      // Send fallback error message to user so they know something went wrong
      try {
        if (event.channel === 'whatsapp' && this.whatsappService) {
          await this.whatsappService.sendText(
            event.identifier,
            "Sorry, something went wrong processing your message. Please try again.",
          );
        }
      } catch (fallbackErr) {
        this.logger.error(`❌ Even fallback message failed: ${fallbackErr.message}`);
      }
    }
  }

  /**
   * SYNC routing - for Web Chat, Voice, Mobile
   * Returns response IMMEDIATELY for real-time channels
   */
  async routeSync(event: MessageEvent): Promise<RouterResponse> {
    const startTime = Date.now();

    this.logger.log(
      `📨 [SYNC] Routing message [${event.channel}] ${this.preview(event.identifier, 10)}... "${this.preview(event.message, 30)}..."`,
    );

    try {
      // Get session
      let session = await this.sessionService.getSession(event.identifier);
      if (!session) {
        session = await this.sessionService.createSession(event.identifier);
      }

      // Use shared routing logic
      const response = await this.routeInternal(event, session);

      // Safety check: ensure response is valid
      if (!response || !response.routedTo) {
        this.logger.warn(`⚠️ routeInternal returned null/invalid response, using fallback`);
        return {
          message: "I'm here to help! What would you like to do?",
          routedTo: 'greeting',
          buttons: this.getMainMenuButtons(),
        };
      }

      this.logRoutingDecision(response.routedTo, startTime);
      return response;
    } catch (error) {
      this.logger.error(`❌ Sync routing failed: ${error.message}`, error.stack);
      return {
        message: "I'm sorry, something went wrong. Please try again.",
        routedTo: 'agent',
        metadata: { error: error.message },
      };
    }
  }

  /**
   * Internal routing logic - shared by both sync and async paths
   * This is where the 5-step magic happens!
   */
  private async routeInternal(event: MessageEvent, session: any): Promise<RouterResponse> {
    // STEP 0: Check for first-time user onboarding (WhatsApp/Telegram)
    // If user was just auto-registered and hasn't completed onboarding, trigger it
    if (await this.shouldTriggerOnboarding(event, session)) {
      const onboardingResponse = await this.startOnboardingFlow(event, session);
      if (onboardingResponse) {
        return onboardingResponse;
      }
      // If onboarding failed, continue with normal flow
    }

    // 🔄 GAP 4 FIX: Sync session state (Redis ↔ DB) before routing
    // This ensures we have the correct active flow state even if Redis expired
    const activeFlowInfo = await this.sessionSyncService.getActiveFlow(event.identifier);
    if (activeFlowInfo?.outOfSync) {
      this.logger.log(`🔄 Session sync: recovered flow state for ${event.identifier}`);
      // Refresh session to get the synced data
      session = await this.sessionService.getSession(event.identifier);
    }

    // 📚 SEARCH HISTORY: Add last search to context for "show me that again"
    if (session.data?.userId && this.searchAnalytics) {
      try {
        const lastSearch = await this.searchAnalytics.getLastSearch(String(session.data.userId));
        
        if (lastSearch) {
          session.data._last_search = {
            query: lastSearch.query,
            resultsCount: lastSearch.resultsCount,
            filters: lastSearch.filters,
            timestamp: lastSearch.timestamp,
          };
          this.logger.debug(`📚 Added last search to context: "${lastSearch.query}"`);
        }
      } catch (error) {
        this.logger.warn(`⚠️ Failed to fetch search history: ${error.message}`);
      }
    }

    // STEP 1: User Type Detection (if not cached)
    if (!session.data?.userType) {
      await this.detectUserType(event, session);
      // Refresh session after update
      session = await this.sessionService.getSession(event.identifier);
    }

    // 2B: Check for pending refund — user was asked to type a reason
    const pendingRefundOrderId = session.data?.pendingRefundOrderId;
    const hasActiveFlow = activeFlowInfo?.flowId || session.data?.activeFlow || session.data?.flowContext?.flowId;
    if (pendingRefundOrderId && !hasActiveFlow && event.message && event.message.length > 2) {
      const authToken = session.data?.auth_token;
      if (authToken && this.phpOrderService) {
        // Clear pending state immediately
        await this.sessionService.updateSession(event.identifier, { pendingRefundOrderId: null });
        try {
          const reason = event.message;
          const result = await this.phpOrderService.requestRefund(authToken, pendingRefundOrderId, reason, reason, 'wallet');
          if (result?.success) {
            return {
              message: `✅ **Refund request submitted!**\n\nOrder #${pendingRefundOrderId}\nReason: ${reason}\n\nWe'll process your refund to your wallet soon.`,
              buttons: [
                { label: 'My Orders', value: 'my orders', action: 'track_order' },
                ...this.getMainMenuButtons().slice(0, 2),
              ],
              routedTo: 'direct',
              intent: { intent: 'request_refund', confidence: 1.0 },
              metadata: { handler: 'request_refund_executed', orderId: pendingRefundOrderId },
            };
          }
          return {
            message: `❌ Refund request failed: ${result?.message || 'Unknown error'}`,
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
          };
        } catch (e) {
          this.logger.warn(`Refund submission failed: ${e.message}`);
          return {
            message: `❌ Could not submit refund: ${e.message}`,
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
          };
        }
      }
    }

    // STEP 2: Check if we should SKIP NLU for button clicks in active flows
    // Button actions like "razor_pay", "use_my_details", "confirm" should go directly to flow
    // 🔄 GAP 4: Use synced activeFlowInfo instead of raw session check
    const activeFlow = activeFlowInfo?.flowId || session.data?.activeFlow || session.data?.flowContext?.flowId;
    // A button click is detected when type='button_click' is set in metadata.
    // We intentionally do NOT require 'action' — payment selection buttons only have 'value'
    // (e.g. "wallet", "cash_on_delivery") and would otherwise fall through to NLU misclassification.
    const isButtonClick = event.metadata?.type === 'button_click' && (event.metadata?.action || event.metadata?.value);

    // 🎯 OPTIMIZATION: For button clicks within active flows, skip NLU entirely
    // The flow engine knows what buttons it showed and expects specific actions
    if (activeFlow && isButtonClick) {
      const buttonAction = event.metadata.action;
      // 🔧 FIX: Extract button VALUE from message or metadata for flow transition
      // Button value is what the flow expects as event (e.g., 'popular', 'browse_menu')
      // The action is the button ID (e.g., 'btn_popular'), but value is the transition event
      const buttonValue = event.metadata.value || event.message?.toLowerCase();
      this.logger.log(`🔘 Button click in active flow - action: ${buttonAction || '(none)'}, value: ${buttonValue}`);

      // Use a synthetic intent that won't trigger command handlers
      const flowContinueIntent = { intent: 'flow_input', confidence: 1.0 };

      // Special case: Only allow explicit cancel button clicks to cancel
      if (buttonAction === 'cancel' || buttonValue === 'cancel') {
        return this.handleCommandSync(event, session, { intent: 'cancel', confidence: 1.0 });
      }

      // 🔧 FIX: Top-level navigation buttons ALWAYS break out of any active flow.
      // e.g. clicking "Book Parcel" while food_order_v1 is active should start parcel flow,
      // NOT continue the food flow with 'book_parcel' as a flow event.
      // These are the action values sent by getMainMenuButtons() and any top-level CTA.
      const TOP_LEVEL_ACTIONS = new Set([
        'order_food', 'book_parcel', 'track_order', 'help',
        'parcel_booking', 'send_parcel', 'order_tracking',
        'main_menu', 'go_home',
        // Rating/review actions always break out of any active flow
        'rate_order', 'submit_review', 'leave_review',
      ]);
      // These actions are top-level ONLY when they arrive while a PARCEL flow is active.
      // When in food/ecommerce flows, checkout/view_cart/browse_menu are handled by the flow itself.
      const PARCEL_ONLY_BREAK_ACTIONS = new Set(['checkout', 'view_cart', 'browse_menu']);
      const isParcelFlow = activeFlow?.includes('parcel');
      if (TOP_LEVEL_ACTIONS.has(buttonAction) || (isParcelFlow && PARCEL_ONLY_BREAK_ACTIONS.has(buttonAction))) {
        this.logger.log(`🔀 Top-level button "${buttonAction}" while in flow ${activeFlow} — clearing flow and routing fresh`);
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
        session = await this.sessionService.getSession(event.identifier);

        // After clearing flow, handle rating actions directly (IntentRouter would misclassify them)
        if (buttonAction === 'rate_order' || buttonAction === 'submit_review' || buttonAction === 'leave_review') {
          return {
            message: `⭐ **How was your order?**\n\nTap a star to rate:`,
            buttons: [
              { label: '⭐ 1 Star', value: 'rating_1', action: 'rate_order' },
              { label: '⭐⭐ 2 Stars', value: 'rating_2', action: 'rate_order' },
              { label: '⭐⭐⭐ 3 Stars', value: 'rating_3', action: 'rate_order' },
              { label: '⭐⭐⭐⭐ 4 Stars', value: 'rating_4', action: 'rate_order' },
              { label: '⭐⭐⭐⭐⭐ 5 Stars', value: 'rating_5', action: 'rate_order' },
            ],
            routedTo: 'direct',
            intent: { intent: 'rate_order', confidence: 1.0 },
            metadata: { handler: 'submit_review' },
          };
        }

        const routeDecision = await this.intentRouter.route(buttonAction, event.message || buttonAction, {
          hasActiveFlow: false,
          isAuthenticated: session.data?.authenticated === true,
          channel: event.channel || 'web',
        });
        const buttonIntent = { intent: routeDecision.translatedIntent, confidence: 1.0, routeDecision };
        const flowResponse = await this.startNewFlowSync(event, session, buttonIntent);
        if (flowResponse) return flowResponse;
        return this.executeAgentSync(event, session, buttonIntent);
      }

      // 🔧 FIX: Card "Add to cart" buttons send action=item_XXXX but message=item name or "Add".
      // The flow checks _user_message (= event.message) with /^item_\d+/ regex.
      // Override event.message with the action so _user_message matches the selection pattern.
      if (/^item_\d+$/i.test(buttonAction)) {
        event.message = buttonAction;
        this.logger.log(`🛒 Item selection override: _user_message set to "${buttonAction}" (was "${buttonValue}")`);
      }

      // 🔧 FIX: Handle ParcelCard button actions within active flow.
      // Without this, "edit_parcel" falls through to NLU and gets misclassified as "clear_cart".
      // Map these actions to flow-recognized events.
      if (buttonAction === 'edit_parcel') {
        this.logger.log(`📦 edit_parcel action — passing to flow as edit_parcel event`);
        event.message = 'edit_parcel';
        return this.continueFlowSync(event, session, flowContinueIntent, 'edit_parcel');
      }
      if (buttonAction === 'confirm_parcel') {
        this.logger.log(`📦 confirm_parcel action — mapping to "yes" for flow confirmation`);
        event.message = 'yes';
        return this.continueFlowSync(event, session, flowContinueIntent, 'yes');
      }

      // Continue the flow with the button VALUE as the event for correct transition
      return this.continueFlowSync(event, session, flowContinueIntent, buttonValue);
    }
    
    // 🔧 FIX: Handle button clicks WITHOUT active flow (e.g., after auth flow ends)
    // When user clicks a button like "Send Parcel" after auth completes, 
    // use the button action directly as intent instead of NLU classification
    // This prevents misclassification bugs like parcel_booking → manage_address
    if (!activeFlow && isButtonClick) {
      const buttonAction = event.metadata.action;
      this.logger.log(`🔘 Button click without active flow - using action as intent: ${buttonAction}`);
      
      // Special case: Handle cancel
      if (buttonAction === 'cancel' || event.message?.toLowerCase() === 'cancel') {
        return this.handleCommandSync(event, session, { intent: 'cancel', confidence: 1.0 });
      }

      // 2A: Handle cancel order confirmation (user clicked "Cancel #123" button)
      const cancelMatch = (event.metadata?.value || '')?.match?.(/^cancel_order_(\d+)$/);
      if (buttonAction === 'cancel_order' && cancelMatch) {
        const orderId = parseInt(cancelMatch[1]);
        const authToken = session.data?.auth_token;
        if (!authToken) {
          return { message: 'Please login first.', buttons: [{ label: 'Login', value: 'login', action: 'login' }], routedTo: 'direct' };
        }
        try {
          // Fetch cancellation reasons from PHP
          const reasonsResult = await this.phpOrderService?.getCancellationReasons();
          const reasons = reasonsResult?.reasons || [
            { id: 1, reason: 'Changed my mind' },
            { id: 2, reason: 'Taking too long' },
            { id: 3, reason: 'Ordered by mistake' },
          ];

          // Store pending cancel in session for follow-up
          await this.sessionService.updateSession(event.identifier, {
            pendingCancelOrderId: orderId,
          });

          const reasonButtons = reasons.slice(0, 3).map((r: any) => ({
            label: r.reason,
            value: `cancel_reason_${r.id}_${orderId}`,
            action: 'cancel_reason',
          }));

          return {
            message: `**Cancel Order #${orderId}**\n\nPlease select a reason:`,
            buttons: [...reasonButtons, { label: 'Go Back', value: 'menu', action: 'menu' }],
            routedTo: 'direct',
            intent: { intent: 'cancel_order', confidence: 1.0 },
            metadata: { handler: 'cancel_order_confirm', orderId },
          };
        } catch (e) {
          this.logger.warn(`cancel_order execution failed: ${e.message}`);
          return { message: 'Failed to cancel order. Please try again.', buttons: this.getMainMenuButtons(), routedTo: 'direct' };
        }
      }

      // 2A continued: Handle cancel reason selection → execute cancellation
      const cancelReasonMatch = (event.metadata?.value || '')?.match?.(/^cancel_reason_(\d+)_(\d+)$/);
      if (buttonAction === 'cancel_reason' && cancelReasonMatch) {
        const orderId = parseInt(cancelReasonMatch[2]);
        const authToken = session.data?.auth_token;
        if (!authToken) {
          return { message: 'Please login first.', buttons: [{ label: 'Login', value: 'login', action: 'login' }], routedTo: 'direct' };
        }
        try {
          const reason = event.message || 'Customer requested cancellation';
          const result = await this.phpOrderService?.cancelOrder(authToken, orderId, reason);
          if (result?.success) {
            await this.sessionService.updateSession(event.identifier, { pendingCancelOrderId: null });
            return {
              message: `✅ **Order #${orderId} has been cancelled.**\n\nYour refund (if applicable) will be processed.`,
              buttons: [
                { label: 'My Orders', value: 'my orders', action: 'track_order' },
                ...this.getMainMenuButtons().slice(0, 2),
              ],
              routedTo: 'direct',
              intent: { intent: 'cancel_order', confidence: 1.0 },
              metadata: { handler: 'cancel_order_executed', orderId },
            };
          }
          return {
            message: `❌ Could not cancel order #${orderId}: ${result?.message || 'Unknown error'}`,
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
          };
        } catch (e) {
          return { message: `Failed to cancel: ${e.message}`, buttons: this.getMainMenuButtons(), routedTo: 'direct' };
        }
      }

      // 2D: Handle loyalty points conversion (user clicked "Convert All" button)
      const convertMatch = (event.metadata?.value || '')?.match?.(/^convert_points_(\d+)$/);
      if (buttonAction === 'convert_points' && convertMatch) {
        const points = parseInt(convertMatch[1]);
        const authToken = session.data?.auth_token;
        if (!authToken) {
          return { message: 'Please login first.', buttons: [{ label: 'Login', value: 'login', action: 'login' }], routedTo: 'direct' };
        }
        try {
          const result = await this.phpLoyaltyService?.convertPointsToWallet(authToken, points);
          if (result?.success) {
            return {
              message: `✅ **${points} points converted!**\n\n💰 ₹${result.amount_added?.toFixed(2) || '0'} added to wallet.\n💼 New balance: ₹${result.new_balance?.toFixed(2) || '0'}`,
              buttons: [
                { label: 'Check Wallet', value: 'check wallet', action: 'check_wallet' },
                ...this.getMainMenuButtons().slice(0, 2),
              ],
              routedTo: 'direct',
              intent: { intent: 'transfer_points', confidence: 1.0 },
              metadata: { handler: 'transfer_points_executed', points },
            };
          }
          return {
            message: `❌ Could not convert points: ${result?.message || 'Unknown error'}`,
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
          };
        } catch (e) {
          return { message: `Failed to convert points: ${e.message}`, buttons: this.getMainMenuButtons(), routedTo: 'direct' };
        }
      }

      // 2C: Handle star rating button click → submit review to PHP
      if (buttonAction === 'rate_order' || buttonAction === 'submit_review' || buttonAction === 'leave_review') {
        const ratingMatch = (event.metadata?.value || event.message || '')?.match?.(/rating_(\d)/);
        if (ratingMatch) {
          const ratingValue = parseInt(ratingMatch[1]);
          const authToken = session.data?.auth_token;
          const stars = '⭐'.repeat(ratingValue) + '☆'.repeat(5 - ratingValue);

          // Try to submit to PHP backend
          if (authToken && this.phpReviewService && this.phpOrderService) {
            try {
              // Get the last delivered order to attach review to
              const orders = await this.phpOrderService.getOrders(authToken, 3, 1);
              const delivered = (orders || []).find((o: any) =>
                o.orderStatus === 'delivered' || o.order_status === 'delivered',
              );
              if (delivered) {
                await this.phpReviewService.submitItemReview(authToken, 0, delivered.id, ratingValue, '');
                this.logger.log(`✅ Review submitted: ${ratingValue} stars for order #${delivered.id}`);
              }
            } catch (e) {
              this.logger.warn(`Review submit failed (non-blocking): ${e.message}`);
            }
          }

          return {
            message: `${stars} **Thank you for your ${ratingValue}-star rating!**\n\nYour feedback helps us improve.`,
            buttons: [
              { label: 'Order Again', value: 'order food', action: 'order_food' },
              ...this.getMainMenuButtons().slice(0, 2),
            ],
            routedTo: 'direct',
            intent: { intent: 'rate_order', confidence: 1.0 },
            metadata: { handler: 'submit_review_executed', ratingValue },
          };
        }

        // No rating value matched → show star buttons
        return {
          message: `⭐ **How was your order?**\n\nTap a star to rate:`,
          buttons: [
            { label: '⭐ 1 Star', value: 'rating_1', action: 'rate_order' },
            { label: '⭐⭐ 2 Stars', value: 'rating_2', action: 'rate_order' },
            { label: '⭐⭐⭐ 3 Stars', value: 'rating_3', action: 'rate_order' },
            { label: '⭐⭐⭐⭐ 4 Stars', value: 'rating_4', action: 'rate_order' },
            { label: '⭐⭐⭐⭐⭐ 5 Stars', value: 'rating_5', action: 'rate_order' },
          ],
          routedTo: 'direct',
          intent: { intent: 'rate_order', confidence: 1.0 },
          metadata: { handler: 'submit_review' },
        };
      }

      // Use button action as the intent (e.g., 'parcel_booking', 'order_food')
      // Get proper flow routing from IntentRouter
      const routeDecision = await this.intentRouter.route(buttonAction, event.message || buttonAction, {
        hasActiveFlow: false,
        isAuthenticated: session.data?.authenticated === true,
        channel: event.channel || 'web',
      });
      
      const buttonIntent = {
        intent: routeDecision.translatedIntent,
        confidence: 1.0, // High confidence since it's an explicit button click
        routeDecision,
      };
      
      this.logger.log(`🎯 Button intent routed: ${buttonAction} → ${routeDecision.flowId || routeDecision.translatedIntent}`);
      
      // Start the appropriate flow
      const flowResponse = await this.startNewFlowSync(event, session, buttonIntent);
      if (flowResponse) {
        return flowResponse;
      }
      
      // Fallback to agent if no flow matched
      return this.executeAgentSync(event, session, buttonIntent);
    }
    
    // STEP 2b: Run NLU for text messages
    const intent = await this.classifyIntent(event, session);

    this.logger.log(
      `🧠 NLU Result: intent="${intent.intent}" confidence=${intent.confidence.toFixed(2)}`,
    );

    // STEP 3: Check for Command Intents (Highest Priority)
    // BUT NOT if user is in an active flow with low-confidence classification
    // NOTE: 'help' is NOT a command intent - it goes to the AI agent for natural responses
    if (this.commandHandler.isCommandIntent(intent.intent)) {
      // If in active flow, require explicit commands or high confidence
      if (activeFlow) {
        const msg = event.message?.toLowerCase() || '';
        
        // For cancel: require explicit cancel words
        if (intent.intent === 'cancel') {
          const isExplicitCancel = msg.match(/^(cancel|nahi|no|stop|exit|quit|band|ruk)$/);
          if (!isExplicitCancel) {
            this.logger.log(`⚠️ Ignoring NLU "cancel" in active flow - message "${msg}" is not explicit cancel`);
            return this.continueFlowSync(event, session, intent);
          }
        }
        
        // 🔧 FIX: For menu with LOW confidence, let the flow handle it
        // User might be asking a follow-up question that NLU misclassified
        if (['menu', 'main_menu'].includes(intent.intent) && intent.confidence < 0.6) {
          this.logger.log(`⚠️ Low confidence "${intent.intent}" (${intent.confidence.toFixed(2)}) in active flow - letting flow handle it`);
          return this.continueFlowSync(event, session, intent);
        }
        
        // Also skip if message is clearly a follow-up question about displayed results
        const isFollowUpQuestion = /\b(how far|distance|nearest|closest|kitna dur|dur hai|near me|paas|which one|konsa)\b/i.test(msg);
        if (isFollowUpQuestion) {
          this.logger.log(`🔍 Follow-up question detected in active flow - letting flow handle: "${msg.substring(0, 50)}..."`);
          return this.continueFlowSync(event, session, intent);
        }
      }
      return this.handleCommandSync(event, session, intent);
    }

    // STEP 4a: Direct response intents (wallet, etc.) - handle BEFORE flow continuation
    // These are informational queries that don't need a flow — respond directly
    if (intent.intent === 'check_wallet') {
      // Don't break out if user is in the middle of payment selection — "wallet" is a button value
      const currentFlowState = session.data?.flowContext?.currentState;
      const PAYMENT_SENSITIVE_STATES = [
        'wait_payment_selection', 'collect_payment_method', 'collect_payment_method_fallback',
        'select_payment_method', 'check_wallet_balance', 'decide_wallet_payment',
        'show_wallet_empty', 'show_partial_payment_option',
      ];
      if (activeFlow && PAYMENT_SENSITIVE_STATES.includes(currentFlowState)) {
        this.logger.log(`🔒 In payment state (${currentFlowState}) - NOT breaking out for check_wallet, letting flow handle`);
        return this.continueFlowSync(event, session, intent, event.message?.toLowerCase());
      }

      // If in active flow, clear it so user can continue after seeing wallet
      if (activeFlow) {
        this.logger.log(`💰 Breaking out of ${activeFlow} for wallet balance query`);
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }
      
      const walletBalance = session.data?.wallet_balance ?? 0;
      const loyaltyPoints = session.data?.loyalty_points ?? 0;
      
      let walletMessage = `💰 **Wallet Balance**\n\n`;
      if (walletBalance > 0) {
        walletMessage += `Your wallet balance is **₹${Number(walletBalance).toFixed(2)}**`;
        if (loyaltyPoints > 0) {
          walletMessage += `\n🎯 Loyalty Points: **${loyaltyPoints}**`;
        }
        walletMessage += `\n\nYou can use your wallet balance for your next order! 🎉`;
      } else {
        walletMessage += `Your wallet balance is **₹0.00**`;
        if (loyaltyPoints > 0) {
          walletMessage += `\n🎯 Loyalty Points: **${loyaltyPoints}**`;
        }
        walletMessage += `\n\nYou can add money to your wallet or earn cashback on orders!`;
      }
      
      return {
        message: walletMessage,
        buttons: this.getMainMenuButtons(),
        routedTo: 'direct',
        intent,
        metadata: { handler: 'check_wallet', walletBalance, loyaltyPoints },
      };
    }

    // STEP 4a-2: Loyalty points direct response
    if (intent.intent === 'check_loyalty_points' || intent.intent === 'loyalty_points') {
      if (activeFlow) {
        this.logger.log(`🎯 Breaking out of ${activeFlow} for loyalty points query`);
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const loyaltyPoints = session.data?.loyalty_points ?? 0;
      const walletBalance = session.data?.wallet_balance ?? 0;

      let message = `🎯 **Loyalty Points**\n\n`;
      if (loyaltyPoints > 0) {
        message += `You have **${loyaltyPoints} loyalty points**!\n\nYou earn points on every order. Points can be converted to wallet balance.\n\nWant to convert points to wallet? Say "convert points to wallet".`;
      } else {
        message += `You don't have any loyalty points yet.\n\nYou earn points on every order — start ordering to collect points! 🎉`;
      }

      return {
        message,
        buttons: this.getMainMenuButtons(),
        routedTo: 'direct',
        intent,
        metadata: { handler: 'check_loyalty_points', loyaltyPoints },
      };
    }

    // STEP 4a-3: Order again / reorder
    if (intent.intent === 'order_again' || intent.intent === 'reorder') {
      // Clear active flow if any
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login first to see your past orders.\n\nSay "login" to get started.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      // Try to get visit-again items
      try {
        const visitAgain = await this.phpOrderService?.getVisitAgain(authToken);
        if (visitAgain?.success && visitAgain.items?.length > 0) {
          const items = visitAgain.items.slice(0, 5);
          // Group by primary store (most common storeId)
          const storeCounts: Record<number, string> = {};
          for (const item of items) {
            storeCounts[item.storeId] = (storeCounts[item.storeId] || item.storeName);
          }
          const primaryStoreId = items
            .map(i => i.storeId)
            .reduce((a, b) => items.filter(i => i.storeId === a).length >= items.filter(i => i.storeId === b).length ? a : b);
          const primaryStoreName = storeCounts[primaryStoreId] || 'your last restaurant';

          const itemList = items
            .map((item, i) => `${i + 1}. **${item.name}** — ₹${item.price}`)
            .join('\n');

          return {
            message: `🔄 **Repeat Your Last Order**\n\n🏪 From **${primaryStoreName}**:\n\n${itemList}\n\nTap below to add these to your cart instantly!`,
            buttons: [
              { label: '✅ Add All to Cart', value: 'quick reorder confirm', action: 'quick_reorder' },
              { label: '🔍 Order Something Else', value: 'order food', action: 'order_food' },
            ],
            routedTo: 'direct',
            intent,
          };
        }
      } catch (e) {
        this.logger.warn(`Failed to fetch visit-again: ${e.message}`);
      }

      return {
        message: '🔄 No recent orders found. Start a new order?',
        buttons: [
          { label: '🍔 Order Food', value: 'order food', action: 'order_food' },
          ...this.getMainMenuButtons(),
        ],
        routedTo: 'direct',
        intent,
      };
    }

    // STEP 4a-4: View wishlist
    if (intent.intent === 'view_wishlist' || intent.intent === 'wishlist') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login to view your wishlist.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      try {
        const wishlist = await this.phpWishlistService?.getWishlist(authToken);
        if (wishlist?.success && wishlist.items?.length > 0) {
          const cards = wishlist.items.slice(0, 8).map((item: any) => ({
            id: item.itemId || item.id,
            name: item.name,
            price: Number(item.price) || 0,
            storeId: item.storeId,
            storeName: item.storeName,
            moduleId: item.moduleId || 4,
            action: { value: `item_${item.itemId || item.id}` },
          }));
          const extra = wishlist.items.length > 8 ? ` (+${wishlist.items.length - 8} more)` : '';
          return {
            message: `❤️ **Your Wishlist** — ${wishlist.items.length} item${wishlist.items.length !== 1 ? 's' : ''}${extra}`,
            cards,
            buttons: [{ label: '🔍 Order Something', value: 'order food', action: 'order_food' }, ...this.getMainMenuButtons().slice(0, 2)],
            routedTo: 'direct',
            intent,
          };
        }
      } catch (e) {
        this.logger.warn(`Failed to fetch wishlist: ${e.message}`);
      }

      return {
        message: '❤️ Your wishlist is empty.\n\nTap the ❤️ button on any item to save it here!',
        buttons: [{ label: '🍔 Browse Food', value: 'order food', action: 'order_food' }, ...this.getMainMenuButtons().slice(0, 2)],
        routedTo: 'direct',
        intent,
      };
    }

    // STEP 4a-5: Review / rate order — submit to PHP backend
    if (intent.intent === 'submit_review' || intent.intent === 'rate_order' || intent.intent === 'leave_review' || intent.intent === 'feedback') {
      // Check for inline rating value like "rating_4" or "rate 4 stars"
      const ratingMatch = event.message?.match(/(?:rating_|rate\s+)?(\d)(?:\s*(?:star|stars)?)/i);
      const ratingValue = ratingMatch ? parseInt(ratingMatch[1]) : null;

      if (ratingValue && ratingValue >= 1 && ratingValue <= 5) {
        const stars = '⭐'.repeat(ratingValue) + '☆'.repeat(5 - ratingValue);
        const authToken = session.data?.auth_token;

        // Submit review to PHP backend (non-blocking)
        if (authToken && this.phpReviewService && this.phpOrderService) {
          try {
            const orders = await this.phpOrderService.getOrders(authToken, 3, 1);
            const delivered = (orders || []).find((o: any) =>
              o.orderStatus === 'delivered' || o.order_status === 'delivered',
            );
            if (delivered) {
              await this.phpReviewService.submitItemReview(authToken, 0, delivered.id, ratingValue, '');
              this.logger.log(`Review submitted: ${ratingValue} stars for order #${delivered.id}`);
            }
          } catch (e) {
            this.logger.warn(`Review submit failed (non-blocking): ${e.message}`);
          }
        }

        return {
          message: `${stars} **Thank you for your ${ratingValue}-star rating!**\n\nYour feedback helps us improve.`,
          buttons: [
            { label: 'Order Again', value: 'order food', action: 'order_food' },
            ...this.getMainMenuButtons().slice(0, 2),
          ],
          routedTo: 'direct',
          intent,
          metadata: { handler: 'submit_review_executed', ratingValue },
        };
      }

      return {
        message: `⭐ **How was your order?**\n\nTap a star to rate:`,
        buttons: [
          { label: '⭐ 1 Star', value: 'rating_1', action: 'rate_order' },
          { label: '⭐⭐ 2 Stars', value: 'rating_2', action: 'rate_order' },
          { label: '⭐⭐⭐ 3 Stars', value: 'rating_3', action: 'rate_order' },
          { label: '⭐⭐⭐⭐ 4 Stars', value: 'rating_4', action: 'rate_order' },
          { label: '⭐⭐⭐⭐⭐ 5 Stars', value: 'rating_5', action: 'rate_order' },
        ],
        routedTo: 'direct',
        intent,
        metadata: { handler: 'submit_review' },
      };
    }

    // STEP 4a-6: Cancel order
    if (intent.intent === 'cancel_order') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login first to cancel an order.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      try {
        const runningOrders = await this.phpOrderService?.getRunningOrders(authToken);
        if (!runningOrders || runningOrders.length === 0) {
          return {
            message: '📋 You have no active orders to cancel.\n\nOnly orders in **pending** or **confirmed** status can be cancelled.',
            buttons: [
              { label: '📋 View My Orders', value: 'my orders', action: 'track_order' },
              ...this.getMainMenuButtons().slice(0, 2),
            ],
            routedTo: 'direct',
            intent,
          };
        }

        const orderList = runningOrders.slice(0, 3)
          .map((o: any, i: number) => `${i + 1}. **Order #${o.id}** — ₹${o.order_amount} (${o.order_status})`)
          .join('\n');
        const orderButtons = runningOrders.slice(0, 3).map((o: any) => ({
          label: `❌ Cancel #${o.id}`,
          value: `cancel_order_${o.id}`,
          action: 'cancel_order',
        }));

        return {
          message: `📋 **Your Active Orders**\n\n${orderList}\n\nWhich order do you want to cancel?`,
          buttons: [...orderButtons, { label: '⬅️ Back', value: 'menu', action: 'menu' }],
          routedTo: 'direct',
          intent,
          metadata: { handler: 'cancel_order' },
        };
      } catch (e) {
        this.logger.warn(`cancel_order fetch failed: ${e.message}`);
        return {
          message: '❌ Could not fetch your orders right now. Please try again.',
          buttons: this.getMainMenuButtons(),
          routedTo: 'direct',
          intent,
        };
      }
    }

    // STEP 4a-7: Request refund
    if (intent.intent === 'request_refund' || intent.intent === 'refund') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login first to request a refund.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      try {
        const orders = await this.phpOrderService?.getOrders(authToken, 5, 1, '4');
        const delivered = (orders || []).find((o: any) =>
          (o.orderStatus === 'delivered' || o.order_status === 'delivered') &&
          (o.paymentStatus === 'paid' || o.payment_status === 'paid'),
        );

        if (!delivered) {
          return {
            message: '📋 No eligible orders found for a refund.\n\nRefunds are available for **delivered & paid** orders.',
            buttons: [
              { label: '📋 My Orders', value: 'my orders', action: 'track_order' },
              ...this.getMainMenuButtons().slice(0, 2),
            ],
            routedTo: 'direct',
            intent,
          };
        }

        // Store pending refund orderId in session so the next text message can submit it
        await this.sessionService.updateSession(event.identifier, {
          pendingRefundOrderId: delivered.id,
        });

        return {
          message: `💸 **Request a Refund**\n\nOrder **#${delivered.id}** — ₹${delivered.orderAmount}\n\nPlease type your reason for the refund (e.g., "food was cold", "wrong item delivered"):`,
          buttons: [{ label: '❌ Cancel', value: 'menu', action: 'menu' }],
          routedTo: 'direct',
          intent,
          metadata: {
            handler: 'request_refund',
            pendingRefundOrderId: delivered.id,
          },
        };
      } catch (e) {
        this.logger.warn(`request_refund fetch failed: ${e.message}`);
        return {
          message: '❌ Could not fetch your orders right now. Please try again.',
          buttons: this.getMainMenuButtons(),
          routedTo: 'direct',
          intent,
        };
      }
    }

    // STEP 4a-8: Transfer loyalty points to wallet
    if (intent.intent === 'transfer_points' || intent.intent === 'loyalty_to_wallet' || intent.intent === 'convert_points') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login first to convert loyalty points.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      try {
        const loyaltyResult = await this.phpLoyaltyService?.getLoyaltyPoints(authToken);
        if (!loyaltyResult?.success || !loyaltyResult.points) {
          return {
            message: '🎯 Could not fetch your loyalty points. Please try again.',
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
            intent,
          };
        }

        const { points, currency_value, min_points_to_redeem } = loyaltyResult.points;
        if (points <= 0) {
          return {
            message: '🎯 You have no loyalty points to convert.\n\nEarn points by placing orders!',
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
            intent,
          };
        }

        if (min_points_to_redeem > 0 && points < min_points_to_redeem) {
          return {
            message: `🎯 You have **${points} points** (≈ ₹${currency_value.toFixed(2)}).\n\nMinimum **${min_points_to_redeem} points** required to convert. Keep earning!`,
            buttons: this.getMainMenuButtons(),
            routedTo: 'direct',
            intent,
          };
        }

        return {
          message: `🎯 **Convert Loyalty Points**\n\nYou have **${points} points** (≈ ₹${currency_value.toFixed(2)})\n\nHow many points would you like to convert to wallet balance?\n_(Maximum: ${points} points)_`,
          buttons: [
            { label: `Convert All (${points})`, value: `convert_points_${points}`, action: 'convert_points' },
            { label: '❌ Cancel', value: 'menu', action: 'menu' },
          ],
          routedTo: 'direct',
          intent,
          metadata: {
            handler: 'transfer_points',
            availablePoints: points,
          },
        };
      } catch (e) {
        this.logger.warn(`transfer_points fetch failed: ${e.message}`);
        return {
          message: '❌ Could not fetch loyalty points right now. Please try again.',
          buttons: this.getMainMenuButtons(),
          routedTo: 'direct',
          intent,
        };
      }
    }

    // STEP 4a-9: Add to wishlist
    if (intent.intent === 'add_to_wishlist') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }

      const authToken = session.data?.auth_token;
      if (!authToken) {
        return {
          message: '🔐 Please login first to save items to your wishlist.',
          buttons: [{ label: '🔐 Login', value: 'login', action: 'login' }],
          routedTo: 'direct',
          intent,
        };
      }

      // Try to get item ID from context (e.g., last viewed item)
      const itemId = session.data?.last_viewed_item_id || session.data?.selected_item?.id;
      if (!itemId) {
        return {
          message: '❤️ **Add to Wishlist**\n\nBrowse our menu and tap ❤️ next to any item to save it to your wishlist.\n\nSay "order food" to browse our menu!',
          buttons: [
            { label: '🍔 Browse Menu', value: 'order food', action: 'order_food' },
            { label: '❤️ View Wishlist', value: 'view wishlist', action: 'view_wishlist' },
          ],
          routedTo: 'direct',
          intent,
        };
      }

      try {
        const result = await this.phpWishlistService?.addToWishlist(authToken, Number(itemId));
        if (result?.success) {
          const itemName = session.data?.selected_item?.name || `item #${itemId}`;
          return {
            message: `❤️ **${itemName}** added to your wishlist!`,
            buttons: [
              { label: '❤️ View Wishlist', value: 'view wishlist', action: 'view_wishlist' },
              ...this.getMainMenuButtons().slice(0, 2),
            ],
            routedTo: 'direct',
            intent,
          };
        }
      } catch (e) {
        this.logger.warn(`add_to_wishlist failed: ${e.message}`);
      }

      return {
        message: '❤️ Could not add to wishlist right now. Please try again.',
        buttons: this.getMainMenuButtons(),
        routedTo: 'direct',
        intent,
      };
    }

    // STEP 4a-10: Check store/item availability — "kya khula hai", "what's open now"
    // Routes to food flow which shows open-now stores after location collection
    if (intent.intent === 'check_availability') {
      if (activeFlow) {
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
      }
      // If user already has a location, route directly into food flow with open_now hint
      const userLat = session.data?.user_lat ?? session.data?.location?.lat;
      if (userLat) {
        // Rewrite message as "show open restaurants" so food flow picks up open_now
        const modifiedEvent = { ...event, message: 'show open restaurants near me' };
        const foodFlowResponse = await this.startNewFlowSync(modifiedEvent, session, {
          intent: 'order_food', confidence: 0.95, entities: {},
        });
        if (foodFlowResponse) return foodFlowResponse;
      }
      return {
        message: '🟢 **What\'s Open Now?**\n\nShare your location and I\'ll show you all open restaurants and stores near you!',
        buttons: [
          { label: '📍 Find Open Restaurants', value: 'order food', action: 'order_food' },
          ...this.getMainMenuButtons().slice(0, 2),
        ],
        routedTo: 'direct',
        intent,
      };
    }

    // STEP 4a-11: Dietary preference update — "main veg hoon", "I prefer veg"
    if (intent.intent === 'update_preference') {
      const lowerMsg = (event.message || '').toLowerCase();
      // Detect what preference is being set
      const isVeg = /veg(etarian)?/.test(lowerMsg) && !/non.?veg/.test(lowerMsg);
      const isNonVeg = /non.?veg/.test(lowerMsg);
      const prefLabel = isVeg ? '🥦 Vegetarian' : isNonVeg ? '🍗 Non-Vegetarian' : '🍽️ Your preference';

      // Save to session
      if (isVeg) {
        await this.sessionService.setData(event.identifier, 'dietary_preference', 'veg');
      } else if (isNonVeg) {
        await this.sessionService.setData(event.identifier, 'dietary_preference', 'non_veg');
      }

      // Persist to database so preference survives session expiry
      const prefUserId = session.data?.user_id;
      if (prefUserId && this.userPreferenceService) {
        const dietValue = isVeg ? 'veg' : isNonVeg ? 'non_veg' : null;
        if (dietValue) {
          this.userPreferenceService.updatePreference(
            Number(prefUserId), 'dietary_type', dietValue, 'explicit', 1.0,
          ).catch(err => this.logger.warn(`Failed to persist dietary preference: ${err.message}`));
        }
      }

      return {
        message: `✅ Got it! **${prefLabel}** preference saved.\n\nI'll filter your food results accordingly. Ready to order?`,
        buttons: this.getMainMenuButtons().slice(0, 2),
        routedTo: 'direct',
        intent,
        metadata: { handler: 'update_preference', preference: isVeg ? 'veg' : isNonVeg ? 'non_veg' : 'unknown' },
      };
    }

    // STEP 4b: Continue Active Flow (with Intent Awareness)
    // Check both session.data.activeFlow AND flowContext
    if (activeFlow) {
      return this.continueFlowSync(event, session, intent);
    }

    // STEP 5: Start New Flow or Fallback to Agent
    const flowResponse = await this.startNewFlowSync(event, session, intent);
    if (flowResponse) {
      return flowResponse;
    }

    // Fallback to agent
    return this.executeAgentSync(event, session, intent);
  }

  /**
   * STEP 0a: Check if user needs first-time onboarding
   * Returns true if:
   * - User is on WhatsApp/Telegram (auto-auth platforms)
   * - User is newly registered (is_new_user flag or no profile data)
   * - Onboarding hasn't been completed yet
   * - BUT NOT if user sends a clear transactional message (order intent)
   */
  private async shouldTriggerOnboarding(event: MessageEvent, session: any): Promise<boolean> {
    // Enable onboarding for all platforms except mobile (which has native onboarding)
    const platform = event.channel?.toLowerCase();
    if (platform === 'mobile') {
      return false; // Mobile app has its own onboarding UI
    }
    
    // For web users: only trigger after they have authenticated
    const isWebUser = platform === 'web';
    const hasAuthenticated = session.data?.userId || session.data?.phone || session.data?.user_name;
    if (isWebUser && !hasAuthenticated) {
      // Web user not logged in yet - don't trigger onboarding
      return false;
    }
    
    // 🔧 CRITICAL FIX: Google OAuth users already have email + name, skip onboarding!
    // They don't need to tell us their name again - we got it from Google
    const isGoogleOAuthUser = session.data?.email && session.data?.user_name && !session.data?.phone;
    if (isGoogleOAuthUser) {
      this.logger.log(`🔐 Google OAuth user detected (${session.data.email}) - skipping onboarding`);
      // Mark onboarding as complete for this session so we don't ask again
      await this.sessionService.updateSession(event.identifier, {
        onboarding_completed: true,
        onboarding_skipped_reason: 'google_oauth',
      });
      return false;
    }

    // Check if already completed onboarding (profile >= 70%)
    if (session.data?.onboarding_completed === true) {
      return false;
    }

    // Check if already in onboarding flow
    const activeFlow = session.data?.activeFlow || session.data?.flowContext?.flowId;
    if (activeFlow === 'first_time_onboarding_v1') {
      return false;
    }

    // 🔧 FIX: Don't interrupt an active transactional flow with onboarding!
    // If user is in the middle of food_order, parcel_delivery, etc. - let them finish
    const TRANSACTIONAL_FLOWS = ['food_order_v1', 'parcel_delivery_v1', 'order_tracking_v1', 'auth_v1'];
    if (activeFlow && TRANSACTIONAL_FLOWS.includes(activeFlow)) {
      this.logger.debug(`🎯 Skipping onboarding - user is in active transactional flow: ${activeFlow}`);
      return false;
    }

    // 🎯 SKIP ONBOARDING if user sends a clear transactional message
    // Process their order first, we can profile them later from behavior
    const msg = event.message?.toLowerCase() || '';
    const hasTransactionalIntent = 
      // Food order keywords
      /\b(order|deliver|pizza|burger|biryani|paneer|chicken|naan|momos|cafe|restaurant|khana|mangwa|food)\b/i.test(msg) ||
      // Parcel keywords  
      /\b(parcel|send|courier|pickup|delivery|bhejo)\b/i.test(msg) ||
      // Has quantity patterns like "2 pizza", "1 butter chicken"
      /\d+\s*(x\s*)?(pizza|burger|naan|roti|chicken|paneer|biryani|momos)/i.test(msg);
    
    // 🔧 FIX: Skip onboarding if user says they're already logged in
    // This prevents the loop where user says "I am already logged in" and gets onboarding
    const isAlreadyLoggedInMessage = 
      /\b(already|i am|i'm|maine)\b.*\b(log|login|logged|sign|signin|registered)\b/i.test(msg) ||
      /\b(log|login|logged|sign|signin)\b.*\b(already|in|ho gaya|done)\b/i.test(msg);
    
    if (isAlreadyLoggedInMessage) {
      this.logger.log(`🔐 User claims already logged in: "${msg.substring(0, 50)}..." - skipping onboarding`);
      // Re-check auth status and proceed with flow
      return false;
    }
    
    if (hasTransactionalIntent) {
      this.logger.log(`🎯 Skipping onboarding - user has transactional intent: "${msg.substring(0, 50)}..."`);
      // Mark onboarding as deferred - we'll learn from their order instead
      await this.sessionService.updateSession(event.identifier, {
        onboarding_deferred: true,
        onboarding_deferred_at: new Date().toISOString(),
      });
      return false;
    }

    // Check profile completeness - users with incomplete profiles need onboarding
    const profileCompleteness = session.data?.profile_completeness ?? 0;
    const PROFILE_THRESHOLD = 70;
    
    if (profileCompleteness < PROFILE_THRESHOLD) {
      this.logger.log(`🎉 Profile incomplete! Completeness: ${profileCompleteness}% (threshold: ${PROFILE_THRESHOLD}%). Triggering onboarding for ${event.identifier.substring(0, 10)}...`);
      return true;
    }

    // Check if user is truly new (first message or no profile data)
    const isNewUser = session.data?.is_new_user === true;
    const hasNoProfile = !session.data?.dietary_type && !session.data?.user_name;
    
    if (isNewUser || hasNoProfile) {
      this.logger.log(`🎉 First-time user detected! Platform: ${platform}, isNew: ${isNewUser}, hasNoProfile: ${hasNoProfile}`);
      return true;
    }

    return false;
  }

  /**
   * STEP 0b: Start onboarding flow for first-time users
   */
  private async startOnboardingFlow(event: MessageEvent, session: any): Promise<RouterResponse> {
    this.logger.log(`🚀 Starting first-time onboarding for ${event.identifier.substring(0, 10)}...`);

    try {
      const flowResult = await this.flowEngineService.startFlow('first_time_onboarding_v1', {
        sessionId: event.identifier,
        initialContext: {
          _user_message: event.message,
          platform: event.channel,
          phone: event.identifier,
        },
      });

      if (flowResult && flowResult.response) {
        return {
          message: flowResult.response,
          buttons: flowResult.buttons,
          routedTo: 'flow',
          intent: { intent: 'first_time_onboarding', confidence: 1.0 },
          metadata: {
            flowId: 'first_time_onboarding_v1',
            flowStarted: true,
            flowRunId: flowResult.flowRunId,
            currentState: flowResult.currentState,
          },
        };
      }
    } catch (error) {
      this.logger.warn(`⚠️ Could not start onboarding flow: ${error.message}`);
    }

    // Fallback if onboarding flow fails - continue with normal routing
    return null as any; // Will continue to normal routing
  }

  /**
   * STEP 1: Detect user type (customer/vendor/driver)
   * Cache in session to avoid repeated calls
   */
  private async detectUserType(event: MessageEvent, session: any): Promise<void> {
    try {
      // For now, default to customer
      // TODO: Call UserTypeDetectorService for real detection
      const userType = 'customer';

      this.logger.log(`👤 User type detected: ${userType} for ${event.identifier}`);

      await this.sessionService.saveSession(event.identifier, {
        ...session,
        data: {
          ...session.data,
          userType,
          userTypeDetectedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      this.logger.error(`❌ User type detection failed: ${error.message}`);
    }
  }

  /**
   * STEP 2: Classify intent using NLU (IndicBERT v17 on Mercury)
   * This ALWAYS runs - NO REGEX FALLBACK! Pure AI-driven classification.
   * 
   * ✨ NEW: Uses centralized IntentRouterService for all translation/override logic
   * 
   * Regex patterns have been migrated to NLU training data (v18)
   * See: /home/ubuntu/Devs/MangwaleAI/nlu_training_data_v18.jsonl
   */
  private async classifyIntent(
    event: MessageEvent,
    session: any,
  ): Promise<IntentClassification & { routeDecision?: RouteDecision }> {
    try {
      const text = event.message;
      const lowerText = text.toLowerCase();

      // ⚡ NLU v3: IntentClassifierService with LLM fallback for low confidence
      // Pipeline: IndicBERT (0.7+ conf) → LLM fallback (0.5+ conf) → Heuristics
      if (this.intentClassifierService) {
        try {
          const startTime = Date.now();
          const classifierResult = await this.intentClassifierService.classify(text);
          const processingTime = Date.now() - startTime;
          
          // 🔄 Use centralized IntentRouterService for ALL translation/override logic
          const routeDecision = await this.intentRouter.route(classifierResult.intent, text, {
            hasActiveFlow: !!(session.data?.activeFlow || session.data?.flowContext?.flowId),
            activeFlowId: session.data?.activeFlow || session.data?.flowContext?.flowId,
            isAuthenticated: session.data?.authenticated === true,
            channel: event.channel || 'web',
          });
          
          this.logger.log(
            `🧠 NLU+LLM: "${lowerText.substring(0, 25)}..." → ` +
            `provider: ${classifierResult.provider}, intent: ${classifierResult.intent} (${classifierResult.confidence.toFixed(2)}), ` +
            `routed: ${routeDecision.translatedIntent}, flow: ${routeDecision.flowId || 'none'} (${processingTime}ms)`
          );
          
          // Return translated intent with route decision attached
          return {
            intent: routeDecision.translatedIntent,
            confidence: classifierResult.confidence,
            routeDecision,
          };
        } catch (classifierError) {
          this.logger.error(`❌ IntentClassifier failed: ${classifierError.message}`);
        }
      }
      
      // Fallback to raw IndicBERT if IntentClassifierService unavailable
      if (this.indicBertService) {
        try {
          const startTime = Date.now();
          const nluResult = await this.indicBertService.classify(text);
          const processingTime = Date.now() - startTime;
          
          const routeDecision = await this.intentRouter.route(nluResult.intent, text, {
            hasActiveFlow: !!(session.data?.activeFlow || session.data?.flowContext?.flowId),
            activeFlowId: session.data?.activeFlow || session.data?.flowContext?.flowId,
            isAuthenticated: session.data?.authenticated === true,
            channel: event.channel || 'web',
          });
          
          this.logger.log(
            `🧠 NLU (fallback): "${lowerText.substring(0, 25)}..." → ` +
            `raw: ${nluResult.intent}, routed: ${routeDecision.translatedIntent} (${processingTime}ms)`
          );
          
          return {
            intent: routeDecision.translatedIntent,
            confidence: nluResult.confidence,
            routeDecision,
          };
        } catch (nluError) {
          this.logger.error(`❌ IndicBERT NLU failed: ${nluError.message}`);
          return { intent: 'unknown', confidence: 0.0 };
        }
      }
      
      // NLU service not available - use IntentRouter with 'unknown' intent
      this.logger.warn(`⚠️ NLU service not available, using IntentRouter fallback`);
      const routeDecision = await this.intentRouter.route('unknown', text, {
        hasActiveFlow: !!(session.data?.activeFlow || session.data?.flowContext?.flowId),
        activeFlowId: session.data?.activeFlow || session.data?.flowContext?.flowId,
        isAuthenticated: session.data?.authenticated === true,
        channel: event.channel || 'web',
      });
      return { intent: routeDecision.translatedIntent, confidence: 0.0, routeDecision };
    } catch (error) {
      this.logger.error(`❌ NLU classification failed: ${error.message}`);
      return { intent: 'unknown', confidence: 0.0 };
    }
  }

  /**
   * STEP 3: Handle command intent (cancel, help, menu) - SYNC version
   */
  private async handleCommandSync(
    event: MessageEvent,
    session: any,
    intent: IntentClassification,
  ): Promise<RouterResponse> {
    this.logger.log(`🎯 Handling command: ${intent.intent}`);

    const result = await this.commandHandler.handle(intent, {
      phoneNumber: event.identifier,
      data: session.data,
    });

    return {
      message: result.message,
      buttons: this.getMainMenuButtons(), // CommandHandler returns action, not buttons
      routedTo: 'command',
      intent,
      metadata: { commandType: intent.intent, action: result.action },
    };
  }

  /**
   * STEP 4: Continue active flow (with intent awareness) - SYNC version
   * Now with smart intent switching!
   * @param buttonEvent - Optional: The button value to use as flow event (e.g., 'popular', 'browse_menu')
   */
  private async continueFlowSync(
    event: MessageEvent,
    session: any,
    intent: IntentClassification,
    buttonEvent?: string,
  ): Promise<RouterResponse> {
    const flowId = session.data?.activeFlow || session.data?.flowContext?.flowId;
    const currentState = session.data?.flowContext?.currentState;
    
    this.logger.log(`📍 continueFlowSync: current flow=${flowId}, state=${currentState}, detected intent=${intent.intent} (conf=${intent.confidence})${buttonEvent ? `, buttonEvent=${buttonEvent}` : ''}`);
    
    // 🎯 SPECIAL CASE: Handle greeting/chitchat during active flow gracefully
    // If user is in a browsable/stale state, reset the flow and greet fresh
    // If in a critical transactional state, continue the flow
    const isMidFlowGreeting = ['greeting', 'chitchat'].includes(intent.intent) && flowId;
    if (isMidFlowGreeting) {
      // States where the user is just browsing — safe to reset on greeting
      const BROWSABLE_STATES = [
        'display_recommendations', 'show_results', 'show_recommendations',
        'ask_food_query', 'check_trigger', 'start',
        'understand_request', 'welcome', 'search_food', 'check_search_query_exists',
        'ask_what_to_order', 'ask_for_query',
      ];
      const isStaleState = BROWSABLE_STATES.includes(currentState);
      
      if (isStaleState) {
        this.logger.log(`👋 Greeting in browsable state (${currentState}) — clearing stale ${flowId} flow, greeting fresh`);
        // Clear the stale flow
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
          flowRunId: null,
        });
        
        // Return greeting with main menu
        const userName = session.data?.user_name || 'there';
        return {
          message: `Hey ${userName}! 😊 What would you like to do today?`,
          buttons: this.getMainMenuButtons(),
          routedTo: 'greeting',
          intent,
          metadata: { action: 'greeting_reset' },
        };
      } else {
        this.logger.log(`👋 Mid-flow greeting in critical state (${currentState}) — continuing ${flowId}`);
        // Continue flow directly - will be handled naturally
      }
    }
    
    // 🔧 FIX: Don't switch to address-management when current flow is waiting for location
    // The location message gets classified as manage_address but we should continue the flow
    const isLocationWaitState = ['request_location', 'handle_location_response', 'ask_location'].includes(currentState);
    const isLocationRelatedIntent = ['manage_address', 'provide_location', 'check_address', 'save_address'].includes(intent.intent);
    const messageContainsLocation = event.message?.includes('Location shared') || event.message?.includes('Coordinates:') || /\d+\.\d+,\s*\d+\.\d+/.test(event.message || '');
    
    // 🔧 FIX: Only recurse if we haven't already set buttonEvent to location_shared (prevents infinite loop)
    if (isLocationWaitState && (isLocationRelatedIntent || messageContainsLocation) && buttonEvent !== 'location_shared') {
      this.logger.log(`📍 Flow is waiting for location, not switching to address flow - continuing ${flowId}`);
      // Continue the current flow with the location data
      return this.continueFlowSync(event, session, intent, 'location_shared');
    }
    
    // Check if user intent suggests switching to a different flow
    // COMPREHENSIVE MAPPING for flow switching
    const flowMapping: Record<string, string> = {
      search_food: 'food_order_v1',
      order_food: 'food_order_v1',
      book_parcel: 'parcel_delivery_v1',
      parcel_booking: 'parcel_delivery_v1',
      track_order: 'order_tracking_v1',
      login: 'auth_v1',
      contact_support: 'support_v1',
      support_request: 'support_v1',
      // NOTE: 'help' intentionally NOT mapped - goes to AI agent for natural conversation
      manage_address: 'address-management',
    };
    
    const targetFlowForIntent = flowMapping[intent.intent];
    
    // 🔧 FIX: Don't switch flows when user is in CRITICAL wait states
    // These are states where the user is expected to provide specific input like
    // payment selection, order confirmation, recipient details, etc.
    const CRITICAL_WAIT_STATES = [
      'wait_payment_selection', 'select_payment_method', 'select_payment_method_fallback',
      'handle_payment_selection', 'confirm_order', 'show_summary',
      'wait_for_pickup', 'wait_for_delivery', 'collect_recipient', 'wait_recipient',
      'wait_confirmation', 'wait_vehicle_selection', 'confirm_checkout',
      'wait_quantity', 'wait_size', 'wait_addon_selection',
      // Parcel vehicle category selection states
      'show_categories', 'show_categories_retry',
      // Address collection states
      'collect_pickup', 'collect_delivery', 'extract_pickup_address', 'extract_delivery_address',
      // Payment gateway wait states (parcel + food)
      'wait_payment_result', 'wait_food_payment_result',
      'await_payment_retry', 'await_food_payment_retry',
      // Location wait states — user is sharing GPS/location, don't switch to address flow
      'request_location', 'handle_location_response', 'ask_location',
      // Auth/OTP states — user is entering phone or OTP, don't switch to auth flow
      'request_phone', 'verify_otp', 'otp_retry', 'collect_phone', 'ask_for_otp',
      // Name/profile collection states
      'ask_name', 'ask_email',
    ];
    
    const isInCriticalState = CRITICAL_WAIT_STATES.includes(currentState);
    if (isInCriticalState) {
      this.logger.log(`🔒 In critical wait state (${currentState}) - NOT switching flows, letting flow handle input`);
      // Fall through to continue the flow
    }
    
    // SPECIAL CASE: Don't switch to auth flow if user is already authenticated
    // This prevents disrupting other flows when user says "login is done", "logged in", etc.
    const isAuthenticatedAndLoginIntent = 
      intent.intent === 'login' && 
      (session.data?.authenticated || session.data?.user_id || session.data?.auth_token);
    
    if (isAuthenticatedAndLoginIntent) {
      this.logger.log(`🔐 User already authenticated, ignoring login intent - continuing current flow: ${flowId}`);
      // Continue the current flow instead of switching to auth
    } else if (!isInCriticalState && targetFlowForIntent && targetFlowForIntent !== flowId && intent.confidence >= 0.70) {
      // If user intent maps to a DIFFERENT flow than current, switch flows
      // Lower threshold (0.70) for switching between transactional flows
      this.logger.log(`🔀 SWITCHING FLOW! ${flowId} → ${targetFlowForIntent} (intent: ${intent.intent}, conf: ${intent.confidence})`);
      
      // Clear current flow and start new one
      await this.sessionService.updateSession(event.identifier, {
        activeFlow: null,
        flowContext: null,
      });
      
      // Await the flow result, fallback to agent if no response
      const flowSwitchResult = await this.startNewFlowSync(event, session, intent);
      return flowSwitchResult || await this.executeAgentSync(event, session, intent);
    }
    
    // Special case: If in chitchat and user shows strong transactional intent, switch
    if (flowId === 'chitchat_v1' && targetFlowForIntent && intent.confidence >= 0.60) {
      this.logger.log(`🔀 Exiting chitchat for ${targetFlowForIntent} (intent: ${intent.intent})`);
      
      await this.sessionService.updateSession(event.identifier, {
        activeFlow: null,
        flowContext: null,
      });
      
      // Await the flow result, fallback to agent if no response
      const chitchatSwitchResult = await this.startNewFlowSync(event, session, intent);
      return chitchatSwitchResult || await this.executeAgentSync(event, session, intent);
    }
    
    // Special case: If already in parcel flow but user sends a NEW full parcel request
    // (message contains pickup/delivery/location info), restart the flow fresh
    if (flowId === 'parcel_delivery_v1' && intent.intent === 'parcel_booking' && intent.confidence >= 0.80) {
      const msg = event.message.toLowerCase();
      const hasNewBookingIndicators = 
        // Location-related keywords
        (msg.includes('from') || msg.includes('se') || msg.includes('pickup') || msg.includes('uthao')) &&
        // Recipient/destination keywords  
        (msg.includes('to') || msg.includes('ko') || msg.includes('deliver') || msg.includes('drop') || 
         msg.includes('friend') || msg.includes('dost') || msg.includes('recipient')) ||
        // Explicit new order keywords
        msg.includes('new order') || msg.includes('new parcel') || msg.includes('naya') ||
        // Has phone number pattern (likely a new recipient)
        /\d{10}/.test(msg) ||
        // Has address reference like "home", "42 wala", etc.
        /\b(home|ghar|office|shop|dukaan|\d+\s*wala)\b/i.test(msg);
      
      if (hasNewBookingIndicators) {
        this.logger.log(`🔄 RESTARTING parcel flow! User sent a new full booking request`);
        
        // Clear current flow context to start fresh
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
        
        // Await the flow result, fallback to agent if no response
        const parcelRestartResult = await this.startNewFlowSync(event, session, intent);
        return parcelRestartResult || await this.executeAgentSync(event, session, intent);
      }
    }
    
    // 🔧 FIX: If already in food order flow but user sends a NEW food query
    // (e.g., says "pizza" when in checkout with biryani in cart), restart search
    if (flowId === 'food_order_v1' && intent.intent === 'order_food' && intent.confidence >= 0.80) {
      const currentState = session.data?.flowContext?.currentState;
      const msg = event.message.toLowerCase().trim();
      
      // Detect if this is a new food search (not a button click or address input)
      const isNewFoodQuery = 
        // It's a food keyword by itself (like "pizza", "burger", "biryani")
        /^(pizza|burger|biryani|paneer|momos|naan|roti|dal|rice|thali|sandwich|dosa|idli|paratha|samosa|pakora|chaat|pav bhaji|pulao|noodles|manchurian|fried rice|chowmein|pasta|maggi|vada pav|misal|poha|upma|chole|rajma|kadhi|korma|tikka|kebab|tandoori|butter chicken|chicken|mutton|fish|prawn|egg)/i.test(msg) ||
        // Or has food order pattern like "2 pizza", "burger chahiye"
        /^\d+\s*(pizza|burger|biryani|paneer|momos|naan)/i.test(msg) ||
        /\b(pizza|burger|biryani|paneer)\s*(chahe|chahiye|do|lao|order|karna|mangwa)/i.test(msg);
      
      // Only restart if we're past the add-to-cart stage and in actual checkout states
      // Do NOT match cart_add_success (user is adding items, not checking out)
      const isInCheckoutStage = currentState && 
        (currentState.includes('address') || 
         currentState.includes('payment') || 
         currentState.includes('checkout') ||
         currentState.includes('confirm') ||
         currentState.includes('distance') ||
         currentState.includes('pricing'));
      
      if (isNewFoodQuery && isInCheckoutStage) {
        this.logger.log(`🔄 RESTARTING food order flow! User sent new food query "${msg}" while in ${currentState}`);
        
        // Clear current flow context to start fresh search
        await this.sessionService.updateSession(event.identifier, {
          activeFlow: null,
          flowContext: null,
        });
        
        // Start fresh food order flow
        const foodRestartResult = await this.startNewFlowSync(event, session, intent);
        return foodRestartResult || await this.executeAgentSync(event, session, intent);
      }
    }
    
    // 🔧 FIX: Normalize numeric button values (e.g., "1", "2") to 'user_message' event
    // Numeric values are saved address selections, not flow transition events
    // Named events like 'login', 'cancel', '__LOCATION__' are valid flow transitions
    const flowEvent = buttonEvent && /^\d+$/.test(buttonEvent) ? 'user_message' : buttonEvent;
    
    this.logger.log(`🔄 Continuing existing flow: ${flowId} (no switch, intent: ${intent.intent})${buttonEvent ? `, event=${buttonEvent} → flowEvent=${flowEvent}` : ''}`);

    try {
      // Use real FlowEngineService to continue the flow
      // Pass flowEvent if present (e.g., 'popular', 'browse_menu', 'login' from button clicks)
      // Numeric button values are normalized to 'user_message' so the flow treats them as user input
      const flowResult = await this.flowEngineService.processMessage(
        event.identifier,
        event.message,
        flowEvent, // Pass normalized event for correct transition
      );

      if (flowResult && flowResult.response) {
        // FlowProcessingResult has: { flowRunId, currentState, response (string), buttons, cards, completed, metadata }
        return {
          message: flowResult.response,
          buttons: flowResult.buttons, // Pass through buttons from flow
          cards: flowResult.cards, // Pass through cards from flow
          routedTo: 'flow',
          intent,
          metadata: { 
            flowId, 
            flowRunId: flowResult.flowRunId,
            currentState: flowResult.currentState,
            completed: flowResult.completed,
            ...flowResult.metadata,
          },
        };
      }

      // Flow returned no response — if we're in an active flow, re-prompt instead of falling to agent
      if (flowResult && !flowResult.completed && currentState) {
        this.logger.log(`🔄 Flow returned no response in state "${currentState}" — re-prompting user`);
        return {
          message: 'Mujhe samajh nahi aaya 🤔 Kya aap phir se bata sakte hain?',
          routedTo: 'flow',
          intent,
          metadata: { flowId, currentState, rePrompt: true },
        };
      }
    } catch (error) {
      this.logger.warn(`⚠️ FlowEngine error, falling back to agent: ${error.message}`);
    }

    // Fallback if flow engine fails
    return this.executeAgentSync(event, session, intent);
  }

  /**
   * STEP 5a: Start new flow based on intent - SYNC version
   * 
   * ✨ REFACTORED: Now uses centralized IntentRouterService instead of local flowMapping
   * The routing decision is pre-computed in classifyIntent() and attached to intent object
   */
  private async startNewFlowSync(
    event: MessageEvent,
    session: any,
    intent: IntentClassification & { routeDecision?: RouteDecision },
  ): Promise<RouterResponse | null> {
    // 🎯 Use pre-computed route decision from IntentRouterService
    const routeDecision = intent.routeDecision;
    const flowId = routeDecision?.flowId || this.intentRouter.getFlowIdForIntent(intent.intent);

    if (flowId) {
      this.logger.log(`🚀 Starting new flow: ${flowId} (intent: ${intent.intent}, reason: ${routeDecision?.reason || 'direct lookup'})`);

      try {
        // Extract auth data from session to pass to flow
        const sessionData = session?.data || {};
        const authContext = {
          authenticated: sessionData.authenticated === true,
          user_id: sessionData.user_id,
          auth_token: sessionData.auth_token,
          phone_number: sessionData.phone,
          user_name: sessionData.user_name || sessionData.userName,
        };
        
        if (authContext.authenticated) {
          this.logger.log(`🔐 Passing auth to flow: user_id=${authContext.user_id}, phone=${authContext.phone_number ? '***' : 'none'}`);
        }
        
        // Use startFlow to create a NEW flow (not processMessage which continues existing)
        const flowResult = await this.flowEngineService.startFlow(flowId, {
          sessionId: event.identifier,
          initialContext: {
            _user_message: event.message,
            _initial_intent: intent.intent,
            _intent_confidence: intent.confidence,
            _route_decision: routeDecision, // Pass routing metadata to flow
            // Pass auth data from session to flow context
            ...authContext,
          },
        });

        // 🔧 FIX: Check for flowResult existence, not just response (empty string is valid)
        // Flow can return cards without a text response (e.g., food search results)
        if (flowResult && (flowResult.response !== undefined || flowResult.cards?.length > 0)) {
          // FlowProcessingResult has: { flowRunId, currentState, response (string), buttons, cards, completed, metadata }
          return {
            message: flowResult.response || '', // Default to empty string if undefined
            buttons: flowResult.buttons, // Pass through buttons from flow
            cards: flowResult.cards, // Pass through cards from flow
            routedTo: 'flow',
            intent,
            metadata: { 
              flowId, 
              flowStarted: true, 
              flowRunId: flowResult.flowRunId,
              currentState: flowResult.currentState,
              completed: flowResult.completed,
              routeDecision: routeDecision, // Include routing decision in metadata
              ...flowResult.metadata,
            },
          };
        }
      } catch (error) {
        this.logger.warn(`⚠️ Could not start flow ${flowId}: ${error.message}`);
      }
    }

    return null;
  }

  /**
   * STEP 5b: Fallback to agent execution - SYNC version
   */
  private async executeAgentSync(
    event: MessageEvent,
    session: any,
    intent: IntentClassification,
  ): Promise<RouterResponse> {
    this.logger.log(`🤖 Executing agent for intent: ${intent.intent}`);

    try {
      // Use real AgentOrchestratorService
      const module = this.getModuleFromIntent(intent.intent);
      const agentResult = await this.agentOrchestrator.processMessage(
        event.identifier,
        event.message,
        module,
      );

      // AgentResult has: { response: string, buttons, cards, executionTime, metadata }
      if (agentResult?.response) {
        return {
          message: agentResult.response,
          buttons: agentResult.buttons, // Pass through buttons from agent
          cards: agentResult.cards, // Pass through cards from agent
          routedTo: 'agent',
          intent,
          metadata: { 
            executionTime: agentResult.executionTime,
            functionsCalled: agentResult.functionsCalled,
            cached: agentResult.cached,
            ...agentResult.metadata,
          },
        };
      }
    } catch (error) {
      this.logger.error(`❌ Agent execution failed: ${error.message}`, error.stack);
    }

    // Final fallback
    return {
      message: this.getGreetingMessage(event.message),
      routedTo: 'greeting',
      intent,
      buttons: this.getMainMenuButtons(),
    };
  }

  /**
   * Get module type from intent
   */
  private getModuleFromIntent(intent: string): ModuleType {
    if (intent.includes('food') || intent.includes('search')) {
      return ModuleType.FOOD;
    }
    if (intent.includes('parcel')) {
      return ModuleType.PARCEL;
    }
    if (intent.includes('ecom')) {
      return ModuleType.ECOM;
    }
    return ModuleType.FOOD;
  }

  /**
   * Get greeting message for new users
   */
  private getGreetingMessage(userMessage: string): string {
    const greetingPatterns = /^(hi|hello|hey|namaste|namaskar)/i;
    
    if (greetingPatterns.test(userMessage.trim())) {
      return "Hello! 👋 Welcome to Mangwale!\n\nI can help you with:\n• 🍕 Order delicious food\n• 📦 Book parcel delivery\n• 🛒 Shop products\n\nWhat would you like to do today?";
    }

    return `I understand you're asking about "${userMessage}". How can I help you today?\n\nYou can:\n• Search for food (e.g., "pizza", "biryani")\n• Track your order\n• Get help`;
  }

  /**
   * Get main menu buttons
   */
  private getMainMenuButtons(): Array<{ label: string; value: string; action?: string }> {
    return [
      { label: '🍕 Order Food', value: 'order_food', action: 'order_food' },
      { label: '📦 Book Parcel', value: 'book_parcel', action: 'book_parcel' },
      { label: '📍 Track Order', value: 'track_order', action: 'track_order' },
      { label: '❓ Help', value: 'help', action: 'help' },
    ];
  }

  /**
   * Send async response for WhatsApp/Telegram
   */
  private async sendAsyncResponse(event: MessageEvent, response: RouterResponse): Promise<void> {
    this.logger.log(
      `📤 [ASYNC ${event.channel}] Response to ${this.preview(event.identifier, 10)}...: ${this.preview(response.message, 50)}...`,
    );

    // Store response in session for legacy getBotMessages compatibility
    // Pass the object directly - storeBotMessage will JSON.stringify it
    await this.sessionService.storeBotMessage(event.identifier, {
      message: response.message,
      buttons: response.buttons,
      cards: response.cards,
      metadata: response.metadata,
      timestamp: Date.now(),
    });

    // Send via appropriate service based on platform
    try {
      const platform = this.channelToPlatform(event.channel);
      
      // Use WhatsAppCloudService directly for WhatsApp (bypass disabled MessagingService provider)
      if (platform === Platform.WHATSAPP && this.whatsappService) {
        const buttonCount = response.buttons?.length || 0;
        const cardCount = response.cards?.length || 0;
        this.logger.log(`📱 WhatsApp send: ${buttonCount} buttons, ${cardCount} cards for message`);
        
        // � WhatsApp-specific text limits per Meta docs:
        // - Text message body: max 4096 chars
        // - Interactive button body: max 1024 chars
        // - Interactive list body: max 4096 chars
        // - Header text: max 60 chars
        // - Footer text: max 60 chars
        // - Button title: max 20 chars
        // - List row title: max 24 chars
        // - List row description: max 72 chars
        // - List button text: max 20 chars
        
        // 📍 Check if this is a location request
        const hasLocationButton = response.buttons?.some(b => b.value === '__LOCATION__');
        const isLocationRequest = response.metadata?.responseType === 'request_location' || hasLocationButton;
        
        // Filter out special buttons (__LOCATION__, cancel) from regular buttons for WhatsApp
        const regularButtons = response.buttons?.filter(b => 
          b.value !== '__LOCATION__' && b.value !== 'cancel' && b.value !== 'trigger_auth_flow'
        ) || [];
        
        // 🎨 Smart header extraction: Use flowId/metadata for contextual headers
        const flowId = response.metadata?.flowId;
        const headerText = this.getWhatsAppHeader(flowId, response.metadata);
        const footerText = 'Mangwale • Fast Delivery';
        
        if (isLocationRequest && regularButtons.length > 0) {
          // 📍 HYBRID: Has saved addresses + location request
          // WhatsApp can't mix buttons with location request in one message
          // Send saved addresses as list/buttons first, then location request
          this.logger.log(`📍 WhatsApp hybrid: ${regularButtons.length} address buttons + location request`);
          
          if (regularButtons.length <= 3) {
            await this.whatsappService.sendButtons(
              event.identifier,
              {
                body: response.message.substring(0, 1024),
                header: '📍 Select Address',
                footer: footerText,
                buttons: regularButtons.slice(0, 3).map((b, i) => ({
                  id: b.value || `btn_${i}`,
                  title: b.label.substring(0, 20),
                })),
              }
            );
          } else {
            await this.whatsappService.sendList(
              event.identifier,
              {
                body: response.message.substring(0, 4096),
                header: '📍 Select Address',
                footer: footerText,
                buttonText: 'Choose Address',
                sections: [{
                  title: 'Saved Addresses',
                  rows: regularButtons.slice(0, 10).map((b, i) => ({
                    id: b.value || `btn_${i}`,
                    title: b.label.substring(0, 24),
                    description: 'Tap to select this address',
                  })),
                }],
              }
            );
          }
          
          // Then send location request as a separate message
          await this.whatsappService.sendLocationRequest(
            event.identifier, 
            '📍 Or share your live location for a new address:'
          );
        } else if (isLocationRequest) {
          this.logger.log(`📍 Sending native WhatsApp location request`);
          // Pure location request - no saved addresses
          await this.whatsappService.sendLocationRequest(event.identifier, response.message);
        } else if (response.cards && response.cards.length > 0) {
          // 🍕 Format food items as list for WhatsApp
          this.logger.log(`🍕 Formatting ${response.cards.length} food items as list`);
          
          // Build formatted message with items
          let itemsMessage = response.message + '\n\n';
          const rows: Array<{ id: string; title: string; description?: string }> = [];
          
          const maxItems = event.channel === 'whatsapp' ? 5 : 10;
          response.cards.slice(0, maxItems).forEach((card, idx) => {
            const name = card.name || card.title || `Item ${idx + 1}`;
            const price = card.price ? (typeof card.price === 'number' ? `₹${card.price}` : `${card.price}`) : '';
            const store = card.storeName || card.store_name || card.restaurant || '';
            const rating = card.rating && parseFloat(card.rating) > 0 ? `⭐${parseFloat(card.rating).toFixed(1)}` : '';
            const vegIcon = card.veg == 1 || card.veg === true ? '🟢' : card.veg == 0 || card.veg === false ? '🔴' : '';

            // Add to message — always show store line for consistent layout
            itemsMessage += `${idx + 1}. ${vegIcon} ${name} ${price}\n`;
            itemsMessage += `   📍 ${store || 'Unknown store'} ${rating}\n`;
            itemsMessage += '\n';

            // Add to rows for list - use item_ID format for consistent handling with web
            // card.action?.value is the preferred source (e.g., "item_10201")
            // Fallback: prefix card.id with "item_" to match the web format
            const rowId = card.action?.value || (card.id ? `item_${card.id}` : `item_${idx}`);
            rows.push({
              id: String(rowId).substring(0, 200), // WhatsApp list row ID limit
              title: String(name).substring(0, 24),
              description: `${vegIcon} ${price} • ${store || 'Unknown store'}`.substring(0, 72),
            });
          });
          
          // Send as list if many items, otherwise as text with buttons
          if (rows.length > 3) {
            await this.whatsappService.sendList(
              event.identifier,
              {
                body: itemsMessage.substring(0, 4096),
                header: '🍽️ Menu Items',
                footer: footerText,
                buttonText: 'View Menu',
                sections: [{
                  title: 'Available Items',
                  rows,
                }],
              }
            );
          } else if (rows.length > 0) {
            // Few items - send as buttons for quick selection
            await this.whatsappService.sendButtons(
              event.identifier,
              {
                body: itemsMessage.substring(0, 1024),
                header: '🍽️ Menu Items',
                footer: footerText,
                buttons: rows.map(r => ({
                  id: r.id,
                  title: `Add ${r.title}`.substring(0, 20),
                })),
              }
            );
          } else {
            // No items matched - send text
            await this.whatsappService.sendText(event.identifier, response.message);
          }
        } else if (response.buttons && response.buttons.length > 0 && response.buttons.length <= 3) {
          this.logger.log(`📱 Sending ${response.buttons.length} buttons via sendButtons`);
          // Use sendButtons for up to 3 buttons (WhatsApp limit)
          await this.whatsappService.sendButtons(
            event.identifier,
            {
              body: response.message.substring(0, 1024),
              ...(headerText ? { header: headerText } : {}),
              footer: footerText,
              buttons: response.buttons.slice(0, 3).map((b, i) => ({
                id: b.value || `btn_${i}`,
                title: b.label.substring(0, 20), // WhatsApp button title limit
              })),
            }
          );
        } else if (response.buttons && response.buttons.length > 3) {
          this.logger.log(`📱 Sending ${response.buttons.length} options via sendList`);
          // Use sendList for more than 3 options
          await this.whatsappService.sendList(
            event.identifier,
            {
              body: response.message.substring(0, 4096),
              ...(headerText ? { header: headerText } : {}),
              footer: footerText,
              buttonText: 'Choose Option',
              sections: [{
                title: 'Options',
                rows: response.buttons.slice(0, 10).map((b, i) => ({
                  id: b.value || `btn_${i}`,
                  title: b.label.substring(0, 24),
                })),
              }],
            }
          );
        } else {
          this.logger.log(`📱 Sending text only (no buttons)`);
          // Enable link preview for URLs in text
          const hasUrl = /https?:\/\//.test(response.message);
          await this.whatsappService.sendText(
            event.identifier, 
            response.message,
            { previewUrl: hasUrl },
          );
        }
        
        this.logger.log(`✅ [ASYNC] Response sent via WhatsApp Cloud API`);
      } else {
        // Fallback to MessagingService for other platforms
        await this.messagingService.sendTextMessage(platform, event.identifier, response.message);
        
        // If we have buttons, send them too
        if (response.buttons && response.buttons.length > 0) {
          await this.messagingService.sendButtonMessage(
            platform,
            event.identifier,
            'Please choose:',
            response.buttons.map((b, i) => ({ id: `btn_${i}`, title: b.label })),
          );
        }
        
        this.logger.log(`✅ [ASYNC] Response sent via ${platform}`);
      }
    } catch (error) {
      this.logger.error(`❌ Failed to send async response: ${error.message}`, error.stack);
      // Try sending plain text as fallback (buttons/list may have failed due to formatting)
      try {
        if (event.channel === 'whatsapp' && this.whatsappService) {
          await this.whatsappService.sendText(event.identifier, response.message);
        }
      } catch (fallbackErr) {
        this.logger.error(`❌ Even plain text fallback failed: ${fallbackErr.message}`);
      }
    }
  }

  /**
   * Get contextual header text for WhatsApp interactive messages (max 60 chars)
   */
  private getWhatsAppHeader(flowId?: string, metadata?: Record<string, any>): string | null {
    if (!flowId) return null;
    
    const headerMap: Record<string, string> = {
      'food_order_v1': '🍕 Food Order',
      'parcel_delivery_v1': '📦 Parcel Delivery',
      'order_tracking_v1': '📍 Order Tracking',
      'auth_v1': '🔐 Login',
      'first_time_onboarding_v1': '👋 Welcome to Mangwale',
      'address-management': '📍 Address Management',
    };
    
    return headerMap[flowId] || null;
  }

  /**
   * Convert channel string to Platform enum
   */
  private channelToPlatform(channel: string): Platform {
    switch (channel.toLowerCase()) {
      case 'whatsapp':
        return Platform.WHATSAPP;
      case 'telegram':
        return Platform.TELEGRAM;
      case 'rcs':
        return Platform.RCS;
      case 'web':
        return Platform.WEB;
      case 'voice':
        return Platform.VOICE;
      default:
        return Platform.WHATSAPP;
    }
  }

  /**
   * @deprecated Use IntentRouterService.route() instead
   * This method is kept for backward compatibility but all logic is now in IntentRouterService
   * 
   * MIGRATION NOTE (Jan 10, 2026):
   * - All translation logic moved to IntentRouterService
   * - All override logic moved to IntentRouterService
   * - All flow mapping moved to IntentRouterService
   */
  private async translateNluIntent(rawIntent: string, text: string): Promise<string> {
    // Delegate to new centralized IntentRouterService
    const decision = await this.intentRouter.route(rawIntent, text, {
      hasActiveFlow: false,
      isAuthenticated: false,
      channel: 'web',
    });
    return decision.translatedIntent;
  }

  /**
   * Log routing decision with metrics
   */
  private logRoutingDecision(decision: string, startTime: number): void {
    const duration = Date.now() - startTime;
    this.logger.log(`✅ Routed to: ${decision} (${duration}ms)`);
    
    // In production, would emit Prometheus metrics here:
    // routing_decision_total{decision="command"} +1
    // routing_duration_seconds{decision="command"} = duration/1000
  }

  /**
   * Graceful shutdown - unsubscribe from message channel
   * Redis connection cleanup handled by RedisModule
   */
  async onModuleDestroy() {
    await this.redis.unsubscribe(this.MESSAGE_CHANNEL);
    this.logger.log('🔴 ContextRouter unsubscribed from message channel');
  }
}
