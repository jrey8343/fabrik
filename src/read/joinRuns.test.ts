import { describe, expect, it } from "vitest";
import type { OpenIssueFacts, OpenPullRequestFacts } from "../kit/weeklySummary.ts";
import { handBackMarker } from "../loop/markers.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aReview, aRunRead, aRunsRead, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { Facts } from "./gather.ts";
import { joinRuns } from "./joinRuns.ts";
import { type Row, rowsOf } from "./rows.ts";
import type { RunInFlight, RunsRead } from "./runs.ts";

const NOW = "2026-11-08T20:00:00Z";

/** A `ready-for-agent` Ticket given `agent:implement` at `at`, twenty minutes before now unless a test says otherwise, with no run started on it. */
const aTicketAwaitingImplement = (number: number, at = "2026-11-08T19:40:00Z", overrides: Partial<OpenIssueFacts> = {}) =>
  anOpenIssue({ number, title: `Ticket ${number}`, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", at)], ...overrides });

/** An exact run of the Fabrik App's: Actions run 4410, created at 19:50, its agent job given a runner at 19:52. */
const anExactRun = (overrides: Partial<RunInFlight>) =>
  aRunRead({ exact: true, kind: "first", run: 4410, createdAt: "2026-11-08T19:50:00Z", startedAt: "2026-11-08T19:52:00Z", ...overrides });

/** The Fabrik App's exact Implement run on a Ticket. */
const anImplementRunOn = (issue: number, overrides: Partial<RunInFlight> = {}) => anExactRun({ role: "implement", issue, ...overrides });

/** The Fabrik App's exact Review run on Ticket 7's agent draft 50. */
const aReviewRunOn50 = (job: RunInFlight["job"]) => anExactRun({ role: "review", issue: 7, pullRequest: 50, kind: "first", job, startedAt: job === "running" ? "2026-11-08T19:52:00Z" : null });

/** Ticket 7's agent draft 50, quiet since its last push, with no Verdict on its head. */
const A_QUIET_DRAFT: OpenPullRequestFacts = anOpenPullRequest({ number: 50, ticket: 7, draft: true, commits: [{ at: "2026-11-08T19:30:00Z", author: "fabrik-app[bot]" }] });

/** Ticket 7, whose agent PR 50 passed, then the Operator requested changes on it. */
const A_REQUEST_CHANGES = {
  openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
  openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", "h".repeat(40), "2026-11-08T17:00:00Z")], reviews: [aReview("2026-11-08T19:00:00Z")] })],
} as const;

/** A Review run told by its job's name, from a release before the closing line: it carries no number and no kind. */
const A_NUMBERLESS_REVIEW = (job: RunInFlight["job"]) =>
  aRunRead({ role: "review", exact: false, issue: null, pullRequest: null, kind: null, job, run: 4440, createdAt: "2026-11-08T19:50:00Z", startedAt: job === "running" ? "2026-11-08T19:55:00Z" : null });

/** An Implement run told by its job's name that carries no number and no kind. */
const A_NUMBERLESS_IMPLEMENT = aRunRead({ role: "implement", exact: false, issue: null, pullRequest: null, kind: null, run: 4450, createdAt: "2026-11-08T19:50:00Z", startedAt: "2026-11-08T19:51:00Z" });

/** Ticket 7's agent draft 50, quiet since its last push, a pass on its head. */
const A_PASSED_DRAFT: OpenPullRequestFacts = { ...A_QUIET_DRAFT, comments: [aVerdictComment("pass", "h".repeat(40), "2026-11-08T19:35:00Z")] };

/** An Implement job on Ticket 7 told by its name, from a release before the closing line: it carries no kind. */
const AN_IMPLEMENT_JOB_ON_7 = aRunRead({ role: "implement", issue: 7, exact: false, run: 4430, createdAt: "2026-11-08T19:50:00Z" });

/**
 * One case of the join: the facts a gather read, the runs read the kept rows
 * were worked out with (null: none held), when, and a later runs read and time.
 */
interface JoinCase {
  readonly facts: Facts;
  readonly earlier: RunsRead | null;
  readonly keptAt: string;
  readonly later: RunsRead;
  readonly now: string;
}

const aCase = (github: Parameters<typeof factsOf>[0], later: readonly RunInFlight[] | "unread", overrides: Partial<JoinCase> = {}): JoinCase => ({
  facts: homeFactsOf({ github: factsOf(github) }),
  earlier: null,
  keptAt: NOW,
  later: aRunsRead(later),
  now: NOW,
  ...overrides,
});

/** The rows a reader keeps, worked out by the rows function from the case's facts and earlier runs read. */
const keptOf = ({ facts, earlier, keptAt }: JoinCase): Row[] => rowsOf(facts, earlier, null, keptAt);
/** The kept rows joined with the later runs read. */
const joinedOf = (join: JoinCase): Row[] => joinRuns(keptOf(join), join.later, join.now);
/** What the rows function gives from the same facts with the later runs read. */
const ruleOf = ({ facts, later, now }: JoinCase): Row[] => rowsOf(facts, later, null, now);
/** What tells one row's Standing from another's, for the tests that say only what changed. */
const namesOf = (rows: readonly Row[]) => rows.map(({ standing }) => ({ issue: standing.issue, pullRequest: standing.pullRequest, name: standing.name }));

const CASES = {
  started: aCase({ openIssues: [aTicketAwaitingImplement(12)] }, [anImplementRunOn(12)]),
  anotherTicket: aCase({ openIssues: [aTicketAwaitingImplement(12)] }, [anImplementRunOn(13)]),
  stuck: aCase({ openIssues: [aTicketAwaitingImplement(12, "2026-11-07T10:00:00Z")] }, [anImplementRunOn(12)]),
  operators: aCase(
    {
      openIssues: [
        aTicketAwaitingImplement(12, "2026-11-08T19:00:00Z", {
          comments: [aComment(["The Implement run on #12 failed: it crashed.", handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "crash" })].join("\n"), "2026-11-08T19:30:00Z")],
        }),
      ],
    },
    [anImplementRunOn(12)],
  ),
  gotARunner: aCase({ openIssues: [aTicketAwaitingImplement(12)] }, [anImplementRunOn(12)], {
    earlier: aRunsRead([anImplementRunOn(12, { job: "blocked", startedAt: null })]),
  }),
  waitingOnChecks: aCase({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [A_QUIET_DRAFT] }, [aReviewRunOn50("waiting-on-checks")]),
  reviewing: aCase({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [A_QUIET_DRAFT] }, [aReviewRunOn50("running")], {
    earlier: aRunsRead([aReviewRunOn50("waiting-on-checks")]),
  }),
  numberless: aCase(
    {
      openIssues: [aTicketAwaitingImplement(12), aTicketAwaitingImplement(14), anOpenIssue({ number: 15, labels: ["needs-triage"], labelEvents: [aLabelAdded("needs-triage", "2026-11-08T19:40:00Z")] })],
    },
    [aRunRead({ role: "implement", exact: false, run: 4420, createdAt: "2026-11-08T19:50:00Z", startedAt: "2026-11-08T19:53:00Z" })],
  ),
  reviewingNumberless: aCase({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [A_QUIET_DRAFT] }, [A_NUMBERLESS_REVIEW("running")], {
    earlier: aRunsRead([A_NUMBERLESS_REVIEW("waiting-on-checks")]),
  }),
  passedDraftNumberless: aCase({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [A_PASSED_DRAFT] }, [A_NUMBERLESS_REVIEW("running")]),
  requestChanges: aCase(A_REQUEST_CHANGES, [AN_IMPLEMENT_JOB_ON_7]),
  requestChangesNumberless: aCase(A_REQUEST_CHANGES, [A_NUMBERLESS_IMPLEMENT]),
  requestChangesUnderWay: aCase(A_REQUEST_CHANGES, [{ ...AN_IMPLEMENT_JOB_ON_7, startedAt: "2026-11-08T19:55:00Z" }], { earlier: aRunsRead([AN_IMPLEMENT_JOB_ON_7]) }),
  unread: aCase({ openIssues: [aTicketAwaitingImplement(12, "2026-11-08T15:00:00Z"), aTicketAwaitingImplement(14, "2026-11-08T19:40:00Z")] }, "unread", {
    keptAt: "2026-11-08T15:30:00Z",
    now: "2026-11-08T23:00:00Z",
  }),
} as const satisfies Readonly<Record<string, JoinCase>>;

