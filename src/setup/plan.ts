// Setup's planner. Pure, no I/O: given what a Product repo holds now
// and the Kit being set up, it returns every step that would leave the repo
// ready to run the Loop, and nothing a working install already has.
import { DEFAULT_KIT_CONFIG, KIT_CONFIG_PATH, resolveKitConfig, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { ALL_LABELS, type Label as LoopLabel, LOOP_LABELS, READY_FOR_AGENT } from "../loop/labels.ts";
import { RUN_STORE, RUN_STORE_REPO } from "../kit/runStore.ts";
import { setupCommand } from "./finish.ts";
import { withMember } from "./json.ts";
import type { SetupKit } from "./kit.ts";
import {
  CALLER_PATH,
  callerUpdate,
  DEPENDABOT_PATH,
  dependabotUpdate,
  type FileUpdate,
  GITIGNORE_PATH,
  gitignoreUpdate,
  hasPrettierConfig,
  PRETTIER_DETECTION_PATHS,
  PRETTIERIGNORE_PATH,
  prettierignoreUpdate,
  scheduleIn,
  SETTINGS_PATH,
  settingsUpdate,
  STORE_CALLER_PATH,
  storeCallerUpdate,
} from "./shims.ts";

/** What Setup reads from a Product repo and its 1Password account before planning. */
export interface ProductState {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
    /** Whether an organization owns it. Only an organization repo's branch protection can have bypass allowances. */
    readonly inOrganization: boolean;
  };
  /** The text of each file Setup writes or merges, or null when the repo lacks it. */
  readonly files: Readonly<Record<string, string | null>>;
  readonly labels: readonly string[];
  readonly secrets: readonly string[];
  readonly vaults: readonly string[];
  /** The titles of the items in the `Fabrik` vault, where each Subscription's token lives. Empty when the vault is missing. */
  readonly fabrikItems: readonly string[];
  readonly protection: BranchProtection | null;
  /** The Merge gate ruleset, found by its name, or null when the repo lacks it. */
  readonly mergeGate: MergeGateRuleset | null;
  /** The fabrik-runs store every Product repo shares. Its Fabrik App vault is in `vaults`, the same 1Password account's. */
  readonly store: RunStoreState;
  /** How many open issues are labelled ready-for-agent: Dispatch releases them once the caller workflow is on the default branch. */
  readonly readyForAgent: number;
}

/** What setup reads about the fabrik-runs store (ADR-0009). */
export interface RunStoreState {
  readonly exists: boolean;
  readonly private: boolean;
  /** The text of each file setup writes in the store, or null when it lacks it. */
  readonly files: Readonly<Record<string, string | null>>;
  /** The store's Actions secret names. */
  readonly secrets: readonly string[];
}

/** What the Operator tells setup that no repo holds. */
export interface SetupAnswers {
  /**
   * The Operator's IANA time zone, such as Australia/Sydney, for the Weekly
   * summary's Monday-morning schedule. Without it setup leaves the store alone,
   * so the store stays an opt-in step.
   */
  readonly timeZone?: string;
  /**
   * Whether the Operator wants a second Subscription, so runs fail over to it
   * when the first reaches its weekly limit. With it, setup lists the second
   * Subscription in a Kit config that lists one, once its token is in the
   * vault. Without it setup says nothing about a second Subscription, so it
   * stays an opt-in step.
   */
  readonly secondSubscription?: boolean;
  /**
   * Whether to install with Dispatch paused: the starter Kit config is written
   * with `max_in_flight: 0`, so no Implementer starts until the Operator raises
   * it. A Kit config the default branch has is the Product's, so it's never
   * changed, but the starter on setup's branch is set to match, either way.
   */
  readonly paused?: boolean;
}

/**
 * A branch's protection, every setting of it, in the shape GitHub's PUT takes:
 * gather reads it, and the protect-branch step writes it back with only the
 * settings Setup owns changed. A setting the PUT leaves out GitHub switches
 * off, so the step sends them all.
 */
