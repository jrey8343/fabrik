import { describe, expect, it } from "vitest";
import { runReplayGates } from "./replayGates.ts";

const SANDBOX = { setup: "npm ci", build: "npm run build", test: "npm test" };
const HIDDEN = ["src/cart.test.ts"];

/** A checkout whose commands fail when `failing` names them, logging each it runs and when it lays the hidden tests. */
function checkout(failing: (command: string, ran: readonly string[]) => boolean = () => false) {
  const ran: string[] = [];
  return {
    ran,
    run: async (command: string) => {
      ran.push(command);
      return !failing(command, ran);
    },
    layHiddenTests: async (paths: readonly string[]) => {
      ran.push(`lay ${paths.join(" ")}`);
    },
  };
}

describe("A replay arm's gates, on its diff", () => {
  it("runs setup, build and test, then lays the merged PR's tests over the tree and runs test again", async () => {
    const tree = checkout();

    expect(await runReplayGates(SANDBOX, HIDDEN, tree)).toEqual({ gates: "passed", hiddenTests: "passed" });
    expect(tree.ran).toEqual(["npm ci", "npm run build", "npm test", "lay src/cart.test.ts", "npm test"]);
  });

  it("runs the hidden tests even when the arm's own tests failed, and tells their results apart", async () => {
    const tree = checkout((command, ran) => command === "npm test" && !ran.some((line) => line.startsWith("lay")));

    expect(await runReplayGates(SANDBOX, HIDDEN, tree)).toEqual({ gates: "tests-failed", hiddenTests: "passed" });
  });

  it("reports hidden tests that fail", async () => {
    const tree = checkout((command, ran) => command === "npm test" && ran.some((line) => line.startsWith("lay")));

    expect(await runReplayGates(SANDBOX, HIDDEN, tree)).toEqual({ gates: "passed", hiddenTests: "failed" });
  });

  it.each([
    ["setup", "npm ci", "setup-failed", ["npm ci"]],
    ["build", "npm run build", "build-failed", ["npm ci", "npm run build"]],
  ] as const)("stops at a failed %s, the hidden tests not run, which counts as failing them", async (_, failing, gates, ran) => {
    const tree = checkout((command) => command === failing);

    expect(await runReplayGates(SANDBOX, HIDDEN, tree)).toEqual({ gates, hiddenTests: "not-run" });
    expect(tree.ran).toEqual(ran);
  });

  it("skips a setup or build Kit config doesn't have", async () => {
    const tree = checkout();

    await runReplayGates({ setup: null, build: null, test: "npm test" }, HIDDEN, tree);

    expect(tree.ran).toEqual(["npm test", "lay src/cart.test.ts", "npm test"]);
  });

  it("reports no test command, never a pass, for Kit config with none, after its setup and build", async () => {
    const tree = checkout();

    expect(await runReplayGates({ ...SANDBOX, test: null }, HIDDEN, tree)).toEqual({ gates: "no-test-command", hiddenTests: "no-test-command" });
    expect(tree.ran).toEqual(["npm ci", "npm run build"]);
  });

  it("reports no hidden tests, never a pass, for a merged PR that added or changed none, running the tests once", async () => {
    const tree = checkout();

    expect(await runReplayGates(SANDBOX, [], tree)).toEqual({ gates: "passed", hiddenTests: "no-hidden-tests" });
    expect(tree.ran).toEqual(["npm ci", "npm run build", "npm test"]);
  });

  it("still says the merged PR has no hidden tests when the build failed first", async () => {
    expect(await runReplayGates(SANDBOX, [], checkout((command) => command === "npm run build"))).toEqual({ gates: "build-failed", hiddenTests: "no-hidden-tests" });
  });
});
