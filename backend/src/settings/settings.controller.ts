import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getAllSettings() {
    return this.settingsService.getAllSettings();
  }

  @Put()
  async updateSettings(@Body() body: { settings: Array<{ key: string; value: string }> }) {
    return this.settingsService.updateSettings(body.settings);
  }

  /**
   * GET /settings/agent — Agent personality/tone settings
   */
  @Get('agent')
  async getAgentSettings() {
    const raw = await this.settingsService.getSetting('agent-settings', '');
    if (raw) {
      try { return JSON.parse(raw); } catch {}
    }
    // Return defaults
    return {
      tone: {
        personality: 'friendly',
        enthusiasm: 70,
        empathy: 80,
        humor: 40,
        formality: 50,
        verbosity: 'balanced',
        emoji: true,
        greetingStyle: 'warm',
      },
      language: {
        defaultLanguage: 'hi',
        supportedLanguages: ['en', 'hi', 'mr'],
        autoDetect: true,
        translationEnabled: true,
        regionalVariants: true,
      },
      response: {
        maxLength: 500,
        includeEmoji: true,
        useMarkdown: false,
        suggestFollowUps: true,
        acknowledgeFirst: true,
        useUserName: true,
      },
      voice: {
        ttsVoice: 'chotu',
        speechRate: 1.0,
        pitch: 1.0,
        emphasis: 'medium',
      },
    };
  }

  /**
   * POST /settings/agent — Save agent personality/tone settings
   */
  @Post('agent')
  async updateAgentSettings(@Body() body: Record<string, unknown>) {
    await this.settingsService.updateSettings([
      { key: 'agent-settings', value: JSON.stringify(body) },
    ]);
    return { success: true, message: 'Agent settings saved' };
  }

  @Get('labelstudio/test')
  async testLabelStudio() {
    return this.settingsService.testLabelStudio();
  }

  @Get('asr/test')
  async testAsr() {
    return this.settingsService.testAsr();
  }

  @Get('tts/test')
  async testTts() {
    return this.settingsService.testTts();
  }

  @Get('nlu/test')
  async testNlu() {
    return this.settingsService.testNlu();
  }

  @Get('llm/test')
  async testLlm() {
    return this.settingsService.testLlm();
  }

  @Get('minio/test')
  async testMinio() {
    return this.settingsService.testMinio();
  }

  /**
   * A setting is looked up by exact name, so this route hands out whatever name
   * the caller can guess -- ADMIN_API_KEY included, which is how an anonymous
   * request read the platform's admin credential on 2026-08-16.
   *
   * Secret-shaped names are refused here as well as in GlobalAuthGuard, because
   * the guard's behaviour depends on GLOBAL_AUTH_MODE and a credential leak
   * should not be one env var away from returning.
   */
  private static readonly SECRET_SHAPED_NAME =
    /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|DSN|PRIVATE)/i;

  @Get('key/:key')
  async getSetting(@Param('key') key: string) {
    if (SettingsController.SECRET_SHAPED_NAME.test(key)) {
      throw new ForbiddenException(
        'Secret-valued settings cannot be read through the settings API',
      );
    }
    const value = await this.settingsService.getSetting(key);
    return { key, value };
  }

  @Put('key/:key')
  async updateSetting(@Param('key') key: string, @Body() body: { value: string }) {
    if (SettingsController.SECRET_SHAPED_NAME.test(key)) {
      throw new ForbiddenException(
        'Secret-valued settings cannot be written through the settings API',
      );
    }
    await this.settingsService.updateSettings([{ key, value: body.value }]);
    return { key, value: body.value, success: true };
  }
}
