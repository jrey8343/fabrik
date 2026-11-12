import { describe, expect, it } from "vitest";
import { type CheckState, checksFromGh, requiredChecksOutcome } from "./checks.ts";

const check = (name: string, bucket: CheckState["bucket"]): CheckState => ({ name, bucket });

describe("An agent PR's required checks", () => {
  it("are green when every one passed", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("test", "pass")], [])).toEqual({ kind: "green" });
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
      skipped: [],
    });
  });

  it("count a cancelled check as not passed", () => {
    expect(requiredChecksOutcome([check("build", "cancel")], [])).toEqual({ kind: "red", failed: ["build"], skipped: [] });
  });

  it("count a skipped or neutral check as not passed, naming it as skipped too", () => {
    expect(requiredChecksOutcome([check("build", "fail"), check("e2e", "skipping")], [])).toEqual({
      kind: "red",
      failed: ["build", "e2e"],
      skipped: ["e2e"],
    });
  });

  it("never name a check as skipped when another run of it failed", () => {
    expect(requiredChecksOutcome([check("e2e", "skipping"), check("e2e", "fail")], [])).toEqual({ kind: "red", failed: ["e2e"], skipped: [] });
  });

  it("are only the Required checks the Kit config lists, when it lists some", () => {
    const checks = [check("build", "pass"), check("lint", "fail")];

    expect(requiredChecksOutcome(checks, ["build"])).toEqual({ kind: "green" });
  });

  it("wait for a Required check the Kit config lists that hasn't reported yet, naming it apart from the ones still running", () => {
    expect(requiredChecksOutcome([check("build", "pending")], ["build", "e2e"])).toEqual({
      kind: "pending",
      unreported: ["e2e"],
      running: ["build"],
    });
  });

  it("are green when nothing gates the PR", () => {
    expect(requiredChecksOutcome([], [])).toEqual({ kind: "green" });
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
