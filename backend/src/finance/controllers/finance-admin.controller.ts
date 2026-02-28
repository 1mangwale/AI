/**
 * Finance Admin Controller
 *
 * Admin endpoints for managing commissions, commission rules,
 * settlements, and payouts.
 *
 * All routes are prefixed with /finance.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { CommissionService } from '../services/commission.service';
import { SettlementService } from '../services/settlement.service';
import { PayoutService } from '../services/payout.service';

@Controller('finance')
export class FinanceAdminController {
  private readonly logger = new Logger(FinanceAdminController.name);

  constructor(
    private readonly commissionService: CommissionService,
    private readonly settlementService: SettlementService,
    private readonly payoutService: PayoutService,
  ) {}

  // ─── Commission Rules ──────────────────────────────────────────

  @Get('commission-rules')
  async getCommissionRules(
    @Query('module_id') moduleId?: string,
    @Query('store_id') storeId?: string,
  ) {
    try {
      const rules = await this.commissionService.getCommissionRules(
        moduleId ? parseInt(moduleId, 10) : undefined,
        storeId ? parseInt(storeId, 10) : undefined,
      );
      return { success: true, data: rules };
    } catch (error) {
      this.logger.error(`Failed to get commission rules: ${error.message}`);
      throw new HttpException(
        'Failed to get commission rules',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('commission-rules')
  async createCommissionRule(
    @Body()
    body: {
      storeId?: number;
      moduleId: number;
      zoneId?: number;
      commissionRate: number;
      minOrderAmount?: number;
      maxCommission?: number;
      priority?: number;
    },
  ) {
    try {
      if (!body.moduleId || body.commissionRate === undefined) {
        throw new HttpException(
          'moduleId and commissionRate are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (body.commissionRate < 0 || body.commissionRate > 1) {
        throw new HttpException(
          'commissionRate must be between 0 and 1 (e.g., 0.15 for 15%)',
          HttpStatus.BAD_REQUEST,
        );
      }

      const rule = await this.commissionService.createCommissionRule(body);
      return { success: true, data: rule };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to create commission rule: ${error.message}`);
      throw new HttpException(
        'Failed to create commission rule',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('commission-rules/:id')
  async updateCommissionRule(
    @Param('id') id: string,
    @Body()
    body: {
      commissionRate?: number;
      minOrderAmount?: number;
      maxCommission?: number;
      priority?: number;
      isActive?: boolean;
    },
  ) {
    try {
      if (
        body.commissionRate !== undefined &&
        (body.commissionRate < 0 || body.commissionRate > 1)
      ) {
        throw new HttpException(
          'commissionRate must be between 0 and 1',
          HttpStatus.BAD_REQUEST,
        );
      }

      const rule = await this.commissionService.updateCommissionRule(id, body);
      if (!rule) {
        throw new HttpException(
          'Commission rule not found',
          HttpStatus.NOT_FOUND,
        );
      }
      return { success: true, data: rule };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to update commission rule: ${error.message}`);
      throw new HttpException(
        'Failed to update commission rule',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Commissions ───────────────────────────────────────────────

  @Get('commissions')
  async listCommissions(
    @Query('store_id') storeId?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const result = await this.commissionService.listCommissions({
        storeId: storeId ? parseInt(storeId, 10) : undefined,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        status,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 20,
      });
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`Failed to list commissions: ${error.message}`);
      throw new HttpException(
        'Failed to list commissions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('commissions/stats')
  async getCommissionStats(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    try {
      const stats = await this.commissionService.getCommissionStats(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined,
      );
      return { success: true, data: stats };
    } catch (error) {
      this.logger.error(`Failed to get commission stats: ${error.message}`);
      throw new HttpException(
        'Failed to get commission stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Settlements ───────────────────────────────────────────────

  @Post('settlements/generate')
  async generateSettlement(
    @Body()
    body: {
      storeId: number;
      periodStart: string;
      periodEnd: string;
    },
  ) {
    try {
      if (!body.storeId || !body.periodStart || !body.periodEnd) {
        throw new HttpException(
          'storeId, periodStart, and periodEnd are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const settlement = await this.settlementService.generateSettlement(
        body.storeId,
        new Date(body.periodStart),
        new Date(body.periodEnd),
      );

      if (!settlement) {
        return {
          success: true,
          data: null,
          message: 'No commissions found for the specified store and period',
        };
      }

      return { success: true, data: settlement };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to generate settlement: ${error.message}`);
      throw new HttpException(
        'Failed to generate settlement',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('settlements')
  async listSettlements(
    @Query('store_id') storeId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const result = await this.settlementService.getSettlements(
        storeId ? parseInt(storeId, 10) : undefined,
        status,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 20,
      );
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`Failed to list settlements: ${error.message}`);
      throw new HttpException(
        'Failed to list settlements',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('settlements/:id')
  async getSettlementDetails(@Param('id') id: string) {
    try {
      const result = await this.settlementService.getSettlementDetails(id);
      if (!result) {
        throw new HttpException('Settlement not found', HttpStatus.NOT_FOUND);
      }
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to get settlement details: ${error.message}`,
      );
      throw new HttpException(
        'Failed to get settlement details',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('settlements/:id/confirm')
  async confirmSettlement(@Param('id') id: string) {
    try {
      const settlement = await this.settlementService.confirmSettlement(id);
      if (!settlement) {
        throw new HttpException(
          'Settlement not found or not in draft status',
          HttpStatus.BAD_REQUEST,
        );
      }
      return { success: true, data: settlement };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to confirm settlement: ${error.message}`);
      throw new HttpException(
        'Failed to confirm settlement',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('settlements/:id/pay')
  async markSettlementAsPaid(
    @Param('id') id: string,
    @Body() body: { paymentReference: string },
  ) {
    try {
      if (!body.paymentReference) {
        throw new HttpException(
          'paymentReference is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const settlement = await this.settlementService.markAsPaid(
        id,
        body.paymentReference,
      );
      if (!settlement) {
        throw new HttpException(
          'Settlement not found or not in confirmed/processing status',
          HttpStatus.BAD_REQUEST,
        );
      }
      return { success: true, data: settlement };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to mark settlement as paid: ${error.message}`,
      );
      throw new HttpException(
        'Failed to mark settlement as paid',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Payouts ───────────────────────────────────────────────────

  @Get('payouts')
  async listPayouts(
    @Query('store_id') storeId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const result = await this.payoutService.getPayouts(
        storeId ? parseInt(storeId, 10) : undefined,
        status,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 20,
      );
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`Failed to list payouts: ${error.message}`);
      throw new HttpException(
        'Failed to list payouts',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
