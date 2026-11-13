import { describe, expect, it } from "vitest";
import { type ReleaseRunningFacts, releaseRunningPlan } from "./releaseRunning.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42";

function facts(overrides: Partial<ReleaseRunningFacts> = {}): ReleaseRunningFacts {
  return {
    running: "v1.4.0",
    move: { sha: "abc1234def", release: "v1.4.0", pull: { number: 31, comments: [] } },
    runUrl: RUN,
    startedAt: "2026-11-13T04:17:09Z",
    timeZone: "Australia/Sydney",
    ...overrides,
  };
}

describe("Saying on the pull request that moved the pin that its release is running", () => {
  it("comments on the pin move's pull request with the release, the run, its release notes and the hidden marker", () => {
    const plan = releaseRunningPlan(facts());

    expect(plan.comment).toEqual({
      pull: 31,
      body: [
        "Fabrik v1.4.0 is running here: the hourly Tick started on it at 2026-11-13 15:17 Australia/Sydney ([its run](https://github.com/acme/shop/actions/runs/42)). [v1.4.0's release notes](https://github.com/jrey8343/fabrik/releases/tag/v1.4.0) say what changed and whether anything needs turning on.",
        "",
        "<!-- fabrik:release-running v1.4.0 -->",
      ].join("\n"),
    });
    expect(plan.summary).toBe("Fabrik v1.4.0 is running here, so #31, which moved the pin to it, is told.");
  });

  it("posts nothing when an App comment on the pull request already carries this release's marker", () => {
    const comments = [{ body: "Thanks!", byApp: false }, { body: "Fabrik v1.4.0 is running here...\n\n<!-- fabrik:release-running v1.4.0 -->", byApp: true }];
    const plan = releaseRunningPlan(facts({ move: { sha: "abc1234def", release: "v1.4.0", pull: { number: 31, comments } } }));

    expect(plan.comment).toBeNull();
    expect(plan.summary).toBe("Fabrik v1.4.0 is running here, and #31, which moved the pin to it, says so already.");
  });

  it.each([
    ["another release's marker from the App", { body: "<!-- fabrik:release-running v1.3.1 -->", byApp: true }],
    ["this release's marker in someone else's comment", { body: "<!-- fabrik:release-running v1.4.0 -->", byApp: false }],
  ])("still comments when the pull request has only %s", (_, comment) => {
    const plan = releaseRunningPlan(facts({ move: { sha: "abc1234def", release: "v1.4.0", pull: { number: 31, comments: [comment] } } }));

    expect(plan.comment?.pull).toBe(31);
    expect(plan.comment?.body).toContain("<!-- fabrik:release-running v1.4.0 -->");
  });

  it("posts nothing for a pin moved by a direct push to main, and says so", () => {
    const plan = releaseRunningPlan(facts({ move: { sha: "abc1234def", release: "v1.4.0", pull: null } }));

    expect(plan).toEqual({
      comment: null,
      summary: "Fabrik v1.4.0 is running here, but commit abc1234, which moved the pin to it, came from no pull request, so nothing is posted.",
    });
  });

  it("posts nothing when the pin pins no exact release", () => {
    const plan = releaseRunningPlan(facts({ running: "main", move: { sha: "abc1234def", release: null, pull: { number: 31, comments: [] } } }));

    expect(plan).toEqual({ comment: null, summary: "`.github/workflows/fabrik.yml` on main pins no exact Fabrik release, so nothing is posted." });
  });

  it("posts nothing when no commit on main brings the caller workflow", () => {
    const plan = releaseRunningPlan(facts({ move: null }));

    expect(plan).toEqual({ comment: null, summary: "No commit on main brings `.github/workflows/fabrik.yml`, so nothing is posted." });
  });

  it("posts nothing when the newest pin move pins another release than the one this Tick runs on", () => {
    const plan = releaseRunningPlan(facts({ running: "v1.3.1" }));

    expect(plan).toEqual({
      comment: null,
      summary: "This Tick runs on Fabrik v1.3.1, but the newest pin move on main, commit abc1234, pins v1.4.0, so nothing is posted.",
    });
  });

  it("confirms a revert that moves the pin back like any other pin move, though its pull request names the newer release", () => {
    const comments = [{ body: "Reverts #31, which moved Fabrik to v1.4.0. <!-- fabrik:release-running v1.4.0 -->", byApp: false }];
    const plan = releaseRunningPlan(facts({ running: "v1.3.0", move: { sha: "fed9876", release: "v1.3.0", pull: { number: 33, comments } } }));

    expect(plan.comment?.pull).toBe(33);
    expect(plan.comment?.body).toMatch(/^Fabrik v1\.3\.0 is running here: /);
    expect(plan.comment?.body).toContain("<!-- fabrik:release-running v1.3.0 -->");
    expect(plan.summary).toBe("Fabrik v1.3.0 is running here, so #33, which moved the pin to it, is told.");
  });
});
