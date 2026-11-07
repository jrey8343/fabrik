// The setup program, which the bootstrap command (setup.sh) downloads at the
// release being set up and runs from the Product repo's clone, on the
// Operator's terminal, with their own gh and op sign-ins:
//   node src/setup/main.ts <product checkout> <release>          in a terminal: one run, to the setup PR
//   node src/setup/main.ts <product checkout> <release> --plan   prints the plan, and never does more
// It runs its checks first, and offers to delete an old copy of the
// fabrik-setup skill. Then it chooses the 1Password account (--account=, or
// the only one, or asks with OP_ACCOUNT as the default, which answers without
// a terminal), and asks the questions the flags left out: --time-zone=<IANA
// zone>, --second-subscription and --paused, each with a --no- form. It asks
// only when stdin is a terminal: without one it prints the plan and stops. In
// a terminal it asks for a yes, applies the plan on fabrik/setup-<release>,
// runs the wizard in the same terminal, then commits, pushes and opens the
// setup PR. Visual evidence isn't setup's:
// /fabrik-visual-evidence turns it on. Thin by design: the program is in
// program.ts, one run's order in oneRun.ts, and every decision about the
// repo in the planner (plan.ts).
import { resolve } from "node:path";
import { spawnRun } from "./exec.ts";
import { runSetup } from "./program.ts";
import { terminalPrompt } from "./prompt.ts";
import { runWizardInTerminal } from "./wizard.ts";

if (import.meta.main) {
  const prompt = terminalPrompt(process.stdin, process.stdout);
  let closed = false;
  // The wizard reads the terminal itself, so setup lets go of it first.
  const close = () => {
    if (closed) return;
    closed = true;
    prompt?.close();
  };
  runSetup(process.argv.slice(2), {
    run: spawnRun,
    env: process.env,
    cwd: process.cwd(),
    prompt,
    say: (line) => console.log(line),
    complain: (line) => console.error(line),
    kitDir: resolve(import.meta.dirname, "..", ".."),
    nodeVersion: process.versions.node,
    machineTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    wizard: (run) => {
      close();
      return runWizardInTerminal(run);
    },
  }).then(
    (code) => {
      close();
      process.exitCode = code;
    },
    (error: unknown) => {
      close();
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
