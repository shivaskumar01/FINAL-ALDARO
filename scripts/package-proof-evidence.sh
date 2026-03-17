#!/usr/bin/env bash
set -euo pipefail

# Package all proof evidence for a given date into a single archive.
#
# Usage:
#   scripts/package-proof-evidence.sh [YYYY-MM-DD]
#   (defaults to today's date)

DATE="${1:-$(date +%Y-%m-%d)}"
EVIDENCE_ROOT="exports/proofs/$DATE"

if [ ! -d "$EVIDENCE_ROOT" ]; then
  echo "ERROR: No evidence directory found at $EVIDENCE_ROOT"
  exit 1
fi

# Count proofs with evidence
PROOF_COUNT=$(ls -d "$EVIDENCE_ROOT"/*/ 2>/dev/null | wc -l | tr -d ' ')
echo "Found $PROOF_COUNT proof directories for $DATE"

# Generate top-level manifest
TOP_MANIFEST="$EVIDENCE_ROOT/manifest.json"
echo "{" > "$TOP_MANIFEST"
echo "  \"date\": \"$DATE\"," >> "$TOP_MANIFEST"
echo "  \"packagedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$TOP_MANIFEST"
echo "  \"operator\": \"$(whoami)\"," >> "$TOP_MANIFEST"
echo "  \"hostname\": \"$(hostname)\"," >> "$TOP_MANIFEST"
echo "  \"proofs\": [" >> "$TOP_MANIFEST"

first=true
for proof_dir in "$EVIDENCE_ROOT"/*/; do
  proof_name=$(basename "$proof_dir")
  file_count=$(ls -1 "$proof_dir" 2>/dev/null | wc -l | tr -d ' ')

  if [ "$first" = true ]; then first=false; else echo "," >> "$TOP_MANIFEST"; fi

  # Check for per-proof manifest
  has_manifest="false"
  if [ -f "$proof_dir/manifest.json" ]; then has_manifest="true"; fi

  printf "    {\"name\": \"%s\", \"files\": %s, \"hasManifest\": %s}" "$proof_name" "$file_count" "$has_manifest" >> "$TOP_MANIFEST"
done

echo "" >> "$TOP_MANIFEST"
echo "  ]" >> "$TOP_MANIFEST"
echo "}" >> "$TOP_MANIFEST"

# Create archive
ARCHIVE="exports/proofs/aldaro-proof-evidence-$DATE.tar.gz"
tar -czf "$ARCHIVE" -C exports/proofs "$DATE"

echo ""
echo "=== Proof Evidence Package ==="
echo "Date:       $DATE"
echo "Proofs:     $PROOF_COUNT"
echo "Manifest:   $TOP_MANIFEST"
echo "Archive:    $ARCHIVE"
echo "Size:       $(ls -lh "$ARCHIVE" | awk '{print $5}')"
echo "=============================="
