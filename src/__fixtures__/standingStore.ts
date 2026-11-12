// Fact builders for the store's Standings (src/kit/standingStore.ts).
import type { StoreStandingFacts, WeeklySummaryIssueFacts } from "../kit/standingStore.ts";

/** What the Standing rule reads of the store: nothing in it unless a test says so. */
export function storeFactsOf(overrides: Partial<Omit<StoreStandingFacts, "kind">> = {}): StoreStandingFacts {
  return { kind: "store", summaries: [], failedSummaryIssues: [], readyForHuman: [], ...overrides };
}

/** Weekly summary issue 9, open, its body written on 2026-11-09 at 07:00 UTC, with no comments of the Fabrik App's unless a test says so. */
export function aSummaryIssue(overrides: Partial<WeeklySummaryIssueFacts> = {}): WeeklySummaryIssueFacts {
  return { number: 9, open: true, bodyWrittenAt: "2026-11-09T07:00:00Z", appComments: [], ...overrides };
}
