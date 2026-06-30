import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApprovalService } from '../../approval/services/approval.service';
import { buildWhatsAppCallingReadiness, WhatsAppCallingReadiness } from './whatsapp-calling-readiness.service';
import { ConfigService } from '@nestjs/config';
import {
  WhatsAppCallingPermissionCheckResult,
  WhatsAppCallingPermissionService,
  WhatsAppCallingPermissionSource,
} from './whatsapp-calling-permission.service';
import {
  WhatsAppCallingLiveExecutorPreflightResult,
  WhatsAppCallingLiveExecutorService,
} from './whatsapp-calling-live-executor.service';

export interface ApprovedWhatsAppNativeCallRequest {
  approvalId: string;
  idempotencyKey: string;
  customerPhone?: string;
  customerPhoneHash?: string;
  callPermissionToken?: string;
  callPermissionTokenHash?: string;
  script?: string;
  scriptHash?: string;
  purpose?: string;
  permissionExpiresAt?: string;
  ongoingPermission?: boolean;
  permissionSource?: WhatsAppCallingPermissionSource;
  customerOptedOut?: boolean;
  orderId?: string | number;
  customerId?: string | number;
  maxCostPaisa?: number;
}

export interface ApprovedWhatsAppNativeCallDryRunResult {
  ok: true;
  mode: 'whatsapp_native_call_approved_dry_run';
  status: 'blocked_live_whatsapp_calling_not_enabled';
  dry_run: true;
  approval_validated: true;
  approval_id: string;
  execution_idempotency_key: string;
  action: 'whatsapp_native_call';
  live_calling_available: false;
  provider_called: false;
  external_call_performed: false;
  mutation_performed: false;
  execution_performed: false;
  raw_pii_returned: false;
  safe_runtime_hashes: {
    customer_phone_hash: string;
    call_permission_token_hash: string;
    script_hash: string;
  };
  readiness: Pick<WhatsAppCallingReadiness, 'channel' | 'live_calling_available' | 'blockers' | 'safety_contract'>;
  permission_check: WhatsAppCallingPermissionCheckResult;
  live_executor_preflight: WhatsAppCallingLiveExecutorPreflightResult;
  required_before_live: string[];
  next_step: string;
}

export interface InboundWhatsAppCallAcceptRequest {
  idempotencyKey?: string;
  acceptedBy?: string;
  supportAgentId?: string;
  reason?: string;
}

export interface InboundWhatsAppCallAcceptPreflightResult {
  ok: true;
  mode: 'whatsapp_native_inbound_call_accept_preflight';
  status:
    | 'blocked_inbound_support_accept_not_enabled'
    | 'blocked_inbound_accept_missing_idempotency'
    | 'blocked_inbound_accept_adapter_not_implemented';
  dry_run: true;
  call_id_hash: string;
  manual_accept_allowed: false;
  live_calling_available: false;
  provider_called: false;
  external_call_performed: false;
  mutation_performed: false;
  execution_performed: false;
  raw_pii_returned: false;
  controls: {
    calling_enabled: boolean;
    meta_approved: boolean;
    inbound_support_enabled: boolean;
    user_initiated_ready: boolean;
    admin_accept_endpoint_guarded: true;
    idempotency_key_bound: boolean;
    graph_native_path_selected: boolean;
    live_accept_adapter_implemented: false;
    provider_adapter_enabled: false;
  };
  blockers: string[];
  required_before_live: string[];
  next_step: string;
}

@Injectable()
export class WhatsAppCallingExecutorService {
  private readonly logger = new Logger(WhatsAppCallingExecutorService.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly config: ConfigService,
    private readonly permissionService: WhatsAppCallingPermissionService,
    @Optional()
    private readonly liveExecutor?: WhatsAppCallingLiveExecutorService,
  ) {}

