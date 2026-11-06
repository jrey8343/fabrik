// A Replay Ticket's run (#156): agent:replay on a replay issue starts its next
// pending Ticket, both arms, which the workflow routes to `replay`
// (src/kit/jobs.ts). The run's claim takes the label off and marks the Ticket
// in progress, as Implement's claim takes agent:implement off. A replay run is
// never held and never re-run on another Subscription: while any
// Subscription is used up it doesn't start, and the Ticket waits, pending,
// for a later tick. Pure, no I/O.
import { nextReplayTicket, replayMarksIn } from "../kit/replay.ts";
import { REPLAY_LABEL, REPLAY_TRIGGER_LABEL } from "./labels.ts";
import { whyUsedUp } from "./replayGate.ts";
import type { IssueContext, Plan } from "./types.ts";

/**
 * agent:replay added to `issueNumber`: the claim's plan, which takes the
 * label off, marks the Ticket the replay issue's plan runs next in progress,
 * and starts its two arms; or nothing, with why, when it isn't the
 * Operator's open, accepted replay issue with a Ticket waiting, when a Ticket
 * of it is in progress already, or while any Subscription is used up.
 */
export function startReplay(issueNumber: number, { issue, operator, kitIssues }: IssueContext): Plan {
  const name = `#${issueNumber}`;
  if (!issue.labels.includes(REPLAY_LABEL)) return { kind: "nothing", reason: `${name} isn't a replay issue: it has no ${REPLAY_LABEL}` };
  if (!issue.open) return { kind: "nothing", reason: `${name} is closed, which cancels its Replay` };
  if (issue.author !== operator) return { kind: "nothing", reason: `${name} isn't the Operator's, so its Replay never runs` };
  const marks = replayMarksIn(issue.body);
  if (marks === null) return { kind: "nothing", reason: `${name}'s request isn't accepted yet` };
  const running = marks.progress.find(({ state }) => state === "in-progress");
  if (running !== undefined) return { kind: "nothing", reason: `#${running.ticket} is in progress on ${name} already, and one replay Ticket runs at a time` };
  const next = nextReplayTicket(marks);
  if (next === null) return { kind: "nothing", reason: `No Ticket of ${name} waits to run` };
  // The tick checked, but one may have hit a limit since; a live run would be held or rotated here.
  const usedUp = whyUsedUp(kitIssues);
  if (usedUp !== null) return { kind: "nothing", reason: `${usedUp}, and a replay run is never held: its Ticket waits for spare capacity` };
  return {
    kind: "act",
    actions: [
      { kind: "remove-label", issue: issueNumber, label: REPLAY_TRIGGER_LABEL },
      { kind: "mark-replay-started", issue: issueNumber, ticket: next.ticket },
      { kind: "start-replay", issue: issueNumber, ticket: next },
    ],
  };
}
