// Reads the Kit's history back from an issue's or a PR's comments, through
// the markers the core writes on them (src/loop/markers.ts), into snapshot
// fields, and drops the push notes whose push never landed (landedPushNotes)
// before they're read. Pure, no I/O. The snapshot passes in only the comments a marker may
// come from: a bot's, where quoting one mustn't fake it.
import type { SentBack } from "../loop/backToDesign.ts";
import { changeIn } from "../loop/changeFingerprint.ts";
import {
  BACK_TO_DESIGN_MARKER,
  conflictAttemptIn,
  CONFLICT_RUN_ENDED_MARKER,
  CONFLICT_RUN_MARKER,
  DESIGN_ROUND_MARKER,
  DESIGN_TURN_FAILED_MARKER,
  isBrokenRunComment,
  isEmptyDiffComment,
  LIVE_OUTCOME_MARKER,
  PROTOTYPE_FAILURE_ROUND_MARKER,
  PROTOTYPE_ROUND_MARKER,
  type PrototypeRequestMarker,
  prototypeRequestIn,
  prototypeStartedIn,
  pushedHeadIn,
  REQUEST_CHANGES_RUN_EMPTY_MARKER,
  REQUEST_CHANGES_RUN_MARKER,
  requestChangesRunEndedIn,
  IMPLEMENT_RUN_FAILED_MARKER,
  RESEARCH_RUN_FAILED_MARKER,
  RETRY_ENDED_MARKER,
  RETRY_PUSH_MARKER,
  RETRY_RESTARTED_MARKER,
  SESSION_FINISHED,
  startedReviewsIn,
  stuckTriggerGaveUpMarker,
  stuckTriggerReaddedMarker,
  UNMARKED_RETRY_PUSH,
  VERDICT_MARKER,
  flakyCheckMarksIn,
} from "../loop/markers.ts";
import type { TriggerLabel } from "../loop/labels.ts";
import type { IssueSnapshot, PendingPrototype, PullRequestSnapshot, UnbuiltChangesRequest, Verdict, VerdictRecord } from "../loop/types.ts";
import { VERDICTS } from "../loop/verdict.ts";

/**
 * The Verdicts recorded in these comments, oldest first. Comments without a
 * valid marker are skipped. One whose head the Kit's Flaky check line marks
 * counted back reads as flaky (#462). Each carries the fingerprint its
 * comment records under the marker, if it records one (#643).
 */
export function verdictsIn(commentBodies: readonly string[]): VerdictRecord[] {
  const countedBack = new Set(flakyCheckMarksIn(commentBodies).flatMap((mark) => (mark.countedBack === true ? [mark.headSha] : [])));
  return commentBodies.flatMap((body) => {
    const record = readVerdictMarker(body);
    if (record === null) return [];
    return [record.source === "ci" && countedBack.has(record.headSha) ? { ...record, flaky: true as const } : record];
  });
}

function readVerdictMarker(body: string): VerdictRecord | null {
  const json = VERDICT_MARKER.exec(body)?.[1];
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { verdict, source, requestChanges, conflictRun = false, requestChangesFirst, ticketNotReady = false, checks, headSha } = value as Record<string, unknown>;
  if (!VERDICTS.includes(verdict as Verdict)) return null;
  if (source !== "reviewer" && source !== "ci" && source !== "empty-diff" && source !== "broken-run") return null;
  // A marker from before conflict-only runs (#304) has no conflictRun, and none came from one; likewise requestChangesFirst (#341).
  if (typeof requestChanges !== "boolean" || typeof conflictRun !== "boolean") return null;
  if (requestChangesFirst !== undefined && !isReviewIds(requestChangesFirst)) return null;
  // Likewise ticketNotReady (#416).
  if (typeof ticketNotReady !== "boolean") return null;
  if (typeof headSha !== "string") return null;
  // Likewise checks (#462), which only a Verdict from red required checks carries.
  const named = Array.isArray(checks) && checks.every((name) => typeof name === "string") ? { checks: checks as string[] } : {};
  // The fingerprint of the PR's own change (#643), from the line under the marker; a Verdict from before it has none.
  const change = changeIn(body);
  return {
    verdict: verdict as Verdict,
    source,
    requestChanges,
    ...(conflictRun ? { conflictRun: true as const } : {}),
    ...(requestChangesFirst === undefined ? {} : { requestChangesFirst }),
    ...(ticketNotReady ? { ticketNotReady: true as const } : {}),
    ...named,
    ...(change === null ? {} : { change }),
    headSha,
  };
}

