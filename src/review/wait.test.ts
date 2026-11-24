import { describe, expect, it } from "vitest";
import { checksFromGh } from "./checks.ts";
import type { FailureReader } from "./failureExcerpt.ts";
import { type CheckDetail, redChecksOf } from "./rerun.ts";
import {
  type ChecksWaitGitHub,
  conflictReport,
  errorReport,
  gaveUpReport,
  type PullRequestState,
  ranNothingLine,
  redExcerpts,
  requiredChecksToWaitOn,
  waitForRequiredChecks,
} from "./wait.ts";

const HEAD = "a".repeat(40);
const MINUTE = 60_000;

const open: PullRequestState = { headRefOid: HEAD, isDraft: true, state: "OPEN", mergeable: "MERGEABLE" };
/** GitHub runs no `pull_request` workflow on a PR that conflicts with its base, so a Required check that hadn't started never will (#704). */
const conflicting: PullRequestState = { ...open, mergeable: "CONFLICTING" };
/** GitHub hadn't yet worked out whether it merges cleanly. */
const unknown: PullRequestState = { ...open, mergeable: "UNKNOWN" };

/** A PR whose checks read as `rounds` gives them, one round per poll, the last repeating; and a clock that only moves when the wait sleeps. */
function fakes(rounds: readonly (readonly CheckDetail[])[], states: readonly PullRequestState[] = [open]) {
  let now = 0;
  let polls = 0;
  const logged: string[] = [];
  const github: ChecksWaitGitHub = {
    pullRequestState: async () => states[Math.min(polls, states.length - 1)] ?? open,
    checks: async () => {
      const round = rounds[Math.min(polls, rounds.length - 1)] ?? [];
      polls += 1;
      return [...round];
    },
  };
  return {
    github,
    logged,
    options: (requiredChecks: readonly string[], deadlineMs = 27 * MINUTE) => ({
      requiredChecks,
      deadlineMs,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      log: (line: string) => {
        logged.push(line);
      },
    }),
  };
}

const check = (name: string, bucket: CheckDetail["bucket"]): CheckDetail => ({ name, bucket, link: "", workflow: "" });

