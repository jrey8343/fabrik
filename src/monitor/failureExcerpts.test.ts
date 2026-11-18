// The Monitor's issues carry a Failure excerpt for each failed run their block
// names (#786): which runs a plan asks an excerpt for, and the block it
// writes once they're read.
import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { aMonitorIssue } from "../__fixtures__/monitor.ts";
import { aCheckRun, aCommit, aRedMainBody, aRedMainIssue, commitUrl, RED_DETAILS, redMainInput, runUrl } from "../__fixtures__/redMain.ts";
import type { FailureExcerpt } from "../review/failureExcerpt.ts";
import { type MonitorInput, monitorPlanFor, runsNeedingExcerpt } from "./core.ts";
import { monitorBlockIn, type MonitorIssue } from "./issues.ts";
import type { MainCommit } from "./redMain.ts";

/** The commit aRedMainIssue() names, its `test` check failed in run 901. */
const RED = "badc0de4a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** A later commit that's red too. */
const STILL_RED = "dead0004a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** `test` failed at its `Test` step, with two log lines and one error annotation. */
function testFailed(id: number): FailureExcerpt {
  return {
    kind: "actions",
    check: "test",
    link: runUrl(id),
    steps: [{ name: "Test", lines: ["FAIL src/a.test.ts > adds", "Expected 2, got 3"], earlier: 0 }],
    annotations: [{ path: "src/a.test.ts", line: 3, message: "Expected 2, got 3" }],
  };
}

/** What the block shows for testFailed(id), under the check's name. */
function testFailedLines(id: number): string[] {
  return [
    `- \`test\` ([the job](${runUrl(id)}))`,
    "",
    "  The step `Test` failed. The end of its log:",
    "",
    "  ```text",
    "  FAIL src/a.test.ts > adds",
    "  Expected 2, got 3",
    "  ```",
    "",
    "  Its error annotations:",
    "",
    "  - `src/a.test.ts`, line 3:",
    "",
    "    ```text",
    "    Expected 2, got 3",
    "    ```",
  ];
}

/** An excerpt that couldn't be read, for check `e2e`'s run 903. */
const E2E_UNREAD: FailureExcerpt = { kind: "unread", check: "e2e", link: runUrl(903), why: "the job never started, so it left no log and no annotation" };

const failedAt = (sha: string, ...runs: readonly [number, string][]): MainCommit =>
  aCommit(
    sha,
    runs.map(([id, name]) => aCheckRun({ id, name, conclusion: "failure" })),
  );

const withExcerpts = (input: MonitorInput, ...excerpts: readonly [number, FailureExcerpt][]): MonitorInput => ({ ...input, excerpts: new Map(excerpts) });

describe("Red main's Failure excerpts", () => {
  it("asks for the excerpt of each failed check the issue it files names, and nothing else", () => {
    const commit = aCommit(RED, [
      aCheckRun({ id: 901, name: "test", conclusion: "failure" }),
      aCheckRun({ id: 902, name: "build", conclusion: "success" }),
      aCheckRun({ id: 903, name: "e2e", conclusion: "timed_out" }),
    ]);

    expect(runsNeedingExcerpt(monitorPlanFor(redMainInput([commit])))).toEqual([
      { id: 903, name: "e2e", link: runUrl(903), sha: RED },
      { id: 901, name: "test", link: runUrl(901), sha: RED },
    ]);
  });

  it("files the red-main issue with each failed check's excerpt in its Monitor block, under its name, after the details", () => {
    const input = withExcerpts(redMainInput([failedAt(RED, [901, "test"], [903, "e2e"])]), [901, testFailed(901)], [903, E2E_UNREAD]);

    const [filed] = monitorPlanFor(input).open;

    expect(monitorBlockIn(filed?.body ?? "")).toEqual([
      `- Red at: [\`badc0de\`](${commitUrl(RED)})`,
      "- Failed checks:",
      `  - [\`e2e\`](${runUrl(903)}) failed`,
      `  - [\`test\`](${runUrl(901)}) failed`,
      "",
      "Each failed check's Failure excerpt:",
      "",
      `- \`e2e\` ([the job](${runUrl(903)}))`,
      "",
      "  Its failure couldn't be read: the job never started, so it left no log and no annotation.",
      "",
      ...testFailedLines(901),
    ]);
  });
});

