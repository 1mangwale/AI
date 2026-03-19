import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { TrendingHook } from '../interfaces/content-factory.interfaces';

@Injectable()
export class HookService implements OnModuleInit {
  private readonly logger = new Logger(HookService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS trending_hooks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          hook_text TEXT NOT NULL,
          platform VARCHAR(50) NOT NULL,
          category VARCHAR(50) NOT NULL,
          source_url VARCHAR(500),
          freshness_score INTEGER DEFAULT 100,
          usage_count INTEGER DEFAULT 0,
          last_used_at TIMESTAMP,
          expires_at TIMESTAMP,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hooks_platform ON trending_hooks(platform);
        CREATE INDEX IF NOT EXISTS idx_hooks_active_fresh ON trending_hooks(freshness_score DESC) WHERE is_active = true;
      `);

      // Seed sample hooks if table is empty
      const countResult = await client.query('SELECT COUNT(*)::int AS count FROM trending_hooks');
      if (countResult.rows[0].count === 0) {
        await client.query(`
          INSERT INTO trending_hooks (hook_text, platform, category) VALUES
          ('POV: You ordered something and it actually arrived in 15 minutes', 'instagram', 'trending_audio'),
          ('Nobody: ... Mangwale rider at 11 PM:', 'instagram', 'meme_format'),
          ('Things Nashik people don''t have to worry about anymore', 'instagram', 'emotional'),
          ('How a Tier-2 city startup is beating the big guys at delivery', 'linkedin', 'data_driven'),
          ('We hit {{milestone}} orders this week. Here''s what we learned.', 'linkedin', 'data_driven'),
          ('Local store owners are the real heroes. Here''s why.', 'linkedin', 'emotional'),
          ('When your delivery is faster than your friend''s reply', 'instagram', 'humor'),
          ('3 things we do differently from Swiggy/Zomato (and why it matters)', 'linkedin', 'data_driven'),
          ('That moment when you discover Mangwale delivers from your favorite local shop', 'instagram', 'emotional'),
          ('Building in a Tier-2 city taught me more than any VC pitch deck', 'linkedin', 'emotional')
        `);
        this.logger.log('Seeded 10 sample trending hooks');
      }

      client.release();
      this.logger.log('HookService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async createHook(data: {
    hookText: string;
    platform: string;
    category: string;
    sourceUrl?: string;
    expiresAt?: string;
  }): Promise<TrendingHook> {
    const result = await this.pool.query(
      `INSERT INTO trending_hooks (hook_text, platform, category, source_url, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.hookText, data.platform, data.category, data.sourceUrl || null, data.expiresAt || null],
    );
    return this.mapRow(result.rows[0]);
  }

  async listHooks(filters?: {
    platform?: string;
    category?: string;
    isActive?: boolean;
    limit?: number;
  }): Promise<TrendingHook[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters?.platform) {
      conditions.push(`platform = $${paramIdx++}`);
      params.push(filters.platform);
    }
    if (filters?.category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(filters.category);
    }
    if (filters?.isActive !== undefined) {
      conditions.push(`is_active = $${paramIdx++}`);
      params.push(filters.isActive);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;

    const result = await this.pool.query(
      `SELECT * FROM trending_hooks ${where} ORDER BY freshness_score DESC LIMIT $${paramIdx}`,
      [...params, limit],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  async getHookById(id: string): Promise<TrendingHook | null> {
    const result = await this.pool.query(
      'SELECT * FROM trending_hooks WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async suggestHook(platform: string): Promise<TrendingHook | null> {
    const result = await this.pool.query(
      `SELECT * FROM trending_hooks
       WHERE platform = $1 AND is_active = true
       ORDER BY (freshness_score - usage_count * 10) DESC
       LIMIT 1`,
      [platform],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async recordUsage(hookId: string): Promise<void> {
    await this.pool.query(
      `UPDATE trending_hooks
       SET usage_count = usage_count + 1, last_used_at = NOW()
       WHERE id = $1`,
      [hookId],
    );
  }

  async decayFreshness(): Promise<{ decayed: number; deactivated: number }> {
    const decayResult = await this.pool.query(
      `UPDATE trending_hooks
       SET freshness_score = freshness_score - 5
       WHERE is_active = true AND freshness_score > 0`,
    );

    const deactivateResult = await this.pool.query(
      `UPDATE trending_hooks
       SET is_active = false
       WHERE (freshness_score <= 10 OR (expires_at IS NOT NULL AND expires_at < NOW()))
         AND is_active = true`,
    );

    return {
      decayed: decayResult.rowCount || 0,
      deactivated: deactivateResult.rowCount || 0,
    };
  }

  async updateHook(
    id: string,
    data: Partial<{
      hookText: string;
      platform: string;
      category: string;
      sourceUrl: string;
      freshnessScore: number;
      isActive: boolean;
      expiresAt: string;
    }>,
  ): Promise<TrendingHook> {
    const fieldMap: Record<string, string> = {
      hookText: 'hook_text',
      platform: 'platform',
      category: 'category',
      sourceUrl: 'source_url',
      freshnessScore: 'freshness_score',
      isActive: 'is_active',
      expiresAt: 'expires_at',
    };

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    for (const [key, column] of Object.entries(fieldMap)) {
      if (data[key as keyof typeof data] !== undefined) {
        setClauses.push(`${column} = $${paramIdx++}`);
        params.push(data[key as keyof typeof data]);
      }
    }

    if (setClauses.length === 0) {
      const existing = await this.getHookById(id);
      if (!existing) {
        throw new Error(`Hook ${id} not found`);
      }
      return existing;
    }

    params.push(id);
    const result = await this.pool.query(
      `UPDATE trending_hooks SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      throw new Error(`Hook ${id} not found`);
    }
    return this.mapRow(result.rows[0]);
  }

  async deleteHook(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE trending_hooks SET is_active = false WHERE id = $1',
      [id],
    );
  }

  private mapRow(row: any): TrendingHook {
    return {
      id: row.id,
      hookText: row.hook_text,
      platform: row.platform,
      category: row.category,
      sourceUrl: row.source_url,
      freshnessScore: row.freshness_score,
      usageCount: row.usage_count,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }
}
