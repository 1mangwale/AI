import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

type ConfigReader = Pick<ConfigService, 'get'>;

export type WhatsAppCallingDirection = 'user_initiated' | 'business_initiated';
export type WhatsAppCallingPermissionSource =
  | 'call_permission_request'
  | 'callback_permission'
  | 'business_profile'
  | 'manual_import_hash_only'
  | 'none';

export interface WhatsAppCallingUseCase {
  id: string;
  direction: WhatsAppCallingDirection;
  first_pilot: boolean;
  description: string;
  requires_user_permission: boolean;
  requires_human_approval: boolean;
  allowed_actions: string[];
  blocked_actions: string[];
}

export interface WhatsAppCallingUseCasesResponse {
  ok: true;
  mode: 'whatsapp_calling_use_cases';
  channel: 'whatsapp_native_calling';
  first_pilot: 'customer_support_user_initiated_inbound_manual_handoff';
  user_initiated: WhatsAppCallingUseCase[];
  business_initiated: WhatsAppCallingUseCase[];
  blocked: WhatsAppCallingUseCase[];
  permission_check_path: '/api/whatsapp/calling/permission-check';
  approved_call_path: '/api/whatsapp/calling/approved-call';
  raw_pii_returned: false;
  docs: string[];
}

export interface WhatsAppCallingPermissionCheckRequest {
  direction?: WhatsAppCallingDirection;
  purpose?: string;
  customerPhone?: string;
  customerPhoneHash?: string;
  callPermissionToken?: string;
  callPermissionTokenHash?: string;
  permissionExpiresAt?: string;
  ongoingPermission?: boolean;
  permissionSource?: WhatsAppCallingPermissionSource;
  customerOptedOut?: boolean;
  now?: string;
}

export interface WhatsAppCallingPermissionCheckResult {
  ok: true;
  mode: 'whatsapp_call_permission_check';
  dry_run: true;
  direction: WhatsAppCallingDirection;
  purpose: string;
  allowed: boolean;
  status: 'permission_ready_when_live_executor_exists' | 'blocked_by_permission_or_runtime_gate';
  raw_pii_returned: false;
  safe_runtime_hashes: {
    customer_phone_hash: string;
    call_permission_token_hash: string;
  };
  controls: {
    calling_enabled: boolean;
    meta_approved: boolean;
    supported_use_case: boolean;
    approved_executor_routing_configured: boolean;
    permission_hash_storage_hash_only: boolean;
    call_permission_hash_present: boolean;
    permission_not_expired_or_ongoing: boolean;
    ongoing_permission: boolean;
    permission_source: WhatsAppCallingPermissionSource;
    opt_out_configured: boolean;
    customer_opted_out: boolean;
    business_hours_configured: boolean;
    within_business_hours: boolean;
    business_hours_timezone: string;
    business_hours_window: string | null;
  };
  failures: string[];
  allowed_actions: string[];
  blocked_actions: string[];
  docs: string[];
  next_step: string;
}

const WHATSAPP_CALLING_DOCS = [
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples',
];

const USER_INITIATED_USE_CASES: WhatsAppCallingUseCase[] = [
  {
    id: 'customer_support_inbound',
    direction: 'user_initiated',
    first_pilot: true,
    description:
      'Customer calls Mangwale from WhatsApp for late order, tracking confusion, cancellation/refund explanation, payment issue, or low-rating recovery support.',
    requires_user_permission: false,
    requires_human_approval: false,
    allowed_actions: ['manual_human_route', 'create_support_draft', 'human_handoff'],
    blocked_actions: [
      'auto_answer',
      'ai_audio_playback',
      'outbound_callback',
      'checkout',
      'refund',
      'cancel_order',
      'vendor_mutation',
      'rider_mutation',
    ],
  },
  {
    id: 'order_intake_help_inbound',
    direction: 'user_initiated',
    first_pilot: true,
    description:
      'Customer calls because WhatsApp order-intake is stuck; agent may draft a cart or guide the customer, but checkout still requires confirmation.',
    requires_user_permission: false,
    requires_human_approval: false,
    allowed_actions: ['capture_transcript', 'draft_cart', 'manual_search_help'],
    blocked_actions: ['autonomous_checkout', 'payment', 'refund', 'cancel_order'],
  },
  {
    id: 'vendor_rider_support_inbound',
    direction: 'user_initiated',
    first_pilot: false,
    description:
      'Future lane for vendor/rider operational support if the same WhatsApp business number is explicitly routed for those actor types.',
    requires_user_permission: false,
    requires_human_approval: false,
    allowed_actions: ['route_to_agent', 'support_draft'],
    blocked_actions: ['wallet_mutation', 'settlement_mutation', 'assignment_mutation'],
  },
];

