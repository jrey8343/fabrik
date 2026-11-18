// Conflicts with main (#304, ADR-0011): when main moves and leaves an agent PR
// at the Merge gate conflicting with it, the Kit brings the PR up to date
// itself instead of waiting for the Operator. A mechanical rebase comes first,
// with no agent; when it conflicts, one conflict-only Implementer run on the
// Step-up model resolves it. Neither uses a retry. Each PR gets one attempt per
// main head, recorded on the PR, and a PR only behind main is left alone. The
// loop is bounded: only the Operator merges to main, and neither attempt ever
// changes main, only the PR's own branch. A draft whose push GitHub never
// reviewed, because the draft conflicts with main, takes the same path (#389,
// ADR-0016): nothing else would move it on. So does a draft whose Review passed
// while it conflicts with main, before the Merge gate opens (#480), and one whose
// Review stopped waiting because it conflicts (#704, ADR-0028), at once, with no
// grace period: the Review that period leaves room for has ended.
import { agentBranchFor } from "./agentPullRequest.ts";
import { type HeldOn, heldUntilThen, startsWhen } from "./hold.ts";
import { DISPATCH_LABEL, READY_FOR_HUMAN } from "./labels.ts";
import { flakyOnPassedHead, passedHeadAtGate } from "./flakyChecks.ts";
import { checkFixMarker, type CheckFixMark, conflictAttemptMarker, CONFLICT_RUN_ENDED_MARKER, handBackMarker, requestChangesRunEndedMarker } from "./markers.ts";
import type { Recovery } from "./recoveryWaits.ts";
import { checkNames } from "./checkNames.ts";
import { hasVerdictOn, runInFlight, runName, unstartedRetry } from "./retry.ts";
import { actOnUndelivered, unnotedChangesRequests } from "./undelivered.ts";
import type { Action, ConflictCandidate, ConflictSnapshot, InfrastructureFailure, KitConfig, MergeableSnapshot, PassedHeadChecks, Plan, PullRequestSnapshot } from "./types.ts";

/**
 * The conflict check, on a push to the default branch or the scheduled tick:
 * for each open agent PR, what follows a Retry that never started
 * (src/loop/retry.ts, #416), or the Request-changes run for an undelivered
 * Request changes on it (src/loop/undelivered.ts, #341), or else a rebase onto main if
 * it conflicts with it, at the Merge gate or as a draft whose push GitHub never
 * reviewed (#389), or why there's neither. Each recovery waits as long as
 * `waits`, the record of recovery waits at the repo's Kit config
 * (src/loop/recoveryWaits.ts), says. `heldTickets` are the Tickets whose
 * Implement run is held until a reset (#424). On the scheduled tick, `fixes`
 * are the check's issues closed as completed and the tick's read of the heads
 * at the Merge gate: a PR a fixed check holds there, whose issue closed since
 * its pass, is brought up to date though it may be only behind main, should
 * the issue-closed event have missed it (#784).
 */
export function checkConflicts(
  conflicts: ConflictSnapshot,
  operator: string,
  held: HeldOn | null,
  waits: Readonly<Record<Recovery, number>>,
  heldTickets: readonly number[],
  fixes: CheckFixes | null = null,
): Plan {
  const { main, now } = conflicts;
  const reasons: string[] = [];
  const actions: Action[] = [];
  for (const candidate of conflicts.pullRequests) {
    // A Retry may be working until the Implement job's timeout has passed.
    const unstarted = unstartedRetry(candidate.pullRequest, operator, now, waits.unstartedRetry, conflicts.implementJobUnderWay);
    if (unstarted !== null) {
      actions.push(...unstarted);
      continue;
    }
    const undelivered = actOnUndelivered(candidate, operator, now, held, waits.undeliveredRequestChanges, conflicts.implementJobUnderWay, heldTickets);
    if (undelivered !== null) {
      actions.push(...undelivered);
      continue;
    }
    if (main === null) {
      reasons.push("The default branch has no head, so no PR can conflict with it");
      continue;
    }
    const why = whyNotRebased(candidate, main, operator, { now, reviewMinutes: waits.unreviewedDraft });
    const fixed = fixes === null ? [] : fixesHolding(candidate.pullRequest, fixes.closed, greenAtGate(candidate.pullRequest, fixes.passedHeads));
    if (fixed.length > 0) {
      const done = fixBroughtIn(candidate, main, why, fixed, held);
      if (Array.isArray(done)) actions.push(...done);
      else reasons.push(done.reason);
    } else if (why !== null) reasons.push(why.reason);
    else actions.push(rebaseOntoMain(candidate.pullRequest, main, held));
  }
  if (actions.length > 0) return { kind: "act", actions };
  return { kind: "nothing", reason: reasons.length === 0 ? "No agent PR is open, so none conflicts with main" : reasons.join("; ") };
}

