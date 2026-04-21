import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient, normalizeStatus, type GetSessionData } from "../devin.js";
import { makeOctokit, parseRepo, type RepoRef } from "../github.js";
import type { SessionRecord, StateDb } from "../state.js";

function extractPrUrl(
  structured: Record<string, unknown> | undefined,
  fallback?: string,
  prList?: { url?: string }[] | null,
): string | undefined {
  if (structured && typeof structured["pr_url"] === "string") return structured["pr_url"] as string;
  if (fallback) return fallback;
  const first = prList?.find((p) => !!p.url);
  return first?.url;
}

async function checkCiStatus(
  octokit: ReturnType<typeof makeOctokit>,
  prUrl: string,
): Promise<"pending" | "success" | "failure" | "unknown"> {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return "unknown";
  const [, owner, repo, num] = m;
  try {
    const pr = await octokit.pulls.get({ owner: owner!, repo: repo!, pull_number: Number(num) });
    const { data: status } = await octokit.repos.getCombinedStatusForRef({
      owner: owner!,
      repo: repo!,
      ref: pr.data.head.sha,
    });
    if (status.state === "success") return "success";
    if (status.state === "failure" || status.state === "error") return "failure";
    // combined status is "pending" if no statuses at all — check check-runs too
    const { data: checks } = await octokit.checks.listForRef({
      owner: owner!,
      repo: repo!,
      ref: pr.data.head.sha,
    });
    if (checks.total_count === 0) return "pending";
    // Treat cancelled/action_required/stale as failure so we don't prematurely archive and
    // mis-report ciPassedFirstTry. Only success/neutral/skipped should count as "done ok".
    const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
    const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
    const anyFail = checks.check_runs.some((c) => c.conclusion !== null && FAIL_CONCLUSIONS.has(c.conclusion));
    if (anyFail) return "failure";
    const allDone = checks.check_runs.every(
      (c) => c.status === "completed" && c.conclusion !== null && OK_CONCLUSIONS.has(c.conclusion),
    );
    if (allDone) return "success";
    return "pending";
  } catch {
    return "unknown";
  }
}

export async function runReconcile(config: Config, db: StateDb): Promise<void> {
  if (!config.devinApiKey || !config.devinOrgId) {
    console.warn(pc.yellow("reconcile: DEVIN_API_KEY / DEVIN_ORG_ID not set — skipping"));
    return;
  }
  const devin = new DevinClient(config.devinApiKey, config.devinOrgId, config.devinApiBase);
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);

  const open = db.data.sessions.filter((s) => !["completed", "stopped", "failed"].includes(s.status));
  let changed = 0;
  let archived = 0;

  for (const s of open) {
    const result = await reconcileOneSession(s, { devin, octokit, repo });
    if (result.changed) changed += 1;
    if (result.archived) archived += 1;
  }

  await db.write();
  console.log(
    pc.green(
      `reconcile: ${changed} state update(s), ${archived} auto-archived after CI-green, ${open.length} previously open`,
    ),
  );
}

export interface ReconcileSessionDeps {
  devin: DevinClient;
  octokit: ReturnType<typeof makeOctokit>;
  repo: RepoRef;
}

export interface ReconcileSessionResult {
  changed: boolean;
  archived: boolean;
}

/**
 * Per-session reconcile: refetch from Devin, update state, auto-archive on CI-green,
 * nudge blocked sessions, post completion comments. Mutates `s` in place; callers are
 * responsible for `db.write()` after calling this (so multiple sessions can be batched).
 *
 * Exported so the webhook receiver can turn a single session.event push into an immediate
 * state update + STATUS.md refresh without waiting for the polling loop.
 */
