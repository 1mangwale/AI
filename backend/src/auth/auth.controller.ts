import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Logger,
  UnauthorizedException,
  BadRequestException,
  Res,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { PhpAuthService } from '../php-integration/services/php-auth.service';
import { CentralizedAuthService } from './centralized-auth.service';
import { normalizePhoneNumber } from '../common/utils/helpers';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

// Helper to decode JWT without verification (for extracting payload)
function decodeJwt(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Auth Controller - API Gateway for Authentication
 * 
 * Proxies auth requests to PHP backend with proper normalization
 * Handles OTP send, verify, and user profile management
 * 
 * PHP Auth Flow:
 * 1. Send OTP: POST /api/v1/auth/login { login_type: 'otp', phone: '+91...' }
 * 2. Verify OTP: POST /api/v1/auth/login { login_type: 'otp', phone: '+91...', otp: '123456', verified: true }
 * 3. Update Info: POST /api/v1/auth/update-info { login_type: 'otp', phone: '+91...', name: '...', email: '...' }
 */
@Controller('v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly isProduction: boolean;
  private readonly cookieDomain: string | undefined;

  constructor(
    private readonly phpAuth: PhpAuthService,
    private readonly centralizedAuth: CentralizedAuthService,
    private readonly httpService: HttpService,
  ) {
    this.isProduction = process.env.NODE_ENV === 'production';
    this.cookieDomain = process.env.COOKIE_DOMAIN || undefined;
  }

  /** Set HttpOnly auth cookie (dual mode — cookie + JSON token for non-browser clients) */
  private setAuthCookie(res: Response, token: string): void {
    res.cookie('mangwale_token', token, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
      ...(this.cookieDomain ? { domain: this.cookieDomain } : {}),
    });
  }

  /** Clear auth cookie */
  private clearAuthCookie(res: Response): void {
    res.clearCookie('mangwale_token', {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/',
      ...(this.cookieDomain ? { domain: this.cookieDomain } : {}),
    });
  }

  /**
   * Send OTP to phone number
   * POST /v1/auth/send-otp
   * Body: { phone: '9923383838' }
   * 
   * Normalizes phone to +91 format and calls PHP backend
   */
  @Post('send-otp')
  @Throttle({ short: { limit: 3, ttl: 60000 }, medium: { limit: 5, ttl: 60000 }, long: { limit: 10, ttl: 300000 } })
  async sendOtp(@Body() body: { phone: string }) {
    const { phone } = body;
    
    if (!phone) {
      throw new BadRequestException('Phone number is required');
    }

    this.logger.log(`📱 Send OTP request for: ${phone}`);

    // Normalize phone number (handles with/without +91, 10 digit, etc.)
    const normalizedPhone = normalizePhoneNumber(phone);
    
    if (!normalizedPhone) {
      throw new BadRequestException('Invalid phone number format');
    }

    this.logger.log(`📱 Normalized phone: ${normalizedPhone}`);

    const result = await this.phpAuth.sendOtp(normalizedPhone);

    if (!result.success) {
      this.logger.warn(`❌ OTP send failed: ${result.message}`);
      throw new BadRequestException(result.message || 'Failed to send OTP');
    }

    this.logger.log(`✅ OTP sent to ${normalizedPhone}`);
    
    return {
      success: true,
      message: 'OTP sent successfully',
    };
  }

  /**
   * Verify OTP and get auth token
   * POST /v1/auth/verify-otp
   * Body: { phone: '9923383838', otp: '123456' }
   * 
   * Returns: { success, token, is_personal_info, user: { ... } }
   */
  @Post('verify-otp')
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 10, ttl: 60000 }, long: { limit: 20, ttl: 300000 } })
  async verifyOtp(
    @Body() body: { phone: string; otp: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { phone, otp } = body;

    if (!phone || !otp) {
      throw new BadRequestException('Phone and OTP are required');
    }

    this.logger.log(`🔐 Verify OTP request for: ${phone}`);

    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    
    if (!normalizedPhone) {
      throw new BadRequestException('Invalid phone number format');
    }

    const result = await this.phpAuth.verifyOtp(normalizedPhone, otp);

    if (!result.success) {
      this.logger.warn(`❌ OTP verification failed: ${result.message}`);
      throw new UnauthorizedException(result.message || 'Invalid OTP');
    }

    this.logger.log(`✅ OTP verified for ${normalizedPhone}`);
    this.logger.debug(`📦 Response data: ${JSON.stringify(result.data)}`);

    // Extract user data from PHP response (type as any to access PHP response fields)
    const phpData: any = result.data || {};
    
    // is_personal_info at root level for frontend compatibility
    // 0 = new user needs to complete registration
    // 1 = existing user with complete profile
    const isPersonalInfo = phpData.is_personal_info ?? 0;
    
    // Fetch full user profile if we have a token and user is existing (is_personal_info=1)
    let userProfile: any = null;
    if (phpData.token && isPersonalInfo === 1) {
      try {
        this.logger.log(`📋 Fetching user profile for existing user...`);
        userProfile = await this.phpAuth.getUserProfile(phpData.token);
        this.logger.log(`👤 User profile fetched: ${JSON.stringify(userProfile)}`);
      } catch (profileError) {
        this.logger.warn(`⚠️ Could not fetch user profile: ${profileError.message}`);
      }
    }
    
    // Sync user to PostgreSQL for enhanced profile features
    // This creates/updates the user record in PostgreSQL users table
    try {
      const userId = userProfile?.id || phpData.id;
      if (userId) {
        await this.centralizedAuth.syncUserToPostgres(
          normalizedPhone,
          {
            userId: parseInt(userId),
            firstName: userProfile?.firstName || phpData.f_name || '',
            lastName: userProfile?.lastName || phpData.l_name || '',
            email: userProfile?.email || phpData.email || '',
          },
          'web', // default channel for web OTP login
        );
        this.logger.log(`✅ User synced to PostgreSQL: ${userId}`);
      }
    } catch (syncError) {
      this.logger.error(`⚠️ PostgreSQL sync failed: ${syncError.message}`);
      // Don't fail auth if sync fails - it's not critical for login
    }
    
    // Set HttpOnly cookie (browsers use this; non-browser clients use JSON token)
    if (phpData.token) {
      this.setAuthCookie(res, phpData.token);
    }

    return {
      success: true,
      token: phpData.token || null,
      is_personal_info: isPersonalInfo,
      user: {
        id: userProfile?.id || phpData.id,
        phone: normalizedPhone,
        f_name: userProfile?.firstName || phpData.f_name || '',
        l_name: userProfile?.lastName || phpData.l_name || '',
        email: userProfile?.email || phpData.email || '',
        is_personal_info: isPersonalInfo,
        is_phone_verified: userProfile?.isPhoneVerified ? 1 : (phpData.is_phone_verified ?? 1),
        is_email_verified: userProfile?.isEmailVerified ? 1 : (phpData.is_email_verified ?? 0),
      },
    };
  }

  /**
   * Update user profile (for new user registration)
   * POST /v1/auth/update-info
   * Body: { phone: '9923383838', f_name: 'John', l_name: 'Doe', email: 'john@example.com' }
   * 
   * Returns: { token, user }
   */
  @Post('update-info')
  async updateUserInfo(
    @Body() body: { phone: string; f_name: string; l_name?: string; email: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { phone, f_name, l_name, email } = body;

    if (!phone || !f_name || !email) {
      throw new BadRequestException('Phone, first name, and email are required');
    }

    this.logger.log(`📝 Update user info for: ${phone}`);

    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    
    if (!normalizedPhone) {
      throw new BadRequestException('Invalid phone number format');
    }

    // Combine first and last name for PHP (PHP expects single 'name' field)
    const fullName = l_name ? `${f_name} ${l_name}` : f_name;

    const result = await this.phpAuth.updateUserInfo(normalizedPhone, fullName, email);

    if (!result.success) {
      this.logger.warn(`❌ Update info failed: ${result.message}`);
      throw new BadRequestException(result.message || 'Failed to update info');
    }

    this.logger.log(`✅ User info updated for ${normalizedPhone}`);

    // Fetch user profile to get the ID
    let userId: number | undefined;
    if (result.token) {
      try {
        const userProfile = await this.phpAuth.getUserProfile(result.token);
        if (userProfile) {
          userId = userProfile.id;
          this.logger.log(`✅ Got user ID: ${userId}`);
        }
      } catch (err) {
        this.logger.warn(`⚠️ Could not fetch user profile after update: ${err.message}`);
      }
    }

    if (result.token) {
      this.setAuthCookie(res, result.token);
    }

    return {
      success: true,
      token: result.token,
      user: {
        id: userId,
        phone: normalizedPhone,
        f_name,
        l_name: l_name || '',
        email,
        is_personal_info: 1,
      },
    };
  }

  /**
   * Get user profile
   * GET /v1/auth/profile
   * Requires: Authorization header with Bearer token
   */
  @Get('profile')
  async getProfile(
    @Headers('authorization') authHeader: string,
    @Req() req: any,
  ) {
    let token: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies?.mangwale_token) {
      token = req.cookies.mangwale_token;
    }

    if (!token) {
      throw new UnauthorizedException('Authorization token required');
    }
    
    this.logger.log(`👤 Get profile request`);

    const user = await this.phpAuth.getUserProfile(token);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    this.logger.log(`✅ Profile retrieved for user ${user.id}`);

    return {
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        f_name: user.firstName,
        l_name: user.lastName || '',
        email: user.email,
        image: user.image || null,
      },
    };
  }

  /**
   * Login with email/password
   * POST /v1/auth/login
   * Body: { phone: 'email@example.com' or '9923383838', password: 'Hello@1506' }
   * 
   * PHP expects:
   * { email_or_phone, password, login_type: 'manual', field_type: 'email' | 'phone' }
   */
  @Post('login')
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 10, ttl: 60000 }, long: { limit: 20, ttl: 300000 } })
  async login(
    @Body() body: { phone: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { phone, password } = body;

    if (!phone || !password) {
      throw new BadRequestException('Email/phone and password are required');
    }

    this.logger.log(`🔐 Password login request for: ${phone}`);

    // Check if it's email or phone
    const isEmail = phone.includes('@');
    const fieldType = isEmail ? 'email' : 'phone';
    
    // Normalize phone if needed
    let emailOrPhone = phone;
    if (!isEmail) {
      const normalized = normalizePhoneNumber(phone);
      if (!normalized) {
        throw new BadRequestException('Invalid phone number format');
      }
      emailOrPhone = normalized;
    }

    try {
      // Call PHP backend for password login
      const phpData = await this.phpAuth.loginWithPassword(emailOrPhone, password, fieldType);
      
      this.logger.log(`✅ Password login successful for ${phone}`);

      if (phpData.token) {
        this.setAuthCookie(res, phpData.token);
      }

      return {
        success: true,
        token: phpData.token,
        is_personal_info: phpData.is_personal_info ?? 1,
        user: {
          id: phpData.id,
          phone: phpData.phone || (isEmail ? '' : emailOrPhone),
          email: phpData.email || (isEmail ? phone : ''),
          f_name: phpData.f_name || '',
          l_name: phpData.l_name || '',
          is_personal_info: phpData.is_personal_info ?? 1,
          is_phone_verified: phpData.is_phone_verified ?? 1,
          is_email_verified: phpData.is_email_verified ?? 1,
        },
      };
    } catch (error) {
      this.logger.warn(`❌ Password login failed: ${error.message}`);
      throw new UnauthorizedException(error.message || 'Invalid credentials');
    }
  }

  /**
   * Social login (Google, Facebook, Apple)
   * POST /v1/auth/social-login
   * Body: { token: 'google-id-token', unique_id: '...', email: '...', medium: 'google' }
   * 
   * For Google: Token is a JWT ID token from Google Identity Services
   * We decode it, verify with Google's tokeninfo API, then create/login user in PHP
   */
  @Post('social-login')
  async socialLogin(
    @Body() body: { token: string; unique_id: string; email: string; medium: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    let { token, unique_id, email, medium } = body;

    if (!token || !medium) {
      throw new BadRequestException('Token and medium are required');
    }

    // Validate medium
    const validMediums = ['google', 'facebook', 'apple'];
    if (!validMediums.includes(medium)) {
      throw new BadRequestException(`Invalid medium. Must be one of: ${validMediums.join(', ')}`);
    }

    this.logger.log(`🔐 Social login via ${medium} for: ${email || unique_id}`);

    // For Google: The token from Google Identity Services is a JWT ID token
    // We need to verify it with Google and extract user info
    if (medium === 'google') {
      try {
        // Decode the JWT to extract claims
        const decoded = decodeJwt(token);
        
        if (decoded) {
          this.logger.log(`📋 Decoded Google JWT: sub=${decoded.sub}, email=${decoded.email}`);
          
          // Verify with Google's tokeninfo endpoint
          const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`;
          const verifyResponse = await firstValueFrom(
            this.httpService.get(verifyUrl)
          ).catch(err => {
            this.logger.warn(`⚠️ Google token verification failed: ${err.message}`);
            return null;
          });

          if (verifyResponse?.data) {
            const googleUser = verifyResponse.data;
            this.logger.log(`✅ Google token verified: email=${googleUser.email}, sub=${googleUser.sub}`);
            
            // Update the fields from verified token
            email = googleUser.email || decoded.email || email;
            unique_id = googleUser.sub || decoded.sub || unique_id;
            
            // Strategy: Look up existing PHP user by email, then autoLogin.
            // This avoids sending the Google ID token to PHP's social-login endpoint
            // which incorrectly tries to use it as an access token.
            const existingUser = await this.phpAuth.checkUserExistsByEmail(email);
            
            if (existingUser.exists && existingUser.data?.phone) {
              this.logger.log(`✅ Found existing PHP user by email: id=${existingUser.data.id}, phone=${existingUser.data.phone}`);
              
              // Auto-login via PHP platform-login (trusted server-side call)
              // Use 'whatsapp' platform for autoLogin (trusted server-side call, platform is just for PHP API key)
              const loginResult = await this.phpAuth.autoLogin(existingUser.data.phone);
              
              if (loginResult.success && loginResult.data) {
                this.logger.log(`✅ Google OAuth auto-login successful for existing user ${existingUser.data.id}`);
                if (loginResult.data.token) {
                  this.setAuthCookie(res, loginResult.data.token);
                }
                return {
                  success: true,
                  token: loginResult.data.token,
                  user: {
                    id: loginResult.data.id || existingUser.data.id,
                    phone: existingUser.data.phone,
                    email: existingUser.data.email || email,
                    f_name: loginResult.data.f_name || existingUser.data.f_name || googleUser.given_name || decoded.given_name || '',
                    l_name: loginResult.data.l_name || existingUser.data.l_name || googleUser.family_name || decoded.family_name || '',
                    is_personal_info: 1,
                    is_phone_verified: 1,
                    is_email_verified: 1,
                  },
                };
              }
              
              this.logger.warn(`⚠️ Auto-login failed for existing user, falling back to needs_phone`);
            } else {
              this.logger.log(`🆕 No PHP account found for email ${email} - user needs to register with phone`);
            }
            
            // User not in PHP yet (or auto-login failed) - frontend must collect phone + OTP
            return {
              success: true,
              token: null,
              is_personal_info: 0,
              user: {
                id: null,
                phone: null,
                email: email,
                f_name: googleUser.given_name || decoded.given_name || '',
                l_name: googleUser.family_name || decoded.family_name || '',
                is_personal_info: 0,
                is_phone_verified: 0,
                is_email_verified: 1,
              },
              google_verified: true,
              needs_phone: true,
            };
          }
        }
      } catch (err) {
        this.logger.error(`❌ Google token processing error: ${err.message}`);
      }
    }

    // For Facebook/Apple or if Google verification failed, try PHP directly
    const result = await this.phpAuth.socialLogin({
      token,
      unique_id,
      email,
      medium: medium as 'google' | 'facebook' | 'apple',
    });

    if (!result.success) {
      this.logger.warn(`❌ Social login failed: ${result.message}`);
      throw new UnauthorizedException(result.message || 'Social login failed');
    }

    const phpData = result.data;

    if (phpData.token) {
      this.setAuthCookie(res, phpData.token);
    }

    return {
      success: true,
      token: phpData.token,
      user: {
        id: phpData.id,
        phone: phpData.phone,
        email: phpData.email,
        f_name: phpData.f_name,
        l_name: phpData.l_name,
        is_personal_info: phpData.is_personal_info,
        is_phone_verified: phpData.is_phone_verified,
        is_email_verified: phpData.is_email_verified,
      },
    };
  }

  /**
   * Logout
   * POST /v1/auth/logout
   */
  @Post('logout')
  async logout(
    @Headers('authorization') authHeader: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.logger.log(`👋 Logout request`);

    this.clearAuthCookie(res);

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }
}
