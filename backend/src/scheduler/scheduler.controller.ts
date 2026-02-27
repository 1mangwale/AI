import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Logger,
} from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { AutoActionService } from './services/auto-action.service';

@Controller('mos/scheduler')
export class SchedulerController {
  private readonly logger = new Logger(SchedulerController.name);

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly autoAction: AutoActionService,
  ) {}

  // ─── Scheduled Jobs ───────────────────────────────────────────

  @Get('jobs')
  async getJobs() {
    return this.scheduler.getAllJobs();
  }

  @Patch('jobs/:name/toggle')
  async toggleJob(@Param('name') name: string) {
    const result = await this.scheduler.toggleJob(name);
    if (!result) {
      return { error: `Job '${name}' not found` };
    }
    return { jobName: name, ...result };
  }

  @Post('jobs/:name/run')
  async runJob(@Param('name') name: string) {
    this.logger.log(`Manual trigger requested for job: ${name}`);
    return this.scheduler.runJobManually(name);
  }

  @Get('jobs/:name/history')
  async getJobHistory(
    @Param('name') name: string,
    @Query('limit') limit?: string,
  ) {
    return this.scheduler.getJobHistory(name, limit ? parseInt(limit) : 20);
  }

  // ─── Auto Actions ─────────────────────────────────────────────

  @Get('actions')
  async getActions() {
    return this.autoAction.getAllActions();
  }

  @Patch('actions/:name/toggle')
  async toggleAction(@Param('name') name: string) {
    const result = await this.autoAction.toggleAction(name);
    if (!result) {
      return { error: `Action '${name}' not found` };
    }
    return { actionName: name, ...result };
  }

  @Patch('actions/:name/config')
  async updateActionConfig(
    @Param('name') name: string,
    @Body() config: Record<string, any>,
  ) {
    const result = await this.autoAction.updateActionConfig(name, config);
    if (!result) {
      return { error: `Action '${name}' not found` };
    }
    return result;
  }

  @Get('actions/:name/history')
  async getActionHistory(
    @Param('name') name: string,
    @Query('limit') limit?: string,
  ) {
    return this.autoAction.getActionHistory(name, limit ? parseInt(limit) : 20);
  }
}
