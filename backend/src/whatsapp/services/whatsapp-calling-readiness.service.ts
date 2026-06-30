import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type CallingSignalingMode = 'graph_api' | 'sip';
type ConfigReader = Pick<ConfigService, 'get'>;

const GRAPH_APPLICATION_WEBHOOKS_DOC =
  'https://developers.facebook.com/docs/graph-api/webhooks/reference/application/';
const WHATSAPP_CALLING_DOC =
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling';
const WHATSAPP_CALLING_SIP_EXAMPLES_DOC =
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples/';

export interface WhatsAppCallingWebhookControls {
  graph_application_webhook_reference: typeof GRAPH_APPLICATION_WEBHOOKS_DOC;
  whatsapp_calling_reference: typeof WHATSAPP_CALLING_DOC;
  callback_controller_path: '/webhook/whatsapp';
  application_webhook_subscription_configured: boolean;
  callback_url_configured: boolean;
  callback_verification_configured: boolean;
  signature_validation_configured: boolean;
  calling_event_routing_to_approved_executor_only: boolean;
  permission_status_storage_hash_only: boolean;
  opt_out_configured: boolean;
  business_hours_configured: boolean;
  required_before_live: string[];
  required_before_user_initiated_live: string[];
  required_before_business_initiated_live: string[];
  missing_controls: string[];
  missing_user_initiated_controls: string[];
  missing_business_initiated_controls: string[];
  no_secret_values_returned: true;
}

export interface WhatsAppCallingDirectionalReadiness {
  ready: boolean;
  missing_config: string[];
  blockers: string[];
  requires_user_permission: boolean;
  requires_permission_template: boolean;
  manual_handoff_only: boolean;
  approved_call_dry_run_only: boolean;
  live_accept_available: false;
  provider_called: false;
  external_call_performed: false;
  execution_performed: false;
}

export interface WhatsAppCallingReadiness {
  ok: true;
  channel: 'whatsapp_native_calling';
  live_calling_available: boolean;
  user_initiated_ready: boolean;
  business_initiated_ready: boolean;
  enabled: boolean;
  meta_approved: boolean;
  signaling_mode: CallingSignalingMode;
  configured: Record<string, boolean>;
  missing_config: string[];
  blockers: string[];
  readiness_by_direction: {
    user_initiated: WhatsAppCallingDirectionalReadiness;
    business_initiated: WhatsAppCallingDirectionalReadiness;
  };
  capabilities: {
    user_initiated_calls: boolean;
    business_initiated_calls: boolean;
    call_icon_visibility_control: boolean;
    business_hours_control: boolean;
    click_to_call_links: boolean;
  };
  webhook_controls: WhatsAppCallingWebhookControls;
  executor: {
    implemented: false;
    dry_run_approved_call_endpoint: true;
    enabled: false;
    execution_performed: false;
    permission_check_endpoint: true;
    use_cases_endpoint: true;
    approved_call_path: '/api/whatsapp/calling/approved-call';
    permission_check_path: '/api/whatsapp/calling/permission-check';
    use_cases_path: '/api/whatsapp/calling/use-cases';
  };
  persistence: {
    migration_required: '20260623_whatsapp_calling_audit';
    migration_path: 'prisma/migrations/20260623_whatsapp_calling_audit/migration.sql';
    schema_verified: boolean;
    audit_storage_enabled: boolean;
    writes_allowed: boolean;
    stores_raw_customer_phone: false;
    stores_raw_permission_token: false;
    raw_pii_allowed: false;
  };
  sip: {
    selected: boolean;
    enabled: boolean;
    endpoint_configured: boolean;
    support_queue: string;
    business_hours: string | null;
    timezone: string;
    provider_called: false;
    external_call_performed: false;
  };
  live_executor: {
    implemented: true;
    enabled: boolean;
    provider_adapter_enabled: boolean;
    internal_allowlist_configured: boolean;
    template_approved: boolean;
    execution_performed: false;
    provider_called: false;
    external_call_performed: false;
    mutation_performed: false;
  };
  safety_contract: {
    outbound_requires_user_permission: true;
    requires_human_approval: true;
    requires_execution_authorization: true;
    requires_idempotency_key: true;
    requires_audit_log: true;
    stores_raw_customer_phone: false;
    stores_raw_permission_token: false;
  };
  docs: string[];
  next_step: string;
}

