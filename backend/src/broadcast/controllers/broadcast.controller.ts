import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BroadcastService } from '../services/broadcast.service';
import { CartRecoveryService } from '../services/cart-recovery.service';

// ─── DTOs ────────────────────────────────────────────────────────

class SendBroadcastDto {
  name: string;                         // Campaign name
  templateName: string;                 // Meta-approved template name
  templateLanguage?: string;            // Default: 'hi'
  templateComponents?: any[];           // Template parameters (header/body/button vars)
  audience: 'all' | 'recent' | 'inactive' | 'custom';
  audienceFilter?: {
    lastActiveWithinDays?: number;
    inactiveForDays?: number;
    phoneNumbers?: string[];
  };
}

class QuickSendDto {
  templateName: string;
  templateLanguage?: string;
  templateComponents?: any[];
  phoneNumbers: string[];               // Direct phone list
}

// ─── Controller ──────────────────────────────────────────────────

@Controller('broadcast')
export class BroadcastController {
  private readonly logger = new Logger(BroadcastController.name);

  constructor(
    private readonly broadcastService: BroadcastService,
    private readonly cartRecoveryService: CartRecoveryService,
  ) {}

  /**
   * GET /broadcast/campaigns — List all campaigns
   */
  @Get('campaigns')
  getCampaigns() {
    return {
      success: true,
      campaigns: this.broadcastService.getCampaigns(),
    };
  }

  /**
   * GET /broadcast/campaigns/:id — Single campaign details
   */
  @Get('campaigns/:id')
  getCampaign(@Param('id') id: string) {
    const campaign = this.broadcastService.getCampaign(id);
    if (!campaign) {
      throw new HttpException('Campaign not found', HttpStatus.NOT_FOUND);
    }
    return { success: true, campaign };
  }

  /**
   * POST /broadcast/send — Send campaign with audience resolution
   * Body: { name, templateName, templateLanguage?, templateComponents?, audience, audienceFilter? }
   */
  @Post('send')
  async sendCampaign(@Body() dto: SendBroadcastDto) {
    if (!dto.templateName) {
      throw new HttpException(
        'templateName is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!dto.audience) {
      throw new HttpException('audience is required', HttpStatus.BAD_REQUEST);
    }
    if (
      dto.audience === 'custom' &&
      (!dto.audienceFilter?.phoneNumbers?.length)
    ) {
      throw new HttpException(
        'phoneNumbers required for custom audience',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.logger.log(
      `📢 Campaign request: "${dto.name}" template="${dto.templateName}" audience="${dto.audience}"`,
    );

    const campaign = await this.broadcastService.sendCampaign({
      name: dto.name || dto.templateName,
      templateName: dto.templateName,
      templateLanguage: dto.templateLanguage || 'hi',
      templateComponents: dto.templateComponents,
      audience: dto.audience,
      audienceFilter: dto.audienceFilter,
    });

    return { success: true, campaign };
  }

  /**
   * POST /broadcast/quick-send — Send template to explicit phone list
   * Body: { templateName, templateLanguage?, templateComponents?, phoneNumbers }
   */
  @Post('quick-send')
  async quickSend(@Body() dto: QuickSendDto) {
    if (!dto.templateName) {
      throw new HttpException(
        'templateName is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!dto.phoneNumbers?.length) {
      throw new HttpException(
        'phoneNumbers array is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const campaign = await this.broadcastService.sendBroadcast({
      name: `Quick: ${dto.templateName}`,
      templateName: dto.templateName,
      templateLanguage: dto.templateLanguage || 'hi',
      templateComponents: dto.templateComponents,
      phoneNumbers: dto.phoneNumbers,
    });

    return { success: true, campaign };
  }

  /**
   * GET /broadcast/audience-count/:type — Preview audience size
   */
  @Get('audience-count/:type')
  async getAudienceCount(
    @Param('type') type: 'all' | 'recent' | 'inactive',
  ) {
    const phones = await this.broadcastService.getAudienceList(type);
    return {
      success: true,
      audience: type,
      count: phones.length,
      sample: phones.slice(0, 5).map((p) => p.replace(/(\d{2})\d{6}(\d{2})/, '$1******$2')),
    };
  }

  // ─── Cart Recovery ──────────────────────────────────────────

  /**
   * GET /broadcast/cart-recovery/stats — Recovery metrics
   */
  @Get('cart-recovery/stats')
  async getCartRecoveryStats() {
    const stats = await this.cartRecoveryService.getRecoveryStats();
    return { success: true, stats };
  }

  /**
   * GET /broadcast/cart-recovery/pending — Pending recoveries
   */
  @Get('cart-recovery/pending')
  async getPendingRecoveries() {
    const records = await this.cartRecoveryService.getPendingRecoveries();
    return { success: true, count: records.length, records };
  }
}
