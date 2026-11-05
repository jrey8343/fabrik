import { describe, expect, it } from "vitest";
import { aGroup, aMonitorIssue, aMonitorIssueBody, monitorInput, SENTRY_ON, sentryRead } from "../__fixtures__/monitor.ts";
import { aCheckRun, aCommit, aRedMainBody, aRedMainIssue, commitUrl, RED_DETAILS, redMainInput, runUrl } from "../__fixtures__/redMain.ts";
import { monitorPlanFor } from "./core.ts";

/** The step summary's lines about red main. */
function redMainLines(plan: ReturnType<typeof monitorPlanFor>): string[] {
  return plan.summary.filter((line) => line.startsWith("Red main"));
}

/** The commit the red-main issue this plan files names, by its short sha. */
function filedFor(plan: ReturnType<typeof monitorPlanFor>): (string | undefined)[] {
  return plan.open.map((issue) => /^- Red at: \[`(\w+)`\]/m.exec(issue.body)?.[1]);
}

/** A commit whose gating checks failed, the one aRedMainIssue() names. */
const RED = "badc0de4a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** A later commit that's red too. */
const STILL_RED = "dead0004a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** A commit whose gating checks passed. */
const GREEN = "600dc0de1b2c3d4e5f60718293a4b5c6d7e8f901";

describe("Red main", () => {
  it("files one issue while the newest decided commit is red, naming the commit, its failed checks and links to their runs", () => {
    const plan = monitorPlanFor(
      redMainInput([
        aCommit(RED, [
          aCheckRun({ id: 901, name: "test", conclusion: "failure" }),
          aCheckRun({ id: 902, name: "build", conclusion: "success" }),
          aCheckRun({ id: 903, name: "e2e", conclusion: "timed_out" }),
        ]),
      ]),
    );

    expect(plan.open).toEqual([
      {
        sentryGroup: null,
        title: "Red main: the default branch's CI is failing",
        labels: ["fabrik:monitor"],
        body: [
          "<!-- fabrik:monitor red-main -->",
          "The default branch is red: the newest commit on it whose gating checks have all finished failed some of them. The Monitor keeps the details below current while it stays red, and closes this issue itself once the default branch is green again.",
          "",
          "<!-- fabrik:monitor-stats -->",
          `- Red at: [\`badc0de\`](${commitUrl(RED)})`,
          "- Failed checks:",
          `  - [\`e2e\`](${runUrl(903)}) timed out`,
          `  - [\`test\`](${runUrl(901)}) failed`,
          "<!-- /fabrik:monitor-stats -->",
          "",
          "The gating checks are `sandbox.checks` in `.fabrik/config.json`, or every check but Fabrik's own when it lists none.",
        ].join("\n"),
      },
    ]);
  });

  it("rewrites the open red-main issue's details to name the latest red commit, its failed checks and their runs, leaving the rest of the body alone", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(STILL_RED, [
            aCheckRun({ id: 911, name: "test", conclusion: "success" }),
            aCheckRun({ id: 912, name: "lint", conclusion: "failure" }),
          ]),
        ],
        { issues: [aRedMainIssue({ number: 41 })] },
      ),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([
      {
        kind: "red-main",
        issue: 41,
        body: aRedMainBody([
          `- Red at: [\`dead000\`](${commitUrl(STILL_RED)})`,
          "- Failed checks:",
          `  - [\`lint\`](${runUrl(912)}) failed`,
        ]),
        summary: "Refreshed red main's details on #41.",
      },
    ]);
  });

  it("leaves the open red-main issue alone while the red commit and its failed checks are the ones it names", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })])], {
        issues: [aRedMainIssue({ body: aRedMainBody(RED_DETAILS) })],
      }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.summary).toContain("Red main: the default branch is still red at `badc0de`, as #41 says.");
  });

  it("leaves an open red-main issue whose details block was edited out alone, and files no other", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(STILL_RED, [aCheckRun({ id: 930, name: "lint", conclusion: "failure" })])], {
        issues: [aRedMainIssue({ number: 41, body: "<!-- fabrik:monitor red-main -->\nThe Operator rewrote this." })],
      }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
  });

  it("closes the open red-main issue as completed once the newest decided commit is green, with a green-at note", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(GREEN, [aCheckRun({ name: "test", conclusion: "success" })])], { issues: [aRedMainIssue({ number: 41 })] }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([
      {
        issue: 41,
        comment: [
          "<!-- fabrik:monitor-green -->",
          `Green at [\`600dc0d\`](${commitUrl(GREEN)}): its gating checks passed, so the default branch is no longer red and the Monitor closes this issue as completed.`,
        ].join("\n"),
      },
    ]);
  });

  it("files and closes nothing while the default branch is green with no red-main issue open, and says it's green", () => {
    const plan = monitorPlanFor(redMainInput([aCommit(GREEN, [aCheckRun({ conclusion: "success" })])]));

    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(plan.summary).toContain("Red main: the default branch is green at `600dc0d`.");
  });
});

