#!/bin/bash
# Secrets Validation Script
# Validates all required secrets are set and flags weak/default values
# Run in CI pre-deploy or manually

set -euo pipefail

ERRORS=0
WARNINGS=0

error() { echo "ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "WARNING: $1"; WARNINGS=$((WARNINGS + 1)); }
ok() { echo "OK: $1"; }

echo "========================================="
echo "  Mangwale AI - Secrets Validation"
echo "========================================="
echo ""

# Load .env if exists
ENV_FILE="${1:-.env}"
if [ -f "$ENV_FILE" ]; then
    echo "Loading: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "No .env file found at $ENV_FILE — checking environment variables"
fi
echo ""

# === Required Secrets (must be set) ===
echo "--- Required Secrets ---"

check_required() {
    local var_name="$1"
    local description="$2"
    local value="${!var_name:-}"

    if [ -z "$value" ]; then
        error "$var_name is not set ($description)"
        return
    fi
    ok "$var_name is set"
}

check_not_default() {
    local var_name="$1"
    local default_val="$2"
    local description="$3"
    local value="${!var_name:-}"

    if [ -z "$value" ]; then
        error "$var_name is not set ($description)"
        return
    fi

    if [ "$value" = "$default_val" ]; then
        warn "$var_name is using the default value — change for production!"
        return
    fi
    ok "$var_name is set and non-default"
}

# Database
check_required "DATABASE_URL" "PostgreSQL connection string"
check_not_default "POSTGRES_PASSWORD" "config_secure_pass_2024" "PostgreSQL password"

# Redis
check_required "REDIS_HOST" "Redis hostname"

# JWT / Auth
check_required "JWT_SECRET" "JWT signing secret"

# WhatsApp
check_required "WHATSAPP_ACCESS_TOKEN" "WhatsApp Cloud API token"
check_required "WHATSAPP_PHONE_NUMBER_ID" "WhatsApp phone number ID"
check_required "WHATSAPP_VERIFY_TOKEN" "WhatsApp webhook verify token"

# Razorpay
check_required "RAZORPAY_WEBHOOK_SECRET" "Razorpay webhook signature secret"

# PHP Backend
check_required "PHP_BACKEND_URL" "PHP backend URL"

echo ""
echo "--- Security Checks ---"

# Check for weak JWT secret
JWT="${JWT_SECRET:-}"
if [ -n "$JWT" ] && [ ${#JWT} -lt 32 ]; then
    warn "JWT_SECRET is shorter than 32 characters — use a stronger secret"
fi

# Check for default passwords
if [ "${POSTGRES_PASSWORD:-}" = "config_secure_pass_2024" ]; then
    warn "POSTGRES_PASSWORD is using the dev default"
fi

if [ "${RAZORPAY_WEBHOOK_SECRET:-}" = "not_required_php_handles_payments" ]; then
    error "RAZORPAY_WEBHOOK_SECRET has placeholder value — must be set from Razorpay dashboard"
fi

echo ""
echo "========================================="
echo "  Results: $ERRORS errors, $WARNINGS warnings"
echo "========================================="

if [ $ERRORS -gt 0 ]; then
    echo "FAILED: Fix $ERRORS error(s) before deploying"
    exit 1
fi

if [ $WARNINGS -gt 0 ]; then
    echo "PASSED with warnings — review before production"
    exit 0
fi

echo "ALL CHECKS PASSED"
exit 0
