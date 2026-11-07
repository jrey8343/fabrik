// What setup reads before planning, with the Operator's own gh and op: the
// Product repo's files, labels, secrets, branch protection and Merge gate, the
// 1Password account's vaults, and the fabrik-runs store. It only reads.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { READY_FOR_AGENT } from "../loop/labels.ts";
import { ok, type Run } from "./exec.ts";
import { FABRIK_VAULT, MERGE_GATE_RULESET, type BranchProtection, type MergeGateRuleset, type ProductState, type RunStoreState } from "./plan.ts";
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
  const titles = (json: string) => (JSON.parse(json) as { title: string }[]).map((item) => item.title);
  const fabrikItems = vaults.includes(FABRIK_VAULT)
    ? titles(await ok(run, "op", ["item", "list", "--vault", FABRIK_VAULT, "--format", "json"], { cwd }))
    : [];
  const [protection, mergeGate, store] = await Promise.all([
    gatherProtection(run, cwd, repo),
    gatherMergeGate(run, cwd, repo),
    gatherStore(run, cwd),
  ]);
  const readyForAgent = await gatherReadyForAgent(run, cwd, labels);
  return { repo, files, labels, secrets, vaults, fabrikItems, protection, mergeGate, store, readyForAgent };
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

interface ProtectionResponse {
  required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } | null;
  required_pull_request_reviews?: {
    bypass_pull_request_allowances?: { users?: { login: string }[]; teams?: { slug: string }[]; apps?: { slug: string }[] };
  } | null;
}

async function gatherProtection(run: Run, cwd: string, repo: ProductState["repo"]): Promise<BranchProtection | null> {
  const result = await run("gh", ["api", `repos/${repo.owner}/${repo.name}/branches/${repo.defaultBranch}/protection`], { cwd });
  if (result.code !== 0) {
    if (/Branch not protected|HTTP 404/.test(result.stderr + result.stdout)) return null;
    throw new Error(`Reading ${repo.defaultBranch}'s branch protection failed: ${result.stderr.trim()}`);
  }
  const body = JSON.parse(result.stdout) as ProtectionResponse;
  const checks = body.required_status_checks;
  const reviews = body.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  return {
    requiredChecks: checks?.contexts ?? checks?.checks?.map((check) => check.context) ?? [],
    requiresPullRequest: reviews != null,
    bypassAllowances: [
      ...(bypass?.apps ?? []).map((app) => `app:${app.slug}`),
      ...(bypass?.users ?? []).map((user) => `user:${user.login}`),
      ...(bypass?.teams ?? []).map((team) => `team:${team.slug}`),
    ],
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