/** When a conflict check runs, and the unreviewed-draft grace period it leaves a draft's push, in minutes (ADR-0016). */
interface Grace {
  readonly now: string;
  readonly reviewMinutes: number;
}

/**
 * Which of whyNotRebased's rules keeps a PR as it is: a Request changes no run
 * has started for, a run in flight, an attempt already made against this main
 * head, a mergeable state GitHub hadn't worked out, no conflict, or any other.
 */
type NotRebasedRule = "undelivered" | "in-flight" | "tried" | "unknown" | "clean" | "other";

/** Why the Kit doesn't bring a PR up to date with main now: the rule, and the reason the conflict check gives. */
interface NotRebased {
  readonly rule: NotRebasedRule;
  readonly reason: string;
}

/**
 * Why the Kit doesn't bring this PR up to date with main at `main` now, or
 * null when it does. `grace` is when the check runs and the unreviewed-draft
 * grace period, for a draft whose push may still have a Review under way;
 * null when the caller knows its Review has ended (#704), so a conflicting
 * draft is brought up to date with no wait.
 */
function whyNotRebased(
  { pullRequest, mergeable }: ConflictCandidate,
  main: string,
  operator: string,
  grace: Grace | null,
): NotRebased | null {
  const { number } = pullRequest;
  const other = (reason: string): NotRebased => ({ rule: "other", reason });
  if (!pullRequest.isAgent || pullRequest.ticket === null || !pullRequest.open) return other(`#${number} isn't an open agent PR for a Ticket`);
  if (pullRequest.draft) {
    const why = whyNotUnreviewedDraft(pullRequest, mergeable, grace);
    if (why !== null) return other(why);
  }
  // Its Request-changes run, which the Kit starts once the review is past its grace period, brings main in itself, by merging (#341).
  if (unnotedChangesRequests(pullRequest, operator).length > 0) {
    return { rule: "undelivered", reason: `#${number} has a Request changes from the Operator that no run has started for yet, so its Request-changes run brings main in instead` };
  }
  const run = runInFlight(pullRequest);
  if (run !== null) return { rule: "in-flight", reason: `${runName(run)} on #${number} is still in flight, so main isn't brought in now: its push is rebased when it lands` };
  if (pullRequest.conflictAttempts.includes(main)) {
    return { rule: "tried", reason: `#${number} was already tried against main at ${main.slice(0, 7)}, so it waits for main to move or for the Operator` };
  }
  if (mergeable === null) return { rule: "unknown", reason: `GitHub hadn't worked out whether #${number} conflicts with main, so it's left for the scheduled tick` };
  // Rebasing a PR that's only behind would push, and start a Review, on every PR after every merge.
  if (mergeable) return { rule: "clean", reason: `#${number} doesn't conflict with main, so it's left as it is` };
  return null;
}

