import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { aGroup, aMonitorIssue, SENTRY_ON, sentryRead } from "../__fixtures__/monitor.ts";
import { aCheckRun, aCommit, commitUrl, redMainInput, runUrl } from "../__fixtures__/redMain.ts";
import type { MonitorInput } from "./core.ts";
import { monitorPlanFor } from "./core.ts";
import type { MonitorIssue } from "./issues.ts";
import type { MainCommit } from "./redMain.ts";

/** Commits on the default branch, newest last in this list's names: OLDER, then RED, then NEWER, then NEWEST. */
const OLDER = "01de000a1b2c3d4e5f60718293a4b5c6d7e8f901";
const RED = "9148e44a1b2c3d4e5f60718293a4b5c6d7e8f901";
const NEWER = "7654877a1b2c3d4e5f60718293a4b5c6d7e8f901";
const NEWEST = "18a0966a1b2c3d4e5f60718293a4b5c6d7e8f901";

/**
 * redMainInput() for a repo like gradually-core: `gate` and `e2e` its Required
 * checks, `deploy` and `smoke-check` its Main checks.
 */
function mainChecksInput(commits: readonly MainCommit[], overrides: Partial<MonitorInput> = {}): MonitorInput {
  return redMainInput(commits, {
    monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: true, mainChecks: ["deploy", "smoke-check"] },
    listedChecks: ["gate", "e2e"],
    ...overrides,
  });
}

/** The newest commit's runs: `gate` and `e2e` passed, `deploy` failed (run 902), `smoke-check` skipped. */
function deployFailedAt(sha: string, id = 902): MainCommit {
  return aCommit(sha, [
    aCheckRun({ id: id - 2, name: "gate", conclusion: "success" }),
    aCheckRun({ id: id - 1, name: "e2e", conclusion: "success" }),
    aCheckRun({ id, name: "deploy", conclusion: "failure" }),
    aCheckRun({ id: id + 1, name: "smoke-check", conclusion: "skipped" }),
  ]);
}

/** The body of the issue the Monitor files for `deploy` failing at RED in run 902. */
const DEPLOY_BODY = [
  "<!-- fabrik:monitor main-check:deploy -->",
  "The Main check `deploy` is failing on the default branch: the newest commit on it where `deploy` has finished failed it. No pull request runs a Main check, so a fix is only tested once it merges. The Monitor keeps the details below current while it stays red, and closes this issue itself once `deploy` passes on the default branch again.",
  "",
  "<!-- fabrik:monitor-stats -->",
  `- Red at: [\`9148e44\`](${commitUrl(RED)})`,
  "- Failed checks:",
  `  - [\`deploy\`](${runUrl(902)}) failed`,
  "<!-- /fabrik:monitor-stats -->",
  "",
  "`monitor.main_checks` in `.fabrik/config.json` names the Main checks the Monitor reads on the default branch, each with an issue of its own.",
].join("\n");

/** The Fabrik App's open issue 50 for `deploy`, naming RED, as the Monitor filed it. */
function aDeployIssue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return aMonitorIssue({ number: 50, body: DEPLOY_BODY, ...overrides });
}

