import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import {
  ApprovedWhatsAppNativeCallRequest,
  InboundWhatsAppCallAcceptRequest,
  WhatsAppCallingExecutorService,
} from '../services/whatsapp-calling-executor.service';
import {
  WhatsAppCallingPermissionCheckRequest,
  WhatsAppCallingPermissionService,
} from '../services/whatsapp-calling-permission.service';
import { WhatsAppCallingReadinessService } from '../services/whatsapp-calling-readiness.service';

@Controller('whatsapp/calling')
@UseGuards(AdminApiKeyGuard)
export class WhatsAppCallingController {
  constructor(
    private readonly readiness: WhatsAppCallingReadinessService,
    private readonly executor: WhatsAppCallingExecutorService,
    private readonly permission: WhatsAppCallingPermissionService,
  ) {}

  @Get('readiness')
  getReadiness() {
    return this.readiness.getReadiness();
  }

  @Get('use-cases')
  getUseCases() {
    return this.permission.getUseCases();
  }

  @Post('permission-check')
  @HttpCode(HttpStatus.OK)
  checkPermission(@Body() body: WhatsAppCallingPermissionCheckRequest) {
    return this.permission.check(body);
  }

  @Post('approved-call')
  @HttpCode(HttpStatus.OK)
  dryRunApprovedCall(@Body() body: ApprovedWhatsAppNativeCallRequest) {
    return this.executor.dryRunApprovedCall(body);
  }

  @Post('inbound/:callIdHash/accept')
  @HttpCode(HttpStatus.OK)
  preflightInboundAccept(
    @Param('callIdHash') callIdHash: string,
    @Body() body: InboundWhatsAppCallAcceptRequest,
  ) {
    return this.executor.preflightInboundSupportAccept(callIdHash, body);
  }
}
