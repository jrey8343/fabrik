// The setup branch and the setup PR, with the Operator's own git and gh: the
// run switches to fabrik/setup-<release>, commits only the files setup
// writes, pushes the branch, and opens the setup PR or updates the one
// already open from it.
import { uncommittedPaths } from "./checks.ts";
import { ok, type Run } from "./exec.ts";
import { prBody, withEarlierDone } from "./finish.ts";
import type { Published, RunSummary } from "./oneRun.ts";

/**
 * From the default branch, an earlier run's setup branch that isn't merged
 * yet: the run picks up from there, not from the default branch, so it doesn't
 * plan that run's files again over the Operator's edits. Null when there's none.
 */
export async function earlierSetupRun(run: Run, cwd: string, branch: string, defaultBranch: string): Promise<string | null> {
  const merged = async (sha: string) => (await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd })).code === 0;
  const local = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
  if (local.code === 0 && !(await merged(local.stdout.trim()))) {
    return `${branch} holds an earlier run of setup that isn't on ${defaultBranch} yet. Switch to it with git switch ${branch}, then run setup again: it picks up where that run stopped.`;
  }
  if (local.code === 0) return null;
  const remote = await run("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd });
  const tip = remote.stdout.split("\t")[0]?.trim() ?? "";
  if (remote.code !== 0 || tip === "" || (await merged(tip))) return null;
  return (
    `origin's ${branch} holds an earlier run of setup that isn't on ${defaultBranch} yet. ` +
    `Fetch it and switch to it with git fetch origin ${branch}:${branch} && git switch ${branch}, then run setup again: it picks up where that run stopped.`
  );
}

/** Switches to the setup branch. One left from a merged run is started again from here, which loses nothing. */
export async function switchToSetupBranch(run: Run, cwd: string, branch: string, current: string): Promise<void> {
  if (current === branch) return;
  await ok(run, "git", ["switch", "-C", branch], { cwd });
}

/** Commits whichever of setup's files changed, and nothing else the clone has. Returns whether there was anything to commit. */
export async function commitSetupFiles(run: Run, cwd: string, paths: readonly string[], release: string): Promise<boolean> {
  const changed = (await uncommittedPaths(run, cwd)).filter((path) => paths.includes(path));
  if (changed.length === 0) return false;
  await ok(run, "git", ["add", "--", ...changed], { cwd });
  await ok(run, "git", ["commit", "-q", "-m", `Set up Fabrik ${release}`, "--", ...changed], { cwd });
  return true;
}

export async function pushSetupBranch(run: Run, cwd: string, branch: string): Promise<void> {
  await ok(run, "git", ["push", "-q", "-u", "origin", branch], { cwd });
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
