// Re-running red checks before a Verdict (#462, ADR-0018). When the Review's
// checks job finds red required checks, the Kit re-runs the failed jobs of the
// GitHub Actions ones once on the same head, and waits for them again: a check
// that passes then is a Flaky check, and gives no Verdict. A check from an
// outside service (Vercel, Buildkite, a commit status) only its owner can
// re-run, so it stands as it is. Pure, no I/O.
import type { FlakyCheck } from "../loop/types.ts";
import { type CheckState, type ChecksOutcome, requiredChecksOutcome } from "./checks.ts";

/** One check on the PR's head, as `gh pr checks --json name,bucket,link,workflow,startedAt` reports it. */
export interface CheckDetail extends CheckState {
  /** Where the check's run is: for a GitHub Actions check, its job in its workflow run. */
  readonly link: string;
  /** The workflow it ran in; empty for a check that isn't GitHub Actions. */
  readonly workflow: string;
  /** When it started, ISO 8601; empty or missing when GitHub gives none. */
  readonly startedAt?: string;
}

/** A red GitHub Actions check the Kit can re-run: its name, its job's link, and its workflow run. */
export interface RerunnableCheck {
  readonly name: string;
  readonly link: string;
  readonly run: number;
}


/** A GitHub Actions job's link: …/actions/runs/<run>/job/<job>. */
const ACTIONS_JOB = /\/actions\/runs\/(\d+)\/job\/\d+/;

/**
 * The red checks split by whether the Kit can re-run them: the GitHub Actions
 * ones, each with its workflow run, and the outside ones. A skipped or neutral
 * check is neither, as no re-run changes it.
 */
export function redChecksOf(
  checks: readonly CheckDetail[],
  failed: readonly string[],
  skipped: readonly string[],
): { rerun: RerunnableCheck[]; outside: string[] } {
  const rerun: RerunnableCheck[] = [];
  const outside: string[] = [];
  for (const name of failed.filter((name) => !skipped.includes(name))) {
    const red = checks.find((check) => check.name === name && (check.bucket === "fail" || check.bucket === "cancel"));
    const run = red === undefined || red.workflow === "" ? undefined : ACTIONS_JOB.exec(red.link)?.[1];
    if (red === undefined || run === undefined) outside.push(name);
    else rerun.push({ name, link: red.link, run: Number(run) });
  }
  return { rerun, outside };
}

/** The re-run checks, and when the Kit re-ran them, ISO 8601. */
export interface Rerun {
  readonly rerun: readonly string[];
  readonly rerunAt: string;
}

/**
 * The outcome of the checks the Review waits on after a re-run. A re-run
 * check that started before the re-run reads as it did then, so it's still
 * pending; and the outcome is red only once none of them is still running, as a re-run check
 * may yet pass beside an outside check that stays red.
 */
export function settledChecksOutcome(checks: readonly CheckDetail[], listedChecks: readonly string[], { rerun, rerunAt }: Rerun): ChecksOutcome {
  const since = Date.parse(rerunAt);
  const fresh = checks.map((check): CheckState => {
    const stale = rerun.includes(check.name) && !(Date.parse(check.startedAt ?? "") >= since);
    return { name: check.name, bucket: stale ? "pending" : check.bucket };
  });
  const outcome = requiredChecksOutcome(fresh, listedChecks);
  if (outcome.kind !== "red") return outcome;
  const gate = listedChecks.length === 0 ? fresh : fresh.filter((check) => listedChecks.includes(check.name));
  const running = [...new Set(gate.filter((check) => check.bucket === "pending").map((check) => check.name))];
  return running.length === 0 ? outcome : { kind: "pending", unreported: [], running };
}

/** What re-running these red checks came to, from the checks as they ended: the ones that failed again, and the flaky ones. */
export function rerunOutcome(red: readonly RerunnableCheck[], after: readonly CheckDetail[]): { failedAgain: string[]; flaky: FlakyCheck[] } {
  const failedAgain: string[] = [];
  const flaky: FlakyCheck[] = [];
  for (const { name, link } of red) {
    const now = after.filter((check) => check.name === name);
    const green = now.length > 0 && now.every((check) => check.bucket === "pass") ? now[0] : undefined;
    if (green === undefined) failedAgain.push(name);
    else flaky.push({ name, red: link, green: green.link });
  }
  return { failedAgain, flaky };
}

/**
 * Why GitHub refused to re-run a workflow run, from what `gh api` printed: a
 * token without `actions: write` names the line the caller workflow lacks;
 * anything else, as a run too old to re-run, gives GitHub's own words.
 */
export function whyNotRerun(stderr: string): string {
  const said = stderr.trim().replace(/^gh: /, "").replace(/\s*\(HTTP \d+\)$/, "").trim() || "no reason given";
  if (/resource not accessible by integration/i.test(said)) {
    return `GitHub refused the workflow token (${said}). Add \`actions: write\` under the \`loop\` job's \`permissions:\` in \`.github/workflows/fabrik.yml\``;
  }
  return `GitHub refused: ${said}`;
}
