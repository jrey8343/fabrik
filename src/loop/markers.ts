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

/** What a Monitor issue's marker line says it tracks (#148): a Sentry group, or red main. */
export type MonitorMarker = { readonly kind: "sentry"; readonly group: string } | { readonly kind: "red-main" };

/**
 * A Monitor issue's marker line, naming the Sentry group or the red main it
 * tracks. Only the line itself counts, never the Monitor block's markers.
 */
const MONITOR_MARKER = /^<!-- fabrik:monitor (?:sentry:(\S+)|red-main) -->$/m;

/** The Monitor marker in this body, or null when it has none. */
export function monitorMarkerIn(body: string): MonitorMarker | null {
  const match = MONITOR_MARKER.exec(body);
  if (match === null) return null;
  const group = match[1];
  return group === undefined ? { kind: "red-main" } : { kind: "sentry", group };
}

/** The marker line a Monitor issue's body opens with, for what it tracks. */
export function monitorMarkerLine(marker: MonitorMarker): string {
  return marker.kind === "sentry" ? `<!-- fabrik:monitor sentry:${marker.group} -->` : "<!-- fabrik:monitor red-main -->";
}

/**
 * The first line of the Monitor's note closing its red-main issue once the
 * default branch is green: its only comment, which tells its own close apart
 * from anyone else's.
 */
export const RED_MAIN_GREEN_MARKER = "<!-- fabrik:monitor-green -->";
