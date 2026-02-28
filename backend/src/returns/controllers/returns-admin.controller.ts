/**
 * Returns Admin Controller
 *
 * Admin endpoints for managing return requests and policies.
 * Routes prefixed with /returns/admin.
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
import { ReturnRequestService } from '../services/return-request.service';
import { ReturnPolicyService } from '../services/return-policy.service';
import { RefundProcessorService } from '../services/refund-processor.service';

@Controller('returns/admin')
export class ReturnsAdminController {
  private readonly logger = new Logger(ReturnsAdminController.name);

  constructor(
    private readonly returnRequestService: ReturnRequestService,
    private readonly returnPolicyService: ReturnPolicyService,
    private readonly refundProcessorService: RefundProcessorService,
  ) {}

  // ─── Return Request Queue ─────────────────────────────────────

  /**
   * GET /returns/admin/queue
   *
   * Get pending and under_review return requests for admin dashboard.
   */
  @Get('queue')
  async getReturnQueue(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      // Get pending requests
      const pending = await this.returnRequestService.getReturnRequests(
        { status: 'pending' },
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 50,
      );

      // Get under_review requests
      const underReview = await this.returnRequestService.getReturnRequests(
        { status: 'under_review' },
        1,
        50,
      );

      return {
        success: true,
        data: {
          pending: pending.data,
          pendingCount: pending.total,
          underReview: underReview.data,
          underReviewCount: underReview.total,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get return queue: ${error.message}`);
      throw new HttpException(
        'Failed to get return queue',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /returns/admin/:id/approve
   *
   * Approve a return request.
   */
  @Post(':id/approve')
  async approveRequest(
    @Param('id') id: string,
    @Body() body: { adminId: string; notes?: string },
  ) {
    try {
      if (!body.adminId) {
        throw new HttpException(
          'adminId is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.returnRequestService.reviewRequest(
        id,
        'approve',
        body.adminId,
        body.notes,
      );

      if (!result) {
        throw new HttpException(
          'Return request not found or not in reviewable status',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        data: result,
        message: 'Return request approved. Refund will be processed.',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to approve return request: ${error.message}`);
      throw new HttpException(
        'Failed to approve return request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /returns/admin/:id/reject
   *
   * Reject a return request.
   */
  @Post(':id/reject')
  async rejectRequest(
    @Param('id') id: string,
    @Body() body: { adminId: string; notes?: string },
  ) {
    try {
      if (!body.adminId) {
        throw new HttpException(
          'adminId is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.returnRequestService.reviewRequest(
        id,
        'reject',
        body.adminId,
        body.notes,
      );

      if (!result) {
        throw new HttpException(
          'Return request not found or not in reviewable status',
          HttpStatus.BAD_REQUEST,
        );
      }

      return { success: true, data: result, message: 'Return request rejected.' };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to reject return request: ${error.message}`);
      throw new HttpException(
        'Failed to reject return request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /returns/admin/:id/initiate-refund
   *
   * Manually trigger refund processing for an approved request.
   */
  @Post(':id/initiate-refund')
  async initiateRefund(@Param('id') id: string) {
    try {
      const result = await this.returnRequestService.initiateRefund(id);

      if (!result) {
        throw new HttpException(
          'Return request not found or not in approved status',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        data: result,
        message: 'Refund processing initiated.',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to initiate refund: ${error.message}`);
      throw new HttpException(
        'Failed to initiate refund',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /returns/admin/stats
   *
   * Get return request statistics.
   */
  @Get('stats')
  async getReturnStats() {
    try {
      const stats = await this.returnRequestService.getReturnStats();
      return { success: true, data: stats };
    } catch (error) {
      this.logger.error(`Failed to get return stats: ${error.message}`);
      throw new HttpException(
        'Failed to get return stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Return Policies CRUD ─────────────────────────────────────

  /**
   * GET /returns/admin/policies
   *
   * List all return policies.
   */
  @Get('policies')
  async getPolicies(@Query('module_id') moduleId?: string) {
    try {
      const policies = await this.returnPolicyService.getPolicies(
        moduleId ? parseInt(moduleId, 10) : undefined,
      );
      return { success: true, data: policies };
    } catch (error) {
      this.logger.error(`Failed to get policies: ${error.message}`);
      throw new HttpException(
        'Failed to get policies',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /returns/admin/policies
   *
   * Create a new return policy.
   */
  @Post('policies')
  async createPolicy(
    @Body()
    body: {
      moduleId: number;
      categoryId?: number;
      returnWindowHours: number;
      autoApproveThreshold: number;
      evidenceRequired?: boolean;
      maxRefundAmount?: number;
    },
  ) {
    try {
      if (!body.moduleId || body.returnWindowHours === undefined) {
        throw new HttpException(
          'moduleId and returnWindowHours are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const policy = await this.returnPolicyService.createPolicy(body);
      return { success: true, data: policy };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to create policy: ${error.message}`);
      throw new HttpException(
        'Failed to create policy',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * PUT /returns/admin/policies/:id
   *
   * Update an existing return policy.
   */
  @Put('policies/:id')
  async updatePolicy(
    @Param('id') id: string,
    @Body()
    body: {
      returnWindowHours?: number;
      autoApproveThreshold?: number;
      evidenceRequired?: boolean;
      maxRefundAmount?: number;
      isActive?: boolean;
    },
  ) {
    try {
      const policy = await this.returnPolicyService.updatePolicy(id, body);
      if (!policy) {
        throw new HttpException('Policy not found', HttpStatus.NOT_FOUND);
      }
      return { success: true, data: policy };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to update policy: ${error.message}`);
      throw new HttpException(
        'Failed to update policy',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
