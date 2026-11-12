// Reopening for Triage (#663): a Roll-in the Operator settled and never sent
// is not lost. When its agent pull request merges or closes, whoever closed
// it, the Kit reopens the issue and sends it to Triage with one line saying
// why, so the work can be built as its own Ticket. Decided in #530.
import { NEEDS_TRIAGE, WONTFIX } from "./labels.ts";
import { ROLL_IN_REOPENED_MARKER } from "./markers.ts";
import { unsentRollIns } from "./owedRollIn.ts";
import type { Action, LoopEvent, PullRequestSnapshot, RollInsSnapshot } from "./types.ts";

type PullRequestClosed = Extract<LoopEvent, { kind: "pull-request-closed" }>;

/**
 * For each Roll-in left unsent on an agent pull request that has just merged
 * or closed (src/loop/owedRollIn.ts), lowest issue number first: reopens the
 * issue, takes wontfix off, posts the reopening note and adds needs-triage,
 * which starts Triage as that label does on any issue. In that order: Triage
 * starts only on an open issue, and GitHub's reopening event starts nothing.
 * The note's mark makes it happen once: after it the Roll-in stands no
 * longer. Nothing when the snapshot read no issues for the pull request.
 */
export function reopenUnsentRollIns({ merged }: PullRequestClosed, pullRequest: PullRequestSnapshot, rollIns: RollInsSnapshot | null): Action[] {
  if (rollIns === null) return [];
  const { repo, requestChanges, issues } = rollIns;
  const { number, open, isAgent } = pullRequest;
  return unsentRollIns({ repo, pullRequest: { number, open, isAgent, requestChanges }, issues }).flatMap(({ issue }): Action[] => [
    { kind: "reopen", issue },
    { kind: "remove-label", issue, label: WONTFIX },
    { kind: "comment", issue, body: reopeningNote(number, merged) },
    { kind: "add-labels", issue, labels: [NEEDS_TRIAGE] },
  ]);
}

/**
 * The Kit's note on an issue it reopened for Triage: its mark, then one line
 * saying why, which mentions nobody. A pull request that closed unmerged may
 * have taken with it the code the Roll-in's text names, so its line says so
 * for whoever weighs that text next.
 */
function reopeningNote(pullRequest: number, merged: boolean): string {
  const line = merged
    ? `#${pullRequest} merged before this Roll-in was sent, so the Kit reopened this issue for Triage: its work can be built on \`main\` as its own Ticket.`
    : `#${pullRequest} closed unmerged before this Roll-in was sent, so the Kit reopened this issue for Triage. The code the text above names may not be on \`main\`.`;
  return `${ROLL_IN_REOPENED_MARKER}\n${line}`;
}
