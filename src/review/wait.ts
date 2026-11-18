// The Review's checks job: waits for an agent PR's required checks to finish
// on its head, and tells the workflow how they ended. It holds only a
// read-only token and runs none of the PR's code. It logs what it waits on
// whenever that changes, and every few minutes while it doesn't, and gives up
// a few minutes short of its job's timeout (the Review timeout), or at once
// when the PR conflicts with its base and a Required check hasn't reported:
// GitHub starts no `pull_request` workflow on a PR it can't merge, so that
// check never will (#704). It waits on
// the Required checks: those the Kit config lists plus any the default branch
// requires, the branch's list read once before it starts (#565). Giving up, or
// any error, fails the job and leaves a failure report for the push job's
// notice: a Required check that never reported is named, as no re-run fixes it,
// with the head it waited on, for how long, and whether the PR merged cleanly.
//   node src/review/wait.ts <product checkout>
// Env: GH_TOKEN (read-only, `contents: read` enough for the branch), GITHUB_REPOSITORY, FABRIK_PULL_REQUEST, GITHUB_OUTPUT,
//   FABRIK_REVIEW_TIMEOUT_MINUTES (the job's timeout), FABRIK_OUT_DIR (where the failure report and the Failure excerpts go).
// Writes step outputs:
//   checks   "green", "red", or "stale" when the PR moved on, closed or left draft while waiting
//   head-sha the commit the checks ran on
//   failed   the required checks that failed or were cancelled, as a JSON list
//   ran-nothing on green, the ones that passed only by being skipped or reporting
//            neutral, as a JSON list, which the Reviewer and the Digest are told
//            and the step summary names
//   red      on red, the ones the Kit can re-run and the outside ones (src/review/rerun.ts), as JSON
//   main     on red, each red check's result on the default branch's head, as JSON, for the
//            Reviewer to judge whether the PR caused it (#780): read once, before anything is re-run
// After the Kit re-ran red checks (#462), the same wait runs again as the Re-run
// checks' wait, given FABRIK_RERUN (the re-run checks, as the red output named
// them), FABRIK_RERUN_AT and FABRIK_HEAD_SHA: it waits until the re-run checks
// have reported again on that head, and then for every check it waits on, and also writes
//   failed-again the re-run checks that failed again, as a JSON list
//   flaky        the re-run checks that passed, with their red and green runs, as JSON
// A wait that ends red also leaves, in FABRIK_OUT_DIR, the Failure excerpt of
// each red check (src/review/failureExcerpt.ts, #775) for the push job's
// Verdict: the first wait every red one's, before anything is re-run, an
// outside service's among them (#777), and the Re-run checks' wait those that
// failed again. It reads them with the same token, whose `actions: read`,
// `checks: read` and `statuses: read` its job holds.
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { GitHub } from "../github/client.ts";
import type { MergeableState } from "../github/snapshot.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { checkCode } from "./failureExcerpt.ts";
import type { FailureReport } from "../loop/types.ts";
import { type BranchRequiredChecks, type DefaultBranchHeadChecks, readDefaultBranchHeadChecks, readDefaultBranchRequiredChecks } from "../read/requiredChecks.ts";
import { type ChecksOutcome, checksFromGh, requiredChecksOutcome } from "./checks.ts";
import {
  FAILURE_EXCERPTS_FILE,
  type FailureExcerpt,
  type FailureReader,
  failureReaderOf,
  readFailureExcerpt,
  RERUN_FAILURE_EXCERPTS_FILE,
} from "./failureExcerpt.ts";
import { type CheckDetail, type RerunnableCheck, redChecksOf, rerunOutcome, settledChecksOutcome } from "./rerun.ts";

const run = promisify(execFile);

/** Long enough for a fresh push's check suites to register before an empty list counts as nothing to wait on. */
const SETTLE_MS = 60_000;
const POLL_MS = 30_000;
/** How often it says what it waits on while that doesn't change. */
const LOG_EVERY_MS = 5 * 60_000;
/** How far short of the job's timeout it gives up, leaving the job time to pass out its failure report. */
const TIMEOUT_MARGIN_MS = 3 * 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function gh(...args: string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await run("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, failed: false };
  } catch (error) {
    // `gh pr checks` exits non-zero while checks are pending or failed, still printing them.
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: true };
  }
}

