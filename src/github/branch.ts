// The push job's git work for an Implement run: rebuilds the agent branch from
// the bundle the agent job passed out, in an empty repository, reads the paths
// it changes for the trust-root guard, and pushes it as the Fabrik App. It
// never checks out a working tree or runs anything from the Product repo: a
// fresh `git init` has no hooks, and a bundle carries only objects and refs.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuiltBranch } from "../agent/result.ts";
import { parseNameStatus } from "../guard/changes.ts";
import type { ChangedPath } from "../guard/trust-root.ts";
import type { BranchChanges } from "../loop/types.ts";
import type { Repo } from "./client.ts";

const run = promisify(execFile);

export interface AgentBranchGit {
  readonly changes: BranchChanges;
  /** Pushes the rebuilt branch to the Product repo, replacing the agent branch of that name. */
  push(branch: string): Promise<void>;
}

interface Remote {
  readonly serverUrl: string;
  readonly repo: Repo;
  readonly token: string;
}

/** Runs git in the empty repository the branch is rebuilt in. */
type Git = (...args: string[]) => Promise<string>;

/** Where the remote's default branch (the PR's base, main) is fetched to. */
const MAIN_REF = "refs/fabrik/main";

/**
 * Rebuilds `branch` from `bundlePath` and reads what it changes. A branch with
 * no commits has no bundle and changes nothing.
 */
export async function rebuildAgentBranch(
  branch: BuiltBranch,
  bundlePath: string,
  remote: Remote,
): Promise<AgentBranchGit> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-branch-"));
  const url = `${remote.serverUrl}/${remote.repo.owner}/${remote.repo.name}.git`;
  // The token goes in an env-only config entry, so it never lands on disk or in argv.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${remote.serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${remote.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
  };
  const git: Git = async (...args) => (await run("git", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 })).stdout;

  await git("init", "--quiet", "--template=");
  if (branch.head === null) {
    return {
      changes: { net: [], commits: [], updatedFromMain: false },
      push: () => Promise.reject(new Error(`${branch.name} has no commits to push`)),
    };
  }
  return branch.base.ref === branch.name
    ? onItsOwnBranch(git, url, branch, bundlePath)
    : cutFromMain(git, url, branch, bundlePath);
}

/** Reads the bundle's branch in, checking it ends where the agent job said. */
async function fetchBundle(git: Git, branch: BuiltBranch, bundlePath: string): Promise<string> {
  const ref = `refs/heads/${branch.name}`;
  await git("bundle", "verify", "--quiet", bundlePath);
  await git("fetch", "--quiet", bundlePath, `${ref}:${ref}`);
  const tip = (await git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
  if (tip !== branch.head) throw new Error(`The bundle's ${branch.name} is at ${tip}, not ${branch.head}`);
  return tip;
}

function diff(git: Git, from: string, to: string): Promise<ChangedPath[]> {
  return git("diff", "--name-status", "-z", "-M", "--no-ext-diff", from, to).then(parseNameStatus);
}

/**
 * What each commit in `range` changes on its own. A merge shows only what was
 * changed by hand on top of the merge git would make (remerge), so merging
 * main in doesn't count main's own changes.
 */
function commitsIn(git: Git, range: string): Promise<ChangedPath[]> {
  return git("log", "--format=", "--name-status", "-z", "-M", "--diff-merges=remerge", "--no-ext-diff", range).then(
    parseNameStatus,
  );
}

function isAncestor(git: Git, ancestor: string, of: string): Promise<boolean> {
  return git("merge-base", "--is-ancestor", ancestor, of).then(
    () => true,
    () => false,
  );
}

/** A first run, cut from main: everything it changes is its own. Its push replaces whatever an earlier run left on the agent branch. */
async function cutFromMain(git: Git, url: string, branch: BuiltBranch, bundlePath: string): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  await git("fetch", "--quiet", "--depth=1", url, branch.base.sha);
  const tip = await fetchBundle(git, branch, bundlePath);
  if (!(await isAncestor(git, branch.base.sha, tip))) {
    throw new Error(`${branch.name} doesn't start from ${branch.base.ref} at ${branch.base.sha}`);
  }
  return {
    changes: {
      net: await diff(git, branch.base.sha, tip),
      commits: await commitsIn(git, `${branch.base.sha}..${tip}`),
      updatedFromMain: false,
    },
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", "--force", url, `${ref}:${ref}`);
    },
  };
}

/**
 * A retry or Request-changes run, built on its agent PR's head. To fix a
 * conflict it may have merged main in or rebased onto it, so only its own
 * changes are judged: its commits main doesn't hold, and the paths it changed
 * that don't now read as main has them. Its push may replace the PR's branch
 * (a rebase doesn't fast-forward), but only while that branch is still at the
 * head the run built on, and it never touches any other branch.
 */
async function onItsOwnBranch(git: Git, url: string, branch: BuiltBranch, bundlePath: string): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  await git("fetch", "--quiet", url, branch.base.sha);
  await git("fetch", "--quiet", url, `+HEAD:${MAIN_REF}`);
  const tip = await fetchBundle(git, branch, bundlePath);
  const main = (await git("rev-parse", "--verify", `${MAIN_REF}^{commit}`)).trim();

  const unlikeMain = new Set((await git("diff", "--name-only", "-z", "--no-ext-diff", main, tip)).split("\0").filter(Boolean));
  // A path the branch now holds just as main does came from main, not from this run.
  const net = (await diff(git, branch.base.sha, tip)).filter(
    (change) => unlikeMain.has(change.path) || (change.from !== undefined && unlikeMain.has(change.from)),
  );
  return {
    changes: {
      net,
      commits: await commitsIn(git, `${main}..${tip}`),
      updatedFromMain: !(await isAncestor(git, main, branch.base.sha)) && (await isAncestor(git, main, tip)),
    },
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", `--force-with-lease=${ref}:${branch.base.sha}`, url, `${ref}:${ref}`);
    },
  };
}