/**
 * Why this draft isn't one whose push GitHub never reviewed (#389, ADR-0016),
 * or null when it is. GitHub starts no pull_request-family workflow while a PR
 * conflicts with its base, so a push onto a conflicting draft (a Retry's, a
 * first Implement run's, a Request-changes run's, or the Operator's) starts
 * no Review, and nothing else moves the draft on. The rest of whyNotRebased's
 * rules (a run in flight, one attempt per main head, a mergeable state
 * GitHub has worked out) apply to it as to a PR at the Merge gate. A push is
 * left `reviewMinutes` (the record's unreviewedDraft) for a Review that did
 * start before the Kit counts it as never reviewed; with no `grace`, the
 * caller knows that Review has ended (#704), so there's nothing to leave.
 */
function whyNotUnreviewedDraft(
  pullRequest: PullRequestSnapshot,
  mergeable: boolean | null,
  grace: Grace | null,
): string | null {
  const { number, headSha, headPushedAt } = pullRequest;
  const head = headSha.slice(0, 7);
  // A Verdict on its head: the Loop's next step is already decided, or the Operator parked it after a pass.
  if (hasVerdictOn(pullRequest, headSha)) {
    return `#${number} is a draft with a Verdict on ${head}, so it isn't brought up to date with main`;
  }
  // Only a conflict keeps GitHub from starting the Review its push should have.
  if (mergeable !== false || grace === null) return null;
  const { now, reviewMinutes } = grace;
  if (headPushedAt === null) return `#${number} is a draft and when ${head} was pushed isn't known, so it isn't brought up to date with main`;
  // A Review that did start, before main moved, is given its job's whole timeout to land.
  if (Date.parse(now) - Date.parse(headPushedAt) < reviewMinutes * 60_000) {
    return `#${number} is a draft pushed less than a Review's timeout ago, so a Review of ${head} may still land`;
  }
  return null;
}

/**
 * Where an agent PR stands when the Kit brings it up to date with main: at
 * the Merge gate, a draft whose push GitHub never reviewed (#389, ADR-0016),
 * or a draft its Review just passed while it conflicts with main (#480).
 */
type Stance = "merge-gate" | "unreviewed-draft" | "passed-draft";

/** What bringing a PR up to date says and does, for where it stands. */
interface StanceNotes {
  /** Why the Kit is bringing it up to date. */
  why: string;
  /** What follows "so the Kit rebased the branch onto it". */
  rebasedTail: string;
  /** What happens next after a clean rebase is pushed. */
  pushed: string;
  /** What the conflict-only run counts as, and what happens next. */
  conflicted: string;
  /** Whether it's at the Merge gate: it goes back to draft, and back out of it on a refused lease. */
  atMergeGate: boolean;
  /** Whether its markers say it was a draft GitHub never reviewed. */
  unreviewedDraft: boolean;
}

function stanceNotes(stance: Stance, number: number, head: string): StanceNotes {
  const executionFlaw = "It uses no retry, but an Execution flaw on its push calls for one like any other.";
  switch (stance) {
    case "merge-gate":
      return {
        why: `\`main\` moved to ${head} and #${number} conflicted with it`,
        rebasedTail: "",
        pushed: "The PR is back in draft, and Review runs again on the rebased head; a pass brings it back to you.",
        conflicted: `${executionFlaw} The PR is back in draft, and Review runs again on the run's push.`,
        atMergeGate: true,
        unreviewedDraft: false,
      };
    case "unreviewed-draft":
      return {
        why: `#${number} is a draft that conflicts with \`main\` at ${head}, so GitHub started no Review of its last push`,
        rebasedTail: "",
        pushed: "The PR stays in draft, and Review runs on the rebased head.",
        conflicted: "The run uses no retry, but the Verdict on its push counts as one on the unreviewed push would have. The PR stays in draft, and Review runs on the run's push.",
        atMergeGate: false,
        unreviewedDraft: true,
      };
    case "passed-draft":
      return {
        why: `#${number} passed its Review but conflicts with \`main\` at ${head}`,
        rebasedTail: " before asking for your review",
        pushed: "The PR stays in draft, and Review runs again on the rebased head; a pass brings it to you.",
        conflicted: `${executionFlaw} The PR stays in draft, and Review runs again on the run's push; a pass brings it to you.`,
        atMergeGate: false,
        unreviewedDraft: false,
      };
  }
}

