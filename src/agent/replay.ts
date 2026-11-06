// A Replay arm's agent runs (#156), which run as live ones do but leave the
// Product repo untouched: no branch is pushed and no PR is opened. A replay
// arm's Review judges the arm's diff from the Ticket's baseSha, a local commit
// on top of it in the job's checkout, with the Ticket and its Spec in place of
// a PR, and no Operator comments, since nobody has commented on it.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CODING_STANDARDS_FILE } from "../guard/trust-root.ts";
import { readIfPresent } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { type ImplementInput, implementInput, ticketContext } from "./implement.ts";
import type { BuiltBranch } from "./result.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** The env var a replay arm's runs take the Ticket's baseSha in, the commit the arm builds from and is judged against. */
export const BASE_SHA_ENV = "FABRIK_BASE_SHA";

/** Throws unless the checkout's HEAD is `baseSha` or built on it, so a replay arm never runs on some other commit. */
async function builtOn(productDir: string, baseSha: string): Promise<void> {
  try {
    await git(productDir, "merge-base", "--is-ancestor", baseSha, "HEAD");
  } catch {
    throw new Error(`The checkout's HEAD isn't built on the replay's baseSha ${baseSha}`);
  }
}

/**
 * A replay arm's Implement input, in a checkout of the Ticket's `baseSha`:
 * what a first Implement run's would be (implementInput), with the Ticket and
 * its Spec as GitHub holds them now and the glossary, ADRs and Kit config at
 * `baseSha`. It cuts the Ticket's agent branch there, which is never pushed.
 * Throws unless the checkout is at `baseSha`.
 */
export async function replayImplementInput(
  productDir: string,
  ticket: number,
  config: KitConfig,
  specFile: string,
  baseSha: string,
): Promise<ImplementInput> {
  const head = (await git(productDir, "rev-parse", "HEAD")).trim();
  if (head !== baseSha) throw new Error(`The checkout is at ${head}, not the replay's baseSha ${baseSha}`);
  return implementInput(productDir, ticket, config, { spec: specFile, pullRequest: "", review: "" });
}

/** The file a replay arm's Implement run passes its diff from baseSha out in, beside agent-result.json. */
export const REPLAY_PATCH_FILE = "replay.patch";

/**
 * Writes the commits a replay arm's Implementer made on `started`, its agent
 * branch from baseSha, into `outDir` as one patch from baseSha, binary files
 * included, which `git apply` lays on a fresh checkout of baseSha: the replay
 * gates and Review jobs' input, and the patch the store keeps. With none it
 * writes an empty patch and the head stays null. Work left uncommitted isn't
 * the run's output, as on a live run.
 */
export async function writeReplayPatch(productDir: string, started: BuiltBranch, outDir: string): Promise<BuiltBranch> {
  const current = (await git(productDir, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (current !== started.name) throw new Error(`The agent left ${started.name} for ${current}`);
  if ((await git(productDir, "status", "--porcelain")) !== "") {
    console.log("::warning title=Uncommitted work::The agent left changes it didn't commit; they aren't in the patch");
  }
  const head = (await git(productDir, "rev-parse", "HEAD")).trim();
  const committed = head !== started.base.sha;
  const patch = committed ? await git(productDir, "diff", "--binary", started.base.sha, head) : "";
  await writeFile(join(outDir, REPLAY_PATCH_FILE), patch);
  return { ...started, head: committed ? head : null };
}

/** Past this many characters, the diff a replay arm's Review is shown is cut short; the checkout holds all of it. */
export const REPLAY_DIFF_LIMIT = 60_000;

/** The heading a replay arm's Review sets the change it judges out under. */
export const REPLAY_CHANGE_HEADING = "The change you're judging";

/**
 * What a replay arm's Review is told of the change it judges, in place of a
 * PR: that there is none, how to read the change from `baseSha` instead, and
 * the diff itself, cut short past REPLAY_DIFF_LIMIT. Pure.
 */
export function replayChangeParts(baseSha: string, diff: string): string[] {
  const text = diff.trimEnd();
  const truncated = text.length > REPLAY_DIFF_LIMIT;
  return [
    `## ${REPLAY_CHANGE_HEADING}`,
    [
      `This change has no pull request. It's an Implementer's work on the Ticket above, built from the commit \`${baseSha}\`, and the checkout holds it as a commit on top of that one, at \`HEAD\`.`,
      `Wherever this prompt speaks of the PR, judge this change: its base is \`${baseSha}\`, so read it with \`git diff ${baseSha} HEAD\` and \`git log ${baseSha}..HEAD\`, never against \`origin/main\`.`,
      "It has no title, description or comments, and the Operator has written nothing on it, so what this prompt says of a PR's description and of the Operator's comments doesn't apply.",
      "Its build and tests run apart from you, and their result isn't given to you: judge it as you would a PR whose required checks have passed.",
    ].join(" "),
    text === ""
      ? "(The change is empty: the Implementer committed nothing.)"
      : [
          "```diff",
          truncated ? text.slice(0, REPLAY_DIFF_LIMIT) : text,
          "```",
          ...(truncated
            ? [`[Diff cut short at ${REPLAY_DIFF_LIMIT} of ${text.length} characters; \`git diff ${baseSha} HEAD\` shows all of it.]`]
            : []),
        ].join("\n"),
  ];
}

/**
 * What a replay arm's Reviewer is given beyond the Ticket, in a checkout of
 * the arm's change as a commit on `baseSha`: the change and its diff from
 * `baseSha` (replayChangeParts), the Ticket's Spec, the repo's glossary and
 * ADRs, and its Coding standards, all at that commit. A live Review's PR, its
 * Operator comments and its UI evidence have no counterpart here.
 */
export async function replayReviewContext(productDir: string, specFile: string, baseSha: string): Promise<string[]> {
  await builtOn(productDir, baseSha);
  const diff = await git(productDir, "diff", baseSha, "HEAD");
  const standards = await readIfPresent(join(productDir, CODING_STANDARDS_FILE));
  return [
    ...replayChangeParts(baseSha, diff),
    ...(await ticketContext(productDir, specFile)),
    ...(standards === null ? [] : [`## ${CODING_STANDARDS_FILE}`, standards.trimEnd()]),
  ];
}
