// Pushes a Product repo's weekly skills bumps (ADR-0008): for each Skills
// source it pins, asks planSourceBump whether a picked skill changed upstream,
// and if so opens or refreshes that source's PR. Everything goes through the
// GitHub API as the Fabrik App: it reads .fabrik/ from the default branch and
// writes each bump as one commit on that branch's head, so it never checks out
// or runs the Product repo's code.
//
// The rules are those of Fabrik's own bump (.github/workflows/skills-bump.yml):
// the branch moves only when its lockfile differs from the planned one, so an
// unchanged week leaves an open PR and its review alone, a PR left behind by
// another merged bump is rebuilt on the default branch, and a bump closed
// unmerged at the same commit opens nothing until upstream moves again.
import type { GitHub, Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import {
  type KitConfig,
  picksIn,
  resolveKitConfig,
  SKILLS_SOURCES_LOCK_PATH,
  type SkillsSource,
} from "../kit/config.ts";
import { planSourceBump, type UpstreamSkills } from "./bump.ts";

/** What happened to one source's bump this week. */
export type SourceBumpOutcome =
  | { readonly repository: string; readonly outcome: "up-to-date" }
  /** The bump to this commit was closed unmerged; nothing happens until upstream moves. */
  | { readonly repository: string; readonly outcome: "closed-unmerged" }
  | { readonly repository: string; readonly outcome: "opened" | "refreshed" | "unchanged"; readonly pullRequest: number }
  | { readonly repository: string; readonly outcome: "failed"; readonly error: string };

export type SourceBumpsResult =
  | { readonly ok: true; readonly sources: readonly SourceBumpOutcome[] }
  /** The Kit config on the default branch is invalid, so no source was looked at. */
  | { readonly ok: false; readonly errors: readonly string[] };

/** Reads what a source's default branch looks like now against its pin, through the public API. */
export type ReadUpstream = (source: SkillsSource) => Promise<UpstreamSkills>;

/**
 * Plans and pushes each pinned source's bump on its own, so one failing is
 * reported and the rest carry on. A repo with no Skills sources lockfile makes
 * no upstream calls.
 */
export async function pushSourceBumps(
  github: Pick<GitHub, "rest" | "fileText">,
  repo: Repo,
  readUpstream: ReadUpstream,
): Promise<SourceBumpsResult> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const { default_branch: defaultBranch } = (await github.rest("GET", base)) as { default_branch: string };
  const sources = await readKitConfigSources(github, repo, await headOf(github, base, defaultBranch));
  if (sources.skillsLock === null || sources.skillsLock === undefined) return { ok: true, sources: [] };
  const resolved = resolveKitConfig(sources);
  if (!resolved.ok) return resolved;

  const outcomes: SourceBumpOutcome[] = [];
  for (const source of resolved.config.skillsSources) {
    try {
      outcomes.push(await bumpOne(github, base, repo, defaultBranch, resolved.config, source, readUpstream));
    } catch (error) {
      outcomes.push({ repository: source.repository, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, sources: outcomes };
}

async function bumpOne(
  github: Pick<GitHub, "rest" | "fileText">,
  base: string,
  repo: Repo,
  defaultBranch: string,
  config: KitConfig,
  source: SkillsSource,
  readUpstream: ReadUpstream,
): Promise<SourceBumpOutcome> {
  const { repository } = source;
  const picked = picksIn(config).filter((pick) => pick.source === repository).map((pick) => pick.name);
  const upstream = await readUpstream(source);
  // Read the default branch afresh for each source, so an earlier one's failure or timing can't leave this one stale.
  const head = await headOf(github, base, defaultBranch);
  const lockText = await github.fileText(repo, SKILLS_SOURCES_LOCK_PATH, head);
  if (lockText === null) throw new Error(`${SKILLS_SOURCES_LOCK_PATH} is gone from ${defaultBranch}`);
  const plan = planSourceBump(source, picked, upstream, lockText);
  if (plan.kind === "up-to-date") return { repository, outcome: "up-to-date" };

  const open = (await github.rest(
    "GET",
    `${base}/pulls?head=${encodeURIComponent(`${repo.owner}:${plan.branch}`)}&base=${encodeURIComponent(defaultBranch)}&state=open`,
  )) as { number: number; title: string; body: string | null }[];
  const pullRequest = open[0];
  const onBranch = await github.fileText(repo, SKILLS_SOURCES_LOCK_PATH, plan.branch);

  if (onBranch === plan.lockText) {
    // The Operator closed the PR for this commit: wait for upstream to move again.
    if (pullRequest === undefined) return { repository, outcome: "closed-unmerged" };
    if (pullRequest.title !== plan.title || pullRequest.body !== plan.body) {
      await github.rest("PATCH", `${base}/pulls/${pullRequest.number}`, { title: plan.title, body: plan.body });
    }
    return { repository, outcome: "unchanged", pullRequest: pullRequest.number };
  }

  const { tree } = (await github.rest("GET", `${base}/git/commits/${head}`)) as { tree: { sha: string } };
  const newTree = (await github.rest("POST", `${base}/git/trees`, {
    base_tree: tree.sha,
    tree: [{ path: SKILLS_SOURCES_LOCK_PATH, mode: "100644", type: "blob", content: plan.lockText }],
  })) as { sha: string };
  const commit = (await github.rest("POST", `${base}/git/commits`, {
    message: plan.title,
    tree: newTree.sha,
    parents: [head],
  })) as { sha: string };
  const branchRef = `${base}/git/ref/heads/${plan.branch}`;
  if ((await github.rest("GET", branchRef, undefined, { allowNotFound: true })) === null) {
    await github.rest("POST", `${base}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit.sha });
  } else {
    await github.rest("PATCH", `${base}/git/refs/heads/${plan.branch}`, { sha: commit.sha, force: true });
  }

  if (pullRequest !== undefined) {
    await github.rest("PATCH", `${base}/pulls/${pullRequest.number}`, { title: plan.title, body: plan.body });
    return { repository, outcome: "refreshed", pullRequest: pullRequest.number };
  }
  const created = (await github.rest("POST", `${base}/pulls`, {
    title: plan.title,
    head: plan.branch,
    base: defaultBranch,
    body: plan.body,
  })) as { number: number };
  return { repository, outcome: "opened", pullRequest: created.number };
}

async function headOf(github: Pick<GitHub, "rest">, base: string, branch: string): Promise<string> {
  const ref = (await github.rest("GET", `${base}/git/ref/heads/${branch}`)) as { object: { sha: string } };
  return ref.object.sha;
}
