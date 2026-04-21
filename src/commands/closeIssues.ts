import pc from "picocolors";
import type { Config } from "../config.js";
import { makeOctokit, parseRepo } from "../github.js";
import type { StateDb } from "../state.js";

/**
 * Backfill: close every GitHub issue whose corresponding Devin session already has a PR URL
 * persisted in state.json. Normally this happens automatically inside `reconcileOneSession`
 * the moment a PR is first detected, but for sessions dispatched before auto-close shipped
 * we need to sweep them retroactively.
 *
 * Idempotent: sessions with `issueClosed: true` are skipped.
 */
export async function runCloseIssues(config: Config, db: StateDb): Promise<void> {
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);

  const pending = db.data.sessions.filter((s) => s.prUrl && !s.issueClosed);
  if (pending.length === 0) {
    console.log(pc.gray("close-issues: nothing to do (no unclosed issues with PRs)"));
    return;
  }

  console.log(pc.cyan(`close-issues: closing ${pending.length} issue(s) with open PRs`));

  let closed = 0;
  for (const s of pending) {
    try {
      await octokit.issues.createComment({
        ...repo,
        issue_number: s.issueNumber,
        body: `Auto-closing: Devin opened a PR for this issue — ${s.prUrl}. Reopen this issue if the PR is rejected.`,
      });
      await octokit.issues.update({
        ...repo,
        issue_number: s.issueNumber,
        state: "closed",
        state_reason: "completed",
      });
      s.issueClosed = true;
      closed += 1;
      console.log(pc.green(`  closed #${s.issueNumber} (PR: ${s.prUrl})`));
    } catch (err) {
      console.warn(pc.yellow(`  #${s.issueNumber}: ${(err as Error).message}`));
    }
  }

  await db.write();
  console.log(pc.green(`close-issues: ${closed}/${pending.length} closed`));
}
