import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export interface CreateTicketDto {
  phone: string;
  userId?: number;
  issueType: string;
  description: string;
  orderId?: string;
  conversationSummary?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface SupportTicket {
  id: string;
  phone: string;
  userId: number | null;
  issueType: string;
  description: string;
  orderId: string | null;
  conversationSummary: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  assignedTo: string | null;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

@Injectable()
export class SupportTicketService implements OnModuleInit {
  private readonly logger = new Logger(SupportTicketService.name);
  private pool: Pool;
  private readonly supportTeamPhone: string | null;

  constructor(private readonly config: ConfigService) {
    this.supportTeamPhone = this.config.get<string>('SUPPORT_TEAM_PHONE') || null;
  }

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) NOT NULL,
          user_id INTEGER,
          issue_type VARCHAR(50) NOT NULL,
          description TEXT,
          order_id VARCHAR(50),
          conversation_summary TEXT,
          status VARCHAR(20) DEFAULT 'open',
          assigned_to VARCHAR(100),
          priority VARCHAR(10) DEFAULT 'normal',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          resolved_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
        CREATE INDEX IF NOT EXISTS idx_tickets_phone ON support_tickets(phone);
        CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets(created_at DESC);
      `);
      client.release();
      this.logger.log('SupportTicketService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async createTicket(dto: CreateTicketDto): Promise<SupportTicket> {
    const result = await this.pool.query(
      `INSERT INTO support_tickets
       (phone, user_id, issue_type, description, order_id, conversation_summary, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        dto.phone,
        dto.userId || null,
        dto.issueType,
        dto.description || '',
        dto.orderId || null,
        dto.conversationSummary || null,
        dto.priority || 'normal',
      ],
    );

    const ticket = this.mapRow(result.rows[0]);
    this.logger.log(`Ticket created: ${ticket.id} (${dto.issueType}) for ${dto.phone}`);

    return ticket;
  }

  async getTicket(id: string): Promise<SupportTicket | null> {
    const result = await this.pool.query(
      'SELECT * FROM support_tickets WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateTicket(
    id: string,
    updates: Partial<Pick<SupportTicket, 'status' | 'assignedTo' | 'priority'>>,
  ): Promise<SupportTicket | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;

    if (updates.status) {
      sets.push(`status = $${idx++}`);
      params.push(updates.status);
      if (updates.status === 'resolved' || updates.status === 'closed') {
        sets.push('resolved_at = NOW()');
      }
    }
    if (updates.assignedTo !== undefined) {
      sets.push(`assigned_to = $${idx++}`);
      params.push(updates.assignedTo);
    }
    if (updates.priority) {
      sets.push(`priority = $${idx++}`);
      params.push(updates.priority);
    }

    params.push(id);
    const result = await this.pool.query(
      `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async getOpenTickets(filters?: {
    phone?: string;
    status?: string;
    limit?: number;
  }): Promise<SupportTicket[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.phone) {
      conditions.push(`phone = $${idx++}`);
      params.push(filters.phone);
    }
    if (filters?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    } else {
      conditions.push(`status IN ('open', 'in_progress')`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;

    const result = await this.pool.query(
      `SELECT * FROM support_tickets ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      [...params, limit],
    );

    return result.rows.map(this.mapRow);
  }

  async resolveTicket(id: string, resolution?: string): Promise<SupportTicket | null> {
    const result = await this.pool.query(
      `UPDATE support_tickets
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(),
           conversation_summary = COALESCE(conversation_summary, '') || $2
       WHERE id = $1
       RETURNING *`,
      [id, resolution ? `\n[Resolution] ${resolution}` : ''],
    );

    if (result.rows[0]) {
      this.logger.log(`Ticket ${id} resolved`);
      return this.mapRow(result.rows[0]);
    }
    return null;
  }

  async getTicketStats(): Promise<{
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
  }> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'open')::int AS open,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'resolved' OR status = 'closed')::int AS resolved
      FROM support_tickets
    `);

    const row = result.rows[0];
    return {
      total: row.total,
      open: row.open,
      inProgress: row.in_progress,
      resolved: row.resolved,
    };
  }

  /**
   * Build a WhatsApp notification message body for the support team
   */
  buildNotificationMessage(ticket: SupportTicket): string {
    const lines = [
      `🎫 *New Support Ticket*`,
      ``,
      `*ID:* ${ticket.id.substring(0, 8)}`,
      `*Type:* ${ticket.issueType}`,
      `*Customer:* ${ticket.phone}`,
    ];

    if (ticket.orderId) {
      lines.push(`*Order:* #${ticket.orderId}`);
    }
    if (ticket.description) {
      lines.push(`*Issue:* ${ticket.description.substring(0, 200)}`);
    }
    lines.push(`*Priority:* ${ticket.priority}`);
    lines.push(`*Time:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

    return lines.join('\n');
  }

  getSupportTeamPhone(): string | null {
    return this.supportTeamPhone;
  }

  private mapRow(row: any): SupportTicket {
    return {
      id: row.id,
      phone: row.phone,
      userId: row.user_id,
      issueType: row.issue_type,
      description: row.description,
      orderId: row.order_id,
      conversationSummary: row.conversation_summary,
      status: row.status,
      assignedTo: row.assigned_to,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    };
  }
}