export interface PullRequestState {
  readonly headRefOid: string;
  readonly isDraft: boolean;
  readonly state: string;
  /** Whether GitHub can merge it into its base: UNKNOWN while GitHub is still working that out. */
  readonly mergeable: MergeableState;
}

async function pullRequestState(repo: string, number: string): Promise<PullRequestState> {
  const { stdout, stderr, failed } = await gh("pr", "view", number, "--repo", repo, "--json", "headRefOid,isDraft,mergeable,state");
  if (failed) throw new Error(`gh pr view failed: ${stderr.trim() || "no output"}`);
  return JSON.parse(stdout) as PullRequestState;
}

/** Every check on the PR's head; which of them gate it is the Required checks' to say. */
async function checksOf(repo: string, number: string): Promise<CheckDetail[]> {
  return checksFromGh(await gh("pr", "checks", number, "--repo", repo, "--json", "name,bucket,link,workflow,startedAt")) as CheckDetail[];
}

/**
 * The Required checks a wait waits on, resolved before it starts: the default
 * branch's own list, then any the Kit config lists beyond it. GitHub holds
 * the merge to the branch's list, so a branch that can't be read fails as
 * unread checks, never falling back to the Kit config's list alone.
 */
export async function requiredChecksToWaitOn(readBranch: () => Promise<BranchRequiredChecks>, listedChecks: readonly string[]): Promise<string[]> {
  const branch = await whileWaiting(readBranch);
  if (branch.kind === "unread") throw new WaitError(`Couldn't read the default branch's Required checks: ${branch.why}`);
  return [...new Set([...branch.required, ...listedChecks])];
}

/** What the wait reads from GitHub: the PR's state, its mergeable state among it, and its head's checks. */
export interface ChecksWaitGitHub {
  pullRequestState(): Promise<PullRequestState>;
  checks(): Promise<CheckDetail[]>;
}

export interface ChecksWaitOptions {
  /** The Required checks, as requiredChecksToWaitOn resolves them: those the Kit config lists plus any the default branch requires. Empty, nothing gates the PR. */
  readonly requiredChecks: readonly string[];
  /** How long it waits, from its start, before it gives up. */
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** The head it waits on, when an earlier job named it: the PR having moved off it makes the wait stale. */
  readonly headSha?: string;
  /** How the checks it reads have ended; requiredChecksOutcome when not given. */
  readonly outcome?: (checks: readonly CheckDetail[], requiredChecks: readonly string[]) => ChecksOutcome;
}

/**
 * How the wait ended. It gives up at its deadline, naming the Required checks
 * that never reported and those still running, how long it waited, and the
 * last mergeable state it read (null when GitHub hadn't worked it out). It
 * stops at once as `conflicting` when the PR conflicts with its base while a
 * Required check hasn't reported, naming those that hadn't.
 */
export type ChecksWaitOutcome =
  | { readonly checks: "stale"; readonly headSha: string }
  /** `ranNothing`: the checks that passed only by being skipped or reporting neutral. */
  | { readonly checks: "green"; readonly headSha: string; readonly ranNothing: readonly string[] }
  | { readonly checks: "red"; readonly headSha: string; readonly failed: readonly string[] }
  | {
      readonly checks: "gave-up";
      readonly headSha: string;
      readonly unreported: readonly string[];
      readonly running: readonly string[];
      readonly waitedMinutes: number;
      readonly mergeable: boolean | null;
    }
  | { readonly checks: "conflicting"; readonly headSha: string; readonly unreported: readonly string[]; readonly waitedMinutes: number };

/** The checks it waits on, as its log names them. */
function waitingOn(unreported: readonly string[], running: readonly string[]): string {
  const checks = [
    ...running.map((name) => ({ name, how: "running" })),
    ...unreported.map((name) => ({ name, how: "not reported yet" })),
  ];
  return checks
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, how }) => `${name} (${how})`)
    .join(", ");
}

/** Thrown when a GitHub request fails as it reads the Required checks or waits on them, as opposed to any other error before it starts, so its report says so. */
export class WaitError extends Error {
  override name = "WaitError";
}

