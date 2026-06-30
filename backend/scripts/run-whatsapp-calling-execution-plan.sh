#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_COMMAND="${WHATSAPP_CALLING_EXECUTION_PLAN_GATE_COMMAND:-$ROOT_DIR/scripts/run-whatsapp-calling-gate.sh}"
BASE_URL="${WHATSAPP_CALLING_EXECUTION_PLAN_BASE_URL:-https://chat.mangwale.ai/api}"
OUTPUT_PATH="${OUTPUT_PATH:-/tmp/mangwale-ai-whatsapp-calling-execution-plan.json}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
else
  ENV_FILE="${ENV_FILE:-/home/ubuntu/Devs/MangwaleAI/backend/.env}"
fi

usage() {
  cat <<'USAGE'
Usage:
  run-whatsapp-calling-execution-plan.sh [--env-file FILE] [--base-url URL]
    [--output FILE]

This is a no-call packet builder for a future WhatsApp native calling
approval/live-smoke. It chains the WhatsApp calling gate, then emits hash-only
approval and approved-call dry-run request bodies. It never calls the approved
call endpoint, starts a WhatsApp call, sends a message, calls a provider,
applies schema, writes a support ticket, places/cancels/refunds/pays for an
order, or mutates vendor/rider/customer state.

The script prints env file paths only, never env values.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file|--envFile)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --base-url|--baseUrl)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    --)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ -z "$ENV_FILE" || ! -r "$ENV_FILE" ]]; then
  echo "env file is required and must be readable; pass --env-file FILE" >&2
  exit 64
fi
if [[ -z "$BASE_URL" ]]; then
  echo "base URL is required" >&2
  exit 64
fi
if [[ ! -x "$GATE_COMMAND" ]]; then
  echo "WhatsApp calling gate command is missing or not executable: $GATE_COMMAND" >&2
  exit 69
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

gate_output="$tmp_dir/whatsapp_calling_gate.json"

set +e
"$GATE_COMMAND" \
  --env-file "$ENV_FILE" \
  --base-url "$BASE_URL" \
  --output "$gate_output" >"$tmp_dir/gate.stdout" 2>"$tmp_dir/gate.stderr"
gate_status=$?
set -e
printf '%s' "$gate_status" >"$tmp_dir/gate.exit"

mkdir -p "$(dirname "$OUTPUT_PATH")"

WHATSAPP_CALL_PLAN_TMP_DIR="$tmp_dir" \
WHATSAPP_CALL_PLAN_GATE_OUTPUT="$gate_output" \
WHATSAPP_CALL_PLAN_OUTPUT_PATH="$OUTPUT_PATH" \
WHATSAPP_CALL_PLAN_ENV_FILE="$ENV_FILE" \
WHATSAPP_CALL_PLAN_BASE_URL="$BASE_URL" \
WHATSAPP_CALL_PLAN_GATE_COMMAND="$GATE_COMMAND" \
node <<'NODE'
const crypto = require('crypto');
const fs = require('fs');

const tmpDir = process.env.WHATSAPP_CALL_PLAN_TMP_DIR;
const outputPath = process.env.WHATSAPP_CALL_PLAN_OUTPUT_PATH;

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readGate() {
  const fileRaw = readText(process.env.WHATSAPP_CALL_PLAN_GATE_OUTPUT);
  const stdout = readText(`${tmpDir}/gate.stdout`);
  const stderr = readText(`${tmpDir}/gate.stderr`);
  const exitCode = Number(readText(`${tmpDir}/gate.exit`) || 0);
  const raw = fileRaw.trim() ? fileRaw : stdout;

  try {
    return {
      exit_code: exitCode,
      json_ok: true,
      body: JSON.parse(raw || '{}'),
      stderr_excerpt: stderr ? stderr.slice(0, 800) : undefined,
    };
  } catch (error) {
    return {
      exit_code: exitCode,
      json_ok: false,
      parse_error: error.message,
      raw_excerpt: raw.slice(0, 800),
      stderr_excerpt: stderr ? stderr.slice(0, 800) : undefined,
      body: null,
    };
  }
}

function addFailure(failures, id, detail = {}) {
  failures.push({ id, ...detail });
}

function containsForbiddenKey(value, path = []) {
  const forbidden = /^(phone|customer_phone|customerPhone|recipient_phone|recipientPhone|call_permission_token|callPermissionToken|permission_token|permissionToken|script|message|raw_message|rawMessage|raw_text|rawText)$/;
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...containsForbiddenKey(item, [...path, String(index)])));
    return hits;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (forbidden.test(key)) {
        hits.push(childPath.join('.'));
      }
      hits.push(...containsForbiddenKey(child, childPath));
    }
  }
  return hits;
}

function mustBeFalse(failures, owner, value, id) {
  if (value !== false) {
    addFailure(failures, id, { observed: value ?? null, owner });
  }
}

