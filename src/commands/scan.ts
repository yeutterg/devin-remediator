import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import pc from "picocolors";
import { z } from "zod";
import { Finding, fingerprint, FindingClass, Severity } from "../scanners/normalize.js";
import { runPipAudit } from "../scanners/pipAudit.js";
import { runNpmAudit } from "../scanners/npmAudit.js";
import { runActionlint } from "../scanners/actionlint.js";
import { runBandit } from "../scanners/bandit.js";
import type { Config } from "../config.js";
import type { StateDb } from "../state.js";

const SeedIssue = z.object({
  class: FindingClass,
  title: z.string(),
  severity: Severity,
  body: z.string(),
});

const SeedFile = z.object({ issues: z.array(SeedIssue) });

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function runScan(config: Config, db: StateDb): Promise<Finding[]> {
  const allFindings: Finding[] = [];

  const seedPath = path.resolve("src/seeds/issues.yaml");
  try {
    const raw = await fs.readFile(seedPath, "utf-8");
    const seed = SeedFile.parse(yaml.load(raw));
    for (const entry of seed.issues) {
      allFindings.push({
        fingerprint: fingerprint(["seed", entry.class, entry.title]),
        class: entry.class,
        title: entry.title,
        severity: entry.severity,
        source: "seed",
        body: entry.body,
        meta: {},
      });
    }
    console.log(pc.gray(`  seed: ${seed.issues.length} issues`));
  } catch (err) {
    console.warn(pc.yellow(`  seed: skipped (${(err as Error).message})`));
  }

  if (await dirExists(config.targetCheckout)) {
    const [pip, npmA, act, ban] = await Promise.allSettled([
      runPipAudit(config.targetCheckout),
      runNpmAudit(path.join(config.targetCheckout, "superset-frontend")),
      runActionlint(config.targetCheckout),
      runBandit(config.targetCheckout),
    ]);
    const reports: Array<[string, PromiseSettledResult<Finding[]>]> = [
      ["pip-audit", pip],
      ["npm-audit", npmA],
      ["actionlint", act],
      ["bandit", ban],
    ];
    for (const [name, res] of reports) {
      if (res.status === "fulfilled") {
        allFindings.push(...res.value);
        console.log(pc.gray(`  ${name}: ${res.value.length} findings`));
      } else {
        console.warn(pc.yellow(`  ${name}: failed (${res.reason?.message ?? res.reason})`));
      }
    }
  } else {
    console.log(pc.yellow(`  target checkout not found at ${config.targetCheckout} — scanners skipped`));
  }

  const seen = new Set<string>();
  const deduped = allFindings.filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });

  db.data.findings = deduped;
  await db.write();

  console.log(pc.green(`scan: ${deduped.length} unique findings`));
  return deduped;
}
