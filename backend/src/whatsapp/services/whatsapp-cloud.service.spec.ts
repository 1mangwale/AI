import * as crypto from 'crypto';
import { of } from 'rxjs';
import { WhatsAppCloudService } from './whatsapp-cloud.service';

const hash = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

describe('WhatsAppCloudService outbound allowlist', () => {
  function makeService(allowlist: string) {
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'whatsapp.phoneNumberId': 'phone-number-id',
          'whatsapp.accessToken': 'access-token',
          'whatsapp.apiVersion': 'v24.0',
          WHATSAPP_OUTBOUND_ALLOWED_RECIPIENT_HASHES: allowlist,
        };
        return values[key];
      }),
    };
    const httpService = {
      post: jest.fn().mockReturnValue(of({ data: { messages: [{ id: 'wamid.ok' }] } })),
    };

    return {
      service: new WhatsAppCloudService(configService as any, httpService as any),
      httpService,
    };
  }

  it('blocks non-allowlisted recipients before calling Meta', async () => {
    const { service, httpService } = makeService(hash('+919923383838'));

    await expect(service.sendText('+919999999999', 'hello')).rejects.toThrow(
      'WhatsApp outbound recipient is not allowlisted',
    );
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('allows the configured recipient hash and sends through Cloud API', async () => {
    const { service, httpService } = makeService(hash('+919923383838'));

    await expect(service.sendText('919923383838', 'hello')).resolves.toEqual({
      messages: [{ id: 'wamid.ok' }],
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v24.0/phone-number-id/messages',
      expect.objectContaining({
        messaging_product: 'whatsapp',
        to: '919923383838',
        type: 'text',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
        }),
      }),
    );
  });
});