const gate = readGate();
const gateBody = gate.body || {};
const readiness = gateBody.readiness || {};
const dryRun = gateBody.approved_call_dry_run || {};
const gates = gateBody.gates || {};
const failures = [];

if (gate.exit_code !== 0) addFailure(failures, 'whatsapp_calling_gate_failed', { exit_code: gate.exit_code });
if (!gate.json_ok) addFailure(failures, 'whatsapp_calling_gate_non_json');
if (gateBody.ok !== true) addFailure(failures, 'whatsapp_calling_gate_ok_not_true');
if (gateBody.mode !== 'whatsapp_calling_operator_gate') {
  addFailure(failures, 'whatsapp_calling_gate_mode_wrong', { observed: gateBody.mode || null });
}
if (readiness.channel !== 'whatsapp_native_calling') {
  addFailure(failures, 'whatsapp_calling_readiness_channel_wrong', { observed: readiness.channel || null });
}

mustBeFalse(failures, 'gate', gateBody.production_write_performed, 'production_write_performed_must_be_false');
mustBeFalse(failures, 'gate', gateBody.external_send_performed, 'external_send_performed_must_be_false');
mustBeFalse(failures, 'gate', gateBody.provider_call_performed, 'provider_call_performed_must_be_false');
mustBeFalse(failures, 'gate', gateBody.mutation_performed, 'mutation_performed_must_be_false');
mustBeFalse(failures, 'gate', gateBody.execution_performed, 'execution_performed_must_be_false');
mustBeFalse(failures, 'readiness', readiness.live_calling_available, 'live_calling_available_must_be_false');
mustBeFalse(failures, 'readiness_executor', readiness.executor?.enabled, 'executor_enabled_must_be_false');
mustBeFalse(failures, 'readiness_executor', readiness.executor?.execution_performed, 'executor_execution_performed_must_be_false');
mustBeFalse(failures, 'gates', gates.whatsapp_native_calling_allowed, 'whatsapp_native_calling_allowed_must_be_false');
mustBeFalse(failures, 'gates', gates.provider_calls_allowed, 'provider_calls_allowed_must_be_false');
mustBeFalse(failures, 'gates', gates.external_sends_allowed, 'external_sends_allowed_must_be_false');

if (dryRun.requested === true) {
  addFailure(failures, 'approved_call_dry_run_must_not_be_called_by_plan');
}

const approvalId = 'whatsapp-call-smoke-approval-1';
const idempotencyKey = `${approvalId}:native-call:v1`;
const customerPhoneHash = sha256('9876543210');
const permissionTokenHash = sha256('whatsapp_call_permission_token_fixture_v1');
const scriptHash = sha256('Namaste, Mangwale support se call kar rahe hain. Aapki late order query mein help karni hai.');
const executionPayload = {
  action: 'whatsapp_native_call',
  execution_idempotency_key: idempotencyKey,
  customer_phone_hash: customerPhoneHash,
  call_permission_token_hash: permissionTokenHash,
  script_hash: scriptHash,
  max_cost_paisa: 900,
  order_id: 'support-smoke-order-1',
  customer_id: 'support-smoke-customer-1',
  conversation_id: 'support-smoke-conversation-1',
  source_event_id: 'support-smoke-event-1',
  channel: 'whatsapp',
  surface: 'customer_support',
  call_direction: 'business_initiated',
  permission_scope: 'meta_user_call_permission_required',
  priority: 'high',
  safety: {
    draft_only: false,
    execution_authorized: true,
    approval_required_for_execution: true,
    external_execution_allowed: true,
    mutation_execution_allowed: false,
    provider_call_allowed_only_after_separate_live_executor_approval: true,
  },
};
const packet = {
  approval_id: approvalId,
  execution_idempotency_key: idempotencyKey,
  authorize_execution_request: {
    action: 'whatsapp_native_call',
    executionIdempotencyKey: idempotencyKey,
    authorizedBy: 'akash_after_explicit_whatsapp_calling_live_smoke_approval',
    executionPayload,
  },
  approved_call_dry_run_request: {
    approvalId,
    idempotencyKey,
    customerPhoneHash,
    callPermissionTokenHash: permissionTokenHash,
    scriptHash,
    orderId: executionPayload.order_id,
    customerId: executionPayload.customer_id,
  },
};

const forbiddenKeyHits = containsForbiddenKey(packet);
if (forbiddenKeyHits.length > 0) {
  addFailure(failures, 'payload_packet_contains_forbidden_raw_keys', { forbidden_key_hits: forbiddenKeyHits });
}

const packetText = JSON.stringify(packet);
for (const rawValue of [
  '9876543210',
  '+91',
  'whatsapp_call_permission_token_fixture_v1',
  'Namaste',
  'late order query',
]) {
  if (packetText.includes(rawValue)) {
    addFailure(failures, 'payload_packet_contains_forbidden_raw_value', { raw_value: rawValue });
  }
}

