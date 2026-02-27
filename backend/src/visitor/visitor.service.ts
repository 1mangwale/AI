import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Universal Visitor Identification Service
 * 
 * PHILOSOPHY:
 * Every person who touches Mangwale AI should have a unique identifier
 * that persists across sessions, devices, and channels.
 * 
 * IDENTIFIER HIERARCHY:
 * 1. visitor_id (UVID) - Generated on first touch, stored forever
 * 2. phone_number - Linked after verification, becomes primary key
 * 3. user_id - Linked after full registration/login
 * 
 * BENEFITS:
 * - Track anonymous users before login
 * - Merge activity when user finally logs in
 * - Cross-device tracking via phone linking
 * - Analytics on conversion funnel
 * - Personalization even for guests
 */

export interface Visitor {
  id: string;              // UUID v4: vis_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  phone?: string;          // Linked after verification
  userId?: number;         // Linked after login (PHP backend user ID)
  firstSeenAt: Date;
  lastSeenAt: Date;
  firstChannel: string;    // 'web', 'whatsapp', 'telegram', etc.
  deviceFingerprint?: string;
  userAgent?: string;
  totalSessions: number;
  totalMessages: number;
  isAnonymous: boolean;
  mergedVisitorIds?: string[];  // Other visitor_ids that were merged into this one
  metadata?: Record<string, any>;
}

export interface VisitorSession {
  sessionId: string;
  visitorId: string;
  channel: string;
  startedAt: Date;
  lastActivityAt: Date;
  messagesCount: number;
  isAuthenticated: boolean;
}