  async dryRunApprovedCall(
    request: ApprovedWhatsAppNativeCallRequest,
  ): Promise<ApprovedWhatsAppNativeCallDryRunResult> {
    if (!request?.approvalId || !request?.idempotencyKey) {
      throw new BadRequestException('approvalId and idempotencyKey are required');
    }

    const hashes = {
      customer_phone_hash: this.customerPhoneHash(request),
      call_permission_token_hash: this.callPermissionTokenHash(request),
      script_hash: this.scriptHash(request),
    };
    if (!hashes.customer_phone_hash || !hashes.call_permission_token_hash || !hashes.script_hash) {
      throw new BadRequestException('customer phone, call permission token, and script hashes are required');
    }

    await this.assertApprovalAllowsDryRun(request, hashes);
    const readiness = buildWhatsAppCallingReadiness(this.config);
    const permissionCheck = this.permissionService.check({
      direction: 'business_initiated',
      purpose: request.purpose || 'support_callback_requested',
      customerPhone: request.customerPhone,
      customerPhoneHash: request.customerPhoneHash || hashes.customer_phone_hash,
      callPermissionToken: request.callPermissionToken,
      callPermissionTokenHash: request.callPermissionTokenHash || hashes.call_permission_token_hash,
      permissionExpiresAt: request.permissionExpiresAt,
      ongoingPermission: request.ongoingPermission,
      permissionSource: request.permissionSource,
      customerOptedOut: request.customerOptedOut,
    });
    const liveExecutorPreflight = this.liveExecutor
      ? this.liveExecutor.preflightApprovedCallback({
          approvalId: request.approvalId,
          idempotencyKey: request.idempotencyKey,
          customerPhoneHash: hashes.customer_phone_hash,
          callPermissionTokenHash: hashes.call_permission_token_hash,
          scriptHash: hashes.script_hash,
          permissionCheck,
          readiness,
        })
      : this.missingLiveExecutorPreflight(
          request,
          hashes,
          permissionCheck,
          readiness,
        );

    this.logger.warn(
      `WhatsApp native call dry-run blocked before provider call: approval ${request.approvalId}`,
    );

    return {
      ok: true,
      mode: 'whatsapp_native_call_approved_dry_run',
      status: 'blocked_live_whatsapp_calling_not_enabled',
      dry_run: true,
      approval_validated: true,
      approval_id: request.approvalId,
      execution_idempotency_key: request.idempotencyKey,
      action: 'whatsapp_native_call',
      live_calling_available: false,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
      execution_performed: false,
      raw_pii_returned: false,
      safe_runtime_hashes: hashes,
      readiness: {
        channel: readiness.channel,
        live_calling_available: readiness.live_calling_available,
        blockers: readiness.blockers,
        safety_contract: readiness.safety_contract,
      },
      permission_check: permissionCheck,
      live_executor_preflight: liveExecutorPreflight,
      required_before_live: [
        'meta_calling_permission_token_verified',
        'webhook_control_and_opt_out_verified',
        'business_hours_window_verified',
        'live_executor_implementation',
        'provider_result_captured_before_success',
        'support_contact_audit_fanout_after_success',
      ],
      next_step:
        'keep native WhatsApp calling blocked until Meta approval, permission token, webhook/control, opt-out/business-hours, audit, and live executor gates pass',
    };
  }

