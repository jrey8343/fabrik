import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aReview, aRunInFlight, aVerdictComment, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { conflictAttemptMarker } from "../loop/markers.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf } from "./standing.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit, on the default Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread", overrides: Partial<RepoKitFacts> = {}): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, ...overrides };
}

function standingsIn(github: Partial<GitHubFacts>, kit: RepoKitFacts | null): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit }), NOW);
}

const ticket = (number: number, labels: readonly string[] = ["ready-for-agent"]) => anOpenIssue({ number, labels });

describe("work that goes on without the Operator", () => {
  describe("running", () => {
    it("gives a Ticket with an Implement job in flight that names it one Standing, running at Implement, awaiting the Kit, since Actions created its run", () => {
      const standings = standingsIn({ openIssues: [ticket(7)] }, aKit([aRunInFlight({ issue: 7, createdAt: "2026-11-08T19:20:00Z" })]));
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: null,
          work: "ticket",
          place: "implement",
          name: "running",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: "2026-11-08T19:20:00Z",
          stuckAt: null,
          awaits: { role: "implement", on: "issue" },
          subscription: null,
          detail: { run: "implement", retry: null },
        },
      ]);
    });

    /** What tells one `running` Standing from another. */
    const runningIn = (standings: readonly Standing[]) =>
      standings.map((standing) => ({ issue: standing.issue, pullRequest: standing.pullRequest, name: standing.name, place: standing.place, awaits: standing.awaits, detail: standing.detail }));
    const HEAD = "h".repeat(40);

    it("gives a Retry the same, at Implement on the Ticket's agent PR, with the Retry's number", () => {
      const standings = standingsIn(
        { openIssues: [ticket(7)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, comments: [aVerdictComment("execution-flaw", HEAD, "2026-11-08T18:00:00Z")] })] },
        aKit([aRunInFlight({ issue: 7, retry: 1, kind: "retry" })]),
      );
      expect(runningIn(standings)).toEqual([
        { issue: 7, pullRequest: 50, name: "running", place: "implement", awaits: { role: "implement", on: "pullRequest" }, detail: { run: "retry", retry: 1 } },
      ]);
    });

    it("tells a Request-changes run and a conflict-only run on a Ticket's agent PR apart, where the PR's facts tell them", () => {
      const pass = aVerdictComment("pass", HEAD, "2026-11-07T18:00:00Z");
      const standings = standingsIn(
        {
          openIssues: [ticket(7), ticket(8)],
          openPullRequests: [
            anOpenPullRequest({ number: 50, ticket: 7, comments: [pass], reviews: [aReview("2026-11-08T08:00:00Z")] }),
            anOpenPullRequest({ number: 51, ticket: 8, comments: [pass, aComment(`${conflictAttemptMarker({ main: "c".repeat(40), outcome: "conflict-run" })}\nResolving.`, "2026-11-08T09:00:00Z")] }),
          ],
        },
        aKit([aRunInFlight({ issue: 7 }), aRunInFlight({ issue: 8 })]),
      );
      expect(runningIn(standings).map(({ issue, pullRequest, detail }) => ({ issue, pullRequest, detail }))).toEqual([
        { issue: 7, pullRequest: 50, detail: { run: "request-changes", retry: null } },
        { issue: 8, pullRequest: 51, detail: { run: "conflict-only", retry: null } },
      ]);
    });

    it("still counts an Implement job that's done while its run is landing it", () => {
      const standings = standingsIn({ openIssues: [ticket(7)] }, aKit([aRunInFlight({ issue: 7, job: "landing" })]));
      expect(standings.map(({ name }) => name)).toEqual(["running"]);
    });

    it("makes every research Decision whose agent:research is on, or the claim just took off, running on a Research job, and no Ticket or other Decision", () => {
      const decision = (number: number, overrides: Parameters<typeof anOpenIssue>[0] = {}) => anOpenIssue({ number, labels: ["wayfinder:research"], ...overrides });
      const claimedAt = "2026-11-08T18:30:00Z";
      const claim = aLabelAdded("agent:research", claimedAt, { action: "unlabeled" });
      const standings = standingsIn(
        {
          openIssues: [
            decision(30, { labels: ["wayfinder:research", "agent:research"] }),
            decision(31, { labelEvents: [aLabelAdded("agent:research", "2026-11-08T18:00:00Z"), claim] }),
            decision(32, { labelEvents: [aLabelAdded("agent:research", "2026-11-08T18:00:00Z"), claim], comments: [aComment("The Research run failed.", "2026-11-08T19:30:00Z")] }),
            decision(33, { labelEvents: [aLabelAdded("agent:research", "2026-11-08T18:00:00Z"), { ...claim, actor: "operator" }] }),
            decision(34),
            ticket(7, ["ready-for-agent", "agent:implement"]),
          ],
        },
        aKit([aRunInFlight({ role: "research" })]),
      );
      expect(runningIn(standings)).toEqual([
        { issue: 30, pullRequest: null, name: "running", place: null, awaits: { role: "research", on: "issue" }, detail: { run: "research", retry: null } },
        { issue: 31, pullRequest: null, name: "running", place: null, awaits: { role: "research", on: "issue" }, detail: { run: "research", retry: null } },
      ]);
    });

    it("counts an Implement job named for nothing, from an earlier release, for every Ticket waiting on Implement", () => {
      const standings = standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"]), ticket(8)] }, aKit([aRunInFlight()]));
      expect(runningIn(standings).map(({ issue, detail }) => ({ issue, detail }))).toEqual([{ issue: 7, detail: { run: "implement", retry: null } }]);
    });

    it("counts a Triage job for every issue waiting on Triage: needs-triage, or needs-info with an answer", () => {
      const asked = aLabelAdded("needs-info", "2026-11-07T18:00:00Z");
      const standings = standingsIn(
        {
          openIssues: [
            anOpenIssue({ number: 12, labels: ["needs-triage"] }),
            anOpenIssue({ number: 13, labels: ["needs-info"], labelEvents: [asked], comments: [aComment("It happens on Safari.", "2026-11-08T10:00:00Z", { author: "someone", byBot: false })] }),
            anOpenIssue({ number: 14, labels: ["needs-info"], labelEvents: [asked] }),
          ],
        },
        aKit([aRunInFlight({ role: "triage" })]),
      );
      expect(runningIn(standings)).toEqual([
        { issue: 12, pullRequest: null, name: "running", place: "triage", awaits: { role: "triage", on: "issue" }, detail: { run: "triage", retry: null } },
        { issue: 13, pullRequest: null, name: "running", place: "triage", awaits: { role: "triage", on: "issue" }, detail: { run: "triage", retry: null } },
      ]);
    });

    it("gives an agent PR a Review job names running at Review, on the PR, with its Ticket, and a Design-session or prototype turn running at Design", () => {
      const standings = standingsIn(
        { openIssues: [ticket(7), anOpenIssue({ number: 20, labels: ["needs-design"] }), anOpenIssue({ number: 21, labels: ["needs-design"] })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] },
        aKit([aRunInFlight({ role: "review", pullRequest: 50 }), aRunInFlight({ role: "design", issue: 20 }), aRunInFlight({ role: "design", issue: 21, kind: "prototype" })]),
      );
      expect(runningIn(standings)).toEqual([
        { issue: 7, pullRequest: 50, name: "running", place: "review", awaits: { role: "review", on: "pullRequest" }, detail: { run: "review", retry: null } },
        { issue: 20, pullRequest: null, name: "running", place: "design", awaits: { role: "design", on: "issue" }, detail: { run: "design", retry: null } },
        { issue: 21, pullRequest: null, name: "running", place: "design", awaits: { role: "design", on: "issue" }, detail: { run: "prototype", retry: null } },
      ]);
    });

    describe("waiting on checks", () => {
      const checks = aRunInFlight({ role: "review", job: "waiting-on-checks", createdAt: "2026-11-08T19:40:00Z" });

      it("gives an agent draft with no Verdict on its head, while a Review's wait for checks is in flight, waiting on checks at Review", () => {
        const standings = standingsIn({ openIssues: [ticket(7)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }, aKit([checks]));
        expect(standings).toEqual([
          {
            schema: 1,
            repo: "owner/product",
            issue: 7,
            pullRequest: 50,
            work: "ticket",
            place: "review",
            name: "waiting-on-checks",
            move: "kit",
            yours: false,
            stopsWork: false,
            since: "2026-11-08T19:40:00Z",
            stuckAt: null,
            awaits: { role: "review", on: "pullRequest" },
            subscription: null,
            detail: { plain: null, check: null, checksUnread: false },
          },
        ]);
      });

      it("makes a draft a Review job names running instead, and leaves alone one with a Verdict on its head or out of draft", () => {
        const standings = standingsIn(
          {
            openPullRequests: [
              anOpenPullRequest({ number: 50, ticket: 7 }),
              anOpenPullRequest({ number: 51, ticket: 8, comments: [aVerdictComment("execution-flaw", HEAD, "2026-11-08T18:00:00Z")] }),
              anOpenPullRequest({ number: 52, ticket: 9, draft: false }),
              anOpenPullRequest({ number: 53, ticket: 10 }),
            ],
          },
          aKit([checks, aRunInFlight({ role: "review", pullRequest: 50 })]),
        );
        expect(standings.map(({ pullRequest, name }) => ({ pullRequest, name }))).toEqual([
          { pullRequest: 50, name: "running" },
          { pullRequest: 53, name: "waiting-on-checks" },
        ]);
      });

      it("gives no draft waiting on checks with no wait for checks in flight", () => {
        expect(standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }, aKit([aRunInFlight({ role: "triage" })]))).toEqual([]);
      });
    });

    it("gives nothing running with the runs unread, or no Kit read", () => {
      expect(standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"])] }, aKit("unread"))).toEqual([]);
      expect(standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"])] }, null)).toEqual([]);
    });
  });
});
