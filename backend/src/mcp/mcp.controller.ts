import { Controller, Get, Post, Delete, Param, Body, Req, Res, Logger, HttpCode, Optional, Headers } from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServerService } from './services/mcp-server.service';
import { McpToolsService } from './services/mcp-tools.service';
import { McpOpenApiService } from './services/mcp-openapi.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * MCP Controller — HTTP Transport for AI Agent Access
 *
 * Endpoints:
 *   POST /mcp/stream     → Streamable HTTP (modern, stateful sessions)
 *   DELETE /mcp/stream   → Session cleanup (per MCP spec)
 *   GET  /mcp/sse        → SSE stream (legacy, backwards compatible)
 *   POST /mcp/messages   → JSON-RPC messages for SSE sessions
 *   GET  /mcp/health     → Server info and status
 *
 * Discovery & Compatibility:
 *   GET  /mcp/.well-known/mcp.json              → Claude Desktop MCP discovery
 *   GET  /mcp/.well-known/ai-plugin.json         → ChatGPT GPT Action config
 *   GET  /mcp/.well-known/google-ai-extensions.json → Gemini Extensions config
 *   GET  /mcp/openapi.json                       → OpenAPI 3.1 spec
 *   POST /mcp/tools/:toolName                    → REST wrapper for any MCP tool
 */
