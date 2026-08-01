import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { ProgressiveProfileService } from '../../personalization/progressive-profile.service';
import { SessionService } from '../../session/session.service';

/**
 * Profile Executor - Handles progressive profile questions
 * 
 * Use cases:
 * 1. Ask a profile question after successful order
 * 2. Ask contextual questions based on user activity
 * 3. Handle profile answer responses
 */
@Injectable()
export class ProfileExecutor implements ActionExecutor {
  readonly name = 'profile';
  private readonly logger = new Logger(ProfileExecutor.name);

  constructor(
    private readonly progressiveProfile: ProgressiveProfileService,
    private readonly sessionService: SessionService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;

    try {
      switch (action) {
        case 'ask_question':
          return this.askQuestion(config, context);
        case 'save_answer':
          return this.saveAnswer(config, context);
        case 'save_preference':
          return this.savePreference(config, context);
        case 'check_status':
          return this.checkStatus(context);
        case 'learn_from_order':
          return this.learnFromOrder(config, context);
        case 'copy_to_recipient':
          return this.copyToRecipient(context);
        default:
          this.logger.warn(`Unknown profile action: ${action}`);
          return { success: true, event: 'skip' };
      }
    } catch (error) {
      this.logger.error(`Profile executor error: ${error.message}`);
      return { success: true, event: 'skip' }; // Don't break flow on profile errors
    }
  }

  /**
   * Copy user's profile details to recipient_details
   */
  private async copyToRecipient(context: FlowContext): Promise<ActionExecutionResult> {
    const session = await this.sessionService.getSession(context._system.sessionId);
    
    // Get user name and phone from context or session (check all possible field names)
    const userName = context.data.user_name || context.data.userName || 
                     session?.data?.user_name || session?.data?.userName;
    const userPhone = context.data.phone || context.data.phone_number || context.data.user_phone ||
                      session?.data?.phone || session?.data?.phone_number || session?.data?.user_phone;
    
    this.logger.log(`📋 Copying user profile to recipient: name=${userName}, phone=${userPhone}`);
    this.logger.debug(`📋 Session data keys: ${Object.keys(session?.data || {}).join(', ')}`);
    
    if (!userName || !userPhone) {
      this.logger.warn('⚠️ User profile incomplete - cannot copy to recipient');
      this.logger.warn(`   Available: name=${userName}, phone=${userPhone}`);
      return { 
        success: false, 
        event: 'profile_incomplete',
        output: { error: 'Profile name or phone missing' }
      };
    }
    
    // Set recipient_details in context
    context.data.recipient_details = {
      name: userName,
      phone: userPhone,
    };
    
    this.logger.log(`✅ Recipient set: ${userName} - ${userPhone}`);
    
    return {
      success: true,
      output: {
        name: userName,
        phone: userPhone,
      },
      event: 'copied',
    };
  }

  /**
   * Ask a contextual profile question
   */
  private async askQuestion(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const questionContext = config.context || 'post_order';
    const userId = context.data.user_id;

    if (!userId) {
      this.logger.log('No user ID, skipping profile question');
      return { success: true, event: 'skip' };
    }

    const question = await this.progressiveProfile.getContextualQuestion(userId, questionContext);

    if (!question) {
      this.logger.log('No question to ask (rate limited or profile complete)');
      return { success: true, event: 'skip' };
    }

    // Format for chat
    const formatted = this.progressiveProfile.formatQuestionForChat(question);

    context.data._pending_profile_question = question.id;
    
    // Preserve any existing response (e.g. "Order Confirmed!") and append the profile question
    const existingResponse = context.data._last_response;
    if (existingResponse && typeof existingResponse === 'string' && existingResponse.trim().length > 0) {
      context.data._last_response = `${existingResponse}\n\n---\n\n${formatted.message}`;
      this.logger.log(`📝 Appending profile question to existing response`);
    } else {
      context.data._last_response = formatted.message;
    }

    return {
      success: true,
      output: {
        message: formatted.message,
        buttons: formatted.buttons,
        questionId: question.id,
      },
      event: 'question_asked',
    };
  }

  /**
   * Save profile answer from user
   */
  private async saveAnswer(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const userId = context.data.user_id;
    const userMessage = context.data._user_message as string;

    if (!userId) {
      return { success: true, event: 'skip' };
    }

    // Parse answer from button click (format: profile_answer:questionId:value)
    if (userMessage && userMessage.startsWith('profile_answer:')) {
      const parts = userMessage.split(':');
      if (parts.length >= 3) {
        const questionId = parts[1];
        const value = parts.slice(2).join(':'); // Handle values with colons

        await this.progressiveProfile.saveAnswer(userId, questionId, value);

        context.data._last_response = '✅ Thanks for sharing that! It helps me give you better recommendations.';

        return {
          success: true,
          event: 'answer_saved',
        };
      }
    }

    // Check for pending question
    const pendingQuestion = context.data._pending_profile_question;
    if (pendingQuestion && userMessage) {
      await this.progressiveProfile.saveAnswer(userId, pendingQuestion, userMessage);
      delete context.data._pending_profile_question;

      return {
        success: true,
        event: 'answer_saved',
      };
    }

    return { success: true, event: 'skip' };
  }

