// Reads the Kit's history back from an issue's or a PR's comments, through
// the markers the core writes on them (src/loop/markers.ts), into snapshot
// fields. Pure, no I/O. The snapshot passes in only the comments a marker may
// come from: a bot's, where quoting one mustn't fake it.
import type { SentBack } from "../loop/backToDesign.ts";
import {
  BACK_TO_DESIGN_MARKER,
  DESIGN_ROUND_MARKER,
  EMPTY_DIFF_MARKER,
  LIVE_OUTCOME_MARKER,
  REQUEST_CHANGES_RUN_MARKER,
  RETRY_PUSH_MARKER,
  SESSION_FINISHED,
  UNMARKED_RETRY_PUSH,
  VERDICT_MARKER,
} from "../loop/markers.ts";
import type { IssueSnapshot, Verdict, VerdictRecord } from "../loop/types.ts";
import { VERDICTS } from "../loop/verdict.ts";

/** The Verdicts recorded in these comments, oldest first. Comments without a valid marker are skipped. */
export function verdictsIn(commentBodies: readonly string[]): VerdictRecord[] {
  return commentBodies.flatMap((body) => {
    const record = readVerdictMarker(body);
    return record === null ? [] : [record];
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
  const { verdict, source, requestChanges, headSha } = value as Record<string, unknown>;
  if (!VERDICTS.includes(verdict as Verdict)) return null;
  if (source !== "reviewer" && source !== "ci" && source !== "empty-diff") return null;
  if (typeof requestChanges !== "boolean" || typeof headSha !== "string") return null;
  return { verdict: verdict as Verdict, source, requestChanges, headSha };
}

/**
 * Whether a PR's latest push came from a Request-changes run, from the Fabrik
 * App's comments on it, oldest first: its last note of such a push has no
 * Verdict after it yet, so the next Verdict is marked as from that run.
 */
export function requestChangesRunIn(commentBodies: readonly string[]): boolean {
  let latest = false;
  for (const body of commentBodies) {
    if (body.startsWith(REQUEST_CHANGES_RUN_MARKER)) latest = true;
    else if (verdictsIn([body]).length > 0) latest = false;
  }
  return latest;
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

function isPushNote(body: string): boolean {
  return body.startsWith(RETRY_PUSH_MARKER) || body.startsWith(REQUEST_CHANGES_RUN_MARKER) || body.startsWith(UNMARKED_RETRY_PUSH);
}

/**
 * How many empty diffs the Kit has recorded on a Ticket, from its comments
 * oldest first. A Design session starts the count again, because a Ticket
 * that went back to design starts again on its retries.
 */
export function countEmptyDiffs(commentBodies: readonly string[]): number {
  let count = 0;
  for (const body of commentBodies) {
    if (isDesignSessionComment(body)) count = 0;
    else if (body.startsWith(EMPTY_DIFF_MARKER)) count += 1;
  }
  return count;
}

/**
 * Where an issue's current Design session stands, from its comments oldest
 * first: how many rounds it has posted, and the return it follows, if any. A
 * session's end starts the count again, and so does the Kit's note that a
 * Ticket came back, whose session that follows. Only a bot's note counts, so
 * nobody can fake a return by quoting one.
 */
export function designSessionOf(
  comments: readonly { readonly body: string; readonly byBot: boolean }[],
): Pick<IssueSnapshot, "designRounds" | "sentBack"> {
  let session: Pick<IssueSnapshot, "designRounds" | "sentBack"> = { designRounds: 0, sentBack: null };
  for (const { body, byBot } of comments) {
    const returned = byBot ? sentBackIn(body) : null;
    if (returned !== null) session = { designRounds: 0, sentBack: returned };
    else if (DESIGN_ROUND_MARKER.test(body)) session = { ...session, designRounds: session.designRounds + 1 };
    else if (isDesignSessionComment(body)) session = { designRounds: 0, sentBack: null };
  }
  return session;
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
