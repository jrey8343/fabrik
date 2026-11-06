// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it. A
// failed Auditor or Retro run fails its Audit or Retro instead, with no
// trigger to re-add, since the scheduled tick opens the next one
// (src/loop/weeklyRuns.ts). With rotation on, a
// run refused on its Subscription's weekly limit is re-run once, quietly,
// through its trigger label while another Subscription is free, so the
// Operator hears nothing. Once none is free it is held instead, with no
// failure comment, and so is a refused Auditor run, whose Audit stays pending
// (src/loop/heldRun.ts). A run killed for spending usage credits is re-run or
// held the same way, while its Subscription's usage-credits issue keeps the
// Kit off that Subscription. A Retro run is never re-run or held: the tick
// can't start one at a reset, so its Retro fails, for the tick to try again.
import { isPendingAudit } from "./audit.ts";
import { type HeldRun, heldInOrder, holding, RESUME_LABELS, RUN_NAMES } from "./heldRun.ts";
import { canHold, heldAfterKill } from "./hold.ts";
import { anotherSubscriptionFree, refusedToken, repoWideNotice } from "./kitIssues.ts";
import { DESIGN_TURN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "./markers.ts";
import { type RanOn, ranOnOf, rotationIsOn, subscriptionOfRun } from "./subscriptions.ts";
import type { AgentRole, InfrastructureFailure, IssueContext, KitConfig, LoopEvent, Plan } from "./types.ts";
import { failWeekly, isWeeklyRole } from "./weeklyRuns.ts";

type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/**
 * With rotation on, the failures that leave the run's Subscription unusable,
 * so the Kit re-runs the run on the next free one, or holds it while none is:
 * the weekly limit, and a kill for spending usage credits. A run is re-run,
 * or resumed, through the label RESUME_LABELS names for its role
 * (src/loop/heldRun.ts): its trigger label, and agent:design for a
 * Design-session turn, which starts the turn again (src/loop/design.ts).
 */
const RERUN_FAILURES: readonly InfrastructureFailure[] = ["weekly-limit", "usage-credits"];

/**
 * The first line of a failure notice the snapshot reads back: a failed
 * Design-session turn keeps its session's slot (#147), and a failed
 * Researcher run keeps Dispatch off its Decision until the Operator re-adds
 * agent:research (#154).
 */
const FAILURE_MARKERS: Partial<Record<AgentRole, string>> = {
  design: DESIGN_TURN_FAILED_MARKER,
  research: RESEARCH_RUN_FAILED_MARKER,
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
      // A prototype turn builds and serves the Product, so it ran within the Implement role's timeout.
      return `it was cancelled, most likely by its ${config.roles[run.prototype === true ? "implement" : run.role].timeoutMinutes}-minute timeout`;
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
    case "usage-credits":
      return `its stream showed usage credits being spent on the \`${subscriptionOfRun(run, config)}\` Subscription, so the Kit killed it`;
  }
}

/**
 * With rotation on, the run a weekly-limit refusal holds rather than fails, or
 * null: a run of any role while no other Subscription is free, and an Auditor
 * run whatever is free, since it has no trigger label to re-run it through
 * and is resumed on its pending Audit. An Audit that's no longer pending holds
 * nothing, and a Retro run is never held.
 */
function heldOnRefusal(
  run: FailedRun,
  failure: InfrastructureFailure,
  { issue, kitIssues }: IssueContext,
  ranOn: RanOn,
): HeldRun | null {
  if (!ranOn.rotation || !RERUN_FAILURES.includes(failure)) return null;
  // The tick can't start a Retro run at the reset, so its Retro fails, and the tick opens the next one.
  if (run.role === "retro") return null;
  // A kill opens no weekly-limit issue, and only one can hold the run: with none open it fails as usual.
  if (failure === "usage-credits" && !canHold(kitIssues)) return null;
  // A killed Auditor run is held only while none is free: else its Audit fails, for the tick to try again.
  const auditHeld = failure === "weekly-limit" || !anotherSubscriptionFree(kitIssues, ranOn);
  if (run.role === "audit") return auditHeld && isPendingAudit(issue) ? { role: "audit", issue: run.issue, label: null } : null;
  if (anotherSubscriptionFree(kitIssues, ranOn)) return null;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? (issue.openPullRequests[0] ?? run.issue) : run.issue;
  return { role: run.role, issue: labelled, label: RESUME_LABELS[run.role] };
}