@Injectable()
export class WhatsAppCallingReadinessService {
  constructor(private readonly config: ConfigService) {}

  getReadiness(): WhatsAppCallingReadiness {
    return buildWhatsAppCallingReadiness(this.config);
  }
}

export function buildWhatsAppCallingReadiness(config: ConfigReader): WhatsAppCallingReadiness {
  const enabled = flag(config, 'WHATSAPP_CALLING_ENABLED');
  const metaApproved = flag(config, 'WHATSAPP_CALLING_META_APPROVED');
  const inboundSupportEnabled = flag(config, 'WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED');
  const signalingMode = signalingModeFor(config);
  const commonConfigKeys = [
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_CALLING_WEBHOOK_URL',
    'WHATSAPP_CALLING_BUSINESS_HOURS',
  ];
  const businessInitiatedConfigKeys = [
    'WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME',
  ];
  const configured = configuredMap(config, [
    ...commonConfigKeys,
    ...businessInitiatedConfigKeys,
  ]);
  const missingConfig = Object.entries(configured)
    .filter(([, isConfigured]) => !isConfigured)
    .map(([key]) => key);
  const commonMissingConfig = commonConfigKeys.filter((key) => !configured[key]);
  const businessInitiatedMissingConfig = businessInitiatedConfigKeys.filter((key) => !configured[key]);
  const webhookControls = webhookControlsFor(config, configured);
  const persistence = persistenceFor(config);
  const sip = sipFor(config, signalingMode);
  const liveExecutor = liveExecutorFor(config);

  const commonBlockers: string[] = [];
  if (!enabled) {
    commonBlockers.push('WHATSAPP_CALLING_ENABLED is not true');
  }
  if (!metaApproved) {
    commonBlockers.push('WHATSAPP_CALLING_META_APPROVED is not true');
  }
  for (const key of commonMissingConfig) {
    commonBlockers.push(`${key} is not configured`);
  }
  if (signalingMode === 'sip' && !hasConfig(config, 'WHATSAPP_CALLING_SIP_ENDPOINT')) {
    commonBlockers.push('WHATSAPP_CALLING_SIP_ENDPOINT is required for sip signaling mode');
  }
  const userInitiatedBlockers = [
    ...commonBlockers,
    ...(!inboundSupportEnabled ? ['WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED is not true'] : []),
    ...webhookControlBlockers(webhookControls, configured, 'user_initiated'),
  ];

  const businessInitiatedBlockers = [
    ...commonBlockers,
    ...businessInitiatedMissingConfig.map((key) => `${key} is not configured for business-initiated calls`),
    ...webhookControlBlockers(webhookControls, configured, 'business_initiated'),
  ];

  const liveExecutorBlockers: string[] = [];
  if (!persistence.schema_verified) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_SCHEMA_VERIFIED is not true');
  }
  if (!persistence.audit_storage_enabled) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED is not true');
  }
  if (!liveExecutor.template_approved) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_TEMPLATE_APPROVED is not true');
  }
  if (!liveExecutor.enabled) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED is not true');
  }
  if (!liveExecutor.internal_allowlist_configured) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES is not configured');
  }
  if (!liveExecutor.provider_adapter_enabled) {
    liveExecutorBlockers.push('WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED is not true');
  }
  const businessLiveBlockers = [...businessInitiatedBlockers, ...liveExecutorBlockers];
  const blockers = unique([
    ...userInitiatedBlockers,
    ...businessLiveBlockers,
  ]);
  const userInitiatedReady = userInitiatedBlockers.length === 0;
  const businessInitiatedReady = businessLiveBlockers.length === 0;

  return {
    ok: true,
    channel: 'whatsapp_native_calling',
    live_calling_available: false,
    user_initiated_ready: userInitiatedReady,
    business_initiated_ready: businessInitiatedReady,
    enabled,
    meta_approved: metaApproved,
    signaling_mode: signalingMode,
    configured,
    missing_config: missingConfig,
    blockers,
    readiness_by_direction: {
      user_initiated: {
        ready: userInitiatedReady,
        missing_config: commonMissingConfig,
        blockers: unique(userInitiatedBlockers),
        requires_user_permission: false,
        requires_permission_template: false,
        manual_handoff_only: true,
        approved_call_dry_run_only: true,
        live_accept_available: false,
        provider_called: false,
        external_call_performed: false,
        execution_performed: false,
      },
      business_initiated: {
        ready: businessInitiatedReady,
        missing_config: unique([
          ...commonMissingConfig,
          ...businessInitiatedMissingConfig,
        ]),
        blockers: unique(businessLiveBlockers),
        requires_user_permission: true,
        requires_permission_template: true,
        manual_handoff_only: true,
        approved_call_dry_run_only: true,
        live_accept_available: false,
        provider_called: false,
        external_call_performed: false,
        execution_performed: false,
      },
    },
    capabilities: {
      user_initiated_calls: userInitiatedReady,
      business_initiated_calls: businessInitiatedReady,
      call_icon_visibility_control: enabled && metaApproved,
      business_hours_control: enabled && configured['WHATSAPP_CALLING_BUSINESS_HOURS'],
      click_to_call_links: enabled && metaApproved,
    },
    webhook_controls: webhookControls,
    executor: {
      implemented: false,
      dry_run_approved_call_endpoint: true,
      enabled: false,
      execution_performed: false,
      permission_check_endpoint: true,
      use_cases_endpoint: true,
      approved_call_path: '/api/whatsapp/calling/approved-call',
      permission_check_path: '/api/whatsapp/calling/permission-check',
      use_cases_path: '/api/whatsapp/calling/use-cases',
    },
    persistence,
    sip,
    live_executor: liveExecutor,
    safety_contract: {
      outbound_requires_user_permission: true,
      requires_human_approval: true,
      requires_execution_authorization: true,
      requires_idempotency_key: true,
      requires_audit_log: true,
      stores_raw_customer_phone: false,
      stores_raw_permission_token: false,
    },
    docs: [
      GRAPH_APPLICATION_WEBHOOKS_DOC,
      WHATSAPP_CALLING_DOC,
      'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls',
      'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/',
      'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings',
      'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls',
      WHATSAPP_CALLING_SIP_EXAMPLES_DOC,
      'https://whatsappbusiness.com/blog/whatsapp-business-calling-api/',
    ],
    next_step:
      'complete Meta calling approval, Graph calls webhook subscription, inbound-support live smoke, callback permission template approval for business-initiated calls, hash-only audit storage, opt-out/business-hours gates, and an approval-bound executor before enabling live calls',
  };
}