describe("rows settled against fresh runs with no gather", () => {
  it("make a kept not-started row running when an exact run of the role it awaits is in flight on its Ticket, with the run, its kind, its time and no stuckAt", () => {
    const kept = keptOf(CASES.started);
    expect(kept.map(({ standing }) => standing.name)).toEqual(["not-started"]);

    expect(joinedOf(CASES.started)).toEqual([
      {
        ...kept[0],
        standing: {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: null,
          work: "ticket",
          place: "implement",
          name: "running",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: "2026-11-08T19:52:00Z",
          stuckAt: null,
          awaits: { role: "implement", on: "issue" },
          subscription: null,
          detail: { run: "implement", retry: null, actionsRun: 4410 },
        },
      },
    ]);
  });

  it("leave the row as it was when the exact run is on another Ticket", () => {
    expect(joinedOf(CASES.anotherTicket)).toEqual(keptOf(CASES.anotherTicket));
  });

  it("make a kept Stuck row running when the run it awaits is now in flight", () => {
    expect(namesOf(keptOf(CASES.stuck))).toEqual([{ issue: 12, pullRequest: null, name: "stuck" }]);

    expect(joinedOf(CASES.stuck).map(({ standing }) => standing)).toEqual([
      expect.objectContaining({ name: "running", move: "kit", yours: false, stopsWork: false, stuckAt: null, since: "2026-11-08T19:52:00Z", detail: { run: "implement", retry: null, actionsRun: 4410 } }),
    ]);
  });

  it("never change a row whose move is the Operator's, though a run is in flight on its work", () => {
    const kept = keptOf(CASES.operators);
    expect(kept.map(({ standing }) => standing.move)).toEqual(["operator"]);
    expect(joinedOf(CASES.operators)).toEqual(kept);

    const awaitingARun = kept.map((row) => ({ ...row, standing: { ...row.standing, awaits: { role: "implement", on: "issue" } } }) as Row);
    expect(joinRuns(awaitingARun, CASES.operators.later, NOW)).toEqual(awaitingARun);
  });

  it("take the agent job's start as a blocked run's time once it has a runner, and give the same rows when joined again with the same read", () => {
    const kept = keptOf(CASES.gotARunner);
    expect(kept.map(({ standing }) => ({ name: standing.name, since: standing.since }))).toEqual([{ name: "running", since: "2026-11-08T19:50:00Z" }]);

    const joined = joinedOf(CASES.gotARunner);

    expect(joined.map(({ standing }) => ({ name: standing.name, since: standing.since }))).toEqual([{ name: "running", since: "2026-11-08T19:52:00Z" }]);
    expect(joinRuns(joined, CASES.gotARunner.later, NOW)).toEqual(joined);
  });

  it("make a kept agent draft awaiting a Review waiting-on-checks while its Review waits for its Required checks, and running once that run is", () => {
    expect(namesOf(keptOf(CASES.waitingOnChecks))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-kit" }]);

    expect(joinedOf(CASES.waitingOnChecks).map(({ standing }) => standing)).toEqual([
      expect.objectContaining({ issue: 7, pullRequest: 50, name: "waiting-on-checks", since: "2026-11-08T19:50:00Z", detail: { plain: null, check: null, checksUnread: false, head: "h".repeat(40) } }),
    ]);
    expect(namesOf(keptOf(CASES.reviewing))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-checks" }]);
    expect(joinedOf(CASES.reviewing).map(({ standing }) => standing)).toEqual([
      expect.objectContaining({ name: "running", place: "review", awaits: { role: "review", on: "pullRequest" }, detail: { run: "review", retry: null, actionsRun: 4410, head: "h".repeat(40) } }),
    ]);
  });

  it("return a kept running row as it was when its run is no longer in the read, and an agent draft's waiting-on-checks row too", () => {
    const running = keptOf({ ...CASES.started, earlier: CASES.started.later });
    expect(running.map(({ standing }) => standing.name)).toEqual(["running"]);
    expect(joinRuns(running, aRunsRead([]), NOW)).toEqual(running);

    const waiting = keptOf({ ...CASES.reviewing });
    expect(joinRuns(waiting, aRunsRead([]), NOW)).toEqual(waiting);
  });

  it("make every row awaiting its role running on a run that is not exact and carries no number, and no other", () => {
    expect(namesOf(joinedOf(CASES.numberless))).toEqual([
      { issue: 15, pullRequest: null, name: "waiting-on-kit" },
      { issue: 12, pullRequest: null, name: "running" },
      { issue: 14, pullRequest: null, name: "running" },
    ]);
  });

  it("make a kept agent draft waiting on checks running once its Review, told by its job's name with no number, is", () => {
    expect(namesOf(keptOf(CASES.reviewingNumberless))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-checks" }]);

    expect(joinedOf(CASES.reviewingNumberless).map(({ standing }) => standing)).toEqual([
      expect.objectContaining({ name: "running", since: "2026-11-08T19:55:00Z", awaits: { role: "review", on: "pullRequest" }, detail: { run: "review", retry: null, actionsRun: 4440, head: "h".repeat(40) } }),
    ]);
  });

  it("count a run with no number only for a row whose Standing shows it waits on any run of its role, as the rule counts one", () => {
    expect(namesOf(keptOf(CASES.requestChangesNumberless))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-kit" }]);
    expect(joinedOf(CASES.requestChangesNumberless)).toEqual(keptOf(CASES.requestChangesNumberless));

    expect(namesOf(keptOf(CASES.passedDraftNumberless))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-kit" }]);
    expect(joinedOf(CASES.passedDraftNumberless)).toEqual(keptOf(CASES.passedDraftNumberless));
  });

  it("name a run that carries no kind by the run the kept row waits for, or the one it already names", () => {
    expect(namesOf(keptOf(CASES.requestChanges))).toEqual([{ issue: 7, pullRequest: 50, name: "waiting-on-kit" }]);
    expect(joinedOf(CASES.requestChanges).map(({ standing }) => standing)).toEqual([
      expect.objectContaining({ name: "running", awaits: { role: "implement", on: "pullRequest" }, detail: { run: "request-changes", retry: null, actionsRun: 4430, head: "h".repeat(40) } }),
    ]);

    expect(keptOf(CASES.requestChangesUnderWay).map(({ standing }) => standing.detail)).toEqual([expect.objectContaining({ run: "request-changes" })]);
    expect(joinedOf(CASES.requestChangesUnderWay).map(({ standing }) => ({ since: standing.since, detail: standing.detail }))).toEqual([
      { since: "2026-11-08T19:55:00Z", detail: { run: "request-changes", retry: null, actionsRun: 4430, head: "h".repeat(40) } },
    ]);
  });

  it("with the runs unread, read each kept row at the later time and change nothing else: one past its stuckAt comes back Stuck", () => {
    const kept = keptOf(CASES.unread);
    expect(namesOf(kept)).toEqual([
      { issue: 12, pullRequest: null, name: "not-started" },
      { issue: 14, pullRequest: null, name: "not-started" },
    ]);

    const joined = joinedOf(CASES.unread);

    expect(namesOf(joined)).toEqual([
      { issue: 12, pullRequest: null, name: "stuck" },
      { issue: 14, pullRequest: null, name: "not-started" },
    ]);
    expect(joined.map(({ standing }) => standing.since)).toEqual(kept.map(({ standing }) => standing.since));
  });

  it.each(Object.entries(CASES))("agree with the rows function given the later runs read: %s", (_name, join) => {
    expect(joinedOf(join)).toEqual(ruleOf(join));
  });

  it("survive a JSON round trip", () => {
    const joined = Object.values(CASES).flatMap(joinedOf);

    expect(joined.length).toBeGreaterThan(8);
    expect(JSON.parse(JSON.stringify(joined))).toStrictEqual(joined);
  });
});
