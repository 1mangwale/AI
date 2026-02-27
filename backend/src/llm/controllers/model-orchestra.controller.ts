import { Controller, Get, Post, Body } from '@nestjs/common';
import { SmartModelRouterService } from '../services/smart-model-router.service';
import { CloudLlmService } from '../services/cloud-llm.service';

@Controller('mos/models')
export class ModelOrchestraController {
  constructor(
    private readonly router: SmartModelRouterService,
    private readonly cloudLlm: CloudLlmService,
  ) {}

  @Get('orchestra')
  async getModelProfiles() {
    return this.router.getModelProfiles();
  }

  @Get('orchestra/stats')
  async getStats() {
    return this.router.getStats();
  }

  @Post('orchestra/test')
  async testProvider(@Body() body: { provider: string; prompt: string; model?: string }) {
    const dto = {
      messages: [
        { role: 'system' as const, content: 'You are a helpful assistant.' },
        { role: 'user' as const, content: body.prompt },
      ],
      model: body.model,
      temperature: 0.7,
      maxTokens: 256,
    };

    switch (body.provider) {
      case 'openai':
        return this.cloudLlm.chatOpenAI(dto);
      case 'groq':
        return this.cloudLlm.chatGroq(dto);
      case 'gemini':
        return this.cloudLlm.chatGemini(dto);
      case 'anthropic':
        return this.cloudLlm.chatClaude(dto);
      case 'deepseek':
        return this.cloudLlm.chatDeepSeek(dto);
      case 'grok':
        return this.cloudLlm.chatGrok(dto);
      default:
        return { error: `Unknown provider: ${body.provider}` };
    }
  }
}
