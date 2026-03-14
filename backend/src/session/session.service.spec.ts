import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SessionService, Session } from './session.service';
import { REDIS_CLIENT } from '../redis/redis.module';

// Mock Redis
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  exists: jest.fn(),
  rpush: jest.fn(),
  lrange: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn().mockResolvedValue(-1),
  scan: jest.fn().mockResolvedValue(['0', []]),
  ping: jest.fn(),
  lpop: jest.fn().mockResolvedValue(null),
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

describe('SessionService', () => {
  let service: SessionService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, any> = {
        'redis.host': 'localhost',
        'redis.port': 6379,
        'redis.password': '',
        'redis.db': 0,
        'session.ttl': 3600,
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    // Clear all mock calls
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should initialize with config values', () => {
      expect(mockConfigService.get).toHaveBeenCalledWith('session.ttl');
    });
  });

  describe('getSession', () => {
    it('should return session when it exists', async () => {
      const sessionData: Session = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { foo: 'bar' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(sessionData));

      const result = await service.getSession('+1234567890');

      expect(result).toEqual(sessionData);
      expect(mockRedis.get).toHaveBeenCalledWith('session:+1234567890');
    });

    it('should return null when session does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getSession('+1234567890');

      expect(result).toBeNull();
    });

    it('should return null on redis error', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.getSession('+1234567890');

      expect(result).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      const result = await service.createSession('+1234567890');

      expect(result).toMatchObject({
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
      });
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('saveSession', () => {
    it('should save session with TTL', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.saveSession('+1234567890', { currentStep: 'menu' });

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'session:+1234567890',
        3600,
        expect.any(String),
      );
    });

    it('should merge with existing session data', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { existingKey: 'value' },
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.saveSession('+1234567890', { currentStep: 'menu' });

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.currentStep).toBe('menu');
      expect(savedData.data.existingKey).toBe('value');
    });
  });

  describe('updateSession', () => {
    it('should update session data', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { existingKey: 'value' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.updateSession('+1234567890', { newKey: 'newValue' });

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.data.existingKey).toBe('value');
      expect(savedData.data.newKey).toBe('newValue');
    });

    it('should create session if it does not exist', async () => {
      mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.updateSession('+1234567890', { newKey: 'newValue' });

      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('setStep', () => {
    it('should set current step', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.setStep('+1234567890', 'menu');

      // Check the last setex call (saveSession may trigger multiple writes)
      const lastCall = mockRedis.setex.mock.calls[mockRedis.setex.mock.calls.length - 1];
      const savedData = JSON.parse(lastCall[2]);
      expect(savedData.currentStep).toBe('menu');
    });

    it('should set step with additional data', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.setStep('+1234567890', 'menu', { selectedOption: 'food' });

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.currentStep).toBe('menu');
      expect(savedData.data.selectedOption).toBe('food');
    });
  });

  describe('clearStep', () => {
    it('should reset step to welcome', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'menu',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.clearStep('+1234567890');

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.currentStep).toBe('welcome');
    });
  });

  describe('getData', () => {
    it('should return specific key data', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { name: 'John', age: 30 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));

      const result = await service.getData('+1234567890', 'name');

      expect(result).toBe('John');
    });

    it('should return all data when no key specified', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { name: 'John', age: 30 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));

      const result = await service.getData('+1234567890');

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('should return null when session does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getData('+1234567890', 'name');

      expect(result).toBeNull();
    });
  });

  describe('setData', () => {
    it('should set single key-value pair', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.setData('+1234567890', 'name', 'John');

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.data.name).toBe('John');
    });

    it('should set multiple data as object', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.setData('+1234567890', { name: 'John', age: 30 });

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.data.name).toBe('John');
      expect(savedData.data.age).toBe(30);
    });
  });

  describe('clearOrderData', () => {
    it('should clear order data but keep auth', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'order',
        data: {
          auth_token: 'token123',
          user_info: { id: 1 },
          cart: ['item1', 'item2'],
          orderDetails: { total: 100 },
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.clearOrderData('+1234567890');

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.data.auth_token).toBe('token123');
      expect(savedData.data.user_info).toEqual({ id: 1 });
      expect(savedData.data.cart).toBeUndefined();
      expect(savedData.data.orderDetails).toBeUndefined();
      expect(savedData.currentStep).toBe('modules');
    });

    it('should do nothing if session does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);

      await service.clearOrderData('+1234567890');

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('clearSession', () => {
    it('should delete session from redis', async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.clearSession('+1234567890');

      expect(mockRedis.del).toHaveBeenCalledWith('session:+1234567890');
    });
  });

  describe('deleteSession', () => {
    it('should delete session and bot messages', async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.deleteSession('+1234567890');

      expect(mockRedis.del).toHaveBeenCalledWith('session:+1234567890');
      expect(mockRedis.del).toHaveBeenCalledWith('bot_messages:+1234567890');
    });
  });

  describe('getAllSessions', () => {
    it('should return all sessions', async () => {
      const sessions = [
        { phoneNumber: '+1', currentStep: 'a', data: {}, createdAt: 1, updatedAt: 1 },
        { phoneNumber: '+2', currentStep: 'b', data: {}, createdAt: 2, updatedAt: 2 },
      ];
      // Service uses redis.scan instead of redis.keys
      mockRedis.scan.mockResolvedValue(['0', ['session:+1', 'session:+2']]);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(sessions[0]))
        .mockResolvedValueOnce(JSON.stringify(sessions[1]));

      const result = await service.getAllSessions();

      expect(result).toHaveLength(2);
      expect(result[0].phoneNumber).toBe('+1');
      expect(result[1].phoneNumber).toBe('+2');
    });

    it('should return empty array on error', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));

      const result = await service.getAllSessions();

      expect(result).toEqual([]);
    });
  });

  describe('storeBotMessage', () => {
    it('should store message in redis list', async () => {
      mockRedis.rpush.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      await service.storeBotMessage('+1234567890', 'Hello!');

      expect(mockRedis.rpush).toHaveBeenCalledWith(
        'bot_messages:+1234567890',
        expect.stringContaining('Hello!'),
      );
      expect(mockRedis.expire).toHaveBeenCalledWith('bot_messages:+1234567890', 300);
    });
  });

  describe('getBotMessages', () => {
    it('should return messages', async () => {
      const messages = [
        JSON.stringify({ message: 'Hello!', timestamp: Date.now() }),
        JSON.stringify({ message: 'How can I help?', timestamp: Date.now() }),
      ];
      mockRedis.lrange.mockResolvedValue(messages);

      const result = await service.getBotMessages('+1234567890');

      expect(result).toHaveLength(2);
      expect(result[0].message).toBe('Hello!');
      // getBotMessages no longer deletes messages; caller must explicitly acknowledge
    });

    it('should return empty array when no messages', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      const result = await service.getBotMessages('+1234567890');

      expect(result).toEqual([]);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('peekBotMessages', () => {
    it('should return messages without deleting', async () => {
      const messages = [
        JSON.stringify({ message: 'Hello!', timestamp: Date.now() }),
      ];
      mockRedis.lrange.mockResolvedValue(messages);

      const result = await service.peekBotMessages('+1234567890');

      expect(result).toHaveLength(1);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('clearBotMessages', () => {
    it('should delete bot messages', async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.clearBotMessages('+1234567890');

      expect(mockRedis.del).toHaveBeenCalledWith('bot_messages:+1234567890');
    });
  });

  describe('ping', () => {
    it('should return true when redis responds', async () => {
      mockRedis.ping.mockResolvedValue('PONG');

      const result = await service.ping();

      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection error'));

      const result = await service.ping();

      expect(result).toBe(false);
    });
  });

  describe('clearAuth', () => {
    it('should clear auth data from session', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: {
          user_id: 1,
          phone: '+1234567890',
          auth_token: 'token123',
          user_name: 'John',
          authenticated: true,
          authenticated_at: Date.now(),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.clearAuth('+1234567890');

      const savedData = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(savedData.data.user_id).toBeNull();
      expect(savedData.data.auth_token).toBeNull();
      expect(savedData.data.authenticated).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle phone numbers with different formats', async () => {
      mockRedis.get.mockResolvedValue(null);

      await service.getSession('1234567890');
      await service.getSession('+1234567890');
      await service.getSession('91-1234567890');

      expect(mockRedis.get).toHaveBeenCalledWith('session:1234567890');
      expect(mockRedis.get).toHaveBeenCalledWith('session:+1234567890');
      expect(mockRedis.get).toHaveBeenCalledWith('session:91-1234567890');
    });

    it('should handle concurrent session updates', async () => {
      const existingSession = {
        phoneNumber: '+1234567890',
        currentStep: 'welcome',
        data: { counter: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(existingSession));
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      // Simulate concurrent updates
      await Promise.all([
        service.setData('+1234567890', 'key1', 'value1'),
        service.setData('+1234567890', 'key2', 'value2'),
      ]);

      // Both should complete without error
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);
    });

    it('should handle empty data objects', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.exists.mockResolvedValue(1);

      await service.updateSession('+1234567890', {});

      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });
});