const BUSINESS_INITIATED_USE_CASES: WhatsAppCallingUseCase[] = [
  {
    id: 'support_callback_requested',
    direction: 'business_initiated',
    first_pilot: true,
    description:
      'Customer requested a callback in WhatsApp/app/support, and a human-approved agent calls back within the permission window.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'support_script', 'support_audit_log'],
    blocked_actions: ['cold_call', 'autonomous_call', 'refund', 'cancel_order', 'charge_customer'],
  },
  {
    id: 'missed_user_call_callback',
    direction: 'business_initiated',
    first_pilot: true,
    description:
      'Customer called Mangwale and missed/abandoned the call; Mangwale calls back only when callback permission is present.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'support_script', 'support_audit_log'],
    blocked_actions: ['repeat_unanswered_calls', 'marketing_call', 'autonomous_call'],
  },
  {
    id: 'late_order_escalation_callback',
    direction: 'business_initiated',
    first_pilot: true,
    description:
      'Human-approved callback for an active late-order/support escalation where chat is not enough.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'order_status_explanation', 'human_handoff'],
    blocked_actions: ['cancel_order_without_confirmation', 'refund_without_laravel_confirmation'],
  },
  {
    id: 'payment_refund_resolution_callback',
    direction: 'business_initiated',
    first_pilot: true,
    description:
      'Human-approved callback to explain payment/refund status; money movement remains in Laravel/Razorpay approval lanes.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'payment_status_explanation', 'support_ticket_note'],
    blocked_actions: ['refund_execution', 'charge_customer', 'wallet_mutation'],
  },
  {
    id: 'low_rating_recovery_callback',
    direction: 'business_initiated',
    first_pilot: true,
    description:
      'Human-approved service recovery callback for a low rating or complaint; no marketing or sales pitch.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'support_script', 'support_follow_up'],
    blocked_actions: ['marketing_call', 'coupon_spend_without_approval', 'repeat_unanswered_calls'],
  },
  {
    id: 'voice_order_shadow_help_callback',
    direction: 'business_initiated',
    first_pilot: false,
    description:
      'Future voice order help after the user requests support; agent may draft a cart, never checkout or charge autonomously.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: ['approved_callback', 'draft_cart', 'manual_confirmation'],
    blocked_actions: ['autonomous_checkout', 'payment', 'refund', 'cancel_order'],
  },
];

const BLOCKED_USE_CASES: WhatsAppCallingUseCase[] = [
  {
    id: 'cold_marketing_or_sales_call',
    direction: 'business_initiated',
    first_pilot: false,
    description: 'Outbound marketing, sales, or growth calls without an active user request/permission.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: [],
    blocked_actions: ['cold_call', 'marketing_call', 'repeat_unanswered_calls'],
  },
  {
    id: 'autonomous_money_or_order_action_call',
    direction: 'business_initiated',
    first_pilot: false,
    description: 'Any agent call that directly places, cancels, refunds, pays out, or charges without app/Laravel confirmation.',
    requires_user_permission: true,
    requires_human_approval: true,
    allowed_actions: [],
    blocked_actions: ['checkout', 'refund', 'cancel_order', 'payout', 'charge_customer'],
  },
];

@Injectable()
export class WhatsAppCallingPermissionService {
  constructor(private readonly config: ConfigService) {}

  getUseCases(): WhatsAppCallingUseCasesResponse {
    return {
      ok: true,
      mode: 'whatsapp_calling_use_cases',
      channel: 'whatsapp_native_calling',
      first_pilot: 'customer_support_user_initiated_inbound_manual_handoff',
      user_initiated: USER_INITIATED_USE_CASES,
      business_initiated: BUSINESS_INITIATED_USE_CASES,
      blocked: BLOCKED_USE_CASES,
      permission_check_path: '/api/whatsapp/calling/permission-check',
      approved_call_path: '/api/whatsapp/calling/approved-call',
      raw_pii_returned: false,
      docs: WHATSAPP_CALLING_DOCS,
    };
  }

