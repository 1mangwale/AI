#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="${OPENCLAW_AI_HELPER:-/root/.openclaw/skills/mangwale-ai-stack-router/scripts/ai-intent-gateway.sh}"
BASE_URL="${WHATSAPP_CALLING_GATE_BASE_URL:-https://chat.mangwale.ai/api}"
OUTPUT_PATH="${OUTPUT_PATH:-/tmp/mangwale-ai-whatsapp-calling-gate.json}"
ACK_APPROVED_DRY_RUN="false"
REQUEST_JSON=""

if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
else
  ENV_FILE="${ENV_FILE:-/home/ubuntu/Devs/MangwaleAI/backend/.env}"
fi

usage() {
  cat <<'USAGE'
Usage:
  run-whatsapp-calling-gate.sh [--env-file FILE] [--base-url URL]
    [--output FILE]
  run-whatsapp-calling-gate.sh [--env-file FILE] [--base-url URL]
    [--output FILE] --ack-approved-dry-run --request-json JSON|@file|@-

This is a no-send/no-call operator gate for WhatsApp native calling. The
default mode checks deployed readiness and must keep live_calling_available,
provider calls, and execution false. The approved-call dry-run mode requires an
operator-supplied request that is already bound to an approved execution record;
it still must return provider_called=false and execution_performed=false.

The script prints env file paths only, never env values.
USAGE
}

env_value_from_file() {
  local file="$1"
  local key="$2"
  local line value

  line="$(grep -m1 -E "^${key}=" "$file" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
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
    --request-json|--requestJson)
      REQUEST_JSON="${2:-}"
      shift 2
      ;;
    --ack-approved-dry-run|--ackApprovedDryRun|--ack-dry-run|--ackDryRun)
      ACK_APPROVED_DRY_RUN="true"
      shift
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

if [[ ! -x "$HELPER" ]]; then
  echo "OpenClaw AI helper is missing or not executable: $HELPER" >&2
  exit 69
fi
if [[ -z "$ENV_FILE" || ! -r "$ENV_FILE" ]]; then
  echo "env file is required and must be readable; pass --env-file FILE" >&2
  exit 64
fi
if [[ -z "$BASE_URL" ]]; then
  echo "base URL is required" >&2
  exit 64
fi
if [[ "$ACK_APPROVED_DRY_RUN" == "true" && -z "$REQUEST_JSON" ]]; then
  echo "--request-json is required with --ack-approved-dry-run" >&2
  exit 64
fi
if [[ "$ACK_APPROVED_DRY_RUN" != "true" && -n "$REQUEST_JSON" ]]; then
  echo "--ack-approved-dry-run is required when --request-json is supplied" >&2
  exit 64
fi

token_value="${AI_GATEWAY_INTERNAL_TOKEN:-}"
admin_key_value="${MANGWALE_ADMIN_API_KEY:-${ADMIN_API_KEY:-}}"
if [[ -z "$token_value" ]]; then
  token_value="$(env_value_from_file "$ENV_FILE" AI_GATEWAY_INTERNAL_TOKEN || true)"
fi
if [[ -z "$token_value" ]]; then
  token_value="$(env_value_from_file "$ENV_FILE" MANGWALE_API_KEY || true)"
fi
if [[ -z "$admin_key_value" ]]; then
  admin_key_value="$(env_value_from_file "$ENV_FILE" MANGWALE_ADMIN_API_KEY || true)"
fi
if [[ -z "$admin_key_value" ]]; then
  admin_key_value="$(env_value_from_file "$ENV_FILE" ADMIN_API_KEY || true)"
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

run_helper_step() {
  local name="$1"
  shift
  local env_args=(
    "AI_INTENT_GATEWAY_BASE_URL=$BASE_URL"
    "MANGWALE_AI_INTENT_GATEWAY_BASE_URL=$BASE_URL"
  )
  if [[ -n "$token_value" ]]; then
    env_args+=("AI_GATEWAY_INTERNAL_TOKEN=$token_value")
  fi
  if [[ -n "$admin_key_value" ]]; then
    env_args+=("MANGWALE_ADMIN_API_KEY=$admin_key_value")
  fi

  set +e
  env "${env_args[@]}" "$HELPER" "$@" >"$tmp_dir/$name.json" 2>"$tmp_dir/$name.stderr"
  local status=$?
  set -e
  printf '%s' "$status" >"$tmp_dir/$name.exit"
}

run_helper_step readiness whatsapp-call-readiness

if [[ "$ACK_APPROVED_DRY_RUN" == "true" ]]; then
  run_helper_step approved_dry_run whatsapp-call-approved-dry-run \
    --request-json "$REQUEST_JSON" \
    --ack-dry-run
