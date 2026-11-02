// Whether an agent PR's required checks have finished, and how. The Review job
// waits on this before the Reviewer runs: red checks are an Execution flaw and
// the Reviewer never starts. Pure, no I/O.

/** One check on the PR's head, as `gh pr checks --json name,bucket` reports it. */
export interface CheckState {
  readonly name: string;
  readonly bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

export type ChecksOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "green" }
  | { readonly kind: "red"; readonly failed: readonly string[] };

/**
 * The outcome of the checks that gate the PR: the Kit config's gating checks
 * when it lists any, else every check given (the branch protection's required
 * ones). A skipped or cancelled check never counts as a pass, and a gating
 * check that hasn't reported yet is still pending. With nothing gating the
 * PR, the checks are green.
 */
export function requiredChecksOutcome(checks: readonly CheckState[], gating: readonly string[]): ChecksOutcome {
  const gate = gating.length === 0 ? checks : checks.filter((check) => gating.includes(check.name));
  const failed = gate.filter((check) => check.bucket === "fail" || check.bucket === "cancel" || check.bucket === "skipping");
  if (failed.length > 0) return { kind: "red", failed: [...new Set(failed.map((check) => check.name))] };
  const unreported = gating.some((name) => !checks.some((check) => check.name === name));
  if (unreported || gate.some((check) => check.bucket === "pending")) return { kind: "pending" };
  return { kind: "green" };
}
