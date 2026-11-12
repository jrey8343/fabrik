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
import { isTestPath } from "../loop/changedTests.ts";
import { PROTOTYPE_BRANCH_PREFIX } from "../loop/designOutput.ts";
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

export interface Remote {
  readonly serverUrl: string;
  readonly repo: Repo;
  readonly token: string;
}

/**
 * Runs git in the empty repository the branch is rebuilt in; `with` runs it
 * with more environment, such as a commit's identity. Its output is read as
 * UTF-8 text; `bytes` gives the output as the bytes git printed, for a diff,
 * whose lines are in whatever encoding their files are.
 */
export type Git = Run & {
  with(more: Readonly<Record<string, string>>): Run;
  bytes(...args: string[]): Promise<Uint8Array>;
};

/** One way of running git, such as with more environment. */
type Run = (...args: string[]) => Promise<string>;

/** Where the remote's default branch (the PR's base, main) is fetched to. */
export const MAIN_REF = "refs/fabrik/main";

/** Where the PR's branch, as it is on the remote now, is fetched to. */
const HEAD_REF = "refs/fabrik/head";

/**
 * Rebuilds `branch` from `bundlePath` and reads what it changes. A branch with
 * no commits has no bundle and changes nothing. A Request-changes run whose
 * PR conflicted with main (#341) is judged on whether it resolved the
 * conflict, against the main head it was told to merge: `mergeMain`, from
 * the run's result, which the agent job writes, so it counts only if it's
 * main as the run started (`started`, which the Kit job read before the run)
 * or as it is now, and otherwise main as it is now. One whose result names
 * none is still judged, against `started`, when its PR conflicted with that.
 * Neither ever decides which of the run's paths read as main's. A run told to
 * merge main that made no commits resolved nothing.
 */
export async function rebuildAgentBranch(
  branch: BuiltBranch,
  bundlePath: string,
  remote: Remote,
  judged: Judged = {},
): Promise<AgentBranchGit> {
  const { git, url } = await emptyRepository(remote);
  if (branch.head === null) {
    const { requestChanges = false, mergeMain = null, started = null } = judged;
    const now = requestChanges ? await mainNow(git, url) : null;
    const told = !requestChanges
      ? null
      : mergeMain !== null
        ? mergeMain === started || mergeMain === now
          ? mergeMain
          : (now ?? started ?? mergeMain)
        : await conflictingOnRemote(git, url, branch.name, [started, now]);
    return {
      changes: {
        net: [],
        commits: [],
        updatedFromMain: false,
        ...(judged.requestChanges !== true || told === null ? {} : { mainMerge: { main: told, resolved: false } }),
      },
      head: null,
      push: () => Promise.reject(new Error(`${branch.name} has no commits to push`)),
    };
  }
  if (isPrototypeBranch(branch.name)) return fastForwardOnly(git, url, branch, bundlePath);
  return branch.base.ref === branch.name ? onItsOwnBranch(git, url, branch, bundlePath, judged) : cutFromMain(git, url, branch, bundlePath);
}

/** What a run on its own branch is judged by, beyond its changes (#341). */
export interface Judged {
  /** Whether it's a Request-changes run, from the Kit job's plan. */
  readonly requestChanges?: boolean;
  /** The main head its result says it was told to merge, if any. */
  readonly mergeMain?: string | null;
  /** The main head the Kit job read before the run started, if it read one. */
  readonly started?: string | null;
  /**
   * Whether the run's PR is the whole branch, not only its own commits: a
   * Kept-branch start (#536), from the Kit job's plan, whose new PR's paths
   * are worked out from the whole branch against main.
   */
  readonly wholeBranch?: boolean;
}

/**
 * For a run that committed nothing: the first of these main heads the PR's
 * branch, as it is on the remote now, conflicts with, or null. Nothing is
 * fetched until it's needed, and a head that can't be fetched is skipped.
 */
async function conflictingOnRemote(git: Git, url: string, branch: string, mains: readonly (string | null)[]): Promise<string | null> {
  const head = await headNow(git, url, branch);
  if (head === null) return null;
  const fetched: string[] = [];
  for (const main of mains) {
    if (main === null || fetched.includes(main)) continue;
    if (await git("fetch", "--quiet", url, main).then(() => true, () => false)) fetched.push(main);
  }
  return conflictingMain(git, head, fetched);
}

