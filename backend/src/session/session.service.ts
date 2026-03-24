import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { maskPhone } from '../common/utils/phone.util';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  phoneNumber: string;
  currentStep: string;
  data: Record<string, any>;
  conversationHistory?: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessionTtl: number;

  // ✨ Request-scoped in-memory cache to reduce Redis calls
  // Cache is cleared after each request (via interceptor or manual cleanup)
  private readonly memoryCache = new Map<string, { session: Session | null; timestamp: number }>();
  private readonly CACHE_TTL_MS = 5000; // 5 seconds - enough for a single request lifecycle

  // 🔒 Auth token refresh mutex: prevents parallel executors from triggering
  // duplicate token refreshes. Concurrent callers await the same Promise.
  private readonly pendingTokenRefresh = new Map<string, Promise<string | null>>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private configService: ConfigService,
    @Optional() private prisma: PrismaService,
  ) {
    this.sessionTtl = this.configService.get('session.ttl');
    this.logger.log(`✅ Session Service initialized with shared Redis | TTL: ${this.sessionTtl}s | Memory cache enabled`);

    // Cleanup expired cache entries every 10 seconds
    setInterval(() => this.cleanupCache(), 10000);
  }
  
  /**
   * Cleanup expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.memoryCache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL_MS) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`🧹 Cleaned ${cleaned} expired cache entries`);
    }
  }
  
  /**
   * Clear cache for a specific session (call after updates)
   */
  /**
   * Invalidate the in-memory cache for a session.
   * Call this before reading session data that may have been recently updated
   * by another service (e.g., ChatGateway auth sync).
   */
  invalidateCache(phoneNumber: string): void {
    this.memoryCache.delete(this.getSessionKey(phoneNumber));
  }

  private getSessionKey(phoneNumber: string): string {
    // Channel-agnostic session key (works for WhatsApp, Web, Telegram, SMS, etc.)
    return `session:${phoneNumber}`;
  }

  async getSession(phoneNumber: string): Promise<Session | null> {
    try {
      const key = this.getSessionKey(phoneNumber);
      
      // ✨ Check memory cache first
      const cached = this.memoryCache.get(key);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL_MS) {
        this.logger.debug(`📦 Cache HIT for session: ${phoneNumber}`);
        return cached.session;
      }
      
      // Cache miss - fetch from Redis
      this.logger.debug(`📥 Cache MISS for session: ${maskPhone(phoneNumber)} - fetching from Redis`);
      const data = await this.redis.get(key);
      const session = data ? JSON.parse(data) : null;
      
      // Update cache
      this.memoryCache.set(key, { session, timestamp: Date.now() });
      
      return session;
    } catch (error) {
      this.logger.error(`Error getting session for ${maskPhone(phoneNumber)}:`, error);
      return null;
    }
  }

  async createSession(phoneNumber: string): Promise<Session> {
    const session: Session = {
      phoneNumber,
      currentStep: 'welcome',
      data: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveSession(phoneNumber, session);
    this.logger.log(`📝 Session created for ${maskPhone(phoneNumber)}`);
    return session;
  }

  async saveSession(phoneNumber: string, session: Partial<Session>): Promise<void> {
    try {
      const existingSession = await this.getSession(phoneNumber);
      const updatedSession: Session = {
        ...(existingSession || { phoneNumber, data: {}, createdAt: Date.now() }),
        ...session,
        updatedAt: Date.now(),
      } as Session;

      const key = this.getSessionKey(phoneNumber);
      const sessionData = JSON.stringify(updatedSession);
      
      this.logger.debug(`🔍 About to save: key=${key}, ttl=${this.sessionTtl}, dataSize=${sessionData.length}`);
      
      const result = await this.redis.setex(key, this.sessionTtl, sessionData);
      
      // ✨ Update memory cache after save
      this.memoryCache.set(key, { session: updatedSession, timestamp: Date.now() });
      
      this.logger.log(`💾 Saved session for ${phoneNumber} | Result: ${result} | TTL: ${this.sessionTtl}s | Data keys: ${Object.keys(updatedSession.data || {}).join(', ')}`);
      
      // Verify it was saved
      const verify = await this.redis.exists(key);
      if (verify === 0) {
        this.logger.error(`⚠️ Session key ${key} NOT FOUND after saving!`);
      } else {
        this.logger.debug(`✅ Session key ${key} verified in Redis`);
      }
    } catch (error) {
      this.logger.error(`Error saving session for ${maskPhone(phoneNumber)}:`, error);
      throw error;
    }
  }

  async updateSession(phoneNumber: string, data: Record<string, any>): Promise<void> {
    const session = await this.getSession(phoneNumber);
    if (!session) {
      await this.createSession(phoneNumber);
    }
    
    await this.saveSession(phoneNumber, {
      data: {
        ...(session?.data || {}),
        ...data,
      },
    });
  }

  async setStep(phoneNumber: string, step: string, data: Record<string, any> = {}): Promise<void> {
    const session = await this.getSession(phoneNumber);
    
    if (!session) {
      await this.createSession(phoneNumber);
    }

    await this.saveSession(phoneNumber, {
      currentStep: step,
      data: {
        ...(session?.data || {}),
        ...data,
      },
    });
  }

  async clearStep(phoneNumber: string): Promise<void> {
    await this.setStep(phoneNumber, 'welcome');
  }

  async getData(phoneNumber: string, key?: string): Promise<any> {
    const session = await this.getSession(phoneNumber);
    if (!session) return null;
    return key ? session.data[key] : session.data;
  }

  async setData(phoneNumber: string, keyOrData: string | Record<string, any>, value?: any): Promise<void> {
    // ✨ Invalidate cache before getSession to ensure fresh data
    this.invalidateCache(phoneNumber);
    const session = await this.getSession(phoneNumber);
    const data = session?.data || {};

    
    if (typeof keyOrData === 'string') {
      // Single key-value pair
      data[keyOrData] = value;
      this.logger.log(`📝 Setting data for ${maskPhone(phoneNumber)}: ${keyOrData} = ${typeof value === 'string' ? value.substring(0, 50) : value}`);
    } else {
      // Multiple data as object
      Object.assign(data, keyOrData);
      this.logger.log(`📝 Setting multiple data for ${maskPhone(phoneNumber)}: ${Object.keys(keyOrData).join(', ')}`);
    }

    await this.saveSession(phoneNumber, { data });
  }

  async clearOrderData(phoneNumber: string): Promise<void> {
    const session = await this.getSession(phoneNumber);
    if (session) {
      // Clear order-related data while keeping authentication
      const { auth_token, user_info, ...otherData } = session.data;
      const clearedData = {
        auth_token,
        user_info,
        // Reset to initial state
        currentStep: 'modules',
      };
      await this.saveSession(phoneNumber, { 
        data: clearedData,
        currentStep: 'modules'
      });
    }
  }

  /**
   * Persist key user preferences from session data to PostgreSQL user_profiles
   * before the session is cleared or expires. This ensures preferences survive
   * beyond the Redis session TTL (24h).
   */
  async persistUserPreferences(phoneNumber: string): Promise<void> {
    try {
      const session = await this.getSession(phoneNumber);
      if (!session || !this.prisma) return;

      const data = session.data || {};
      const userId = data.user_id ? Number(data.user_id) : null;
      if (!userId) {
        this.logger.debug(`No user_id in session for ${phoneNumber}, skipping preference persistence`);
        return;
      }

      // Collect preference updates from session data
      const updates: Record<string, any> = {
        updated_at: new Date(),
      };

      // Communication tone (e.g., 'formal', 'casual', 'friendly')
      if (data.communication_tone) {
        updates.communication_tone = String(data.communication_tone).substring(0, 20);
      }

      // Language preference (e.g., 'en', 'hi', 'hinglish')
      if (data.language_preference || data.detected_language) {
        updates.language_preference = String(data.language_preference || data.detected_language).substring(0, 10);
      }

      // Favorite items from ordered/carted items during this session
      if (data.ordered_items || data.cart_items) {
        const sessionItems = data.ordered_items || data.cart_items || [];
        if (Array.isArray(sessionItems) && sessionItems.length > 0) {
          // Merge with existing favorites rather than overwriting
          const existing = await this.prisma.user_profiles.findUnique({
            where: { user_id: userId },
            select: { favorite_items: true },
          });
          const existingFavorites = Array.isArray(existing?.favorite_items) ? existing.favorite_items as any[] : [];
          // Extract item names/ids from session items
          const newItemRefs = sessionItems.map((item: any) =>
            typeof item === 'object' ? { id: item.id, name: item.name || item.item_name } : item,
          );
          // Deduplicate by id, keep last 50
          const merged = [...existingFavorites, ...newItemRefs];
          const deduped = merged.reduce((acc: any[], item: any) => {
            const key = typeof item === 'object' ? item.id : item;
            if (!acc.find((a: any) => (typeof a === 'object' ? a.id : a) === key)) {
              acc.push(item);
            }
            return acc;
          }, []).slice(-50);
          updates.favorite_items = deduped;
        }
      }

      // Only persist if we have meaningful updates beyond just the timestamp
      if (Object.keys(updates).length <= 1) {
        this.logger.debug(`No meaningful preferences to persist for user ${userId}`);
        return;
      }

      await this.prisma.user_profiles.upsert({
        where: { user_id: userId },
        update: updates,
        create: {
          user_id: userId,
          phone: phoneNumber,
          ...updates,
        },
      });

      const persistedKeys = Object.keys(updates).filter(k => k !== 'updated_at');
      this.logger.log(`Persisted user preferences for user ${userId} (${maskPhone(phoneNumber)}): ${persistedKeys.join(', ')}`);
    } catch (error) {
      // Non-critical: log but don't throw so session cleanup still proceeds
      this.logger.warn(`Failed to persist user preferences for ${maskPhone(phoneNumber)}: ${error.message}`);
    }
  }

  async clearSession(phoneNumber: string): Promise<void> {
    // Persist preferences before clearing
    await this.persistUserPreferences(phoneNumber);
    const key = this.getSessionKey(phoneNumber);
    await this.redis.del(key);
    this.logger.log(`Session cleared for ${maskPhone(phoneNumber)}`);
  }

  async deleteSession(phoneNumber: string): Promise<void> {
    // Persist preferences before deleting
    await this.persistUserPreferences(phoneNumber);

    // Delete session data
    const sessionKey = this.getSessionKey(phoneNumber);
    await this.redis.del(sessionKey);

    // Delete bot messages
    const messagesKey = `bot_messages:${phoneNumber}`;
    await this.redis.del(messagesKey);

    this.logger.log(`Session and messages deleted for ${maskPhone(phoneNumber)}`);
  }

  async getAllSessions(): Promise<Session[]> {
    try {
      // Use SCAN instead of KEYS to avoid blocking Redis
      const sessions: Session[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          const data = await this.redis.get(key);
          if (data) {
            sessions.push(JSON.parse(data));
          }
        }
      } while (cursor !== '0');

      return sessions;
    } catch (error) {
      this.logger.error('Error getting all sessions:', error);
      return [];
    }
  }

  /**
   * Store bot messages for test mode (so frontend can retrieve them)
   * @param phoneNumber - The phone/session identifier
   * @param message - Can be a string (simple message) or an object with message, buttons, cards, etc.
   */
  async storeBotMessage(phoneNumber: string, message: string | object): Promise<void> {
    try {
      const key = `bot_messages:${phoneNumber}`;
      
      // Handle both string and object inputs
      let messageObj: { message: string | object; timestamp: number; buttons?: any[]; cards?: any[]; metadata?: any };
      
      if (typeof message === 'object' && message !== null) {
        // Object input - use directly (may already have timestamp)
        messageObj = {
          ...(message as any),
          timestamp: (message as any).timestamp || Date.now(),
        };
      } else {
        // String input - wrap in object
        messageObj = {
          message,
          timestamp: Date.now()
        };
      }
      
      await this.redis.rpush(key, JSON.stringify(messageObj));
      await this.redis.expire(key, 300); // 5 minutes TTL
    } catch (error) {
      this.logger.error('Error storing bot message:', error);
    }
  }

  /**
   * Get pending bot messages for frontend
   */
  async getBotMessages(phoneNumber: string): Promise<any[]> {
    try {
      const key = `bot_messages:${phoneNumber}`;
      const messages = await this.redis.lrange(key, 0, -1);

      // Don't delete messages here — caller must explicitly acknowledge
      // This prevents message loss if client fails to receive
      return messages.map(msg => JSON.parse(msg));
    } catch (error) {
      this.logger.error('Error getting bot messages:', error);
      return [];
    }
  }

  /**
   * Acknowledge bot messages (delete after client confirms receipt)
   */
  async acknowledgeBotMessages(phoneNumber: string, count?: number): Promise<void> {
    try {
      const key = `bot_messages:${phoneNumber}`;
      if (count) {
        // Remove only the first N messages (acknowledged ones)
        for (let i = 0; i < count; i++) {
          await this.redis.lpop(key);
        }
      } else {
        // Acknowledge all
        await this.redis.del(key);
      }
      this.logger.debug(`✅ Acknowledged ${count || 'all'} bot messages for ${maskPhone(phoneNumber)}`);
    } catch (error) {
      this.logger.error('Error acknowledging bot messages:', error);
    }
  }

  /**
   * Clear bot messages without retrieving
   */
  async clearBotMessages(phoneNumber: string): Promise<void> {
    try {
      const key = `bot_messages:${phoneNumber}`;
      await this.redis.del(key);
      this.logger.log(`🗑️ Cleared bot messages for ${maskPhone(phoneNumber)}`);
    } catch (error) {
      this.logger.error('Error clearing bot messages:', error);
    }
  }

  /**
   * Peek at bot messages without deleting
   */
  async peekBotMessages(phoneNumber: string): Promise<any[]> {
    try {
      const key = `bot_messages:${phoneNumber}`;
      const messages = await this.redis.lrange(key, 0, -1);
      return messages.map(msg => JSON.parse(msg));
    } catch (error) {
      this.logger.error('Error peeking bot messages:', error);
      return [];
    }
  }

  /**
   * Check Redis connection health
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  /**
   * Clear authentication data from a session
   */
  async clearAuth(sessionId: string): Promise<void> {
    try {
      await this.setData(sessionId, {
        user_id: null,
        phone: null,
        auth_token: null,
        user_name: null,
        authenticated: false,
        authenticated_at: null,
      });
      this.logger.log(`🗑️ Cleared auth for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error clearing auth for session ${sessionId}:`, error);
    }
  }

  /**
   * Add a message to conversation history (last 10 messages)
   */
  async addToConversationHistory(phoneNumber: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      const session = await this.getSession(phoneNumber);
      if (!session) {
        this.logger.warn(`Session not found for ${phoneNumber}, creating new session`);
        await this.createSession(phoneNumber);
        return this.addToConversationHistory(phoneNumber, role, content);
      }

      const history = session.conversationHistory || [];
      const newMessage: ConversationMessage = {
        role,
        content,
        timestamp: Date.now(),
      };

      // Keep only last 10 messages
      const updatedHistory = [...history, newMessage].slice(-10);

      await this.saveSession(phoneNumber, {
        conversationHistory: updatedHistory,
      });

      this.logger.debug(`💬 Added ${role} message to history for ${phoneNumber} (history length: ${updatedHistory.length})`);
    } catch (error) {
      this.logger.error(`Error adding conversation history for ${maskPhone(phoneNumber)}:`, error);
    }
  }

  /**
   * Get conversation history for context
   */
  async getConversationHistory(phoneNumber: string, limit: number = 10): Promise<ConversationMessage[]> {
    try {
      const session = await this.getSession(phoneNumber);
      if (!session) {
        return [];
      }

      const history = session.conversationHistory || [];
      return history.slice(-limit);
    } catch (error) {
      this.logger.error(`Error getting conversation history for ${maskPhone(phoneNumber)}:`, error);
      return [];
    }
  }

  /**
   * Clear conversation history
   */
  async clearConversationHistory(phoneNumber: string): Promise<void> {
    try {
      await this.saveSession(phoneNumber, {
        conversationHistory: [],
      });
      this.logger.log(`🗑️ Cleared conversation history for ${maskPhone(phoneNumber)}`);
    } catch (error) {
      this.logger.error(`Error clearing conversation history for ${maskPhone(phoneNumber)}:`, error);
    }
  }

  /**
   * Refresh auth token with mutex/coalescing.
   *
   * If a refresh is already in-progress for this session, concurrent callers
   * receive the same Promise (no duplicate PHP calls). The refreshed token is
   * written back to session data so subsequent executor reads pick it up.
   *
   * @param sessionId - session identifier (phone number or session key)
   * @param refreshFn - async function that performs the actual token refresh
   *                     (e.g., phpAuthService.autoLogin). Must return the new
   *                     token string, or null on failure.
   * @returns the new auth token, or null if refresh failed
   */
  async refreshAuthToken(
    sessionId: string,
    refreshFn: () => Promise<string | null>,
  ): Promise<string | null> {
    // If a refresh is already in-flight for this session, piggyback on it
    const pending = this.pendingTokenRefresh.get(sessionId);
    if (pending) {
      this.logger.debug(`🔒 Auth refresh already in-flight for ${sessionId}, waiting...`);
      return pending;
    }

    // Create the refresh promise and store it so concurrent callers can share it
    const refreshPromise = (async () => {
      try {
        const newToken = await refreshFn();
        if (newToken) {
          // Write refreshed token back to session so other executors see it
          await this.setData(sessionId, { auth_token: newToken });
          this.logger.log(`🔑 Auth token refreshed and saved for ${sessionId}`);
        }
        return newToken;
      } catch (error) {
        this.logger.error(`Auth token refresh failed for ${sessionId}: ${error.message}`);
        return null;
      } finally {
        // Always clear the pending entry so future calls can retry
        this.pendingTokenRefresh.delete(sessionId);
      }
    })();

    this.pendingTokenRefresh.set(sessionId, refreshPromise);
    return refreshPromise;
  }
}

