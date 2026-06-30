import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { WhatsAppCallingController } from './whatsapp-calling.controller';
import { WhatsAppCallingExecutorService } from '../services/whatsapp-calling-executor.service';
import { WhatsAppCallingPermissionService } from '../services/whatsapp-calling-permission.service';
import { WhatsAppCallingReadinessService } from '../services/whatsapp-calling-readiness.service';

const ADMIN_API_KEY = 'test-admin-api-key';

describe('WhatsAppCallingController admin auth boundary', () => {
  let app: INestApplication;
	  let previousAdminApiKey: string | undefined;
	  let readiness: { getReadiness: jest.Mock };
	  let executor: { dryRunApprovedCall: jest.Mock; preflightInboundSupportAccept: jest.Mock };
	  let permission: { getUseCases: jest.Mock; check: jest.Mock };

  beforeEach(async () => {
    previousAdminApiKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;

	    readiness = {
	      getReadiness: jest.fn().mockReturnValue({
	        ok: true,
	        channel: 'whatsapp_native_calling',
	        live_calling_available: false,
	      }),
	    };
	    executor = {
	      dryRunApprovedCall: jest.fn().mockResolvedValue({
	        ok: true,
	        mode: 'whatsapp_native_call_approved_dry_run',
	        status: 'blocked_live_whatsapp_calling_not_enabled',
	        dry_run: true,
	        provider_called: false,
	        external_call_performed: false,
	        execution_performed: false,
	        raw_pii_returned: false,
	      }),
	      preflightInboundSupportAccept: jest.fn().mockReturnValue({
	        ok: true,
	        mode: 'whatsapp_native_inbound_call_accept_preflight',
	        status: 'blocked_inbound_support_accept_not_enabled',
	        dry_run: true,
	        call_id_hash: 'a'.repeat(64),
	        manual_accept_allowed: false,
	        live_calling_available: false,
	        provider_called: false,
	        external_call_performed: false,
	        mutation_performed: false,
	        execution_performed: false,
	        raw_pii_returned: false,
	      }),
	    };
	    permission = {
	      getUseCases: jest.fn().mockReturnValue({
	        ok: true,
	        mode: 'whatsapp_calling_use_cases',
	        permission_check_path: '/api/whatsapp/calling/permission-check',
	        raw_pii_returned: false,
	      }),
	      check: jest.fn().mockReturnValue({
	        ok: true,
	        mode: 'whatsapp_call_permission_check',
	        dry_run: true,
	        allowed: false,
	        raw_pii_returned: false,
	        failures: ['WHATSAPP_CALLING_ENABLED is not true'],
	        safe_runtime_hashes: {
	          customer_phone_hash: 'hash-only',
	          call_permission_token_hash: 'hash-only',
	        },
	      }),
	    };

    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppCallingController],
      providers: [
	        { provide: WhatsAppCallingReadinessService, useValue: readiness },
	        { provide: WhatsAppCallingExecutorService, useValue: executor },
	        { provide: WhatsAppCallingPermissionService, useValue: permission },
	        AdminApiKeyGuard,
	      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previousAdminApiKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = previousAdminApiKey;
    }
  });

  it('rejects readiness checks without the admin API key', async () => {
    await request(app.getHttpServer())
      .get('/api/whatsapp/calling/readiness')
      .expect(401);

    expect(readiness.getReadiness).not.toHaveBeenCalled();
  });

	  it('returns readiness checks to admins without executing a call', async () => {
    await request(app.getHttpServer())
      .get('/api/whatsapp/calling/readiness')
      .set('X-Admin-Api-Key', ADMIN_API_KEY)
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual(expect.objectContaining({
          ok: true,
          channel: 'whatsapp_native_calling',
          live_calling_available: false,
        }));
      });

	    expect(readiness.getReadiness).toHaveBeenCalledTimes(1);
	  });

	  it('rejects approved call dry-runs without the admin API key', async () => {
	    await request(app.getHttpServer())
	      .post('/api/whatsapp/calling/approved-call')
	      .send({})
	      .expect(401);

	    expect(executor.dryRunApprovedCall).not.toHaveBeenCalled();
	  });

	  it('returns calling use cases to admins', async () => {
	    await request(app.getHttpServer())
	      .get('/api/whatsapp/calling/use-cases')
	      .set('X-Admin-Api-Key', ADMIN_API_KEY)
	      .expect(200)
	      .expect((res) => {
	        expect(res.body).toEqual(expect.objectContaining({
	          mode: 'whatsapp_calling_use_cases',
	          permission_check_path: '/api/whatsapp/calling/permission-check',
	          raw_pii_returned: false,
	        }));
	      });

	    expect(permission.getUseCases).toHaveBeenCalledTimes(1);
	  });

	  it('checks call permission without echoing raw customer inputs', async () => {
	    await request(app.getHttpServer())
	      .post('/api/whatsapp/calling/permission-check')
	      .set('X-Admin-Api-Key', ADMIN_API_KEY)
	      .send({
	        direction: 'business_initiated',
	        purpose: 'support_callback_requested',
	        customerPhone: '+91 98765 43210',
	        callPermissionToken: 'permission-token-1',
	      })
	      .expect(200)
	      .expect((res) => {
	        expect(res.body).toEqual(expect.objectContaining({
	          mode: 'whatsapp_call_permission_check',
	          dry_run: true,
	          allowed: false,
	          raw_pii_returned: false,
	        }));
	        expect(JSON.stringify(res.body)).not.toContain('98765');
	        expect(JSON.stringify(res.body)).not.toContain('permission-token-1');
	      });

	    expect(permission.check).toHaveBeenCalledWith(expect.objectContaining({
	      direction: 'business_initiated',
	      purpose: 'support_callback_requested',
	    }));
	  });

	  it('returns approved call dry-run without performing a provider call or echoing raw inputs', async () => {
	    await request(app.getHttpServer())
	      .post('/api/whatsapp/calling/approved-call')
	      .set('X-Admin-Api-Key', ADMIN_API_KEY)
	      .send({
	        approvalId: 'approval-1',
	        idempotencyKey: 'approval-1:wa-native-call:v1',
	        customerPhone: '+91 98765 43210',
	        callPermissionToken: 'permission-token-1',
	        script: 'Namaste from Mangwale support.',
	      })
	      .expect(200)
	      .expect((res) => {
	        expect(res.body).toEqual(expect.objectContaining({
	          mode: 'whatsapp_native_call_approved_dry_run',
	          dry_run: true,
	          provider_called: false,
	          external_call_performed: false,
	          execution_performed: false,
	        }));
	        expect(JSON.stringify(res.body)).not.toContain('98765');
	        expect(JSON.stringify(res.body)).not.toContain('permission-token-1');
	        expect(JSON.stringify(res.body)).not.toContain('Namaste');
	      });

	    expect(executor.dryRunApprovedCall).toHaveBeenCalledWith(expect.objectContaining({
	      approvalId: 'approval-1',
	      idempotencyKey: 'approval-1:wa-native-call:v1',
	    }));
	  });

	  it('rejects inbound accept preflights without the admin API key', async () => {
	    await request(app.getHttpServer())
	      .post(`/api/whatsapp/calling/inbound/${'a'.repeat(64)}/accept`)
	      .send({ idempotencyKey: 'call-accept:v1' })
	      .expect(401);

	    expect(executor.preflightInboundSupportAccept).not.toHaveBeenCalled();
	  });

	  it('returns inbound accept preflight as blocked without performing a provider call', async () => {
	    await request(app.getHttpServer())
	      .post(`/api/whatsapp/calling/inbound/${'a'.repeat(64)}/accept`)
	      .set('X-Admin-Api-Key', ADMIN_API_KEY)
	      .send({
	        idempotencyKey: 'call-accept:v1',
	        acceptedBy: 'support-lead',
	        reason: 'Customer called support from WhatsApp',
	      })
	      .expect(200)
	      .expect((res) => {
	        expect(res.body).toEqual(expect.objectContaining({
	          mode: 'whatsapp_native_inbound_call_accept_preflight',
	          dry_run: true,
	          manual_accept_allowed: false,
	          provider_called: false,
	          external_call_performed: false,
	          execution_performed: false,
	          raw_pii_returned: false,
	        }));
	        expect(JSON.stringify(res.body)).not.toContain('Customer called support');
	      });

	    expect(executor.preflightInboundSupportAccept).toHaveBeenCalledWith(
	      'a'.repeat(64),
	      expect.objectContaining({
	        idempotencyKey: 'call-accept:v1',
	        acceptedBy: 'support-lead',
	      }),
	    );
	  });
	});
