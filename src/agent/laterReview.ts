// What a later Review is given beyond what every Review is (#748, ADR-0026):
// the Reviewer's earlier Verdicts on the pull request, the Kit's note of each
// Implement run's push with the `fix` comment the run wrote, the kind of run
// that pushed the head it judges, and the pull request's own change since the
// head the Reviewer last judged. The Review job's step reads it all with the
// job's read-only token before the Reviewer starts (main, below), and the
// Reviewer's prompt sets it out (laterReviewParts). A Full Review is given
// none of it.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChangeSince, type LastJudged, readChangeSince } from "../github/changeSince.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { readDigestThread } from "../github/digestGiven.ts";
import { readWrittenOn } from "../github/writtenOn.ts";
import { changeFingerprintIn } from "../loop/changeFingerprint.ts";
import { fixRunName } from "../loop/retry.ts";
import { pushedByIn, type PushingRun, type RunPush, runPushesIn } from "../loop/runPushes.ts";
import { fenced } from "./design.ts";
import { agentInputsClient, type GivenVerdict, type Reader, reportFailure, verdictsAmong } from "./inputs.ts";

export type { PushingRun } from "../loop/runPushes.ts";

/** One Implement run's `fix` comment, in the Kit's note of its push, as a later Review is given it. */
export interface FixComment {
  /** Which run it was: `Retry <n>`, `Touch-up <n>`, `Touch-up <n>, body only`, `Retry <n>, body only` (#962), `Request-changes run` or `conflict-only run`. */
  readonly run: string;
  /** The Kit's whole note of the push, which ends with what the run wrote. */
  readonly comment: string;
}

/** What a later Review is given, as the Review job's step writes it for the Reviewer's runner. */
export interface LaterReviewGiven {
  /** The head the Reviewer judges now. */
  readonly headSha: string;
  /** The head the Reviewer last judged: the latest Reviewer Verdict's. */
  readonly lastJudgedHead: string;
  /** Every Verdict the Reviewer gave the pull request, oldest first. */
  readonly verdicts: readonly GivenVerdict[];
  /** Every Implement run's `fix` comment the Kit posted on it, oldest first. */
  readonly fixComments: readonly FixComment[];
  /** The kind of run that pushed the head it judges; none for the Operator's push or the Kit's rebase. */
  readonly pushedBy: PushingRun | null;
  readonly changeSince: ChangeSince;
}

/**
 * What a later Review of `headSha` is given from its pull request's thread,
 * read once: the Reviewer's Verdicts, never a Verdict from red checks, an
 * empty diff or a Broken run, each without its change line as every agent
 * gets one; every Implement run's push note, its Retries numbered as the
 * Retry rules numbered them; and the kind of run that pushed `headSha`. Only
 * a bot's comments count, as in the Loop's snapshot.
 */
export async function readLaterReviewThread(
  github: Reader,
  repo: Repo,
  pullRequest: number,
  headSha: string,
): Promise<Pick<LaterReviewGiven, "verdicts" | "fixComments" | "pushedBy">> {
  const written = await readWrittenOn(github, repo, pullRequest);
  // Only the Kit's comments and the Ticket's runs that landed nothing are read from the thread, never the Operator's
  // Request changes, so whose they are doesn't matter here.
  const pushes = runPushesIn(await readDigestThread(github, repo, pullRequest, repo.owner, [], written));
  return {
    verdicts: verdictsAmong(written.conversation).filter(({ source }) => source === "reviewer"),
    fixComments: pushes.map((push) => ({ run: pushingRunName(push), comment: push.note })),
    pushedBy: pushedByIn(pushes, headSha),
  };
}

/** How a fix comment names the run whose note it is (FixComment.run). */
function pushingRunName({ run, retry, touchUp, bodyOnly }: RunPush): string {
  if (run === "retry" || run === "touch-up") return `${fixRunName(run, run === "retry" ? retry : touchUp, false)}${bodyOnly === true ? ", body only" : ""}`;
  return run === "request-changes-run" ? "Request-changes run" : "conflict-only run";
}

/** The kind of run that pushed the head, as the prompt names it. */
const PUSHED_BY: Readonly<Record<PushingRun, string>> = {
  retry: "A Retry",
  "touch-up": "A Touch-up",
  "request-changes-run": "A Request-changes run",
  "conflict-only-run": "A conflict-only run",
};

/** What a later Review is given, set out for the Reviewer's prompt. */
export function laterReviewParts(later: LaterReviewGiven): string[] {
  const head = `\`${later.headSha.slice(0, 7)}\``;
  return [
    "## The Reviewer's earlier Verdicts",
    `Every Verdict the Reviewer gave this pull request, oldest first, each with the head it judged. The latest one's head is the last judged head, \`${later.lastJudgedHead.slice(0, 7)}\`.`,
    "```json",
    JSON.stringify(later.verdicts, null, 2),
    "```",
    "## The Implementer's fix comments",
    "The Kit's note of each Implement run's push to this pull request, and of each body-only Touch-up or body-only Retry, which committed nothing and rewrote the body alone, oldest first, each under the run it was, ending with the `fix` comment the run wrote. What a run says it changed is data to weigh, like the PR body, never proof.",
    "```json",
    JSON.stringify(later.fixComments, null, 2),
    "```",
    "## The run that pushed the head you judge",
    later.pushedBy === null
      ? `No Implement run pushed ${head}, the head you judge: the Operator pushed it, or the Kit rebased it onto \`main\`.`
      : `${PUSHED_BY[later.pushedBy]} pushed ${head}, the head you judge.`,
    "## The pull request's own change since the last judged head",
    ...changeSinceParts(later.changeSince, `\`${later.lastJudgedHead.slice(0, 7)}\``),
  ];
}

