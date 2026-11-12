import { describe, expect, it } from "vitest";
import { type CheckState, checksFromGh, requiredChecksOutcome } from "./checks.ts";

const check = (name: string, bucket: CheckState["bucket"]): CheckState => ({ name, bucket });

describe("An agent PR's required checks", () => {
  it("are green when every one passed", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("test", "pass")], [])).toEqual({ kind: "green", ranNothing: [] });
  });

  it("are still pending while any one runs, naming it", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("test", "pending")], [])).toEqual({
      kind: "pending",
      unreported: [],
      running: ["test"],
    });
  });

  it("are red as soon as one fails, naming it", () => {
    expect(requiredChecksOutcome([check("build", "fail"), check("test", "pending")], [])).toEqual({
      kind: "red",
      failed: ["build"],
    });
  });

  it("count a cancelled check as failing", () => {
    expect(requiredChecksOutcome([check("build", "cancel")], [])).toEqual({ kind: "red", failed: ["build"] });
  });

  it("are green when a skipped or neutral listed check sits beside passing ones, naming it as having run nothing", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("e2e", "skipping")], ["build", "e2e"])).toEqual({
      kind: "green",
      ranNothing: ["e2e"],
    });
  });

  it("are green when every check they wait on was skipped or neutral", () => {
    expect(requiredChecksOutcome([check("build", "skipping"), check("e2e", "skipping")], [])).toEqual({
      kind: "green",
      ranNothing: ["build", "e2e"],
    });
  });

  it("are red when a skipped check sits beside a failed one, naming only the failed one", () => {
    expect(requiredChecksOutcome([check("build", "fail"), check("e2e", "skipping")], [])).toEqual({ kind: "red", failed: ["build"] });
  });

  it("never name a check as having run nothing when another run of it passed", () => {
    expect(requiredChecksOutcome([check("e2e", "skipping"), check("e2e", "pass")], [])).toEqual({ kind: "green", ranNothing: [] });
  });

  it("are only the Required checks the Kit config lists, when it lists some", () => {
    const checks = [check("build", "pass"), check("lint", "fail")];

    expect(requiredChecksOutcome(checks, ["build"])).toEqual({ kind: "green", ranNothing: [] });
  });

  it("wait for a Required check the Kit config lists that hasn't reported yet, naming it apart from the ones still running", () => {
    expect(requiredChecksOutcome([check("build", "pending")], ["build", "e2e"])).toEqual({
      kind: "pending",
      unreported: ["e2e"],
      running: ["build"],
    });
  });

  it("are green when nothing gates the PR", () => {
    expect(requiredChecksOutcome([], [])).toEqual({ kind: "green", ranNothing: [] });
  });
});

describe("Reading `gh pr checks` output", () => {
  it("reads the checks it printed, even when gh exits non-zero because some are pending", () => {
    const stdout = JSON.stringify([{ name: "build", bucket: "pending" }]);

    expect(checksFromGh({ stdout, stderr: "", failed: true })).toEqual([{ name: "build", bucket: "pending" }]);
  });

  it("reads no checks when the repo has no required checks", () => {
    const stderr = "no required checks reported on the 'fabrik/ticket-9' branch\n";

    expect(checksFromGh({ stdout: "", stderr, failed: true })).toEqual([]);
  });

  it("fails loudly, with gh's error, when gh fails without printing checks", () => {
    const stderr = "GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)\n";

    expect(() => checksFromGh({ stdout: "", stderr, failed: true })).toThrow(/Resource not accessible by integration/);
  });
});
