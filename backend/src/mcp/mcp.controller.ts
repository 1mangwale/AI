import { Controller, Get, Post, Delete, Req, Res, Logger, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServerService } from './services/mcp-server.service';

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
 * Streamable HTTP (recommended):
 *   1. Client sends initialize via POST /mcp/stream → gets mcp-session-id header
 *   2. Client sends subsequent requests with mcp-session-id header
 *   3. Client sends DELETE /mcp/stream to clean up session
 */
@SkipThrottle()
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly sseTransports = new Map<string, SSEServerTransport>();
  private readonly streamSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  constructor(private readonly mcpServer: McpServerService) {}

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
        this.logger.log(`MCP stream session created: ${transport.sessionId}`);
        transport.onclose = () => {
          this.streamSessions.delete(transport.sessionId);
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
    this.logger.log(`MCP SSE session created: ${transport.sessionId}`);

    transport.onclose = () => {
      this.sseTransports.delete(transport.sessionId);
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
      version: '1.1.0',
      protocol: 'MCP (Model Context Protocol)',
      tools: 17,
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
      },
      documentation: 'https://modelcontextprotocol.io',
    };
  }
}
