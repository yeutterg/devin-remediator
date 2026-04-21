#!/usr/bin/env bash
# Background reconcile loop — the polling fallback to the webhook receiver.
#
# Each tick does: dispatch (pick up newly-ingested/labeled issues) → reconcile (poll Devin,
# auto-archive CI-green sessions, self-heal blocked ones) → report (regenerate STATUS.md) →
# commit + push if STATUS.md changed.
#
# Default interval is 60s so PRs + status comments appear in near-realtime. Pair with
# `remediator webhook --push-branch main` for true push-based updates; the loop is the
# safety net for when the webhook tunnel is down.
set -euo pipefail

: "${DEVIN_ORG_ID:?DEVIN_ORG_ID required}"
: "${DEVIN_API_KEY:?DEVIN_API_KEY required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"

INTERVAL="${INTERVAL:-60}"
BRANCH="${BRANCH:-main}"
LOOP_DISPATCH="${LOOP_DISPATCH:-1}"   # set to 0 to skip dispatch each tick
LOOP_DEMO="${LOOP_DEMO:-0}"            # 1 = one-at-a-time pacing for live demos
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Demo mode: cap MAX_ACTIVE_SESSIONS=1 so dispatch only creates one session at a time.
# A new session is only created once the previous has shipped its PR (released via the
# auto-archive path). Useful for Loom recordings where you want to narrate one PR at a time.
if [[ "$LOOP_DEMO" = "1" ]]; then
  export MAX_ACTIVE_SESSIONS=1
  echo "  LOOP_DEMO=1: MAX_ACTIVE_SESSIONS pinned to 1 for one-at-a-time pacing"
fi

while true; do
  echo "=== $(date -u +%FT%TZ) tick"
  if [[ "$LOOP_DISPATCH" != "0" ]]; then
    npx tsx src/cli.ts dispatch || true
  fi
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
