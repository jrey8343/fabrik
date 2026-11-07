// Carrying out one step of the plan with the Operator's own gh and op, and
// how the plan names each step.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ok, type Run } from "./exec.ts";
import { storeFile } from "./gather.ts";
import { ADMIN_BYPASS, MERGE_GATE_RULESET, type ProductState, type SetupAction } from "./plan.ts";

export async function apply(run: Run, action: SetupAction, productDir: string, repo: ProductState["repo"]): Promise<void> {
  const cwd = productDir;
  switch (action.kind) {
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
      // Read-only, no expiry (ADR-0004). The token is shown once: it goes
      // straight into the Actions secret and is never printed.
      const grants = action.vaults.flatMap((vault) => ["--vault", `${vault}:read_items`]);
      const token = (await ok(run, "op", ["service-account", "create", action.name, ...grants, "--raw"], { cwd })).trim();
      const where = action.repo === undefined ? [] : ["--repo", action.repo];
      await ok(run, "gh", ["secret", "set", action.secret, ...where], { cwd, input: token });
      return;
    }
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
      await ok(run, "gh", ["api", "--method", "PUT", path, "--input", "-"], { cwd, input: JSON.stringify(body) });
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
