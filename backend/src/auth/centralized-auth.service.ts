import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PhpAuthService } from '../php-integration/services/php-auth.service';
import { normalizePhoneNumber } from '../common/utils/helpers';
import { PrismaService } from '../database/prisma.service';
import { UserProfileEnrichmentService } from '../personalization/user-profile-enrichment.service';
import { REDIS_CLIENT, REDIS_PUBLISHER } from '../redis/redis.module';

export interface AuthenticatedUser {
  userId: number;
  phone: string;
  email?: string;
  firstName: string;
  lastName?: string;
  token: string;
  authenticatedAt: number;
  lastActiveAt: number;
  channels: string[]; // ['web', 'whatsapp', 'telegram', etc.]
}

export interface AuthEvent {
  type: 'LOGIN' | 'LOGOUT' | 'TOKEN_REFRESH' | 'PROFILE_UPDATE';
  phone: string;
  userId?: number;
  channel: string;
  timestamp: number;
  data?: any;
}

/**
 * Centralized Authentication Service
 * 
 * Manages authentication state across ALL channels:
 * - Web (chat.mangwale.ai)
 * - WhatsApp
 * - Telegram (future)
 * - SMS (future)
 * - Mobile App (future)
 * 
 * Uses phone number as the universal identifier.
 * When a user logs in on ANY channel, all other channels are notified.
 */
