// The setup skill's planner. Pure, no I/O: given what a Product repo holds now
// and the Kit being set up, it returns every step that would leave the repo
// ready to run the Loop, and nothing a working install already has.
import { KIT_CONFIG_PATH, resolveKitConfig } from "../kit/config.ts";
import {
  ALL_LABELS,
  BUG,
  DISPATCH_LABEL,
  ENHANCEMENT,
  type Label as LoopLabel,
  NEEDS_DESIGN,
  NEEDS_INFO,
  NEEDS_TRIAGE,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REVIEW_LABEL,
  TOKEN_ROTATION_LABEL,
  WEEKLY_LIMIT_LABEL,
  WONTFIX,
} from "../loop/labels.ts";
import type { SetupKit } from "./kit.ts";
import {
  CALLER_PATH,
  callerUpdate,
  DEPENDABOT_PATH,
  dependabotUpdate,
  type FileUpdate,
  GITIGNORE_PATH,
  gitignoreUpdate,
  SETTINGS_PATH,
  settingsUpdate,
} from "./shims.ts";

/** What the setup skill reads from a Product repo and its 1Password account before planning. */
export interface ProductState {
  readonly repo: { readonly owner: string; readonly name: string; readonly defaultBranch: string };
  /** The text of each file the setup skill writes or merges, or null when the repo lacks it. */
  readonly files: Readonly<Record<string, string | null>>;
  readonly labels: readonly string[];
  readonly secrets: readonly string[];
  readonly vaults: readonly string[];
  readonly protection: BranchProtection | null;
}

export interface BranchProtection {
  readonly requiredChecks: readonly string[];
  readonly requiresPullRequest: boolean;
  readonly requiredApprovals: number;
  /** Who may skip the pull request requirement: app slugs, users and teams. */
  readonly bypassAllowances: readonly string[];
}

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
    }
  | {
      readonly kind: "protect-branch";
      readonly branch: string;
      readonly requiredChecks: readonly string[];
      readonly requiredApprovals: number;
    };

export interface SetupPlan {
  readonly actions: readonly SetupAction[];
  /** What the Operator should know or do that setup can't do for them. */
  readonly notes: readonly string[];
}

export function planSetup(state: ProductState, kit: SetupKit): SetupPlan {
  const actions: SetupAction[] = [];
  const notes: string[] = [];
  const shims: [string, FileUpdate, string][] = [
    [CALLER_PATH, callerUpdate(file(state, CALLER_PATH), kit.templates.caller, kit.release), "the caller workflow, pinning one Fabrik release"],
    [SETTINGS_PATH, settingsUpdate(file(state, SETTINGS_PATH), kit.templates.claudeSettings), "the SessionStart hook entry, with the skills plugin off"],
    [GITIGNORE_PATH, gitignoreUpdate(file(state, GITIGNORE_PATH)), "gitignore the skills the Kit installs"],
    [DEPENDABOT_PATH, dependabotUpdate(file(state, DEPENDABOT_PATH), kit.templates.dependabot), "Dependabot bumps the Fabrik pin"],
  ];
  for (const [path, update, why] of shims) {
    if (update === null) continue;
    if ("note" in update) notes.push(update.note);
    else actions.push(write(path, update.content, why));
  }
  actions.push(...starters(state, kit));
  const present = new Set(state.labels.map((label) => label.toLowerCase()));
  for (const name of ALL_LABELS) {
    if (!present.has(name.toLowerCase())) actions.push({ kind: "create-label", name, ...LOOP_LABELS[name] });
  }
  actions.push(...secrets(state));
  actions.push(...protection(state, kit, notes));
  return { actions, notes };
}

/** Every file planSetup reads from the Product checkout. */
export function setupPaths(kit: SetupKit): readonly string[] {
  return [
    CALLER_PATH,
    SETTINGS_PATH,
    GITIGNORE_PATH,
    DEPENDABOT_PATH,
    KIT_CONFIG_PATH,
    ...Object.keys(kit.templates.docsAgents).map((name) => `docs/agents/${name}`),
    "AGENTS.md",
    "CLAUDE.md",
  ];
}