  preflightInboundSupportAccept(
    callIdHash: string,
    request: InboundWhatsAppCallAcceptRequest = {},
  ): InboundWhatsAppCallAcceptPreflightResult {
    const normalizedCallIdHash = String(callIdHash || '').trim().toLowerCase();
    if (!this.isSha256Hash(normalizedCallIdHash)) {
      throw new BadRequestException('callIdHash must be a 64-character sha256 hash');
    }

    const readiness = buildWhatsAppCallingReadiness(this.config);
    const controls = {
      calling_enabled: readiness.enabled,
      meta_approved: readiness.meta_approved,
      inbound_support_enabled: this.truthy(this.config.get<string>('WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED')),
      user_initiated_ready: readiness.user_initiated_ready,
      admin_accept_endpoint_guarded: true as const,
      idempotency_key_bound: Boolean(String(request.idempotencyKey || '').trim()),
      graph_native_path_selected: readiness.signaling_mode === 'graph_api',
      live_accept_adapter_implemented: false as const,
      provider_adapter_enabled: false as const,
    };
    const blockers = unique([
      ...readiness.readiness_by_direction.user_initiated.blockers,
      ...(!controls.idempotency_key_bound ? ['idempotencyKey is required'] : []),
      ...(!controls.graph_native_path_selected ? ['WHATSAPP_CALLING_SIGNALING_MODE must be graph_api for this pilot'] : []),
      'WhatsApp native inbound accept provider adapter is not implemented',
    ]);

    const status: InboundWhatsAppCallAcceptPreflightResult['status'] =
      !controls.idempotency_key_bound
        ? 'blocked_inbound_accept_missing_idempotency'
        : readiness.readiness_by_direction.user_initiated.blockers.length > 0
          ? 'blocked_inbound_support_accept_not_enabled'
          : 'blocked_inbound_accept_adapter_not_implemented';

    this.logger.warn(
      `WhatsApp inbound native call accept preflight blocked before provider call: ${normalizedCallIdHash.slice(0, 12)}`,
    );

    return {
      ok: true,
      mode: 'whatsapp_native_inbound_call_accept_preflight',
      status,
      dry_run: true,
      call_id_hash: normalizedCallIdHash,
      manual_accept_allowed: false,
      live_calling_available: false,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
      execution_performed: false,
      raw_pii_returned: false,
      controls,
      blockers,
      required_before_live: [
        'Meta WhatsApp Calling approval confirmed for the WABA phone number',
        'WHATSAPP_CALLING_ENABLED=true after Akash approval',
        'WHATSAPP_CALLING_META_APPROVED=true after evidence is captured',
        'WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED=true for the manual pilot',
        'Graph calls webhook subscription and signature verification smoke-tested',
        'manual human operator accept flow smoke-tested with an internal call id hash',
        'provider accept adapter implemented with audit-before-call and rollback evidence',
      ],
      next_step:
        'keep this endpoint as a blocked preflight until Meta Graph native inbound accept semantics and the manual human adapter are verified',
    };
  }

  private async assertApprovalAllowsDryRun(
    request: ApprovedWhatsAppNativeCallRequest,
    hashes: ApprovedWhatsAppNativeCallDryRunResult['safe_runtime_hashes'],
  ): Promise<void> {
    const approval = await this.approvalService.getById(request.approvalId);
    const payload = approval.payload || {};
    const metadata = approval.metadata || {};
    const safety = payload.safety || {};

    if (approval.status !== 'approved') {
      throw new BadRequestException(`approval ${request.approvalId} is ${approval.status}, not approved`);
    }
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException(`approval ${request.approvalId} is expired`);
    }
    if (payload.draft_only === true || metadata.safe_mode === 'draft_only') {
      throw new BadRequestException(`approval ${request.approvalId} is draft-only`);
    }
    if (!this.truthy(payload.execution_allowed, metadata.execution_allowed)) {
      throw new BadRequestException(`approval ${request.approvalId} does not allow execution`);
    }
    if (!this.truthy(payload.external_execution_allowed, safety.external_execution_allowed, metadata.external_execution_allowed)) {
      throw new BadRequestException(`approval ${request.approvalId} does not allow external execution`);
    }
    if (!this.truthy(safety.execution_authorized, metadata.execution_authorized)) {
      throw new BadRequestException(`approval ${request.approvalId} is not execution-authorized`);
    }

    const action = this.normalizeActionName(this.firstString(
      payload.action,
      payload.action_type,
      payload.purpose,
      metadata.execution_action,
      metadata.action,
      metadata.action_type,
      metadata.purpose,
    ) || '');
    if (action !== 'whatsapp_native_call') {
      throw new BadRequestException(`approval action ${action || 'missing'} does not match whatsapp_native_call`);
    }

    this.assertHashBound('customer_phone_hash', hashes.customer_phone_hash, payload, metadata);
    this.assertHashBound('call_permission_token_hash', hashes.call_permission_token_hash, payload, metadata);
    this.assertHashBound('script_hash', hashes.script_hash, payload, metadata);

    const approvedIdempotency = this.firstString(
      payload.execution_idempotency_key,
      payload.idempotency_key,
      payload.idempotencyKey,
      metadata.execution_idempotency_key,
      metadata.idempotency_key,
      metadata.idempotencyKey,
    );
    if (!approvedIdempotency) {
      throw new BadRequestException('approval must bind execution idempotency_key');
    }
    if (approvedIdempotency !== request.idempotencyKey) {
      throw new BadRequestException('approval idempotency_key does not match');
    }

