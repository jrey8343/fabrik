// Carrying out one step of the plan with the Operator's own gh and op, and
// how the plan names each step.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONSOLE_CHECK } from "../kit/consoleCheck.ts";
import { ok, type Run } from "./exec.ts";
import { readDefaultBranch, readEnvironmentPolicy, readEnvironmentRules, storeFile } from "./gather.ts";
import {
  ADMIN_BYPASS,
  type BranchProtection,
  bypassAllowances,
  environmentHeld,
  type EnvironmentRule,
  MERGE_GATE_RULESET,
  namedPolicy,
  onlyRuleNames,
  type ProductState,
  type SetupAction,
  UNPROTECTED,
} from "./plan.ts";

export async function apply(run: Run, action: SetupAction, productDir: string, repo: ProductState["repo"]): Promise<void> {
  const cwd = productDir;
  switch (action.kind) {
    case "hold-environment": {
      const { environment } = action;
      const repoName = action.repo ?? `${repo.owner}/${repo.name}`;
      // A repo that had no default branch when Setup planned has one once its first file is committed: its name is read before anything is made.
      const branch = action.branch ?? (await defaultBranchNow(run, cwd, repoName, environment));
      const path = `repos/${repoName}/environments/${environment}`;
      // Makes it, or sets it to "Selected branches and tags". Only the branch policy is sent, so any other protection rule stays as it is.
      const body = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
      const put = await run("gh", ["api", "--method", "PUT", path, "--input", "-"], { cwd, input: JSON.stringify(body) });
      if (put.code !== 0) {
        const answer = (put.stderr.trim() || put.stdout.trim()).split("\n")[0]?.trim() || `exit ${put.code}`;
        throw new Error(
          `GitHub refused the ${environment} environment on ${repoName}: ${answer}. A private repo needs a GitHub plan with environments: GitHub Pro for a personal account's repo, or GitHub Team for an organization's. The Kit keeps no fallback to repo-level secrets, so Setup stopped before changing anything else.`,
        );
      }
      // The rule naming the default branch goes in before any other comes out, so an environment that holds secrets is never left with no rule (#846).
      const rules = await readEnvironmentRules(run, cwd, repoName, environment);
      // The rule that holds it: a branch rule naming the branch, never a tag rule of that name.
      const namesTheBranch = (rule: EnvironmentRule) => onlyRuleNames([rule], branch);
      if (!rules.some(namesTheBranch)) {
        await ok(run, "gh", ["api", "--method", "POST", `${path}/deployment-branch-policies`, "-f", `name=${branch}`, "-f", "type=branch"], { cwd });
      }
      for (const rule of rules.filter((found) => !namesTheBranch(found))) {
        await ok(run, "gh", ["api", "--method", "DELETE", `${path}/deployment-branch-policies/${rule.id}`], { cwd });
      }
      // Read back whole, its setting with its rules, by the test the plan uses: never a call's having been taken, and never the rule alone, which GitHub lists under any setting.
      const readBack = await readEnvironmentPolicy(run, cwd, repoName, environment);
      if (!environmentHeld(readBack, branch)) {
        const as = readBack === null ? "missing" : namedPolicy(readBack);
        throw new Error(`The ${environment} environment on ${repoName} reads back as ${as}, not held to ${branch} alone, so Setup stored no token in it. Run setup again.`);
      }
      return;
    }
    case "write-file": {
      const target = resolve(productDir, action.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, action.content);
      return;
    }
    case "create-label":
      await ok(run, "gh", ["label", "create", action.name, "--color", action.color, "--description", action.description], { cwd });
      return;
    case "create-vault":
      await ok(run, "op", ["vault", "create", action.name], { cwd });
      return;
    case "create-service-account": {
      const { environment } = action;
      const repoName = action.repo ?? `${repo.owner}/${repo.name}`;
      // The rule must name the default branch of the repo that holds the environment: another repo's own, as GitHub has it now, never the Product repo's.
      const branch = action.repo === undefined ? repo.defaultBranch : await defaultBranchNow(run, cwd, action.repo, environment);
      // The environment is read first, its setting and its rules, whether or not this run changed it: one that isn't held gives its secrets to other refs (#846).
      const found = await readEnvironmentPolicy(run, cwd, repoName, environment);
      if (!environmentHeld(found, branch)) {
        throw new Error(`The ${environment} environment on ${repoName} isn't held to ${branch} alone, so Setup stored no token in it. Run setup again.`);
      }
      // Read-only, no expiry (ADR-0004). The token is shown once: it goes
      // straight into the environment's secret, on gh's stdin, and is never printed.
      const grants = action.vaults.flatMap((vault) => ["--vault", `${vault}:read_items`]);
      const token = (await ok(run, "op", ["service-account", "create", action.name, ...grants, "--raw"], { cwd })).trim();
      const where = action.repo === undefined ? [] : ["--repo", action.repo];
      await ok(run, "gh", ["secret", "set", action.secret, "--env", environment, ...where], { cwd, input: token });
      return;
    }
    case "delete-repo-secret":
      // Named with no --env, so only ever the repo-level one: the environment's secret of the same name stays.
      await ok(run, "gh", ["secret", "delete", action.secret, ...(action.repo === undefined ? [] : ["--repo", action.repo])], { cwd });
      return;
    case "create-run-store":
      await ok(
        run,
        "gh",
        ["repo", "create", action.repo, "--private", "--description", "Fabrik's Run records, their transcripts and the Weekly summary (ADR-0009)"],
        { cwd },
      );
      return;
    case "write-store-file": {
      // Committed straight to the store's default branch; on an empty repo this first commit creates it.
      const current = await storeFile(run, cwd, action.path);
      const body = {
        message: `Fabrik setup: ${action.why}`,
        content: Buffer.from(action.content, "utf8").toString("base64"),
        ...(current === null ? {} : { sha: current.sha }),
      };
      await ok(run, "gh", ["api", "--method", "PUT", `repos/${action.repo}/contents/${action.path}`, "--input", "-"], {
        cwd,
        input: JSON.stringify(body),
      });
      return;
    }
    case "protect-branch": {
      const path = `repos/${repo.owner}/${repo.name}/branches/${action.branch}/protection`;
      await ok(run, "gh", ["api", "--method", "PUT", path, "--input", "-"], { cwd, input: JSON.stringify(action.protection) });
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
      await ok(run, "gh", ["api", "--method", ...target, "--input", "-"], { cwd, input: JSON.stringify(body) });
      return;
    }
  }
}

