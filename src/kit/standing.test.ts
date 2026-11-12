import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aComment, aDesignRound, aDesignTurnFailedNotice, aLabelAdded, aMapCapRefusal, aReplayBody, aReview, aVerdictComment, anOpenAudit, anOpenIssue, anOpenPullRequest, anOpenReplay, anOpenRetro, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { aRunInFlight, aWeeklyLimitIssue } from "../__fixtures__/weeklySummary.ts";
import { aTicket } from "../__fixtures__/snapshots.ts";
import { resetsAtMarker } from "../loop/kitIssueMarks.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { subscriptionMarker } from "../loop/subscriptions.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
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

    it("gives a Design session whose last word is the Kit's notice that a turn failed one Standing, yours to do at Design, stopping work, since the notice", () => {
      const standings = standingsIn({ openIssues: [designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z"), aDesignTurnFailedNotice("2026-11-06T20:00:00Z")])] });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: null,
          work: "design-session",
          place: "design",
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: "design-turn-failed", role: "design", failure: null, label: null },
        },
      ]);
    });

    it("tells the Map cap's refusal apart from a failed turn", () => {
      const standings = standingsIn({ openIssues: [designing(21, [aMapCapRefusal("2026-11-07T20:00:00Z")])] });
      expect(standings).toEqual([
        expect.objectContaining({ issue: 21, work: "design-session", place: "design", name: "yours-to-do", stopsWork: true, detail: { handBack: "map-cap-refused", role: "design", failure: null, label: null } }),
      ]);
    });

    it("gives no Standing of the Operator's once they replied to the notice, once the session is over, or for a notice another bot posted", () => {
      const standings = standingsIn({
        openIssues: [
          designing(12, [aDesignTurnFailedNotice("2026-11-06T20:00:00Z"), operatorAnswer("2026-11-07T20:00:00Z")]),
          anOpenIssue({ number: 13, labels: ["ready-for-agent"], comments: [aDesignTurnFailedNotice("2026-11-06T20:00:00Z")] }),
          designing(14, [{ ...aDesignTurnFailedNotice("2026-11-06T20:00:00Z"), author: "other-app[bot]" }]),
        ],
      });
      expect(standings).toEqual([]);
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

  describe("a Subscription's issue", () => {
    const listing = (...subscriptions: readonly string[]) =>
      ({ kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, subscriptions } }, dispatch: null, runsInFlight: [] } }) as const;
    /** Open Kit-owned issue `number`, labelled `labels`, naming `subscription` in its body (none when null), opened at `createdAt`: as the open issues and as the Kit's issues. */
    const kitIssue = (number: number, labels: readonly string[], subscription: string | null, createdAt: string, body = "") => ({
      open: anOpenIssue({ number, labels, createdAt, labelEvents: labels.map((label) => aLabelAdded(label, createdAt)) }),
      kit: { number, labels, body: [body, ...(subscription === null ? [] : [subscriptionMarker(subscription)])].join("\n"), comments: [] },
    });
    const weeklyLimit = (number: number, subscription: string | null, resetsAt: string, createdAt = "2026-11-06T20:00:00Z") =>
      kitIssue(number, ["fabrik:weekly-limit"], subscription, createdAt, resetsAtMarker(resetsAt));
    const tokenRotation = (number: number, subscription: string | null) => kitIssue(number, ["ready-for-human", "fabrik:token-rotation"], subscription, "2026-11-05T20:00:00Z");
    const usageCredits = (number: number, subscription: string) => kitIssue(number, ["ready-for-human", "fabrik:usage-credits"], subscription, "2026-11-04T20:00:00Z");
    const facts = (...issues: readonly ReturnType<typeof kitIssue>[]) => ({ openIssues: issues.map(({ open }) => open), kitIssues: issues.map(({ kit }) => kit) });

    it("is waiting for its reset, the Kit's and never Stuck, for a weekly-limit issue while another Subscription is free, naming its Subscription", () => {
      expect(standingsIn(facts(weeklyLimit(20, "B", "2026-11-10T22:00:00Z")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 20,
          pullRequest: null,
          work: "weekly-limit",
          place: null,
          name: "waiting-for-reset",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { resetsAt: "2026-11-10T22:00:00Z" },
        },
      ]);
    });

    it("is the Operator's weekly limit reached, stopping work, once every Subscription listed is used up, each saying when the first resets", () => {
      const standings = standingsIn(facts(weeklyLimit(20, "A", "2026-11-10T22:00:00Z"), weeklyLimit(21, "B", "2026-11-09T22:00:00Z", "2026-11-07T20:00:00Z")), listing("A", "B"));
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 20,
          pullRequest: null,
          work: "weekly-limit",
          place: null,
          name: "weekly-limit-reached",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "A",
          detail: { resetsAt: "2026-11-09T22:00:00Z" },
        },
        expect.objectContaining({ issue: 21, name: "weekly-limit-reached", subscription: "B", detail: { resetsAt: "2026-11-09T22:00:00Z" } }),
      ]);
    });

    it("names the first Subscription listed for an issue whose body names none, and judges used up by the Kit's default config when none was read", () => {
      expect(standingsIn(facts(weeklyLimit(20, null, "2026-11-10T22:00:00Z")), listing("A", "B"))).toEqual([
        expect.objectContaining({ name: "waiting-for-reset", subscription: "A" }),
      ]);
      expect(standingsIn(facts(weeklyLimit(20, null, "2026-11-10T22:00:00Z")))).toEqual([
        expect.objectContaining({ name: "weekly-limit-reached", subscription: "Claude token" }),
      ]);
    });

    it("is the Operator's token refused, stopping work, for a token-rotation issue, saying whether another Subscription is free, not ready-for-human work", () => {
      expect(standingsIn(facts(tokenRotation(22, "B")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 22,
          pullRequest: null,
          work: "token-rotation",
          place: null,
          name: "token-refused",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-05T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { anotherFree: true },
        },
      ]);
      expect(standingsIn(facts(tokenRotation(22, null)))).toEqual([expect.objectContaining({ name: "token-refused", subscription: "Claude token", detail: { anotherFree: false } })]);
    });

    it("is the Operator's to do, stopping work, for a usage-credits issue, naming its Subscription", () => {
      expect(standingsIn(facts(usageCredits(23, "B")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 23,
          pullRequest: null,
          work: "usage-credits",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-04T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { handBack: null, role: null, failure: null, label: null },
        },
      ]);
    });
  });

  describe("reading matter", () => {
    const reading = (issue: number, work: Standing["work"], since: string, detail = { map: null as number | null, decisions: [] as number[] }) => ({
      schema: 1,
      repo: "owner/product",
      issue,
      pullRequest: null,
      work,
      place: null,
      name: "yours-to-read",
      move: "operator",
      yours: true,
      stopsWork: false,
      since,
      stuckAt: null,
      awaits: null,
      subscription: null,
      detail,
    });

    it("gives the Fabrik App's open Audit and Retro, filled or still pending, one Standing each, yours to read and stopping no work, since each was opened", () => {
      const standings = standingsIn({
        openAudits: [anOpenAudit({ number: 90, createdAt: "2026-11-02T20:00:00Z" })],
        openRetros: [anOpenRetro({ number: 120, createdAt: "2026-10-31T20:00:00Z" })],
      });
      expect(standings).toEqual([reading(120, "retro", "2026-10-31T20:00:00Z"), reading(90, "audit", "2026-11-02T20:00:00Z")]);
    });

    it("gives none to a fabrik:audit or fabrik:retro issue someone other than the Fabrik App opened", () => {
      const standings = standingsIn({
        openAudits: [anOpenAudit({ author: "operator" }), anOpenAudit({ number: 91, author: "other-app[bot]" })],
        openRetros: [anOpenRetro({ author: "operator" })],
      });
      expect(standings).toEqual([]);
    });

    it("gives the Operator's Replay whose results are in one, since the Kit wrote them, and none to one still running or someone else's", () => {
      const standings = standingsIn({
        openReplays: [
          anOpenReplay({ number: 140, lastEditedAt: "2026-11-06T20:00:00Z" }),
          anOpenReplay({ number: 141, body: aReplayBody({ state: "pending" }) }),
          anOpenReplay({ number: 142, author: "someone-else" }),
        ],
      });
      expect(standings).toEqual([reading(140, "replay", "2026-11-06T20:00:00Z")]);
    });

    it("gives an open Map one, since it got wayfinder:map, carrying its open grilling, prototype and task Decisions, and each of them one carrying the Map", () => {
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 30, labels: ["wayfinder:map"], labelEvents: [aLabelAdded("wayfinder:map", "2026-11-03T20:00:00Z")], subIssues: [31, 32, 33, 34, 35] }),
          anOpenIssue({ number: 31, labels: ["wayfinder:grilling"], labelEvents: [aLabelAdded("wayfinder:grilling", "2026-11-04T20:00:00Z")] }),
          anOpenIssue({ number: 32, labels: ["wayfinder:prototype"], createdAt: "2026-11-05T20:00:00Z" }),
          anOpenIssue({ number: 33, labels: ["wayfinder:task"], createdAt: "2026-11-05T20:00:00Z" }),
          // The Researcher's, and its run hasn't failed: not the Operator's.
          anOpenIssue({ number: 34, labels: ["wayfinder:research"] }),
          // On no open Map.
          anOpenIssue({ number: 36, labels: ["wayfinder:grilling"] }),
        ],
        openMaps: [30],
      });
      expect(standings).toEqual([
        reading(30, "map", "2026-11-03T20:00:00Z", { map: null, decisions: [31, 32, 33] }),
        reading(31, "operator-decision", "2026-11-04T20:00:00Z", { map: 30, decisions: [] }),
        reading(32, "operator-decision", "2026-11-05T20:00:00Z", { map: 30, decisions: [] }),
        reading(33, "operator-decision", "2026-11-05T20:00:00Z", { map: 30, decisions: [] }),
      ]);
    });

    it("gives an open issue labelled wayfinder:map that the Map cap's read doesn't count no Standing as a Map", () => {
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 30, labels: ["wayfinder:map"] })] })).toEqual([]);
    });
  });

  describe("a research Decision", () => {
    const failureNotice = (decision: number, at: string) => aComment(`${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #${decision} failed: it timed out.`, at);
    const mapOf = (number: number, decisions: readonly number[]) => anOpenIssue({ number, labels: ["wayfinder:map"], subIssues: decisions, createdAt: "2026-11-07T20:00:00Z" });
    const failed = (number: number, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
      anOpenIssue({ number, labels: ["wayfinder:research"], comments: [failureNotice(number, "2026-11-06T20:00:00Z")], ...overrides });
    const decisionsIn = (standings: readonly Standing[]) => standings.filter(({ work }) => work === "research-decision");

    it("on an open Map whose last run failed is the Operator's to do, stopping work, since the Kit's notice, until agent:research is added again", () => {
      const standings = standingsIn({ openIssues: [mapOf(30, [31]), failed(31)], openMaps: [30] });
      expect(decisionsIn(standings)).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 31,
          pullRequest: null,
          work: "research-decision",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: "research-failed", role: "research", failure: null, label: "agent:research" },
        },
      ]);
    });

    it("is no longer the Operator's once agent:research was added again after the notice", () => {
      const readded = aLabelAdded("agent:research", "2026-11-07T20:00:00Z", { actor: "operator" });
      const before = aLabelAdded("agent:research", "2026-11-05T20:00:00Z", { actor: "operator" });
      const standings = standingsIn({ openIssues: [mapOf(30, [31, 32]), failed(31, { labelEvents: [readded] }), failed(32, { labelEvents: [before] })], openMaps: [30] });
      expect(decisionsIn(standings).map(({ issue }) => issue)).toEqual([32]);
    });

    it("reads the failure from the Fabrik App's comments alone, and none on no open Map or whose later word answered it", () => {
      const otherBot = { author: "dependabot[bot]", byBot: true };
      const standings = standingsIn({
        openIssues: [
          mapOf(30, [31, 32, 33]),
          failed(31, { comments: [failureNotice(31, "2026-11-06T20:00:00Z"), aComment("Bumped a dependency.", "2026-11-07T08:00:00Z", otherBot)] }),
          failed(32, { comments: [aComment(`${RESEARCH_RUN_FAILED_MARKER}\nA look-alike.`, "2026-11-06T20:00:00Z", otherBot)] }),
          failed(33, { comments: [failureNotice(33, "2026-11-04T20:00:00Z"), aComment("Resolved: Stripe and Square both do.", "2026-11-05T20:00:00Z")] }),
          failed(34),
        ],
        openMaps: [30],
      });
      expect(decisionsIn(standings).map(({ issue, since }) => ({ issue, since }))).toEqual([{ issue: 31, since: "2026-11-06T20:00:00Z" }]);
    });
  });

  describe("in needs-info", () => {
    const asked = (number: number, author: string, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
      anOpenIssue({ number, author, labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", "2026-11-06T20:00:00Z")], ...overrides });

    it("gives an unanswered needs-info issue the Operator filed one Standing, needs your answer at Triage, stopping work, since the label", () => {
      expect(standingsIn({ openIssues: [asked(18, "operator")] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 18,
          pullRequest: null,
          work: "issue",
          place: "triage",
          name: "needs-your-answer",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { author: "operator" },
        },
      ]);
    });

    it("gives one the Fabrik App filed as the Monitor the same, naming the App as its author", () => {
      expect(standingsIn({ openIssues: [asked(15, "fabrik-app[bot]")] })).toEqual([
        expect.objectContaining({ issue: 15, name: "needs-your-answer", move: "operator", stopsWork: true, detail: { author: "fabrik-app[bot]" } }),
      ]);
    });

    it("never makes one anyone else filed the Operator's: it waits on its author, nobody's move, at Triage", () => {
      expect(standingsIn({ openIssues: [asked(16, "kate")] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 16,
          pullRequest: null,
          work: "issue",
          place: "triage",
          name: "waiting-on-author",
          move: "nobody",
          yours: false,
          stopsWork: false,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { author: "kate" },
        },
      ]);
    });

    it("gives none once a person answered after the question, though a bot's comment or an answer before it leaves it waiting", () => {
      const standings = standingsIn({
        openIssues: [
          asked(18, "operator", { comments: [aComment("CSV.", "2026-11-07T20:00:00Z", { author: "operator", byBot: false })] }),
          asked(19, "kate", { comments: [aComment("Since 2.3.", "2026-11-07T20:00:00Z", { author: "kate", byBot: false })] }),
          asked(20, "operator", { comments: [aComment("Still looking.", "2026-11-07T20:00:00Z")] }),
          asked(21, "operator", { comments: [aComment("Earlier.", "2026-11-05T20:00:00Z", { author: "operator", byBot: false })] }),
          anOpenIssue({ number: 22, author: "operator", labels: ["needs-triage"] }),
        ],
      });
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([
        { issue: 20, name: "needs-your-answer" },
        { issue: 21, name: "needs-your-answer" },
      ]);
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

describe("work that goes on without the Operator (#606)", () => {
  it("gives one Standing of each of its names, the Kit's move or nobody's, none of them the Operator's or able to turn Stuck", () => {
    const readyAt = "2026-11-05T12:00:00Z";
    const ready = (number: number) => anOpenIssue({ number, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", readyAt)] });
    const standings = standingsIn(
      {
        openIssues: [ready(7), ready(9), ready(14), ready(15)],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })],
        kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 9, label: "agent:implement" }], { commentedAt: ["2026-11-08T10:00:00Z"] })],
      },
      {
        kit: {
          repo: "owner/product",
          branch: "main",
          config: { ok: true, config: DEFAULT_KIT_CONFIG },
          dispatch: { candidates: { tickets: [aTicket({ number: 14 }), aTicket({ number: 15, openBlockers: [3] })], researchDecisions: [] } },
          runsInFlight: [
            aRunInFlight({ issue: 7, createdAt: "2026-11-08T19:20:00Z" }),
            aRunInFlight({ issue: 12 }),
            aRunInFlight({ role: "review", job: "waiting-on-checks", createdAt: "2026-11-08T19:40:00Z" }),
          ],
        },
      },
    );
    expect(standings.map(({ issue, name, move, yours, stopsWork, stuckAt }) => ({ issue, name, move, yours, stopsWork, stuckAt }))).toEqual([
      { issue: 14, name: "waiting-for-slot", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 15, name: "blocked", move: "nobody", yours: false, stopsWork: false, stuckAt: null },
      { issue: 9, name: "held", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 7, name: "running", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 8, name: "waiting-on-checks", move: "kit", yours: false, stopsWork: false, stuckAt: null },
    ]);
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

  it("stops work only when the Operator's, never for reading matter, and always for any other move of theirs but a Plain pull request's or a failed Weekly summary run's", () => {
    for (const standing of all()) {
      if (!standing.yours || standing.name === "yours-to-read") expect(standing).toMatchObject({ stopsWork: false });
      else if (standing.work !== "plain" && standing.work !== "weekly-summary") expect(standing).toMatchObject({ stopsWork: true });
    }
    expect(all().some(({ name }) => name === "yours-to-read")).toBe(true);
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
