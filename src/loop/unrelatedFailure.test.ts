// The Reviewer judges each red Required check on a head still red after
// everything the Kit could do as caused or an Unrelated failure (#780). An
// Unrelated failure never counts toward the Ticket's Retries, and a pass that
// names one goes to the Merge gate, which holds the pull request until the
// check is green.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { DISPATCH_LABEL } from "./labels.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, RedRequiredChecks, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** `gate` and `e2e` failed again on the Kit's re-run. */
const RED: RedRequiredChecks = {
  failed: ["gate", "e2e"],
  rerun: { outside: [], failedAgain: ["gate", "e2e"], flaky: [], refused: null },
  excerpts: [],
};

type Reviewed = Extract<LoopEvent, { kind: "review-run-finished" }>;

function reviewed(output: string, overrides: Partial<Reviewed> = {}): Reviewed {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop", redChecks: RED, ...overrides };
}

const land = (output: string, pullRequest: PullRequestSnapshot = aPullRequest(), overrides: Partial<Reviewed> = {}) =>
  planFor(reviewed(output, overrides), snapshotOfPullRequest(pullRequest), kitConfig());

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** A comment's text, an issue the plan files written as `#new` (#781). */
function textOf(action: Action): string {
  if (action.kind === "comment") return action.body;
  if (action.kind === "comment-linking") return action.body.map((part) => (typeof part === "string" ? part : "#new")).join("");
  return "";
}

function verdictOf(plan: Plan): string {
  const bodies = actionsOf(plan).flatMap((action) => (textOf(action).includes("## Verdict") ? [textOf(action)] : []));
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

const recordOf = (plan: Plan): VerdictRecord => verdictsPostedIn([verdictOf(plan)])[0] as VerdictRecord;

/** The plan's actions other than its Verdict comment, and the Unrelated failure line and issues before it (#781). */
const besidesVerdict = (plan: Plan) =>
  actionsOf(plan).filter(
    (action) =>
      !textOf(action).includes("## Verdict") &&
      !textOf(action).startsWith("<!-- fabrik:unrelated-failure ") &&
      !(action.kind === "create-issue" && action.labels.includes("fabrik:flaky-check")),
  );

const retryStarted = (plan: Plan) => actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7 && action.labels.includes(DISPATCH_LABEL));

const BOTH_UNRELATED = "red-checks:\n- unrelated `gate`: the lint ran out of memory on the runner.\n- unrelated `e2e`: the booking journey fails the same way on main's head.";
const ONE_CAUSED = "red-checks:\n- caused `gate`: the typecheck error is in a stub the renamed type breaks.\n- unrelated `e2e`: the booking journey fails the same way on main's head.";