describe("Red main's Failure excerpts, on a red-main issue already open", () => {
  /** aRedMainIssue()'s block as the Monitor wrote it with testFailed(901)'s excerpt. */
  const withExcerpt = aRedMainIssue({
    body: aRedMainBody([...RED_DETAILS, "", "Each failed check's Failure excerpt:", "", ...testFailedLines(901)]),
  });

  it("rewrites a block for a newer red commit with that commit's excerpt in place of the old one, asking for it alone", () => {
    const input = redMainInput([failedAt(STILL_RED, [912, "test"]), failedAt(RED, [901, "test"])], { issues: [withExcerpt] });

    expect(runsNeedingExcerpt(monitorPlanFor(input))).toEqual([{ id: 912, name: "test", link: runUrl(912), sha: STILL_RED }]);
    const [rewrite] = monitorPlanFor(withExcerpts(input, [912, testFailed(912)])).rewrite;
    expect(rewrite?.body).toBe(
      aRedMainBody([
        `- Red at: [\`dead000\`](${commitUrl(STILL_RED)})`,
        "- Failed checks:",
        `  - [\`test\`](${runUrl(912)}) failed`,
        "",
        "Each failed check's Failure excerpt:",
        "",
        ...testFailedLines(912),
      ]),
    );
  });

  it.each([
    ["its details and their excerpt", withExcerpt],
    ["its details alone, as the Monitor wrote them before it carried excerpts", aRedMainIssue()],
  ])("leaves a block naming the red commit's details alone, holding %s, and asks for no excerpt", (_holding, issue) => {
    const input = redMainInput([failedAt(RED, [901, "test"])], { issues: [issue] });
    const plan = monitorPlanFor(input);

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(runsNeedingExcerpt(plan)).toEqual([]);
    expect(monitorPlanFor(withExcerpts(input, [901, testFailed(901)])).rewrite).toEqual([]);
  });
});

describe("A Tick that names nothing new", () => {
  it.each([
    [
      "the default branch green, closing the open red-main issue",
      redMainInput([aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "success" })])], { issues: [aRedMainIssue()] }),
    ],
    [
      "the red-main issue's close held",
      redMainInput([failedAt(RED, [901, "test"])], {
        issues: [aRedMainIssue({ open: false, stateReason: "completed", closedAt: "2026-11-06T08:00:00Z" })],
      }),
    ],
    [
      "`monitor.red_main` off",
      redMainInput([failedAt(RED, [901, "test"])], { monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: false }, mainChecks: null }),
    ],
  ])("asks for no excerpt with %s", (_with, input) => {
    expect(runsNeedingExcerpt(monitorPlanFor(input))).toEqual([]);
  });
});

