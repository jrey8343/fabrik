// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { IssueEventSnapshot, IssueSnapshot, KitConfig, Plan, Snapshot } from "../loop/types.ts";

/** An issue with these labels and this parent; everything else is plain. */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    author: "someone",
    labels: [],
    parent: null,
    openPullRequests: [],
    ...overrides,
  };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(
  issue: IssueSnapshot,
  overrides: Partial<Omit<Snapshot, "issue">> = {},
): IssueEventSnapshot {
  return { issue, operator: "operator", kitIssues: [], ...overrides };
}

/** A snapshot for an event about no one issue, such as a scheduled tick. */
export function repoSnapshot(overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue: null, operator: "operator", kitIssues: [], ...overrides };
}

/**
 * Every way a plan would buzz the Operator's phone: an assignment, an issue
 * opened assigned to them, or an @-mention of them in a comment or new issue.
 */
export function notificationsOf(plan: Plan, operator = "operator"): string[] {
  if (plan.kind !== "act") return [];
  const mention = new RegExp(`@${operator}\\b`);
  return plan.actions.flatMap((action) => {
    switch (action.kind) {
      case "assign":
        return action.assignee === operator ? [`assign #${action.issue}`] : [];
      case "comment":
        return mention.test(action.body) ? [`mention on #${action.issue}`] : [];
      case "open-issue":
        return [
          ...(action.assignees.includes(operator) ? [`assign new "${action.title}"`] : []),
          ...(mention.test(action.body) ? [`mention in new "${action.title}"`] : []),
        ];
      default:
        return [];
    }
  });
}

/** A Kit config with every v1 default, as a Product repo with no .fabrik/config.json gets. */
export function kitConfig(): KitConfig {
  return DEFAULT_KIT_CONFIG;
}
