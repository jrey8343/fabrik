// Conflicts with main (#304, ADR-0011): when main moves and leaves an agent PR
// at the Merge gate conflicting with it, the Kit brings the PR up to date
// itself instead of waiting for the Operator. A mechanical rebase comes first,
// with no agent; when it conflicts, one conflict-only Implementer run on the
// Step-up model resolves it. Neither uses a retry. Each PR gets one attempt per
// main head, recorded on the PR, and a PR only behind main is left alone. The
// loop is bounded: only the Operator merges to main, and neither attempt ever
// changes main, only the PR's own branch.
import { agentBranchFor } from "./agentPullRequest.ts";
import { DISPATCH_LABEL, READY_FOR_HUMAN } from "./labels.ts";
import { conflictAttemptMarker, CONFLICT_RUN_ENDED_MARKER, requestChangesRunEndedMarker } from "./markers.ts";
import { runInFlight, runName } from "./retry.ts";
import { actOnUndelivered, unnotedChangesRequests } from "./undelivered.ts";
import type { Action, ConflictCandidate, ConflictSnapshot, KitConfig, Plan, PullRequestSnapshot } from "./types.ts";

/**
 * The conflict check, on a push to the default branch or the scheduled tick:
 * for each open agent PR, the Request-changes run for an undelivered Request
 * changes on it (src/loop/undelivered.ts, #341), or else a rebase onto main if
 * it's at the Merge gate and conflicts with it, or why there's neither.
 */
export function checkConflicts(conflicts: ConflictSnapshot, operator: string): Plan {
  const { main, now } = conflicts;
  const reasons: string[] = [];
  const actions: Action[] = [];
  for (const candidate of conflicts.pullRequests) {
    const undelivered = actOnUndelivered(candidate, operator, now);
    if (undelivered !== null) {
      actions.push(...undelivered);
      continue;
    }
    const why = main === null ? "The default branch has no head, so no PR can conflict with it" : whyNotRebased(candidate, main, operator);
    if (why !== null) reasons.push(why);
    else actions.push(rebaseOntoMain(candidate.pullRequest, main as string));
  }
  if (actions.length > 0) return { kind: "act", actions };
  return { kind: "nothing", reason: reasons.length === 0 ? "No agent PR is open, so none conflicts with main" : reasons.join("; ") };
}

/** Why the Kit doesn't bring this PR up to date with main at `main` now, or null when it does. */
function whyNotRebased({ pullRequest, mergeable }: ConflictCandidate, main: string, operator: string): string | null {
  const { number } = pullRequest;
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return `#${number} isn't an open agent PR for a Ticket`;
  // A draft is still in the Loop, whose next push is reviewed anyway, or the Operator parked it.
  if (pullRequest.draft) return `#${number} is a draft, so it isn't brought up to date with main`;
  // Its Request-changes run brings main in itself, by merging (#341).
  if (unnotedChangesRequests(pullRequest, operator).length > 0) {
    return `#${number} has a Request changes from the Operator that no run has built yet, so its Request-changes run brings main in instead`;
  }
  const run = runInFlight(pullRequest, operator);
  if (run !== null) return `${runName(run)} on #${number} is still in flight, so main isn't brought in now: its push is rebased when it lands`;
  if (pullRequest.conflictAttempts.includes(main)) {
    return `#${number} was already tried against main at ${main.slice(0, 7)}, so it waits for main to move or for the Operator`;
  }
  if (mergeable === null) return `GitHub hadn't worked out whether #${number} conflicts with main, so it's left for the scheduled tick`;
  // Rebasing a PR that's only behind would push, and start a Review, on every PR after every merge.
  if (mergeable) return `#${number} doesn't conflict with main, so it's left as it is`;
  return null;
}

/**
 * The mechanical rebase of the PR's branch onto main, and what follows it.
 * Either way the PR goes back to draft first, so the push that follows starts
 * a full Review of the combined head, whose pass brings the PR back to the
 * Merge gate. A clean rebase is pushed, using no retry, and the attempt is
 * recorded once it has landed; if its lease refuses it, the PR goes back out
 * of draft with no attempt recorded, for the next check. A conflicting one
 * records the attempt, pushes nothing and starts the
 * conflict-only run through agent:implement on the Ticket, which resumes the
 * run now in flight on its open PR (src/loop/implement.ts).
 */
