import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { aDesignQueueIssue, aResearchDecision, aTicket } from "../__fixtures__/snapshots.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aReview, aRunInFlight, aVerdictComment, aWeeklyLimitIssue, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import type { HeldRun } from "../loop/heldRun.ts";
import { conflictAttemptMarker } from "../loop/markers.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf } from "./standing.ts";
import { wordStanding } from "./standingWording.ts";
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
      expect(runningIn(standings.filter(({ name }) => name === "running"))).toEqual([
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
              // A pass, since an Execution flaw on a draft announces a Retry, a not-started Standing of its own (#607).
              anOpenPullRequest({ number: 51, ticket: 8, comments: [aVerdictComment("pass", HEAD, "2026-11-08T18:00:00Z")] }),
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

    describe("held", () => {
      const implement = { role: "implement", issue: 7, label: "agent:implement" } as const;
      const carrier = (held: readonly HeldRun[]) => aWeeklyLimitIssue(null, held, { createdAt: "2026-11-08T09:00:00Z", commentedAt: held.map(() => "2026-11-08T10:00:00Z") });

      it("gives a Ticket a held marker names one Standing, held at Implement with its Carrier, since the marker", () => {
        const standings = standingsIn({ openIssues: [ticket(7)], kitIssues: [carrier([implement])] }, null);
        expect(standings).toEqual([
          {
            schema: 1,
            repo: "owner/product",
            issue: 7,
            pullRequest: null,
            work: "ticket",
            place: "implement",
            name: "held",
            move: "kit",
            yours: false,
            stopsWork: false,
            since: "2026-11-08T10:00:00Z",
            stuckAt: null,
            awaits: { role: "implement", on: "issue" },
            subscription: null,
            detail: { carrier: 20, role: "implement" },
          },
        ]);
      });

      it("gives a held Review its agent PR and Ticket, at Review, awaiting a run on the PR", () => {
        const standings = standingsIn(
          { openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8, draft: false })], kitIssues: [carrier([{ role: "review", issue: 51, label: "agent:review" }])] },
          null,
        );
        expect(standings.map(({ issue, pullRequest, name, place, awaits, detail }) => ({ issue, pullRequest, name, place, awaits, detail }))).toEqual([
          { issue: 8, pullRequest: 51, name: "held", place: "review", awaits: { role: "review", on: "pullRequest" }, detail: { carrier: 20, role: "review" } },
        ]);
      });

      it("keeps a held Ticket held whatever else is true of it, a run named for nothing included, short of a move of the Operator's", () => {
        const heldTicket = ticket(7, ["ready-for-agent", "agent:implement"]);
        const standings = standingsIn(
          { openIssues: [heldTicket, anOpenIssue({ number: 8, labels: ["ready-for-agent", "ready-for-human"] })], kitIssues: [carrier([implement, { ...implement, issue: 8 }])] },
          aKit([aRunInFlight()], { dispatch: { candidates: { tickets: [aTicket({ number: 7, labels: ["ready-for-agent"], openBlockers: [3] })], researchDecisions: [] } } }),
        );
        expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([
          { issue: 8, name: "yours-to-do" },
          { issue: 7, name: "held" },
        ]);
      });

      it("leaves out a run the scheduled tick has resumed", () => {
        const resumed = carrier([implement]);
        const standings = standingsIn(
          { openIssues: [ticket(7)], kitIssues: [{ ...resumed, comments: [...resumed.comments, '<!-- fabrik:resumed {"issue":7,"role":"implement","held":1} -->'] }] },
          null,
        );
        expect(standings).toEqual([]);
      });
    });

    it("gives nothing running with the runs unread, or no Kit read", () => {
      expect(standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"])] }, aKit("unread"))).toEqual([]);
      expect(standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"])] }, null)).toEqual([]);
    });

    it("still gives the rest with the runs unread", () => {
      const standings = standingsIn(
        {
          openIssues: [ticket(7, ["ready-for-agent", "agent:implement"]), ticket(8), ticket(9), anOpenIssue({ number: 13, labels: ["ready-for-human"] })],
          kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 8, label: "agent:implement" }])],
        },
        aKit("unread", { dispatch: { candidates: { tickets: [aTicket({ number: 9, openBlockers: [3] })], researchDecisions: [] } } }),
      );
      expect(standings.map(({ issue, name }) => ({ issue, name })).toSorted((a, b) => (a.issue ?? 0) - (b.issue ?? 0))).toEqual([
        { issue: 8, name: "held" },
        { issue: 9, name: "blocked" },
        { issue: 13, name: "yours-to-do" },
      ]);
    });
  });

  const readyAt = "2026-11-05T12:00:00Z";
  const ready = (number: number) => anOpenIssue({ number, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", readyAt)] });
  const dispatching = (tickets: Parameters<typeof aTicket>[0][], overrides: Partial<RepoKitFacts> = {}, runs: readonly RunInFlightFact[] = []) =>
    aKit(runs, { dispatch: { candidates: { tickets: tickets.map((t) => aTicket(t)), researchDecisions: [] } }, ...overrides });
  const withMaxInFlight = (maxInFlight: number) => ({ config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, maxInFlight } } }) as const;

  describe("waiting for a slot", () => {
    it("gives a Ticket Dispatch would release, while max_in_flight is full, one Standing waiting for a slot at Implement, since it got ready-for-agent", () => {
      const standings = standingsIn(
        { openIssues: [ready(14)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 11 })] },
        dispatching([{ number: 14 }], {}, [aRunInFlight({ issue: 12 })]),
      );
      expect(standings.filter(({ issue }) => issue === 14)).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 14,
          pullRequest: null,
          work: "ticket",
          place: "implement",
          name: "waiting-for-slot",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: readyAt,
          stuckAt: null,
          awaits: { role: "implement", on: "issue" },
          subscription: null,
          detail: { slot: "max-in-flight", maxInFlight: 2 },
        },
      ]);
    });

    it("gives the same with Dispatch paused at 0, and a research Decision too, since it got wayfinder:research, with no place", () => {
      const decision = anOpenIssue({ number: 16, labels: ["wayfinder:research"], labelEvents: [aLabelAdded("wayfinder:research", "2026-11-06T12:00:00Z")] });
      const standings = standingsIn(
        { openIssues: [ready(14), decision] },
        aKit([], { ...withMaxInFlight(0), dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [aResearchDecision({ number: 16 })] } } }),
      );
      expect(standings.map(({ issue, work, place, name, since, awaits, detail }) => ({ issue, work, place, name, since, awaits, detail }))).toEqual([
        { issue: 14, work: "ticket", place: "implement", name: "waiting-for-slot", since: readyAt, awaits: { role: "implement", on: "issue" }, detail: { slot: "max-in-flight", maxInFlight: 0 } },
        {
          issue: 16,
          work: "research-decision",
          place: null,
          name: "waiting-for-slot",
          since: "2026-11-06T12:00:00Z",
          awaits: { role: "research", on: "issue" },
          detail: { slot: "max-in-flight", maxInFlight: 0 },
        },
      ]);
    });

    it("gives a releasable Ticket none while a slot is free, and one Dispatch wouldn't release none", () => {
      expect(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], withMaxInFlight(3), [aRunInFlight({ issue: 12 })]))).toEqual([]);
      expect(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14, lastRunFailed: true }], withMaxInFlight(0)))).toEqual([]);
    });

    it("counts max_in_flight full with the runs unread, as Held does", () => {
      const standings = standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], { runsInFlight: "unread" }));
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([{ issue: 14, name: "waiting-for-slot" }]);
    });

    it("gives a needs-design issue with no Design session slot free one waiting for a slot at Design, since it got needs-design, and none to one holding a slot", () => {
      const standings = standingsIn(
        {
          designQueue: {
            issues: [aDesignQueueIssue({ number: 21, neededDesignAt: "2026-11-06T09:00:00Z" }), aDesignQueueIssue({ number: 22, designRounds: 1 })],
            designTurnsInProgress: [],
          },
        },
        null,
      );
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 21,
          pullRequest: null,
          work: "design-session",
          place: "design",
          name: "waiting-for-slot",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: "2026-11-06T09:00:00Z",
          stuckAt: null,
          awaits: { role: "design", on: "issue" },
          subscription: null,
          detail: { slot: "design-session", maxInFlight: null },
        },
      ]);
    });
  });

  describe("blocked", () => {
    it("gives a ready-for-agent Ticket with open blockers one Standing, blocked, the move nobody's, naming its blockers", () => {
      const standings = standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14, openBlockers: [9, 3] }]));
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 14,
          pullRequest: null,
          work: "ticket",
          place: "implement",
          name: "blocked",
          move: "nobody",
          yours: false,
          stopsWork: false,
          since: readyAt,
          stuckAt: null,
          awaits: { role: "implement", on: "issue" },
          subscription: null,
          detail: { blockers: [3, 9] },
        },
      ]);
    });

    it("blocks a Ticket on a blocker closed as not planned, and a research Decision on an open blocker", () => {
      const decision = anOpenIssue({ number: 16, labels: ["wayfinder:research"], labelEvents: [aLabelAdded("wayfinder:research", readyAt)] });
      const standings = standingsIn(
        { openIssues: [ready(14), decision] },
        aKit([], { dispatch: { candidates: { tickets: [aTicket({ number: 14, notPlannedBlockers: [5] })], researchDecisions: [aResearchDecision({ number: 16, openBlockers: [4] })] } } }),
      );
      expect(standings.map(({ issue, work, name, move, detail }) => ({ issue, work, name, move, detail }))).toEqual([
        { issue: 14, work: "ticket", name: "blocked", move: "nobody", detail: { blockers: [5] } },
        { issue: 16, work: "research-decision", name: "blocked", move: "nobody", detail: { blockers: [4] } },
      ]);
    });

    it("gives a Ticket with no open blocker none", () => {
      expect(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], withMaxInFlight(3)))).toEqual([]);
    });
  });

  describe("a Spec", () => {
    it("gives an open issue labelled ready-for-agent with sub-issues no Standing; its Tickets have their own", () => {
      const spec = anOpenIssue({ number: 3, labels: ["ready-for-agent", "agent:implement"], subIssues: [14], labelEvents: [aLabelAdded("ready-for-agent", readyAt)] });
      const standings = standingsIn(
        { openIssues: [spec, ready(14)], kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 3, label: "agent:implement" }])] },
        dispatching([{ number: 3, subIssues: 1, openBlockers: [2] }, { number: 14, openBlockers: [2] }], {}, [aRunInFlight()]),
      );
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([{ issue: 14, name: "blocked" }]);
    });
  });

  describe("their wording", () => {
    const ZONE = "Australia/Sydney";
    const words = (standings: readonly Standing[], issue: number) => {
      const standing = standings.find((read) => read.issue === issue);
      if (standing === undefined) throw new Error(`no Standing for #${issue}`);
      return wordStanding(standing, NOW, ZONE);
    };

    it("says which run is running, and for how long", () => {
      const pass = aVerdictComment("pass", "h".repeat(40), "2026-11-07T18:00:00Z");
      const standings = standingsIn(
        {
          openIssues: [ticket(7), ticket(8), ticket(9), anOpenIssue({ number: 12, labels: ["needs-triage"] })],
          openPullRequests: [anOpenPullRequest({ number: 50, ticket: 8, comments: [pass], reviews: [aReview("2026-11-08T08:00:00Z")] }), anOpenPullRequest({ number: 51, ticket: 10 })],
        },
        aKit([
          aRunInFlight({ issue: 7, createdAt: "2026-11-08T19:20:00Z" }),
          aRunInFlight({ issue: 9, retry: 1, kind: "retry", createdAt: "2026-11-08T17:00:00Z" }),
          aRunInFlight({ issue: 8 }),
          aRunInFlight({ role: "review", pullRequest: 51 }),
          aRunInFlight({ role: "triage" }),
        ]),
      );
      expect(words(standings, 7)).toEqual({ pill: "Running", sentence: "An Implement run has been running for 40 minutes.", remedy: null });
      expect(words(standings, 9).sentence).toBe("Retry 1 has been running for 3 hours.");
      expect(words(standings, 8).sentence).toBe("A Request-changes run has been running for 1 hour.");
      expect(words(standings, 10).sentence).toBe("A Review has been running for 1 hour.");
      expect(words(standings, 12).sentence).toBe("A Triage run has been running for 1 hour.");
    });

    it("says a draft's Review is waiting for the Required checks on its head", () => {
      const standings = standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }, aKit([aRunInFlight({ role: "review", job: "waiting-on-checks" })]));
      expect(words(standings, 7)).toEqual({ pill: "Waiting on checks", sentence: "Its Review is waiting for the Required checks on its head.", remedy: null });
    });

    it("says which run is held, and on which Carrier", () => {
      const standings = standingsIn({ openIssues: [ticket(7)], kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 7, label: "agent:implement" }])] }, null);
      expect(words(standings, 7)).toEqual({ pill: "Held", sentence: "Its Implement run is held on #20 until a Subscription is free.", remedy: null });
    });

    it("says what slot work waits for, and how long it has", () => {
      const full = standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], { runsInFlight: "unread" }));
      expect(words(full, 14)).toEqual({ pill: "Waiting for a slot", sentence: "Waiting for a slot for 3 days: `max_in_flight` is 2.", remedy: null });
      const paused = standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], withMaxInFlight(0)));
      expect(words(paused, 14).sentence).toBe("Dispatch is paused: `max_in_flight` is 0.");
      const design = standingsIn({ designQueue: { issues: [aDesignQueueIssue({ number: 21, neededDesignAt: "2026-11-06T20:00:00Z" })], designTurnsInProgress: [] } }, null);
      expect(words(design, 21).sentence).toBe("Waiting for a Design session slot for 2 days.");
    });

    it("names the blockers", () => {
      const standings = standingsIn({ openIssues: [ready(14), ready(15)] }, dispatching([{ number: 14, openBlockers: [9, 3] }, { number: 15, openBlockers: [4] }]));
      expect(words(standings, 14)).toEqual({ pill: "Blocked", sentence: "Blocked by #3 and #9.", remedy: null });
      expect(words(standings, 15).sentence).toBe("Blocked by #4.");
    });
  });
});
