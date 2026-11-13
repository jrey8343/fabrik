// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type {
  AuditIssueSnapshot,
  DesignQueueIssue,
  DesignQueueSnapshot,
  DispatchSnapshot,
  IssueSnapshot,
  KitConfig,
  LabelledTrigger,
  NamedPullRequestSnapshot,
  Plan,
  PullRequestSnapshot,
  ResearchDecisionSnapshot,
  RetroIssueSnapshot,
  RolesUnderWay,
  Snapshot,
  TicketSnapshot,
} from "../loop/types.ts";

/**
 * An issue with these labels and this parent; everything else is plain. The
 * adapter fills `parent` and `parentIssue` from the one GitHub parent, so
 * they always agree here too: give either, and the other follows (a parent
 * given by number alone is open, with no labels); give both only as one. A
 * pending prototype request is unanswered too, unless a test says otherwise,
 * as the adapter reads them from the one thread.
 */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  const pending = overrides.pendingPrototype ?? null;
  return {
    number: 1,
    title: "An issue",
    open: true,
    author: "someone",
    byApp: false,
    body: "",
    labels: [],
    openPullRequests: [],
    mergedPullRequests: [],
    openAgentDrafts: [],
    designRounds: 0,
    turnFailed: false,
    firstTurnClaimed: false,
    pendingPrototype: null,
    unansweredPrototypes: pending === null ? [] : [{ request: pending.request, reply: pending.reply }],
    sentBack: null,
    landedNothing: 0,
    keptBranch: null,
    openBlockers: [],
    openBlocking: [],
    ...overrides,
    ...parentOf(overrides),
  };
}

/** An issue's parent, by number and as it stands, from whichever of the two a test gave. */
function parentOf({ parent, parentIssue }: Partial<IssueSnapshot>): Pick<IssueSnapshot, "parent" | "parentIssue"> {
  if (parentIssue === undefined) {
    const number = parent ?? null;
    return { parent: number, parentIssue: number === null ? null : { number, open: true, labels: [] } };
  }
  const number = parentIssue?.number ?? null;
  if (parent !== undefined && parent !== number) {
    throw new Error(`anIssue was given parent ${parent} but parentIssue ${number === null ? "null" : `#${number}`}: give one, or both as the same parent`);
  }
  return { parent: number, parentIssue };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], flakyCheckIssues: [], startingComment: null, reviewHasInlineComments: null, audit: null, retro: null, weeklyIssues: null, replay: null, namedPullRequests: null, rollIns: null, held: null, closedKitIssue: null, closedCarriers: null, weekCarriers: null, openMaps: null, conflicts: null, mergeable: null, triggers: null, readyTickets: null, flakySweep: null, ...overrides };
}

/** The head commit aPullRequest() is at unless a test says otherwise. */
export const HEAD_SHA = "a".repeat(40);

/** A pull request, by default an open agent draft PR the Fabrik App opened for a Ticket, with no Verdicts yet. */
export function aPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 50,
    isAgent: true,
    ticket: 7,
    ticketLabels: [],
    ticketOpen: true,
    ticketLandedNothing: 0,
    open: true,
    draft: true,
    headSha: HEAD_SHA,
    labels: [],
    verdicts: [],
    requestChangesRun: false,
    conflictRun: false,
    conflictAttempts: [],
    conflictRunInFlight: null,
    conflictRunOnUnreviewedDraft: false,
    pushedSinceVerdict: false,
    retryNoteSinceVerdict: null,
    verdictPostedAt: null,
    headPushedAt: null,
    unbuiltChangesRequests: [],
    notedChangesRequests: [],
    requestChangesRunInFlight: null,
    requestChangesRunReviews: [],
    requestChangesRunSince: null,
    orphanedChangesRequests: [],
    requestChangesRunDismissed: false,
    requestChangesRunFailed: false,
    deferredChangesRequests: [],
    leftDraftSinceVerdict: false,
    url: "https://github.com/acme/shop/pull/50",
    uiEvidenceMarker: null,
    changedTests: [],
    digests: [],
    ...overrides,
  };
}

/** A snapshot of this pull request. */
export function snapshotOfPullRequest(
  pullRequest: PullRequestSnapshot,
  overrides: Partial<Pick<Snapshot, "operator" | "kitIssues" | "conflicts" | "mergeable" | "reviewHasInlineComments" | "rollIns">> = {},
): Snapshot {
  return { issue: null, pullRequest, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], flakyCheckIssues: [], startingComment: null, reviewHasInlineComments: null, audit: null, retro: null, weeklyIssues: null, replay: null, namedPullRequests: null, rollIns: null, held: null, closedKitIssue: null, closedCarriers: null, weekCarriers: null, openMaps: null, conflicts: null, mergeable: null, triggers: null, readyTickets: null, flakySweep: null, ...overrides };
}