function webhookControlsFor(
  config: ConfigReader,
  configured: Record<string, boolean>,
): WhatsAppCallingWebhookControls {
  const controls = {
    application_webhook_subscription_configured: flag(
      config,
      'WHATSAPP_CALLING_GRAPH_APP_WEBHOOK_SUBSCRIBED',
    ),
    callback_url_configured: configured['WHATSAPP_CALLING_WEBHOOK_URL'] === true,
    callback_verification_configured: hasAnyConfig(config, [
      'WHATSAPP_CALLING_WEBHOOK_VERIFY_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'whatsapp.verifyToken',
    ]),
    signature_validation_configured: configured['WHATSAPP_APP_SECRET'] === true,
    calling_event_routing_to_approved_executor_only: flag(
      config,
      'WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY',
    ),
    permission_status_storage_hash_only: flag(
      config,
      'WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED',
    ),
    opt_out_configured: flagAny(config, [
      'WHATSAPP_CALLING_OPTOUT_ENABLED',
      'WHATSAPP_CALLING_OPT_OUT_ENABLED',
    ]),
    business_hours_configured: configured['WHATSAPP_CALLING_BUSINESS_HOURS'] === true,
  };
  const requiredBeforeUserInitiatedLive = [
    'graph_application_webhook_subscription_configured',
    'webhook_callback_url_configured',
    'webhook_callback_url_verification_configured',
    'webhook_signature_validation_enabled',
    'calling_event_routing_to_approved_executor_only',
  ];
  const requiredBeforeBusinessInitiatedLive = [
    ...requiredBeforeUserInitiatedLive,
    'call_permission_status_storage_hash_only',
    'opt_out_and_business_hours_enforced_before_business_initiated_calls',
  ];
  const missingUserInitiatedControls = [
    ...(!controls.application_webhook_subscription_configured
      ? ['graph_application_webhook_subscription_configured']
      : []),
    ...(!controls.callback_url_configured
      ? ['webhook_callback_url_configured']
      : []),
    ...(!controls.callback_verification_configured
      ? ['webhook_callback_url_verification_configured']
      : []),
    ...(!controls.signature_validation_configured
      ? ['webhook_signature_validation_enabled']
      : []),
    ...(!controls.calling_event_routing_to_approved_executor_only
      ? ['calling_event_routing_to_approved_executor_only']
      : []),
  ];
  const missingBusinessInitiatedControls = [
    ...missingUserInitiatedControls,
    ...(!controls.permission_status_storage_hash_only
      ? ['call_permission_status_storage_hash_only']
      : []),
    ...(!controls.opt_out_configured || !controls.business_hours_configured
      ? ['opt_out_and_business_hours_enforced_before_business_initiated_calls']
      : []),
  ];

  return {
    graph_application_webhook_reference: GRAPH_APPLICATION_WEBHOOKS_DOC,
    whatsapp_calling_reference: WHATSAPP_CALLING_DOC,
    callback_controller_path: '/webhook/whatsapp',
    ...controls,
    required_before_live: requiredBeforeBusinessInitiatedLive,
    required_before_user_initiated_live: requiredBeforeUserInitiatedLive,
    required_before_business_initiated_live: requiredBeforeBusinessInitiatedLive,
    missing_controls: unique(missingBusinessInitiatedControls),
    missing_user_initiated_controls: unique(missingUserInitiatedControls),
    missing_business_initiated_controls: unique(missingBusinessInitiatedControls),
    no_secret_values_returned: true,
  };
}

