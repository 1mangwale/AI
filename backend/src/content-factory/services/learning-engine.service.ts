import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { ContentLearning } from '../interfaces/content-factory.interfaces';

@Injectable()
export class LearningEngineService implements OnModuleInit {
  private readonly logger = new Logger(LearningEngineService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const dbUrl = this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pool = new Pool({ connectionString: dbUrl, max: 3 });

    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS content_learnings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          learning_type VARCHAR(50) NOT NULL,
          dimension VARCHAR(100) NOT NULL,
          dimension_value VARCHAR(200) NOT NULL,
          insight TEXT NOT NULL,
          confidence DECIMAL(4,2) DEFAULT 0,
          evidence JSONB DEFAULT '{}',
          auto_generated BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_learnings_type ON content_learnings(learning_type);
        CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON content_learnings(confidence DESC);
      `);
      this.logger.log('LearningEngineService initialized — content_learnings table ready');
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Analyze performance — discover patterns from analytics data
  // ---------------------------------------------------------------------------

  async analyzePerformance(): Promise<{ learningsGenerated: number }> {
    let learningsGenerated = 0;

    try {
      // Clear old auto-generated learnings (keep manual ones)
      await this.pool.query(`DELETE FROM content_learnings WHERE auto_generated = true`);

      // 1. Best content type by engagement
      learningsGenerated += await this.analyzeByDimension(
        'best_type',
        'content_type',
        `SELECT cp.content_type AS dimension_value,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         JOIN content_pieces cp ON cp.id = pa.content_piece_id
         GROUP BY cp.content_type
         HAVING COUNT(*) >= 3
         ORDER BY avg_engagement DESC`,
      );

      // 2. Best platform by engagement
      learningsGenerated += await this.analyzeByDimension(
        'best_platform',
        'platform',
        `SELECT pa.platform AS dimension_value,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         GROUP BY pa.platform
         HAVING COUNT(*) >= 3
         ORDER BY avg_engagement DESC`,
      );

      // 3. Best posting hour by engagement
      learningsGenerated += await this.analyzeByDimension(
        'best_time',
        'hour',
        `SELECT EXTRACT(HOUR FROM cp.scheduled_at)::text AS dimension_value,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         JOIN content_pieces cp ON cp.id = pa.content_piece_id
         WHERE cp.scheduled_at IS NOT NULL
         GROUP BY EXTRACT(HOUR FROM cp.scheduled_at)
         HAVING COUNT(*) >= 2
         ORDER BY avg_engagement DESC`,
      );

      // 4. Best day of week by engagement
      learningsGenerated += await this.analyzeByDimension(
        'best_day',
        'day_of_week',
        `SELECT EXTRACT(DOW FROM cp.scheduled_at)::text AS dimension_value,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         JOIN content_pieces cp ON cp.id = pa.content_piece_id
         WHERE cp.scheduled_at IS NOT NULL
         GROUP BY EXTRACT(DOW FROM cp.scheduled_at)
         HAVING COUNT(*) >= 2
         ORDER BY avg_engagement DESC`,
      );

      // 5. Best hook category by engagement
      learningsGenerated += await this.analyzeByDimension(
        'best_hook',
        'hook_category',
        `SELECT th.category AS dimension_value,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         JOIN content_pieces cp ON cp.id = pa.content_piece_id
         JOIN trending_hooks th ON th.id = cp.hook_id
         WHERE cp.hook_id IS NOT NULL
         GROUP BY th.category
         HAVING COUNT(*) >= 2
         ORDER BY avg_engagement DESC`,
      );

      // 6. Engagement patterns — identify low performers
      try {
        const lowResult = await this.pool.query(`
          SELECT cp.content_type, pa.platform, pa.engagement_rate
          FROM post_analytics pa
          JOIN content_pieces cp ON cp.id = pa.content_piece_id
          WHERE pa.engagement_rate < 1.0 AND pa.impressions > 100
          ORDER BY pa.engagement_rate ASC
          LIMIT 5
        `);

        if (lowResult.rows.length > 0) {
          const lowTypes = [...new Set(lowResult.rows.map(r => r.content_type))];
          await this.insertLearning(
            'engagement_pattern',
            'low_engagement',
            lowTypes.join(', '),
            `Content types with consistently low engagement (<1%): ${lowTypes.join(', ')}. Consider adjusting tone, hooks, or posting times for these types.`,
            0.6,
            { lowPerformers: lowResult.rows },
          );
          learningsGenerated++;
        }
      } catch (error: any) {
        this.logger.warn(`Low engagement analysis failed: ${error.message}`);
      }

      this.logger.log(`Performance analysis complete: ${learningsGenerated} learnings generated`);
    } catch (error: any) {
      this.logger.error(`analyzePerformance failed: ${error.message}`);
    }

    return { learningsGenerated };
  }

  private async analyzeByDimension(learningType: string, dimension: string, query: string): Promise<number> {
    let count = 0;
    try {
      const result = await this.pool.query(query);
      const rows = result.rows;

      if (rows.length === 0) return 0;

      // Top performer
      const top = rows[0];
      const confidence = Math.min(0.99, 0.5 + (parseInt(top.sample_count) / 50));
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      let displayValue = top.dimension_value;
      if (dimension === 'day_of_week') {
        displayValue = dayNames[parseInt(top.dimension_value)] || top.dimension_value;
      } else if (dimension === 'hour') {
        const hour = parseInt(top.dimension_value);
        displayValue = `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
      }