/** A Ticket Dispatch can release: open, ready-for-agent, unblocked, no sub-issues, no PR open or merged. */
export function aTicket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    number: 1,
    open: true,
    labels: ["enhancement", "ready-for-agent"],
    openBlockers: [],
    notPlannedBlockers: [],
    subIssues: 0,
    openLinkedPullRequests: [],
    mergedLinkedPullRequests: [],
    lastRunFailed: false,
    ...overrides,
  };
}

/** A research Decision Dispatch can release: open, unassigned, unblocked, under the open Map #3, its last run not failed. */
export function aResearchDecision(overrides: Partial<ResearchDecisionSnapshot> = {}): ResearchDecisionSnapshot {
  return {
    number: 1,
    open: true,
    labels: ["wayfinder:research"],
    assignees: [],
    openBlockers: [],
    parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
    lastRunFailed: false,
    ...overrides,
  };
}

/** A Dispatch check's snapshot: these Tickets and, by default, no research Decision and nothing in flight. */
export function dispatchSnapshotOf(
  tickets: readonly TicketSnapshot[],
  inFlight: Partial<Omit<DispatchSnapshot, "tickets">> = {},
): Snapshot {
  return {
    issue: null,
    pullRequest: null,
    dispatch: {
      tickets,
      openAgentDraftPullRequests: [],
      openAgentPullRequestsAtMergeGate: [],
      implementRunsInProgress: 0,
      implementRunTickets: [],
      implementRunsWithoutPullRequest: 0,
      researchDecisions: [],
      researchRunsInProgress: 0,
      ...inFlight,
    },
    designQueue: null,
    spec: null,
    operator: "operator",
    kitIssues: [],
    flakyCheckIssues: [],
    startingComment: null,
    reviewHasInlineComments: null,
    audit: null,
    retro: null,
    weeklyIssues: null,
    replay: null,
    namedPullRequests: null,
    rollIns: null,
    held: null,
    closedKitIssue: null,
    closedCarriers: null,
    weekCarriers: null,
    openMaps: null,
    conflicts: null,
    flakySweep: null,
    mergeable: null,
    triggers: null,
    readyTickets: null,
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
    flakyCheckIssues: [],
    startingComment: null,
    reviewHasInlineComments: null,
    audit: null,
    retro: null,
    weeklyIssues: null,
    replay: null,
    namedPullRequests: null,
    rollIns: null,
    held: null,
    closedKitIssue: null,
    closedCarriers: null,
    weekCarriers: null,
    openMaps: null,
    conflicts: null,
    flakySweep: null,
    mergeable: null,
    triggers: null,
    readyTickets: null,
  };
}

/** A snapshot for an event about the repo as a whole, such as a scheduled tick. */
export function repoSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues" | "audit" | "retro" | "replay" | "held" | "conflicts" | "triggers" | "readyTickets" | "weekCarriers" | "closedCarriers">> = {}): Snapshot {
  return { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec: null, operator: "operator", kitIssues: [], flakyCheckIssues: [], startingComment: null, reviewHasInlineComments: null, audit: null, retro: null, weeklyIssues: null, replay: null, namedPullRequests: null, rollIns: null, held: null, closedKitIssue: null, closedCarriers: null, weekCarriers: null, openMaps: null, conflicts: null, mergeable: null, triggers: null, readyTickets: null, flakySweep: null, ...overrides };
}

/**
 * A scheduled tick's snapshot: the repo's, with the audit and retro slices
 * every tick gathers. By default the repo is unaudited, with its default
 * branch at HEAD_SHA, and has had no Retro, with its store ready but nothing
 * new to read, so the retro gate opens nothing. Its replay slice is the one
 * a tick gathers with no replay issue open, unless a test gives one, and
 * its trigger-sweep slice holds no trigger label, with nothing under way.
 * It reads no open ready-for-agent Ticket.
 */
