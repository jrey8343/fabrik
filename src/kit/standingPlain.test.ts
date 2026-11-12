import { describe, expect, it } from "vitest";
import { aLabelAdded, anOpenIssue, anOpenPullRequest, aPlainPullRequest, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { GitHubFacts, RepoKitFacts, RequiredChecksFact } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "p".repeat(40);

/** Every read a test in this file made, with the Standings it gave, for the plain-data checks at the end. */
const produced: { readonly facts: StandingFacts; readonly now: string; readonly standings: readonly Standing[] }[] = [];

/** `owner/product`'s Kit config, the default, with these Required checks read on these heads. */
function kitWith(headChecks: Readonly<Record<string, RequiredChecksFact>>): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks };
}

/** Each listed check passed on the head. */
const PASSED: RequiredChecksFact = [
  { name: "test", is: "passed" },
  { name: "lint", is: "passed" },
];

function standingsIn(github: Partial<GitHubFacts>, kit: RepoKitFacts | null = kitWith({ [HEAD]: PASSED })): Standing[] {
  const facts = standingFactsOf({ github: factsOf(github), kit });
  const standings = standingsOf(facts, NOW);
  produced.push({ facts, now: NOW, standings });
  return standings;
}

describe("a Plain pull request's Standing", () => {
  it("is yours to merge for a Kit bump out of draft, merging cleanly, with every Required check passed: no place, never stopping work, never Stuck", () => {
    expect(standingsIn({ plainPullRequests: [aPlainPullRequest()] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: null,
        pullRequest: 70,
        work: "plain",
        place: null,
        name: "yours-to-merge",
        move: "operator",
        yours: true,
        stopsWork: false,
        since: "2026-11-06T20:00:00Z",
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { plain: "kit-bump" },
      },
    ]);
  });

  describe("its name", () => {
    const standingOf = (overrides: Parameters<typeof aPlainPullRequest>[0], checks: RequiredChecksFact = PASSED) =>
      standingsIn({ plainPullRequests: [aPlainPullRequest(overrides)] }, kitWith({ [HEAD]: checks }))[0];
    const named = (standing: Standing | undefined) =>
      standing === undefined ? undefined : { name: standing.name, move: standing.move, yours: standing.yours, stopsWork: standing.stopsWork, detail: standing.detail };

    it("is a draft, nobody's move, for a draft", () => {
      expect(named(standingOf({ draft: true }))).toEqual({ name: "draft", move: "nobody", yours: false, stopsWork: false, detail: { plain: "kit-bump" } });
    });

    it("conflicts, the Operator's, for one that cannot merge cleanly, and reads one GitHub hasn't worked out yet as merging cleanly", () => {
      expect(named(standingOf({ mergeable: false }))).toEqual({ name: "conflicts", move: "operator", yours: true, stopsWork: false, detail: { plain: "kit-bump" } });
      expect(standingOf({ mergeable: null })?.name).toBe("yours-to-merge");
    });

    it("is the Operator's, naming the first Required check failing", () => {
      const checks: RequiredChecksFact = [
        { name: "test", is: "passed" },
        { name: "lint", is: "failing" },
        { name: "types", is: "failing" },
      ];
      expect(named(standingOf({}, checks))).toEqual({
        name: "check-failing",
        move: "operator",
        yours: true,
        stopsWork: false,
        detail: { plain: "kit-bump", check: "lint", checkIs: "failing" },
      });
    });

    it("is waiting on checks, the Kit's, naming the first Required check still running", () => {
      const checks: RequiredChecksFact = [
        { name: "test", is: "running" },
        { name: "lint", is: "running" },
      ];
      expect(named(standingOf({}, checks))).toEqual({
        name: "waiting-on-checks",
        move: "kit",
        yours: false,
        stopsWork: false,
        detail: { plain: "kit-bump", check: "test", checksUnread: false },
      });
    });

    it("is the Operator's, naming the first Required check that has never reported on its head", () => {
      const checks: RequiredChecksFact = [
        { name: "test", is: "passed" },
        { name: "lint", is: "never-reported" },
      ];
      expect(named(standingOf({}, checks))).toEqual({
        name: "check-failing",
        move: "operator",
        yours: true,
        stopsWork: false,
        detail: { plain: "kit-bump", check: "lint", checkIs: "never-reported" },
      });
    });

    it("takes the first that holds: a draft that conflicts is a draft, a conflict beats a failing check, a failing check beats a running one, and a running one beats one never reported", () => {
      expect(standingOf({ draft: true, mergeable: false })?.name).toBe("draft");
      expect(standingOf({ mergeable: false }, [{ name: "test", is: "failing" }])?.name).toBe("conflicts");
      expect(standingOf({}, [{ name: "test", is: "running" }, { name: "lint", is: "failing" }])?.detail).toMatchObject({ check: "lint", checkIs: "failing" });
      expect(named(standingOf({}, [{ name: "test", is: "never-reported" }, { name: "lint", is: "running" }]))).toMatchObject({
        name: "waiting-on-checks",
        detail: { check: "lint" },
      });
    });

    it("is waiting on checks it could not read when the head's checks are unread, the repo's Kit wasn't read, or no check is listed", () => {
      const unread = { name: "waiting-on-checks", move: "kit", yours: false, stopsWork: false, detail: { plain: "kit-bump", check: null, checksUnread: true } };
      expect(named(standingOf({}, "unread"))).toEqual(unread);
      expect(named(standingsIn({ plainPullRequests: [aPlainPullRequest()] }, kitWith({}))[0])).toEqual(unread);
      expect(named(standingsIn({ plainPullRequests: [aPlainPullRequest()] }, null)[0])).toEqual(unread);
      expect(named(standingOf({}, []))).toEqual(unread);
    });

    it("never reads a check the Kit config doesn't list: what the gather leaves out of the fact names nothing", () => {
      expect(standingOf({}, [{ name: "test", is: "passed" }])?.name).toBe("yours-to-merge");
    });
  });

  it("stands since its head was committed, or since it was opened when that was later", () => {
    const sinceOf = (overrides: Parameters<typeof aPlainPullRequest>[0]) => standingsIn({ plainPullRequests: [aPlainPullRequest(overrides)] })[0]?.since;
    expect(sinceOf({ createdAt: "2026-11-01T00:00:00Z", headCommittedAt: "2026-11-07T09:00:00Z" })).toBe("2026-11-07T09:00:00Z");
    expect(sinceOf({ createdAt: "2026-11-07T00:00:00Z", headCommittedAt: "2026-11-01T09:00:00Z" })).toBe("2026-11-07T00:00:00Z");
    expect(sinceOf({ createdAt: "2026-11-07T00:00:00Z", headCommittedAt: null })).toBe("2026-11-07T00:00:00Z");
  });

  it("stands since it last left draft or went into it, when that came after its head and its opening", () => {
    const sinceOf = (overrides: Parameters<typeof aPlainPullRequest>[0]) => standingsIn({ plainPullRequests: [aPlainPullRequest({ headSha: HEAD, ...overrides })] })[0];
    const readied = sinceOf({ createdAt: "2026-11-01T00:00:00Z", headCommittedAt: "2026-11-02T09:00:00Z", draftChangedAt: "2026-11-08T19:00:00Z" });
    expect(readied).toMatchObject({ name: "yours-to-merge", since: "2026-11-08T19:00:00Z" });
    expect(sinceOf({ createdAt: "2026-11-01T00:00:00Z", headCommittedAt: "2026-11-07T09:00:00Z", draftChangedAt: "2026-11-02T00:00:00Z" })?.since).toBe("2026-11-07T09:00:00Z");
  });

  describe("a Pairing session's, joined to its issue", () => {
    const pairing = (overrides: Parameters<typeof aPlainPullRequest>[0] = {}) =>
      aPlainPullRequest({ number: 80, author: "operator", headRef: "fabrik/pair-12", closes: [12], createdAt: "2026-11-07T10:00:00Z", headCommittedAt: "2026-11-07T10:00:00Z", ...overrides });
    const handedOver = anOpenIssue({ number: 12, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-05T20:00:00Z")] });

    it("is the issue's own Standing while issue 12 is open and has one, carrying both numbers and the name the pull request would have had", () => {
      expect(standingsIn({ openIssues: [handedOver], plainPullRequests: [pairing({ draft: true })] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: 80,
          work: "ready-for-human",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-05T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: null, role: null, failure: null, label: null, pullRequest: "draft" },
        },
      ]);
    });

    it("takes yours to merge, with the mark off, once the pull request is ready", () => {
      expect(standingsIn({ openIssues: [handedOver], plainPullRequests: [pairing()] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: 80,
          work: "ready-for-human",
          place: null,
          name: "yours-to-merge",
          move: "operator",
          yours: true,
          stopsWork: false,
          since: "2026-11-07T10:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { plain: "pairing", pullRequest: "yours-to-merge" },
        },
      ]);
    });

    it("is the pull request's own Standing, carrying the issue's number, when issue 12 is open with no Standing of its own", () => {
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 12, labels: [] })], plainPullRequests: [pairing({ mergeable: false })] })).toEqual([
        expect.objectContaining({ issue: 12, pullRequest: 80, work: "plain", name: "conflicts", stopsWork: false, detail: { plain: "pairing" } }),
      ]);
    });

    it("is the issue's own Standing, carrying the pull request's number, when that Standing already carries the issue's open agent PR", () => {
      const standings = standingsIn({ openIssues: [handedOver], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 12, draft: false })], plainPullRequests: [pairing({ draft: true })] });
      expect(standings.filter(({ issue, pullRequest }) => issue === 12 || pullRequest === 80)).toEqual([
        expect.objectContaining({ issue: 12, pullRequest: 80, work: "ready-for-human", name: "yours-to-do", detail: { handBack: null, role: null, failure: null, label: null, pullRequest: "draft" } }),
      ]);
    });

    it("joins issue 12 when its body closes another issue first", () => {
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 12, labels: [] })], plainPullRequests: [pairing({ closes: [5, 12], mergeable: false })] })).toEqual([
        expect.objectContaining({ issue: 12, pullRequest: 80, work: "plain", name: "conflicts", detail: { plain: "pairing" } }),
      ]);
    });

    it("stands by itself when issue 12 is closed or missing", () => {
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 13, labels: ["ready-for-human"] })], plainPullRequests: [pairing()] })).toEqual([
        expect.objectContaining({ issue: 13, pullRequest: null, name: "yours-to-do" }),
        expect.objectContaining({ issue: null, pullRequest: 80, work: "plain", name: "yours-to-merge", detail: { plain: "pairing" } }),
      ]);
    });
  });

  describe("its kind", () => {
    const kindOf = (overrides: Parameters<typeof aPlainPullRequest>[0]) =>
      standingsIn({ plainPullRequests: [aPlainPullRequest({ ...overrides, headSha: HEAD })] }).map(({ detail }) => (detail as { plain?: unknown }).plain)[0];

    it("is a Kit bump for Dependabot's on its fabrik group's branch, and other for Dependabot's bump of anything else", () => {
      expect(kindOf({ author: "dependabot[bot]", headRef: "dependabot/github_actions/fabrik-42ad2e47fd" })).toBe("kit-bump");
      expect(kindOf({ author: "dependabot[bot]", headRef: "dependabot/github_actions/actions/checkout-4.2.0" })).toBe("other");
      expect(kindOf({ author: "dependabot[bot]", headRef: "dependabot/npm_and_yarn/fabrik-1a2b3c" })).toBe("other");
      expect(kindOf({ author: "operator", headRef: "dependabot/github_actions/fabrik-42ad2e47fd" })).toBe("other");
    });

    it("is Setup's for the Operator's on a setup or upgrade branch", () => {
      expect(kindOf({ author: "operator", headRef: "fabrik/setup-v3.1.0" })).toBe("setup");
      expect(kindOf({ author: "operator", headRef: "fabrik/upgrade-v4.0.0" })).toBe("setup");
      expect(kindOf({ author: "someone", headRef: "fabrik/setup-v3.1.0" })).toBe("other");
      expect(kindOf({ author: "operator", headRef: "fabrik/setup-main" })).toBe("other");
    });

    it("is a Skills bump for the Fabrik App's on a Skills source's bump branch", () => {
      expect(kindOf({ author: "fabrik-app[bot]", headRef: "fabrik/skills-bump/mattpocock-skills" })).toBe("skills-bump");
      expect(kindOf({ author: "operator", headRef: "fabrik/skills-bump/mattpocock-skills" })).toBe("other");
    });

    it("is a Pairing session's for the Operator's on a pair branch whose body closes the issue it names, whatever else it closes", () => {
      expect(kindOf({ author: "operator", headRef: "fabrik/pair-12", closes: [12] })).toBe("pairing");
      expect(kindOf({ author: "operator", headRef: "fabrik/pair-12", closes: [5, 12] })).toBe("pairing");
      expect(kindOf({ author: "operator", headRef: "fabrik/pair-12", closes: [13] })).toBe("other");
      expect(kindOf({ author: "operator", headRef: "fabrik/pair-12", closes: [] })).toBe("other");
      expect(kindOf({ author: "someone", headRef: "fabrik/pair-12", closes: [12] })).toBe("other");
    });

    it("is other for anyone else's", () => {
      expect(kindOf({ author: "operator", headRef: "fix-typo" })).toBe("other");
    });
  });
});

// After every test above: these read what they produced.
describe("a Plain pull request's Standing, whatever it is named", () => {
  const plain = () => produced.flatMap(({ standings }) => standings).filter(({ work }) => work === "plain");

  it("never stops work, never turns Stuck and has no place on the Loop", () => {
    expect(plain().length).toBeGreaterThan(0);
    for (const standing of plain()) expect(standing).toMatchObject({ stopsWork: false, stuckAt: null, place: null, awaits: null });
  });

  it("survives a JSON round trip unchanged, and is the same read a minute later", () => {
    for (const standing of plain()) expect(JSON.parse(JSON.stringify(standing))).toStrictEqual(standing);
    for (const { facts, now, standings } of produced) expect(standingsOf(facts, new Date(Date.parse(now) + 60 * 1000).toISOString())).toStrictEqual(standings);
  });
});
