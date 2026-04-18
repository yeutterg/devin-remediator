#!/usr/bin/env bash
# Background reconcile loop.
# Reconciles Devin sessions + regenerates STATUS.md every INTERVAL seconds,
# commits + pushes to `scaffold` when sessions have changed.
set -euo pipefail

: "${DEVIN_ORG_ID:?DEVIN_ORG_ID required}"
: "${DEVIN_API_KEY:?DEVIN_API_KEY required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"

INTERVAL="${INTERVAL:-120}"
BRANCH="${BRANCH:-scaffold}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

while true; do
  echo "=== $(date -u +%FT%TZ) reconcile"
  npx tsx src/cli.ts reconcile || true
  npx tsx src/cli.ts report || true
  if ! git diff --quiet STATUS.md 2>/dev/null; then
    git add STATUS.md
    git -c user.name="devin-remediator[bot]" -c user.email="devin-remediator@yeutterg.local" \
      commit -m "status: $(date -u +%FT%TZ)" >/dev/null
    git push origin "$BRANCH" >/dev/null 2>&1 || git push origin "$BRANCH"
    echo "  pushed STATUS.md update"
  else
    echo "  no STATUS.md changes"
  fi
  sleep "$INTERVAL"
done
