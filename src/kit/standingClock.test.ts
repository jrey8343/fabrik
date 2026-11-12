import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { aComment, aCommit, aLabelAdded, anOpenIssue, anOpenPullRequest, aReview, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import type { KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit at this Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread" = [], config: KitConfig = DEFAULT_KIT_CONFIG): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight };
}

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit: aKit(), ...overrides }), now);
}

/** Ticket 7, ready for an agent, with `agent:implement` added at `at`. */
const askedFor = (at: string, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
  anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", at)], ...overrides });

describe("a run that was asked for and never began", () => {
  it("gives a Ticket whose agent:implement was added 40 minutes ago, with no Implement run in flight, not-started, the Kit's, turning Stuck 210 minutes after the label", () => {
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: null,
        work: "ticket",
        place: "implement",
        name: "not-started",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: "2026-11-08T19:20:00Z",
        stuckAt: "2026-11-08T22:50:00.000Z",
        awaits: { role: "implement", on: "issue" },
        subscription: null,
        detail: { silence: "trigger-label", label: "agent:implement" },
      },
    ]);
  });

  it("reads the same facts a minute before the bar as not-started, and a minute after as stuck, the Operator's and stopping work, keeping its since and the name it had", () => {
    const issue = askedFor("2026-11-08T19:20:00Z");
    const [before] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:49:00Z");
    const [after] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:51:00Z");
    expect(before).toMatchObject({ name: "not-started", move: "kit", yours: false, stopsWork: false });
    expect(after).toEqual({
      ...before,
      name: "stuck",
      yours: true,
      stopsWork: true,
      detail: { was: "not-started", silence: "trigger-label", label: "agent:implement" },
    });
  });

  it("counts the repo's own bar: with the Implement role's timeout raised to 120, Stuck comes 270 minutes after the label", () => {
    const config = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, implement: { ...DEFAULT_KIT_CONFIG.roles.implement, timeoutMinutes: 120 } } });
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit: aKit([], config) })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T23:50:00.000Z" }]);
  });

  it("reads a repo whose Kit config is invalid on the Kit's default timeouts", () => {
    const kit: RepoKitFacts = { ...aKit([]), config: { ok: false, errors: ["roles.implement.timeoutMinutes: not a number"] } };
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T22:50:00.000Z" }]);
  });

  describe("the clock", () => {
    const LABELLED = "2026-11-08T19:20:00Z";
    const LATER = "2026-11-08T19:50:00Z";
    /** Ticket 7 asked for at LABELLED, with its agent draft #50 open, and these facts on either. */
    const withSigns = ({ issue = {}, pullRequest = {}, ...overrides }: { issue?: Parameters<typeof anOpenIssue>[0]; pullRequest?: Parameters<typeof anOpenPullRequest>[0] } & Partial<Omit<StandingFacts, "kind" | "github">>) =>
      standingsIn({ openIssues: [askedFor(LABELLED, issue)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, createdAt: "2026-11-08T12:00:00Z", ...pullRequest })] }, overrides);
    const issueLabels = [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", LABELLED)];

    it("starts when the label was last added, whoever added it", () => {
      const byOperator = [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", LABELLED, { actor: "operator" })];
      expect(withSigns({ issue: { labelEvents: byOperator } })).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });

    it.each([
      ["a person's comment on the issue", { issue: { comments: [aComment("Any news?", LATER, { author: "operator", byBot: false })] } }],
      ["a person's comment on its pull request", { pullRequest: { comments: [aComment("Any news?", LATER, { author: "operator", byBot: false })] } }],
      ["another bot's comment", { issue: { comments: [aComment("Beep.", LATER, { author: "dependabot[bot]" })] } }],
      ["a label a person adds elsewhere on the issue", { issue: { labelEvents: [...issueLabels, aLabelAdded("priority", LATER, { actor: "operator" })] } }],
      ["a label a person takes off its pull request", { pullRequest: { labelEvents: [aLabelAdded("priority", LATER, { action: "unlabeled", actor: "operator" })] } }],
      ["a review", { pullRequest: { reviews: [aReview(LATER, { state: "commented" })] } }],
      ["a person's push", { pullRequest: { commits: [{ at: LATER }] } }],
      ["a person taking the pull request out of draft", { pullRequest: { draftEvents: [{ kind: "ready", actor: "operator", at: LATER }] } }],
      ["a run ending on other work", { runsEnded: [{ issue: 8, pullRequest: null, role: "implement", at: LATER }] }],
    ] as const)("leaves stuckAt where it was after %s", (_, overrides) => {
      expect(withSigns(overrides)).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });

    it.each([
      ["a comment the Fabrik App posts on the issue", { issue: { comments: [aComment("Noted.", LATER)] } }],
      ["a comment the Fabrik App posts on its pull request", { pullRequest: { comments: [aComment("Noted.", LATER)] } }],
      ["a label the Fabrik App adds elsewhere on the issue", { issue: { labelEvents: [...issueLabels, aLabelAdded("fabrik:step-up", LATER)] } }],
      ["a label the Fabrik App takes off its pull request", { pullRequest: { labelEvents: [aLabelAdded("agent:review", LATER, { action: "unlabeled" })] } }],
      ["a commit the Fabrik App pushes to its branch", { pullRequest: { commits: [{ at: LATER, byApp: true }] } }],
      ["the Fabrik App taking the pull request into draft", { pullRequest: { draftEvents: [{ kind: "draft", actor: "fabrik-app[bot]", at: LATER }] } }],
      ["the Fabrik App taking the pull request out of draft", { pullRequest: { draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: LATER }] } }],
      ["a run on the Ticket ending", { runsEnded: [{ issue: 7, pullRequest: null, role: "implement", at: LATER }] }],
      ["a run on its pull request ending", { runsEnded: [{ issue: null, pullRequest: 50, role: "review", at: LATER }] }],
    ] as const)("restarts after %s, keeping since", (_, overrides) => {
      expect(withSigns(overrides)).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T23:20:00.000Z" }]);
    });

    it("never runs back for a sign from before the label", () => {
      expect(withSigns({ issue: { comments: [aComment("Earlier.", "2026-11-08T18:00:00Z")] } })).toMatchObject([{ stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });
  });
});
