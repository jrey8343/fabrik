// Product repo states for the setup planner's tests.
import { type ProductState, type SetupPlan } from "../setup/plan.ts";

export function aCleanProduct(overrides: Partial<ProductState> = {}): ProductState {
  return {
    repo: { owner: "acme", name: "clinic", defaultBranch: "main" },
    files: {},
    labels: [],
    secrets: [],
    vaults: [],
    protection: null,
    mergeGate: null,
    ...overrides,
  };
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
        next = { ...next, secrets: [...next.secrets, action.secret] };
        break;
      case "protect-branch":
        next = {
          ...next,
          protection: {
            requiredChecks: action.requiredChecks,
            requiresPullRequest: true,
            bypassAllowances: [],
          },
        };
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
    }
  }
  return next;
}
