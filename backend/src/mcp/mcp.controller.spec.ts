import { Test, TestingModule } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpServerService } from './services/mcp-server.service';

describe('McpController', () => {
  let controller: McpController;
  let mcpServerService: Partial<McpServerService>;

  beforeEach(async () => {
    mcpServerService = {
      createServer: jest.fn().mockReturnValue({
        connect: jest.fn(),
        close: jest.fn(),
        setRequestHandler: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpServerService, useValue: mcpServerService },
      ],
    }).compile();

    controller = module.get<McpController>(McpController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHealth', () => {
    it('should return health with 18 tools', () => {
      const health = controller.getHealth();

      expect(health.status).toBe('ok');
      expect(health.tools).toBe(18);
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

    it('should list all endpoints', () => {
      const health = controller.getHealth();

      expect(health.endpoints).toHaveProperty('streamable_http');
      expect(health.endpoints).toHaveProperty('sse');
      expect(health.endpoints).toHaveProperty('messages');
      expect(health.endpoints).toHaveProperty('health');
    });
  });
});
