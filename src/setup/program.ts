// The setup program, from its command line to its plan. It runs the checks,
// chooses the 1Password account, reads the Product repo, asks the questions
// the flags left out, and prints the plan with the account on its first line.
// With --apply it also carries the plan out, as the setup skill's step 5 runs
// it. The command runner, environment and prompt come in from main.ts, so the
// tests run it all without real git, gh, op or a terminal.
import { resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { checkOp, chooseAccount } from "./account.ts";
import { apply, describeAction } from "./apply.ts";
import { parseSetupArgs, SETUP_USAGE } from "./args.ts";
import { checkSetup } from "./checks.ts";
import type { Env, Run } from "./exec.ts";
import { gatherState } from "./gather.ts";
import { loadSetupKit } from "./kit.ts";
import { planSetup, type SetupPlan, setupPaths } from "./plan.ts";
import type { Prompt } from "./prompt.ts";
import { askQuestions } from "./questions.ts";
import { pinCaller } from "./shims.ts";

export interface SetupIo {
  readonly run: Run;
  /** The program's environment. Setup never changes it: the account it chooses goes into each command's own. */
  readonly env: Env;
  /** Where a relative Product checkout is found from. */
  readonly cwd: string;
  /** Null when stdin isn't a terminal: then setup asks nothing. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
  readonly complain: (line: string) => void;
  /** The Fabrik checkout setup runs from, at the release being set up. */
  readonly kitDir: string;
  readonly nodeVersion: string;
  readonly machineTimeZone: string;
}

/** Runs setup, returning its exit code: 0 when done, 1 when it stopped, 2 on a bad command line. */
export async function runSetup(argv: readonly string[], io: SetupIo): Promise<number> {
  const parsed = parseSetupArgs(argv);
  if (!parsed.ok) {
    // Run with nothing, it only shows how it's run.
    if (argv.length > 0) io.complain(parsed.error);
    io.complain(SETUP_USAGE);
    return 2;
  }
  const args = parsed.args;
  const productDir = resolve(io.cwd, args.productDir);
  try {
    const kit = await loadSetupKit(io.kitDir, args.release);
    const pinned = checkCallerWorkflow(pinCaller(kit.templates.caller, args.release));
    if (!pinned.ok) return stop(io, `Can't set up Fabrik ${args.release}: ${pinned.error}`);

    const before: Run = (command, commandArgs, options) => io.run(command, commandArgs, { ...options, env: io.env });
    const paths = setupPaths(kit);
    const checked = await checkSetup({ run: before, productDir, release: args.release, env: io.env, nodeVersion: io.nodeVersion, setupPaths: paths });
    if (!checked.ok) return stop(io, checked.problem);
    const chosen = await chooseAccount({
      run: before,
      cwd: productDir,
      env: io.env,
      ...(args.account === undefined ? {} : { given: args.account }),
      prompt: io.prompt,
      say: io.say,
    });
    if (!chosen.ok) return stop(io, chosen.problem);

    // Every op call from here on, and the wizard, uses the chosen account.
    const env = { ...io.env, OP_ACCOUNT: chosen.account.opAccount };
    const run: Run = (command, commandArgs, options) => io.run(command, commandArgs, { ...options, env });
    const unreachable = await checkOp(run, productDir, env, chosen.account.name);
    if (unreachable !== null) return stop(io, unreachable);

    const state = await gatherState(run, productDir, checked.repo, paths);
    const answers = await askQuestions({ flags: args.answers, state, machineTimeZone: io.machineTimeZone, prompt: io.prompt, say: io.say });
    const plan = planSetup(state, kit, answers);

    io.say(`Setup uses the 1Password account ${chosen.account.name}.`);
    io.say("");
    if (args.apply) {
      for (const action of plan.actions) {
        await apply(run, action, productDir, state.repo);
        io.say(`- ${describeAction(action)}`);
      }
    }
    io.say(report(plan, args.apply));
    return 0;
  } catch (error) {
    return stop(io, error instanceof Error ? error.message : String(error));
  }
}

function stop(io: SetupIo, problem: string): number {
  io.complain(problem);
  return 1;
}

function report(plan: SetupPlan, applied: boolean): string {
  const lines =
    plan.actions.length === 0
      ? ["Nothing to do: this repo's Fabrik install is complete."]
      : applied
        ? ["Done."]
        : ["Setup would:", ...plan.actions.map((action) => `- ${describeAction(action)}`), "", "Run again with --apply to do it."];
  if (plan.notes.length > 0) lines.push("", "For the Operator:", ...plan.notes.map((note) => `- ${note}`));
  return lines.join("\n");
}
