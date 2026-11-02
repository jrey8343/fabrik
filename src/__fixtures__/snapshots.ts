// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type {
  DispatchSnapshot,
  IssueSnapshot,
  KitConfig,
  PullRequestSnapshot,
  Snapshot,
  TicketSnapshot,
} from "../loop/types.ts";

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
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, pullRequest: null, dispatch: null, operator: "operator", ...overrides };
}

/** A pull request, by default one the Fabrik App opened for a Ticket. */
export function aPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return { number: 50, isAgent: true, ...overrides };
}

/** A snapshot of this pull request. */
export function snapshotOfPullRequest(pullRequest: PullRequestSnapshot): Snapshot {
  return { issue: null, pullRequest, dispatch: null, operator: "operator" };
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
  };
}

/** A Kit config with every v1 default, as a Product repo with no .fabrik/config.json gets. */
export function kitConfig(overrides: Partial<KitConfig> = {}): KitConfig {
  return { ...DEFAULT_KIT_CONFIG, ...overrides };
}
