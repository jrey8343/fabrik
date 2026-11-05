// The markers the Kit's comments open with. The core writes them; the adapter
// reads a thread's comments back through them into the snapshot
// (src/github/threads.ts), so the Loop's history lives on GitHub alone.
import type { VerdictRecord } from "./types.ts";

/** A Verdict comment's first line, carrying its record as JSON. */
export const VERDICT_MARKER = /^<!-- fabrik:verdict (\{.*?\}) -->/;

export function verdictMarker(record: VerdictRecord): string {
  const { verdict, source, requestChanges, headSha } = record;
  return `<!-- fabrik:verdict ${JSON.stringify({ verdict, source, requestChanges, headSha })} -->`;
}

/** The first line of the Kit's note on a PR that a Request-changes run pushed to it. */
export const REQUEST_CHANGES_RUN_MARKER = "<!-- fabrik:request-changes-run -->";

/** The first line of the Kit's note on a PR that a Retry pushed to it: the Retry's outcome, which ends its time in flight. */
export const RETRY_PUSH_MARKER = "<!-- fabrik:retry-push -->";

/** How the note of a Retry's push opened before it carried RETRY_PUSH_MARKER, so older PRs read the same. */
export const UNMARKED_RETRY_PUSH = "The Implementer pushed a fix for the Execution flaw to ";

/** The first line of the Kit's comment on a Ticket whose Implement run changed nothing. */
export const EMPTY_DIFF_MARKER = "<!-- fabrik:empty-diff -->";

/** A Design-session round's first line. */
export const DESIGN_ROUND_MARKER = /^<!-- fabrik:design-round (\d+) -->/;

export function designRoundMarker(round: number): string {
  return `<!-- fabrik:design-round ${round} -->`;
}

/**
 * The first line of the Kit's failure notice for a Design-session turn: the
 * session keeps its slot while that notice is the Operator's move (#147).
 */
export const DESIGN_TURN_FAILED_MARKER = "<!-- fabrik:design-turn-failed -->";

/** How the comment that ends a Design session starts, either way it ends. */
export const SESSION_FINISHED = "**Design session finished.**";

/**
 * Opens the comment a live Design session ends with. Only the start of a
 * comment counts, so quoting it doesn't.
 */
export const LIVE_OUTCOME_MARKER = /^<!-- fabrik:live-outcome (\S+) -->/;

/** The first line of the Kit's note that a Ticket came back to design from an agent PR. */
export const BACK_TO_DESIGN_MARKER = /^<!-- fabrik:back-to-design ([1-9][0-9]*) (https:\/\/\S+|operator) -->/;

/**
 * An Architectural escape's record (#150): `<!-- fabrik:escape <strength> #<pr> #<pr> -->`,
 * the hidden line an Audit candidate's prefilled issue body ends with when it
 * traces to merged agent PRs. It can sit anywhere in a body, since a Design
 * session's rewrite carries it forward, and the Operator may paste one by hand.
 */
const ESCAPE_MARKER = /<!--\s*fabrik:escape(\s[^>]*?)?\s*-->/;

/** What an escape marker says, read as written. */
export interface EscapeMarker {
  /** The word in the Strength's place, known or not, or null when the marker opens with a PR. */
  readonly strength: string | null;
  /** The PR numbers it names, in order. */
  readonly pullRequests: readonly number[];
}

/** The first escape marker in `body`, or null if it has none. */
export function escapeMarkerIn(body: string): EscapeMarker | null {
  const match = ESCAPE_MARKER.exec(body);
  if (match === null) return null;
  const words = (match[1] ?? "").split(/\s+/).filter((word) => word !== "");
  const first = words[0];
  return {
    strength: first === undefined || first.startsWith("#") ? null : first,
    pullRequests: words.flatMap((word) => {
      const pullRequest = /^#([1-9][0-9]*)$/.exec(word);
      return pullRequest === null ? [] : [Number(pullRequest[1])];
    }),
  };
}

/**
 * An Audit's marker line (#150): `<!-- fabrik:audit <sha> -->`, the commit the
 * Audit reads, which was the default branch's head when the tick opened it.
 * Its body keeps the line through every state.
 */
export function auditMarker(sha: string): string {
  return `<!-- fabrik:audit ${sha} -->`;
}

/** The marker line on an Audit still waiting on its run. */
export const AUDIT_PENDING_MARKER = "<!-- fabrik:audit-pending -->";

/** The marker line on an Audit whose run failed, in place of the pending one. */
export const AUDIT_FAILED_MARKER = "<!-- fabrik:audit-failed -->";

const AUDIT_MARKER = /^<!-- fabrik:audit ([0-9a-f]{40}) -->$/;

/** What an Audit's body says through its marker lines. Only a body the Fabrik App wrote is read for them. */
export interface AuditMarks {
  /** The commit its audit marker names, or null when it has none. */
  readonly commit: string | null;
  readonly pending: boolean;
  readonly failed: boolean;
}

/** The Audit marker lines in `body`, each matched against a whole line with its outer whitespace trimmed. */
export function auditMarksIn(body: string): AuditMarks {
  const lines = body.split("\n").map((line) => line.trim());
  const commit = lines.map((line) => AUDIT_MARKER.exec(line)?.[1]).find((sha) => sha !== undefined) ?? null;
  return { commit, pending: lines.includes(AUDIT_PENDING_MARKER), failed: lines.includes(AUDIT_FAILED_MARKER) };
}
