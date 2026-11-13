import { describe, expect, it } from "vitest";
import type { CheckDetail } from "./rerun.ts";
import { type ChecksWaitGitHub, errorReport, gaveUpReport, type PullRequestState, ranNothingLine, requiredChecksToWaitOn, waitForRequiredChecks } from "./wait.ts";

const HEAD = "a".repeat(40);
const MINUTE = 60_000;

const open: PullRequestState = { headRefOid: HEAD, isDraft: true, state: "OPEN" };

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
    });
  });

  it("gives up at its own deadline on checks still running, naming them", async () => {
    const { github, options } = fakes([[check("build", "pending")]]);

    expect(await waitForRequiredChecks(github, options(["build"]))).toEqual({
      checks: "gave-up",
      headSha: HEAD,
      unreported: [],
      running: ["build"],
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
    expect(await waitOn(["a", "b"], ["a"], [[check("a", "pass")]])).toEqual({ checks: "gave-up", headSha: HEAD, unreported: ["b"], running: [] });
  });

  it("still include a check the Kit config lists that the branch doesn't require", async () => {
    expect(await waitOn(["a"], ["a", "c"], [[check("a", "pass"), check("c", "fail")]])).toEqual({ checks: "red", headSha: HEAD, failed: ["c"] });
  });

  it("give up naming a check the branch requires that never registered on the head, with nothing listed in the Kit config", async () => {
    expect(await waitOn(["b"], [], [[]])).toEqual({ checks: "gave-up", headSha: HEAD, unreported: ["b"], running: [] });
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
  it("names the Required checks that never reported, even with others still running", () => {
    expect(gaveUpReport({ checks: "gave-up", headSha: HEAD, unreported: ["e2e"], running: ["build"] })).toEqual({
      failure: "unreported-checks",
      detail: "",
      checks: ["e2e"],
    });
  });

  it("is a timeout naming the checks still running when every Required check reported", () => {
    expect(gaveUpReport({ checks: "gave-up", headSha: HEAD, unreported: [], running: ["build", "lint"] })).toEqual({
      failure: "timeout",
      detail: "",
      checks: ["build", "lint"],
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
