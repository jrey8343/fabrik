// The marker lines the Kit leaves in its own issues' bodies and comments, and
// reads back: that an issue has buzzed the Operator, and when a weekly-limit
// issue's limit resets. Pure, no I/O.
import type { KitIssueSnapshot } from "./types.ts";

/** Where in its body the weekly-limit issue records when the limit resets, for the scheduled tick. */
const RESETS_AT_MARKER = "<!-- fabrik:resets-at";

/**
 * Left in the body or comment that buzzed the Operator about a Kit-owned
 * issue, so that later failures on it stay quiet.
 */
export const NOTIFIED = "<!-- fabrik:notified -->";

/**
 * The marker line ending a Dead-tick issue's body (#461), by which the daily
 * check finds the one it opened and the Tick finds the one it closes.
 */
export const DEAD_TICK_MARKER = "<!-- fabrik:dead-tick -->";

/** Whether the Kit has buzzed the Operator about this issue already. */
export function notified(issue: KitIssueSnapshot): boolean {
  return [issue.body, ...issue.comments].some((text) => text.includes(NOTIFIED));
}

/** The marker line recording when a weekly-limit issue's limit resets. */
export function resetsAtMarker(resetsAt: string): string {
  return `${RESETS_AT_MARKER} ${resetsAt} -->`;
}

/** When the weekly-limit issue says the limit resets, or null if it doesn't say. */
export function resetsAtOf(issue: KitIssueSnapshot): string | null {
  const start = issue.body.indexOf(RESETS_AT_MARKER);
  if (start === -1) return null;
  const end = issue.body.indexOf("-->", start);
  const value = issue.body.slice(start + RESETS_AT_MARKER.length, end === -1 ? undefined : end).trim();
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** The earliest of these reset times, or null when none is known. */
export function earliestOf(resets: readonly (string | null)[]): string | null {
  const known = resets.filter((reset): reset is string => reset !== null);
  return known.length === 0 ? null : known.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