@Injectable()
export class CentralizedAuthService {
  private readonly logger = new Logger(CentralizedAuthService.name);
  private readonly authTtl: number = 7 * 24 * 60 * 60; // 7 days

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_PUBLISHER) private readonly redisPublisher: Redis,
    private readonly configService: ConfigService,
    private readonly phpAuthService: PhpAuthService,
    private readonly prisma: PrismaService,
    private readonly profileEnrichment: UserProfileEnrichmentService,
  ) {
    this.logger.log('✅ Centralized Auth Service initialized with shared Redis, PostgreSQL sync & profile enrichment');
  }

  /**
   * Get the auth key for a phone number
   */
  private getAuthKey(phone: string): string {
    const normalized = normalizePhoneNumber(phone) || phone;
    return `auth:${normalized.replace('+', '')}`;
  }

  /**
   * Check if a user is authenticated (from any channel)
   */
  async isAuthenticated(phone: string): Promise<boolean> {
    const key = this.getAuthKey(phone);
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Get authenticated user data
   */
  async getAuthenticatedUser(phone: string): Promise<AuthenticatedUser | null> {
    const key = this.getAuthKey(phone);
    const data = await this.redis.get(key);
    if (!data) return null;
    
    try {
      const user = JSON.parse(data) as AuthenticatedUser;
      // Update last active time
      user.lastActiveAt = Date.now();
      await this.redis.setex(key, this.authTtl, JSON.stringify(user));
      return user;
    } catch (e) {
      this.logger.error(`Failed to parse auth data for ${phone}: ${e.message}`);
      return null;
    }
  }

  /**
   * Authenticate user and store globally
   * Called after OTP verification succeeds
   * Also syncs user to PostgreSQL for AI persistence
   */
  async authenticateUser(
    phone: string,
    token: string,
    userData: {
      userId: number;
      firstName: string;
      lastName?: string;
      email?: string;
    },
    channel: string,
  ): Promise<AuthenticatedUser> {
    const normalizedPhone = normalizePhoneNumber(phone) || phone;
    const key = this.getAuthKey(normalizedPhone);

    // Check if user already has auth from another channel
    const existingAuth = await this.getAuthenticatedUser(normalizedPhone);
    
    const authUser: AuthenticatedUser = {
      userId: userData.userId,
      phone: normalizedPhone,
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      token,
      authenticatedAt: existingAuth?.authenticatedAt || Date.now(),
      lastActiveAt: Date.now(),
      channels: existingAuth 
        ? [...new Set([...existingAuth.channels, channel])]
        : [channel],
    };

    // Store in Redis
    await this.redis.setex(key, this.authTtl, JSON.stringify(authUser));
    
    this.logger.log(`✅ User ${userData.firstName} (${normalizedPhone}) authenticated via ${channel}`);
    this.logger.log(`   Active channels: ${authUser.channels.join(', ')}`);

    // 🔄 CRITICAL: Sync customer to PostgreSQL for AI persistence (ALL CHANNELS)
    this.syncUserToPostgres(normalizedPhone, userData, channel)
      .then(aiUser => {
        if (aiUser) {
          this.logger.log(`✅ Customer ${userData.firstName} synced to PostgreSQL: ai_user_id=${aiUser.id}, php_user_id=${userData.userId}`);
        }
      })
      .catch(err => this.logger.error(`Failed to sync customer to PostgreSQL: ${err.message}`));

    // Emit auth event for all listeners (WebSocket, etc.)
    const authEvent: AuthEvent = {
      type: 'LOGIN',
      phone: normalizedPhone,
      userId: userData.userId,
      channel,
      timestamp: Date.now(),
      data: {
        firstName: userData.firstName,
        lastName: userData.lastName,
      },
    };
    
    // Publish to Redis pub/sub for cross-instance sync
    await this.redisPublisher.publish('auth:events', JSON.stringify(authEvent));

    return authUser;
  }

  /**
   * Sync customer to PostgreSQL users table (for AI features)
   * This enables: conversation history, preferences, gamification, personalization
   */
  async syncUserToPostgres(
    phone: string,
    userData: { userId: number; firstName: string; lastName?: string; email?: string },
    channel: string,
  ): Promise<{ id: number } | null> {
    try {
      // First, try to find existing user by phpUserId (source of truth)
      let aiUser = await this.prisma.user.findUnique({
        where: { phpUserId: userData.userId },
      });

      if (aiUser) {
        // User exists: update if details changed
        aiUser = await this.prisma.user.update({
          where: { phpUserId: userData.userId },
          data: {
            phone, // Update phone (user might have changed it)
            email: userData.email,
            firstName: userData.firstName,
            lastName: userData.lastName,
            lastActiveAt: new Date(),
            updatedAt: new Date(),
          },
        });
      } else {
        // User doesn't exist: create new record
        aiUser = await this.prisma.user.create({
          data: {
            phpUserId: userData.userId,
            phone,
            email: userData.email,
            firstName: userData.firstName,
            lastName: userData.lastName,
            preferredLanguage: 'en',
            lastActiveAt: new Date(),
          },
        });
      }

      // 📊 CRITICAL: Enrich user profile with order history from MySQL
      // This runs async to not block login, but builds comprehensive profile
      this.profileEnrichment.enrichUserProfile({
        userId: userData.userId,
        phone,
        firstName: userData.firstName,
        lastName: userData.lastName,
        email: userData.email,
      }).then(() => {
        this.logger.log(`📊 Profile enrichment started for user ${userData.userId}`);
      }).catch(err => {
        this.logger.error(`Profile enrichment failed: ${err.message}`);
      });

      return aiUser;
    } catch (error) {
      this.logger.error(`Error syncing user to PostgreSQL: ${error.message}`);
      return null;
    }
  }

  /**
   * Logout user from a specific channel or all channels
   */
  async logoutUser(phone: string, channel?: string): Promise<void> {
    const normalizedPhone = normalizePhoneNumber(phone) || phone;
    const key = this.getAuthKey(normalizedPhone);

    if (channel) {
      // Remove only from specific channel
      const existingAuth = await this.getAuthenticatedUser(normalizedPhone);
      if (existingAuth) {
        existingAuth.channels = existingAuth.channels.filter(c => c !== channel);
        
        if (existingAuth.channels.length === 0) {
          // No more active channels, fully logout
          await this.redis.del(key);
          this.logger.log(`🚪 User ${normalizedPhone} fully logged out (no active channels)`);
        } else {
          await this.redis.setex(key, this.authTtl, JSON.stringify(existingAuth));
          this.logger.log(`🚪 User ${normalizedPhone} logged out from ${channel}, still active on: ${existingAuth.channels.join(', ')}`);
        }
      }
    } else {
      // Full logout from all channels
      await this.redis.del(key);
      this.logger.log(`🚪 User ${normalizedPhone} fully logged out from all channels`);
    }

    // Emit logout event
    const authEvent: AuthEvent = {
      type: 'LOGOUT',
      phone: normalizedPhone,
      channel: channel || 'all',
      timestamp: Date.now(),
    };
    
    await this.redisPublisher.publish('auth:events', JSON.stringify(authEvent));
  }

  /**
   * Refresh token for a user
   */
  async refreshToken(phone: string, newToken: string): Promise<void> {
    const normalizedPhone = normalizePhoneNumber(phone) || phone;
    const existingAuth = await this.getAuthenticatedUser(normalizedPhone);
    
    if (existingAuth) {
      existingAuth.token = newToken;
      existingAuth.lastActiveAt = Date.now();
      
      const key = this.getAuthKey(normalizedPhone);
      await this.redis.setex(key, this.authTtl, JSON.stringify(existingAuth));
      
      this.logger.log(`🔄 Token refreshed for ${normalizedPhone}`);
      
      const authEvent: AuthEvent = {
        type: 'TOKEN_REFRESH',
        phone: normalizedPhone,
        userId: existingAuth.userId,
        channel: 'system',
        timestamp: Date.now(),
      };
      
      await this.redisPublisher.publish('auth:events', JSON.stringify(authEvent));
    }
  }

  /**
   * Get token for a user (for making API calls)
   */
  async getToken(phone: string): Promise<string | null> {
    const auth = await this.getAuthenticatedUser(phone);
    return auth?.token || null;
  }

  /**
   * Link a session ID to a phone number (for web sessions)
   */
  async linkSessionToPhone(sessionId: string, phone: string): Promise<void> {
    const normalizedPhone = normalizePhoneNumber(phone) || phone;
    
    // Store session -> phone mapping
    await this.redis.setex(`session_phone:${sessionId}`, this.authTtl, normalizedPhone);
    
    // Store phone -> sessions mapping (for broadcast)
    const sessionsKey = `phone_sessions:${normalizedPhone.replace('+', '')}`;
    await this.redis.sadd(sessionsKey, sessionId);
    await this.redis.expire(sessionsKey, this.authTtl);
    
    this.logger.log(`🔗 Linked session ${sessionId} to phone ${normalizedPhone}`);
  }

  /**
   * Get phone number for a session ID
   */
  async getPhoneForSession(sessionId: string): Promise<string | null> {
    return await this.redis.get(`session_phone:${sessionId}`);
  }

  /**
   * Get all active sessions for a phone number
   */
  async getSessionsForPhone(phone: string): Promise<string[]> {
    const normalizedPhone = normalizePhoneNumber(phone) || phone;
    const sessionsKey = `phone_sessions:${normalizedPhone.replace('+', '')}`;
    return await this.redis.smembers(sessionsKey);
  }

  /**
   * Sync auth state from PHP backend (for users who logged in via main app)
   */
  async syncFromPhpBackend(token: string, channel: string): Promise<AuthenticatedUser | null> {
    try {
      const profile = await this.phpAuthService.getUserProfile(token);
      
      if (profile) {
        return await this.authenticateUser(
          profile.phone,
          token,
          {
            userId: profile.id,
            firstName: profile.firstName,
            lastName: profile.lastName,
            email: profile.email,
          },
          channel,
        );
      }
      
      return null;
    } catch (e) {
      this.logger.error(`Failed to sync auth from PHP backend: ${e.message}`);
      return null;
    }
  }

  /**
   * Get auth data for a phone (alias for getAuthenticatedUser for compatibility)
   */
  async getAuthData(phone: string): Promise<{ userId?: number; userName?: string; platform?: string } | null> {
    const auth = await this.getAuthenticatedUser(phone);
    if (!auth) return null;
    return {
      userId: auth.userId,
      userName: auth.firstName,
      platform: auth.channels[auth.channels.length - 1] || 'unknown',
    };
  }

  /**
   * Simple logout (alias for logoutUser)
   */
  async logout(phone: string): Promise<void> {
    await this.logoutUser(phone);
  }

  /**
   * Broadcast auth event to all connected WebSocket clients for a phone
   */
  async broadcastAuthEvent(
    phone: string,
    eventType: string,
    data: any,
    wsServer: any,
  ): Promise<void> {
    const sessions = await this.getSessionsForPhone(phone);
    
    this.logger.log(`📢 Broadcasting ${eventType} to ${sessions.length} sessions for ***${phone?.slice(-4)}`);
    
    for (const sessionId of sessions) {
      wsServer.to(sessionId).emit(eventType, data);
    }
  }

  /**
   * Sync authentication across all sessions for a phone
   */
  async syncAuthAcrossSessions(
    phone: string, 
    userId: number, 
    token: string
  ): Promise<void> {
    const sessions = await this.getSessionsForPhone(phone);
    
    this.logger.log(`🔄 Syncing auth across ${sessions.length} sessions for user ${userId}`);
    
    // Auth data is already stored centrally by phone, 
    // this just ensures all sessions are aware
    const authEvent: AuthEvent = {
      type: 'LOGIN',
      phone,
      userId,
      channel: 'sync',
      timestamp: Date.now(),
    };
    
    await this.redisPublisher.publish('auth:events', JSON.stringify(authEvent));
  }
}
