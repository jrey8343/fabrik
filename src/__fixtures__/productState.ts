// Product repo states for the setup planner's tests.
import { type BranchProtection, type ProductState, type RunStoreState, type SetupPlan, UNPROTECTED } from "../setup/plan.ts";

export function aCleanProduct(overrides: Partial<ProductState> = {}): ProductState {
  return {
    repo: { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false },
    files: {},
    labels: [],
    secrets: [],
    vaults: [],
    fabrikItems: [],
    protection: null,
    mergeGate: null,
    store: noStore(),
    readyForAgent: 0,
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
  return { exists: false, private: false, files: {}, secrets: [] };
}

/** The state a repo is left in once every action in the plan has been applied to it. */
export function afterApplying(state: ProductState, plan: SetupPlan): ProductState {
  let next = state;
  for (const action of plan.actions) {
    switch (action.kind) {
      case "write-file":
        next = { ...next, files: { ...next.files, [action.path]: action.content } };
        break;
      case "create-label":
        next = { ...next, labels: [...next.labels, action.name] };
        break;
      case "create-vault":
        next = { ...next, vaults: [...next.vaults, action.name] };
        break;
      case "create-service-account":
        next =
          action.repo === undefined
            ? { ...next, secrets: [...next.secrets, action.secret] }
            : { ...next, store: { ...next.store, secrets: [...next.store.secrets, action.secret] } };
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
        next = { ...next, store: { ...next.store, files: { ...next.store.files, [action.path]: action.content } } };
        break;
    }
  }
  return next;
}
