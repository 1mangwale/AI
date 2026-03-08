import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { McpController } from './mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { McpToolsService } from './services/mcp-tools.service';
import { McpCacheService } from './services/mcp-cache.service';
import { PhpIntegrationModule } from '../php-integration/php-integration.module';
import { ZonesModule } from '../zones/zones.module';
import { SearchModule } from '../search/search.module';

/**
 * MCP Module — Model Context Protocol Server
 *
 * Exposes Mangwale commerce capabilities as 19 MCP tools that AI assistants
 * (Claude, ChatGPT, Gemini) can discover and use to help users order food,
 * browse restaurants, manage orders, and handle deliveries.
 *
 * Transports:
 *   - Streamable HTTP (POST /mcp/stream) — modern, stateful, recommended
 *   - SSE (GET /mcp/sse) — legacy, backwards compatible
 *
 * Architecture:
 *   AI Client → HTTP → McpController → McpServerService → McpToolsService
 *                                            ↓                    ↓
 *                                      McpCacheService    PhpStoreService,
 *                                       (Redis)          PhpOrderService,
 *                                                        PhpPaymentService,
 *                                                        Search API, etc.
 */
@Module({
  imports: [
    HttpModule.register({ timeout: 15000 }),
    PhpIntegrationModule,
    ZonesModule,
    SearchModule,
  ],
  controllers: [McpController],
  providers: [McpServerService, McpToolsService, McpCacheService],
})
export class McpModule {}