describe("Waiting for an agent PR's required checks", () => {
  it("ends green once every Required check passed", async () => {
    const { github, options } = fakes([[check("build", "pending")], [check("build", "pass")]]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
  });

  it("ends green past a skipped or neutral check, naming it as having run nothing", async () => {
    const { github, options } = fakes([[check("build", "pass"), check("e2e", "skipping")]]);

    expect(await waitForRequiredChecks(github, options(["build", "e2e"]))).toEqual({ checks: "green", headSha: HEAD, ranNothing: ["e2e"] });
  });

  it("ends red, naming the checks that didn't pass", async () => {
    const { github, options } = fakes([[check("build", "fail"), check("lint", "pass")]]);

    expect(await waitForRequiredChecks(github, options(["build", "lint"]))).toEqual({ checks: "red", headSha: HEAD, failed: ["build"] });
  });

  it("ends stale when the PR has moved off the head an earlier job named", async () => {
    const { github, options } = fakes([[check("build", "pass")]]);

    expect(await waitForRequiredChecks(github, { ...options([]), headSha: "c".repeat(40) })).toEqual({ checks: "stale", headSha: "c".repeat(40) });
  });

  it("ends stale when the PR moves on while it waits", async () => {
    const moved = { ...open, headRefOid: "b".repeat(40) };
    const { github, options } = fakes([[check("build", "pending")]], [open, open, moved]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({ checks: "stale", headSha: HEAD });
  });

  it("gives up at its own deadline on a Required check that never reported, naming it", async () => {
    const { github, options } = fakes([[check("build", "pass")]]);

    expect(await waitForRequiredChecks(github, options(["build", "e2e"]))).toEqual({
      checks: "gave-up",
      headSha: HEAD,
      unreported: ["e2e"],
      running: [],
      waitedMinutes: 27,
      mergeable: true,
    });
  });

  it("gives up at its own deadline on checks still running, naming them", async () => {
    const { github, options } = fakes([[check("build", "pending")]]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({
      checks: "gave-up",
      headSha: HEAD,
      unreported: [],
      running: ["build"],
      waitedMinutes: 27,
      mergeable: true,
    });
  });

  // #704: GitHub never starts a `pull_request` check on a PR it can't merge, so waiting on one is waiting for nothing.
  it("stops at once when the PR conflicts with its base and a Required check never reported, naming the ones that didn't", async () => {
    const { github, logged, options } = fakes([[check("build", "pass")]], [conflicting]);

    expect(await waitForRequiredChecks(github, options(["build", "e2e", "gate"]))).toEqual({
      checks: "conflicting",
      headSha: HEAD,
      unreported: ["e2e", "gate"],
      waitedMinutes: 1,
    });
    expect(logged).toEqual(["Stopped waiting after 1 minute: the PR conflicts with its base, so GitHub won't start e2e, gate on this head"]);
  });

  it("keeps waiting on a PR that conflicts with its base while every Required check has reported or is running, and goes green as they pass", async () => {
    const { github, options } = fakes(
      [
        [check("build", "pending"), check("e2e", "pending")],
        [check("build", "pass"), check("e2e", "pass")],
      ],
      [conflicting],
    );

    expect(await waitForRequiredChecks(github, options(["build", "e2e"]))).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
  });

  it("keeps waiting on a PR that conflicts with its base while its Required checks run, and goes red on one that fails", async () => {
    const { github, options } = fakes([[check("build", "pending")], [check("build", "fail")]], [conflicting]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({ checks: "red", headSha: HEAD, failed: ["build"] });
  });

  it("keeps waiting while GitHub hasn't worked out whether the PR merges cleanly, and gives up recording that it didn't know", async () => {
    const { github, options } = fakes([[check("build", "pass")]], [unknown]);

    expect(await waitForRequiredChecks(github, options(["build", "e2e"]))).toEqual({
      checks: "gave-up",
      headSha: HEAD,
      unreported: ["e2e"],
      running: [],
      waitedMinutes: 27,
      mergeable: null,
    });
  });

  it("logs what it waits on when that changes, and again every few minutes while it doesn't", async () => {
    const { github, logged, options } = fakes([
      [check("build", "pending")],
      [check("build", "pending"), check("e2e", "pending")],
      [check("build", "pass"), check("e2e", "pending")],
      [check("build", "pass"), check("e2e", "pending")],
    ]);

    await waitForRequiredChecks(github, options(["build", "e2e"], 10 * MINUTE));

    expect(logged.slice(0, 3)).toEqual([
      "Waiting on build (running), e2e (not reported yet)",
      "Waiting on build (running), e2e (running)",
      "Waiting on e2e (running)",
    ]);
    // Nothing changes after that, so it says the same again every 5 minutes until it gives up.
    expect(logged.slice(3)).toEqual(["Waiting on e2e (running)", "Gave up waiting after 10 minutes, still waiting on e2e (running)"]);
  });

  it("reports a GitHub request that failed while it waited as unread checks, quoting the error, not as a crash", async () => {
    const { github, options } = fakes([[check("build", "pending")]]);
    const failing: ChecksWaitGitHub = {
      ...github,
      checks: async () => {
        throw new Error("gh pr checks failed: HTTP 502: Bad Gateway");
      },
    };

    const report = await waitForRequiredChecks(failing, options(["build"])).then(() => undefined, errorReport);

    expect(report).toEqual({ failure: "unread-checks", detail: "gh pr checks failed: HTTP 502: Bad Gateway" });
  });

  it("reports a PR read that failed as it started as unread checks too", async () => {
    const { options } = fakes([]);
    const failing: ChecksWaitGitHub = {
      pullRequestState: async () => {
        throw new Error("gh pr view failed: HTTP 503");
      },
      checks: async () => [],
    };

    const report = await waitForRequiredChecks(failing, options(["build"])).then(() => undefined, errorReport);

    expect(report).toEqual({ failure: "unread-checks", detail: "gh pr view failed: HTTP 503" });
  });

  it("reports any other error, such as one before the wait starts, as a crash with its message", () => {
    expect(errorReport(new Error("The Kit config is invalid"))).toEqual({ failure: "crash", detail: "The Kit config is invalid" });
  });
});

/** The checks a `gh pr checks` run printed, read as the wait reads them. */
const printed = (checks: readonly CheckDetail[]): CheckDetail[] =>
  checksFromGh({ stdout: JSON.stringify(checks), stderr: "", failed: checks.some((check) => check.bucket !== "pass") }) as CheckDetail[];

const actionsCheck = (name: string, bucket: CheckDetail["bucket"], run: number): CheckDetail => ({
  name,
  bucket,
  link: `https://github.com/o/r/actions/runs/${run}/job/${run * 10}`,
  workflow: "CI",
});

// The Console check is never a Required check (ADR-0019): a head may hold one when GitHub refused the Console's merge.
describe("Waiting on a head that also holds the Console check", () => {
  it.each(["fail", "pending"] as const)("ends green once build passed, whatever the Console check beside it (%s)", async (bucket) => {
    const { github, options } = fakes([
      printed([check("build", "pending"), check("Merge from the Console", bucket)]),
      printed([check("build", "pass"), check("Merge from the Console", bucket)]),
    ]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
  });

  it("ends red naming build alone when build failed beside a failed Console check", async () => {
    const { github, options } = fakes([printed([check("build", "fail"), check("Merge from the Console", "fail")])]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({ checks: "red", headSha: HEAD, failed: ["build"] });
  });

  it("hands the red checks only the Required checks that failed, never the Console check", async () => {
    const checks = printed([actionsCheck("build", "fail", 7), actionsCheck("lint", "pass", 7), actionsCheck("Merge from the Console", "fail", 8)]);
    const { github, options } = fakes([checks]);

    const outcome = await waitForRequiredChecks(github, options(["build", "lint"]));

    expect(redChecksOf(checks, outcome.checks === "red" ? outcome.failed : [])).toEqual({
      rerun: [{ name: "build", link: "https://github.com/o/r/actions/runs/7/job/70", run: 7 }],
      outside: [],
    });
  });
});

describe("The Required checks a Review waits on: those the Kit config lists plus any the default branch requires (#565)", () => {
  /** The checks it waits on, given the branch's own list and `sandbox.checks`, through a wait whose PR's head reads as `rounds` give it. */
  async function waitOn(branch: readonly string[], listed: readonly string[], rounds: readonly (readonly CheckDetail[])[]) {
    const { github, options } = fakes(rounds);
    const requiredChecks = await requiredChecksToWaitOn(async () => ({ kind: "read", required: branch }), listed);
    return waitForRequiredChecks(github, options(requiredChecks));
  }

  it("are the branch's own list, then any the Kit config lists beyond it, each once", async () => {
    expect(await requiredChecksToWaitOn(async () => ({ kind: "read", required: ["b", "a"] }), ["a", "c"])).toEqual(["b", "a", "c"]);
  });

  it("end red on a check only the branch requires failing, naming it", async () => {
    expect(await waitOn(["a", "b"], ["a"], [[check("a", "pass"), check("b", "fail")]])).toEqual({ checks: "red", headSha: HEAD, failed: ["b"] });
  });

  it("wait on a check only the branch requires while it runs, and end green once it passes", async () => {
    const { github, logged, options } = fakes([[check("a", "pass"), check("b", "pending")], [check("a", "pass"), check("b", "pass")]]);
    const requiredChecks = await requiredChecksToWaitOn(async () => ({ kind: "read", required: ["a", "b"] }), ["a"]);

    expect(await waitForRequiredChecks(github, options(requiredChecks))).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
    expect(logged).toEqual(["Waiting on b (running)"]);
  });

  it("give up naming a check only the branch requires that never reported", async () => {
    expect(await waitOn(["a", "b"], ["a"], [[check("a", "pass")]])).toEqual({ checks: "gave-up", headSha: HEAD, unreported: ["b"], running: [], waitedMinutes: 27, mergeable: true });
  });

  it("still include a check the Kit config lists that the branch doesn't require", async () => {
    expect(await waitOn(["a"], ["a", "c"], [[check("a", "pass"), check("c", "fail")]])).toEqual({ checks: "red", headSha: HEAD, failed: ["c"] });
  });

  it("give up naming a check the branch requires that never registered on the head, with nothing listed in the Kit config", async () => {
    expect(await waitOn(["b"], [], [[]])).toEqual({ checks: "gave-up", headSha: HEAD, unreported: ["b"], running: [], waitedMinutes: 27, mergeable: true });
  });

  it("never include a check on the head in neither list, such as `loop / Kit`", async () => {
    expect(await waitOn(["a"], ["a"], [[check("a", "pass"), check("loop / Kit", "fail")]])).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
  });

  it("are none when neither lists any, so the checks are green after the settle window", async () => {
    expect(await waitOn([], [], [[check("loop / Kit", "pending")]])).toEqual({ checks: "green", headSha: HEAD, ranNothing: [] });
  });

  it("fail as unread checks, quoting why, when the branch can't be read, never falling back to the Kit config's list", async () => {
    const unread = requiredChecksToWaitOn(async () => ({ kind: "unread", why: "GET /repos/o/p/branches/main failed with 403: Resource not accessible by integration" }), ["a"]);

    expect(await unread.then(() => undefined, errorReport)).toEqual({
      failure: "unread-checks",
      detail: "Couldn't read the default branch's Required checks: GET /repos/o/p/branches/main failed with 403: Resource not accessible by integration",
    });
  });
});

describe("What a wait that gave up reports", () => {
  it("names the Required checks that never reported, even with others still running, with the head, how long it waited and the last mergeable state it read", () => {
    expect(gaveUpReport({ checks: "gave-up", headSha: HEAD, unreported: ["e2e"], running: ["build"], waitedMinutes: 27, mergeable: true })).toEqual({
      failure: "unreported-checks",
      detail: "",
      checks: ["e2e"],
      headSha: HEAD,
      waitedMinutes: 27,
      mergeable: true,
    });
  });

  it("records a mergeable state GitHub hadn't worked out as unknown", () => {
    expect(gaveUpReport({ checks: "gave-up", headSha: HEAD, unreported: ["e2e"], running: [], waitedMinutes: 27, mergeable: null })).toMatchObject({ mergeable: null });
  });

  it("is a timeout naming the checks still running when every Required check reported", () => {
    expect(gaveUpReport({ checks: "gave-up", headSha: HEAD, unreported: [], running: ["build", "lint"], waitedMinutes: 27, mergeable: true })).toEqual({
      failure: "timeout",
      detail: "",
      checks: ["build", "lint"],
    });
  });
});

describe("What a wait that stopped on a conflict reports", () => {
  it("is a merge conflict naming the Required checks that never reported, with the head and how long it waited", () => {
    expect(conflictReport({ checks: "conflicting", headSha: HEAD, unreported: ["e2e", "gate"], waitedMinutes: 1 })).toEqual({
      failure: "merge-conflict",
      detail: "",
      checks: ["e2e", "gate"],
      headSha: HEAD,
      waitedMinutes: 1,
      mergeable: false,
    });
  });
});

describe("The Review's step summary line on checks that ran nothing", () => {
  it("names each Required check that passed by being skipped or reporting neutral", () => {
    expect(ranNothingLine(["e2e", "visual"])).toBe(
      "These Required checks were skipped or reported neutral, so they passed but ran nothing on this head: `e2e`, `visual`",
    );
  });

  it("is left out when every check ran", () => {
    expect(ranNothingLine([])).toBeNull();
  });
});

describe("The Failure excerpts a red wait passes out (#775)", () => {
  const job = (n: number) => `https://github.com/acme/shop/actions/runs/7/job/${n}`;
  const read: string[] = [];
  const reader: FailureReader = {
    job: async (id) => (read.push(`job ${id}`), { status: "completed", conclusion: "failure", steps: [{ name: "Test", number: 3, conclusion: "failure" }] }),
    stepLog: async () => "##[error]boom\n",
    runJobs: async () => [],
    annotations: async () => [],
    checkRun: async (id) => Promise.reject(new Error(`no check run ${id}`)),
    checkRuns: async () => [],
    statuses: async () => [],
  };

  it("reads each red check the wait names: a GitHub Actions one by the job its link gives, an outside one by what it wrote to GitHub (#777)", async () => {
    read.length = 0;
    const checks: CheckDetail[] = [
      { name: "unit", bucket: "fail", link: job(11), workflow: "CI" },
      { name: "lint", bucket: "pass", link: job(12), workflow: "CI" },
      { name: "Vercel", bucket: "fail", link: "https://vercel.com/acme/shop/1", workflow: "" },
    ];
    const outside: FailureReader = {
      ...reader,
      checkRuns: async (sha, name) => (read.push(`check runs ${name} on ${sha}`), []),
      statuses: async (sha) => (read.push(`statuses on ${sha}`), [{ context: "Vercel", state: "failure", description: "Deployment has failed", target_url: null }]),
    };

    const excerpts = await redExcerpts(checks, ["unit", "Vercel"], HEAD, outside);

    expect(read).toEqual(["job 11", `check runs Vercel on ${HEAD}`, `statuses on ${HEAD}`]);
    expect(excerpts).toEqual([
      { kind: "actions", check: "unit", link: job(11), steps: [{ name: "Test", earlier: 0, lines: ["##[error]boom"] }], annotations: [] },
      { kind: "commit-status", check: "Vercel", link: "https://vercel.com/acme/shop/1", description: "Deployment has failed" },
    ]);
  });

  it("reads the re-run's job for a check that failed again, as the checks on the head now link it", async () => {
    read.length = 0;
    const checks: CheckDetail[] = [{ name: "unit", bucket: "fail", link: job(21), workflow: "CI", startedAt: "2026-11-18T01:00:00Z" }];

    await redExcerpts(checks, ["unit"], HEAD, reader);

    expect(read).toEqual(["job 21"]);
  });
});
