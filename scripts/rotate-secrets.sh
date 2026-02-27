#!/bin/bash
# Secret Rotation Script
# Generates new secrets and updates .env file
# Usage: ./rotate-secrets.sh [.env-path]

set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found"
    exit 1
fi

echo "========================================="
echo "  Mangwale AI - Secret Rotation"
echo "========================================="
echo ""

generate_secret() {
    openssl rand -hex 32
}

# Backup current .env
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
echo "Backed up to: $BACKUP"

# Rotate JWT_SECRET
NEW_JWT=$(generate_secret)
if grep -q "^JWT_SECRET=" "$ENV_FILE"; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${NEW_JWT}|" "$ENV_FILE"
    echo "JWT_SECRET rotated"
else
    echo "JWT_SECRET=${NEW_JWT}" >> "$ENV_FILE"
    echo "JWT_SECRET added"
fi

echo ""
echo "After rotation:"
echo "  1. Restart all services: docker compose restart"
echo "  2. Active user sessions will be invalidated"
echo "  3. Users will need to re-login"
echo ""
echo "Rotation complete. Backup at: $BACKUP"
