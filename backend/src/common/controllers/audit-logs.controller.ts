import { Controller, Get, Query, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  resource_id?: string;
  details: string;
  ip: string;
  status: 'success' | 'failure';
  user_agent?: string;
  metadata?: Record<string, any>;
}

interface CreateAuditLogDto {
  user: string;
  action: string;
  resource: string;
  resource_id?: string;
  details: string;
  ip?: string;
  status?: 'success' | 'failure';
  metadata?: Record<string, any>;
}

// In-memory storage — persists within process lifetime only (max 1000 entries)
// Seeded empty; all entries are real runtime logs
const auditLogs: AuditLog[] = [];

@ApiTags('audit-logs')
@Controller('audit-logs')
export class AuditLogsController {
  private readonly logger = new Logger(AuditLogsController.name);

  @Get()
  @ApiOperation({ summary: 'Get audit logs with filtering' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'action', required: false, description: 'Filter by action type' })
  @ApiQuery({ name: 'resource', required: false, description: 'Filter by resource type' })
  @ApiQuery({ name: 'user', required: false, description: 'Filter by user' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'from', required: false, description: 'Start date (ISO string)' })
  @ApiQuery({ name: 'to', required: false, description: 'End date (ISO string)' })
  @ApiResponse({ status: 200, description: 'Audit logs retrieved' })
  async getAuditLogs(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 50,
    @Query('action') action?: string,
    @Query('resource') resource?: string,
    @Query('user') user?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    let filtered = [...auditLogs];

    // Apply filters
    if (action) {
      filtered = filtered.filter(log => log.action.toLowerCase() === action.toLowerCase());
    }
    if (resource) {
      filtered = filtered.filter(log => log.resource.toLowerCase().includes(resource.toLowerCase()));
    }
    if (user) {
      filtered = filtered.filter(log => log.user.toLowerCase().includes(user.toLowerCase()));
    }
    if (status) {
      filtered = filtered.filter(log => log.status === status);
    }
    if (from) {
      const fromDate = new Date(from);
      filtered = filtered.filter(log => new Date(log.timestamp) >= fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      filtered = filtered.filter(log => new Date(log.timestamp) <= toDate);
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Paginate
    const startIndex = (page - 1) * limit;
    const paginatedLogs = filtered.slice(startIndex, startIndex + limit);

    return {
      logs: paginatedLogs,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new audit log entry' })
  @ApiResponse({ status: 201, description: 'Audit log created' })
  async createAuditLog(@Body() dto: CreateAuditLogDto): Promise<AuditLog> {
    const newLog: AuditLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      user: dto.user,
      action: dto.action,
      resource: dto.resource,
      resource_id: dto.resource_id,
      details: dto.details,
      ip: dto.ip || '127.0.0.1',
      status: dto.status || 'success',
      metadata: dto.metadata,
    };

    auditLogs.unshift(newLog); // Add to beginning
    
    // Keep only last 1000 logs in memory
    if (auditLogs.length > 1000) {
      auditLogs.pop();
    }

    return newLog;
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get audit log statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStats() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const logs24h = auditLogs.filter(log => new Date(log.timestamp) >= last24h);
    const logs7d = auditLogs.filter(log => new Date(log.timestamp) >= last7d);

    const actionCounts: Record<string, number> = {};
    const resourceCounts: Record<string, number> = {};
    
    for (const log of auditLogs) {
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
      resourceCounts[log.resource] = (resourceCounts[log.resource] || 0) + 1;
    }

    return {
      total_logs: auditLogs.length,
      logs_24h: logs24h.length,
      logs_7d: logs7d.length,
      success_rate: auditLogs.length > 0
        ? Math.round(auditLogs.filter(l => l.status === 'success').length / auditLogs.length * 100)
        : 100,
      action_breakdown: actionCounts,
      resource_breakdown: resourceCounts,
      recent_failures: auditLogs.filter(l => l.status === 'failure').slice(0, 5),
      storage: 'in-memory',
      note: 'Logs reset on server restart. Limited to last 1000 entries.',
    };
  }

  @Get('actions')
  @ApiOperation({ summary: 'Get list of action types' })
  @ApiResponse({ status: 200, description: 'Action types retrieved' })
  async getActionTypes() {
    const actions = [...new Set(auditLogs.map(log => log.action))];
    return { actions };
  }

  @Get('resources')
  @ApiOperation({ summary: 'Get list of resource types' })
  @ApiResponse({ status: 200, description: 'Resource types retrieved' })
  async getResourceTypes() {
    const resources = [...new Set(auditLogs.map(log => log.resource))];
    return { resources };
  }
}
