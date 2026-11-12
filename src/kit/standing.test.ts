import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aComment, aDesignRound, aLabelAdded, aReview, aVerdictComment, anOpenIssue, anOpenPullRequest, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { type Standing, STANDING_NAMES, STANDING_SCHEMA, standingsOf, type StandingFacts } from "./standing.ts";
import type { CommentFacts, GitHubFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);

/** Every read a test in this file made, with the Standings it gave, for the plain-data checks at the end. */
const produced: { readonly facts: StandingFacts; readonly now: string; readonly standings: readonly Standing[] }[] = [];

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  const facts = standingFactsOf({ github: factsOf(github), ...overrides });
  const standings = standingsOf(facts, now);
  produced.push({ facts, now, standings });
  return standings;
}

describe("the Standing rule", () => {
  describe("at the Merge gate", () => {
    it("gives an agent PR out of draft with a pass on its head one Standing, yours to merge and stopping work, carrying its Ticket, since the pass", () => {
      const standings = standingsIn({
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")] })],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: "merge-gate",
          name: "yours-to-merge",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-07T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { plain: null },
        },
      ]);
    });

    const passed = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const atTheGate = (number: number, overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
      anOpenPullRequest({ number, ticket: number - 50, draft: false, comments: [passed], ...overrides });
    const namesIn = (standings: readonly Standing[]) => standings.map(({ pullRequest, name }) => ({ pullRequest, name }));

    it("leaves an agent PR yours to merge after the Operator's comment or approving review, which the Kit never acts on (ADR-0007)", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "approved", body: "Ship it." })] }),
          atTheGate(61, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "commented", body: "Nice." })] }),
          atTheGate(62, { comments: [passed, aComment("Looks good.", "2026-11-07T06:00:00Z", { author: "operator", byBot: false })] }),
        ],
      });
      expect(namesIn(standings)).toEqual([
        { pullRequest: 60, name: "yours-to-merge" },
        { pullRequest: 61, name: "yours-to-merge" },
        { pullRequest: 62, name: "yours-to-merge" },
      ]);
    });

    it("takes an agent PR off what is the Operator's once they request changes after the pass, but not for a dismissed one, one before the pass or someone else's", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { reviews: [aReview("2026-11-07T06:00:00Z")] }),
          atTheGate(61, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "dismissed" })] }),
          atTheGate(62, { reviews: [aReview("2026-11-04T20:00:00Z")] }),
          atTheGate(63, { reviews: [aReview("2026-11-07T06:00:00Z", { author: "someone" })] }),
          atTheGate(64, { reviews: [aReview("2026-11-06T06:00:00Z"), aReview("2026-11-07T06:00:00Z", { state: "approved" })] }),
        ],
      });
      expect(namesIn(standings)).toEqual([
        { pullRequest: 61, name: "yours-to-merge" },
        { pullRequest: 62, name: "yours-to-merge" },
        { pullRequest: 63, name: "yours-to-merge" },
      ]);
    });

    it("gives no Standing of the Operator's to a draft, or to a PR whose latest Verdict on its head is no pass", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { draft: true }),
          atTheGate(61, { comments: [aVerdictComment("pass", "o".repeat(40), "2026-11-05T20:00:00Z")] }),
          atTheGate(62, { comments: [passed, aVerdictComment("execution-flaw", HEAD, "2026-11-06T20:00:00Z")] }),
        ],
      });
      expect(standings).toEqual([]);
    });
  });

  describe("with ready-for-human", () => {
    const passed = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const handedBack = aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z");

    it("gives an agent PR the Kit handed back after its pass one Standing, yours to do at the Merge gate and stopping work, since the label", () => {
      const standings = standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [passed], labelEvents: [handedBack] })] });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: "merge-gate",
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: null, role: null, failure: null, label: null },
        },
      ]);
    });

    it("hands back a PR the Kit labelled after the Operator's Request changes, but not one labelled before a later pass or whose label came off", () => {
      const standings = standingsIn({
        openPullRequests: [
          anOpenPullRequest({ number: 60, ticket: 10, draft: false, comments: [passed], reviews: [aReview("2026-11-06T08:00:00Z")], labelEvents: [handedBack] }),
          anOpenPullRequest({ number: 61, ticket: 11, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")], labelEvents: [handedBack] }),
          anOpenPullRequest({
            number: 62,
            ticket: 12,
            draft: false,
            comments: [passed],
            labelEvents: [handedBack, aLabelAdded("ready-for-human", "2026-11-07T08:00:00Z", { action: "unlabeled", actor: "operator" })],
          }),
        ],
      });
      expect(standings.map(({ pullRequest, name, since }) => ({ pullRequest, name, since }))).toEqual([
        { pullRequest: 62, name: "yours-to-merge", since: "2026-11-05T20:00:00Z" },
        { pullRequest: 60, name: "yours-to-do", since: "2026-11-06T20:00:00Z" },
        { pullRequest: 61, name: "yours-to-merge", since: "2026-11-07T20:00:00Z" },
      ]);
    });

    it("gives any open issue labelled ready-for-human one Standing, yours to do with no place and stopping work, since the label, or since it was opened", () => {
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("needs-triage", "2026-10-30T20:00:00Z"), aLabelAdded("ready-for-human", "2026-11-01T20:00:00Z")] }),
          anOpenIssue({ number: 14, labels: ["ready-for-human"], createdAt: "2026-11-02T20:00:00Z" }),
          anOpenIssue({ number: 15, labels: ["needs-triage"] }),
        ],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 13,
          pullRequest: null,
          work: "ready-for-human",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-01T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: null, role: null, failure: null, label: null },
        },
        expect.objectContaining({ issue: 14, name: "yours-to-do", since: "2026-11-02T20:00:00Z" }),
      ]);
    });
  });

  describe("in a Design session", () => {
    const operatorAnswer = (at: string) => aComment("Option A, please.", at, { author: "operator", byBot: false });
    const designing = (number: number, comments: readonly CommentFacts[]) => anOpenIssue({ number, labels: ["needs-design"], comments });

    it("gives a needs-design issue whose last comment is the Fabrik App's Round one Standing, a Design round at Design with its number, stopping work, since the Round", () => {
      const standings = standingsIn({
        openIssues: [designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z"), aDesignRound(2, "2026-11-05T20:00:00Z")])],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: null,
          work: "design-session",
          place: "design",
          name: "design-round",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-05T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { round: 2, prototype: null },
        },
      ]);
    });

    it("says whether the Round is a prototype round or a prototype's failure round", () => {
      const round = (number: number, marker: string) => aComment(`${designRoundMarker(number)}\n${marker}\nWhich variant?`, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openIssues: [designing(12, [round(3, PROTOTYPE_ROUND_MARKER)]), designing(13, [round(4, PROTOTYPE_FAILURE_ROUND_MARKER)])],
      });
      expect(standings.map(({ issue, name, detail }) => ({ issue, name, detail }))).toEqual([
        { issue: 12, name: "design-round", detail: { round: 3, prototype: "ready" } },
        { issue: 13, name: "design-round", detail: { round: 4, prototype: "failed" } },
      ]);
    });

    it("gives no Design round once the Operator answered it, or for a Round marker another bot or a person posted", () => {
      const standings = standingsIn({
        openIssues: [
          designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z")]),
          designing(13, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "other-app[bot]" }]),
          designing(14, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "operator", byBot: false }]),
        ],
      });
      expect(standings).toEqual([]);
    });
  });

  describe("one piece of work", () => {
    it("is one Standing for a Ticket and the agent PR that closes it, carrying both numbers", () => {
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
        openPullRequests: [
          anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z")] }),
          anOpenPullRequest({ number: 51, ticket: 8 }),
        ],
      });
      expect(standings).toEqual([expect.objectContaining({ issue: 7, pullRequest: 50, work: "ready-for-human", name: "yours-to-do" })]);
    });

    it("keeps two open agent PRs that close the same Ticket apart, the Ticket's own Standing going with the lower", () => {
      const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: 7, draft: false, comments: [pass] }), anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [pass] })],
      });
      expect(standings.map(({ issue, pullRequest, name }) => ({ issue, pullRequest, name }))).toEqual([
        { issue: 7, pullRequest: 51, name: "yours-to-merge" },
        { issue: 7, pullRequest: 50, name: "yours-to-do" },
      ]);
    });

    it("is one Standing for an agent PR that closes no Ticket, keyed by its number", () => {
      const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: null, draft: false, comments: [pass] }), anOpenPullRequest({ number: 51, ticket: null, draft: false, comments: [pass] })],
      });
      expect(standings.map(({ issue, pullRequest }) => ({ issue, pullRequest }))).toEqual([
        { issue: null, pullRequest: 50 },
        { issue: null, pullRequest: 51 },
      ]);
    });
  });
});

