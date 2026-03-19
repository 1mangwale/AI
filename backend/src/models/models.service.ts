import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Return actual system models (known services).
   * Falls back to this when the `model` Prisma table doesn't exist.
   */
  private getSystemModels() {
    const vllmUrl = this.config.get('VLLM_URL', 'http://localhost:8002');
    const nluUrl = this.config.get('NLU_SERVICE_URL', 'http://192.168.0.151:7012');
    const nerUrl = this.config.get('NER_SERVICE_URL', 'http://192.168.0.151:7011');
    const asrUrl = this.config.get('ASR_SERVICE_URL', 'http://192.168.0.151:7001');
    const ttsUrl = this.config.get('TTS_SERVICE_URL', 'http://192.168.0.151:7002');

    return [
      {
        id: 'vllm-qwen-7b',
        name: 'Qwen 2.5 7B Instruct AWQ',
        provider: 'vllm-local',
        providerModelId: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
        modelType: 'llm',
        endpoint: vllmUrl,
        status: 'active',
        isLocal: true,
        maxTokens: 4096,
        capabilities: ['chat', 'completion', 'reasoning', 'hindi', 'english'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'nlu-indicbert-v2',
        name: 'IndicBERTv2 NLU Classifier',
        provider: 'mercury-local',
        providerModelId: 'ai4bharat/IndicBERTv2-MLM-only',
        modelType: 'nlu',
        endpoint: nluUrl,
        status: 'active',
        isLocal: true,
        maxTokens: 512,
        capabilities: ['intent-classification', '33-intents', 'multilingual'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'ner-muril-v7',
        name: 'MuRIL NER v7',
        provider: 'mercury-local',
        providerModelId: 'google/muril-base-cased',
        modelType: 'nlu',
        endpoint: nerUrl,
        status: 'active',
        isLocal: true,
        maxTokens: 512,
        capabilities: ['entity-extraction', 'FOOD', 'STORE', 'LOC', 'QTY', 'PREF'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'asr-whisper',
        name: 'Whisper ASR',
        provider: 'mercury-local',
        providerModelId: 'openai/whisper-large-v3',
        modelType: 'asr',
        endpoint: asrUrl,
        status: 'active',
        isLocal: true,
        capabilities: ['speech-to-text', 'hindi', 'english', 'marathi'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'tts-kokoro',
        name: 'Kokoro TTS',
        provider: 'mercury-local',
        providerModelId: 'kokoro-tts',
        modelType: 'tts',
        endpoint: ttsUrl,
        status: 'active',
        isLocal: true,
        capabilities: ['text-to-speech', 'hindi', 'english'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'embedding-food',
        name: 'Food Embeddings (768D)',
        provider: 'search-local',
        providerModelId: 'jonny9f/food_embeddings',
        modelType: 'embedding',
        endpoint: this.config.get('SEARCH_API_URL') || 'http://localhost:3100',
        status: 'active',
        isLocal: true,
        maxTokens: 512,
        capabilities: ['embedding', 'food-search', '768-dimensions'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'embedding-ecom',
        name: 'MiniLM Embeddings (384D)',
        provider: 'search-local',
        providerModelId: 'all-MiniLM-L6-v2',
        modelType: 'embedding',
        endpoint: this.config.get('SEARCH_API_URL') || 'http://localhost:3100',
        status: 'active',
        isLocal: true,
        maxTokens: 512,
        capabilities: ['embedding', 'ecom-search', '384-dimensions'],
        hasApiKey: false,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  async create(createModelDto: CreateModelDto) {
    try {
      const model = await (this.prisma as any).model?.create({
        data: {
          name: createModelDto.name,
          provider: createModelDto.provider,
          providerModelId: createModelDto.providerModelId,
          modelType: createModelDto.modelType,
          endpoint: createModelDto.endpoint,
          apiKey: createModelDto.apiKey,
          deploymentName: createModelDto.deploymentName,
          config: createModelDto.config || {},
          capabilities: createModelDto.capabilities || [],
          maxTokens: createModelDto.maxTokens,
          costPerToken: createModelDto.costPerToken,
          isLocal: createModelDto.isLocal || false,
          metadata: createModelDto.metadata || {},
          status: 'active',
        },
      });
      if (model) return this.sanitizeModel(model);
    } catch (error) {
      this.logger.warn(`Model table not available, cannot create: ${error.message}`);
    }
    return { error: 'Model registry database table not available. System models are read-only.' };
  }

  async findAll(filters?: { provider?: string; modelType?: string; status?: string }) {
    // Try DB first
    try {
      const where: any = {};
      if (filters?.provider) where.provider = filters.provider;
      if (filters?.modelType) where.modelType = filters.modelType;
      if (filters?.status) where.status = filters.status;

      const models = await (this.prisma as any).model?.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      if (models && models.length > 0) {
        const modelsWithHealth = await Promise.all(models.map(async (model: any) => {
          const sanitized = this.sanitizeModel(model);
          if (model.isLocal && model.endpoint && model.status === 'active') {
            const isHealthy = await this.checkModelHealth(model.endpoint, model.modelType);
            return { ...sanitized, healthStatus: isHealthy ? 'healthy' : 'unhealthy' };
          }
          return { ...sanitized, healthStatus: 'unknown' };
        }));
        return modelsWithHealth;
      }
    } catch {
      // model table doesn't exist — use system models
    }

    // Fallback: return actual system models with live health checks
    let systemModels = this.getSystemModels();

    // Apply filters
    if (filters?.provider) {
      systemModels = systemModels.filter(m => m.provider === filters.provider);
    }
    if (filters?.modelType) {
      systemModels = systemModels.filter(m => m.modelType === filters.modelType);
    }
    if (filters?.status) {
      systemModels = systemModels.filter(m => m.status === filters.status);
    }

    // Run health checks on local models
    const modelsWithHealth = await Promise.all(systemModels.map(async (model) => {
      if (model.isLocal && model.endpoint) {
        const isHealthy = await this.checkModelHealth(model.endpoint, model.modelType);
        return { ...model, healthStatus: isHealthy ? 'healthy' : 'unhealthy' };
      }
      return { ...model, healthStatus: 'unknown' };
    }));

    return modelsWithHealth;
  }

  private async checkModelHealth(endpoint: string, type: string): Promise<boolean> {
    try {
      let healthPath = '/health';
      if (type === 'llm') healthPath = '/v1/models';

      const baseUrl = endpoint.replace(/\/$/, '');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${baseUrl}${healthPath}`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  async findOne(id: string) {
    // Try DB first
    try {
      const model = await (this.prisma as any).model?.findUnique({ where: { id } });
      if (model) return this.sanitizeModel(model);
    } catch {
      // table doesn't exist
    }

    // Fallback: check system models
    const systemModel = this.getSystemModels().find(m => m.id === id);
    if (!systemModel) {
      throw new NotFoundException(`Model with ID ${id} not found`);
    }
    return systemModel;
  }

  async update(id: string, updateModelDto: UpdateModelDto) {
    try {
      const existing = await (this.prisma as any).model?.findUnique({ where: { id } });
      if (existing) {
        const updated = await (this.prisma as any).model?.update({
          where: { id },
          data: { ...updateModelDto, updatedAt: new Date() },
        });
        return this.sanitizeModel(updated);
      }
    } catch {
      // table doesn't exist
    }

    // Check if it's a system model
    const systemModel = this.getSystemModels().find(m => m.id === id);
    if (systemModel) {
      return { ...systemModel, error: 'System models are read-only. Add a database model table to enable editing.' };
    }
    throw new NotFoundException(`Model with ID ${id} not found`);
  }

  async remove(id: string) {
    try {
      const existing = await (this.prisma as any).model?.findUnique({ where: { id } });
      if (existing) {
        await (this.prisma as any).model?.delete({ where: { id } });
        return { message: 'Model deleted successfully', id };
      }
    } catch {
      // table doesn't exist
    }

    const systemModel = this.getSystemModels().find(m => m.id === id);
    if (systemModel) {
      return { error: 'System models cannot be deleted.' };
    }
    throw new NotFoundException(`Model with ID ${id} not found`);
  }

  async toggleStatus(id: string) {
    try {
      const model = await (this.prisma as any).model?.findUnique({ where: { id } });
      if (model) {
        const newStatus = model.status === 'active' ? 'inactive' : 'active';
        const updated = await (this.prisma as any).model?.update({
          where: { id },
          data: { status: newStatus },
        });
        return this.sanitizeModel(updated);
      }
    } catch {
      // table doesn't exist
    }

    const systemModel = this.getSystemModels().find(m => m.id === id);
    if (systemModel) {
      return { ...systemModel, error: 'System model status cannot be toggled from here.' };
    }
    throw new NotFoundException(`Model with ID ${id} not found`);
  }

  private sanitizeModel(model: any) {
    const { apiKey, ...sanitized } = model;
    return {
      ...sanitized,
      hasApiKey: !!apiKey,
    };
  }
}