@SkipThrottle()
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly sseTransports = new Map<string, SSEServerTransport>();
  private readonly streamSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  constructor(
    private readonly mcpServer: McpServerService,
    private readonly mcpTools: McpToolsService,
    private readonly openApiService: McpOpenApiService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ─── Discovery Endpoints ─────────────────────────────────────

  /**
   * Claude Desktop MCP auto-discovery manifest.
   * Claude Desktop checks /.well-known/mcp.json or the server's manifest endpoint.
   */
  @Get('.well-known/mcp.json')
  getMcpManifest(): any {
    return {
      schema_version: '1.0.0',
      server: {
        name: 'mangwale-commerce',
        version: '1.2.0',
        description:
          'Mangwale — India\'s hyperlocal food delivery, e-commerce & parcel platform. Order food from restaurants, shop products, and send parcels in Nashik and expanding cities.',
        vendor: 'Mangwale Technologies',
        homepage: 'https://mangwale.com',
        protocol: 'MCP (Model Context Protocol)',
        sdk_version: '1.26.0',
      },
      transports: {
        streamable_http: {
          url: 'https://api.mangwale.com/mcp/stream',
          method: 'POST',
          description:
            'Modern stateful transport (recommended). Send initialize request, receive mcp-session-id header for subsequent requests.',
        },
        sse: {
          url: 'https://api.mangwale.com/mcp/sse',
          method: 'GET',
          messages_url: 'https://api.mangwale.com/mcp/messages',
          description: 'Legacy SSE transport for backwards compatibility.',
        },
      },
      setup: {
        claude_desktop: {
          mcpServers: {
            mangwale: {
              url: 'https://api.mangwale.com/mcp/stream',
              transport: 'streamable-http',
            },
          },
        },
      },
      capabilities: {
        services: ['food_delivery', 'ecommerce', 'parcel_delivery'],
        coverage: 'Nashik, Maharashtra, India (expanding)',
        languages: ['en', 'hi', 'mr'],
        currency: 'INR',
        tools_count: 20,
      },
    };
  }

  /**
   * ChatGPT GPT Action plugin manifest.
   * ChatGPT looks for /.well-known/ai-plugin.json to discover API capabilities.
   */
  @Get('.well-known/ai-plugin.json')
  getAiPluginManifest(): any {
    return {
      schema_version: 'v1',
      name_for_human: 'Mangwale',
      name_for_model: 'mangwale_commerce',
      description_for_human: 'Order food, groceries, and more from local shops in Nashik',
      description_for_model:
        'Search restaurants, browse menus, order food/products with delivery in Nashik, India. ' +
        'Supports food delivery, e-commerce, and parcel delivery. ' +
        'Discovery tools (search, browse) need no auth. ' +
        'Transactional tools (cart, orders) need auth_token from send_otp + verify_otp flow.',
      auth: { type: 'none' },
      api: {
        type: 'openapi',
        url: 'https://api.mangwale.com/mcp/openapi.json',
      },
      logo_url: 'https://mangwale.com/logo.png',
      contact_email: 'support@mangwale.com',
      legal_info_url: 'https://mangwale.com/terms',
    };
  }

  /**
   * Google Gemini Extensions discovery manifest.
   */
  @Get('.well-known/google-ai-extensions.json')
  getGoogleAiExtensionsManifest(): any {
    return {
      name: 'mangwale_commerce',
      display_name: 'Mangwale Commerce',
      description:
        'Search restaurants, browse menus, order food and products with delivery in Nashik, India.',
      api: {
        type: 'openapi',
        url: 'https://api.mangwale.com/mcp/openapi.json',
      },
      authentication: {
        type: 'none',
        instructions:
          'Discovery tools require no auth. For transactional tools, call send_otp with a phone number, then verify_otp with the OTP to get an auth_token. Pass auth_token in request body.',
      },
      logo: {
        light: 'https://mangwale.com/logo.png',
        dark: 'https://mangwale.com/logo-dark.png',
      },
      contact_email: 'support@mangwale.com',
      category: 'food_and_drink',
      region: 'IN',
    };
  }

  /**
   * OpenAPI 3.1 spec generated from MCP tool definitions.
   * Used by ChatGPT GPT Actions, Gemini Extensions, and REST clients.
   */
  @Get('openapi.json')
  getOpenApiSpec(): any {
    return this.openApiService.generateOpenApiSpec();
  }

  // ─── REST Tool Wrapper ───────────────────────────────────────

  /**
   * REST wrapper for MCP tools — no MCP session required.
   * Accepts JSON body matching the tool's inputSchema and returns the result.
   *
   * For auth-required tools, pass auth_token in the body OR as Bearer token
   * in the Authorization header.
   */
  @Post('tools/:toolName')
  @HttpCode(200)
  async executeToolRest(
    @Param('toolName') toolName: string,
    @Body() body: Record<string, any>,
    @Headers('authorization') authHeader?: string,
  ): Promise<any> {
    const validTools = this.openApiService.getValidToolNames();
    if (!validTools.includes(toolName)) {
      return {
        error: `Unknown tool: ${toolName}`,
        available_tools: validTools,
      };
    }

    // If Authorization header is present, inject auth_token into body
    const params = { ...body };
    if (authHeader && authHeader.startsWith('Bearer ') && !params.auth_token) {
      params.auth_token = authHeader.slice(7);
    }

    const startTime = Date.now();

    try {
      const result = await this.dispatchTool(toolName, params);
      const elapsed = Date.now() - startTime;
      this.logger.log(`REST tool call: ${toolName} (${elapsed}ms)`);
      this.metrics?.recordMcpToolCall(toolName, elapsed, false);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`REST tool ${toolName} failed: ${err.message}`, err.stack);
      this.metrics?.recordMcpToolError(toolName, 'rest_error');
      return { error: err.message || 'Tool execution failed' };
    }
  }

  /**
   * Dispatch a tool call to McpToolsService by name.
   */
  private async dispatchTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'search_restaurants':
        return this.mcpTools.searchRestaurants(args as any);
      case 'get_restaurant_menu':
        return this.mcpTools.getRestaurantMenu(args as any);
      case 'search_items':
        return this.mcpTools.searchItems(args as any);
      case 'check_serviceability':
        return this.mcpTools.checkServiceability(args as any);
      case 'get_coupons':
        return this.mcpTools.getCoupons(args as any);
      case 'get_payment_methods':
        return this.mcpTools.getPaymentMethods(args as any);
      case 'get_categories':
        return this.mcpTools.getCategories(args as any);
      case 'conversational_search':
        return this.mcpTools.conversationalSearch(args as any);
      case 'order_by_recipe':
        return this.mcpTools.orderByRecipe(args as any);
      case 'send_otp':
        return this.mcpTools.sendOtp(args as any);
      case 'verify_otp':
        return this.mcpTools.verifyOtp(args as any);
      case 'add_to_cart':
        return this.mcpTools.addToCart(args as any);
      case 'place_order':
        return this.mcpTools.placeOrder(args as any);
      case 'get_addresses':
        return this.mcpTools.getAddresses(args as any);
      case 'add_address':
        return this.mcpTools.addAddress(args as any);
      case 'get_wallet_balance':
        return this.mcpTools.getWalletBalance(args as any);
      case 'get_order_status':
        return this.mcpTools.getOrderStatus(args as any);
      case 'get_order_history':
        return this.mcpTools.getOrderHistory(args as any);
      case 'cancel_order':
        return this.mcpTools.cancelOrder(args as any);
      case 'get_recommendations':
        return this.mcpTools.getRecommendations(args as any);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ─── Streamable HTTP (Modern) ──────────────────────────────

  @Post('stream')
  async handleStreamPost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Reuse existing session
      if (sessionId && this.streamSessions.has(sessionId)) {
        const { transport } = this.streamSessions.get(sessionId);
        await transport.handleRequest(req as any, res as any, req.body);
        return;
      }

      // Must be an initialize request to create a new session
      const body = req.body;
      const isInit = body && (
        body.method === 'initialize' ||
        (Array.isArray(body) && body.some((m: any) => m.method === 'initialize'))
      );

      if (!isInit) {
        const code = sessionId ? -32000 : -32600;
        const msg = sessionId
          ? 'Session not found. Send an initialize request first.'
          : 'Missing mcp-session-id header. Send an initialize request first.';
        res.status(sessionId ? 404 : 400).json({ jsonrpc: '2.0', error: { code, message: msg }, id: null });
        return;
      }

      // Create new session
      this.logger.log(`MCP Streamable HTTP new session from ${req.ip}`);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      const server = this.mcpServer.createServer();
      await server.connect(transport);

      // handleRequest will process the initialize and set the session ID
      await transport.handleRequest(req as any, res as any, req.body);

      // Now store the transport (session ID is set after handleRequest)
      if (transport.sessionId) {
        this.streamSessions.set(transport.sessionId, { transport, server });
        this.metrics?.updateMcpSessions('streamable-http', this.streamSessions.size);
        this.logger.log(`MCP stream session created: ${transport.sessionId}`);
        transport.onclose = () => {
          this.streamSessions.delete(transport.sessionId);
          this.metrics?.updateMcpSessions('streamable-http', this.streamSessions.size);
          this.logger.log(`MCP stream session closed: ${transport.sessionId}`);
        };
      }
    } catch (err) {
      this.logger.error(`Streamable HTTP error: ${err.message}`, err.stack);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }

  @Delete('stream')
  async handleStreamDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string;
    if (sessionId && this.streamSessions.has(sessionId)) {
      const { transport, server } = this.streamSessions.get(sessionId);
      await transport.close();
      await server.close();
      this.streamSessions.delete(sessionId);
      this.metrics?.updateMcpSessions('streamable-http', this.streamSessions.size);
      this.logger.log(`MCP stream session cleaned up: ${sessionId}`);
      res.status(200).json({ status: 'session_closed' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  }

  // ─── SSE (Legacy, Backwards Compatible) ────────────────────

  @Get('sse')
  async handleSse(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.logger.log(`MCP SSE connection from ${req.ip}`);

    const server = this.mcpServer.createServer();
    const transport = new SSEServerTransport('/mcp/messages', res as any);

    this.sseTransports.set(transport.sessionId, transport);
    this.metrics?.updateMcpSessions('sse', this.sseTransports.size);
    this.logger.log(`MCP SSE session created: ${transport.sessionId}`);

    transport.onclose = () => {
      this.sseTransports.delete(transport.sessionId);
      this.metrics?.updateMcpSessions('sse', this.sseTransports.size);
      this.logger.log(`MCP SSE session closed: ${transport.sessionId}`);
    };

    await server.connect(transport);
  }

  @Post('messages')
  @HttpCode(200)
  async handleMessages(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId query parameter is required' });
      return;
    }

    const transport = this.sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found. Connect to /mcp/sse first.' });
      return;
    }

    await transport.handlePostMessage(req as any, res as any);
  }

  // ─── Health ────────────────────────────────────────────────

  @Get('health')
  getHealth(): any {
    return {
      status: 'ok',
      server: 'mangwale-commerce',
      version: '1.2.0',
      protocol: 'MCP (Model Context Protocol)',
      tools: 20,
      transports: ['sse', 'streamable-http'],
      active_sessions: {
        sse: this.sseTransports.size,
        streamable_http: this.streamSessions.size,
      },
      endpoints: {
        streamable_http: 'POST /mcp/stream',
        sse: 'GET /mcp/sse',
        messages: 'POST /mcp/messages',
        health: 'GET /mcp/health',
        openapi: 'GET /mcp/openapi.json',
        rest_tools: 'POST /mcp/tools/{toolName}',
        discovery_mcp: 'GET /mcp/.well-known/mcp.json',
        discovery_chatgpt: 'GET /mcp/.well-known/ai-plugin.json',
        discovery_gemini: 'GET /mcp/.well-known/google-ai-extensions.json',
      },
      documentation: 'https://modelcontextprotocol.io',
    };
  }
}
