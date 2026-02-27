import { Controller, Get, Post, Delete, Req, Res, Logger, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServerService } from './services/mcp-server.service';

/**
 * MCP Controller — HTTP Transport for AI Agent Access
 *
 * Endpoints:
 *   GET  /mcp/sse       → SSE stream (legacy, backwards compatible)
 *   POST /mcp/messages   → JSON-RPC messages for SSE sessions
 *   POST /mcp/stream     → Streamable HTTP (modern, stateless)
 *   DELETE /mcp/stream   → Session cleanup (per MCP spec)
 *   GET  /mcp/health     → Server info and status
 *
 * Streamable HTTP (recommended for new integrations):
 *   AI client sends JSON-RPC requests directly via POST /mcp/stream.
 *   No persistent connection needed — each request is self-contained.
 *
 * SSE (legacy, still supported):
 *   1. Client connects to GET /mcp/sse → receives SSE stream
 *   2. Client sends tool calls via POST /mcp/messages?sessionId=X
 *   3. Server responds via the SSE stream
 */
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly sseTransports = new Map<string, SSEServerTransport>();
  private readonly streamTransports = new Map<string, StreamableHTTPServerTransport>();

  constructor(private readonly mcpServer: McpServerService) {}

  // ─── Streamable HTTP (Modern) ──────────────────────────────

  /**
   * Streamable HTTP endpoint — stateless JSON-RPC over HTTP POST.
   * Each request gets its own transport and server instance.
   */
  @Post('stream')
  async handleStreamPost(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.logger.log(`MCP Streamable HTTP request from ${req.ip}`);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      const server = this.mcpServer.createServer();
      await server.connect(transport);

      // Track transport for cleanup
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.streamTransports.set(sessionId, transport);
        transport.onclose = () => {
          this.streamTransports.delete(sessionId);
        };
      }

      await transport.handleRequest(req as any, res as any, req.body);
    } catch (err) {
      this.logger.error(`Streamable HTTP error: ${err.message}`, err.stack);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  /**
   * Session cleanup endpoint (per MCP spec)
   */
  @Delete('stream')
  async handleStreamDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string;
    if (sessionId && this.streamTransports.has(sessionId)) {
      const transport = this.streamTransports.get(sessionId);
      await transport.close();
      this.streamTransports.delete(sessionId);
      this.logger.log(`MCP stream session cleaned up: ${sessionId}`);
      res.status(200).json({ status: 'session_closed' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  }

  // ─── SSE (Legacy, Backwards Compatible) ────────────────────

  /**
   * SSE endpoint — AI client connects here to establish a persistent stream
   */
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

  /**
   * Messages endpoint — AI client sends JSON-RPC tool calls here (SSE mode)
   */
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

  /**
   * Health check — returns server info, tool count, and transport status
   */
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
        streamable_http: this.streamTransports.size,
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
