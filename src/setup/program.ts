// The setup program, from its command line to the setup PR. It runs the
// checks, chooses the 1Password account, reads the Product repo, asks the
// questions the flags left out, and prints the plan with the account on its
// first line. In a terminal it then asks the Operator's yes and makes one run
// of it (oneRun.ts): apply on the setup branch, the wizard, then the setup PR.
// Without a terminal, or with --plan, it stops at the plan. With --apply it
// only carries the plan out, as the setup skill's step 5 runs it. The command
// runner, environment, prompt and wizard come in from main.ts, so the tests
// run it all without real gh, op or a terminal.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { checkOp, chooseAccount } from "./account.ts";
import { apply, describeAction } from "./apply.ts";
import { parseSetupArgs, SETUP_USAGE } from "./args.ts";
import { checkSetup, setupBranch } from "./checks.ts";
import type { Env, Run } from "./exec.ts";
import { closingLines } from "./finish.ts";
import { gatherState, vaultItems } from "./gather.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import { type OneRunSteps, readinessOf, runOnce } from "./oneRun.ts";
import { FABRIK_APP_VAULT, planSetup, type ProductState, type SetupAnswers, type SetupPlan, setupPaths } from "./plan.ts";
import { isYes, type Prompt } from "./prompt.ts";
import { askQuestions } from "./questions.ts";
import { commitSetupFiles, earlierSetupRun, publishSetupPr, pushSetupBranch, switchToSetupBranch } from "./setupBranch.ts";
import { pinCaller } from "./shims.ts";
import { WIZARD_REPORT_ENV, type WizardRun } from "./wizard.ts";

export interface SetupIo {
  readonly run: Run;
  /** The program's environment. Setup never changes it: the account it chooses goes into each command's own. */
  readonly env: Env;
  /** Where a relative Product checkout is found from. */
  readonly cwd: string;
  /** Null when stdin isn't a terminal: then setup asks nothing, and stops at the plan. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
  readonly complain: (line: string) => void;
  /** The Fabrik checkout setup runs from, at the release being set up. */
  readonly kitDir: string;
  readonly nodeVersion: string;
  readonly machineTimeZone: string;
  /** Runs the wizard in the Operator's terminal, resolving once it has ended, however it ended. */
  readonly wizard: (run: WizardRun) => Promise<void>;
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
      io.say(withNotes([plan.actions.length === 0 ? COMPLETE : "Done."], plan));
      return 0;
    }
    if (io.prompt === null || args.plan) {
      io.say(withNotes(plan.actions.length === 0 ? [COMPLETE] : [...stepsOf(plan), "", "Run again with --apply to do it."], plan));
      return 0;
    }
    const inTerminal = { ...io, prompt: io.prompt };
    return await oneRun({ io: inTerminal, run, env, kit, paths, answers, plan, state, release: args.release, current: checked.branch, productDir });
  } catch (error) {
    return stop(io, error instanceof Error ? error.message : String(error));
  }
}

interface OneRunInputs {
  readonly io: SetupIo & { readonly prompt: Prompt };
  readonly run: Run;
  /** The environment every command runs in, OP_ACCOUNT included. */
  readonly env: Env;
  readonly kit: SetupKit;
  readonly paths: readonly string[];
  readonly answers: SetupAnswers;
  readonly plan: SetupPlan;
  readonly state: ProductState;
  readonly release: string;
  /** The branch the checks found the clone on. */
  readonly current: string;
  readonly productDir: string;
}

/** The plan, the Operator's yes, and one run from there to the setup PR. */
async function oneRun(inputs: OneRunInputs): Promise<number> {
  const { io, run, env, kit, paths, answers, plan, state, release, current, productDir } = inputs;
  const cwd = productDir;
  const branch = setupBranch(release);
  const { repo } = state;
  const repoName = `${repo.owner}/${repo.name}`;

  // On the default branch, nothing to plan is a working install. On the
  // setup branch, an earlier run stopped partway: the wizard and the PR are left.
  if (plan.actions.length === 0 && current !== branch) {
    io.say(withNotes([COMPLETE], plan));
    return 0;
  }
  if (current !== branch) {
    const earlier = await earlierSetupRun(run, cwd, branch, repo.defaultBranch);
    if (earlier !== null) return stop(io, earlier);
  }
  io.say(withNotes(plan.actions.length === 0 ? [`${branch} already holds what an earlier run of setup applied.`] : stepsOf(plan), plan));
  io.say("");

  let wizardReport = "";
  const steps: OneRunSteps = {
    confirm: async () =>
      isYes(
        await io.prompt.ask(
          plan.actions.length === 0
            ? `Nothing's left to apply. Walk the wizard, then push ${branch} and open the setup PR? [y/N] `
            : `Apply this plan on ${branch}, walk the wizard, then push it and open the setup PR? [y/N] `,
        ),
      ),
    switchToSetupBranch: async () => {
      await switchToSetupBranch(run, cwd, branch, current);
      io.say(`On ${branch}.`);
    },
    apply: async (actions) => {
      for (const action of actions) {
        await apply(run, action, productDir, repo);
        io.say(`- ${describeAction(action)}`);
      }
    },
    wizard: async () => {
      io.say("");
      io.say("Now the wizard, for the steps only you can take.");
      const dir = await mkdtemp(join(tmpdir(), "fabrik-wizard-"));
      const reportPath = join(dir, "report");
      try {
        await io.wizard({ cwd, env: { ...env, [WIZARD_REPORT_ENV]: reportPath } });
        wizardReport = await readFile(reportPath, "utf8").catch(() => "");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    afterWizard: async () => {
      // Read again and planned again: #322 writes the subscriptions line from this plan.
      const now = await gatherState(run, cwd, repo, paths);
      const appItems = now.vaults.includes(FABRIK_APP_VAULT) ? await vaultItems(run, cwd, FABRIK_APP_VAULT) : [];
      return {
        plan: planSetup(now, kit, answers),
        readiness: readinessOf({ repo: repoName, report: wizardReport, fabrikItems: now.fabrikItems, appItems }),
      };
    },
    commit: async () => void (await commitSetupFiles(run, cwd, paths, release)),
    push: () => pushSetupBranch(run, cwd, branch),
    publish: (summary) => publishSetupPr({ run, cwd, branch, defaultBranch: repo.defaultBranch, release, summary }),
  };

  const result = await runOnce({ plan, repo: repoName }, steps);
  if (result.kind === "declined") {
    io.say("Setup changed nothing.");
    return 0;
  }
  io.say("");
  const closing = { release, defaultBranch: repo.defaultBranch, url: result.url, summary: result.summary, paused: answers.paused === true };
  for (const line of closingLines(closing)) io.say(line);
  return 0;
}

function stop(io: SetupIo, problem: string): number {
  io.complain(problem);
  return 1;
}

const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";

/** The plan's steps, as setup would carry them out. */
function stepsOf(plan: SetupPlan): string[] {
  return ["Setup would:", ...plan.actions.map((action) => `- ${describeAction(action)}`)];
}

/** The lines, then the plan's notes for the Operator. */
function withNotes(lines: readonly string[], plan: SetupPlan): string {
  const notes = plan.notes.length === 0 ? [] : [...(lines.length === 0 ? [] : [""]), "For the Operator:", ...plan.notes.map((note) => `- ${note}`)];
  return [...lines, ...notes].join("\n");
}
