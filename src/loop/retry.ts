// Execution-flaw retries: an Execution flaw on an agent PR re-runs the
// Implementer on the same branch with the findings as input, then Review runs
// again. Retries are counted from the PR's earlier Verdict comments alone, and
// stay silent: no mention, assignment or review request.
import { whyNotReviewable } from "./agentPullRequest.ts";
import type { Action, KitConfig, Plan, PullRequestSnapshot, VerdictRecord } from "./types.ts";

/** The label on an agent PR that starts its retry, so re-adding it resumes one after an Infrastructure failure. */
export const RETRY_LABEL = "agent:retry";

/** Execution-flaw retries a Ticket gets before the next flaw counts as a Design flaw. */
export const MAX_RETRIES = 2;

/**
 * Which retry an Execution flaw calls for, given the Verdicts posted before it:
 * one more than the earlier Execution flaws. Verdicts from a Request-changes
 * run don't count, and an Infrastructure failure posts no Verdict at all.
 */
export function retryNumber(earlier: readonly VerdictRecord[]): number {
  return 1 + earlier.filter((record) => record.verdict === "execution-flaw" && !record.requestChanges).length;
}

/** What an Execution flaw on this PR does next: its retry, if one is left, and a line saying so. */
export function retryAfterFlaw(pullRequest: PullRequestSnapshot): { readonly line: string; readonly actions: Action[] } {
  const retry = retryNumber(pullRequest.verdicts);
  if (retry > MAX_RETRIES) {
    return { line: `This PR has used its ${MAX_RETRIES} retries, so the Implementer doesn't run again.`, actions: [] };
  }
  return {
    line: `Retry ${retry} of ${MAX_RETRIES} starts now${retry === MAX_RETRIES ? ", stepped up" : ""}: the Implementer fixes these findings on the same branch.`,
    // A fresh label event starts the retry; the label is the PR's, so it notifies nobody.
    actions: [{ kind: "add-labels", issue: pullRequest.number, labels: [RETRY_LABEL] }],
  };
}

/**
 * agent:retry on an agent draft PR whose latest Verdict, on its head, is an
 * Execution flaw starts the Implementer on its branch. The first retry runs on
 * the Implementer's model and the second Steps up, for this PR only. The label
 * comes off as the run starts, so re-adding it after an Infrastructure failure
 * runs the same retry again: that failure posted no Verdict, so used none up.
 */
export function startRetry(pullRequest: PullRequestSnapshot, config: KitConfig): Plan {
  const removeLabel: Action = { kind: "remove-label", issue: pullRequest.number, label: RETRY_LABEL };
  const why = whyNotRetryable(pullRequest);
  const ticket = pullRequest.ticket;
  if (why !== null || ticket === null) {
    // The label still comes off, so it never sits there claiming a retry that isn't running.
    return { kind: "act", actions: [removeLabel] };
  }
  const { implement, stepUp } = config.roles;
  // Never a cheaper model, and never a skipped Step-up, whatever the weekly pool says.
  const { model, effort } = retryNumber(pullRequest.verdicts.slice(0, -1)) === MAX_RETRIES ? stepUp : implement;
  return {
    kind: "act",
    actions: [
      removeLabel,
      {
        kind: "start-agent-run",
        role: "implement",
        issue: ticket,
        pullRequest: pullRequest.number,
        model,
        effort,
        timeoutMinutes: implement.timeoutMinutes,
      },
    ],
  };
}

/** Why this PR has no retry to run now, or null when it has. */
function whyNotRetryable(pullRequest: PullRequestSnapshot): string | null {
  const why = whyNotReviewable(pullRequest);
  if (why !== null) return why;
  const latest = pullRequest.verdicts.at(-1);
  if (latest === undefined) return `#${pullRequest.number} has no Verdict to fix`;
  if (latest.verdict !== "execution-flaw") return `#${pullRequest.number}'s latest Verdict isn't an Execution flaw`;
  if (latest.headSha !== pullRequest.headSha) return `#${pullRequest.number} has moved on from its Execution flaw`;
  if (retryNumber(pullRequest.verdicts.slice(0, -1)) > MAX_RETRIES) {
    return `#${pullRequest.number} has used its ${MAX_RETRIES} retries`;
  }
  return null;
}