/**
 * The mechanical rebase of the PR's branch onto main, and what follows it.
 * Either way a PR at the Merge gate goes back to draft first, so the push that
 * follows starts a full Review of the combined head, whose pass brings the PR
 * back to the Merge gate. A clean rebase is pushed, using no retry, and the
 * attempt is recorded once it has landed; if its lease refuses it, the PR goes
 * back out of draft, with a comment saying why, and no attempt recorded, for
 * the next check. A conflicting one
 * records the attempt, pushes nothing and starts the
 * conflict-only run through agent:implement on the Ticket, which resumes the
 * run now in flight on its open PR (src/loop/implement.ts).
 *
 * A draft whose push GitHub never reviewed (#389, ADR-0016) takes the same
 * path, but it's in draft already and stays there: a refused lease leaves it
 * for the next check, where a PR at the Merge gate goes back to it. Its notes
 * say that GitHub started no Review, and their markers say it was a draft, so
 * the Verdict that follows is marked as the unreviewed push's own would have
 * been, never as a conflict-only run's. A draft its Review passed
 * (upToDateBeforeMergeGate) stays in draft too, but its notes are a Merge-gate
 * PR's: its push was judged, so a conflict-only run's Verdict is marked as one.
 */
function rebaseOntoMain(
  pullRequest: PullRequestSnapshot,
  main: string,
  held: HeldOn | null,
  stance: Stance = pullRequest.draft ? "unreviewed-draft" : "merge-gate",
  noteBodies: RebaseNoteBodies | null = null,
): Action {
  const { number } = pullRequest;
  const ticket = pullRequest.ticket as number;
  const branch = agentBranchFor(ticket);
  const notes = stanceNotes(stance, number, main.slice(0, 7));
  const said = noteBodies ?? stanceNoteBodies(notes, branch, number, held);
  const unreviewedDraft = notes.unreviewedDraft ? { unreviewedDraft: true as const } : {};
  const toDraft: Action[] = notes.atMergeGate ? [{ kind: "convert-to-draft", pullRequest: number }] : [];
  const comment = (body: string): Action => ({ kind: "comment", issue: number, body });
  return {
    kind: "rebase-onto-main",
    pullRequest: number,
    branch,
    onto: main,
    clean: toDraft,
    pushed: [comment([conflictAttemptMarker({ main, outcome: "rebased", ...unreviewedDraft }), said.pushed].join("\n"))],
    // The branch moved between the rebase and its push: nothing landed, so nothing is recorded. A draft stays one, and
    // a PR put in draft for the push says why it's back out (#436). Unmarked, so the next check tries again.
    refused: [...(notes.atMergeGate ? [{ kind: "mark-ready-for-review" as const, pullRequest: number }] : []), ...(said.refused === null ? [] : [comment(said.refused)])],
    conflicted: [
      comment([conflictAttemptMarker({ main, outcome: "conflict-run", ...unreviewedDraft }), said.conflicted].join("\n")),
      ...toDraft,
      // A fresh agent:implement on the Ticket starts the run in flight on its open PR. It notifies nobody.
      { kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] },
    ],
  };
}

/**
 * What a rebase's notes say after their marker: once pushed, once its lease
 * refused it (null for none), and once it conflicted. A stance's own, unless
 * its caller words them itself (afterConflictedReview).
 */
interface RebaseNoteBodies {
  readonly pushed: string;
  readonly refused: string | null;
  readonly conflicted: string;
}

