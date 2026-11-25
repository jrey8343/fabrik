// Setup's planner. Pure, no I/O: given what a Product repo holds now
// and the Kit being set up, it returns every step that would leave the repo
// ready to run the Loop, and nothing a working install already has.
import { CONSOLE_CHECK } from "../kit/consoleCheck.ts";
import { KIT_ENVIRONMENT } from "../kit/environment.ts";
import { DEFAULT_KIT_CONFIG, KIT_CONFIG_PATH, type ProductionConfig, resolveKitConfig, SKILLS_SOURCES_LOCK_PATH, type StagingConfig } from "../kit/config.ts";
import { ALL_LABELS, type Label as LoopLabel, LOOP_LABELS, READY_FOR_AGENT } from "../loop/labels.ts";
import { isTimeZone } from "../loop/readable.ts";
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
  /** The repo's `fabrik` environment, whose secrets are the Kit's tokens (ADR-0004), or null when the repo has none. */
  readonly environment: EnvironmentState | null;
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

/**
 * What setup read of a repo's Deployments, to offer production's environment
 * and address: each environment its Deployments carry, newest first, with the
 * http(s) address on its newest successful Deployment, or why it couldn't read.
 */
export type DeploymentsSeen =
  | { readonly read: true; readonly environments: readonly { readonly name: string; readonly url: string | null }[] }
  | { readonly read: false; readonly why: string };

/** One rule of an environment set to "Selected branches and tags": the branches, or the tags, of that name. */
export interface EnvironmentRule {
  /** GitHub's id for it, which a delete names. */
  readonly id: number;
  /** The name, or the pattern, of the branches or tags it lets through. */
  readonly name: string;
  readonly type: "branch" | "tag";
}

/**
 * Which refs a GitHub environment gives its secrets to, as Setup reads it:
 * its setting, and the rules of one set to "Selected branches and tags".
 */
export interface EnvironmentPolicy {
  /** `all` is every branch, `protected` is protected branches only, `selected` is selected branches and tags. */
  readonly branches: "all" | "protected" | "selected";
  /** Its rules. Only one set to `selected` has any. */
  readonly rules: readonly EnvironmentRule[];
}

