import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AiPrompt } from '../interfaces/content-factory.interfaces';

@Injectable()
export class PromptService implements OnModuleInit {
  private readonly logger = new Logger(PromptService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_prompts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(200) NOT NULL,
          content_type VARCHAR(50) NOT NULL,
          platform VARCHAR(50) NOT NULL,
          system_prompt TEXT NOT NULL,
          user_prompt_template TEXT NOT NULL,
          version INTEGER DEFAULT 1,
          is_active BOOLEAN DEFAULT true,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_name_version ON ai_prompts(name, version);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_active_unique ON ai_prompts(content_type, platform) WHERE is_active = true;
      `);
      client.release();

      // Seed default prompts if table is empty
      const countResult = await this.pool.query('SELECT COUNT(*)::int AS count FROM ai_prompts');
      if (countResult.rows[0].count === 0) {
        await this.seedDefaultPrompts();
      }

      this.logger.log('PromptService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async getActivePrompt(contentType: string, platform: string): Promise<AiPrompt | null> {
    const result = await this.pool.query(
      `SELECT * FROM ai_prompts
       WHERE content_type = $1 AND platform = $2 AND is_active = true
       ORDER BY version DESC LIMIT 1`,
      [contentType, platform],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async createPrompt(data: {
    name: string;
    contentType: string;
    platform: string;
    systemPrompt: string;
    userPromptTemplate: string;
    metadata?: Record<string, any>;
  }): Promise<AiPrompt> {
    // Auto-calculate version as max(version)+1 for same name
    const versionResult = await this.pool.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM ai_prompts WHERE name = $1',
      [data.name],
    );
    const nextVersion = versionResult.rows[0].next_version;

    const result = await this.pool.query(
      `INSERT INTO ai_prompts (name, content_type, platform, system_prompt, user_prompt_template, version, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.name,
        data.contentType,
        data.platform,
        data.systemPrompt,
        data.userPromptTemplate,
        nextVersion,
        JSON.stringify(data.metadata || {}),
      ],
    );

