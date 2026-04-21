# devin-remediator

Event-driven remediation orchestrator. Turns GitHub issues (from scanners, seeded tickets, or humans adding a label) into autonomous Devin sessions that ship merge-ready PRs.

## What it does

1. **scan** — runs `pip-audit` / `npm audit` / `actionlint` / `bandit` against a target checkout; normalizes findings through Zod schemas.
2. **file-issues** — creates GitHub issues for new findings (idempotent via fingerprint). Also ingests a curated YAML seed file for non-scanner classes (theming, a11y, TS migration, tests).
3. **dispatch** — for each issue labeled `devin-auto-remediate` without an active session: creates a Devin session via the v3 API, attaches a class-specific playbook by `playbook_id`, tags the session, requires a structured output schema. Dispatch is **round-robin by class** so STATUS.md shows class diversity early.
4. **reconcile** — polls open Devin sessions, checks CI on resulting PRs, auto-messages blocked sessions with useful context, writes status comments back to the issues, and **DELETEs (archives) sessions once their PR's CI is green** so the concurrent-session slot is released.
5. **report** — regenerates `STATUS.md` with funnel, throughput, quality, and **ACU cost** metrics plus a per-session table.
6. **run** — scan → file-issues → dispatch → reconcile → report, in one execution.
7. **doctor** — one-shot preflight: verifies GitHub access, enables issues on the fork, creates the class labels, and probes whether `create_as_user_id` works. Results are cached in `state.json.preflight` so dispatch doesn't re-probe on every tick.
8. **playbooks:register** — uploads each `src/playbooks/*.md` to Devin as an org-level playbook and caches the returned `playbook_id` in `state.json.playbooks[]`. On the next dispatch, sessions are created with `playbook_id` instead of ~2KB of inlined markdown per prompt.
9. **webhook** — real-time receiver on `:8787/webhook`. Verifies a shared secret, and on each Devin session event: refetches the session, runs the per-session reconcile pipeline (CI check, auto-archive on CI-green, completion comment), regenerates `STATUS.md`, and (optionally) commits + pushes to a configured branch. The polling loop remains as a fallback.
10. **issues:ingest** — pulls existing open GitHub issues (default filter: `devin-auto-remediate` label) into `state.json` so `dispatch` can remediate **pre-existing issues** without the orchestrator filing any new ones. Useful when the issue source is humans, Linear/Jira webhooks, Dependabot/Snyk, or any upstream ticketing system.

## Why Devin

Dependabot can bump versions but can't fix the downstream test/CI breakage. Codemods can apply mechanical rewrites but can't make semantic decisions. Devin is the only primitive that can:

- Reproduce a finding, patch minimally, run the right test suite.
- Read failing CI and self-correct.
- Apply cross-stack fixes (py + tsx + yml) in a single PR.
- Follow a design-token system for theming work.
- Emit structured output so metrics stay typed end-to-end.

This orchestrator is intentionally thin (~300 LOC of glue). Devin is the agent; the CLI is the bus.

## Quick start

```bash
npm install
npm run build
export GITHUB_TOKEN=ghp_...
export DEVIN_API_KEY=cog_...                   # must start with cog_ / dsk_ / dev_
export DEVIN_ORG_ID=org-xxxxxxxxxxxxxxxx       # prefixed UUID from the Devin UI URL
export DEVIN_USER_ID='email|xxxxxxxxxxxx'      # prefixed user id, not the display name
export TARGET_REPO=yeutterg/superset
export REMEDIATOR_REPO=yeutterg/devin-remediator

# one-time setup
npx remediator doctor                          # preflight: labels, issues, impersonation probe
npx remediator playbooks:register              # register playbooks → cache playbook_id in state.json

# steady state — full pipeline (scanners file new issues, Devin remediates)
npx remediator run                             # scan → file-issues → dispatch → reconcile → report

# OR — resolve-only mode (remediate issues filed elsewhere; no scanner/seed work)
npx remediator issues:ingest                   # pulls existing `devin-auto-remediate` issues into state
npx remediator dispatch                        # creates Devin sessions for the ingested issues
npx remediator reconcile                       # polls, auto-archives on CI-green, writes STATUS.md

# OR — one-shot a single issue on demand
npx remediator issues:ingest --issue 42 --class fe:a11y
npx remediator dispatch
```

