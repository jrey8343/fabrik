// What setup reads before planning, with the Operator's own gh and op: the
// Product repo's files, labels, secrets, branch protection and Merge gate, the
// 1Password account's vaults, and the fabrik-runs store. It only reads.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { READY_FOR_AGENT } from "../loop/labels.ts";
import { ok, type Run } from "./exec.ts";
import { type Allowances, type DeploymentsSeen, FABRIK_VAULT, MERGE_GATE_RULESET, type BranchProtection, type MergeGateRuleset, type ProductState, type RunStoreState } from "./plan.ts";
import { DEPENDABOT_PATH, STORE_CALLER_PATH } from "./shims.ts";

/** Everything planSetup needs, for the repo the checks found. */
export async function gatherState(run: Run, productDir: string, repo: ProductState["repo"], paths: readonly string[]): Promise<ProductState> {
  const cwd = productDir;
  const files = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(productDir, path), "utf8").catch(() => null)] as const)),
  );
  const names = (json: string) => (JSON.parse(json) as { name: string }[]).map((item) => item.name);
  const labels = names(await ok(run, "gh", ["label", "list", "--limit", "1000", "--json", "name"], { cwd }));
  const secrets = names(await ok(run, "gh", ["secret", "list", "--json", "name"], { cwd }));
  const vaults = names(await ok(run, "op", ["vault", "list", "--format", "json"], { cwd }));
  const fabrikItems = vaults.includes(FABRIK_VAULT) ? await vaultItems(run, cwd, FABRIK_VAULT) : [];
  const [protection, mergeGate, store] = await Promise.all([
    gatherProtection(run, cwd, repo),
    gatherMergeGate(run, cwd, repo),
    gatherStore(run, cwd),
  ]);
  const readyForAgent = await gatherReadyForAgent(run, cwd, labels);
  return { repo, files, labels, secrets, vaults, fabrikItems, protection, mergeGate, store, readyForAgent };
}

/** How many of an environment's newest Deployments setup reads the statuses of, looking for its address. */
const DEPLOYMENTS_PER_ENVIRONMENT = 5;

/**
 * The environments the repo's Deployments carry, from its newest hundred, and
 * each one's address on its newest successful Deployment where GitHub has one:
 * a Deployment succeeded if any of its statuses was ever `success`, as GitHub
 * turns an earlier success `inactive`. A refused read is said, never thrown:
 * production's question is no reason for setup to stop.
 */
export async function gatherDeployments(run: Run, cwd: string, repo: ProductState["repo"]): Promise<DeploymentsSeen> {
  try {
    return await readDeployments(run, cwd, repo);
  } catch (error) {
    return { read: false, why: firstLine(error instanceof Error ? error.message : String(error)) };
  }
}

async function readDeployments(run: Run, cwd: string, repo: ProductState["repo"]): Promise<DeploymentsSeen> {
  const listed = await run("gh", ["api", `repos/${repo.owner}/${repo.name}/deployments?per_page=100`], { cwd });
  if (listed.code !== 0) return { read: false, why: firstLine(listed.stderr || listed.stdout) };
  const deployments = (JSON.parse(listed.stdout) as { id: number; environment: string; created_at?: string }[]).toSorted((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  const names = [...new Set(deployments.map((deployment) => deployment.environment))];
  const environments = [];
  for (const name of names) {
    const newest = deployments.filter((deployment) => deployment.environment === name).slice(0, DEPLOYMENTS_PER_ENVIRONMENT);
    let url: string | null = null;
    for (const { id } of newest) {
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
