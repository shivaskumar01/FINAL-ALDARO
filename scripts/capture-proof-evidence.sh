#!/usr/bin/env bash
set -euo pipefail

# Evidence capture helper for Aldaro proof execution.
# Creates timestamped evidence directory and provides capture functions.
#
# Usage:
#   source scripts/capture-proof-evidence.sh <proof-name>
#   capture "filename.txt" "psql command or any command"
#   capture_stdin "filename.txt" <<< "some content"
#   finish_capture

PROOF_NAME="${1:?Usage: source scripts/capture-proof-evidence.sh <proof-name>}"
PROOF_DATE=$(date +%Y-%m-%d)
EVIDENCE_DIR="exports/proofs/$PROOF_DATE/$PROOF_NAME"

mkdir -p "$EVIDENCE_DIR"

echo "=== Evidence capture initialized ==="
echo "Proof:     $PROOF_NAME"
echo "Date:      $PROOF_DATE"
echo "Directory: $EVIDENCE_DIR"
echo "==================================="

# Capture command output to an evidence file and stdout
capture() {
  local filename="$1"
  shift
  echo "[CAPTURE] $filename"
  "$@" 2>&1 | tee "$EVIDENCE_DIR/$filename"
  echo ""
}

# Capture stdin to an evidence file
capture_stdin() {
  local filename="$1"
  echo "[CAPTURE] $filename"
  cat > "$EVIDENCE_DIR/$filename"
}

# Capture a SQL query against DATABASE_URL
capture_sql() {
  local filename="$1"
  local query="$2"
  echo "[CAPTURE] $filename (SQL)"
  psql "$DATABASE_URL" -c "$query" 2>&1 | tee "$EVIDENCE_DIR/$filename"
  echo ""
}

# Capture a SQL file against DATABASE_URL
capture_sql_file() {
  local filename="$1"
  local sqlfile="$2"
  echo "[CAPTURE] $filename (SQL file: $sqlfile)"
  psql "$DATABASE_URL" -f "$sqlfile" 2>&1 | tee "$EVIDENCE_DIR/$filename"
  echo ""
}

# Capture an HTTP request
capture_http() {
  local filename="$1"
  shift
  echo "[CAPTURE] $filename (HTTP)"
  curl -s -v "$@" 2>&1 | tee "$EVIDENCE_DIR/$filename"
  echo ""
}

# Generate manifest.json for this proof's evidence
finish_capture() {
  echo "[CAPTURE] Generating manifest..."
  local manifest="$EVIDENCE_DIR/manifest.json"
  echo "{" > "$manifest"
  echo "  \"proof\": \"$PROOF_NAME\"," >> "$manifest"
  echo "  \"date\": \"$PROOF_DATE\"," >> "$manifest"
  echo "  \"capturedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$manifest"
  echo "  \"operator\": \"$(whoami)\"," >> "$manifest"
  echo "  \"hostname\": \"$(hostname)\"," >> "$manifest"
  echo "  \"files\": [" >> "$manifest"

  local first=true
  for f in "$EVIDENCE_DIR"/*; do
    if [ "$(basename "$f")" = "manifest.json" ]; then continue; fi
    if [ "$first" = true ]; then first=false; else echo "," >> "$manifest"; fi
    local size=$(wc -c < "$f" | tr -d ' ')
    local md5=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)
    printf "    {\"name\": \"%s\", \"size\": %s, \"md5\": \"%s\"}" "$(basename "$f")" "$size" "$md5" >> "$manifest"
  done

  echo "" >> "$manifest"
  echo "  ]" >> "$manifest"
  echo "}" >> "$manifest"

  echo ""
  echo "=== Evidence capture complete ==="
  echo "Directory: $EVIDENCE_DIR"
  echo "Files:     $(ls -1 "$EVIDENCE_DIR" | wc -l | tr -d ' ')"
  echo "Manifest:  $manifest"
  echo "==================================="
}

export -f capture capture_stdin capture_sql capture_sql_file capture_http finish_capture
export EVIDENCE_DIR PROOF_NAME PROOF_DATE
