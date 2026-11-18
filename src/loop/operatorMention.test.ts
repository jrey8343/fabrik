// The Operator's mention (#785): once the Kit's own moves on an Unrelated
// failure holding an agent PR at the Merge gate are spent (one more re-run
// there, and the check's issue routed or its fix brought in), the hourly Tick
// @-mentions the Operator once per PR and check, naming the check, its issue
// and what's left. Until then the Operator hears of it as quietly as of a
// Flaky check.
import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, notificationsOf, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { checkFixMarker, checkFixMarksIn, flakyCheckIssueMarker, flakyCheckMarker, flakyCheckMarksIn, gateRerunDoneMarker, gateRerunMarksIn, operatorMentionMarksIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type {
  ClosedCheckIssue,
  HeadCheckRun,
  KitIssueSnapshot,
  LoopEvent,
  PassedHeadChecks,
  Plan,
  PullRequestSnapshot,
  Snapshot,
  VerdictRecord,
} from "./types.ts";

const NOW = "2026-11-18T12:17:00Z";
const TICK: LoopEvent = { kind: "scheduled-tick", now: NOW };
const HEAD = "c".repeat(40);
const SHORT = HEAD.slice(0, 7);
const MAIN = "9".repeat(40);

/** A Reviewer's pass on `headSha` that judged these checks Unrelated failures. */
const passNaming = (headSha: string, ...unrelated: string[]): VerdictRecord => ({ verdict: "pass", source: "reviewer", requestChanges: false, unrelated, headSha });

/** The Kit's line saying one more re-run at the Merge gate is done for `checks` on `headSha`, as read back off the PR. */
const rerunDone = (headSha: string, ...checks: string[]) => gateRerunMarksIn([{ id: "IC_done", body: gateRerunDoneMarker(headSha, checks, "red-again"), createdAt: NOW }]);

/** Agent PR #50 out of draft at the Merge gate, its pass on HEAD naming `e2e` an Unrelated failure, whose re-run there is done. */
const atGate = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot =>
  aPullRequest({ number: 50, draft: false, headSha: HEAD, verdicts: [passNaming(HEAD, "e2e")], gateReruns: rerunDone(HEAD, "e2e"), ...overrides });

const actionsRun = (name: string, conclusion: string | null, startedAt = "2026-11-18T10:00:00Z"): HeadCheckRun => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  startedAt,
  url: "https://github.com/acme/shop/actions/runs/7/job/70",
});

const RED_E2E = actionsRun("e2e", "failure");

const passedHead = (checkRuns: HeadCheckRun[] = [RED_E2E], overrides: Partial<PassedHeadChecks> = {}): PassedHeadChecks => ({
  pullRequest: 50,
  ticket: 7,
  headSha: HEAD,
  required: ["e2e", "lint"],
  checkRuns,
  marks: [],
  excerpts: [],
  ...overrides,
});

/** The open issue the Fabrik App filed for `check`, by default #12 for `e2e`, filed the day before. */
const checkIssue = (labels: string[], overrides: Partial<KitIssueSnapshot> & { check?: string } = {}): KitIssueSnapshot => {
  const { check = "e2e", ...rest } = overrides;
  return {
    number: 12,
    labels: ["fabrik:flaky-check", ...labels],
    body: `${flakyCheckIssueMarker(check)}\nThe required check \`${check}\` …`,
    comments: [],
    createdAt: "2026-11-17T09:00:00Z",
    ...rest,
  };
};

interface Read {
  readonly pullRequests?: PullRequestSnapshot[];
  readonly heads?: PassedHeadChecks[];
  readonly issues?: KitIssueSnapshot[];
  readonly closed?: ClosedCheckIssue[];
}

/** The Tick's plan for these PRs at the gate, what it read of their heads, and the check's issues open and closed. */
function tick({ pullRequests = [atGate()], heads = [passedHead()], issues = [], closed = [] }: Read = {}): Plan {
  const base = tickSnapshot();
  const snapshot: Snapshot = {
    ...base,
    conflicts: { ...base.conflicts!, main: MAIN, now: NOW, pullRequests: pullRequests.map((pullRequest) => ({ pullRequest, mergeable: true })) },
    flakySweep: [],
    passedHeads: heads,
    flakyCheckIssues: issues,
    closedCheckIssues: closed,
  };
  return planFor(TICK, snapshot, kitConfig());
}