/**
 * The default branch a repo that isn't the Product repo has now, for the step
 * that holds its environment to it, or stores a token there. A repo with no
 * commit has none, and no branch for a rule to name, so the step stops there.
 */
async function defaultBranchNow(run: Run, cwd: string, repo: string, environment: string): Promise<string> {
  const branch = await readDefaultBranch(run, cwd, repo);
  if (branch === null) {
    throw new Error(`${repo} has no default branch yet, so Setup couldn't hold its ${environment} environment to one, and stored no token in it. Run setup again.`);
  }
  return branch;
}

export function describeAction(action: SetupAction): string {
  switch (action.kind) {
    case "hold-environment": {
      const { found } = action;
      const branch = action.branch ?? "its default branch";
      const environment = `the ${action.environment} environment${action.repo === undefined ? "" : ` in ${action.repo}`}`;
      if (found === null) return `create ${environment}, held to ${branch} alone: only a run of ${branch} is given its secrets`;
      return `hold ${environment} to ${branch} alone: rules ${namedPolicy(found)} → ${branch}`;
    }
    case "write-file":
      return `write ${action.path} (${action.why})`;
    case "create-label":
      return `create the label ${action.name}`;
    case "create-vault":
      return `create the 1Password vault "${action.name}"`;
    case "create-service-account": {
      const account = `create the read-only service account "${action.name}" (reads ${action.vaults.map((v) => `"${v}"`).join(", ")})`;
      const repo = action.repo === undefined ? "" : ` in ${action.repo}`;
      return `${account} and store it as ${action.secret} in the ${action.environment} environment${repo}`;
    }
    case "delete-repo-secret": {
      const repo = action.repo === undefined ? "" : ` in ${action.repo}`;
      return `delete the repo-level Actions secret ${action.secret}${repo}: the Kit ${action.branch} pins reads the ${action.environment} environment's`;
    }
    case "protect-branch":
      return `protect ${action.branch}: ${[...protectionChanges(action.found ?? UNPROTECTED, action.protection), "every other setting stays as it is"].join("; ")}`;
    case "restrict-default-branch":
      return `${action.rulesetId === null ? "create" : "repair"} the "${MERGE_GATE_RULESET}" ruleset: only repo admins (you) may update the default branch, so the Fabrik App can't merge`;
    case "create-run-store":
      return `create ${action.repo}, private, to hold Run records, their transcripts and the Weekly summary`;
    case "write-store-file":
      return `write ${action.path} in ${action.repo} (${action.why})`;
  }
}

/** Each setting Setup owns that the protect-branch step changes, from what to what. */
function protectionChanges(found: BranchProtection, protection: BranchProtection): string[] {
  const list = (items: readonly string[]) => (items.length === 0 ? "none" : items.join(", "));
  const changes: string[] = [];
  if (found.required_pull_request_reviews === null) changes.push("a pull request: not required → required");
  const [checksBefore, checksAfter] = [namedChecks(found), namedChecks(protection)];
  if (list(checksBefore) !== list(checksAfter)) changes.push(`required checks: ${list(checksBefore)} → ${list(checksAfter)}`);
  const [reviewsBefore, reviewsAfter] = [found, protection].map((p) => p.required_pull_request_reviews?.required_approving_review_count ?? 0);
  if (reviewsBefore !== reviewsAfter) changes.push(`approving reviews: ${reviewsBefore} → ${reviewsAfter}`);
  const [bypassBefore, bypassAfter] = [bypassAllowances(found), bypassAllowances(protection)];
  if (list(bypassBefore) !== list(bypassAfter)) changes.push(`bypass allowances: ${list(bypassBefore)} → ${list(bypassAfter)}`);
  const held = (on: boolean) => (on ? "yes" : "no");
  if (found.enforce_admins !== protection.enforce_admins) changes.push(`admins held to the rules: ${held(found.enforce_admins)} → ${held(protection.enforce_admins)}`);
  return changes;
}

/**
 * The checks a branch requires, as the plan names them: the Console check with
 * the App beside it, since Setup owns that App and a change of it alone is a
 * change, and every other check by its name.
 */
function namedChecks(protection: BranchProtection): string[] {
  return (protection.required_status_checks?.checks ?? []).map(({ context, app_id }) =>
    context === CONSOLE_CHECK && app_id !== undefined ? `${context} (App ${app_id})` : context,
  );
}

/** The files in the Product checkout these steps wrote, as describeAction words them. A step of any other kind names none. */
export function writtenPaths(steps: readonly string[]): string[] {
  return [...new Set(steps.flatMap((step) => /^write (\S+) \(/.exec(step)?.[1] ?? []))];
}