export interface BranchProtection {
  readonly required_status_checks: {
    readonly strict: boolean;
    /** Each check, with the GitHub App it must come from when it's bound to one. */
    readonly checks: readonly { readonly context: string; readonly app_id?: number }[];
  } | null;
  readonly enforce_admins: boolean;
  readonly required_pull_request_reviews: {
    readonly required_approving_review_count: number;
    readonly dismiss_stale_reviews: boolean;
    readonly require_code_owner_reviews: boolean;
    readonly require_last_push_approval: boolean;
    /** Who may dismiss a review. Only an organization repo's protection has it. */
    readonly dismissal_restrictions?: Allowances;
    /** Who may skip the pull request requirement. Only an organization repo's protection has it. */
    readonly bypass_pull_request_allowances?: Allowances;
  } | null;
  /** Who may push to the branch. Only an organization repo's protection has it. */
  readonly restrictions: Allowances | null;
  readonly required_linear_history: boolean;
  readonly allow_force_pushes: boolean;
  readonly allow_deletions: boolean;
  readonly block_creations: boolean;
  readonly required_conversation_resolution: boolean;
  readonly lock_branch: boolean;
  readonly allow_fork_syncing: boolean;
}

/** Users by login, teams and apps by slug. */
export interface Allowances {
  readonly users: readonly string[];
  readonly teams: readonly string[];
  readonly apps: readonly string[];
}

/** A branch without protection, as GitHub's PUT takes it: every setting off. */
export const UNPROTECTED: BranchProtection = {
  required_status_checks: null,
  enforce_admins: false,
  required_pull_request_reviews: null,
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false,
};

/** Who may skip a branch's pull request requirement, as `app:<slug>`, `user:<login>` or `team:<slug>`. */
export function bypassAllowances(protection: BranchProtection): string[] {
  const bypass = protection.required_pull_request_reviews?.bypass_pull_request_allowances;
  return [
    ...(bypass?.apps ?? []).map((app) => `app:${app}`),
    ...(bypass?.users ?? []).map((user) => `user:${user}`),
    ...(bypass?.teams ?? []).map((team) => `team:${team}`),
  ];
}

/** The contexts of the checks a branch requires. */
export function requiredChecks(protection: BranchProtection): string[] {
  return (protection.required_status_checks?.checks ?? []).map((check) => check.context);
}

/** The repository ruleset named MERGE_GATE_RULESET, as setup reads it. */
export interface MergeGateRuleset {
  readonly id: number;
  /** "active", "evaluate" or "disabled". */
  readonly enforcement: string;
  /** The ref_name conditions it includes, such as ~DEFAULT_BRANCH. */
  readonly branches: readonly string[];
  /** Whether it has the rule that only its bypass actors may update a matching branch. */
  readonly restrictsUpdates: boolean;
  /** Who may bypass it, as `<actor_type>:<actor_id>`. */
  readonly bypassActors: readonly string[];
}

/** The name setup gives the ruleset that keeps the default branch the Operator's alone. */
export const MERGE_GATE_RULESET = "Fabrik Merge gate";

/** Repository admins, the only bypass actor: the Operator, who owns the repo. The Fabrik App is never an admin. */
export const ADMIN_BYPASS = "RepositoryRole:5";

export type SetupAction =
  | { readonly kind: "write-file"; readonly path: string; readonly content: string; readonly why: string }
  | { readonly kind: "create-label"; readonly name: LoopLabel; readonly color: string; readonly description: string }
  | { readonly kind: "create-vault"; readonly name: string }
  | {
      readonly kind: "create-service-account";
      readonly name: string;
      /** Vaults it may read items from, and nothing else. */
      readonly vaults: readonly string[];
      /** The Actions secret its token is stored as. */
      readonly secret: string;
      /** The repo, as `owner/name`, that holds the secret when it isn't the Product repo. */
      readonly repo?: string;
    }
  | {
      readonly kind: "protect-branch";
      readonly branch: string;
      /** The protection as found, or null when the branch has none. */
      readonly found: BranchProtection | null;
      /** What the PUT sends: the protection as found, with only the settings Setup owns changed. */
      readonly protection: BranchProtection;
    }
  | {
      /** Creates the Merge gate ruleset, or with its id puts the existing one right. */
      readonly kind: "restrict-default-branch";
      readonly rulesetId: number | null;
    }
  | { readonly kind: "create-run-store"; readonly repo: string; readonly private: true }
  | {
      /** A file committed straight to the store's default branch: it has no checkout of its own. */
      readonly kind: "write-store-file";
      readonly repo: string;
      readonly path: string;
      readonly content: string;
      readonly why: string;
    };

