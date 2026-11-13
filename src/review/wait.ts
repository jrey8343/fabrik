// The Review's checks job: waits for an agent PR's required checks to finish
// on its head, and tells the workflow how they ended. It holds only a
// read-only token and runs none of the PR's code. It logs what it waits on
// whenever that changes, and every few minutes while it doesn't, and gives up
// a few minutes short of its job's timeout (the Review timeout). It waits on
// the Required checks: those the Kit config lists plus any the default branch
// requires, the branch's list read once before it starts (#565). Giving up, or
// any error, fails the job and leaves a failure report for the push job's
// notice: a Required check that never reported is named, as no re-run fixes it.
//   node src/review/wait.ts <product checkout>
// Env: GH_TOKEN (read-only, `contents: read` enough for the branch), GITHUB_REPOSITORY, FABRIK_PULL_REQUEST, GITHUB_OUTPUT,
//   FABRIK_REVIEW_TIMEOUT_MINUTES (the job's timeout), FABRIK_OUT_DIR (where the failure report goes).
// Writes step outputs:
//   checks   "green", "red", or "stale" when the PR moved on, closed or left draft while waiting
//   head-sha the commit the checks ran on
//   failed   the required checks that failed or were cancelled, as a JSON list
//   ran-nothing on green, the ones that passed only by being skipped or reporting
//            neutral, as a JSON list, which the Reviewer and the Digest are told
//            and the step summary names
//   red      on red, the ones the Kit can re-run and the outside ones (src/review/rerun.ts), as JSON
// After the Kit re-ran red checks (#462), the same wait runs again as the Re-run
// checks' wait, given FABRIK_RERUN (the re-run checks, as the red output named
// them), FABRIK_RERUN_AT and FABRIK_HEAD_SHA: it waits until the re-run checks
// have reported again on that head, and then for every check it waits on, and also writes
//   failed-again the re-run checks that failed again, as a JSON list
//   flaky        the re-run checks that passed, with their red and green runs, as JSON
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { GitHub } from "../github/client.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { checkCode } from "../loop/flakyChecks.ts";
import type { FailureReport } from "../loop/types.ts";
import { type BranchRequiredChecks, readDefaultBranchRequiredChecks } from "../read/requiredChecks.ts";
import { type ChecksOutcome, checksFromGh, requiredChecksOutcome } from "./checks.ts";
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
}

async function pullRequestState(repo: string, number: string): Promise<PullRequestState> {
  const { stdout, stderr, failed } = await gh("pr", "view", number, "--repo", repo, "--json", "headRefOid,isDraft,state");
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

/** What the wait reads from GitHub: the PR's state, and its head's checks. */
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

/** How the wait ended. It gives up at its deadline, naming the Required checks that never reported and those still running. */
export type ChecksWaitOutcome =
  | { readonly checks: "stale"; readonly headSha: string }
  /** `ranNothing`: the checks that passed only by being skipped or reporting neutral. */
  | { readonly checks: "green"; readonly headSha: string; readonly ranNothing: readonly string[] }
  | { readonly checks: "red"; readonly headSha: string; readonly failed: readonly string[] }
  | { readonly checks: "gave-up"; readonly headSha: string; readonly unreported: readonly string[]; readonly running: readonly string[] };

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
 * check on the head that isn't Required never gates it.
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
    if (now() - started >= deadlineMs) {
      log(`Gave up waiting after ${Math.round(deadlineMs / 60_000)} minutes, still waiting on ${line}`);
      return { checks: "gave-up", headSha, unreported: result.unreported, running: result.running };
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
 * The failure report a wait that gave up leaves for the push job's notice: the
 * Required checks that never reported, if any did not, as no re-run fixes those;
 * else a timeout naming the checks still running.
 */
export function gaveUpReport(outcome: Extract<ChecksWaitOutcome, { checks: "gave-up" }>): FailureReport {
  if (outcome.unreported.length > 0) return { failure: "unreported-checks", detail: "", checks: outcome.unreported };
  return { failure: "timeout", detail: "", checks: outcome.running };
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
  if (outcome.checks === "gave-up") {
    await leaveFailureReport(gaveUpReport(outcome));
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
  if (rerun === null && outcome.checks === "red") {
    const red = redChecksOf(last, failed);
    console.log(`The Kit can re-run ${red.rerun.length === 0 ? "none of them" : red.rerun.map(({ name }) => name).join(", ")}`);
    lines.push(`red=${JSON.stringify(red)}`);
  }
  if (rerun !== null && outcome.checks !== "stale") {
    const { failedAgain, flaky } = rerunOutcome(rerun, last);
    lines.push(`failed-again=${JSON.stringify(failedAgain)}`, `flaky=${JSON.stringify(flaky)}`);
  }
  await appendFile(required("GITHUB_OUTPUT"), `${lines.join("\n")}\n`);
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
