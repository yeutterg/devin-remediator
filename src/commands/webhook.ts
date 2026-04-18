import http from "node:http";
import pc from "picocolors";
import type { Config } from "../config.js";
import { openState } from "../state.js";

// Minimal webhook receiver stub. Today the reconciler polls every 3 minutes; a webhook would
// turn that into push-based status updates. This handler verifies a shared-secret header, parses
// the payload, and writes an entry to state.json — wiring it up to re-run `reconcile` for the
// affected session is a follow-up (not landed yet, deliberately kept out of scope).
//
// Expected payload shape (subject to Devin API stabilization):
//   { event: "session.status_changed" | "session.pr_opened" | "session.completed",
//     session_id: "devin-…", status: "…", pr_url?: "…", acus_consumed?: number }
//
// Set WEBHOOK_SECRET in .env and configure Devin to POST here (e.g. via ngrok + the Devin UI).

type WebhookEvent = {
  event?: string;
  session_id?: string;
  status?: string;
  pr_url?: string;
  acus_consumed?: number;
};

export async function runWebhook(config: Config, opts: { port: number; secret?: string }): Promise<void> {
  const db = await openState(config.stateFile);
  const secret = opts.secret ?? process.env["WEBHOOK_SECRET"];

  const server = http.createServer(async (req, res) => {
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
    console.log(pc.cyan(`[webhook] ${payload.event ?? "?"} ${payload.session_id ?? "?"} → ${payload.status ?? "?"}`));

    // Persist into state so the next reconcile tick picks it up. This keeps the webhook a thin
    // observer; the source of truth remains the Devin GET endpoint.
    const match = db.data.sessions.find(
      (s) => s.devinSessionId === payload.session_id || s.devinSessionId === `devin-${payload.session_id}`,
    );
    if (match) {
      match.updatedAt = new Date().toISOString();
      if (payload.pr_url) match.prUrl = payload.pr_url;
      if (typeof payload.acus_consumed === "number") match.acusConsumed = payload.acus_consumed;
      await db.write();
    }

    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  console.log(
    pc.green(`webhook listening on :${opts.port}/webhook${secret ? " (secret required)" : " (no secret set)"}`),
  );
}