@Injectable()
export class VisitorService {
  private readonly logger = new Logger(VisitorService.name);
  private pgPool: Pool;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private configService: ConfigService,
  ) {
    this.initializeConnections();
  }

  private async initializeConnections() {
    // PostgreSQL for persistent storage
    const pgUrl = process.env.DATABASE_URL ||
      'postgresql://mangwale_config:config_secure_pass_2024@172.17.0.2:5432/headless_mangwale';

    this.pgPool = new Pool({
      connectionString: pgUrl,
      max: 10,
      idleTimeoutMillis: 30000,
    });

    await this.ensureTablesExist();
    this.logger.log('✅ Visitor Service initialized with shared Redis');
  }

  private async ensureTablesExist() {
    try {
      await this.pgPool.query(`
        CREATE TABLE IF NOT EXISTS visitors (
          id VARCHAR(50) PRIMARY KEY,
          phone VARCHAR(50),
          user_id INTEGER,
          first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          first_channel VARCHAR(20),
          device_fingerprint VARCHAR(255),
          user_agent TEXT,
          total_sessions INTEGER DEFAULT 1,
          total_messages INTEGER DEFAULT 0,
          is_anonymous BOOLEAN DEFAULT true,
          merged_visitor_ids TEXT[],
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_visitors_phone ON visitors(phone) WHERE phone IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_visitors_user_id ON visitors(user_id) WHERE user_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_visitors_anonymous ON visitors(is_anonymous);
        
        CREATE TABLE IF NOT EXISTS visitor_sessions (
          session_id VARCHAR(100) PRIMARY KEY,
          visitor_id VARCHAR(50) NOT NULL REFERENCES visitors(id),
          channel VARCHAR(20),
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          messages_count INTEGER DEFAULT 0,
          is_authenticated BOOLEAN DEFAULT false,
          metadata JSONB DEFAULT '{}'
        );
        
        CREATE INDEX IF NOT EXISTS idx_visitor_sessions_visitor ON visitor_sessions(visitor_id);
      `);
      this.logger.log('✅ Visitor tables ready');
    } catch (error) {
      this.logger.error(`Failed to create visitor tables: ${error.message}`);
    }
  }

  /**
   * Generate a new visitor ID
   * Format: vis_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   */
  generateVisitorId(): string {
    return `vis_${uuidv4()}`;
  }

  /**
   * Get or create a visitor for a session
   * 
   * This is the main entry point - called on every new session
   */
  async getOrCreateVisitor(params: {
    sessionId: string;
    existingVisitorId?: string;  // From localStorage/cookie
    channel: string;
    phone?: string;              // If known (WhatsApp, after login)
    deviceFingerprint?: string;
    userAgent?: string;
  }): Promise<Visitor> {
    const { sessionId, existingVisitorId, channel, phone, deviceFingerprint, userAgent } = params;

    try {
      // 1. If phone is provided, try to find existing visitor by phone
      if (phone) {
        const existingByPhone = await this.findVisitorByPhone(phone);
        if (existingByPhone) {
          await this.updateVisitorActivity(existingByPhone.id);
          await this.linkSessionToVisitor(sessionId, existingByPhone.id, channel);
          return existingByPhone;
        }
      }

      // 2. If existingVisitorId provided, verify it exists
      if (existingVisitorId) {
        const existing = await this.findVisitorById(existingVisitorId);
        if (existing) {
          // Link phone if now known
          if (phone && !existing.phone) {
            await this.linkPhoneToVisitor(existing.id, phone);
            existing.phone = phone;
            existing.isAnonymous = false;
          }
          await this.updateVisitorActivity(existing.id);
          await this.linkSessionToVisitor(sessionId, existing.id, channel);
          return existing;
        }
      }

      // 3. Try to find by device fingerprint (returning anonymous user)
      if (deviceFingerprint) {
        const existingByFingerprint = await this.findVisitorByFingerprint(deviceFingerprint);
        if (existingByFingerprint) {
          await this.updateVisitorActivity(existingByFingerprint.id);
          await this.linkSessionToVisitor(sessionId, existingByFingerprint.id, channel);
          return existingByFingerprint;
        }
      }

      // 4. Create new visitor
      const newVisitorId = this.generateVisitorId();
      const newVisitor = await this.createVisitor({
        id: newVisitorId,
        phone,
        channel,
        deviceFingerprint,
        userAgent,
      });

      await this.linkSessionToVisitor(sessionId, newVisitorId, channel);
      
      this.logger.log(`👤 New visitor created: ${newVisitorId} (channel: ${channel}, phone: ${phone || 'anonymous'})`);
      return newVisitor;
    } catch (error) {
      this.logger.error(`Error in getOrCreateVisitor: ${error.message}`);
      // Fallback: return a temporary visitor
      return {
        id: this.generateVisitorId(),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        firstChannel: channel,
        totalSessions: 1,
        totalMessages: 0,
        isAnonymous: true,
      };
    }
  }

  /**
   * Create a new visitor record
   */
  private async createVisitor(params: {
    id: string;
    phone?: string;
    channel: string;
    deviceFingerprint?: string;
    userAgent?: string;
  }): Promise<Visitor> {
    const { id, phone, channel, deviceFingerprint, userAgent } = params;

    const result = await this.pgPool.query(
      `INSERT INTO visitors (id, phone, first_channel, device_fingerprint, user_agent, is_anonymous)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, phone || null, channel, deviceFingerprint || null, userAgent || null, !phone]
    );

    const row = result.rows[0];
    
    // Cache in Redis for fast lookups (24 hour TTL)
    await this.redis.setex(`visitor:${id}`, 86400, JSON.stringify(row));
    if (phone) {
      await this.redis.setex(`visitor:phone:${phone}`, 86400, id);
    }

    return this.rowToVisitor(row);
  }

  /**
   * Find visitor by ID
   */
  async findVisitorById(visitorId: string): Promise<Visitor | null> {
    // Check Redis cache first
    const cached = await this.redis.get(`visitor:${visitorId}`);
    if (cached) {
      return this.rowToVisitor(JSON.parse(cached));
    }

    const result = await this.pgPool.query(
      `SELECT * FROM visitors WHERE id = $1`,
      [visitorId]
    );

    if (result.rows.length === 0) return null;

    // Cache for next time
    await this.redis.setex(`visitor:${visitorId}`, 86400, JSON.stringify(result.rows[0]));
    return this.rowToVisitor(result.rows[0]);
  }

  /**
   * Find visitor by phone number
   */
  async findVisitorByPhone(phone: string): Promise<Visitor | null> {
    const normalizedPhone = this.normalizePhone(phone);
    
    // Check Redis cache first
    const cachedId = await this.redis.get(`visitor:phone:${normalizedPhone}`);
    if (cachedId) {
      return this.findVisitorById(cachedId);
    }

    const result = await this.pgPool.query(
      `SELECT * FROM visitors WHERE phone = $1`,
      [normalizedPhone]
    );

    if (result.rows.length === 0) return null;

    const visitor = this.rowToVisitor(result.rows[0]);
    // Cache for next time
    await this.redis.setex(`visitor:phone:${normalizedPhone}`, 86400, visitor.id);
    return visitor;
  }

  /**
   * Find visitor by device fingerprint
   */
  async findVisitorByFingerprint(fingerprint: string): Promise<Visitor | null> {
    const result = await this.pgPool.query(
      `SELECT * FROM visitors WHERE device_fingerprint = $1 ORDER BY last_seen_at DESC LIMIT 1`,
      [fingerprint]
    );

    return result.rows.length > 0 ? this.rowToVisitor(result.rows[0]) : null;
  }

  /**
   * Link phone number to visitor (after login/verification)
   */
  async linkPhoneToVisitor(visitorId: string, phone: string): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    
    // Check if another visitor already has this phone
    const existingVisitor = await this.findVisitorByPhone(normalizedPhone);
    
    if (existingVisitor && existingVisitor.id !== visitorId) {
      // Merge the two visitors
      await this.mergeVisitors(existingVisitor.id, visitorId);
      return;
    }

    await this.pgPool.query(
      `UPDATE visitors SET phone = $1, is_anonymous = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [normalizedPhone, visitorId]
    );

    // Update cache
    await this.redis.setex(`visitor:phone:${normalizedPhone}`, 86400, visitorId);
    await this.redis.del(`visitor:${visitorId}`);  // Invalidate old cache

    this.logger.log(`📱 Linked phone ${normalizedPhone.slice(-4)} to visitor ${visitorId}`);
  }

  /**
   * Link user ID to visitor (after full login)
   */
  async linkUserToVisitor(visitorId: string, userId: number): Promise<void> {
    await this.pgPool.query(
      `UPDATE visitors SET user_id = $1, is_anonymous = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [userId, visitorId]
    );

    await this.redis.del(`visitor:${visitorId}`);  // Invalidate cache
    this.logger.log(`👤 Linked user ${userId} to visitor ${visitorId}`);
  }

  /**
   * Merge two visitors (when same person identified)
   * 
   * This happens when:
   * - Anonymous visitor logs in with phone that belongs to another visitor
   * - Same user on different devices finally identified
   */
  async mergeVisitors(primaryVisitorId: string, secondaryVisitorId: string): Promise<void> {
    try {
      // Get both visitors
      const primary = await this.findVisitorById(primaryVisitorId);
      const secondary = await this.findVisitorById(secondaryVisitorId);

      if (!primary || !secondary) {
        this.logger.warn(`Cannot merge: visitor not found`);
        return;
      }

      // Update primary with merged data
      await this.pgPool.query(
        `UPDATE visitors SET 
          total_sessions = total_sessions + $1,
          total_messages = total_messages + $2,
          merged_visitor_ids = array_append(COALESCE(merged_visitor_ids, ARRAY[]::TEXT[]), $3),
          first_seen_at = LEAST(first_seen_at, $4),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [
          secondary.totalSessions,
          secondary.totalMessages,
          secondaryVisitorId,
          secondary.firstSeenAt,
          primaryVisitorId
        ]
      );

      // Update all sessions to point to primary
      await this.pgPool.query(
        `UPDATE visitor_sessions SET visitor_id = $1 WHERE visitor_id = $2`,
        [primaryVisitorId, secondaryVisitorId]
      );

      // Mark secondary as merged (soft delete)
      await this.pgPool.query(
        `UPDATE visitors SET 
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{merged_into}', $1::jsonb),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify(primaryVisitorId), secondaryVisitorId]
      );

      // Clear caches
      await this.redis.del(`visitor:${primaryVisitorId}`);
      await this.redis.del(`visitor:${secondaryVisitorId}`);

      this.logger.log(`🔗 Merged visitor ${secondaryVisitorId} into ${primaryVisitorId}`);
    } catch (error) {
      this.logger.error(`Failed to merge visitors: ${error.message}`);
    }
  }

  /**
   * Link session to visitor
   */
  private async linkSessionToVisitor(sessionId: string, visitorId: string, channel: string): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO visitor_sessions (session_id, visitor_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) 
       DO UPDATE SET visitor_id = $2, last_activity_at = CURRENT_TIMESTAMP`,
      [sessionId, visitorId, channel]
    );
  }

  /**
   * Update visitor activity (last seen, session count)
   */
  private async updateVisitorActivity(visitorId: string): Promise<void> {
    await this.pgPool.query(
      `UPDATE visitors SET 
        last_seen_at = CURRENT_TIMESTAMP,
        total_sessions = total_sessions + 1,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [visitorId]
    );

    // Invalidate cache
    await this.redis.del(`visitor:${visitorId}`);
  }

  /**
   * Increment message count for visitor
   */
  async incrementMessageCount(visitorId: string): Promise<void> {
    await this.pgPool.query(
      `UPDATE visitors SET total_messages = total_messages + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [visitorId]
    );

    // Also update session
    await this.pgPool.query(
      `UPDATE visitor_sessions SET messages_count = messages_count + 1, last_activity_at = CURRENT_TIMESTAMP 
       WHERE visitor_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [visitorId]
    );
  }

  /**
   * Get visitor statistics (for analytics)
   */
  async getVisitorStats(): Promise<{
    totalVisitors: number;
    anonymousVisitors: number;
    identifiedVisitors: number;
    last24Hours: number;
    last7Days: number;
  }> {
    const result = await this.pgPool.query(`
      SELECT 
        COUNT(*) as total_visitors,
        COUNT(*) FILTER (WHERE is_anonymous = true) as anonymous_visitors,
        COUNT(*) FILTER (WHERE is_anonymous = false) as identified_visitors,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '24 hours') as last_24_hours,
        COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days') as last_7_days
      FROM visitors
    `);

    const row = result.rows[0];
    return {
      totalVisitors: parseInt(row.total_visitors),
      anonymousVisitors: parseInt(row.anonymous_visitors),
      identifiedVisitors: parseInt(row.identified_visitors),
      last24Hours: parseInt(row.last_24_hours),
      last7Days: parseInt(row.last_7_days),
    };
  }

  /**
   * Get visitor's full history (all sessions, all channels)
   */
  async getVisitorHistory(visitorId: string): Promise<VisitorSession[]> {
    const result = await this.pgPool.query(
      `SELECT * FROM visitor_sessions WHERE visitor_id = $1 ORDER BY started_at DESC`,
      [visitorId]
    );

    return result.rows.map(row => ({
      sessionId: row.session_id,
      visitorId: row.visitor_id,
      channel: row.channel,
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      messagesCount: row.messages_count,
      isAuthenticated: row.is_authenticated,
    }));
  }

  /**
   * Normalize phone number
   */
  private normalizePhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    return '+' + cleaned;
  }

  /**
   * Convert DB row to Visitor object
   */
  private rowToVisitor(row: any): Visitor {
    return {
      id: row.id,
      phone: row.phone,
      userId: row.user_id,
      firstSeenAt: new Date(row.first_seen_at),
      lastSeenAt: new Date(row.last_seen_at),
      firstChannel: row.first_channel,
      deviceFingerprint: row.device_fingerprint,
      userAgent: row.user_agent,
      totalSessions: parseInt(row.total_sessions) || 1,
      totalMessages: parseInt(row.total_messages) || 0,
      isAnonymous: row.is_anonymous,
      mergedVisitorIds: row.merged_visitor_ids,
      metadata: row.metadata,
    };
  }
}
