// The stuck-trigger sweep (#419): a trigger label whose run never started, as
// when the Kit job failed on an invalid Kit config or the run was cancelled or
// lost before its claim, held its slot and started nothing again, since GitHub
// fires `labeled` once. On the scheduled tick, before its Dispatch and Design
// queue checks, the Kit adds such a label again once, and on a second strike
// takes it off and hands the work to the Operator.
import type { TriggerLabel } from "./labels.ts";
import {
  DESIGN_TURN_FAILED_MARKER,
  handBackMarker,
  IMPLEMENT_RUN_FAILED_MARKER,
  RESEARCH_RUN_FAILED_MARKER,
  stuckTriggerGaveUpMarker,
  stuckTriggerReaddedMarker,
} from "./markers.ts";
import type { Action, AgentRole, LabelledTrigger, Plan, RolesUnderWay, TriggerSweepSnapshot } from "./types.ts";

/** The role whose run each trigger label starts; a Replay's starts no one role's. */
const TRIGGER_ROLES: Readonly<Record<TriggerLabel, AgentRole | null>> = {
  "agent:implement": "implement",
  "agent:design": "design",
  "agent:review": "review",
  "agent:research": "research",
  "agent:replay": null,
};

function roleOfTrigger(label: TriggerLabel): { readonly role?: AgentRole } {
  const role = TRIGGER_ROLES[label];
  return role === null ? {} : { role };
}

/**
 * The first line of the give-up comment for each role whose failed run parks
 * its work: Dispatch skips a Ticket or research Decision whose latest Kit word
 * is its role's failure notice (#418, #154), and a Design session whose turn
 * failed keeps its slot and waits for the Operator (#147). Nothing adds
 * agent:review by itself, and the replay step leaves an issue the Kit gave up
 * on alone (src/loop/replayGate.ts), so those two need none.
 */
const PARKING_MARKERS: Partial<Record<TriggerLabel, string>> = {
  "agent:implement": IMPLEMENT_RUN_FAILED_MARKER,
  "agent:research": RESEARCH_RUN_FAILED_MARKER,
  "agent:design": DESIGN_TURN_FAILED_MARKER,
};

/**
 * What the sweep does this tick about each trigger label with no run behind
 * it: on an open issue or PR, one last added at least `waitMinutes` ago (the
 * record's stuckTrigger, src/loop/recoveryWaits.ts) with no job of its role
 * under way. The first time, it adds it again;
 * if it's still stuck at a later tick, the Kit's re-add since it last came
 * off, it gives up. The count resets whenever the label comes off, so only
 * the Operator adding it again restarts the work after a give-up. With the
 * Actions API unread, it leaves every label alone and says so.
 */
export function sweepStuckTriggers(now: string, { underWay, labelled }: TriggerSweepSnapshot, operator: string, waitMinutes: number): Plan {
  if (underWay === null) {
    return {
      kind: "act",
      actions: [],
      notes: ["The stuck-trigger sweep left every trigger label alone: the Actions API couldn't be read, so whether a run is behind one isn't known"],
    };
  }
  const actions = labelled.flatMap((trigger) => {
    const minutes = minutesOn(now, trigger);
    if (minutes === null || minutes < waitMinutes || hasRunBehind(trigger, underWay)) return [];
    return trigger.readded ? giveUp(trigger, operator) : readd(trigger, minutes);
  });
  return actions.length === 0 ? { kind: "nothing", reason: "No trigger label sits with no run behind it" } : { kind: "act", actions };
}

/**
 * Whether a job of the label's role is under way. Implement and Review job
 * names carry no issue number, so any one of them, anywhere in the repo,
 * counts for every such label: the sweep errs toward leaving a label be.
 */
function hasRunBehind({ number, label }: LabelledTrigger, underWay: RolesUnderWay): boolean {
  switch (label) {
    case "agent:implement":
      return underWay.implement;
    case "agent:research":
      return underWay.research;
    case "agent:review":
      return underWay.review;
    case "agent:design":
      return underWay.designTurns.includes(number);
    case "agent:replay":
      return underWay.claim || underWay.implement || underWay.review;
  }
}

/** How many whole minutes the label has been on, or null when its timeline doesn't show it being added. */
function minutesOn(now: string, { lastAddedAt }: LabelledTrigger): number | null {
  if (lastAddedAt === null) return null;
  return Math.floor((Date.parse(now) - Date.parse(lastAddedAt)) / 60_000);
}

/**
 * Strike one: add it again, which the adapter's cycle (#417) turns into a
 * fresh `labeled` event, then say so. The comment comes after the cycle's
 * unlabeled event, which is how the next tick tells strike two.
 */
function readd({ number, label }: LabelledTrigger, minutes: number): Action[] {
  return [
    { kind: "add-labels", issue: number, labels: [label] },
    {
      kind: "comment",
      issue: number,
      body: `${stuckTriggerReaddedMarker(label)}\n\`${label}\` sat ${minutes} minutes with no run behind it, so the Kit added it again.`,
    },
  ];
}

/**
 * Strike two: the re-add started nothing either. Take the label off and tell
 * the Operator, once, parking the work as the role's failed run does, so no
 * check adds the label back by itself.
 */
function giveUp({ number, label }: LabelledTrigger, operator: string): Action[] {
  const parking = PARKING_MARKERS[label];
  return [
    { kind: "remove-label", issue: number, label },
    {
      kind: "comment",
      issue: number,
      body: [
        ...(parking === undefined ? [] : [parking]),
        stuckTriggerGaveUpMarker(label),
        `@${operator} \`${label}\` came off: nothing started when it was added, nor when the Kit added it again. Check the Loop's Actions runs (an invalid Kit config is the usual cause), then add \`${label}\` again once it's fixed.`,
        handBackMarker({ kind: "trigger-swept", ...roleOfTrigger(label) }),
      ].join("\n"),
    },
  ];
}