/** The notes a rebase gives for where the PR stands: a draft's lease refusal says nothing, for the next check. */
function stanceNoteBodies(notes: StanceNotes, branch: string, number: number, held: HeldOn | null): RebaseNoteBodies {
  return {
    pushed: [`${notes.why}, so the Kit rebased \`${branch}\` onto it${notes.rebasedTail}. The rebase was clean, so no agent ran and no retry was used.`, "", notes.pushed].join("\n"),
    refused: notes.atMergeGate
      ? `${notes.why}, so the Kit rebased \`${branch}\` onto it, but the branch moved before the rebase could be pushed, so nothing landed. #${number} is back out of draft as it was, and the next conflict check tries again.`
      : null,
    conflicted: [
      `${notes.why}, and rebasing \`${branch}\` onto it conflicts too.`,
      "",
      `A conflict-only Implementer run ${startsWhen(held)}, on the Step-up model: it rebases the branch onto \`main\`, resolves the conflicts and changes nothing else. ${notes.conflicted}${heldUntilThen(held)}`,
    ].join("\n"),
  };
}

/**
 * What the Loop does after a Review whose checks wait stopped because its
 * draft conflicts with main (#704, ADR-0028), from its own read of whether the
 * PR conflicts, `mergeable`, not the wait's. While it conflicts, it takes the
 * unreviewed-draft path (ADR-0016) at once, with no grace period, since that
 * Review has ended: the rebase, else the conflict-only run, its Verdict
 * counted as the unreviewed push's would have been, and every other rule of
 * that path still applies. Its notes lead with what happened, naming the
 * checks GitHub didn't start (`unstarted`), then say in bold whether the
 * Operator has to act; only when they do does a note mention them and hand
 * the PR back. When the Kit can't move the PR on from here, the note says why,
 * what will, and how to move it sooner by hand. When it no longer conflicts,
 * nothing will: GitHub won't start the checks on its head until something is
 * pushed, so that note is the Operator's. Null for a PR
 * that isn't an open agent draft for a Ticket, which a Review no longer
 * weighs.
 */
