import { ConfigService } from '@nestjs/config';
import { WhatsAppCallingReadinessService } from './whatsapp-calling-readiness.service';

describe('WhatsAppCallingReadinessService', () => {
  function service(values: Record<string, string | undefined>) {
    return new WhatsAppCallingReadinessService({
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService);
  }

  it('fails closed when native calling is not configured', () => {
    const readiness = service({}).getReadiness();

    expect(readiness.live_calling_available).toBe(false);
    expect(readiness.user_initiated_ready).toBe(false);
    expect(readiness.business_initiated_ready).toBe(false);
    expect(readiness.readiness_by_direction.user_initiated).toEqual(expect.objectContaining({
      ready: false,
      requires_user_permission: false,
      requires_permission_template: false,
      manual_handoff_only: true,
      live_accept_available: false,
      provider_called: false,
      external_call_performed: false,
      execution_performed: false,
    }));
    expect(readiness.readiness_by_direction.business_initiated).toEqual(expect.objectContaining({
      ready: false,
      requires_user_permission: true,
      requires_permission_template: true,
      manual_handoff_only: true,
      live_accept_available: false,
      provider_called: false,
      external_call_performed: false,
      execution_performed: false,
    }));
    expect(readiness.enabled).toBe(false);
    expect(readiness.executor).toEqual({
      implemented: false,
      dry_run_approved_call_endpoint: true,
      enabled: false,
      execution_performed: false,
      permission_check_endpoint: true,
      use_cases_endpoint: true,
      approved_call_path: '/api/whatsapp/calling/approved-call',
      permission_check_path: '/api/whatsapp/calling/permission-check',
      use_cases_path: '/api/whatsapp/calling/use-cases',
    });
    expect(readiness.webhook_controls).toEqual(expect.objectContaining({
      graph_application_webhook_reference:
        'https://developers.facebook.com/docs/graph-api/webhooks/reference/application/',
      whatsapp_calling_reference:
        'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling',
      application_webhook_subscription_configured: false,
      callback_url_configured: false,
      callback_verification_configured: false,
      signature_validation_configured: false,
      calling_event_routing_to_approved_executor_only: false,
      permission_status_storage_hash_only: false,
      opt_out_configured: false,
      business_hours_configured: false,
      no_secret_values_returned: true,
    }));
    expect(readiness.webhook_controls.missing_controls).toEqual(expect.arrayContaining([
      'graph_application_webhook_subscription_configured',
      'webhook_callback_url_configured',
      'webhook_callback_url_verification_configured',
      'webhook_signature_validation_enabled',
      'calling_event_routing_to_approved_executor_only',
      'call_permission_status_storage_hash_only',
      'opt_out_and_business_hours_enforced_before_business_initiated_calls',
    ]));
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      'WHATSAPP_CALLING_ENABLED is not true',
      'WHATSAPP_CALLING_META_APPROVED is not true',
      'WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED is not true',
      'WHATSAPP_CALLING_GRAPH_APP_WEBHOOK_SUBSCRIBED is not true',
      'WHATSAPP_CALLING_WEBHOOK_VERIFY_TOKEN or WHATSAPP_VERIFY_TOKEN is not configured',
      'WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY is not true',
      'WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED is not true',
      'WHATSAPP_CALLING_OPTOUT_ENABLED and WHATSAPP_CALLING_BUSINESS_HOURS are not configured',
      'WHATSAPP_CALLING_SCHEMA_VERIFIED is not true',
      'WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED is not true',
      'WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED is not true',
      'WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED is not true',
    ]));
    expect(readiness.persistence).toEqual(expect.objectContaining({
      migration_required: '20260623_whatsapp_calling_audit',
      migration_path: 'prisma/migrations/20260623_whatsapp_calling_audit/migration.sql',
      schema_verified: false,
      audit_storage_enabled: false,
      writes_allowed: false,
      raw_pii_allowed: false,
    }));
    expect(readiness.sip).toEqual(expect.objectContaining({
      selected: false,
      enabled: false,
      endpoint_configured: false,
      support_queue: 'mangwale-support',
      provider_called: false,
      external_call_performed: false,
    }));
    expect(readiness.live_executor).toEqual(expect.objectContaining({
      implemented: true,
      enabled: false,
      provider_adapter_enabled: false,
      internal_allowlist_configured: false,
      template_approved: false,
      execution_performed: false,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
    }));
    expect(readiness.configured.WHATSAPP_ACCESS_TOKEN).toBe(false);
    expect(readiness.docs).toEqual(expect.arrayContaining([
      'https://developers.facebook.com/docs/graph-api/webhooks/reference/application/',
      'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling',
    ]));
    expect(readiness.safety_contract.outbound_requires_user_permission).toBe(true);
  });

  it('reports Meta/provider prerequisites without exposing values', () => {
    const readiness = service({
      WHATSAPP_CALLING_ENABLED: 'true',
      WHATSAPP_CALLING_META_APPROVED: 'true',
      WHATSAPP_CALLING_SIGNALING_MODE: 'sip',
      WHATSAPP_PHONE_NUMBER_ID: 'phone-number-id',
      WHATSAPP_ACCESS_TOKEN: 'secret-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-id',
      WHATSAPP_CALLING_WEBHOOK_URL: 'https://api.mangwale.com/whatsapp/calling/webhook',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME: 'call_permission',
      WHATSAPP_CALLING_BUSINESS_HOURS: '10:00-20:00',
      WHATSAPP_CALLING_GRAPH_APP_WEBHOOK_SUBSCRIBED: 'true',
      WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY: 'true',
      WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED: 'true',
      WHATSAPP_CALLING_OPTOUT_ENABLED: 'true',
      WHATSAPP_CALLING_SCHEMA_VERIFIED: 'true',
      WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED: 'true',
      WHATSAPP_CALLING_TEMPLATE_APPROVED: 'true',
      WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED: 'true',
      WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED: 'true',
      WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES: 'a'.repeat(64),
    }).getReadiness();

    expect(readiness.live_calling_available).toBe(false);
    expect(readiness.signaling_mode).toBe('sip');
    expect(readiness.capabilities).toEqual(expect.objectContaining({
      user_initiated_calls: false,
      business_initiated_calls: false,
      business_hours_control: true,
    }));
    expect(readiness.readiness_by_direction.user_initiated.blockers).toEqual(expect.arrayContaining([
      'WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED is not true',
      'WHATSAPP_CALLING_SIP_ENDPOINT is required for sip signaling mode',
    ]));
    expect(readiness.missing_config).toEqual([]);
    expect(readiness.webhook_controls).toEqual(expect.objectContaining({
      application_webhook_subscription_configured: true,
      callback_url_configured: true,
      callback_verification_configured: true,
      signature_validation_configured: true,
      calling_event_routing_to_approved_executor_only: true,
      permission_status_storage_hash_only: true,
      opt_out_configured: true,
      business_hours_configured: true,
      missing_controls: [],
    }));
    expect(readiness.blockers).toContain('WHATSAPP_CALLING_SIP_ENDPOINT is required for sip signaling mode');
    expect(readiness.persistence.writes_allowed).toBe(true);
    expect(readiness.live_executor).toEqual(expect.objectContaining({
      implemented: true,
      enabled: true,
      provider_adapter_enabled: true,
      internal_allowlist_configured: true,
      template_approved: true,
      execution_performed: false,
    }));
    expect(JSON.stringify(readiness)).not.toContain('secret-token');
    expect(JSON.stringify(readiness)).not.toContain('app-secret');
    expect(JSON.stringify(readiness)).not.toContain('verify-token');
  });

  it('does not block user-initiated inbound support readiness on the outbound permission template', () => {
    const readiness = service({
      WHATSAPP_CALLING_ENABLED: 'true',
      WHATSAPP_CALLING_META_APPROVED: 'true',
      WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED: 'true',
      WHATSAPP_CALLING_SIGNALING_MODE: 'graph_api',
      WHATSAPP_PHONE_NUMBER_ID: 'phone-number-id',
      WHATSAPP_ACCESS_TOKEN: 'secret-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-id',
      WHATSAPP_CALLING_WEBHOOK_URL: 'https://api.mangwale.ai/api/webhook/whatsapp',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_CALLING_BUSINESS_HOURS: '10:00-20:00',
      WHATSAPP_CALLING_GRAPH_APP_WEBHOOK_SUBSCRIBED: 'true',
      WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY: 'true',
      WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED: 'true',
      WHATSAPP_CALLING_OPTOUT_ENABLED: 'true',
      WHATSAPP_CALLING_SCHEMA_VERIFIED: 'true',
      WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED: 'true',
      WHATSAPP_CALLING_TEMPLATE_APPROVED: 'true',
      WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED: 'true',
      WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED: 'true',
      WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES: 'a'.repeat(64),
    }).getReadiness();

    expect(readiness.signaling_mode).toBe('graph_api');
    expect(readiness.live_calling_available).toBe(false);
    expect(readiness.user_initiated_ready).toBe(true);
    expect(readiness.business_initiated_ready).toBe(false);
    expect(readiness.capabilities.user_initiated_calls).toBe(true);
    expect(readiness.capabilities.business_initiated_calls).toBe(false);
    expect(readiness.missing_config).toContain('WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME');
    expect(readiness.readiness_by_direction.user_initiated.missing_config).not.toContain(
      'WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME',
    );
    expect(readiness.readiness_by_direction.user_initiated.blockers).not.toContain(
      'WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME is not configured',
    );
    expect(readiness.readiness_by_direction.business_initiated.blockers).toContain(
      'WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME is not configured for business-initiated calls',
    );
    expect(JSON.stringify(readiness)).not.toContain('secret-token');
    expect(JSON.stringify(readiness)).not.toContain('app-secret');
  });
});
