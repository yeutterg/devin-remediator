import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient } from "../devin.js";
import type { FindingClass } from "../scanners/normalize.js";
import type { PlaybookRef, StateDb } from "../state.js";

// One playbook per finding class. Changing a markdown file and rerunning `playbooks:register`
// PUTs the new body to Devin and updates the cached playbook_id; dispatch.ts then attaches it by
// reference instead of inlining ~2KB of markdown into every session prompt.
const CLASS_TO_FILE: Record<FindingClass, { file: string; title: string; macro: string }> = {
  "vuln:dep": { file: "security", title: "Remediator: vuln:dep", macro: "!remediator-vuln-dep" },
  "vuln:ci": { file: "ci", title: "Remediator: vuln:ci", macro: "!remediator-vuln-ci" },
  "vuln:static": { file: "security", title: "Remediator: vuln:static", macro: "!remediator-vuln-static" },
  "fe:theme": { file: "theme", title: "Remediator: fe:theme", macro: "!remediator-fe-theme" },
  "fe:a11y": { file: "a11y", title: "Remediator: fe:a11y", macro: "!remediator-fe-a11y" },
  "fe:perf": { file: "perf", title: "Remediator: fe:perf", macro: "!remediator-fe-perf" },
  "ts:migrate": { file: "ts-migrate", title: "Remediator: ts:migrate", macro: "!remediator-ts-migrate" },
  tests: { file: "tests", title: "Remediator: tests", macro: "!remediator-tests" },
};

export async function runRegisterPlaybooks(config: Config, db: StateDb): Promise<void> {
  if (!config.devinApiKey || !config.devinOrgId) {
    console.warn(pc.yellow("playbooks: DEVIN_API_KEY / DEVIN_ORG_ID not set — skipping"));
    return;
  }
  const devin = new DevinClient(config.devinApiKey, config.devinOrgId, config.devinApiBase);

  let existing = [] as Awaited<ReturnType<typeof devin.listPlaybooks>>;
  try {
    existing = await devin.listPlaybooks();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("403") || msg.includes("404")) {
      console.log(
        pc.yellow(
          `playbooks: org playbook API not available (${msg}) — dispatch will keep inlining markdown`,
        ),
      );
      return;
    }
    throw err;
  }

  const out: PlaybookRef[] = [];
  for (const [cls, meta] of Object.entries(CLASS_TO_FILE) as [FindingClass, typeof CLASS_TO_FILE[FindingClass]][]) {
    const bodyPath = path.resolve("src/playbooks", `${meta.file}.md`);
    let body: string;
    try {
      body = await fs.readFile(bodyPath, "utf-8");
    } catch {
      console.log(pc.gray(`  · skip ${cls} (no ${meta.file}.md)`));
      continue;
    }

    const match = existing.find((p) => p.title === meta.title || p.macro === meta.macro);
    let playbookId: string;
    if (match) {
      if (match.body === body && match.macro === meta.macro) {
        playbookId = match.playbook_id;
        console.log(pc.gray(`  · ${cls}: unchanged (${playbookId})`));
      } else {
        const updated = await devin.updatePlaybook(match.playbook_id, {
          title: meta.title,
          body,
          macro: meta.macro,
        });
        playbookId = updated.playbook_id;
        console.log(pc.green(`  ✓ ${cls}: updated (${playbookId})`));
      }
    } else {
      const created = await devin.createPlaybook({ title: meta.title, body, macro: meta.macro });
      playbookId = created.playbook_id;
      console.log(pc.green(`  ✓ ${cls}: created (${playbookId})`));
    }
    out.push({ className: cls, playbookId, title: meta.title, updatedAt: new Date().toISOString() });
  }

  db.data.playbooks = out;
  await db.write();
  console.log(pc.green(`playbooks: registered ${out.length} — cached in state.json`));
}