/** A GitHub read the wait makes, its failure thrown as a WaitError. */
async function whileWaiting<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new WaitError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Waits for the PR's Required checks on the head it started at: polls until
 * they all passed or one didn't, the PR moves on, or its deadline passes. A
 * check on the head that isn't Required never gates it. On a PR that
 * conflicts with its base, a Required check that hasn't reported never will,
 * so it stops then; checks that started before the base moved still finish,
 * and while every one has reported or runs, it waits on them as on any PR.
 */
export async function waitForRequiredChecks(github: ChecksWaitGitHub, options: ChecksWaitOptions): Promise<ChecksWaitOutcome> {
  const { requiredChecks, deadlineMs, now, sleep, log, outcome = requiredChecksOutcome } = options;
  const started = now();
  const headSha = options.headSha ?? (await whileWaiting(() => github.pullRequestState())).headRefOid;
  await sleep(SETTLE_MS);
  let said = "";
  let saidAt = started;
  for (;;) {
    const state = await whileWaiting(() => github.pullRequestState());
    if (state.headRefOid !== headSha || state.state !== "OPEN" || !state.isDraft) return { checks: "stale", headSha };
    const result = outcome(await whileWaiting(() => github.checks()), requiredChecks);
    if (result.kind === "green") return { checks: "green", headSha, ranNothing: result.ranNothing };
    if (result.kind === "red") return { checks: "red", headSha, failed: result.failed };
    const line = waitingOn(result.unreported, result.running);
    const waitedMinutes = Math.round((now() - started) / 60_000);
    if (state.mergeable === "CONFLICTING" && result.unreported.length > 0) {
      log(`Stopped waiting after ${minutes(waitedMinutes)}: the PR conflicts with its base, so GitHub won't start ${result.unreported.join(", ")} on this head`);
      return { checks: "conflicting", headSha, unreported: result.unreported, waitedMinutes };
    }
    if (now() - started >= deadlineMs) {
      log(`Gave up waiting after ${Math.round(deadlineMs / 60_000)} minutes, still waiting on ${line}`);
      return { checks: "gave-up", headSha, unreported: result.unreported, running: result.running, waitedMinutes, mergeable: mergeableOf(state.mergeable) };
    }
    if (line !== said || now() - saidAt >= LOG_EVERY_MS) {
      log(`Waiting on ${line}`);
      said = line;
      saidAt = now();
    }
    await sleep(POLL_MS);
  }
}

/**
 * Whether the PR merges cleanly, as the Loop's snapshot reads it (mergeableOf
 * in src/github/snapshot.ts, whose module this job doesn't load): null while
 * GitHub is still working it out.
 */
function mergeableOf(state: MergeableState): boolean | null {
  return state === "UNKNOWN" ? null : state === "MERGEABLE";
}

/** A whole number of minutes, as the wait's log says it. */
function minutes(count: number): string {
  return `${count} minute${count === 1 ? "" : "s"}`;
}

/**
 * The failure report a wait that gave up leaves for the push job's notice: the
 * Required checks that never reported, if any did not, as no re-run fixes those,
 * with the head, how long it waited and whether the PR merged cleanly, for the
 * notice to say what most likely kept them from starting; else a timeout naming
 * the checks still running.
 */
export function gaveUpReport(outcome: Extract<ChecksWaitOutcome, { checks: "gave-up" }>): FailureReport {
  if (outcome.unreported.length === 0) return { failure: "timeout", detail: "", checks: outcome.running };
  const { headSha, waitedMinutes, mergeable } = outcome;
  return { failure: "unreported-checks", detail: "", checks: outcome.unreported, headSha, waitedMinutes, mergeable };
}

/**
 * The failure report a wait that stopped on a conflict leaves (#704): the
 * Required checks GitHub won't start on the head, for the Loop to bring the
 * PR up to date with its base (ADR-0028).
 */
export function conflictReport({ headSha, unreported, waitedMinutes }: Extract<ChecksWaitOutcome, { checks: "conflicting" }>): FailureReport {
  return { failure: "merge-conflict", detail: "", checks: unreported, headSha, waitedMinutes, mergeable: false };
}

