# devin-remediator

Event-driven remediation orchestrator. Turns GitHub issues (from scanners, seeded tickets, or humans adding a label) into autonomous Devin sessions that ship merge-ready PRs.

Built as a 2–3h take-home challenge. Pitched for a VP of Engineering audience.

## What it does

1. **scan** — runs `pip-audit` / `npm audit` / `actionlint` / `bandit` against a target checkout; normalizes findings through Zod schemas.
2. **file-issues** — creates GitHub issues for new findings (idempotent via fingerprint). Also ingests a curated YAML seed file for non-scanner classes (theming, a11y, TS migration, tests).
3. **dispatch** — for each issue labeled `devin-auto-remediate` without an active session: creates a Devin session via the v3 API, attaches a class-specific playbook, tags the session, requires a structured output schema.
4. **reconcile** — polls open Devin sessions, checks CI on resulting PRs, auto-messages blocked sessions with useful context, writes status comments back to the issues.
5. **report** — regenerates `STATUS.md` with funnel, throughput, quality, and cost metrics plus a per-session table.
6. **run** — scan → file-issues → dispatch → reconcile → report, in one execution.

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
export DEVIN_API_KEY=cog_...
export DEVIN_ORG_ID=...
export DEVIN_USER_ID=...        # your Devin user id for create_as_user_id
export TARGET_REPO=yeutterg/superset
export REMEDIATOR_REPO=yeutterg/devin-remediator
npx remediator run
```

## Event sources

- **Scheduled trigger** — `cron`, `launchd`, or a GitHub Action on `schedule:` runs `remediator run`. Scan findings are the event.
- **Label trigger** — a human (or another system) labels an issue `devin-auto-remediate`; the next `dispatch` picks it up.
- **CI-feedback trigger** — when a Devin PR's CI fails, the reconciler sends a follow-up message to the Devin session to self-correct.

## Observability

`STATUS.md` is regenerated on every `report` run. It answers *"if I were a VP of Engineering, how would I know this is working?"* with:

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
    dispatch.ts
    reconcile.ts
    report.ts
    run.ts
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
