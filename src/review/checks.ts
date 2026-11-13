// Whether an agent PR's required checks have finished, and how. The Review job
// waits on this before the Reviewer runs: red checks are an Execution flaw and
// the Reviewer never starts. Pure, no I/O.

/** One check on the PR's head, as `gh pr checks --json name,bucket` reports it. */
export interface CheckState {
  readonly name: string;
  readonly bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

export type ChecksOutcome =
  /** Still waiting: on Required checks the Kit config lists that haven't reported on the PR's head, and on checks still running. */
  | { readonly kind: "pending"; readonly unreported: readonly string[]; readonly running: readonly string[] }
  /** `ranNothing` names the checks it waits on that were only ever skipped or neutral: passed, though they checked nothing on this head. */
  | { readonly kind: "green"; readonly ranNothing: readonly string[] }
  /** `failed` names every check it waits on that failed or was cancelled. */
  | { readonly kind: "red"; readonly failed: readonly string[] };

/**
 * The outcome of the checks the Review waits on: the Required checks the Kit
 * config lists, when it lists any, else every check given (the branch
 * protection's required ones). As GitHub judges a merge, a check that
 * succeeded, was skipped or reported neutral has passed, and a cancelled one
 * is failing; a listed check that hasn't reported yet is still pending. With
 * nothing to wait on, the checks are green.
 */
export function requiredChecksOutcome(checks: readonly CheckState[], listedChecks: readonly string[]): ChecksOutcome {
  const gate = listedChecks.length === 0 ? checks : checks.filter((check) => listedChecks.includes(check.name));
  const failed = gate.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
  if (failed.length > 0) return { kind: "red", failed: [...new Set(failed.map((check) => check.name))] };
  const unreported = listedChecks.filter((name) => !checks.some((check) => check.name === name));
  const running = [...new Set(gate.filter((check) => check.bucket === "pending").map((check) => check.name))];
  if (unreported.length > 0 || running.length > 0) return { kind: "pending", unreported, running };
  const names = [...new Set(gate.map((check) => check.name))];
  const ranNothing = names.filter((name) => gate.every((check) => check.name !== name || check.bucket === "skipping"));
  return { kind: "green", ranNothing };
}

/** What a `gh pr checks --json name,bucket` run left behind. */
export interface GhChecksRun {
  readonly stdout: string;
  readonly stderr: string;
  /** gh exited non-zero, which it also does while checks are pending or failed. */
  readonly failed: boolean;
}

/**
 * The checks a `gh pr checks` run printed. gh exits non-zero while checks are
 * pending or failed but still prints them, and prints only an error when the
 * repo has no required checks, which means nothing gates the PR. Any other
 * failure that printed nothing is an error: reading it as "no checks" would
 * leave a listed check unreported, and the Review would wait out its timeout.
 */
export function checksFromGh(run: GhChecksRun): CheckState[] {
  if (run.stdout.trim() !== "") return JSON.parse(run.stdout) as CheckState[];
  if (!run.failed || /no required checks reported/i.test(run.stderr)) return [];
  throw new Error(`gh pr checks failed: ${run.stderr.trim() || "no output"}`);
}
