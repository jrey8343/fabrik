// What the setup skill runs, from a Fabrik checkout at the release being set
// up, with the Operator's own `gh` and `op` sign-ins:
//   node src/setup/main.ts <product checkout> <release>          prints the plan
//   node src/setup/main.ts <product checkout> <release> --apply  carries it out
// With --time-zone=<IANA zone> it also sets up the fabrik-runs store.
// It gathers the Product repo's state, asks the planner (plan.ts) what's
// missing, and applies that. Thin by design: every decision is in the planner.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { loadSetupKit } from "./kit.ts";
import {
  ADMIN_BYPASS,
  type BranchProtection,
  MERGE_GATE_RULESET,
  type MergeGateRuleset,
  type ProductState,
  planSetup,
  type RunStoreState,
  type SetupAction,
  type SetupAnswers,
  type SetupPlan,
  setupPaths,
} from "./plan.ts";
import { DEPENDABOT_PATH, pinCaller, STORE_CALLER_PATH } from "./shims.ts";

interface Run {
  readonly stdout: string;
  readonly code: number;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], options: { cwd: string; input?: string }): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(options.input ?? "");
  });
}

async function ok(command: string, args: readonly string[], options: { cwd: string; input?: string }): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} ${args[1] ?? ""} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

async function gatherState(productDir: string, paths: readonly string[]): Promise<ProductState> {
  const cwd = productDir;
  const view = JSON.parse(await ok("gh", ["repo", "view", "--json", "owner,name,defaultBranchRef,isInOrganization"], { cwd })) as {
    owner: { login: string };
    name: string;
    defaultBranchRef: { name: string };
    isInOrganization: boolean;
  };
  const repo = {
    owner: view.owner.login,
    name: view.name,
    defaultBranch: view.defaultBranchRef.name,
    inOrganization: view.isInOrganization,
  };
  const files = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(productDir, path), "utf8").catch(() => null)] as const)),
  );
  const names = (json: string) => (JSON.parse(json) as { name: string }[]).map((item) => item.name);
  const labels = names(await ok("gh", ["label", "list", "--limit", "1000", "--json", "name"], { cwd }));
  const secrets = names(await ok("gh", ["secret", "list", "--json", "name"], { cwd }));
  const vaults = names(await ok("op", ["vault", "list", "--format", "json"], { cwd }));
  const [protection, mergeGate, store] = await Promise.all([
    gatherProtection(cwd, repo),
    gatherMergeGate(cwd, repo),
    gatherStore(cwd),
  ]);
  return { repo, files, labels, secrets, vaults, protection, mergeGate, store };
}

/** The fabrik-runs store, read through the API: setup has no checkout of it. */
async function gatherStore(cwd: string): Promise<RunStoreState> {
  const view = await run("gh", ["repo", "view", RUN_STORE_REPO, "--json", "visibility"], { cwd });
  if (view.code !== 0) {
    if (/Could not resolve to a Repository|HTTP 404/.test(view.stderr + view.stdout)) {
      return { exists: false, private: false, files: {}, secrets: [] };
    }
    throw new Error(`Reading ${RUN_STORE_REPO} failed: ${view.stderr.trim()}`);
  }
  const { visibility } = JSON.parse(view.stdout) as { visibility: string };
  const files = Object.fromEntries(
    await Promise.all(STORE_PATHS.map(async (path) => [path, (await storeFile(cwd, path))?.text ?? null] as const)),
  );
  const listed = JSON.parse(await ok("gh", ["secret", "list", "--repo", RUN_STORE_REPO, "--json", "name"], { cwd })) as { name: string }[];
  return { exists: true, private: visibility === "PRIVATE", files, secrets: listed.map((secret) => secret.name) };
}

/** Every file planSetup reads from the store. */
const STORE_PATHS = [STORE_CALLER_PATH, DEPENDABOT_PATH];

