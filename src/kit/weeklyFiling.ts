// Filing the Weekly summary in the store (ADR-0009): from what the summary
// module returned and the `fabrik:weekly-summary` issues already there, what
// to file, update or close. Only one summary is ever open, and a re-run in the
// same week never files a second. And what a failed run files instead, so a
// failed run is never taken for a quiet week (#445). Pure, no I/O.
import { whatFailed } from "./landingFailure.ts";
import { FAILED_OPENING, WEEKLY_SUMMARY_FAILED_MARKER, WEEKLY_SUMMARY_FAILED_TITLE } from "./weeklyMarks.ts";
import type { WeeklySummaryResult } from "./weeklySummary.ts";

export { isWeeklyFailureNotice, WEEKLY_SUMMARY_FAILED_MARKER, WEEKLY_SUMMARY_FAILED_TITLE, WEEKLY_SUMMARY_LABEL } from "./weeklyMarks.ts";

/** A Weekly summary issue already in the store. */
export interface SummaryIssue {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
}

export type WeeklyFiling =
  /** A skipped week: nothing filed, nothing closed, no one mentioned. */
  | { readonly kind: "nothing" }
  /** This week's summary, filed with the label, and the older open summaries to close. */
  | { readonly kind: "file"; readonly title: string; readonly body: string; readonly close: readonly number[] }
  /** This week's summary already filed, rewritten in place. */
  | { readonly kind: "update"; readonly issue: number; readonly body: string; readonly close: readonly number[] };

/** What to do in the store with this week's result, given the summaries already filed. */
export function weeklyFilingOf(
  result: { readonly kind: "skip" } | Pick<Extract<WeeklySummaryResult, { kind: "summary" }>, "kind" | "title" | "body">,
  existing: readonly SummaryIssue[],
): WeeklyFiling {
  if (result.kind === "skip") return { kind: "nothing" };
  const thisWeek = existing.find((issue) => issue.title === result.title);
  const close = existing.filter((issue) => issue.open && issue !== thisWeek).map((issue) => issue.number);
  return thisWeek === undefined
    ? { kind: "file", title: result.title, body: result.body, close }
    : { kind: "update", issue: thisWeek.number, body: result.body, close };
}

/** What a failed run files in the store: a comment on the newest summary, or an issue of its own when there's none. */
export type WeeklyFailureFiling =
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "file"; readonly title: string; readonly body: string };

/**
 * What a failed Weekly summary run says: its step summary, its `::error`
 * line, and what it files with the store token, given the summaries already
 * filed, newest first. It @-mentions `operator` with the run's link, so no
 * Monday passes in silence.
 */
export function weeklyFailureOf(
  error: unknown,
  existing: readonly SummaryIssue[],
  runUrl: string,
  operator: string,
): { readonly summary: string; readonly error: string; readonly filing: WeeklyFailureFiling } {
  const what = whatFailed(error);
  const rest = [`**What failed:** ${what}`, "**To recover:** Open the run and choose **Re-run jobs → Re-run failed jobs**, which files this week's summary."];
  const body = [`@${operator} ${FAILED_OPENING}, so this week's summary isn't filed. The [run](${runUrl}) failed.`, ...rest, WEEKLY_SUMMARY_FAILED_MARKER].join("\n\n");
  const [newest] = existing;
  return {
    summary: ["The Weekly summary failed, so this week's summary isn't filed.", ...rest].join("\n\n"),
    error: `The Weekly summary failed: ${what}`,
    filing: newest === undefined ? { kind: "file", title: WEEKLY_SUMMARY_FAILED_TITLE, body } : { kind: "comment", issue: newest.number, body },
  };
}
