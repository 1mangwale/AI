import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { ApprovalService, CreateApprovalDto } from '../services/approval.service';

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  @Get()
  async getQueue(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.approvalService.getQueue({
      type, status, priority, assignedTo,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  @Get('stats')
  async getStats() {
    return this.approvalService.getStats();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.approvalService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateApprovalDto) {
    return this.approvalService.createRequest(dto);
  }

  @Patch(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body() body: { decidedBy: string; notes?: string },
  ) {
    return this.approvalService.approveRequest(id, body.decidedBy, body.notes);
  }

  @Patch(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() body: { decidedBy: string; reason: string },
  ) {
    return this.approvalService.rejectRequest(id, body.decidedBy, body.reason);
  }
}
