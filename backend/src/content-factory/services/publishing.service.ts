import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export interface PublishResult {
  contentPieceId: string;
  platform: string;
  status: 'published' | 'draft_ready' | 'failed';
  externalPostId?: string;
  externalUrl?: string;
  draftPayload?: Record<string, any>;
  error?: string;
}

export interface PublishLog {
  id: string;
  contentPieceId: string;
  platform: string;
  publishStatus: string;
  externalPostId: string | null;
  externalUrl: string | null;
  draftPayload: Record<string, any> | null;
  error: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class PublishingService implements OnModuleInit {
  private readonly logger = new Logger(PublishingService.name);
  private pool: Pool;

  // API keys — null means draft mode
  private facebookToken: string | null = null;
  private instagramPageId: string | null = null;
  private linkedinToken: string | null = null;
  private linkedinPersonUrn: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const dbUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: dbUrl, max: 3 });

    this.facebookToken = this.config.get('FACEBOOK_PAGE_ACCESS_TOKEN') || null;
    this.instagramPageId = this.config.get('INSTAGRAM_PAGE_ID') || null;
    this.linkedinToken = this.config.get('LINKEDIN_ACCESS_TOKEN') || null;
    this.linkedinPersonUrn = this.config.get('LINKEDIN_PERSON_URN') || null;

    if (!this.facebookToken) this.logger.warn('FACEBOOK_PAGE_ACCESS_TOKEN not set — Instagram publishing in draft mode');
    if (!this.linkedinToken) this.logger.warn('LINKEDIN_ACCESS_TOKEN not set — LinkedIn publishing in draft mode');

    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS content_publish_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content_piece_id UUID NOT NULL,
          platform VARCHAR(50) NOT NULL,
          publish_status VARCHAR(30) NOT NULL DEFAULT 'pending',
          external_post_id VARCHAR(200),
          external_url VARCHAR(500),
          draft_payload JSONB,
          error TEXT,
          published_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_publish_log_content ON content_publish_log(content_piece_id);
        CREATE INDEX IF NOT EXISTS idx_publish_log_status ON content_publish_log(publish_status);
      `);
      this.logger.log('PublishingService initialized — content_publish_log table ready');
    } finally {
      client.release();
    }
  }

  async publishContent(contentPieceId: string, platform: string, contentJson: Record<string, any>, contentType: string): Promise<PublishResult> {
    // Check if API keys are configured for this platform
    if (platform === 'instagram' && this.facebookToken && this.instagramPageId) {
      return this.publishToInstagram(contentPieceId, contentJson, contentType);
    }
    if (platform === 'linkedin' && this.linkedinToken && this.linkedinPersonUrn) {
      return this.publishToLinkedIn(contentPieceId, contentJson);
    }

    // Draft mode — generate the payload for manual posting
    return this.generateDraftPayload(contentPieceId, platform, contentJson, contentType);
  }

  private async publishToInstagram(contentPieceId: string, contentJson: Record<string, any>, contentType: string): Promise<PublishResult> {
    try {
      // Build caption from content JSON
      const caption = this.buildInstagramCaption(contentJson, contentType);

      // For now, Instagram publishing needs a media URL (image/video hosted somewhere)
      // In draft mode equivalent, we prepare the Graph API payload
      const payload = {
        access_token: this.facebookToken,
        caption,
      };

      // If we have a media URL in the content, attempt real publish
      const mediaUrl = contentJson.media_url || contentJson.image_url || contentJson.video_url;
      if (mediaUrl) {
        // Step 1: Create container
        const createRes = await fetch(
          `https://graph.facebook.com/v22.0/${this.instagramPageId}/media`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              access_token: this.facebookToken,
              caption,
              ...(contentType === 'reel_script' ? { media_type: 'REELS', video_url: mediaUrl } : { image_url: mediaUrl }),
            }),
          },
        );
        const createData = await createRes.json();
        if (createData.error) throw new Error(createData.error.message);

        // Step 2: Publish
        const publishRes = await fetch(
          `https://graph.facebook.com/v22.0/${this.instagramPageId}/media_publish`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: this.facebookToken, creation_id: createData.id }),
          },
        );
        const publishData = await publishRes.json();
        if (publishData.error) throw new Error(publishData.error.message);

        await this.logPublish(contentPieceId, 'instagram', 'published', publishData.id, `https://www.instagram.com/p/${publishData.id}/`);
        return { contentPieceId, platform: 'instagram', status: 'published', externalPostId: publishData.id };
      }

      // No media URL — fall through to draft mode
      return this.generateDraftPayload(contentPieceId, 'instagram', contentJson, contentType);
    } catch (error: any) {
      this.logger.error(`Instagram publish failed: ${error.message}`);
      await this.logPublish(contentPieceId, 'instagram', 'failed', null, null, null, error.message);
      return { contentPieceId, platform: 'instagram', status: 'failed', error: error.message };
    }
  }

  private async publishToLinkedIn(contentPieceId: string, contentJson: Record<string, any>): Promise<PublishResult> {
    try {
      const text = this.buildLinkedInText(contentJson);

      const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.linkedinToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({
          author: this.linkedinPersonUrn,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`LinkedIn API ${res.status}: ${errBody}`);
      }

      const postId = res.headers.get('x-restli-id') || 'unknown';
      await this.logPublish(contentPieceId, 'linkedin', 'published', postId, `https://www.linkedin.com/feed/update/${postId}/`);
      return { contentPieceId, platform: 'linkedin', status: 'published', externalPostId: postId };
    } catch (error: any) {
      this.logger.error(`LinkedIn publish failed: ${error.message}`);
      await this.logPublish(contentPieceId, 'linkedin', 'failed', null, null, null, error.message);
      return { contentPieceId, platform: 'linkedin', status: 'failed', error: error.message };
    }
  }

  private async generateDraftPayload(contentPieceId: string, platform: string, contentJson: Record<string, any>, contentType: string): Promise<PublishResult> {
    let draftPayload: Record<string, any>;

    if (platform === 'instagram') {
      draftPayload = {
        platform: 'instagram',
        caption: this.buildInstagramCaption(contentJson, contentType),
        media_type: contentType === 'reel_script' ? 'REELS' : 'IMAGE',
        instructions: 'Copy the caption below and post manually via Instagram app or Meta Business Suite.',
        content_summary: contentType === 'reel_script'
          ? { scenes: contentJson.scenes?.length || 0, duration: contentJson.duration_seconds || 30 }
          : { type: contentType },
      };
    } else if (platform === 'linkedin') {
      draftPayload = {
        platform: 'linkedin',
        post_text: this.buildLinkedInText(contentJson),
        instructions: 'Copy the text below and post manually on LinkedIn.',
      };
    } else {
      draftPayload = {
        platform,
        raw_content: contentJson,
        instructions: `Copy the content and post manually on ${platform}.`,
      };
    }

    await this.logPublish(contentPieceId, platform, 'draft_ready', null, null, draftPayload);
    this.logger.log(`Draft payload generated for ${platform} (content ${contentPieceId})`);

    return { contentPieceId, platform, status: 'draft_ready', draftPayload };
  }

  private buildInstagramCaption(contentJson: Record<string, any>, contentType: string): string {
    const parts: string[] = [];

    if (contentType === 'reel_script') {
      if (contentJson.caption) parts.push(contentJson.caption);
      else if (contentJson.hook_line) parts.push(contentJson.hook_line);
    } else if (contentType === 'carousel') {
      if (contentJson.caption) parts.push(contentJson.caption);
      else if (contentJson.title) parts.push(contentJson.title);
    } else {
      if (contentJson.caption) parts.push(contentJson.caption);
      if (contentJson.body) parts.push(contentJson.body);
    }

    if (contentJson.hashtags && Array.isArray(contentJson.hashtags)) {
      parts.push('\n' + contentJson.hashtags.map((h: string) => h.startsWith('#') ? h : `#${h}`).join(' '));
    }

    return parts.join('\n\n') || JSON.stringify(contentJson);
  }

  private buildLinkedInText(contentJson: Record<string, any>): string {
    const parts: string[] = [];
    if (contentJson.headline) parts.push(contentJson.headline);
    if (contentJson.body) parts.push(contentJson.body);
    if (contentJson.cta) parts.push(contentJson.cta);
    if (contentJson.hashtags && Array.isArray(contentJson.hashtags)) {
      parts.push(contentJson.hashtags.map((h: string) => h.startsWith('#') ? h : `#${h}`).join(' '));
    }
    return parts.join('\n\n') || JSON.stringify(contentJson);
  }

  // --- Publish log ---

  private async logPublish(
    contentPieceId: string,
    platform: string,
    status: string,
    externalPostId?: string | null,
    externalUrl?: string | null,
    draftPayload?: Record<string, any> | null,
    error?: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO content_publish_log (content_piece_id, platform, publish_status, external_post_id, external_url, draft_payload, error, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [contentPieceId, platform, status, externalPostId || null, externalUrl || null, draftPayload ? JSON.stringify(draftPayload) : null, error || null, status === 'published' ? new Date() : null],
      );
    } catch (e: any) {
      this.logger.error(`Failed to log publish: ${e.message}`);
    }
  }

  async getPublishStatus(contentPieceId: string): Promise<PublishLog[]> {
    const result = await this.pool.query(
      'SELECT * FROM content_publish_log WHERE content_piece_id = $1 ORDER BY created_at DESC',
      [contentPieceId],
    );
    return result.rows.map(r => ({
      id: r.id,
      contentPieceId: r.content_piece_id,
      platform: r.platform,
      publishStatus: r.publish_status,
      externalPostId: r.external_post_id,
      externalUrl: r.external_url,
      draftPayload: r.draft_payload,
      error: r.error,
      publishedAt: r.published_at,
      createdAt: r.created_at,
    }));
  }

  async getScheduledContentDueNow(): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM content_pieces WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC`,
    );
    return result.rows;
  }
}