      await this.insertLearning(
        learningType,
        dimension,
        top.dimension_value,
        `Best performing ${dimension}: ${displayValue} with ${parseFloat(top.avg_engagement).toFixed(2)}% avg engagement (${top.sample_count} posts).`,
        confidence,
        { allValues: rows.map(r => ({ value: r.dimension_value, avgEngagement: parseFloat(r.avg_engagement), sampleCount: parseInt(r.sample_count) })) },
      );
      count++;

      // Bottom performer (if we have at least 2 dimensions)
      if (rows.length >= 2) {
        const bottom = rows[rows.length - 1];
        let bottomDisplay = bottom.dimension_value;
        if (dimension === 'day_of_week') {
          bottomDisplay = dayNames[parseInt(bottom.dimension_value)] || bottom.dimension_value;
        } else if (dimension === 'hour') {
          const hour = parseInt(bottom.dimension_value);
          bottomDisplay = `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
        }

        await this.insertLearning(
          learningType,
          dimension,
          `worst_${bottom.dimension_value}`,
          `Lowest performing ${dimension}: ${bottomDisplay} with ${parseFloat(bottom.avg_engagement).toFixed(2)}% avg engagement (${bottom.sample_count} posts). Consider avoiding or improving content for this ${dimension}.`,
          Math.min(0.99, 0.4 + (parseInt(bottom.sample_count) / 50)),
          { value: bottom.dimension_value, avgEngagement: parseFloat(bottom.avg_engagement), sampleCount: parseInt(bottom.sample_count) },
        );
        count++;
      }
    } catch (error: any) {
      this.logger.warn(`analyzeByDimension(${learningType}) failed: ${error.message}`);
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Optimal posting schedule — data-driven or fallback
  // ---------------------------------------------------------------------------

  async getOptimalPostingSchedule(platform: string): Promise<{ hour: number; avgEngagement: number; sampleCount: number }[]> {
    try {
      const result = await this.pool.query(
        `SELECT EXTRACT(HOUR FROM cp.scheduled_at)::int AS hour,
                AVG(pa.engagement_rate) AS avg_engagement,
                COUNT(*) AS sample_count
         FROM post_analytics pa
         JOIN content_pieces cp ON cp.id = pa.content_piece_id
         WHERE cp.scheduled_at IS NOT NULL AND pa.platform = $1
         GROUP BY EXTRACT(HOUR FROM cp.scheduled_at)
         ORDER BY avg_engagement DESC`,
        [platform],
      );

      const totalSamples = result.rows.reduce((sum, r) => sum + parseInt(r.sample_count), 0);

      // If we have enough data (>=20 samples), use data-driven schedule
      if (totalSamples >= 20 && result.rows.length >= 2) {
        return result.rows.slice(0, 3).map(r => ({
          hour: parseInt(r.hour),
          avgEngagement: parseFloat(r.avg_engagement),
          sampleCount: parseInt(r.sample_count),
        }));
      }

      // Fallback to hardcoded optimal times
      return this.getHardcodedOptimalTimes(platform);
    } catch (error: any) {
      this.logger.warn(`getOptimalPostingSchedule failed: ${error.message}`);
      return this.getHardcodedOptimalTimes(platform);
    }
  }

  private getHardcodedOptimalTimes(platform: string): { hour: number; avgEngagement: number; sampleCount: number }[] {
    const defaults: Record<string, number[]> = {
      instagram: [11, 19, 21],
      linkedin: [8, 12, 17],
      youtube: [14, 20],
      meta_ads: [10, 19],
    };

    const hours = defaults[platform] || [10, 14, 19];
    return hours.map(h => ({ hour: h, avgEngagement: 0, sampleCount: 0 }));
  }

  // ---------------------------------------------------------------------------
  // Suggest content strategy — actionable insights
  // ---------------------------------------------------------------------------

  async suggestContentStrategy(): Promise<ContentLearning[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM content_learnings ORDER BY confidence DESC, created_at DESC`,
      );
      return result.rows.map(r => this.mapRow(r));
    } catch (error: any) {
      this.logger.error(`suggestContentStrategy failed: ${error.message}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Enrich prompt with learnings — inject insights into content generation
  // ---------------------------------------------------------------------------

  async enrichPromptWithLearnings(contentType: string, platform: string): Promise<string> {
    try {
      const result = await this.pool.query(
        `SELECT insight FROM content_learnings
         WHERE (dimension_value = $1 OR dimension_value = $2
                OR learning_type IN ('best_time', 'best_hook', 'engagement_pattern'))
         ORDER BY confidence DESC
         LIMIT 5`,
        [contentType, platform],
      );

      if (result.rows.length === 0) {
        return '';
      }

      const insights = result.rows.map((r, i) => `${i + 1}. ${r.insight}`).join('\n');
      return `\n\nPERFORMANCE INSIGHTS (use these to optimize the content):\n${insights}`;
    } catch (error: any) {
      this.logger.warn(`enrichPromptWithLearnings failed: ${error.message}`);
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Get learnings list
  // ---------------------------------------------------------------------------

  async getLearnings(limit?: number): Promise<ContentLearning[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM content_learnings ORDER BY confidence DESC, created_at DESC LIMIT $1',
        [limit || 50],
      );
      return result.rows.map(r => this.mapRow(r));
    } catch (error: any) {
      this.logger.error(`getLearnings failed: ${error.message}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Insert helper
  // ---------------------------------------------------------------------------

  private async insertLearning(
    learningType: string,
    dimension: string,
    dimensionValue: string,
    insight: string,
    confidence: number,
    evidence: Record<string, any>,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO content_learnings (learning_type, dimension, dimension_value, insight, confidence, evidence, auto_generated)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [learningType, dimension, dimensionValue, insight, confidence, JSON.stringify(evidence)],
      );
    } catch (error: any) {
      this.logger.error(`insertLearning failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Row mapper
  // ---------------------------------------------------------------------------

  private mapRow(row: any): ContentLearning {
    return {
      id: row.id,
      learningType: row.learning_type,
      dimension: row.dimension,
      dimensionValue: row.dimension_value,
      insight: row.insight,
      confidence: parseFloat(row.confidence) || 0,
      evidence: row.evidence || {},
      autoGenerated: row.auto_generated,
      createdAt: row.created_at,
    };
  }
}