function webhookControlBlockers(
  controls: WhatsAppCallingWebhookControls,
  configured: Record<string, boolean>,
  direction: 'user_initiated' | 'business_initiated',
): string[] {
  const blockers: string[] = [];
  const missingControls = direction === 'user_initiated'
    ? controls.missing_user_initiated_controls
    : controls.missing_business_initiated_controls;
  for (const control of missingControls) {
    if (control === 'webhook_callback_url_configured' && !configured['WHATSAPP_CALLING_WEBHOOK_URL']) {
      continue;
    }
    if (control === 'webhook_signature_validation_enabled' && !configured['WHATSAPP_APP_SECRET']) {
      continue;
    }
    blockers.push(webhookControlBlocker(control));
  }
  return blockers;
}

function webhookControlBlocker(control: string): string {
  switch (control) {
    case 'graph_application_webhook_subscription_configured':
      return 'WHATSAPP_CALLING_GRAPH_APP_WEBHOOK_SUBSCRIBED is not true';
    case 'webhook_callback_url_configured':
      return 'WHATSAPP_CALLING_WEBHOOK_URL is not configured';
    case 'webhook_callback_url_verification_configured':
      return 'WHATSAPP_CALLING_WEBHOOK_VERIFY_TOKEN or WHATSAPP_VERIFY_TOKEN is not configured';
    case 'calling_event_routing_to_approved_executor_only':
      return 'WHATSAPP_CALLING_EVENT_ROUTING_APPROVED_EXECUTOR_ONLY is not true';
    case 'call_permission_status_storage_hash_only':
      return 'WHATSAPP_CALLING_PERMISSION_HASH_STORAGE_ENABLED is not true';
    case 'opt_out_and_business_hours_enforced_before_business_initiated_calls':
      return 'WHATSAPP_CALLING_OPTOUT_ENABLED and WHATSAPP_CALLING_BUSINESS_HOURS are not configured';
    case 'webhook_signature_validation_enabled':
      return 'WHATSAPP_APP_SECRET is not configured for webhook signature validation';
    default:
      return `${control} is not configured`;
  }
}

