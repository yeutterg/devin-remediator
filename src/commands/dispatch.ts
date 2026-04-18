import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient } from "../devin.js";
import { makeOctokit, parseRepo } from "../github.js";
import type { FindingClass } from "../scanners/normalize.js";
import type { IssueRecord, SessionRecord, StateDb } from "../state.js";

const PLAYBOOK_BY_CLASS: Record<FindingClass, string> = {
  "vuln:dep": "security",
  "vuln:ci": "ci",
  "vuln:static": "security",
  "fe:theme": "theme",
  "fe:a11y": "a11y",
  "fe:perf": "perf",
  "ts:migrate": "ts-migrate",
  tests: "tests",
};

// Round-robin priority — classes near the front of the list are dispatched first in each cycle so
// STATUS.md shows class diversity within the first N PRs instead of 8 consecutive vuln:dep rows.
const CLASS_ROUND_ROBIN: FindingClass[] = [
  "vuln:dep",
  "fe:theme",
  "fe:a11y",
  "tests",
  "vuln:ci",
  "fe:perf",
  "ts:migrate",
  "vuln:static",
];

const STRUCTURED_SCHEMA = {
  type: "object",
  required: ["pr_url", "fix_summary", "confidence"],
  properties: {
    pr_url: { type: "string", description: "URL of the PR Devin opened to fix this issue" },
    fix_summary: { type: "string", description: "2-3 sentence summary of what Devin changed and why" },
    tests_added: { type: "boolean", description: "Whether Devin added or updated tests" },
    scanner_rerun_clean: { type: "boolean", description: "Whether re-running the source scanner is clean post-fix" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string", description: "Anything a human reviewer should know" },
  },
};

async function readPlaybook(name: string): Promise<string> {
  const p = path.resolve("src/playbooks", `${name}.md`);
  return fs.readFile(p, "utf-8");
}

function roundRobinByClass(issues: IssueRecord[]): IssueRecord[] {
  const byClass = new Map<FindingClass, IssueRecord[]>();
  for (const i of issues) {
    const list = byClass.get(i.class) ?? [];
    list.push(i);
    byClass.set(i.class, list);
  }
  const ordered: IssueRecord[] = [];
  const classOrder = [
    ...CLASS_ROUND_ROBIN,
    ...([...byClass.keys()].filter((c) => !CLASS_ROUND_ROBIN.includes(c))),
  ];
  let kept = true;
  while (kept) {
    kept = false;
    for (const c of classOrder) {
      const list = byClass.get(c);
      if (list && list.length > 0) {
        ordered.push(list.shift()!);
        kept = true;
      }
    }
  }
  return ordered;
}

function playbookIdFor(db: StateDb, cls: FindingClass): string | undefined {
  return db.data.playbooks?.find((p) => p.className === cls)?.playbookId;
}

export async function runDispatch(config: Config, db: StateDb): Promise<void> {
  if (!config.devinApiKey || !config.devinOrgId) {
    console.warn(pc.yellow("dispatch: DEVIN_API_KEY / DEVIN_ORG_ID not set — skipping"));
    return;
  }
  const devin = new DevinClient(config.devinApiKey, config.devinOrgId, config.devinApiBase);
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);

  const active = db.data.sessions.filter((s) =>
    ["pending", "running", "blocked"].includes(s.status),
  ).length;
  let budget = Math.max(0, config.maxActiveSessions - active);
  if (budget === 0) {
    console.log(pc.gray(`dispatch: at capacity (${active}/${config.maxActiveSessions})`));
    return;
  }

  const withSession = new Set(db.data.sessions.map((s) => s.fingerprint));
  const raw = db.data.issues.filter((i) => !withSession.has(i.fingerprint));
  const candidates = roundRobinByClass(raw);

  // #2 cached preflight — avoid noisy 403 retries on every single dispatch.
  const impersonationAllowed = db.data.preflight?.impersonationAllowed ?? true;
  const useImpersonation = impersonationAllowed && !!config.devinUserId;

  let created = 0;
  for (const issue of candidates) {
    if (budget <= 0) break;
    const playbookName = PLAYBOOK_BY_CLASS[issue.class];
    const registeredPlaybookId = playbookIdFor(db, issue.class);

    // Fall back to inlining the markdown when we haven't registered the playbooks yet (first run,
    // missing `ManageAccountPlaybooks` permission, or org-level playbook API disabled).
    let playbookBody = "";
    if (!registeredPlaybookId) {
      try {
        playbookBody = await readPlaybook(playbookName);
      } catch {
        playbookBody = "Follow standard remediation: minimal diff, add tests, open PR linked to the issue.";
      }
    }

    const promptHead = [
      `# Remediate issue ${issue.url}`,
      "",
      "You are being invoked by the `devin-remediator` automation. Your job:",
      `1. Read issue #${issue.issueNumber} in ${config.targetRepo}.`,
      "2. Follow the attached playbook.",
      `3. Open a PR against the \`master\` branch of the same repo with \`Fixes #${issue.issueNumber}\` in the description.`,
      "4. Emit the structured output when done.",
    ].join("\n");

    const promptTail = [
      "",
      "---",
      "",
      "## Constraints",
      "- Keep the diff minimal and scoped to this issue.",
      "- Run the appropriate test suite before opening the PR.",
      "- If you run into an unrecoverable blocker, stop and explain it in structured output.",
    ].join("\n");

    const prompt = registeredPlaybookId
      ? `${promptHead}${promptTail}`
      : `${promptHead}\n\n---\n\n${playbookBody}${promptTail}`;

    if (config.dryRun) {
      console.log(pc.gray(`dispatch: [dry-run] would create session for #${issue.issueNumber}`));
      continue;
    }

    const baseArgs = {
      prompt,
      tags: ["vuln-remediation", issue.class, `issue-${issue.issueNumber}`],
      structuredOutputSchema: STRUCTURED_SCHEMA,
      title: `Remediate #${issue.issueNumber}: ${issue.class}`,
      repos: [config.targetRepo],
      maxAcuLimit: config.maxAcuPerSession,
      ...(registeredPlaybookId ? { playbookId: registeredPlaybookId } : {}),
    };

    let sessionId: string;
    let url: string;
    try {
      const res = await devin.createSession({
        ...baseArgs,
        ...(useImpersonation ? { createAsUserId: config.devinUserId } : {}),
      });
      sessionId = res.sessionId;
      url = res.url;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429")) {
        console.log(pc.yellow(`dispatch: hit concurrent session limit; pausing`));
        break;
      }
      if (msg.includes("403") && useImpersonation) {
        // Remember for future dispatches instead of retrying on every issue.
        db.data.preflight = {
          ...(db.data.preflight ?? { checkedAt: new Date().toISOString() }),
          impersonationAllowed: false,
          checkedAt: new Date().toISOString(),
        };
        await db.write();
        console.log(pc.yellow(`dispatch: impersonation denied; cached result, retrying without create_as_user_id`));
        const res = await devin.createSession(baseArgs);
        sessionId = res.sessionId;
        url = res.url;
      } else {
        throw err;
      }
    }

    const rec: SessionRecord = {
      fingerprint: issue.fingerprint,
      issueNumber: issue.issueNumber,
      devinSessionId: sessionId,
      devinSessionUrl: url,
      class: issue.class,
      status: "running",
      iterations: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.data.sessions.push(rec);
    await db.write();

    await octokit.issues.createComment({
      ...repo,
      issue_number: issue.issueNumber,
      body: `Devin session kicked off: ${url}${registeredPlaybookId ? ` (playbook \`${registeredPlaybookId}\`)` : ""}`,
    });

    created += 1;
    budget -= 1;
    console.log(pc.cyan(`  session ${sessionId} → issue #${issue.issueNumber} [${issue.class}]`));
  }

  console.log(pc.green(`dispatch: ${created} new session(s)`));
}