function file(state: ProductState, path: string): string | null {
  return state.files[path] ?? null;
}

/**
 * Only the Operator merges into the default branch: a PR is required, with an
 * approving review the App can't give its own PRs, the gating checks, and no
 * bypass for anyone (user stories 10 and 71).
 */
function protection(state: ProductState, kit: SetupKit, notes: string[]): SetupAction[] {
  const configText = state.files[KIT_CONFIG_PATH] ?? kit.templates.kitConfig;
  const config = resolveKitConfig({ config: configText });
  if (!config.ok) notes.push(`${KIT_CONFIG_PATH} is invalid, so its gating checks weren't required: ${config.errors.join("; ")}`);
  const gating = config.ok ? config.config.sandbox.checks : [];
  const current = state.protection;
  const requiredChecks = [...new Set([...(current?.requiredChecks ?? []), ...gating])];
  if (requiredChecks.length === 0) {
    notes.push(
      `${state.repo.defaultBranch} requires no gating checks yet: list the CI checks that must pass in sandbox.checks in ${KIT_CONFIG_PATH}, then run setup again.`,
    );
  }
  const satisfied =
    current !== null &&
    current.requiresPullRequest &&
    current.requiredApprovals >= REQUIRED_APPROVALS &&
    current.bypassAllowances.length === 0 &&
    gating.every((check) => current.requiredChecks.includes(check));
  if (satisfied) return [];
  return [{ kind: "protect-branch", branch: state.repo.defaultBranch, requiredChecks, requiredApprovals: REQUIRED_APPROVALS }];
}

const REQUIRED_APPROVALS = 1;

/** The vault every repo's agent and implement accounts read: the shared Claude token. */
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

/** How the setup skill creates each label the Loop reads or writes, so no run fails on a missing one. */
const LOOP_LABELS: Readonly<Record<LoopLabel, { readonly color: string; readonly description: string }>> = {
  [NEEDS_TRIAGE]: { color: "fbca04", description: "Fabrik: waiting for Triage" },
  [NEEDS_INFO]: { color: "d876e3", description: "Fabrik: waiting on the reporter for more information" },
  [NEEDS_DESIGN]: { color: "5319e7", description: "Fabrik: needs a Design session with the Operator" },
  [READY_FOR_AGENT]: { color: "0e8a16", description: "Fabrik: fully specified, ready for an Implementer" },
  [READY_FOR_HUMAN]: { color: "1d76db", description: "Fabrik: needs the Operator to build it" },
  [WONTFIX]: { color: "ffffff", description: "Fabrik: will not be actioned" },
  [DISPATCH_LABEL]: { color: "c2e0c6", description: "Fabrik: starts or resumes an Implementer (the Kit adds it)" },
  [REVIEW_LABEL]: { color: "c2e0c6", description: "Fabrik: starts or resumes a Review" },
  [BUG]: { color: "d73a4a", description: "Something isn't working" },
  [ENHANCEMENT]: { color: "a2eeef", description: "New feature or request" },
  [TOKEN_ROTATION_LABEL]: { color: "b60205", description: "Fabrik: the Claude token needs rotating" },
  [WEEKLY_LIMIT_LABEL]: { color: "b60205", description: "Fabrik: the subscription's weekly limit is reached" },
};

/**
 * Files the Product repo owns from then on. Each is written once, when the repo
 * lacks it, and never rewritten, so re-running setup keeps the Operator's edits.
 */
function starters(state: ProductState, kit: SetupKit): SetupAction[] {
  const actions: SetupAction[] = [];
  if (state.files[KIT_CONFIG_PATH] == null) {
    actions.push(write(KIT_CONFIG_PATH, kit.templates.kitConfig, "a starter Kit config with every v1 default"));
  }
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