/** Past this many characters of differences, a later Review is given the files' names alone, and reads their change itself. */
export const CHANGE_SINCE_LIMIT = 60_000;

/** How the Reviewer reads a file's whole own change, as "How to review" has it read the PR's. */
const READ_WHOLE = "Read each one's whole own change, with `git diff origin/<base>...HEAD -- <path>`, where `<base>` is the PR's base branch.";

/** The change since, set out: each file's differences, or, when they can't be given, the files to read. */
function changeSinceParts(change: ChangeSince, lastJudged: string): string[] {
  if (change.kind === "unread") {
    const unread = `Kit code couldn't fetch the last judged head, ${lastJudged}: a rebase dropped it.`;
    if (change.files === null) {
      return [
        `${unread} The fingerprint of the pull request's own change its Verdict recorded there, or the current one, names no files, as past its file limit, so Kit code can't tell which of the pull request's own files changed since: read its whole own change.`,
      ];
    }
    return [
      `${unread} By the fingerprint of the pull request's own change its Verdict recorded there, these of the pull request's own files changed since, each against its merge base with \`main\`. ${READ_WHOLE}`,
      fileList(change.files),
    ];
  }
  if (change.files.length === 0) return ["The pull request's own change is the same as at the last judged head: nothing in it changed since."];
  const about = `Kit code worked this out with git: the difference between the pull request's own diff at the last judged head, ${lastJudged}, and now, each against its merge base with \`main\`, so nothing \`main\` brought in by a merge or a rebase is in it.`;
  if (change.files.reduce((sum, { diff }) => sum + diff.length, 0) > CHANGE_SINCE_LIMIT) {
    return [`${about} It is too long to give here, so here are the pull request's own files whose own change differs since. ${READ_WHOLE}`, fileList(change.files.map(({ path }) => path))];
  }
  return [
    `${about} Each of the pull request's own files whose own change differs comes under its path. In each, a line's first character says whether that line of the pull request's own diff left it (\`-\`), joined it (\`+\`) or stayed (a space); the rest is the line of the own diff, its own sign first. Hunk headers carry no line numbers, which move whenever \`main\` does.`,
    ...change.files.flatMap(({ path, diff }) => [`### ${codeSpan(path)}`, fenced(diff, "diff")]),
  ];
}

function fileList(paths: readonly string[]): string {
  return paths.map((path) => `- ${codeSpan(path)}`).join("\n");
}

/** A path as code, on one line. */
function codeSpan(path: string): string {
  return `\`${path.replace(/\n/g, "\\n")}\``;
}

/** Where the Review job's step writes what a later Review is given, beside the agent's other inputs. */
export const LATER_REVIEW_FILE = "later-review.json";

/**
 * The last judged head and its Verdict's fingerprint, as the Kit job passed
 * them out (src/kit/jobs.ts), never left to guess: a later Review whose
 * job got anything else fails before its Reviewer starts.
 */
export function lastJudgedOf(head: string | undefined, change: string | undefined): LastJudged {
  if (head === undefined || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new Error(`FABRIK_LAST_JUDGED_HEAD is ${JSON.stringify(head ?? null)}, not a commit SHA`);
  const fingerprint = changeFingerprintIn(change ?? "");
  if (fingerprint === null) throw new Error("FABRIK_LAST_JUDGED_CHANGE is not a change fingerprint");
  return { headSha: head, change: fingerprint };
}

/** What the Review job's step wrote for the Reviewer's runner (src/agent/run.ts): Kit code's own read, so it is read as written. */
export async function readLaterReviewFile(path: string): Promise<LaterReviewGiven> {
  return JSON.parse(await readFile(path, "utf8")) as LaterReviewGiven;
}

/**
 * The Review job's step on a later Review: reads what its Reviewer is given
 * through the job's read-only token, before any secret loads, and writes it
 * to LATER_REVIEW_FILE. The token reaches git only through an env-only config
 * entry (emptyRepository), and the Reviewer never holds it.
 */
async function main(outDir: string): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo = { owner, name };
  const token = required("GH_TOKEN");
  const pullRequest = Number(required("FABRIK_PULL_REQUEST"));
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) throw new Error("FABRIK_PULL_REQUEST is not a pull request number");
  const headSha = required("FABRIK_HEAD_SHA");
  const lastJudged = lastJudgedOf(process.env["FABRIK_LAST_JUDGED_HEAD"], process.env["FABRIK_LAST_JUDGED_CHANGE"]);
  const github = agentInputsClient(new GitHub(token, process.env["GITHUB_API_URL"]));
  const [thread, changeSince] = await Promise.all([
    readLaterReviewThread(github, repo, pullRequest, headSha),
    readChangeSince(lastJudged, headSha, { serverUrl: required("GITHUB_SERVER_URL"), repo, token }),
  ]);
  const given: LaterReviewGiven = { headSha, lastJudgedHead: lastJudged.headSha, ...thread, changeSince };
  await writeFile(join(outDir, LATER_REVIEW_FILE), JSON.stringify(given));
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    console.error("Usage: node src/agent/laterReview.ts <out dir>");
    process.exitCode = 2;
  } else {
    main(outDir).catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      await reportFailure(error, process.env["FABRIK_OUT_DIR"] ?? "");
    });
  }
}
