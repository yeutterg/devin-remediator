import { spawn } from "node:child_process";
import http from "node:http";
import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient } from "../devin.js";
import { makeOctokit, parseRepo } from "../github.js";
import { openState } from "../state.js";
import { reconcileOneSession } from "./reconcile.js";
import { runReport } from "./report.js";

// Webhook receiver: turns a Devin session event into an immediate state update + STATUS.md push,
// so observability latency is O(ms) instead of O(poll-interval). The polling loop remains as a
// fallback when the webhook is unreachable (e.g. ngrok tunnel dropped).
//
// Expected payload (Devin v3 webhooks; field names are best-effort pending API stabilization):
//   {
//     event: "session.status_changed" | "session.pr_opened" | "session.completed" | ...,
//     session_id: "devin-abcd1234" | "abcd1234",   // with or without the `devin-` prefix
//     status?: "running" | "blocked" | "completed" | "stopped" | "failed",
//     pr_url?: "https://github.com/…/pull/42",
//     acus_consumed?: number,
//   }
//
// Configure Devin with:
//   export WEBHOOK_PUBLIC_URL=https://<tunnel>/webhook
//   POST  https://api.devin.ai/v3/organizations/{org}/webhooks  { url, events: ["session.*"], secret }
// Set WEBHOOK_SECRET in .env; the receiver rejects requests whose x-devin-signature /
// x-webhook-secret header doesn't match.

type WebhookEvent = {
  event?: string;
  session_id?: string;
  status?: string;
  pr_url?: string;
  acus_consumed?: number;
};

function matchSession(
  sessions: ReadonlyArray<{ devinSessionId: string }>,
  payloadId: string | undefined,
): { devinSessionId: string } | undefined {
  if (!payloadId) return undefined;
  const normalized = payloadId.startsWith("devin-") ? payloadId : `devin-${payloadId}`;
  return sessions.find(
    (s) => s.devinSessionId === payloadId || s.devinSessionId === normalized,
  );
}

/** Commit + push STATUS.md if it changed. Fires a detached git invocation so a slow push
 *  doesn't block the HTTP response to Devin. */
function pushStatusAsync(rootDir: string, branch: string): void {
  // Multi-line bash script: join with `\n` so each array element is its own line (space-join
  // merged `cd` and `if` into one command; && join broke on `then &&`). Inner `&&` chains the
  // three git commands so a failed add/commit doesn't push stale state.
  const sh = [
    `cd "${rootDir}"`,
    `if ! git diff --quiet STATUS.md 2>/dev/null; then`,
    `  git add STATUS.md &&`,
    `  git -c user.name='devin-remediator[bot]' -c user.email='devin-remediator@local' commit -m "status: webhook $(date -u +%FT%TZ)" >/dev/null 2>&1 &&`,
    `  git push origin "${branch}" >/dev/null 2>&1 || true`,
    `fi`,
  ].join("\n");
  const child = spawn("bash", ["-c", sh], { stdio: "ignore", detached: true });
  child.unref();
}

export async function runWebhook(
  config: Config,
  opts: { port: number; secret?: string; pushBranch?: string; reportOut?: string },
): Promise<void> {
  const db = await openState(config.stateFile);
  const secret = opts.secret ?? process.env["WEBHOOK_SECRET"];
  const pushBranch = opts.pushBranch ?? process.env["WEBHOOK_PUSH_BRANCH"] ?? "";
  const reportOut = opts.reportOut ?? "STATUS.md";

  const devin = config.devinApiKey && config.devinOrgId
    ? new DevinClient(config.devinApiKey, config.devinOrgId, config.devinApiBase)
    : undefined;
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);

  // Per-session serialization: two webhook events for the same session (e.g. status_changed +
  // completed in quick succession) would otherwise race on `session.completionCommentPosted`,
  // `session.archivedAfterPr`, etc., producing duplicate GitHub comments + duplicate sendMessage
  // calls. Chain each session's work onto a per-session promise so different sessions still
  // process in parallel but same-session events run in order.
  const sessionQueues = new Map<string, Promise<void>>();
  function serialize(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = sessionQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    sessionQueues.set(key, next);
    // Clean up when the queue drains so the Map doesn't grow unboundedly.
    void next.finally(() => {
      if (sessionQueues.get(key) === next) sessionQueues.delete(key);
    });
    return next;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: db.data.sessions.length }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }
    if (secret) {
      const got = req.headers["x-devin-signature"] ?? req.headers["x-webhook-secret"];
      if (got !== secret) {
        res.writeHead(401).end("unauthorized");
        return;
      }
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    let payload: WebhookEvent;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as WebhookEvent;
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }

    // Respond fast; do the expensive work asynchronously so webhook delivery doesn't time out
    // on slow Devin GETs or git pushes.
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));

    console.log(
      pc.cyan(
        `[webhook] ${payload.event ?? "?"} ${payload.session_id ?? "?"} → ${payload.status ?? "?"}`,
      ),
    );

    const match = matchSession(db.data.sessions, payload.session_id);
    if (!match) {
      console.warn(pc.yellow(`  no local session for ${payload.session_id}; ignoring`));
      return;
    }

    void serialize(match.devinSessionId, async () => {
      // Re-lookup the session under the lock so we see mutations from the previous chained task.
      const session = db.data.sessions.find((s) => s.devinSessionId === match.devinSessionId);
      if (!session) return;

      // Optimistic in-memory update from the payload so STATUS.md reflects the event even if
      // the Devin GET slow-paths below or fails.
      if (payload.pr_url) session.prUrl = payload.pr_url;
      if (typeof payload.acus_consumed === "number") session.acusConsumed = payload.acus_consumed;
      session.updatedAt = new Date().toISOString();

      // Authoritative update: refetch from Devin + run the per-session reconcile pipeline
      // (CI check, auto-archive, completion comment, blocked-nudge).
      if (devin) {
        try {
          await reconcileOneSession(session, { devin, octokit, repo });
        } catch (err) {
          console.warn(pc.yellow(`  reconcileOneSession failed: ${(err as Error).message}`));
        }
      }
      await db.write();

      try {
        await runReport(config, db, reportOut);
      } catch (err) {
        console.warn(pc.yellow(`  runReport failed: ${(err as Error).message}`));
      }

      if (pushBranch) pushStatusAsync(process.cwd(), pushBranch);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  console.log(
    pc.green(
      `webhook listening on :${opts.port}/webhook${secret ? " (secret required)" : " (no secret — DEV ONLY)"}`,
    ),
  );
  if (pushBranch) console.log(pc.gray(`  STATUS.md pushes → origin/${pushBranch}`));
}
