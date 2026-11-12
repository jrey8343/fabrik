import { describe, expect, it } from "vitest";
import { type Standing, standingsOf } from "./standing.ts";
import { aSummaryIssue, storeFactsOf } from "../__fixtures__/standingStore.ts";
import { aLabelAdded, anOpenIssue } from "../__fixtures__/weeklySummary.ts";
import type { StoreStandingFacts } from "./standingStore.ts";
import { weeklyFailureOf } from "./weeklyFiling.ts";

const NOW = "2026-11-09T20:00:00Z";
const RUN_URL = "https://github.com/jrey8343/fabrik-runs/actions/runs/55/attempts/1";

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

  describe("a failed Weekly summary run", () => {
    const notice = (at: string) => ({ body: weeklyFailureOf(new Error("boom"), [{ number: 9, title: "t", open: true }], RUN_URL, "operator").filing.body, at });

    it("gives one, yours to do but not stopping work, while its notice is the Fabrik App's last comment on the newest summary, closed or open", () => {
      const standings = storeStandingsIn({
        summaries: [aSummaryIssue({ number: 9, open: false, appComments: [notice("2026-11-09T07:05:00Z")] }), aSummaryIssue({ number: 4, open: false })],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "jrey8343/fabrik-runs",
          issue: 9,
          pullRequest: null,
          work: "weekly-summary",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: false,
          since: "2026-11-09T07:05:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: "weekly-summary-failed", role: null, failure: null, label: null },
        },
      ]);
    });

    const namesIn = (standings: readonly Standing[]) => standings.map(({ issue, name }) => ({ issue, name }));

    it("is gone once a re-run that succeeded writes the summary's body after the notice, which is then to read", () => {
      const standings = storeStandingsIn({ summaries: [aSummaryIssue({ number: 9, open: true, bodyWrittenAt: "2026-11-09T08:00:00Z", appComments: [notice("2026-11-09T07:05:00Z")] })] });
      expect(namesIn(standings)).toEqual([{ issue: 9, name: "yours-to-read" }]);
    });

    it("is the open summary's one Standing while it stands, not also to read", () => {
      const standings = storeStandingsIn({ summaries: [aSummaryIssue({ number: 9, open: true, bodyWrittenAt: "2026-11-02T07:00:00Z", appComments: [notice("2026-11-09T07:05:00Z")] })] });
      expect(namesIn(standings)).toEqual([{ issue: 9, name: "yours-to-do" }]);
    });

    it("gives none for a notice on a summary that is no longer the newest", () => {
      const standings = storeStandingsIn({
        summaries: [aSummaryIssue({ number: 10, open: true, bodyWrittenAt: "2026-11-09T08:00:00Z" }), aSummaryIssue({ number: 9, open: false, appComments: [notice("2026-11-02T07:05:00Z")] })],
      });
      expect(namesIn(standings)).toEqual([{ issue: 10, name: "yours-to-read" }]);
    });

    it("gives none once the Fabrik App has commented after the notice", () => {
      const standings = storeStandingsIn({
        summaries: [aSummaryIssue({ number: 9, open: false, appComments: [notice("2026-11-09T07:05:00Z"), { body: "Something else.", at: "2026-11-09T09:00:00Z" }] })],
      });
      expect(standings).toEqual([]);
    });

    it("knows an earlier release's notice, with no marker, by its opening words", () => {
      const earlier = notice("2026-11-09T07:05:00Z").body.replace("\n\n<!-- fabrik:weekly-summary-failed -->", "");
      const standings = storeStandingsIn({ summaries: [aSummaryIssue({ number: 9, open: false, appComments: [{ body: earlier, at: "2026-11-09T07:05:00Z" }] })] });
      expect(namesIn(standings)).toEqual([{ issue: 9, name: "yours-to-do" }]);
    });

    it("gives one for an open Weekly summary failed issue, since it was filed, and none once it is closed", () => {
      const open = storeStandingsIn({ failedSummaryIssues: [{ number: 3, createdAt: "2026-11-09T07:05:00Z" }] });
      expect(open).toEqual([
        expect.objectContaining({ repo: "jrey8343/fabrik-runs", issue: 3, work: "weekly-summary", name: "yours-to-do", stopsWork: false, since: "2026-11-09T07:05:00Z", detail: { handBack: "weekly-summary-failed", role: null, failure: null, label: null } }),
      ]);
      expect(storeStandingsIn({ failedSummaryIssues: [] })).toEqual([]);
    });
  });

  it("gives an open ready-for-human issue there, such as one for a Product repo the Fabrik App can't reach, yours to do and stopping work, as in a Product repo", () => {
    const standings = storeStandingsIn({
      readyForHuman: [anOpenIssue({ number: 14, author: "fabrik-app[bot]", labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-08T03:00:00Z")] })],
    });
    expect(standings).toEqual([
      {
        schema: 1,
        repo: "jrey8343/fabrik-runs",
        issue: 14,
        pullRequest: null,
        work: "ready-for-human",
        place: null,
        name: "yours-to-do",
        move: "operator",
        yours: true,
        stopsWork: true,
        since: "2026-11-08T03:00:00Z",
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { handBack: null, role: null, failure: null, label: null },
      },
    ]);
  });
});

// After every test above: these read what they produced.
describe("a store Standing, as plain data", () => {
  it("survives a JSON round trip unchanged, every one the tests above produced", () => {
    const all = produced.flatMap(({ standings }) => standings);
    expect(all.length).toBeGreaterThan(0);
    for (const standing of all) expect(JSON.parse(JSON.stringify(standing))).toStrictEqual(standing);
  });

  it("is the same for the same facts read a minute later", () => {
    for (const { facts, standings } of produced) expect(standingsOf(facts, "2026-11-09T20:01:00Z")).toStrictEqual(standings);
  });
});
