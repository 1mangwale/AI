import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { PhpAuthService } from '../../php-integration/services/php-auth.service';
import { SessionService } from '../../session/session.service';
import { SessionIdentifierService } from '../../session/session-identifier.service';
import { CentralizedAuthService } from '../../auth/centralized-auth.service';
import { normalizePhoneNumber } from '../../common/utils/helpers';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';

/**
 * Auth Executor - Unified Authentication Handler
 * 
 * Handles all authentication-related actions for the auth flow:
 * - Phone number validation and normalization
 * - OTP sending and verification
 * - Profile updates (name, email)
 * 
 * This executor centralizes auth logic previously scattered across:
 * - AgentOrchestratorService.handlePhoneNumberInput()
 * - AgentOrchestratorService.handleOtpInput()
 * - ConversationService.handleOtpVerification()
 * 
 * IMPORTANT: Uses SessionIdentifierService to properly resolve phone numbers
 * from session IDs (critical for web chat where sessionId != phoneNumber)
 */
@Injectable()
export class AuthExecutor implements ActionExecutor {
  readonly name = 'auth';
  private readonly logger = new Logger(AuthExecutor.name);

  constructor(
    private readonly phpAuthService: PhpAuthService,
    private readonly sessionService: SessionService,
    private readonly sessionIdentifierService: SessionIdentifierService,
    private readonly centralizedAuthService: CentralizedAuthService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;
    
    this.logger.log(`🔐 Auth executor: action=${action}`);

    try {
      switch (action) {
        case 'validate_phone':
          return await this.validatePhone(config, context);
        
        case 'send_otp':
          return await this.sendOtp(config, context);
        
        case 'verify_otp':
          return await this.verifyOtp(config, context);
        
        case 'validate_name':
          return await this.validateName(config, context);
        
        case 'validate_email':
          return await this.validateEmail(config, context);
        
        case 'update_profile':
          return await this.updateProfile(config, context);
        
        case 'auto_auth_by_phone':
          return await this.autoAuthByPhone(config, context);
        
        case 'link_google_oauth':
          return await this.linkGoogleOAuth(config, context);
        
        case 'extract_phone':
          return await this.extractPhone(config, context);
        
        default:
          return {
            success: false,
            error: `Unknown auth action: ${action}`,
          };
      }
    } catch (error) {
      this.logger.error(`Auth executor error: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Validate and normalize phone number
   */
  private async validatePhone(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    let input = this.resolveValue(config.input, context) as string;
    
    this.logger.log(`📱 validatePhone: config.input="${config.input}", resolved input="${input}", _user_message="${context.data._user_message}"`);
    
    if (!input) {
      this.logger.warn(`⚠️ No phone input found!`);
      return {
        success: true, // Changed to true to avoid "Unknown executor error"
        output: {
          error: 'No phone number provided',
          valid: false,
        },
        event: 'invalid',
      };
    }

    // Check for cancel commands
    if (this.isCancelCommand(input)) {
      return {
        success: true,
        output: { cancelled: true },
        event: 'cancel',
      };
    }

    // Clean and normalize phone number
    input = input.trim().replace(/[\s\-\(\)\.\,]/g, '');
    input = input.replace(/^0+/, ''); // Remove leading zeros
    
    const digitsOnly = input.replace(/\D/g, '');
    let normalizedPhone: string;

    // Normalize to +91XXXXXXXXXX format
    if (digitsOnly.length === 10) {
      normalizedPhone = '+91' + digitsOnly;
    } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
      normalizedPhone = '+' + digitsOnly;
    } else if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
      normalizedPhone = '+' + digitsOnly;
    } else {
      return {
        success: true, // Changed to true to trigger 'invalid' transition gracefully
        output: {
          error: 'Invalid phone number format. Please enter a 10-digit mobile number.',
          valid: false,
        },
        event: 'invalid',
      };
    }

    // Validate final format
    if (!/^\+\d{10,15}$/.test(normalizedPhone)) {
      return {
        success: true, // Changed to true to trigger 'invalid' transition gracefully
        output: {
          error: 'Invalid phone number format.',
          valid: false,
        },
        event: 'invalid',
      };
    }

    // Store in context
    context.data.phone_number = normalizedPhone;
    
    this.logger.log(`✅ Phone validated: ${normalizedPhone}`);

    // Phase 2: Track phone validation attempt
    const userMessage = context.data._user_message || input || '';
    if (userMessage) {
      await this.recordAuthInteraction(userMessage, 'phone_validation', true, context);
    }

    return {
      success: true,
      output: {
        phone_number: normalizedPhone,
        valid: true,
      },
      event: 'valid',
    };
  }

  /**
   * Send OTP to phone number
   */
  private async sendOtp(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const phone = this.resolveValue(config.phone, context) as string || context.data.phone_number;
    
    if (!phone) {
      return {
        success: false,
        error: 'Phone number not found in context',
        event: 'error',
      };
    }

    try {
      this.logger.log(`📤 Sending OTP to ${phone}`);
      
      const result = await this.phpAuthService.sendOtp(phone);
      
      if (result.success) {
        this.logger.log(`✅ OTP sent successfully to ${phone}`);
        return {
          success: true,
          output: {
            sent: true,
            phone: phone,
          },
          event: 'success', // Match flow transition
        };
      } else {
        this.logger.warn(`❌ OTP send failed: ${result.message}`);
        return {
          success: false,
          error: result.message || 'Failed to send OTP',
          event: 'error',
        };
      }
    } catch (error) {
      this.logger.error(`❌ OTP send error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Verify OTP
   */
  private async verifyOtp(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const phone = this.resolveValue(config.phone, context) as string || context.data.phone_number;
    let otp = this.resolveValue(config.otp, context) as string;
    
    if (!phone) {
      return {
        success: false,
        error: 'Phone number not found',
        event: 'error',
      };
    }

    if (!otp) {
      return {
        success: false,
        error: 'OTP not provided',
        event: 'invalid',
      };
    }

    // Check for cancel/resend commands
    otp = otp.trim().toLowerCase();
    
    if (this.isCancelCommand(otp)) {
      return {
        success: true,
        output: { cancelled: true },
        event: 'cancel',
      };
    }
    
    if (otp === 'resend' || otp === 'send again' || otp === 'new otp') {
      return {
        success: true,
        output: { resend: true },
        event: 'resend',
      };
    }

    // Validate OTP format (6 digits)
    if (!/^\d{6}$/.test(otp)) {
      return {
        success: true, // Changed to true to avoid "Unknown executor error"
        output: {
          error: 'Please enter a valid 6-digit OTP code.',
          valid: false,
        },
        event: 'invalid',
      };
    }

    try {
      this.logger.log(`🔍 Verifying OTP for ${phone}`);
      
      const result = await this.phpAuthService.verifyOtp(phone, otp);
      
      // Check if phone was verified (is_phone_verified: 1)
      // Token may be null if user needs to complete profile (is_personal_info: 0)
      const isPhoneVerified = result.success && result.data?.is_phone_verified === 1;
      const hasToken = result.success && result.data?.token;
      const needsProfileInfo = result.success && result.data?.is_personal_info === 0;
      
      if (isPhoneVerified || hasToken) {
        this.logger.log(`✅ OTP verified for ${phone} (token=${hasToken ? 'YES' : 'NO'}, needsProfile=${needsProfileInfo})`);
        
        // Phase 2: Track OTP verification attempt
        const userMessage = context.data._user_message || otp || '';
        if (userMessage) {
          await this.recordAuthInteraction(userMessage, 'otp_verification', true, context);
        }
        
        // Fetch user profile only if we have a token
        let userProfile: any = null;
        if (hasToken) {
          try {
            userProfile = await this.phpAuthService.getUserProfile(result.data.token);
          } catch (e) {
            this.logger.warn(`Could not fetch profile: ${e.message}`);
          }
        }
        
        // Store auth data in context
        context.data.auth_token = result.data?.token || null;
        context.data.phone_verified = true;  // Phone is verified even without token
        context.data.authenticated = hasToken ? true : false;  // Only fully authenticated with token
        context.data.is_personal_info = result.data?.is_personal_info ?? 0;
        context.data.needs_profile = needsProfileInfo;

        // If we couldn't fetch a profile (e.g., mock tokens), still populate basics from verifyOtp payload.
        // This prevents auth flow from incorrectly forcing profile completion for existing users.
        if (!userProfile) {
          const firstName = (result.data as any)?.f_name;
          const lastName = (result.data as any)?.l_name;
          const email = (result.data as any)?.email;
          const userId = (result.data as any)?.id;

          const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
          if (fullName) {
            context.data.user_name = fullName;
          }
          if (email) {
            context.data.user_email = email;
          }
          if (userId) {
            context.data.user_id = userId;
          }
        }
        
        if (userProfile) {
          context.data.user_id = userProfile.id;
          context.data.user_name = userProfile.firstName;
          context.data.user_email = userProfile.email;
        }

        // 🔐 CRITICAL: Link verified phone to session using SessionIdentifierService
        // This properly links web sessions (e.g., "web-abc123") to real phone numbers
        const sessionId = context._system.sessionId;
        await this.sessionIdentifierService.linkPhoneToSession(sessionId, phone);
        
        // Also update session with full auth data
        await this.sessionService.saveSession(sessionId, {
          data: {
            auth_token: result.data?.token || null,
            user_id: userProfile?.id ?? context.data.user_id,
            user_name: userProfile?.firstName ?? context.data.user_name,
            user_phone: phone, // Store the verified phone number
            phone_number: phone, // Also store as phone_number for compatibility
            phone_verified: true,
            authenticated: hasToken ? true : false,
            needs_profile: needsProfileInfo,
          },
        });
        
        this.logger.log(`🔗 Session ${sessionId} linked to verified phone ${phone}`);

        // 📊 CRITICAL: Sync to PostgreSQL and enrich profile with order history
        // This triggers profile building from MySQL order history for personalization
        // Only sync if we have a token and user profile
        if (hasToken && userProfile) {
          this.centralizedAuthService.authenticateUser(
            phone,
            result.data.token,
            {
              userId: userProfile.id,
              firstName: userProfile.firstName,
              lastName: userProfile.lastName,
              email: userProfile.email,
            },
            'web',
          ).then(() => {
            this.logger.log(`✅ User ${userProfile.firstName} synced to PostgreSQL with profile enrichment`);
          }).catch(err => {
            this.logger.error(`Failed to sync user to PostgreSQL: ${err.message}`);
          });
        }

        // Determine the appropriate event based on authentication status
        // 'valid' = fully authenticated with token
        // 'needs_profile' = OTP verified but needs profile info to complete registration
        const eventType = needsProfileInfo && !hasToken ? 'needs_profile' : 'valid';

        return {
          success: true,
          output: {
            verified: true,
            token: result.data?.token || null,
            user: userProfile,
            is_personal_info: result.data?.is_personal_info ?? 0,
            needs_profile: needsProfileInfo,
          },
          event: eventType, // 'valid' or 'needs_profile' based on auth status
        };
      } else {
        this.logger.warn(`❌ OTP verification failed: ${result.message}`);
        
        // Phase 2: Track OTP verification failure
        const userMessage = context.data._user_message || otp || '';
        if (userMessage) {
          await this.recordAuthInteraction(userMessage, 'otp_verification', false, context);
        }
        
        return {
          success: true, // Changed to true to allow flow to handle the error
          output: {
            error: result.message || 'Invalid OTP',
            valid: false,
          },
          event: 'invalid', // Match flow transition
        };
      }
    } catch (error) {
      this.logger.error(`❌ OTP verification error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        event: 'otp_invalid',
      };
    }
  }

  /**
   * Validate name input
   */
  private async validateName(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    let input = this.resolveValue(config.input, context) as string;
    
    if (!input) {
      return {
        success: false,
        error: 'No name provided',
        event: 'invalid',
      };
    }

    // Check for cancel/skip commands
    if (this.isCancelCommand(input) || input.toLowerCase() === 'skip') {
      return {
        success: true,
        output: { skipped: true },
        event: 'cancel',
      };
    }

    const name = input.trim();

    // 🔧 FIX (2026-08-01): navigation/order text is not a name — "browse menu"
    // was captured as user_name ("Great browse menu!"). Don't capture it, but
    // let the flow proceed rather than re-asking in a loop.
    const notAName = /\b(menu|order|browse|cart|checkout|food|parcel|track|search|deliver|show|khana|misal|pizza|burger|thali)\b/i;
    if (notAName.test(name) || name.split(/\s+/).length > 4) {
      this.logger.log(`⏭️ Input "${name}" looks like a command, not a name — proceeding without capturing`);
      return {
        success: true,
        output: { skipped: true, reason: 'not_a_name' },
        event: 'valid',
      };
    }

    // Validate name (at least 2 characters, only letters and spaces)
    if (name.length < 2) {
      return {
        success: false,
        output: {
          error: 'Please enter a valid name (at least 2 characters).',
        },
        event: 'invalid',
      };
    }

    // Store in context
    context.data.user_name = name;
    
    this.logger.log(`✅ Name validated: ${name}`);

    return {
      success: true,
      output: {
        name: name,
        valid: true,
      },
      event: 'valid',
    };
  }

  /**
   * Validate email input
   */
  private async validateEmail(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    let input = this.resolveValue(config.input, context) as string;
    
    if (!input) {
      return {
        success: false,
        error: 'No email provided',
        event: 'invalid',
      };
    }

    // Check for cancel/skip commands
    if (this.isCancelCommand(input) || input.toLowerCase() === 'skip') {
      return {
        success: true,
        output: { skipped: true },
        event: 'skip',
      };
    }

    const email = input.trim().toLowerCase();
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return {
        success: false,
        output: {
          error: 'Please enter a valid email address (e.g., yourname@gmail.com).',
        },
        event: 'invalid',
      };
    }

    // Store in context
    context.data.user_email = email;
    
    this.logger.log(`✅ Email validated: ${email}`);

    return {
      success: true,
      output: {
        email: email,
        valid: true,
      },
      event: 'valid',
    };
  }

  /**
   * Update user profile
   */
  private async updateProfile(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const name = this.resolveValue(config.name, context) as string || context.data.user_name;
    const email = this.resolveValue(config.email, context) as string || context.data.user_email;
    const phone = context.data.phone_number;
    const token = context.data.auth_token;

    if (!phone || !token) {
      return {
        success: false,
        error: 'Missing phone or auth token',
        event: 'error',
      };
    }

    if (!name || !email) {
      this.logger.warn('Missing name or email for profile update');
      return {
        success: true, // Don't fail, just skip
        output: { skipped: true },
        event: 'success',
      };
    }

    try {
      this.logger.log(`📝 Updating profile for ${phone}: name=${name}, email=${email}`);
      
      const result = await this.phpAuthService.updateUserInfo(phone, name, email);
      
      if (result.success) {
        // Update token if new one was provided
        if (result.token) {
          context.data.auth_token = result.token;
        }

        // Fetch updated profile
        const userProfile = await this.phpAuthService.getUserProfile(
          result.token || token
        );

        if (userProfile) {
          context.data.user_id = userProfile.id;
          context.data.user_name = userProfile.firstName;
          context.data.user_email = userProfile.email;
        }

        // Update session - IMPORTANT: Store phone_number for order placement
        const sessionId = context._system.sessionId;
        await this.sessionService.saveSession(sessionId, {
          data: {
            auth_token: result.token || token,
            user_id: userProfile?.id,
            user_name: userProfile?.firstName,
            user_phone: phone, // Store the verified phone number
            phone_number: phone, // Also store as phone_number for compatibility
            authenticated: true,
          },
        });

        this.logger.log(`✅ Profile updated for ${phone}`);

        return {
          success: true,
          output: {
            updated: true,
            user: userProfile,
          },
          event: 'success',
        };
      } else {
        throw new Error(result.message || 'Update failed');
      }
    } catch (error) {
      this.logger.error(`❌ Profile update error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/;
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  /**
   * Phase 2: Record auth interaction for training
   */
  private async recordAuthInteraction(userMessage: string, actionType: string, success: boolean, context: FlowContext): Promise<void> {
    try {
      const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
        conversation_history: context.data._conversation_history || [],
        flow_stage: `auth_${actionType}`,
      });

      await this.advancedLearning.recordTrainingData({
        message: userMessage,
        questionType: actionType,
        actualClassification: success,
        predictedClassification: success,
        confidence: success ? 0.9 : 0.4,
        flowContext: 'authentication',
        language: this.detectLanguage(userMessage),
        userId: context._system?.userId || 'unknown',
        sessionId: context._system?.sessionId || 'unknown',
      });

      if (!success && sentiment.frustration_score > 0.6) {
        this.logger.log(`😤 Auth frustration: ${actionType} failed, frustration: ${sentiment.frustration_score.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.warn(`Phase 2 auth tracking failed: ${error.message}`);
    }
  }

  /**
   * Check if input is a cancel command
   */
  private isCancelCommand(input: string): boolean {
    const cancelCommands = ['cancel', 'stop', 'quit', 'exit', 'no', 'nevermind'];
    return cancelCommands.includes(input.toLowerCase().trim());
  }

  /**
   * Resolve template value from context
   */
  private resolveValue(value: any, context: FlowContext): any {
    if (typeof value !== 'string') return value;
    
    // Handle {{variable}} syntax
    const match = value.match(/^\{\{(.+?)\}\}$/);
    if (match) {
      const path = match[1].trim();
      
      // Special case for _user_message
      if (path === '_user_message') {
        return context.data._user_message;
      }
      
      // First try direct path in context.data
      const directValue = path.split('.').reduce(
        (obj, key) => obj?.[key],
        context.data
      );
      
      if (directValue !== undefined) {
        return directValue;
      }
      
      // Also check in _session (where session executor stores data)
      if (context.data._session) {
        const sessionValue = path.split('.').reduce(
          (obj, key) => obj?.[key],
          context.data._session
        );
        if (sessionValue !== undefined) {
          return sessionValue;
        }
      }
      
      return undefined;
    }
    
    return value;
  }

  /**
   * Auto-authenticate user by phone number
   * Used for WhatsApp/Telegram where phone is already verified by the platform
   * 
   * For WhatsApp: The user's phone number IS their identity, verified by Meta
   * For Telegram: The user's phone (if shared) is verified by Telegram
   * 
   * Flow:
   * 1. Get phone from session (session ID is the phone for these platforms)
   * 2. Check if user exists in PHP backend
   * 3. If exists: auto-login and get token
   * 4. If not: auto-register with phone, then login
   * 5. Store auth data in session context
   */
  private async autoAuthByPhone(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const sessionId = context._system?.sessionId;
    const platform = context.data.platform || 'unknown';
    
    this.logger.log(`🔐 Auto-auth by phone: sessionId=${sessionId}, platform=${platform}`);
    
    // For WhatsApp/Telegram, the session ID IS the phone number
    const isPhoneBasedPlatform = platform === 'whatsapp' || platform === 'telegram';
    
    // Get phone number from session
    let phone = context.data.phone_number || context.data.phone;
    
    if (!phone && isPhoneBasedPlatform && sessionId) {
      // For WhatsApp/Telegram, session ID is the phone number
      phone = normalizePhoneNumber(sessionId);
      this.logger.log(`📱 Using session ID as phone: ${phone}`);
    }
    
    if (!phone) {
      this.logger.warn(`⚠️ No phone number found for auto-auth`);
      return {
        success: false,
        error: 'No phone number available for auto-authentication',
        event: 'auth_failed',
      };
    }
    
    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    this.logger.log(`📱 Attempting auto-auth for: ${normalizedPhone}`);
    
    try {
      // Step 1: Check if user exists in PHP backend
      const existingUser = await this.phpAuthService.checkUserExists(normalizedPhone);
      
      if (existingUser.exists && existingUser.data) {
        // User exists - use their info
        this.logger.log(`✅ Existing user found: ${existingUser.data.id}`);
        
        // Get auth token (generate one or use existing session)
        const authResult = await this.phpAuthService.autoLogin(normalizedPhone);
        
        if (authResult.success && authResult.data) {
          // Store auth in context
          context.data.authenticated = true;
          context.data.auth_token = authResult.data.token;
          context.data.user_id = authResult.data.id;
          context.data.user_name = `${authResult.data.f_name || ''} ${authResult.data.l_name || ''}`.trim();
          context.data.phone = normalizedPhone;
          
          // Update session with auth data
          await this.sessionService.setData(sessionId, {
            authenticated: true,
            auth_token: authResult.data.token,
            user_id: authResult.data.id,
            user_name: context.data.user_name,
            phone: normalizedPhone,
          });
          
          // Link phone to session for future lookups
          await this.sessionIdentifierService.linkPhoneToSession(sessionId, normalizedPhone);
          
          this.logger.log(`✅ Auto-auth successful for ${normalizedPhone} (user_id: ${authResult.data.id})`);
          
          return {
            success: true,
            output: {
              authenticated: true,
              user_id: authResult.data.id,
              user_name: context.data.user_name,
              phone: normalizedPhone,
              is_new_user: false,
            },
            event: 'authenticated',
          };
        }
      }
      
      // User doesn't exist - register them. This used to call autoRegister,
      // which POSTs /api/v1/auth/auto-register - a route that does not exist
      // in Laravel (grep routes/: platform-login is there, auto-register is
      // not), so every brand-new customer 404'd here and fell straight through
      // to "Auto-authentication failed". Existing users never saw it: they take
      // the checkUserExists -> autoLogin branch above.
      //
      // platform-login upserts: CustomerAuthController@platformLogin looks the
      // phone up three ways and, finding nothing, User::create()s it with
      // is_phone_verified=1, generates a ref_code and records DPDP consent
      // (CustomerAuthController.php:1717-1732). Its validator is
      // in:whatsapp,telegram - exactly isPhoneBasedPlatform.
      if (isPhoneBasedPlatform) {
        this.logger.log(`📝 Registering new user via platform-login: ${normalizedPhone}`);

        const registerResult = await this.phpAuthService.autoLogin(
          normalizedPhone,
          platform as 'whatsapp' | 'telegram',
        );
        
        if (registerResult.success && registerResult.data) {
          // Store auth in context
          context.data.authenticated = true;
          context.data.auth_token = registerResult.data.token;
          context.data.user_id = registerResult.data.id;
          context.data.phone = normalizedPhone;
          context.data.is_new_user = true;  // Mark as new user for onboarding
          
          // Update session - include is_new_user flag for onboarding trigger
          await this.sessionService.setData(sessionId, {
            authenticated: true,
            auth_token: registerResult.data.token,
            user_id: registerResult.data.id,
            phone: normalizedPhone,
            is_new_user: true,  // This triggers first-time onboarding flow
          });
          
          await this.sessionIdentifierService.linkPhoneToSession(sessionId, normalizedPhone);
          
          this.logger.log(`✅ Registered and authenticated via platform-login (NEW USER): ${normalizedPhone}`);
          
          return {
            success: true,
            output: {
              authenticated: true,
              user_id: registerResult.data.id,
              phone: normalizedPhone,
              is_new_user: true,
            },
            event: 'authenticated',
          };
        }
      }
      
      // Auth failed
      this.logger.warn(`❌ Auto-auth failed for ${normalizedPhone}`);
      return {
        success: false,
        error: 'Auto-authentication failed',
        event: 'auth_failed',
      };
      
    } catch (error) {
      this.logger.error(`❌ Auto-auth error: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'auth_failed',
      };
    }
  }

  /**
   * Extract phone number from user message
   * Used for Google OAuth users who need to provide phone
   */
  private async extractPhone(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const userMessage = context.data._user_message || '';
    const field = config.field || 'phone_number';
    
    this.logger.log(`📱 Extracting phone from: "${userMessage}"`);
    
    // Extract phone number using regex
    const phoneMatch = userMessage.match(/(?:\+91|91|0)?[\s-]?([6-9]\d{9})/);
    
    if (phoneMatch) {
      const rawPhone = phoneMatch[1] || phoneMatch[0];
      const normalized = normalizePhoneNumber(rawPhone);
      
      if (normalized) {
        this.logger.log(`✅ Phone extracted: ${normalized}`);
        
        // Store in context
        context.data[field] = normalized;
        context.data.phone_number = normalized;
        
        // Also update session
        const sessionId = context._system.sessionId;
        await this.sessionService.setData(sessionId, {
          phone: normalized,
          phone_number: normalized,
        });
        
        return {
          success: true,
          output: { phone: normalized },
          event: 'phone_extracted',
        };
      }
    }
    
    // No valid phone found
    this.logger.warn(`⚠️ No valid phone in: "${userMessage}"`);
    return {
      success: false,
      output: { message: config.prompt_on_invalid || 'Please enter a valid 10-digit phone number:' },
      event: 'invalid_phone',
    };
  }

  /**
   * Link Google OAuth user to PHP account by creating/updating with phone number
   * This creates the PHP user account so they can have saved addresses, order history, etc.
   */
  private async linkGoogleOAuth(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const sessionId = context._system.sessionId;
    const session = await this.sessionService.getSession(sessionId);
    const sessionData = session?.data || {};
    
    // Get Google OAuth data from session
    const email = sessionData.email || context.data.email;
    const userName = sessionData.user_name || context.data.user_name;
    const phone = sessionData.phone || context.data.phone_number;
    
    this.logger.log(`🔗 Linking Google OAuth to PHP: email=${email}, name=${userName}, phone=${phone}`);
    
    if (!phone) {
      this.logger.warn(`⚠️ No phone number for PHP account linking`);
      return {
        success: false,
        error: 'Phone number required for account linking',
        event: 'link_failed',
      };
    }
    
    // Even if email/name are missing, we can still proceed with phone
    // The user can complete their profile later
    
    try {
      // 🔧 FIX: Use platform-login API first - it can create or find users by phone
      // This is more reliable than update-info which only updates existing users
      // Note: Using 'whatsapp' as platform type since PHP API only accepts whatsapp/telegram
      const autoLoginResult = await this.phpAuthService.autoLogin(phone, 'whatsapp');
      
      if (autoLoginResult.success && autoLoginResult.data?.token) {
        this.logger.log(`✅ PHP account linked via platform-login! user_id=${autoLoginResult.data.id}`);
        
        // Update session with PHP auth data
        await this.sessionService.setData(sessionId, {
          auth_token: autoLoginResult.data.token,
          user_id: autoLoginResult.data.id,
          phone: phone,
          phone_number: phone,
          authenticated: true,
          php_linked: true,
        });
        
        // Update context
        context.data.auth_token = autoLoginResult.data.token;
        context.data.user_id = autoLoginResult.data.id;
        context.data.phone_number = phone;
        context.data.php_linked = true;
        
        return {
          success: true,
          output: {
            token: autoLoginResult.data.token,
            user_id: autoLoginResult.data.id,
            phone: phone,
          },
          event: 'account_linked',
        };
      }
      
      // Fallback: Try update-info API (for users who need name/email update)
      if (email && userName) {
        const result = await this.phpAuthService.updateUserInfo(
          phone,
          userName,
          email
        );
        
        if (result.success && result.token) {
          this.logger.log(`✅ PHP account linked via update-info! Token received`);
          
          // Get user profile to get user_id
          const userProfile = await this.phpAuthService.getUserProfile(result.token);
          
          // Update session with PHP auth data
          await this.sessionService.setData(sessionId, {
            auth_token: result.token,
            user_id: userProfile?.id,
            phone: phone,
            phone_number: phone,
            authenticated: true,
            php_linked: true,
          });
          
          // Update context
          context.data.auth_token = result.token;
          context.data.user_id = userProfile?.id;
          context.data.phone_number = phone;
          context.data.php_linked = true;
          
          return {
            success: true,
            output: {
              token: result.token,
              user_id: userProfile?.id,
              phone: phone,
            },
            event: 'account_linked',
          };
        }
      }
      
      // 🔧 FIX: If we get here, PHP linking failed but we should still store phone
      // This allows "Use my details" to work with the phone user provided
      this.logger.warn(`⚠️ PHP account linking failed, storing phone for manual flow`);
      await this.sessionService.setData(sessionId, {
        phone: phone,
        phone_number: phone,
        authenticated: true,
        php_linked: false,
      });
      context.data.phone_number = phone;
      
      // Continue anyway - user can still enter addresses manually
      return {
        success: true,
        output: { partial_link: true, phone: phone },
        event: 'account_linked',
      };
    } catch (error) {
      this.logger.error(`❌ PHP account linking error: ${error.message}`);
      
      // 🔧 FIX: Still store phone in session even on error
      const phone = context.data.phone_number;
      if (phone) {
        await this.sessionService.setData(sessionId, {
          phone: phone,
          phone_number: phone,
          authenticated: true,
          php_linked: false,
        });
      }
      
      // Continue anyway - don't block the flow
      return {
        success: true,
        output: { error: error.message, partial_link: true, phone: phone },
        event: 'account_linked',
      };
    }
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
