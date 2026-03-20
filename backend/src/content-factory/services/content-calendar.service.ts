import { Injectable, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import {
  ContentPiece,
  CalendarEntry,
  TimeSlot,
  WeeklyPlan,
  ContentPlatform,
  ContentType,
} from '../interfaces/content-factory.interfaces';
import { LearningEngineService } from './learning-engine.service';

@Injectable()
export class ContentCalendarService implements OnModuleInit {
  private readonly logger = new Logger(ContentCalendarService.name);
  private pool: Pool;

  private static readonly OPTIMAL_TIMES: Record<string, TimeSlot[]> = {
    instagram: [
      { hour: 11, label: '11:00 AM', platform: 'instagram', reason: 'Peak lunch break browsing' },
      { hour: 19, label: '7:00 PM', platform: 'instagram', reason: 'Evening wind-down scrolling' },
      { hour: 21, label: '9:00 PM', platform: 'instagram', reason: 'Late night high engagement' },
    ],
    linkedin: [
      { hour: 8, label: '8:00 AM', platform: 'linkedin', reason: 'Morning commute reading' },
      { hour: 12, label: '12:00 PM', platform: 'linkedin', reason: 'Lunch break networking' },
      { hour: 17, label: '5:00 PM', platform: 'linkedin', reason: 'End of workday reflection' },
    ],
    youtube: [
      { hour: 14, label: '2:00 PM', platform: 'youtube', reason: 'Afternoon break viewing' },
      { hour: 20, label: '8:00 PM', platform: 'youtube', reason: 'Evening entertainment time' },
    ],
    meta_ads: [
      { hour: 10, label: '10:00 AM', platform: 'meta_ads', reason: 'Mid-morning browsing' },
      { hour: 19, label: '7:00 PM', platform: 'meta_ads', reason: 'Evening social time' },
    ],
  };

  private static readonly WEEKLY_TEMPLATE: Array<{
    dayOfWeek: string;
    suggestedType: ContentType;
    suggestedPlatform: ContentPlatform;
    rationale: string;
  }> = [
    { dayOfWeek: 'Monday', suggestedType: 'linkedin_post', suggestedPlatform: 'linkedin', rationale: 'Start the week with a business insight' },
    { dayOfWeek: 'Tuesday', suggestedType: 'reel_script', suggestedPlatform: 'instagram', rationale: 'Trending hook day' },
    { dayOfWeek: 'Wednesday', suggestedType: 'ad_copy', suggestedPlatform: 'meta_ads', rationale: 'Mid-week ad refresh' },
    { dayOfWeek: 'Thursday', suggestedType: 'carousel', suggestedPlatform: 'instagram', rationale: 'Educational carousel' },
    { dayOfWeek: 'Friday', suggestedType: 'reel_script', suggestedPlatform: 'instagram', rationale: 'Fun behind-the-scenes reel' },
    { dayOfWeek: 'Saturday', suggestedType: 'blog_seo', suggestedPlatform: 'blog', rationale: 'Rest day or bonus SEO content' },
    { dayOfWeek: 'Sunday', suggestedType: 'linkedin_post', suggestedPlatform: 'linkedin', rationale: 'Week reflection post' },
  ];

  /** Minimum posts per week by platform for gap detection */
  private static readonly PLATFORM_FREQUENCY: Record<string, number> = {
    instagram: 5,
    linkedin: 3,
    meta_ads: 2,
    youtube: 1,
    blog: 1,
    google_ads: 1,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly learningEngine: LearningEngineService,
  ) {}

  async onModuleInit() {
    const databaseUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });

    try {
      const client = await this.pool.connect();
      await client.query(`
        ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;
        CREATE INDEX IF NOT EXISTS idx_content_scheduled ON content_pieces(scheduled_at) WHERE status = 'scheduled';
      `);
      client.release();
      this.logger.log('ContentCalendarService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  async scheduleContent(contentId: string, scheduledAt: Date, platform: string): Promise<ContentPiece> {
    const result = await this.pool.query(
      `UPDATE content_pieces
       SET status = 'scheduled', scheduled_at = $2, platform = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'approved'
       RETURNING *`,
      [contentId, scheduledAt, platform],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException(
        `Content piece ${contentId} not found or not in 'approved' status`,
      );
    }

    this.logger.log(`Content ${contentId} scheduled for ${scheduledAt.toISOString()} on ${platform}`);
    return this.mapRow(result.rows[0]);
  }

  async unscheduleContent(contentId: string): Promise<ContentPiece> {
    const result = await this.pool.query(
      `UPDATE content_pieces
       SET status = 'approved', scheduled_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'scheduled'
       RETURNING *`,
      [contentId],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException(
        `Content piece ${contentId} not found or not in 'scheduled' status`,
      );
    }

    this.logger.log(`Content ${contentId} unscheduled`);
    return this.mapRow(result.rows[0]);
  }

  async getCalendar(startDate: string, endDate: string, platform?: string): Promise<CalendarEntry[]> {
    const conditions = [
      `status IN ('scheduled', 'posted')`,
      `(scheduled_at BETWEEN $1 AND $2 OR (created_at BETWEEN $1 AND $2 AND status = 'posted'))`,
    ];
    const params: any[] = [startDate, endDate];

    if (platform) {
      conditions.push(`platform = $3`);
      params.push(platform);
    }

    const result = await this.pool.query(
      `SELECT * FROM content_pieces
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(scheduled_at, created_at) ASC`,
      params,
    );

    // Group rows by date in code
    const grouped = new Map<string, ContentPiece[]>();

    for (const row of result.rows) {
      const piece = this.mapRow(row);
      const dateKey = piece.scheduledAt
        ? piece.scheduledAt.toISOString().split('T')[0]
        : piece.createdAt.toISOString().split('T')[0];

      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }
      grouped.get(dateKey)!.push(piece);
    }

    // Sort by date and return
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }));
  }

  async getOptimalTimes(platform: string, dayOfWeek?: number): Promise<TimeSlot[]> {
    // Try data-driven optimal times from learning engine
    try {
      const dataDriven = await this.learningEngine.getOptimalPostingSchedule(platform);
      if (dataDriven.length > 0 && dataDriven[0].sampleCount > 0) {
        return dataDriven.map(d => ({
          hour: d.hour,
          label: `${d.hour > 12 ? d.hour - 12 : d.hour}:00 ${d.hour >= 12 ? 'PM' : 'AM'}`,
          platform: platform as ContentPlatform,
          reason: `Data-driven: ${d.avgEngagement.toFixed(2)}% avg engagement (${d.sampleCount} posts)`,
        }));
      }
    } catch (e: any) {
      this.logger.warn(`Failed to get data-driven optimal times: ${e.message}`);
    }

    // Fallback to hardcoded times
    return ContentCalendarService.OPTIMAL_TIMES[platform] || [];
  }

  async getWeeklyPlan(weekStartDate: string): Promise<WeeklyPlan> {
    const start = new Date(weekStartDate);
    const days = ContentCalendarService.WEEKLY_TEMPLATE.map((template, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return {
        date: date.toISOString().split('T')[0],
        dayOfWeek: template.dayOfWeek,
        suggestedType: template.suggestedType,
        suggestedPlatform: template.suggestedPlatform,
        rationale: template.rationale,
      };
    });

    return {
      weekStart: weekStartDate,
      days,
    };
  }

  async getGaps(startDate: string, endDate: string): Promise<{ date: string; platforms: string[] }[]> {
    // Fetch all scheduled/posted content in range
    const result = await this.pool.query(
      `SELECT platform, DATE(COALESCE(scheduled_at, created_at)) AS content_date
       FROM content_pieces
       WHERE status IN ('scheduled', 'posted')
         AND (scheduled_at BETWEEN $1 AND $2 OR (created_at BETWEEN $1 AND $2 AND status = 'posted'))`,
      [startDate, endDate],
    );

    // Build a set of "date|platform" pairs that have content
    const coveredSet = new Set<string>();
    for (const row of result.rows) {
      const dateStr = row.content_date instanceof Date
        ? row.content_date.toISOString().split('T')[0]
        : String(row.content_date);
      coveredSet.add(`${dateStr}|${row.platform}`);
    }

    // Count how many posts each platform has in the range (for weekly frequency check)
    const platformCounts = new Map<string, number>();
    for (const row of result.rows) {
      const count = platformCounts.get(row.platform) || 0;
      platformCounts.set(row.platform, count + 1);
    }

    // Iterate each day in range and find missing platforms
    const gaps: { date: string; platforms: string[] }[] = [];
    const current = new Date(startDate);
    const end = new Date(endDate);

    // Determine total days in range for scaling weekly frequency
    const totalDays = Math.ceil((end.getTime() - current.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const weeks = Math.max(1, totalDays / 7);

    // Platforms that are under their weekly frequency target
    const underservedPlatforms: string[] = [];
    for (const [platform, weeklyTarget] of Object.entries(ContentCalendarService.PLATFORM_FREQUENCY)) {
      const actual = platformCounts.get(platform) || 0;
      const expectedTotal = weeklyTarget * weeks;
      if (actual < expectedTotal) {
        underservedPlatforms.push(platform);
      }
    }

    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay(); // 0=Sunday

      const missingPlatforms: string[] = [];

      for (const platform of underservedPlatforms) {
        // Skip weekends for linkedin
        if (platform === 'linkedin' && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

        if (!coveredSet.has(`${dateStr}|${platform}`)) {
          missingPlatforms.push(platform);
        }
      }

      if (missingPlatforms.length > 0) {
        gaps.push({ date: dateStr, platforms: missingPlatforms });
      }

      current.setDate(current.getDate() + 1);
    }

    return gaps;
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
