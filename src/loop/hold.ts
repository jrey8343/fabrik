// Where a held run is put (src/loop/heldRun.ts): with rotation on, while every
// listed Subscription is used up, through any mix of weekly limits, usage
// credits and dead tokens, each run due is held instead of started, and a run
// refused, or killed, while none is free is held instead of re-run (#470).
// The held marker naming it goes, quietly, on a carrier: the weekly-limit
// issue that buzzed the Operator, else the first to reset, and it is held
// until the earliest reset across them. With no weekly-limit issue open it
// goes on the usage-credits or token-rotation issue that already carries held
// markers, else the most recently opened, whose opening took the last free
// Subscription, and no reset is known: it resumes once the Operator closes an
// issue that frees a Subscription (src/loop/resume.ts). Pure, no I/O.
import { carriesHeldMarkers, heldInOrder, heldMarker, heldRunOf, type HoldableRun, holding, isCarrier, runNamed } from "./heldRun.ts";
import { earliestOf, notified, resetsAtOf } from "./kitIssueMarks.ts";
import { WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { readable } from "./readable.ts";
import { freeSubscriptions, rotationIsOn } from "./subscriptions.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/**
 * The carrier a run due now is held on, as a note promising the run names
 * it: its number, and whether it is a weekly-limit issue, whose reset the
 * run waits for, rather than a usage-credits or token-rotation issue, which
 * has none.
 */
export interface HeldOn {
  readonly issue: number;
  readonly reset: boolean;
}

/** The line naming a held run, with its held marker, for a weekly-limit issue. */
export function heldLine(held: HoldableRun, until: string | null): string {
  const run = `The ${runNamed(held.role)} on #${held.issue}`;
  const resume = `re-adds \`${held.label}\` on #${held.issue} then, to run it again.`;
  // With no reset known, only the Operator's close of this issue frees a Subscription for it (#440).
  const line =
    until === null
      ? `${run} is held until a Subscription is free again. The Kit doesn't know when this limit resets. Close this issue once agent runs work again, and the Kit ${resume}`
      : `${run} is held until ${readable(until)}, when the first Subscription's weekly limit resets. The Kit ${resume}`;
  return [line, "", heldMarker(held)].join("\n");
}

/**
 * The line naming a held run, with its held marker, for a usage-credits or
 * token-rotation issue, which has no reset: it resumes on a close (#470).
 */
export function heldUntilFreeLine(held: HoldableRun): string {
  const line = `The ${runNamed(held.role)} on #${held.issue} is held until a Subscription is free again. It resumes once this issue, or another issue blocking a Subscription, is closed: the Kit re-adds \`${held.label}\` on #${held.issue} then, to run it again.`;
  return [line, "", heldMarker(held)].join("\n");
}

/**
 * With rotation on and every listed Subscription used up, the Plan with each
 * run it would start held instead: its trigger label off, and a quiet comment
 * naming it on its carrier (holdingOn). No comment on the Ticket, and no
 * @-mention. Every other action, and every Plan that starts no run, is left
 * as it is.
 */
export function heldWhileUsedUp(
  plan: Plan,
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Plan {
  if (plan.kind !== "act" || !runsDueAreHeld(kitIssues, config)) return plan;
  if (!plan.actions.some((action) => action.kind === "start-agent-run")) return plan;
  const carrier = holdingOn(kitIssues);
  if (carrier === null) return plan;
  const { until, on } = carrier;
  const { actions: planned } = plan;
  const starts = planned.filter((action) => action.kind === "start-agent-run");
  // Each in its place in the order held runs resume in.
  const held = heldInOrder(starts.map(heldRunOf), kitIssues);
  const comments: Action[] = held.map((run) => ({ kind: "comment", issue: on.number, body: lineOn(carrier, run) }));
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
 * rotation on, while every listed Subscription is used up, through any mix of
 * weekly-limit, usage-credits and token-rotation issues (#470). An Auditor or
 * Retro run is never held: its pending issue fails instead
 * (src/loop/weeklyRuns.ts).
 */
export function runsDueAreHeld(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): boolean {
  return rotationIsOn(config) && freeSubscriptions(kitIssues, config).length === 0 && holdingOn(kitIssues) !== null;
}

/**
 * The carrier a run due now is held on, or null when it would start: what a
 * note promising a run names, so it never says the run is starting while it
 * waits (#341), nor promises a reset a carrier doesn't have (#470).
 */
export function heldOn(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): HeldOn | null {
  if (!runsDueAreHeld(kitIssues, config)) return null;
  const carrier = holdingOn(kitIssues);
  return carrier === null ? null : { issue: carrier.on.number, reset: carrier.reset };
}

/** How a note promising a Request-changes run says it waits on `held`, its carrier. */
export function heldUntilReset(held: HeldOn): string {
  const until = held.reset ? "until the weekly limit resets" : "until a Subscription is free again";
  return `every Subscription is used up, so it's held on #${held.issue} ${until}, and starts then`;
}

/**
 * When a note says the run it promises starts: now, or, while `held` names the
 * carrier a run due now is held on, once the weekly limit resets, or once a
 * Subscription is free again for a carrier with no reset (#341, #470).
 */
export function startsWhen(held: HeldOn | null): string {
  return held === null ? "starts now" : `starts${onceReset(held)}`;
}

/** What a note adds after where a run starts (again) while it's held on `held` (heldOn), or "" while it would start now. */
export function onceReset(held: HeldOn | null): string {
  if (held === null) return "";
  return held.reset ? " once the weekly limit resets" : " once a Subscription is free again";
}

/** The sentence a note promising a run ends with while it's held on `held` (heldOn), or "" while it would start. */
export function heldUntilThen(held: HeldOn | null): string {
  return held === null ? "" : ` Every Subscription is used up, so it's held on #${held.issue} until then.`;
}

/** A carrier a run is held on, when it is held until, and whether it has a reset at all. */
interface Carrier {
  readonly on: KitIssueSnapshot;
  readonly until: string | null;
  readonly reset: boolean;
}

/**
 * Where a run held while no Subscription is free is named: the weekly-limit
 * issue that buzzed the Operator, else the first to reset, else the first
 * open, held until the earliest reset across them. With no weekly-limit issue
 * open, the usage-credits or token-rotation issue already carrying held
 * markers, else the most recently opened, with no reset (#470). Null with no
 * carrier open.
 */
function holdingOn(kitIssues: readonly KitIssueSnapshot[]): Carrier | null {
  const limits = kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const until = earliestOf(limits.map(resetsAtOf));
  const limit = limits.find(notified) ?? limits.find((issue) => until !== null && resetsAtOf(issue) === until) ?? limits[0];
  if (limit !== undefined) return { on: limit, until, reset: true };
  const others = kitIssues.filter(isCarrier);
  const on = others.find(carriesHeldMarkers) ?? others.toSorted((a, b) => b.number - a.number)[0];
  return on === undefined ? null : { on, until: null, reset: false };
}

/** The held line for a run held on this carrier. */
function lineOn({ until, reset }: Carrier, held: HoldableRun): string {
  return reset ? heldLine(held, until) : heldUntilFreeLine(held);
}

/**
 * With rotation on, a run killed for spending usage credits, or refused on a
 * dead token, while no other Subscription is free, held: its trigger label
 * off, and a quiet line naming it on its carrier, then `notice`, the actions
 * on its usage-credits or token-rotation issue. With no weekly-limit issue
 * open and no other issue carrying held markers, the issue the notice opens
 * is the carrier, as the most recently opened, and the line goes in its body,
 * as a weekly-limit refusal's does (#470).
 */
export function heldAfterKill(held: HoldableRun, kitIssues: readonly KitIssueSnapshot[], notice: readonly Action[]): Action[] {
  const carrier = holdingOn(kitIssues);
  const opens = notice.some((action) => action.kind === "open-issue");
  if (carrier !== null && (carrier.reset || carriesHeldMarkers(carrier.on) || !opens)) {
    return [...holding(held, carrier.until), { kind: "comment", issue: carrier.on.number, body: lineOn(carrier, held) }, ...notice];
  }
  if (!opens) throw new Error(`The ${runNamed(held.role)} on #${held.issue} has no issue to be held on`);
  const opened = notice.map((action): Action =>
    action.kind === "open-issue" ? { ...action, body: [action.body, "", heldUntilFreeLine(held)].join("\n") } : action,
  );
  return [...holding(held, null), ...opened];
}
