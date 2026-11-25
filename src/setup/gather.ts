// What setup reads before planning, with the Operator's own gh and op: the
// Product repo's files, labels, secrets, fabrik environment, branch protection
// and Merge gate, the 1Password account's vaults, and the fabrik-runs store.
// With git it reads the caller workflow the default branch holds.
// For Setup's report it reads production's environment too, when the Kit
// config names one. It only reads.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import { KIT_ENVIRONMENT } from "../kit/environment.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { READY_FOR_AGENT } from "../loop/labels.ts";
import { ok, type Run } from "./exec.ts";
import {
  type Allowances,
  type BranchProtection,
  type DeploymentsSeen,
  type EnvironmentPolicy,
  type EnvironmentRule,
  type EnvironmentState,
  FABRIK_VAULT,
  MERGE_GATE_RULESET,
  type MergeGateRuleset,
  type ProductionEnvironment,
  productionEnvironmentIn,
  type ProductState,
  type RunStoreState,
} from "./plan.ts";
import { CALLER_PATH, DEPENDABOT_PATH, STORE_CALLER_PATH } from "./shims.ts";

/**
 * Everything planSetup needs, for the repo the checks found.
 * `defaultBranchTip` is the default branch's tip on origin, as they found it.
 */
export async function gatherState(
  run: Run,
  productDir: string,
  repo: ProductState["repo"],
  paths: readonly string[],
  defaultBranchTip: string,
): Promise<ProductState> {
  const cwd = productDir;
  const files = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(productDir, path), "utf8").catch(() => null)] as const)),
  );
  // The checkout's own copy can be the setup branch's, so the default branch's is read from its tip.
  const shown = await run("git", ["show", `${defaultBranchTip}:${CALLER_PATH}`], { cwd });
  const defaultBranchCaller = shown.code === 0 ? shown.stdout : null;
  const names = (json: string) => (JSON.parse(json) as { name: string }[]).map((item) => item.name);
  const labels = names(await ok(run, "gh", ["label", "list", "--limit", "1000", "--json", "name"], { cwd }));
  const secrets = names(await ok(run, "gh", ["secret", "list", "--json", "name"], { cwd }));
  const vaults = names(await ok(run, "op", ["vault", "list", "--format", "json"], { cwd }));
  const fabrikItems = vaults.includes(FABRIK_VAULT) ? await vaultItems(run, cwd, FABRIK_VAULT) : [];
  const [environment, protection, mergeGate, store] = await Promise.all([
    gatherEnvironment(run, cwd, `${repo.owner}/${repo.name}`, KIT_ENVIRONMENT),
    gatherProtection(run, cwd, repo),
    gatherMergeGate(run, cwd, repo),
    gatherStore(run, cwd),
  ]);
  const readyForAgent = await gatherReadyForAgent(run, cwd, labels);
  const production = await gatherProduction(run, cwd, `${repo.owner}/${repo.name}`, files[KIT_CONFIG_PATH] ?? null);
  return { repo, files, defaultBranchCaller, labels, secrets, environment, production, vaults, fabrikItems, protection, mergeGate, store, readyForAgent };
}

/**
 * Production's environment, for Setup's report: the one the checkout's Kit
 * config's `production` block names, and which refs it lets through, never its
 * secrets' names. Null, with no environment read, when the Kit config names
 * none. The repo is `owner/name`.
 */
async function gatherProduction(run: Run, cwd: string, repo: string, kitConfig: string | null): Promise<ProductionEnvironment | null> {
  const name = productionEnvironmentIn(kitConfig);
  return name === null ? null : { name, policy: await readEnvironmentPolicy(run, cwd, repo, name) };
}

/**
 * A repo's environment: which refs it lets through and its secrets' names, or
 * null when the repo has none of that name. The repo is `owner/name`.
 * `elsewhere` says it isn't the checkout's own repo, so `gh secret` is told it
 * with `--repo`.
 */
export async function gatherEnvironment(
  run: Run,
  cwd: string,
  repo: string,
  name: string,
  { elsewhere = false }: { readonly elsewhere?: boolean } = {},
): Promise<EnvironmentState | null> {
  const policy = await readEnvironmentPolicy(run, cwd, repo, name);
  if (policy === null) return null;
  const where = elsewhere ? ["--repo", repo] : [];
  const secrets = JSON.parse(await ok(run, "gh", ["secret", "list", "--env", name, ...where, "--json", "name"], { cwd })) as { name: string }[];
  return { ...policy, secrets: secrets.map((secret) => secret.name) };
}

