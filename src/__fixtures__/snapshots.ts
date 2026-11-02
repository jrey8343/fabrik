// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type {
  DispatchSnapshot,
  IssueSnapshot,
  KitConfig,
  Plan,
  PullRequestSnapshot,
  Snapshot,
  TicketSnapshot,
} from "../loop/types.ts";

/** An issue with these labels and this parent; everything else is plain. */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    open: true,
    author: "someone",
    labels: [],
    parent: null,
    openPullRequests: [],
    designRounds: 0,
    emptyDiffs: 0,
    ...overrides,
  };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, pullRequest: null, dispatch: null, operator: "operator", kitIssues: [], ...overrides };
}

/** The head commit aPullRequest() is at unless a test says otherwise. */
export const HEAD_SHA = "a".repeat(40);

/** A pull request, by default an open agent draft PR the Fabrik App opened for a Ticket, with no Verdicts yet. */
export function aPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 50,
    isAgent: true,
    open: true,
    draft: true,
    headSha: HEAD_SHA,
    labels: [],
    verdicts: [],
    requestChangesRun: false,
    ...overrides,
  };
}

/** A snapshot of this pull request. */
export function snapshotOfPullRequest(
  pullRequest: PullRequestSnapshot,
  overrides: Partial<Pick<Snapshot, "operator" | "kitIssues">> = {},
): Snapshot {
  return { issue: null, pullRequest, dispatch: null, operator: "operator", kitIssues: [], ...overrides };
}

/** A Ticket Dispatch can release: open, ready-for-agent, unblocked, no sub-issues, no PR. */
export function aTicket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    number: 1,
    open: true,
    labels: ["enhancement", "ready-for-agent"],
    openBlockers: [],
    subIssues: 0,
    openLinkedPullRequests: [],
    ...overrides,
  };
}

/** A Dispatch check's snapshot: these Tickets and, by default, nothing in flight. */
export function dispatchSnapshotOf(
  tickets: readonly TicketSnapshot[],
  inFlight: Partial<Omit<DispatchSnapshot, "tickets">> = {},
): Snapshot {
  return {
    issue: null,
    pullRequest: null,
    dispatch: { tickets, openAgentDraftPullRequests: 0, implementRunsInProgress: 0, ...inFlight },
    operator: "operator",
    kitIssues: [],
  };
}

/** A snapshot for an event about the repo as a whole, such as a scheduled tick. */
export function repoSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues">> = {}): Snapshot {
  return { issue: null, pullRequest: null, dispatch: null, operator: "operator", kitIssues: [], ...overrides };
}

/**
 * Every way a plan would buzz the Operator's phone: an assignment, a review request, an issue
 * opened assigned to them, or an @-mention of them in a comment or new issue.
 */
export function notificationsOf(plan: Plan, operator = "operator"): string[] {
  if (plan.kind !== "act") return [];
  const mention = new RegExp(`@${operator}\\b`);
  return plan.actions.flatMap((action) => {
    switch (action.kind) {
      case "assign":
        return action.assignee === operator ? [`assign #${action.issue}`] : [];
      case "request-review":
        return action.reviewer === operator ? [`review request on #${action.pullRequest}`] : [];
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
export function kitConfig(overrides: Partial<KitConfig> = {}): KitConfig {
  return { ...DEFAULT_KIT_CONFIG, ...overrides };
}
