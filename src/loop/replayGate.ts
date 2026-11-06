// The replay step (#156): on the hourly scheduled tick, the Replays' next
// step, which the Replay module decides (src/kit/replay.ts): accept or reject
// a waiting request, or start the next pending Ticket, which only spare
// capacity allows. Starting one adds agent:replay to its replay issue
// (ADR-0001), whose claim takes it off as the run starts (src/loop/replayRun.ts).
import { type ReplayCapacity, type ReplayStep, nextReplayStep } from "../kit/replay.ts";
import { atOrOver, REPLAY_UTILIZATION_LIMIT } from "../kit/scorer.ts";
import { waitingForDispatch } from "./dispatch.ts";
import { heldOf } from "./heldRun.ts";
import { REPLAY_TRIGGER_LABEL, USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { spelled } from "./readable.ts";
import { chosenSubscription } from "./subscriptions.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan, ReplaySnapshot, Snapshot } from "./types.ts";

/**
 * The replay step: what the tick does next for the Replays, or why nothing.
 * The scheduled-tick rule runs it on every tick, beside the audit gate and
 * the retro gate, after closing each weekly-limit issue past its reset
 * (scheduledTickWith in src/loop/rules.ts). With no replay issue open, its
 * slice holds none, and it does nothing.
 */
export function replayGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  const slice = snapshot.replay;
  if (slice === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the replay slice the replay step weighs" };
  }
  const capacity = capacityOf(now, slice, snapshot, config);
  const step = nextReplayStep({ operator: snapshot.operator, issues: slice.issues, capacity, acceptance: slice.acceptance });
  return planOf(step, slice);
}

/**
 * The spare-capacity gate: whether a replay Ticket may start now, or why
 * not. Only while Dispatch has nothing to start, by its own eligibility, so
 * live work always goes first; while no Subscription is used up; and while
 * the newest weekly-limit reading on the Subscription the run would use is
 * under REPLAY_UTILIZATION_LIMIT, and `allowed`. No reading counts as spare,
 * and so does one whose limit has reset since: the week it read is over.
 */
function capacityOf(now: string, { capacity }: ReplaySnapshot, { kitIssues }: Snapshot, config: KitConfig): ReplayCapacity {
  if (capacity === null) return { spare: false, why: "No open replay issue is the Operator's" };
  const held = { implement: heldOf("implement", kitIssues), research: heldOf("research", kitIssues) };
  const waiting = waitingForDispatch(capacity, held);
  if (waiting.length > 0) {
    return { spare: false, why: `${spelled(waiting.map((number) => `#${number}`), "and")} ${waiting.length === 1 ? "waits" : "wait"} for Dispatch, and live work goes first` };
  }
  const usedUp = whyUsedUp(kitIssues);
  if (usedUp !== null) return { spare: false, why: usedUp };
  if (capacity.weeklyLimits === null) return { spare: false, why: "The fabrik-runs store couldn't be read, so the weekly limit's utilization isn't known" };
  // With every Subscription free, the first listed.
  const subscription = chosenSubscription(kitIssues, config);
  const reading = capacity.weeklyLimits[subscription];
  if (reading === undefined || (reading.resetsAt !== null && reading.resetsAt * 1000 <= Date.parse(now))) return { spare: true };
  if (atOrOver(reading, REPLAY_UTILIZATION_LIMIT)) {
    const utilization = reading.utilization === null ? "" : ` at ${Math.round(reading.utilization * 100)}% utilization`;
    return {
      spare: false,
      why: `The \`${subscription}\` Subscription's last weekly-limit reading was ${reading.status ?? "unknown"}${utilization}, and a replay starts only under ${REPLAY_UTILIZATION_LIMIT * 100}%`,
    };
  }
  return { spare: true };
}

/**
 * Why a Subscription is used up, from the first open weekly-limit or
 * usage-credits issue, or null while none is open. Any Subscription's, not
 * only the one a replay run would use, so a Replay never spends into a limit.
 */
export function whyUsedUp(kitIssues: readonly KitIssueSnapshot[]): string | null {
  const usedUp = kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL) || issue.labels.includes(USAGE_CREDITS_LABEL));
  if (usedUp === undefined) return null;
  const what = usedUp.labels.includes(WEEKLY_LIMIT_LABEL) ? "weekly-limit" : "usage-credits";
  return `A Subscription is used up, as the ${what} issue #${usedUp.number} says`;
}

/**
 * The step as the Kit carries it out. A start adds agent:replay; on an issue
 * that still has it, as after a claim that never ran, it takes it off first,
 * since adding a label an issue has fires no event, and nothing would ever
 * start the Ticket.
 */
function planOf(step: ReplayStep, { issues }: ReplaySnapshot): Plan {
  switch (step.kind) {
    case "nothing":
      return { kind: "nothing", reason: step.reason };
    case "accept":
      return { kind: "act", actions: [{ kind: "edit-issue-body", issue: step.issue, body: step.body }] };
    case "reject":
      return { kind: "act", actions: [{ kind: "comment", issue: step.issue, body: step.comment }] };
    case "start": {
      const labelled = issues.some((issue) => issue.number === step.issue && issue.labels.includes(REPLAY_TRIGGER_LABEL));
      const add: Action = { kind: "add-labels", issue: step.issue, labels: [REPLAY_TRIGGER_LABEL] };
      return { kind: "act", actions: labelled ? [{ kind: "remove-label", issue: step.issue, label: REPLAY_TRIGGER_LABEL }, add] : [add] };
    }
  }
}