export function afterConflictedReview(
  pullRequest: PullRequestSnapshot,
  mergeable: MergeableSnapshot,
  unstarted: readonly string[],
  operator: string,
  held: HeldOn | null,
): Action[] | null {
  const { number, ticket } = pullRequest;
  if (!pullRequest.isAgent || ticket === null || !pullRequest.open || !pullRequest.draft) return null;
  const branch = agentBranchFor(ticket);
  const checks = unstarted.length === 0 ? "its Required checks" : checkNames(unstarted, "or");
  const main = mergeable.main;
  const at = main === null ? "" : ` at ${main.slice(0, 7)}`;
  const opening = `Review couldn't start on #${number}: it conflicts with \`main\`${at}, and GitHub doesn't run ${checks} on a PR it can't merge. Your workflows are fine.`;
  const sooner = `To move sooner, merge \`main\` into \`${branch}\` yourself and push.`;
  /** A note the Operator needn't act on: it mentions nobody and hands nothing back. */
  const noActionNote = (said: string): Action[] => [{ kind: "comment", issue: number, body: [opening, "", said].join("\n") }];
  /** A note only the Operator can act on: it mentions them, and hands the PR back. */
  const handedBack = (first: string, said: string): Action[] => [
    { kind: "comment", issue: number, body: [`@${operator} ${first}`, "", `**This needs you.** ${said}`, handBackMarker({ kind: "conflicted-review", role: "review" })].join("\n") },
  ];
  const mergeYourself = `Merge \`main\` into \`${branch}\` and push, and Review starts on the push.`;
  if (main === null) return noActionNote(`**You don't need to do anything yet.** The default branch's head couldn't be read, so the Kit left #${number} for a later conflict check. ${sooner}`);
  const why = whyNotRebased({ pullRequest, mergeable: mergeable.mergeable }, main, operator, null);
  if (why === null) {
    return [
      rebaseOntoMain(pullRequest, main, held, "unreviewed-draft", {
        pushed: [opening, "", `**You don't need to do anything.** The Kit rebased \`${branch}\` onto \`main\` cleanly and pushed it, so no agent ran and no retry was used. Review starts on the rebased head.`].join("\n"),
        refused: [
          opening,
          "",
          `**You don't need to do anything.** The Kit rebased \`${branch}\` onto \`main\`, but the branch moved before the rebase could be pushed, so nothing landed. Review starts on that push if it merges cleanly with \`main\`; if it still conflicts, a later conflict check brings it up to date.`,
        ].join("\n"),
        conflicted: [
          opening,
          "",
          `**You don't need to do anything.** Rebasing \`${branch}\` onto \`main\` conflicts too, so a conflict-only Implementer run ${startsWhen(held)}, on the Step-up model: it rebases the branch onto \`main\`, resolves the conflicts and changes nothing else. It uses no retry, and the Verdict on its push counts as one on the unreviewed push would have. Review starts on the run's push.${heldUntilThen(held)}`,
        ].join("\n"),
      }),
    ];
  }
  // It conflicted while the Review waited, but merges cleanly now: GitHub starts the checks on a push, and only a push.
  // A run that pushes, in flight or owed for a Request changes, starts them; nothing else will.
  if (mergeable.mergeable === true && why.rule !== "undelivered" && why.rule !== "in-flight") {
    return handedBack(
      `Review couldn't start on #${number}: it conflicted with \`main\` while Review waited, and GitHub doesn't run ${checks} on a PR it can't merge. Your workflows are fine.`,
      `#${number} merges cleanly with \`main\`${at} now, but GitHub won't start the checks on \`${pullRequest.headSha.slice(0, 7)}\` until something is pushed to \`${branch}\`. ${mergeYourself}`,
    );
  }
  switch (why.rule) {
    case "undelivered":
      return noActionNote(`**You don't need to do anything.** #${number} has a Request changes from you that no run has started for yet, and the Request-changes run brings \`main\` in when it starts. ${sooner}`);
    case "in-flight": {
      const run = runInFlight(pullRequest);
      return noActionNote(`**You don't need to do anything.** ${run === null ? "A run" : runName(run)} on #${number} is still in flight, so the Kit isn't bringing the branch up to date now: its push is rebased when it lands. ${sooner}`);
    }
    case "unknown":
      return noActionNote(
        `**You don't need to do anything yet.** GitHub hadn't worked out whether #${number} still conflicts with \`main\`, so the Kit left it for a later conflict check, which brings it up to date if it does. If it merges cleanly, GitHub won't start the checks on \`${pullRequest.headSha.slice(0, 7)}\` until something is pushed to \`${branch}\`. ${sooner}`,
      );
    // A later conflict check tries again once main moves past this head.
    case "tried":
      return noActionNote(`**You don't need to do anything.** The Kit already tried to bring #${number} up to date with \`main\`${at}, so it tries again once \`main\` moves. ${sooner}`);
    default:
      return handedBack(opening, `The Kit isn't bringing it up to date from here: ${why.reason}. ${mergeYourself}`);
  }
}

/**
 * What a pass on an agent draft PR that conflicts with main does in place of
 * opening the Merge gate (#480): the rebase onto main, or the conflict-only
 * run, as at the Merge gate, with the PR kept in draft, so the pass on the
 * up-to-date head is what asks for the Operator's review. Null when it
 * doesn't conflict, GitHub hadn't worked that out, or the Kit already tried
 * against this head of main: one attempt per head, as for the conflict check.
 */
export function upToDateBeforeMergeGate(
  pullRequest: PullRequestSnapshot,
  mergeable: MergeableSnapshot | null,
  held: HeldOn | null,
): Action | null {
  if (mergeable === null || mergeable.main === null || mergeable.mergeable !== false) return null;
  if (pullRequest.ticket === null || pullRequest.conflictAttempts.includes(mergeable.main)) return null;
  return rebaseOntoMain(pullRequest, mergeable.main, held, "passed-draft");
}

/**
 * A check whose issue closed as completed, so its fix is on main (#784): the
 * check, its issue, and when it closed; null when it closed just now, as the
 * issue-closed event says.
 */
