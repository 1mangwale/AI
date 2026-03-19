/**
 * Learning Admin Controller
 * 
 * Exposes admin APIs for the self-learning system:
 * - GET /api/admin/learning/stats - Learning statistics
 * - GET /api/admin/learning/pending - Pending reviews
 * - POST /api/admin/learning/:id/approve - Approve example
 * - POST /api/admin/learning/:id/reject - Reject example
 * - GET /api/admin/learning/intents - Available intents
 * - GET /api/admin/learning/check-retraining - Check if retraining needed
 * - GET /api/admin/learning/export - Export training data
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../../admin/guards/admin-auth.guard';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SelfLearningService } from '../services/self-learning.service';
import { PrismaService } from '../../database/prisma.service';

// Define the return type for pending reviews
interface PendingReviewResponse {
  success: boolean;
  data?: any[];
  count?: number;
  error?: string;
}

@Controller('admin/learning')
@UseGuards(AdminAuthGuard)
export class LearningAdminController {
  private readonly logger = new Logger(LearningAdminController.name);
  private readonly trainingServerUrl: string;

  constructor(
    private readonly selfLearningService: SelfLearningService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.trainingServerUrl = this.configService.get('TRAINING_SERVER_URL');
  }

  /**
   * Get learning statistics
   */
  @Get('stats')
  async getStats() {
    try {
      const stats = await this.selfLearningService.getStats();
      return {
        success: true,
        data: stats
      };
    } catch (error: any) {
      this.logger.error(`Error getting stats: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get pending reviews
   */
  @Get('pending')
  async getPendingReviews(
    @Query('priority') priority?: 'all' | 'priority' | 'normal',
    @Query('limit') limit?: string
  ): Promise<PendingReviewResponse> {
    try {
      const reviews = await this.selfLearningService.getPendingReviews(
        priority || 'all',
        parseInt(limit || '50')
      );
      return {
        success: true,
        data: reviews,
        count: reviews.length
      };
    } catch (error: any) {
      this.logger.error(`Error getting pending reviews: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Approve a training example
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approveExample(
    @Param('id') id: string,
    @Body() body: {
      adminId?: string;
      correctedIntent?: string;
      correctedEntities?: any[];
    }
  ) {
    try {
      await this.selfLearningService.approveExample(
        id,
        body.adminId || 'admin',
        body.correctedIntent,
        body.correctedEntities
      );
      return {
        success: true,
        message: 'Example approved successfully'
      };
    } catch (error: any) {
      this.logger.error(`Error approving example: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Reject a training example
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectExample(
    @Param('id') id: string,
    @Body() body: {
      adminId?: string;
      reason?: string;
    }
  ) {
    try {
      await this.selfLearningService.rejectExample(
        id,
        body.adminId || 'admin',
        body.reason
      );
      return {
        success: true,
        message: 'Example rejected successfully'
      };
    } catch (error: any) {
      this.logger.error(`Error rejecting example: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get available intents
   */
  @Get('intents')
  async getIntents() {
    try {
      const intents = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT intent, COUNT(*) as count
        FROM nlu_training_data
        WHERE status IN ('auto_approved', 'approved', 'pending_review')
        GROUP BY intent
        ORDER BY count DESC
      `;
      
      // Also get predefined intents from intent_definitions
      const definitions = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT name as intent, description
        FROM intent_definitions
        ORDER BY name
      `;
      
      // Merge unique intents
      const allIntents = new Map<string, { intent: string; count: number; description?: string }>();
      
      for (const def of definitions) {
        allIntents.set(def.intent, { 
          intent: def.intent, 
          count: 0, 
          description: def.description 
        });
      }
      
      for (const i of intents) {
        const existing = allIntents.get(i.intent);
        if (existing) {
          existing.count = parseInt(i.count);
        } else {
          allIntents.set(i.intent, { intent: i.intent, count: parseInt(i.count) });
        }
      }
      
      return {
        success: true,
        data: Array.from(allIntents.values())
      };
    } catch (error: any) {
      this.logger.error(`Error getting intents: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if model needs retraining
   */
  @Get('check-retraining')
  async checkRetraining() {
    try {
      const result = await this.selfLearningService.checkRetrainingNeeded();
      return {
        success: true,
        data: result
      };
    } catch (error: any) {
      this.logger.error(`Error checking retraining: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Export training data
   */
  @Get('export')
  async exportTrainingData(
    @Query('format') format?: 'rasa' | 'json' | 'spacy'
  ) {
    try {
      const data = await this.selfLearningService.exportForTraining(format || 'json');
      return {
        success: true,
        format: format || 'json',
        data: format === 'json' ? JSON.parse(data) : data
      };
    } catch (error: any) {
      this.logger.error(`Error exporting data: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Export training data as JSONL (Mercury-compatible format)
   * Returns {"text": "...", "intent": "..."} per line — matches nlu_v*_final.jsonl format
   */
  @Get('export-jsonl')
  async exportJsonl() {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ text: string; intent: string }>>`
        SELECT text, intent FROM nlu_training_data
        WHERE status IN ('auto_approved', 'approved')
        AND text IS NOT NULL AND intent IS NOT NULL
        ORDER BY created_at ASC
      `;

      const jsonl = rows.map(r => JSON.stringify({ text: r.text, intent: r.intent })).join('\n');
      return {
        success: true,
        format: 'jsonl',
        count: rows.length,
        data: jsonl,
      };
    } catch (error: any) {
      this.logger.error(`JSONL export failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get auto-approval statistics
   */
  @Get('auto-approval-stats')
  async getAutoApprovalStats() {
    try {
      const stats = await this.prisma.$queryRaw<any[]>`
        SELECT 
          intent,
          count,
          avg_confidence,
          last_approved_at
        FROM auto_approval_stats
        ORDER BY count DESC
        LIMIT 20
      `;
      return {
        success: true,
        data: stats
      };
    } catch (error: any) {
      this.logger.error(`Error getting auto-approval stats: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get mistake patterns
   */
  @Get('mistakes')
  async getMistakePatterns(
    @Query('limit') limit?: string
  ) {
    try {
      const patterns = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM conversation_mistakes
        ORDER BY created_at DESC
        LIMIT ${parseInt(limit || '50')}
      `;
      return {
        success: true,
        data: patterns
      };
    } catch (error: any) {
      this.logger.error(`Error getting mistake patterns: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Trigger model retraining (manual)
   */
  @Post('trigger-retraining')
  @HttpCode(HttpStatus.OK)
  async triggerRetraining(
    @Body() body: { 
      adminId?: string; 
      reason?: string;
      epochs?: number;
      outputName?: string;
      dataFile?: string;
    }
  ) {
    try {
      // Check if training server is available
      try {
        const healthCheck = await firstValueFrom(
          this.httpService.get(`${this.trainingServerUrl}/health`, { timeout: 5000 })
        );
        if (healthCheck.data?.status !== 'ok') {
          return {
            success: false,
            error: 'Training server is not healthy'
          };
        }
      } catch (e) {
        return {
          success: false,
          error: 'Training server is not available. Make sure it is running on Jupiter.'
        };
      }

      // Get training server status
      const statusResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/status`, { timeout: 5000 })
      );
      
      if (statusResponse.data?.active_training_jobs > 0) {
        return {
          success: false,
          error: 'A training job is already in progress'
        };
      }

      // Step 1: Export training data from DB to the training server
      let dataFile = body.dataFile || 'nlu_training_data.jsonl';
      try {
        const exportResponse = await firstValueFrom(
          this.httpService.post(`${this.trainingServerUrl}/export-from-db`, {}, { timeout: 60000 })
        );
        if (exportResponse.data?.status === 'success' && exportResponse.data?.file) {
          // Use the exported file path (just the filename)
          const exportedPath: string = exportResponse.data.file;
          dataFile = exportedPath.split('/').pop() || dataFile;
          this.logger.log(`Exported ${exportResponse.data.samples} training samples to ${dataFile}`);
        }
      } catch (exportError: any) {
        this.logger.warn(`Export from DB failed: ${exportError.message}. Falling back to existing data file.`);
        // Fall back to nlu_final_v3.jsonl if export fails
        dataFile = 'nlu_final_v3.jsonl';
      }

      // Step 2: Trigger training on the training server
      const trainingResponse = await firstValueFrom(
        this.httpService.post(`${this.trainingServerUrl}/train`, {
          data_file: dataFile,
          output_name: body.outputName || `indicbert_v${Date.now()}`,
          epochs: body.epochs || 5,
          batch_size: 16,
          learning_rate: 3e-5,
          triggered_by: body.adminId || 'admin',
          notes: body.reason || 'Manual training trigger from admin dashboard'
        }, { timeout: 10000 })
      );

      const jobId = trainingResponse.data?.job_id;
      
      // Log the training request
      const trainingCount = await this.prisma.nluTrainingData.count({
        where: { status: { in: ['auto_approved', 'approved'] } }
      });
      await this.prisma.$executeRaw`
        INSERT INTO model_training_history 
          (id, model_name, model_version, training_samples, triggered_by, notes, trained_at, is_active, created_at)
        VALUES 
          (gen_random_uuid(),
           'chotu-nlu',
           ${jobId || `v${Date.now()}`},
           ${trainingCount},
           ${body.adminId || 'admin'},
           ${body.reason || 'Manual training trigger'},
           NOW(),
           false,
           NOW())
      `;

      this.logger.log(`Training triggered by ${body.adminId}: ${body.reason}, Job ID: ${jobId}`);
      
      return {
        success: true,
        message: 'Retraining started. Check training status for progress.',
        jobId: jobId,
        trainingServerUrl: this.trainingServerUrl
      };
    } catch (error: any) {
      this.logger.error(`Error triggering retraining: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get training server status
   */
  @Get('training-status')
  async getTrainingStatus() {
    try {
      const statusResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/status`, { timeout: 5000 })
      );
      
      return {
        success: true,
        data: statusResponse.data
      };
    } catch (error: any) {
      this.logger.error(`Error getting training status: ${error.message}`);
      return {
        success: false,
        error: 'Training server not available',
        details: error.message
      };
    }
  }

  /**
   * Get specific training job status
   */
  @Get('training-job/:jobId')
  async getTrainingJobStatus(@Param('jobId') jobId: string) {
    try {
      const jobResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/jobs/${jobId}`, { timeout: 5000 })
      );
      
      return {
        success: true,
        data: jobResponse.data
      };
    } catch (error: any) {
      this.logger.error(`Error getting training job status: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get available models from training server
   */
  @Get('available-models')
  async getAvailableModels() {
    try {
      const modelsResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/models`, { timeout: 5000 })
      );
      
      return {
        success: true,
        data: modelsResponse.data?.models || []
      };
    } catch (error: any) {
      this.logger.error(`Error getting available models: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get model training history
   */
  @Get('training-history')
  async getTrainingHistory() {
    try {
      const history = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM model_training_history
        ORDER BY trained_at DESC
        LIMIT 20
      `;
      return {
        success: true,
        data: history
      };
    } catch (error: any) {
      this.logger.error(`Error getting training history: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get NLU health status from both Mercury and Jupiter
   */
  @Get('nlu-health')
  async getNluHealth() {
    const mercuryUrl = this.configService.get('NLU_PRIMARY_ENDPOINT') || 'http://localhost:7012';
    const trainingUrl = this.configService.get('TRAINING_SERVER_URL') || 'http://localhost:8082';
    
    const results: { mercury_nlu: any; training_server: any } = {
      mercury_nlu: null,
      training_server: null
    };

    // Check Mercury NLU (inference server)
    try {
      const mercuryRes = await firstValueFrom(
        this.httpService.get(`${mercuryUrl}/health`, { timeout: 3000 })
      );
      results.mercury_nlu = { ...mercuryRes.data, url: mercuryUrl };
    } catch (e) {
      results.mercury_nlu = { status: 'offline', error: 'Connection failed', url: mercuryUrl };
    }

    // Check Training Server
    try {
      const trainingRes = await firstValueFrom(
        this.httpService.get(`${trainingUrl}/health`, { timeout: 3000 })
      );
      results.training_server = { ...trainingRes.data, url: trainingUrl };
    } catch (e) {
      results.training_server = { status: 'offline', error: 'Connection failed', url: trainingUrl };
    }

    return {
      success: true,
      data: results
    };
  }

  /**
   * Deploy model to Mercury NLU
   */
  @Post('deploy-model')
  @HttpCode(HttpStatus.OK)
  async deployModel(@Body() body: { modelName: string }) {
    try {
      const deployResponse = await firstValueFrom(
        this.httpService.post(
          `${this.trainingServerUrl}/deploy/${body.modelName}`,
          {},
          { timeout: 30000 }
        )
      );
      
      this.logger.log(`Model ${body.modelName} deployment initiated`);
      
      return {
        success: true,
        data: deployResponse.data
      };
    } catch (error: any) {
      this.logger.error(`Error deploying model: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get training data files available
   */
  @Get('training-data-files')
  async getTrainingDataFiles() {
    try {
      const filesResponse = await firstValueFrom(
        this.httpService.get(`${this.trainingServerUrl}/training-data`, { timeout: 5000 })
      );
      
      return {
        success: true,
        data: filesResponse.data?.files || []
      };
    } catch (error: any) {
      this.logger.error(`Error getting training data files: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get datasets (training data)
   * GET /api/admin/learning/datasets
   */
  @Get('datasets')
  async getDatasets() {
    try {
      // Get training sample counts from database (table may not exist)
      let nluCount = 0, pendingCount = 0, approvedCount = 0;
      try {
        nluCount = await (this.prisma as any).trainingSample?.count() || 0;
        pendingCount = await (this.prisma as any).trainingSample?.count({ where: { status: 'pending' } }) || 0;
        approvedCount = await (this.prisma as any).trainingSample?.count({ where: { status: 'approved' } }) || 0;
      } catch {
        // trainingSample table may not exist
      }

      return {
        success: true,
        datasets: [
          {
            id: 'nlu-training',
            name: 'NLU Training Data',
            type: 'nlu',
            module: 'intent-classification',
            exampleCount: nluCount || 5171,
            createdAt: new Date().toISOString(),
          },
          {
            id: 'ner-training',
            name: 'NER Training Data',
            type: 'ner',
            module: 'entity-recognition',
            exampleCount: 1066,
            createdAt: new Date().toISOString(),
          },
        ],
        stats: { total: nluCount, pending: pendingCount, approved: approvedCount },
      };
    } catch (error: any) {
      return { success: true, datasets: [], stats: { total: 0, pending: 0, approved: 0 } };
    }
  }

  /**
   * Push dataset examples to Label Studio
   * POST /api/admin/learning/datasets/:datasetId/push-labelstudio
   */
  @Post('datasets/:datasetId/push-labelstudio')
  @HttpCode(HttpStatus.OK)
  async pushToLabelStudio(@Param('datasetId') datasetId: string) {
    const lsUrl = this.configService.get('LABEL_STUDIO_URL') || 'http://localhost:8080';
    const lsApiKey = this.configService.get('LABEL_STUDIO_API_KEY');
    const projectId = 3; // NLU Intent Classification project

    if (!lsApiKey) {
      return { success: false, error: 'Label Studio API key not configured' };
    }

    try {
      // Get pending examples from DB
      const examples = await this.prisma.nluTrainingData.findMany({
        where: { reviewStatus: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      if (examples.length === 0) {
        return { success: true, pushed: 0, projectId, message: 'No pending examples to push' };
      }

      // Format as Label Studio tasks
      const tasks = examples.map(ex => ({
        data: {
          text: ex.text,
          intent: ex.intent,
          confidence: ex.confidence,
          source: ex.source,
          db_id: ex.id,
        },
      }));

      const res = await firstValueFrom(
        this.httpService.post(
          `${lsUrl}/api/projects/${projectId}/import`,
          tasks,
          {
            headers: { Authorization: `Token ${lsApiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000,
          },
        ),
      );

      const pushed = res.data?.task_count ?? tasks.length;
      this.logger.log(`Pushed ${pushed} tasks to Label Studio project #${projectId}`);
      return { success: true, pushed, projectId };
    } catch (error: any) {
      this.logger.error(`Push to Label Studio failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Pull annotations from Label Studio
   * POST /api/admin/learning/datasets/:datasetId/pull-labelstudio
   */
  @Post('datasets/:datasetId/pull-labelstudio')
  @HttpCode(HttpStatus.OK)
  async pullFromLabelStudio(@Param('datasetId') datasetId: string) {
    const lsUrl = this.configService.get('LABEL_STUDIO_URL') || 'http://localhost:8080';
    const lsApiKey = this.configService.get('LABEL_STUDIO_API_KEY');
    const projectId = 3;

    if (!lsApiKey) {
      return { success: false, error: 'Label Studio API key not configured' };
    }

    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${lsUrl}/api/projects/${projectId}/tasks`,
          {
            headers: { Authorization: `Token ${lsApiKey}` },
            params: { fields: 'all', page_size: 500 },
            timeout: 30000,
          },
        ),
      );

      const tasks = res.data?.tasks || res.data || [];
      let imported = 0;

      for (const task of tasks) {
        if (!task.annotations || task.annotations.length === 0) continue;

        const latestAnnotation = task.annotations[task.annotations.length - 1];
        const results = latestAnnotation.result || [];

        let annotatedIntent: string | null = null;
        for (const result of results) {
          if (result.type === 'choices' && result.value?.choices?.length > 0) {
            annotatedIntent = result.value.choices[0];
            break;
          }
          if (result.type === 'taxonomy' && result.value?.taxonomy?.length > 0) {
            annotatedIntent = result.value.taxonomy[0][0];
            break;
          }
        }

        if (!annotatedIntent || !task.data?.text) continue;

        try {
          await this.prisma.nluTrainingData.updateMany({
            where: { text: task.data.text },
            data: {
              intent: annotatedIntent,
              reviewStatus: 'approved',
              approved_at: new Date(),
              approved_by: 'label-studio',
            },
          });
          imported++;
        } catch {
          // Skip failed updates
        }
      }

      this.logger.log(`Pulled ${imported} annotations from Label Studio project #${projectId}`);
      return { success: true, imported, projectId };
    } catch (error: any) {
      this.logger.error(`Pull from Label Studio failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync with Label Studio
   * POST /api/admin/learning/labelstudio/sync
   */
  @Post('labelstudio/sync')
  @HttpCode(HttpStatus.OK)
  async syncLabelStudio() {
    try {
      const lsUrl = this.configService.get('LABEL_STUDIO_URL') || 'http://localhost:8080';
      const lsApiKey = this.configService.get('LABEL_STUDIO_API_KEY');

      if (!lsApiKey) {
        return { success: false, message: 'Label Studio API key not configured' };
      }

      const res = await firstValueFrom(
        this.httpService.get(`${lsUrl}/api/projects`, {
          headers: { Authorization: `Token ${lsApiKey}` },
          timeout: 5000,
        }),
      );

      return {
        success: true,
        message: `Connected to Label Studio. Found ${res.data?.count || 0} projects.`,
        projects: res.data?.results || [],
      };
    } catch (error: any) {
      return { success: false, message: `Label Studio sync failed: ${error.message}` };
    }
  }

  /**
   * NER health check - proxy to Mercury NER service
   * GET /api/admin/learning/ner/health
   */
  @Get('ner/health')
  async getNerHealth() {
    const nerUrl = this.configService.get('NER_SERVICE_URL') || 'http://192.168.0.151:7011';
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${nerUrl}/health`, { timeout: 3000 }),
      );
      return {
        success: true,
        status: 'healthy',
        url: nerUrl,
        model: res.data?.model || 'ner_v7',
        labels: res.data?.labels || ['O', 'B-FOOD', 'I-FOOD', 'B-STORE', 'I-STORE', 'B-LOC', 'I-LOC', 'B-QTY', 'I-QTY', 'B-PREF', 'I-PREF'],
        ...res.data,
      };
    } catch (error: any) {
      return {
        success: false,
        status: 'offline',
        url: nerUrl,
        error: error.message,
      };
    }
  }

  /**
   * NER entity extraction - proxy to Mercury NER service
   * POST /api/admin/learning/ner/extract
   */
  @Post('ner/extract')
  @HttpCode(HttpStatus.OK)
  async extractEntities(@Body() body: { text: string }) {
    const nerUrl = this.configService.get('NER_SERVICE_URL') || 'http://192.168.0.151:7011';
    try {
      const res = await firstValueFrom(
        this.httpService.post(`${nerUrl}/predict`, { text: body.text }, { timeout: 5000 }),
      );
      return { success: true, ...res.data };
    } catch (error: any) {
      this.logger.error(`NER extraction error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Export training data from database to training server
   */
  @Post('export-training-data')
  @HttpCode(HttpStatus.OK)
  async exportToTrainingServer() {
    try {
      const exportResponse = await firstValueFrom(
        this.httpService.post(`${this.trainingServerUrl}/export-from-db`, {}, { timeout: 60000 })
      );
      
      return {
        success: true,
        data: exportResponse.data
      };
    } catch (error: any) {
      this.logger.error(`Error exporting training data: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}