  /**
   * Check profile completeness
   */
  private async checkStatus(context: FlowContext): Promise<ActionExecutionResult> {
    const userId = context.data.user_id;

    if (!userId) {
      return {
        success: true,
        output: { completeness: 0, canAskNow: false },
        event: 'status_checked',
      };
    }

    const status = await this.progressiveProfile.getProfileStatus(userId);

    context.data._profile_status = status;

    return {
      success: true,
      output: status,
      event: status.completeness >= 80 ? 'profile_complete' : 'profile_incomplete',
    };
  }

  /**
   * Save a single profile preference (key-value)
   * Used by onboarding flow to save dietary, cuisines, budget, etc.
   */
  private async savePreference(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const userId = context.data.user_id;
    const sessionId = context._system?.sessionId || context.data.sessionId;
    const key = config.key as string;
    let value = this.resolveValue(config.value, context);

    if (!key) {
      this.logger.warn('No preference key provided');
      return { success: true, event: 'skip' };
    }

    this.logger.log(`💾 Saving preference: ${key}=${value} for user=${userId || sessionId}`);

    // Normalize value based on key
    value = this.normalizePreferenceValue(key, value as string);

    // Save to context for immediate use
    context.data[key] = value;

    // Save to session for persistence
    if (sessionId) {
      await this.sessionService.setData(sessionId, key, value);
    }

    // Save to profile service if user is authenticated
    if (userId) {
      try {
        await this.progressiveProfile.saveAnswer(userId, key, value);
        this.logger.log(`✅ Preference saved to profile: ${key}=${value}`);
      } catch (error) {
        this.logger.warn(`⚠️ Could not save to profile service: ${error.message}`);
      }
    }

    return {
      success: true,
      output: { key, value },
      event: 'success',
    };
  }

  /**
   * Normalize preference values to standard format
   */
  private normalizePreferenceValue(key: string, value: string): string {
    if (!value) return '';
    
    const normalizedValue = value.toLowerCase().trim();
    
    switch (key) {
      case 'dietary_type':
        // Map various inputs to standard values
        if (normalizedValue.includes('veg') && !normalizedValue.includes('non')) {
          return 'vegetarian';
        }
        if (normalizedValue.includes('non') || normalizedValue.includes('🍗')) {
          return 'non-vegetarian';
        }
        if (normalizedValue.includes('egg') || normalizedValue.includes('both')) {
          return 'eggetarian';
        }
        if (normalizedValue.includes('vegan')) {
          return 'vegan';
        }
        if (normalizedValue.includes('jain')) {
          return 'jain';
        }
        if (normalizedValue.includes('flex') || normalizedValue.includes('sab') || normalizedValue.includes('anything') || normalizedValue.includes('everything')) {
          return 'flexible';
        }
        // 🔧 FIX (2026-08-01): free text that matches no dietary option must not
        // be stored as a diet ("show me the menu of Tushar Misal" was saved
        // verbatim as dietary_type). Default to flexible.
        this.logger.warn(`Unrecognized dietary_type "${value}" — defaulting to flexible`);
        return 'flexible';

      case 'price_sensitivity':
        if (normalizedValue.includes('budget') || normalizedValue.includes('100')) {
          return 'budget';
        }
        if (normalizedValue.includes('moderate') || normalizedValue.includes('300')) {
          return 'moderate';
        }
        if (normalizedValue.includes('premium') || normalizedValue.includes('300+')) {
          return 'premium';
        }
        return normalizedValue;

      case 'favorite_cuisines':
        // Keep as comma-separated list
        return normalizedValue;

      default:
        return value;
    }
  }

  /**
   * Resolve template variables in config values
   */
  private resolveValue(value: any, context: FlowContext): any {
    if (typeof value !== 'string') return value;
    
    // Handle {{_user_message}} and similar templates
    return value.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      return context.data[trimmedKey] ?? match;
    });
  }

  /**
   * Learn from order details (implicit profiling)
   */
  private async learnFromOrder(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const userId = context.data.user_id;

    if (!userId) {
      return { success: true, event: 'skip' };
    }

    // Extract order details from context (for food orders)
    const items = context.data.cart_items || context.data.order_items || [];
    const totalAmount = context.data.total_amount || context.data.pricing?.total || 0;

    if (items.length === 0) {
      return { success: true, event: 'skip' };
    }

    await this.progressiveProfile.learnFromOrder(userId, {
      items: items.map((item: any) => ({
        name: item.name || item.item_name,
        isVeg: item.is_veg ?? item.veg ?? true,
        category: item.category || item.category_name || 'Unknown',
        price: item.price || 0,
      })),
      totalAmount,
      orderTime: new Date(),
    });

    return { success: true, event: 'learned' };
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