function rebaseOntoMain(pullRequest: PullRequestSnapshot, main: string): Action {
  const { number } = pullRequest;
  const ticket = pullRequest.ticket as number;
  const head = main.slice(0, 7);
  const branch = agentBranchFor(ticket);
  return {
    kind: "rebase-onto-main",
    pullRequest: number,
    branch,
    onto: main,
    clean: [{ kind: "convert-to-draft", pullRequest: number }],
    pushed: [
      {
        kind: "comment",
        issue: number,
        body: [
          conflictAttemptMarker({ main, outcome: "rebased" }),
          `\`main\` moved to ${head} and #${number} conflicted with it, so the Kit rebased \`${branch}\` onto it. The rebase was clean, so no agent ran and no retry was used.`,
          "",
          "The PR is back in draft, and Review runs again on the rebased head; a pass brings it back to you.",
        ].join("\n"),
      },
    ],
    // The branch moved between the rebase and its push: nothing landed, so nothing is recorded.
    refused: [{ kind: "mark-ready-for-review", pullRequest: number }],
    conflicted: [
      {
        kind: "comment",
        issue: number,
        body: [
          conflictAttemptMarker({ main, outcome: "conflict-run" }),
          `\`main\` moved to ${head} and #${number} conflicts with it, and rebasing \`${branch}\` onto it conflicts too.`,
          "",
          "A conflict-only Implementer run starts now on the Step-up model: it rebases the branch onto `main`, resolves the conflicts and changes nothing else. It uses no retry. The PR is back in draft, and Review runs again on the run's push.",
        ].join("\n"),
      },
      { kind: "convert-to-draft", pullRequest: number },
      // A fresh agent:implement on the Ticket starts the run in flight on its open PR. It notifies nobody.
      { kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] },
    ],
  };
}

/**
 * The conflict-only run an agent PR is owed, or null: the one the Kit's note
 * started, which hasn't pushed or ended. It runs on the Step-up model, on the
 * PR's branch, and is neither a Retry nor a Request-changes run.
 */
export function owedConflictRun(pullRequest: PullRequestSnapshot, config: KitConfig): Extract<Action, { kind: "start-agent-run" }> | null {
  const main = pullRequest.conflictRunInFlight;
  if (main === null || pullRequest.ticket === null || !pullRequest.isAgent || !pullRequest.open || !pullRequest.draft) return null;
  const { implement, stepUp } = config.roles;
  return {
    kind: "start-agent-run",
    role: "implement",
    issue: pullRequest.ticket,
    pullRequest: pullRequest.number,
    conflict: { main },
    model: stepUp.model,
    effort: stepUp.effort,
    timeoutMinutes: implement.timeoutMinutes,
  };
}

/**
 * A conflict-only run that ended without pushing: it failed, changed nothing,
 * didn't bring main in, or was refused. The Kit says why on the PR, ends the
 * run's time in flight, adds ready-for-human to the PR, and brings it back
 * out of draft to the Merge gate, where the Operator takes it from here. It
 * never closes the PR, and it doesn't try again until main moves to a new
 * head. The comment's @-mention is its one notification.
 */
export function conflictRunEnded(
  pullRequest: number,
  main: string,
  operator: string,
  why: string,
  runUrl: string | null = null,
  draft = true,
): Action[] {
  return [
    {
      kind: "comment",
      issue: pullRequest,
      body: [
        CONFLICT_RUN_ENDED_MARKER,
        `@${operator} The conflict-only run on #${pullRequest} didn't bring it up to date with \`main\` at ${main.slice(0, 7)}: ${why}.`,
        "",
        `The PR still conflicts with \`main\`, so it's yours to resolve: the Kit won't try again until \`main\` moves past ${main.slice(0, 7)}. No retry was used.`,
        ...(runUrl === null ? [] : ["", `[The run](${runUrl})`]),
      ].join("\n"),
    },
    { kind: "add-labels", issue: pullRequest, labels: [READY_FOR_HUMAN] },
    // Out of draft, the next conflict check weighs it again once main moves.
    ...(draft ? [{ kind: "mark-ready-for-review" as const, pullRequest }] : []),
  ];
}

/**
 * A Request-changes run told to merge main in (#341) that ended without
 * pushing: it couldn't bring main in, or the trust-root guard refused it. As
 * for a conflict-only run, the Kit says why on the PR, ends the run's time in
 * flight, adds ready-for-human to the PR, and brings it back out of draft to
 * the Merge gate. It never closes the PR, and the note counts as main's
 * conflict attempt, so the conflict check doesn't try again until main moves.
 */
export function requestChangesRunEnded(pullRequest: number, main: string, operator: string, why: string, runUrl: string): Action[] {
  return [
    {
      kind: "comment",
      issue: pullRequest,
      body: [
        requestChangesRunEndedMarker(main),
        `@${operator} The Request-changes run on #${pullRequest} didn't land: ${why}.`,
        "",
        `The PR conflicts with \`main\` at ${main.slice(0, 7)} and your requested changes aren't built, so it's yours from here: the Kit won't bring it up to date until \`main\` moves past ${main.slice(0, 7)}. No retry was used.`,
        "",
        `[The run](${runUrl})`,
      ].join("\n"),
    },
    { kind: "add-labels", issue: pullRequest, labels: [READY_FOR_HUMAN] },
    { kind: "mark-ready-for-review", pullRequest },
  ];
}
