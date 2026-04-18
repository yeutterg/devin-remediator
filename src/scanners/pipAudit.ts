import { execa } from "execa";
import { z } from "zod";
import { Finding, fingerprint } from "./normalize.js";

const PipAuditVuln = z.object({
  id: z.string(),
  fix_versions: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  description: z.string().default(""),
});

const PipAuditDep = z.object({
  name: z.string(),
  version: z.string(),
  vulns: z.array(PipAuditVuln).default([]),
});

const PipAuditReport = z.object({
  dependencies: z.array(PipAuditDep),
});

export async function runPipAudit(cwd: string): Promise<Finding[]> {
  const { stdout, exitCode } = await execa("pip-audit", ["-f", "json"], {
    cwd,
    reject: false,
  });
  if (exitCode !== 0 && !stdout.trim().startsWith("{")) return [];
  const parsed = PipAuditReport.safeParse(JSON.parse(stdout));
  if (!parsed.success) return [];
  const findings: Finding[] = [];
  for (const dep of parsed.data.dependencies) {
    for (const v of dep.vulns) {
      findings.push({
        fingerprint: fingerprint(["pip-audit", dep.name, dep.version, v.id]),
        class: "vuln:dep",
        title: `Bump ${dep.name}@${dep.version} past ${v.id}`,
        severity: "high",
        advisory: v.id,
        source: "pip-audit",
        body: `pip-audit found ${v.id} in ${dep.name}@${dep.version}.\n\nFix versions: ${
          v.fix_versions.join(", ") || "(none listed)"
        }\n\n${v.description}`,
        meta: { package: dep.name, version: dep.version, fix_versions: v.fix_versions },
      });
    }
  }
  return findings;
}
