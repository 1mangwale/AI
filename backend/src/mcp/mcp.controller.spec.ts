import { Test, TestingModule } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { McpToolsService } from './services/mcp-tools.service';
import { McpOpenApiService } from './services/mcp-openapi.service';
import { MetricsService } from '../metrics/metrics.service';

describe('McpController', () => {
  let controller: McpController;
  let mcpServerService: Partial<McpServerService>;
  let mcpToolsService: Partial<McpToolsService>;
  let mcpOpenApiService: Partial<McpOpenApiService>;

  beforeEach(async () => {
    mcpServerService = {
      createServer: jest.fn().mockReturnValue({
        connect: jest.fn(),
        close: jest.fn(),
        setRequestHandler: jest.fn(),
      }),
    };

    mcpToolsService = {
      searchRestaurants: jest.fn(),
      searchItems: jest.fn(),
      getRecommendations: jest.fn(),
    };

    mcpOpenApiService = {
      generateOpenApiSpec: jest.fn().mockReturnValue({ openapi: '3.1.0' }),
      getValidToolNames: jest.fn().mockReturnValue(['search_items', 'get_recommendations']),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpServerService, useValue: mcpServerService },
        { provide: McpToolsService, useValue: mcpToolsService },
        { provide: McpOpenApiService, useValue: mcpOpenApiService },
        { provide: MetricsService, useValue: { recordMcpToolCall: jest.fn(), recordMcpToolError: jest.fn(), updateMcpSessions: jest.fn() } },
      ],
    }).compile();

    controller = module.get<McpController>(McpController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHealth', () => {
    it('should return health with 20 tools', () => {
      const health = controller.getHealth();

      expect(health.status).toBe('ok');
      expect(health.tools).toBe(20);
      expect(health.server).toBe('mangwale-commerce');
    });

    it('should list both transports', () => {
      const health = controller.getHealth();

      expect(health.transports).toContain('sse');
      expect(health.transports).toContain('streamable-http');
      expect(health.transports).toHaveLength(2);
    });

    it('should show active session counts', () => {
      const health = controller.getHealth();

      expect(health.active_sessions).toHaveProperty('sse');
      expect(health.active_sessions).toHaveProperty('streamable_http');
      expect(health.active_sessions.sse).toBe(0);
      expect(health.active_sessions.streamable_http).toBe(0);
    });

    it('should list all endpoints including discovery and REST', () => {
      const health = controller.getHealth();

      expect(health.endpoints).toHaveProperty('streamable_http');
      expect(health.endpoints).toHaveProperty('sse');
      expect(health.endpoints).toHaveProperty('messages');
      expect(health.endpoints).toHaveProperty('health');
      expect(health.endpoints).toHaveProperty('openapi');
      expect(health.endpoints).toHaveProperty('rest_tools');
      expect(health.endpoints).toHaveProperty('discovery_mcp');
      expect(health.endpoints).toHaveProperty('discovery_chatgpt');
      expect(health.endpoints).toHaveProperty('discovery_gemini');
    });
  });

  describe('discovery endpoints', () => {
    it('should return MCP manifest', () => {
      const manifest = controller.getMcpManifest();
      expect(manifest.server.name).toBe('mangwale-commerce');
      expect(manifest.transports).toHaveProperty('streamable_http');
      expect(manifest.setup.claude_desktop).toBeDefined();
    });

    it('should return ChatGPT plugin manifest', () => {
      const manifest = controller.getAiPluginManifest();
      expect(manifest.name_for_model).toBe('mangwale_commerce');
      expect(manifest.api.type).toBe('openapi');
    });

    it('should return Gemini extensions manifest', () => {
      const manifest = controller.getGoogleAiExtensionsManifest();
      expect(manifest.name).toBe('mangwale_commerce');
      expect(manifest.api.type).toBe('openapi');
    });

    it('should return OpenAPI spec', () => {
      const spec = controller.getOpenApiSpec();
      expect(spec.openapi).toBe('3.1.0');
      expect(mcpOpenApiService.generateOpenApiSpec).toHaveBeenCalled();
    });
  });
});
