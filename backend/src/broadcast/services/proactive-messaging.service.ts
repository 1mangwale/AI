import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { MealSuggestionService } from './meal-suggestion.service';
import { WhatsAppCloudService } from '../../whatsapp/services/whatsapp-cloud.service';

@Injectable()
export class ProactiveMessagingService implements OnModuleInit {
  private readonly logger = new Logger(ProactiveMessagingService.name);
  private readonly SEND_DELAY_MS = 50; // 20 msgs/sec rate limit
  private readonly CONVERSION_WINDOW_HOURS = 2;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly mealSuggestionService: MealSuggestionService,
    private readonly whatsappService: WhatsAppCloudService,
  ) {}

  async onModuleInit() {
    this.logger.log('ProactiveMessagingService initialized');
  }

  /**
   * Run a meal-time campaign: find eligible users, generate suggestions, send templates.
   */
  async runMealTimeCampaign(mealTime: 'lunch' | 'dinner'): Promise<{
    sent: number;
    failed: number;
    skipped: number;
  }> {
    const stats = { sent: 0, failed: 0, skipped: 0 };

    try {
      this.logger.log(`Starting ${mealTime} proactive campaign`);

      // Find eligible users
      const eligibleUsers = await this.mealSuggestionService.findEligibleUsers(
        mealTime,
        50,
      );

      if (eligibleUsers.length === 0) {
        this.logger.log(`No eligible users for ${mealTime} campaign`);
        return stats;
      }

      // Generate and send suggestions
      for (const user of eligibleUsers) {
        try {
          const suggestion =
            await this.mealSuggestionService.generateSuggestion(user, mealTime);

          if (!suggestion) {
            stats.skipped++;
            continue;
          }

          // Send WhatsApp template message
          const waResult = await this.sendTemplate(suggestion);

          if (waResult.success) {
            // Record in database
            await this.prisma.proactiveMessage.create({
              data: {
                phone: suggestion.phone,
                userId: suggestion.userId,
                messageType: mealTime,
                templateName: suggestion.templateName,
                templateParams: suggestion.templateParams as any,
                mealContext: suggestion.mealContext as any,
                waMessageId: waResult.messageId || null,
              },
            });
            stats.sent++;
          } else {
            stats.failed++;
          }

          // Rate limiting delay
          await this.delay(this.SEND_DELAY_MS);
        } catch (error) {
          this.logger.error(
            `Failed to process user ${user.phone}`,
            error,
          );
          stats.failed++;
        }
      }

      this.logger.log(
        `${mealTime} campaign complete: ${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped`,
      );
      return stats;
    } catch (error) {
      this.logger.error(`${mealTime} campaign failed`, error);
      return stats;
    }
  }

  /**
   * Send a WhatsApp template message for a meal suggestion.
   */
  private async sendTemplate(suggestion: {
    phone: string;
    templateName: string;
    templateParams: Record<string, any>;
  }): Promise<{ success: boolean; messageId?: string }> {
    try {
      const result = await this.whatsappService.sendTemplate(
        suggestion.phone,
        {
          name: suggestion.templateName,
          language: suggestion.templateName.includes('_hi_') ? 'hi' : 'en',
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: suggestion.templateParams.name },
                { type: 'text', text: suggestion.templateParams.greeting },
                { type: 'text', text: suggestion.templateParams.suggestion },
              ],
            },
          ],
        },
      );

      return {
        success: true,
        messageId: result?.messages?.[0]?.id || undefined,
      };
    } catch (error) {
      this.logger.error(
        `Failed to send template to ${suggestion.phone}`,
        error,
      );
      return { success: false };
    }
  }

  /**
   * Track order conversion from a proactive message.
   * Called when an order is placed — checks if a proactive message was sent within the conversion window.
   */
  async trackConversion(phone: string, orderId: number): Promise<boolean> {
    try {
      const normalizedPhone = phone.replace(/^\+?91/, '');
      const fullPhone = `91${normalizedPhone}`;

      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - this.CONVERSION_WINDOW_HOURS);

      const message = await this.prisma.proactiveMessage.findFirst({
        where: {
          phone: fullPhone,
          sentAt: { gte: cutoff },
          convertedAt: null,
        },
        orderBy: { sentAt: 'desc' },
      });

      if (message) {
        await this.prisma.proactiveMessage.update({
          where: { id: message.id },
          data: {
            convertedAt: new Date(),
            orderId,
          },
        });
        this.logger.log(
          `Conversion tracked: message ${message.id} -> order ${orderId}`,
        );
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`Failed to track conversion for ${phone}`, error);
      return false;
    }
  }

  /**
   * Handle opt-out request (user sends STOP).
   */
  async handleOptOut(
    phone: string,
    userId?: number,
    reason = 'user_request',
  ): Promise<void> {
    try {
      const normalizedPhone = phone.replace(/^\+?91/, '');
      const fullPhone = `91${normalizedPhone}`;

      await this.prisma.proactiveOptOut.upsert({
        where: { phone: fullPhone },
        create: {
          phone: fullPhone,
          userId: userId || null,
          reason,
        },
        update: {
          userId: userId || undefined,
          reason,
          optedOutAt: new Date(),
        },
      });

      this.logger.log(`Opt-out recorded for ${fullPhone}`);
    } catch (error) {
      this.logger.error(`Failed to handle opt-out for ${phone}`, error);
    }
  }

  /**
   * Handle opt-in request (user sends START).
   */
  async handleOptIn(phone: string): Promise<void> {
    try {
      const normalizedPhone = phone.replace(/^\+?91/, '');
      const fullPhone = `91${normalizedPhone}`;

      await this.prisma.proactiveOptOut.deleteMany({
        where: { phone: fullPhone },
      });

      this.logger.log(`Opt-in recorded for ${fullPhone}`);
    } catch (error) {
      this.logger.error(`Failed to handle opt-in for ${phone}`, error);
    }
  }

  /**
   * Get campaign stats for admin dashboard.
   */
  async getCampaignStats(days = 7): Promise<{
    totalSent: number;
    totalConverted: number;
    conversionRate: number;
    byMealTime: Record<string, { sent: number; converted: number }>;
  }> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const messages = await this.prisma.proactiveMessage.findMany({
        where: { sentAt: { gte: since } },
        select: {
          messageType: true,
          convertedAt: true,
        },
      });

      const totalSent = messages.length;
      const totalConverted = messages.filter((m) => m.convertedAt).length;

      const byMealTime: Record<string, { sent: number; converted: number }> = {};
      for (const msg of messages) {
        if (!byMealTime[msg.messageType]) {
          byMealTime[msg.messageType] = { sent: 0, converted: 0 };
        }
        byMealTime[msg.messageType].sent++;
        if (msg.convertedAt) {
          byMealTime[msg.messageType].converted++;
        }
      }

      return {
        totalSent,
        totalConverted,
        conversionRate: totalSent > 0 ? (totalConverted / totalSent) * 100 : 0,
        byMealTime,
      };
    } catch (error) {
      this.logger.error('Failed to get campaign stats', error);
      return { totalSent: 0, totalConverted: 0, conversionRate: 0, byMealTime: {} };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
