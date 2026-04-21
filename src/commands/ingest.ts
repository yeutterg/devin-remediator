import pc from "picocolors";
import type { Config } from "../config.js";
import { makeOctokit, parseRepo } from "../github.js";
import type { FindingClass } from "../scanners/normalize.js";
import type { IssueRecord, StateDb } from "../state.js";

const KNOWN_CLASSES: FindingClass[] = [
  "vuln:dep",
  "vuln:ci",
  "vuln:static",
  "fe:theme",
  "fe:a11y",
  "fe:perf",
  "ts:migrate",
  "tests",
];

// Extracts the fingerprint from an issue body written by file-issues (which embeds
// `<!-- devin-remediator fingerprint:<hex> -->`). Falls back to a stable synthetic
// fingerprint keyed on the issue number so issues created outside the remediator
// (humans, Dependabot, Snyk, Linear webhook, etc.) still dedupe across runs.
function fingerprintFor(body: string | null | undefined, issueNumber: number, repo: string): string {
  const m = body?.match(/fingerprint:([a-z0-9]+)/i);
  if (m?.[1]) return m[1];
  return `ingest:${repo}#${issueNumber}`;
}

function classFromLabels(labelNames: string[], fallback?: FindingClass): FindingClass | undefined {
  for (const n of labelNames) {
    if ((KNOWN_CLASSES as string[]).includes(n)) return n as FindingClass;
  }
  return fallback;
}

export interface IngestOptions {
  class?: FindingClass;
  issue?: number;
  labelFilter?: string;
}

export async function runIngest(config: Config, db: StateDb, opts: IngestOptions = {}): Promise<void> {
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);
  const label = opts.labelFilter ?? config.autoRemediateLabel;

  const existing = new Set(db.data.issues.map((i) => i.fingerprint));
  const alreadyByNumber = new Set(db.data.issues.map((i) => i.issueNumber));
  let added = 0;
  let skippedNoClass = 0;
  let alreadyKnown = 0;

  const pages = opts.issue
    ? [{ data: [await octokit.issues.get({ ...repo, issue_number: opts.issue }).then((r) => r.data)] }]
    : octokit.paginate.iterator(octokit.issues.listForRepo, {
        ...repo,
        state: "open",
        labels: label,
        per_page: 100,
      });

  for await (const page of pages as AsyncIterable<{ data: unknown[] }>) {
    for (const raw of page.data) {
      const issue = raw as {
        number: number;
        html_url: string;
        title: string;
        body?: string | null;
        pull_request?: unknown;
        labels?: ({ name?: string } | string)[];
      };
      // The issues listing includes PRs; skip them.
      if (issue.pull_request) continue;
      if (alreadyByNumber.has(issue.number)) {
        alreadyKnown += 1;
        continue;
      }
      const labelNames = (issue.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean);
      const cls = classFromLabels(labelNames, opts.class);
      if (!cls) {
        console.warn(
          pc.yellow(
            `  #${issue.number}: no remediation class label (one of ${KNOWN_CLASSES.join(", ")}); pass --class or add a label`,
          ),
        );
        skippedNoClass += 1;
        continue;
      }
      const fp = fingerprintFor(issue.body, issue.number, config.targetRepo);
      if (existing.has(fp)) {
        alreadyKnown += 1;
        continue;
      }
      const rec: IssueRecord = {
        fingerprint: fp,
        class: cls,
        issueNumber: issue.number,
        repo: config.targetRepo,
        url: issue.html_url,
        createdAt: new Date().toISOString(),
      };
      db.data.issues.push(rec);
      existing.add(fp);
      alreadyByNumber.add(issue.number);
      added += 1;
      console.log(pc.cyan(`  + #${issue.number} [${cls}] ${issue.title}`));
    }
  }

  await db.write();
  console.log(
    pc.green(
      `ingest: ${added} new issue(s) staged, ${alreadyKnown} already known, ${skippedNoClass} skipped (no class label)`,
    ),
  );
}
