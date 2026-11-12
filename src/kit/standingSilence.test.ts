import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { aDesignQueueIssue, aResearchDecision, aTicket, kitConfig } from "../__fixtures__/snapshots.ts";
import {
  aComment,
  aDesignRound,
  aLabelAdded,
  anOpenIssue,
  anOpenPullRequest,
  anOpenReplay,
  aReplayBody,
  aReview,
  aRunInFlight,
  aVerdictComment,
  factsOf,
  standingFactsOf,
} from "../read/builders.ts";
import { undeliveredMarker } from "../loop/markers.ts";
import type { KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit at this Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread" = [], config: KitConfig = DEFAULT_KIT_CONFIG): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {} };
}

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit: aKit(), ...overrides }), now);
}

/** A time `minutes` after `at`, as the rule writes one. */
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();

const HEAD = "h".repeat(40);
const PUSHED = "2026-11-08T19:20:00Z";
/** 210 minutes after PUSHED: the bar on default timeouts. */
const BAR = plus(PUSHED, 210);

describe("a draft with nothing to explain it", () => {
  const quiet = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
    anOpenPullRequest({ number: 50, ticket: 7, createdAt: "2026-11-08T12:00:00Z", commits: [{ at: "2026-11-08T12:00:00Z", byApp: true }, { at: PUSHED, byApp: true }], ...overrides });

  it("is waiting on the Kit at Review from its last push, turning Stuck at the bar, and awaits a Review on the pull request", () => {
    expect(standingsIn({ openPullRequests: [quiet()] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "review",
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: PUSHED,
        stuckAt: BAR,
        awaits: { role: "review", on: "pullRequest" },
        subscription: null,
        detail: { silence: "quiet-draft", round: null, head: HEAD },
      },
    ]);
  });

  it("is waiting on the Kit a minute before the bar and stuck a minute after it", () => {
    expect(standingsIn({ openPullRequests: [quiet()] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openPullRequests: [quiet()] }, {}, plus(BAR, 1))).toMatchObject([
      { name: "stuck", move: "kit", yours: true, stopsWork: true, since: PUSHED, stuckAt: BAR, detail: { was: "waiting-on-kit", silence: "quiet-draft", round: null } },
    ]);
  });

  it("leaves stuckAt where it was after a person's later comment, and moves it on the Fabrik App's", () => {
    const later = plus(PUSHED, 30);
    expect(standingsIn({ openPullRequests: [quiet({ comments: [aComment("What's happening?", later, { author: "operator", byBot: false })] })] })).toMatchObject([{ stuckAt: BAR }]);
    expect(standingsIn({ openPullRequests: [quiet({ comments: [aComment("Noted.", later)] })] })).toMatchObject([{ stuckAt: plus(later, 210) }]);
  });

  it("counts from its opening when none of its commits were read", () => {
    expect(standingsIn({ openPullRequests: [quiet({ commits: [] })] })).toMatchObject([{ since: "2026-11-08T12:00:00Z" }]);
  });

  it("counts the repo's own bar", () => {
    const config = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, implement: { ...DEFAULT_KIT_CONFIG.roles.implement, timeoutMinutes: 120 } } });
    expect(standingsIn({ openPullRequests: [quiet()] }, { kit: aKit([], config) })).toMatchObject([{ stuckAt: plus(PUSHED, 270) }]);
  });
});

describe("a draft that conflicts with main and has no Verdict on its head", () => {
  const conflicting = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
    anOpenPullRequest({ number: 50, ticket: 7, mergeable: false, commits: [{ at: PUSHED, byApp: true }], ...overrides });

  it("is waiting on the Kit at Review from its last push, for the conflict-only run that brings it up to date, turning Stuck at the bar", () => {
    expect(standingsIn({ openPullRequests: [conflicting()] })).toMatchObject([
      { issue: 7, pullRequest: 50, place: "review", name: "waiting-on-kit", since: PUSHED, stuckAt: BAR, awaits: { role: "implement", on: "pullRequest" }, detail: { silence: "conflicting-draft", round: null } },
    ]);
    expect(standingsIn({ openPullRequests: [conflicting()] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openPullRequests: [conflicting()] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "conflicting-draft" } }]);
  });

  it("is a quiet draft instead when GitHub hasn't worked out whether it conflicts, which is read as merging cleanly, or when its head has a Verdict", () => {
    expect(standingsIn({ openPullRequests: [conflicting({ mergeable: null })] })).toMatchObject([{ detail: { silence: "quiet-draft" } }]);
    expect(standingsIn({ openPullRequests: [conflicting({ comments: [aVerdictComment("design-flaw", HEAD, plus(PUSHED, 5))] })] })).toMatchObject([
      { detail: { silence: "quiet-draft" } },
    ]);
  });
});

