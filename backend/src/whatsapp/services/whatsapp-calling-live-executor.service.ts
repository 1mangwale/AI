import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsAppCallingPermissionCheckResult } from './whatsapp-calling-permission.service';
import { WhatsAppCallingReadiness } from './whatsapp-calling-readiness.service';

type ConfigReader = Pick<ConfigService, 'get'>;

export interface WhatsAppCallingLiveExecutorPreflightInput {
  approvalId: string;
  idempotencyKey: string;
  customerPhoneHash: string;
  callPermissionTokenHash: string;
  scriptHash: string;
  permissionCheck: WhatsAppCallingPermissionCheckResult;
  readiness: WhatsAppCallingReadiness;
}

export interface WhatsAppCallingLiveExecutorPreflightResult {
  ok: true;
  mode: 'whatsapp_calling_live_executor_preflight';
  ready_for_provider_adapter: boolean;
  status:
    | 'blocked_live_executor_disabled'
    | 'blocked_missing_runtime_binding'
    | 'blocked_permission_check_failed'
    | 'blocked_customer_not_allowlisted'
    | 'blocked_audit_or_schema_not_ready'
    | 'blocked_provider_adapter_disabled'
    | 'ready_for_provider_adapter_live_smoke';
  provider_called: false;
  external_call_performed: false;
  mutation_performed: false;
  execution_performed: false;
  raw_pii_returned: false;
  controls: {
    calling_enabled: boolean;
    meta_approved: boolean;
    live_executor_enabled: boolean;
    provider_adapter_enabled: boolean;
    schema_verified: boolean;
    audit_storage_enabled: boolean;
    template_configured: boolean;
    template_approved: boolean;
    internal_allowlist_configured: boolean;
    customer_hash_allowlisted: boolean;
    permission_allowed: boolean;
    approval_bound: boolean;
    idempotency_key_bound: boolean;
    script_hash_bound: boolean;
    customer_hash_bound: boolean;
    call_permission_hash_bound: boolean;
  };
  blockers: string[];
  required_before_live: string[];
  next_step: string;
}

@Injectable()
export class WhatsAppCallingLiveExecutorService {
  constructor(private readonly config: ConfigService) {}

