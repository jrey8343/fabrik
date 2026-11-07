// The setup program, from its command line to the setup PR. It runs the
// checks, offers to delete an old copy of the fabrik-setup skill, chooses the
// 1Password account, reads the Product repo, asks the questions the flags left
// out, and prints the plan with the account on its first line. In a terminal
// it then asks the Operator's yes and makes one run of it (oneRun.ts): apply
// on the setup branch, the wizard, then the setup PR. Without a terminal, or
// with --plan, it stops at the plan. The command runner, environment, prompt
// and wizard come in from main.ts, so the tests run it all without real gh,
// op or a terminal.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import { checkOp, chooseAccount } from "./account.ts";
import { apply, describeAction, writtenPaths } from "./apply.ts";
import { parseSetupArgs, SETUP_USAGE } from "./args.ts";
import { checkSetup, offerToDeleteOldSetupSkill, type OriginTips } from "./checks.ts";
import { type Env, ok, type Run } from "./exec.ts";
import { appliedLines, closingLines } from "./finish.ts";
import { gatherState, vaultItems } from "./gather.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import { type OneRunSteps, readinessOf, runOnce } from "./oneRun.ts";
import { FABRIK_APP_VAULT, pausesDispatch, planSetup, type ProductState, type SetupAnswers, type SetupPlan, setupPaths } from "./plan.ts";
import { isYes, type Prompt } from "./prompt.ts";
import { askQuestions } from "./questions.ts";
import {
  commitSetupFiles,
  type DoneRecord,
  doneRecord,
  earlierSetupRun,
  openSetupPr,
  publishSetupPr,
  pushSetupBranch,
  setupBranch,
  switchToSetupBranch,
} from "./setupBranch.ts";
import { pinCaller } from "./shims.ts";
import { WIZARD_REPORT_ENV, WIZARD_SECOND_SUBSCRIPTION_ENV, type WizardRun } from "./wizard.ts";

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
    // What runs on the setup branch applied since their last setup PR, which that PR lists too.
    const record = doneRecord(before, productDir, args.release);
    const checked = await checkSetup({
      run: before,
      productDir,
      release: args.release,
      env: io.env,
      nodeVersion: io.nodeVersion,
      earlierWrites: async () => writtenPaths(await record.read()),
    });
    if (!checked.ok) return stop(io, checked.problem);
    await offerToDeleteOldSetupSkill({ env: io.env, prompt: args.plan ? null : io.prompt, say: io.say });
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
    // The default branch the checks found has no Kit config, so one here is the starter setup wrote on its branch.
    const config = await run("git", ["cat-file", "-e", `${checked.origin.defaultBranch}:${KIT_CONFIG_PATH}`], { cwd: productDir });
    const wroteStarter = config.code !== 0;
    const answers = await askQuestions({ flags: args.answers, state, wroteStarter, machineTimeZone: io.machineTimeZone, prompt: io.prompt, say: io.say });
    const plan = planSetup(state, kit, answers, { wroteStarter });

    io.say(`Setup uses the 1Password account ${chosen.account.name}.`);
    io.say("");
    if (io.prompt === null || args.plan) {
      const toDoIt = args.plan ? "Run setup again without --plan to do it." : "Setup carries the plan out only on your yes, so run it in a terminal to do it.";
      const branch = setupBranch(args.release);
      const left =
        plan.actions.length === 0
          ? [heldBy(branch), `What's left is the wizard, then pushing ${branch} and opening or updating the setup PR.`]
          : stepsOf(plan);
      io.say(withNotes(isComplete(plan, checked.branch, branch) ? [COMPLETE] : [...left, "", toDoIt], plan));
      return 0;
    }
    const inTerminal = { ...io, prompt: io.prompt };
    return await oneRun({
      io: inTerminal,
      run,
      env,
      kit,
      paths,
      record,
      answers,
      wroteStarter,
      plan,
      state,
      release: args.release,
      current: checked.branch,
      origin: checked.origin,
      productDir,
    });
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
  readonly record: DoneRecord;
  readonly answers: SetupAnswers;
  /** Whether the repo's Kit config is the starter setup wrote on its branch, which every plan of the run is told. */
  readonly wroteStarter: boolean;
  readonly plan: SetupPlan;
  readonly state: ProductState;
  readonly release: string;
  /** The branch the checks found the clone on. */
  readonly current: string;
  readonly origin: OriginTips;
  readonly productDir: string;
}