export interface FixedCheck {
  readonly check: string;
  readonly issue: number;
  readonly closedAt: string | null;
}

/** What the tick's conflict check weighs of the check's fixes (#784): the check's issues closed as completed, and its read of the heads at the Merge gate. */
export interface CheckFixes {
  readonly closed: readonly FixedCheck[];
  readonly passedHeads: readonly PassedHeadChecks[];
}

/** The checks that have since read green on this PR's head at the Merge gate, as the tick's own read of it finds (#693). */
function greenAtGate(pullRequest: PullRequestSnapshot, passedHeads: readonly PassedHeadChecks[]): string[] {
  const head = passedHeads.find((read) => read.pullRequest === pullRequest.number && read.headSha === pullRequest.headSha);
  return head === undefined ? [] : flakyOnPassedHead({ ...head, marks: [] }).map(({ name }) => name);
}

/**
 * Of these `fixed` checks, each that holds this PR at the Merge gate (#784):
 * it is an open agent PR out of draft whose latest pass, on its current head,
 * names an Unrelated failure of the check, which hasn't since read green
 * there, by a Flaky check line or the tick's read (`green`), and whose issue
 * closed since that pass. One the Kit has already brought up to date for on
 * this head is spent (CheckFixMark).
 */
function fixesHolding(pullRequest: PullRequestSnapshot, fixed: readonly FixedCheck[], green: readonly string[]): FixedCheck[] {
  const head = passedHeadAtGate(pullRequest);
  if (head === null || pullRequest.ticket === null) return [];
  const pass = pullRequest.verdicts.findLast((record) => record.verdict === "pass");
  const greenHere = new Set([...green, ...pullRequest.flakyCheckMarks.filter((mark) => mark.headSha === head).flatMap((mark) => mark.checks)]);
  const spent = new Set(pullRequest.checkFixMarks.filter((mark) => mark.headSha === head).flatMap((mark) => mark.fixes.map(({ check }) => check)));
  const passedAt = pullRequest.verdictPostedAt;
  const sincePass = ({ closedAt }: FixedCheck) => closedAt === null || (passedAt !== null && Date.parse(closedAt) > Date.parse(passedAt));
  const seen = new Set<string>();
  return fixed.filter((fix) => {
    if (seen.has(fix.check)) return false;
    const holds = (pass?.unrelated ?? []).includes(fix.check) && !greenHere.has(fix.check) && !spent.has(fix.check) && sincePass(fix);
    if (holds) seen.add(fix.check);
    return holds;
  });
}

/**
 * What bringing this PR up to date for its checks' fixes does (#784), given
 * why ADR-0011 wouldn't otherwise (`why`): only being behind main doesn't stop
 * it, as the one exception to that rule, but everything else ADR-0011 leaves
 * alone stays alone. A PR whose head already holds main's has nothing to bring
 * in, so the Kit pushes nothing and records that once. Its notes say the fix
 * for each check landed, naming its issue, and carry the attempt marker, as
 * any bring-up-to-date's do, and the record of the move (CheckFixMark).
 */
