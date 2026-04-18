#!/usr/bin/env node
import "dotenv/config.js";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { openState } from "./state.js";
import { runScan } from "./commands/scan.js";
import { runFileIssues } from "./commands/fileIssues.js";
import { runDispatch } from "./commands/dispatch.js";
import { runReconcile } from "./commands/reconcile.js";
import { runReport } from "./commands/report.js";
import { runAll } from "./commands/run.js";
import { runDoctor } from "./commands/doctor.js";
import { runRegisterPlaybooks } from "./commands/playbooks.js";
import { runWebhook } from "./commands/webhook.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("remediator")
    .description("Event-driven remediation orchestrator that turns GitHub issues into Devin sessions")
    .version("0.2.0");

  program.command("scan").description("Run scanners and refresh findings").action(async () => {
    const config = loadConfig();
    const db = await openState(config.stateFile);
    await runScan(config, db);
  });

  program.command("file-issues").description("File GitHub issues for new findings").action(async () => {
    const config = loadConfig();
    const db = await openState(config.stateFile);
    await runFileIssues(config, db);
  });

  program.command("dispatch").description("Create Devin sessions for labeled issues").action(async () => {
    const config = loadConfig();
    const db = await openState(config.stateFile);
    await runDispatch(config, db);
  });

  program.command("reconcile").description("Poll Devin sessions + update state").action(async () => {
    const config = loadConfig();
    const db = await openState(config.stateFile);
    await runReconcile(config, db);
  });

  program
    .command("report")
    .description("Regenerate STATUS.md")
    .option("-o, --out <path>", "Output path", "STATUS.md")
    .action(async (opts: { out: string }) => {
      const config = loadConfig();
      const db = await openState(config.stateFile);
      await runReport(config, db, opts.out);
    });

  program
    .command("doctor")
    .description("Run preflight checks (GitHub, labels, Devin impersonation) and cache results")
    .option("-f, --force", "Re-probe even if a cached result exists", false)
    .action(async (opts: { force?: boolean }) => {
      const config = loadConfig();
      const db = await openState(config.stateFile);
      await runDoctor(config, db, { force: opts.force === true });
    });

  program
    .command("playbooks:register")
    .description("Register src/playbooks/*.md as org-level Devin playbooks and cache playbook_ids")
    .action(async () => {
      const config = loadConfig();
      const db = await openState(config.stateFile);
      await runRegisterPlaybooks(config, db);
    });

  program
    .command("webhook")
    .description("Start a minimal Devin webhook receiver (stub — writes to state.json)")
    .option("-p, --port <n>", "Port to listen on", "8787")
    .option("-s, --secret <secret>", "Shared secret (overrides WEBHOOK_SECRET env)")
    .action(async (opts: { port: string; secret?: string }) => {
      const config = loadConfig();
      await runWebhook(config, {
        port: Number(opts.port),
        ...(opts.secret ? { secret: opts.secret } : {}),
      });
    });

  program.command("run").description("scan → file-issues → dispatch → reconcile → report").action(async () => {
    const config = loadConfig();
    const db = await openState(config.stateFile);
    await runAll(config, db);
  });

  await program.parseAsync();
}

main().catch((err: unknown) => {
  console.error(pc.red((err as Error).message));
  process.exitCode = 1;
});