/** The comments the plan posts that @-mention the Operator. */
const mentions = (plan: Plan): string[] =>
  (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" && /@operator\b/.test(action.body) ? [action.body] : []));

describe("the Operator is mentioned once the Kit's moves on an Unrelated failure are spent (#785)", () => {
  it.each([["needs-design"], ["ready-for-human"], ["needs-info"]])(
    "with the re-run at the gate done and the check's issue %s, posts one mention naming the check, its issue and the three ways on",
    (label) => {
      const plan = tick({ issues: [checkIssue([label])] });

      expect(notificationsOf(plan)).toEqual(["mention on #50"]);
      const [mention] = mentions(plan);
      expect(mention).toContain("`e2e`");
      expect(mention).toContain("#12");
      expect(mention).toContain(`\`${label}\``);
      expect(mention).toContain("re-run it, fix it, or merge past it by hand as ADR-0019 describes");
    },
  );
});

describe("while the Kit still has a move left, nothing is posted", () => {
  const waiting = [checkIssue(["needs-design"])];

  it("with the re-run at the gate not yet done for the head", () => {
    expect(notificationsOf(tick({ pullRequests: [atGate({ gateReruns: [] })], issues: waiting }))).toEqual([]);
  });

  it("with the re-run asked but not yet read back", () => {
    const asked = gateRerunMarksIn([{ id: "IC_ask", body: `<!-- fabrik:gate-rerun {"headSha":"${HEAD}","checks":[{"name":"e2e","link":"https://github.com/acme/shop/actions/runs/7/job/70"}]} -->`, createdAt: NOW }]);

    expect(notificationsOf(tick({ pullRequests: [atGate({ gateReruns: asked })], issues: waiting }))).toEqual([]);
  });

  it("with the re-run done only on an earlier head", () => {
    expect(notificationsOf(tick({ pullRequests: [atGate({ gateReruns: rerunDone("b".repeat(40), "e2e") })], issues: waiting }))).toEqual([]);
  });

  it("but a re-run skipped, as for a check red on main's head, counts as done", () => {
    const skipped = gateRerunMarksIn([{ id: "IC_skip", body: gateRerunDoneMarker(HEAD, ["e2e"], "red-on-main"), createdAt: NOW }]);

    expect(notificationsOf(tick({ pullRequests: [atGate({ gateReruns: skipped })], issues: waiting }))).toEqual(["mention on #50"]);
  });

  it("while the check's issue is ready-for-agent", () => {
    expect(notificationsOf(tick({ issues: [checkIssue(["ready-for-agent"])] }))).toEqual([]);
  });

  it("while a pull request for the check's issue is open, whatever its label says", () => {
    const fix = aPullRequest({ number: 61, ticket: 12, headSha: "f".repeat(40) });

    expect(notificationsOf(tick({ pullRequests: [atGate(), fix], issues: [checkIssue(["needs-design"])] }))).toEqual([]);
  });

  it("with no issue for the check to weigh", () => {
    expect(notificationsOf(tick())).toEqual([]);
  });
});

describe("once per pull request and check", () => {
  const waiting = [checkIssue(["needs-design"])];
  /** The mentions the plan posts, as the adapter reads them back off the PR. */
  const marksPosted = (plan: Plan) => operatorMentionMarksIn(mentions(plan));

  it("records the check and its issue in the mention's marker", () => {
    expect(marksPosted(tick({ issues: waiting }))).toEqual([{ headSha: HEAD, checks: [{ name: "e2e", issue: 12 }] }]);
  });

  it("posts no second mention at a later Tick", () => {
    const first = tick({ issues: waiting });

    expect(notificationsOf(tick({ pullRequests: [atGate({ operatorMentions: marksPosted(first) })], issues: waiting }))).toEqual([]);
  });

  it("posts none on a new head the check still fails on, or for a second failure of it there", () => {
    const first = tick({ issues: waiting });
    const NEW = "d".repeat(40);
    const moved = atGate({ headSha: NEW, verdicts: [passNaming(HEAD, "e2e"), passNaming(NEW, "e2e")], gateReruns: [...rerunDone(HEAD, "e2e"), ...rerunDone(NEW, "e2e")], operatorMentions: marksPosted(first) });

    expect(notificationsOf(tick({ pullRequests: [moved], heads: [passedHead([RED_E2E], { headSha: NEW })], issues: waiting }))).toEqual([]);
  });

  it("gives a different check on the PR its own", () => {
    const first = tick({ issues: waiting });
    const both = atGate({ verdicts: [passNaming(HEAD, "e2e", "lint")], gateReruns: rerunDone(HEAD, "e2e", "lint"), operatorMentions: marksPosted(first) });
    const lintIssue = checkIssue(["ready-for-human"], { number: 13, check: "lint" });

    const plan = tick({ pullRequests: [both], heads: [passedHead([RED_E2E, actionsRun("lint", "failure")])], issues: [...waiting, lintIssue] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(marksPosted(plan)).toEqual([{ headSha: HEAD, checks: [{ name: "lint", issue: 13 }] }]);
  });

  it("names two checks spent at the same Tick in one mention", () => {
    const both = atGate({ verdicts: [passNaming(HEAD, "e2e", "lint")], gateReruns: rerunDone(HEAD, "e2e", "lint") });
    const lintIssue = checkIssue(["ready-for-human"], { number: 13, check: "lint" });

    const plan = tick({ pullRequests: [both], heads: [passedHead([RED_E2E, actionsRun("lint", "failure")])], issues: [...waiting, lintIssue] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(mentions(plan)[0]).toContain("for each: re-run it, fix it, or merge past it by hand as ADR-0019 describes");
  });
});

describe("what gets no mention", () => {
  const waiting = [checkIssue(["needs-design"])];

  it("a check that has since read green on the head", () => {
    expect(notificationsOf(tick({ heads: [passedHead([RED_E2E, actionsRun("e2e", "success", "2026-11-18T11:00:00Z")])], issues: waiting }))).toEqual([]);
  });

  it("a check a Flaky check line already reports green on the head", () => {
    const flaky = flakyCheckMarksIn([flakyCheckMarker({ headSha: HEAD, checks: ["e2e"] })]);

    expect(notificationsOf(tick({ pullRequests: [atGate({ flakyCheckMarks: flaky })], issues: waiting }))).toEqual([]);
  });

  it("a pull request no longer at the Merge gate: back in draft, or moved past its pass", () => {
    expect(notificationsOf(tick({ pullRequests: [atGate({ draft: true })], issues: waiting }))).toEqual([]);
    expect(notificationsOf(tick({ pullRequests: [atGate({ headSha: "e".repeat(40) })], issues: waiting }))).toEqual([]);
  });

  it("a check the pass doesn't name an Unrelated failure", () => {
    expect(notificationsOf(tick({ pullRequests: [atGate({ verdicts: [passNaming(HEAD)] })], issues: waiting }))).toEqual([]);
  });

  it("anything at all on a Tick that read no passed head", () => {
    expect(notificationsOf(tick({ heads: [], issues: waiting }))).toEqual([]);
  });

  // The tick's tokens hold no Commit statuses: read, so it can't tell a commit status has since gone green.
  it("a commit status from an outside service, with no check run on the head, whose state the tick can't read", () => {
    const skipped = gateRerunMarksIn([{ id: "IC_done", body: gateRerunDoneMarker(HEAD, ["Vercel"], "outside"), createdAt: NOW }]);
    const pullRequest = atGate({ verdicts: [passNaming(HEAD, "Vercel")], gateReruns: skipped });

    expect(notificationsOf(tick({ pullRequests: [pullRequest], heads: [passedHead([RED_E2E])], issues: [checkIssue(["needs-design"], { check: "Vercel" })] }))).toEqual([]);
  });
});

describe("a check's issue waiting on the Operator", () => {
  it("counts one still needs-triage an hour after it was filed", () => {
    const plan = tick({ issues: [checkIssue(["needs-triage"], { createdAt: "2026-11-18T11:17:00Z" })] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(mentions(plan)[0]).toContain("`needs-triage`");
  });

  it("doesn't count one filed less than an hour ago", () => {
    const plan = tick({ issues: [checkIssue(["needs-triage"], { createdAt: "2026-11-18T11:30:00Z" })] });

    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("a check's issue that closed", () => {
  it.each([
    ["not-planned" as const, "closed as not planned"],
    ["duplicate" as const, "closed as a duplicate"],
  ])("calls for the mention when it closed as %s", (stateReason, said) => {
    const plan = tick({ closed: [{ number: 12, check: "e2e", closedAt: "2026-11-18T09:00:00Z", stateReason }] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(mentions(plan)[0]).toContain(`#12 ${said}`);
  });

  it("doesn't call for it when it closed as completed and the Kit hasn't brought the fix in yet", () => {
    const plan = tick({ closed: [{ number: 12, check: "e2e", closedAt: "2026-11-18T09:00:00Z", stateReason: "completed" }] });

    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("a head the Kit brought up to date after the check's fix", () => {
  const OLD = "b".repeat(40);
  const FIXED: ClosedCheckIssue = { number: 12, check: "e2e", closedAt: "2026-11-18T09:00:00Z", stateReason: "completed" };
  /** The Kit's record of bringing #50 up to date for #12's fix, as read back off the PR. */
  const broughtIn = (headSha: string, outcome: "rebased" | "conflict-run" | "held-main") => checkFixMarksIn([checkFixMarker({ headSha, main: MAIN, outcome, fixes: [{ check: "e2e", issue: 12 }] })]);

  /** #50 rebased from OLD onto the fix, passed on HEAD with `e2e` an Unrelated failure again. */
  const rebased = (overrides: Partial<PullRequestSnapshot> = {}) =>
    atGate({ verdicts: [passNaming(OLD, "e2e"), passNaming(HEAD, "e2e")], checkFixMarks: broughtIn(OLD, "rebased"), gateReruns: [...rerunDone(OLD, "e2e"), ...rerunDone(HEAD, "e2e")], ...overrides });

  it.each([["rebased" as const], ["conflict-run" as const]])("calls for the mention when the check still fails on it once its own re-run is done (%s)", (outcome) => {
    const plan = tick({ pullRequests: [rebased({ checkFixMarks: broughtIn(OLD, outcome) })], closed: [FIXED] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(mentions(plan)[0]).toContain("the Kit brought #50 up to date after #12 closed as completed, and `e2e` is still red on the new head");
  });

  it("waits for that head's own re-run at the gate", () => {
    const plan = tick({ pullRequests: [rebased({ gateReruns: rerunDone(OLD, "e2e") })], closed: [FIXED] });

    expect(notificationsOf(plan)).toEqual([]);
  });

  it("calls for it on a PR that already held main's head when the issue closed", () => {
    const plan = tick({ pullRequests: [atGate({ checkFixMarks: broughtIn(HEAD, "held-main") })], closed: [FIXED] });

    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(mentions(plan)[0]).toContain("#12 closed as completed while #50 already held `main`'s head, and `e2e` is still red on it");
  });

  it("says nothing on that head while the fresh issue is ready-for-agent", () => {
    const plan = tick({ pullRequests: [rebased()], closed: [FIXED], issues: [checkIssue(["ready-for-agent"], { number: 15 })] });

    expect(notificationsOf(plan)).toEqual([]);
  });

  it("links the check's fresh issue too, where its failure since is held", () => {
    const plan = tick({ pullRequests: [rebased()], closed: [FIXED], issues: [checkIssue(["needs-triage"], { number: 15, createdAt: "2026-11-18T12:00:00Z" })] });

    expect(mentions(plan)[0]).toContain("its failure since is on #15");
  });
});