/** A GitHub environment as Setup reads it: which refs it lets through, and its secrets' names, never their values. */
export interface EnvironmentState extends EnvironmentPolicy {
  readonly secrets: readonly string[];
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
  /**
   * The production block the Operator confirmed: the site's address and the
   * environment its deploys carry in GitHub's Deployments. Setup adds it to a
   * Kit config that declares none, and never changes one it declares.
   */
  readonly production?: ProductionConfig;
  /**
   * The staging block the Operator confirmed: the staging site's address and
   * the environment its deploys carry in GitHub's Deployments. Setup adds it to
   * a Kit config that declares none, and never changes one it declares.
   */
  readonly staging?: StagingConfig;
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
  | {
      /**
       * Makes the environment when the repo lacks it, and holds it to the
       * default branch: "Selected branches and tags" with one branch rule
       * naming that branch, and no other rule.
       */
      readonly kind: "hold-environment";
      /** The environment's name. */
      readonly environment: string;
      /** The default branch, the one branch its one rule names. */
      readonly branch: string;
      /** Which refs it lets through as found, or null when the repo has no such environment. */
      readonly found: EnvironmentPolicy | null;
      /** The repo, as `owner/name`, whose environment it is when it isn't the Product repo. */
      readonly repo?: string;
    }
  | { readonly kind: "write-file"; readonly path: string; readonly content: string; readonly why: string }
  | { readonly kind: "create-label"; readonly name: LoopLabel; readonly color: string; readonly description: string }
  | { readonly kind: "create-vault"; readonly name: string }
  | {
      readonly kind: "create-service-account";
      readonly name: string;
      /** Vaults it may read items from, and nothing else. */
      readonly vaults: readonly string[];
      /** The secret its token is stored as. */
      readonly secret: string;
      /** The environment whose secret it is. A step that names none stores a repo-level Actions secret. */
      readonly environment?: string;
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
  // The fabrik environment goes first: when GitHub refuses it, Setup stops before it changes anything else.
  const actions: SetupAction[] = [...holdEnvironment(KIT_ENVIRONMENT, state.environment, state.repo.defaultBranch)];
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
 * Whether an environment is held to the default branch alone: it exists, it is
 * set to "Selected branches and tags", and its rules are exactly one, a branch
 * rule naming the default branch. Its being there, or its setting, is never
 * taken for its being held: GitHub makes one a workflow names with no rule,
 * and one set to "Selected branches and tags" with no rule gives its secrets
 * to every ref (#846).
 */
export function environmentHeld(environment: EnvironmentPolicy | null, defaultBranch: string): boolean {
  return environment !== null && environment.branches === "selected" && onlyRuleNames(environment.rules, defaultBranch);
}

/**
 * Whether these rules are exactly one, a branch rule naming the branch. A tag
 * rule of that name doesn't count: it lets a tag's run in, where a branch rule
 * refuses a tag named as the branch is (#846).
 */
export function onlyRuleNames(rules: readonly EnvironmentRule[], branch: string): boolean {
  return rules.length === 1 && rules[0]!.type === "branch" && rules[0]!.name === branch;
}

/**
 * The step that makes an environment and holds it to the default branch, with
 * which refs it lets through as found, or no step for one already held. The
 * Product repo's own unless `repo` names another, as `owner/name`.
 */
export function holdEnvironment(environment: string, found: EnvironmentPolicy | null, defaultBranch: string, repo?: string): SetupAction[] {
  if (environmentHeld(found, defaultBranch)) return [];
  const policy = found === null ? null : { branches: found.branches, rules: found.rules };
  return [{ kind: "hold-environment", environment, branch: defaultBranch, found: policy, ...(repo === undefined ? {} : { repo }) }];
}

/**
 * Which refs an environment lets through, as Setup names it: `every branch`,
 * `protected branches only`, or the rules of one set to "Selected branches
 * and tags".
 */
export function namedPolicy(policy: EnvironmentPolicy): string {
  return policy.branches === "all" ? "every branch" : policy.branches === "protected" ? "protected branches only" : namedRules(policy.rules);
}

/**
 * An environment's rules as Setup names them: each by its name, a tag rule as
 * `tag <name>`, or `none`.
 */
export function namedRules(rules: readonly EnvironmentRule[]): string {
  return rules.length === 0 ? "none" : rules.map((rule) => (rule.type === "tag" ? `tag ${rule.name}` : rule.name)).join(", ");
}

/**
 * The Kit config is the Product's: setup writes the starter once, when the repo
 * lacks one, and after that changes only its subscriptions list, on the
 * Operator's yes to a second Subscription, its production block and its
 * staging block, each while it declares none, and its time_zone, to the
 * Operator's answer (ADR-0023). Until the setup PR merges, the starter on
 * setup's branch is still setup's own, so a later run's answer on pausing sets
 * its max_in_flight. Visual evidence, the one block that needs judgment, is
 * /fabrik-visual-evidence's to write (Spec #330).
 */
function kitConfig(state: ProductState, kit: SetupKit, answers: SetupAnswers, notes: string[], { wroteStarter = false }: PlanContext): SetupAction[] {
  const existing = state.files[KIT_CONFIG_PATH] ?? null;
  const paused = answers.paused === true;
  if (existing !== null && wroteStarter && jsonObject(existing) !== null) {
    if (!paused) notes.push(...readyForAgentWarning(state.readyForAgent));
    const maxInFlight = paused ? 0 : DEFAULT_KIT_CONFIG.maxInFlight;
    const repaused = pausesDispatch(existing) === paused ? null : withMember(existing, ["max_in_flight"], maxInFlight);
    const edited = answeredEdits(repaused ?? existing, state, answers, notes);
    if (repaused === null) return edits(edited);
    const why = `the starter Kit config, with Dispatch ${paused ? "" : "not "}paused now (max_in_flight ${maxInFlight})${alsoWords(edited)}`;
    return [write(KIT_CONFIG_PATH, edited.text ?? repaused, why)];
  }
  if (existing !== null) {
    if (paused) notes.push(pausedHadNoEffect(existing));
    return edits(answeredEdits(existing, state, answers, notes));
  }
  if (!paused) notes.push(...readyForAgentWarning(state.readyForAgent));
  const starter = paused ? pausedStarter(kit.templates.kitConfig) : kit.templates.kitConfig;
  const edited = answeredEdits(starter, state, answers, notes);
  const why = `a starter Kit config with every v1 default${paused ? " but Dispatch paused (max_in_flight 0)" : ""}${alsoWords(edited)}`;
  return [write(KIT_CONFIG_PATH, edited.text ?? starter, why)];
}

/** The Kit config's text with the Operator's answers in it, or null when they change nothing, and how the plan names each change. */
interface AnsweredEdits {
  readonly text: string | null;
  /** As the plan names the change on its own, such as "add the production block: …". */
  readonly changes: readonly string[];
  /** As the plan names it after a starter's or a re-pause's write, such as "the production block: …". */
  readonly also: readonly string[];
}

/** The second Subscription listed, the production block and the staging block added and time_zone set, each on the text the one before left. */
function answeredEdits(text: string, state: ProductState, answers: SetupAnswers, notes: string[]): AnsweredEdits {
  const listed = withSecondSubscription(text, state, answers);
  const live = withProduction(listed ?? text, answers, notes);
  const staged = withStaging(live ?? listed ?? text, answers, notes);
  const zoned = withTimeZone(staged ?? live ?? listed ?? text, answers, notes);
  const made: (readonly [change: string, also: string])[] = [];
  if (listed !== null) made.push([LIST_SECOND_SUBSCRIPTION, "the second Subscription listed"]);
  if (live !== null) made.push([`add ${productionWords(answers)}`, productionWords(answers)]);
  if (staged !== null) made.push([`add ${stagingWords(answers)}`, stagingWords(answers)]);
  if (zoned !== null) made.push([`set ${timeZoneWords(answers)}`, timeZoneWords(answers)]);
  return { text: zoned ?? staged ?? live ?? listed, changes: made.map(([change]) => change), also: made.map(([, also]) => also) };
}

/** The one write of a Kit config whose only changes are the Operator's answers, or none. */
function edits({ text, changes }: AnsweredEdits): SetupAction[] {
  return text === null ? [] : [write(KIT_CONFIG_PATH, text, changes.join(", and "))];
}

/** What a starter's or a re-pause's write also does. */
function alsoWords({ also }: AnsweredEdits): string {
  return also.map((words) => `, and ${words}`).join("");
}

/** The time_zone the plan sets, named with its value. */
function timeZoneWords({ timeZone }: SetupAnswers): string {
  return `time_zone ${JSON.stringify(timeZone)}`;
}

/**
 * The Kit config's text with time_zone set to the Operator's time zone, where
 * it stands or added, every other byte kept, or null when there's nothing to
 * write: no answer, as when they left fabrik-runs out, an answer that isn't a
 * zone, which the store's note says, the zone it gives already, or a Kit
 * config setup can't set a member in, which it says.
 */
function withTimeZone(text: string, { timeZone }: SetupAnswers, notes: string[]): string | null {
  if (timeZone === undefined || !isTimeZone(timeZone)) return null;
  const config = jsonObject(text);
  if (config === null) {
    notes.push(`${KIT_CONFIG_PATH} isn't a JSON object, so setup didn't set time_zone in it: fix it, then run setup again.`);
    return null;
  }
  return config["time_zone"] === timeZone ? null : withMember(text, ["time_zone"], timeZone);
}

/** The production block the plan writes, named with both its values. */
function productionWords({ production }: SetupAnswers): string {
  return `the production block: url ${JSON.stringify(production?.url)}, environment ${JSON.stringify(production?.environment ?? null)}`;
}

/**
 * The Kit config's text with the production block the Operator answered added,
 * every other byte kept, or null when there's nothing to write: no answer, a
 * Kit config that declares production already, which is the Product's to
 * change, or one setup can't add a member to, which it says.
 */
function withProduction(text: string, { production }: SetupAnswers, notes: string[]): string | null {
  return withBlock(text, "production", production, productionRefusal, notes);
}

/**
 * The Kit config's text with the block `name` the Operator answered added,
 * its address and its environment, every other byte kept, or null when
 * there's nothing to write: no answer, a Kit config that declares the block
 * already, which is the Product's to change, one setup can't add a member
 * to, or a block Kit config would refuse (`refusalOf`), each of which it
 * says. The production block and the staging block are both written so.
 */
function withBlock<Block extends { readonly url: string; readonly environment: string | null }>(
  text: string,
  name: "production" | "staging",
  block: Block | undefined,
  refusalOf: (block: Block) => string | null,
  notes: string[],
): string | null {
  if (block === undefined) return null;
  if (jsonObject(text) === null) {
    notes.push(`${KIT_CONFIG_PATH} isn't a JSON object, so setup didn't add the ${name} block to it: fix it, then run setup again.`);
    return null;
  }
  if (declaresBlock(text, name)) return null;
  const refused = refusalOf(block);
  if (refused !== null) {
    notes.push(`Setup didn't write the ${name} block: ${refused}.`);
    return null;
  }
  return withMember(text, [name], { url: block.url, environment: block.environment });
}

/** Whether the Kit config's text declares the block `name`: a member of that name that isn't null. */
function declaresBlock(text: string, name: "production" | "staging"): boolean {
  const block = jsonObject(text)?.[name];
  return block !== undefined && block !== null;
}

/** Whether the Kit config's text declares production: a production member that isn't null. */
export function declaresProduction(text: string): boolean {
  return declaresBlock(text, "production");
}

/** Why Kit config would refuse this production block, in its own words, or null when it takes it. */
export function productionRefusal(production: ProductionConfig): string | null {
  const resolved = resolveKitConfig({ config: JSON.stringify({ production }) });
  return resolved.ok ? null : resolved.errors.join("; ");
}

/** The staging block the plan writes, named with both its values. */
function stagingWords({ staging }: SetupAnswers): string {
  return `the staging block: url ${JSON.stringify(staging?.url)}, environment ${JSON.stringify(staging?.environment)}`;
}

/**
 * The Kit config's text with the staging block the Operator answered added,
 * every other byte kept, or null when there's nothing to write: no answer, a
 * Kit config that declares staging already, which is the Product's to change,
 * one setup can't add a member to, or a block Kit config would refuse beside
 * the production this text declares, each of which it says.
 */
function withStaging(text: string, { staging }: SetupAnswers, notes: string[]): string | null {
  return withBlock(text, "staging", staging, (block) => stagingRefusal(block, productionEnvironmentIn(text)), notes);
}

/** Whether the Kit config's text declares staging: a staging member that isn't null. */
export function declaresStaging(text: string): boolean {
  return declaresBlock(text, "staging");
}

/**
 * Why Kit config would refuse this staging block, in its own words, or null
 * when it takes it. It is judged beside a production whose deploys carry
 * `productionEnvironment`, which staging's may not, when one is given.
 */
export function stagingRefusal(staging: StagingConfig, productionEnvironment: string | null): string | null {
  const production = productionEnvironment === null ? null : { url: "https://example.com", environment: productionEnvironment };
  const resolved = resolveKitConfig({ config: JSON.stringify({ production, staging }) });
  return resolved.ok ? null : resolved.errors.join("; ");
}

/** The environment the production block in a Kit config's text names, when Kit config takes it, or null. */
export function productionEnvironmentIn(text: string | null): string | null {
  const production = text === null ? null : jsonObject(text)?.["production"];
  const environment = typeof production === "object" && production !== null ? (production as Record<string, unknown>)["environment"] : null;
  return typeof environment === "string" && productionRefusal({ url: "https://example.com", environment }) === null ? environment : null;
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

/** The Kit config's text as a JSON object, or null when it isn't one. */
export function jsonObject(text: string): Record<string, unknown> | null {
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
 * Branch protection requires a PR and the Required checks, with no bypass
 * allowance for anyone, but no approving review: the Operator works alone and
 * can't approve their own PRs. What keeps the Fabrik App from merging is the
 * Merge gate ruleset (mergeGate below), not a review. Admins are held to
 * those rules, so GitHub refuses the Operator too a merge at a head whose
 * Required checks haven't all passed, and any push straight to the branch.
 * Setup owns only those settings, the required checks, the PR, its approving
 * reviews, its bypass allowances and admin enforcement, and keeps every other
 * one as it finds it.
 */
function protection(state: ProductState, kit: SetupKit, notes: string[]): SetupAction[] {
  const configText = state.files[KIT_CONFIG_PATH] ?? kit.templates.kitConfig;
  const config = resolveKitConfig({ config: configText, skillsLock: file(state, SKILLS_SOURCES_LOCK_PATH) });
  if (!config.ok) notes.push(`${KIT_CONFIG_PATH} is invalid, so the Required checks it lists weren't added to the branch: ${config.errors.join("; ")}`);
  const listedChecks = config.ok ? config.config.sandbox.checks : [];
  // The Console's App, where the Kit config names it: Setup then requires the
  // Console check from it, and owns the App beside that one check (ADR-0019).
  const consoleApp = config.ok ? config.config.console.appId : null;
  const current = state.protection;
  const found = current ?? UNPROTECTED;
  // The Required checks: the branch's, then those the Kit config lists. The
  // Console check is never one, though the branch may already require it.
  const wantedRequiredChecks = [...new Set([...requiredChecks(found), ...listedChecks])].filter((context) => context !== CONSOLE_CHECK);
  if (wantedRequiredChecks.length === 0) {
    notes.push(
      `${state.repo.defaultBranch} has no Required checks yet: list the CI checks that must pass in sandbox.checks in ${KIT_CONFIG_PATH}, then run setup again.`,
    );
  }
  const consoleCheckFound = found.required_status_checks?.checks.find((check) => check.context === CONSOLE_CHECK);
  const consoleCheckHeld = consoleApp === null || consoleCheckFound?.app_id === consoleApp;
  const satisfied =
    current !== null &&
    current.required_pull_request_reviews !== null &&
    bypassAllowances(current).length === 0 &&
    listedChecks.every((check) => requiredChecks(current).includes(check)) &&
    consoleCheckHeld &&
    current.enforce_admins;
  if (satisfied) return [];
  if (!consoleCheckHeld) {
    notes.push(
      `The Kit config names the Console's App (console.app_id is ${consoleApp}), so from this run on ${state.repo.defaultBranch} merges only from the Console: GitHub refuses a merge at any head that App hasn't passed, from github.com, gh and an Operator session alike, the setup PR's included. Setup can't check the Console is ready, so look for this repo in the Console before you go on. Until the Console can pass a head here, the only way to merge is the Merge gate's by-hand way past.`,
    );
  }
  const checks = found.required_status_checks;
  // What the step requires: the branch's checks where they are, the Console
  // check among them, then the Required checks it adds, then the Console check
  // where Setup first requires it.
  const wantedChecks = [...new Set([...requiredChecks(found), ...wantedRequiredChecks, ...(consoleApp === null ? [] : [CONSOLE_CHECK])])];
  const entry = (context: string) =>
    context === CONSOLE_CHECK && consoleApp !== null
      ? { context, app_id: consoleApp }
      : (checks?.checks.find((check) => check.context === context) ?? { context });
  // Empty lists take away any bypass. GitHub rejects the field (HTTP 422) on a
  // personal account's repo, which can't have bypass allowances anyway.
  const { bypass_pull_request_allowances: _, ...reviews } = found.required_pull_request_reviews ?? NEW_PULL_REQUEST_RULE;
  const wanted: BranchProtection = {
    ...found,
    enforce_admins: true,
    required_status_checks:
      wantedChecks.length === 0
        ? null
        : {
            strict: checks?.strict ?? false,
            checks: wantedChecks.map(entry),
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
 * The repo's three read-only service accounts, one per job role, each one's
 * token a secret of the fabrik environment (ADR-0004). A token is missing
 * when the environment lacks it, wherever else it sits: a repo-level secret
 * of its name doesn't count. 1Password shows a token only once and GitHub
 * never gives a secret back, so a missing one can only be made with a new
 * account, named apart from the ones whose tokens sat at repo level; one the
 * environment holds is left alone.
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
    if (state.environment?.secrets.includes(secret)) continue;
    const name = `fabrik-${state.repo.owner}-${state.repo.name}-${role}-env`;
    actions.push({ kind: "create-service-account", name, vaults, secret, environment: KIT_ENVIRONMENT });
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