describe("a draft with a pass on its head", () => {
  const PASSED = PUSHED;
  const LATER = plus(PASSED, 30);
  const passedDraft = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
    anOpenPullRequest({ number: 50, ticket: 7, commits: [{ at: "2026-11-08T18:00:00Z", byApp: true }], comments: [aVerdictComment("pass", HEAD, PASSED)], ...overrides });

  it("never taken out of draft since its pass is waiting on the Kit to open the Merge gate, from the pass, turning Stuck at the bar", () => {
    expect(standingsIn({ openPullRequests: [passedDraft()] })).toMatchObject([
      { issue: 7, pullRequest: 50, place: "review", name: "waiting-on-kit", move: "kit", since: PASSED, stuckAt: BAR, awaits: { role: "review", on: "pullRequest" }, detail: { silence: "passed-draft", round: null } },
    ]);
    expect(standingsIn({ openPullRequests: [passedDraft()] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openPullRequests: [passedDraft()] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "passed-draft" } }]);
  });

  it("put back in draft after the pass by the Operator is parked: theirs, not stopping work, never Stuck, since they did it", () => {
    const parked = passedDraft({
      draftEvents: [
        { kind: "ready", actor: "fabrik-app[bot]", at: plus(PASSED, 1) },
        { kind: "draft", actor: "operator", at: LATER },
      ],
    });
    expect(standingsIn({ openPullRequests: [parked] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "review",
        name: "parked",
        move: "operator",
        yours: true,
        stopsWork: false,
        since: LATER,
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { head: HEAD },
      },
    ]);
    expect(standingsIn({ openPullRequests: [parked] }, {}, "2027-01-01T00:00:00Z")).toMatchObject([{ name: "parked" }]);
  });

  it("is not parked when the Fabrik App put it back in draft, or when the Operator's draft was before the pass", () => {
    const byApp = passedDraft({ draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: plus(PASSED, 1) }, { kind: "draft", actor: "fabrik-app[bot]", at: LATER }] });
    const before = passedDraft({ draftEvents: [{ kind: "ready", actor: "operator", at: "2026-11-08T18:10:00Z" }, { kind: "draft", actor: "operator", at: "2026-11-08T18:20:00Z" }] });
    expect(standingsIn({ openPullRequests: [byApp] })).toMatchObject([{ name: "waiting-on-kit", detail: { silence: "quiet-draft" } }]);
    expect(standingsIn({ openPullRequests: [before] })).toMatchObject([{ name: "waiting-on-kit", detail: { silence: "passed-draft" } }]);
  });
});

