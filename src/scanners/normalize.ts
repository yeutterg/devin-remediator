import { createHash } from "node:crypto";
import { z } from "zod";

export const FindingClass = z.enum([
  "vuln:dep",
  "vuln:ci",
  "vuln:static",
  "fe:theme",
  "fe:a11y",
  "fe:perf",
  "ts:migrate",
  "tests",
]);
export type FindingClass = z.infer<typeof FindingClass>;

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const Finding = z.object({
  fingerprint: z.string(),
  class: FindingClass,
  title: z.string(),
  severity: Severity,
  file: z.string().optional(),
  advisory: z.string().optional(),
  source: z.enum(["pip-audit", "npm-audit", "actionlint", "bandit", "seed"]),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Finding = z.infer<typeof Finding>;

export function fingerprint(parts: Array<string | undefined>): string {
  return createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}
