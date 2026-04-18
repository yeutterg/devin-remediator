import pc from "picocolors";
import type { Config } from "../config.js";
import type { StateDb } from "../state.js";
import { runScan } from "./scan.js";
import { runFileIssues } from "./fileIssues.js";
import { runDispatch } from "./dispatch.js";
import { runReconcile } from "./reconcile.js";
import { runReport } from "./report.js";

export async function runAll(config: Config, db: StateDb): Promise<void> {
  const started = new Date().toISOString();
  const before = {
    issues: db.data.issues.length,
    sessions: db.data.sessions.length,
    completed: db.data.sessions.filter((s) => s.status === "completed").length,
    prs: db.data.sessions.filter((s) => !!s.prUrl).length,
  };

  console.log(pc.bold("▸ scan"));
  const findings = await runScan(config, db);

  console.log(pc.bold("▸ file-issues"));
  await runFileIssues(config, db);

  console.log(pc.bold("▸ dispatch"));
  await runDispatch(config, db);

  console.log(pc.bold("▸ reconcile"));
  await runReconcile(config, db);

  console.log(pc.bold("▸ report"));
  await runReport(config, db);

  db.data.runs.push({
    startedAt: started,
    finishedAt: new Date().toISOString(),
    findings: findings.length,
    newIssues: db.data.issues.length - before.issues,
    sessionsCreated: db.data.sessions.length - before.sessions,
    sessionsCompleted:
      db.data.sessions.filter((s) => s.status === "completed").length - before.completed,
    prsOpened: db.data.sessions.filter((s) => !!s.prUrl).length - before.prs,
  });
  await db.write();
}