describe("The red-main issue", () => {
  const red = [aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })])];

  it("files one while red when only an issue someone else opened carries the red-main marker", () => {
    const plan = monitorPlanFor(redMainInput(red, { issues: [aRedMainIssue({ number: 52, authorIsApp: false })] }));

    expect(filedFor(plan)).toEqual(["badc0de"]);
    expect(plan.rewrite).toEqual([]);
  });

  it("files one while red even with five error issues open, as it never counts toward their cap", () => {
    const errorIssues = [40, 42, 43, 44, 45].map((number) =>
      aMonitorIssue({ number, body: aMonitorIssueBody().replaceAll("4504", `45${number}`) }),
    );

    const plan = monitorPlanFor(redMainInput(red, { issues: errorIssues }));

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });
});

describe("Red main at caps.monitor_issues 0", () => {
  /** Error filings paused, with a qualifying Sentry group that would otherwise be filed. */
  const paused = { cap: 0, monitor: { errors: SENTRY_ON, redMain: true }, sentry: sentryRead([aGroup()]) };

  it("still files the red-main issue while new error filings are paused", () => {
    const plan = monitorPlanFor(redMainInput([aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })])], paused));

    expect(plan.open.map((issue) => issue.sentryGroup)).toEqual([null]);
    expect(filedFor(plan)).toEqual(["badc0de"]);
  });

  it("still closes the red-main issue once green while new error filings are paused", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(GREEN, [aCheckRun({ id: 920, name: "test", conclusion: "success" })])], {
        ...paused,
        issues: [aRedMainIssue({ number: 41 })],
      }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.close.map((close) => close.issue)).toEqual([41]);
  });
});

describe("Which commit decides red main", () => {
  it.each(["cancelled", "skipped", "neutral", "action_required", "stale"])(
    "passes over a commit whose checks all ended %s, so an older decided commit is the state",
    (conclusion) => {
      const plan = monitorPlanFor(
        redMainInput([
          aCommit(GREEN, [aCheckRun({ id: 920, name: "test", conclusion }), aCheckRun({ id: 921, name: "build", conclusion })]),
          aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })]),
        ]),
      );

      expect(filedFor(plan)).toEqual(["badc0de"]);
    },
  );

  it("decides a commit by its passed and failed checks, ignoring a cancelled or skipped one beside them", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(GREEN, [
            aCheckRun({ id: 920, name: "test", conclusion: "success" }),
            aCheckRun({ id: 921, name: "deploy", conclusion: "skipped" }),
            aCheckRun({ id: 922, name: "e2e", conclusion: "cancelled" }),
          ]),
        ],
        { issues: [aRedMainIssue({ number: 41 })] },
      ),
    );

    expect(plan.close.map((close) => close.issue)).toEqual([41]);
  });

  it.each(["queued", "in_progress", "waiting", "pending"])(
    "leaves a commit undecided while one of its checks is %s, even with another failed, so an older decided commit is the state",
    (status) => {
      const plan = monitorPlanFor(
        redMainInput(
          [
            aCommit(STILL_RED, [
              aCheckRun({ id: 930, name: "test", conclusion: "failure" }),
              aCheckRun({ id: 931, name: "build", status, conclusion: null, completedAt: null }),
            ]),
            aCommit(GREEN, [aCheckRun({ id: 920, name: "test", conclusion: "success" })]),
          ],
          { issues: [aRedMainIssue({ number: 41 })] },
        ),
      );

      expect(plan.open).toEqual([]);
      expect(plan.rewrite).toEqual([]);
      expect(plan.close.map((close) => close.issue)).toEqual([41]);
    },
  );

  it("goes by the newest run of each check on a commit, so a re-run that passed makes it green", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(RED, [
            aCheckRun({ id: 950, name: "test", conclusion: "success", completedAt: "2026-11-06T07:30:00Z" }),
            aCheckRun({ id: 901, name: "test", conclusion: "failure", completedAt: "2026-11-06T07:00:00Z" }),
          ]),
        ],
        { issues: [aRedMainIssue({ number: 41 })] },
      ),
    );

    expect(plan.close.map((close) => close.issue)).toEqual([41]);
  });

  it("goes by the newest run of each check on a commit, so a re-run that failed makes it red, and an older run still in progress doesn't count", () => {
    const plan = monitorPlanFor(
      redMainInput([
        aCommit(RED, [
          aCheckRun({ id: 880, name: "test", status: "in_progress", conclusion: null, completedAt: null }),
          aCheckRun({ id: 901, name: "test", conclusion: "failure" }),
          aCheckRun({ id: 890, name: "build", conclusion: "failure" }),
          aCheckRun({ id: 902, name: "build", conclusion: "success" }),
        ]),
      ]),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
    expect(plan.open[0]?.body).toContain(`  - [\`test\`](${runUrl(901)}) failed`);
    expect(plan.open[0]?.body).not.toContain("`build`");
  });
});

