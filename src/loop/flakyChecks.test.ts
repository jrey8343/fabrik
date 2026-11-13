import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, tickSnapshot, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, FlakyCheck, FlawHeadChecks, HeadCheckRun, KitIssueSnapshot, LoopEvent, PassedHeadChecks, Plan, RerunReport, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const E2E: FlakyCheck = { name: "e2e", red: "https://github.com/acme/shop/actions/runs/7/job/70", green: "https://github.com/acme/shop/actions/runs/7/job/99" };

function redChecks(failed: string[], rerun: RerunReport): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed, rerun, runUrl: RUN };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function verdictOf(plan: Plan): string {
  const verdict = actionsOf(plan).find((action) => action.kind === "comment" && action.body.startsWith("<!-- fabrik:verdict"));
  if (verdict?.kind !== "comment") throw new Error("no Verdict posted");
  return verdict.body;
}

/** Each comment's text, created issues written as `#new`. */
function textOf(action: Action): string {
  if (action.kind === "comment") return action.body;
  if (action.kind === "comment-linking") return action.body.map((part) => (typeof part === "string" ? part : "#new")).join("");
  return "";
}

describe("A Verdict after the Kit re-ran the red checks (#462)", () => {
  it("names the checks that failed again on a re-run of the same head, apart from the outside ones", () => {
    const plan = planFor(redChecks(["unit", "Vercel"], { outside: ["Vercel"], failedAgain: ["unit"], flaky: [], refused: null }), snapshotOfPullRequest(aPullRequest()), kitConfig());
    const verdict = verdictOf(plan);

    expect(verdict).toContain("These required checks failed again when the Kit re-ran them on the same head, so the Reviewer didn't run:\n\n- `unit`");
    expect(verdict).toContain("These required checks didn't pass and aren't GitHub Actions, so the Kit couldn't re-run them:\n\n- `Vercel`");
    expect(verdict).not.toContain("flaky");
    expect(verdict).toContain("Retry 1 of 2 starts now");
  });

  it("says why the Kit couldn't re-run them when GitHub refused", () => {
    const why = "GitHub refused the workflow token (Resource not accessible by integration). Add `actions: write` under the `loop` job's `permissions:` in `.github/workflows/fabrik.yml`";
    const plan = planFor(redChecks(["unit"], { outside: [], failedAgain: [], flaky: [], refused: why }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(verdictOf(plan)).toContain(`These required checks didn't pass, so the Reviewer didn't run:\n\n- \`unit\`\n\nThe Kit couldn't re-run them: ${why}.`);
  });

  it("records the checks it names in its marker, so a later green on the same head can count it back", () => {
    const plan = planFor(redChecks(["unit", "lint"], { outside: [], failedAgain: ["unit", "lint"], flaky: [], refused: null }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(verdictsPostedIn([verdictOf(plan)])).toEqual([expect.objectContaining({ source: "ci", checks: ["unit", "lint"] })]);
  });
});

describe("A Flaky check the Kit's re-run found (#462)", () => {
  it("is said on the PR in one line mentioning nobody, ahead of the Verdict, and filed as an issue for Triage", () => {
    const plan = planFor(redChecks(["Vercel"], { outside: ["Vercel"], failedAgain: [], flaky: [E2E], refused: null }), snapshotOfPullRequest(aPullRequest()), kitConfig());
    const actions = actionsOf(plan);
    const line = actions.findIndex((action) => textOf(action).includes("<!-- fabrik:flaky-check "));
    const verdict = actions.findIndex((action) => textOf(action).startsWith("<!-- fabrik:verdict"));

    expect(line).toBeGreaterThanOrEqual(0);
    expect(line).toBeLessThan(verdict);
    expect(textOf(actions[line]!)).toContain(`\`e2e\` failed on ${HEAD_SHA.slice(0, 7)} and passed when the Kit re-ran it on the same head: a Flaky check (#new).`);
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "create-issue",
        title: "Flaky required check: e2e",
        labels: ["needs-triage", "fabrik:flaky-check"],
        body: expect.stringContaining(`[red](${E2E.red})`),
      }),
    );
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("lets the Reviewer's Verdict land as usual, with the line and the issue", () => {
    const event: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nGood.", flaky: [E2E], runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
    // The Digest off, so the pass opens the Merge gate itself (src/loop/digestGate.test.ts has it on).
    const plan = planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig({ digest: { enabled: false } }));
    const actions = actionsOf(plan);

    expect(actions.some((action) => textOf(action).includes("<!-- fabrik:flaky-check "))).toBe(true);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "create-issue", title: "Flaky required check: e2e" }));
    expect(actions).toContainEqual(expect.objectContaining({ kind: "mark-ready-for-review", pullRequest: 50 }));
  });

  it("comments on the check's open Flaky check issue rather than filing another", () => {
    const open = { number: 88, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nFlaky.', comments: [] };
    const snapshot = { ...snapshotOfPullRequest(aPullRequest()), flakyCheckIssues: [open] };
    const actions = actionsOf(planFor(redChecks(["Vercel"], { outside: ["Vercel"], failedAgain: [], flaky: [E2E], refused: null }), snapshot, kitConfig()));

    expect(actions.some((action) => action.kind === "create-issue")).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "comment", issue: 88, body: expect.stringContaining(`[green](${E2E.green})`) }));
    expect(actions.map(textOf).find((text) => text.includes("<!-- fabrik:flaky-check "))).toContain("a Flaky check (#88).");
  });
});