describe("the Operator's Request changes with no run started", () => {
  const PASSED = "2026-11-08T12:00:00Z";
  const REQUESTED = PUSHED;
  /** Agent PR #50 for Ticket 7, passed and taken out of draft by the Fabrik App, then given these reviews and comments. */
  const atTheGate = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
    anOpenPullRequest({
      number: 50,
      ticket: 7,
      draft: false,
      comments: [aVerdictComment("pass", HEAD, PASSED)],
      draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: PASSED }],
      reviews: [aReview(REQUESTED, { id: 901 })],
      ...overrides,
    });

  it("is waiting on the Kit at Implement from when it was submitted, for a Request-changes run on the pull request, turning Stuck at the bar", () => {
    expect(standingsIn({ openPullRequests: [atTheGate()] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "implement",
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: REQUESTED,
        stuckAt: BAR,
        awaits: { role: "implement", on: "pullRequest" },
        subscription: null,
        detail: { silence: "request-changes", round: null, head: HEAD },
      },
    ]);
    expect(standingsIn({ openPullRequests: [atTheGate()] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openPullRequests: [atTheGate()] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "request-changes" } }]);
  });

  it("reads an out-of-draft PR whose draft events weren't read as out of draft all along", () => {
    expect(standingsIn({ openPullRequests: [atTheGate({ draftEvents: [] })] })).toMatchObject([{ detail: { silence: "request-changes" } }]);
  });

  it("leaves stuckAt where it was after the Operator's later comment", () => {
    const comments = [aVerdictComment("pass", HEAD, PASSED), aComment("Any news?", plus(REQUESTED, 30), { author: "operator", byBot: false })];
    expect(standingsIn({ openPullRequests: [atTheGate({ comments })] })).toMatchObject([{ stuckAt: BAR }]);
  });

  it("is no such silence once the Kit's note started a run for it, nor for a dismissed one or someone else's", () => {
    const noted = atTheGate({ comments: [aVerdictComment("pass", HEAD, PASSED), aComment(`${undeliveredMarker([901])}\nStarting it.`, plus(REQUESTED, 90))] });
    for (const pullRequest of [noted, atTheGate({ reviews: [aReview(REQUESTED, { id: 901, state: "dismissed" })] }), atTheGate({ reviews: [aReview(REQUESTED, { id: 901, author: "someone" })] })]) {
      expect(standingsIn({ openPullRequests: [pullRequest] })).not.toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ silence: "request-changes" }) }));
    }
  });

  it("is running while an Implement run is in flight for its Ticket", () => {
    expect(standingsIn({ openIssues: [anOpenIssue({ number: 7 })], openPullRequests: [atTheGate()] }, { kit: aKit([aRunInFlight({ issue: 7 })]) })).toMatchObject([
      { issue: 7, pullRequest: 50, name: "running", detail: { run: "request-changes" } },
    ]);
  });
});

describe("an issue waiting on Triage", () => {
  const ASKED = "2026-11-08T12:00:00Z";
  const ANSWERED = PUSHED;
  const question = (comments: readonly CommentFacts[] = [], author = "someone") =>
    anOpenIssue({ number: 12, author, labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", ASKED)], comments });
  const answer = aComment("It happens on Safari.", ANSWERED, { author: "someone", byBot: false });

  it("with its needs-info question answered is waiting on the Kit at Triage from the first answer, for a Triage run, turning Stuck at the bar", () => {
    expect(standingsIn({ openIssues: [question([answer])] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 12,
        pullRequest: null,
        work: "issue",
        place: "triage",
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: ANSWERED,
        stuckAt: BAR,
        awaits: { role: "triage", on: "issue" },
        subscription: null,
        detail: { silence: "needs-info-answered", round: null },
      },
    ]);
    expect(standingsIn({ openIssues: [question([answer])] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openIssues: [question([answer])] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "needs-info-answered" } }]);
  });

  it("leaves stuckAt where it was after a person's later comment on the answered question", () => {
    const later = aComment("Any news?", plus(ANSWERED, 60), { author: "operator", byBot: false });
    expect(standingsIn({ openIssues: [question([answer, later])] })).toMatchObject([{ since: ANSWERED, stuckAt: BAR }]);
  });

  it("is running while a Triage run is in flight", () => {
    expect(standingsIn({ openIssues: [question([answer])] }, { kit: aKit([aRunInFlight({ role: "triage" })]) })).toMatchObject([{ name: "running", detail: { run: "triage" } }]);
  });

  it("with needs-triage is waiting on the Kit at Triage from when the label was last added, whoever added it", () => {
    const triage = anOpenIssue({
      number: 13,
      labels: ["needs-triage"],
      labelEvents: [aLabelAdded("needs-triage", "2026-11-08T10:00:00Z"), aLabelAdded("needs-triage", "2026-11-08T11:00:00Z", { action: "unlabeled" }), aLabelAdded("needs-triage", PUSHED, { actor: "operator" })],
    });
    expect(standingsIn({ openIssues: [triage] })).toMatchObject([
      { issue: 13, work: "issue", place: "triage", name: "waiting-on-kit", since: PUSHED, stuckAt: BAR, awaits: { role: "triage", on: "issue" }, detail: { silence: "needs-triage", round: null } },
    ]);
    expect(standingsIn({ openIssues: [triage] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openIssues: [triage] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "needs-triage" } }]);
    expect(standingsIn({ openIssues: [anOpenIssue({ number: 13, labels: ["needs-triage"], createdAt: PUSHED })] })).toMatchObject([{ since: PUSHED, stuckAt: BAR }]);
  });
});