export function tickSnapshot(overrides: Partial<Pick<Snapshot, "operator" | "kitIssues" | "audit" | "retro" | "replay" | "held" | "conflicts" | "triggers" | "readyTickets" | "weekCarriers" | "closedCarriers">> = {}): Snapshot {
  return repoSnapshot({
    conflicts: { main: HEAD_SHA, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [] },
    audit: { head: HEAD_SHA, issues: [] },
    retro: { storeReady: true, issues: [], agentPullRequestClosed: false, escapeFiled: false },
    replay: { issues: [], capacity: null, acceptance: null },
    held: [],
    triggers: { underWay: NOTHING_UNDER_WAY, labelled: [] },
    readyTickets: [],
    weekCarriers: [],
    closedCarriers: [],
    ...overrides,
  });
}

/** No role's job under way anywhere in the repo. */
export const NOTHING_UNDER_WAY: RolesUnderWay = { implement: false, research: false, review: false, claim: false, designTurns: [], digests: [] };

/** A trigger label on an open issue: by default agent:implement on #7, added an hour before the tick at 04:00, never re-added by the Kit. */
export function aLabelledTrigger(overrides: Partial<LabelledTrigger> = {}): LabelledTrigger {
  return { number: 7, label: "agent:implement", lastAddedAt: "2026-11-09T03:00:00Z", readded: false, ...overrides };
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

/**
 * The window end aRetroIssue() read up to unless a test says otherwise: the
 * Saturday 06:00 UTC tick of the week of 2026-10-26.
 */
export const RETRO_WINDOW_END = "2026-10-31T06:00:00.000Z";

/**
 * A Retro's body in each of its states, with its markers as the Fabrik App
 * writes them (#151): pending on its run, filled with its proposals, or failed.
 */
export function retroBody(windowEnd: string, state: "pending" | "filled" | "failed" = "filled"): string {
  switch (state) {
    case "pending":
      return `The Retro is reading the factory's runs, and this issue fills in when it's done.\n\n<!-- fabrik:retro ${windowEnd} -->\n<!-- fabrik:retro-pending -->`;
    case "filled":
      return `The Retro read the factory's runs.\n\n## Check the cart totals with a test, not a reminder\n\n<!-- fabrik:retro ${windowEnd} -->`;
    case "failed":
      return `The Retro's run failed: it timed out.\n\n<!-- fabrik:retro ${windowEnd} -->\n<!-- fabrik:retro-failed -->`;
  }
}

/** A `fabrik:retro` issue the Fabrik App opened: by default last week's, filled up to RETRO_WINDOW_END, and closed by the Operator. */
export function aRetroIssue(overrides: Partial<RetroIssueSnapshot> = {}): RetroIssueSnapshot {
  return {
    number: 80,
    title: "Retro: week of 2026-10-26",
    open: false,
    stateReason: "completed",
    createdAt: "2026-10-31T06:00:04Z",
    byApp: true,
    body: retroBody(RETRO_WINDOW_END),
    ...overrides,
  };
}

/** A PR an Auditor named: by default a merged agent PR. */
export function aNamedPullRequest(overrides: Partial<NamedPullRequestSnapshot> = {}): NamedPullRequestSnapshot {
  return { number: 31, open: false, merged: true, headRef: "fabrik/ticket-7", isAgent: true, ...overrides };
}

/** An Audit run's snapshot: by default the App's pending Audit #97 at AUDITED_SHA, and the PRs its Auditor named. */
export function auditRunSnapshotOf(
  namedPullRequests: readonly NamedPullRequestSnapshot[] = [],
  audit: Partial<IssueSnapshot> = {},
): Snapshot {
  const issue = anIssue({ number: 97, byApp: true, labels: ["fabrik:audit"], body: auditBody(AUDITED_SHA, "pending"), ...audit });
  return snapshotOf(issue, { namedPullRequests });
}

/** A Retro run's snapshot: by default the App's pending Retro #120, its window ending at RETRO_WINDOW_END. */
export function retroRunSnapshotOf(retro: Partial<IssueSnapshot> = {}): Snapshot {
  return snapshotOf(anIssue({ number: 120, byApp: true, labels: ["fabrik:retro"], body: retroBody(RETRO_WINDOW_END, "pending"), ...retro }));
}

/**
 * A scheduled tick's plan without its notes, which say why each part of the
 * tick did nothing, for a test about what the tick does.
 */
export function withoutNotes(plan: Plan): Plan {
  if (plan.kind !== "act") return plan;
  const { notes: _notes, ...acting } = plan;
  return acting;
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
      case "append-to-decisions-so-far": {
        const text = action.line.map((part) => (typeof part === "string" ? part : "https://github.com/x")).join("");
        return mention.test(text) ? [`mention in the Map #${action.issue}`] : [];
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