const ok = failures.length === 0;
const fallbackWebhookControlsRequired = [
  'graph_application_webhook_subscription_configured',
  'webhook_callback_url_verification_configured',
  'webhook_signature_validation_enabled',
  'calling_event_routing_to_approved_executor_only',
  'call_permission_status_storage_hash_only',
  'opt_out_and_business_hours_enforced_before_business_initiated_calls',
];
const webhookControlsRequired = Array.isArray(readiness.webhook_controls?.required_before_live)
  ? readiness.webhook_controls.required_before_live
  : fallbackWebhookControlsRequired;
const fallbackDocs = [
  'https://developers.facebook.com/docs/graph-api/webhooks/reference/application/',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings',
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference',
];
const metaDocs = Array.from(new Set([
  ...(Array.isArray(readiness.docs) ? readiness.docs : []),
  ...fallbackDocs,
]));
const summary = {
  ok,
  status: ok
    ? 'whatsapp_calling_execution_plan_ready_live_blocked_no_call'
    : 'whatsapp_calling_execution_plan_failed',
  mode: 'whatsapp_calling_execution_plan',
  plan_only: true,
  dry_run: true,
  production_write_performed: false,
  external_send_performed: false,
  provider_call_performed: false,
  mutation_performed: false,
  execution_performed: false,
  approved_call_endpoint_called: false,
  live_whatsapp_native_calling_allowed: false,
  base_url: process.env.WHATSAPP_CALL_PLAN_BASE_URL,
  env_file: {
    path: process.env.WHATSAPP_CALL_PLAN_ENV_FILE,
    values_printed: false,
  },
  commands: {
    whatsapp_calling_gate: process.env.WHATSAPP_CALL_PLAN_GATE_COMMAND,
    values_printed: false,
  },
  whatsapp_calling_gate: {
    exit_code: gate.exit_code,
    json_ok: gate.json_ok,
    ok: gateBody.ok ?? null,
    status: gateBody.status || null,
    mode: gateBody.mode || null,
    live_calling_available: readiness.live_calling_available ?? null,
    enabled: readiness.enabled ?? null,
    meta_approved: readiness.meta_approved ?? null,
    missing_config: readiness.missing_config || [],
    blockers: readiness.blockers || [],
    webhook_controls: readiness.webhook_controls || null,
    docs: readiness.docs || [],
    executor: readiness.executor || null,
    approved_call_dry_run_requested: dryRun.requested ?? null,
    parse_error: gate.parse_error,
    raw_excerpt: gate.raw_excerpt,
    stderr_excerpt: gate.stderr_excerpt,
  },
  payload_packet: packet,
  payload_contract: {
    hash_only_runtime_assertions: true,
    raw_customer_phone_returned: false,
    raw_permission_token_returned: false,
    raw_script_returned: false,
    forbidden_raw_keys_absent: forbiddenKeyHits.length === 0,
    required_hash_bindings: [
      'execution_idempotency_key',
      'customer_phone_hash',
      'call_permission_token_hash',
      'script_hash',
      'max_cost_paisa',
    ],
  },
  approval_boundary: {
    separate_meta_calling_approval_required: true,
    separate_graph_application_webhook_subscription_required: true,
    separate_live_executor_approval_required: true,
    separate_approved_call_dry_run_approval_required: true,
    excluded_from_this_packet: [
      'approved_call_endpoint_call',
      'whatsapp_native_call',
      'external_whatsapp_send',
      'voice_provider_call',
      'support_ticket_write',
      'production_schema_apply',
      'order_checkout',
      'refund',
      'cancellation',
      'payment',
      'vendor_rider_mutation',
    ],
  },
  gates: {
    whatsapp_calling_gate_passed: gate.exit_code === 0 && gate.json_ok && gateBody.ok === true,
    live_calling_blocked: readiness.live_calling_available === false,
    approved_call_endpoint_called: false,
    packet_hash_only_runtime_assertions: true,
    packet_forbidden_raw_keys_absent: forbiddenKeyHits.length === 0,
    plan_only: true,
    external_sends_allowed: false,
    provider_calls_allowed: false,
    support_ticket_writes_allowed: false,
    cart_order_payment_refund_cancel_allowed: false,
    vendor_rider_mutation_allowed: false,
    autonomous_checkout_allowed: false,
    whatsapp_native_calling_allowed: false,
  },
  meta_prerequisites: {
    missing_config: readiness.missing_config || [],
    blockers: readiness.blockers || [],
    webhook_controls: readiness.webhook_controls || null,
    webhook_controls_required: webhookControlsRequired,
    docs: metaDocs,
  },
  failures,
};

summary.next_step = ok
  ? 'preserve_this_packet; complete_Meta_calling_config_webhooks_permission_audit_opt_out_and_separate_live_executor_approval_before_any_approved_call_dry_run_or_live_call'
  : 'fix_whatsapp_calling_execution_plan_failures_before_any_calling_work';

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 68);
NODE
