// The setup branch and the setup PR, with the Operator's own git and gh: the
// run switches to fabrik/setup-<release>, commits only the files setup
// wrote, pushes the branch, and opens the setup PR or updates the one
// already open from it.
import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Run } from "./exec.ts";
import { prBody, withEarlierDone } from "./finish.ts";
import type { Published, RunSummary } from "./oneRun.ts";

/** The branch setup applies its plan on, and a later run of the same release picks up. */
export function setupBranch(release: string): string {
  return `fabrik/setup-${release}`;
}

/**
 * Every path the clone has uncommitted, untracked ones included. The checks
 * and the setup commit both read it, so they agree on what's uncommitted.
 */
export async function uncommittedPaths(run: Run, cwd: string): Promise<string[]> {
  return changedPaths(await ok(run, "git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }));
}

/** Every path `git status --porcelain=v1 -z` names, a rename's old path included. */
function changedPaths(status: string): string[] {
  const entries = status.split("\0").filter((entry) => entry !== "");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++i] ?? "");
  }
  return paths.filter((path) => path !== "");
}

/**
 * The head commit of each merged PR from this repo's own setup branch. A
 * squash or rebase merge leaves none of the branch's commits on the default
 * branch, so this is how setup knows that branch is done.
 */
export async function mergedSetupHeads(run: Run, cwd: string, branch: string): Promise<string[]> {
  const listed = JSON.parse(
    await ok(run, "gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid,isCrossRepository"], { cwd }),
  ) as { headRefOid: string; isCrossRepository: boolean }[];
  return listed.filter((pr) => !pr.isCrossRepository).map((pr) => pr.headRefOid);
}

/**
 * From the default branch, an earlier run's setup branch that isn't merged
 * yet, here or on origin (whose tip the checks found): the run picks up from
 * there, not from the default branch, so it doesn't plan that run's files
 * again over the Operator's edits. Null when there's none.
 */
export async function earlierSetupRun(
  run: Run,
  cwd: string,
  branch: string,
  defaultBranch: string,
  originTip: string | null,
): Promise<string | null> {
  let heads: Promise<string[]> | undefined;
  const merged = async (sha: string) =>
    (await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd })).code === 0 ||
    (await (heads ??= mergedSetupHeads(run, cwd, branch))).includes(sha);
  const local = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
  if (local.code === 0 && !(await merged(local.stdout.trim()))) {
    return `${branch} holds an earlier run of setup that isn't on ${defaultBranch} yet. Switch to it with git switch ${branch}, then run setup again: it picks up where that run stopped.`;
  }
  if (originTip === null || (await merged(originTip))) return null;
  return (
    `origin's ${branch} holds an earlier run of setup that isn't on ${defaultBranch} yet. ` +
    `Fetch it and switch to it with git fetch origin ${branch}:${branch} && git switch ${branch}, then run setup again: it picks up where that run stopped.`
  );
}

/**
 * What runs of setup applied on the setup branch since its last setup PR was
 * published, a step a line, as describeAction words it. A run that stops
 * before the PR, partway through applying or at the push, leaves it for the
 * next run's PR to list. It's a file in the clone's git directory, so it's in
 * no commit.
 */
export interface DoneRecord {
  read(): Promise<string[]>;
  add(step: string): Promise<void>;
  clear(): Promise<void>;
}

export function doneRecord(run: Run, cwd: string, release: string): DoneRecord {
  let path: Promise<string> | undefined;
  const file = () =>
    (path ??= ok(run, "git", ["rev-parse", "--absolute-git-dir"], { cwd }).then((dir) => join(dir.trim(), `fabrik-setup-${release}.done`)));
  return {
    read: async () => (await readFile(await file(), "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
    add: async (step) => appendFile(await file(), `${step}\n`),
    clear: async () => rm(await file(), { force: true }),
  };
}

/** Switches to the setup branch. One left from a merged run is started again from here, which loses nothing. */
export async function switchToSetupBranch(run: Run, cwd: string, branch: string, current: string): Promise<void> {
  if (current === branch) return;
  await ok(run, "git", ["switch", "-C", branch], { cwd });
}

/** Commits whichever of these files, the ones setup wrote, changed, and nothing else the clone has. Returns whether there was anything to commit. */
export async function commitSetupFiles(run: Run, cwd: string, paths: readonly string[], release: string): Promise<boolean> {
  const changed = (await uncommittedPaths(run, cwd)).filter((path) => paths.includes(path));
  if (changed.length === 0) return false;
  await ok(run, "git", ["add", "--", ...changed], { cwd });
  await ok(run, "git", ["commit", "-q", "-m", `Set up Fabrik ${release}`, "--", ...changed], { cwd });
  return true;
}

/**
 * Pushes the setup branch over the tip the checks found on origin, or none:
 * one GitHub kept from a squash- or rebase-merged run is replaced, and one
 * that moved since the checks is not.
 */
export async function pushSetupBranch(run: Run, cwd: string, branch: string, originTip: string | null): Promise<void> {
  await ok(run, "git", ["push", "-q", "-u", `--force-with-lease=${branch}:${originTip ?? ""}`, "origin", branch], { cwd });
}

export interface PublishInputs {
  readonly run: Run;
  readonly cwd: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly release: string;
  readonly summary: RunSummary;
}

/** An open PR from the setup branch. */
export interface SetupPr {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/**
 * The setup PR open from the branch, or null. gh matches the head by its name
 * alone, so a fork's PR from a branch of the same name is left out: setup
 * never edits one, or offers it to the Operator to merge.
 */
export async function openSetupPr(run: Run, cwd: string, branch: string): Promise<SetupPr | null> {
  const listed = JSON.parse(
    await ok(run, "gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,body,isCrossRepository"], { cwd }),
  ) as (SetupPr & { isCrossRepository: boolean })[];
  const own = listed.find((pr) => !pr.isCrossRepository);
  return own === undefined ? null : { number: own.number, url: own.url, body: own.body };
}

/** Opens the setup PR, or updates the one already open from the branch, keeping what earlier runs did in its list. */
export async function publishSetupPr({ run, cwd, branch, defaultBranch, release, summary }: PublishInputs): Promise<Published> {
  const open = await openSetupPr(run, cwd, branch);
  const full: RunSummary = { ...summary, done: withEarlierDone(open?.body ?? null, summary.done) };
  const body = prBody({ release, defaultBranch, summary: full });
  if (open !== null) {
    await ok(run, "gh", ["pr", "edit", String(open.number), "--body-file", "-"], { cwd, input: body });
    return { url: open.url, summary: full };
  }
  const created = await ok(
    run,
    "gh",
    ["pr", "create", "--base", defaultBranch, "--head", branch, "--title", `Set up Fabrik ${release}`, "--body-file", "-"],
    { cwd, input: body },
  );
  const url = created.trim().split("\n").at(-1) ?? "";
  return { url, summary: full };
}
