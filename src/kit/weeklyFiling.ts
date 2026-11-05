// Filing the Weekly summary in the store (ADR-0009): from what the summary
// module returned and the `fabrik:weekly-summary` issues already there, what
// to file, update or close. Only one summary is ever open, and a re-run in the
// same week never files a second. Pure, no I/O.
import type { WeeklySummaryResult } from "./weeklySummary.ts";

/** The label on every Weekly summary issue, by which the next week's filing finds it. */
export const WEEKLY_SUMMARY_LABEL = "fabrik:weekly-summary";

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
