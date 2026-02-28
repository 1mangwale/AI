/**
 * Returns Controller (Customer-facing)
 *
 * Endpoints for customers to submit and track return requests.
 * All routes prefixed with /returns.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ReturnRequestService } from '../services/return-request.service';
import { ReturnPolicyService } from '../services/return-policy.service';

@Controller('returns')
export class ReturnsController {
  private readonly logger = new Logger(ReturnsController.name);

  constructor(
    private readonly returnRequestService: ReturnRequestService,
    private readonly returnPolicyService: ReturnPolicyService,
  ) {}

  /**
   * POST /returns/request
   *
   * Submit a new return request.
   */
  @Post('request')
  async createReturnRequest(
    @Body()
    body: {
      orderId: number;
      userId?: string;
      reason: string;
      evidenceUrls?: string[];
      refundAmount?: number;
      refundMethod?: 'original' | 'wallet';
      moduleId?: number;
      orderDeliveredAt?: string;
    },
  ) {
    try {
      if (!body.orderId || !body.reason) {
        throw new HttpException(
          'orderId and reason are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.returnRequestService.createReturnRequest(
        {
          orderId: body.orderId,
          userId: body.userId,
          reason: body.reason,
          evidenceUrls: body.evidenceUrls,
          refundAmount: body.refundAmount,
          refundMethod: body.refundMethod,
        },
        body.moduleId ?? 4,
        body.orderDeliveredAt ? new Date(body.orderDeliveredAt) : undefined,
      );

      return {
        success: true,
        data: result.request,
        autoApproved: result.autoApproved,
        message: result.message,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to create return request: ${error.message}`,
      );
      throw new HttpException(
        'Failed to create return request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /returns/requests
   *
   * List the current user's return requests.
   */
  @Get('requests')
  async listReturnRequests(
    @Query('user_id') userId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const result = await this.returnRequestService.getReturnRequests(
        { userId, status },
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 20,
      );
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(
        `Failed to list return requests: ${error.message}`,
      );
      throw new HttpException(
        'Failed to list return requests',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /returns/requests/:id
   *
   * Get a specific return request by ID.
   */
  @Get('requests/:id')
  async getReturnRequest(@Param('id') id: string) {
    try {
      const request = await this.returnRequestService.getReturnRequestById(id);
      if (!request) {
        throw new HttpException(
          'Return request not found',
          HttpStatus.NOT_FOUND,
        );
      }
      return { success: true, data: request };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to get return request: ${error.message}`,
      );
      throw new HttpException(
        'Failed to get return request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /returns/policies
   *
   * Get applicable return policies.
   */
  @Get('policies')
  async getReturnPolicies(@Query('module_id') moduleId?: string) {
    try {
      const policies = await this.returnPolicyService.getPolicies(
        moduleId ? parseInt(moduleId, 10) : undefined,
      );
      return { success: true, data: policies };
    } catch (error) {
      this.logger.error(
        `Failed to get return policies: ${error.message}`,
      );
      throw new HttpException(
        'Failed to get return policies',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