/**
 * One comment on the Ticket's PR if it has one, else the issue. It carries the
 * Operator's only @-mention, unless the failure stalls the whole repo: then a
 * Kit-owned issue does the notifying, once, and the comment points there.
 */
export function failureNotice(run: FailedRun, context: IssueContext, config: KitConfig): Plan {
  const { issue, operator } = context;
  const failure = infrastructureFailureOf(run);
  const ranOn = ranOnOf(run, config);
  const failedRun = run.prototype === true ? `The prototype turn on #${run.issue}` : `The ${RUN_NAMES[run.role]} run on #${run.issue}`;
  const refused = heldOnRefusal(run, failure, context, ranOn);
  if (refused !== null) {
    // Its place in the order: a run held before, resumed and refused again, keeps the one it had.
    const [held = refused] = heldInOrder([refused], context.kitIssues);
    // A kill says nothing of when the limit resets: the held run waits for the first weekly-limit issue's.
    const killed = failure === "usage-credits";
    const repoWide = repoWideNotice(failure, context, {
      run: failedRun,
      runUrl: run.runUrl,
      resetsAt: killed ? null : (run.report?.resetsAt ?? null),
      ...ranOn,
      ...(killed ? {} : { held }),
    });
    const holds = killed ? heldAfterKill(held, context.kitIssues) : holding(held, repoWide?.firstReset ?? null);
    return { kind: "act", actions: [...holds, ...(repoWide?.actions ?? [])] };
  }
  // The scheduled tick tries a failed Audit or Retro again, so there's no trigger label to re-add.
  if (isWeeklyRole(run.role)) {
    const how = howItFailed(failure, run, config);
    return failWeekly(run.role, context, {
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
  // A Design-session turn has none to re-add: its issue keeps needs-design, and the Operator's reply starts it again.
  const label = run.role === "design" ? null : RESUME_LABELS[run.role];
  // The failure notice ends a prototype turn's request (src/github/threads.ts), so a reply starts an ordinary turn.
  const resume =
    label !== null
      ? `Re-add the \`${label}\` label${where} to run it again.`
      : run.prototype === true
        ? "Reply on this issue to carry the session on: the turn your reply starts can ask for the prototype again."
        : "Reply on this issue to run the turn again.";
  const detail = run.report === null || run.report.detail.trim() === "" ? [] : ["", `> ${run.report.detail.trim()}`];
  const repoWide = repoWideNotice(failure, context, {
    run: failedRun,
    runUrl: run.runUrl,
    resetsAt: run.report?.resetsAt ?? null,
    ...ranOn,
  });
  // Another Subscription is free: the new Loop run's Kit job starts the run on it,
  // as an Infrastructure failure's resumption that never counts against retries.
  if (RERUN_FAILURES.includes(failure) && anotherSubscriptionFree(context.kitIssues, ranOn)) {
    const rerun = RESUME_LABELS[run.role];
    return {
      kind: "act",
      actions: [
        { kind: "remove-label", issue: labelled, label: rerun },
        { kind: "add-labels", issue: labelled, labels: [rerun] },
        ...(repoWide?.actions ?? []),
      ],
    };
  }
  const marker = FAILURE_MARKERS[run.role];
  // A research Decision has no retries to count against, and Dispatch leaves it alone once its run failed.
  const notRetried =
    run.role === "research"
      ? "neither the Loop nor Dispatch runs it again by itself"
      : "the Loop won't retry it and it doesn't count against the Ticket's retries";
  const body = [
    ...(marker === undefined ? [] : [marker]),
    `${repoWide === null ? `@${operator} ` : ""}${failedRun} failed: ${howItFailed(failure, run, config)}.`,
    ...detail,
    "",
    `This is an Infrastructure failure, so ${notRetried}. ${resume}`,
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
