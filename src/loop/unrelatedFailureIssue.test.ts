// The Operator hears of an Unrelated failure as quietly as of a Flaky check
// (#781): a line on the pull request ahead of the Verdict, mentioning nobody,
// and the check's own issue, one per check, which holds its Flaky checks and
// its Unrelated failures alike.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import type { FailureExcerpt } from "../review/failureExcerpt.ts";
import { planFor } from "./rules.ts";
import type { Action, KitIssueSnapshot, LoopEvent, Plan, PullRequestSnapshot, RedRequiredChecks } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const E2E_JOB = "https://github.com/acme/shop/actions/runs/7/job/70";
const GATE_JOB = "https://github.com/acme/shop/actions/runs/7/job/71";

const excerpt = (check: string, link: string, line: string): FailureExcerpt => ({
  kind: "actions",
  check,
  link,
  steps: [{ name: "Run pnpm test", earlier: 0, lines: [line, "##[error]Process completed with exit code 1."] }],
  annotations: [],
});

/** `gate` and `e2e` failed again on the Kit's re-run, each with its excerpt. */
const RED: RedRequiredChecks = {
  failed: ["gate", "e2e"],
  rerun: { outside: [], failedAgain: ["gate", "e2e"], flaky: [], refused: null },
  excerpts: [excerpt("gate", GATE_JOB, "tsc: Type 'Cart' is not assignable"), excerpt("e2e", E2E_JOB, "FAIL booking.spec.ts > books a table")],
};

const ONE_UNRELATED = "red-checks:\n- caused `gate`: the typecheck error is in a stub the renamed type breaks.\n- unrelated `e2e`: the booking journey fails the same way on main's head, @someone.";

type Reviewed = Extract<LoopEvent, { kind: "review-run-finished" }>;

function reviewed(output: string, overrides: Partial<Reviewed> = {}): Reviewed {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop", redChecks: RED, ...overrides };
}

const land = (output: string, { pullRequest = aPullRequest(), issues = [] }: { pullRequest?: PullRequestSnapshot; issues?: KitIssueSnapshot[] } = {}) =>
  planFor(reviewed(output), { ...snapshotOfPullRequest(pullRequest), flakyCheckIssues: issues }, kitConfig());

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** Each comment's text, created issues written as `#new:<key>`. */
function textOf(action: Action): string {
  if (action.kind === "comment" || action.kind === "comment-on-created") return action.body;
  if (action.kind === "comment-linking") return action.body.map((part) => (typeof part === "string" ? part : "created" in part ? `#new:${part.created}` : part.posted)).join("");
  return "";
}

const createdIn = (plan: Plan) => actionsOf(plan).flatMap((action) => (action.kind === "create-issue" ? [action] : []));
const lineIndex = (plan: Plan) => actionsOf(plan).findIndex((action) => textOf(action).startsWith("<!-- fabrik:unrelated-failure "));
const verdictIndex = (plan: Plan) => actionsOf(plan).findIndex((action) => textOf(action).startsWith("<!-- fabrik:verdict "));

