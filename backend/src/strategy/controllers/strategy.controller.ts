import { Controller, Get, Post, Patch, Delete, Query, Param, Body } from '@nestjs/common';
import { StrategyLedgerService } from '../services/strategy-ledger.service';
import { InstitutionalMemoryService } from '../services/institutional-memory.service';

@Controller('mos/strategy')
export class StrategyController {
  constructor(
    private readonly strategyLedger: StrategyLedgerService,
    private readonly institutionalMemory: InstitutionalMemoryService,
  ) {}

  // --- Strategy Decisions ---

  @Get('decisions')
  async getDecisions(
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    return this.strategyLedger.getDecisionHistory(type, limit ? parseInt(limit) : 50);
  }

  @Get('decisions/search')
  async searchDecisions(@Query('query') query: string) {
    if (!query) return [];
    return this.strategyLedger.searchDecisions(query);
  }

  @Get('decisions/stats')
  async getDecisionStats() {
    return this.strategyLedger.getDecisionStats();
  }

  @Get('decisions/:id')
  async getDecision(@Param('id') id: string) {
    return this.strategyLedger.getDecisionById(id);
  }

  @Post('decisions')
  async logDecision(@Body() body: {
    type: string;
    title: string;
    decision: string;
    rationale?: string;
    context?: Record<string, any>;
    decidedBy?: string;
    tags?: string[];
  }) {
    return this.strategyLedger.logDecision(body);
  }

  @Patch('decisions/:id/outcome')
  async updateOutcome(
    @Param('id') id: string,
    @Body() body: { outcome: string; metrics?: Record<string, any> },
  ) {
    return this.strategyLedger.updateOutcome(id, body.outcome, body.metrics);
  }

  // --- Institutional Memory ---

  @Get('memory')
  async getMemory(
    @Query('query') query?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? parseInt(limit) : 20;
    if (query) {
      return this.institutionalMemory.searchMemory(query, category, lim);
    }
    return this.institutionalMemory.getRecentMemories(category, lim);
  }

  @Get('memory/categories')
  async getMemoryCategories() {
    return this.institutionalMemory.getCategories();
  }

  @Get('memory/popular')
  async getPopularMemory(@Query('limit') limit?: string) {
    return this.institutionalMemory.getMostAccessed(limit ? parseInt(limit) : 10);
  }

  @Post('memory')
  async addMemory(@Body() body: {
    category: string;
    title: string;
    content: string;
    source?: string;
    tags?: string[];
  }) {
    return this.institutionalMemory.addMemory(body);
  }

  @Patch('memory/:id')
  async updateMemory(
    @Param('id') id: string,
    @Body() body: {
      category?: string;
      title?: string;
      content?: string;
      source?: string;
      tags?: string[];
      relevance_score?: number;
    },
  ) {
    return this.institutionalMemory.updateMemory(id, body);
  }

  @Delete('memory/:id')
  async deleteMemory(@Param('id') id: string) {
    const deleted = await this.institutionalMemory.deleteMemory(id);
    return { deleted };
  }
}