describe("a Design session whose Round the Operator answered", () => {
  const answered = (comments = [aDesignRound(2, "2026-11-08T12:00:00Z"), aComment("The second.", PUSHED, { author: "operator", byBot: false })]) =>
    anOpenIssue({ number: 20, labels: ["needs-design"], comments });

  it("is waiting on the Kit at Design from the Operator's reply, for the next turn, carrying the round, turning Stuck at the bar", () => {
    expect(standingsIn({ openIssues: [answered()] })).toMatchObject([
      { issue: 20, work: "design-session", place: "design", name: "waiting-on-kit", since: PUSHED, stuckAt: BAR, awaits: { role: "design", on: "issue" }, detail: { silence: "round-answered", round: 2 } },
    ]);
    expect(standingsIn({ openIssues: [answered()] }, {}, plus(BAR, -1))).toMatchObject([{ name: "waiting-on-kit" }]);
    expect(standingsIn({ openIssues: [answered()] }, {}, plus(BAR, 1))).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit", silence: "round-answered", round: 2 } }]);
  });

  it("counts from the Operator's first reply, and a turn in flight is running", () => {
    const twice = [aDesignRound(2, "2026-11-08T12:00:00Z"), aComment("The second.", PUSHED, { author: "operator", byBot: false }), aComment("Or the first.", plus(PUSHED, 20), { author: "operator", byBot: false })];
    expect(standingsIn({ openIssues: [answered(twice)] })).toMatchObject([{ since: PUSHED, stuckAt: BAR }]);
    expect(standingsIn({ openIssues: [answered()] }, { kit: aKit([aRunInFlight({ role: "design", issue: 20 })]) })).toMatchObject([{ name: "running" }]);
  });

  it("is no answered Round while the Round is the last word, or when only someone else replied", () => {
    expect(standingsIn({ openIssues: [answered([aDesignRound(2, "2026-11-08T12:00:00Z")])] })).toMatchObject([{ name: "design-round" }]);
    const someoneElse = [aDesignRound(2, "2026-11-08T12:00:00Z"), aComment("+1", PUSHED, { author: "someone", byBot: false })];
    expect(standingsIn({ openIssues: [answered(someoneElse)] })).not.toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ silence: "round-answered" }) }));
  });
});

