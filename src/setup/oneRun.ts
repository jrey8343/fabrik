// One setup run, from the Operator's yes to the setup PR, and the rule for
// when it asks for the merge. The order is fixed here: apply the plan on the
// setup branch, walk the wizard, read the repo and 1Password again, then
// commit, push and open the setup PR. When the setup branch then holds
// nothing the default branch lacks, there's no PR: the run goes back to the
// default branch. Each step is injected, so this module does no git, gh, op or
// terminal work itself.
import { describeAction } from "./apply.ts";
import { FABRIK_APP_VAULT, FABRIK_VAULT, type SetupAction, type SetupPlan } from "./plan.ts";
import { appInstalledIn } from "./wizard.ts";

/** What the Kit's first runs need before the setup PR merges, read after the wizard. */
export interface Readiness {
  /** The Operator confirmed, in the wizard, that the Fabrik App is installed on the repo. */
  readonly appInstalled: boolean;
  /** The "Fabrik App" item is in the "Fabrik App" vault. */
  readonly appKeyStored: boolean;
  /** The "Claude token" item is in the "Fabrik" vault. */
  readonly claudeTokenStored: boolean;
}

/** The item that holds the Fabrik App's client ID and private key, in the "Fabrik App" vault. */
export const FABRIK_APP_ITEM = "Fabrik App";
/** The first Subscription's token, in the "Fabrik" vault. */
export const CLAUDE_TOKEN_ITEM = "Claude token";

export interface AfterWizard {
  /** The Product repo, as owner/name. */
  readonly repo: string;
  /** What the wizard wrote to its report file. */
  readonly report: string;
  /** The "Fabrik" vault's item titles. */
  readonly fabrikItems: readonly string[];
  /** The "Fabrik App" vault's item titles. */
  readonly appItems: readonly string[];
}

/** The merge rule's three facts, from what the wizard left behind rather than how it ended. */
export function readinessOf({ repo, report, fabrikItems, appItems }: AfterWizard): Readiness {
  return {
    appInstalled: appInstalledIn(report, repo),
    appKeyStored: appItems.includes(FABRIK_APP_ITEM),
    claudeTokenStored: fabrikItems.includes(CLAUDE_TOKEN_ITEM),
  };
}

/** What the run did and left, for the setup PR and the Operator. */
export interface RunSummary {
  /** Each step setup carried out in this run. */
  readonly done: readonly string[];
  /** The notes for the Operator, from the plan made after the wizard. */
  readonly notes: readonly string[];
  /** What the merge waits for. Empty when the Operator can merge, or there's no setup PR. */
  readonly blockers: readonly string[];
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
  /** Commits whatever setup wrote on the setup branch, returning whether there was anything to commit. */
  commit(): Promise<boolean>;
  /** Whether the setup branch holds anything for the setup PR: commits origin's default branch lacks, or a setup PR open from it. */
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

  const done = [...new Set([...earlierDone, ...[...plan.actions, ...files].map(describeAction)])];
  // GitHub opens no PR that holds no commits, as after a repair of only labels, secrets or protection.
  if (!(await steps.commit()) && !(await steps.somethingToPublish())) {
    await steps.leaveSetupBranch();
    return { kind: "applied", summary: { done, notes, blockers: [] } };
  }
  await steps.push();
  const published = await steps.publish({ done, notes, blockers: mergeBlockers(after.readiness, repo) });
  return { kind: "done", ...published };
}

/** What the merge waits for: the Fabrik App on the repo, its key and the Claude token. Sentry, notifications and watching don't hold it back. */
export function mergeBlockers(readiness: Readiness, repo: string): string[] {
  return [
    ...(readiness.appInstalled ? [] : [`the Fabrik App, installed on ${repo}`]),
    ...(readiness.appKeyStored ? [] : [`the Fabrik App's key, in the "${FABRIK_APP_VAULT}" vault`]),
    ...(readiness.claudeTokenStored ? [] : [`the Claude token, in the "${FABRIK_VAULT}" vault`]),
  ];
}
