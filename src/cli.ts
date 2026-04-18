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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("remediator")
    .description("Event-driven remediation orchestrator that turns GitHub issues into Devin sessions")
    .version("0.1.0");

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
