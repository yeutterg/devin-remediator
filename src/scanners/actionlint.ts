import { execa } from "execa";
import { z } from "zod";
import { Finding, fingerprint } from "./normalize.js";

const ActionlintItem = z.object({
  message: z.string(),
  filepath: z.string(),
  line: z.number(),
  column: z.number(),
  kind: z.string().optional(),
});

export async function runActionlint(cwd: string): Promise<Finding[]> {
  const { stdout, exitCode } = await execa("actionlint", ["-format", "{{json .}}"], {
    cwd,
    reject: false,
  });
  if (exitCode !== 0 && !stdout.trim().startsWith("[")) return [];
  let items: z.infer<typeof ActionlintItem>[] = [];
  try {
    items = z.array(ActionlintItem).parse(JSON.parse(stdout || "[]"));
  } catch {
    return [];
  }
  return items.map((it) => ({
    fingerprint: fingerprint(["actionlint", it.filepath, String(it.line), it.message]),
    class: "vuln:ci" as const,
    title: `actionlint: ${it.message.slice(0, 80)}`,
    severity: "medium" as const,
    file: it.filepath,
    source: "actionlint" as const,
    body: `actionlint flagged ${it.filepath}:${it.line}:${it.column}\n\n${it.message}`,
    meta: { line: it.line, column: it.column, kind: it.kind ?? "unknown" },
  }));
}
