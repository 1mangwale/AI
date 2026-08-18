import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/services/conversation.service';
import { SessionService } from '../session/session.service';
import { SessionIdentifierService } from '../session/session-identifier.service';
import { AgentOrchestratorService } from '../agents/services/agent-orchestrator.service';
import { ConversationLoggerService } from '../database/conversation-logger.service';
import { CentralizedAuthService } from '../auth/centralized-auth.service';
import { FlowEngineService } from '../flow-engine/flow-engine.service';
import { MessageGatewayService } from '../messaging/services/message-gateway.service';
import { PhpAuthService } from '../php-integration/services/php-auth.service';
import { LlmService } from '../llm/services/llm.service';
import { ConversationMemoryService } from '../ai/conversation-memory.service';
import { UserContextService } from '../user-context/user-context.service';

interface MessagePayload {
  message: string;
  sessionId: string;
  platform?: string;
  module?: string;
  type?: 'text' | 'button_click' | 'quick_reply' | 'location';
  action?: string; // For button clicks: action to execute
  metadata?: Record<string, any>; // Additional context
  location?: { latitude: number; longitude: number }; // For location messages
  // Auth info - included in every message to ensure session has auth
  auth?: {
    userId?: number;
    token?: string;
    phone?: string;
    email?: string;   // For Google OAuth users
    name?: string;    // For Google OAuth users
  };
}

/**
 * Every flow state that parks a user in front of the login modal.
 *
 * Both post-login resume paths MUST read this same list. They previously
 * disagreed: `session:join` carried all five, while `auth:login` — the event
 * the inline web login actually fires — carried only the two parcel states.
 * A food order therefore never resumed on the socket; it survived purely on
 * the frontend's 800ms `handleSend('checkout')` timer. That is a race, not a
 * handshake, and it is invisible until the network is slow.
 */
const LOGIN_WAIT_STATES = [
  'wait_for_login',
  'trigger_frontend_auth_order',
  'handle_frontend_auth_response',
  'trigger_frontend_auth_food',
  'handle_frontend_auth_food',
];

