import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

interface ResponseTemplateConfig {
  name: string;
  intent: string;
  language: string;
  template: string;
  variables: string[];
  priority: number;
  conditions?: Record<string, any>;
}

@Injectable()
export class ResponseTemplateService {
  private readonly logger = new Logger(ResponseTemplateService.name);
  private templateCache: Map<string, ResponseTemplateConfig[]> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get response templates for an intent
   */
  async getTemplatesForIntent(intent: string, language: string = 'hi-en'): Promise<ResponseTemplateConfig[]> {
    await this.refreshCacheIfNeeded();

    const cacheKey = `${intent}:${language}`;
    if (this.templateCache.has(cacheKey)) {
      return this.templateCache.get(cacheKey)!;
    }

    try {
      const templates = await this.prisma.responseTemplate.findMany({
        where: {
          intent,
          language,
          isActive: true,
        },
        orderBy: { priority: 'desc' },
      });

      const configs: ResponseTemplateConfig[] = templates.map(t => ({
        name: t.name,
        intent: t.intent,
        language: t.language,
        template: t.template,
        variables: t.variables,
        priority: t.priority,
        conditions: (t as any).conditions as Record<string, any> | undefined,
      }));

      this.templateCache.set(cacheKey, configs);
      return configs;
    } catch (error) {
      this.logger.warn(`Failed to fetch templates for ${intent}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get a single response for an intent with variable interpolation
   */
  async getResponse(
    intent: string,
    variables: Record<string, string> = {},
    context: Record<string, any> = {},
    language: string = 'hi-en',
  ): Promise<string | null> {
    const templates = await this.getTemplatesForIntent(intent, language);

    if (templates.length === 0) {
      this.logger.debug(`No templates found for intent: ${intent}`);
      return null;
    }

    // Find matching template based on conditions
    const matchingTemplate = templates.find(t => {
      if (!t.conditions || Object.keys(t.conditions).length === 0) {
        return true;
      }

      // Check all conditions
      return Object.entries(t.conditions).every(([key, expectedValue]) => {
        return context[key] === expectedValue;
      });
    });

    if (!matchingTemplate) {
      // Use first template (highest priority) as fallback
      const fallback = templates[0];
      return this.interpolateTemplate(fallback.template, variables);
    }

    return this.interpolateTemplate(matchingTemplate.template, variables);
  }

  /**
   * Get all response templates (for admin UI)
   */
  async getAllTemplates(): Promise<ResponseTemplateConfig[]> {
    try {
      const templates = await this.prisma.responseTemplate.findMany({
        orderBy: [{ intent: 'asc' }, { priority: 'desc' }],
      });

      return templates.map(t => ({
        name: t.name,
        intent: t.intent,
        language: t.language,
        template: t.template,
        variables: t.variables,
        priority: t.priority,
        conditions: (t as any).conditions as Record<string, any> | undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to fetch all templates: ${error.message}`);
      return [];
    }
  }

  /**
   * Interpolate variables into template
   */
  private interpolateTemplate(template: string, variables: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * Refresh cache if expired
   */
  private async refreshCacheIfNeeded(): Promise<void> {
    if (Date.now() - this.cacheTimestamp > this.CACHE_TTL) {
      this.templateCache.clear();
      this.cacheTimestamp = Date.now();
    }
  }

  /**
   * Clear cache (for testing or manual refresh)
   */
  clearCache(): void {
    this.templateCache.clear();
    this.cacheTimestamp = 0;
  }
}
