import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { aDesignQueueIssue, aResearchDecision, aTicket, AUDITED_SHA, auditBody, RETRO_WINDOW_END, retroBody } from "../__fixtures__/snapshots.ts";
import {
  aComment,
  aLabelAdded,
  anOpenIssue,
  anOpenPullRequest,
  aReview,
  aRunInFlight,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  standingFactsOf,
} from "../read/builders.ts";
import type { HeldRun } from "../loop/heldRun.ts";
import { conflictAttemptMarker } from "../loop/markers.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf } from "./standing.ts";
import { wordStanding } from "./standingWording.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit, on the default Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread", overrides: Partial<RepoKitFacts> = {}): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {}, ...overrides };
}

/** The Standings of these facts, but the silences that wait on the Kit (#608), which src/kit/standingSilence.test.ts holds. */
function standingsIn(github: Partial<GitHubFacts>, kit: RepoKitFacts | null): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit }), NOW).filter(
    (standing) => standing.name !== "waiting-on-kit" && !(standing.name === "stuck" && standing.detail.was === "waiting-on-kit"),
  );
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
          detail: { run: "implement", retry: null, actionsRun: 1 },
        },
      ]);
    });

    it("takes its time from its run, when its agent job got a runner, and carries the Actions run (#621)", () => {
      const standings = standingsIn(
        { openIssues: [ticket(7)] },
        aKit([aRunInFlight({ issue: 7, run: 4410, createdAt: "2026-11-08T19:20:00Z", startedAt: "2026-11-08T19:31:00Z" })]),
      );
      expect(standings.map(({ name, since, detail }) => ({ name, since, detail }))).toEqual([
        { name: "running", since: "2026-11-08T19:31:00Z", detail: { run: "implement", retry: null, actionsRun: 4410 } },
      ]);
    });

    it("takes an exact run's kind from the run itself (#621)", () => {
      const standings = standingsIn(
        { openIssues: [ticket(7)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] },
        aKit([aRunInFlight({ issue: 7, pullRequest: 50, exact: true, kind: "request-changes" })]),
      );
      expect(standings.map(({ name, pullRequest, awaits, detail }) => ({ name, pullRequest, awaits, run: "run" in detail ? detail.run : null }))).toEqual([
        { name: "running", pullRequest: 50, awaits: { role: "implement", on: "pullRequest" }, run: "request-changes" },
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
        { issue: 7, pullRequest: 50, name: "running", place: "implement", awaits: { role: "implement", on: "pullRequest" }, detail: { run: "retry", retry: 1, actionsRun: 1, head: HEAD } },
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
        { issue: 7, pullRequest: 50, detail: { run: "request-changes", retry: null, actionsRun: 1, head: HEAD } },
        { issue: 8, pullRequest: 51, detail: { run: "conflict-only", retry: null, actionsRun: 1, head: HEAD } },
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
        { issue: 30, pullRequest: null, name: "running", place: null, awaits: { role: "research", on: "issue" }, detail: { run: "research", retry: null, actionsRun: 1 } },
        { issue: 31, pullRequest: null, name: "running", place: null, awaits: { role: "research", on: "issue" }, detail: { run: "research", retry: null, actionsRun: 1 } },
      ]);
    });

    it("counts an Implement job named for nothing, from an earlier release, for every Ticket waiting on Implement", () => {
      const standings = standingsIn({ openIssues: [ticket(7, ["ready-for-agent", "agent:implement"]), ticket(8)] }, aKit([aRunInFlight()]));
      expect(runningIn(standings).map(({ issue, detail }) => ({ issue, detail }))).toEqual([{ issue: 7, detail: { run: "implement", retry: null, actionsRun: 1 } }]);
    });

    describe("an exact run, from the Kit job's closing line (#617)", () => {
      it("counts only for the work it names: a Triage run for its issue, not every issue waiting on Triage", () => {
        const standings = standingsIn(
          { openIssues: [anOpenIssue({ number: 12, labels: ["needs-triage"] }), anOpenIssue({ number: 13, labels: ["needs-triage"] })] },
          aKit([aRunInFlight({ role: "triage", issue: 13, exact: true })]),
        );
        expect(runningIn(standings.filter(({ name }) => name === "running")).map(({ issue, detail }) => ({ issue, detail }))).toEqual([{ issue: 13, detail: { run: "triage", retry: null, actionsRun: 1 } }]);
      });

      it("counts a Research run for the Decision it names, and a Review run for its pull request alone", () => {
        const decision = (number: number) => anOpenIssue({ number, labels: ["wayfinder:research", "agent:research"] });
        const standings = standingsIn(
          { openIssues: [decision(30), decision(31), ticket(7)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 }), anOpenPullRequest({ number: 51, ticket: 8 })] },
          aKit([aRunInFlight({ role: "research", issue: 31, exact: true }), aRunInFlight({ role: "review", issue: 7, pullRequest: 50, exact: true })]),
        );
        expect(runningIn(standings.filter(({ name }) => name === "running")).map(({ issue, pullRequest }) => ({ issue, pullRequest }))).toEqual([
          { issue: 7, pullRequest: 50 },
          { issue: 31, pullRequest: null },
        ]);
      });

      it("counts for no work when it names none", () => {
        const standings = standingsIn({ openIssues: [anOpenIssue({ number: 12, labels: ["needs-triage"] }), ticket(7, ["ready-for-agent", "agent:implement"])] }, aKit([aRunInFlight({ role: "triage", exact: true }), aRunInFlight({ exact: true })]));
        expect(standings.filter(({ name }) => name === "running")).toEqual([]);
      });
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
        { issue: 12, pullRequest: null, name: "running", place: "triage", awaits: { role: "triage", on: "issue" }, detail: { run: "triage", retry: null, actionsRun: 1 } },
        { issue: 13, pullRequest: null, name: "running", place: "triage", awaits: { role: "triage", on: "issue" }, detail: { run: "triage", retry: null, actionsRun: 1 } },
      ]);
    });

    it("gives an agent PR a Review job names running at Review, on the PR, with its Ticket, and a Design-session or prototype turn running at Design", () => {
      const standings = standingsIn(
        { openIssues: [ticket(7), anOpenIssue({ number: 20, labels: ["needs-design"] }), anOpenIssue({ number: 21, labels: ["needs-design"] })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] },
        aKit([aRunInFlight({ role: "review", pullRequest: 50 }), aRunInFlight({ role: "design", issue: 20 }), aRunInFlight({ role: "design", issue: 21, kind: "prototype" })]),
      );
      expect(runningIn(standings)).toEqual([
        { issue: 7, pullRequest: 50, name: "running", place: "review", awaits: { role: "review", on: "pullRequest" }, detail: { run: "review", retry: null, actionsRun: 1, head: "h".repeat(40) } },
        { issue: 20, pullRequest: null, name: "running", place: "design", awaits: { role: "design", on: "issue" }, detail: { run: "design", retry: null, actionsRun: 1 } },
        { issue: 21, pullRequest: null, name: "running", place: "design", awaits: { role: "design", on: "issue" }, detail: { run: "prototype", retry: null, actionsRun: 1 } },
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
            detail: { plain: null, check: null, checksUnread: false, head: "h".repeat(40) },
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
        // The others wait on the Kit (#608).
        expect(standings.filter(({ name }) => name !== "waiting-on-kit").map(({ pullRequest, name }) => ({ pullRequest, name }))).toEqual([
          { pullRequest: 50, name: "running" },
          { pullRequest: 53, name: "waiting-on-checks" },
        ]);
      });

      it("counts an exact wait for checks only for the pull request its closing line names (#617)", () => {
        const exact = aRunInFlight({ role: "review", job: "waiting-on-checks", exact: true, issue: 7, pullRequest: 50, createdAt: "2026-11-08T19:40:00Z" });
        const standings = standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 }), anOpenPullRequest({ number: 51, ticket: 8 })] }, aKit([exact]));

        expect(standings.filter(({ name }) => name !== "waiting-on-kit").map(({ pullRequest, name, since }) => ({ pullRequest, name, since }))).toEqual([
          { pullRequest: 50, name: "waiting-on-checks", since: "2026-11-08T19:40:00Z" },
        ]);
      });

      it("gives no draft waiting on checks with no wait for checks in flight", () => {
        expect(standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }, aKit([aRunInFlight({ role: "triage" })])).filter(({ name }) => name === "waiting-on-checks")).toEqual([]);
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
          { issue: 8, pullRequest: 51, name: "held", place: "review", awaits: { role: "review", on: "pullRequest" }, detail: { carrier: 20, role: "review", head: "h".repeat(40) } },
        ]);
      });

      it("keeps an agent draft whose Review is held held while another Review's wait for checks is in flight", () => {
        const standings = standingsIn(
          { openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })], kitIssues: [carrier([{ role: "review", issue: 51, label: "agent:review" }])] },
          aKit([aRunInFlight({ role: "review", job: "waiting-on-checks", createdAt: "2026-11-08T19:40:00Z" })]),
        );
        expect(standings.map(({ issue, pullRequest, name }) => ({ issue, pullRequest, name }))).toEqual([{ issue: 8, pullRequest: 51, name: "held" }]);
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

    // Two failed runs in a week hold the next Audit or Retro back until the weekly gate's next week (#443).
    describe("a given-up Audit or Retro week", () => {
      const APP = "fabrik-app[bot]";
      const run = (number: number, name: "Audit" | "Retro", createdAt: string, body: string, author = APP) => ({ number, title: `${name}: week of 2026-11-02`, author, createdAt, body });
      const failedAudit = (number: number, createdAt: string, author = APP) => run(number, "Audit", createdAt, auditBody(AUDITED_SHA, "failed"), author);
      const failedRetro = (number: number, createdAt: string) => run(number, "Retro", createdAt, retroBody(RETRO_WINDOW_END, "failed"));
      const givenUpIn = (github: Partial<GitHubFacts>, now = NOW) => standingsOf(standingFactsOf({ github: factsOf(github) }), now);

      it("gives the week one Standing, held, the Kit's, naming its last failed Audit, though closed, from that failure until the gate's next week begins", () => {
        const standings = givenUpIn({ audits: [failedAudit(96, "2026-11-08T02:05:00Z"), failedAudit(95, "2026-11-08T00:05:00Z"), run(90, "Audit", "2026-11-01T00:05:00Z", auditBody(AUDITED_SHA))] });
        expect(standings).toEqual([
          {
            schema: 1,
            repo: "owner/product",
            issue: 96,
            pullRequest: null,
            work: "audit",
            place: null,
            name: "held",
            move: "kit",
            yours: false,
            stopsWork: false,
            since: "2026-11-08T02:05:00Z",
            stuckAt: null,
            awaits: null,
            subscription: null,
            detail: { carrier: null, role: "audit", failed: [95, 96], until: "2026-11-09T00:00:00.000Z" },
          },
        ]);
      });

      it("gives a Retro week the same", () => {
        const standings = givenUpIn({ retros: [failedRetro(121, "2026-11-07T01:05:00Z"), failedRetro(120, "2026-11-07T00:05:00Z")] });
        expect(standings.map(({ issue, work, name, detail }) => ({ issue, work, name, detail }))).toEqual([
          { issue: 121, work: "retro", name: "held", detail: { carrier: null, role: "retro", failed: [120, 121], until: "2026-11-09T00:00:00.000Z" } },
        ]);
      });

      it("gives none once the gate's next week has begun", () => {
        expect(givenUpIn({ audits: [failedAudit(96, "2026-11-08T02:05:00Z"), failedAudit(95, "2026-11-08T00:05:00Z")] }, "2026-11-09T00:00:00Z")).toEqual([]);
      });

      it.each([
        ["only once", [failedAudit(96, "2026-11-08T02:05:00Z"), run(95, "Audit", "2026-11-03T00:05:00Z", auditBody(AUDITED_SHA))]],
        ["twice, but in two weeks", [failedAudit(96, "2026-11-02T00:05:00Z"), failedAudit(95, "2026-11-01T12:05:00Z")]],
        ["twice, one of them a person's issue", [failedAudit(96, "2026-11-08T02:05:00Z"), failedAudit(95, "2026-11-08T00:05:00Z", "someone")]],
      ])("gives none for an Audit that failed %s", (_, audits) => {
        expect(givenUpIn({ audits })).toEqual([]);
      });

      it("says the next run is held until next week", () => {
        const [standing] = givenUpIn({ audits: [failedAudit(96, "2026-11-08T02:05:00Z"), failedAudit(95, "2026-11-08T00:05:00Z")] });
        if (standing === undefined) throw new Error("no Standing");
        expect(wordStanding(standing, NOW, "Australia/Sydney")).toEqual({ pill: "Held", sentence: "The next Audit is held until next week: two runs failed.", remedy: null });
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
      // A releasable one waits on the Kit instead (#608).
      const slots = (standings: readonly Standing[]) => standings.filter(({ name }) => name === "waiting-for-slot");
      expect(slots(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], withMaxInFlight(3), [aRunInFlight({ issue: 12 })])))).toEqual([]);
      expect(slots(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14, lastRunFailed: true }], withMaxInFlight(0))))).toEqual([]);
    });

    it("counts max_in_flight full with the runs unread, as Held does", () => {
      const standings = standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], { runsInFlight: "unread" }));
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([{ issue: 14, name: "waiting-for-slot" }]);
    });

    const atGate = (number: number, ticket: number) => anOpenPullRequest({ number, ticket, draft: false });

    it("gives a Ticket that caps.merge_gate holds one Standing waiting for the Merge gate, with the cap (#459)", () => {
      const standings = standingsIn({ openIssues: [ready(14)], openPullRequests: [atGate(21, 1), atGate(22, 2), atGate(23, 3)] }, dispatching([{ number: 14 }]));
      expect(standings.filter(({ issue }) => issue === 14).map(({ name, place, since, detail }) => ({ name, place, since, detail }))).toEqual([
        { name: "waiting-for-slot", place: "implement", since: readyAt, detail: { slot: "merge-gate", mergeGate: 3 } },
      ]);
    });

    it("gives the Merge gate the Ticket when both caps hold it, as the Operator can clear it, and max_in_flight the research Decision the gate doesn't hold", () => {
      const decision = anOpenIssue({ number: 16, labels: ["wayfinder:research"], labelEvents: [aLabelAdded("wayfinder:research", readyAt)] });
      const standings = standingsIn(
        { openIssues: [ready(14), decision], openPullRequests: [atGate(21, 1), anOpenPullRequest({ number: 50, ticket: 11 }), anOpenPullRequest({ number: 51, ticket: 12 })] },
        aKit([], { dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [aResearchDecision({ number: 16 })] } } }),
      );
      expect(standings.filter(({ name }) => name === "waiting-for-slot").map(({ issue, detail }) => ({ issue, detail }))).toEqual([
        { issue: 14, detail: { slot: "merge-gate", mergeGate: 3 } },
        { issue: 16, detail: { slot: "max-in-flight", maxInFlight: 2 } },
      ]);
    });

    it("holds a Ticket at a caps.merge_gate of 0 while any agent PR is at the gate, and none while nothing is at or on its way", () => {
      const zero = { config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, caps: { ...DEFAULT_KIT_CONFIG.caps, mergeGate: 0 } } } } as const;
      const slots = (standings: readonly Standing[]) => standings.filter(({ name }) => name === "waiting-for-slot").map(({ issue, detail }) => ({ issue, detail }));
      expect(slots(standingsIn({ openIssues: [ready(14)], openPullRequests: [atGate(21, 1)] }, dispatching([{ number: 14 }], zero)))).toEqual([
        { issue: 14, detail: { slot: "merge-gate", mergeGate: 0 } },
      ]);
      expect(slots(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], zero)))).toEqual([]);
    });

    it("words a Ticket waiting for the Merge gate with its cap", () => {
      const [standing] = standingsIn({ openIssues: [ready(14)], openPullRequests: [atGate(21, 1), atGate(22, 2), atGate(23, 3)] }, dispatching([{ number: 14 }])).filter(({ issue }) => issue === 14);
      expect(standing === undefined ? null : wordStanding(standing, "2026-11-08T12:00:00Z", "UTC")).toMatchObject({
        pill: "Waiting for a slot",
        sentence: "Waiting for room at the Merge gate for 3 days: `caps.merge_gate` is 3.",
      });
    });

    it("gives a needs-design issue with no Design session slot free one waiting for a slot at Design, since it got needs-design, and none to one holding a slot", () => {
      const standings = standingsIn(
        {
          designQueue: {
            // caps.design_sessions is 2 by default: 22 and 23 hold both slots.
            issues: [aDesignQueueIssue({ number: 21, neededDesignAt: "2026-11-06T09:00:00Z" }), aDesignQueueIssue({ number: 22, designRounds: 1 }), aDesignQueueIssue({ number: 23, designRounds: 1 })],
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
      expect(standingsIn({ openIssues: [ready(14)] }, dispatching([{ number: 14 }], withMaxInFlight(3))).filter(({ name }) => name === "blocked")).toEqual([]);
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
      const holding = [aDesignQueueIssue({ number: 22, designRounds: 1 }), aDesignQueueIssue({ number: 23, designRounds: 1 })];
      const design = standingsIn({ designQueue: { issues: [aDesignQueueIssue({ number: 21, neededDesignAt: "2026-11-06T20:00:00Z" }), ...holding], designTurnsInProgress: [] } }, null);
      expect(words(design, 21).sentence).toBe("Waiting for a Design session slot for 2 days.");
    });

    it("names the blockers", () => {
      const standings = standingsIn({ openIssues: [ready(14), ready(15)] }, dispatching([{ number: 14, openBlockers: [9, 3] }, { number: 15, openBlockers: [4] }]));
      expect(words(standings, 14)).toEqual({ pill: "Blocked", sentence: "Blocked by #3 and #9.", remedy: null });
      expect(words(standings, 15).sentence).toBe("Blocked by #4.");
    });
  });
});
