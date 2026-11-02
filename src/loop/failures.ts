// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it.
import type { AgentRole, InfrastructureFailure, KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** The label whose adding starts each role's agent job, so re-adding it resumes a stalled run. */
export const TRIGGER_LABELS: Readonly<Record<AgentRole, string>> = {
  triage: "needs-triage",
  design: "needs-design",
  implement: "agent:implement",
  review: "agent:review",
};

const ROLE_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
};

/** Which Infrastructure failure this was, from what the agent job left and how it ended. */
function classify(run: FailedRun): InfrastructureFailure {
  if (run.secretsStep === "failure") return "unreachable-1password";
  if (run.report !== null) return run.report.failure;
  return run.jobResult === "cancelled" ? "timeout" : "crash";
}

function howItFailed(failure: InfrastructureFailure, run: FailedRun, config: KitConfig): string {
  switch (failure) {
    case "timeout":
      return `it was cancelled, most likely by its ${config.roles[run.role].timeoutMinutes}-minute timeout`;
    case "unreachable-1password":
      return "its secrets couldn't be loaded from 1Password";
    case "crash":
      return "it crashed";
    case "missing-output":
      return run.role === "review" ? "the Reviewer gave no valid Verdict" : "the agent gave no valid output";
    case "provider-error":
      return "the model provider returned an error";
    case "dead-token":
      return "the Claude token was refused (`authentication_failed`), so it may need rotating";
    case "weekly-limit":
      return "it hit the weekly usage limit";
    case "metered-billing":
      return "the preflight found a route that would bill metered API usage, so it refused to start the agent";
  }
}

/** One comment, with the Operator's only @-mention, on the Ticket's PR if it has one, else the issue. */
export function failureNotice(run: FailedRun, { issue, operator }: Snapshot, config: KitConfig): Plan {
  const failure = classify(run);
  const label = TRIGGER_LABELS[run.role];
  const pullRequest = issue.openPullRequests[0];
  const target = pullRequest ?? run.issue;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? target : run.issue;
  const where = labelled === target ? "" : ` on #${labelled}`;
  const detail = run.report === null || run.report.detail.trim() === "" ? [] : ["", `> ${run.report.detail.trim()}`];
  const body = [
    `@${operator} The ${ROLE_NAMES[run.role]} run on #${run.issue} failed: ${howItFailed(failure, run, config)}.`,
    ...detail,
    "",
    `This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the \`${label}\` label${where} to run it again.`,
    "",
    `[The run](${run.runUrl})`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      // Off now, so that adding it back is a fresh label event that restarts the role.
      { kind: "remove-label", issue: labelled, label },
      { kind: "comment", issue: target, body },
    ],
  };
}
