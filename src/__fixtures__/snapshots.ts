// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type {
  DesignQueueIssue,
  DesignQueueSnapshot,
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
    sentBack: null,
    emptyDiffs: 0,
    openBlockers: [],
    openBlocking: [],
    ...overrides,
  };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, ...overrides };
}

/** The head commit aPullRequest() is at unless a test says otherwise. */
export const HEAD_SHA = "a".repeat(40);

/** A pull request, by default an open agent draft PR the Fabrik App opened for a Ticket, with no Verdicts yet. */
export function aPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 50,
    isAgent: true,
    ticket: 7,
    open: true,
    draft: true,
    headSha: HEAD_SHA,
    labels: [],
    verdicts: [],
    requestChangesRun: false,
    pushedSinceVerdict: false,
    changesRequested: null,
    ...overrides,
  };
}

/** A snapshot of this pull request. */
export function snapshotOfPullRequest(
  pullRequest: PullRequestSnapshot,
  overrides: Partial<Pick<Snapshot, "operator" | "kitIssues">> = {},
): Snapshot {
  return { issue: null, pullRequest, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, ...overrides };
}

/** A Ticket Dispatch can release: open, ready-for-agent, unblocked, no sub-issues, no PR. */
export function aTicket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    number: 1,
    open: true,
    labels: ["enhancement", "ready-for-agent"],
    openBlockers: [],
    notPlannedBlockers: [],
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
    designQueue: null,
    spec: null,
    operator: "operator",
    kitIssues: [],
    startingComment: null,
  };
}

/** An open needs-design issue that holds no Design session slot (no round, no turn failed, no agent:design) and is no re-design. */
export function aDesignQueueIssue(overrides: Partial<DesignQueueIssue> = {}): DesignQueueIssue {
  return {
    number: 1,
    labels: ["enhancement", "needs-design"],
    designRounds: 0,
    turnFailed: false,
    redesign: false,
    neededDesignAt: "2026-11-01T09:00:00Z",
    ...overrides,
  };
}

/** A Design queue check's snapshot: these needs-design issues and, by default, no Design turn in progress. */
export function designQueueSnapshotOf(
  issues: readonly DesignQueueIssue[],
  inProgress: Partial<Omit<DesignQueueSnapshot, "issues">> = {},
): Snapshot {
  return {
    issue: null,
    pullRequest: null,
    dispatch: null,
    designQueue: { issues, designTurnsInProgress: [], ...inProgress },
    spec: null,
    operator: "operator",
    kitIssues: [],
    startingComment: null,
  };
}

/** A snapshot for an event about the repo as a whole, such as a scheduled tick. */
export function repoSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues">> = {}): Snapshot {
  return { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, ...overrides };
}

/**
 * Every way a plan would buzz the Operator's phone: an assignment, a review request, an issue
 * opened or created assigned to them, or an @-mention of them in a comment or new issue.
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
      case "comment-linking": {
        const text = action.body.map((part) => (typeof part === "string" ? part : "https://github.com/x")).join("");
        return mention.test(text) ? [`mention on #${action.issue}`] : [];
      }
      case "create-issue":
        return action.assignees?.includes(operator) ? [`assign new "${action.title}"`] : [];
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

/**
 * The Verdict records these comments' first lines carry, as the marker's JSON
 * says them (README: "Posting"). The core's tests read a plan's Verdicts with
 * this rather than through the adapter's reader (src/github/threads.ts).
 */
export function verdictsPostedIn(commentBodies: readonly string[]): unknown[] {
  return commentBodies.flatMap((body) => {
    const json = /^<!-- fabrik:verdict (\{.*?\}) -->\n/.exec(body)?.[1];
    return json === undefined ? [] : [JSON.parse(json) as unknown];
  });
}

/** A Kit config with every v1 default, as a Product repo with no .fabrik/config.json gets. */
export function kitConfig(overrides: Partial<KitConfig> = {}): KitConfig {
  return { ...DEFAULT_KIT_CONFIG, ...overrides };
}
