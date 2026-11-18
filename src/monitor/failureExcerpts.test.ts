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
