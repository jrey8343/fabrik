// The setup program, from its command line to the setup PR. It runs the
// checks, offers to delete an old copy of the fabrik-setup skill, chooses the
// 1Password account, reads the Product repo, asks the questions the flags left
// out, and prints the plan with the account on its first line. In a terminal
// it then asks the Operator's yes and makes one run of it (oneRun.ts): apply
// on the setup branch, the wizard, then the setup PR. On the default branch
// with nothing to apply, the run is the wizard's alone, offered only while
// 1Password lacks what a stage stores. Without a terminal, or with --plan, it
// stops at the plan. The command runner, environment, prompt
// and wizard come in from main.ts, so the tests run it all without real gh,
// op or a terminal.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { KIT_CONFIG_PATH, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { checkOp, chooseAccount } from "./account.ts";
import { apply, describeAction, writtenPaths } from "./apply.ts";
import { parseSetupArgs, SETUP_USAGE } from "./args.ts";
import { checkSetup, offerToDeleteOldSetupSkill, type OriginTips } from "./checks.ts";
import { type Env, ok, type Run } from "./exec.ts";
import { appliedLines, closingLines, setupCommand } from "./finish.ts";
import { gatherDeployments, gatherState, vaultItems } from "./gather.ts";
import { loadSetupKit, type SetupKit } from "./kit.ts";
import { type DoneSources, type OneRunSteps, readinessOf, runOnce, stepsDone, wizardGaps } from "./oneRun.ts";
import {
  FABRIK_APP_VAULT,
  listedSubscriptions,
  pausesDispatch,
  planSetup,
  type ProductState,
  type SetupAnswers,
  type SetupPlan,
  setupPaths,
  takesSecondSubscription,
} from "./plan.ts";
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
    const answers = await askQuestions({
      flags: args.answers,
      state,
      wroteStarter,
      machineTimeZone: io.machineTimeZone,
      prompt: io.prompt,
      say: io.say,
      deployments: () => gatherDeployments(run, productDir, checked.repo),
    });
    const plan = planSetup(state, kit, answers, { wroteStarter });
    const branch = setupBranch(args.release);
    // On the default branch, nothing to apply is a working install, but for what a wizard stage stores.
    const gaps = nothingToApply(plan, checked.branch, branch) ? wizardGaps(state, answers, await appVaultItems(run, productDir, state)) : [];

    io.say(`Setup uses the 1Password account ${chosen.account.name}.`);
    io.say("");
    if (io.prompt === null || args.plan) {
      if (nothingToApply(plan, checked.branch, branch)) {
        const toWalk = `Run setup in a terminal to walk the wizard for them: ${setupCommand(args.release)}`;
        io.say(withNotes(gaps.length === 0 ? [COMPLETE] : [...gapLines(gaps), "", toWalk], plan));
        return 0;
      }
      const toDoIt = args.plan ? "Run setup again without --plan to do it." : "Setup carries the plan out only on your yes, so run it in a terminal to do it.";
      const left =
        plan.actions.length === 0
          ? [heldBy(branch), `What's left is the wizard, then pushing ${branch} and opening or updating the setup PR.`]
          : stepsOf(plan);
      io.say(withNotes([...left, "", toDoIt], plan));
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
      gaps,
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
  /** On the default branch with nothing to apply, what a wizard stage stores that 1Password lacks. */
  readonly gaps: readonly string[];
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

  // On the default branch with nothing to apply, the run is the wizard's alone, and only for what 1Password lacks.
  const wizardOnly = nothingToApply(inputs.plan, current, branch);
  if (wizardOnly && inputs.gaps.length === 0) {
    io.say(withNotes([COMPLETE], inputs.plan));
    return 0;
  }
  if (current !== branch) {
    const earlier = await earlierSetupRun(run, cwd, repoName, branch, repo.defaultBranch, origin);
    if (earlier !== null) return stop(io, earlier);
  }
  // The same actions, with notes that say what this run does once its wizard has run.
  const plan = planSetup(state, kit, answers, { wizardNext: true, wroteStarter });
  io.say(withNotes(wizardOnly ? gapLines(inputs.gaps) : plan.actions.length === 0 ? [heldBy(branch)] : stepsOf(plan), plan));
  io.say("");

  // A run on the setup branch picks up from one that stopped before its PR, which the PR lists too.
  const earlierDone = current === branch ? await record.read() : [];
  let wizardReport = "";
  // What 1Password still lacks once the wizard has run.
  let gapsAfter: readonly string[] = [];
  // The branch protection and "Fabrik App" vault items read after the wizard.
  let readAfter: Pick<DoneSources, "protection" | "appItems"> = { protection: null, appItems: [] };
  // Whether the default branch the run left the setup branch for is origin's.
  let upToDate = true;
  const steps: OneRunSteps = {
    confirm: async () =>
      isYes(
        await io.prompt.ask(
          wizardOnly
            ? "Walk the wizard now? [y/N] "
            : plan.actions.length === 0
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
        // Yes only when setup lists the token the stage stores: a list of one, or the starter's.
        const listed = listedSubscriptions(state.files[KIT_CONFIG_PATH] ?? kit.templates.kitConfig);
        const secondSubscription = answers.secondSubscription === true && listed !== null && takesSecondSubscription(listed) ? "yes" : "no";
        await io.wizard({ cwd, env: { ...env, [WIZARD_REPORT_ENV]: reportPath, [WIZARD_SECOND_SUBSCRIPTION_ENV]: secondSubscription } });
        wizardReport = await readFile(reportPath, "utf8").catch(() => "");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    afterWizard: async () => {
      // Read again and planned again: a second Subscription's token the wizard stored gets its subscriptions line from this plan.
      const now = await gatherState(run, cwd, repo, paths);
      const appItems = await appVaultItems(run, cwd, now);
      const earlierPr = (await openSetupPr(run, cwd, branch))?.body ?? null;
      gapsAfter = wizardGaps(now, answers, appItems);
      readAfter = { protection: now.protection, appItems };
      return {
        plan: planSetup(now, kit, answers, { wroteStarter }),
        readiness: readinessOf({
          repo: repoName,
          report: wizardReport,
          earlierPr,
          fabrikItems: now.fabrikItems,
          appItems,
          kitConfig: now.files[KIT_CONFIG_PATH] ?? null,
        }),
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
      // From the setup branch, the default branch here can be behind origin's, whose tip the setup branch holds.
      await run("git", ["merge", "-q", "--ff-only", origin.defaultBranch], { cwd });
      upToDate = (await ok(run, "git", ["rev-parse", "HEAD"], { cwd })).trim() === origin.defaultBranch;
      await ok(run, "git", ["branch", "-q", "-D", branch], { cwd });
      await record.clear();
    },
    push: () => pushSetupBranch(run, cwd, branch, origin.setupBranch),
    publish: async (summary) => {
      // What the PR merges is the setup branch's Kit config, whatever this run's answer was.
      const onBranch = async (path: string) => {
        const shown = await run("git", ["show", `HEAD:${path}`], { cwd });
        return shown.code === 0 ? shown.stdout : null;
      };
      const [kitConfig, skillsLock] = await Promise.all([onBranch(KIT_CONFIG_PATH), onBranch(SKILLS_SOURCES_LOCK_PATH)]);
      const merged = {
        ...summary,
        pausesDispatch: kitConfig !== null && pausesDispatch(kitConfig),
        // So the closing lines leave out the notes for steps the setup branch's Kit config and the Product repo already show done.
        alreadyDone: stepsDone({ kitConfig, skillsLock, ...readAfter }),
      };
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
    for (const line of appliedLines(repo.defaultBranch, result.summary, upToDate)) io.say(line);
    if (wizardOnly) {
      io.say("");
      io.say(gapsAfter.length === 0 ? COMPLETE : [...gapLines(gapsAfter, true), `Run setup again to walk the wizard for them: ${setupCommand(release)}`].join("\n"));
    }
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
 * Whether the plan has nothing to apply on the default branch: a working
 * install, once 1Password holds what each wizard stage stores. An empty plan
 * on the setup branch isn't one, as an earlier run stopped partway there: the
 * wizard and the setup PR are left.
 */
function nothingToApply(plan: SetupPlan, current: string, branch: string): boolean {
  return plan.actions.length === 0 && current !== branch;
}

/** The Fabrik App vault's item titles, none when the account lacks it. */
async function appVaultItems(run: Run, cwd: string, state: ProductState): Promise<string[]> {
  return state.vaults.includes(FABRIK_APP_VAULT) ? await vaultItems(run, cwd, FABRIK_APP_VAULT) : [];
}

/** What a wizard stage stores that 1Password lacks, on the default branch with nothing to apply: before the wizard, or still after it. */
function gapLines(gaps: readonly string[], after = false): string[] {
  const heading = after ? "1Password still lacks what the wizard stores:" : "Nothing's left to apply, but 1Password lacks what the wizard stores:";
  return [heading, ...gaps.map((gap) => `- ${gap}`)];
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
