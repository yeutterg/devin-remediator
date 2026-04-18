import { execa } from "execa";
import { z } from "zod";
import { Finding, fingerprint, Severity } from "./normalize.js";

const BanditResult = z.object({
  test_id: z.string(),
  test_name: z.string(),
  issue_severity: z.string(),
  issue_text: z.string(),
  filename: z.string(),
  line_number: z.number(),
});

const BanditReport = z.object({ results: z.array(BanditResult).default([]) });

function coerce(s: string): z.infer<typeof Severity> {
  const n = s.toUpperCase();
  if (n === "HIGH") return "high";
  if (n === "MEDIUM") return "medium";
  if (n === "LOW") return "low";
  return "medium";
}

export async function runBandit(cwd: string): Promise<Finding[]> {
  const { stdout, exitCode } = await execa(
    "bandit",
    ["-r", "-f", "json", "-q", "--exit-zero", "."],
    { cwd, reject: false },
  );
  if (exitCode !== 0 && !stdout.trim().startsWith("{")) return [];
  const parsed = BanditReport.safeParse(JSON.parse(stdout || "{}"));
  if (!parsed.success) return [];
  return parsed.data.results.map((r) => ({
    fingerprint: fingerprint(["bandit", r.test_id, r.filename, String(r.line_number)]),
    class: "vuln:static" as const,
    title: `Bandit ${r.test_id}: ${r.test_name} in ${r.filename}:${r.line_number}`,
    severity: coerce(r.issue_severity),
    file: r.filename,
    advisory: r.test_id,
    source: "bandit" as const,
    body: `Bandit ${r.test_id} (${r.test_name}) @ ${r.filename}:${r.line_number}\nSeverity: ${r.issue_severity}\n\n${r.issue_text}`,
    meta: { test_id: r.test_id, line: r.line_number },
  }));
}
