import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, tickSnapshot, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { uncountedFlaws } from "./flakyChecks.ts";
import type { FailureExcerpt } from "../review/failureExcerpt.ts";
import { planFor } from "./rules.ts";
import type { Action, FlakyCheck, FlawHeadChecks, HeadCheckRun, KitIssueSnapshot, LoopEvent, PassedHeadChecks, Plan, PullRequestSnapshot, RerunReport, Snapshot, VerdictRecord } from "./types.ts";

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

    const verdict = verdictOf(plan);
    expect(verdict).toContain("These required checks didn't pass, so the Reviewer didn't run:\n\n- `unit`\n\n");
    // After the checks and their excerpts (#775), out of the list.
    expect(verdict).toMatch(new RegExp(`\\n\\nThe Kit couldn't re-run them: ${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
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
        title: "Flaky check or Unrelated failure: `e2e`",
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
    expect(actions).toContainEqual(expect.objectContaining({ kind: "create-issue", title: "Flaky check or Unrelated failure: `e2e`" }));
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
  const head = (checkRuns: HeadCheckRun[], checks = ["e2e"]): FlawHeadChecks => ({ pullRequest: 50, ticket: 7, headSha: FLAW, checks, checkRuns, excerpts: [] });
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
        title: "Flaky check or Unrelated failure: `e2e`",
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

// #779: a Reviewer's Verdict on a red head names its red checks too, so the sweep reads every Execution flaw that names
// checks, whatever its source. One with no untagged finding counted only for its checks, and is counted back as a
// red-checks Verdict is; one with an untagged finding counts for that, so its checks are reported and the count stands.
describe("The hourly tick's sweep of a Reviewer's Execution flaw on a red head (#779)", () => {
  const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-11T12:17:00Z" };
  const FLAW = "b".repeat(40);
  const flipped: HeadCheckRun[] = [
    { name: "e2e", status: "completed", conclusion: "failure", startedAt: "2026-11-11T09:00:00Z", url: E2E.red },
    { name: "e2e", status: "completed", conclusion: "success", startedAt: "2026-11-11T11:00:00Z", url: E2E.green },
  ];
  const reviewerFlaw = (counted: number, overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({
    verdict: "execution-flaw",
    source: "reviewer",
    requestChanges: false,
    checks: ["e2e"],
    tags: { small: 1, missedEarlier: 0, counted, smallBody: 0 },
    headSha: FLAW,
    ...overrides,
  });
  /** The sweep of this PR's flaws, each read as the Tick's gatherer reads it, with these check runs on its head. */
  const sweepOf = (pullRequest: PullRequestSnapshot) =>
    planFor(TICK, { ...tickSnapshot(), flakySweep: uncountedFlaws(pullRequest).map((flaw) => ({ ...flaw, checkRuns: flipped, excerpts: [] })) }, kitConfig());
  const lineOf = (plan: Plan) => actionsOf(plan).map(textOf).find((text) => text.includes("<!-- fabrik:flaky-check "));

  it("reads every Execution flaw that names checks, whatever its source, and no other Verdict", () => {
    const pullRequest = aPullRequest({
      verdicts: [
        { verdict: "execution-flaw", source: "ci", requestChanges: false, checks: ["unit"], headSha: "1".repeat(40) },
        reviewerFlaw(0),
        reviewerFlaw(1, { headSha: "2".repeat(40) }),
        { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "3".repeat(40) },
        { verdict: "design-flaw", source: "reviewer", requestChanges: false, checks: ["e2e"], headSha: "4".repeat(40) },
      ],
    });

    expect(uncountedFlaws(pullRequest)).toEqual([
      { pullRequest: 50, ticket: 7, headSha: "1".repeat(40), checks: ["unit"] },
      { pullRequest: 50, ticket: 7, headSha: FLAW, checks: ["e2e"] },
      { pullRequest: 50, ticket: 7, headSha: "2".repeat(40), checks: ["e2e"], untaggedFinding: true },
    ]);
  });

  it("counts back a Reviewer's flaw with no untagged finding once every check it named reads green on its head", () => {
    const line = lineOf(sweepOf(aPullRequest({ verdicts: [reviewerFlaw(0)] })));

    expect(line).toContain(`"countedBack":true`);
    expect(line).toContain("so that Verdict no longer counts toward #7's Retries");
  });

  it("counts back a pass a red check made a flaw, which has no finding of its own", () => {
    const line = lineOf(sweepOf(aPullRequest({ verdicts: [reviewerFlaw(0, { tags: { small: 0, missedEarlier: 0, counted: 0, smallBody: 0 } })] })));

    expect(line).toContain(`"countedBack":true`);
  });

  it("reports the checks of one with an untagged finding as Flaky checks, filing their issue, and the count stands", () => {
    const plan = sweepOf(aPullRequest({ verdicts: [reviewerFlaw(1)] }));
    const line = lineOf(plan);

    expect(line).not.toContain("countedBack");
    expect(line).toContain(`"checks":["e2e"]`);
    expect(line).toContain("`e2e` has since passed on bbbbbbb");
    expect(line).toContain("a Flaky check (#new)");
    expect(line).toContain("still counts");
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "create-issue" }));
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reports them once: a line naming the flaw's checks on its head leaves it out of the next sweep", () => {
    const pullRequest = aPullRequest({ verdicts: [reviewerFlaw(1)], flakyCheckMarks: [{ headSha: FLAW, checks: ["e2e"] }] });

    expect(uncountedFlaws(pullRequest)).toEqual([]);
    // A line on the head naming other checks, as the Kit's re-run's, leaves it in.
    expect(uncountedFlaws(aPullRequest({ verdicts: [reviewerFlaw(1)], flakyCheckMarks: [{ headSha: FLAW, checks: ["lint"] }] }))).toHaveLength(1);
  });

  it("a Reviewer's flaw a later green counted back no longer counts toward the Retries", () => {
    const counted = reviewerFlaw(0, { flaky: true });
    const plan = planFor(
      { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: execution-flaw\n\n- A bug.", runUrl: RUN, repoUrl: "https://github.com/acme/shop" },
      snapshotOfPullRequest(aPullRequest({ verdicts: [counted], pushedSinceVerdict: true })),
      kitConfig(),
    );

    expect(verdictOf(plan)).toContain("Retry 1 of 2 starts now");
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
    excerpts: [],
    ...overrides,
  });
  const read = (heads: Snapshot["passedHeads"], flakySweep: Snapshot["flakySweep"] = [], flakyCheckIssues: KitIssueSnapshot[] = []) =>
    planFor(TICK, { ...tickSnapshot(), flakySweep, passedHeads: heads, flakyCheckIssues }, kitConfig());
  const swept = (plan: Plan) => (plan.kind === "act" ? plan.actions : []).filter((action) => action.kind !== "check-dispatch" && action.kind !== "check-design-queue");
  const lines = (plan: Plan) => swept(plan).map(textOf).filter((text) => text.includes("<!-- fabrik:flaky-check "));

  it("reports a Required check that succeeded then failed on the passed head: one line on the PR and a filed issue", () => {
    const plan = read([head(greenThenRed)]);

    expect(lines(plan)).toEqual([
      `<!-- fabrik:flaky-check {"headSha":"${PASSED}","checks":["ci"]} -->\n\`ci\` has both failed and succeeded on ${short}, the head the Reviewer passed: a Flaky check (#new).`,
    ]);
    expect(swept(plan)).toContainEqual(
      expect.objectContaining({
        kind: "create-issue",
        title: "Flaky check or Unrelated failure: `ci`",
        labels: ["needs-triage", "fabrik:flaky-check"],
        body: expect.stringContaining("[red](https://github.com/acme/shop/actions/runs/7/job/99), [green](https://github.com/acme/shop/actions/runs/7/job/70)"),
      }),
    );
    expect(swept(plan).find((action) => action.kind === "comment-linking")).toMatchObject({ issue: 50 });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reports one whose failure came before its success, the same way", () => {
    const redThenGreen = [run("ci", "failure", "2026-11-11T09:00:00Z", 70), run("ci", "success", "2026-11-11T11:00:00Z", 99)];

    expect(lines(read([head(redThenGreen)]))).toEqual([expect.stringContaining(`\`ci\` has both failed and succeeded on ${short}, the head the Reviewer passed`)]);
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

  it("says nothing of a check that passed only by being skipped or neutral", () => {
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

  it("files a separate issue for each check when the count-back sweep and this read each find one on the same head", () => {
    const flaw: FlawHeadChecks = { pullRequest: 50, ticket: 7, headSha: PASSED, checks: ["e2e"], checkRuns: [run("e2e", "failure", "2026-11-11T09:00:00Z", 60), run("e2e", "success", "2026-11-11T10:00:00Z", 61)], excerpts: [] };
    const created = swept(read([head(greenThenRed)], [flaw])).flatMap((action) => (action.kind === "create-issue" ? [action.key] : []));

    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
  });

  it("leaves the count-back sweep as it was, and says a check it counts back on that head once", () => {
    const flaw: FlawHeadChecks = { pullRequest: 50, ticket: 7, headSha: PASSED, checks: ["ci"], checkRuns: [run("ci", "failure", "2026-11-11T09:00:00Z", 70), run("ci", "success", "2026-11-11T11:00:00Z", 99)], excerpts: [] };
    const plan = read([head(flaw.checkRuns as HeadCheckRun[])], [flaw]);

    expect(lines(plan)).toEqual([expect.stringContaining('"countedBack":true')]);
    expect(swept(plan).filter((action) => action.kind === "create-issue")).toHaveLength(1);
  });
});

