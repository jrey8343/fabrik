// A Replay Ticket's run (#156): agent:replay on a replay issue starts its next
// pending Ticket, both arms, which the workflow routes to `replay`
// (src/kit/jobs.ts). The run's claim takes the label off and marks the Ticket
// in progress, as Implement's claim takes agent:implement off. A replay run is
// never held and never re-run on another Subscription: while any
// Subscription is used up it doesn't start, and the Ticket waits, pending,
// for a later tick. When the run ends, its replay-record job lands it: the
// Ticket's progress and the results as the store holds them, one comment
// once the last Ticket is in, and for a weekly-limit refusal the weekly-limit
// issue, as any refused run opens it, with the Ticket back to pending. Pure,
// no I/O.
import {
  isOperatorsReplay,
  nextReplayTicket,
  oneAtATime,
  type ReplayIssue,
  replayInProgress,
  replayMarksIn,
  replayResultsIn,
  withReplayResults,
  withTicketFinished,
} from "../kit/replay.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { REPLAY_LABEL, REPLAY_TRIGGER_LABEL } from "./labels.ts";
import { whyUsedUp } from "./replayGate.ts";
import { ranOnOf } from "./subscriptions.ts";
import type { Action, IssueContext, KitConfig, LoopEvent, Plan } from "./types.ts";

/**
 * agent:replay added to `issueNumber`: the claim's plan, which takes the
 * label off, marks the Ticket the replay issue's plan runs next in progress,
 * and starts its two arms; or nothing, with why, when it isn't the
 * Operator's open, accepted replay issue with a Ticket waiting, when a replay
 * Ticket is in progress on any of the Operator's replay issues, `replayIssues`
 * being every open one, or while any Subscription is used up. Like
 * agent:implement added by hand, which starts past Dispatch's cap, it starts
 * the Ticket whether or not the tick's spare-capacity gate would: the label
 * is the Operator's own start, or the tick's that weighed the gate already.
 */
export function startReplay(issueNumber: number, { issue, operator, kitIssues }: IssueContext, replayIssues: readonly ReplayIssue[] | null): Plan {
  const name = `#${issueNumber}`;
  if (!issue.labels.includes(REPLAY_LABEL)) return { kind: "nothing", reason: `${name} isn't a replay issue: it has no ${REPLAY_LABEL}` };
  if (!issue.open) return { kind: "nothing", reason: `${name} is closed, which cancels its Replay` };
  if (!isOperatorsReplay(issue, operator)) return { kind: "nothing", reason: `${name} isn't the Operator's, so its Replay never runs` };
  const marks = replayMarksIn(issue.body);
  if (marks === null) return { kind: "nothing", reason: `${name}'s request isn't accepted yet` };
  if (replayIssues === null) return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the replay issues a replay Ticket's claim weighs" };
  // This issue as the claim read it, beside every other open replay issue.
  const itself: ReplayIssue = { number: issueNumber, open: issue.open, author: issue.author, body: issue.body, comments: [] };
  const running = replayInProgress({ operator, issues: [itself, ...replayIssues.filter(({ number }) => number !== issueNumber)] });
  if (running !== null) return { kind: "nothing", reason: oneAtATime(running) };
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

/**
 * A replay Ticket's run ending, as its replay-record job saw it: the
 * Ticket's progress on its replay issue (withTicketFinished), and the
 * results rewritten from what the store holds of the Replay
 * (withReplayResults), so the table grows as Tickets finish; unless the
 * Operator closed the issue, which cancels the Replay. Once every Ticket is
 * done or failed, one comment tells the Operator the results are in. A
 * weekly-limit refusal opens or comments on the weekly-limit issue, a fact
 * about the Subscription, as any refused run does. Never a hold, and never
 * the trigger label again: the Ticket waits, pending, for a later tick with
 * spare capacity.
 */
export function landReplayRun(run: Extract<LoopEvent, { kind: "replay-run-finished" }>, context: IssueContext, config: KitConfig): Plan {
  const { issue } = context;
  const name = `#${run.ticket}`;
  const finished = issue.open ? withTicketFinished(issue.body, run.ticket, run.run, run.end) : null;
  // Without the store, the body keeps the results it last showed.
  const progressed =
    finished === null || run.outcomes === null ? finished : (withReplayResults(finished, { open: true, ...run.outcomes }) ?? finished);
  // Only the run that finishes the last Ticket sees the results come in, so the comment is posted once.
  const resultsIn = progressed !== null && replayResultsIn(progressed) && !replayResultsIn(issue.body);
  const notice =
    run.end.kind === "weekly-limit"
      ? repoWideNotice("weekly-limit", context, {
          run: `The replay of ${name} on #${run.issue}`,
          runUrl: run.runUrl,
          resetsAt: run.resetsAt ?? null,
          ...ranOnOf(run, config),
        })
      : null;
  const actions: Action[] = [
    ...(progressed === null ? [] : [{ kind: "edit-issue-body" as const, issue: run.issue, body: progressed }]),
    ...(resultsIn ? [{ kind: "comment" as const, issue: run.issue, body: resultsReady(context.operator) }] : []),
    ...(notice?.actions ?? []),
  ];
  if (actions.length > 0) return { kind: "act", actions };
  const why = issue.open ? `${name} isn't in progress in run ${run.run} on replay #${run.issue}` : `replay #${run.issue} is closed, which cancelled it`;
  return { kind: "nothing", reason: `${why}, so its run's end changes nothing there` };
}

/** The one comment a Replay gets when its results are in, the Operator's to act on: no model judged them, and nothing changes until they do. */
function resultsReady(operator: string): string {
  return [
    `@${operator} **This Replay's results are in.** The table above sets each Ticket's baseline beside its variant, with the totals and the baseline's gap from the original runs.`,
    "",
    "Nothing changes until you act on them, as by changing a Kit config default or merging a Retro proposal. Close this issue once you have.",
  ].join("\n");
}