describe("A Main check's Failure excerpt", () => {
  const mainChecksInput = (commits: readonly MainCommit[], overrides: Partial<MonitorInput> = {}): MonitorInput =>
    redMainInput(commits, { monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: true, mainChecks: ["deploy"] }, listedChecks: ["test"], ...overrides });
  const deployFailed = (id: number): FailureExcerpt => ({ ...testFailed(id), check: "deploy" });
  const deployLines = (id: number) => [`- \`deploy\` ([the job](${runUrl(id)}))`, ...testFailedLines(id).slice(1)];

  it("files the deploy issue with the excerpt of the failed run it names", () => {
    const input = mainChecksInput([failedAt(RED, [902, "deploy"])]);

    expect(runsNeedingExcerpt(monitorPlanFor(input))).toEqual([{ id: 902, name: "deploy", link: runUrl(902), sha: RED }]);
    const [filed] = monitorPlanFor(withExcerpts(input, [902, deployFailed(902)])).open;
    expect(monitorBlockIn(filed?.body ?? "")).toEqual([
      `- Red at: [\`badc0de\`](${commitUrl(RED)})`,
      "- Failed checks:",
      `  - [\`deploy\`](${runUrl(902)}) failed`,
      "",
      "Each failed check's Failure excerpt:",
      "",
      ...deployLines(902),
    ]);
  });

  it('files a "Still failing after" issue with the excerpt of its own run, not the closed issue\'s', () => {
    const [closed] = monitorPlanFor(withExcerpts(mainChecksInput([failedAt(RED, [902, "deploy"])]), [902, deployFailed(902)])).open;
    const closedAsFixed = aMonitorIssue({ number: 50, open: false, stateReason: "completed", closedAt: "2026-11-06T08:00:00Z", body: closed?.body ?? "" });
    const input = mainChecksInput([failedAt(STILL_RED, [922, "deploy"]), failedAt(RED, [902, "deploy"])], { issues: [closedAsFixed] });

    expect(runsNeedingExcerpt(monitorPlanFor(input))).toEqual([{ id: 922, name: "deploy", link: runUrl(922), sha: STILL_RED }]);
    const [filed] = monitorPlanFor(withExcerpts(input, [922, deployFailed(922)])).open;
    expect(filed?.body).toContain("Still failing after #50");
    expect(monitorBlockIn(filed?.body ?? "")?.slice(3)).toEqual(["", "Each failed check's Failure excerpt:", "", ...deployLines(922)]);
  });

  it("rewrites the open deploy issue for a newer red commit with that commit's excerpt", () => {
    const [filed] = monitorPlanFor(withExcerpts(mainChecksInput([failedAt(RED, [902, "deploy"])]), [902, deployFailed(902)])).open;
    const open: MonitorIssue = aMonitorIssue({ number: 50, body: filed?.body ?? "" });
    const input = mainChecksInput([failedAt(STILL_RED, [922, "deploy"]), failedAt(RED, [902, "deploy"])], { issues: [open] });

    expect(runsNeedingExcerpt(monitorPlanFor(input))).toEqual([{ id: 922, name: "deploy", link: runUrl(922), sha: STILL_RED }]);
    const [rewrite] = monitorPlanFor(withExcerpts(input, [922, deployFailed(922)])).rewrite;
    expect(monitorBlockIn(rewrite?.body ?? "")?.slice(3)).toEqual(["", "Each failed check's Failure excerpt:", "", ...deployLines(922)]);
  });

  it("says why a failure couldn't be read, under the check's name with its run link", () => {
    const refused = "GitHub refused the read: GET /repos/acme/clinic/actions/jobs/902 failed with 403: Resource not accessible by integration";
    const why: FailureExcerpt = { kind: "unread", check: "deploy", link: runUrl(902), why: refused };
    const [filed] = monitorPlanFor(withExcerpts(mainChecksInput([failedAt(RED, [902, "deploy"])]), [902, why])).open;

    expect(monitorBlockIn(filed?.body ?? "")?.slice(3)).toEqual([
      "",
      "Each failed check's Failure excerpt:",
      "",
      `- \`deploy\` ([the job](${runUrl(902)}))`,
      "",
      `  Its failure couldn't be read: ${refused}.`,
    ]);
  });
});

describe("A Monitor issue's body with Failure excerpts", () => {
  /** GitHub's limit on an issue's body. */
  const LIMIT = 65_536;
  /** An excerpt whose log lines fill the cap and whose annotation alone passes GitHub's limit. */
  const huge = (id: number, check: string): FailureExcerpt => ({
    kind: "actions",
    check,
    link: runUrl(id),
    steps: [{ name: "Test", lines: Array.from({ length: 150 }, (_, i) => `line ${i} `.padEnd(300, "x")), earlier: 0 }],
    annotations: [{ path: "src/a.ts", line: 1, message: "y".repeat(70_000) }],
  });

  it("files a red-main issue cut until it fits GitHub's limit, saying so", () => {
    const input = withExcerpts(redMainInput([failedAt(RED, [901, "test"], [903, "e2e"])]), [901, huge(901, "test")], [903, huge(903, "e2e")]);
    const [filed] = monitorPlanFor(input).open;

    expect(filed?.body.length).toBeLessThanOrEqual(LIMIT);
    expect(filed?.body.length).toBeGreaterThan(LIMIT - 1_000);
    expect(filed?.body).toContain("_Shortened to fit GitHub's size limit._");
    expect(filed?.body).not.toContain("fit the comment");
    expect(filed?.body).toContain(`- \`e2e\` ([the job](${runUrl(903)}))`);
  });

  it("rewrites a block cut to fit what the rest of the body leaves, Windows line endings and Triage's notes included", () => {
    const notes = "Triage: ".padEnd(20_000, "n");
    const issue = aRedMainIssue({ body: `${aRedMainBody()}\n${notes}`.replaceAll("\n", "\r\n") });
    const input = withExcerpts(redMainInput([failedAt(STILL_RED, [912, "test"])], { issues: [issue] }), [912, huge(912, "test")]);
    const [rewrite] = monitorPlanFor(input).rewrite;

    expect(rewrite?.body.length).toBeLessThanOrEqual(LIMIT);
    expect(rewrite?.body.length).toBeGreaterThan(LIMIT - 1_000);
    expect(rewrite?.body).toContain(notes);
    expect(rewrite?.body).toContain(`- \`test\` ([the job](${runUrl(912)}))`);
  });
});
