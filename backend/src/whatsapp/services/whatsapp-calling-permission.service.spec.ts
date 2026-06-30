import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { WhatsAppCallingPermissionService } from './whatsapp-calling-permission.service';

describe('WhatsAppCallingPermissionService', () => {
  function service(values: Record<string, string | undefined>) {
    return new WhatsAppCallingPermissionService({
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService);
  }

  it('describes Mangwale WhatsApp calling use cases without exposing PII', () => {
    const result = service({}).getUseCases();

    expect(result.ok).toBe(true);
    expect(result.first_pilot).toBe('customer_support_user_initiated_inbound_manual_handoff');
    expect(result.permission_check_path).toBe('/api/whatsapp/calling/permission-check');
    expect(result.user_initiated.map((useCase) => useCase.id)).toEqual(expect.arrayContaining([
      'customer_support_inbound',
      'order_intake_help_inbound',
    ]));
    expect(result.business_initiated.map((useCase) => useCase.id)).toEqual(expect.arrayContaining([
      'support_callback_requested',
      'missed_user_call_callback',
      'late_order_escalation_callback',
    ]));
    expect(result.blocked.map((useCase) => useCase.id)).toContain('cold_marketing_or_sales_call');
    expect(result.raw_pii_returned).toBe(false);
  });

  it('fails closed when runtime calling controls are not configured', () => {
    const result = service({}).check({
      direction: 'business_initiated',
      purpose: 'support_callback_requested',
      customerPhone: '+91 98765 43210',
      callPermissionToken: 'permission-token-1',
      permissionExpiresAt: '2026-06-24T12:00:00.000Z',
      now: '2026-06-23T06:00:00.000Z',
    });

    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'WHATSAPP_CALLING_ENABLED is not true',
      'WHATSAPP_CALLING_META_APPROVED is not true',
      'WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY is not true',
      'WHATSAPP_CALLING_BUSINESS_HOURS is not configured',
      'WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED is not true',
      'WHATSAPP_CALLING_OPTOUT_ENABLED is not true',
    ]));
    expect(result.safe_runtime_hashes.customer_phone_hash).toBe(sha256('9876543210'));
    expect(result.safe_runtime_hashes.call_permission_token_hash).toBe(sha256('permission-token-1'));
    expect(JSON.stringify(result)).not.toContain('98765');
    expect(JSON.stringify(result)).not.toContain('permission-token-1');
  });

  it('allows a business-initiated callback only when permission and runtime gates are present', () => {
    const result = service(liveLikeEnv()).check({
      direction: 'business_initiated',
      purpose: 'support_callback_requested',
      customerPhone: '+91 98765 43210',
      callPermissionToken: 'permission-token-1',
      permissionExpiresAt: '2026-06-24T12:00:00.000Z',
      permissionSource: 'call_permission_request',
      now: '2026-06-23T07:00:00.000Z',
    });

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('permission_ready_when_live_executor_exists');
    expect(result.controls).toEqual(expect.objectContaining({
      calling_enabled: true,
      meta_approved: true,
      supported_use_case: true,
      approved_executor_routing_configured: true,
      permission_hash_storage_hash_only: true,
      opt_out_configured: true,
      business_hours_configured: true,
      within_business_hours: true,
      permission_not_expired_or_ongoing: true,
    }));
    expect(result.failures).toEqual([]);
  });

  it('blocks unsupported marketing calls and customer opt-outs', () => {
    const result = service(liveLikeEnv()).check({
      direction: 'business_initiated',
      purpose: 'cold_marketing_or_sales_call',
      callPermissionTokenHash: sha256('permission-token-1'),
      ongoingPermission: true,
      permissionSource: 'callback_permission',
      customerOptedOut: true,
      now: '2026-06-23T07:00:00.000Z',
    });

    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'unsupported_calling_purpose',
      'customer_opted_out',
    ]));
    expect(result.blocked_actions).toEqual(expect.arrayContaining([
      'no_provider_call',
      'manual_support_only',
    ]));
  });

  it('does not require a call permission token for user-initiated inbound support', () => {
    const result = service(liveLikeEnv()).check({
      direction: 'user_initiated',
      purpose: 'customer_support_inbound',
      customerPhoneHash: sha256('9876543210'),
      now: '2026-06-23T07:00:00.000Z',
    });

    expect(result.allowed).toBe(true);
    expect(result.controls.call_permission_hash_present).toBe(true);
    expect(result.allowed_actions).toContain('manual_human_route');
    expect(result.blocked_actions).toEqual(expect.arrayContaining([
      'auto_answer',
      'ai_audio_playback',
      'outbound_callback',
    ]));
  });
});

function liveLikeEnv(): Record<string, string> {
  return {
    WHATSAPP_CALLING_ENABLED: 'true',
    WHATSAPP_CALLING_META_APPROVED: 'true',
    WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY: 'true',
    WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED: 'true',
    WHATSAPP_CALLING_OPTOUT_ENABLED: 'true',
    WHATSAPP_CALLING_BUSINESS_HOURS: '09:00-21:00',
    WHATSAPP_CALLING_BUSINESS_HOURS_TIMEZONE: 'Asia/Kolkata',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