export interface SetupPlan {
  readonly actions: readonly SetupAction[];
  /** What the Operator should know or do that setup can't do for them. */
  readonly notes: readonly string[];
}

/** Where the plan stands in setup's run. */
export interface PlanContext {
  /**
   * The same run walks the wizard once the plan is applied, then plans again
   * and writes what that plan writes in the setup PR, as one run in a terminal
   * does. Without it, a step the wizard leaves to setup waits for its next run.
   */
  readonly wizardNext?: boolean;
  /**
   * The repo's Kit config is the starter setup wrote on its own branch, in this
   * run or an earlier one, as the default branch lacks one. Until the setup PR
   * merges it's setup's own, not yet the Product's: this run's answer on
   * pausing sets its max_in_flight, and its notes are a fresh install's.
   */
  readonly wroteStarter?: boolean;
}

export function planSetup(state: ProductState, kit: SetupKit, answers: SetupAnswers = {}, context: PlanContext = {}): SetupPlan {
  const actions: SetupAction[] = [];
  const notes: string[] = [];
  const shims: [string, FileUpdate, string][] = [
    [CALLER_PATH, callerUpdate(file(state, CALLER_PATH), kit.templates.caller, kit.release), "the caller workflow, pinning one Fabrik release"],
    [SETTINGS_PATH, settingsUpdate(file(state, SETTINGS_PATH), kit.templates.claudeSettings), "the SessionStart hook entry, with the skills plugin off"],
    [GITIGNORE_PATH, gitignoreUpdate(file(state, GITIGNORE_PATH)), "gitignore the skills the Kit installs"],
    [
      PRETTIERIGNORE_PATH,
      prettierignoreUpdate(file(state, PRETTIERIGNORE_PATH), hasPrettierConfig(state.files)),
      "keep Prettier off the Kit-owned caller workflow",
    ],
    [DEPENDABOT_PATH, dependabotUpdate(file(state, DEPENDABOT_PATH), kit.templates.dependabot), "Dependabot bumps the Fabrik pin"],
  ];
  for (const [path, update, why] of shims) {
    if (update === null) continue;
    if ("note" in update) notes.push(update.note);
    else actions.push(write(path, update.content, why));
  }
  actions.push(...kitConfig(state, kit, answers, notes, context));
  actions.push(...starters(state, kit));
  const present = new Set(state.labels.map((label) => label.toLowerCase()));
  for (const name of ALL_LABELS) {
    if (!present.has(name.toLowerCase())) actions.push({ kind: "create-label", name, ...LOOP_LABELS[name] });
  }
  actions.push(...secrets(state));
  actions.push(...protection(state, kit, notes));
  actions.push(...mergeGate(state));
  actions.push(...runStore(state.store, kit, answers, notes));
  notes.push(...subscriptions(state, kit, answers, context));
  return { actions, notes };
}

/**
 * The Kit config is the Product's: setup writes the starter once, when the repo
 * lacks one, and after that changes only its subscriptions list, on the
 * Operator's yes to a second Subscription. Until the setup PR merges, the
 * starter on setup's branch is still setup's own, so a later run's answer on
 * pausing sets its max_in_flight. Visual evidence, the one block that needs
 * judgment, is /fabrik-visual-evidence's to write (Spec #330).
 */