async function leaveFailureReport(report: FailureReport): Promise<void> {
  const outDir = process.env["FABRIK_OUT_DIR"] ?? "";
  if (outDir === "") return;
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, AGENT_FAILURE_FILE), JSON.stringify(report));
}

/** The failure report an error leaves: a GitHub request that failed mid-wait names the wait, with its error; anything else is a crash, with its message. */
export function errorReport(error: unknown): FailureReport {
  const message = error instanceof Error ? error.message : String(error);
  return { failure: error instanceof WaitError ? "unread-checks" : "crash", detail: message };
}

async function main(productDir: string): Promise<void> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) throw new Error(`The Kit config is invalid:\n${resolved.errors.map((e) => `- ${e}`).join("\n")}`);
  const repo = required("GITHUB_REPOSITORY");
  const number = required("FABRIK_PULL_REQUEST");
  const client = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  const timeoutMinutes = Number(required("FABRIK_REVIEW_TIMEOUT_MINUTES"));
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) throw new Error("FABRIK_REVIEW_TIMEOUT_MINUTES is not a whole number of minutes");

  const rerun = rerunOf(process.env["FABRIK_RERUN"]);
  const rerunAt = process.env["FABRIK_RERUN_AT"] ?? "";
  let last: CheckDetail[] = [];
  const requiredChecks = await requiredChecksToWaitOn(() => readDefaultBranchRequiredChecks(client, repo), resolved.config.sandbox.checks);
  console.log(`Waits on the Required checks ${requiredChecks.length === 0 ? "(none)" : requiredChecks.join(", ")}`);
  const outcome = await waitForRequiredChecks(
    {
      pullRequestState: () => pullRequestState(repo, number),
      checks: async () => (last = await checksOf(repo, number)),
    },
    {
      requiredChecks,
      ...(rerun === null ? {} : { headSha: required("FABRIK_HEAD_SHA"), outcome: (checks, requiredChecks) => settledChecksOutcome(checks, requiredChecks, { rerun: rerun.map(({ name }) => name), rerunAt }) }),
      deadlineMs: Math.max(timeoutMinutes * 60_000 - TIMEOUT_MARGIN_MS, SETTLE_MS),
      now: Date.now,
      sleep: (ms) => sleep(ms),
      log: (line) => console.log(line),
    },
  );
  if (outcome.checks === "gave-up" || outcome.checks === "conflicting") {
    await leaveFailureReport(outcome.checks === "gave-up" ? gaveUpReport(outcome) : conflictReport(outcome));
    process.exitCode = 1;
    return;
  }
  const failed = outcome.checks === "red" ? outcome.failed : [];
  const ranNothing = outcome.checks === "green" ? outcome.ranNothing : [];
  console.log(`Required checks on #${number} at ${outcome.headSha}: ${outcome.checks}${failed.length > 0 ? ` (${failed.join(", ")})` : ""}`);
  const lines = [`checks=${outcome.checks}`, `head-sha=${outcome.headSha}`, `failed=${JSON.stringify(failed)}`, `ran-nothing=${JSON.stringify(ranNothing)}`];
  const summary = ranNothingLine(ranNothing);
  if (summary !== null) {
    console.log(summary);
    const stepSummary = process.env["GITHUB_STEP_SUMMARY"] ?? "";
    if (stepSummary !== "") await appendFile(stepSummary, `${summary}\n`);
  }
  // The workflow token holds Actions: read, Checks: read and Commit statuses: read.
  const reader = failureReaderOf(repo, { actions: client, checks: client, statuses: client });
  if (rerun === null && outcome.checks === "red") {
    const red = redChecksOf(last, failed);
    console.log(`The Kit can re-run ${red.rerun.length === 0 ? "none of them" : red.rerun.map(({ name }) => name).join(", ")}`);
    lines.push(`red=${JSON.stringify(red)}`, `main=${JSON.stringify(await onMain(() => readDefaultBranchHeadChecks(client, repo, failed, "check-runs-and-statuses")))}`);
    // Before anything is re-run (#775): the re-run may leave the first attempt's job readable only by its own id.
    await leaveExcerpts(FAILURE_EXCERPTS_FILE, () => redExcerpts(last, failed, outcome.headSha, reader));
  }
  if (rerun !== null && outcome.checks !== "stale") {
    const { failedAgain, flaky } = rerunOutcome(rerun, last);
    lines.push(`failed-again=${JSON.stringify(failedAgain)}`, `flaky=${JSON.stringify(flaky)}`);
    if (outcome.checks === "red") await leaveExcerpts(RERUN_FAILURE_EXCERPTS_FILE, () => redExcerpts(last, failedAgain, outcome.headSha, reader));
  }
  await appendFile(required("GITHUB_OUTPUT"), `${lines.join("\n")}\n`);
}