describe("Which checks gate the default branch", () => {
  it("goes by sandbox.checks alone when it lists any, so another check failing leaves the commit green", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(GREEN, [
            aCheckRun({ id: 920, name: "build", conclusion: "success" }),
            aCheckRun({ id: 921, name: "lint", conclusion: "failure" }),
          ]),
        ],
        { gatingChecks: ["build"], issues: [aRedMainIssue({ number: 41 })] },
      ),
    );

    expect(plan.close.map((close) => close.issue)).toEqual([41]);
  });

  it("goes by sandbox.checks alone when it lists any, so another check in progress doesn't hold the commit undecided", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(RED, [
            aCheckRun({ id: 901, name: "test", conclusion: "failure" }),
            aCheckRun({ id: 902, name: "deploy", status: "in_progress", conclusion: null, completedAt: null }),
          ]),
        ],
        { gatingChecks: ["build", "test"] },
      ),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });

  it("decides a commit by the gating checks on it, a listed check that isn't on it counting for nothing", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })])], {
        gatingChecks: ["build", "test"],
      }),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });

  it("passes over a commit that carries none of the gating checks", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(STILL_RED, [aCheckRun({ id: 930, name: "lint", conclusion: "failure" })]),
          aCommit(GREEN, [aCheckRun({ id: 920, name: "build", conclusion: "success" })]),
        ],
        { gatingChecks: ["build"], issues: [aRedMainIssue({ number: 41 })] },
      ),
    );

    expect(plan.open).toEqual([]);
    expect(plan.close.map((close) => close.issue)).toEqual([41]);
  });

  it("goes by every check when sandbox.checks lists none", () => {
    const plan = monitorPlanFor(
      redMainInput([
        aCommit(RED, [
          aCheckRun({ id: 901, name: "build", conclusion: "success" }),
          aCheckRun({ id: 902, name: "lint", conclusion: "failure" }),
        ]),
      ]),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });

  it.each(["loop", "loop / Push", "tick", "tick / Monitor"])(
    "leaves Fabrik's own %s job out of every check, so it never makes the commit red or holds it undecided",
    (name) => {
      const plan = monitorPlanFor(
        redMainInput(
          [
            aCommit(GREEN, [
              aCheckRun({ id: 920, name: "test", conclusion: "success" }),
              aCheckRun({ id: 921, name, conclusion: "failure" }),
              aCheckRun({ id: 922, name: `${name.split(" / ")[0]} / Kit`, status: "in_progress", conclusion: null, completedAt: null }),
            ]),
          ],
          { issues: [aRedMainIssue({ number: 41 })] },
        ),
      );

      expect(plan.close.map((close) => close.issue)).toEqual([41]);
    },
  );

  it("passes over a commit that carries only Fabrik's own jobs when sandbox.checks lists none", () => {
    const plan = monitorPlanFor(
      redMainInput([
        aCommit(GREEN, [aCheckRun({ id: 921, name: "tick / Tick", conclusion: "success" }), aCheckRun({ id: 922, name: "loop", conclusion: "skipped" })]),
        aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })]),
      ]),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });

  it("counts a check whose name only starts like Fabrik's jobs", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(RED, [aCheckRun({ id: 901, name: "ticket-lint", conclusion: "failure" })])]),
    );

    expect(filedFor(plan)).toEqual(["badc0de"]);
  });
});