@WebSocketGateway({
  namespace: '/ai-agent',
  cors: {
    origin: [
      'https://chat.mangwale.ai',
      'https://admin.mangwale.ai',
      'https://test.mangwale.ai',
      'https://mangwale.ai',
      ...(process.env.ADDITIONAL_CORS_ORIGINS
        ? process.env.ADDITIONAL_CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
        : []),
      ...(process.env.NODE_ENV !== 'production' ? [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3005',
      ] : []),
    ],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000, // 60 seconds - client must respond to ping within this time
  pingInterval: 25000, // 25 seconds - send ping every 25 seconds
  upgradeTimeout: 30000, // 30 seconds for connection upgrade
  maxHttpBufferSize: 1e6, // 1MB
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  
  // Message deduplication cache: sessionId -> Map of message hash -> last send time
  private readonly messageCache = new Map<string, Map<string, number>>();
  private readonly DEDUP_WINDOW = 3000; // 3 seconds window for duplicate detection (accounts for network latency on slow connections)

  constructor(
    private readonly conversationService: ConversationService,
    private readonly sessionService: SessionService,
    private readonly sessionIdentifierService: SessionIdentifierService,
    private readonly agentOrchestratorService: AgentOrchestratorService,
    private readonly conversationLogger: ConversationLoggerService,
    private readonly centralizedAuth: CentralizedAuthService,
    private readonly flowEngineService: FlowEngineService,
    private readonly messageGateway: MessageGatewayService,
    private readonly phpAuthService: PhpAuthService,
    private readonly llmService: LlmService,
    private readonly conversationMemory: ConversationMemoryService,
    private readonly userContextService: UserContextService,
  ) {
    this.logger.log('🚀 ChatGateway instance created');
    
    // Cleanup old message hashes every minute
    setInterval(() => {
      this.messageCache.clear();
    }, 60000);
  }

  afterInit(server: Server) {
    this.logger.log('🚀 ChatGateway WebSocket server initialized on /ai-agent namespace');
  }

  async handleConnection(client: Socket) {
    this.logger.log(`🔌 Client connected: ${client.id}`);
    
    // Log transport type
    this.logger.debug(`📡 Transport: ${client.conn.transport.name}`);
    
    client.emit('connect_ack', { clientId: client.id, timestamp: Date.now() });
    
    // Listen for errors
    client.on('error', (error) => {
      this.logger.error(`❌ Client ${client.id} error:`, error);
    });
  }

  async handleDisconnect(client: Socket) {
    // Get disconnect reason from the socket
    const reason = client.disconnected ? 'client disconnected' : 'unknown';
    this.logger.log(`🔌 Client disconnected: ${client.id} | Reason: ${reason}`);
    this.logger.debug(`🔍 Disconnect details - Transport was: ${client.conn?.transport?.name || 'unknown'}`);
  }

  @SubscribeMessage('session:join')
  async handleJoinSession(
    @MessageBody() data: { 
      sessionId: string; 
      userId?: number; 
      phone?: string; 
      email?: string;
      token?: string;
      name?: string;
      platform?: string;  // 'web', 'whatsapp', 'instagram', etc.
    },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, userId, phone, email, token, name, platform } = data;
    this.logger.log(`📱 Client ${client.id} joining session: ${sessionId}`);
    this.logger.debug(`🔍 Received session:join data: ${JSON.stringify({ sessionId, userId, phone: phone ? '***' : undefined, email, token: token ? '***' : undefined, name, platform })}`);
    
    // ✅ GUEST MODE FIRST - Don't prompt auth immediately
    // Users can chat, browse, and explore without logging in
    // Auth will be triggered naturally when they try to place orders
    
    this.logger.log(`👋 User joining session: ${sessionId} | Authenticated: ${!!(userId || token)} | Platform: ${platform || 'web'}`);
    
    // Check existing session to preserve authentication state
    const existingSession = await this.sessionService.getSession(sessionId);
    const isAlreadyAuthenticated = existingSession?.data?.authenticated === true;
    
    if (!userId && !token && !isAlreadyAuthenticated) {
      this.logger.log(`🚶 Guest user ${sessionId} - allowing browsing without auth`);
    } else {
      this.logger.log(`✅ Authenticated user ${userId || existingSession?.data?.user_id} (${phone || email || existingSession?.data?.phone || 'unknown'})`);
    }
    
    // Store user authentication data in session
    // ✅ FIXED: Accept platform from client instead of always 'web'
    const sessionData: any = { 
      platform: platform || 'web',
    };
    
    // Set authenticated if userId provided OR VALID token provided OR already authenticated
    // ✅ FIX: Reject fake tokens like 'guest_token', 'null', 'undefined', empty strings
    // Validate token: reject known fakes, check minimum length, and verify JWT-like format (3 dot-separated segments)
    const isValidToken = token &&
      token !== 'guest_token' &&
      token !== 'null' &&
      token !== 'undefined' &&
      token.length > 20 &&
      token.split('.').length === 3; // JWT tokens always have 3 segments (header.payload.signature)
    const isValidUserId = userId && userId > 0;
    
    if (isValidUserId || isValidToken || isAlreadyAuthenticated) {
      sessionData.user_id = userId || existingSession?.data?.user_id;
      sessionData.authenticated = true;
      sessionData.authenticated_at = Date.now();
      this.logger.log(`✅ Session ${sessionId} marked as authenticated`);
      
      // 🔧 FIX: Query profile completeness from PostgreSQL for authenticated users
      // This ensures context-router knows the correct onboarding status
      try {
        const resolvedUserId = userId || existingSession?.data?.user_id;
        const resolvedPhone = phone || existingSession?.data?.phone || sessionId;
        
        if (resolvedUserId || resolvedPhone) {
          const pool = this.conversationLogger.getPool();
          if (pool) {
            const result = await pool.query(
              `SELECT profile_completeness FROM user_profiles 
               WHERE user_id = $1 OR phone = $2 LIMIT 1`,
              [resolvedUserId, resolvedPhone]
            );
            
            if (result.rows.length > 0) {
              const completeness = result.rows[0].profile_completeness || 0;
              sessionData.profile_completeness = completeness;
              sessionData.onboarding_completed = completeness >= 70;
              this.logger.log(`📊 Profile completeness for user ${resolvedUserId}: ${completeness}% (onboarding: ${sessionData.onboarding_completed ? 'complete' : 'needed'})`);
            } else {
              // No profile found - user needs onboarding
              sessionData.profile_completeness = 0;
              sessionData.onboarding_completed = false;
              this.logger.log(`📊 No profile found for user ${resolvedUserId} - onboarding needed`);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`⚠️ Could not check profile completeness: ${err.message}`);
        // On error, assume complete to not block the user
        sessionData.profile_completeness = 100;
        sessionData.onboarding_completed = true;
      }
    }
    
    // 🔧 CRITICAL FIX: Google OAuth users - look up their PHP account by email!
    // If they already have a PHP account with that email, we can get their user_id + phone
    const isGoogleOAuthUser = email && name && !phone && !userId;
    if (isGoogleOAuthUser) {
      this.logger.log(`🔐 Google OAuth user detected: ${email} (${name}) - checking PHP database...`);
      
      // Try to find existing PHP user by email
      try {
        const existingUser = await this.phpAuthService.checkUserExistsByEmail(email);
        if (existingUser.exists && existingUser.data) {
          // User exists in PHP! Use their data
          this.logger.log(`✅ Found existing PHP user: ID=${existingUser.data.id}, phone=${existingUser.data.phone}`);
          sessionData.user_id = existingUser.data.id;
          sessionData.phone = existingUser.data.phone;
          sessionData.phone_number = existingUser.data.phone;
          sessionData.authenticated = true;
          sessionData.php_linked = true;
          sessionData.needs_php_account = false;
          
          // Try to get auth token via platform-login for API calls
          if (existingUser.data.phone) {
            try {
              const loginResult = await this.phpAuthService.autoLogin(existingUser.data.phone, 'whatsapp');
              if (loginResult.success && loginResult.data?.token) {
                sessionData.auth_token = loginResult.data.token;
                this.logger.log(`✅ Got PHP auth token for Google OAuth user`);
              }
            } catch (loginErr) {
              this.logger.warn(`⚠️ Could not get auth token: ${loginErr.message}`);
            }
          }
        } else {
          // No existing PHP account - need to collect phone
          this.logger.log(`🆕 No PHP account for ${email} - needs phone for account linking`);
          sessionData.authenticated = true;
          sessionData.needs_php_account = true;
        }
      } catch (lookupErr) {
        this.logger.error(`❌ Error looking up user by email: ${lookupErr.message}`);
        sessionData.authenticated = true;
        sessionData.needs_php_account = true;
      }
      
      sessionData.onboarding_completed = true;
      sessionData.onboarding_skipped_reason = 'google_oauth';
      sessionData.email = email;
      sessionData.user_name = name;
    }
    
    if (phone) sessionData.phone = phone;
    if (email) sessionData.email = email;
    if (token) sessionData.auth_token = token;
    if (name) sessionData.user_name = name;
    
    await this.sessionService.setData(sessionId, sessionData);
    
    await client.join(sessionId);
    
    // Retrieve conversation history for reconnection (last 20 messages)
    // This ensures messages are not lost when WebSocket reconnects
    let history: any[] = [];
    try {
      history = await this.conversationLogger.getSessionHistory(sessionId, 20);
      if (history.length > 0) {
        this.logger.log(`📜 Retrieved ${history.length} messages for session ${sessionId}`);
      }
    } catch (error) {
      this.logger.warn(`Could not retrieve session history: ${error.message}`);
    }
    
    // ✨ ENHANCED: Emit detailed auth status to frontend for proper profile display
    const isAuthenticated = !!(userId || token || isAlreadyAuthenticated);
    const storedUserId = userId || existingSession?.data?.user_id;
    const storedUserName = name || existingSession?.data?.user_name || 'User';
    const storedToken = token || existingSession?.data?.auth_token;
    const storedPhone = phone || existingSession?.data?.phone;
    const storedEmail = email || existingSession?.data?.email;
    
    this.logger.debug(`🔍 Auth Data Summary:
      isAuthenticated: ${isAuthenticated}
      userId: ${storedUserId}
      userName: ${storedUserName}
      phone: ${storedPhone}
      hasToken: ${!!storedToken}`);
    
    if (isAuthenticated && storedUserId) {
      // Send auth success to sync frontend state with COMPLETE user data
      const [fName, ...lNameParts] = storedUserName.split(' ');
      const authSuccessData = {
        token: storedToken,
        user: {
          id: storedUserId,
          f_name: fName || 'User',
          l_name: lNameParts.join(' ') || '',
          phone: storedPhone || '',
          email: storedEmail || '',
        },
        phone: storedPhone,
        authenticated: true,
      };
      
      client.emit('auth:success', authSuccessData);
      this.logger.log(`🔐 Emitted auth:success for user ${storedUserId} (${storedUserName})`);
      this.logger.debug(`📤 Auth success payload: ${JSON.stringify(authSuccessData)}`);
    } else if (!isAuthenticated) {
      this.logger.log(`👤 Guest session joined: ${sessionId}`);
    }
    
    client.emit('session:joined', { 
      sessionId,
      history,
      authenticated: isAuthenticated,
      user: isAuthenticated ? {
        id: storedUserId,
        name: storedUserName,
        phone: storedPhone,
        email: storedEmail,
      } : null,
    });
  }

  @SubscribeMessage('session:leave')
  async handleLeaveSession(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = data;
    this.logger.log(`📱 Client ${client.id} leaving session: ${sessionId}`);
    await client.leave(sessionId);
    client.emit('session:left', { sessionId });
  }

  @SubscribeMessage('message:send')
  async handleMessage(
    @MessageBody() payload: MessagePayload,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.debug(`handleMessage called`, { sessionId: payload?.sessionId });
    const t0 = Date.now();
    const { message, sessionId } = payload;
    
    if (!message || !sessionId) {
      client.emit('error', { message: 'Message and sessionId are required' });
      return;
    }

    // Check for duplicate message (prevent double-send from frontend)
    // FIX: Use exact timestamp + message hash instead of quantized window
    // This prevents false positives where different messages within 5s get deduplicated
    const crypto = require('crypto');
    const msgHash = crypto.createHash('md5').update(message).digest('hex');
    // Allow same message twice if at least DEDUP_WINDOW ms has passed
    const messageKey = `${sessionId}:${msgHash}`;
    const currentTime = Date.now();
    
    if (!this.messageCache.has(sessionId)) {
      this.messageCache.set(sessionId, new Map());
    }
    
    const sessionCache = this.messageCache.get(sessionId)!;
    const lastSendTime = sessionCache.get(messageKey);
    
    if (lastSendTime && (currentTime - lastSendTime) < this.DEDUP_WINDOW) {
      this.logger.warn(`⚠️ Duplicate message detected and ignored: "${message}" from ${sessionId} (sent ${currentTime - lastSendTime}ms ago)`);
      return;
    }
    
    // Record this message
    sessionCache.set(messageKey, currentTime);
    // Auto-cleanup old entries after dedup window
    setTimeout(() => {
      const timeAfterCleanup = Date.now();
      if (timeAfterCleanup - currentTime > this.DEDUP_WINDOW * 2) {
        sessionCache.delete(messageKey);
      }
    }, this.DEDUP_WINDOW);

    this.logger.log(`💬 Message from ${sessionId}: "${message}" | Type: ${payload.type || 'text'}`);
    this.logger.debug(`📦 Raw Payload: ${JSON.stringify(payload)}`);

    try {
      // 🔐 SYNC AUTH FROM MESSAGE - ALWAYS ensure session has auth data
      // This fixes multiple issues:
      // 1. Race condition where flow starts before session:join completes
      // 2. Session data loss after Redis TTL expiry
      // 3. Auth data not being available when flow engine reads session
      // 4. Client leaving room due to frontend effect cleanup (auth state change)

      // Ensure client is in the session room (single check for all auth paths)
      if (!client.rooms.has(sessionId)) {
        this.logger.log(`🔧 Client not in room ${sessionId} - rejoining`);
        await client.join(sessionId);
      }

      if (payload.auth?.userId || payload.auth?.token) {
        const existingSession = await this.sessionService.getSession(sessionId);
        const isAlreadyAuthed = existingSession?.data?.authenticated === true && 
                                 existingSession?.data?.user_id === payload.auth.userId &&
                                 existingSession?.data?.auth_token; // Also check token exists
        
        if (!isAlreadyAuthed) {
          this.logger.log(`🔐 Auth sync from message: userId=${payload.auth.userId}, hasToken=${!!payload.auth.token}`);
          const authData: Record<string, any> = {
            authenticated: true,
            authenticated_at: Date.now(),
          };
          if (payload.auth.userId) authData.user_id = payload.auth.userId;
          if (payload.auth.token) authData.auth_token = payload.auth.token;
          if (payload.auth.phone) authData.phone = payload.auth.phone;
          if (payload.auth.email) authData.email = payload.auth.email;
          if (payload.auth.name) authData.user_name = payload.auth.name;
          
          await this.sessionService.setData(sessionId, authData);
          this.logger.log(`✅ Auth synced to session ${sessionId}`);
        }
      }
      // Also handle Google OAuth users (have email + name but no userId yet)
      else if (payload.auth?.email && payload.auth?.name) {
        const existingSession = await this.sessionService.getSession(sessionId);
        const isAlreadyAuthed = existingSession?.data?.authenticated === true && 
                                 existingSession?.data?.user_id; // Also check user_id exists
        
        if (!isAlreadyAuthed) {
          this.logger.log(`🔐 Google OAuth auth in message - syncing: email=${payload.auth.email}`);
          const authData: Record<string, any> = {
            email: payload.auth.email,
            user_name: payload.auth.name,
            authenticated: true,
            onboarding_completed: true,
            onboarding_skipped_reason: 'google_oauth',
            needs_php_account: true,
            authenticated_at: Date.now(),
          };
          
          // 🔧 FIX: Also do PHP user lookup by email (same as session:join)
          // This handles the case where session:join was missed or didn't have auth data
          try {
            const existingUser = await this.phpAuthService.checkUserExistsByEmail(payload.auth.email);
            if (existingUser.exists && existingUser.data) {
              this.logger.log(`✅ Found PHP user for Google OAuth in message: ID=${existingUser.data.id}`);
              authData.user_id = existingUser.data.id;
              authData.phone = existingUser.data.phone;
              authData.phone_number = existingUser.data.phone;
              authData.needs_php_account = false;
              authData.php_linked = true;
              
              // Try to get auth token
              if (existingUser.data.phone) {
                try {
                  const loginResult = await this.phpAuthService.autoLogin(existingUser.data.phone, 'whatsapp');
                  if (loginResult.success && loginResult.data?.token) {
                    authData.auth_token = loginResult.data.token;
                    this.logger.log(`✅ Got PHP auth token for Google OAuth user via message`);
                  }
                } catch (loginErr) {
                  this.logger.warn(`⚠️ Could not get auth token in message sync: ${loginErr.message}`);
                }
              }
            }
          } catch (lookupErr) {
            this.logger.warn(`⚠️ PHP user lookup failed in message sync: ${lookupErr.message}`);
          }
          
          await this.sessionService.setData(sessionId, authData);
          this.logger.log(`✅ Google OAuth auth synced to session ${sessionId} (user_id=${authData.user_id || 'pending'})`);
        }
      }
      // 🔧 FIX: Even if no auth payload, ensure client is in the room
      // This handles the case where frontend cleanup removed client from room
      else {
        const rooms = client.rooms;
        if (!rooms.has(sessionId)) {
          this.logger.log(`🔧 Client not in room ${sessionId} (no auth payload) - rejoining`);
          await client.join(sessionId);
        }
      }

      // Handle __init__ message - user-aware initialization
      if (message === '__init__' && payload.metadata?.isInit) {
        this.logger.log(`🎯 Init message received - User: ${payload.metadata.userName || 'Guest'}`);
        
        // Store user info in session if provided
        if (payload.metadata.userId) {
          await this.sessionService.setData(sessionId, {
            user_id: payload.metadata.userId,
            userName: payload.metadata.userName,
            phone: payload.metadata.phone,
            authenticated: true,
          });
        }
        
        // 🎯 PERSONALIZATION: Fetch and emit user context for personalized welcome screen
        const phone = payload.metadata.phone || payload.auth?.phone;
        if (phone) {
          try {
            const userContext = await this.userContextService.getUserContext(phone);
            if (userContext) {
              const personalizedData = {
                userName: userContext.firstName || payload.metadata.userName,
                walletBalance: userContext.wallet?.balance || 0,
                loyaltyPoints: userContext.wallet?.loyaltyPoints || 0,
                totalOrders: userContext.orderHistory?.totalOrders || 0,
                recentOrders: (userContext.orderHistory?.recentOrders || []).slice(0, 3).map(o => ({
                  storeName: o.storeName,
                  items: o.items?.slice(0, 3) || [],
                  amount: o.amount,
                  status: o.status,
                })),
                favoriteStores: (userContext.orderHistory?.favoriteStores || []).slice(0, 3).map(s => ({
                  storeName: s.storeName,
                  orderCount: s.orderCount,
                })),
                favoriteItems: (userContext.orderHistory?.favoriteItems || []).slice(0, 5).map(i => ({
                  itemName: i.itemName,
                  orderCount: i.orderCount,
                })),
                suggestedActions: userContext.suggestedActions || [],
                dietaryType: userContext.preferences?.dietaryType || null,
              };
              client.emit('user:context', personalizedData);
              this.logger.log(`👤 Emitted user:context for ${userContext.firstName}: ${userContext.orderHistory?.totalOrders || 0} orders, ₹${userContext.wallet?.balance?.toFixed(0) || 0} wallet`);
              
              // 🎯 CRITICAL: If user has real order history, they're NOT a first-time user!
              // Skip onboarding for returning users — profile them from their order data instead
              const totalOrders = userContext.orderHistory?.totalOrders || 0;
              if (totalOrders > 0) {
                await this.sessionService.setData(sessionId, {
                  onboarding_completed: true,
                  profile_completeness: 100,
                  onboarding_skipped_reason: `returning_user_${totalOrders}_orders`,
                  user_name: userContext.firstName || payload.metadata.userName,
                  dietary_type: userContext.preferences?.dietaryType || 'unknown',
                  wallet_balance: userContext.wallet?.balance || 0,
                  loyalty_points: userContext.wallet?.loyaltyPoints || 0,
                });
                this.logger.log(`🎯 Returning user detected (${totalOrders} orders) — skipping onboarding for ${sessionId}`);
              }
            }
          } catch (err) {
            this.logger.warn(`⚠️ Failed to fetch user context for init: ${err.message}`);
          }
        }
        
        // 🔄 CRITICAL: Check if there's an active flow waiting for login before showing greeting
        // This handles: user starts parcel/order → gets login prompt → logs in → __init__ fires
        // We should RESUME the flow, not show a generic greeting
        try {
          const flowContext = await this.flowEngineService.getContext(sessionId);
          if (flowContext && LOGIN_WAIT_STATES.includes(flowContext.currentState)) {
            this.logger.log(`🔄 Active flow "${flowContext.flowId}" waiting at "${flowContext.currentState}" — resuming after login`);
            
            // Send a brief "logged in" confirmation
            const loginConfirmation = `Hello${payload.metadata.userName ? ' ' + payload.metadata.userName : ''}! 👋 Welcome back to Mangwale!\n\nContinuing where you left off...`;
            client.emit('message', {
              content: loginConfirmation,
              role: 'assistant',
              timestamp: Date.now(),
            });
            
            // Resume the flow — the auth data is already stored in session from session:join
            const resumeResult = await this.flowEngineService.processMessage(
              sessionId,
              '__AUTH_COMPLETE__',
              'user_message'
            );
            
            if (resumeResult?.response) {
              this.emitBotResponse(client, sessionId, resumeResult);
            }
            return;
          }

          // 🛒 A live flow that is NOT waiting for login: the customer logged
          // in voluntarily, mid-order. Re-render where they actually are instead
          // of burying a live cart under the generic menu greeting below.
          // rerenderCurrentState() only re-runs a wait state's onEntry and never
          // advances the flow, so this is safe for any non-terminal state.
          if (flowContext?.currentState) {
            const resumed = await this.flowEngineService.rerenderCurrentState(sessionId);
            if (resumed?.response || resumed?.cards?.length) {
              this.logger.log(
                `🛒 Live flow "${flowContext.flowId}" parked at "${flowContext.currentState}" - re-rendering after voluntary login`,
              );
              client.emit('message', {
                content: `Hello${payload.metadata.userName ? ' ' + payload.metadata.userName : ''}! 👋 Welcome back to Mangwale!\n\nPicking up where you left off...`,
                role: 'assistant',
                timestamp: Date.now(),
              });
              this.emitBotResponse(client, sessionId, resumed);
              return;
            }
          }
        } catch (flowResumeErr) {
          this.logger.warn(`⚠️ Flow resume check failed: ${flowResumeErr.message}`);
          // Fall through to normal greeting
        }
        
        // For __init__ with isInit, emit a greeting message with main menu buttons
        // and return — don't send raw '__init__' text to the NLU/flow engine
        const greeting = `Hello${payload.metadata.userName ? ' ' + payload.metadata.userName : ''}! 👋 Welcome back to Mangwale!\n\nWhat would you like to do today?`;
        client.emit('message', {
          content: greeting,
          role: 'assistant',
          timestamp: Date.now(),
          buttons: [
            { label: '🍔 Order Food', value: 'order_food', action: 'order_food' },
            { label: '📦 Send Parcel', value: 'send_parcel', action: 'send_parcel' },
            { label: '🛒 Shop Online', value: 'shop_online', action: 'shop_online' },
            { label: '❓ Help & Support', value: 'help_support', action: 'help_support' },
          ],
        });
        return;
      }
      
      // Handle button clicks - convert action to proper message
      let processedMessage = message;
      if (payload.type === 'button_click' && payload.action) {
        this.logger.log(`🔘 Button click detected: ${payload.action}`);
        
        // Special handling for location button - trigger location request
        if (payload.action === '__LOCATION__' || payload.action === 'share_location') {
          this.logger.log(`📍 Location button clicked - requesting location from client`);
          client.emit('request:location', { 
            sessionId,
            message: 'Please share your location for better results' 
          });
          return; // Don't process further, wait for location:update event
        }
        
        // Known intent values that need conversion to natural language for NLU
        // NOTE: Do NOT add flow-internal button values here (browse_menu, popular, surprise)
        // — those need to pass through as-is for the flow's decision nodes to match
        const intentValueMap: Record<string, string> = {
          'order_food': 'I want to order food',
          'parcel_booking': 'I want to book a parcel',
          'search_product': 'I want to search for products',
          'help': 'I need help',
        };
        
        // Check if button value is a known intent that needs conversion
        if (message && intentValueMap[message]) {
          processedMessage = intentValueMap[message];
          this.logger.log(`✨ Converted intent value "${message}" to: "${processedMessage}"`);
        }
        // Use the button VALUE (from message) if it's a meaningful value (number, text)
        // Only convert action to message if the message is just a generic action ID
        else if (message && !message.startsWith('btn-') && message !== payload.action) {
          // Message contains the actual button value (e.g., "2" for address selection)
          processedMessage = message;
          this.logger.log(`✨ Using button value: "${processedMessage}"`);
        }
        // Preserve structured button values (item_ID, category_ID, etc.) — don't strip underscores
        // Also preserves flow-internal buttons: browse_menu, popular, surprise
        else if (message && /^(item_\d+|category_\d+|store_\d+|skip_location|search_different|view_cart|show_cart|browse_menu|popular|surprise|clear_cart|add_more)$/i.test(message)) {
          processedMessage = message;
          this.logger.log(`✨ Using structured button value: "${processedMessage}"`);
        } else {
          // Message is just the action ID, convert it to natural language
          processedMessage = this.convertButtonActionToMessage(payload.action, payload.metadata);
          this.logger.log(`✨ Converted to message: "${processedMessage}"`);
        }
      }
      
      // 📍 Handle location messages - save location to session for flow engine
      if (payload.type === 'location' && payload.location) {
        this.logger.log(`📍 Location message received: (${payload.location.latitude}, ${payload.location.longitude})`);
        await this.sessionService.setData(sessionId, {
          location: { lat: payload.location.latitude, lng: payload.location.longitude },
          lastLocationUpdate: Date.now(),
          // Also store as _user_location for address executor
          _user_location: payload.location,
        });
        this.logger.log(`📍 Location saved to session`);
      }
      
      // 🔐 Use SessionIdentifierService to properly resolve phone number from session
      // This handles web chat where sessionId != phoneNumber
      const identifierResolution = await this.sessionIdentifierService.resolve(sessionId);
      const phone = identifierResolution.phoneNumber || sessionId;
      const userId = identifierResolution.userId;
      
      this.logger.log(`📋 Session data: userId=${userId}, phone=${identifierResolution.isPhoneVerified ? '***verified' : (phone ? '***' : 'none')}`);
      
      // Log user message to PostgreSQL
      const tDbUserStart = Date.now();
      try {
        await this.conversationLogger.logUserMessage({
          phone,
          userId,
          messageText: message,
          platform: 'web',
          sessionId,
        });
        this.logger.log(`✅ User message logged to database`);
      } catch (dbError) {
        this.logger.error(`❌ Failed to log user message to DB: ${dbError.message}`, dbError.stack);
        // Continue processing even if logging fails
      }
      const dbUserMs = Date.now() - tDbUserStart;

      // Send typing indicator
      this.server.to(sessionId).emit('typing', { isTyping: true });
      this.logger.log(`⌨️ Typing indicator sent to session ${sessionId}`);

      // Clear previous bot messages to get only new ones
      const tClearBotStart = Date.now();
      await this.sessionService.clearBotMessages(sessionId);
      const clearBotMs = Date.now() - tClearBotStart;

      // Process the message through NEW MessageGateway (Unified Architecture - Phase 1)
      // NOW WITH SYNC SUPPORT - response comes directly!
      const contextModule = payload.module || 'general';
      this.logger.log(`🚀 Processing message through MessageGateway (SYNC) with module: ${contextModule}`);
      
      // 🔧 FIX: Preserve original button value for flow transitions
      // When user clicks a button like "Popular items" with value "popular",
      // we need to pass "popular" as the event for the flow transition
      const buttonValue = (payload.type === 'button_click' && message) ? message : undefined;
      
      let result;
      try {
        const tGatewayStart = Date.now();
        result = await this.messageGateway.handleWebSocketMessage(sessionId, processedMessage, {
          module: contextModule,
          type: payload.type,
          action: payload.action,
          location: payload.location,
          metadata: payload.metadata,
          value: buttonValue, // Pass original button value for flow event
        });
        const gatewayMs = Date.now() - tGatewayStart;
        this.logger.log(`✅ MessageGateway SYNC result: success=${result?.success}, routedTo=${result?.routedTo}, hasResponse=${!!result?.response}`);

        const totalMs = Date.now() - t0;
        // Only warn when slow to avoid noisy logs.
        if (totalMs > 2000) {
          this.logger.warn(
            `🐢 Slow message processing ${totalMs}ms (dbUser=${dbUserMs}ms, clearBot=${clearBotMs}ms, gateway=${gatewayMs}ms)`
          );
        }
      } catch (gatewayError) {
        this.logger.error(`❌ MessageGateway failed: ${gatewayError.message}`, gatewayError.stack);
        throw gatewayError;
      }

      // Stop typing indicator
      this.server.to(sessionId).emit('typing', { isTyping: false });

      // 🔥 NEW: Use SYNC response directly from MessageGateway
      // The response now comes WITH content (no need to fetch from session)
      if (result?.success && result?.response) {
        // Direct SYNC response from MessageGateway
        // Handle case where response might be object, string, or JSON string
        let rawResponse = result.response;
        
        // If rawResponse is a JSON string, parse it
        if (typeof rawResponse === 'string') {
          try {
            const parsed = JSON.parse(rawResponse);
            if (typeof parsed === 'object' && parsed !== null) {
              rawResponse = parsed;
            }
          } catch {
            // Not JSON, keep as string
          }
        }
        
        // Extract message text from various possible structures
        // FIX: Handle nested response objects (e.g., { response: { message: "..." } })
        let messageText: string;
        if (typeof rawResponse === 'string') {
          messageText = rawResponse;
        } else if (typeof rawResponse === 'object' && rawResponse !== null) {
          // Try all possible message fields, including nested ones
          messageText = rawResponse.message 
            || rawResponse.content 
            || rawResponse.text 
            || rawResponse.response?.message 
            || rawResponse.response?.content 
            || rawResponse.response?.text
            || (typeof rawResponse.response === 'string' ? rawResponse.response : '')
            || '';
          
          // If still empty and it's an object, log for debugging
          if (!messageText && Object.keys(rawResponse).length > 0) {
            this.logger.warn(`⚠️ Could not extract message from response object. Keys: ${Object.keys(rawResponse).join(', ')}`);
          }
        } else {
          messageText = '';
        }
        
        // Strip outer quotes if present (sometimes LLM adds them)
        if (typeof messageText === 'string') {
          messageText = messageText.trim();
          if (messageText.startsWith('"') && messageText.endsWith('"')) {
            messageText = messageText.slice(1, -1);
          }
        }
        
        const buttons = result.buttons || rawResponse?.buttons;
        const cards = result.cards || rawResponse?.cards;
        const metadata = result.metadata || rawResponse?.metadata;
        
        const textPreview = typeof messageText === 'string' ? messageText.substring(0, 50) : String(messageText ?? '').substring(0, 50);
        this.logger.log(`📤 SYNC Response: ${textPreview}... [${buttons?.length || 0} buttons] [${cards?.length || 0} cards]`);
        
        // Get fresh session for flowContext (may have been updated during processing)
        const currentSession = await this.sessionService.getSession(sessionId);
        const flowContext = currentSession?.data?.flowContext;
        
        // Check if user was just authenticated via flow (OTP verification)
        // and emit auth:success event to frontend
        // Auth data can be in flowContext.data OR directly in session.data (agent-orchestrator path)
        const flowAuthData = currentSession?.data?.flowContext?.data;
        const sessionAuthData = currentSession?.data;
        const isAuthenticated = flowAuthData?.authenticated || sessionAuthData?.authenticated;
        const authToken = flowAuthData?.auth_token || sessionAuthData?.auth_token;
        const userId = flowAuthData?.user_id || sessionAuthData?.user_id;
        const userName = flowAuthData?.user_name || sessionAuthData?.user_name;
        const userPhone = flowAuthData?.phone || sessionAuthData?.phone || sessionAuthData?.tempPhone;
        
        if (isAuthenticated && authToken && !currentSession?.data?.authEmitted) {
          this.logger.log(`🔐 User authenticated via flow, emitting auth:success for user_id=${userId}, phone=${userPhone}`);
          client.emit('auth:success', {
            token: authToken,
            user: {
              id: userId,
              f_name: userName?.split(' ')[0] || 'User',
              l_name: userName?.split(' ').slice(1).join(' ') || '',
              phone: userPhone,
            },
            phone: userPhone,
          });
          // Mark auth as emitted to avoid duplicate events
          await this.sessionService.setData(sessionId, { authEmitted: true });
        }

        // Build message payload
        const messagePayload: any = {
          id: `${Date.now()}-${Math.random()}`,
          role: 'assistant',
          content: messageText,
          timestamp: Date.now(),
        };
        
        // Add buttons if present
        if (buttons && buttons.length > 0) {
          messagePayload.buttons = buttons;
          this.logger.log(`✅ Added ${buttons.length} buttons to response`);
        }

        // Add cards if present
        if (cards && cards.length > 0) {
          messagePayload.cards = cards;
          this.logger.log(`✅ Added ${cards.length} cards to response`);
        }
        
        // Add metadata if present (including action triggers like trigger_auth_modal)
        if (metadata) {
          messagePayload.metadata = metadata;
          this.logger.log(`✅ Added metadata to response: ${JSON.stringify(metadata)}`);
        }
        
        this.server.to(sessionId).emit('message', messagePayload);
        
        // 🛒 RUNNING CART: Emit cart:update event if flow context has cart data
        // This enables the frontend to show a persistent running cart UI
        try {
          const cartItems = flowContext?.data?.cart_items;
          const cartData = flowContext?.data?.cart_data || flowContext?.data?.selected_items;
          if (cartItems || cartData) {
            const rawCart = Array.isArray(cartData) ? cartData : (Array.isArray(cartItems) ? cartItems : []);
            const totalPrice = rawCart.reduce((sum: number, item: any) => sum + ((item.price || item.unitPrice || 0) * (item.quantity || 1)), 0);
            const totalItems = rawCart.reduce((sum: number, item: any) => sum + (item.quantity || 1), 0);
            
            this.server.to(sessionId).emit('cart:update', {
              items: rawCart.map((item: any) => ({
                id: item.itemId || item.id,
                name: item.itemName || item.name,
                price: item.price || item.unitPrice || 0,
                quantity: item.quantity || 1,
                storeName: item.storeName || item.store_name,
                storeId: item.storeId || item.store_id,
                image: item.image || '',
                variationLabel: item.variationLabel || null,
              })),
              totalPrice,
              totalItems,
              storeCount: new Set(rawCart.map((item: any) => item.storeId || item.store_id)).size,
              isMultiStore: new Set(rawCart.map((item: any) => item.storeId || item.store_id)).size > 1,
            });
            this.logger.debug(`🛒 Emitted cart:update: ${totalItems} items, ₹${totalPrice}`);
          }
        } catch (cartErr) {
          this.logger.debug(`Cart update emission skipped: ${cartErr.message}`);
        }
        
        // 🧠 Option C: Store conversation in vector memory (non-blocking)
        const currentSessionForMemory = await this.sessionService.getSession(sessionId);
        this.storeConversationMemory(sessionId, currentSessionForMemory, message, messageText)
          .catch(e => this.logger.debug(`Memory store (non-blocking): ${e.message}`));
        
        return; // 🔥 Return early - sync path complete!
      }

      // FALLBACK: Try legacy path (getBotMessages) if sync response is empty
      const botMessages = await this.sessionService.getBotMessages(sessionId);
      const latestResponse = botMessages[botMessages.length - 1];

      // Send response back to client
      if (result?.success && latestResponse) {
        let response: any = latestResponse; // Response from bot messages cache
        
        // If response is a JSON string, parse it first
        if (typeof response === 'string') {
          try {
            const parsed = JSON.parse(response);
            if (typeof parsed === 'object' && parsed !== null) {
              response = parsed;
            }
          } catch {
            // Not JSON, keep as string
          }
        }
        
        // Handle structured response (with buttons) vs simple string response
        let messageText: string;
        let buttons: any[] | undefined;
        let cards: any[] | undefined;
        let metadata: any;
        
        if (typeof response === 'string') {
          // Simple string response from LLM executor
          messageText = response;
          const textPreview = messageText.substring(0, 50);
          this.logger.log(`📤 [LEGACY] String response: ${textPreview}...`);
        } else if (typeof response === 'object' && response !== null) {
          // Structured response - check multiple possible text fields
          let rawMessage = response.message || response.content || response.text || response.response;
          
          // If rawMessage is still an object, try to extract text from it
          if (typeof rawMessage === 'object' && rawMessage !== null) {
            rawMessage = rawMessage.message || rawMessage.content || rawMessage.text || rawMessage.response || '';
          }
          
          // Handle case where message itself is JSON string
          if (typeof rawMessage === 'string') {
            try {
              const parsedMsg = JSON.parse(rawMessage);
              if (typeof parsedMsg === 'object' && parsedMsg !== null) {
                rawMessage = parsedMsg.message || parsedMsg.content || parsedMsg.text || rawMessage;
              }
            } catch {
              // Not JSON, keep as string
            }
          }
          
          messageText = typeof rawMessage === 'string' ? rawMessage : String(rawMessage ?? '');
          buttons = response.buttons;
          // Cards can be at response.cards OR response.metadata.cards
          cards = response.cards || (response.metadata?.cards);
          metadata = response.metadata;
          const textPreview = messageText.substring(0, 50);
          this.logger.log(`📤 [LEGACY] Structured response: ${textPreview}... [${buttons?.length || 0} buttons] [${cards?.length || 0} cards]`);
          
          // If still no message text but have cards, set a default
          if (!messageText && cards?.length) {
            messageText = 'Here are some options for you:';
          }
        } else {
          this.logger.warn(`⚠️ Unexpected response type: ${typeof response}, value: ${JSON.stringify(response)?.substring(0, 100)}`);
          messageText = '';
        }
        
        // Log bot response to PostgreSQL
        // Get fresh session for flowContext (may have been updated during processing)
        const currentSession = await this.sessionService.getSession(sessionId);
        const flowContext = currentSession?.data?.flowContext;
        
        // Check if user was just authenticated via flow (OTP verification)
        // and emit auth:success event to frontend
        const authData = currentSession?.data?.flowContext?.data;
        if (authData?.authenticated && authData?.auth_token && !currentSession?.data?.authEmitted) {
          this.logger.log(`🔐 User authenticated via flow, emitting auth:success`);
          client.emit('auth:success', {
            token: authData.auth_token,
            user: authData.user || { phone: authData.phone, name: authData.name },
            phone: authData.phone,
          });
          // Mark auth as emitted to avoid duplicate events
          await this.sessionService.setData(sessionId, { authEmitted: true });
        }
        try {
          await this.conversationLogger.logBotMessage({
            phone,
            userId,
            messageText,
            platform: 'web',
            sessionId,
            flowId: flowContext?.flowId,
            stepId: flowContext?.currentStepId,
          });
          this.logger.log(`✅ Bot message logged to database`);
        } catch (dbError) {
          this.logger.error(`❌ Failed to log bot message to DB: ${dbError.message}`, dbError.stack);
        }
        
        // Build message payload
        const messagePayload: any = {
          id: `${Date.now()}-${Math.random()}`,
          role: 'assistant',
          content: messageText,
          timestamp: Date.now(),
        };
        
        // Add buttons if present (for structured responses)
        if (buttons && buttons.length > 0) {
          messagePayload.buttons = buttons;
          this.logger.log(`✅ Added ${buttons.length} buttons to response`);
        }

        // Add cards if present (for structured responses)
        if (cards && cards.length > 0) {
          messagePayload.cards = cards;
          this.logger.log(`✅ Added ${cards.length} cards to response`);
        }
        
        // Add metadata if present
        if (metadata) {
          messagePayload.metadata = metadata;
        }
        
        this.server.to(sessionId).emit('message', messagePayload);
      } else {
        // 🔧 FIX: If message was dropped due to dedup, silently stop typing
        // Don't show a generic fallback that confuses the user
        if (result?.routedTo === 'dropped') {
          this.logger.warn(`⚠️ Message dropped (dedup) for ${sessionId} - no fallback shown`);
          this.server.to(sessionId).emit('typing', { isTyping: false });
        } else {
          this.logger.warn(`⚠️ No response from Agent Orchestrator for ${sessionId}`);
          // Fallback message
          this.server.to(sessionId).emit('message', {
            id: `${Date.now()}-fallback`,
            role: 'assistant',
            content: 'I\'m here to help! What can I do for you today?',
            timestamp: Date.now(),
          });
        }
      }
    } catch (error) {
      this.logger.error(`Error processing message: ${error.message}`, error.stack);
      this.server.to(sessionId).emit('typing', { isTyping: false });
      client.emit('error', {
        message: 'Failed to process message',
        error: error.message,
      });
    }
  }

  @SubscribeMessage('typing')
  async handleTyping(
    @MessageBody() data: { sessionId: string; isTyping: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, isTyping } = data;
    // Broadcast typing status to other clients in the session
    client.to(sessionId).emit('typing', { isTyping, clientId: client.id });
  }

  @SubscribeMessage('location:update')
  async handleLocationUpdate(
    @MessageBody() data: { sessionId: string; lat: number; lng: number; zoneId?: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, lat, lng, zoneId } = data;
    this.logger.log(`📍 Location update for ${sessionId}: (${lat}, ${lng})${zoneId ? `, zoneId=${zoneId}` : ''}`);
    
    try {
      // Save location to session first - include _user_location for address executor
      await this.sessionService.setData(sessionId, {
        location: { lat, lng },
        _user_location: { latitude: lat, longitude: lng, zoneId },
        lastLocationUpdate: Date.now(),
        // no _session_has_location flag: `location` above IS the gate that
        // check_existing_location reads.
      });
      client.emit('location:updated', { success: true });
      
      // Check if there's an active flow waiting for location
      const flowContext = await this.flowEngineService.getContext(sessionId);
      const locationWaitStates = [
        'request_location',       // Food order location request
        'wait_for_pickup',        // Parcel pickup address
        'wait_for_delivery',      // Parcel delivery address
        'collect_pickup',         // Parcel pickup collection
        'collect_delivery',       // Parcel delivery collection
      ];
      
      if (flowContext && locationWaitStates.includes(flowContext.currentState)) {
        this.logger.log(`📍 Active flow in "${flowContext.currentState}" waiting for location - advancing flow`);
        // Advance the flow with a location message
        // The location is already saved to session, so flow-engine will pick it up
        const response = await this.flowEngineService.processMessage(
          sessionId,
          `__LOCATION__`, // Standard location message that flows recognize
          'user_message' // Event to trigger the transition
        );
        if (response) {
          this.emitBotResponse(client, sessionId, response);
        }
      }
    } catch (error) {
      this.logger.error(`❌ Failed to update location:`, error);
      client.emit('error', { message: 'Failed to update location' });
    }
  }

  @SubscribeMessage('option:click')
  async handleOptionClick(
    @MessageBody() data: { sessionId: string; optionId: string; payload?: any },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, optionId, payload } = data;
    this.logger.log(`🔘 Option clicked in ${sessionId}: ${optionId}`);

    try {
      // Process option click as a message
      await this.handleMessage(
        { message: payload?.value || optionId, sessionId },
        client,
      );
    } catch (error) {
      client.emit('error', { message: 'Failed to process option click' });
    }
  }

  /**
   * Handle centralized authentication event from any channel
   * This syncs auth across all connected clients for the same phone
   */
  /**
   * The web frontend ALSO re-sends the literal text "checkout" 800ms after a
   * successful login (page.tsx `InlineLogin.onSuccess`) as its own fallback for
   * the socket resume below. While the resume never fired for food, that timer
   * was the only thing carrying the customer back into their order.
   *
   * Now that the resume does fire, the trailing "checkout" would land on
   * `wait_cart_review`, whose `user_message` transition advances — auto-clicking
   * straight past the "Review Your Order / Confirm & Add Address" screen the
   * customer never got to read. So when the resume owns the turn, seed the
   * existing dedup cache to swallow that one message.
   *
   * Only "checkout" is suppressed — never "proceed", which is the customer's
   * own confirm button and must always reach the flow.
   */
  private static readonly RESUME_FALLBACK_MESSAGE = 'checkout';

  private resumeFallbackKey(sessionId: string): string {
    const crypto = require('crypto');
    const hash = crypto
      .createHash('md5')
      .update(ChatGateway.RESUME_FALLBACK_MESSAGE)
      .digest('hex');
    return `${sessionId}:${hash}`;
  }

  /** Swallow the frontend's 800ms "checkout" — the resume is handling this turn. */
  private suppressResumeFallback(sessionId: string): void {
    if (!this.messageCache.has(sessionId)) {
      this.messageCache.set(sessionId, new Map());
    }
    const cache = this.messageCache.get(sessionId)!;
    const key = this.resumeFallbackKey(sessionId);
    cache.set(key, Date.now());
    // Don't leave the entry behind: a real "checkout" typed later must get through.
    setTimeout(() => cache.delete(key), this.DEDUP_WINDOW);
  }

  /** Resume failed — hand the turn back to the frontend's fallback timer. */
  private releaseResumeFallback(sessionId: string): void {
    this.messageCache.get(sessionId)?.delete(this.resumeFallbackKey(sessionId));
  }

  @SubscribeMessage('auth:login')
  async handleAuthLogin(
    @MessageBody() data: { 
      phone: string; 
      token: string; 
      userId: number;
      userName?: string;
      platform?: string;
      sessionId: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const { phone, token, userId, userName, platform, sessionId } = data;
    this.logger.log(`🔐 Auth login event from ${platform || 'web'} for phone ***${phone?.slice(-4)}`);

    try {
      // Sync from PHP backend to validate token and get user data
      const authResult = await this.centralizedAuth.syncFromPhpBackend(token, platform || 'web');

      if (authResult) {
        // Sync auth across all sessions for this phone
        await this.centralizedAuth.syncAuthAcrossSessions(phone, userId, token);

        // Broadcast auth event to all connected clients with same phone
        await this.centralizedAuth.broadcastAuthEvent(
          phone,
          'auth:synced',
          {
            userId,
            userName,
            token,
            platform: platform || 'web',
            timestamp: Date.now(),
          },
          this.server
        );

        // Update session data
        await this.sessionService.setData(sessionId, {
          user_id: userId,
          phone,
          auth_token: token,
          user_name: userName,
          authenticated: true,
          authenticated_at: Date.now(),
        });

        client.emit('auth:success', {
          userId,
          userName,
          message: 'Authentication successful across all channels',
        });

        this.logger.log(`✅ Auth synced across all channels for user ${userId}`);

        // 🔄 CRITICAL: Resume any waiting flow after authentication
        // This handles the case where frontend auth completed and flow is waiting at trigger_frontend_auth_order
        try {
          const session = await this.sessionService.getSession(sessionId);
          const flowContext = session?.data?.flowContext;
          // `session.data.flowContext` is FLAT — `flow-engine.service.ts:688 getContext()`
          // returns `{flowRunId, currentState, flowId}` and the sibling resume block at
          // :573 reads `flowContext.currentState` directly. Reading `_system.currentState`
          // here always yielded undefined, so this post-login resume has never once fired:
          // a web user who logged in from the checkout modal was left staring at a dead
          // chat instead of being carried back into their order.
          const currentState = flowContext?.currentState;
          
          if (flowContext && LOGIN_WAIT_STATES.includes(currentState)) {
            this.logger.log(`🔄 Flow waiting at ${currentState}, sending auth completion signal to resume flow`);

            // Claim this turn before the await — the frontend's fallback fires
            // at 800ms and the resume can take longer than that.
            this.suppressResumeFallback(sessionId);

            // Send internal message to resume the flow
            const resumeResult = await this.flowEngineService.processMessage(
              sessionId,
              '__AUTH_COMPLETE__',
              'web'
            );
            
            // Send the flow's response to the client
            if (resumeResult?.response) {
              client.emit('message', {
                id: `auth-resume-${Date.now()}`,
                role: 'assistant',
                content: resumeResult.response,
                timestamp: Date.now(),
                buttons: resumeResult.buttons || [],
                metadata: resumeResult.metadata,
              });
            }
          }
        } catch (resumeError) {
          this.logger.error(`⚠️ Error resuming flow after auth: ${resumeError.message}`);
          // Resume died — let the frontend's 800ms "checkout" through after all.
          this.releaseResumeFallback(sessionId);
        }
      } else {
        client.emit('auth:failed', {
          message: 'Authentication failed',
          reason: 'Invalid token',
        });
      }
    } catch (error) {
      this.logger.error(`❌ Auth login error: ${error.message}`, error.stack);
      client.emit('auth:failed', { message: 'Authentication error' });
    }
  }

  /**
   * Handle logout - sync across all channels
   */
  @SubscribeMessage('auth:logout')
  async handleAuthLogout(
    @MessageBody() data: { phone: string; sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { phone, sessionId } = data;
    this.logger.log(`🚪 Auth logout event for phone ***${phone?.slice(-4)}`);

    try {
      // Clear centralized auth
      await this.centralizedAuth.logout(phone);

      // Clear session data
      await this.sessionService.clearAuth(sessionId);

      // Broadcast logout to all connected clients with same phone
      await this.centralizedAuth.broadcastAuthEvent(
        phone,
        'auth:logged_out',
        { timestamp: Date.now() },
        this.server
      );

      client.emit('auth:logged_out', { success: true });
      this.logger.log(`✅ Logout synced across all channels for ***${phone?.slice(-4)}`);
    } catch (error) {
      this.logger.error(`❌ Auth logout error: ${error.message}`, error.stack);
      client.emit('error', { message: 'Logout error' });
    }
  }

  /**
   * Check auth status across channels
   */
  @SubscribeMessage('auth:check')
  async handleAuthCheck(
    @MessageBody() data: { phone: string; sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { phone, sessionId } = data;
    
    try {
      const isAuthenticated = await this.centralizedAuth.isAuthenticated(phone);
      
      if (isAuthenticated) {
        const authData = await this.centralizedAuth.getAuthData(phone);
        client.emit('auth:status', {
          authenticated: true,
          userId: authData?.userId,
          userName: authData?.userName,
          lastAuthPlatform: authData?.platform,
        });
      } else {
        client.emit('auth:status', { authenticated: false });
      }
    } catch (error) {
      this.logger.error(`❌ Auth check error: ${error.message}`);
      client.emit('auth:status', { authenticated: false });
    }
  }

  // REMOVED: Legacy 'user_message' handler - was causing duplicate message processing
  // The 'message:send' handler above is the active handler for all message processing

  /**
   * Helper to emit bot response to client
   * Used for flow engine responses (e.g., after location is shared)
   */
  private emitBotResponse(client: Socket, sessionId: string, response: any) {
    if (!response) return;
    
    // FlowEngineService returns { response, buttons, cards } - NOT { message }
    const { content, text, message, response: flowResponse, buttons, cards, metadata } = response;
    const responseText = content || text || message || flowResponse || '';
    
    if (!responseText && !cards?.length) {
      this.logger.warn(`⚠️ Empty response from flow engine for ${sessionId}`);
      return;
    }
    
    const messagePayload: any = {
      id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
      role: 'assistant',
      content: responseText,
      timestamp: Date.now(),
    };
    
    if (buttons?.length) {
      messagePayload.buttons = buttons;
    }
    
    if (cards?.length) {
      messagePayload.cards = cards;
    }
    
    if (metadata) {
      messagePayload.metadata = metadata;
    }
    
    this.logger.log(`📤 Emitting flow response to ${sessionId}`);
    this.server.to(sessionId).emit('message', messagePayload);
  }

  /**
   * Convert button action to natural language message for intent detection
   */
  private convertButtonActionToMessage(action: string, metadata?: Record<string, any>): string {
    // Map common button actions to natural language
    const actionMap: Record<string, string> = {
      // CRITICAL: Cancel actions must be recognized
      'cancel': 'cancel',
      'cancel_order': 'cancel',
      'user_cancelled': 'cancel',
      // Auth actions - CRITICAL for login flow
      'trigger_auth_flow': 'login',
      'start_login': 'login',
      'authenticate': 'login',
      // Game-related actions
      'start_game_intent_quest': 'I want to play intent quest game',
      'start_game_delivery_dash': 'I want to play delivery dash game',
      'start_game_product_puzzle': 'I want to play product puzzle game',
      'view_leaderboard': 'Show me the leaderboard',
      'earn_rewards': 'How can I earn rewards',
      // Main menu button IDs (from greeting flow)
      'btn_food': 'I want to order food',
      'btn_parcel': 'I want to book a parcel',
      'btn_shop': 'I want to search for products',
      'btn_help': 'I need help',
      // Value-based actions
      'order_food': 'I want to order food',
      'parcel_booking': 'I want to book a parcel',
      'search_product': 'I want to search for products',
      'book_parcel': 'I want to book a parcel',
      'search_products': 'I want to search for products',
      'view_menu': 'Show me the menu',
      'confirm_order': 'Yes, confirm my order',
      'help': 'I need help',
      'back_to_menu': 'Go back to main menu',
      // Start fresh / reset actions
      'reset': 'reset',
      'restart': 'restart',
      'start_fresh': 'start fresh',
      'start_over': 'start over',
    };

    // Check if we have a direct mapping
    if (actionMap[action]) {
      return actionMap[action];
    }

    // Try to infer from action name (e.g., 'select_pizza' -> 'I want pizza')
    if (action.startsWith('select_')) {
      const item = action.replace('select_', '').replace(/_/g, ' ');
      return `I want ${item}`;
    }

    // If metadata has a display name, use it
    if (metadata?.display) {
      return metadata.display;
    }

    // Last resort: clean up action name
    return action.replace(/_/g, ' ');
  }

  // =========================================================================
  // 🔄 Option B: LLM Response Streaming via WebSocket
  // =========================================================================

  /**
   * Stream an LLM response token-by-token via WebSocket.
   * 
   * Emits:
   *   'message:stream:start' — { id }
   *   'message:stream:token' — { id, token, accumulated }
   *   'message:stream:end'   — { id, content, timestamp }
   * 
   * Usage from frontend:
   *   socket.emit('message:stream', { message, sessionId, module })
   */
  @SubscribeMessage('message:stream')
  async handleStreamMessage(
    @MessageBody() payload: MessagePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { message, sessionId } = payload;
    if (!message || !sessionId) {
      client.emit('error', { message: 'Message and sessionId are required' });
      return;
    }

    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    this.logger.log(`🔄 Stream request from ${sessionId}: "${message.substring(0, 50)}..."`);

    try {
      // Send typing + stream start
      this.server.to(sessionId).emit('typing', { isTyping: true });
      client.emit('message:stream:start', { id: streamId });

      // Build messages for LLM
      const session = await this.sessionService.getSession(sessionId);

      // Option C: Recall relevant memories for context
      let memoryContext = '';
      try {
        const userId = session?.data?.user_id;
        if (userId) {
          memoryContext = await this.conversationMemory.buildContextFromMemories(
            message,
            { userId, maxMemories: 3 },
          );
        }
      } catch (e) {
        this.logger.debug(`Memory recall failed: ${e.message}`);
      }

      const systemPrompt = `You are Chotu, Mangwale's friendly AI assistant for food delivery, parcel booking, and shopping in Nashik, India. Be helpful, concise, and friendly. Respond in the same language the user writes in (Hindi, English, or Hinglish).${memoryContext ? `\n\n${memoryContext}` : ''}`;

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: message },
      ];

      // Get stream from vLLM
      const stream = await this.llmService.chatStream({
        messages,
        temperature: 0.7,
        maxTokens: 1500,
        stream: true,
      });

      // Parse SSE stream and emit tokens
      let accumulated = '';
      
      stream.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter((l: string) => l.trim());
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content;
              
              if (token) {
                accumulated += token;
                client.emit('message:stream:token', {
                  id: streamId,
                  token,
                  accumulated,
                });
              }
            } catch {
              // Skip malformed SSE chunks
            }
          }
        }
      });

      stream.on('end', async () => {
        this.server.to(sessionId).emit('typing', { isTyping: false });
        
        // Emit final complete message
        client.emit('message:stream:end', {
          id: streamId,
          content: accumulated,
          timestamp: Date.now(),
        });

        // Also emit as regular message for history consistency
        this.server.to(sessionId).emit('message', {
          id: streamId,
          role: 'assistant',
          content: accumulated,
          timestamp: Date.now(),
          streamed: true,
        });

        // Option C: Store in vector memory
        await this.storeConversationMemory(sessionId, session, message, accumulated);

        this.logger.log(`✅ Stream complete: ${accumulated.length} chars`);
      });

      stream.on('error', (err: Error) => {
        this.logger.error(`Stream error: ${err.message}`);
        this.server.to(sessionId).emit('typing', { isTyping: false });
        client.emit('message:stream:end', {
          id: streamId,
          content: accumulated || 'Sorry, I encountered an error. Please try again.',
          timestamp: Date.now(),
          error: true,
        });
      });

    } catch (error) {
      this.logger.error(`Stream setup failed: ${error.message}`);
      this.server.to(sessionId).emit('typing', { isTyping: false });
      
      // Fallback: process normally without streaming
      client.emit('message:stream:end', {
        id: streamId,
        content: 'Let me process that for you...',
        timestamp: Date.now(),
        error: true,
      });
    }
  }

  // =========================================================================
  // 🧠 Option C: Store & Recall Vector Memory
  // =========================================================================

  /**
   * Store a conversation turn (user + assistant) into long-term vector memory.
   * Called after every successful message exchange.
   */
  private async storeConversationMemory(
    sessionId: string,
    session: any,
    userMessage: string,
    botResponse: string,
  ): Promise<void> {
    try {
      const userId = session?.data?.user_id;
      const phone = session?.data?.phone;
      
      // Get turn count from session (increment for each exchange)
      const turnNumber = (session?.data?._memory_turn || 0) + 1;
      await this.sessionService.setData(sessionId, { _memory_turn: turnNumber });

      // Store user message
      await this.conversationMemory.store({
        userId,
        sessionId,
        phoneNumber: phone,
        role: 'user',
        content: userMessage,
        turnNumber,
        timestamp: new Date(),
        metadata: {
          intent: session?.data?.flowContext?.data?._current_intent,
        },
      });

      // Store bot response
      await this.conversationMemory.store({
        userId,
        sessionId,
        phoneNumber: phone,
        role: 'assistant',
        content: botResponse,
        turnNumber,
        timestamp: new Date(),
      });
    } catch (error) {
      // Memory storage should never block the conversation
      this.logger.debug(`Memory storage failed (non-blocking): ${error.message}`);
    }
  }
}
