// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type {
  AuditIssueSnapshot,
  DesignQueueIssue,
  DesignQueueSnapshot,
  DispatchSnapshot,
  IssueSnapshot,
  KitConfig,
  NamedPullRequestSnapshot,
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
    byApp: false,
    body: "",
    labels: [],
    parent: null,
    openPullRequests: [],
    designRounds: 0,
    turnFailed: false,
    firstTurnClaimed: false,
    sentBack: null,
    emptyDiffs: 0,
    openBlockers: [],
    openBlocking: [],
    ...overrides,
  };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, audit: null, namedPullRequests: null, held: null, ...overrides };
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
    uiEvidence: null,
    ...overrides,
  };
}

/** A snapshot of this pull request. */
export function snapshotOfPullRequest(
  pullRequest: PullRequestSnapshot,
  overrides: Partial<Pick<Snapshot, "operator" | "kitIssues">> = {},
): Snapshot {
  return { issue: null, pullRequest, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, audit: null, namedPullRequests: null, held: null, ...overrides };
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
    audit: null,
    namedPullRequests: null,
    held: null,
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
    audit: null,
    namedPullRequests: null,
    held: null,
  };
}

/** A snapshot for an event about the repo as a whole, such as a scheduled tick. */
export function repoSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues" | "audit" | "held">> = {}): Snapshot {
  return { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], startingComment: null, audit: null, namedPullRequests: null, held: null, ...overrides };
}

/**
 * A scheduled tick's snapshot: the repo's, with the audit slice every tick
 * gathers, by default an unaudited repo whose default branch is at HEAD_SHA.
 */
export function tickSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues" | "audit" | "held">> = {}): Snapshot {
  return repoSnapshot({ audit: { head: HEAD_SHA, issues: [] }, held: [], ...overrides });
}

/** The commit anAuditIssue() audited unless a test says otherwise. */
export const AUDITED_SHA = "b".repeat(40);

/**
 * An Audit's body in each of its states, with its markers as the Fabrik App
 * writes them (#150): pending on its run, filled with its candidates (or
 * clean), or failed.
 */
export function auditBody(sha: string, state: "pending" | "filled" | "failed" = "filled"): string {
  switch (state) {
    case "pending":
      return `The Auditor is reading the default branch up to \`${sha.slice(0, 7)}\`, and this issue fills in when it's done.\n\n<!-- fabrik:audit ${sha} -->\n<!-- fabrik:audit-pending -->`;
    case "filled":
      return `The Auditor read the default branch up to \`${sha.slice(0, 7)}\`.\n\n## Make the cart module deeper\n\n<!-- fabrik:audit ${sha} -->`;
    case "failed":
      return `The Auditor's run failed: it timed out.\n\n<!-- fabrik:audit ${sha} -->\n<!-- fabrik:audit-failed -->`;
  }
}

/** A `fabrik:audit` issue the Fabrik App opened: by default last week's, filled at AUDITED_SHA, and closed by the Operator. */
export function anAuditIssue(overrides: Partial<AuditIssueSnapshot> = {}): AuditIssueSnapshot {
  return {
    number: 90,
    title: "Audit: week of 2026-10-26",
    open: false,
    stateReason: "completed",
    createdAt: "2026-11-01T00:05:00Z",
    byApp: true,
    body: auditBody(AUDITED_SHA),
    ...overrides,
  };
}

/** A PR an Auditor named: by default a merged agent PR. */
export function aNamedPullRequest(overrides: Partial<NamedPullRequestSnapshot> = {}): NamedPullRequestSnapshot {
  return { number: 31, merged: true, headRef: "fabrik/ticket-7", isAgent: true, ...overrides };
}

/** An Audit run's snapshot: by default the App's pending Audit #97 at AUDITED_SHA, and the PRs its Auditor named. */
export function auditRunSnapshotOf(
  namedPullRequests: readonly NamedPullRequestSnapshot[] = [],
  audit: Partial<IssueSnapshot> = {},
): Snapshot {
  const issue = anIssue({ number: 97, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending"), ...audit });
  return snapshotOf(issue, { namedPullRequests });
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
