import pc from "picocolors";
import type { Config } from "../config.js";
import { ensureLabel, findIssueByFingerprint, makeOctokit, parseRepo } from "../github.js";
import type { FindingClass } from "../scanners/normalize.js";
import type { IssueRecord, StateDb } from "../state.js";

const CLASS_COLORS: Record<FindingClass, string> = {
  "vuln:dep": "b60205",
  "vuln:ci": "d93f0b",
  "vuln:static": "e99695",
  "fe:theme": "1d76db",
  "fe:a11y": "5319e7",
  "fe:perf": "0e8a16",
  "ts:migrate": "fbca04",
  tests: "0052cc",
};

export async function runFileIssues(config: Config, db: StateDb): Promise<void> {
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);

  await ensureLabel(octokit, repo, config.autoRemediateLabel, "6f42c1", "Auto-remediated by Devin");
  for (const [cls, color] of Object.entries(CLASS_COLORS) as [FindingClass, string][]) {
    await ensureLabel(octokit, repo, cls, color, `Remediation class: ${cls}`);
  }

  const existing = new Set(db.data.issues.map((i) => i.fingerprint));
  let created = 0;

  for (const finding of db.data.findings) {
    if (existing.has(finding.fingerprint)) continue;

    const cached = await findIssueByFingerprint(octokit, repo, finding.fingerprint);
    if (cached.found && cached.number && cached.url) {
      db.data.issues.push({
        fingerprint: finding.fingerprint,
        class: finding.class,
        issueNumber: cached.number,
        repo: config.targetRepo,
        url: cached.url,
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    const body = [
      finding.body.trim(),
      "",
      "---",
      `**source:** \`${finding.source}\``,
      `**severity:** \`${finding.severity}\``,
      finding.file ? `**file:** \`${finding.file}\`` : undefined,
      finding.advisory ? `**advisory:** ${finding.advisory}` : undefined,
      `<!-- devin-remediator fingerprint:${finding.fingerprint} -->`,
    ]
      .filter(Boolean)
      .join("\n");

    const { data } = await octokit.issues.create({
      ...repo,
      title: finding.title,
      body,
      labels: [config.autoRemediateLabel, finding.class],
    });

    const rec: IssueRecord = {
      fingerprint: finding.fingerprint,
      class: finding.class,
      issueNumber: data.number,
      repo: config.targetRepo,
      url: data.html_url,
      createdAt: new Date().toISOString(),
    };
    db.data.issues.push(rec);
    created += 1;
    console.log(pc.cyan(`  #${data.number} ${finding.title}`));
    await db.write();
  }

  console.log(pc.green(`file-issues: ${created} new, ${db.data.issues.length} total`));
}