  check(request: WhatsAppCallingPermissionCheckRequest = {}): WhatsAppCallingPermissionCheckResult {
    const direction = request.direction === 'user_initiated' ? 'user_initiated' : 'business_initiated';
    const purpose = normalizePurpose(
      request.purpose || (direction === 'user_initiated' ? 'customer_support_inbound' : 'support_callback_requested'),
    );
    const useCase = this.findUseCase(direction, purpose);
    const customerPhoneHash = safeHash(
      request.customerPhoneHash,
      request.customerPhone ? phoneKey(request.customerPhone) : '',
    );
    const callPermissionTokenHash = safeHash(
      request.callPermissionTokenHash,
      request.callPermissionToken || '',
    );
    const now = parseNow(request.now);
    const hours = businessHoursState(this.config, now);
    const permissionNotExpiredOrOngoing =
      direction === 'user_initiated' ||
      request.ongoingPermission === true ||
      isFutureTimestamp(request.permissionExpiresAt, now);
    const permissionSource = request.permissionSource || 'none';

    const controls = {
      calling_enabled: flag(this.config, 'WHATSAPP_CALLING_ENABLED'),
      meta_approved: flag(this.config, 'WHATSAPP_CALLING_META_APPROVED'),
      supported_use_case: Boolean(useCase),
      approved_executor_routing_configured: flag(
        this.config,
        'WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY',
      ),
      permission_hash_storage_hash_only: flag(
        this.config,
        'WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED',
      ),
      call_permission_hash_present: direction === 'user_initiated' || Boolean(callPermissionTokenHash),
      permission_not_expired_or_ongoing: permissionNotExpiredOrOngoing,
      ongoing_permission: request.ongoingPermission === true,
      permission_source: permissionSource,
      opt_out_configured: flagAny(this.config, [
        'WHATSAPP_CALLING_OPTOUT_ENABLED',
        'WHATSAPP_CALLING_OPT_OUT_ENABLED',
      ]),
      customer_opted_out: request.customerOptedOut === true,
      business_hours_configured: hours.configured,
      within_business_hours: hours.within,
      business_hours_timezone: hours.timezone,
      business_hours_window: hours.window,
    };

    const failures = this.failuresFor(direction, controls);
    const allowed = failures.length === 0;

    return {
      ok: true,
      mode: 'whatsapp_call_permission_check',
      dry_run: true,
      direction,
      purpose,
      allowed,
      status: allowed
        ? 'permission_ready_when_live_executor_exists'
        : 'blocked_by_permission_or_runtime_gate',
      raw_pii_returned: false,
      safe_runtime_hashes: {
        customer_phone_hash: customerPhoneHash,
        call_permission_token_hash: callPermissionTokenHash,
      },
      controls,
      failures,
      allowed_actions: useCase?.allowed_actions || [],
      blocked_actions: useCase?.blocked_actions || [
        'no_provider_call',
        'manual_support_only',
      ],
      docs: WHATSAPP_CALLING_DOCS,
      next_step: allowed
        ? 'permission gate is green; live call still requires an implemented/enabled provider executor and an approved execution record'
        : 'do not call; collect missing permission/runtime controls or route to chat/manual support',
    };
  }

  private findUseCase(direction: WhatsAppCallingDirection, purpose: string): WhatsAppCallingUseCase | null {
    return [...USER_INITIATED_USE_CASES, ...BUSINESS_INITIATED_USE_CASES].find((useCase) => {
      return useCase.direction === direction && normalizePurpose(useCase.id) === purpose;
    }) || null;
  }

  private failuresFor(
    direction: WhatsAppCallingDirection,
    controls: WhatsAppCallingPermissionCheckResult['controls'],
  ): string[] {
    const failures: string[] = [];
    if (!controls.calling_enabled) failures.push('WHATSAPP_CALLING_ENABLED is not true');
    if (!controls.meta_approved) failures.push('WHATSAPP_CALLING_META_APPROVED is not true');
    if (!controls.supported_use_case) failures.push('unsupported_calling_purpose');
    if (!controls.approved_executor_routing_configured) {
      failures.push('WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY is not true');
    }
    if (!controls.business_hours_configured) {
      failures.push('WHATSAPP_CALLING_BUSINESS_HOURS is not configured');
    } else if (!controls.within_business_hours) {
      failures.push('outside_configured_business_hours');
    }

    if (direction === 'business_initiated') {
      if (!controls.permission_hash_storage_hash_only) {
        failures.push('WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED is not true');
      }
      if (!controls.call_permission_hash_present) {
        failures.push('call_permission_token_hash is required for business-initiated calls');
      }
      if (!controls.permission_not_expired_or_ongoing) {
        failures.push('call_permission is expired or missing expiry/ongoing permission');
      }
      if (!controls.opt_out_configured) {
        failures.push('WHATSAPP_CALLING_OPTOUT_ENABLED is not true');
      }
      if (controls.customer_opted_out) {
        failures.push('customer_opted_out');
      }
    }
    return failures;
  }
}

function businessHoursState(config: ConfigReader, now: Date) {
  const timezone = String(config.get<string>('WHATSAPP_CALLING_BUSINESS_HOURS_TIMEZONE') || 'Asia/Kolkata').trim() || 'Asia/Kolkata';
  const rawWindow = String(config.get<string>('WHATSAPP_CALLING_BUSINESS_HOURS') || '').trim();
  if (!rawWindow) {
    return { configured: false, within: false, timezone, window: null };
  }
  if (/^(24x7|24\/7|always)$/i.test(rawWindow)) {
    return { configured: true, within: true, timezone, window: rawWindow };
  }

  const currentMinute = minuteOfDay(now, timezone);
  const ranges = rawWindow.split(',').map((range) => range.trim()).filter(Boolean);
  for (const range of ranges) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range);
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (start > 1439 || end > 1439) continue;
    const within = start <= end
      ? currentMinute >= start && currentMinute <= end
      : currentMinute >= start || currentMinute <= end;
    if (within) {
      return { configured: true, within: true, timezone, window: range };
    }
  }
  return { configured: true, within: false, timezone, window: rawWindow };
}

function minuteOfDay(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function isFutureTimestamp(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function parseNow(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function normalizePurpose(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function safeHash(providedHash: string | undefined, rawValue: string): string {
  const provided = String(providedHash || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(provided)) return provided;
  const raw = String(rawValue || provided || '').trim();
  return raw ? sha256(raw) : '';
}

function phoneKey(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function flag(config: ConfigReader, key: string): boolean {
  const value = config.get<string>(key);
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function flagAny(config: ConfigReader, keys: string[]): boolean {
  return keys.some((key) => flag(config, key));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