function kitConfig(state: ProductState, kit: SetupKit, answers: SetupAnswers, notes: string[], { wroteStarter = false }: PlanContext): SetupAction[] {
  const existing = state.files[KIT_CONFIG_PATH] ?? null;
  const paused = answers.paused === true;
  if (existing !== null && wroteStarter && jsonObject(existing) !== null) {
    if (!paused) notes.push(...readyForAgentWarning(state.readyForAgent));
    const maxInFlight = paused ? 0 : DEFAULT_KIT_CONFIG.maxInFlight;
    const repaused = pausesDispatch(existing) === paused ? null : withMember(existing, ["max_in_flight"], maxInFlight);
    const listed = withSecondSubscription(repaused ?? existing, state, answers);
    if (repaused === null) return listed === null ? [] : [write(KIT_CONFIG_PATH, listed, LIST_SECOND_SUBSCRIPTION)];
    const why = `the starter Kit config, with Dispatch ${paused ? "" : "not "}paused now (max_in_flight ${maxInFlight})${listed === null ? "" : ", and the second Subscription listed"}`;
    return [write(KIT_CONFIG_PATH, listed ?? repaused, why)];
  }
  if (existing !== null) {
    if (paused) notes.push(pausedHadNoEffect(existing));
    const listed = withSecondSubscription(existing, state, answers);
    return listed === null ? [] : [write(KIT_CONFIG_PATH, listed, LIST_SECOND_SUBSCRIPTION)];
  }
  if (!paused) notes.push(...readyForAgentWarning(state.readyForAgent));
  const starter = paused ? pausedStarter(kit.templates.kitConfig) : kit.templates.kitConfig;
  const listed = withSecondSubscription(starter, state, answers);
  const why = `a starter Kit config with every v1 default${paused ? " but Dispatch paused (max_in_flight 0)" : ""}${listed === null ? "" : ", and the second Subscription listed"}`;
  return [write(KIT_CONFIG_PATH, listed ?? starter, why)];
}

/** The warning that an unpaused install puts the tracker's ready-for-agent issues straight into Dispatch's queue. */
function readyForAgentWarning(count: number): string[] {
  if (count === 0) return [];
  const one = count === 1;
  return [
    `${count} open ${one ? "issue is" : "issues are"} labelled ${READY_FOR_AGENT}: Dispatch starts releasing ${one ? "it to an Implementer" : "them to Implementers"} as soon as the setup PR merges. Run setup with --paused to hold ${one ? "it" : "them"} back.`,
  ];
}

/** Why --paused changed nothing: the Kit config is the Product's, and setup never edits its max_in_flight. */
function pausedHadNoEffect(existing: string): string {
  const prefix = `--paused had no effect: ${KIT_CONFIG_PATH} already exists`;
  const config = jsonObject(existing);
  if (config === null) return `${prefix}. Set max_in_flight to 0 in it by hand to pause Dispatch.`;
  const value = config["max_in_flight"] ?? DEFAULT_KIT_CONFIG.maxInFlight;
  if (value === 0) return `${prefix}, with max_in_flight 0, so Dispatch is already paused.`;
  return `${prefix}, with max_in_flight ${JSON.stringify(value)}. Set it to 0 by hand to pause Dispatch.`;
}

/** Whether the Kit config's text sets max_in_flight to 0. */
export function pausesDispatch(text: string): boolean {
  return (jsonObject(text)?.["max_in_flight"] ?? DEFAULT_KIT_CONFIG.maxInFlight) === 0;
}