describe("The Unrelated failure line (#781)", () => {
  it("goes ahead of the Verdict, with its marker naming the head and the check, and links the check's issue", () => {
    const plan = land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`);
    const [issue] = createdIn(plan);

    expect(lineIndex(plan)).toBeGreaterThanOrEqual(0);
    expect(lineIndex(plan)).toBeLessThan(verdictIndex(plan));
    const line = textOf(actionsOf(plan)[lineIndex(plan)]!);
    expect(line.split("\n")[0]).toBe(`<!-- fabrik:unrelated-failure {"headSha":"${HEAD_SHA}","checks":["e2e"]} -->`);
    expect(line).toContain(`\`e2e\` is still red on ${HEAD_SHA.slice(0, 7)}, and the Reviewer judged this pull request didn't cause it: an Unrelated failure (#new:${issue!.key}).`);
    expect(line).not.toContain("`gate`");
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("The Verdict after an Unrelated failure line (#781)", () => {
  it.each([
    ["an Execution flaw", "verdict: execution-flaw\n\n- The empty cart throws."],
    ["a pass", "verdict: pass\n\nChecked each criterion against the diff."],
  ])("%s links the check's issue it files beside the Reviewer's reason, as the Verdict comment", (_, opening) => {
    const plan = land(`${opening}\n\n${ONE_UNRELATED.replace("caused `gate`", "unrelated `gate`")}`);
    const verdict = actionsOf(plan)[verdictIndex(plan)]!;
    const [gate, e2e] = createdIn(plan);

    expect(verdict).toMatchObject({ kind: "comment-linking", issue: 50, key: "verdict" });
    expect(textOf(verdict)).toMatch(new RegExp(`\`e2e\`[^\\n]*\\n\\n {2}An Unrelated failure, reported on #new:${e2e!.key}: the booking journey fails the same way on main's head`));
    expect(textOf(verdict)).toContain(`An Unrelated failure, reported on #new:${gate!.key}:`);
  });

  it("links an open issue for the check by its number, and stays a plain comment", () => {
    const open: KitIssueSnapshot = { number: 88, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nFlaky.', comments: [] };
    const plan = land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`, { issues: [open] });
    const verdict = actionsOf(plan)[verdictIndex(plan)]!;

    expect(verdict).toMatchObject({ kind: "comment", key: "verdict" });
    expect(textOf(verdict)).toContain("An Unrelated failure, reported on #88: the booking journey fails the same way on main's head");
  });
});

describe("The check's issue for an Unrelated failure (#781)", () => {
  it("is filed when none is open, under the new title with both labels, the Reviewer's reason, mentioning nobody, and the red run's excerpt", () => {
    const plan = land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`);
    const filed = createdIn(plan);

    expect(filed).toHaveLength(1);
    const [issue] = filed;
    expect(issue).toMatchObject({ title: "Flaky check or Unrelated failure: `e2e`", labels: ["needs-triage", "fabrik:flaky-check"], parent: null, blockedBy: [] });
    expect(issue!.body.split("\n")[0]).toBe('<!-- fabrik:flaky-check-issue {"check":"e2e"} -->');
    expect(issue!.body).toContain("the Reviewer judged the pull request didn't cause it: an Unrelated failure");
    expect(issue!.body).toContain(`- #50 at ${HEAD_SHA.slice(0, 7)}: [red](${E2E_JOB})`);
    expect(issue!.body).toContain("- The Reviewer judged the pull request didn't cause it: the booking journey fails the same way on main's head, @​someone.");
    expect(issue!.body).toContain("FAIL booking.spec.ts > books a table");
    expect(issue!.body).not.toContain("tsc: Type 'Cart'");
    expect(notificationsOf(plan)).toEqual([]);
  });

  it.each([
    ["the old title, filed before the bump", '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nThe required check `e2e` reported both failure and success on the same head commit: a Flaky check.'],
    ["the new title", '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nThe required check `e2e` was still red after the Kit\'s re-run.'],
  ])("one open under %s takes a comment with the reason and the excerpt, and nothing is filed", (_, body) => {
    const open: KitIssueSnapshot = { number: 88, labels: ["needs-triage", "fabrik:flaky-check"], body, comments: [] };
    const plan = land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`, { issues: [open] });

    expect(createdIn(plan)).toEqual([]);
    const comments = actionsOf(plan).filter((action) => action.kind === "comment" && action.issue === 88);
    expect(comments).toHaveLength(1);
    expect(textOf(comments[0]!)).toMatch(
      new RegExp(`^Unrelated failure on #50 at ${HEAD_SHA.slice(0, 7)}: \\[red\\]\\(${E2E_JOB.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)\\. The Reviewer judged the pull request didn't cause it: the booking journey`),
    );
    expect(textOf(comments[0]!)).toContain("FAIL booking.spec.ts > books a table");
    expect(textOf(actionsOf(plan)[lineIndex(plan)]!)).toContain("an Unrelated failure (#88).");
  });

  it("is filed fresh once the check's issue is closed: only an open one takes the comment", () => {
    // The snapshot holds the open issues alone; a closed one for `e2e` isn't among them, and another check's open one doesn't count.
    const otherCheck: KitIssueSnapshot = { number: 12, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"unit"} -->\nFlaky.', comments: [] };
    const plan = land(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`, { issues: [otherCheck] });

    expect(createdIn(plan)).toEqual([expect.objectContaining({ title: "Flaky check or Unrelated failure: `e2e`" })]);
    expect(actionsOf(plan).some((action) => action.kind === "comment" && action.issue === 12)).toBe(false);
  });

  it("says the Kit read no excerpt when the Review read none, linking the Review's run", () => {
    const plan = planFor(reviewed(`verdict: execution-flaw\n\n- The empty cart throws.\n\n${ONE_UNRELATED}`, { redChecks: { ...RED, excerpts: [] } }), snapshotOfPullRequest(aPullRequest()), kitConfig());
    const [issue] = createdIn(plan);

    expect(issue!.body).toContain(`- #50 at ${HEAD_SHA.slice(0, 7)}: [red](${RUN})`);
    expect(issue!.body).toContain("the Kit read no Failure excerpt of this run");
  });
});
