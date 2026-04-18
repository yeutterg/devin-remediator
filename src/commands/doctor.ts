import pc from "picocolors";
import type { Config } from "../config.js";
import { DevinClient } from "../devin.js";
import { makeOctokit, parseRepo } from "../github.js";
import type { PreflightCache, StateDb } from "../state.js";

// `doctor` runs every environmental precondition once and caches the result in state.json so
// dispatch and reconcile don't pay the cost of re-probing (403 retries, label checks, PATCHes)
// on every tick. Rerun it whenever service-user perms or fork settings change.
export async function runDoctor(config: Config, db: StateDb, opts: { force?: boolean } = {}): Promise<void> {
  const octokit = makeOctokit(config.githubToken);
  const repo = parseRepo(config.targetRepo);
  const cache: PreflightCache = db.data.preflight ?? { checkedAt: new Date().toISOString() };
  const force = opts.force === true;

  console.log(pc.bold("doctor — pre-flight checks"));

  // 1. GitHub: token works + has repo access
  try {
    const me = await octokit.users.getAuthenticated();
    console.log(pc.green(`  ✓ GitHub auth ok as ${me.data.login}`));
  } catch (err) {
    console.log(pc.red(`  ✗ GitHub auth failed: ${(err as Error).message}`));
    throw err;
  }

  // 2. Target fork: issues enabled? (need this to dispatch) — patch if not
  try {
    const { data } = await octokit.repos.get({ ...repo });
    if (!data.has_issues) {
      console.log(pc.yellow(`  ! target repo has issues disabled; enabling…`));
      await octokit.repos.update({ ...repo, has_issues: true });
    }
    cache.targetIssuesEnabled = true;
    console.log(pc.green(`  ✓ ${config.targetRepo}: issues enabled`));
  } catch (err) {
    console.log(pc.red(`  ✗ target fork check failed: ${(err as Error).message}`));
    throw err;
  }

  // 3. Auto-remediate label + class labels exist on target
  const classLabels = [
    "vuln:dep",
    "vuln:ci",
    "vuln:static",
    "fe:theme",
    "fe:a11y",
    "fe:perf",
    "ts:migrate",
    "tests",
    config.autoRemediateLabel,
  ];
  const present: string[] = [];
  for (const name of classLabels) {
    try {
      await octokit.issues.getLabel({ ...repo, name });
      present.push(name);
    } catch {
      try {
        await octokit.issues.createLabel({ ...repo, name, color: "ededed" });
        present.push(name);
        console.log(pc.gray(`    + created label ${name}`));
      } catch (err) {
        console.log(pc.yellow(`    ! could not create label ${name}: ${(err as Error).message}`));
      }
    }
  }
  cache.labelsPresent = present;
  console.log(pc.green(`  ✓ labels: ${present.length}/${classLabels.length} present`));

  // 4. Devin API reachable + service-user permission probe
  if (!config.devinApiKey || !config.devinOrgId) {
    console.log(pc.yellow(`  ! DEVIN_API_KEY / DEVIN_ORG_ID not set — skipping Devin probes`));
  } else {
    const devin = new DevinClient(config.devinApiKey, config.devinOrgId, config.devinApiBase);
    try {
      const self = await devin.getSelf();
      cache.serviceUserEmail = self.email ?? self.user_id;
      console.log(pc.green(`  ✓ Devin /self ok (${cache.serviceUserEmail ?? "service user"})`));
    } catch (err) {
      console.log(pc.yellow(`  ! Devin /self probe failed: ${(err as Error).message}`));
    }

    if (config.devinUserId && (force || cache.impersonationAllowed === undefined)) {
      // A cheap probe: create a minimal session with create_as_user_id, then archive. If it 403s
      // we know to skip the field everywhere; if it 200s we archive and move on.
      try {
        const probe = await devin.createSession({
          prompt: "doctor preflight probe — archive immediately",
          title: "doctor: impersonation probe",
          createAsUserId: config.devinUserId,
          tags: ["doctor", "probe"],
          maxAcuLimit: 1,
        });
        await devin.archiveSession(probe.sessionId);
        cache.impersonationAllowed = true;
        console.log(pc.green(`  ✓ impersonation (create_as_user_id) works`));
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("403")) {
          cache.impersonationAllowed = false;
          console.log(pc.yellow(`  ! impersonation denied (403); will dispatch as service user`));
        } else {
          console.log(pc.yellow(`  ! impersonation probe inconclusive: ${msg}`));
        }
      }
    } else if (config.devinUserId) {
      console.log(
        pc.gray(`  · impersonation cached: ${cache.impersonationAllowed ? "allowed" : "denied"} (use --force to re-probe)`),
      );
    }
  }

  cache.checkedAt = new Date().toISOString();
  db.data.preflight = cache;
  await db.write();
  console.log(pc.green(`doctor: cached preflight results in state.json`));
}