function configuredMap(config: ConfigReader, keys: string[]): Record<string, boolean> {
  return keys.reduce<Record<string, boolean>>((acc, key) => {
    acc[key] = hasConfig(config, key);
    return acc;
  }, {});
}

function persistenceFor(config: ConfigReader): WhatsAppCallingReadiness['persistence'] {
  const schemaVerified = flag(config, 'WHATSAPP_CALLING_SCHEMA_VERIFIED');
  const auditStorageEnabled = flag(config, 'WHATSAPP_CALLING_AUDIT_STORAGE_ENABLED');
  return {
    migration_required: '20260623_whatsapp_calling_audit',
    migration_path: 'prisma/migrations/20260623_whatsapp_calling_audit/migration.sql',
    schema_verified: schemaVerified,
    audit_storage_enabled: auditStorageEnabled,
    writes_allowed: schemaVerified && auditStorageEnabled,
    stores_raw_customer_phone: false,
    stores_raw_permission_token: false,
    raw_pii_allowed: false,
  };
}

function sipFor(
  config: ConfigReader,
  signalingMode: CallingSignalingMode,
): WhatsAppCallingReadiness['sip'] {
  return {
    selected: signalingMode === 'sip',
    enabled: flag(config, 'WHATSAPP_CALLING_SIP_ENABLED'),
    endpoint_configured: hasConfig(config, 'WHATSAPP_CALLING_SIP_ENDPOINT'),
    support_queue: String(config.get<string>('WHATSAPP_CALLING_SIP_SUPPORT_QUEUE') || 'mangwale-support'),
    business_hours: hasConfig(config, 'WHATSAPP_CALLING_BUSINESS_HOURS')
      ? String(config.get<string>('WHATSAPP_CALLING_BUSINESS_HOURS'))
      : null,
    timezone:
      String(config.get<string>('WHATSAPP_CALLING_BUSINESS_HOURS_TIMEZONE') || 'Asia/Kolkata') ||
      'Asia/Kolkata',
    provider_called: false,
    external_call_performed: false,
  };
}

function liveExecutorFor(config: ConfigReader): WhatsAppCallingReadiness['live_executor'] {
  return {
    implemented: true,
    enabled: flag(config, 'WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED'),
    provider_adapter_enabled: flag(config, 'WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED'),
    internal_allowlist_configured: hasConfig(config, 'WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES'),
    template_approved: flag(config, 'WHATSAPP_CALLING_TEMPLATE_APPROVED'),
    execution_performed: false,
    provider_called: false,
    external_call_performed: false,
    mutation_performed: false,
  };
}

function hasConfig(config: ConfigReader, key: string): boolean {
  const value = config.get<string>(key);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasAnyConfig(config: ConfigReader, keys: string[]): boolean {
  return keys.some((key) => hasConfig(config, key));
}

function flag(config: ConfigReader, key: string): boolean {
  const value = config.get<string>(key);
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function flagAny(config: ConfigReader, keys: string[]): boolean {
  return keys.some((key) => flag(config, key));
}

function signalingModeFor(config: ConfigReader): CallingSignalingMode {
  const raw = String(config.get<string>('WHATSAPP_CALLING_SIGNALING_MODE') || 'graph_api')
    .trim()
    .toLowerCase();
  return raw === 'sip' ? 'sip' : 'graph_api';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
