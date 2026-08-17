import { Controller, Post, Body, Get, Logger, Inject, Optional, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { AgentOrchestratorService } from '../services/agent-orchestrator.service';
import { SessionService } from '../../session/session.service';

/**
 * Flow Test Controller
 * 
 * Endpoints for testing Flow integration (moved to /test/flows to avoid conflict)
 */
@UseGuards(AdminApiKeyGuard)
@Controller('test/flows')
export class FlowTestController {
  private readonly logger = new Logger(FlowTestController.name);

  constructor(
    private readonly agentOrchestratorService: AgentOrchestratorService,
    @Optional() private readonly sessionService: SessionService,
  ) {}

  /**
   * Test endpoint: Load flows from Admin Backend
   * 
   * GET /flows/load
   */
  @Get('load')
  async loadFlows() {
    this.logger.log('📥 Loading flows from Admin Backend...');
    
    try {
      const flows = await this.agentOrchestratorService.loadFlows();
      
      return {
        success: true,
        count: flows.length,
        flows: flows.map(f => ({
          id: f.id,
          name: f.name,
          module: f.module,
          trigger: f.trigger,
          enabled: f.enabled,
          stepCount: f.steps?.length || 0,
        })),
      };
    } catch (error) {
      this.logger.error('Error loading flows:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Test endpoint: Clear flow cache
   * 
   * POST /flows/cache/clear
   */
  @Post('cache/clear')
  async clearCache() {
    this.logger.log('🗑️ Clearing flow cache...');
    
    this.agentOrchestratorService.clearFlowCache();
    
    return {
      success: true,
      message: 'Flow cache cleared successfully',
    };
  }

  /**
   * Test endpoint: Process message with flow
   * 
   * POST /flows/test
   * Body: { phoneNumber, message, module }
   */
  @Post('test')
  async testFlow(@Body() body: { phoneNumber: string; message: string; module?: string }) {
    this.logger.log(`🧪 Testing flow for message: "${body.message}" from ${body.phoneNumber}`);
    
    try {
      const result = await this.agentOrchestratorService.processMessage(
        body.phoneNumber,
        body.message,
        body.module as any,
      );
      
      this.logger.log(`✅ Flow test result: ${JSON.stringify(result).substring(0, 200)}`);
      
      return {
        success: true,
        result,
      };
    } catch (error) {
      this.logger.error(`❌ Error testing flow: ${error.message}`);
      this.logger.error(`Stack: ${error.stack}`);
      return {
        success: false,
        error: error.message,
        stack: error.stack,
      };
    }
  }

  /**
   * Test endpoint: Set user as authenticated (for testing purposes)
   * 
   * POST /flows/test-auth
   * Body: { phoneNumber }
   */
  @Post('test-auth')
  async testAuth(@Body() body: { phoneNumber: string }) {
    this.logger.log(`🧪 Setting test auth for: ${body.phoneNumber}`);
    
    if (!this.sessionService) {
      return {
        success: false,
        error: 'SessionService not available',
      };
    }
    
    try {
      // Set the session as authenticated with test data
      await this.sessionService.updateSession(body.phoneNumber, {
        authenticated: true,
        user_id: 1, // Test user ID
        user_name: 'Test User',
        auth_token: 'test_token_123',
        phone: body.phoneNumber.replace('91', ''),
      });
      
      this.logger.log(`✅ Test auth set for: ${body.phoneNumber}`);
      
      return {
        success: true,
        message: `User ${body.phoneNumber} authenticated for testing`,
      };
    } catch (error) {
      this.logger.error(`❌ Error setting test auth: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
