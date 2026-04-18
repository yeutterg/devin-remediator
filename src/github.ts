import { Octokit } from "@octokit/rest";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(slug: string): RepoRef {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo slug: ${slug}`);
  return { owner, repo };
}

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "devin-remediator/0.1.0" });
}

export async function ensureLabel(
  octokit: Octokit,
  ref: RepoRef,
  name: string,
  color: string,
  description: string,
): Promise<void> {
  try {
    await octokit.issues.getLabel({ ...ref, name });
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    if (status === 404) {
      await octokit.issues.createLabel({ ...ref, name, color, description });
      return;
    }
    throw e;
  }
}

export async function forkRepo(
  octokit: Octokit,
  upstream: RepoRef,
  fork: RepoRef,
): Promise<void> {
  try {
    await octokit.repos.get({ owner: fork.owner, repo: fork.repo });
    return;
  } catch (e: unknown) {
    if ((e as { status?: number })?.status !== 404) throw e;
  }
  await octokit.repos.createFork({
    owner: upstream.owner,
    repo: upstream.repo,
    name: fork.repo,
    default_branch_only: true,
  });
}

export async function ensureRepo(
  octokit: Octokit,
  ref: RepoRef,
  opts: { description?: string; privateRepo?: boolean } = {},
): Promise<void> {
  try {
    await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    return;
  } catch (e: unknown) {
    if ((e as { status?: number })?.status !== 404) throw e;
  }
  const { data: me } = await octokit.users.getAuthenticated();
  if (me.login.toLowerCase() === ref.owner.toLowerCase()) {
    await octokit.repos.createForAuthenticatedUser({
      name: ref.repo,
      description: opts.description,
      private: opts.privateRepo ?? false,
      auto_init: true,
    });
  } else {
    await octokit.repos.createInOrg({
      org: ref.owner,
      name: ref.repo,
      description: opts.description,
      private: opts.privateRepo ?? false,
      auto_init: true,
    });
  }
}

export interface FindIssueByFingerprintResult {
  found: boolean;
  number?: number;
  url?: string;
}

export async function findIssueByFingerprint(
  octokit: Octokit,
  ref: RepoRef,
  fingerprint: string,
): Promise<FindIssueByFingerprintResult> {
  const q = `repo:${ref.owner}/${ref.repo} in:body "fingerprint:${fingerprint}" is:issue`;
  const { data } = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
  const first = data.items[0];
  if (!first) return { found: false };
  return { found: true, number: first.number, url: first.html_url };
}