Config load fails fast if `DEVIN_ORG_ID` / `DEVIN_USER_ID` / `DEVIN_API_KEY` don't match their expected prefixes — previously these were accepted as display names and only surfaced as a 404 on the first API call.

## Event sources

- **Scheduled trigger** — `cron`, `launchd`, or a GitHub Action on `schedule:` runs `remediator run`. Scan findings are the event.
- **Label trigger** — a human (or another system) labels an issue `devin-auto-remediate`; the next `issues:ingest` + `dispatch` pair picks it up. Use this when the orchestrator should **only remediate, not file**.
- **Upstream ticketing trigger** — Linear/Jira/Snyk/Dependabot file issues on the repo (carrying the `devin-auto-remediate` label + a class label like `vuln:dep`); `issues:ingest` pulls them into state.
- **CI-feedback trigger** — when a Devin PR's CI fails, the reconciler sends a follow-up message to the Devin session to self-correct.

## Real-time updates

Two paths, designed to coexist:

- **Webhook (push)** — lowest latency. Devin POSTs session events to `:8787/webhook`; the receiver updates state + STATUS.md in one round-trip.
  ```bash
  # terminal 1: start receiver, auto-push STATUS.md to main on every event
  export WEBHOOK_SECRET=$(openssl rand -hex 32)
  npx remediator webhook --push-branch main

  # terminal 2 (or the Devin UI): expose the receiver + register it
  ngrok http 8787              # or cloudflared, tailscale funnel, etc.
  # Then register the public URL + secret with Devin (UI → Settings → Webhooks,
  # or POST /v3/organizations/{org}/webhooks with events: ["session.*"]).
  ```
- **Polling loop (pull)** — always-on fallback. Default interval 60s; runs `dispatch → reconcile → report` per tick.
  ```bash
  BRANCH=main INTERVAL=60 bash scripts/loop.sh

  # Live-demo pacing: one session at a time (a new one only starts after the previous
  # session's PR ships and the concurrent slot is released). Useful for Loom recordings.
  LOOP_DEMO=1 BRANCH=main INTERVAL=60 bash scripts/loop.sh
  ```

## Issue lifecycle

- When a Devin session **opens a PR** for an issue, the reconciler immediately **closes the issue** with a comment linking the PR. This keeps the `Open` issue list as the live work-queue.
- The PR itself is **never auto-merged** — a human reviewer is the trust gate. GitHub keeps the issue closed when the PR merges (via `Fixes #N`). If the PR is rejected, manually reopen the issue; the next `reconcile` will pick it back up.
- To backfill closure for issues whose PRs were opened before this auto-close behavior shipped:
  ```bash
  npx remediator close-issues
  ```

## Observability

`STATUS.md` is regenerated on every `report` run (polling) and on every webhook event (push). It tracks end-to-end effectiveness with:

- Funnel (findings → issues → sessions → PRs → merged) by class.
- Throughput (sessions completed per hour).
- Quality (CI-pass-on-first-try rate, retries per PR).
- Cost (ACU per fix, $/fix).
- Per-session table with direct links.

## Configuration

Environment variables are read from `.env` or shell. See `src/config.ts`.

## Project layout

```
src/
  cli.ts              commander entrypoint
  config.ts           env-backed config + zod validation
  state.ts            lowdb wrapper over state.json
  github.ts           octokit helpers
  devin.ts            Devin v3 API client
  scanners/
    pipAudit.ts
    npmAudit.ts
    actionlint.ts
    bandit.ts
    normalize.ts      Zod schemas + Finding type
  commands/
    scan.ts
    fileIssues.ts
    dispatch.ts          # round-robin by class; uses playbook_id when registered
    reconcile.ts         # auto-archives after CI-green; captures acus_consumed
    report.ts            # ACU cost + sessions table
    run.ts
    doctor.ts            # preflight checks + cache
    playbooks.ts         # register/update org playbooks
    webhook.ts           # real-time receiver: per-session reconcile + STATUS.md push
  playbooks/
    security.md
    ci.md
    theme.md
    a11y.md
    perf.md
    ts-migrate.md
    tests.md
  seeds/
    issues.yaml       30 curated issues
```
