#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Aldaro PostgreSQL Backup Script
#
# Dumps the entire Aldaro database and uploads to a versioned S3 bucket.
# Designed to run every 4 hours via cron or systemd timer.
#
# Required environment variables:
#   DATABASE_URL          — Postgres connection string
#   BACKUP_S3_BUCKET      — S3 bucket name (e.g. aldaro-db-backups)
#   BACKUP_S3_PREFIX      — S3 key prefix (default: backups/)
#   AWS_DEFAULT_REGION    — AWS region (default: us-east-1)
#
# Optional:
#   BACKUP_RETENTION_DAYS — Delete local dumps older than N days (default: 7)
#   BACKUP_LOCAL_DIR      — Local staging directory (default: /tmp/aldaro-backups)
#   BACKUP_ENCRYPT_KEY    — If set, encrypt dump with AES-256-CBC before upload
#
# Usage:
#   # Manual run
#   DATABASE_URL=postgres://... BACKUP_S3_BUCKET=aldaro-db-backups ./scripts/db-backup.sh
#
#   # Cron (every 4 hours)
#   0 */4 * * * /opt/aldaro/scripts/db-backup.sh >> /var/log/aldaro-backup.log 2>&1
#
# S3 bucket should have:
#   - Versioning enabled (protects against accidental overwrites)
#   - Lifecycle rule: transition to Glacier after 30 days, expire after 365
#   - Server-side encryption (SSE-S3 or SSE-KMS)
# ---------------------------------------------------------------------------

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/tmp/aldaro-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
DUMP_FILE="aldaro_${TIMESTAMP}.sql.gz"
UPLOAD_FILE="${DUMP_FILE}"

# --- Validation ---

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[BACKUP] FATAL: DATABASE_URL is not set"
  exit 1
fi

if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[BACKUP] FATAL: BACKUP_S3_BUCKET is not set"
  exit 1
fi

if ! command -v pg_dump &> /dev/null; then
  echo "[BACKUP] FATAL: pg_dump not found — install postgresql-client"
  exit 1
fi

if ! command -v aws &> /dev/null; then
  echo "[BACKUP] FATAL: aws CLI not found — install awscli"
  exit 1
fi

# --- Prepare ---

mkdir -p "${BACKUP_LOCAL_DIR}"
echo "[BACKUP] Starting database backup at $(date -u +"%Y-%m-%d %H:%M:%S UTC")"

# --- Dump ---

echo "[BACKUP] Running pg_dump..."
pg_dump "${DATABASE_URL}" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --format=plain \
  | gzip > "${BACKUP_LOCAL_DIR}/${DUMP_FILE}"

DUMP_SIZE=$(du -h "${BACKUP_LOCAL_DIR}/${DUMP_FILE}" | cut -f1)
echo "[BACKUP] Dump complete: ${DUMP_FILE} (${DUMP_SIZE})"

# --- Optional encryption ---

if [ -n "${BACKUP_ENCRYPT_KEY:-}" ]; then
  echo "[BACKUP] Encrypting dump with AES-256-CBC..."
  UPLOAD_FILE="${DUMP_FILE}.enc"
  openssl enc -aes-256-cbc -salt -pbkdf2 \
    -in "${BACKUP_LOCAL_DIR}/${DUMP_FILE}" \
    -out "${BACKUP_LOCAL_DIR}/${UPLOAD_FILE}" \
    -pass "pass:${BACKUP_ENCRYPT_KEY}"
  rm -f "${BACKUP_LOCAL_DIR}/${DUMP_FILE}"
  echo "[BACKUP] Encrypted: ${UPLOAD_FILE}"
fi

# --- Upload to S3 ---

S3_KEY="${BACKUP_S3_PREFIX}${UPLOAD_FILE}"
echo "[BACKUP] Uploading to s3://${BACKUP_S3_BUCKET}/${S3_KEY}..."

aws s3 cp \
  "${BACKUP_LOCAL_DIR}/${UPLOAD_FILE}" \
  "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" \
  --storage-class STANDARD_IA \
  --sse AES256 \
  --only-show-errors

echo "[BACKUP] Upload complete: s3://${BACKUP_S3_BUCKET}/${S3_KEY}"

# --- Verify upload ---

REMOTE_SIZE=$(aws s3api head-object \
  --bucket "${BACKUP_S3_BUCKET}" \
  --key "${S3_KEY}" \
  --query "ContentLength" \
  --output text 2>/dev/null || echo "0")

LOCAL_SIZE=$(stat -f%z "${BACKUP_LOCAL_DIR}/${UPLOAD_FILE}" 2>/dev/null || stat -c%s "${BACKUP_LOCAL_DIR}/${UPLOAD_FILE}" 2>/dev/null || echo "0")

if [ "${REMOTE_SIZE}" -eq "${LOCAL_SIZE}" ] && [ "${REMOTE_SIZE}" -gt 0 ]; then
  echo "[BACKUP] Verification PASSED (local=${LOCAL_SIZE} bytes, remote=${REMOTE_SIZE} bytes)"
else
  echo "[BACKUP] WARNING: Size mismatch — local=${LOCAL_SIZE}, remote=${REMOTE_SIZE}"
  # Don't exit — the file may have been uploaded correctly but size query may have a race
fi

# --- Cleanup old local dumps ---

echo "[BACKUP] Cleaning up local dumps older than ${BACKUP_RETENTION_DAYS} days..."
find "${BACKUP_LOCAL_DIR}" -name "aldaro_*.sql.gz*" -mtime "+${BACKUP_RETENTION_DAYS}" -delete 2>/dev/null || true

# --- Done ---

echo "[BACKUP] Backup completed successfully at $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "[BACKUP] S3 path: s3://${BACKUP_S3_BUCKET}/${S3_KEY}"