  preflightApprovedCallback(
    input: WhatsAppCallingLiveExecutorPreflightInput,
  ): WhatsAppCallingLiveExecutorPreflightResult {
    const allowlist = this.allowlistedCustomerHashes();
    const controls = {
      calling_enabled: input.readiness.enabled,
      meta_approved: input.readiness.meta_approved,
      live_executor_enabled: flag(this.config, 'WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED'),
      provider_adapter_enabled: flag(this.config, 'WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED'),
      schema_verified: flag(this.config, 'WHATSAPP_CALLING_SCHEMA_VERIFIED'),
      audit_storage_enabled: flag(this.config, 'WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED'),
      template_configured: hasConfig(this.config, 'WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME'),
      template_approved: flag(this.config, 'WHATSAPP_CALLING_TEMPLATE_APPROVED'),
      internal_allowlist_configured: allowlist.size > 0,
      customer_hash_allowlisted: allowlist.has(normalizeHash(input.customerPhoneHash)),
      permission_allowed: input.permissionCheck.allowed,
      approval_bound: Boolean(input.approvalId),
      idempotency_key_bound: Boolean(input.idempotencyKey),
      script_hash_bound: validHash(input.scriptHash),
      customer_hash_bound: validHash(input.customerPhoneHash),
      call_permission_hash_bound: validHash(input.callPermissionTokenHash),
    };

    const blockers: string[] = [];
    if (!controls.approval_bound) blockers.push('approval_id is required');
    if (!controls.idempotency_key_bound) blockers.push('idempotency_key is required');
    if (!controls.script_hash_bound) blockers.push('script_hash is required');
    if (!controls.customer_hash_bound) blockers.push('customer_phone_hash is required');
    if (!controls.call_permission_hash_bound) blockers.push('call_permission_token_hash is required');
    if (!controls.permission_allowed) blockers.push('permission_check is not allowed');
    if (!controls.calling_enabled) blockers.push('WHATSAPP_CALLING_ENABLED is not true');
    if (!controls.meta_approved) blockers.push('WHATSAPP_CALLING_META_APPROVED is not true');
    if (!controls.live_executor_enabled) blockers.push('WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED is not true');
    if (!controls.schema_verified) blockers.push('WHATSAPP_CALLING_SCHEMA_VERIFIED is not true');
    if (!controls.audit_storage_enabled) blockers.push('WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED is not true');
    if (!controls.template_configured) blockers.push('WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME is not configured');
    if (!controls.template_approved) blockers.push('WHATSAPP_CALLING_TEMPLATE_APPROVED is not true');
    if (!controls.internal_allowlist_configured) {
      blockers.push('WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES is not configured');
    } else if (!controls.customer_hash_allowlisted) {
      blockers.push('customer_phone_hash is not allowlisted for internal callback smoke');
    }
    if (!controls.provider_adapter_enabled) {
      blockers.push('WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED is not true');
    }

    const status = this.statusFor(blockers, controls);

    return {
      ok: true,
      mode: 'whatsapp_calling_live_executor_preflight',
      ready_for_provider_adapter: blockers.length === 0,
      status,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
      execution_performed: false,
      raw_pii_returned: false,
      controls,
      blockers,
      required_before_live: [
        'Meta WhatsApp Calling approval confirmed',
        'callback permission template approved',
        'Graph native call webhook and internal inbound smoke completed with internal allowlist',
        'whatsapp_call_* schema applied and verified',
        'hash-only audit write enabled',
        'human-approved execution row bound to idempotency key, script hash, customer hash, and permission hash',
        'provider adapter captures provider result before success',
      ],
      next_step:
        blockers.length === 0
          ? 'ready for internal provider-adapter live smoke; provider call still must be performed by the separate adapter path'
          : 'keep approved-call endpoint as dry-run only until all live executor blockers are cleared',
    };
  }

  private allowlistedCustomerHashes(): Set<string> {
    const raw = String(this.config.get<string>('WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES') || '');
    return new Set(
      raw
        .split(',')
        .map((item) => normalizeHash(item))
        .filter(Boolean),
    );
  }

  private statusFor(
    blockers: string[],
    controls: WhatsAppCallingLiveExecutorPreflightResult['controls'],
  ): WhatsAppCallingLiveExecutorPreflightResult['status'] {
    if (blockers.length === 0) return 'ready_for_provider_adapter_live_smoke';
    if (
      !controls.approval_bound ||
      !controls.idempotency_key_bound ||
      !controls.script_hash_bound ||
      !controls.customer_hash_bound ||
      !controls.call_permission_hash_bound
    ) {
      return 'blocked_missing_runtime_binding';
    }
    if (!controls.permission_allowed) return 'blocked_permission_check_failed';
    if (!controls.live_executor_enabled || !controls.calling_enabled || !controls.meta_approved) {
      return 'blocked_live_executor_disabled';
    }
    if (!controls.schema_verified || !controls.audit_storage_enabled || !controls.template_approved) {
      return 'blocked_audit_or_schema_not_ready';
    }
    if (!controls.internal_allowlist_configured || !controls.customer_hash_allowlisted) {
      return 'blocked_customer_not_allowlisted';
    }
    return 'blocked_provider_adapter_disabled';
  }
}

function hasConfig(config: ConfigReader, key: string): boolean {
  const value = config.get<string>(key);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function flag(config: ConfigReader, key: string): boolean {
  const value = config.get<string>(key);
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeHash(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  return validHash(normalized) ? normalized : '';
}

function validHash(value: string | undefined): boolean {
  return /^[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase());
}
