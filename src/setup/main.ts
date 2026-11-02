// What the setup skill runs, from a Fabrik checkout at the release being set
// up, with the Operator's own `gh` and `op` sign-ins:
//   node src/setup/main.ts <product checkout> <release>          prints the plan
//   node src/setup/main.ts <product checkout> <release> --apply  carries it out
// It gathers the Product repo's state, asks the planner (plan.ts) what's
// missing, and applies that. Thin by design: every decision is in the planner.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { loadSetupKit } from "./kit.ts";
import { type BranchProtection, type ProductState, planSetup, type SetupAction, type SetupPlan, setupPaths } from "./plan.ts";
import { pinCaller } from "./shims.ts";

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
  const view = JSON.parse(await ok("gh", ["repo", "view", "--json", "owner,name,defaultBranchRef"], { cwd })) as {
    owner: { login: string };
    name: string;
    defaultBranchRef: { name: string };
  };
  const repo = { owner: view.owner.login, name: view.name, defaultBranch: view.defaultBranchRef.name };
  const files = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(productDir, path), "utf8").catch(() => null)] as const)),
  );
  const names = (json: string) => (JSON.parse(json) as { name: string }[]).map((item) => item.name);
  const labels = names(await ok("gh", ["label", "list", "--limit", "1000", "--json", "name"], { cwd }));
  const secrets = names(await ok("gh", ["secret", "list", "--json", "name"], { cwd }));
  const vaults = names(await ok("op", ["vault", "list", "--format", "json"], { cwd }));
  return { repo, files, labels, secrets, vaults, protection: await gatherProtection(cwd, repo) };
}

interface ProtectionResponse {
  required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
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
    requiredApprovals: reviews?.required_approving_review_count ?? 0,
    bypassAllowances: [
      ...(bypass?.apps ?? []).map((app) => `app:${app.slug}`),
      ...(bypass?.users ?? []).map((user) => `user:${user.login}`),
      ...(bypass?.teams ?? []).map((team) => `team:${team.slug}`),
    ],
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
      await ok("gh", ["secret", "set", action.secret], { cwd, input: token });
      return;
    }
    case "protect-branch": {
      const body = {
        required_status_checks: action.requiredChecks.length === 0 ? null : { strict: false, contexts: action.requiredChecks },
        enforce_admins: false,
        required_pull_request_reviews: {
          required_approving_review_count: action.requiredApprovals,
          dismiss_stale_reviews: true,
          bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      };
      const path = `repos/${repo.owner}/${repo.name}/branches/${action.branch}/protection`;
      await ok("gh", ["api", "--method", "PUT", path, "--input", "-"], { cwd, input: JSON.stringify(body) });
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
      return `create the read-only service account "${action.name}" (reads ${action.vaults.map((v) => `"${v}"`).join(", ")}) and store it as the Actions secret ${action.secret}`;
    case "protect-branch":
      return `protect ${action.branch}: a PR with ${action.requiredApprovals} approving review, ${action.requiredChecks.length === 0 ? "no required checks yet" : `the checks ${action.requiredChecks.join(", ")}`}, no bypass`;
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

async function main(productDir: string, release: string, applying: boolean): Promise<void> {
  const kitDir = resolve(import.meta.dirname, "..", "..");
  const kit = await loadSetupKit(kitDir, release);
  const pinned = checkCallerWorkflow(pinCaller(kit.templates.caller, release));
  if (!pinned.ok) throw new Error(`Can't set up Fabrik ${release}: ${pinned.error}`);
  const state = await gatherState(productDir, setupPaths(kit));
  const plan = planSetup(state, kit);
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
  const [productDir, release] = args.filter((arg) => arg !== "--apply");
  if (productDir === undefined || release === undefined) {
    console.error("Usage: node src/setup/main.ts <product checkout> <release> [--apply]");
    process.exit(2);
  }
  main(resolve(productDir), release, applying).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
