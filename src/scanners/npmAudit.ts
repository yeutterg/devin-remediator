import { execa } from "execa";
import { z } from "zod";
import { Finding, fingerprint, Severity } from "./normalize.js";

const NpmAuditAdvisory = z.object({
  source: z.number().optional(),
  name: z.string(),
  title: z.string().optional(),
  severity: z.string(),
  url: z.string().optional(),
  range: z.string().optional(),
});

const NpmAuditReport = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({
      name: z.string(),
      severity: z.string(),
      via: z.array(z.union([z.string(), NpmAuditAdvisory])).default([]),
      fixAvailable: z.union([z.boolean(), z.object({ name: z.string(), version: z.string() })]).optional(),
    }),
  ),
});

function coerceSeverity(s: string): z.infer<typeof Severity> {
  const norm = s.toLowerCase();
  if (["critical", "high", "medium", "low"].includes(norm)) return norm as z.infer<typeof Severity>;
  if (norm === "moderate") return "medium";
  return "medium";
}

export async function runNpmAudit(cwd: string): Promise<Finding[]> {
  const { stdout } = await execa("npm", ["audit", "--json"], { cwd, reject: false });
  const parsed = NpmAuditReport.safeParse(JSON.parse(stdout || "{}"));
  if (!parsed.success) return [];
  const findings: Finding[] = [];
  for (const [pkg, v] of Object.entries(parsed.data.vulnerabilities)) {
    const advisory = v.via.find((x): x is z.infer<typeof NpmAuditAdvisory> => typeof x !== "string");
    const id = advisory?.url ?? advisory?.title ?? `npm-${pkg}`;
    findings.push({
      fingerprint: fingerprint(["npm-audit", pkg, id]),
      class: "vuln:dep",
      title: `Bump ${pkg} past ${advisory?.title ?? "npm audit advisory"}`,
      severity: coerceSeverity(v.severity),
      advisory: id,
      source: "npm-audit",
      body: `npm audit flagged ${pkg} (severity: ${v.severity}).\n\n${advisory?.url ?? ""}\n\nRange: ${
        advisory?.range ?? "?"
      }`,
      meta: { package: pkg, severity: v.severity, fixAvailable: v.fixAvailable },
    });
  }
  return findings;
}