/**
 * Which refs a repo's environment lets through: its setting, and its rules
 * when it is set to "Selected branches and tags". Null when GitHub answers 404
 * for it, as for a repo that has none of that name. Any other refusal throws,
 * naming GitHub's answer.
 */
export async function readEnvironmentPolicy(run: Run, cwd: string, repo: string, name: string): Promise<EnvironmentPolicy | null> {
  // The name is one segment of the path: a Product repo's own may hold a space or a slash.
  const read = await run("gh", ["api", `repos/${repo}/environments/${encodeURIComponent(name)}`], { cwd });
  if (read.code !== 0) {
    if (/HTTP 404/.test(read.stderr + read.stdout)) return null;
    throw new Error(`Reading the ${name} environment on ${repo} failed: ${read.stderr.trim() || `exit ${read.code}`}`);
  }
  const policy = (JSON.parse(read.stdout) as EnvironmentResponse).deployment_branch_policy ?? null;
  if (policy === null) return { branches: "all", rules: [] };
  if (policy.custom_branch_policies !== true) return { branches: "protected", rules: [] };
  return { branches: "selected", rules: await readEnvironmentRules(run, cwd, repo, name) };
}

/** GitHub's environment, as far as Setup reads it: null is every branch, and exactly one of the two switches is on otherwise. */
interface EnvironmentResponse {
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

/**
 * The rules of a repo's environment set to "Selected branches and tags", as
 * GitHub has them now: the step that holds one reads them before it adds its
 * rule and again once it has.
 */
export async function readEnvironmentRules(run: Run, cwd: string, repo: string, name: string): Promise<EnvironmentRule[]> {
  const path = `repos/${repo}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`;
  const listed = JSON.parse(await ok(run, "gh", ["api", path], { cwd })) as { branch_policies?: { id: number; name: string; type?: string }[] };
  // A rule made before GitHub's rules had a type is a branch rule.
  return (listed.branch_policies ?? []).map(({ id, name: ruleName, type }) => ({ id, name: ruleName, type: type === "tag" ? "tag" : "branch" }));
}

/** A page of the repo's Deployments, as many as GitHub gives to one. */
const DEPLOYMENTS_PAGE = 100;

/**
 * The environments the repo's Deployments carry, from every page of them, and
 * each one's address on its newest successful Deployment where GitHub has one:
 * a Deployment succeeded if any of its statuses was ever `success`, as GitHub
 * turns an earlier success `inactive`. It reads an environment's Deployments'
 * statuses newest first, stopping at the first that succeeded. A refused read
 * is said, never thrown: production's question is no reason for setup to stop.
 */
export async function gatherDeployments(run: Run, cwd: string, repo: ProductState["repo"]): Promise<DeploymentsSeen> {
  try {
    return await readDeployments(run, cwd, repo);
  } catch (error) {
    return { read: false, why: firstLine(error instanceof Error ? error.message : String(error)) };
  }
}

interface ListedDeployment {
  readonly id: number;
  readonly environment: string;
  readonly created_at?: string;
}

async function readDeployments(run: Run, cwd: string, repo: ProductState["repo"]): Promise<DeploymentsSeen> {
  const listed: ListedDeployment[] = [];
  for (let page = 1; ; page++) {
    const read = await run("gh", ["api", `repos/${repo.owner}/${repo.name}/deployments?per_page=${DEPLOYMENTS_PAGE}&page=${page}`], { cwd });
    if (read.code !== 0) return { read: false, why: firstLine(read.stderr || read.stdout) };
    const batch = JSON.parse(read.stdout) as ListedDeployment[];
    listed.push(...batch);
    if (batch.length < DEPLOYMENTS_PAGE) break;
  }
  const deployments = listed.toSorted((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const names = [...new Set(deployments.map((deployment) => deployment.environment))];
  const environments = [];
  for (const name of names) {
    let url: string | null = null;
    for (const { id } of deployments.filter((deployment) => deployment.environment === name)) {
      const read = await run("gh", ["api", `repos/${repo.owner}/${repo.name}/deployments/${id}/statuses?per_page=100`], { cwd });
      if (read.code !== 0) continue;
      const success = (JSON.parse(read.stdout) as { state: string; environment_url?: string | null }[]).find((status) => status.state === "success");
      if (success === undefined) continue;
      url = isHttpAddress(success.environment_url ?? "") ? (success.environment_url ?? null) : null;
      break;
    }
    environments.push({ name, url });
  }
  return { read: true, environments };
}

function isHttpAddress(text: string): boolean {
  const protocol = URL.parse(text)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/** The titles of the items in a vault the account has. */
export async function vaultItems(run: Run, cwd: string, vault: string): Promise<string[]> {
  const listed = JSON.parse(await ok(run, "op", ["item", "list", "--vault", vault, "--format", "json"], { cwd })) as { title: string }[];
  return listed.map((item) => item.title);
}

/** How many open issues are labelled ready-for-agent. A repo without the label has none, and `gh` may refuse to filter by a label that doesn't exist. */
async function gatherReadyForAgent(run: Run, cwd: string, labels: readonly string[]): Promise<number> {
  if (!labels.some((label) => label.toLowerCase() === READY_FOR_AGENT.toLowerCase())) return 0;
  const args = ["issue", "list", "--label", READY_FOR_AGENT, "--state", "open", "--limit", "1000", "--json", "number"];
  return (JSON.parse(await ok(run, "gh", args, { cwd })) as unknown[]).length;
}

/** The fabrik-runs store, read through the API: setup has no checkout of it. */
async function gatherStore(run: Run, cwd: string): Promise<RunStoreState> {
  const view = await run("gh", ["repo", "view", RUN_STORE_REPO, "--json", "visibility"], { cwd });
  if (view.code !== 0) {
    if (/Could not resolve to a Repository|HTTP 404/.test(view.stderr + view.stdout)) {
      return { exists: false, private: false, files: {}, secrets: [] };
    }
    throw new Error(`Reading ${RUN_STORE_REPO} failed: ${view.stderr.trim()}`);
  }
  const { visibility } = JSON.parse(view.stdout) as { visibility: string };
  const files = Object.fromEntries(
    await Promise.all(STORE_PATHS.map(async (path) => [path, (await storeFile(run, cwd, path))?.text ?? null] as const)),
  );
  const listed = JSON.parse(await ok(run, "gh", ["secret", "list", "--repo", RUN_STORE_REPO, "--json", "name"], { cwd })) as { name: string }[];
  return { exists: true, private: visibility === "PRIVATE", files, secrets: listed.map((secret) => secret.name) };
}

/** Every file planSetup reads from the store. */
const STORE_PATHS = [STORE_CALLER_PATH, DEPENDABOT_PATH];

/** One file on the store's default branch, with the blob sha an update must name, or null when it lacks it. */
export async function storeFile(run: Run, cwd: string, path: string): Promise<{ text: string; sha: string } | null> {
  const result = await run("gh", ["api", `repos/${RUN_STORE_REPO}/contents/${path}`], { cwd });
  if (result.code !== 0) {
    // An empty repo answers 404 for every path, as a missing file does.
    if (/HTTP 404|This repository is empty/.test(result.stderr + result.stdout)) return null;
    throw new Error(`Reading ${path} in ${RUN_STORE_REPO} failed: ${result.stderr.trim()}`);
  }
  const body = JSON.parse(result.stdout) as { content: string; sha: string };
  return { text: Buffer.from(body.content, "base64").toString("utf8"), sha: body.sha };
}

/** Who an allowance in GitHub's protection response names: users by login, teams and apps by slug. */
interface AllowancesResponse {
  users?: { login: string }[];
  teams?: { slug: string }[];
  apps?: { slug: string }[];
}

type Enabled = { enabled?: boolean } | undefined;

interface ProtectionResponse {
  required_status_checks?: { strict?: boolean; contexts?: string[]; checks?: { context: string; app_id?: number | null }[] } | null;
  enforce_admins?: Enabled;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    require_last_push_approval?: boolean;
    dismissal_restrictions?: AllowancesResponse;
    bypass_pull_request_allowances?: AllowancesResponse;
  } | null;
  restrictions?: AllowancesResponse | null;
  required_linear_history?: Enabled;
  allow_force_pushes?: Enabled;
  allow_deletions?: Enabled;
  block_creations?: Enabled;
  required_conversation_resolution?: Enabled;
  lock_branch?: Enabled;
  allow_fork_syncing?: Enabled;
}

/** The default branch's whole protection, every setting the PUT takes, so Setup can write back what it doesn't own as it found it. */
async function gatherProtection(run: Run, cwd: string, repo: ProductState["repo"]): Promise<BranchProtection | null> {
  const result = await run("gh", ["api", `repos/${repo.owner}/${repo.name}/branches/${repo.defaultBranch}/protection`], { cwd });
  if (result.code !== 0) {
    if (/Branch not protected|HTTP 404/.test(result.stderr + result.stdout)) return null;
    throw new Error(`Reading ${repo.defaultBranch}'s branch protection failed: ${result.stderr.trim()}`);
  }
  const body = JSON.parse(result.stdout) as ProtectionResponse;
  const checks = body.required_status_checks;
  const reviews = body.required_pull_request_reviews;
  const on = (setting: Enabled) => setting?.enabled === true;
  return {
    required_status_checks:
      checks == null
        ? null
        : {
            strict: checks.strict === true,
            checks:
              checks.checks?.map(({ context, app_id }) => (typeof app_id === "number" ? { context, app_id } : { context })) ??
              (checks.contexts ?? []).map((context) => ({ context })),
          },
    enforce_admins: on(body.enforce_admins),
    required_pull_request_reviews:
      reviews == null
        ? null
        : {
            required_approving_review_count: reviews.required_approving_review_count ?? 0,
            dismiss_stale_reviews: reviews.dismiss_stale_reviews === true,
            require_code_owner_reviews: reviews.require_code_owner_reviews === true,
            require_last_push_approval: reviews.require_last_push_approval === true,
            ...(reviews.dismissal_restrictions === undefined ? {} : { dismissal_restrictions: allowances(reviews.dismissal_restrictions) }),
            ...(reviews.bypass_pull_request_allowances === undefined
              ? {}
              : { bypass_pull_request_allowances: allowances(reviews.bypass_pull_request_allowances) }),
          },
    restrictions: body.restrictions == null ? null : allowances(body.restrictions),
    required_linear_history: on(body.required_linear_history),
    allow_force_pushes: on(body.allow_force_pushes),
    allow_deletions: on(body.allow_deletions),
    block_creations: on(body.block_creations),
    required_conversation_resolution: on(body.required_conversation_resolution),
    lock_branch: on(body.lock_branch),
    allow_fork_syncing: on(body.allow_fork_syncing),
  };
}

function allowances(response: AllowancesResponse): Allowances {
  return {
    users: (response.users ?? []).map((user) => user.login),
    teams: (response.teams ?? []).map((team) => team.slug),
    apps: (response.apps ?? []).map((app) => app.slug),
  };
}

interface RulesetResponse {
  id: number;
  name: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[] } } | null;
  rules?: { type: string }[];
  bypass_actors?: { actor_id: number | null; actor_type: string }[];
}

/** The Merge gate ruleset, found by its name among the repo's own rulesets. */
async function gatherMergeGate(run: Run, cwd: string, repo: ProductState["repo"]): Promise<MergeGateRuleset | null> {
  const rulesets = JSON.parse(await ok(run, "gh", ["api", `repos/${repo.owner}/${repo.name}/rulesets?includes_parents=false`], { cwd })) as {
    id: number;
    name: string;
  }[];
  const found = rulesets.find((ruleset) => ruleset.name === MERGE_GATE_RULESET);
  if (found === undefined) return null;
  const ruleset = JSON.parse(await ok(run, "gh", ["api", `repos/${repo.owner}/${repo.name}/rulesets/${found.id}`], { cwd })) as RulesetResponse;
  return {
    id: ruleset.id,
    enforcement: ruleset.enforcement,
    branches: ruleset.conditions?.ref_name?.include ?? [],
    restrictsUpdates: (ruleset.rules ?? []).some((rule) => rule.type === "update"),
    bypassActors: (ruleset.bypass_actors ?? []).map((actor) => `${actor.actor_type}:${actor.actor_id ?? ""}`),
  };
}