    const maxCost = payload.max_cost_paisa ?? payload.maxCostPaisa ?? metadata.max_cost_paisa;
    if (maxCost === undefined || maxCost === null || Number(maxCost) <= 0) {
      throw new BadRequestException('approval must bind max_cost_paisa');
    }
    this.compareIfBound('order_id', request.orderId, payload.order_id ?? payload.orderId ?? metadata.order_id ?? metadata.orderId);
    this.compareIfBound('customer_id', request.customerId, payload.customer_id ?? payload.customerId ?? metadata.customer_id ?? metadata.customerId);
  }

  private assertHashBound(
    key: 'customer_phone_hash' | 'call_permission_token_hash' | 'script_hash',
    runtimeHash: string,
    payload: Record<string, any>,
    metadata: Record<string, any>,
  ): void {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => String(letter).toUpperCase());
    const approvedHash = this.firstString(payload[key], payload[camelKey], metadata[key], metadata[camelKey]);
    if (!approvedHash) {
      throw new BadRequestException(`approval must bind ${key}`);
    }
    if (approvedHash !== runtimeHash) {
      throw new BadRequestException(`approval ${key} does not match runtime input`);
    }
  }

  private customerPhoneHash(request: ApprovedWhatsAppNativeCallRequest): string {
    if (request.customerPhoneHash) return request.customerPhoneHash;
    const phoneKey = this.phoneKey(request.customerPhone || '');
    return phoneKey ? this.sha256(phoneKey) : '';
  }

  private callPermissionTokenHash(request: ApprovedWhatsAppNativeCallRequest): string {
    if (request.callPermissionTokenHash) return request.callPermissionTokenHash;
    return request.callPermissionToken ? this.sha256(request.callPermissionToken) : '';
  }

  private scriptHash(request: ApprovedWhatsAppNativeCallRequest): string {
    if (request.scriptHash) return request.scriptHash;
    return request.script ? this.sha256(request.script) : '';
  }

  private phoneKey(value: string): string | null {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }

  private compareIfBound(field: string, requestValue: any, approvedValue: any): void {
    if (approvedValue === undefined || approvedValue === null || approvedValue === '') return;
    if (requestValue === undefined || requestValue === null || requestValue === '') {
      throw new BadRequestException(`approval binds ${field} but request omitted it`);
    }
    if (String(requestValue) !== String(approvedValue)) {
      throw new BadRequestException(`approval ${field} does not match request`);
    }
  }

  private normalizeActionName(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private firstString(...values: any[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private truthy(...values: any[]): boolean {
    return values.some((value) => value === true || value === 'true' || value === 1 || value === '1');
  }

  private isSha256Hash(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private missingLiveExecutorPreflight(
    request: ApprovedWhatsAppNativeCallRequest,
    hashes: ApprovedWhatsAppNativeCallDryRunResult['safe_runtime_hashes'],
    permissionCheck: WhatsAppCallingPermissionCheckResult,
    readiness: WhatsAppCallingReadiness,
  ): WhatsAppCallingLiveExecutorPreflightResult {
    return {
      ok: true,
      mode: 'whatsapp_calling_live_executor_preflight',
      ready_for_provider_adapter: false,
      status: 'blocked_live_executor_disabled',
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
      execution_performed: false,
      raw_pii_returned: false,
      controls: {
        calling_enabled: readiness.enabled,
        meta_approved: readiness.meta_approved,
        live_executor_enabled: false,
        provider_adapter_enabled: false,
        schema_verified: false,
        audit_storage_enabled: false,
        template_configured: false,
        template_approved: false,
        internal_allowlist_configured: false,
        customer_hash_allowlisted: false,
        permission_allowed: permissionCheck.allowed,
        approval_bound: Boolean(request.approvalId),
        idempotency_key_bound: Boolean(request.idempotencyKey),
        script_hash_bound: Boolean(hashes.script_hash),
        customer_hash_bound: Boolean(hashes.customer_phone_hash),
        call_permission_hash_bound: Boolean(hashes.call_permission_token_hash),
      },
      blockers: [
        'WhatsAppCallingLiveExecutorService is not wired',
        'WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED is not true',
        'WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED is not true',
      ],
      required_before_live: [
        'wire WhatsAppCallingLiveExecutorService',
        'enable live executor after Meta/SIP/audit approval',
      ],
      next_step: 'keep approved-call endpoint as dry-run only until the live executor service is wired',
    };
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
