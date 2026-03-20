import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { AdaptiveFlowService, FlowAdaptation, SmartDefaults } from '../../personalization/adaptive-flow.service';

/**
 * Adaptive Executor
 * 
 * Provides flow adaptations and smart defaults for personalized experiences.
 * Use this executor to make flows behave differently based on user behavior.
 * 
 * Actions:
 * - get_adaptations: Get flow behavior adaptations for user
 * - get_defaults: Get smart defaults (address, payment, items)
 * - should_skip: Check if a step should be skipped for this user
 * - get_quick_reorder: Get quick reorder suggestions
 * - record_interaction: Record user interaction for learning
 * - check_intervention: Check if we should intervene to prevent abandonment
 */
@Injectable()
export class AdaptiveExecutor implements ActionExecutor {
  readonly name = 'adaptive';
  private readonly logger = new Logger(AdaptiveExecutor.name);

  constructor(
    private adaptiveFlowService: AdaptiveFlowService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const action = config.action || 'get_adaptations';
    const userId = context._system?.userId ? parseInt(context._system.userId, 10) : null;

    if (!userId) {
      return {
        success: false,
        error: 'No user ID in session',
        event: 'error',
      };
    }

    try {
      switch (action) {
        case 'get_adaptations':
          return await this.getAdaptations(userId, context);
        
        case 'get_defaults':
          return await this.getDefaults(userId, config, context);
        
        case 'should_skip':
          return await this.checkShouldSkip(userId, config);
        
        case 'get_quick_reorder':
          return await this.getQuickReorder(userId);
        
        case 'record_interaction':
          return await this.recordInteraction(userId, config);
        
        case 'check_intervention':
          return await this.checkIntervention(userId, config, context);
        
        default:
          return {
            success: false,
            error: `Unknown action: ${action}`,
            event: 'error',
          };
      }
    } catch (error) {
      this.logger.error(`Adaptive executor failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        event: 'error',
      };
    }
  }

  /**
   * Get flow adaptations for the user
   */
  private async getAdaptations(
    userId: number,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const adaptations = await this.adaptiveFlowService.getFlowAdaptations(userId);
    
    this.logger.log(`🔄 User ${userId} adaptations: decisive=${adaptations.showQuickReorder}, skip=${adaptations.skipBrowsing}`);

    return {
      success: true,
      output: {
        adaptations,
        // Convenience flags for common checks
        isDecisiveUser: adaptations.skipBrowsing || adaptations.skipConfirmation,
        isPowerUser: adaptations.autoSelectLastAddress && adaptations.autoSelectLastPayment,
        prefersBrevity: adaptations.useShortPrompts,
      },
      event: 'adaptations_loaded',
    };
  }

  /**
   * Get smart defaults for the user
   */
  private async getDefaults(
    userId: number,
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const defaults = await this.adaptiveFlowService.getSmartDefaults(userId, {
      flowType: config.flowType || context.data.flowType,
      currentTime: new Date(),
      searchQuery: context.data.searchQuery || context.data.userMessage,
    });

    this.logger.log(`🎯 Smart defaults for user ${userId}: ${JSON.stringify({
      hasAddress: !!defaults.defaultAddress,
      hasPayment: !!defaults.defaultPayment,
      suggestedItems: defaults.suggestedItems?.length || 0,
    })}`);

    return {
      success: true,
      output: {
        defaults,
        // Build a helpful suggestion message
        suggestionMessage: this.buildSuggestionMessage(defaults),
        // Quick access to key defaults
        suggestedQuantity: defaults.defaultQuantity || 1,
        suggestedPayment: defaults.defaultPayment?.method,
      },
      event: 'defaults_loaded',
    };
  }

  /**
   * Check if a specific step should be skipped
   */
  private async checkShouldSkip(
    userId: number,
    config: Record<string, any>
  ): Promise<ActionExecutionResult> {
    const stepName = config.step || config.stepName;
    const adaptations = await this.adaptiveFlowService.getFlowAdaptations(userId);

    let shouldSkip = false;
    let reason = '';

    switch (stepName) {
      case 'browse':
      case 'browsing':
      case 'show_suggestions':
        shouldSkip = adaptations.skipBrowsing;
        reason = 'User prefers quick ordering';
        break;
      
      case 'confirm':
      case 'confirmation':
        shouldSkip = adaptations.skipConfirmation;
        reason = 'User is decisive';
        break;
      
      case 'upsell':
      case 'upsells':
      case 'add_more':
        shouldSkip = adaptations.skipUpsells;
        reason = 'User prefers minimal interaction';
        break;
      
      case 'address_selection':
        shouldSkip = adaptations.autoSelectLastAddress;
        reason = 'Auto-selecting last address';
        break;
      
      case 'payment_selection':
        shouldSkip = adaptations.autoSelectLastPayment;
        reason = 'Auto-selecting preferred payment';
        break;
    }

    return {
      success: true,
      output: {
        shouldSkip,
        reason,
        stepName,
      },
      event: shouldSkip ? 'skip' : 'continue',
    };
  }

  /**
   * Get quick reorder suggestions
   */
  private async getQuickReorder(userId: number): Promise<ActionExecutionResult> {
    const suggestions = await this.adaptiveFlowService.getQuickReorderSuggestions(userId);

    if (!suggestions.canQuickReorder) {
      return {
        success: true,
        output: { canQuickReorder: false },
        event: 'no_history',
      };
    }

    return {
      success: true,
      output: {
        canQuickReorder: true,
        lastOrder: suggestions.lastOrder,
        frequentOrders: suggestions.frequentOrders,
        message: this.buildReorderMessage(suggestions),
      },
      event: 'reorder_available',
    };
  }

  /**
   * Record a user interaction
   */
  private async recordInteraction(
    userId: number,
    config: Record<string, any>
  ): Promise<ActionExecutionResult> {
    const type = config.interactionType || config.type;
    const metadata = config.metadata || {};

    await this.adaptiveFlowService.recordInteraction(userId, type, metadata);

    return {
      success: true,
      output: { recorded: true },
      event: 'recorded',
    };
  }

  /**
   * Check if we should intervene to prevent abandonment
   */
  private async checkIntervention(
    userId: number,
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    const currentState = config.state || context._system?.currentState || '';
    const timeInState = config.timeInState || 0;

    const result = await this.adaptiveFlowService.shouldIntervenePrevention(
      userId,
      currentState,
      timeInState
    );

    return {
      success: true,
      output: {
        shouldIntervene: result.shouldIntervene,
        interventionMessage: result.intervention,
      },
      event: result.shouldIntervene ? 'intervene' : 'continue',
    };
  }

  /**
   * Build a suggestion message from defaults
   */
  private buildSuggestionMessage(defaults: SmartDefaults): string {
    const parts: string[] = [];

    if (defaults.suggestedItems && defaults.suggestedItems.length > 0) {
      const items = defaults.suggestedItems.slice(0, 3);
      const itemNames = items.map(i => i.itemName).join(', ');
      parts.push(`Based on your history, you might like: ${itemNames}`);
    }

    if (defaults.preferredStores && defaults.preferredStores.length > 0) {
      const storeName = defaults.preferredStores[0].storeName;
      parts.push(`Your favorite: ${storeName}`);
    }

    if (defaults.usualOrderTime) {
      parts.push(`You usually order around ${defaults.usualOrderTime}`);
    }

    return parts.join(' • ');
  }

  /**
   * Build quick reorder message
   */
  private buildReorderMessage(suggestions: any): string {
    if (!suggestions.lastOrder) return '';

    const { storeName, items, totalAmount } = suggestions.lastOrder;
    const itemNames = items.slice(0, 3).map((i: any) => i.name).join(', ');
    
    let message = `🔄 **Quick Reorder**\n`;
    message += `Your last order from ${storeName}: ${itemNames}`;
    if (items.length > 3) message += ` +${items.length - 3} more`;
    message += `\nTotal: ₹${totalAmount}\n\nWant to order the same?`;
    
    return message;
  }

  validate(config: Record<string, any>): boolean {
    const validActions = [
      'get_adaptations', 'get_defaults', 'should_skip', 
      'get_quick_reorder', 'record_interaction', 'check_intervention'
    ];
    return !config.action || validActions.includes(config.action);
  }
}
