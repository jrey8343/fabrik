// Product repo states for the setup planner's tests.
import { type BranchProtection, type EnvironmentState, type ProductState, type RunStoreState, type SetupPlan, UNPROTECTED } from "../setup/plan.ts";

export function aCleanProduct(overrides: Partial<ProductState> = {}): ProductState {
  return {
    repo: { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false },
    files: {},
    defaultBranchCaller: null,
    labels: [],
    secrets: [],
    environment: null,
    production: null,
    vaults: [],
    fabrikItems: [],
    protection: null,
    mergeGate: null,
    store: noStore(),
    readyForAgent: 0,
    workflows: {},
    ...overrides,
  };
}

/** A branch protected with a PR, the given checks and no approving review, every other setting off, then the overrides. */
export function aProtectedBranch(checks: readonly string[], overrides: Partial<BranchProtection> = {}): BranchProtection {
  return {
    ...UNPROTECTED,
    required_status_checks: { strict: false, checks: checks.map((context) => ({ context })) },
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
    },
    ...overrides,
  };
}

/** The fabrik-runs store before the Operator has opted in: it doesn't exist. */
export function noStore(): RunStoreState {
  return { exists: false, private: false, defaultBranch: null, files: {}, secrets: [], environment: null };
}

/** The state a repo is left in once every action in the plan has been applied to it. */
export function afterApplying(state: ProductState, plan: SetupPlan): ProductState {
  let next = state;
  for (const action of plan.actions) {
    switch (action.kind) {
      case "hold-environment": {
        // Its one rule names the branch, and its secrets stay as they were. A step that names a repo is the store's,
        // and one that names no branch holds it to the default branch the store has by then.
        const found = action.repo === undefined ? next.environment : next.store.environment;
        const branch = action.branch ?? next.store.defaultBranch;
        if (branch === null) throw new Error("The store has no default branch to hold its environment to: no file was committed to it first.");
        const held: EnvironmentState = { branches: "selected", rules: [{ id: 1, name: branch, type: "branch" }], secrets: found?.secrets ?? [] };
        next = action.repo === undefined ? { ...next, environment: held } : { ...next, store: { ...next.store, environment: held } };
        break;
      }
      case "write-file":
        next = { ...next, files: { ...next.files, [action.path]: action.content } };
        break;
      case "create-label":
        next = { ...next, labels: [...next.labels, action.name] };
        break;
      case "create-vault":
        next = { ...next, vaults: [...next.vaults, action.name] };
        break;
      case "create-service-account": {
        // Each goes into its repo's environment, which an earlier step of the plan holds, and never to repo level.
        // A step that names a repo is the store's.
        const environment = action.repo === undefined ? next.environment : next.store.environment;
        if (environment === null) break;
        const holding: EnvironmentState = { ...environment, secrets: [...environment.secrets, action.secret] };
        next = action.repo === undefined ? { ...next, environment: holding } : { ...next, store: { ...next.store, environment: holding } };
        break;
      }
      case "delete-repo-secret":
        if (action.repo !== undefined) next = { ...next, store: { ...next.store, secrets: next.store.secrets.filter((name) => name !== action.secret) } };
        else next = { ...next, secrets: next.secrets.filter((name) => name !== action.secret) };
        break;
      case "protect-branch":
        next = { ...next, protection: action.protection };
        break;
      case "restrict-default-branch":
        next = {
          ...next,
          mergeGate: {
            id: action.rulesetId ?? 1,
            enforcement: "active",
            branches: ["~DEFAULT_BRANCH"],
            restrictsUpdates: true,
            bypassActors: ["RepositoryRole:5"],
          },
        };
        break;
      case "create-run-store":
        next = { ...next, store: { ...next.store, exists: true, private: action.private } };
        break;
      case "write-store-file":
        // The first commit to a store with none makes its default branch.
        next = { ...next, store: { ...next.store, defaultBranch: next.store.defaultBranch ?? "main", files: { ...next.store.files, [action.path]: action.content } } };
        break;
    }
  }
  return next;
}
