import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { aComment, aLabelAdded, aVerdictComment, anOpenIssue, anOpenPullRequest, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import type { KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

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
        detail: { silence: "quiet-draft", round: null },
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

void aLabelAdded;
void anOpenIssue;
