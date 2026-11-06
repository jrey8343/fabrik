// The push job's git work for an Implement run, a Researcher run or a Design
// session's prototype turn: rebuilds the agent branch from
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
  /**
   * The commit its push leaves the branch at: the run's own tip, or where its
   * commits were rebased onto a branch that moved; null when there's nothing to push.
   */
  readonly head: string | null;
  /** Pushes the rebuilt branch to the Product repo, replacing the agent branch of that name. */
  push(branch: string): Promise<void>;
}

interface Remote {
  readonly serverUrl: string;
  readonly repo: Repo;
  readonly token: string;
}

/** Runs git in the empty repository the branch is rebuilt in; `with` runs it with more environment, such as a commit's identity. */
type Git = ((...args: string[]) => Promise<string>) & {
  with(more: Readonly<Record<string, string>>): (...args: string[]) => Promise<string>;
};

/** Where the remote's default branch (the PR's base, main) is fetched to. */
const MAIN_REF = "refs/fabrik/main";

/** Where the PR's branch, as it is on the remote now, is fetched to. */
const HEAD_REF = "refs/fabrik/head";

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
  const runIn =
    (more: Readonly<Record<string, string>>) =>
    async (...args: string[]) =>
      (await run("git", args, { cwd: dir, env: { ...env, ...more }, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const git: Git = Object.assign(runIn({}), { with: runIn });

  await git("init", "--quiet", "--template=");
  if (branch.head === null) {
    return {
      changes: { net: [], commits: [], updatedFromMain: false },
      head: null,
      push: () => Promise.reject(new Error(`${branch.name} has no commits to push`)),
    };
  }
  if (isPrototypeBranch(branch.name)) return fastForwardOnly(git, url, branch, bundlePath);
  return branch.base.ref === branch.name
    ? onItsOwnBranch(git, url, branch, bundlePath)
    : cutFromMain(git, url, branch, bundlePath);
}

/**
 * Whether this is an issue's prototype branch (#155, prototypeBranchFor),
 * which the Kit never merges, never opens a PR from, never deletes, and only
 * ever fast-forwards, whoever's run built it.
 */
function isPrototypeBranch(name: string): boolean {
  return name.startsWith("prototype/");
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
 * What each commit in `revisions` changes on its own. A merge shows only what
 * was changed by hand on top of the merge git would make (remerge), so merging
 * main in doesn't count main's own changes.
 */
function commitsIn(git: Git, ...revisions: string[]): Promise<ChangedPath[]> {
  return git("log", "--format=", "--name-status", "-z", "-M", "--diff-merges=remerge", "--no-ext-diff", ...revisions, "--").then(
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
    head: tip,
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", "--force", url, `${ref}:${ref}`);
    },
  };
}

/**
 * A Design session's prototype turn, on the issue's prototype branch: a first
 * round cut it from the default branch, and a later one carried on from the
 * head an earlier round pushed. Everything since the head it started on is
 * its own, every commit judged, since only the push job's guard stands before
 * the branch. Its push only fast-forwards from that head: a later round's
 * only while the branch is still there, and a first round's only while there
 * is no branch yet. It never rebases onto a branch that moved, nor replaces
 * one, as an agent PR's runs may; the next prototype turn builds on what's there.
 * A branch that moved while the turn ran, as a live Design session's push may
 * move it, reads as moved, with nothing to push, so the core can say so
 * (src/loop/prototypeLanding.ts). The lease still refuses a push that loses
 * the race in the moments between reading the branch and pushing it.
 */
async function fastForwardOnly(git: Git, url: string, branch: BuiltBranch, bundlePath: string): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  const { sha: base } = branch.base;
  await git("fetch", "--quiet", "--depth=1", url, base);
  const tip = await fetchBundle(git, branch, bundlePath);
  if (!(await isAncestor(git, base, tip))) throw new Error(`${branch.name} doesn't start from ${branch.base.ref} at ${base}`);
  // The head the turn started on: a later round's base, or no branch at all for a first round's.
  const from = branch.base.ref === branch.name ? base : null;
  const changes = { net: await diff(git, base, tip), commits: await commitsIn(git, `${base}..${tip}`), updatedFromMain: false };
  const now = (await git("ls-remote", url, ref)).split("\t")[0]?.trim() || null;
  if (now !== from) {
    return {
      changes: { ...changes, moved: { from, to: now } },
      head: null,
      push: () => Promise.reject(new Error(`${branch.name} moved while the prototype turn ran, so there's nothing to push`)),
    };
  }
  // An empty lease means the branch mustn't exist yet.
  const lease = from ?? "";
  return {
    changes,
    head: tip,
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", `--force-with-lease=${ref}:${lease}`, url, `${ref}:${ref}`);
    },
  };
}