/** The starter Kit config with `max_in_flight` set to 0, every other byte kept. */
function pausedStarter(starter: string): string {
  const member = /("max_in_flight"\s*:\s*)\d+/;
  if (!member.test(starter)) throw new Error("The starter Kit config has no max_in_flight to pause.");
  return starter.replace(member, (_, key: string) => `${key}0`);
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `Fabrik` vault item the wizard saves the first Subscription's token in. */
export const CLAUDE_TOKEN_ITEM = "Claude token";
/** The `Fabrik` vault item the wizard saves the second Subscription's token in. */
export const SECOND_SUBSCRIPTION = "Claude token 2";

/** Why setup writes a Kit config whose only change is the second Subscription listed. */
const LIST_SECOND_SUBSCRIPTION = `list the second Subscription, "${SECOND_SUBSCRIPTION}", in subscriptions`;

/** The wizard's stage for the steps of a second Subscription only the Operator can take. */
const SECOND_SUBSCRIPTION_STAGE = 'the wizard\'s "A second Subscription" stage';

/** The wizard's stage for each Subscription's item it stores in the `Fabrik` vault. It stores no other Subscription's token. */
const SUBSCRIPTION_STAGES: ReadonlyMap<string, string> = new Map([
  [CLAUDE_TOKEN_ITEM, 'the wizard\'s "The Claude token" stage'],
  [SECOND_SUBSCRIPTION, SECOND_SUBSCRIPTION_STAGE],
]);

/**
 * The Subscriptions the Kit config's text lists, read from its raw JSON: one
 * setup plans to add is a list the reader may not take yet, and still counts as
 * listed. Null when it isn't a JSON object or its list isn't a non-empty one
 * of names: protection() already tells the Operator the Kit config is invalid.
 */
export function listedSubscriptions(text: string): readonly string[] | null {
  const config = jsonObject(text);
  if (config === null) return null;
  const listed = config["subscriptions"] === undefined ? DEFAULT_KIT_CONFIG.subscriptions : config["subscriptions"];
  return Array.isArray(listed) && listed.length > 0 && listed.every((name) => typeof name === "string") ? listed : null;
}

/**
 * The Subscriptions whose tokens the Kit reads, from the Kit config's text:
 * the ones it lists. A repo with none gets the starter, which lists the
 * default, the Claude token alone, and a list setup can't read counts as the
 * default too.
 */
export function subscriptionsTheKitReads(text: string | null): readonly string[] {
  return (text === null ? null : listedSubscriptions(text)) ?? DEFAULT_KIT_CONFIG.subscriptions;
}

/**
 * Each listed Subscription the vault lacks, and a second Subscription (Spec
 * #152): its account and token are the Operator's to make, in the wizard, so
 * they're planned as notes. Once the token is in the vault, kitConfig() lists
 * it. The agent and implement accounts already read the whole `Fabrik` vault,
 * so it needs no new service account.
 */
function subscriptions(state: ProductState, kit: SetupKit, answers: SetupAnswers, { wizardNext = false }: PlanContext): string[] {
  const read = listedSubscriptions(state.files[KIT_CONFIG_PATH] ?? kit.templates.kitConfig);
  const listed = read ?? DEFAULT_KIT_CONFIG.subscriptions;
  const stored = new Set(state.fabrikItems);
  // Once the setup PR is merged, setup's command is the way to the wizard, which it walks while 1Password lacks the token.
  const command = setupCommand(kit.release);
  // The Kit reads each listed one. The default, the Claude token alone, is the install's own, whose token the merge rule names.
  const isDefault = listed.length === 1 && listed[0] === CLAUDE_TOKEN_ITEM;
  const lacking = (isDefault ? [] : listed.filter((name) => !stored.has(name))).map(
    (name) =>
      `${KIT_CONFIG_PATH} lists ${JSON.stringify(name)} in subscriptions, but the "${FABRIK_VAULT}" vault has no item of that name: ${toStore(name, wizardNext, command)}`,
  );
  if (answers.secondSubscription !== true || !takesSecondSubscription(listed)) return lacking;
  if (stored.has(SECOND_SUBSCRIPTION)) {
    if (read !== null) return lacking;
    return [
      `${KIT_CONFIG_PATH} isn't a JSON object whose subscriptions is a list of names, so setup didn't list "${SECOND_SUBSCRIPTION}" in it: fix it, then run setup again.`,
    ];
  }
  const listing = wizardNext
    ? `Setup then lists it in subscriptions in ${KIT_CONFIG_PATH}, in the setup PR.`
    : `Running setup again walks it, then lists it in subscriptions in ${KIT_CONFIG_PATH}: ${command}`;
  return [
    ...lacking,
    `Walk ${SECOND_SUBSCRIPTION_STAGE}: create a second Claude account, run \`claude setup-token\` on it, save the token as the "${SECOND_SUBSCRIPTION}" API Credential, with its expiry date, in the "${FABRIK_VAULT}" vault, and turn usage credits off on every account. ${listing}`,
  ];
}

/** How the Operator stores a listed Subscription's token: in the wizard's stage for it, or by hand under a name no stage stores. */
function toStore(name: string, wizardNext: boolean, command: string): string {
  const stage = SUBSCRIPTION_STAGES.get(name);
  if (stage === undefined) {
    const items = [...SUBSCRIPTION_STAGES.keys()].map((item) => JSON.stringify(item)).join(" and ");
    return `run \`claude setup-token\` on that Subscription's Claude account and save the token as the ${JSON.stringify(name)} API Credential, with its expiry date, in the "${FABRIK_VAULT}" vault yourself, since the wizard stores only ${items}.`;
  }
  return wizardNext ? `walk ${stage} for it.` : `run setup again to walk ${stage} for it: ${command}`;
}

/**
 * The Kit config's text with the second Subscription listed after the one it
 * lists, every other byte kept, or null when there's nothing to write: the
 * Operator didn't say yes, its token isn't in the vault yet, or the list
 * doesn't take it.
 */
function withSecondSubscription(text: string, state: ProductState, answers: SetupAnswers): string | null {
  if (answers.secondSubscription !== true || !state.fabrikItems.includes(SECOND_SUBSCRIPTION)) return null;
  const listed = listedSubscriptions(text);
  if (listed === null || !takesSecondSubscription(listed)) return null;
  return withMember(text, ["subscriptions"], [...listed, SECOND_SUBSCRIPTION]);
}

/**
 * Whether setup lists the second Subscription after these, on the Operator's
 * yes once its token is stored: a list of one that doesn't name it already. A
 * list of two or more is a rotation the Operator wrote, or setup on an earlier
 * yes, which setup leaves as it is.
 */
export function takesSecondSubscription(listed: readonly string[]): boolean {
  return listed.length === 1 && !listed.includes(SECOND_SUBSCRIPTION);
}

/**
 * The fabrik-runs store: Run records and the Weekly summary turn on once it
 * exists with the Fabrik App installed on it (the wizard's stage).
 */
/** Whether GitHub's schedule `timezone:` takes it: an IANA name the runtime's time zone data knows. */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The store's one Actions secret, which its caller workflow passes to the Weekly summary. */
const STORE_SECRET = "FABRIK_OP_PUSH_TOKEN";

function runStore(store: RunStoreState, kit: SetupKit, answers: SetupAnswers, notes: string[]): SetupAction[] {
  const { timeZone } = answers;
  if (timeZone === undefined) return [];
  if (!isTimeZone(timeZone)) {
    notes.push(
      `${timeZone} isn't an IANA time zone, such as Europe/London, so ${RUN_STORE_REPO} wasn't set up: run setup again with your time zone.`,
    );
    return [];
  }
  // A transcript can hold whatever an agent echoed, so the store must be private
  // (ADR-0009). Making a repo private is the Operator's call, never setup's.
  if (store.exists && !store.private) {
    notes.push(
      `${RUN_STORE_REPO} is public, so setup changed nothing there and no Run record will be written to it: make it private (Settings → General → Danger Zone → Change visibility), then run setup again.`,
    );
    return [];
  }
  const actions: SetupAction[] = [];
  if (!store.exists) actions.push({ kind: "create-run-store", repo: RUN_STORE_REPO, private: true });
  const caller = scheduleIn(kit.templates.storeCaller, timeZone);
  const files: [string, FileUpdate, string][] = [
    [
      STORE_CALLER_PATH,
      storeCallerUpdate(store.files[STORE_CALLER_PATH] ?? null, caller, kit.release),
      "the Weekly summary each Monday morning, pinning one Fabrik release",
    ],
    [
      DEPENDABOT_PATH,
      dependabotUpdate(store.files[DEPENDABOT_PATH] ?? null, kit.templates.dependabot),
      "Dependabot bumps the Fabrik pin",
    ],
  ];
  for (const [path, update, why] of files) {
    if (update === null) continue;
    if ("note" in update) notes.push(`${RUN_STORE_REPO}: ${update.note}`);
    else actions.push({ kind: "write-store-file", repo: RUN_STORE_REPO, path, content: update.content, why });
  }
  // The push account pattern: the Weekly summary mints its App tokens from the Fabrik App vault.
  if (!store.secrets.includes(STORE_SECRET)) {
    actions.push({
      kind: "create-service-account",
      name: `fabrik-${RUN_STORE.owner}-${RUN_STORE.name}-push`,
      vaults: [FABRIK_APP_VAULT],
      secret: STORE_SECRET,
      repo: RUN_STORE_REPO,
    });
  }
  return actions;
}

/** Every file planSetup reads from the Product checkout. */
export function setupPaths(kit: SetupKit): readonly string[] {
  return [
    CALLER_PATH,
    SETTINGS_PATH,
    GITIGNORE_PATH,
    PRETTIERIGNORE_PATH,
    ...PRETTIER_DETECTION_PATHS,
    DEPENDABOT_PATH,
    KIT_CONFIG_PATH,
    SKILLS_SOURCES_LOCK_PATH,
    ...Object.keys(kit.templates.docsAgents).map((name) => `docs/agents/${name}`),
    "AGENTS.md",
    "CLAUDE.md",
  ];
}

function file(state: ProductState, path: string): string | null {
  return state.files[path] ?? null;
}

/**
 * Only the Operator merges into the default branch (user stories 10 and 71).
 * Branch protection requires a PR and the gating checks, with no bypass
 * allowance for anyone, but no approving review: the Operator works alone and
 * can't approve their own PRs. What keeps the Fabrik App from merging is the
 * Merge gate ruleset (mergeGate below), not a review. Setup owns only those
 * settings, the required checks, the PR, its approving reviews and its bypass
 * allowances, and keeps every other one as it finds it, admin enforcement
 * included.
 */
function protection(state: ProductState, kit: SetupKit, notes: string[]): SetupAction[] {
  const configText = state.files[KIT_CONFIG_PATH] ?? kit.templates.kitConfig;
  const config = resolveKitConfig({ config: configText, skillsLock: file(state, SKILLS_SOURCES_LOCK_PATH) });
  if (!config.ok) notes.push(`${KIT_CONFIG_PATH} is invalid, so its gating checks weren't required: ${config.errors.join("; ")}`);
  const gating = config.ok ? config.config.sandbox.checks : [];
  const current = state.protection;
  const found = current ?? UNPROTECTED;
  const required = [...new Set([...requiredChecks(found), ...gating])];
  if (required.length === 0) {
    notes.push(
      `${state.repo.defaultBranch} requires no gating checks yet: list the CI checks that must pass in sandbox.checks in ${KIT_CONFIG_PATH}, then run setup again.`,
    );
  }
  const satisfied =
    current !== null &&
    current.required_pull_request_reviews !== null &&
    bypassAllowances(current).length === 0 &&
    gating.every((check) => requiredChecks(current).includes(check));
  if (satisfied) return [];
  const checks = found.required_status_checks;
  // Empty lists take away any bypass. GitHub rejects the field (HTTP 422) on a
  // personal account's repo, which can't have bypass allowances anyway.
  const { bypass_pull_request_allowances: _, ...reviews } = found.required_pull_request_reviews ?? NEW_PULL_REQUEST_RULE;
  const wanted: BranchProtection = {
    ...found,
    required_status_checks:
      required.length === 0
        ? null
        : {
            strict: checks?.strict ?? false,
            checks: required.map((context) => checks?.checks.find((check) => check.context === context) ?? { context }),
          },
    required_pull_request_reviews: {
      ...reviews,
      required_approving_review_count: 0,
      ...(state.repo.inOrganization ? { bypass_pull_request_allowances: { users: [], teams: [], apps: [] } } : {}),
    },
  };
  return [{ kind: "protect-branch", branch: state.repo.defaultBranch, found: current, protection: wanted }];
}

/** The pull request rule Setup adds to a branch that has none: no approving review, and a later push dismisses one. */
const NEW_PULL_REQUEST_RULE: NonNullable<BranchProtection["required_pull_request_reviews"]> = {
  dismiss_stale_reviews: true,
  require_code_owner_reviews: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
};

/**
 * The Merge gate ruleset: an active repository ruleset on the default branch
 * whose one rule restricts updates to its bypass actors, and whose only bypass
 * actor is the repo admin role. Merging a PR updates the branch, so the
 * Fabrik App, which can push agent branches but is never an admin, can't
 * merge one, while the Operator, the repo's owner and admin, can.
 */
function mergeGate(state: ProductState): SetupAction[] {
  const current = state.mergeGate;
  const sound =
    current !== null &&
    current.enforcement === "active" &&
    current.restrictsUpdates &&
    current.branches.includes("~DEFAULT_BRANCH") &&
    current.bypassActors.length === 1 &&
    current.bypassActors[0] === ADMIN_BYPASS;
  if (sound) return [];
  return [{ kind: "restrict-default-branch", rulesetId: current?.id ?? null }];
}

/** The vault every repo's agent and implement accounts read: the Claude token every Product repo in this 1Password account shares. */
export const FABRIK_VAULT = "Fabrik";
/** The vault only push accounts read: the Fabrik App's client ID and private key. */
export const FABRIK_APP_VAULT = "Fabrik App";

export function sandboxVault(repo: ProductState["repo"]): string {
  return `Fabrik Sandbox · ${repo.name}`;
}

/**
 * The repo's three read-only service accounts, one per job role (ADR-0004).
 * 1Password shows a token only once, so a missing Actions secret can only be
 * repaired with a new account; one whose secret is present is left alone.
 */
function secrets(state: ProductState): SetupAction[] {
  const sandbox = sandboxVault(state.repo);
  const roles = [
    { role: "agent", vaults: [FABRIK_VAULT], secret: "FABRIK_OP_AGENT_TOKEN" },
    { role: "implement", vaults: [FABRIK_VAULT, sandbox], secret: "FABRIK_OP_IMPLEMENT_TOKEN" },
    { role: "push", vaults: [FABRIK_APP_VAULT], secret: "FABRIK_OP_PUSH_TOKEN" },
  ];
  const actions: SetupAction[] = [];
  for (const vault of [FABRIK_VAULT, FABRIK_APP_VAULT, sandbox]) {
    if (!state.vaults.includes(vault)) actions.push({ kind: "create-vault", name: vault });
  }
  for (const { role, vaults, secret } of roles) {
    if (state.secrets.includes(secret)) continue;
    const name = `fabrik-${state.repo.owner}-${state.repo.name}-${role}`;
    actions.push({ kind: "create-service-account", name, vaults, secret });
  }
  return actions;
}

/**
 * Files the Product repo owns from then on. Each is written once, when the repo
 * lacks it, and never rewritten, so re-running setup keeps the Operator's edits.
 */
function starters(state: ProductState, kit: SetupKit): SetupAction[] {
  const actions: SetupAction[] = [];
  for (const [name, content] of Object.entries(kit.templates.docsAgents)) {
    const path = `docs/agents/${name}`;
    if (state.files[path] == null) actions.push(write(path, content, "Fabrik's fixed answers for the skills"));
  }
  // The skills look for docs/agents/* through this block, as Matt Pocock's setup
  // skill writes it. It goes in with the docs: a repo that has them already set
  // the skills up its own way.
  if (state.files["docs/agents/issue-tracker.md"] != null) return actions;
  const instructions = state.files["CLAUDE.md"] != null ? "CLAUDE.md" : "AGENTS.md";
  const existing = state.files[instructions] ?? null;
  if (existing === null) {
    actions.push(write(instructions, kit.templates.agentSkills, "point the skills at docs/agents/*"));
  } else if (!/^## Agent skills\s*$/m.test(existing)) {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    actions.push(write(instructions, `${existing}${separator}${kit.templates.agentSkills}`, "point the skills at docs/agents/*"));
  }
  return actions;
}

function write(path: string, content: string, why: string): SetupAction {
  return { kind: "write-file", path, content, why };
}
