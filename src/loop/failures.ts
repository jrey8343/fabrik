// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it. A
// failed Auditor run goes to failAudit instead, which fails its Audit with no
// trigger to re-add, since the scheduled tick opens the next one
// (src/loop/auditFailure.ts). With rotation on, a run refused on its
// Subscription's weekly limit is re-run once, quietly, through its trigger
// label while another Subscription is free, so the Operator hears nothing.
// Once none is free it is held instead, with no failure comment, and so is a
// refused Auditor run, whose Audit stays pending (src/loop/heldRun.ts).
import { isPendingAudit } from "./audit.ts";
import { failAudit } from "./auditFailure.ts";
import { type HeldRun, holding } from "./heldRun.ts";
import { anotherSubscriptionFree, refusedToken, repoWideNotice, type StalledRun } from "./kitIssues.ts";
import { DESIGN_LABEL, DISPATCH_LABEL, type Label, NEEDS_TRIAGE, REVIEW_LABEL } from "./labels.ts";
import { DESIGN_TURN_FAILED_MARKER } from "./markers.ts";
import { rotationIsOn, subscriptionOfRun } from "./subscriptions.ts";
import type { AgentRole, InfrastructureFailure, IssueContext, KitConfig, LoopEvent, Plan } from "./types.ts";

type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** A role whose failed run gets a failure notice: a failed Auditor run fails its Audit instead (src/loop/auditFailure.ts). */
type NoticedRole = Exclude<AgentRole, "audit">;

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

/**
 * The label the Kit itself removes and re-adds to re-run a refused run on the
 * next free Subscription: each role's trigger label, and agent:design for a
 * Design-session turn, which starts the turn again (src/loop/design.ts).
 */
const RERUN_LABELS: Readonly<Record<NoticedRole, Label>> = { ...TRIGGER_LABELS, design: DESIGN_LABEL };

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
    case "dead-token": {
      // With rotation on, it names the Subscription whose vault item needs rotating.
      const subscription = subscriptionOfRun(run, config);
      const rotation = rotationIsOn(config);
      const token = refusedToken({ subscription, rotation });
      return `${token} was refused (\`authentication_failed\`), so ${rotation ? `its \`${subscription}\` vault item` : "it"} may need rotating`;
    }
    case "weekly-limit":
      return "it hit the weekly usage limit";
    case "metered-billing":
      return "the preflight found a route that would bill metered API usage, so it refused to start the agent";
  }
}

/**
 * With rotation on, the run a weekly-limit refusal holds rather than fails, or
 * null: a run of any role while no other Subscription is free, and an Auditor
 * run whatever is free, since it has no trigger label to re-run it through
 * and is resumed on its pending Audit. An Audit that's no longer pending holds
 * nothing.
 */
function heldOnRefusal(
  run: FailedRun,
  failure: InfrastructureFailure,
  { issue, kitIssues }: IssueContext,
  ranOn: Pick<StalledRun, "subscription" | "rotation" | "subscriptions">,
): HeldRun | null {
  if (failure !== "weekly-limit" || !ranOn.rotation) return null;
  if (run.role === "audit") return isPendingAudit(issue) ? { role: "audit", issue: run.issue, label: null } : null;
  if (anotherSubscriptionFree(kitIssues, ranOn)) return null;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? (issue.openPullRequests[0] ?? run.issue) : run.issue;
  return { role: run.role, issue: labelled, label: RERUN_LABELS[run.role] };
}

/**
 * One comment on the Ticket's PR if it has one, else the issue. It carries the
 * Operator's only @-mention, unless the failure stalls the whole repo: then a
 * Kit-owned issue does the notifying, once, and the comment points there.
 */
export function failureNotice(run: FailedRun, context: IssueContext, config: KitConfig): Plan {
  const { issue, operator } = context;
  const failure = infrastructureFailureOf(run);
  const ranOn = {
    subscription: subscriptionOfRun(run, config),
    rotation: rotationIsOn(config),
    subscriptions: config.subscriptions,
  };
  const held = heldOnRefusal(run, failure, context, ranOn);
  if (held !== null) {
    const repoWide = repoWideNotice(failure, context, {
      run: run.role === "audit" ? `The Audit run on #${run.issue}` : `The ${ROLE_NAMES[run.role]} run on #${run.issue}`,
      runUrl: run.runUrl,
      resetsAt: run.report?.resetsAt ?? null,
      ...ranOn,
      held,
    });
    return { kind: "act", actions: [...holding(held, repoWide?.firstReset ?? null), ...(repoWide?.actions ?? [])] };
  }
  // The scheduled tick tries a failed Audit again, so there's no trigger label to re-add.
  if (run.role === "audit") {
    const how = howItFailed(failure, run, config);
    return failAudit(context, {
      failure,
      how,
      runUrl: run.runUrl,
      resetsAt: run.report?.resetsAt ?? null,
      ranOn,
    });
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
    ...ranOn,
  });
  // Another Subscription is free: the new Loop run's Kit job starts the run on it,
  // as an Infrastructure failure's resumption that never counts against retries.
  if (failure === "weekly-limit" && anotherSubscriptionFree(context.kitIssues, ranOn)) {
    const rerun = RERUN_LABELS[run.role];
    return {
      kind: "act",
      actions: [
        { kind: "remove-label", issue: labelled, label: rerun },
        { kind: "add-labels", issue: labelled, labels: [rerun] },
        ...(repoWide?.actions ?? []),
      ],
    };
  }
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
