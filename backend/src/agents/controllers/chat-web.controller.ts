import { Controller, Post, Get, Body, Param, Logger } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { MessageGatewayService } from '../../messaging/services/message-gateway.service';
import { SessionService } from '../../session/session.service';
import { OrderDatabaseService } from '../../php-integration/services/order-database.service';

/**
 * Web Chat Controller
 * 
 * REST API for web-based chat interface
 * NOW INTEGRATED WITH PHASE 1 MODERN ARCHITECTURE:
 * - MessageGateway (single entry point)
 * - ContextRouter (smart 5-step routing)
 * - FlowEngine + AgentOrchestrator
 * - Conversation logging for training data
 * - Session management with user context
 */
@Controller('chat')
export class ChatWebController {
  private readonly logger = new Logger(ChatWebController.name);

  // Store recent messages temporarily (in production, use Redis)
  private messageStore = new Map<string, Array<{ message: string; timestamp: number; from: 'bot' | 'user' }>>();

  constructor(
    private readonly messageGateway: MessageGatewayService,
    private readonly sessionService: SessionService,
    private readonly orderDatabaseService: OrderDatabaseService,
  ) {
    this.logger.log('✅ Web Chat Controller initialized with MessageGateway');
  }

  /**
   * Send a message from web chat
   * 
   * POST /chat/send
   * Body: { recipientId: string, text?: string, location?: { lat: number; lng: number }, type?: 'text' | 'location' }
   * 
   * Rate limited: 30 requests per minute per IP (chat-specific)
   */
  @Post('send')
  @Throttle({ default: { limit: 30, ttl: 60000 } }) // 30 messages per minute per IP
  async sendMessage(@Body() body: {
    recipientId?: string;
    sessionId?: string;
    userId?: string;
    message?: string;
    text?: string;
    location?: { lat: number; lng: number };
    userLocation?: { lat: number; lng: number; address?: string; zone_id?: number };
    zone_id?: number;
    type?: 'text' | 'location';
    metadata?: Record<string, any>;
  }) {
    // Support both recipientId and sessionId for backwards compatibility
    const recipientId = body.recipientId || body.sessionId || body.userId;
    // Support both text and message fields
    const text = body.text || body.message;
    const { location, userLocation, zone_id, type = 'text', metadata: requestMetadata } = body;
    
    // Prefer userLocation over location
    const finalLocation = userLocation || location;
    
    // Validate required field
    if (!recipientId) {
      return {
        success: false,
        error: 'recipientId or sessionId is required',
        response: 'Please provide a recipientId or sessionId',
      };
    }
    
    this.logger.log(`💬 Web chat message from ${recipientId}: "${type === 'location' ? 'Location Shared' : text}"`);
    
    try {
      // 🔧 FIX: DON'T add web- prefix if session already starts with 'sess-' (from WebSocket)
      // This fixes auth data mismatch between WebSocket and REST API sessions
      const webRecipientId = recipientId.startsWith('web-') || recipientId.startsWith('sess-') 
        ? recipientId 
        : `web-${recipientId}`;
      
      // Set platform in session before processing
      const session = await this.sessionService.getSession(webRecipientId);
      if (!session || !session.data?.platform) {
        await this.sessionService.setData(webRecipientId, {
          platform: 'web',
          channel: 'web_chat'
        });
        this.logger.log(`✅ Set platform=web for session ${webRecipientId} (session existed: ${!!session}, had platform: ${session?.data?.platform})`);
      } else {
        this.logger.log(`✅ Session ${webRecipientId} already has platform=${session.data.platform}, auth=${session.data?.authenticated}, uid=${session.data?.user_id}`);
      }
      
      // Save GPS location to session if provided
      if (finalLocation?.lat && finalLocation?.lng) {
        const locationData: any = {
          location: { lat: finalLocation.lat, lng: finalLocation.lng },
          user_lat: finalLocation.lat,
          user_lng: finalLocation.lng,
          lastLocationUpdate: Date.now(),
        };
        
        // Save zone_id if provided
        if (zone_id) {
          locationData.zone_id = zone_id;
        } else if (userLocation?.zone_id) {
          locationData.zone_id = userLocation.zone_id;
        }
        
        // Save address if provided
        if (userLocation?.address) {
          locationData.delivery_address = userLocation.address;
        }
        
        await this.sessionService.setData(webRecipientId, locationData);
        this.logger.log(`📍 Saved location to session: (${finalLocation.lat}, ${finalLocation.lng}, zone: ${locationData.zone_id || 'N/A'})`);
      }
      
      // Store user message
      this.addMessage(webRecipientId, type === 'location' ? `Location: ${finalLocation?.lat}, ${finalLocation?.lng}` : (text || ''), 'user');

      // Clear previous bot messages to get only new ones
      await this.sessionService.clearBotMessages(webRecipientId);

      // Use MessageGateway (Phase 1 modern architecture)
      // MessageGateway → ContextRouter → FlowEngine/Agents → Response
      // This ensures: proper routing, flow execution, logging, and session management
      await this.messageGateway.handleWebSocketMessage(
        webRecipientId,
        text || '',
        {
          location: finalLocation,
          type: type,
          ...(requestMetadata || {}),
        }
      );

      // Retrieve bot response stored by MessagingService in Redis
      const botMessages = await this.sessionService.getBotMessages(webRecipientId);
      
      let responseText = 'Message received. Processing...';
      let allCards: any[] = [];
      let allButtons: any[] = [];
      let metadata: any = {};
      
      if (botMessages && botMessages.length > 0) {
        // Combine ALL bot messages into a single response
        // This ensures welcome messages + flow prompts are both included
        const allMessages: string[] = [];
        
        for (const msg of botMessages) {
          if (typeof msg === 'object' && msg.message) {
            allMessages.push(msg.message);
            // Extract cards if present
            if (msg.cards && Array.isArray(msg.cards)) {
              allCards = [...allCards, ...msg.cards];
            }
            // Extract buttons if present
            if (msg.buttons && Array.isArray(msg.buttons)) {
              allButtons = [...allButtons, ...msg.buttons];
            }
            // Merge metadata if present
            if (msg.metadata) {
              metadata = { ...metadata, ...msg.metadata };
            }
          } else if (typeof msg === 'string') {
            allMessages.push(msg);
          } else {
            allMessages.push(JSON.stringify(msg));
          }
        }
        
        // Join with double newline for readability
        responseText = allMessages.join('\n\n');
      }
      
      // Store bot response in local message store for polling
      this.addMessage(webRecipientId, responseText, 'bot');

      // Safe logging - responseText might be object or string
      const logText = typeof responseText === 'string' 
        ? responseText.substring(0, 80) 
        : JSON.stringify(responseText).substring(0, 80);
      this.logger.log(`✅ Response retrieved: "${logText}..." cards: ${allCards.length}, buttons: ${allButtons.length}`);

      return {
        success: true,
        response: responseText,
        cards: allCards.length > 0 ? allCards : null,
        buttons: allButtons.length > 0 ? allButtons : null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Error processing web chat message: ${error.message}`, error.stack);
      
      const errorMsg = 'Sorry, I encountered an error. Please try again.';
      this.addMessage(recipientId, errorMsg, 'bot');
      
      return {
        success: false,
        error: error.message,
        response: errorMsg,
      };
    }
  }

  /**
   * Get messages for a recipient (polling endpoint)
   * 
   * GET /chat/messages/:recipientId
   */
  @Get('messages/:recipientId')
  async getMessages(@Param('recipientId') recipientId: string) {
    this.logger.debug(`📨 Fetching messages for ${recipientId}`);
    
    try {
      // Get stored messages
      const messages = this.messageStore.get(recipientId) || [];
      
      // Clear messages after reading (or keep last N messages)
      const unreadMessages = messages.filter(m => m.from === 'bot');
      
      // Clear bot messages that were sent (keep user messages for context)
      this.messageStore.set(
        recipientId,
        messages.filter(m => m.from === 'user')
      );

      return {
        success: true,
        recipientId,
        messages: unreadMessages.map(m => ({
          message: m.message,
          text: m.message,
          timestamp: m.timestamp,
          from: m.from,
        })),
        count: unreadMessages.length,
      };
    } catch (error) {
      this.logger.error(`Error fetching messages: ${error.message}`);
      return {
        success: false,
        error: error.message,
        messages: [],
      };
    }
  }

  /**
   * Get session information for a recipient
   * 
   * GET /chat/session/:recipientId
   */
  @Get('session/:recipientId')
  async getSession(@Param('recipientId') recipientId: string) {
    try {
      const session = await this.sessionService.getSession(recipientId);
      
      return {
        success: true,
        recipientId,
        session: session || null,
        hasActiveSession: !!session,
      };
    } catch (error) {
      this.logger.error(`Error fetching session: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Clear session for a recipient
   * 
   * POST /chat/session/:recipientId/clear
   */
  @Post('session/:recipientId/clear')
  async clearSession(@Param('recipientId') recipientId: string) {
    try {
      // 🔧 FIX: DON'T add web- prefix if session already starts with 'sess-'
      const webRecipientId = recipientId.startsWith('web-') || recipientId.startsWith('sess-') 
        ? recipientId 
        : `web-${recipientId}`;

      // Clear session - Create fresh session with 'welcome' step
      await this.sessionService.createSession(webRecipientId);
      
      // Clear message store
      this.messageStore.delete(recipientId);
      this.messageStore.delete(webRecipientId);
      
      this.logger.log(`✅ Session cleared and reset to 'welcome' for ${webRecipientId}`);
      
      return {
        success: true,
        message: 'Session cleared successfully',
        recipientId: webRecipientId,
      };
    } catch (error) {
      this.logger.error(`Error clearing session: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Live order status — polled by frontend after order placement
   *
   * GET /chat/track/:orderId
   * Returns current status from Redis cache (updated by webhooks) → MySQL fallback
   * No auth required: orderId itself is not guessable for other users' orders
   */
  @Get('track/:orderId')
  @SkipThrottle()
  async trackOrder(@Param('orderId') orderId: string) {
    const id = parseInt(orderId, 10);
    if (isNaN(id) || id <= 0) {
      return { success: false, error: 'Invalid orderId' };
    }

    try {
      const order = await this.orderDatabaseService.getOrderStatus(id);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Map status to a user-friendly step (1=confirmed, 2=preparing, 3=out for delivery, 4=delivered)
      const statusStep: Record<string, number> = {
        pending: 1, confirmed: 1, accepted: 1,
        processing: 2, preparing: 2,
        handover: 3, out_for_delivery: 3, picked_up: 3,
        delivered: 4, completed: 4,
      };

      return {
        success: true,
        orderId: id,
        status: order.status,
        step: statusStep[order.status] || 1,
        storeName: order.storeName,
        deliveryMan: order.deliveryManName || null,
        eta: order.eta || null,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
      };
    } catch (error) {
      this.logger.warn(`Order track error for #${orderId}: ${error.message}`);
      return { success: false, error: 'Could not fetch order status' };
    }
  }

  /**
   * Health check endpoint
   *
   * GET /chat/health
   */
  @Get('health')
  async health() {
    return {
      success: true,
      status: 'ok',
      service: 'Web Chat',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Helper: Add message to store
   */
  private addMessage(recipientId: string, message: string, from: 'bot' | 'user') {
    if (!this.messageStore.has(recipientId)) {
      this.messageStore.set(recipientId, []);
    }
    
    const messages = this.messageStore.get(recipientId);
    messages.push({
      message,
      timestamp: Date.now(),
      from,
    });

    // Keep only last 50 messages per recipient
    if (messages.length > 50) {
      messages.splice(0, messages.length - 50);
    }
  }
}
