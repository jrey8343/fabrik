// The Review's checks job: waits for an agent PR's required checks to finish
// on its head, and tells the workflow how they ended. It holds only a
// read-only token and runs none of the PR's code. It logs what it waits on
// whenever that changes, and every few minutes while it doesn't, and gives up
// a few minutes short of its job's timeout (the Review timeout). Giving up, or
// any error, fails the job and leaves a failure report for the push job's
// notice: a Required check the Kit config lists that never reported is named,
// as no re-run fixes it.
//   node src/review/wait.ts <product checkout>
// Env: GH_TOKEN (read-only), GITHUB_REPOSITORY, FABRIK_PULL_REQUEST, GITHUB_OUTPUT,
//   FABRIK_REVIEW_TIMEOUT_MINUTES (the job's timeout), FABRIK_OUT_DIR (where the failure report goes).
// Writes step outputs:
//   checks   "green", "red", or "stale" when the PR moved on, closed or left draft while waiting
//   head-sha the commit the checks ran on
//   failed   the required checks that didn't pass, as a JSON list
//   skipped  the ones among them skipped or reported neutral, as a JSON list
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
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import type { FailureReport } from "../loop/types.ts";
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

/** The PR head's checks: every one when the Kit config lists Required checks, else only the required ones. */
async function checksOf(repo: string, number: string, listedChecks: readonly string[]): Promise<CheckDetail[]> {
  const args = ["pr", "checks", number, "--repo", repo, "--json", "name,bucket,link,workflow,startedAt"];
  return checksFromGh(await gh(...args, ...(listedChecks.length === 0 ? ["--required"] : []))) as CheckDetail[];
}

/** What the wait reads from GitHub: the PR's state, and its head's checks. */
export interface ChecksWaitGitHub {
  pullRequestState(): Promise<PullRequestState>;
  checks(): Promise<CheckDetail[]>;
}

export interface ChecksWaitOptions {
  /** The Required checks the Kit config lists; empty for the branch protection's required ones. */
  readonly listedChecks: readonly string[];
  /** How long it waits, from its start, before it gives up. */
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** The head it waits on, when an earlier job named it: the PR having moved off it makes the wait stale. */
  readonly headSha?: string;
  /** How the checks it reads have ended; requiredChecksOutcome when not given. */
  readonly outcome?: (checks: readonly CheckDetail[], listedChecks: readonly string[]) => ChecksOutcome;
}

/** How the wait ended. It gives up at its deadline, naming the listed checks that never reported and those still running. */
export type ChecksWaitOutcome =
  | { readonly checks: "green" | "stale"; readonly headSha: string }
  | { readonly checks: "red"; readonly headSha: string; readonly failed: readonly string[]; readonly skipped: readonly string[] }
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

/** Thrown when a GitHub request fails while it waits, as opposed to before it started, so its report says it was waiting. */
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
 * Waits for the PR's checks on the head it started at, the Required checks
 * the Kit config lists or else the branch's required ones: polls until they
 * all passed or one didn't, the PR moves on, or its deadline passes.
 */
export async function waitForRequiredChecks(github: ChecksWaitGitHub, options: ChecksWaitOptions): Promise<ChecksWaitOutcome> {
  const { listedChecks, deadlineMs, now, sleep, log, outcome = requiredChecksOutcome } = options;
  const started = now();
  const headSha = options.headSha ?? (await whileWaiting(() => github.pullRequestState())).headRefOid;
  await sleep(SETTLE_MS);
  let said = "";
  let saidAt = started;
  for (;;) {
    const state = await whileWaiting(() => github.pullRequestState());
    if (state.headRefOid !== headSha || state.state !== "OPEN" || !state.isDraft) return { checks: "stale", headSha };
    const result = outcome(await whileWaiting(() => github.checks()), listedChecks);
    if (result.kind === "green") return { checks: "green", headSha };
    if (result.kind === "red") return { checks: "red", headSha, failed: result.failed, skipped: result.skipped };
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
 * listed checks that never reported, if any did not, as no re-run fixes those;
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
  const listedChecks = resolved.config.sandbox.checks;
  const repo = required("GITHUB_REPOSITORY");
  const number = required("FABRIK_PULL_REQUEST");
  const timeoutMinutes = Number(required("FABRIK_REVIEW_TIMEOUT_MINUTES"));
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) throw new Error("FABRIK_REVIEW_TIMEOUT_MINUTES is not a whole number of minutes");

  const rerun = rerunOf(process.env["FABRIK_RERUN"]);
  const rerunAt = process.env["FABRIK_RERUN_AT"] ?? "";
  let last: CheckDetail[] = [];
  const outcome = await waitForRequiredChecks(
    {
      pullRequestState: () => pullRequestState(repo, number),
      checks: async () => (last = await checksOf(repo, number, listedChecks)),
    },
    {
      listedChecks,
      ...(rerun === null ? {} : { headSha: required("FABRIK_HEAD_SHA"), outcome: (checks, listed) => settledChecksOutcome(checks, listed, { rerun: rerun.map(({ name }) => name), rerunAt }) }),
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
  const skipped = outcome.checks === "red" ? outcome.skipped : [];
  console.log(`Required checks on #${number} at ${outcome.headSha}: ${outcome.checks}${failed.length > 0 ? ` (${failed.join(", ")})` : ""}`);
  const lines = [`checks=${outcome.checks}`, `head-sha=${outcome.headSha}`, `failed=${JSON.stringify(failed)}`, `skipped=${JSON.stringify(skipped)}`];
  if (rerun === null && outcome.checks === "red") {
    const red = redChecksOf(last, failed, skipped);
    console.log(`The Kit can re-run ${red.rerun.length === 0 ? "none of them" : red.rerun.map(({ name }) => name).join(", ")}`);
    lines.push(`red=${JSON.stringify(red)}`);
  }
  if (rerun !== null && outcome.checks !== "stale") {
    const { failedAgain, flaky } = rerunOutcome(rerun, last);
    lines.push(`failed-again=${JSON.stringify(failedAgain)}`, `flaky=${JSON.stringify(flaky)}`);
  }
  await appendFile(required("GITHUB_OUTPUT"), `${lines.join("\n")}\n`);
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
