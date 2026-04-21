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

/** Awaitable git add/commit/push of the report file (defaults to STATUS.md). Resolves whether
 *  or not there was anything to push; errors are swallowed (the next event / loop tick will
 *  retry). Callers serialize via the pushQueue to avoid `.git/index.lock` races between
 *  concurrent webhook events. */
function pushStatus(rootDir: string, branch: string, reportFile: string): Promise<void> {
  // Single-quote paths & branch for the bash script; escape any embedded single quotes using
  // the standard `'"'"'` sandwich so a path like `weird'name.md` still parses correctly.
  const q = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
  const qFile = q(reportFile);
  const qBranch = q(branch);
  const qRoot = q(rootDir);
  // Multi-line bash script: join with `\n` so each array element is its own line (space-join
  // merged `cd` and `if` into one command; && join broke on `then &&`). Inner `&&` chains the
  // three git commands so a failed add/commit doesn't push stale state.
  const sh = [
    `cd ${qRoot}`,
    `if ! git diff --quiet -- ${qFile} 2>/dev/null; then`,
    `  git add -- ${qFile} &&`,
    `  git -c user.name='devin-remediator[bot]' -c user.email='devin-remediator@local' commit -m "status: webhook $(date -u +%FT%TZ)" >/dev/null 2>&1 &&`,
    `  git push origin ${qBranch} >/dev/null 2>&1 || true`,
    `fi`,
  ].join("\n");
  return new Promise<void>((resolve) => {
    const child = spawn("bash", ["-c", sh], { stdio: "ignore" });
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
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

  // Global serialization of the entire read → mutate → write → report → push cycle. We tried
  // per-session queues earlier but that still lets different-session events interleave, and
  // `db.read()` replaces `db.data` wholesale (lowdb behavior) — so an in-flight callback holding
  // a reference to `session` from the previous db.data would silently have its mutations
  // dropped when the next event called db.read() and then db.write(). A single chain is the
  // cheapest way to make the whole cycle atomic. STATUS.md git pushes ride the same chain so
  // they can't race on `.git/index.lock`.
  let chain: Promise<void> = Promise.resolve();
  function serialize(fn: () => Promise<void>): Promise<void> {
    // Each task runs after the previous one settles; catch at both ends so neither a failing
    // predecessor blocks the chain nor a failing task surfaces as an unhandled rejection when
    // callers `void serialize(...)`.
    const next = chain.then(() => fn().catch((err: unknown) => {
      console.warn(pc.yellow(`  serialized task failed: ${(err as Error).message}`));
    }));
    chain = next;
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

    void serialize(async () => {
      // Re-read state.json inside the lock so we pick up any mutations made by the polling-loop
      // process (different Node process) between events.
      try {
        await db.read();
      } catch (err) {
        console.warn(pc.yellow(`  db.read failed: ${(err as Error).message}`));
      }

      // Re-lookup after re-read (db.data is replaced wholesale by lowdb on .read()).
      const match = matchSession(db.data.sessions, payload.session_id);
      if (!match) {
        console.warn(pc.yellow(`  no local session for ${payload.session_id}; ignoring`));
        return;
      }
      const session = db.data.sessions.find((s) => s.devinSessionId === match.devinSessionId);
      if (!session) return;

      // Optimistic in-memory update from the payload so STATUS.md reflects the event even if
      // the Devin GET slow-paths below or fails.
      if (payload.pr_url) session.prUrl = payload.pr_url;
      if (typeof payload.acus_consumed === "number") session.acusConsumed = payload.acus_consumed;
      session.updatedAt = new Date().toISOString();

      // Authoritative update: refetch from Devin + run the per-session reconcile pipeline
      // (CI check, auto-archive, completion comment, blocked-nudge, issue auto-close).
      if (devin) {
        try {
          await reconcileOneSession(session, { devin, octokit, repo });
        } catch (err) {
          console.warn(pc.yellow(`  reconcileOneSession failed: ${(err as Error).message}`));
        }
      }
      try {
        await db.write();
      } catch (err) {
        console.warn(pc.yellow(`  db.write failed: ${(err as Error).message}`));
      }

      try {
        await runReport(config, db, reportOut);
      } catch (err) {
        console.warn(pc.yellow(`  runReport failed: ${(err as Error).message}`));
      }

      if (pushBranch) await pushStatus(process.cwd(), pushBranch, reportOut);
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