    this.logger.log(`Prompt created: ${data.name} v${nextVersion}`);
    return this.mapRow(result.rows[0]);
  }

  async updatePrompt(
    id: string,
    data: Partial<{
      name: string;
      systemPrompt: string;
      userPromptTemplate: string;
      metadata: Record<string, any>;
    }>,
  ): Promise<AiPrompt> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (data.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      params.push(data.name);
    }
    if (data.systemPrompt !== undefined) {
      setClauses.push(`system_prompt = $${paramIdx++}`);
      params.push(data.systemPrompt);
    }
    if (data.userPromptTemplate !== undefined) {
      setClauses.push(`user_prompt_template = $${paramIdx++}`);
      params.push(data.userPromptTemplate);
    }
    if (data.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIdx++}`);
      params.push(JSON.stringify(data.metadata));
    }

    if (setClauses.length === 0) {
      const existing = await this.pool.query('SELECT * FROM ai_prompts WHERE id = $1', [id]);
      return existing.rows[0] ? this.mapRow(existing.rows[0]) : null;
    }

    params.push(id);

    const result = await this.pool.query(
      `UPDATE ai_prompts SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );

    this.logger.log(`Prompt updated: ${id}`);
    return this.mapRow(result.rows[0]);
  }

  async listPrompts(contentType?: string): Promise<AiPrompt[]> {
    let query = 'SELECT * FROM ai_prompts';
    const params: any[] = [];

    if (contentType) {
      query += ' WHERE content_type = $1';
      params.push(contentType);
    }

    query += ' ORDER BY content_type, platform, version DESC';

    const result = await this.pool.query(query, params);
    return result.rows.map(r => this.mapRow(r));
  }

  async activateVersion(id: string): Promise<void> {
    // First get the prompt's content_type and platform
    const promptResult = await this.pool.query(
      'SELECT content_type, platform FROM ai_prompts WHERE id = $1',
      [id],
    );

    if (promptResult.rows.length === 0) {
      throw new Error(`Prompt not found: ${id}`);
    }

    const { content_type, platform } = promptResult.rows[0];

    // Deactivate all prompts with same content_type + platform
    await this.pool.query(
      'UPDATE ai_prompts SET is_active = false WHERE content_type = $1 AND platform = $2',
      [content_type, platform],
    );

    // Activate the specified prompt
    await this.pool.query(
      'UPDATE ai_prompts SET is_active = true WHERE id = $1',
      [id],
    );

    this.logger.log(`Activated prompt ${id} for ${content_type}/${platform}`);
  }

  private mapRow(row: any): AiPrompt {
    return {
      id: row.id,
      name: row.name,
      contentType: row.content_type,
      platform: row.platform,
      systemPrompt: row.system_prompt,
      userPromptTemplate: row.user_prompt_template,
      version: row.version,
      isActive: row.is_active,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private async seedDefaultPrompts(): Promise<void> {
    this.logger.log('Seeding default AI prompts...');

    const defaults = [
      {
        name: 'reel_script_instagram_v1',
        content_type: 'reel_script',
        platform: 'instagram',
        system_prompt: 'You are a viral content strategist for Mangwale, a hyperlocal delivery app in Nashik, India. You create Instagram Reel scripts that hook viewers in the first 2 seconds, use trending formats authentically, integrate real business data naturally, feel local and relatable to Nashik audience, and drive app downloads without being salesy. Brand voice: Young, energetic, proudly local, slightly cheeky, anti-corporate. NEVER: Generic startup speak, fake urgency, clickbait without substance.',
        user_prompt_template: `Create a 30-second Instagram Reel script for Mangwale.

{{#if hook}}TRENDING HOOK TO ADAPT:
{{hook}}
{{/if}}

{{#if business_data}}TODAY'S BUSINESS DATA:
{{business_data}}
{{/if}}

CONTENT FOCUS: {{vertical}} vertical
TONE: {{tone}}
LANGUAGE: {{language}}

{{#if additional}}ADDITIONAL INSTRUCTIONS:
{{additional}}
{{/if}}

Generate a reel script with:
1. Hook (0-3 sec): Pattern interrupt or POV that stops scrolling
2. Scene 1 (3-12 sec): Setup the scenario
3. Scene 2 (12-22 sec): Show the Mangwale solution
4. Scene 3 (22-27 sec): Proof point using real data
5. CTA (27-30 sec): Clear next step

Respond with ONLY a JSON object:
{
  "hook_line": "...",
  "scenes": [
    {"scene_num": 1, "duration_sec": 3, "visual": "...", "voiceover": "...", "text_overlay": "..."},
    ...
  ],
  "caption": "...",
  "hashtags": ["..."],
  "audio_suggestion": "...",
  "duration_seconds": 30,
  "visual_style": "..."
}`,
      },
      {
        name: 'linkedin_post_v1',
        content_type: 'linkedin_post',
        platform: 'linkedin',
        system_prompt: 'You are the founder of Mangwale, a hyperlocal delivery startup in Nashik, India. You write LinkedIn posts that share genuine insights from building a local-first delivery platform in a Tier-2 Indian city. Your voice: Thoughtful but not preachy, data-informed but human, celebrates small wins authentically, shares real challenges not just successes, speaks to founders, local business owners, and curious observers. Format: Short paragraphs (1-2 sentences max), line breaks between thoughts, one key insight per post, end with a question or invitation to discuss.',
        user_prompt_template: `Write a LinkedIn post for the Mangwale founder account.

{{#if business_data}}THIS WEEK'S HIGHLIGHTS:
{{business_data}}
{{/if}}

ANGLE: {{tone}}
LANGUAGE: {{language}}

{{#if additional}}ADDITIONAL CONTEXT:
{{additional}}
{{/if}}

Respond with ONLY a JSON object:
{
  "headline": "Opening hook line",
  "body": "Full post body with line breaks",
  "closing_cta": "Engagement prompt or question",
  "hashtags": ["..."],
  "key_insight": "One sentence summary of the insight"
}`,
      },
      {
        name: 'ad_copy_meta_v1',
        content_type: 'ad_copy',
        platform: 'meta_ads',
        system_prompt: 'You are a performance marketing expert creating Meta ad copy for Mangwale, a hyperlocal delivery app in Nashik. Your ads stop the scroll with local relevance, communicate value in under 3 seconds, drive app installs or store partner signups. Constraints: Headline max 40 chars, Primary text 125 chars optimal, Description max 30 chars.',
        user_prompt_template: `Create Meta ad copy for Mangwale.

OBJECTIVE: {{tone}}

{{#if business_data}}KEY DATA POINTS:
{{business_data}}
{{/if}}

{{#if additional}}CONTEXT:
{{additional}}
{{/if}}

Generate 3 variations. Respond with ONLY a JSON object:
{
  "variations": [
    {
      "variation_id": "A",
      "angle": "speed/convenience",
      "headline": "max 40 chars",
      "primary_text": "125 chars optimal",
      "description": "max 30 chars",
      "cta_button": "Install Now"
    },
    ...
  ]
}`,
      },
      {
        name: 'ad_copy_google_v1',
        content_type: 'ad_copy',
        platform: 'google_ads',
        system_prompt: 'You are a Google Ads specialist creating search and display ads for Mangwale, a delivery app in Nashik. Google Ads constraints: Headlines max 30 chars each (need 3+), Descriptions max 90 chars each (need 2+). Focus on local intent and delivery keywords.',
        user_prompt_template: `Create Google Ads copy for Mangwale.

{{#if business_data}}DATA POINTS:
{{business_data}}
{{/if}}

{{#if additional}}CONTEXT:
{{additional}}
{{/if}}

Respond with ONLY a JSON object:
{
  "headlines": ["max 30 chars each", "...", "..."],
  "descriptions": ["max 90 chars each", "..."],
  "path_texts": ["nashik", "delivery"]
}`,
      },
      {
        name: 'carousel_instagram_v1',
        content_type: 'carousel',
        platform: 'instagram',
        system_prompt: 'You are a visual content creator for Mangwale, a hyperlocal delivery app in Nashik. You create Instagram carousel posts that educate, tell stories, or present data in visually engaging slides. Each slide should have a clear headline and concise body. Brand voice: Young, energetic, proudly local.',
        user_prompt_template: `Create an Instagram carousel post for Mangwale.

{{#if business_data}}BUSINESS DATA:
{{business_data}}
{{/if}}

TOPIC: {{tone}}
LANGUAGE: {{language}}

{{#if hook}}HOOK INSPIRATION:
{{hook}}
{{/if}}

{{#if additional}}ADDITIONAL:
{{additional}}
{{/if}}

Respond with ONLY a JSON object:
{
  "slides": [
    {"slide_num": 1, "headline": "...", "body": "...", "visual_description": "..."},
    ...
  ],
  "caption": "...",
  "hashtags": ["..."]
}`,
      },
    ];

    for (const prompt of defaults) {
      await this.pool.query(
        `INSERT INTO ai_prompts (name, content_type, platform, system_prompt, user_prompt_template)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, version) DO NOTHING`,
        [prompt.name, prompt.content_type, prompt.platform, prompt.system_prompt, prompt.user_prompt_template],
      );
    }

    this.logger.log(`Seeded ${defaults.length} default AI prompts`);
  }
}
