import { describe, expect, it } from "vitest";
import { RUNS } from "./run.ts";

describe("What each run's ready hook readies before the agent starts (#703)", () => {
  it("runs setup then build for every run that builds a branch: an Implement run, a replay arm's and a prototype turn", () => {
    expect(RUNS["implement"]?.readies).toBe("setup-and-build");
    expect(RUNS["replay-implement"]?.readies).toBe("setup-and-build");
    expect(RUNS["prototype"]?.readies).toBe("setup-and-build");
  });

  it("runs setup alone for Triage and a Design session's other turns", () => {
    expect(RUNS["triage"]?.readies).toBe("setup");
    expect(RUNS["design"]?.readies).toBe("setup");
  });

  it("runs neither for the roles that only read the code", () => {
    for (const run of ["review", "audit", "retro", "research", "digest", "replay-review"]) {
      expect(RUNS[run]?.readies, run).toBe("none");
    }
  });

  it("names every run the script takes", () => {
    expect(Object.keys(RUNS).sort()).toEqual(
      ["audit", "design", "digest", "implement", "prototype", "replay-implement", "replay-review", "research", "retro", "review", "triage"],
    );
  });
});
