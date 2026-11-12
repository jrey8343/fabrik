import { describe, expect, it } from "vitest";
import { type Standing, standingsOf } from "./standing.ts";
import { aSummaryIssue, storeFactsOf } from "../__fixtures__/standingStore.ts";
import type { StoreStandingFacts } from "./standingStore.ts";

const NOW = "2026-11-09T20:00:00Z";

/** Every read a test in this file made, with the Standings it gave, for the plain-data checks at the end. */
const produced: { readonly facts: StoreStandingFacts; readonly standings: readonly Standing[] }[] = [];

function storeStandingsIn(overrides: Partial<Omit<StoreStandingFacts, "kind">>): Standing[] {
  const facts = storeFactsOf(overrides);
  const standings = standingsOf(facts, NOW);
  produced.push({ facts, standings });
  return standings;
}

describe("the store's Standings", () => {
  it("gives the open Weekly summary one, yours to read, not stopping work, since its body was written, carrying the store as its repo", () => {
    const standings = storeStandingsIn({ summaries: [aSummaryIssue({ number: 9, open: true, bodyWrittenAt: "2026-11-09T07:00:00Z" })] });
    expect(standings).toEqual([
      {
        schema: 1,
        repo: "jrey8343/fabrik-runs",
        issue: 9,
        pullRequest: null,
        work: "weekly-summary",
        place: null,
        name: "yours-to-read",
        move: "operator",
        yours: true,
        stopsWork: false,
        since: "2026-11-09T07:00:00Z",
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { map: null, decisions: [] },
      },
    ]);
  });
});