/** The default branch's head on the remote now, or null if it can't be read. */
async function mainNow(git: Git, url: string): Promise<string | null> {
  const line = await git("ls-remote", url, "HEAD").then(
    (out) => out.split("\n")[0] ?? "",
    () => "",
  );
  const sha = line.split(/\s/)[0] ?? "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * An empty repository to work in, with a git that reaches `remote` as the
 * Fabrik App: the token goes in an env-only config entry, so it never lands
 * on disk or in argv, and hooks are off.
 */
export async function emptyRepository(remote: Remote): Promise<{ readonly git: Git; readonly url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-branch-"));
  const url = `${remote.serverUrl}/${remote.repo.owner}/${remote.repo.name}.git`;
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
  const maxBuffer = 64 * 1024 * 1024;
  const runIn =
    (more: Readonly<Record<string, string>>) =>
    async (...args: string[]) =>
      (await run("git", args, { cwd: dir, env: { ...env, ...more }, maxBuffer })).stdout;
  const bytes = async (...args: string[]): Promise<Uint8Array> => (await run("git", args, { cwd: dir, env, maxBuffer, encoding: "buffer" })).stdout;
  const git: Git = Object.assign(runIn({}), { with: runIn, bytes });
  await git("init", "--quiet", "--template=");
  return { git, url };
}

/** How a mechanical rebase onto main went (#304), and, when clean, its push. */
export interface MainRebase {
  /** `gone` when the branch no longer exists, so there's nothing to rebase. */
  readonly outcome: "rebased" | "conflicted" | "up-to-date" | "gone";
  /** Pushes the rebased branch, with a lease on the head it rebased; refuses unless the rebase was clean. */
  push(): Promise<void>;
}

/**
 * Rebases an agent PR's branch onto `onto`, the default branch's head, with no
 * agent (#304): the PR's commits since it last met main are replayed onto it
 * without a working tree, as a retry's are onto a moved branch (rebaseOnto).
 * Nothing from the Product repo runs. A branch already holding `onto` is up
 * to date, one that's gone has nothing to rebase, and one whose commits
 * conflict with it is left as it is. The push replaces the branch only while it's still at the head that
 * was rebased.
 */
export async function rebaseBranchOntoMain(branch: string, onto: string, remote: Remote): Promise<MainRebase> {
  const { git, url } = await emptyRepository(remote);
  const ref = `refs/heads/${branch}`;
  const refuse = (why: string) => () => Promise.reject(new Error(why));
  await git("fetch", "--quiet", url, onto);
  const head = await headNow(git, url, branch);
  if (head === null) return { outcome: "gone", push: refuse(`${branch} is gone, so there's nothing to rebase`) };
  if (await isAncestor(git, onto, head)) return { outcome: "up-to-date", push: refuse(`${branch} already holds ${onto}`) };
  const base = (await git("merge-base", head, onto)).trim();
  const rebased = await rebaseOnto(git, base, head, onto);
  if (rebased === null) return { outcome: "conflicted", push: refuse(`${branch} conflicts with ${onto}, so there's nothing to push`) };
  await git("update-ref", ref, rebased);
  return {
    outcome: "rebased",
    async push() {
      await git("push", "--quiet", `--force-with-lease=${ref}:${head}`, url, `${ref}:${ref}`);
    },
  };
}

/**
 * Whether this is an issue's prototype branch (#155, prototypeBranchFor),
 * which the Kit never merges, never opens a PR from, never deletes, and only
 * ever fast-forwards, whoever's run built it.
 */
function isPrototypeBranch(name: string): boolean {
  return name.startsWith(PROTOTYPE_BRANCH_PREFIX);
}

/**
 * A bundle the push job can't read the agent's branch from (#535), with git's
 * own reason, such as the prerequisite commits it lacks. Running the push job
 * again downloads the same bundle, so it fails the same way.
 */
export class UnverifiedBundle extends Error {
  override name = "UnverifiedBundle";
}

/** Reads the bundle's branch in, checking it verifies and ends where the agent job said. */
async function fetchBundle(git: Git, branch: BuiltBranch, bundlePath: string): Promise<string> {
  const ref = `refs/heads/${branch.name}`;
  // Not --quiet, which leaves stderr empty: git's reason is all the failure has to say.
  await git("bundle", "verify", bundlePath).catch((error: unknown) => {
    const said = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new UnverifiedBundle(`The bundle of ${branch.name} doesn't verify${said === "" ? "" : `: ${said}`}`, { cause: error });
  });
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
 * main in doesn't count main's own changes. Remerge can't judge an octopus
 * merge, nor a merge whose parents share no merge base (#390). Those are judged
 * by combined diff instead: a path is the merge's own only where its result
 * differs from every parent. A side taken unchanged is judged elsewhere, so it
 * doesn't count; a hand edit does. Git is never asked to remerge those merges,
 * so it never warns into the listing.
 */
async function commitsIn(git: Run, ...revisions: string[]): Promise<ChangedPath[]> {
  const commits = (await git("rev-list", "--parents", ...revisions, "--"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const remerged: string[] = [];
  const combined: (readonly [string, readonly string[]])[] = [];
  for (const [sha, ...parents] of commits) {
    if (sha === undefined) continue;
    if (await remergeCanJudge(git, parents)) remerged.push(sha);
    else combined.push([sha, parents]);
  }
  const changes =
    remerged.length === 0
      ? []
      : parseNameStatus(
          await git("log", "--no-walk=unsorted", "--format=", "--name-status", "-z", "-M", "--diff-merges=remerge", "--no-ext-diff", ...remerged, "--"),
        );
  for (const [sha, parents] of combined) changes.push(...(await unlikeEveryParent(git, sha, parents)));
  return changes;
}

/**
 * Whether remerge can judge a commit with these parents: any but a merge of more than two, or of two with no merge
 * base. Only git's "no merge base" exit (1) says so; any other failure is the push job's to report, never a reason
 * to judge the merge another way.
 */
async function remergeCanJudge(git: Run, parents: readonly string[]): Promise<boolean> {
  const [ours, theirs, ...more] = parents;
  if (ours === undefined || theirs === undefined) return true;
  if (more.length > 0) return false;
  try {
    await git("merge-base", ours, theirs);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * The paths where merge `sha` differs from every one of its `parents`, as its first parent's diff names them. Renames
 * are off, unlike remerge's listing: the parents' diffs are compared path by path, so a rename inside the merge counts
 * as both its paths.
 */
async function unlikeEveryParent(git: Run, sha: string, parents: readonly string[]): Promise<ChangedPath[]> {
  const diffs = await Promise.all(
    parents.map(async (parent) => parseNameStatus(await git("diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", parent, sha))),
  );
  const [first = [], ...rest] = diffs;
  const unlike = rest.map((changes) => new Set(changes.map((change) => change.path)));
  return first.filter((change) => unlike.every((paths) => paths.has(change.path)));
}

function isAncestor(git: Git, ancestor: string, of: string): Promise<boolean> {
  return git("merge-base", "--is-ancestor", ancestor, of).then(
    () => true,
    () => false,
  );
}

/**
 * Git's own merge of `ours` and `theirs` (#341), worked out without a work
 * tree: the tree it makes, with conflict markers in any file that conflicts,
 * and whether one does. Exit status 1 with a tree is a conflicted merge; any
 * other failure is the push job's to report, not a conflict.
 */
async function mergeTree(git: Run,ours: string, theirs: string): Promise<{ readonly tree: string; readonly conflicted: boolean }> {
  const treeOf = (out: string): string | null => {
    const tree = out.split("\n")[0]?.trim() ?? "";
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  };
  try {
    const tree = treeOf(await git("merge-tree", "--write-tree", "--no-messages", ours, theirs));
    if (tree === null) throw new Error(`git merge-tree gave no tree for ${ours} and ${theirs}`);
    return { tree, conflicted: false };
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    const tree = code === 1 && typeof stdout === "string" ? treeOf(stdout) : null;
    if (tree === null) throw error;
    return { tree, conflicted: true };
  }
}

/**
 * Whether `ours` conflicts with `theirs`, by git's own merge: a merge git
 * can't make at all, as of histories main's rewrite left unrelated, counts
 * as a conflict, so the run is handed over rather than the push job failing.
 */
function conflicts(git: Run, ours: string, theirs: string): Promise<boolean> {
  return mergeTree(git, ours, theirs).then(
    ({ conflicted }) => conflicted,
    () => true,
  );
}

/** The first of these main heads the PR's `head` conflicts with, by its own .gitattributes, or null. */
async function conflictingMain(git: Git, head: string, mains: readonly string[]): Promise<string | null> {
  for (const main of mains) {
    if (await conflicts(git.with({ GIT_ATTR_SOURCE: head }), head, main)) return main;
  }
  return null;
}

/** A first run, cut from main: everything it changes is its own. Its push replaces whatever an earlier run left on the agent branch. */
async function cutFromMain(git: Git, url: string, branch: BuiltBranch, bundlePath: string): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  await git("fetch", "--quiet", "--depth=1", url, branch.base.sha);
  const tip = await fetchBundle(git, branch, bundlePath);
  if (!(await isAncestor(git, branch.base.sha, tip))) {
    throw new Error(`${branch.name} doesn't start from ${branch.base.ref} at ${branch.base.sha}`);
  }
  const commits = await commitsIn(git, `${branch.base.sha}..${tip}`);
  return {
    changes: {
      net: await diff(git, branch.base.sha, tip),
      commits,
      updatedFromMain: false,
      changedTests: await existingTests(git, commits, [branch.base.sha]),
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
 * judged as the run's. A path the branch holds just as git's own merge of the
 * PR's head and the main the run brought in would have it is main's, not the
 * run's, though it reads unlike both: a file both had changed that merged
 * cleanly. The main it brought in is main as it is now, or else as the run
 * started, whichever the branch holds and the PR's head didn't: never a
 * commit only the run names, nor one main's history holds but main never
 * was at. A
 * Request-changes run told to merge `mergeMain` in (#341) resolved its
 * conflict when the branch holds that head, or merges cleanly with it. Merges
 * follow the PR's .gitattributes as they were before the run.
 */
async function onItsOwnBranch(
  git: Git,
  url: string,
  branch: BuiltBranch,
  bundlePath: string,
  { requestChanges = false, mergeMain = null, started: startedAt = null, wholeBranch = false }: Judged,
): Promise<AgentBranchGit> {
  const ref = `refs/heads/${branch.name}`;
  await git("fetch", "--quiet", url, branch.base.sha);
  await git("fetch", "--quiet", url, `+HEAD:${MAIN_REF}`);
  // Main as the run started is in main's history already, unless a force-push took it out, when it's no head now.
  const started =
    startedAt === null
      ? null
      : await git("fetch", "--quiet", url, startedAt).then(
          () => startedAt,
          () => null,
        );
  const built = await fetchBundle(git, branch, bundlePath);
  const main = (await git("rev-parse", "--verify", `${MAIN_REF}^{commit}`)).trim();
  const head = (await headNow(git, url, branch.name)) ?? branch.base.sha;
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

  // Merges are judged by the PR's own .gitattributes as they stood before the run, never the run's.
  const judging = git.with({ GIT_ATTR_SOURCE: head });
  const unlike = async (from: string): Promise<Set<string>> =>
    new Set((await git("diff", "--name-only", "-z", "--no-ext-diff", from, tip)).split("\0").filter(Boolean));
  const unlikeMain = await unlike(main);
  // Main's heads the run can have brought in, newest first: main as it is now, and as the Kit job read it before
  // the run started. Neither comes from the agent job. The main the run brought in is the first of them it holds
  // that the PR's head didn't; a commit main was never at, though its history holds one, never is.
  const heads = [main, ...(started === null || started === main ? [] : [started])];
  let broughtIn: string | null = null;
  for (const candidate of heads) {
    if (broughtIn === null && (await isAncestor(git, candidate, tip)) && !(await isAncestor(git, candidate, head))) broughtIn = candidate;
  }
  // A merge git can't make at all, as with a main whose history was rewritten, leaves nothing to compare against: every
  // path unlike main then counts as the run's, which the trust-root guard judges strictly.
  const merged = broughtIn === null ? null : await mergeTree(judging, head, broughtIn).catch(() => null);
  const unlikeMerge = merged === null ? null : await unlike(merged.tree);
  // A path the branch now holds just as main does, or just as git's own merge with it does, came from main, not from this run.
  const own = (path: string): boolean => unlikeMain.has(path) && (unlikeMerge === null || unlikeMerge.has(path));
  const net = (await diff(git, head, tip)).filter((change) => own(change.path) || (change.from !== undefined && own(change.from)));
  // A Request-changes run is judged against the main it was told to merge, from its result, when that's one of those
  // heads, and otherwise main as it is now. One whose result names none is still judged, against main as it started
  // or as it is now, if the PR's head, as this job reads it, conflicts with that: the agent job writes the result, and
  // the head it says it started on, so neither decides whether the run is judged.
  const told = !requestChanges
    ? null
    : mergeMain !== null
      ? heads.includes(mergeMain)
        ? mergeMain
        : main
      : await conflictingMain(git, head, [...(started === null ? [] : [started]), main]);
  const resolved = told === null ? null : (await isAncestor(git, told, tip)) || !(await conflicts(judging, tip, told));
  // Only the run's own: neither main's nor the PR's commits it landed on, whoever pushed them.
  const commits = await commitsIn(judging, tip, `^${main}`, `^${head}`);
  return {
    changes: {
      net,
      commits,
      // A test is already there when the head the run's commits land on holds it, or main does, for a run that brought main in.
      changedTests: await existingTests(git, commits, [head, main]),
      updatedFromMain: !(await isAncestor(git, main, head)) && (await isAncestor(git, main, tip)),
      ...(moved ? { rebase: { onto: head, conflicted: false } } : {}),
      ...(told === null || resolved === null ? {} : { mainMerge: { main: told, resolved } }),
      // What the push lands, which the run's push note names (#420).
      pushedHead: tip,
      ...(wholeBranch ? { wholeBranch: await wholeBranchAgainst(git, main, tip) } : {}),
    },
    head: tip,
    async push(name) {
      if (name !== branch.name) throw new Error(`Asked to push ${name}, but the bundle holds ${branch.name}`);
      await git("push", "--quiet", `--force-with-lease=${ref}:${head}`, url, `${ref}:${ref}`);
    },
  };
}

/**
 * A Kept-branch start's whole branch against main (#536), as its new PR
 * shows it: the paths changed since the two last met, and the existing tests
 * among them that its commits main doesn't hold, the kept ones and the run's,
 * changed, deleted or moved away.
 */
async function wholeBranchAgainst(git: Git, main: string, tip: string): Promise<NonNullable<BranchChanges["wholeBranch"]>> {
  const met = (await git("merge-base", main, tip)).trim();
  const commits = await commitsIn(git, tip, `^${main}`);
  return { net: await diff(git, met, tip), changedTests: await existingTests(git, commits, [main]) };
}

/**
 * The test files (isTestPath) these commits changed, deleted or moved away
 * that one of `bases` already holds (#463), each once, sorted. Pathspecs are
 * read literally, so no path the agent made up reads as a pattern.
 */
async function existingTests(git: Run, commits: readonly ChangedPath[], bases: readonly string[]): Promise<string[]> {
  const tests = [...new Set(commits.flatMap(({ path, from }) => (from === undefined ? [path] : [path, from])).filter(isTestPath))];
  if (tests.length === 0) return [];
  const there = new Set<string>();
  for (const base of new Set(bases)) {
    const listed = await git("--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base, "--", ...tests);
    for (const path of listed.split("\0")) if (path !== "") there.add(path);
  }
  return tests.filter((path) => there.has(path)).sort();
}

/** Where the PR's branch is on the remote now, or null if it's gone. */
async function headNow(git: Git, url: string, branch: string): Promise<string | null> {
  try {
    await git("fetch", "--quiet", url, `+refs/heads/${branch}:${HEAD_REF}`);
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