describe("A Flaky check's issue carries the Failure excerpt of each red run it reports (#778)", () => {
  const excerpt = (check: string, link: string, line: string): FailureExcerpt => ({
    kind: "actions",
    check,
    link,
    steps: [{ name: "Run pnpm test", earlier: 0, lines: [line, "##[error]Process completed with exit code 1."] }],
    annotations: [{ path: "src/a.test.ts", line: 12, message: "AssertionError: expected 3 to be 4" }],
  });
  const created = (plan: Plan) => actionsOf(plan).flatMap((action) => (action.kind === "create-issue" ? [action] : []));
  /** A rendered excerpt's opening: the check and its job, the failed step, and the line its log ends on before the exit code. */
  const rendered = (check: string, link: string, line: string) =>
    [`- \`${check}\` ([the job](${link}))`, "", "  The step `Run pnpm test` failed. The end of its log:", "", "  ```text", `  ${line}`, "  ##[error]Process completed with exit code 1.", "  ```"].join("\n");

  it("files a check the Kit's re-run turned green with its first attempt's excerpt in the body, after the pull request, head and run links", () => {
    const flaky: FlakyCheck = { ...E2E, excerpt: excerpt("e2e", E2E.red, "FAIL src/a.test.ts > adds") };
    const event: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nGood.", flaky: [flaky], runUrl: RUN, repoUrl: "https://github.com/acme/shop" };

    const [issue] = created(planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig()));

    expect(issue).toMatchObject({ title: "Flaky check or Unrelated failure: `e2e`", labels: ["needs-triage", "fabrik:flaky-check"] });
    expect(issue?.body).toContain(`- #50 at ${HEAD_SHA.slice(0, 7)}: [red](${E2E.red}), [green](${E2E.green})`);
    expect(issue?.body).toContain(rendered("e2e", E2E.red, "FAIL src/a.test.ts > adds"));
    expect(issue?.body).toContain("  - `src/a.test.ts`, line 12:");
    expect(issue?.body.indexOf("[red](")).toBeLessThan(issue?.body.indexOf("([the job](") ?? -1);
  });

  it("comments on the check's open issue with that red run's excerpt when it's flaky again on another pull request", () => {
    const open = { number: 88, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nFlaky.', comments: [] };
    const snapshot = { ...snapshotOfPullRequest(aPullRequest({ number: 61 })), flakyCheckIssues: [open] };
    const flaky: FlakyCheck = { ...E2E, excerpt: excerpt("e2e", E2E.red, "FAIL src/b.test.ts > times out") };
    const event: LoopEvent = { kind: "required-checks-finished", pullRequest: 61, headSha: HEAD_SHA, failed: ["Vercel"], rerun: { outside: ["Vercel"], failedAgain: [], flaky: [flaky], refused: null }, runUrl: RUN };

    const actions = actionsOf(planFor(event, snapshot, kitConfig()));

    expect(created(planFor(event, snapshot, kitConfig()))).toEqual([]);
    const comment = actions.find((action) => action.kind === "comment" && action.issue === 88);
    expect(textOf(comment!)).toMatch(new RegExp(`^Flaky again on #61 at ${HEAD_SHA.slice(0, 7)}: \\[red\\]\\(${E2E.red}\\), \\[green\\]\\(${E2E.green}\\)\\.\\n\\n`));
    expect(textOf(comment!)).toContain(rendered("e2e", E2E.red, "FAIL src/b.test.ts > times out"));
  });

  it.each([
    ["one that couldn't be read", { kind: "unread", check: "e2e", link: E2E.red, why: "the job never started, so it left no log and no annotation" } as FailureExcerpt, "the job never started, so it left no log and no annotation"],
    ["none at all, as when the Review's artifact is missing", undefined, "the Kit read no Failure excerpt of this run"],
  ])("still files the issue when the red run has %s, saying why and keeping the run's link", (_, excerpt, why) => {
    const flaky: FlakyCheck = excerpt === undefined ? E2E : { ...E2E, excerpt };
    const plan = planFor(redChecks(["Vercel"], { outside: ["Vercel"], failedAgain: [], flaky: [flaky], refused: null }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    const [issue] = created(plan);
    expect(issue?.body).toContain(`- \`e2e\` ([the job](${E2E.red}))\n\n  Its failure couldn't be read: ${why}.`);
    expect(issue?.body).toContain(`[red](${E2E.red})`);
  });

  it("holds the log to the module's cap, and never passes GitHub's limit in the body or a comment, however much the run's annotations hold", () => {
    const huge: FailureExcerpt = {
      kind: "actions",
      check: "e2e",
      link: E2E.red,
      steps: [{ name: "Run pnpm test", earlier: 0, lines: Array.from({ length: 150 }, (_, i) => `${i}`.padEnd(400, "x")) }],
      annotations: Array.from({ length: 20 }, (_, line) => ({ path: "src/a.test.ts", line, message: "m".repeat(4_096) })),
    };
    const open = { number: 88, labels: ["fabrik:flaky-check"], body: '<!-- fabrik:flaky-check-issue {"check":"e2e"} -->\nFlaky.', comments: [] };
    const filed = planFor(redChecks(["Vercel"], { outside: ["Vercel"], failedAgain: [], flaky: [{ ...E2E, excerpt: huge }], refused: null }), snapshotOfPullRequest(aPullRequest()), kitConfig());
    const commented = planFor(
      redChecks(["Vercel"], { outside: ["Vercel"], failedAgain: [], flaky: [{ ...E2E, excerpt: huge }], refused: null }),
      { ...snapshotOfPullRequest(aPullRequest()), flakyCheckIssues: [open] },
      kitConfig(),
    );

    const body = created(filed)[0]!.body;
    const comment = textOf(actionsOf(commented).find((action) => action.kind === "comment" && action.issue === 88)!);
    for (const text of [body, comment]) {
      expect(text.length).toBeLessThanOrEqual(65_536);
      expect(text).toContain("_Shortened to fit the comment._");
      expect(text).toContain(`[red](${E2E.red})`);
    }
  });

  describe("found by the tick", () => {
    const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-11T12:17:00Z" };
    const HEAD = "c".repeat(40);
    const job = (id: number) => `https://github.com/acme/shop/actions/runs/7/job/${id}`;
    const run = (name: string, conclusion: string, startedAt: string, id: number): HeadCheckRun => ({ name, status: "completed", conclusion, startedAt, url: job(id) });
    const redThenGreen = (name: string) => [run(name, "failure", "2026-11-11T09:00:00Z", 70), run(name, "success", "2026-11-11T11:00:00Z", 99)];
    const flaw = (excerpts: FailureExcerpt[], overrides: Partial<FlawHeadChecks> = {}): FlawHeadChecks => ({
      pullRequest: 50,
      ticket: 7,
      headSha: HEAD,
      checks: ["e2e"],
      checkRuns: redThenGreen("e2e"),
      excerpts,
      ...overrides,
    });
    const passed = (excerpts: FailureExcerpt[], overrides: Partial<PassedHeadChecks> = {}): PassedHeadChecks => ({
      pullRequest: 50,
      ticket: 7,
      headSha: HEAD,
      required: ["ci"],
      checkRuns: redThenGreen("ci"),
      marks: [],
      excerpts,
      ...overrides,
    });
    const tick = (flakySweep: Snapshot["flakySweep"], passedHeads: Snapshot["passedHeads"], flakyCheckIssues: KitIssueSnapshot[] = []) =>
      planFor(TICK, { ...tickSnapshot(), flakySweep, passedHeads, flakyCheckIssues }, kitConfig());

    it("carries the red run's excerpt for a Flaky check on a counted-back Verdict", () => {
      const [issue] = created(tick([flaw([excerpt("e2e", job(70), "FAIL src/e2e.test.ts > logs in")])], []));

      expect(issue?.body).toContain(rendered("e2e", job(70), "FAIL src/e2e.test.ts > logs in"));
    });

    it("carries the red run's excerpt for a Flaky check on a passed head at the Merge gate", () => {
      const [issue] = created(tick([], [passed([excerpt("ci", job(70), "FAIL src/ci.test.ts > builds")])]));

      expect(issue?.body).toContain(rendered("ci", job(70), "FAIL src/ci.test.ts > builds"));
    });

    it("says why when the tick read no excerpt of the red run, keeping its link", () => {
      const [issue] = created(tick([], [passed([])]));

      expect(issue?.body).toContain(`- \`ci\` ([the job](${job(70)}))\n\n  Its failure couldn't be read: the Kit read no Failure excerpt of this run.`);
    });

    it("shares one new issue between two pull requests reporting the same check: its body holds the first's excerpt, and a comment on it the second's", () => {
      const plan = tick(
        [],
        [
          passed([excerpt("ci", job(70), "FAIL first")]),
          passed([excerpt("ci", job(170), "FAIL second")], { pullRequest: 51, ticket: 8, headSha: "d".repeat(40), checkRuns: [run("ci", "failure", "2026-11-11T09:00:00Z", 170), run("ci", "success", "2026-11-11T11:00:00Z", 199)] }),
        ],
      );
      const issues = created(plan);
      const onIt = actionsOf(plan).filter((action) => action.kind === "comment-on-created");

      expect(issues).toHaveLength(1);
      expect(issues[0]?.body).toContain(rendered("ci", job(70), "FAIL first"));
      expect(issues[0]?.body).not.toContain("FAIL second");
      expect(onIt).toEqual([{ kind: "comment-on-created", on: { created: issues[0]!.key }, body: expect.stringContaining(`Flaky again on #51 at ddddddd: [red](${job(170)}), [green](${job(199)}).`) }]);
      expect(onIt[0]?.kind === "comment-on-created" && onIt[0].body).toContain(rendered("ci", job(170), "FAIL second"));
      expect(actionsOf(plan).findIndex((action) => action.kind === "create-issue")).toBeLessThan(actionsOf(plan).findIndex((action) => action.kind === "comment-on-created"));
      expect(notificationsOf(plan)).toEqual([]);
    });
  });
});