describe("A Verdict counted back for a Flaky check (#462)", () => {
  it("no longer counts toward the Ticket's Retries", () => {
    const earlier = [
      { verdict: "execution-flaw" as const, source: "ci" as const, requestChanges: false, checks: ["e2e"], flaky: true as const, headSha: "b".repeat(40) },
    ];
    const plan = planFor(redChecks(["unit"], { outside: [], failedAgain: ["unit"], flaky: [], refused: null }), snapshotOfPullRequest(aPullRequest({ verdicts: earlier, pushedSinceVerdict: true })), kitConfig());

    expect(verdictOf(plan)).toContain("Retry 1 of 2 starts now");
  });
});

describe("The hourly tick's sweep for Flaky checks (#462)", () => {
  const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-11T12:17:00Z" };
  const FLAW = "b".repeat(40);
  const run = (name: string, conclusion: string | null, startedAt: string, id: number): HeadCheckRun => ({
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    startedAt,
    url: `https://github.com/acme/shop/actions/runs/7/job/${id}`,
  });
  const head = (checkRuns: HeadCheckRun[], checks = ["e2e"]): FlawHeadChecks => ({ pullRequest: 50, ticket: 7, headSha: FLAW, checks, checkRuns });
  const sweep = (heads: FlawHeadChecks[] | "no-permission") => planFor(TICK, { ...tickSnapshot(), flakySweep: heads }, kitConfig());
  const swept = (plan: Plan) => actionsOf(plan).filter((action) => action.kind !== "check-dispatch" && action.kind !== "check-design-queue");

  it("counts back a ci Verdict once every check it named reads green on its head, saying so in one line and filing the issue", () => {
    const plan = sweep([head([run("e2e", "failure", "2026-11-11T09:00:00Z", 70), run("e2e", "success", "2026-11-11T11:00:00Z", 99)])]);
    const line = swept(plan).map(textOf).find((text) => text.includes("<!-- fabrik:flaky-check "));

    expect(line).toContain(`"countedBack":true`);
    expect(line).toContain(`\`e2e\` has since passed on ${FLAW.slice(0, 7)}, where its failure gave an Execution flaw: a Flaky check, so that Verdict no longer counts toward #7's Retries (#new).`);
    expect(swept(plan)).toContainEqual(
      expect.objectContaining({
        kind: "create-issue",
        title: "Flaky required check: e2e",
        body: expect.stringContaining("[red](https://github.com/acme/shop/actions/runs/7/job/70), [green](https://github.com/acme/shop/actions/runs/7/job/99)"),
      }),
    );
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("leaves a Verdict whose checks aren't all green on its head, going by each one's latest result", () => {
    const redAgain = [run("e2e", "failure", "2026-11-11T09:00:00Z", 70), run("e2e", "success", "2026-11-11T10:00:00Z", 80), run("e2e", "failure", "2026-11-11T11:00:00Z", 90)];
    const oneOfTwo = [run("e2e", "failure", "2026-11-11T09:00:00Z", 70), run("e2e", "success", "2026-11-11T11:00:00Z", 99), run("unit", "failure", "2026-11-11T09:00:00Z", 71)];

    expect(swept(sweep([head(redAgain)]))).toEqual([]);
    expect(swept(sweep([head(oneOfTwo, ["e2e", "unit"])]))).toEqual([]);
    expect(swept(sweep([head([run("e2e", null, "2026-11-11T11:00:00Z", 99)])]))).toEqual([]);
  });

  it("is quiet when the Fabrik App can't read check runs", () => {
    expect(swept(sweep("no-permission"))).toEqual([]);
  });
});

describe("The hourly tick's read of each passed head at the Merge gate (#693)", () => {
  const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-11T12:17:00Z" };
  const PASSED = "c".repeat(40);
  const short = PASSED.slice(0, 7);
  const run = (name: string, conclusion: string | null, startedAt: string, id: number): HeadCheckRun => ({
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    startedAt,
    url: `https://github.com/acme/shop/actions/runs/7/job/${id}`,
  });
  const greenThenRed = [run("ci", "success", "2026-11-11T09:00:00Z", 70), run("ci", "failure", "2026-11-11T11:00:00Z", 99)];
  const head = (checkRuns: HeadCheckRun[], overrides: Partial<PassedHeadChecks> = {}): PassedHeadChecks => ({
    pullRequest: 50,
    ticket: 7,
    headSha: PASSED,
    required: ["ci"],
    checkRuns,
    marks: [],
    ...overrides,
  });
  const read = (heads: Snapshot["passedHeads"], flakySweep: Snapshot["flakySweep"] = [], flakyCheckIssues: KitIssueSnapshot[] = []) =>
    planFor(TICK, { ...tickSnapshot(), flakySweep, passedHeads: heads, flakyCheckIssues }, kitConfig());
  const swept = (plan: Plan) => (plan.kind === "act" ? plan.actions : []).filter((action) => action.kind !== "check-dispatch" && action.kind !== "check-design-queue");
  const lines = (plan: Plan) => swept(plan).map(textOf).filter((text) => text.includes("<!-- fabrik:flaky-check "));

  it("reports a Required check that passed then failed on the passed head: one line on the PR and a filed issue", () => {
    const plan = read([head(greenThenRed)]);

    expect(lines(plan)).toEqual([
      `<!-- fabrik:flaky-check {"headSha":"${PASSED}","checks":["ci"]} -->\n\`ci\` has both failed and passed on ${short}, the head the Reviewer passed: a Flaky check (#new).`,
    ]);
    expect(swept(plan)).toContainEqual(
      expect.objectContaining({
        kind: "create-issue",
        title: "Flaky required check: ci",
        labels: ["needs-triage", "fabrik:flaky-check"],
        body: expect.stringContaining("[red](https://github.com/acme/shop/actions/runs/7/job/99), [green](https://github.com/acme/shop/actions/runs/7/job/70)"),
      }),
    );
    expect(swept(plan).find((action) => action.kind === "comment-linking")).toMatchObject({ issue: 50 });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reports one whose failure came before its pass, the same way", () => {
    const redThenGreen = [run("ci", "failure", "2026-11-11T09:00:00Z", 70), run("ci", "success", "2026-11-11T11:00:00Z", 99)];

    expect(lines(read([head(redThenGreen)]))).toEqual([expect.stringContaining(`\`ci\` has both failed and passed on ${short}, the head the Reviewer passed`)]);
  });

  it("comments on the check's open Flaky check issue rather than filing another", () => {
    const open = { number: 88, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"ci"} -->\nFlaky.', comments: [] };
    const plan = read([head(greenThenRed)], [], [open]);

    expect(swept(plan).some((action) => action.kind === "create-issue")).toBe(false);
    expect(swept(plan)).toContainEqual(expect.objectContaining({ kind: "comment", issue: 88, body: expect.stringContaining(`#50 at ${short}`) }));
    expect(lines(plan)).toEqual([expect.stringContaining("a Flaky check (#88).")]);
  });

  it.each([
    ["this read's own earlier line", { headSha: PASSED, checks: ["ci"] }],
    ["the Kit's re-run line from the Review", { headSha: PASSED, checks: ["e2e", "ci"] }],
    ["a count-back line", { headSha: PASSED, checks: ["ci"], countedBack: true as const }],
  ])("says nothing of a check on a head %s already names", (_, mark) => {
    expect(swept(read([head(greenThenRed, { marks: [mark] })]))).toEqual([]);
  });

  it("still reports a check a line names on another head", () => {
    expect(lines(read([head(greenThenRed, { marks: [{ headSha: "d".repeat(40), checks: ["ci"] }] })]))).toHaveLength(1);
  });

  it("says nothing of a check that went green only by being skipped or neutral", () => {
    const skipped = [run("ci", "skipped", "2026-11-11T09:00:00Z", 70), run("ci", "failure", "2026-11-11T11:00:00Z", 99)];
    const neutral = [run("ci", "neutral", "2026-11-11T09:00:00Z", 70), run("ci", "failure", "2026-11-11T11:00:00Z", 99)];

    expect(swept(read([head(skipped), head(neutral, { pullRequest: 51 })]))).toEqual([]);
  });

  it("says nothing of a check the branch doesn't require, however it flaked", () => {
    expect(swept(read([head(greenThenRed, { required: ["lint"] })]))).toEqual([]);
  });

  it.each(["no-permission", "branch-unread"] as const)("is quiet when the read is %s", (heads) => {
    expect(swept(read(heads))).toEqual([]);
  });

  it("files one issue for a check flaking on two PRs in one tick, which both lines link", () => {
    const plan = read([head(greenThenRed), head(greenThenRed, { pullRequest: 51, ticket: 8 })]);
    const linking = swept(plan).filter((action) => action.kind === "comment-linking");

    expect(swept(plan).filter((action) => action.kind === "create-issue")).toHaveLength(1);
    expect(linking.map((action) => action.kind === "comment-linking" && action.issue)).toEqual([50, 51]);
    expect(linking.map((action) => action.kind === "comment-linking" && action.body.find((part) => typeof part !== "string"))).toEqual([
      { created: expect.any(String) },
      { created: expect.any(String) },
    ]);
  });

  it("moves nothing else: no Verdict, label, draft, Review or notification", () => {
    const kinds = swept(read([head(greenThenRed)])).map((action) => action.kind);

    expect(new Set(kinds)).toEqual(new Set(["create-issue", "comment-linking"]));
  });

  it("leaves the count-back sweep as it was, and says a check it counts back on that head once", () => {
    const flaw: FlawHeadChecks = { pullRequest: 50, ticket: 7, headSha: PASSED, checks: ["ci"], checkRuns: [run("ci", "failure", "2026-11-11T09:00:00Z", 70), run("ci", "success", "2026-11-11T11:00:00Z", 99)] };
    const plan = read([head(flaw.checkRuns as HeadCheckRun[])], [flaw]);

    expect(lines(plan)).toEqual([expect.stringContaining('"countedBack":true')]);
    expect(swept(plan).filter((action) => action.kind === "create-issue")).toHaveLength(1);
  });
});