/**
 * The Failure excerpts a wait that ended red passes out (#775): one for each
 * of `names` that is a red check on the head. A GitHub Actions one is read
 * from the job its link names now. The first wait reads every red check
 * before anything is re-run, as a re-run may replace what its link reads;
 * the wait after the re-run reads those that failed again, whose links are
 * the re-run's jobs. A red check from an outside service, which the Kit
 * never re-runs, is read for what the service wrote to GitHub (#777).
 */
export async function redExcerpts(checks: readonly CheckDetail[], names: readonly string[], sha: string, reader: FailureReader): Promise<FailureExcerpt[]> {
  const excerpts: FailureExcerpt[] = [];
  const { rerun, outside } = redChecksOf(checks, names);
  for (const { name, link } of rerun) excerpts.push(await readFailureExcerpt({ name, link, sha }, reader));
  for (const name of outside) {
    const link = checks.find((check) => check.name === name && (check.bucket === "fail" || check.bucket === "cancel"))?.link ?? "";
    excerpts.push(await readFailureExcerpt({ name, link, sha }, reader));
  }
  return excerpts;
}

/**
 * The red checks' results on the default branch's head (#780). Never fails
 * the wait: an error reads as unread, and the Reviewer is told why.
 */
async function onMain(read: () => Promise<DefaultBranchHeadChecks>): Promise<DefaultBranchHeadChecks> {
  try {
    const result = await read();
    console.log(
      result.kind === "read"
        ? `On ${result.branch}'s head, ${result.sha.slice(0, 7)}: ${result.checks.map(({ name, is }) => `${name} ${is}`).join(", ")}`
        : `Couldn't read the red checks on the default branch's head: ${result.why}`,
    );
    return result;
  } catch (error) {
    return { kind: "unread", why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Passes out the excerpts in FABRIK_OUT_DIR, which the job uploads for the
 * push job. Never fails the wait: a Verdict whose excerpts are missing says
 * under each check that its failure couldn't be read.
 */
async function leaveExcerpts(file: string, read: () => Promise<FailureExcerpt[]>): Promise<void> {
  const outDir = process.env["FABRIK_OUT_DIR"] ?? "";
  if (outDir === "") return;
  try {
    const excerpts = await read();
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, file), JSON.stringify(excerpts));
    console.log(`Read the Failure excerpt of ${excerpts.length === 0 ? "no check" : excerpts.map(({ check }) => check).join(", ")}`);
  } catch (error) {
    console.log(`Couldn't pass out the Failure excerpts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The step summary's line on green checks some of which ran nothing: they
 * passed by being skipped or reporting neutral, as GitHub's merge passes them,
 * so the pass says nothing of what they would have checked. Null when none did.
 */
export function ranNothingLine(ranNothing: readonly string[]): string | null {
  if (ranNothing.length === 0) return null;
  const names = ranNothing.map(checkCode).join(", ");
  return `These Required checks were skipped or reported neutral, so they passed but ran nothing on this head: ${names}`;
}

/** The re-run checks the Re-run checks' wait is given, or null for the first wait. */
function rerunOf(text: string | undefined): RerunnableCheck[] | null {
  if (text === undefined || text === "") return null;
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("FABRIK_RERUN is not a list of re-run checks");
  return value as RerunnableCheck[];
}

if (import.meta.main) {
  const productDir = process.argv[2];
  if (productDir === undefined) {
    console.error("Usage: node src/review/wait.ts <product checkout>");
    process.exitCode = 2;
  } else {
    main(productDir).catch(async (error: unknown) => {
      const report = errorReport(error);
      console.error(report.detail);
      process.exitCode = 1;
      await leaveFailureReport(report);
    });
  }
}