describe("What lands from the Reviewer's line and its judgments of the red checks (#780)", () => {
  it("a design-flaw lands as a Design flaw whatever the checks, and sends the Ticket back to design", () => {
    const plan = land(`verdict: design-flaw\n\nThe Ticket asks for two contradictory things.\n\n${BOTH_UNRELATED}`);

    expect(recordOf(plan)).toEqual({ verdict: "design-flaw", source: "reviewer", requestChanges: false, unrelated: ["gate", "e2e"], headSha: HEAD_SHA });
    expect(actionsOf(plan).map((action) => action.kind)).toContain("close-pull-request");
    expect(retryStarted(plan)).toBe(false);
  });

  it.each(["pass", "execution-flaw"])("a %s beside a caused check lands as an Execution flaw that counts and calls for a Retry", (line) => {
    const plan = land(`verdict: ${line}\n\nChecked each criterion against the diff.\n\n${ONE_CAUSED}`);

    const record = recordOf(plan);
    expect(record).toMatchObject({ verdict: "execution-flaw", source: "reviewer", checks: ["gate"], unrelated: ["e2e"] });
    expect(record).not.toHaveProperty("touchUp");
    expect(verdictOf(plan)).toContain("## Verdict: Execution flaw");
    expect(verdictOf(plan)).toContain("Retry 1 of 2");
    expect(retryStarted(plan)).toBe(true);
  });

  it("a pass beside a caused check is an Execution flaw whose finding is that check", () => {
    const body = verdictOf(land(`verdict: pass\n\nChecked it.\n\n${ONE_CAUSED}`));

    const part = body.split("### Red Required checks")[1]!;
    expect(part).toContain("The Reviewer found no flaw in the code");
    expect(part).toContain("The Reviewer judged `gate` caused by this pull request, so this Verdict is an Execution flaw that counts.");
    expect(part).toMatch(/`gate`[^\n]*\n\n {2}Caused by this pull request: the typecheck error is in a stub the renamed type breaks\./);
  });

  it("a caused check counts with none left: the Ticket goes back to design", () => {
    const flaw = (headSha: string): VerdictRecord => ({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha });
    const plan = land(`verdict: pass\n\nChecked it.\n\n${ONE_CAUSED}`, aPullRequest({ verdicts: [flaw("1".repeat(40)), flaw("2".repeat(40))], pushedSinceVerdict: true }));

    expect(verdictOf(plan)).toContain("This is the Ticket's third Execution flaw, which counts as a Design flaw.");
    expect(actionsOf(plan).map((action) => action.kind)).toContain("close-pull-request");
  });

  it("an execution-flaw with every check unrelated and every finding tagged calls for a Touch-up while one is left", () => {
    const plan = land(`verdict: execution-flaw\n\n- [small: comment] A stale comment.\n\n${BOTH_UNRELATED}`);

    const record = recordOf(plan);
    expect(record).toMatchObject({ verdict: "execution-flaw", unrelated: ["gate", "e2e"], touchUp: 1 });
    expect(record).not.toHaveProperty("checks");
    expect(verdictOf(plan)).toContain("Touch-up 1 of 2 starts now");
    expect(retryStarted(plan)).toBe(true);
  });

  it("an execution-flaw with every check unrelated and an untagged finding calls for a Retry", () => {
    const plan = land(`verdict: execution-flaw\n\n- [small: comment] A stale comment.\n- The empty cart throws.\n\n${BOTH_UNRELATED}`);

    expect(recordOf(plan)).not.toHaveProperty("touchUp");
    expect(verdictOf(plan)).toContain("Retry 1 of 2");
  });

  it("an execution-flaw says which checks are Unrelated failures and that the run fixing it leaves them alone", () => {
    const body = verdictOf(land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_CAUSED}`));

    const part = body.split("### Red Required checks")[1]!;
    expect(part).toContain("The Reviewer judged `e2e` an Unrelated failure, which doesn't count. The run that fixes this Verdict leaves it alone.");
    expect(part).toMatch(/`e2e`[^\n]*\n\n {2}An Unrelated failure, reported on #new: the booking journey fails the same way on main's head\./);
  });

  it("a pass with every check unrelated lands as a Pass and goes to the Merge gate as any pass does, its marker carrying them", () => {
    const plan = land(`verdict: pass\n\nChecked each criterion against the diff.\n\n${BOTH_UNRELATED}`);
    const green = planFor(reviewed("verdict: pass\n\nChecked each criterion against the diff.", { redChecks: undefined }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(recordOf(plan)).toEqual({ verdict: "pass", source: "reviewer", requestChanges: false, unrelated: ["gate", "e2e"], headSha: HEAD_SHA });
    expect(besidesVerdict(plan)).toEqual(besidesVerdict(green));
    expect(retryStarted(plan)).toBe(false);
    const body = verdictOf(plan);
    expect(body).toContain("## Verdict: Pass");
    expect(body).toContain("The Reviewer judged each of these an Unrelated failure, which doesn't count: `gate` and `e2e`.");
    expect(body).toContain("The Merge gate holds this pull request until each is green on its head.");
  });

  it("a pass with every check unrelated opens the Merge gate with the Digest off, as any pass does", () => {
    const config = kitConfig({ digest: { ...kitConfig().digest, enabled: false } });
    const plan = planFor(reviewed(`verdict: pass\n\nChecked it.\n\n${BOTH_UNRELATED}`), snapshotOfPullRequest(aPullRequest()), config);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(expect.arrayContaining(["mark-ready-for-review", "request-review"]));
    expect(notificationsOf(plan)).toHaveLength(1);
  });
});

describe("A red check the Reviewer didn't judge, or judged in an item that doesn't read (#780)", () => {
  it.each([
    ["leaves out", "red-checks:\n- unrelated `gate`: the runner ran out of memory."],
    ["misnames", "red-checks:\n- unrelated `gate`: the runner ran out of memory.\n- unrelated `e2e-tests`: red on main."],
    ["misspells", "red-checks:\n- unrelated `gate`: the runner ran out of memory.\n- unrelatd `e2e`: red on main."],
  ])("one the block %s is caused, so a pass counts, and the Verdict says the Reviewer gave no judgment", (_, block) => {
    const plan = land(`verdict: pass\n\nChecked it.\n\n${block}`);

    expect(recordOf(plan)).toMatchObject({ verdict: "execution-flaw", checks: ["e2e"], unrelated: ["gate"] });
    expect(verdictOf(plan)).toMatch(/`e2e`[^\n]*\n\n {2}Caused by this pull request: the Reviewer gave no judgment\./);
    expect(retryStarted(plan)).toBe(true);
  });
});

describe("Judgments where nothing is red (#780)", () => {
  it("a red-checks: block on a green head changes nothing", () => {
    const withBlock = planFor(reviewed(`verdict: execution-flaw\n\n- [small: comment] A stale comment.\n\n${ONE_CAUSED}`, { redChecks: undefined }), snapshotOfPullRequest(aPullRequest()), kitConfig());
    const without = planFor(reviewed("verdict: execution-flaw\n\n- [small: comment] A stale comment.", { redChecks: undefined }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(withBlock).toEqual(without);
    expect(recordOf(withBlock)).toMatchObject({ touchUp: 1 });
  });

  it("an item for a check that isn't red changes nothing", () => {
    const red: RedRequiredChecks = { failed: ["e2e"], excerpts: [] };
    const plan = land("verdict: pass\n\nChecked it.\n\nred-checks:\n- caused `gate`: the stub.\n- unrelated `e2e`: red on main.", aPullRequest(), { redChecks: red });

    expect(recordOf(plan)).toEqual({ verdict: "pass", source: "reviewer", requestChanges: false, unrelated: ["e2e"], headSha: HEAD_SHA });
  });
});

describe("Precedence over an Execution flaw with only Unrelated failures (#780)", () => {
  it("the Operator's unbuilt Request changes goes first (#341)", () => {
    const pullRequest = aPullRequest({ unbuiltChangesRequests: [{ review: 9, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }] });

    const plan = land(`verdict: execution-flaw\n\n- [small: comment] A stale comment.\n\n${BOTH_UNRELATED}`, pullRequest);

    expect(recordOf(plan)).toMatchObject({ verdict: "execution-flaw", requestChangesFirst: [9], unrelated: ["gate", "e2e"] });
    expect(recordOf(plan)).not.toHaveProperty("touchUp");
    expect(verdictOf(plan)).toContain("This Execution flaw uses no retry.");
  });

  it("a Ticket no longer ready-for-agent starts nothing (#416)", () => {
    const plan = land(`verdict: execution-flaw\n\n- [small: comment] A stale comment.\n\n${BOTH_UNRELATED}`, aPullRequest({ ticketLabels: ["needs-design"] }));

    expect(recordOf(plan)).toMatchObject({ verdict: "execution-flaw", ticketNotReady: true, unrelated: ["gate", "e2e"] });
    expect(retryStarted(plan)).toBe(false);
  });
});

describe("Each head's red checks are judged afresh (#780)", () => {
  it("an earlier Verdict that judged a check unrelated binds no later Review of a new head", () => {
    const earlier: VerdictRecord = { verdict: "pass", source: "reviewer", requestChanges: false, unrelated: ["gate", "e2e"], headSha: "1".repeat(40) };
    const pullRequest = aPullRequest({ verdicts: [earlier], pushedSinceVerdict: true });

    const plan = land("verdict: pass\n\nChecked it.", pullRequest);

    expect(recordOf(plan)).toMatchObject({ verdict: "execution-flaw", checks: ["gate", "e2e"] });
    expect(recordOf(plan)).not.toHaveProperty("unrelated");
  });
});
