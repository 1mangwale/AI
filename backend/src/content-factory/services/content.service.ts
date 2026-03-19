import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { ContentGeneratorService } from './content-generator.service';
import { HookService } from './hook.service';
import {
  ContentPiece,
  ContentGenerationRequest,
} from '../interfaces/content-factory.interfaces';

@Injectable()
export class ContentService implements OnModuleInit {
  private readonly logger = new Logger(ContentService.name);
  private pool: Pool;

  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    draft: ['review'],
    review: ['approved', 'rejected'],
    approved: ['scheduled'],
    rejected: ['draft'],
    scheduled: ['posted'],
  };

  constructor(
    private readonly config: ConfigService,
    private readonly contentGenerator: ContentGeneratorService,
    private readonly hookService: HookService,
  ) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS content_pieces (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content_type VARCHAR(50) NOT NULL,
          title VARCHAR(500),
          content_json JSONB NOT NULL DEFAULT '{}',
          raw_text TEXT,
          platform VARCHAR(50) NOT NULL,
          status VARCHAR(30) NOT NULL DEFAULT 'draft',
          hook_id UUID,
          prompt_version_id UUID,
          business_context JSONB DEFAULT '{}',
          generation_params JSONB DEFAULT '{}',
          generated_by VARCHAR(30) NOT NULL DEFAULT 'claude',
          cost_inr DECIMAL(10,4) DEFAULT 0,
          review_notes TEXT,
          parent_id UUID,
          scheduled_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_content_status ON content_pieces(status);
        CREATE INDEX IF NOT EXISTS idx_content_type ON content_pieces(content_type);
        CREATE INDEX IF NOT EXISTS idx_content_platform ON content_pieces(platform);
        CREATE INDEX IF NOT EXISTS idx_content_created ON content_pieces(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_content_scheduled ON content_pieces(scheduled_at) WHERE status = 'scheduled';
      `);
      client.release();
      this.logger.log('ContentService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async generateAndSave(request: ContentGenerationRequest): Promise<ContentPiece> {
    const result = await this.contentGenerator.generateContent(request);

    const title = this.deriveTitle(result.contentJson, result.rawText);

    const insertResult = await this.pool.query(
      `INSERT INTO content_pieces
        (content_type, title, content_json, raw_text, platform, status, hook_id,
         prompt_version_id, business_context, generation_params, generated_by, cost_inr)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        request.contentType,
        title,
        JSON.stringify(result.contentJson),
        result.rawText,
        request.platform,
        result.hookId || null,
        result.promptId || null,
        JSON.stringify(request.businessData || {}),
        JSON.stringify(request),
        result.provider,
        result.costInr,
      ],
    );

    this.logger.log(`Content generated and saved: ${insertResult.rows[0].id}`);
    return this.mapRow(insertResult.rows[0]);
  }

  async listContent(filters?: {
    status?: string;
    contentType?: string;
    platform?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ContentPiece[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters?.contentType) {
      conditions.push(`content_type = $${paramIdx++}`);
      params.push(filters.contentType);
    }
    if (filters?.platform) {
      conditions.push(`platform = $${paramIdx++}`);
      params.push(filters.platform);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 20;
    const offset = filters?.offset || 0;

    const [countResult, dataResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS total FROM content_pieces ${where}`,
        params,
      ),
      this.pool.query(
        `SELECT * FROM content_pieces ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset],
      ),
    ]);

    return {
      items: dataResult.rows.map(r => this.mapRow(r)),
      total: countResult.rows[0].total,
    };
  }

  async getById(id: string): Promise<ContentPiece | null> {
    const result = await this.pool.query(
      'SELECT * FROM content_pieces WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateStatus(id: string, status: string, reviewNotes?: string): Promise<ContentPiece> {
    const piece = await this.getById(id);
    if (!piece) {
      throw new NotFoundException(`Content piece ${id} not found`);
    }

    const allowedTargets = ContentService.VALID_TRANSITIONS[piece.status];
    if (!allowedTargets || !allowedTargets.includes(status)) {
      throw new BadRequestException(
        `Invalid status transition: cannot move from '${piece.status}' to '${status}'. Allowed transitions from '${piece.status}': ${allowedTargets?.join(', ') || 'none'}`,
      );
    }

    const setClauses = ['status = $2', 'updated_at = NOW()'];
    const params: any[] = [id, status];
    let paramIdx = 3;

    if (reviewNotes !== undefined) {
      setClauses.push(`review_notes = $${paramIdx++}`);
      params.push(reviewNotes);
    }

    const result = await this.pool.query(
      `UPDATE content_pieces SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    this.logger.log(`Content ${id} status updated: ${piece.status} -> ${status}`);
    return this.mapRow(result.rows[0]);
  }

  async updateContent(id: string, updates: {
    title?: string;
    contentJson?: Record<string, any>;
    rawText?: string;
  }): Promise<ContentPiece> {
    const piece = await this.getById(id);
    if (!piece) {
      throw new NotFoundException(`Content piece ${id} not found`);
    }

    if (piece.status !== 'draft' && piece.status !== 'review') {
      throw new BadRequestException(
        `Content can only be edited in 'draft' or 'review' status, current status is '${piece.status}'`,
      );
    }

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: any[] = [id];
    let paramIdx = 2;

    if (updates.title !== undefined) {
      setClauses.push(`title = $${paramIdx++}`);
      params.push(updates.title);
    }
    if (updates.contentJson !== undefined) {
      setClauses.push(`content_json = $${paramIdx++}`);
      params.push(JSON.stringify(updates.contentJson));
    }
    if (updates.rawText !== undefined) {
      setClauses.push(`raw_text = $${paramIdx++}`);
      params.push(updates.rawText);
    }

    const result = await this.pool.query(
      `UPDATE content_pieces SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    this.logger.log(`Content ${id} updated`);
    return this.mapRow(result.rows[0]);
  }

  async regenerate(id: string, additionalInstructions?: string): Promise<ContentPiece> {
    const original = await this.getById(id);
    if (!original) {
      throw new NotFoundException(`Content piece ${id} not found`);
    }

    const request: ContentGenerationRequest = {
      ...(original.generationParams as ContentGenerationRequest),
    };

    if (additionalInstructions) {
      request.additionalInstructions = additionalInstructions;
    }

    const result = await this.contentGenerator.generateContent(request);
    const title = this.deriveTitle(result.contentJson, result.rawText);

    const insertResult = await this.pool.query(
      `INSERT INTO content_pieces
        (content_type, title, content_json, raw_text, platform, status, hook_id,
         prompt_version_id, business_context, generation_params, generated_by, cost_inr, parent_id)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        request.contentType,
        title,
        JSON.stringify(result.contentJson),
        result.rawText,
        request.platform,
        result.hookId || null,
        result.promptId || null,
        JSON.stringify(request.businessData || {}),
        JSON.stringify(request),
        result.provider,
        result.costInr,
        id,
      ],
    );

    this.logger.log(`Content regenerated: ${insertResult.rows[0].id} (parent: ${id})`);
    return this.mapRow(insertResult.rows[0]);
  }

  async getStats(): Promise<any> {
    const [total, byStatus, byContentType, byPlatform, costResult] = await Promise.all([
      this.pool.query('SELECT COUNT(*)::int AS count FROM content_pieces'),
      this.pool.query(
        'SELECT status, COUNT(*)::int AS count FROM content_pieces GROUP BY status ORDER BY count DESC',
      ),
      this.pool.query(
        'SELECT content_type, COUNT(*)::int AS count FROM content_pieces GROUP BY content_type ORDER BY count DESC',
      ),
      this.pool.query(
        'SELECT platform, COUNT(*)::int AS count FROM content_pieces GROUP BY platform ORDER BY count DESC',
      ),
      this.pool.query(
        'SELECT COALESCE(SUM(cost_inr), 0)::float AS total_cost FROM content_pieces',
      ),
    ]);

    return {
      total: total.rows[0].count,
      byStatus: byStatus.rows,
      byContentType: byContentType.rows,
      byPlatform: byPlatform.rows,
      totalCostInr: costResult.rows[0].total_cost,
    };
  }

  async deleteContent(id: string): Promise<void> {
    const piece = await this.getById(id);
    if (!piece) {
      throw new NotFoundException(`Content piece ${id} not found`);
    }

    if (piece.status !== 'draft' && piece.status !== 'rejected') {
      throw new BadRequestException(
        `Content can only be deleted in 'draft' or 'rejected' status, current status is '${piece.status}'`,
      );
    }

    await this.pool.query('DELETE FROM content_pieces WHERE id = $1', [id]);
    this.logger.log(`Content ${id} deleted`);
  }

  private deriveTitle(contentJson: Record<string, any>, rawText: string | null): string | null {
    if (contentJson.hook_line) return contentJson.hook_line;
    if (contentJson.headline) return contentJson.headline;
    if (contentJson.title) return contentJson.title;
    if (rawText) return rawText.substring(0, 100);
    return null;
  }

  private mapRow(row: any): ContentPiece {
    return {
      id: row.id,
      contentType: row.content_type,
      title: row.title,
      contentJson: row.content_json || {},
      rawText: row.raw_text,
      platform: row.platform,
      status: row.status,
      hookId: row.hook_id,
      promptVersionId: row.prompt_version_id,
      businessContext: row.business_context || {},
      generationParams: row.generation_params || {},
      generatedBy: row.generated_by,
      costInr: parseFloat(row.cost_inr) || 0,
      reviewNotes: row.review_notes,
      parentId: row.parent_id,
      scheduledAt: row.scheduled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
