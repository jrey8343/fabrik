import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import {
  aComment,
  aDesignRound,
  aDesignTurnFailedNotice,
  aLabelAdded,
  aMapCapRefusal,
  anOpenAudit,
  anOpenIssue,
  anOpenPullRequest,
  anOpenReplay,
  anOpenRetro,
  aPlainPullRequest,
  aReplayBody,
  aReview,
  aRunInFlight,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  standingFactsOf,
} from "../read/builders.ts";
import { aTicket } from "../__fixtures__/snapshots.ts";
import { resetsAtMarker } from "../loop/kitIssueMarks.ts";
import { NEEDS_DESIGN, NEEDS_INFO, NEEDS_TRIAGE, READY_FOR_AGENT, READY_FOR_HUMAN, TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "../loop/labels.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { subscriptionMarker } from "../loop/subscriptions.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingAt, STANDING_NAMES, STANDING_SCHEMA, standingsOf, type StandingFacts } from "./standing.ts";
import { isSpec } from "./standingInFlight.ts";
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
          detail: { plain: null, head: HEAD },
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
      expect(namesIn(standings.filter(({ move }) => move === "operator"))).toEqual([
        { pullRequest: 61, name: "yours-to-merge" },
        { pullRequest: 62, name: "yours-to-merge" },
        { pullRequest: 63, name: "yours-to-merge" },
      ]);
      // A Request changes no run was started for is the Kit's, Stuck by now (#608).
      expect(namesIn(standings.filter(({ move }) => move === "kit"))).toEqual([
        { pullRequest: 64, name: "stuck" },
        { pullRequest: 60, name: "stuck" },
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
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
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
          detail: { handBack: null, role: null, failure: null, label: null, head: HEAD },
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
      // #15 waits on Triage, the Kit's (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([
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
      // Each waits on the Kit instead (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
    });

    it("gives no Design round once the Operator answered it, or for a Round marker another bot or a person posted", () => {
      const standings = standingsIn({
        openIssues: [
          designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z")]),
          designing(13, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "other-app[bot]" }]),
          designing(14, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "operator", byBot: false }]),
        ],
      });
      // Each waits on the Kit's next turn instead (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
    });

    it("gives no Design round to an issue that has left Design by hand, its last comment still a Round", () => {
      const standings = standingsIn(
        {
          openIssues: [
            anOpenIssue({ number: 12, labels: ["ready-for-agent"], comments: [aDesignRound(2, "2026-11-05T20:00:00Z")] }),
            anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")], comments: [aDesignRound(3, "2026-11-05T20:00:00Z")] }),
          ],
        },
        {
          kit: {
            repo: "owner/product",
            branch: "main",
            config: { ok: true, config: DEFAULT_KIT_CONFIG },
            dispatch: null,
            headChecks: {},
            runsInFlight: [aRunInFlight({ issue: 12, createdAt: "2026-11-08T19:20:00Z" })],
          },
        },
      );
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([
        { issue: 13, name: "yours-to-do" },
        { issue: 12, name: "running" },
      ]);
    });
  });

  describe("a Subscription's issue", () => {
    const listing = (...subscriptions: readonly string[]) =>
      ({ kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, subscriptions } }, dispatch: null, runsInFlight: [], headChecks: {} } }) as const;
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
      // #141, between its steps, waits on the Kit (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([reading(140, "replay", "2026-11-06T20:00:00Z")]);
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
      // The answered ones and #22 wait on Triage, the Kit's (#608).
      expect(standings.filter(({ move }) => move === "operator").map(({ issue, name }) => ({ issue, name }))).toEqual([
        { issue: 20, name: "needs-your-answer" },
        { issue: 21, name: "needs-your-answer" },
      ]);
    });
  });

  describe("a Plain pull request", () => {
    it("is named by its draft, its merge and its Required checks, each with its kind and no place (src/kit/standingPlain.test.ts)", () => {
      const head = (digit: string) => digit.repeat(40);
      const kit = {
        repo: "owner/product",
        branch: "main",
        config: { ok: true, config: DEFAULT_KIT_CONFIG },
        dispatch: null,
        runsInFlight: [],
        headChecks: { [head("1")]: [{ name: "test", is: "running" }], [head("2")]: [{ name: "test", is: "failing" }] },
      } as const;
      const standings = standingsIn(
        {
          plainPullRequests: [
            aPlainPullRequest({ number: 70, headSha: head("1") }),
            aPlainPullRequest({ number: 71, headSha: head("2"), author: "operator", headRef: "fabrik/setup-v3.1.0" }),
            aPlainPullRequest({ number: 72, mergeable: false }),
            aPlainPullRequest({ number: 73, draft: true, author: "operator", headRef: "fix-typo" }),
          ],
        },
        { kit },
      );
      expect(standings.map(({ pullRequest, name, detail }) => ({ pullRequest, name, detail }))).toEqual([
        { pullRequest: 70, name: "waiting-on-checks", detail: { plain: "kit-bump", check: "test", checksUnread: false, head: head("1") } },
        { pullRequest: 71, name: "check-failing", detail: { plain: "setup", check: "test", checkIs: "failing", head: head("2") } },
        { pullRequest: 72, name: "conflicts", detail: { plain: "kit-bump", head: head("p") } },
        { pullRequest: 73, name: "draft", detail: { plain: "other", head: head("p") } },
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
      expect(standings).toEqual([
        expect.objectContaining({ issue: 8, pullRequest: 51, name: "stuck" }),
        expect.objectContaining({ issue: 7, pullRequest: 50, work: "ready-for-human", name: "yours-to-do" }),
      ]);
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

    it("carries its open pull request's head commit in detail.head, an agent PR's, a Plain one's and a Pairing session's, and no such key with none (#618)", () => {
      const head = (digit: string) => digit.repeat(40);
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] }),
          anOpenIssue({ number: 9, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T21:00:00Z")] }),
          anOpenIssue({ number: 12 }),
        ],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, headSha: head("1") })],
        plainPullRequests: [
          aPlainPullRequest({ number: 70, headSha: head("2") }),
          aPlainPullRequest({ number: 71, headSha: head("3"), author: "operator", headRef: "fabrik/pair-12", closes: [12] }),
        ],
      });
      const heads = standings.map((standing) => ({ issue: standing.issue, pullRequest: standing.pullRequest, head: "head" in standing.detail ? standing.detail.head : "none" }));
      expect(heads).toEqual(
        expect.arrayContaining([
          { issue: 7, pullRequest: 50, head: head("1") },
          { issue: 9, pullRequest: null, head: "none" },
          { issue: null, pullRequest: 70, head: head("2") },
          { issue: 12, pullRequest: 71, head: head("3") },
        ]),
      );
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
          headChecks: {},
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

describe("a run that was asked for and never began (#607)", () => {
  const LABELLED = "2026-11-08T19:20:00Z";
  const STUCK_AT = "2026-11-08T22:50:00.000Z";
  const asked = { openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", LABELLED)] })] };

  it("is not-started before the bar and stuck after it, the Kit's move still, but the Operator's to act on and stopping work", () => {
    expect(standingsIn(asked, {}, "2026-11-08T22:49:00Z")).toMatchObject([{ name: "not-started", move: "kit", yours: false, stopsWork: false, stuckAt: STUCK_AT }]);
    expect(standingsIn(asked, {}, "2026-11-08T22:51:00Z")).toMatchObject([
      { name: "stuck", move: "kit", yours: true, stopsWork: true, since: LABELLED, stuckAt: STUCK_AT, detail: { was: "not-started", silence: "trigger-label", label: "agent:implement" } },
    ]);
  });

  it.each([
    ["before the bar", "2026-11-08T22:49:00Z"],
    ["at the bar", STUCK_AT],
    ["after the bar", "2026-11-09T09:00:00Z"],
  ])("reads a kept Standing at a later time as the rule reads the same facts then, %s", (_, later) => {
    const kept = standingsIn(asked, {}, "2026-11-08T20:00:00Z");
    expect(kept.map((standing) => standingAt(standing, later))).toStrictEqual(standingsIn(asked, {}, later));
  });

  it("leaves a kept Standing with no stuckAt, or one already stuck, as it is", () => {
    const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const [atTheGate] = standingsIn({ openPullRequests: [anOpenPullRequest({ draft: false, comments: [pass] })] });
    const [stuck] = standingsIn(asked, {}, "2026-11-09T09:00:00Z");
    expect(standingAt(atTheGate!, "2027-01-01T00:00:00Z")).toBe(atTheGate);
    expect(standingAt(stuck!, "2027-01-01T00:00:00Z")).toBe(stuck);
  });
});

describe("every other silence, and a draft the Operator parked (#608)", () => {
  const PUSHED = "2026-11-08T19:20:00Z";
  /** Agent draft #50 for Ticket 7, last pushed by the Fabrik App at PUSHED. */
  const draft = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) => anOpenPullRequest({ number: 50, ticket: 7, commits: [{ at: PUSHED, byApp: true }], ...overrides });
  const kit = (runsInFlight: readonly RunInFlightFact[] = []) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {} }) as const;

  it("gives a quiet draft waiting on the Kit a minute before the bar and Stuck a minute after it", () => {
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit() }, "2026-11-08T22:49:00Z")).toMatchObject([
      { issue: 7, pullRequest: 50, name: "waiting-on-kit", stuckAt: "2026-11-08T22:50:00.000Z", detail: { silence: "quiet-draft" } },
    ]);
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit() }, "2026-11-08T22:51:00Z")).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit" } }]);
  });

  it("gives a draft with a pass the Operator put back in draft parked, theirs, stopping no work and never Stuck; never taken out of draft, the passed-draft silence", () => {
    const pass = aVerdictComment("pass", HEAD, PUSHED);
    const parked = draft({ comments: [pass], draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: "2026-11-08T19:21:00Z" }, { kind: "draft", actor: "operator", at: "2026-11-08T19:40:00Z" }] });
    expect(standingsIn({ openPullRequests: [parked] }, { kit: kit() }, "2027-01-01T00:00:00Z")).toMatchObject([
      { name: "parked", move: "operator", yours: true, stopsWork: false, since: "2026-11-08T19:40:00Z", stuckAt: null },
    ]);
    expect(standingsIn({ openPullRequests: [draft({ comments: [pass] })] }, { kit: kit() })).toMatchObject([{ name: "waiting-on-kit", since: PUSHED, detail: { silence: "passed-draft" } }]);
  });

  it("gives a draft with a run in flight on it running, and one whose Ticket's run is held held", () => {
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit([aRunInFlight({ role: "review", pullRequest: 50 })]) })).toMatchObject([{ issue: 7, pullRequest: 50, name: "running" }]);
    const held = aWeeklyLimitIssue(null, [{ role: "implement", issue: 7, label: "agent:implement" }], { commentedAt: ["2026-11-08T10:00:00Z"] });
    expect(standingsIn({ openPullRequests: [draft()], kitIssues: [held] }, { kit: kit() })).toMatchObject([{ issue: 7, pullRequest: 50, name: "held" }]);
  });

  it("gives a releasable Ticket with a free slot waiting on the Kit with no stuckAt", () => {
    const ready = anOpenIssue({ number: 14, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-05T12:00:00Z")] });
    const releasing = { ...kit(), dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [] } } };
    expect(standingsIn({ openIssues: [ready] }, { kit: releasing })).toMatchObject([{ issue: 14, name: "waiting-on-kit", stuckAt: null, detail: { silence: "releasable" } }]);
  });
});

