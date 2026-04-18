import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient, normalizeStatus } from "../devin.js";
import { makeOctokit, parseRepo } from "../github.js";
import type { StateDb } from "../state.js";

function extractPrUrl(structured: Record<string, unknown> | undefined, fallback?: string): string | undefined {
  if (structured && typeof structured["pr_url"] === "string") return structured["pr_url"] as string;
  return fallback;
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

  for (const s of open) {
    let remote;
    try {
      remote = await devin.getSession(s.devinSessionId);
    } catch (err) {
      console.warn(pc.yellow(`  ${s.devinSessionId}: fetch failed (${(err as Error).message})`));
      continue;
    }
    const nextStatus = normalizeStatus(remote.status_enum ?? remote.status);
    const prUrl = extractPrUrl(remote.structured_output ?? undefined, remote.pull_request?.url);

    const becameCompleted = nextStatus === "completed" && s.status !== "completed";

    if (nextStatus !== s.status || (prUrl && prUrl !== s.prUrl)) {
      s.status = nextStatus;
      s.updatedAt = new Date().toISOString();
      if (prUrl) s.prUrl = prUrl;
      if (remote.structured_output) s.structuredOutput = remote.structured_output;
      if (becameCompleted) s.completedAt = s.updatedAt;
      changed += 1;
    }

    if (nextStatus === "blocked" && s.iterations < 1) {
      await devin.sendMessage(
        s.devinSessionId,
        "You appear to be blocked. If you need environment credentials, check `.env.example` in the repo for mock values and continue. Otherwise, finish with your best-effort patch and emit structured output with `confidence: low` and a description of the blocker.",
      );
      s.iterations += 1;
      s.updatedAt = new Date().toISOString();
    }

    if (becameCompleted && s.prUrl) {
      await octokit.issues.createComment({
        ...repo,
        issue_number: s.issueNumber,
        body: [
          `Devin session completed.`,
          `- PR: ${s.prUrl}`,
          s.structuredOutput ? `- Fix summary: ${s.structuredOutput["fix_summary"] ?? "(none)"}` : "",
          s.structuredOutput ? `- Confidence: ${s.structuredOutput["confidence"] ?? "(none)"}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  await db.write();
  console.log(pc.green(`reconcile: ${changed} session state update(s), ${open.length} open`));
}