else
  printf '%s' '{"ok":true,"status":"not_requested","dry_run":true}' >"$tmp_dir/approved_dry_run.json"
  printf '%s' 0 >"$tmp_dir/approved_dry_run.exit"
  : >"$tmp_dir/approved_dry_run.stderr"
fi

WHATSAPP_CALLING_GATE_TMP_DIR="$tmp_dir" \
WHATSAPP_CALLING_GATE_BASE_URL="$BASE_URL" \
WHATSAPP_CALLING_GATE_ENV_FILE="$ENV_FILE" \
WHATSAPP_CALLING_GATE_OUTPUT_PATH="$OUTPUT_PATH" \
WHATSAPP_CALLING_GATE_ACK_APPROVED_DRY_RUN="$ACK_APPROVED_DRY_RUN" \
node <<'NODE'
const fs = require('fs');

const tmpDir = process.env.WHATSAPP_CALLING_GATE_TMP_DIR;
const outputPath = process.env.WHATSAPP_CALLING_GATE_OUTPUT_PATH;

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readJson(name) {
  const raw = readText(`${tmpDir}/${name}.json`);
  const stderr = readText(`${tmpDir}/${name}.stderr`);
  const exitCode = Number(readText(`${tmpDir}/${name}.exit`) || 0);
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

function isFalse(value) {
  return value === false;
}

function addFailure(failures, id, detail = {}) {
  failures.push({ id, ...detail });
}

const readiness = readJson('readiness');
const approvedDryRun = readJson('approved_dry_run');
const readinessBody = readiness.body || {};
const dryRunBody = approvedDryRun.body || {};
const requestedDryRun = process.env.WHATSAPP_CALLING_GATE_ACK_APPROVED_DRY_RUN === 'true';
const failures = [];

if (readiness.exit_code !== 0) addFailure(failures, 'whatsapp_calling_readiness_failed', { exit_code: readiness.exit_code });
if (!readiness.json_ok) addFailure(failures, 'whatsapp_calling_readiness_non_json');
if (readinessBody.ok !== true) addFailure(failures, 'whatsapp_calling_readiness_ok_not_true');
if (readinessBody.channel !== 'whatsapp_native_calling') {
  addFailure(failures, 'whatsapp_calling_channel_not_native', { observed: readinessBody.channel || null });
}
if (!isFalse(readinessBody.live_calling_available)) {
  addFailure(failures, 'whatsapp_live_calling_available_must_be_false', {
    observed: readinessBody.live_calling_available ?? null,
  });
}
if (readinessBody.executor?.implemented !== false) {
  addFailure(failures, 'whatsapp_executor_implemented_must_be_false', {
    observed: readinessBody.executor?.implemented ?? null,
  });
}
if (readinessBody.executor?.enabled !== false) {
  addFailure(failures, 'whatsapp_executor_enabled_must_be_false', {
    observed: readinessBody.executor?.enabled ?? null,
  });
}
if (readinessBody.executor?.execution_performed !== false) {
  addFailure(failures, 'whatsapp_executor_execution_performed_must_be_false', {
    observed: readinessBody.executor?.execution_performed ?? null,
  });
}
if (readinessBody.executor?.dry_run_approved_call_endpoint !== true) {
  addFailure(failures, 'whatsapp_approved_call_dry_run_endpoint_missing');
}
if (readinessBody.safety_contract?.requires_human_approval !== true) {
  addFailure(failures, 'whatsapp_requires_human_approval_must_be_true');
}
if (readinessBody.safety_contract?.requires_execution_authorization !== true) {
  addFailure(failures, 'whatsapp_requires_execution_authorization_must_be_true');
}
if (readinessBody.safety_contract?.stores_raw_customer_phone !== false) {
  addFailure(failures, 'whatsapp_stores_raw_customer_phone_must_be_false');
}
if (readinessBody.safety_contract?.stores_raw_permission_token !== false) {
  addFailure(failures, 'whatsapp_stores_raw_permission_token_must_be_false');
}

if (requestedDryRun) {
  if (approvedDryRun.exit_code !== 0) {
    addFailure(failures, 'whatsapp_approved_call_dry_run_failed', { exit_code: approvedDryRun.exit_code });
  }
  if (!approvedDryRun.json_ok) addFailure(failures, 'whatsapp_approved_call_dry_run_non_json');
  if (dryRunBody.ok !== true) addFailure(failures, 'whatsapp_approved_call_dry_run_ok_not_true');
  if (dryRunBody.mode !== 'whatsapp_native_call_approved_dry_run') {
    addFailure(failures, 'whatsapp_approved_call_dry_run_mode_wrong', { observed: dryRunBody.mode || null });
  }
  for (const key of [
    'dry_run',
    'approval_validated',
  ]) {
    if (dryRunBody[key] !== true) {
      addFailure(failures, `whatsapp_approved_call_${key}_must_be_true`, { observed: dryRunBody[key] ?? null });
    }
  }
  for (const key of [
    'live_calling_available',
    'provider_called',
    'external_call_performed',
    'mutation_performed',
    'execution_performed',
    'raw_pii_returned',
  ]) {
    if (dryRunBody[key] !== false) {
      addFailure(failures, `whatsapp_approved_call_${key}_must_be_false`, { observed: dryRunBody[key] ?? null });
    }
  }
}

const ok = failures.length === 0;
const blockers = Array.isArray(readinessBody.blockers) ? readinessBody.blockers : [];
const summary = {
  ok,
  status: ok ? 'whatsapp_calling_gate_passed_live_blocked' : 'whatsapp_calling_gate_failed',
  mode: 'whatsapp_calling_operator_gate',
  dry_run: true,
  production_write_performed: false,
  external_send_performed: false,
  provider_call_performed: false,
  mutation_performed: false,
  execution_performed: false,
  live_whatsapp_native_calling_allowed: false,
  base_url: process.env.WHATSAPP_CALLING_GATE_BASE_URL,
  env_file: {
    path: process.env.WHATSAPP_CALLING_GATE_ENV_FILE,
    values_printed: false,
  },
  readiness: {
    exit_code: readiness.exit_code,
    json_ok: readiness.json_ok,
    ok: readinessBody.ok ?? null,
    channel: readinessBody.channel || null,
    live_calling_available: readinessBody.live_calling_available ?? null,
    enabled: readinessBody.enabled ?? null,
    meta_approved: readinessBody.meta_approved ?? null,
    signaling_mode: readinessBody.signaling_mode || null,
    missing_config: readinessBody.missing_config || [],
    blockers,
    webhook_controls: readinessBody.webhook_controls || null,
    docs: readinessBody.docs || [],
    executor: readinessBody.executor || null,
    safety_contract: readinessBody.safety_contract || null,
    next_step: readinessBody.next_step || null,
    parse_error: readiness.parse_error,
    raw_excerpt: readiness.raw_excerpt,
    stderr_excerpt: readiness.stderr_excerpt,
  },
  approved_call_dry_run: {
    requested: requestedDryRun,
    exit_code: approvedDryRun.exit_code,
    json_ok: approvedDryRun.json_ok,
    ok: dryRunBody.ok ?? null,
    status: dryRunBody.status || null,
    mode: dryRunBody.mode || null,
    dry_run: dryRunBody.dry_run ?? null,
    approval_validated: dryRunBody.approval_validated ?? null,
    live_calling_available: dryRunBody.live_calling_available ?? null,
    provider_called: dryRunBody.provider_called ?? null,
    external_call_performed: dryRunBody.external_call_performed ?? null,
    mutation_performed: dryRunBody.mutation_performed ?? null,
    execution_performed: dryRunBody.execution_performed ?? null,
    raw_pii_returned: dryRunBody.raw_pii_returned ?? null,
    required_before_live: dryRunBody.required_before_live || [],
    parse_error: approvedDryRun.parse_error,
    raw_excerpt: approvedDryRun.raw_excerpt,
    stderr_excerpt: approvedDryRun.stderr_excerpt,
  },
  gates: {
    readiness_route_ok: readiness.exit_code === 0 && readiness.json_ok && readinessBody.ok === true,
    live_calling_blocked: readinessBody.live_calling_available === false,
    executor_not_implemented_or_enabled: readinessBody.executor?.implemented === false &&
      readinessBody.executor?.enabled === false &&
      readinessBody.executor?.execution_performed === false,
    approved_call_dry_run_no_provider_call: requestedDryRun
      ? dryRunBody.provider_called === false &&
        dryRunBody.external_call_performed === false &&
        dryRunBody.execution_performed === false &&
        dryRunBody.mutation_performed === false
      : null,
    live_action_allowed: false,
    external_sends_allowed: false,
    provider_calls_allowed: false,
    support_ticket_writes_allowed: false,
    cart_order_payment_refund_cancel_allowed: false,
    vendor_rider_mutation_allowed: false,
    autonomous_checkout_allowed: false,
    whatsapp_native_calling_allowed: false,
  },
  failures,
};

summary.next_step = ok
  ? (requestedDryRun
    ? 'preserve_this_packet_as_whatsapp_calling_dry_run_evidence; keep_live_calling_blocked_until_separate_Meta_and_executor_approval'
    : 'use_this_packet_to_explain_whatsapp_calling_blockers; run_with_ack_approved_dry_run_only_after_a_real_execution_bound_approval_exists')
  : 'fix_whatsapp_calling_gate_or_preserve_failure_evidence_before_any_calling_work';

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 68);
NODE
