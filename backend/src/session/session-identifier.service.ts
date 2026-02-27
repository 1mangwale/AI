import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Session Identifier Types
 * 
 * The system uses different identifier formats for different channels:
 * - WhatsApp: Phone number (+919876543210)
 * - Web Chat: Session ID (web-abc123)
 * - Telegram: Chat ID (tg-123456)
 * - SMS: Phone number (+919876543210)
 */
export type ChannelType = 'whatsapp' | 'web' | 'telegram' | 'sms' | 'voice' | 'unknown';

export interface IdentifierResolution {
  /** The original session identifier (could be phone or session ID) */
  sessionId: string;
  
  /** The actual phone number (resolved from session data if needed) */
  phoneNumber: string | null;
  
  /** Whether the user has authenticated and we have their real phone */
  isPhoneVerified: boolean;
  
  /** The channel type detected from the identifier */
  channel: ChannelType;
  
  /** User ID if authenticated */
  userId?: number;
  
  /** Auth token if authenticated */
  authToken?: string;
}

/**
 * Session Identifier Service
 * 
 * Resolves the ambiguity between session IDs and phone numbers across channels.
 * 
 * PROBLEM STATEMENT:
 * - For WhatsApp/SMS, the "phoneNumber" parameter IS the actual phone number
 * - For Web Chat, the "phoneNumber" parameter is actually a session ID (e.g., "web-abc123")
 * - Legacy code passed sessionId as phoneNumber, causing confusion
 * 
 * SOLUTION:
 * This service provides a unified way to:
 * 1. Detect the channel type from an identifier
 * 2. Resolve the actual phone number from session data
 * 3. Get consistent identifier resolution across all services
 * 
 * USAGE:
 * ```typescript
 * const resolution = await sessionIdentifierService.resolve(identifier);
 * const actualPhone = resolution.phoneNumber; // Always the real phone (or null)
 * const sessionId = resolution.sessionId; // Always the session key for storage
 * ```
 * 
 * NOTE: This service uses Redis directly to avoid circular dependencies
 * with SessionService and CentralizedAuthService.
 */
