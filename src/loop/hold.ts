// Where a held run is put (src/loop/heldRun.ts): with rotation on, while every
// listed Subscription is used up, each run due is held instead of started, and
// a run refused, or killed, while none is free is held instead of re-run. The
// held marker naming it goes, quietly, on the weekly-limit issue that buzzed
// the Operator, else on the first to reset, and it is held until the earliest
// reset across them. With no weekly-limit issue open, as when every
// Subscription is unusable through usage-credits issues alone, nothing could
// carry the marker or resume the run, so it isn't held: a run due starts on
// the first listed Subscription, whose stream watch kills it on overage, and a
// killed run gets the usual failure comment. Pure, no I/O.
import { heldInOrder, heldMarker, heldRunOf, type HoldableRun, holding, RUN_NAMES } from "./heldRun.ts";
import { earliestOf, notified, resetsAtOf } from "./kitIssueMarks.ts";
import { WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { readable } from "./readable.ts";
import { freeSubscriptions, rotationIsOn } from "./subscriptions.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/** The line naming a held run, with its held marker, for a weekly-limit issue. */
export function heldLine(held: HoldableRun, until: string | null): string {
  const when =
    until === null
      ? "a Subscription's weekly limit resets, which isn't known"
      : `${readable(until)}, when the first Subscription's weekly limit resets`;
  const resume = `The Kit re-adds \`${held.label}\` on #${held.issue} then, to run it again.`;
  return [`The ${RUN_NAMES[held.role]} run on #${held.issue} is held until ${when}. ${resume}`, "", heldMarker(held)].join("\n");
}

/**
 * With rotation on and every listed Subscription used up, the Plan with each
 * run it would start held instead: its trigger label off, and a quiet comment
 * naming it on the weekly-limit issue that buzzed the Operator, or else on the
 * first to reset. No comment on the Ticket, and no @-mention. Every other
 * action, and every Plan that starts no run, is left as it is.
 */
export function heldWhileUsedUp(
  plan: Plan,
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Plan {
  if (plan.kind !== "act" || !runsDueAreHeld(kitIssues, config)) return plan;
  if (!plan.actions.some((action) => action.kind === "start-agent-run")) return plan;
  const { until, on } = holdingOn(kitIssues);
  if (on === undefined) return plan;
  const { actions: planned } = plan;
  const starts = planned.filter((action) => action.kind === "start-agent-run");
  // Each in its place in the order held runs resume in.
  const held = heldInOrder(starts.map(heldRunOf), kitIssues);
  const comments: Action[] = held.map((run) => ({ kind: "comment", issue: on.number, body: heldLine(run, until) }));
  const actions = planned.flatMap((action): Action[] => {
    // A held prototype turn hasn't started, so its request isn't marked so, and its resumption starts it (src/loop/design.ts).
    if (action.kind === "mark-prototype-request" && action.started && held.some((run) => run.issue === action.issue)) return [];
    const run = action.kind === "start-agent-run" ? held[starts.indexOf(action)] : undefined;
    if (run === undefined) return [action];
    // A Plan that already takes the trigger label off, as a Design-session turn's does, takes it off once.
    const removed = planned.some(
      (other) => other.kind === "remove-label" && other.issue === run.issue && other.label === run.label,
    );
    return holding(run, until).filter((step) => step.kind !== "remove-label" || !removed);
  });
  return { kind: "act", actions: [...actions, ...comments] };
}

/**
 * Whether a run due now is held rather than started (heldWhileUsedUp): with
 * rotation on, while every listed Subscription is used up and a weekly-limit
 * issue is open to carry its held marker. With every Subscription unusable
 * through usage-credits issues alone, nowhere holds its marker, so it starts.
 * An Auditor or Retro run is never held: its pending issue fails instead
 * (src/loop/weeklyRuns.ts).
 */
export function runsDueAreHeld(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): boolean {
  return rotationIsOn(config) && freeSubscriptions(kitIssues, config).length === 0 && canHold(kitIssues);
}

/**
 * The weekly-limit issue a run due now is held on, or null when it would
 * start: what a note promising a run names, so it never says the run is
 * starting while it waits for a reset (#341).
 */
export function heldOn(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): number | null {
  return runsDueAreHeld(kitIssues, config) ? (holdingOn(kitIssues).on?.number ?? null) : null;
}

/** How a note promising a Request-changes run says it waits on `held`, its weekly-limit issue. */
export function heldUntilReset(held: number): string {
  return `every Subscription is used up, so it's held on #${held} until the weekly limit resets, and starts then`;
}

/**
 * Where a run held while no Subscription is free is named: the weekly-limit
 * issue that buzzed the Operator, else the first to reset, else the first
 * open; and when it is held until, the earliest reset across them.
 */
function holdingOn(kitIssues: readonly KitIssueSnapshot[]): { until: string | null; on: KitIssueSnapshot | undefined } {
  const limits = kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const until = earliestOf(limits.map(resetsAtOf));
  const on = limits.find(notified) ?? limits.find((issue) => until !== null && resetsAtOf(issue) === until) ?? limits[0];
  return { until, on };
}

/**
 * Whether a run can be held now: held markers live only on weekly-limit
 * issues, so a run is never held while none is open, as when every
 * Subscription is unusable through usage-credits issues alone.
 */
export function canHold(kitIssues: readonly KitIssueSnapshot[]): boolean {
  return holdingOn(kitIssues).on !== undefined;
}

/**
 * With rotation on, a run killed for spending usage credits while no other
 * Subscription is free, held: its trigger label off, and a quiet comment
 * naming it on the weekly-limit issue a run held now is named on. Only while
 * one is open (canHold).
 */
export function heldAfterKill(held: HoldableRun, kitIssues: readonly KitIssueSnapshot[]): Action[] {
  const { until, on } = holdingOn(kitIssues);
  if (on === undefined) throw new Error(`The ${RUN_NAMES[held.role]} run on #${held.issue} has no weekly-limit issue to be held on`);
  return [...holding(held, until), { kind: "comment", issue: on.number, body: heldLine(held, until) }];
}
