import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpApiService } from './php-api.service';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';
import { User } from '../../common/interfaces/common.interface';
import { normalizePhoneNumber } from '../../common/utils/helpers';
import * as mysql from 'mysql2/promise';

/**
 * PHP Authentication Service
 * Handles all authentication-related API calls
 */
@Injectable()
export class PhpAuthService extends PhpApiService {
  // Cache guest_id per phone to avoid cross-contamination between users
  private guestIdCache: Map<string, string> = new Map();
  
  // MySQL pool for direct user lookup (WhatsApp auto-auth)
  private mysqlPool: mysql.Pool | null = null;

  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);

    // Initialize MySQL pool for direct user queries
    this.initMySQLPool(configService);
  }
  
  /**
   * Initialize MySQL connection pool for direct user lookups
   * This is used for WhatsApp/Telegram auto-auth where we need to
   * check if a user exists without requiring OTP
   */
  private initMySQLPool(configService: ConfigService): void {
    try {
      const mysqlHost = configService.get('MYSQL_HOST');
      const mysqlPort = parseInt(configService.get('MYSQL_PORT', '3306'));
      const mysqlUser = configService.get('MYSQL_USERNAME') || configService.get('MYSQL_USER', 'root');
      const mysqlPassword = configService.get('MYSQL_PASSWORD');
      const mysqlDatabase = configService.get('MYSQL_DATABASE', 'mangwale_db');
      
      if (!mysqlHost || !mysqlPassword) {
        this.logger.warn('⚠️ MySQL not configured - WhatsApp auto-auth will use API fallback');
        return;
      }
      
      this.mysqlPool = mysql.createPool({
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
      });
      
      this.logger.log(`✅ MySQL pool initialized for auto-auth: ${mysqlHost}:${mysqlPort}`);
    } catch (error) {
      this.logger.error(`❌ Failed to initialize MySQL pool: ${error.message}`);
    }
  }

  /**
   * Ensure we have a guest_id from PHP backend (required for auth APIs)
   * FALLBACK: If guests table doesn't exist, generate a temporary guest_id
   */
  private async ensureGuestId(phone?: string): Promise<string> {
    const cacheKey = phone || '__default__';
    const cached = this.guestIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      this.logger.log('🆔 Requesting guest_id from PHP backend');
      const resp: any = await this.post('/api/v1/auth/guest/request', {
        fcm_token: null,
      });

      const guestId = resp?.guest_id || resp?.guestId;
      if (guestId) {
        this.guestIdCache.set(cacheKey, guestId);
        this.logger.log(`✅ Acquired guest_id: ${guestId} for ${cacheKey}`);
        return guestId;
      }

      throw new Error('guest_id not returned by PHP backend');
    } catch (error) {
      this.logger.error(`❌ Failed to fetch guest_id: ${error.message}`);
      
      // FALLBACK: If guests table doesn't exist or guest creation fails,
      // generate a temporary guest_id to allow auth to proceed
      if (error.message?.includes('guests') || error.message?.includes('SQLSTATE')) {
        const fallbackGuestId = `temp_guest_${Date.now()}`;
        this.guestIdCache.set(cacheKey, fallbackGuestId);
        this.logger.warn(`⚠️ Using fallback guest_id: ${fallbackGuestId}`);
        return fallbackGuestId;
      }
      
      throw error;
    }
  }

  /**
   * Send OTP to phone number
   */
  async sendOtp(phone: string): Promise<{
    success: boolean;
    message?: string;
  }> {
    // Normalize phone number to ensure +91 format
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return { success: false, message: 'Invalid phone number format' };
    }

    // MOCK FOR TESTING - Only works when testMode is explicitly enabled
    const isTestMode = this.configService.get('app.testMode') === true;
    const mockNumbers: string[] = this.configService.get('test.mockPhoneNumbers') || [];
    if (isTestMode && mockNumbers.some(n => normalizedPhone.includes(n))) {
      this.logger.log(`📞 [MOCK] Sending OTP to ${normalizedPhone} (TEST MODE)`);
      return { success: true, message: 'OTP sent successfully' };
    }

    try {
      this.logger.log(`📞 Sending OTP to ${normalizedPhone}`);
      
      // Try to get guest_id, but continue even if it fails (PHP backend bug workaround)
      let guestId: string;
      try {
        guestId = await this.ensureGuestId(normalizedPhone);
      } catch (guestError) {
        this.logger.warn(`⚠️ Guest ID fetch failed, trying without it: ${guestError.message}`);
        guestId = null; // Proceed without guest_id
      }

      const requestData: any = {
        phone: normalizedPhone,
        login_type: 'otp',
      };
      
      // Only include guest_id if we have one
      if (guestId) {
        requestData.guest_id = guestId;
      }

      const response = await this.post('/api/v1/auth/login', requestData);

      return { success: true, ...response };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Verify OTP code
   * Uses /api/v1/auth/verify-phone endpoint (same as API Gateway)
   */
  async verifyOtp(phone: string, otp: string): Promise<{
    success: boolean;
    data?: {
      id?: number;
      token?: string;
      is_personal_info: number;
      is_phone_verified: number;
      is_email_verified: number;
      email?: string;
      f_name?: string;
      l_name?: string;
    };
    message?: string;
  }> {
    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return { success: false, message: 'Invalid phone number format' };
    }

    // MOCK FOR TESTING - Only works when testMode is explicitly enabled
    const isTestMode = this.configService.get('app.testMode') === true;
    const verifyMockNumbers: string[] = this.configService.get('test.mockPhoneNumbers') || [];
    const mockOtp: string = this.configService.get('test.mockOtp') || '123456';
    const isMockNumber = verifyMockNumbers.some(n => normalizedPhone.includes(n));
    if (isTestMode && isMockNumber && otp === mockOtp) {
      this.logger.log(`🔐 [MOCK] Verifying OTP for ${normalizedPhone}`);
      const newUserPhone = verifyMockNumbers[1] || '9999888877';
      const isNewUser = normalizedPhone.includes(newUserPhone);
      const mockUserIds = this.configService.get('test.mockUserIds') || { existing: 88887777, new: 99998888 };
      const mockUserId = isNewUser ? mockUserIds.new : mockUserIds.existing;
      
      return {
        success: true,
        data: {
          id: mockUserId,
          token: `mock_token_${normalizedPhone.replace('+', '')}`,
          is_personal_info: isNewUser ? 0 : 1,
          is_phone_verified: 1,
          is_email_verified: isNewUser ? 0 : 1,
          email: isNewUser ? undefined : 'test@example.com',
          f_name: isNewUser ? '' : 'Test',
          l_name: isNewUser ? '' : 'User'
        }
      };
    }

    try {
      this.logger.log(`🔐 Verifying OTP for ${normalizedPhone}`);
      
      const guestId = await this.ensureGuestId(normalizedPhone);

      const response: any = await this.post('/api/v1/auth/verify-phone', {
        phone: normalizedPhone,
        verification_type: 'phone',
        otp: otp,
        login_type: 'otp',
        guest_id: guestId,
      });

      this.logger.log(`✅ OTP verified response: ${JSON.stringify(response)}`);
      this.logger.log(`✅ OTP verified: token=${response.token ? 'YES' : 'NO'}, is_personal_info=${response.is_personal_info}`);
      
      return {
        success: true,
        data: response,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Update user personal information (name and email)
   */
  async updateUserInfo(phone: string, name: string, email: string): Promise<{
    success: boolean;
    token?: string;
    message?: string;
  }> {
    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return { success: false, message: 'Invalid phone number format' };
    }

    // MOCK FOR TESTING - Only works when testMode is explicitly enabled
    const isTestMode = this.configService.get('app.testMode') === true;
    const updateMockNumbers: string[] = this.configService.get('test.mockPhoneNumbers') || [];
    if (isTestMode && updateMockNumbers.some(n => normalizedPhone.includes(n))) {
      this.logger.log(`📝 [MOCK] Updating user info for ${normalizedPhone} (TEST MODE)`);
      return {
        success: true,
        token: `mock_token_${normalizedPhone.replace('+', '')}_updated`
      };
    }

    try {
      this.logger.log(`📝 Updating user info for ${normalizedPhone}`);
      
      const response: any = await this.post('/api/v1/auth/update-info', {
        login_type: 'otp',
        phone: normalizedPhone,
        name,
        email,
      });

      this.logger.log(`✅ User info updated, token: ${response.token ? 'YES' : 'NO'}`);
      
      return {
        success: true,
        token: response.token,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Get user profile
   */
  async getUserProfile(token: string): Promise<User | null> {
    // MOCK FOR TESTING - Only works when testMode is explicitly enabled
    const isTestMode = this.configService.get('app.testMode') === true;
    if (isTestMode && token.startsWith('mock_token_')) {
      const isNewUser = token.includes('9999888877');
      const phone = isNewUser ? '9999888877' : '8888777766';
      this.logger.log(`👤 [MOCK] Getting profile for ${phone} (TEST MODE)`);
      return {
        id: isNewUser ? 67890 : 12345,
        phone: phone,
        email: isNewUser ? 'newuser@example.com' : 'test@example.com',
        firstName: isNewUser ? 'New' : 'Test',
        lastName: 'User',
        isPhoneVerified: true,
        isEmailVerified: true,
      };
    }

    try {
      // Add current_language_key to headers - PHP requires lowercase 'X-localization'
      const response = await this.authenticatedRequest(
        'get', 
        '/api/v1/customer/info', 
        token,
        null, // data
        { 'X-localization': 'en' } // PHP requires lowercase
      );
      this.logger.log(`👤 User Profile Response: ${JSON.stringify(response)}`);
      
      return {
        id: response.id,
        phone: response.phone,
        email: response.email,
        firstName: response.f_name,
        lastName: response.l_name,
        zoneId: response.zone_id,
        isPhoneVerified: response.is_phone_verified === 1,
        isEmailVerified: response.is_email_verified === 1,
      };
    } catch (error) {
      // If header fails, try query param
      try {
        this.logger.warn(`Profile fetch failed, retrying with query param...`);
        const response = await this.authenticatedRequest(
          'get',
          '/api/v1/customer/info?current_language_key=en',
          token
        );
        this.logger.log(`👤 User Profile Response (Retry): ${JSON.stringify(response)}`);

        return {
          id: response.id,
          phone: response.phone,
          email: response.email,
          firstName: response.f_name,
          lastName: response.l_name,
          zoneId: response.zone_id,
          isPhoneVerified: response.is_phone_verified === 1,
          isEmailVerified: response.is_email_verified === 1,
        };
      } catch (retryError) {
        this.logger.error(`Failed to fetch user profile: ${retryError.message}`);
        if (retryError.response) {
           this.logger.error(`Profile Error Response: ${JSON.stringify(retryError.response.data)}`);
        }
        return null;
      }
    }
  }

  /**
   * Login with email/password
   * PHP endpoint: POST /api/v1/auth/login
   * Expects: { email_or_phone, password, login_type: 'manual', field_type: 'email'|'phone' }
   */
  async loginWithPassword(emailOrPhone: string, password: string, fieldType: 'email' | 'phone'): Promise<{
    token: string;
    id?: number;
    phone?: string;
    email?: string;
    f_name?: string;
    l_name?: string;
    is_personal_info: number;
    is_phone_verified: number;
    is_email_verified: number;
  }> {
    // MOCK FOR TESTING - Only works when testMode is explicitly enabled
    const isTestMode = this.configService.get('app.testMode') === true;
    if (isTestMode && emailOrPhone === 'test@example.com' && password === 'test123') {
      this.logger.log(`🔐 [MOCK] Password login for ${emailOrPhone} (TEST MODE)`);
      return {
        token: `mock_token_password_${Date.now()}`,
        id: 99999,
        email: emailOrPhone,
        f_name: 'Test',
        l_name: 'User',
        is_personal_info: 1,
        is_phone_verified: 1,
        is_email_verified: 1,
      };
    }

    this.logger.log(`🔐 Password login for ${emailOrPhone} (${fieldType})`);
    
    const response: any = await this.post('/api/v1/auth/login', {
      email_or_phone: emailOrPhone,
      password: password,
      login_type: 'manual',
      field_type: fieldType,
    });

    this.logger.log(`✅ Password login response: token=${response.token ? 'YES' : 'NO'}, is_personal_info=${response.is_personal_info}`);
    
    if (!response.token) {
      throw new Error('Invalid credentials');
    }
    
    return response;
  }

  /**
   * Social login (Google, Facebook, Apple)
   * PHP endpoint: POST /api/v1/auth/social-login
   * Expects: { token, unique_id, email, medium: 'google'|'facebook'|'apple' }
   */
  async socialLogin(data: {
    token: string;
    unique_id: string;
    email: string;
    medium: 'google' | 'facebook' | 'apple';
  }): Promise<{
    success: boolean;
    data?: {
      token: string;
      id?: number;
      phone?: string;
      email?: string;
      f_name?: string;
      l_name?: string;
      is_personal_info: number;
      is_phone_verified: number;
      is_email_verified: number;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`🔐 Social login via ${data.medium} for: ${data.email || data.unique_id}`);
      
      const response: any = await this.post('/api/v1/auth/social-login', {
        token: data.token,
        unique_id: data.unique_id,
        email: data.email,
        medium: data.medium,
      });

      this.logger.log(`✅ Social login successful: userId=${response.id}, email=${response.email}`);
      
      return {
        success: true,
        data: {
          token: response.token,
          id: response.id,
          phone: response.phone,
          email: response.email,
          f_name: response.f_name,
          l_name: response.l_name,
          is_personal_info: response.is_personal_info ?? 1,
          is_phone_verified: response.is_phone_verified ?? 0,
          is_email_verified: response.is_email_verified ?? 1,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Social login failed: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Social login failed',
      };
    }
  }

  /**
   * Check if user exists by phone number
   * Used for auto-auth on WhatsApp/Telegram
   * 
   * Check if user exists by phone number
   * Used for auto-auth on WhatsApp/Telegram
   * 
   * UPDATED: Query MySQL directly since PHP backend doesn't have 
   * /check-phone or /auto-login endpoints
   */
  async checkUserExists(phone: string): Promise<{
    exists: boolean;
    data?: {
      id: number;
      phone: string;
      f_name?: string;
      l_name?: string;
      email?: string;
      token?: string;
    };
  }> {
    // Normalize phone number for MySQL lookup
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      this.logger.warn(`⚠️ Invalid phone format: ${phone}`);
      return { exists: false };
    }
    
    // Try MySQL direct lookup first (most reliable)
    if (this.mysqlPool) {
      try {
        this.logger.log(`🔍 Checking user in MySQL: ${normalizedPhone}`);
        
        // Query users table directly
        // Phone format in DB could be with or without +91
        const [rows]: any = await this.mysqlPool.execute(
          `SELECT id, phone, f_name, l_name, email 
           FROM users 
           WHERE phone = ? OR phone = ? OR phone = ?
           LIMIT 1`,
          [
            normalizedPhone,
            normalizedPhone.replace('+91', ''),
            normalizedPhone.replace('+', ''),
          ]
        );
        
        if (rows && rows.length > 0) {
          const user = rows[0];
          this.logger.log(`✅ User found in MySQL: ${user.f_name || 'Unknown'} (ID: ${user.id})`);
          return {
            exists: true,
            data: {
              id: user.id,
              phone: user.phone,
              f_name: user.f_name,
              l_name: user.l_name,
              email: user.email,
            },
          };
        }
        
        this.logger.log(`🆕 User not found in MySQL: ${normalizedPhone}`);
        return { exists: false };
      } catch (dbError) {
        this.logger.error(`❌ MySQL lookup failed: ${dbError.message}`);
        // Fall through to API fallback
      }
    }
    
    // Fallback: Try PHP API platform-login
    try {
      this.logger.log(`🔍 Checking user via platform-login API: ${phone}`);
      
      const apiKey = this.configService.get('PLATFORM_LOGIN_API_KEY');
      if (!apiKey) {
        this.logger.warn('⚠️ PLATFORM_LOGIN_API_KEY not configured, skipping platform-login fallback');
        return { exists: false };
      }
      
      const response: any = await this.post('/api/v1/auth/platform-login', {
        phone: normalizedPhone,
        platform: 'whatsapp',
        api_key: apiKey,
      });
      
      if (response && (response.token || response.id)) {
        this.logger.log(`✅ User exists (via API): ${response.f_name || 'Unknown'}`);
        return {
          exists: true,
          data: {
            id: response.id,
            phone: response.phone || phone,
            f_name: response.f_name,
            l_name: response.l_name,
            email: response.email,
            token: response.token,
          },
        };
      }
      
      return { exists: false };
    } catch (error) {
      this.logger.log(`User not found: ${error.message}`);
      return { exists: false };
    }
  }

  /**
   * Check if user exists by email address
   * Used for Google OAuth users who have email but need PHP user_id + phone
   * 
   * @param email - The email address to look up
   * @returns User data if found, including phone number for session
   */
  async checkUserExistsByEmail(email: string): Promise<{
    exists: boolean;
    data?: {
      id: number;
      phone: string;
      f_name?: string;
      l_name?: string;
      email?: string;
    };
  }> {
    if (!email || !email.includes('@')) {
      this.logger.warn(`⚠️ Invalid email format: ${email}`);
      return { exists: false };
    }
    
    // Try MySQL direct lookup (most reliable for existing users)
    if (this.mysqlPool) {
      try {
        this.logger.log(`🔍 Checking user by email in MySQL: ${email}`);
        
        const [rows]: any = await this.mysqlPool.execute(
          `SELECT id, phone, f_name, l_name, email 
           FROM users 
           WHERE email = ?
           LIMIT 1`,
          [email]
        );
        
        if (rows && rows.length > 0) {
          const user = rows[0];
          this.logger.log(`✅ User found by email: ${user.f_name || 'Unknown'} (ID: ${user.id}, phone: ${user.phone})`);
          return {
            exists: true,
            data: {
              id: user.id,
              phone: user.phone,
              f_name: user.f_name,
              l_name: user.l_name,
              email: user.email,
            },
          };
        }
        
        this.logger.log(`🆕 User not found by email: ${email}`);
        return { exists: false };
      } catch (dbError) {
        this.logger.error(`❌ MySQL email lookup failed: ${dbError.message}`);
        return { exists: false };
      }
    }
    
    this.logger.warn(`⚠️ MySQL not configured for email lookup`);
    return { exists: false };
  }

  /**
   * Auto-login by phone number (for verified platforms like WhatsApp)
   * Uses PHP backend's platform-login endpoint which:
   * - Validates API key for security
   * - Finds or creates user by phone
   * - Returns OAuth token for API calls
   */
  async autoLogin(phone: string, platform: 'whatsapp' | 'telegram' = 'whatsapp'): Promise<{
    success: boolean;
    data?: {
      token: string;
      id: number;
      phone: string;
      f_name?: string;
      l_name?: string;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`🔐 Platform login for verified phone: ${phone} (${platform})`);
      
      // Use the correct PHP endpoint: platform-login
      // This endpoint validates an API key and trusts the platform verification
      const apiKey = this.configService.get('PLATFORM_LOGIN_API_KEY');
      if (!apiKey) {
        throw new Error('PLATFORM_LOGIN_API_KEY not configured');
      }
      
      const response: any = await this.post('/api/v1/auth/platform-login', {
        phone: phone,
        platform: platform,
        api_key: apiKey,
      });
      
      if (response && response.token) {
        return {
          success: true,
          data: {
            token: response.token,
            id: response.id,
            phone: response.phone || phone,
            f_name: response.f_name,
            l_name: response.l_name,
          },
        };
      }
      
      return {
        success: false,
        message: 'Auto-login failed',
      };
    } catch (error) {
      this.logger.error(`❌ Auto-login failed: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Auto-register new user from WhatsApp/Telegram
   * Creates a minimal user account with just phone number
   * User can complete profile later
   */
  async autoRegister(data: {
    phone: string;
    channel: string;
    f_name?: string;
    l_name?: string;
  }): Promise<{
    success: boolean;
    data?: {
      token: string;
      id: number;
      phone: string;
    };
    message?: string;
  }> {
    try {
      this.logger.log(`📝 Auto-registering user from ${data.channel}: ${data.phone}`);
      
      const response: any = await this.post('/api/v1/auth/auto-register', {
        phone: data.phone,
        channel: data.channel,
        f_name: data.f_name || 'User',
        l_name: data.l_name || '',
        platform_verified: true, // Indicates phone is verified by platform
      });
      
      if (response && response.token) {
        return {
          success: true,
          data: {
            token: response.token,
            id: response.id,
            phone: response.phone || data.phone,
          },
        };
      }
      
      return {
        success: false,
        message: 'Auto-registration failed',
      };
    } catch (error) {
      this.logger.error(`❌ Auto-register failed: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Get user wallet balance
   */
  async getWalletBalance(token: string): Promise<number> {
    try {
      // Try fetching from wallet endpoint
      const response: any = await this.authenticatedRequest('get', '/api/v1/customer/wallet/list?limit=1', token);
      
      // Check if response has balance directly
      if (response && (response.balance !== undefined || response.total_balance !== undefined)) {
        return parseFloat(response.balance || response.total_balance || 0);
      }
      
      // Sometimes it might be in the profile info, so we can fallback to that if needed
      // But for now, return 0 if not found
      return 0;
    } catch (error) {
      this.logger.warn(`Failed to fetch wallet balance: ${error.message}`);
      return 0;
    }
  }
}