describe("silences the rule cannot date", () => {
  const READY = "2026-11-05T12:00:00Z";
  const dispatching = (tickets: Parameters<typeof aTicket>[0][], researchDecisions: Parameters<typeof aResearchDecision>[0][] = [], maxInFlight = DEFAULT_KIT_CONFIG.maxInFlight): RepoKitFacts => ({
    ...aKit([], { ...DEFAULT_KIT_CONFIG, maxInFlight }),
    dispatch: { candidates: { tickets: tickets.map((ticket) => aTicket(ticket)), researchDecisions: researchDecisions.map((decision) => aResearchDecision(decision)) } },
  });

  it("gives a ready, unblocked Ticket that a free slot would let Dispatch release waiting on the Kit at Implement, since it got ready-for-agent, never turning Stuck", () => {
    const facts = { openIssues: [anOpenIssue({ number: 14, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", READY)] })] };
    expect(standingsIn(facts, { kit: dispatching([{ number: 14 }]) })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 14,
        pullRequest: null,
        work: "ticket",
        place: "implement",
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: READY,
        stuckAt: null,
        awaits: { role: "implement", on: "issue" },
        subscription: null,
        detail: { silence: "releasable", round: null },
      },
    ]);
    expect(standingsIn(facts, { kit: dispatching([{ number: 14 }]) }, "2027-01-01T00:00:00Z")).toMatchObject([{ name: "waiting-on-kit", stuckAt: null }]);
  });

  it("gives a research Decision Dispatch would release the same, with no place, and one max_in_flight holds waits for a slot instead", () => {
    const decision = anOpenIssue({ number: 21, labels: ["wayfinder:research"], labelEvents: [aLabelAdded("wayfinder:research", READY)] });
    expect(standingsIn({ openIssues: [decision] }, { kit: dispatching([], [{ number: 21 }]) })).toMatchObject([
      { issue: 21, work: "research-decision", place: null, name: "waiting-on-kit", stuckAt: null, awaits: { role: "research", on: "issue" }, detail: { silence: "releasable" } },
    ]);
    expect(standingsIn({ openIssues: [decision] }, { kit: dispatching([], [{ number: 21 }], 0) })).toMatchObject([{ name: "waiting-for-slot" }]);
  });

  it("gives a needs-design issue the Design queue check would start a session on, a slot being free, waiting on the Kit at Design, since it got needs-design; with every slot held it waits for one", () => {
    const waiting = aDesignQueueIssue({ number: 21, neededDesignAt: READY });
    const holding = (number: number) => aDesignQueueIssue({ number, designRounds: 1 });
    expect(standingsIn({ designQueue: { issues: [waiting, holding(22)], designTurnsInProgress: [] } })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 21,
        pullRequest: null,
        work: "design-session",
        place: "design",
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: READY,
        stuckAt: null,
        awaits: { role: "design", on: "issue" },
        subscription: null,
        detail: { silence: "design-slot-free", round: null },
      },
    ]);
    expect(standingsIn({ designQueue: { issues: [waiting, holding(22), holding(23)], designTurnsInProgress: [] } })).toMatchObject([{ issue: 21, name: "waiting-for-slot" }]);
  });

  it("gives the Operator's Replay between its steps waiting on the Kit with no place, since its body was last written, and someone else's none", () => {
    const between = anOpenReplay({ body: aReplayBody({ state: "pending" }) });
    expect(standingsIn({ openReplays: [between] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 140,
        pullRequest: null,
        work: "replay",
        place: null,
        name: "waiting-on-kit",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: "2026-11-06T20:00:00Z",
        stuckAt: null,
        awaits: { role: "replay", on: "issue" },
        subscription: null,
        detail: { silence: "replay-between-steps", round: null },
      },
    ]);
    expect(standingsIn({ openReplays: [{ ...between, author: "someone" }] })).toEqual([]);
  });

  describe("anything else left over", () => {
    const LABELLED = "2026-11-06T12:00:00Z";
    const leftOver = { name: "waiting-on-kit", move: "kit", yours: false, stopsWork: false, stuckAt: null, awaits: null, detail: { silence: "left-over", round: null } };

    it.each([
      ["needs-design with no Design queue read", "needs-design", "design-session", "design"],
      ["ready-for-agent with no Dispatch read", "ready-for-agent", "ticket", "implement"],
    ] as const)("gives an open issue labelled %s waiting on the Kit with no stuckAt, since the label", (_, label, work, place) => {
      const issue = anOpenIssue({ number: 30, labels: [label], labelEvents: [aLabelAdded(label, LABELLED)] });
      expect(standingsIn({ openIssues: [issue] }, { kit: null })).toEqual([
        { schema: 1, repo: "owner/product", issue: 30, pullRequest: null, work, place, since: LABELLED, subscription: null, ...leftOver },
      ]);
    });

    it("gives an open agent PR out of draft that nothing names waiting on the Kit with no stuckAt, since it left draft", () => {
      const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, draft: false, draftEvents: [{ kind: "ready", actor: "operator", at: LABELLED }] });
      expect(standingsIn({ openPullRequests: [pullRequest] })).toEqual([
        { schema: 1, repo: "owner/product", issue: 7, pullRequest: 50, work: "ticket", place: "merge-gate", since: LABELLED, subscription: null, ...leftOver, detail: { ...leftOver.detail, head: HEAD } },
      ]);
    });

    it("gives none to an issue with none of those labels, or to a Spec", () => {
      const spec = anOpenIssue({ number: 5, labels: ["ready-for-agent"], subIssues: [6] });
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 31, labels: ["bug"] }), spec] }, { kit: null })).toEqual([]);
    });
  });
});
