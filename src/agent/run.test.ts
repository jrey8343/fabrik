import { afterEach, describe, expect, it, vi } from "vitest";
import { modelFor, RUNS } from "./run.ts";

describe("The model a run is given, from the Kit job's plan (FABRIK_MODEL)", () => {
  const role = { model: "claude-opus-5-5", effort: "medium" };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("in a repo that opted in to Fable, gives a Step-up its Fable model and effort", () => {
    vi.stubEnv("FABRIK_MODEL", "claude-fable-5-2");
    vi.stubEnv("FABRIK_EFFORT", "high");

    expect(modelFor(role, true)).toEqual({ model: "claude-fable-5-2", effort: "high" });
  });

  it.each([
    ["claude-fable-5-2", false],
    ["fable", true],
    ["best", true],
  ])("refuses %j with allow_fable %s, as Kit config would, so a bad route never reaches the CLI", (model, allowFable) => {
    vi.stubEnv("FABRIK_MODEL", model);

    expect(() => modelFor(role, allowFable)).toThrow(`Refusing to run ${model} in an AFK role`);
  });

  it("gives the role's own model when the plan chose none", () => {
    vi.stubEnv("FABRIK_MODEL", "");

    expect(modelFor(role, false)).toEqual(role);
  });
});

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