// After every test above: these read what they produced.
describe("a Standing, as plain data", () => {
  const MINUTE = 60 * 1000;
  const fixture = JSON.parse(readFileSync(new URL("../__fixtures__/standings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
  const all = () => produced.flatMap(({ standings }) => standings);

  it("survives a JSON round trip unchanged, every one the tests above produced", () => {
    expect(all().length).toBeGreaterThan(0);
    for (const standing of all()) expect(JSON.parse(JSON.stringify(standing))).toStrictEqual(standing);
  });

  it("is the same for the same facts read a minute later", () => {
    for (const { facts, now, standings } of produced) {
      expect(standingsOf(facts, new Date(Date.parse(now) + MINUTE).toISOString())).toStrictEqual(standings);
    }
  });

  it("has one of each name so far in the schema fixture, in the order of the names", () => {
    const names = new Set(all().map(({ name }) => name));
    expect(Object.keys(fixture)).toEqual(STANDING_NAMES.filter((name) => names.has(name)));
  });

  it("has the fixture's fields, and its detail's, so removing or renaming one fails here", () => {
    for (const [name, kept] of Object.entries(fixture)) {
      const standing = all().find((read) => read.name === name);
      if (standing === undefined) throw new Error(`no test above produces a ${name} Standing`);
      expect(Object.keys(kept).toSorted()).toEqual(Object.keys(standing).toSorted());
      expect(Object.keys(kept.detail as object).toSorted()).toEqual(Object.keys(standing.detail).toSorted());
      expect(kept).toMatchObject({ schema: STANDING_SCHEMA, name });
    }
  });
});
