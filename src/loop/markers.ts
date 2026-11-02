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

/** The first line of the Kit's comment on a Ticket whose Implement run changed nothing. */
export const EMPTY_DIFF_MARKER = "<!-- fabrik:empty-diff -->";

/** A Design-session round's first line. */
export const DESIGN_ROUND_MARKER = /^<!-- fabrik:design-round (\d+) -->/;

export function designRoundMarker(round: number): string {
  return `<!-- fabrik:design-round ${round} -->`;
}

/** How the comment that ends a Design session starts, either way it ends. */
export const SESSION_FINISHED = "**Design session finished.**";

/**
 * Opens the comment a live Design session ends with. Only the start of a
 * comment counts, so quoting it doesn't.
 */
export const LIVE_OUTCOME_MARKER = /^<!-- fabrik:live-outcome (\S+) -->/;

/** The first line of the Kit's note that a Ticket came back to design from an agent PR. */
export const BACK_TO_DESIGN_MARKER = /^<!-- fabrik:back-to-design ([1-9][0-9]*) (https:\/\/\S+|operator) -->/;
