import { describe, expect, it } from "vitest";
import { type CheckState, requiredChecksOutcome } from "./checks.ts";

const check = (name: string, bucket: CheckState["bucket"]): CheckState => ({ name, bucket });

describe("An agent PR's required checks", () => {
  it("are green when every one passed", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("test", "pass")], [])).toEqual({ kind: "green" });
  });

  it("are still pending while any one runs", () => {
    expect(requiredChecksOutcome([check("build", "pass"), check("test", "pending")], [])).toEqual({ kind: "pending" });
  });

  it("are red as soon as one fails, naming it", () => {
    expect(requiredChecksOutcome([check("build", "fail"), check("test", "pending")], [])).toEqual({
      kind: "red",
      failed: ["build"],
    });
  });

  it.each(["cancel", "skipping"] as const)("count a %s check as not passed", (bucket) => {
    expect(requiredChecksOutcome([check("build", bucket)], [])).toEqual({ kind: "red", failed: ["build"] });
  });

  it("are only the Kit config's gating checks when it lists some", () => {
    const checks = [check("build", "pass"), check("lint", "fail")];

    expect(requiredChecksOutcome(checks, ["build"])).toEqual({ kind: "green" });
  });

  it("wait for a gating check that hasn't reported yet", () => {
    expect(requiredChecksOutcome([check("build", "pass")], ["build", "e2e"])).toEqual({ kind: "pending" });
  });

  it("are green when nothing gates the PR", () => {
    expect(requiredChecksOutcome([], [])).toEqual({ kind: "green" });
  });
});