describe("A Main check", () => {
  it("files one issue for a failed deploy, and nothing for red main while the Required checks passed", () => {
    const plan = monitorPlanFor(mainChecksInput([deployFailedAt(RED)]));

    expect(plan.open).toEqual([
      { sentryGroup: null, title: "Red main: `deploy` is failing on the default branch", body: DEPLOY_BODY, labels: ["fabrik:monitor"] },
    ]);
    expect(plan.summary).toContain("Red main: the default branch is green at `9148e44`.");
  });

  it("files the deploy issue though red main's issue for gate was closed by someone else and main hasn't been seen green since", () => {
    const redMainClosed = aMonitorIssue({
      number: 41,
      open: false,
      stateReason: "completed",
      closedAt: "2026-11-06T06:00:00Z",
      body: "<!-- fabrik:monitor red-main -->\nThe default branch is red.",
    });
    const plan = monitorPlanFor(mainChecksInput([deployFailedAt(RED)], { issues: [redMainClosed] }));

    expect(plan.open.map((issue) => issue.title)).toEqual(["Red main: `deploy` is failing on the default branch"]);
  });

  it("leaves the open deploy issue alone when gate fails on a newer commit and skips deploy, and red main files its own issue for gate", () => {
    const gateFailed = aCommit(NEWER, [
      aCheckRun({ id: 910, name: "gate", conclusion: "failure" }),
      aCheckRun({ id: 911, name: "e2e", conclusion: "success" }),
      aCheckRun({ id: 912, name: "deploy", conclusion: "skipped" }),
    ]);
    const plan = monitorPlanFor(mainChecksInput([gateFailed, deployFailedAt(RED)], { issues: [aDeployIssue()] }));

    expect(plan.open.map((issue) => issue.title)).toEqual(["Red main: the default branch's CI is failing"]);
    expect(plan.rewrite).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(plan.summary).toContain("Main check `deploy` is still red at `9148e44`, as #50 says.");
  });

  it("rewrites the open deploy issue's details when deploy fails on a newer commit", () => {
    const plan = monitorPlanFor(mainChecksInput([deployFailedAt(NEWER, 922), deployFailedAt(RED)], { issues: [aDeployIssue()] }));

    expect(plan.rewrite).toEqual([
      {
        kind: "main-check",
        issue: 50,
        body: DEPLOY_BODY.replace(`[\`9148e44\`](${commitUrl(RED)})`, `[\`7654877\`](${commitUrl(NEWER)})`).replace(runUrl(902), runUrl(922)),
        summary: "Refreshed the Main check `deploy`'s details on #50.",
      },
    ]);
  });

  it("closes the deploy issue with the green note once deploy passes on a newer commit", () => {
    const deployPassed = aCommit(NEWER, [aCheckRun({ id: 920, name: "deploy", conclusion: "success" })]);
    const plan = monitorPlanFor(mainChecksInput([deployPassed, deployFailedAt(RED)], { issues: [aDeployIssue()] }));

    expect(plan.close).toEqual([
      {
        issue: 50,
        comment: [
          "<!-- fabrik:monitor-green -->",
          `Green at [\`7654877\`](${commitUrl(NEWER)}): the Main check \`deploy\` passed, so it's no longer failing on the default branch and the Monitor closes this issue as completed.`,
        ].join("\n"),
        because: "the Main check `deploy` passed again.",
      },
    ]);
    expect(plan.open).toEqual([]);
  });

  it("files one issue, for smoke-check, when deploy passed and smoke-check failed", () => {
    const smokeFailed = aCommit(RED, [
      aCheckRun({ id: 930, name: "gate", conclusion: "success" }),
      aCheckRun({ id: 931, name: "deploy", conclusion: "success" }),
      aCheckRun({ id: 932, name: "smoke-check", conclusion: "failure" }),
    ]);
    const plan = monitorPlanFor(mainChecksInput([smokeFailed]));

    expect(plan.open.map((issue) => issue.title)).toEqual(["Red main: `smoke-check` is failing on the default branch"]);
    expect(plan.open[0]?.body.split("\n")[0]).toBe("<!-- fabrik:monitor main-check:smoke-check -->");
  });

  it("keeps deploy's state at the newest commit that decides it while a run is under way, and red main decides gate without waiting", () => {
    const deploying = aCommit(NEWEST, [
      aCheckRun({ id: 940, name: "gate", conclusion: "failure" }),
      aCheckRun({ id: 941, name: "deploy", status: "in_progress", conclusion: null, completedAt: null }),
    ]);
    const plan = monitorPlanFor(mainChecksInput([deploying, deployFailedAt(RED)], { issues: [aDeployIssue()] }));

    expect(plan.open.map((issue) => issue.title)).toEqual(["Red main: the default branch's CI is failing"]);
    expect(plan.summary).toContain("Main check `deploy` is still red at `9148e44`, as #50 says.");
  });

  describe("closed as completed by someone other than the Monitor", () => {
    const closedAsFixed = aDeployIssue({ open: false, stateReason: "completed", closedAt: "2026-11-06T08:00:00Z" });

    it("files a new issue, still failing after it, once deploy fails on a newer commit than the one it names", () => {
      const plan = monitorPlanFor(mainChecksInput([deployFailedAt(NEWER, 922), deployFailedAt(RED)], { issues: [closedAsFixed] }));

      expect(plan.open).toHaveLength(1);
      expect(plan.open[0]?.body.split("\n").slice(0, 2)).toEqual([
        "<!-- fabrik:monitor main-check:deploy -->",
        "Still failing after #50: that issue was closed as completed, and `deploy` has failed again on a newer commit than the one it names.",
      ]);
    });

    it.each([
      ["only at the commit it names", [deployFailedAt(RED)]],
      ["at an older commit, a newer one undecided", [aCommit(NEWER, []), deployFailedAt(RED), deployFailedAt(OLDER, 800)]],
    ])("files nothing while deploy is red %s", (_when, commits) => {
      const plan = monitorPlanFor(mainChecksInput(commits, { issues: [closedAsFixed] }));

      expect(plan.open).toEqual([]);
      expect(plan.summary.filter((line) => line.startsWith("Main check"))).toEqual([
        "Main check `deploy` is red at `9148e44`, but #50 stays closed: it was closed as completed, and the check hasn't failed on a commit newer than the one it names.",
        "Main check `smoke-check` is undecided: none of the default branch's " + commits.length + " newest commits has finished it with a pass or a failure.",
      ]);
    });

    it("files a new issue when the commit it names is no longer among those read", () => {
      const plan = monitorPlanFor(mainChecksInput([deployFailedAt(NEWEST, 960)], { issues: [closedAsFixed] }));

      expect(plan.open[0]?.body).toContain("Still failing after #50");
    });

    it("holds an issue whose Monitor block is gone until deploy is seen green, as a not-planned close", () => {
      const noBlock = { ...closedAsFixed, body: "<!-- fabrik:monitor main-check:deploy -->\nThe Operator rewrote this." };

      expect(monitorPlanFor(mainChecksInput([deployFailedAt(NEWER, 922), deployFailedAt(RED)], { issues: [noBlock] })).open).toEqual([]);
    });
  });

  describe("closed as not planned by someone other than the Monitor", () => {
    const notPlanned = aDeployIssue({ open: false, stateReason: "not_planned", closedAt: "2026-11-06T08:00:00Z" });

    it("files nothing while deploy stays red", () => {
      const plan = monitorPlanFor(mainChecksInput([deployFailedAt(NEWER, 922), deployFailedAt(RED)], { issues: [notPlanned] }));

      expect(plan.open).toEqual([]);
    });

    it("files a new issue for a red after deploy has been seen green since the close", () => {
      const commits = [
        aCommit(NEWEST, [aCheckRun({ id: 970, name: "deploy", conclusion: "failure", completedAt: "2026-11-06T10:00:00Z" })]),
        aCommit(NEWER, [aCheckRun({ id: 960, name: "deploy", conclusion: "success", completedAt: "2026-11-06T09:00:00Z" })]),
        deployFailedAt(RED),
      ];
      const plan = monitorPlanFor(mainChecksInput(commits, { issues: [notPlanned] }));

      expect(plan.open).toHaveLength(1);
      expect(plan.open[0]?.body).not.toContain("Still failing after");
    });
  });

  it("files a new issue when the Monitor itself closed the last one after its green note", () => {
    const closedByMonitor = aDeployIssue({ open: false, stateReason: "completed", closedAt: "2026-11-06T08:00:00Z", closedByMonitor: true });
    const plan = monitorPlanFor(mainChecksInput([deployFailedAt(RED)], { issues: [closedByMonitor] }));

    expect(plan.open).toHaveLength(1);
    expect(plan.open[0]?.body).not.toContain("Still failing after");
  });

  it("counts only the Fabrik App's issues for a Main check", () => {
    const quoted = aDeployIssue({ byApp: false });

    expect(monitorPlanFor(mainChecksInput([deployFailedAt(RED)], { issues: [quoted] })).open).toHaveLength(1);
  });

  it("with sandbox.checks listing none, files the deploy issue alone, red main reading every other check but Fabrik's own", () => {
    const commit = aCommit(RED, [
      aCheckRun({ id: 980, name: "test", conclusion: "success" }),
      aCheckRun({ id: 981, name: "deploy", conclusion: "failure" }),
      aCheckRun({ id: 982, name: "loop", conclusion: "failure" }),
    ]);
    const plan = monitorPlanFor(mainChecksInput([commit], { listedChecks: [], monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: ["deploy"] } }));

    expect(plan.open.map((issue) => issue.title)).toEqual(["Red main: `deploy` is failing on the default branch"]);
    expect(plan.summary).toContain("Red main: the default branch is green at `9148e44`.");
  });

  it("names a Main check on none of the commits read in the step summary, and files nothing for it", () => {
    const plan = monitorPlanFor(mainChecksInput([aCommit(RED, [aCheckRun({ name: "gate", conclusion: "success" })])]));

    expect(plan.open).toEqual([]);
    expect(plan.summary).toContain(
      "Main check `deploy` is undecided: none of the default branch's 1 newest commits has finished it with a pass or a failure.",
    );
  });

  it("reads no Main check and files nothing for one with monitor.red_main off", () => {
    const plan = monitorPlanFor(
      mainChecksInput([deployFailedAt(RED)], { monitor: { ...DEFAULT_KIT_CONFIG.monitor, redMain: false, mainChecks: ["deploy"] }, mainChecks: null }),
    );

    expect(plan).toEqual({ open: [], rewrite: [], close: [], summary: [expect.stringMatching(/^Production errors are off/)] });
  });

  it("round-trips a name with spaces and punctuation through its marker, so its open issue is found again", () => {
    const check = "image (clinic) --> 1";
    const failed = aCommit(RED, [aCheckRun({ id: 990, name: check, conclusion: "failure" })]);
    const input = (issues: readonly MonitorIssue[]) =>
      mainChecksInput([failed], { monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: [check] }, issues });
    const [filed] = monitorPlanFor(input([])).open;

    expect(filed?.body.split("\n")[0]).toBe("<!-- fabrik:monitor main-check:image%20(clinic)%20--%3E%201 -->");
    const again = monitorPlanFor(input([aMonitorIssue({ number: 60, body: filed?.body ?? "" })]));
    expect(again.open).toEqual([]);
    expect(again.summary).toContain("Main check `image (clinic) --> 1` is still red at `9148e44`, as #60 says.");
  });

  it("never counts a Main check's open issue toward caps.monitor_issues", () => {
    const plan = monitorPlanFor(
      mainChecksInput([], { cap: 1, monitor: { ...DEFAULT_KIT_CONFIG.monitor, errors: SENTRY_ON }, sentry: sentryRead([aGroup()]), issues: [aDeployIssue()] }),
    );

    expect(plan.open.map((issue) => issue.sentryGroup)).toEqual(["4504"]);
  });
});