export async function reconcileOneSession(
  s: SessionRecord,
  deps: ReconcileSessionDeps,
): Promise<ReconcileSessionResult> {
  const { devin, octokit, repo } = deps;
  let remote: GetSessionData;
  try {
    remote = await devin.getSession(s.devinSessionId);
  } catch (err) {
    console.warn(pc.yellow(`  ${s.devinSessionId}: fetch failed (${(err as Error).message})`));
    return { changed: false, archived: false };
  }
  let changed = false;
  let archived = false;

  let nextStatus = normalizeStatus(remote.status_enum ?? remote.status);
  const prList = remote.pull_requests ?? undefined;
  const prUrl = extractPrUrl(
    remote.structured_output ?? undefined,
    remote.pull_request?.url,
    prList,
  );
  // Archived sessions are asleep; if they shipped a PR, treat as completed; else stopped.
  if (remote.is_archived === true && !["completed", "stopped"].includes(nextStatus)) {
    nextStatus = prUrl ? "completed" : "stopped";
  }

  const becameCompleted = nextStatus === "completed" && s.status !== "completed";

  if (
    nextStatus !== s.status
    || (prUrl && prUrl !== s.prUrl)
    || (typeof remote.acus_consumed === "number" && remote.acus_consumed !== s.acusConsumed)
  ) {
    s.status = nextStatus;
    s.updatedAt = new Date().toISOString();
    if (prUrl) s.prUrl = prUrl;
    if (typeof remote.acus_consumed === "number") s.acusConsumed = remote.acus_consumed;
    if (remote.structured_output) s.structuredOutput = remote.structured_output;
    if (becameCompleted) s.completedAt = s.updatedAt;
    changed = true;
  }

  // #1 Concurrent-cap handling — once a session has a PR AND CI has at least reached a
  // non-pending state, archive it to release the concurrent-session slot. The PR keeps running
  // CI on its own; the human reviewer merges. If CI fails BEFORE archive, we auto-message the
  // session to self-correct (below) instead of archiving.
  if (s.prUrl && !s.archivedAfterPr && !remote.is_archived) {
    const ci = await checkCiStatus(octokit, s.prUrl);
    if (ci === "success") {
      if (s.ciPassedFirstTry === undefined) s.ciPassedFirstTry = true;
      await devin.archiveSession(s.devinSessionId);
      s.archivedAfterPr = true;
      s.status = "completed";
      if (!s.completedAt) s.completedAt = new Date().toISOString();
      archived = true;
    } else if (ci === "failure" && s.iterations < 2) {
      // CI-feedback loop: tell the session exactly what to fix.
      await devin.sendMessage(
        s.devinSessionId,
        `Your PR (${s.prUrl}) has failing CI. Please read the failing checks, push fixes to the same branch, and reply when CI is green or you've exhausted reasonable fixes.`,
      );
      s.iterations += 1;
      s.ciPassedFirstTry = false;
      s.updatedAt = new Date().toISOString();
    }
  }

  // Skip the blocked-nudge if this iteration just auto-archived the session (status was flipped
  // to "completed" above but nextStatus is still "blocked" from the pre-archive API snapshot) —
  // sendMessage on an archived session returns an error and would otherwise crash the whole
  // reconcile batch. Also wrap in try/catch defensively so one transient API error can't drop
  // state for every subsequent session in the loop.
  if (nextStatus === "blocked" && s.iterations < 1 && !s.archivedAfterPr && s.status !== "completed") {
    try {
      await devin.sendMessage(
        s.devinSessionId,
        "You appear to be blocked. If you need environment credentials, check `.env.example` for mock values and continue. Otherwise emit structured output with `confidence: low` and a description of the blocker.",
      );
      s.iterations += 1;
      s.updatedAt = new Date().toISOString();
    } catch (err) {
      console.warn(pc.yellow(`  blocked-nudge failed for ${s.devinSessionId}: ${(err as Error).message}`));
    }
  }

  // Post the completion comment either when the session reached "completed" on its own, OR
  // when we just auto-archived it after CI-green (in which case `becameCompleted` is still
  // false because nextStatus was "running"/"blocked" on the pre-archive snapshot).
  const shouldCommentCompletion =
    s.prUrl
    && s.status === "completed"
    && !s.completionCommentPosted
    && (becameCompleted || s.archivedAfterPr);
  if (shouldCommentCompletion) {
    try {
      await octokit.issues.createComment({
        ...repo,
        issue_number: s.issueNumber,
        body: [
          `Devin session completed.`,
          `- PR: ${s.prUrl}`,
          s.structuredOutput ? `- Fix summary: ${s.structuredOutput["fix_summary"] ?? "(none)"}` : "",
          s.structuredOutput ? `- Confidence: ${s.structuredOutput["confidence"] ?? "(none)"}` : "",
          typeof s.acusConsumed === "number" ? `- ACUs consumed: ${s.acusConsumed.toFixed(2)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      s.completionCommentPosted = true;
    } catch (err) {
      console.warn(pc.yellow(`  issue comment failed: ${(err as Error).message}`));
    }
  }

  return { changed, archived };
}
