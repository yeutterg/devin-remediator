# Event-Driven Remediation with Devin

5-slide deck. Each `---` is a slide break.

---

## 1 / Problem

**Security findings and cross-stack polish never get prioritized.**

- A typical repo: dozens of open advisories, a11y gaps, TS-migration stragglers, flaky tests.
- Dependabot auto-bumps **one dep at a time** — doesn't fix the downstream test breakage a bump causes.
- Codemods can do mechanical rewrites — can't make semantic decisions (e.g. "which color token replaces `#1E1E1E`?").
- Everything else: humans, manually, never.

**If that backlog is your tax, how much engineer-time is it costing you per quarter?**

---

## 2 / What we built

**A small TS CLI that turns findings into Devin sessions, and Devin sessions into merge-ready PRs.**

- One package: `yeutterg/devin-remediator` (~400 LOC of glue).
- Events: scan results (`pip-audit`, `npm audit`, `actionlint`, `bandit`), a curated YAML ticket feed, and a GitHub label (`devin-auto-remediate`).
- Target: `yeutterg/superset` (clean fork of apache/superset).
- 30 issues filed. **9 merge-ready PRs** opened by Devin in the first run.

```
scan → file-issues → dispatch → reconcile → report
```

---

## 3 / How it works

**Devin v3 REST API is the core primitive. The orchestrator is the bus.**

- `POST /v3/organizations/{org}/sessions` — one Devin session per issue, with `prompt`, `tags`, `repos`, class-specific `playbook_id`, and a Zod-backed `structured_output_schema`.
- `GET /v3/…/sessions/{id}` — poll status, `pull_requests[]`, `structured_output` → write status comments back to the issue, auto-message blocked sessions with useful context.
- `POST /v3/…/sessions/{id}/messages` — CI-feedback loop: when a Devin PR's CI fails, the reconciler messages the session to self-correct.
- `DELETE /v3/…/sessions/{id}?archive=true` — free concurrent-session slots once a PR is open.
- Observability: lowdb `state.json` + regenerated `STATUS.md` (funnel, throughput, CI-pass-first-try rate).

---

## 4 / Results

**9 PRs opened by Devin, covering real Superset CVEs and workflow hardening.**

| # | Area | Fix |
|---|---|---|
| #31 | `vuln:dep` | bump `flask-cors` past GHSA-84pr-m4jr-85g5 |
| #32 | `vuln:dep` | pin `path-to-regexp` past GHSA-9wv6-86v2-598j |
| #33 | `vuln:dep` | enforce `cookie >=0.7.1` for GHSA-pxg6-pf52-xh8x |
| #34 | `vuln:dep` | pin `send` for GHSA-m6fv-jmcg-4jfg |
| #35 | `vuln:ci` | extract unsafe `${{ github.event.* }}` to env vars |
| #36 | `vuln:dep` | document `urllib3` GHSA-34jh-p97f-mpxf coverage |
| #37 | `vuln:dep` | forbid `lodash.*` subpath imports |
| #38 | `vuln:dep` | ban deprecated `request` package |
| #39 | `vuln:dep` | pin `jinja2>=3.1.5` for GHSA-q2x7-8rv6-6q7h |

Live: `STATUS.md` on [`yeutterg/devin-remediator`](https://github.com/yeutterg/devin-remediator/blob/scaffold/STATUS.md) · PRs on [`yeutterg/superset`](https://github.com/yeutterg/superset/pulls).

---

## 5 / Why Devin, and what's next

**Why Devin is the only primitive that makes this work**

- **CI feedback loop.** Devin reads failing tests and iterates — the hard part of any dependency bump.
- **Cross-stack patches.** One session can touch `.py`, `.tsx`, and `.yml` in the same PR.
- **Playbook-driven.** We attach a different playbook per remediation class (security, a11y, theming, TS) — same orchestrator, different agent behavior.
- **Structured output.** Every session emits typed JSON (`pr_url`, `fix_summary`, `confidence`) so metrics stay typed end-to-end.

**Next (quick wins)**

- Auto-merge behind a confidence + CI-pass gate.
- Real scanner feeds — Snyk, CodeQL, GitHub Advisory — in place of the seed YAML.
- Slack-in-the-loop: `/approve` button instead of GitHub label.
- Multi-repo fleet mode — one orchestrator, N target repos, one dashboard.