/** One file on the store's default branch, with the blob sha an update must name, or null when it lacks it. */
async function storeFile(cwd: string, path: string): Promise<{ text: string; sha: string } | null> {
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

async function gatherProtection(cwd: string, repo: ProductState["repo"]): Promise<BranchProtection | null> {
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
async function gatherMergeGate(cwd: string, repo: ProductState["repo"]): Promise<MergeGateRuleset | null> {
  const rulesets = JSON.parse(await ok("gh", ["api", `repos/${repo.owner}/${repo.name}/rulesets?includes_parents=false`], { cwd })) as {
    id: number;
    name: string;
  }[];
  const found = rulesets.find((ruleset) => ruleset.name === MERGE_GATE_RULESET);
  if (found === undefined) return null;
  const ruleset = JSON.parse(await ok("gh", ["api", `repos/${repo.owner}/${repo.name}/rulesets/${found.id}`], { cwd })) as RulesetResponse;
  return {
    id: ruleset.id,
    enforcement: ruleset.enforcement,
    branches: ruleset.conditions?.ref_name?.include ?? [],
    restrictsUpdates: (ruleset.rules ?? []).some((rule) => rule.type === "update"),
    bypassActors: (ruleset.bypass_actors ?? []).map((actor) => `${actor.actor_type}:${actor.actor_id ?? ""}`),
  };
}

async function apply(action: SetupAction, productDir: string, repo: ProductState["repo"]): Promise<void> {
  const cwd = productDir;
  switch (action.kind) {
    case "write-file": {
      const target = resolve(productDir, action.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, action.content);
      return;
    }
    case "create-label":
      await ok("gh", ["label", "create", action.name, "--color", action.color, "--description", action.description], { cwd });
      return;
    case "create-vault":
      await ok("op", ["vault", "create", action.name], { cwd });
      return;
    case "create-service-account": {
      // Read-only, no expiry (ADR-0004). The token is shown once: it goes
      // straight into the Actions secret and is never printed.
      const grants = action.vaults.flatMap((vault) => ["--vault", `${vault}:read_items`]);
      const token = (await ok("op", ["service-account", "create", action.name, ...grants, "--raw"], { cwd })).trim();
      const where = action.repo === undefined ? [] : ["--repo", action.repo];
      await ok("gh", ["secret", "set", action.secret, ...where], { cwd, input: token });
      return;
    }
    case "create-run-store":
      await ok(
        "gh",
        ["repo", "create", action.repo, "--private", "--description", "Fabrik's Run records, their transcripts and the Weekly summary (ADR-0009)"],
        { cwd },
      );
      return;
    case "write-store-file": {
      // Committed straight to the store's default branch; on an empty repo this first commit creates it.
      const current = await storeFile(cwd, action.path);
      const body = {
        message: `Fabrik setup: ${action.why}`,
        content: Buffer.from(action.content, "utf8").toString("base64"),
        ...(current === null ? {} : { sha: current.sha }),
      };
      await ok("gh", ["api", "--method", "PUT", `repos/${action.repo}/contents/${action.path}`, "--input", "-"], {
        cwd,
        input: JSON.stringify(body),
      });
      return;
    }
    case "protect-branch": {
      const body = {
        required_status_checks: action.requiredChecks.length === 0 ? null : { strict: false, contexts: action.requiredChecks },
        enforce_admins: false,
        // A PR, but no approving review: the Operator can't approve their own PRs.
        // The Merge gate ruleset is what keeps the Fabrik App from merging.
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: true,
          // Empty lists take away any bypass. GitHub rejects the field (HTTP 422) on a
          // personal account's repo, which can't have bypass allowances anyway.
          ...(repo.inOrganization ? { bypass_pull_request_allowances: { users: [], teams: [], apps: [] } } : {}),
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      };
      const path = `repos/${repo.owner}/${repo.name}/branches/${action.branch}/protection`;
      await ok("gh", ["api", "--method", "PUT", path, "--input", "-"], { cwd, input: JSON.stringify(body) });
      return;
    }
    case "restrict-default-branch": {
      // Only its bypass actors may update the default branch, merging a PR included,
      // and the only one is the repo admin role: the Operator, never the Fabrik App.
      const [actorType, actorId] = ADMIN_BYPASS.split(":");
      const body = {
        name: MERGE_GATE_RULESET,
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [{ type: "update" }],
        bypass_actors: [{ actor_type: actorType, actor_id: Number(actorId), bypass_mode: "always" }],
      };
      const rulesets = `repos/${repo.owner}/${repo.name}/rulesets`;
      const target = action.rulesetId === null ? ["POST", rulesets] : ["PUT", `${rulesets}/${action.rulesetId}`];
      await ok("gh", ["api", "--method", ...target, "--input", "-"], { cwd, input: JSON.stringify(body) });
      return;
    }
  }
}

export function describeAction(action: SetupAction): string {
  switch (action.kind) {
    case "write-file":
      return `write ${action.path} (${action.why})`;
    case "create-label":
      return `create the label ${action.name}`;
    case "create-vault":
      return `create the 1Password vault "${action.name}"`;
    case "create-service-account":
      return `create the read-only service account "${action.name}" (reads ${action.vaults.map((v) => `"${v}"`).join(", ")}) and store it as the Actions secret ${action.secret}${action.repo === undefined ? "" : ` on ${action.repo}`}`;
    case "protect-branch":
      return `protect ${action.branch}: a PR and ${action.requiredChecks.length === 0 ? "no required checks yet" : `the checks ${action.requiredChecks.join(", ")}`}, no bypass, no approving review`;
    case "restrict-default-branch":
      return `${action.rulesetId === null ? "create" : "repair"} the "${MERGE_GATE_RULESET}" ruleset: only repo admins (you) may update the default branch, so the Fabrik App can't merge`;
    case "create-run-store":
      return `create ${action.repo}, private, to hold Run records, their transcripts and the Weekly summary`;
    case "write-store-file":
      return `write ${action.path} in ${action.repo} (${action.why})`;
  }
}

function report(plan: SetupPlan, applied: boolean): string {
  const lines =
    plan.actions.length === 0
      ? ["Nothing to do: this repo's Fabrik install is complete."]
      : applied
        ? ["Done."]
        : ["Setup would:", ...plan.actions.map((action) => `- ${describeAction(action)}`), "", "Run again with --apply to do it."];
  if (plan.notes.length > 0) lines.push("", "For the Operator:", ...plan.notes.map((note) => `- ${note}`));
  return lines.join("\n");
}

async function main(productDir: string, release: string, applying: boolean, answers: SetupAnswers): Promise<void> {
  const kitDir = resolve(import.meta.dirname, "..", "..");
  const kit = await loadSetupKit(kitDir, release);
  const pinned = checkCallerWorkflow(pinCaller(kit.templates.caller, release));
  if (!pinned.ok) throw new Error(`Can't set up Fabrik ${release}: ${pinned.error}`);
  const state = await gatherState(productDir, setupPaths(kit));
  const plan = planSetup(state, kit, answers);
  if (applying) {
    for (const action of plan.actions) {
      await apply(action, productDir, state.repo);
      console.log(`- ${describeAction(action)}`);
    }
  }
  console.log(report(plan, applying));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const applying = args.includes("--apply");
  const timeZone = args.find((arg) => arg.startsWith("--time-zone="))?.slice("--time-zone=".length);
  const [productDir, release] = args.filter((arg) => !arg.startsWith("--"));
  if (productDir === undefined || release === undefined) {
    console.error("Usage: node src/setup/main.ts <product checkout> <release> [--time-zone=<IANA zone>] [--apply]");
    process.exit(2);
  }
  main(resolve(productDir), release, applying, timeZone === undefined ? {} : { timeZone }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
