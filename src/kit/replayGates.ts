// A Replay arm's gates (#156): the Sandbox's setup, build and tests from Kit
// config at the Ticket's baseSha, run in turn on the arm's diff, then the
// merged PR's own tests, its hidden tests, laid over the tree and run with the
// test command again. Kit config with no test command tests nothing, and a
// merged PR with no tests has none to lay, neither of which is ever a pass.
// The gates job runs them (src/kit/replay-gates-main.ts) through a checkout it
// gives here. Pure, but for the checkout's commands.
import type { KitConfig } from "./config.ts";
import type { ReplayGates, ReplayHiddenTests } from "./replay.ts";

/** The file an arm's gates job passes out its ReplayArmGates in. */
export const REPLAY_GATES_FILE = "gates.json";

/** The file the gates job reads the merged PR's hidden tests into, before it runs any Product code: the PR's merge commit and the test files to lay from it. */
export const HIDDEN_TESTS_FILE = "hidden-tests.json";

/** The merged PR's hidden tests, as the gates job reads them: the commit they're laid from, and their paths. */
export interface HiddenTestsAt {
  readonly mergeCommit: string;
  readonly paths: readonly string[];
}

/** The arm's checkout, as the gates run in it: a Product command, true when it exits 0, and laying the merged PR's test files over the tree. */
export interface GatesCheckout {
  run(command: string): Promise<boolean>;
  layHiddenTests(paths: readonly string[]): Promise<void>;
}

/**
 * How the arm's gates and hidden tests went: setup, then build, each skipped
 * when Kit config has none and stopping the gates when it fails; then the
 * tests; then, whether or not those passed, the hidden tests laid over the
 * tree and the tests again. A failed setup or build leaves the hidden tests
 * not run, which counts as failing them.
 */
export async function runReplayGates(
  sandbox: Pick<KitConfig["sandbox"], "setup" | "build" | "test">,
  hiddenTests: readonly string[],
  checkout: GatesCheckout,
): Promise<{ readonly gates: ReplayGates; readonly hiddenTests: ReplayHiddenTests }> {
  const hidden = (otherwise: ReplayHiddenTests): ReplayHiddenTests =>
    sandbox.test === null ? "no-test-command" : hiddenTests.length === 0 ? "no-hidden-tests" : otherwise;
  if (sandbox.setup !== null && !(await checkout.run(sandbox.setup))) return { gates: "setup-failed", hiddenTests: hidden("not-run") };
  if (sandbox.build !== null && !(await checkout.run(sandbox.build))) return { gates: "build-failed", hiddenTests: hidden("not-run") };
  if (sandbox.test === null) return { gates: "no-test-command", hiddenTests: "no-test-command" };
  const gates: ReplayGates = (await checkout.run(sandbox.test)) ? "passed" : "tests-failed";
  if (hiddenTests.length === 0) return { gates, hiddenTests: "no-hidden-tests" };
  await checkout.layHiddenTests(hiddenTests);
  return { gates, hiddenTests: (await checkout.run(sandbox.test)) ? "passed" : "failed" };
}
