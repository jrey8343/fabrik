// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it. A
// failed Auditor run goes to failAudit instead, which fails its Audit with no
// trigger to re-add, since the scheduled tick opens the next one
// (src/loop/weeklyFailure.ts). The Kit doesn't land a failed Retro run yet.
import { repoWideNotice } from "./kitIssues.ts";
import { DISPATCH_LABEL, type Label, NEEDS_TRIAGE, REVIEW_LABEL } from "./labels.ts";
import { DESIGN_TURN_FAILED_MARKER } from "./markers.ts";
import type { AgentRole, InfrastructureFailure, IssueContext, KitConfig, LoopEvent, Plan } from "./types.ts";
import { failAudit } from "./weeklyFailure.ts";

type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/**
 * A role whose failed run gets a failure notice: a failed Auditor run fails
 * its Audit instead (src/loop/weeklyFailure.ts), and a failed Retro run gets nothing yet.
 */
type NoticedRole = Exclude<AgentRole, "audit" | "retro">;

/**
 * The label whose adding starts each role's agent job, so re-adding it
 * resumes a stalled run. A Design-session turn has none to re-add: its issue
 * keeps needs-design, its place in the Loop, and the Operator's reply starts
 * the turn again. agent:implement on a Ticket with an open agent PR resumes
 * that PR's retry or Request-changes run (src/loop/implement.ts).
 */
const TRIGGER_LABELS: Readonly<Record<Exclude<NoticedRole, "design">, Label>> = {
  triage: NEEDS_TRIAGE,
  implement: DISPATCH_LABEL,
  review: REVIEW_LABEL,
};

const ROLE_NAMES: Readonly<Record<NoticedRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
};

/**
 * Which Infrastructure failure this was, from what the agent job left and how
 * it ended. The Run record classifies with it too, so the two never disagree.
 */
export function infrastructureFailureOf(run: Pick<FailedRun, "secretsStep" | "report" | "jobResult">): InfrastructureFailure {
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

/**
 * One comment on the Ticket's PR if it has one, else the issue. It carries the
 * Operator's only @-mention, unless the failure stalls the whole repo: then a
 * Kit-owned issue does the notifying, once, and the comment points there.
 */
export function failureNotice(run: FailedRun, context: IssueContext, config: KitConfig): Plan {
  const { issue, operator } = context;
  const failure = infrastructureFailureOf(run);
  // The scheduled tick tries a failed Audit again, so there's no trigger label to re-add.
  if (run.role === "audit") {
    const how = howItFailed(failure, run, config);
    return failAudit(context, { failure, how, runUrl: run.runUrl, resetsAt: run.report?.resetsAt ?? null });
  }
  // Nothing opens a pending Retro yet, so no Retro run fails. Once one can, the tick tries it again, so it has no trigger label.
  if (run.role === "retro") {
    return { kind: "nothing", reason: `the Kit doesn't land a failed Retro run yet, so #${run.issue} stays as it is` };
  }
  const pullRequest = issue.openPullRequests[0];
  const target = pullRequest ?? run.issue;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? target : run.issue;
  const where = labelled === target ? "" : ` on #${labelled}`;
  const label = run.role === "design" ? null : TRIGGER_LABELS[run.role];
  const resume =
    label === null
      ? "Reply on this issue to run the turn again."
      : `Re-add the \`${label}\` label${where} to run it again.`;
  const detail = run.report === null || run.report.detail.trim() === "" ? [] : ["", `> ${run.report.detail.trim()}`];
  const failedRun = `The ${ROLE_NAMES[run.role]} run on #${run.issue}`;
  const repoWide = repoWideNotice(failure, context, {
    run: failedRun,
    runUrl: run.runUrl,
    resetsAt: run.report?.resetsAt ?? null,
  });
  const body = [
    ...(run.role === "design" ? [DESIGN_TURN_FAILED_MARKER] : []),
    `${repoWide === null ? `@${operator} ` : ""}${failedRun} failed: ${howItFailed(failure, run, config)}.`,
    ...detail,
    "",
    `This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. ${resume}`,
    ...(repoWide === null ? [] : ["", repoWide.pointer]),
    "",
    `[The run](${run.runUrl})`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      // Off now, so that adding it back is a fresh label event that restarts the role.
      ...(label === null ? [] : [{ kind: "remove-label" as const, issue: labelled, label }]),
      { kind: "comment", issue: target, body },
      ...(repoWide?.actions ?? []),
    ],
  };
}
