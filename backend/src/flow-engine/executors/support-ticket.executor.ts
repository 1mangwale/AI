import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SupportTicketService } from '../../support/support-ticket.service';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';

/**
 * Support Ticket Executor
 *
 * Creates support tickets, sends notifications to support team,
 * and manages ticket lifecycle from within flow engine.
 *
 * Actions:
 * - create: Create a new support ticket + notify team via WhatsApp
 * - get: Get ticket by ID
 * - resolve: Mark ticket as resolved
 */
@Injectable()
export class SupportTicketExecutor implements ActionExecutor {
  private readonly logger = new Logger(SupportTicketExecutor.name);
  readonly name = 'support_ticket';

  constructor(
    private readonly ticketService: SupportTicketService,
    private readonly whatsappService: WhatsAppCloudService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const action = config.action || 'create';

    try {
      switch (action) {
        case 'create':
          return this.createTicket(config, context);
        case 'get':
          return this.getTicket(config);
        case 'resolve':
          return this.resolveTicket(config);
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      this.logger.error(`Support ticket executor error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async createTicket(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    // Config values are pre-interpolated by the state machine (e.g. {{issue_type}} → actual value)
    // Context fallbacks use (context as any) since dynamic flow vars aren't in the FlowContext type
    const ctx = context as any;
    const phone = config.phone || ctx.session?.phone || ctx._phone;
    const userId = config.userId || ctx.session?.userId;
    const issueType = config.issueType || ctx.issue_type || 'general';
    const description = config.description || ctx.issue_description || '';
    const orderId = config.orderId || ctx.order_id;
    const conversationSummary = config.conversationSummary || ctx.conversation_summary;

    // Determine priority based on issue type
    let priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';
    if (issueType === 'payment' || issueType === 'payment_issue') priority = 'high';
    if (issueType === 'delivery' || issueType === 'delivery_issue') priority = 'high';

    const ticket = await this.ticketService.createTicket({
      phone,
      userId,
      issueType,
      description,
      orderId: orderId ? String(orderId) : undefined,
      conversationSummary,
      priority,
    });

    // Send WhatsApp notification to support team
    const supportPhone = this.ticketService.getSupportTeamPhone();
    if (supportPhone) {
      try {
        const notificationMsg = this.ticketService.buildNotificationMessage(ticket);
        await this.whatsappService.sendText(supportPhone, notificationMsg);
        this.logger.log(`Support team notified at ${supportPhone} for ticket ${ticket.id}`);
      } catch (err) {
        this.logger.warn(`Failed to notify support team: ${err.message}`);
      }
    }

    return {
      success: true,
      output: ticket.id,
      event: 'success',
    };
  }

  private async getTicket(config: Record<string, any>): Promise<ActionExecutionResult> {
    const ticketId = config.ticketId;
    if (!ticketId) {
      return { success: false, error: 'ticketId required' };
    }

    const ticket = await this.ticketService.getTicket(ticketId);
    if (!ticket) {
      return { success: false, error: `Ticket ${ticketId} not found` };
    }

    return { success: true, output: ticket };
  }

  private async resolveTicket(config: Record<string, any>): Promise<ActionExecutionResult> {
    const ticketId = config.ticketId;
    const resolution = config.resolution;
    if (!ticketId) {
      return { success: false, error: 'ticketId required' };
    }

    const ticket = await this.ticketService.resolveTicket(ticketId, resolution);
    if (!ticket) {
      return { success: false, error: `Ticket ${ticketId} not found` };
    }

    return { success: true, output: ticket };
  }
}