/** The plan, the Operator's yes, and one run from there to the setup PR. */
async function oneRun(inputs: OneRunInputs): Promise<number> {
  const { io, run, env, kit, paths, record, answers, wroteStarter, state, release, current, origin, productDir } = inputs;
  const cwd = productDir;
  const branch = setupBranch(release);
  const { repo } = state;
  const repoName = `${repo.owner}/${repo.name}`;

  if (isComplete(inputs.plan, current, branch)) {
    io.say(withNotes([COMPLETE], inputs.plan));
    return 0;
  }
  if (current !== branch) {
    const earlier = await earlierSetupRun(run, cwd, repoName, branch, repo.defaultBranch, origin.setupBranch);
    if (earlier !== null) return stop(io, earlier);
  }
  // The same actions, with notes that say what this run does once its wizard has run.
  const plan = planSetup(state, kit, answers, { wizardNext: true, wroteStarter });
  io.say(withNotes(plan.actions.length === 0 ? [heldBy(branch)] : stepsOf(plan), plan));
  io.say("");

  // A run on the setup branch picks up from one that stopped before its PR, which the PR lists too.
  const earlierDone = current === branch ? await record.read() : [];
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
      // From the default branch the setup branch starts again, so what earlier runs did on it is history.
      if (current !== branch) await record.clear();
      await switchToSetupBranch(run, cwd, branch, current);
      io.say(`On ${branch}.`);
    },
    apply: async (actions) => {
      for (const action of actions) {
        await apply(run, action, productDir, repo);
        await record.add(describeAction(action));
        io.say(`- ${describeAction(action)}`);
      }
    },
    wizard: async () => {
      io.say("");
      io.say("Now the wizard, for the steps only you can take.");
      const dir = await mkdtemp(join(tmpdir(), "fabrik-wizard-"));
      const reportPath = join(dir, "report");
      try {
        const secondSubscription = answers.secondSubscription === true ? "yes" : "no";
        await io.wizard({ cwd, env: { ...env, [WIZARD_REPORT_ENV]: reportPath, [WIZARD_SECOND_SUBSCRIPTION_ENV]: secondSubscription } });
        wizardReport = await readFile(reportPath, "utf8").catch(() => "");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    afterWizard: async () => {
      // Read again and planned again: a second Subscription's token the wizard stored gets its subscriptions line from this plan.
      const now = await gatherState(run, cwd, repo, paths);
      const appItems = now.vaults.includes(FABRIK_APP_VAULT) ? await vaultItems(run, cwd, FABRIK_APP_VAULT) : [];
      const earlierPr = (await openSetupPr(run, cwd, branch))?.body ?? null;
      return {
        plan: planSetup(now, kit, answers, { wroteStarter }),
        readiness: readinessOf({ repo: repoName, report: wizardReport, earlierPr, fabrikItems: now.fabrikItems, appItems }),
      };
    },
    commit: (written) => commitSetupFiles(run, cwd, written, release),
    somethingToPublish: async () => {
      // Commits can change nothing, as when the Operator merged in a default branch that already has a squash-merged setup PR's files.
      const [base, head] = (await ok(run, "git", ["rev-parse", `${origin.defaultBranch}^{tree}`, "HEAD^{tree}"], { cwd })).trim().split("\n");
      return base !== head || (await openSetupPr(run, cwd, branch)) !== null;
    },
    leaveSetupBranch: async () => {
      await ok(run, "git", ["switch", "-q", repo.defaultBranch], { cwd });
      await ok(run, "git", ["branch", "-q", "-D", branch], { cwd });
      await record.clear();
    },
    push: () => pushSetupBranch(run, cwd, branch, origin.setupBranch),
    publish: async (summary) => {
      // What the PR merges is the setup branch's Kit config, whatever this run's answer was.
      const config = await run("git", ["show", `HEAD:${KIT_CONFIG_PATH}`], { cwd });
      const merged = { ...summary, pausesDispatch: config.code === 0 && pausesDispatch(config.stdout) };
      const published = await publishSetupPr({ run, cwd, branch, defaultBranch: repo.defaultBranch, release, summary: merged });
      await record.clear();
      return published;
    },
  };

  const result = await runOnce({ plan, repo: repoName, earlierDone }, steps);
  if (result.kind === "declined") {
    io.say("Setup changed nothing.");
    return 0;
  }
  io.say("");
  if (result.kind === "applied") {
    for (const line of appliedLines(repo.defaultBranch, result.summary)) io.say(line);
    return 0;
  }
  for (const line of closingLines({ release, defaultBranch: repo.defaultBranch, url: result.url, summary: result.summary })) io.say(line);
  return 0;
}

function stop(io: SetupIo, problem: string): number {
  io.complain(problem);
  return 1;
}

const COMPLETE = "Nothing to do: this repo's Fabrik install is complete.";

/**
 * On the default branch, nothing to plan is a working install. On the setup
 * branch, an earlier run stopped partway: the wizard and the setup PR are left.
 */
function isComplete(plan: SetupPlan, current: string, branch: string): boolean {
  return plan.actions.length === 0 && current !== branch;
}

/** What an empty plan on the setup branch means. */
function heldBy(branch: string): string {
  return `${branch} already holds what an earlier run of setup applied.`;
}

/** The plan's steps, as setup would carry them out. */
function stepsOf(plan: SetupPlan): string[] {
  return ["Setup would:", ...plan.actions.map((action) => `- ${describeAction(action)}`)];
}

/** The lines, then the plan's notes for the Operator. */
function withNotes(lines: readonly string[], plan: SetupPlan): string {
  const notes = plan.notes.length === 0 ? [] : [...(lines.length === 0 ? [] : [""]), "For the Operator:", ...plan.notes.map((note) => `- ${note}`)];
  return [...lines, ...notes].join("\n");
}
