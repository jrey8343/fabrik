// Conflicts with main (#304, ADR-0011): when main moves and leaves an agent PR
// at the Merge gate conflicting with it, the Kit brings the PR up to date
// itself instead of waiting for the Operator. A mechanical rebase comes first,
// with no agent; when it conflicts, one conflict-only Implementer run on the
// Step-up model resolves it. Neither uses a retry. Each PR gets one attempt per
// main head, recorded on the PR, and a PR only behind main is left alone. The
// loop is bounded: only the Operator merges to main, and neither attempt ever
// changes main, only the PR's own branch. A draft whose push GitHub never
// reviewed, because the draft conflicts with main, takes the same path (#389,
// ADR-0016): nothing else would move it on.
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
 * it conflicts with it, at the Merge gate or as a draft whose push GitHub never
 * reviewed (#389), or why there's neither. Such a draft waits `reviewMinutes`
 * from its push (reviewGraceMinutes).
 */
export function checkConflicts(
  conflicts: ConflictSnapshot,
  operator: string,
  held: number | null = null,
  runMinutes: number | undefined,
  reviewMinutes: number,
): Plan {
  const { main, now } = conflicts;
  const reasons: string[] = [];
  const actions: Action[] = [];
  for (const candidate of conflicts.pullRequests) {
    const undelivered = actOnUndelivered(candidate, operator, now, held, runMinutes, conflicts.implementJobUnderWay);
    if (undelivered !== null) {
      actions.push(...undelivered);
      continue;
    }
    if (main === null) {
      reasons.push("The default branch has no head, so no PR can conflict with it");
      continue;
    }
    const why = whyNotRebased(candidate, main, operator, now, reviewMinutes);
    if (why !== null) reasons.push(why);
    else actions.push(rebaseOntoMain(candidate.pullRequest, main));
  }
  if (actions.length > 0) return { kind: "act", actions };
  return { kind: "nothing", reason: reasons.length === 0 ? "No agent PR is open, so none conflicts with main" : reasons.join("; ") };
}

/** Why the Kit doesn't bring this PR up to date with main at `main` now, or null when it does. */
function whyNotRebased(
  { pullRequest, mergeable }: ConflictCandidate,
  main: string,
  operator: string,
  now: string,
  reviewMinutes: number,
): string | null {
  const { number } = pullRequest;
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return `#${number} isn't an open agent PR for a Ticket`;
  if (pullRequest.draft) {
    const why = whyNotUnreviewedDraft(pullRequest, mergeable, now, reviewMinutes);
    if (why !== null) return why;
  }
  // Its Request-changes run, which the Kit starts once the review is past its grace period, brings main in itself, by merging (#341).
  if (unnotedChangesRequests(pullRequest, operator).length > 0) {
    return `#${number} has a Request changes from the Operator that no run has started for yet, so its Request-changes run brings main in instead`;
  }
  const run = runInFlight(pullRequest);
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
 * How long a draft's push is left for a Review that did start, before the Kit
 * counts it as never reviewed (#389, ADR-0016): a Review is two jobs, the wait
 * for the PR's required checks and the Reviewer's, each given the Review
 * role's timeout, so a started one has ended by then.
 */
export function reviewGraceMinutes(reviewTimeoutMinutes: number): number {
  return 2 * reviewTimeoutMinutes;
}

/**
 * Why this draft isn't one whose push GitHub never reviewed (#389, ADR-0016),
 * or null when it is. GitHub starts no pull_request-family workflow while a PR
 * conflicts with its base, so a push onto a conflicting draft (a Retry's, a
 * first Implement run's, a Request-changes run's, or the Operator's) starts
 * no Review, and nothing else moves the draft on. The rest of whyNotRebased's
 * rules (a run in flight, one attempt per main head, a mergeable state
 * GitHub has worked out) apply to it as to a PR at the Merge gate.
 */
function whyNotUnreviewedDraft(pullRequest: PullRequestSnapshot, mergeable: boolean | null, now: string, reviewMinutes: number): string | null {
  const { number, headSha, headPushedAt } = pullRequest;
  const head = headSha.slice(0, 7);
  // A Verdict on its head: the Loop's next step is already decided, or the Operator parked it after a pass.
  if (pullRequest.verdicts.some((record) => record.headSha === headSha)) {
    return `#${number} is a draft with a Verdict on ${head}, so it isn't brought up to date with main`;
  }
  // Only a conflict keeps GitHub from starting the Review its push should have.
  if (mergeable !== false) return null;
  if (headPushedAt === null) return `#${number} is a draft and when ${head} was pushed isn't known, so it isn't brought up to date with main`;
  // A Review that did start, before main moved, is given its job's whole timeout to land.
  if (Date.parse(now) - Date.parse(headPushedAt) < reviewMinutes * 60_000) {
    return `#${number} is a draft pushed less than a Review's timeout ago, so a Review of ${head} may still land`;
  }
  return null;
}

/**
 * The mechanical rebase of the PR's branch onto main, and what follows it.
 * Either way a PR at the Merge gate goes back to draft first, so the push that
 * follows starts a full Review of the combined head, whose pass brings the PR
 * back to the Merge gate. A clean rebase is pushed, using no retry, and the
 * attempt is recorded once it has landed; if its lease refuses it, the PR goes
 * back out of draft with no attempt recorded, for the next check. A conflicting one
 * records the attempt, pushes nothing and starts the
 * conflict-only run through agent:implement on the Ticket, which resumes the
 * run now in flight on its open PR (src/loop/implement.ts).
 *
 * A draft whose push GitHub never reviewed (#389, ADR-0016) takes the same
 * path, but it's in draft already and stays there: a refused lease leaves it
 * for the next check, where a PR at the Merge gate goes back to it. Its notes
 * say that GitHub started no Review, and their markers say it was a draft, so
 * the Verdict that follows is marked as the unreviewed push's own would have
 * been, never as a conflict-only run's.
 */
function rebaseOntoMain(pullRequest: PullRequestSnapshot, main: string): Action {
  const { number, draft } = pullRequest;
  const ticket = pullRequest.ticket as number;
  const head = main.slice(0, 7);
  const branch = agentBranchFor(ticket);
  const unreviewedDraft = draft ? { unreviewedDraft: true as const } : {};
  const why = draft
    ? `#${number} is a draft that conflicts with \`main\` at ${head}, so GitHub started no Review of its last push`
    : `\`main\` moved to ${head} and #${number} conflicted with it`;
  const toDraft: Action[] = draft ? [] : [{ kind: "convert-to-draft", pullRequest: number }];
  return {
    kind: "rebase-onto-main",
    pullRequest: number,
    branch,
    onto: main,
    clean: toDraft,
    pushed: [
      {
        kind: "comment",
        issue: number,
        body: [
          conflictAttemptMarker({ main, outcome: "rebased", ...unreviewedDraft }),
          `${why}, so the Kit rebased \`${branch}\` onto it. The rebase was clean, so no agent ran and no retry was used.`,
          "",
          draft
            ? "The PR stays in draft, and Review runs on the rebased head."
            : "The PR is back in draft, and Review runs again on the rebased head; a pass brings it back to you.",
        ].join("\n"),
      },
    ],
    // The branch moved between the rebase and its push: nothing landed, so nothing is recorded. A draft stays one.
    refused: draft ? [] : [{ kind: "mark-ready-for-review", pullRequest: number }],
    conflicted: [
      {
        kind: "comment",
        issue: number,
        body: [
          conflictAttemptMarker({ main, outcome: "conflict-run", ...unreviewedDraft }),
          `${why}, and rebasing \`${branch}\` onto it conflicts too.`,
          "",
          draft
            ? "A conflict-only Implementer run starts now on the Step-up model: it rebases the branch onto `main`, resolves the conflicts and changes nothing else. The run uses no retry, but the Verdict on its push counts as one on the unreviewed push would have. The PR stays in draft, and Review runs on the run's push."
            : "A conflict-only Implementer run starts now on the Step-up model: it rebases the branch onto `main`, resolves the conflicts and changes nothing else. It uses no retry, but an Execution flaw on its push calls for one like any other. The PR is back in draft, and Review runs again on the run's push.",
        ].join("\n"),
      },
      ...toDraft,
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
    stepUp: true,
    stepUpReason: "conflict-only",
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
 * pushing: what it built still conflicts with main, or the trust-root guard
 * refused it. As for a conflict-only run, the Kit says why on the PR, ends the
 * run's time in flight, adds ready-for-human to the PR, and brings it back out
 * of draft to the Merge gate. It never closes the PR, and the note counts as
 * main's conflict attempt, so the conflict check doesn't try again until main
 * moves. The run settles nothing: once main moves and the PR is brought up to
 * date, an Execution flaw on it still gives way to the Operator's Request
 * changes, which no run has built yet.
 */
export function requestChangesRunEnded(pullRequest: number, main: string, operator: string, why: string, runUrl: string): Action[] {
  const head = main.slice(0, 7);
  return [
    {
      kind: "comment",
      issue: pullRequest,
      body: [
        requestChangesRunEndedMarker(main),
        `@${operator} The Request-changes run on #${pullRequest} didn't land: ${why}.`,
        "",
        `The Kit judged the run against \`main\` at ${head}, and your requested changes aren't built, so it's yours from here. The Kit won't bring it up to date until \`main\` moves past ${head}; when it does, your Request changes still goes first. No retry was used.`,
        "",
        `[The run](${runUrl})`,
      ].join("\n"),
    },
    { kind: "add-labels", issue: pullRequest, labels: [READY_FOR_HUMAN] },
    { kind: "mark-ready-for-review", pullRequest },
  ];
}
