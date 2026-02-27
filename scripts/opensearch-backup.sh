#!/bin/bash
# OpenSearch Snapshot Backup Script
# Run daily at 3 AM via crontab
# Keeps last 7 daily snapshots

set -euo pipefail

OPENSEARCH_HOST="${OPENSEARCH_HOST:-http://localhost:9200}"
REPO_NAME="daily_backup"
SNAPSHOT_NAME="snapshot_$(date +%Y%m%d_%H%M%S)"
RETENTION_DAYS=7

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Register snapshot repository (idempotent)
log "Registering snapshot repository..."
curl -sf -X PUT "${OPENSEARCH_HOST}/_snapshot/${REPO_NAME}" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "fs",
    "settings": {
      "location": "/mnt/snapshots",
      "compress": true
    }
  }' || { log "ERROR: Failed to register snapshot repo"; exit 1; }

# Take snapshot
log "Taking snapshot: ${SNAPSHOT_NAME}..."
curl -sf -X PUT "${OPENSEARCH_HOST}/_snapshot/${REPO_NAME}/${SNAPSHOT_NAME}?wait_for_completion=true" \
  -H 'Content-Type: application/json' \
  -d '{
    "indices": "*",
    "ignore_unavailable": true,
    "include_global_state": false
  }' || { log "ERROR: Snapshot failed"; exit 1; }

log "Snapshot ${SNAPSHOT_NAME} completed successfully"

# Prune old snapshots (keep last 7)
log "Pruning snapshots older than ${RETENTION_DAYS} days..."
CUTOFF_DATE=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y%m%d)

SNAPSHOTS=$(curl -sf "${OPENSEARCH_HOST}/_snapshot/${REPO_NAME}/_all" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for snap in data.get('snapshots', []):
    name = snap['snapshot']
    # Extract date from snapshot_YYYYMMDD_HHMMSS format
    parts = name.split('_')
    if len(parts) >= 2:
        print(name)
" 2>/dev/null || echo "")

DELETED=0
for snap in $SNAPSHOTS; do
    # Extract date portion (snapshot_YYYYMMDD_HHMMSS -> YYYYMMDD)
    SNAP_DATE=$(echo "$snap" | sed 's/snapshot_\([0-9]*\)_.*/\1/')
    if [ -n "$SNAP_DATE" ] && [ "$SNAP_DATE" -lt "$CUTOFF_DATE" ] 2>/dev/null; then
        log "Deleting old snapshot: $snap"
        curl -sf -X DELETE "${OPENSEARCH_HOST}/_snapshot/${REPO_NAME}/${snap}" > /dev/null
        DELETED=$((DELETED + 1))
    fi
done

log "Pruned ${DELETED} old snapshots"
log "OpenSearch backup complete"
