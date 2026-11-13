// One setup run, from the Operator's yes to the setup PR, and the rule for
// when it asks for the merge. The order is fixed here: apply the plan on the
// setup branch, walk the wizard, read the repo and 1Password again, then
// commit, push and open the setup PR. When the setup branch then holds
// nothing the default branch lacks, there's no PR: the run goes back to the
// default branch. Each step is injected, so this module does no git, gh, op or
// terminal work itself.
import { KIT_CONFIG_PATH, resolveKitConfig, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { describeAction, writtenPaths } from "./apply.ts";
import { appConfirmedIn, lastOfEach } from "./finish.ts";
import {
  type BranchProtection,
  CLAUDE_TOKEN_ITEM,
  FABRIK_APP_VAULT,
  FABRIK_VAULT,
  type ProductState,
  requiredChecks,
  SECOND_SUBSCRIPTION,
  type SetupAction,
  type SetupAnswers,
  type SetupPlan,
  subscriptionsTheKitReads,
  takesSecondSubscription,
} from "./plan.ts";
import { appInstalledIn } from "./wizard.ts";

/** What the Kit's first runs need before the setup PR merges, read after the wizard. */
export interface Readiness {
  /** The Operator confirmed, in this run's wizard or an earlier run's, that the Fabrik App is installed on the repo. */
  readonly appInstalled: boolean;
  /** The "Fabrik App" item is in the "Fabrik App" vault. */
  readonly appKeyStored: boolean;
  /** The first Subscription the Kit config the setup PR merges lists, while the "Fabrik" vault lacks its token: the first runs read it, and a later one only once those before it are used up. */
  readonly tokensLacking: readonly string[];
}

/** The item that holds the Fabrik App's client ID and private key, in the "Fabrik App" vault. */
export const FABRIK_APP_ITEM = "Fabrik App";
/** The token the Monitor reads Sentry with, in the "Fabrik App" vault. */
export const SENTRY_TOKEN_ITEM = "Sentry token";

const APP_KEY = `the Fabrik App's key, in the "${FABRIK_APP_VAULT}" vault`;
const CLAUDE_TOKEN = `the Claude token, in the "${FABRIK_VAULT}" vault`;
const SECOND_TOKEN = `the second Subscription's token, "${SECOND_SUBSCRIPTION}", in the "${FABRIK_VAULT}" vault`;
/** How setup names the token of each Subscription a wizard stage stores. It stores no other. */
const WIZARD_TOKENS: ReadonlyMap<string, string> = new Map([
  [CLAUDE_TOKEN_ITEM, CLAUDE_TOKEN],
  [SECOND_SUBSCRIPTION, SECOND_TOKEN],
]);

/**
 * What a wizard stage stores that 1Password lacks, as setup names it for the
 * Operator: the Fabrik App's key, the Claude token once the Kit config lists
 * it, the second Subscription's token once the Kit config lists it or setup
 * would list it on the Operator's yes, and the Sentry token once
 * monitor.errors names Sentry. The Kit reads only the Subscriptions listed,
 * and the wizard stores no other Subscription's token, so one the Kit config
 * lists under another name is the plan's note, not a gap. The App's install
 * and the GitHub settings stages leave nothing setup can read, so they're
 * never among them.
 */
export function wizardGaps(state: ProductState, answers: SetupAnswers, appItems: readonly string[]): string[] {
  const config = state.files[KIT_CONFIG_PATH] ?? null;
  const listed = subscriptionsTheKitReads(config);
  // As the plan has it: a yes adds the second Subscription only to a list of one.
  const second = listed.includes(SECOND_SUBSCRIPTION) || (answers.secondSubscription === true && takesSecondSubscription(listed));
  const read = resolveKitConfig({ config, skillsLock: state.files[SKILLS_SOURCES_LOCK_PATH] ?? null });
  const readsSentry = read.ok && read.config.monitor.errors !== null;
  return [
    ...(appItems.includes(FABRIK_APP_ITEM) ? [] : [APP_KEY]),
    ...(listed.includes(CLAUDE_TOKEN_ITEM) && !state.fabrikItems.includes(CLAUDE_TOKEN_ITEM) ? [CLAUDE_TOKEN] : []),
    ...(second && !state.fabrikItems.includes(SECOND_SUBSCRIPTION) ? [SECOND_TOKEN] : []),
    ...(readsSentry && !appItems.includes(SENTRY_TOKEN_ITEM)
      ? [`the Sentry token, in the "${FABRIK_APP_VAULT}" vault, which monitor.errors in ${KIT_CONFIG_PATH} reads`]
      : []),
  ];
}

/** What the setup PR merges and the repo hold, which the closing lines read to leave out the notes for steps already done. */
export interface DoneSources {
  /** The setup branch's Kit config, null when it has none. */
  readonly kitConfig: string | null;
  /** The setup branch's Skills sources lockfile, null when it has none. */
  readonly skillsLock: string | null;
  /** The default branch's protection, null when it has none. */
  readonly protection: BranchProtection | null;
  /** The "Fabrik App" vault's item titles. */
  readonly appItems: readonly string[];
}

/** Which finishing steps are done. A Kit config that's invalid or unreadable shows none done. */
export function stepsDone({ kitConfig, skillsLock, protection, appItems }: DoneSources): Required<StepsDone> {
  const read = resolveKitConfig({ config: kitConfig, skillsLock });
  if (!read.ok) return { checks: false, extraSkills: false, monitor: false, visualEvidence: false };
  const { sandbox, skillsSources, extraSkills, monitor, ui } = read.config;
  const required = protection === null ? [] : requiredChecks(protection);
  return {
    checks: sandbox.checks.length > 0 && sandbox.checks.every((check) => required.includes(check)),
    extraSkills: skillsSources.length > 0 && Object.values(extraSkills).some((picked) => picked.length > 0),
    monitor: monitor.errors !== null && appItems.includes(SENTRY_TOKEN_ITEM),
    visualEvidence: ui !== null,
  };
}

export interface AfterWizard {
  /** The Product repo, as owner/name. */
  readonly repo: string;
  /** What the wizard wrote to its report file. */
  readonly report: string;
  /** The body of the setup PR open from the setup branch, if any, which keeps an earlier run's confirmation that the App is installed. */
  readonly earlierPr?: string | null;
  /** The "Fabrik" vault's item titles. */
  readonly fabrikItems: readonly string[];
  /** The "Fabrik App" vault's item titles. */
  readonly appItems: readonly string[];
  /** The Kit config the setup PR merges, the setup branch's, whose subscriptions the Kit reads. Null leaves them to the starter's. */
  readonly kitConfig?: string | null;
}

/** The merge rule's facts, from what the wizard left behind rather than how it ended. */
export function readinessOf({ repo, report, earlierPr = null, fabrikItems, appItems, kitConfig = null }: AfterWizard): Readiness {
  return {
    // A user's gh can't read an App's installations, so a later run's wizard needn't be walked again to keep it.
    appInstalled: appInstalledIn(report, repo) || (earlierPr !== null && appConfirmedIn(earlierPr, repo)),
    appKeyStored: appItems.includes(FABRIK_APP_ITEM),
    tokensLacking: subscriptionsTheKitReads(kitConfig)
      .slice(0, 1)
      .filter((name) => !fabrikItems.includes(name)),
  };
}

/** What the run did and left, for the setup PR and the Operator. */
export interface RunSummary {
  /** Each step setup carried out in this run. */
  readonly done: readonly string[];
  /** The notes for the Operator, from the plan made after the wizard. */
  readonly notes: readonly string[];
  /** What the merge waits for that the wizard finishes. Empty when nothing it finishes holds the merge back, or there's no setup PR. */
  readonly blockers: readonly string[];
  /** What else the merge waits for: the token of each listed Subscription no wizard stage stores, which the Operator stores by hand, as the plan's note says. */
  readonly storeByHand?: readonly string[];
  /** The repo the Operator has confirmed the Fabrik App is installed on, which the setup PR keeps for later runs. */
  readonly appInstalledOn?: string;
  /** Whether the Kit config the setup PR merges, the setup branch's, pauses Dispatch. */
  readonly pausesDispatch?: boolean;
  /** Which finishing steps the Kit config the setup PR merges, and the repo, already show done, so the closing lines leave out their notes. Absent counts as not done. */
  readonly alreadyDone?: StepsDone;
}

/** The finishing steps the closing lines give a note for, each true once the Kit config and the repo show it done. */
export interface StepsDone {
  /** sandbox.checks lists at least one check, and the default branch requires every one. */
  readonly checks?: boolean;
  /** The Skills sources lockfile pins a source, and some role has skills picked. */
  readonly extraSkills?: boolean;
  /** monitor.errors names a provider, and the "Fabrik App" vault holds the Sentry token. */
  readonly monitor?: boolean;
  /** The Kit config sets ui. */
  readonly visualEvidence?: boolean;
}

export interface Published {
  readonly url: string;
  /** The summary as the PR has it, with what earlier runs did. */
  readonly summary: RunSummary;
}

export interface OneRunSteps {
  /** The Operator's yes to the plan. */
  confirm(): Promise<boolean>;
  /** Switches to the setup branch, creating it when it's missing. */
  switchToSetupBranch(): Promise<void>;
  /** Carries out these actions, in order. */
  apply(actions: readonly SetupAction[]): Promise<void>;
  /** The wizard's stages, in the Operator's terminal. However it ends, the run goes on. */
  wizard(): Promise<void>;
  /**
   * Reads the repo and 1Password again, and plans again, now the wizard has
   * stored what it stored. A file this plan writes goes in the same PR, such
   * as the `subscriptions` line once a second Subscription's token is stored.
   */
  afterWizard(): Promise<{ readonly plan: SetupPlan; readonly readiness: Readiness }>;
  /** Commits these files, the ones setup wrote on the setup branch, returning whether there was anything to commit. */
  commit(paths: readonly string[]): Promise<boolean>;
  /** Whether the setup branch holds anything for the setup PR: files that differ from origin's default branch, or a setup PR open from it. */
  somethingToPublish(): Promise<boolean>;
  /** Switches back to the default branch and deletes the setup branch, which holds nothing the default branch lacks. */
  leaveSetupBranch(): Promise<void>;
  push(): Promise<void>;
  /** Opens the setup PR, or updates the one already open from the setup branch. */
  publish(summary: RunSummary): Promise<Published>;
}

export type OneRunResult =
  | { readonly kind: "declined" }
  /** The run wrote no file the default branch lacks, so there's no setup PR. */
  | { readonly kind: "applied"; readonly summary: RunSummary }
  | ({ readonly kind: "done" } & Published);

export interface OneRun {
  /** The plan the Operator saw. */
  readonly plan: SetupPlan;
  /** The Product repo, as owner/name. */
  readonly repo: string;
  /** What earlier runs on the setup branch applied since the last setup PR they published, as describeAction words it. */
  readonly earlierDone?: readonly string[];
}

export async function runOnce({ plan, repo, earlierDone = [] }: OneRun, steps: OneRunSteps): Promise<OneRunResult> {
  if (!(await steps.confirm())) return { kind: "declined" };
  await steps.switchToSetupBranch();
  if (plan.actions.length > 0) await steps.apply(plan.actions);
  await steps.wizard();

  const after = await steps.afterWizard();
  // Only files: they go in this PR. Anything else wasn't in the plan the Operator said yes to.
  const files = after.plan.actions.filter((action) => action.kind === "write-file");
  const rest = after.plan.actions.filter((action) => action.kind !== "write-file");
  if (files.length > 0) await steps.apply(files);
  const notes = [...after.plan.notes];
  if (rest.length > 0) {
    notes.push(
      `Setup found more to do after the wizard, and left it for the next run: ${rest.map(describeAction).join("; ")}. Run setup again to do it.`,
    );
  }

  const done = lastOfEach([...earlierDone, ...[...plan.actions, ...files].map(describeAction)]);
  // Only what this run or the earlier ones wrote: a file of setup's the Operator edited by hand isn't the setup PR's.
  const committed = await steps.commit(writtenPaths(done));
  // A setup PR that changes no file would merge nothing, as after a repair of only labels, secrets or protection.
  if (!committed && !(await steps.somethingToPublish())) {
    await steps.leaveSetupBranch();
    return { kind: "applied", summary: { done, notes, blockers: [] } };
  }
  await steps.push();
  const published = await steps.publish({
    done,
    notes,
    blockers: mergeBlockers(after.readiness, repo),
    storeByHand: tokensByHand(after.readiness),
    ...(after.readiness.appInstalled ? { appInstalledOn: repo } : {}),
  });
  return { kind: "done", ...published };
}

/**
 * What the merge waits for that the wizard finishes: the Fabrik App on the
 * repo, its key, and the first listed Subscription's token when a wizard stage
 * stores it. Sentry, a later Subscription, notifications and watching don't
 * hold it back.
 */
export function mergeBlockers(readiness: Readiness, repo: string): string[] {
  return [
    ...(readiness.appInstalled ? [] : [`the Fabrik App, installed on ${repo}`]),
    ...(readiness.appKeyStored ? [] : [APP_KEY]),
    ...readiness.tokensLacking.flatMap((name) => WIZARD_TOKENS.get(name) ?? []),
  ];
}

/** The first listed Subscription's token the merge also waits for, under a name no wizard stage stores, so the Operator stores it by hand. */
export function tokensByHand(readiness: Readiness): string[] {
  return readiness.tokensLacking
    .filter((name) => !WIZARD_TOKENS.has(name))
    .map((name) => `the ${JSON.stringify(name)} Subscription's token, in the "${FABRIK_VAULT}" vault`);
}