/** Whether a marker's field is a non-empty list of review ids. */
function isReviewIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * Whether a PR's latest push came from a Request-changes run, from the Fabrik
 * App's comments on it, oldest first: its last note of such a push, or that
 * such a run committed nothing (#388), has no Verdict after it yet, so the
 * next Verdict is marked as from that run.
 */
export function requestChangesRunIn(commentBodies: readonly string[]): boolean {
  let latest = false;
  for (const body of commentBodies) {
    if (isRequestChangesRunOutcome(body)) latest = true;
    else if (verdictsIn([body]).length > 0) latest = false;
  }
  return latest;
}

/**
 * Whether a PR's latest push came from a conflict-only run (#304), from the
 * Fabrik App's comments on it, oldest first, as requestChangesRunIn reads a
 * Request-changes run's: the next Verdict is marked as from that run. One
 * started on a draft whose push GitHub never reviewed (#389) doesn't count:
 * its Verdict is the first judgment of that push's work, so it's marked as
 * that push's own would have been.
 */
export function conflictRunIn(commentBodies: readonly string[]): boolean {
  let latest = false;
  commentBodies.forEach((body, at) => {
    if (body.startsWith(CONFLICT_RUN_MARKER)) latest = !startedOnUnreviewedDraft(commentBodies.slice(0, at));
    else if (verdictsIn([body]).length > 0) latest = false;
  });
  return latest;
}

/** Whether the latest attempt note in these comments that started a conflict-only run was on a draft whose push GitHub never reviewed (#389). */
function startedOnUnreviewedDraft(commentBodies: readonly string[]): boolean {
  let latest = false;
  for (const body of commentBodies) {
    const attempt = conflictAttemptIn(body);
    if (attempt?.outcome === "conflict-run") latest = attempt.unreviewedDraft === true;
  }
  return latest;
}

/**
 * Whether the conflict-only run in flight on a PR (conflictRunInFlightIn) was
 * started on a draft whose push GitHub never reviewed (#389), from the Fabrik
 * App's comments on it, oldest first: its push note doesn't say its Verdict
 * uses no retry.
 */
export function conflictRunOnUnreviewedDraftIn(commentBodies: readonly string[]): boolean {
  return conflictRunInFlightIn(commentBodies) !== null && startedOnUnreviewedDraft(commentBodies);
}

/** The default branch heads the Kit's attempt notes on a PR record (#304), oldest first. */
export function conflictAttemptsIn(commentBodies: readonly string[]): string[] {
  return commentBodies.flatMap((body) => {
    const attempt = conflictAttemptIn(body)?.main ?? requestChangesRunEndedIn(body);
    // A Request-changes run that couldn't bring main in (#341) counts as that head's attempt too.
    return attempt === null ? [] : [attempt];
  });
}

/**
 * The default branch head of the conflict-only run in flight on a PR (#304),
 * or null, from the Fabrik App's comments on it, oldest first: an attempt
 * note that started one, with neither its push note nor its ended note since.
 * A Request-changes run's push note, or any Verdict, since ends it too (#416):
 * agent:implement resumes the Request-changes run owed first, so its push can
 * land in the conflict-only run's place, and a Verdict judges whatever the PR
 * is at, so neither leaves that run owed.
 */
export function conflictRunInFlightIn(commentBodies: readonly string[]): string | null {
  let inFlight: string | null = null;
  for (const body of commentBodies) {
    const attempt = conflictAttemptIn(body);
    if (attempt !== null) inFlight = attempt.outcome === "conflict-run" ? attempt.main : null;
    else if (endsConflictRun(body)) inFlight = null;
  }
  return inFlight;
}

/** Whether a comment ends the conflict-only run in flight: its push or ended note, a Request-changes run's push note, or a Verdict (#416). */
function endsConflictRun(body: string): boolean {
  return (
    body.startsWith(CONFLICT_RUN_MARKER) ||
    body.startsWith(CONFLICT_RUN_ENDED_MARKER) ||
    body.startsWith(REQUEST_CHANGES_RUN_MARKER) ||
    isVerdict(body)
  );
}

/**
 * Whether a Retry or Request-changes run has pushed to a PR since its latest
 * Verdict, from the Fabrik App's comments on it, oldest first: the Kit's note
 * of such a push comes after the last Verdict. A Retry's note from before the
 * marker counts by its opening words.
 */
export function pushedSinceVerdictIn(commentBodies: readonly string[]): boolean {
  let pushed = false;
  for (const body of commentBodies) {
    if (isPushNote(body)) pushed = true;
    else if (verdictsIn([body]).length > 0) pushed = false;
  }
  return pushed;
}

/** Whether a comment is a Verdict: it carries a valid Verdict marker. */
function isVerdict(body: string): boolean {
  return verdictsIn([body]).length > 0;
}

/**
 * The Kit's latest note since a PR's latest Verdict on the Retry it called
 * for, which never started (#416), or null, from the Fabrik App's comments on
 * it, oldest first: that it restarted the Retry, or that it ended it.
 */
export function retryNoteSinceVerdictIn(commentBodies: readonly string[]): "restarted" | "ended" | null {
  let note: "restarted" | "ended" | null = null;
  for (const body of commentBodies) {
    if (body.startsWith(RETRY_RESTARTED_MARKER)) note = "restarted";
    else if (body.startsWith(RETRY_ENDED_MARKER)) note = "ended";
    else if (isVerdict(body)) note = null;
  }
  return note;
}

/** When the latest Verdict in a PR's history was posted, or null when it has none (#416). */
export function verdictPostedAtIn(history: readonly PullRequestHistoryItem[]): string | null {
  let latest: string | null = null;
  for (const item of history) {
    if (item.kind === "bot-comment" && isVerdict(item.body) && (latest === null || item.at >= latest)) latest = item.at;
  }
  return latest;
}

/**
 * Whether a comment is the Kit's note of a push of its own to a PR's branch
 * (#389): a run's push note, or the note of a clean rebase onto main. Each is
 * posted around its push, so the latest one dates the branch's latest push the
 * Kit made.
 */
export function isKitPushNote(body: string): boolean {
  return isPushNote(body) || conflictAttemptIn(body)?.outcome === "rebased";
}

/**
 * Whether a commit is on a PR's branch, as the snapshot read its latest
 * commits (#420): null when it isn't among them but the branch has older
 * commits than were read, so it can't tell.
 */
export type OnBranch = (sha: string) => boolean | null;

/**
 * A PR's comments from the Fabrik App, oldest first, less each push note of a
 * run's whose push never landed (#420; see pushedHeadMarker), so every reader
 * takes that run as still in flight. A note is taken as landed when the head it names is on the
 * branch, or when the Kit has moved on from it since: a Verdict, an attempt to
 * bring the PR up to date with main, or a later push note that landed, any of
 * which may have rewritten the branch, as a rebase does. A note that names no
 * head, as every one from before #420, or whose head the snapshot can't place,
 * is taken as landed.
 */
export function landedPushNotes<Comment extends { readonly body: string }>(comments: readonly Comment[], onBranch: OnBranch): Comment[] {
  let movedOn = false;
  const landed: Comment[] = [];
  for (const comment of [...comments].reverse()) {
    const { body } = comment;
    if (isPushNote(body)) {
      const head = pushedHeadIn(body);
      if (!movedOn && head !== null && onBranch(head) === false) continue;
      movedOn = true;
    } else if (isVerdict(body) || conflictAttemptIn(body) !== null) {
      movedOn = true;
    }
    landed.push(comment);
  }
  return landed.reverse();
}

/** Whether a comment is a Request-changes run's outcome note: its push, or that it committed nothing (#388). */
function isRequestChangesRunOutcome(body: string): boolean {
  return body.startsWith(REQUEST_CHANGES_RUN_MARKER) || body.startsWith(REQUEST_CHANGES_RUN_EMPTY_MARKER);
}

/** Whether a comment is the Kit's note of a Retry's or Request-changes run's push: that run's outcome. */
function isPushNote(body: string): boolean {
  return (
    body.startsWith(RETRY_PUSH_MARKER) ||
    body.startsWith(REQUEST_CHANGES_RUN_MARKER) ||
    body.startsWith(CONFLICT_RUN_MARKER) ||
    body.startsWith(UNMARKED_RETRY_PUSH)
  );
}

/** One thing in an agent PR's history that tells whether a Request changes has been built (#341). */
export type PullRequestHistoryItem =
  | { readonly kind: "bot-comment"; readonly at: string; readonly body: string }
  | {
      readonly kind: "changes-requested";
      readonly at: string;
      readonly review: number;
      readonly reviewer: string;
      readonly reviewerIsBot: boolean;
    }
  /** The PR went to draft, or came out of it. */
  | { readonly kind: "draft" | "ready"; readonly at: string };

/**
 * Where an agent PR's Request changes stand (#341), from its history in any
 * order: the reviews requesting changes that nothing has settled, those a
 * Request-changes run was started for, and the review of the one in flight.
 *
 * A review counts only if the PR was out of draft when it was submitted, as
 * the event path's Request changes only acts on one at the Merge gate; an
 * agent PR opens as a draft. The Operator's own on a draft counts too, once a
 * Request-changes run has put the PR in draft for its reviews: the Kit counts
 * it as noted, so neither check notes it, but it never keeps that run in
 * flight, and the run never read it. So does the Operator's own on a draft
 * while a Retry is in flight (#427), from the Execution flaw that called for
 * it until the next Verdict, as its push's Review is: it's deferred, so neither
 * that Review nor a Retry is given it, and that Verdict, pass or flaw, gives
 * way to it. And so does the Operator's own on a passed draft whose Merge
 * gate has yet to open, as while its Digest is being written (ADR-0022): a
 * draft whose latest Verdict is a pass on `head`, the PR's head now, which
 * has not left draft since that pass and has no run in flight on it. It
 * counts as one given at the Merge gate does, unbuilt and not noted, so the
 * event path acts on it at once and the undelivered check finds it once the
 * PR is out of draft. The history holds no push but the Kit's own, so a pass
 * on a head the PR has moved on from is told by `head` alone, and with no
 * `head` given no review counts this way. Anyone else's on a draft does
 * nothing.
 * A run is started by the Kit's note naming its reviews, or by an Execution
 * flaw that gave way to them, and is in flight until it pushes, is given a
 * Verdict or ends, or the PR leaves draft. Its push or Verdict settles the
 * reviews there were when it started, which it read, but not one that came in
 * while it worked; a pass settles every review before it, its Review having
 * read them all as part of the Ticket (ADR-0010). A run that ended without
 * pushing settles nothing: its reviews stay unbuilt, and noted, so the Kit
 * doesn't note them again. Nor does one that ended in an Infrastructure
 * failure, whose notice leaves it in flight, marked failed until a later note
 * starts a run again (#424). A dismissed review isn't in `notDismissed`, and a run
 * whose every review was dismissed isn't in flight; `notDismissed` is read from
 * the history unless given.
 */
export function requestChangesSinceRunIn(
  history: readonly PullRequestHistoryItem[],
  notDismissed: ReadonlySet<number> = notDismissedIn(history),
  operator: string | null = null,
  head: string | null = null,
): Pick<
  PullRequestSnapshot,
  "unbuiltChangesRequests"
  | "notedChangesRequests"
  | "requestChangesRunInFlight"
  | "requestChangesRunReviews"
  | "requestChangesRunSince"
  | "requestChangesRunFailed"
  | "orphanedChangesRequests"
  | "requestChangesRunDismissed"
  | "deferredChangesRequests"
> {
  // Stable, so items at the same time keep the order they were read in.
  const ordered = [...history].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let draft = true;
  let reviews: UnbuiltChangesRequest[] = [];
  let noted: number[] = [];
  let inFlight: readonly number[] | null = null;
  let since: string | null = null;
  // Whether the run in flight ended in an Infrastructure failure, which leaves it in flight for the Operator (#424).
  let failed = false;
  // The reviews there were when the run in flight started, which it read; one that came in later it never saw.
  let read: readonly number[] = [];
  // From an Execution flaw that called for a Retry until the next Verdict, unless the Retry ended or the PR left draft.
  let retrying = false;
  // The Operator's reviews on the draft while a Retry was in flight, that no run has been started for yet (#427).
  let deferred: number[] = [];
  // The head of the pass whose Merge gate has yet to open (ADR-0022): from a pass until the PR leaves draft, the next
  // Verdict, or the Kit's attempt to bring the PR up to date with main, which moves its head or puts a run in flight.
  let passed: string | null = null;
  for (const item of ordered) {
    switch (item.kind) {
      case "draft":
        draft = true;
        break;
      case "ready":
        draft = false;
        inFlight = null;
        // The Operator took the PR back, so a review deferred for the Retry amends the Ticket for every later run as usual.
        retrying = false;
        deferred = [];
        // The gate opened, or the Operator opened it by hand: a draft again after this is one they parked.
        passed = null;
        break;
      case "changes-requested": {
        const operators = operator !== null && item.reviewer === operator && !item.reviewerIsBot;
        const joins = draft && inFlight !== null && operators;
        const defers = draft && inFlight === null && retrying && operators;
        // On a passed draft waiting for its gate to open, with no run in flight: as one given at the Merge gate.
        const waits = draft && inFlight === null && operators && passed !== null && passed === head;
        if (!draft || joins || defers || waits) {
          reviews.push({ review: item.review, reviewer: item.reviewer, reviewerIsBot: item.reviewerIsBot, submittedAt: item.at });
        }
        if (joins || defers) noted = [...noted, item.review];
        if (defers) deferred = [...deferred, item.review];
        break;
      }
      case "bot-comment": {
        const note = startedReviewsIn(item.body);
        const verdict = verdictsIn([item.body])[0];
        if (verdict !== undefined) {
          retrying = verdict.verdict === "execution-flaw" && verdict.requestChangesFirst === undefined && verdict.ticketNotReady !== true;
          passed = verdict.verdict === "pass" ? verdict.headSha : null;
        } else if (conflictAttemptIn(item.body) !== null) {
          passed = null;
        } else if (item.body.startsWith(RETRY_ENDED_MARKER)) {
          // No Retry started, so no Verdict of its gives way: the deferred reviews amend the Ticket as usual, still noted.
          retrying = false;
          deferred = [];
        }
        const started = note ?? verdict?.requestChangesFirst ?? null;
        if (started !== null) {
          // A pass that gave way to deferred reviews (#427) still settles every other review before it, which its Review read.
          if (verdict?.verdict === "pass") reviews = reviews.filter(({ review }) => started.includes(review) || deferred.includes(review));
          deferred = deferred.filter((review) => !started.includes(review));
          noted = [...noted, ...started.filter((review) => !noted.includes(review))];
          inFlight = started;
          since = item.at;
          failed = false;
          read = reviews.map(({ review }) => review);
        } else if (item.body.startsWith(IMPLEMENT_RUN_FAILED_MARKER)) {
          failed = inFlight !== null;
        } else if (settlesRequestChanges(item.body)) {
          // A pass read them all; a Request-changes run's push or Verdict settles only those its run read.
          // A deferred review was never given to the Review (#427), so even a pass leaves it unbuilt.
          const settled = isPass(item.body) || inFlight === null ? null : new Set(read);
          reviews = reviews.filter(({ review }) => (settled === null ? deferred.includes(review) : !settled.has(review)));
          noted = noted.filter((review) => reviews.some((unbuilt) => unbuilt.review === review));
          inFlight = null;
        } else if (requestChangesRunEndedIn(item.body) !== null || verdictsIn([item.body]).length > 0) {
          // No Verdict lands while a run is in flight, so any other Verdict means the run it followed is over: one whose
          // reviews were all dismissed, its head judged since.
          inFlight = null;
        }
        break;
      }
    }
  }
  const live = (inFlight ?? []).filter((review) => notDismissed.has(review));
  return {
    unbuiltChangesRequests: reviews,
    notedChangesRequests: noted,
    requestChangesRunInFlight: live.length === 0 ? null : Math.max(...live),
    requestChangesRunReviews: live.length === 0 ? [] : (inFlight ?? []),
    requestChangesRunSince: live.length === 0 ? null : since,
    requestChangesRunFailed: live.length > 0 && failed,
    // The Kit's note put the PR in draft for reviews since all dismissed, with no outcome yet: what the Operator asked
    // for meanwhile on the draft is the run that's owed now.
    // Every Request changes of the Operator's no run has built, as its landing would start (src/loop/implement.ts).
    orphanedChangesRequests:
      inFlight !== null && live.length === 0
        ? reviews.filter(({ reviewer, reviewerIsBot }) => operator !== null && reviewer === operator && !reviewerIsBot).map(({ review }) => review)
        : [],
    requestChangesRunDismissed: inFlight !== null && live.length === 0,
    deferredChangesRequests: deferred.filter((review) => notDismissed.has(review)),
  };
}

/**
 * Whether the PR has left draft since its latest Verdict: a Retry that Verdict
 * called for works on a draft, so once the Operator took the PR back, or the
 * Kit handed it to them, none is in flight, even if the PR is a draft again.
 */
export function leftDraftSinceVerdictIn(history: readonly PullRequestHistoryItem[]): boolean {
  const ordered = [...history].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let left = false;
  for (const item of ordered) {
    if (item.kind === "bot-comment" && verdictsIn([item.body]).length > 0) left = false;
    else if (item.kind === "ready") left = true;
  }
  return left;
}

/**
 * Whether a Kit comment settles the Request changes before it: a
 * Request-changes run's push note, its note that it committed nothing (#388),
 * or its Verdict, or a pass.
 */
function settlesRequestChanges(body: string): boolean {
  if (isRequestChangesRunOutcome(body)) return true;
  return verdictsIn([body]).some((record) => record.requestChanges || record.verdict === "pass");
}

function isPass(body: string): boolean {
  return verdictsIn([body]).some((record) => record.verdict === "pass");
}

/** The reviews still requesting changes: GitHub lists a dismissed one no longer. */
export function notDismissedIn(history: readonly PullRequestHistoryItem[]): ReadonlySet<number> {
  return new Set(history.flatMap((item) => (item.kind === "changes-requested" ? [item.review] : [])));
}

/**
 * How many Implement runs on a Ticket the Kit has recorded as landing nothing
 * before its PR opened, from its comments oldest first: its empty diffs and
 * its Broken runs (#434), each of which used one of its Retries. A Design
 * session starts the count again, because a Ticket that went back to design
 * starts again on its retries. Only the Fabrik App's comments count
 * (`byApp`), so nobody, another bot included, can add one or start the count
 * again by posting a marker (#426).
 */
export function countLandedNothing(comments: readonly KitComment[]): number {
  let count = 0;
  for (const { body } of kitCommentsIn(comments)) {
    if (isDesignSessionComment(body)) count = 0;
    else if (isEmptyDiffComment(body) || isBrokenRunComment(body)) count += 1;
  }
  return count;
}

/**
 * Where an issue's current Design session stands, from its comments oldest
 * first: how many rounds it has posted, and the return it follows, if any. A
 * session's end starts the count again, and so does the Kit's note that a
 * Ticket came back, whose session that follows. Only the Fabrik App's
 * comments count (`byApp`), so nobody, another bot included, can fake a
 * round, an end or a return by posting one (#426).
 */
export function designSessionOf(comments: readonly KitComment[]): Pick<IssueSnapshot, "designRounds" | "sentBack"> {
  let session: Pick<IssueSnapshot, "designRounds" | "sentBack"> = { designRounds: 0, sentBack: null };
  for (const { body } of kitCommentsIn(comments)) {
    const returned = sentBackIn(body);
    if (returned !== null) session = { designRounds: 0, sentBack: returned };
    else if (DESIGN_ROUND_MARKER.test(body)) session = { ...session, designRounds: session.designRounds + 1 };
    else if (isDesignSessionComment(body)) session = { designRounds: 0, sentBack: null };
  }
  return session;
}

/**
 * Whether a Design-session turn has failed in an issue's current session, from
 * its comments oldest first: the Kit's failure notice for the turn, with no
 * end of the session, and no return starting a new one, since. Only the
 * Fabrik App's comments count (`byApp`), so nobody, another bot included, can
 * fake a failure, or clear one, by posting a notice or an end (#426).
 */
export function designTurnFailedIn(comments: readonly KitComment[]): boolean {
  let failed = false;
  for (const { body } of kitCommentsIn(comments)) {
    if (body.startsWith(DESIGN_TURN_FAILED_MARKER)) failed = true;
    else if (endsDesignSession(body)) failed = false;
  }
  return failed;
}

/**
 * An issue's comments, oldest first, since its current Design session
 * started: after the last of the Fabrik App's comments that ended a session,
 * async or live, or noted a Ticket's return, which starts a new one, as
 * designSessionOf counts its rounds. All of them, when none has (#640). Only
 * the App's comments start one, so a person quoting an end changes nothing.
 */
export function currentDesignSessionIn<Comment extends KitComment>(comments: readonly Comment[]): Comment[] {
  const ended = comments.findLastIndex(({ body, byApp }) => byApp && endsDesignSession(body));
  return comments.slice(ended + 1);
}

/** A comment on an issue, and whether the Fabrik App wrote it. */
export interface KitComment {
  readonly body: string;
  readonly byApp: boolean;
}

/** The Fabrik App's comments among these, in their order: the only ones a marker may come from. */
function kitCommentsIn<Comment extends KitComment>(comments: readonly Comment[]): Comment[] {
  return comments.filter(({ byApp }) => byApp);
}

/** A comment as the snapshot reads an issue's thread: its id, its text, and whether the Fabrik App wrote it. */
export interface ThreadComment extends KitComment {
  readonly id: number;
}

/**
 * An issue's pending prototype request (#155), from its current Design
 * session's comments oldest first: the latest prototype request with no
 * prototype round, prototype failure round or failed turn since, and no end
 * of the session, or return starting a new one. The Operator's replies and
 * the ordinary rounds in between leave it pending. Only the Fabrik App's
 * comments count (`byApp`), since the request steers what a prototype turn
 * builds. A request the Operator's reply approved is pending only while that
 * reply is among `existing`, the ids of every comment the snapshot read:
 * once they delete it, its prototype turn would post nothing, so no
 * agent:design should build it again. The reply is older than its request, so
 * it can fall outside the last 100 comments the snapshot reads while the
 * request doesn't; that reads as not pending too, the safe side, since a
 * request taken for pending builds a Prototype, where one taken for not
 * pending leaves the Operator's next reply to start an ordinary turn. It
 * carries its comment's id, and whether the Kit marked its prototype turn
 * started there.
 */
export function pendingPrototypeIn(
  comments: readonly ThreadComment[],
  existing: ReadonlySet<number> = new Set(comments.map(({ id }) => id)),
): PendingPrototype | null {
  let pending: PendingPrototype | null = null;
  for (const { id, body, byApp } of comments) {
    if (!byApp) continue;
    const request = prototypeRequestIn(body);
    if (request !== null) pending = { ...request, comment: id, started: prototypeStartedIn(body) };
    else if (endsPrototypeRequest(body)) pending = null;
  }
  return pending !== null && pending.reply !== null && !existing.has(pending.reply) ? null : pending;
}

/**
 * The prototype requests a prototype turn's result may still land on (#155),
 * from an issue's current Design session's comments oldest first: each the
 * Fabrik App posted that no prototype round or prototype failure round has
 * answered, oldest first. A session's turns build its requests in turn, so a
 * round answers the oldest one before it. Unlike the pending request, a failed
 * turn's notice, or the Map cap's refusal, which opens like one, leaves a
 * request unanswered: a prototype turn that was already building it still
 * lands its round. A second landing of a request a round answered is stale,
 * and the session's end or return answers every one.
 */
export function unansweredPrototypesIn(comments: readonly Pick<ThreadComment, "body" | "byApp">[]): PrototypeRequestMarker[] {
  let unanswered: PrototypeRequestMarker[] = [];
  for (const { body, byApp } of comments) {
    if (!byApp) continue;
    const request = prototypeRequestIn(body);
    if (request !== null) unanswered = [...unanswered, request];
    else if (isPrototypeRound(body)) unanswered = unanswered.slice(1);
    else if (endsDesignSession(body)) unanswered = [];
  }
  return unanswered;
}

/** Whether the App's comment ends a pending prototype request: the round that answers it, a failed turn, or the session's end or return. */
function endsPrototypeRequest(body: string): boolean {
  return isPrototypeRound(body) || body.startsWith(DESIGN_TURN_FAILED_MARKER) || endsDesignSession(body);
}

/** Whether the App's comment is a prototype round or prototype failure round: a round whose marker line has the prototype's right under it. */
function isPrototypeRound(body: string): boolean {
  const [first = "", second] = body.split("\n", 2);
  return DESIGN_ROUND_MARKER.test(first) && (second === PROTOTYPE_ROUND_MARKER || second === PROTOTYPE_FAILURE_ROUND_MARKER);
}

/** Whether the App's comment ends the Design session, async or live, or notes the return that starts a new one. */
function endsDesignSession(body: string): boolean {
  return body.startsWith(SESSION_FINISHED) || LIVE_OUTCOME_MARKER.test(body) || sentBackIn(body) !== null;
}

/**
 * Whether the Kit's research failure notice is a Decision's latest run's word,
 * from its comments oldest first: the notice is the Fabrik App's last comment
 * on it, with no later run's word, such as a resolution, since. Only the App's
 * own comments count (`byApp`), so nobody, another bot included, can fake a
 * failure by quoting the notice, and a reply after it, a person's or another
 * bot's, leaves it in place.
 */
export function researchRunFailedIn(comments: readonly KitComment[]): boolean {
  return latestKitWordIs(RESEARCH_RUN_FAILED_MARKER, comments);
}

/**
 * Whether the Kit's Implement failure notice is a Ticket's latest run's word,
 * from its comments oldest first, read as researchRunFailedIn reads a
 * Decision's (#418).
 */
export function implementRunFailedIn(comments: readonly KitComment[]): boolean {
  return latestKitWordIs(IMPLEMENT_RUN_FAILED_MARKER, comments);
}

/** Whether the Fabrik App's last comment, of these oldest first, starts with this marker. */
function latestKitWordIs(marker: string, comments: readonly KitComment[]): boolean {
  const latest = kitCommentsIn(comments).at(-1);
  return latest !== undefined && latest.body.startsWith(marker);
}

/** Whether a comment is part of a Design session: a round, or the session's end, async or live. */
function isDesignSessionComment(body: string): boolean {
  return DESIGN_ROUND_MARKER.test(body) || body.startsWith(SESSION_FINISHED) || LIVE_OUTCOME_MARKER.test(body);
}

/** The Kit's note that a Ticket came back from this PR, read from a comment's first line; null if it isn't one. */
function sentBackIn(body: string): SentBack | null {
  const match = BACK_TO_DESIGN_MARKER.exec(body);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { pullRequest: Number(match[1]), verdictUrl: match[2] === "operator" ? null : match[2] };
}

/**
 * One entry of an issue's or PR's timeline as the stuck-trigger sweep reads
 * it (#419), oldest first: a label added or taken off, or a comment the
 * Fabrik App wrote. Anyone else's comment is left out, so quoting a marker
 * can't fake one.
 */
export type TriggerHistoryEntry =
  | { readonly kind: "labeled" | "unlabeled"; readonly label: string; readonly at: string }
  | { readonly kind: "kit-comment"; readonly body: string };

/** When `label` was last added, from the timeline oldest first, or null when it doesn't show it. */
export function lastAddedAtIn(history: readonly TriggerHistoryEntry[], label: TriggerLabel): string | null {
  let at: string | null = null;
  for (const entry of history) if (entry.kind === "labeled" && entry.label === label) at = entry.at;
  return at;
}

/**
 * Whether the Kit's stuck-trigger re-add comment for `label` came after the
 * label last came off: its strike one stands, so another stuck tick is strike
 * two. Read in timeline order rather than by time, since the re-add's own
 * cycle takes the label off in the same second the comment lands. Any later
 * `unlabeled` event, a claim's or a role declining it, resets the count.
 */
export function stuckTriggerReaddedIn(history: readonly TriggerHistoryEntry[], label: TriggerLabel): boolean {
  let readded = false;
  for (const entry of history) {
    if (entry.kind === "kit-comment" && entry.body.startsWith(stuckTriggerReaddedMarker(label))) readded = true;
    else if (entry.kind === "unlabeled" && entry.label === label) readded = false;
  }
  return readded;
}

/**
 * Whether the Kit gave up on `label` (#419) and nobody has added it since: its
 * give-up comment comes after the label's latest `labeled` event. The give-up
 * marker follows the role's own failure marker where it has one, so it's
 * looked for on any line, where the re-add marker always opens its comment.
 */
export function stuckTriggerGaveUpIn(history: readonly TriggerHistoryEntry[], label: TriggerLabel): boolean {
  let gaveUp = false;
  for (const entry of history) {
    if (entry.kind === "kit-comment" && entry.body.split("\n").includes(stuckTriggerGaveUpMarker(label))) gaveUp = true;
    else if (entry.kind === "labeled" && entry.label === label) gaveUp = false;
  }
  return gaveUp;
}
