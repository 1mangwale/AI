import * as crypto from 'crypto';
import { WebhookController } from './webhook.controller';

const hash = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

describe('WebhookController WhatsApp reply allowlist', () => {
  const allowedSender = '+919923383838';
  const allowedSenderHash = hash(allowedSender);

  function makeController(allowlist = allowedSenderHash) {
    const sessionService = {
      getSession: jest.fn().mockResolvedValue({ currentStep: 'start', data: { user_id: 7 } }),
      createSession: jest.fn().mockResolvedValue({ currentStep: 'start', data: {} }),
      setData: jest.fn().mockResolvedValue(undefined),
      deleteSession: jest.fn(),
      getBotMessages: jest.fn(),
      getAllSessions: jest.fn(),
    };
    const messageService = { sendTextMessage: jest.fn().mockResolvedValue(undefined) };
    const conversationLogger = {
      logUserMessage: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string> = {
          'whatsapp.verifyToken': 'verify-token',
          'whatsapp.accessToken': 'access-token',
          'whatsapp.apiVersion': 'v24.0',
          WHATSAPP_APP_SECRET: 'app-secret',
          WHATSAPP_REPLY_ALLOWED_SENDER_HASHES: allowlist,
        };
        return values[key] ?? fallback;
      }),
    };
    const whatsappCloudService = {
      markAsRead: jest.fn().mockResolvedValue(true),
      sendTypingIndicator: jest.fn().mockResolvedValue(false),
    };
    const messageGateway = {
      handleWhatsAppMessage: jest.fn().mockResolvedValue({ success: true }),
    };

    const controller = new WebhookController(
      sessionService as any,
      messageService as any,
      {} as any,
      conversationLogger as any,
      configService as any,
      {} as any,
      {} as any,
      messageGateway as any,
      whatsappCloudService as any,
      {} as any,
    );

    return {
      controller: controller as any,
      sessionService,
      messageService,
      conversationLogger,
      whatsappCloudService,
      messageGateway,
    };
  }

  it('blocks non-allowlisted inbound messages before read receipts or replies', async () => {
    const { controller, sessionService, whatsappCloudService, messageGateway } =
      makeController();

    await controller.handleIncomingMessage({
      id: 'wamid.blocked',
      from: '919999999999',
      type: 'text',
      text: { body: 'parcel bhejna hai' },
    });

    expect(sessionService.getSession).not.toHaveBeenCalled();
    expect(whatsappCloudService.markAsRead).not.toHaveBeenCalled();
    expect(whatsappCloudService.sendTypingIndicator).not.toHaveBeenCalled();
    expect(messageGateway.handleWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('allows the configured sender hash to continue through MessageGateway', async () => {
    const { controller, whatsappCloudService, messageGateway, conversationLogger } =
      makeController();

    await controller.handleIncomingMessage({
      id: 'wamid.allowed',
      from: '919923383838',
      type: 'text',
      text: { body: 'cod parcel bhejna hai' },
    });

    expect(whatsappCloudService.markAsRead).toHaveBeenCalledWith('wamid.allowed');
    expect(conversationLogger.logUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: 'cod parcel bhejna hai',
        platform: 'whatsapp',
      }),
    );
    expect(messageGateway.handleWhatsAppMessage).toHaveBeenCalledWith(
      allowedSender,
      'cod parcel bhejna hai',
      expect.objectContaining({
        messageId: 'wamid.allowed',
        type: 'text',
      }),
    );
  });
});
