import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  CentralizedAuthService,
  AuthenticatedUser,
  AuthEvent
} from './centralized-auth.service';
import { PhpAuthService } from '../php-integration/services/php-auth.service';
import { PrismaService } from '../database/prisma.service';
import { UserProfilingService } from '../personalization/user-profiling.service';
import { REDIS_CLIENT, REDIS_PUBLISHER } from '../redis/redis.module';

// Mock Redis
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  sadd: jest.fn(),
  smembers: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn().mockResolvedValue(-1),
  keys: jest.fn().mockResolvedValue([]),
  publish: jest.fn(),
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  duplicate: jest.fn().mockReturnThis(),
  status: 'ready',
  pipeline: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    setex: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  }),
  multi: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    setex: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  }),
};

const mockRedisPublisher = {
  publish: jest.fn().mockResolvedValue(1),
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  status: 'ready',
};

describe('CentralizedAuthService', () => {
  let service: CentralizedAuthService;
  let phpAuthService: PhpAuthService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, any> = {
        'redis.host': 'localhost',
        'redis.port': 6379,
        'redis.password': '',
        'redis.db': 0,
      };
      return config[key] ?? defaultValue;
    }),
  };

  const mockPhpAuthService = {
    getUserProfile: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockPrismaService = {
      authSession: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    };
    const mockProfileEnrichment = {
      enrichProfile: jest.fn().mockResolvedValue({}),
      getEnrichedProfile: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CentralizedAuthService,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: REDIS_PUBLISHER,
          useValue: mockRedisPublisher,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: PhpAuthService,
          useValue: mockPhpAuthService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: UserProfilingService,
          useValue: mockProfileEnrichment,
        },
      ],
    }).compile();

    service = module.get<CentralizedAuthService>(CentralizedAuthService);
    phpAuthService = module.get<PhpAuthService>(PhpAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });
  });

  describe('isAuthenticated', () => {
    it('should return true when user is authenticated', async () => {
      mockRedis.exists.mockResolvedValue(1);

      const result = await service.isAuthenticated('+919876543210');

      expect(result).toBe(true);
      // normalizePhoneNumber removes + prefix for key
      expect(mockRedis.exists).toHaveBeenCalledWith('auth:919876543210');
    });

    it('should return false when user is not authenticated', async () => {
      mockRedis.exists.mockResolvedValue(0);

      const result = await service.isAuthenticated('+919876543210');

      expect(result).toBe(false);
    });

    it('should handle phone numbers without + prefix', async () => {
      mockRedis.exists.mockResolvedValue(1);

      // 10-digit Indian number gets normalized to +91...
      await service.isAuthenticated('9876543210');

      expect(mockRedis.exists).toHaveBeenCalledWith('auth:919876543210');
    });
  });

  describe('getAuthenticatedUser', () => {
    it('should return user when authenticated', async () => {
      const authUser: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        token: 'token123',
        authenticatedAt: Date.now() - 10000,
        lastActiveAt: Date.now() - 10000,
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(authUser));
      mockRedis.setex.mockResolvedValue('OK');

      const result = await service.getAuthenticatedUser('+919876543210');

      expect(result).toBeDefined();
      expect(result?.userId).toBe(1);
      expect(result?.firstName).toBe('John');
      // Should update lastActiveAt
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should return null when not authenticated', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getAuthenticatedUser('+919876543210');

      expect(result).toBeNull();
    });

    it('should return null on parse error', async () => {
      mockRedis.get.mockResolvedValue('invalid json');

      const result = await service.getAuthenticatedUser('+919876543210');

      expect(result).toBeNull();
    });
  });

  describe('authenticateUser', () => {
    it('should authenticate a new user', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      const result = await service.authenticateUser(
        '+919876543210',
        'token123',
        {
          userId: 1,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
        },
        'web',
      );

      expect(result.userId).toBe(1);
      expect(result.firstName).toBe('John');
      expect(result.token).toBe('token123');
      expect(result.channels).toContain('web');
      expect(mockRedis.setex).toHaveBeenCalled();
      expect(mockRedisPublisher.publish).toHaveBeenCalledWith(
        'auth:events',
        expect.any(String),
      );
    });

    it('should add new channel to existing user', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'oldToken',
        authenticatedAt: Date.now() - 10000,
        lastActiveAt: Date.now() - 10000,
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      const result = await service.authenticateUser(
        '+919876543210',
        'newToken',
        {
          userId: 1,
          firstName: 'John',
        },
        'whatsapp',
      );

      expect(result.channels).toContain('web');
      expect(result.channels).toContain('whatsapp');
      expect(result.token).toBe('newToken');
    });

    it('should not duplicate channels', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'oldToken',
        authenticatedAt: Date.now() - 10000,
        lastActiveAt: Date.now() - 10000,
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      const result = await service.authenticateUser(
        '+919876543210',
        'newToken',
        { userId: 1, firstName: 'John' },
        'web', // Same channel
      );

      expect(result.channels.filter(c => c === 'web').length).toBe(1);
    });
  });  describe('logoutUser', () => {
    it('should fully logout when no channel specified', async () => {
      mockRedis.del.mockResolvedValue(1);
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.logoutUser('+919876543210');

      expect(mockRedis.del).toHaveBeenCalledWith('auth:919876543210');
      expect(mockRedisPublisher.publish).toHaveBeenCalled();
    });

    it('should remove only specific channel', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'token123',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now(),
        channels: ['web', 'whatsapp'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.logoutUser('+919876543210', 'web');

      // First setex is from getAuthenticatedUser updating lastActiveAt
      // Second setex is from logoutUser saving the updated auth
      expect(mockRedis.setex.mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastSetexCall = mockRedis.setex.mock.calls[mockRedis.setex.mock.calls.length - 1];
      const savedData = JSON.parse(lastSetexCall[2]);
      expect(savedData.channels).not.toContain('web');
      expect(savedData.channels).toContain('whatsapp');
    });

    it('should fully logout when last channel removed', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'token123',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now(),
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.del.mockResolvedValue(1);
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.logoutUser('+919876543210', 'web');

      expect(mockRedis.del).toHaveBeenCalledWith('auth:919876543210');
    });
  });

  describe('refreshToken', () => {
    it('should refresh token for existing user', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'oldToken',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now() - 1000,
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.refreshToken('+919876543210', 'newToken');

      // First setex is from getAuthenticatedUser updating lastActiveAt
      // Second setex is from refreshToken saving the new token
      expect(mockRedis.setex.mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastSetexCall = mockRedis.setex.mock.calls[mockRedis.setex.mock.calls.length - 1];
      const savedData = JSON.parse(lastSetexCall[2]);
      expect(savedData.token).toBe('newToken');
    });

    it('should do nothing if user not authenticated', async () => {
      mockRedis.get.mockResolvedValue(null);

      await service.refreshToken('+919876543210', 'newToken');

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('getToken', () => {
    it('should return token when user is authenticated', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'token123',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now(),
        channels: ['web'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');

      const result = await service.getToken('+919876543210');

      expect(result).toBe('token123');
    });

    it('should return null when not authenticated', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getToken('+919876543210');

      expect(result).toBeNull();
    });
  });

  describe('linkSessionToPhone', () => {
    it('should link session to phone', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.sadd.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      await service.linkSessionToPhone('session123', '+919876543210');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'session_phone:session123',
        expect.any(Number),
        expect.stringContaining('919876543210'),
      );
      expect(mockRedis.sadd).toHaveBeenCalledWith(
        expect.stringContaining('phone_sessions:'),
        'session123',
      );
    });
  });

  describe('getPhoneForSession', () => {
    it('should return phone for session', async () => {
      mockRedis.get.mockResolvedValue('+919876543210');

      const result = await service.getPhoneForSession('session123');

      expect(result).toBe('+919876543210');
      expect(mockRedis.get).toHaveBeenCalledWith('session_phone:session123');
    });

    it('should return null when session not linked', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getPhoneForSession('session123');

      expect(result).toBeNull();
    });
  });

  describe('getSessionsForPhone', () => {
    it('should return sessions for phone', async () => {
      mockRedis.smembers.mockResolvedValue(['session1', 'session2']);

      const result = await service.getSessionsForPhone('+919876543210');

      expect(result).toEqual(['session1', 'session2']);
    });

    it('should return empty array when no sessions', async () => {
      mockRedis.smembers.mockResolvedValue([]);

      const result = await service.getSessionsForPhone('+919876543210');

      expect(result).toEqual([]);
    });
  });

  describe('syncFromPhpBackend', () => {
    it('should sync auth from PHP backend', async () => {
      mockPhpAuthService.getUserProfile.mockResolvedValue({
        id: 1,
        phone: '+919876543210',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      });
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      const result = await service.syncFromPhpBackend('token123', 'web');

      expect(result).toBeDefined();
      expect(result?.userId).toBe(1);
      expect(mockPhpAuthService.getUserProfile).toHaveBeenCalledWith('token123');
    });

    it('should return null when profile not found', async () => {
      mockPhpAuthService.getUserProfile.mockResolvedValue(null);

      const result = await service.syncFromPhpBackend('invalidToken', 'web');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockPhpAuthService.getUserProfile.mockRejectedValue(
        new Error('API error'),
      );

      const result = await service.syncFromPhpBackend('token123', 'web');

      expect(result).toBeNull();
    });
  });

  describe('getAuthData', () => {
    it('should return auth data in compatible format', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'token123',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now(),
        channels: ['web', 'whatsapp'],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');

      const result = await service.getAuthData('+919876543210');

      expect(result).toEqual({
        userId: 1,
        userName: 'John',
        platform: 'whatsapp', // Last channel
      });
    });

    it('should return null when not authenticated', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getAuthData('+919876543210');

      expect(result).toBeNull();
    });
  });

  describe('logout', () => {
    it('should logout user (alias)', async () => {
      mockRedis.del.mockResolvedValue(1);
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.logout('+919876543210');

      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  describe('broadcastAuthEvent', () => {
    it('should broadcast to all sessions', async () => {
      mockRedis.smembers.mockResolvedValue(['session1', 'session2']);
      
      const mockWsServer = {
        to: jest.fn().mockReturnValue({
          emit: jest.fn(),
        }),
      };

      await service.broadcastAuthEvent(
        '+919876543210',
        'auth_success',
        { userId: 1 },
        mockWsServer,
      );

      expect(mockWsServer.to).toHaveBeenCalledWith('session1');
      expect(mockWsServer.to).toHaveBeenCalledWith('session2');
    });
  });

  describe('syncAuthAcrossSessions', () => {
    it('should publish auth sync event', async () => {
      mockRedis.smembers.mockResolvedValue(['session1', 'session2']);
      mockRedisPublisher.publish.mockResolvedValue(1);

      await service.syncAuthAcrossSessions('+919876543210', 1, 'token123');

      expect(mockRedisPublisher.publish).toHaveBeenCalledWith(
        'auth:events',
        expect.any(String),
      );
      const publishedEvent = JSON.parse(mockRedisPublisher.publish.mock.calls[0][1]);
      expect(publishedEvent.type).toBe('LOGIN');
      expect(publishedEvent.userId).toBe(1);
    });
  });

  describe('Phone Number Normalization', () => {
    it('should handle +91 prefix', async () => {
      mockRedis.exists.mockResolvedValue(1);

      await service.isAuthenticated('+911234567890');

      // Should normalize the phone number
      expect(mockRedis.exists).toHaveBeenCalled();
    });

    it('should handle phone without country code', async () => {
      mockRedis.exists.mockResolvedValue(1);

      await service.isAuthenticated('1234567890');

      expect(mockRedis.exists).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty channels array', async () => {
      const existingAuth: AuthenticatedUser = {
        userId: 1,
        phone: '+919876543210',
        firstName: 'John',
        token: 'token123',
        authenticatedAt: Date.now(),
        lastActiveAt: Date.now(),
        channels: [],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingAuth));
      mockRedis.setex.mockResolvedValue('OK');

      const result = await service.getAuthData('+919876543210');

      expect(result?.platform).toBe('unknown');
    });

    it('should handle concurrent authentication requests', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedisPublisher.publish.mockResolvedValue(1);

      const promises = [
        service.authenticateUser(
          '+919876543210',
          'token1',
          { userId: 1, firstName: 'John' },
          'web',
        ),
        service.authenticateUser(
          '+919876543210',
          'token2',
          { userId: 1, firstName: 'John' },
          'whatsapp',
        ),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(2);
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);
    });
  });
});