describe("No decided commit", () => {
  const undecided = [
    aCommit(STILL_RED, [
      aCheckRun({ id: 930, name: "test", conclusion: "failure" }),
      aCheckRun({ id: 931, name: "build", status: "in_progress", conclusion: null, completedAt: null }),
    ]),
    aCommit(GREEN, [aCheckRun({ id: 920, name: "build", conclusion: "cancelled" })]),
    aCommit(RED, [aCheckRun({ id: 901, name: "deploy", conclusion: "failure" })]),
  ];

  it("files, rewrites and closes nothing when no commit within the bound is decided, saying so quietly", () => {
    const plan = monitorPlanFor(redMainInput(undecided.slice(0, 2), { issues: [aRedMainIssue({ number: 41 })] }));

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(redMainLines(plan)).toEqual([
      "Red main is undecided: none of the default branch's 2 newest commits has finished its gating checks with a pass or a failure.",
    ]);
  });

  it("names the gating checks sandbox.checks lists when no commit has finished them", () => {
    const plan = monitorPlanFor(redMainInput(undecided, { gatingChecks: ["build", "test"] }));

    expect(plan.open).toEqual([]);
    expect(redMainLines(plan)).toEqual([
      "Red main is undecided: none of the default branch's 3 newest commits has finished its gating checks (`build`, `test`) with a pass or a failure.",
    ]);
  });
});

describe("A red-main issue someone closed", () => {
  /** Red-main issue 41, closed at 07:20 UTC. */
  const closedAt = "2026-11-06T07:20:00Z";
  const byOperator = aRedMainIssue({ number: 41, open: false, stateReason: "completed", closedAt, closedByMonitor: false });

  it("files again while red once the Monitor itself closed the newest red-main issue as green", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(STILL_RED, [aCheckRun({ id: 930, name: "test", conclusion: "failure" })])], {
        issues: [aRedMainIssue({ number: 41, open: false, stateReason: "completed", closedAt, closedByMonitor: true })],
      }),
    );

    expect(filedFor(plan)).toEqual(["dead000"]);
  });

  it.each([
    ["the Operator closed it as completed", byOperator],
    ["Triage closed it for the Loop as not planned", { ...byOperator, stateReason: "not_planned", labels: ["fabrik:monitor", "wontfix"] }],
  ])("keeps it closed while red, filing nothing, after %s and with no decided-green commit newer than the close", (_who, closed) => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(STILL_RED, [aCheckRun({ id: 930, name: "test", conclusion: "failure", completedAt: "2026-11-06T07:50:00Z" })]),
          aCommit(GREEN, [aCheckRun({ id: 920, name: "test", conclusion: "success", completedAt: "2026-11-06T06:00:00Z" })]),
          aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure", completedAt: "2026-11-06T05:00:00Z" })]),
        ],
        { issues: [closed] },
      ),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(redMainLines(plan)).toEqual([
      "Red main: the default branch is red at `dead000`, but #41 stays closed until it's seen green, as someone other than the Monitor closed it.",
    ]);
  });

  it("files again for a later red once a commit was decided green after the Operator's close, even one committed before it", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(STILL_RED, [aCheckRun({ id: 930, name: "test", conclusion: "failure", completedAt: "2026-11-06T07:50:00Z" })]),
          aCommit(GREEN, [
            aCheckRun({ id: 920, name: "test", conclusion: "success", completedAt: "2026-11-06T07:10:00Z" }),
            aCheckRun({ id: 921, name: "build", conclusion: "success", completedAt: "2026-11-06T07:30:00Z" }),
          ]),
        ],
        { issues: [byOperator] },
      ),
    );

    expect(filedFor(plan)).toEqual(["dead000"]);
  });

  it("keeps it closed while red when only an older commit's re-run passed after the close, as the newer red commit was decided first", () => {
    const plan = monitorPlanFor(
      redMainInput(
        [
          aCommit(STILL_RED, [aCheckRun({ id: 930, name: "test", conclusion: "failure", completedAt: "2026-11-06T07:00:00Z" })]),
          aCommit(GREEN, [
            aCheckRun({ id: 920, name: "test", conclusion: "failure", completedAt: "2026-11-06T06:00:00Z" }),
            aCheckRun({ id: 925, name: "test", conclusion: "success", completedAt: "2026-11-06T07:40:00Z" }),
          ]),
        ],
        { issues: [byOperator] },
      ),
    );

    expect(plan.open).toEqual([]);
    expect(redMainLines(plan)).toEqual([
      "Red main: the default branch is red at `dead000`, but #41 stays closed until it's seen green, as someone other than the Monitor closed it.",
    ]);
  });

  it("goes by the newest of the Fabrik App's red-main issues", () => {
    const plan = monitorPlanFor(
      redMainInput([aCommit(STILL_RED, [aCheckRun({ id: 930, name: "test", conclusion: "failure" })])], {
        issues: [
          aRedMainIssue({ number: 30, open: false, stateReason: "completed", closedAt: "2026-11-01T07:20:00Z", closedByMonitor: true }),
          byOperator,
          aRedMainIssue({ number: 52, authorIsApp: false }),
        ],
      }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
  });
});

