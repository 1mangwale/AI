import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import axios from 'axios';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Get a setting value, falling back to ConfigService (Env) if not in DB
   */
  async getSetting(key: string, defaultValue?: string): Promise<string> {
    // Try DB lookup if systemSettings table exists
    try {
      const dbSetting = await (this.prisma as any).systemSettings?.findUnique({
        where: { key },
      });
      if (dbSetting) {
        return dbSetting.value;
      }
    } catch {
      // systemSettings table may not exist — fall through to env
    }

    // Fallback to env var (convert key to UPPER_SNAKE_CASE)
    const envKey = key.toUpperCase().replace(/-/g, '_');
    return this.config.get(envKey) || defaultValue || '';
  }

  /**
   * Get all settings for the dashboard
   */
  /**
   * Sent in place of a secret's value by getAllSettings. Also refused by
   * updateSettings, so a client that renders the mask into an input and saves
   * the form cannot overwrite the real secret with these characters.
   */
  static readonly SECRET_MASK = '********';

  async getAllSettings() {
    let settings: any[] = [];
    try {
      settings = await (this.prisma as any).systemSettings?.findMany() || [];
    } catch {
      // systemSettings table may not exist
    }
    
    // Map to a friendly object or array
    // We also want to include values from Env if they aren't in DB yet
    const keysOfInterest = [
      'LABEL_STUDIO_URL', 'LABEL_STUDIO_API_KEY',
      'ASR_SERVICE_URL', 'TTS_SERVICE_URL', 'MINIO_ENDPOINT',
      'SYSTEM_PROMPT',
      'ACTIVE_CHATBOT_PERSONA',
      'PERSONA_CHOTU_IMAGE'
    ];

    const result = [];

    for (const key of keysOfInterest) {
      const dbKey = key.toLowerCase().replace(/_/g, '-'); // e.g. label-studio-url
      const dbSetting = settings.find(s => s.key === dbKey);
      
      const rawValue = dbSetting ? dbSetting.value : (this.config.get(key) || '');
      const isSecret = key.includes('KEY') || key.includes('TOKEN') || key.includes('PASSWORD');

      result.push({
        key: dbKey,
        // A secret value never leaves the process. This list is not in
        // GlobalAuthGuard's ALWAYS_ENFORCED_PREFIXES, so under
        // GLOBAL_AUTH_MODE=shadow an anonymous GET /api/settings was served
        // label-studio-api-key in full - the row even declared isSecret: true
        // and returned the bytes anyway. Callers only need to know whether a
        // secret is configured, which isSet answers.
        value: isSecret && rawValue ? SettingsService.SECRET_MASK : rawValue,
        isSecret,
        isSet: Boolean(rawValue),
        source: dbSetting ? 'database' : 'env'
      });
    }

    return result;
  }

  /**
   * Update settings
   */
  async updateSettings(settings: Array<{ key: string; value: string }>) {
    const results = [];
    for (const setting of settings) {
      if (setting.value === SettingsService.SECRET_MASK) {
        // The caller is echoing back the mask from getAllSettings, not a new
        // secret. Writing it would destroy the stored credential.
        results.push({ key: setting.key, success: false, error: 'Masked value ignored' });
        continue;
      }
      try {
        await (this.prisma as any).systemSettings?.upsert({
          where: { key: setting.key },
          update: {
            value: setting.value,
            updatedAt: new Date(),
            updatedBy: 'admin'
          },
          create: {
            key: setting.key,
            value: setting.value,
            type: 'string',
            isSecret: setting.key.includes('key') || setting.key.includes('token'),
            updatedBy: 'admin'
          }
        });
        results.push({ key: setting.key, success: true });
      } catch (error) {
        this.logger.error(`Failed to update ${setting.key}: ${error.message}`);
        results.push({ key: setting.key, success: false, error: error.message });
      }
    }
    return results;
  }

  async testLabelStudio() {
    const url = await this.getSetting('label-studio-url', 'http://localhost:8080');
    const apiKey = await this.getSetting('label-studio-api-key');
    
    try {
      const response = await axios.get(`${url}/api/projects`, {
        headers: { Authorization: `Token ${apiKey}` },
        timeout: 5000
      });
      return { ok: true, projectsCount: response.data.count };
    } catch (error) {
      this.logger.error(`Label Studio test failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async testAsr() {
    const url = await this.getSetting(
      'asr-service-url',
      this.config.get('ASR_SERVICE_URL', 'http://localhost:7001'),
    );
    try {
      const response = await axios.get(`${url}/health`, { timeout: 5000 });
      return { 
        ok: true, 
        success: true,
        message: 'ASR Service is healthy',
        service: response.data?.service || 'asr',
        providers: response.data?.providers || {},
        latency: response.data?.gpu_available ? 'GPU' : 'CPU'
      };
    } catch (error) {
      this.logger.error(`ASR test failed: ${error.message}`);
      return { ok: false, success: false, error: error.message };
    }
  }

  async testTts() {
    const url = await this.getSetting(
      'tts-service-url',
      this.config.get('TTS_SERVICE_URL', 'http://localhost:7002'),
    );
    try {
      const response = await axios.get(`${url}/health`, { timeout: 5000 });
      return { 
        ok: true, 
        success: true,
        message: 'TTS Service is healthy',
        service: response.data?.service || 'tts',
        providers: response.data?.providers || {},
        latency: response.data?.gpu_available ? 'GPU' : 'CPU'
      };
    } catch (error) {
      this.logger.error(`TTS test failed: ${error.message}`);
      return { ok: false, success: false, error: error.message };
    }
  }

  async testNlu() {
    const url = await this.getSetting(
      'nlu-service-url',
      this.config.get('NLU_SERVICE_URL', 'http://192.168.0.151:7012'),
    );
    try {
      const response = await axios.get(`${url}/health`, { timeout: 5000 });
      return {
        ok: true,
        success: true,
        message: 'NLU Service is healthy',
        provider: 'IndicBERTv2',
        model: response.data?.model || 'indicbert_active',
        latency: response.data?.latency || 0,
      };
    } catch (error) {
      this.logger.error(`NLU test failed: ${error.message}`);
      return { ok: false, success: false, error: error.message };
    }
  }

  async testLlm() {
    const url = await this.getSetting(
      'vllm-url',
      this.config.get('VLLM_URL', 'http://localhost:8002'),
    );
    try {
      const response = await axios.get(`${url}/v1/models`, { timeout: 5000 });
      const models = response.data?.data || [];
      return {
        ok: true,
        success: true,
        message: 'LLM Service is healthy',
        provider: 'vLLM',
        model: models[0]?.id || 'unknown',
        latency: 0,
      };
    } catch (error) {
      this.logger.error(`LLM test failed: ${error.message}`);
      return { ok: false, success: false, error: error.message };
    }
  }

  async testMinio() {
    const endpoint = await this.getSetting('minio-endpoint', 'minio:9000');
    // Minio health check usually at /minio/health/live
    // Since endpoint might be just host:port, we need to construct url
    const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
    
    try {
      await axios.get(`${url}/minio/health/live`, { timeout: 5000 });
      return { ok: true, message: 'Minio is reachable' };
    } catch (error) {
      this.logger.error(`Minio test failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }
}