/**
 * A retry or Request-changes run, built on its agent PR's head. To fix a
 * conflict it may have merged main in or rebased onto it, so only its own
 * changes are judged: its commits main doesn't hold, and the paths it changed
 * that don't now read as main has them. Its push may replace the PR's branch
 * (a rebase doesn't fast-forward), but only while that branch is still at the
 * head it lands on, and it never touches any other branch. If the branch moved
 * while the run worked, the run's own commits are rebased onto where it is
 * now (ADR-0006), and the commits in between, being someone else's, aren't
 * judged as the run's.
 */
async function onItsOwnBranch(git: Git, url: string, branch: BuiltBranch, bundlePath: string): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  await git("fetch", "--quiet", url, branch.base.sha);
  await git("fetch", "--quiet", url, `+HEAD:${MAIN_REF}`);
  const built = await fetchBundle(git, branch, bundlePath);
  const main = (await git("rev-parse", "--verify", `${MAIN_REF}^{commit}`)).trim();
  const head = (await headNow(git, url, branch)) ?? branch.base.sha;
  const moved = head !== branch.base.sha;

  let tip = built;
  if (moved) {
    const rebased = await rebaseOnto(git, branch.base.sha, built, head);
    if (rebased === null) {
      return {
        changes: { net: [], commits: [], updatedFromMain: false, rebase: { onto: head, conflicted: true } },
        head: null,
        push: () => Promise.reject(new Error(`${branch.name} conflicts with ${head}, so there's nothing to push`)),
      };
    }
    await git("update-ref", ref, rebased);
    tip = rebased;
  }

  const unlikeMain = new Set((await git("diff", "--name-only", "-z", "--no-ext-diff", main, tip)).split("\0").filter(Boolean));
  // A path the branch now holds just as main does came from main, not from this run.
  const net = (await diff(git, head, tip)).filter(
    (change) => unlikeMain.has(change.path) || (change.from !== undefined && unlikeMain.has(change.from)),
  );
  return {
    changes: {
      net,
      // Only the run's own: neither main's nor the PR's commits it landed on, whoever pushed them.
      commits: await commitsIn(git, tip, `^${main}`, `^${head}`),
      updatedFromMain: !(await isAncestor(git, main, head)) && (await isAncestor(git, main, tip)),
      ...(moved ? { rebase: { onto: head, conflicted: false } } : {}),
    },
    head: tip,
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", `--force-with-lease=${ref}:${head}`, url, `${ref}:${ref}`);
    },
  };
}

/** Where the PR's branch is on the remote now, or null if it's gone. */
async function headNow(git: Git, url: string, branch: BuiltBranch): Promise<string | null> {
  try {
    await git("fetch", "--quiet", url, `+refs/heads/${branch.name}:${HEAD_REF}`);
  } catch {
    return null;
  }
  return (await git("rev-parse", "--verify", `${HEAD_REF}^{commit}`)).trim();
}

/**
 * Replays the run's commits, `base` to `tip` along their first parents, onto
 * `onto`, without a working tree: merge-tree merges each one's change in, and
 * the commit is remade with its author, committer and message. A merge the
 * run made keeps its other parents, so merging main in carries across. Null
 * on a conflict, or when the run rewrote the history it built on, whose own
 * commits can't then be told apart.
 */
async function rebaseOnto(git: Git, base: string, tip: string, onto: string): Promise<string | null> {
  if (!(await isAncestor(git, base, tip))) return null;
  const commits = (await git("rev-list", "--reverse", "--first-parent", `${base}..${tip}`)).split("\n").filter(Boolean);
  let current = onto;
  for (const commit of commits) {
    const [, parent, ...others] = (await git("rev-list", "--parents", "-n", "1", commit)).trim().split(" ");
    if (parent === undefined) return null;
    // Exits non-zero on a conflict.
    const tree = await git("merge-tree", "--write-tree", `--merge-base=${parent}`, current, commit).then(
      (out) => out.split("\n")[0]?.trim() ?? "",
      () => "",
    );
    if (tree === "") return null;
    const [authorName = "", authorEmail = "", authorDate = "", committerName = "", committerEmail = "", message = ""] = (
      await git("log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%B", commit)
    ).split("\0");
    const identity = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
    };
    const parents = [current, ...others].flatMap((sha) => ["-p", sha]);
    current = (await git.with(identity)("commit-tree", tree, ...parents, "-m", message.replace(/\n+$/, ""))).trim();
  }
  return current;
}