// After every test above: these read what they produced.
describe("a Standing, as plain data", () => {
  const MINUTE = 60 * 1000;
  const fixture = JSON.parse(readFileSync(new URL("../__fixtures__/standings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
  const all = () => produced.flatMap(({ standings }) => standings);

  it("gives every open issue on the Loop exactly one, a Spec aside, and every open agent PR one it shares with its Ticket, in every read the tests above made, and none to an issue with no such label", () => {
    // The state labels, and the Kit's own labels on an issue whose rule needs no other fact.
    const onTheLoop = [NEEDS_TRIAGE, NEEDS_INFO, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN, WEEKLY_LIMIT_LABEL, TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL];
    let issues = 0;
    for (const { facts, standings } of produced) {
      const { openIssues, openPullRequests, plainPullRequests } = facts.github;
      for (const pullRequest of openPullRequests) {
        const its = standings.filter((standing) => standing.pullRequest === pullRequest.number);
        expect(its, `#${pullRequest.number}`).toHaveLength(1);
        if (openIssues.some(({ number }) => number === pullRequest.ticket)) expect(its[0]?.issue).toBe(pullRequest.ticket);
      }
      for (const issue of openIssues) {
        const its = standings.filter((standing) => standing.issue === issue.number);
        const closing = openPullRequests.filter(({ ticket }) => ticket === issue.number).length;
        if (issue.labels.some((label) => onTheLoop.includes(label)) && !isSpec(issue)) {
          issues += 1;
          // Two open agent PRs that close one Ticket are kept apart.
          expect(its, `#${issue.number}`).toHaveLength(Math.max(1, closing));
        } else if (issue.labels.length === 0 && closing === 0 && !plainPullRequests.some(({ closes }) => closes.includes(issue.number))) {
          expect(its, `#${issue.number}`).toEqual([]);
        }
      }
    }
    expect(issues).toBeGreaterThan(0);
  });

  it("survives a JSON round trip unchanged, every one the tests above produced", () => {
    expect(all().length).toBeGreaterThan(0);
    for (const standing of all()) expect(JSON.parse(JSON.stringify(standing))).toStrictEqual(standing);
  });

  it("stops work only when the Operator's, never for reading matter or a parked draft, and always for any other move of theirs but a Plain pull request's or a failed Weekly summary run's", () => {
    for (const standing of all()) {
      if (!standing.yours || standing.name === "yours-to-read" || standing.name === "parked") expect(standing).toMatchObject({ stopsWork: false });
      else if (standing.work !== "plain" && standing.work !== "weekly-summary") expect(standing).toMatchObject({ stopsWork: true });
    }
    expect(all().some(({ name }) => name === "yours-to-read")).toBe(true);
  });

  it("is the same for the same facts read a minute later, but for a Standing that crossed its bar then", () => {
    let crossed = 0;
    for (const { facts, now, standings } of produced) {
      const later = new Date(Date.parse(now) + MINUTE).toISOString();
      const read = standingsOf(facts, later);
      crossed += read.filter((standing, at) => standing.name !== standings[at]?.name).length;
      expect(read).toStrictEqual(standings.map((standing) => standingAt(standing, later)));
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it("has one of each name so far in the schema fixture, in the order of the names", () => {
    const names = new Set(all().map(({ name }) => name));
    expect(Object.keys(fixture)).toEqual(STANDING_NAMES.filter((name) => names.has(name)));
  });

  it("has the fixture's fields, and its detail's, so removing or renaming one fails here", () => {
    for (const [name, kept] of Object.entries(fixture)) {
      // A stuck Standing's detail is the name it was's: the fixture's is matched by its `was`.
      const was = (kept.detail as { was?: string }).was;
      // `detail.head` is on a Standing with an open pull request only: the fixture's is matched by whether it has one.
      const standing = all().find(
        (read) => read.name === name && (was === undefined || ("was" in read.detail && read.detail.was === was)) && (read.pullRequest === null) === (kept["pullRequest"] === null),
      );
      if (standing === undefined) throw new Error(`no test above produces a ${name} Standing`);
      expect(Object.keys(kept).toSorted()).toEqual(Object.keys(standing).toSorted());
      expect(Object.keys(kept.detail as object).toSorted()).toEqual(Object.keys(standing.detail).toSorted());
      expect(kept).toMatchObject({ schema: STANDING_SCHEMA, name });
    }
  });
});