describe("Red main turned off", () => {
  it.each([
    ["red with no issue", [aCommit(RED, [aCheckRun({ id: 901, name: "test", conclusion: "failure" })])], []],
    ["red with an open issue", [aCommit(STILL_RED, [aCheckRun({ id: 930, name: "lint", conclusion: "failure" })])], [aRedMainIssue()]],
    ["green with an open issue", [aCommit(GREEN, [aCheckRun({ id: 920, name: "test", conclusion: "success" })])], [aRedMainIssue()]],
  ])("files, rewrites and closes nothing with monitor.red_main false, %s", (_state, commits, issues) => {
    const plan = monitorPlanFor(redMainInput(commits, { monitor: { errors: null, redMain: false }, issues }));

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(redMainLines(plan)).toEqual([]);
  });
});

describe("Red main dormant", () => {
  it("notes quietly that red main is dormant while GitHub refuses the check runs, as the Fabrik App lacks Checks: read, doing nothing", () => {
    const plan = monitorPlanFor(redMainInput([], { mainChecks: { kind: "no-permission" }, issues: [aRedMainIssue()] }));

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(redMainLines(plan)).toEqual([
      "Red main is dormant: the Fabrik App needs Checks: read. Accept the App's request for it on this repo's installation (the setup wizard walks through it) to have the Monitor watch the default branch's CI.",
    ]);
  });

  it("warns, doing nothing, when GitHub's rate limit stopped the read of the default branch's checks, which isn't a missing Checks: read", () => {
    const plan = monitorPlanFor(
      redMainInput([], { mainChecks: { kind: "rate-limited", error: "GitHub GET check-runs failed: 403 API rate limit exceeded" }, issues: [aRedMainIssue()] }),
    );

    expect(plan.open).toEqual([]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(plan.summary.filter((line) => /red main/i.test(line))).toEqual([
      "Warning: GitHub's rate limit stopped red main reading the default branch's checks, so it did nothing this tick: GitHub GET check-runs failed: 403 API rate limit exceeded",
    ]);
  });

  it("notes red main dormant beside what production errors did, so a missing Checks: read never stops Sentry's issues", () => {
    const plan = monitorPlanFor(
      monitorInput([aGroup()], { mainChecks: { kind: "no-permission" } }),
    );

    expect(plan.open.map((issue) => issue.sentryGroup)).toEqual(["4504"]);
    expect(redMainLines(plan)).toHaveLength(1);
  });
});
