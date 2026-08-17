import { Controller, Post, Body, Get, Param, Logger, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { MessageGatewayService } from '../../messaging/services/message-gateway.service';
import { SessionService } from '../../session/session.service';
import { Platform } from '../../common/enums/platform.enum';

@UseGuards(AdminApiKeyGuard)
@Controller('test')
export class TestController {
  private readonly logger = new Logger(TestController.name);

  constructor(
    private messageGateway: MessageGatewayService,
    private sessionService: SessionService,
  ) {}

  @Post('message')
  async sendTestMessage(
    @Body() body: { phoneNumber: string; message: string; senderName?: string },
  ): Promise<any> {
    this.logger.log(`📨 Test message from ${body.phoneNumber}: "${body.message}"`);

    try {
      // Use MessageGateway (Phase 1 modern architecture)
      // Default to WhatsApp channel for phone numbers
      await this.messageGateway.handleWhatsAppMessage(
        body.phoneNumber,
        body.message,
      );

      this.logger.log(`✅ Message processed successfully`);
      return {
        status: 'success',
        phoneNumber: body.phoneNumber,
        message: body.message,
      };
    } catch (error) {
      this.logger.error(`❌ Error processing test message: ${error.message}`);
      return {
        status: 'error',
        error: error.message,
      };
    }
  }

  @Get('session/:phoneNumber')
  async getTestSession(@Param('phoneNumber') phoneNumber: string): Promise<any> {
    const session = await this.sessionService.getSession(phoneNumber);
    return session || { message: 'No session found' };
  }
}
