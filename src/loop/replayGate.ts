// The replay step (#156): on the hourly scheduled tick, the Replays' next
// step, which the Replay module decides (src/kit/replay.ts): accept or reject
// a waiting request, start the next pending Ticket, which only spare
// capacity allows, or release one in progress past the longest its run can
// last, whose run never landed. Starting one adds agent:replay to its replay
// issue (ADR-0001), whose claim takes it off as the run starts
// (src/loop/replayRun.ts).
import { type ReplayCapacity, type ReplayStep, nextReplayStep, resultsReady } from "../kit/replay.ts";
import { JUDGE_TIMEOUT_MINUTES } from "../kit/runStore.ts";
import { atOrOver } from "../kit/scorer.ts";
import { waitingForDispatch } from "./dispatch.ts";
import { heldOf } from "./heldRun.ts";
import { REPLAY_TRIGGER_LABEL, TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { spelled } from "./readable.ts";
import { chosenSubscription } from "./subscriptions.ts";
import type { KitConfig, KitIssueSnapshot, Plan, ReplaySnapshot, Snapshot } from "./types.ts";

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
  const step = nextReplayStep({
    operator: snapshot.operator,
    issues: slice.issues,
    capacity,
    acceptance: slice.acceptance,
    now,
    runLimitMinutes: replayRunLimitMinutes(config),
  });
  return planOf(step, slice, snapshot.operator);
}

/**
 * loop.yml's replay route's fixed job timeouts, in minutes, which a
 * workflows test holds it to: the Kit job's, the claim's and the
 * replay-record job's.
 */
export const REPLAY_ROUTE_JOB_MINUTES = { kit: 5, claim: 10, record: 15 } as const;

/** How long, together, a replay Ticket's run's jobs may wait for a runner, in minutes. */
const REPLAY_QUEUE_MINUTES = 60;

/**
 * The longest a replay Ticket's run can last, in minutes, from its claim to
 * its replay-record job's end, at Kit config's timeouts: its jobs end to end
 * (the Kit job and the claim, each arm's replay implement job, the slowest of
 * its gates job, which runs within the Implement timeout, its Review and its
 * judge, then the replay-record job), and an hour to queue. The tick can't
 * read workflow runs (the caller grants it no Actions permission), so a
 * Ticket in progress longer than this is taken for one whose run is over.
 */
export function replayRunLimitMinutes({ roles }: Pick<KitConfig, "roles">): number {
  const { kit, claim, record } = REPLAY_ROUTE_JOB_MINUTES;
  const implement = roles.implement.timeoutMinutes;
  return kit + claim + implement + Math.max(implement, roles.review.timeoutMinutes, JUDGE_TIMEOUT_MINUTES) + record + REPLAY_QUEUE_MINUTES;
}

/**
 * The weekly-limit utilization, from 0 to 1, at or above which no replay
 * Ticket starts (#156), so a Replay stays in the lower half of the week's
 * budget: a Kit constant, like the Scorers' SCORING_UTILIZATION_LIMIT in
 * src/kit/scorer.ts, and read the same way (atOrOver).
 */
export const REPLAY_UTILIZATION_LIMIT = 0.5;

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

/** The Kit-owned issues that leave a Subscription used up, as each is named in the reason. */
const USED_UP_LABELS: readonly (readonly [string, string])[] = [
  [WEEKLY_LIMIT_LABEL, "weekly-limit"],
  [USAGE_CREDITS_LABEL, "usage-credits"],
  [TOKEN_ROTATION_LABEL, "token-rotation"],
];

/**
 * Why a Subscription is used up, from the first open weekly-limit,
 * usage-credits or token-rotation issue, or null while none is open. Any
 * Subscription's, not only the one a replay run would use, so a Replay never
 * spends into a limit, nor runs while live work has lost a Subscription.
 */
export function whyUsedUp(kitIssues: readonly KitIssueSnapshot[]): string | null {
  for (const issue of kitIssues) {
    const used = USED_UP_LABELS.find(([label]) => issue.labels.includes(label));
    if (used !== undefined) return `A Subscription is used up, as the ${used[1]} issue #${issue.number} says`;
  }
  return null;
}

/**
 * The step as the Kit carries it out. A start adds agent:replay, except on an
 * issue that still has it, as after a claim that never ran, which the
 * stuck-trigger sweep (src/loop/triggerSweep.ts, #419) adds again once and
 * then gives up on, and on one the Kit gave up on, until someone adds it
 * again: retrying it on every tick would only fail the same way. A release
 * ends the run that never landed on a fresh read of the body, with the
 * comment its results get should that end the Replay.
 */
function planOf(step: ReplayStep, { issues }: ReplaySnapshot, operator: string): Plan {
  switch (step.kind) {
    case "nothing":
      return { kind: "nothing", reason: step.reason };
    case "accept":
      return { kind: "act", actions: [{ kind: "edit-issue-body", issue: step.issue, body: step.body }] };
    case "reject":
      return { kind: "act", actions: [{ kind: "comment", issue: step.issue, body: step.comment }] };
    case "release": {
      const { issue, ticket, run, reason } = step;
      return { kind: "act", actions: [{ kind: "release-replay-ticket", issue, ticket, run, reason, resultsReady: resultsReady(operator) }] };
    }
    case "start": {
      const issue = issues.find(({ number }) => number === step.issue);
      if (issue?.labels.includes(REPLAY_TRIGGER_LABEL) === true) {
        return { kind: "nothing", reason: `#${step.issue} still has ${REPLAY_TRIGGER_LABEL}, which the stuck-trigger sweep sees to` };
      }
      if (issue?.gaveUp === true) {
        return { kind: "nothing", reason: `The Kit gave up on ${REPLAY_TRIGGER_LABEL} on #${step.issue}, so only adding it again starts its next Ticket` };
      }
      return { kind: "act", actions: [{ kind: "add-labels", issue: step.issue, labels: [REPLAY_TRIGGER_LABEL] }] };
    }
  }
}
