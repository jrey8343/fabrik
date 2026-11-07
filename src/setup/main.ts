// The setup program, run from a Fabrik checkout at the release being set up,
// with the Operator's own gh and op sign-ins:
//   node src/setup/main.ts <product checkout> <release>          prints the plan
//   node src/setup/main.ts <product checkout> <release> --plan   prints the plan, and never does more
//   node src/setup/main.ts <product checkout> <release> --apply  carries it out
// It runs its checks first, then chooses the 1Password account (--account=, or
// OP_ACCOUNT, or the only one, or asks), then asks the questions the flags
// left out: --time-zone=<IANA zone>, --second-subscription and --paused, each
// with a --no- form. It asks only when stdin is a terminal. Visual evidence
// isn't setup's: /fabrik-visual-evidence turns it on. Thin by design: the
// program is in program.ts, and every decision about the repo is in the
// planner (plan.ts).
import { resolve } from "node:path";
import { spawnRun } from "./exec.ts";
import { runSetup } from "./program.ts";
import { terminalPrompt } from "./prompt.ts";

if (import.meta.main) {
  const prompt = terminalPrompt(process.stdin, process.stdout);
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
  }).then(
    (code) => {
      prompt?.close();
      process.exitCode = code;
    },
    (error: unknown) => {
      prompt?.close();
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