function fixBroughtIn(
  { pullRequest, holdsMain }: ConflictCandidate,
  main: string,
  why: NotRebased | null,
  fixes: readonly FixedCheck[],
  held: HeldOn | null,
): Action[] | NotRebased {
  if (why !== null && why.rule !== "clean") return why;
  const { number, headSha } = pullRequest;
  const head = main.slice(0, 7);
  const checks = checkNames(fixes.map(({ check }) => check));
  const issues = issueList(fixes.map(({ issue }) => issue));
  const record = (outcome: CheckFixMark["outcome"]) => checkFixMarker({ headSha, main, outcome, fixes: fixes.map(({ check, issue }) => ({ check, issue })) });
  const it = fixes.length === 1 ? "it" : "them";
  const landed = `The fix for ${checks} landed: ${issues} closed as completed. #${number} was held at the Merge gate by an Unrelated failure of ${it}`;
  // It can only conflict with a main it doesn't hold.
  if (why !== null && holdsMain === true) {
    return [
      {
        kind: "comment",
        issue: number,
        body: [record("held-main"), `${landed}, but its head ${headSha.slice(0, 7)} already holds \`main\` at ${head}, so there was nothing to bring in and nothing was pushed.`].join("\n"),
      },
    ];
  }
  if (why !== null && holdsMain !== false) {
    return { rule: "unknown", reason: `Whether #${number} already holds main at ${head} couldn't be read, so bringing in the fix for ${checks} waits for the next scheduled tick` };
  }
  const notes: StanceNotes = {
    ...stanceNotes("merge-gate", number, head),
    why: `${landed}, and \`main\` is at ${head}`,
    pushed: "The PR is back in draft, and Review runs again on the rebased head, which holds the fix; a pass brings it back to you.",
  };
  const said = stanceNoteBodies(notes, agentBranchFor(pullRequest.ticket as number), number, held);
  return [
    rebaseOntoMain(pullRequest, main, held, "merge-gate", {
      pushed: [record("rebased"), said.pushed].join("\n"),
      refused: said.refused,
      conflicted: [record("conflict-run"), said.conflicted].join("\n"),
    }),
  ];
}

/** Issue numbers as a note lists them: `#12`, `#12 and #13`, `#12, #13 and #14`. */
function issueList(issues: readonly number[]): string {
  const refs = issues.map((issue) => `#${issue}`);
  const last = refs.pop();
  return refs.length === 0 ? (last ?? "") : `${refs.join(", ")} and ${last}`;
}

/**
 * What a check's issue closing as completed does (#784): each open agent PR
 * that check holds at the Merge gate (fixesHolding) is brought up to date by
 * ADR-0011's path, though it may be only behind main. Every other PR, and
 * every other rule of the conflict check, waits for its own event.
 */
export function bringInCheckFix(conflicts: ConflictSnapshot, fixed: FixedCheck, operator: string, held: HeldOn | null): Plan {
  const { main, now } = conflicts;
  const holding = conflicts.pullRequests.flatMap((candidate) => {
    const fixes = fixesHolding(candidate.pullRequest, [fixed], []);
    return fixes.length === 0 ? [] : [{ candidate, fixes }];
  });
  const check = checkNames([fixed.check]);
  if (holding.length === 0) return { kind: "nothing", reason: `No agent PR at the Merge gate is held by an Unrelated failure of ${check}, so its fix has nothing to bring up to date` };
  if (main === null) return { kind: "nothing", reason: "The default branch has no head, so there's no fix to bring in" };
  const actions: Action[] = [];
  const reasons: string[] = [];
  for (const { candidate, fixes } of holding) {
    const why = whyNotRebased(candidate, main, operator, { now, reviewMinutes: 0 });
    const done = fixBroughtIn(candidate, main, why, fixes, held);
    if (Array.isArray(done)) actions.push(...done);
    else reasons.push(done.reason);
  }
  return actions.length > 0 ? { kind: "act", actions } : { kind: "nothing", reason: reasons.join("; ") };
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
 * head. The comment's @-mention is its one notification. `failure` is how it
 * failed, when it did: the notice's hand-back names it, as a failed run's
 * does, so a reader of the thread can tell a run that failed from one that
 * ended with nothing to push (src/loop/digestFacts.ts).
 */
export function conflictRunEnded(
  pullRequest: number,
  main: string,
  operator: string,
  why: string,
  runUrl: string | null = null,
  draft = true,
  failure: InfrastructureFailure | null = null,
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
        handBackMarker({ kind: "conflict-run-unlanded", role: "implement", ...(failure === null ? {} : { failure }) }),
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
        handBackMarker({ kind: "request-changes-unlanded", role: "implement" }),
      ].join("\n"),
    },
    { kind: "add-labels", issue: pullRequest, labels: [READY_FOR_HUMAN] },
    { kind: "mark-ready-for-review", pullRequest },
  ];
}