@Injectable()
export class SessionIdentifierService implements OnModuleInit {
  private readonly logger = new Logger(SessionIdentifierService.name);
  private pool: Pool;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private configService: ConfigService,
  ) {
    const pgUrl = this.configService.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({
      connectionString: pgUrl,
      max: 5,
      idleTimeoutMillis: 30000,
    });

    this.logger.log('✅ Session Identifier Service initialized with shared Redis');
  }

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS bsuid_mapping (
          bsuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(50),
          wa_username VARCHAR(100),
          device_fingerprint VARCHAR(255),
          channel VARCHAR(20),
          user_id INTEGER,
          verified BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW(),
          last_seen_at TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bsuid_phone ON bsuid_mapping(phone) WHERE phone IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bsuid_wa_username ON bsuid_mapping(wa_username) WHERE wa_username IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_bsuid_user ON bsuid_mapping(user_id);
      `);
      this.logger.log('BSUID mapping table ready');
    } catch (error) {
      this.logger.error(`Failed to initialize BSUID table: ${error.message}`);
    }
  }

  /**
   * Detect channel type from identifier
   */
  detectChannel(identifier: string): ChannelType {
    if (!identifier) return 'unknown';
    
    // Web session IDs start with 'web-' or 'sess-' (from frontend WebSocket)
    if (identifier.startsWith('web-') || identifier.startsWith('sess-')) return 'web';
    
    // Telegram IDs start with 'tg-'
    if (identifier.startsWith('tg-')) return 'telegram';
    
    // Voice sessions start with 'voice-'
    if (identifier.startsWith('voice-')) return 'voice';
    
    // If it looks like a phone number, it's WhatsApp or SMS
    // Phone patterns: +91..., 91..., 9..., whatsapp:+91...
    const cleanId = identifier.replace(/^whatsapp:/, '');
    if (/^\+?\d{10,15}$/.test(cleanId)) {
      return identifier.includes('whatsapp') ? 'whatsapp' : 'whatsapp'; // Default phone to WhatsApp
    }
    
    // SMS explicit prefix
    if (identifier.startsWith('sms-')) return 'sms';
    
    return 'unknown';
  }

  /**
   * Check if identifier is a session ID (not a real phone number)
   */
  isSessionId(identifier: string): boolean {
    const channel = this.detectChannel(identifier);
    return channel === 'web' || channel === 'telegram' || channel === 'voice' || channel === 'unknown';
  }

  /**
   * Check if identifier is a real phone number
   */
  isPhoneNumber(identifier: string): boolean {
    const channel = this.detectChannel(identifier);
    return channel === 'whatsapp' || channel === 'sms';
  }

  /**
   * Normalize a phone number to standard format (+countrycode number)
   */
  normalizePhone(phone: string): string | null {
    if (!phone) return null;
    
    // Remove common prefixes and formatting
    let cleaned = phone
      .replace(/^whatsapp:/, '')
      .replace(/\s+/g, '')
      .replace(/-/g, '')
      .trim();
    
    // Already has + prefix
    if (cleaned.startsWith('+')) {
      return cleaned;
    }
    
    // Indian numbers without country code
    if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
      return `+91${cleaned}`;
    }
    
    // Has country code but no +
    if (cleaned.length >= 11 && cleaned.length <= 15) {
      return `+${cleaned}`;
    }
    
    return null;
  }

  /**
   * Resolve identifier to get both sessionId and actual phoneNumber
   * 
   * This is the main method to use throughout the codebase.
   * It handles all the complexity of resolving phone numbers from session data.
   */
  async resolve(identifier: string): Promise<IdentifierResolution> {
    const channel = this.detectChannel(identifier);
    
    // Default resolution
    const resolution: IdentifierResolution = {
      sessionId: identifier,
      phoneNumber: null,
      isPhoneVerified: false,
      channel,
    };

    // If identifier is already a phone number (WhatsApp/SMS), we're done
    if (this.isPhoneNumber(identifier)) {
      resolution.phoneNumber = this.normalizePhone(identifier);
      resolution.isPhoneVerified = true;
      
      // Still try to get additional user data from session
      try {
        const sessionData = await this.redis.get(`session:${identifier}`);
        if (sessionData) {
          const session = JSON.parse(sessionData);
          resolution.userId = session.data?.user_id;
          resolution.authToken = session.data?.auth_token;
        }
      } catch (error) {
        this.logger.warn(`Failed to get session data: ${error.message}`);
      }
      
      return resolution;
    }

    // For session IDs, we need to look up the actual phone from session data
    try {
      // First try centralized auth service mapping (session_phone:xxx)
      const linkedPhone = await this.redis.get(`session_phone:${identifier}`);
      if (linkedPhone) {
        resolution.phoneNumber = this.normalizePhone(linkedPhone);
        resolution.isPhoneVerified = true;
      }

      // Get session data for additional info
      const sessionData = await this.redis.get(`session:${identifier}`);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        const data = session.data || {};
        
        // If we don't have phone from centralized auth, try session data
        if (!resolution.phoneNumber) {
          // Priority order for phone number in session data:
          // 1. session.phone (root level - set by auth flow)
          // 2. user_phone (set by flow engine after OTP verification)
          // 3. phone_number (compatibility)
          // 4. phone (nested in data object)
          // 5. auth_phone (set during auth flow)
          // 6. otp_phone (phone used for OTP - may not be verified)
          const phoneFromSession = 
            session.phone ||  // ✅ CHECK ROOT LEVEL FIRST
            data.user_phone ||
            data.phone_number ||
            data.phone ||
            data.auth_phone ||
            data.otp_phone;
          
          if (phoneFromSession) {
            resolution.phoneNumber = this.normalizePhone(phoneFromSession);
            // Only mark as verified if user is authenticated
            resolution.isPhoneVerified = !!data.authenticated || !!session.authenticated;
          }
        }

        // Get user ID and token
        resolution.userId = data.user_id;
        resolution.authToken = data.auth_token;
        
        // Update verification status based on auth state
        if (data.authenticated && resolution.phoneNumber) {
          resolution.isPhoneVerified = true;
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to resolve identifier ${identifier}: ${error.message}`);
    }

    this.logger.debug(`🔍 Resolved ${identifier}: phone=${resolution.phoneNumber || 'unknown'}, verified=${resolution.isPhoneVerified}, channel=${channel}`);

    return resolution;
  }

  /**
   * Get the best identifier to use for API calls that need a phone number
   * 
   * @param identifier - The session identifier
   * @param requireVerified - If true, returns null if phone is not verified
   * @returns The phone number or null if not available
   */
  async getPhoneNumber(identifier: string, requireVerified = false): Promise<string | null> {
    const resolution = await this.resolve(identifier);
    
    if (requireVerified && !resolution.isPhoneVerified) {
      return null;
    }
    
    return resolution.phoneNumber;
  }

  /**
   * Get phone number with fallback to session ID
   * 
   * This is useful for cases where you need SOMETHING, even if it's just the session ID.
   * Use with caution - this may return a session ID instead of a real phone.
   */
  async getPhoneNumberOrSessionId(identifier: string): Promise<string> {
    const resolution = await this.resolve(identifier);
    return resolution.phoneNumber || resolution.sessionId;
  }

  /**
   * Store the verified phone number in session
   * 
   * Call this after OTP verification to properly link session to phone.
   */
  async linkPhoneToSession(sessionId: string, phone: string): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      this.logger.warn(`Cannot link invalid phone ${phone} to session ${sessionId}`);
      return;
    }

    try {
      // Get existing session data
      const sessionData = await this.redis.get(`session:${sessionId}`);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        session.data = session.data || {};
        session.data.user_phone = normalizedPhone;
        session.data.phone_number = normalizedPhone;
        session.data.phone = normalizedPhone;
        session.updatedAt = Date.now();
        
        // Save updated session
        const sessionTtl = this.configService.get('session.ttl') || 86400;
        await this.redis.setex(`session:${sessionId}`, sessionTtl, JSON.stringify(session));
      }

      // Store session -> phone mapping (centralized auth format)
      const authTtl = 7 * 24 * 60 * 60; // 7 days
      await this.redis.setex(`session_phone:${sessionId}`, authTtl, normalizedPhone);

      // Store phone -> sessions mapping (for broadcast)
      const sessionsKey = `phone_sessions:${normalizedPhone.replace('+', '')}`;
      await this.redis.sadd(sessionsKey, sessionId);
      await this.redis.expire(sessionsKey, authTtl);

      this.logger.log(`🔗 Linked session ${sessionId} to phone ${normalizedPhone}`);
    } catch (error) {
      this.logger.error(`Failed to link phone to session: ${error.message}`);
    }
  }

  /**
   * Get identifier details for logging (masks sensitive data)
   */
  getMaskedIdentifier(identifier: string): string {
    const channel = this.detectChannel(identifier);
    
    if (channel === 'whatsapp' || channel === 'sms') {
      // Mask phone number: +91****6329
      const phone = identifier.replace(/^whatsapp:/, '');
      if (phone.length > 4) {
        return phone.slice(0, 3) + '****' + phone.slice(-4);
      }
    }
    
    // For session IDs, show type and partial ID
    if (identifier.length > 8) {
      return `${channel}:${identifier.slice(-6)}`;
    }
    
    return identifier;
  }
}
