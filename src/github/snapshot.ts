// The adapter's snapshot side: reads the current GitHub state a Loop event
// needs, fresh rather than from the event payload, into the snapshot the core
// decides on. It holds no Loop rules; those all live in src/loop/rules.ts.
import { evidenceMarkerIn } from "../evidence/uiEvidence.ts";
import { changedTestsIn } from "../loop/changedTests.ts";
import {
  INSTRUCTED_ROLES,
  instructionsPath,
  KIT_CONFIG_PATH,
  type KitConfigSources,
  SKILLS_SOURCES_LOCK_PATH,
} from "../kit/config.ts";
import type { ActionsStep } from "../kit/kitSaid.ts";
import { isOperatorsReplay } from "../kit/replay.ts";
import { newestWeeklyLimits } from "../kit/replayFacts.ts";
import { storeIsPrivate } from "../kit/runStore.ts";
import { agentBranchFor, isAgentPullRequest, ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { agentPullRequestsByGate } from "../loop/dispatch.ts";
import { parseAuditOutput } from "../loop/auditOutput.ts";
import { parseDesignTurnOutput } from "../loop/designOutput.ts";
import { digestMarkIn } from "../loop/digestContract.ts";
import { heldRunsIn, isCarrier } from "../loop/heldRun.ts";
import { makesUnusable } from "../loop/subscriptions.ts";
import {
  AUDIT_LABEL,
  DESIGN_LABEL,
  KEPT_BRANCH_LABEL,
  FLAKY_CHECK_LABEL,
  KIT_ISSUE_LABELS,
  MAP_LABEL,
  NEEDS_DESIGN,
  READY_FOR_AGENT,
  REPLAY_LABEL,
  REPLAY_TRIGGER_LABEL,
  RESEARCH_DECISION_LABEL,
  RETRO_LABEL,
  TOKEN_ROTATION_LABEL,
  TRIGGER_LABELS,
  USAGE_CREDITS_LABEL,
  WEEKLY_LIMIT_LABEL,
} from "../loop/labels.ts";
import { escapeMarkerIn } from "../loop/markers.ts";
import { retroWindowStart } from "../loop/retro.ts";
import { weekStart } from "../loop/weeklyGate.ts";
import { MAX_RETRIES } from "../loop/retry.ts";
import type {
  AgentRole,
  AuditSnapshot,
  ConflictCandidate,
  ConflictSnapshot,
  FlawHeadChecks,
  DesignQueueIssue,
  DesignQueueSnapshot,
  DispatchSnapshot,
  HeldTargetSnapshot,
  KeptBranch,
  KitIssueSnapshot,
  LabelledTrigger,
  LoopEvent,
  MergeableSnapshot,
  NamedPullRequestSnapshot,
  ParentIssueSnapshot,
  PullRequestSnapshot,
  ReplayIssueSnapshot,
  ReplaySnapshot,
  ResearchDecisionSnapshot,
  RetroSnapshot,
  RolesUnderWay,
  RollInsSnapshot,
  Snapshot,
  SpecSnapshot,
  StartingComment,
  TicketSnapshot,
  TriggerSweepSnapshot,
  WeeklyIssueSnapshot,
} from "../loop/types.ts";
import { uncountedFlaws } from "../loop/flakyChecks.ts";
import { allPages, GitHubError, pagesOf, type ReadClient, type Repo, refusalOf } from "./client.ts";
import { gatherReplayAcceptance, type ReplayStore } from "./replaySlice.ts";
import {
  countLandedNothing,
  designSessionOf,
  designTurnFailedIn,
  pendingPrototypeIn,
  unansweredPrototypesIn,
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  landedPushNotes,
  type OnBranch,
  conflictRunOnUnreviewedDraftIn,
  isKitPushNote,
  type PullRequestHistoryItem,
  pushedSinceVerdictIn,
  retryNoteSinceVerdictIn,
  verdictPostedAtIn,
  requestChangesRunIn,
  requestChangesSinceRunIn,
  leftDraftSinceVerdictIn,
  implementRunFailedIn,
  researchRunFailedIn,
  lastAddedAtIn,
  stuckTriggerGaveUpIn,
  stuckTriggerReaddedIn,
  type TriggerHistoryEntry,
  verdictsIn,
} from "./threads.ts";
import { leavingOutHeldLines } from "./heldLines.ts";
import { operatorsRequestChangesIn, type WrittenReview } from "./writtenOn.ts";

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issue(number: $number) {
        number
        title
        state
        author { login __typename }
        body
        labels(first: 100) { nodes { name } }
        parent { number state labels(first: 100) { nodes { name } } }
        comments(last: 100) { nodes { fullDatabaseId body createdAt author { login __typename } } }
        timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], last: 100) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } }
            ... on UnlabeledEvent { createdAt label { name } actor { __typename } }
          }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number state isDraft headRefName author { __typename } } }
        blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
        blocking(first: 50) { nodes { number state repository { nameWithOwner } } }
      }
    }
  }
`;

interface IssueQueryResult {
  repository: {
    owner: { login: string };
    issue: {
      number: number;
      title: string;
      state: "OPEN" | "CLOSED";
      author: { login: string; __typename: string } | null;
      body: string;
      labels: { nodes: { name: string }[] };
      parent: ParentNode | null;
      // A comment's id is a BigInt in GraphQL, which comes back as a string: the REST id the Kit's own comments link to.
      comments: { nodes: { fullDatabaseId: string; body: string; createdAt: string; author: { login: string; __typename: string } | null }[] };
      // Only Labeled and UnlabeledEvents are asked for, but the union's other members come back empty.
      timelineItems: { nodes: LabelTimelineItem[] };
      // includeClosedPrs: false leaves out only PRs closed unmerged: a merged one still comes back (#543).
      closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; headRefName: string; author: { __typename: string } | null }[] };
      blockedBy: DependencyEdges;
      blocking: DependencyEdges;
    } | null;
  };
}

/** A sub-issue's parent, as a query reads it with `parent { number state labels(first: 100) { nodes { name } } }`. */
interface ParentNode {
  number: number;
  state: "OPEN" | "CLOSED";
  labels: { nodes: { name: string }[] };
}

function parentIssueOf(parent: ParentNode | null): ParentIssueSnapshot | null {
  if (parent === null) return null;
  return { number: parent.number, open: parent.state === "OPEN", labels: parent.labels.nodes.map((label) => label.name) };
}

/** One direction of an issue's native dependencies, as the issue query reads it. */
interface DependencyEdges {
  nodes: { number: number; state: "OPEN" | "CLOSED"; repository: { nameWithOwner: string } }[];
}

/**
 * The open issues at the other end of these edges, by number, that live in
 * this repo. An issue in another repo is left out: its number means nothing here.
 */
function openIssueNumbersIn(repo: Repo, edges: DependencyEdges): number[] {
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  return edges.nodes
    .filter((issue) => issue.state === "OPEN" && issue.repository.nameWithOwner.toLowerCase() === here)
    .map((issue) => issue.number);
}

/**
 * What the snapshot reads of each comment on a PR, the latest 100 and each
 * earlier page alike: with its node id and whether it is minimized, which
 * collapsing an older Digest as outdated goes by (ADR-0022).
 */
const PULL_REQUEST_COMMENTS = "pageInfo { hasPreviousPage startCursor } nodes { id isMinimized body createdAt author { __typename } }";

/** What the snapshot reads of a PR, by itself or as one of the open agent PRs the conflict check weighs. */
const PULL_REQUEST_FIELDS = `
        number
        url
        state
        isDraft
        headRefName
        headRefOid
        author { login __typename }
        body
        labels(first: 100) { nodes { name } }
        comments(last: 100) { ${PULL_REQUEST_COMMENTS} }
        changesRequests: reviews(last: 50, states: [CHANGES_REQUESTED]) { nodes { databaseId submittedAt author { login __typename } } }
        draftEvents: timelineItems(last: 100, itemTypes: [CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { __typename ... on ConvertToDraftEvent { createdAt } ... on ReadyForReviewEvent { createdAt } }
        }
        createdAt
        forcePushes: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt } } }
        commits(last: 100) { pageInfo { hasPreviousPage } nodes { commit { oid committedDate } } }
        closingIssuesReferences(first: 10) { nodes { number state labels(first: 100) { nodes { name } } comments(last: 100) { nodes { body author { login __typename } } } } }`;

const PULL_REQUEST_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      pullRequest(number: $number) {${PULL_REQUEST_FIELDS}
      }
    }
  }
`;

interface PullRequestComments {
  pageInfo: { hasPreviousPage: boolean; startCursor?: string | null };
  nodes: { id: string; isMinimized: boolean; body: string; createdAt: string; author: { __typename: string } | null }[];
}

const DEFAULT_BRANCH_QUERY = `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name target { oid } }
    }
  }
`;

/** The default branch's name and its head, a full sha, or null when it has none. */
export async function defaultBranchOf(github: Pick<ReadClient, "graphql">, repo: Repo): Promise<{ readonly name: string; readonly head: string } | null> {
  const data = await github.graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string } } | null } }>(DEFAULT_BRANCH_QUERY, {
    owner: repo.owner,
    name: repo.name,
  });
  const ref = data.repository.defaultBranchRef;
  return ref === null ? null : { name: ref.name, head: ref.target.oid };
}

/** A PR's comments before the ones already read, a page at a time, newest page first. */
const PULL_REQUEST_EARLIER_COMMENTS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $before: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(last: 100, before: $before) { ${PULL_REQUEST_COMMENTS} }
      }
    }
  }
`;

/**
 * How many pages of a PR's earlier comments the snapshot reads at most, 100
 * to a page, beyond the latest 100. Past that, a review from before the
 * oldest comment read is left out, as historyOf says.
 */
const EARLIER_COMMENT_PAGES = 9;

/**
 * The PR with its earlier comments read too, so what started or settled its
 * Request changes (#341), and its Verdicts, are read however long its thread
 * has grown.
 */
async function withEarlierComments<Node extends { number: number; comments: PullRequestComments }>(
  github: Pick<ReadClient, "graphql">,
  repo: Repo,
  pullRequest: Node,
): Promise<Node> {
  let { pageInfo, nodes } = pullRequest.comments;
  for (let page = 0; page < EARLIER_COMMENT_PAGES && pageInfo.hasPreviousPage && typeof pageInfo.startCursor === "string"; page += 1) {
    const data = await github.graphql<{ repository: { pullRequest: { comments: PullRequestComments } | null } }>(
      PULL_REQUEST_EARLIER_COMMENTS_QUERY,
      { owner: repo.owner, name: repo.name, number: pullRequest.number, before: pageInfo.startCursor },
    );
    const earlier = data.repository.pullRequest?.comments;
    if (earlier === undefined) break;
    nodes = [...earlier.nodes, ...nodes];
    pageInfo = earlier.pageInfo;
  }
  return { ...pullRequest, comments: { pageInfo, nodes } };
}

interface PullRequestQueryResult {
  repository: {
    owner: { login: string };
    pullRequest: {
      number: number;
      url: string;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft: boolean;
      headRefName: string;
      headRefOid: string;
      author: { login: string; __typename: string } | null;
      body: string;
      labels: { nodes: { name: string }[] };
      comments: PullRequestComments;
      changesRequests: {
        nodes: { databaseId: number; submittedAt: string | null; author: { login: string; __typename: string } | null }[];
      };
      draftEvents: { pageInfo: { hasPreviousPage: boolean }; nodes: { __typename: string; createdAt?: string }[] };
      createdAt: string;
      forcePushes: { nodes: { createdAt: string }[] };
      /** Its branch's latest commits, oldest first: the head last. */
      commits: { pageInfo: { hasPreviousPage: boolean }; nodes: { commit: { oid: string; committedDate: string } }[] };
      closingIssuesReferences: { nodes: { number: number; state: "OPEN" | "CLOSED"; labels: { nodes: { name: string }[] }; comments: { nodes: { body: string; author: { login: string; __typename: string } | null }[] } }[] };
    } | null;
  };
}

// Pages through every open ready-for-agent issue. Open PRs are read once: a
// Product repo with more than 100 open PRs is far past max_in_flight anyway.
const DISPATCH_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $ready: String!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: [$ready], first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          state
          labels(first: 100) { nodes { name } }
          subIssues { totalCount }
          blockedBy(first: 50) { nodes { number state stateReason } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: false) { nodes { number state } }
          comments(last: 100) { nodes { body author { login __typename } } }
        }
      }
      pullRequests(states: OPEN, first: 100) {
        nodes { number isDraft headRefName author { __typename } }
      }
    }
  }
`;

interface DispatchQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        state: "OPEN" | "CLOSED";
        labels: { nodes: { name: string }[] };
        subIssues: { totalCount: number };
        blockedBy: { nodes: { number: number; state: "OPEN" | "CLOSED"; stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null }[] };
        closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
        comments: { nodes: { body: string; author: { login: string; __typename: string } | null }[] };
      }[];
    };
    pullRequests: { nodes: { number: number; isDraft: boolean; headRefName: string; author: { __typename: string } | null }[] };
  };
}

// Pages through every open wayfinder:research issue, with its parent, which
// the core checks is an open Map, and the thread its last run's word is in.
const RESEARCH_DECISIONS_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $research: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$research], first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          state
          labels(first: 100) { nodes { name } }
          assignees(first: 10) { nodes { login } }
          blockedBy(first: 50) { nodes { number state } }
          parent { number state labels(first: 100) { nodes { name } } }
          comments(last: 100) { nodes { body author { login __typename } } }
        }
      }
    }
  }
`;

interface ResearchDecisionsQueryResult {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        state: "OPEN" | "CLOSED";
        labels: { nodes: { name: string }[] };
        assignees: { nodes: { login: string }[] };
        blockedBy: { nodes: { number: number; state: "OPEN" | "CLOSED" }[] };
        parent: ParentNode | null;
        comments: { nodes: { body: string; author: { login: string; __typename: string } | null }[] };
      }[];
    };
  };
}

// Pages through every open needs-design issue, with the thread and label
// timeline that say whether it holds a Design session slot and how long it has waited.
const DESIGN_QUEUE_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $needsDesign: String!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: [$needsDesign], first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          createdAt
          labels(first: 100) { nodes { name } }
          comments(last: 100) { nodes { body createdAt author { login __typename } } }
          timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], last: 100) {
            nodes {
              __typename
              ... on LabeledEvent { createdAt label { name } }
              ... on UnlabeledEvent { createdAt label { name } actor { __typename } }
            }
          }
        }
      }
    }
  }
`;

/** A label coming on or off an issue, oldest first, as ISSUE_QUERY and DESIGN_QUEUE_QUERY read it. */
interface LabelTimelineItem {
  __typename?: string;
  createdAt?: string;
  label?: { name: string };
  actor?: { __typename: string } | null;
}

interface DesignQueueQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        createdAt: string;
        labels: { nodes: { name: string }[] };
        comments: { nodes: { body: string; createdAt: string; author: { login: string; __typename: string } | null }[] };
        // Only Labeled and UnlabeledEvents are asked for, but the union's other members come back empty.
        timelineItems: { nodes: LabelTimelineItem[] };
      }[];
    };
  };
}

/**
 * The name of the Implement job in .github/workflows/loop.yml, which follows
 * it with ` #<Ticket>`, and a retry's with ` (Retry <n>)` too (#477; a test
 * holds the two together). Called from a Product repo's caller workflow, it
 * shows up as `<caller job> / Implement #12 (Retry 1)`.
 */
export const IMPLEMENT_JOB_NAME = "Implement";

/**
 * The name of the Research job in .github/workflows/loop.yml (a test holds
 * the two together), which Dispatch counts Research runs by as it counts
 * Implement runs by IMPLEMENT_JOB_NAME. Called from a Product repo's caller
 * workflow, it shows up as `<caller job> / Research`.
 */
export const RESEARCH_JOB_NAME = "Research";

/**
 * The name of the push job in .github/workflows/loop.yml (a test holds the
 * two together). An Implement job is under way until its run's push job has
 * landed it (#432). Called from a Product repo's caller workflow, it shows up
 * as `<caller job> / Push`.
 */
export const PUSH_JOB_NAME = "Push";

/**
 * The names of the claim job and the two Review jobs in
 * .github/workflows/loop.yml (a test holds them together), which the
 * stuck-trigger sweep reads a run behind a trigger label by (#419). The
 * Review job follows its name with ` PR #<agent PR>` (#477). Called from a
 * Product repo's caller workflow, each shows up as `<caller job> / <name>`.
 */
export const CLAIM_JOB_NAME = "Claim the work";
export const REVIEW_CHECKS_JOB_NAME = "Review checks";
export const REVIEW_JOB_NAME = "Review";

/**
 * The name of the Digest job in .github/workflows/loop.yml, which follows it
 * with ` PR #<agent PR>`, as the Review job does (a test holds the two
 * together). Called from a Product repo's caller workflow, it shows up as
 * `<caller job> / Digest PR #50`.
 */
export const DIGEST_JOB_NAME = "Digest";

/**
 * The name of the Design job in .github/workflows/loop.yml, which follows it
 * with ` #<issue>` (a test holds the two together). Called from a Product
 * repo's caller workflow, it shows up as `<caller job> / Design-session turn #7`.
 */
export const DESIGN_JOB_NAME = "Design-session turn";

/**
 * The name of the prototype job in .github/workflows/loop.yml, which runs a
 * Design session's prototype turn in the Design job's place, followed by
 * ` #<issue>` too (a test holds the two together). A prototype turn is a turn
 * of its session, so it holds the session's slot as a Design job does (#155).
 */
export const PROTOTYPE_JOB_NAME = "Prototype turn";

/**
 * The names of the jobs in .github/workflows/loop.yml that carry no number (a
 * test holds them together), which the runs in flight are read by (#606): a
 * Triage, Audit or Retro job, and a Review's re-run of its red checks and its
 * wait for them. Called from a Product repo's caller workflow, each shows up
 * as `<caller job> / <name>`.
 */
export const TRIAGE_JOB_NAME = "Triage";
export const AUDIT_JOB_NAME = "Audit";
export const RETRO_JOB_NAME = "Retro";
export const RERUN_CHECKS_JOB_NAME = "Re-run red checks";
export const RERUN_WAIT_JOB_NAME = "Re-run checks' wait";

/**
 * The name of the Kit job in .github/workflows/loop.yml (a test holds the two
 * together), whose closing step's name says what it routed (#616). Called
 * from a Product repo's caller workflow, it shows up as `<caller job> / Kit`.
 */
export const KIT_JOB_NAME = "Kit";

/**
 * The names of a Replay's jobs in .github/workflows/loop.yml (a test holds
 * them together): each of its Arms' jobs, followed by ` (<arm>)`, and the job
 * that records it, which a Replay's run is in flight until (#617).
 */
export const REPLAY_ARM_JOB_NAMES = ["Replay implement", "Replay gates", "Replay review", "Replay score"] as const;
export const REPLAY_RECORD_JOB_NAME = "Replay record";

/**
 * Reads the current GitHub state the event needs, fresh rather than from the
 * event payload. The Operator is the Kit config's `operator`, or else the
 * repo's owner. `appLogin` is the Fabrik App's bot login, its slug with
 * `[bot]`, which tells the App's issues apart from any other bot's; null when
 * the run doesn't know it, as the Kit job, which only routes, doesn't, so any
 * bot's issue is taken for the App's (see byAppOf). A
 * Dispatch check also reads workflow runs, through `actions`, and so do a
 * conflict check when it's given them (#387), and the scheduled tick's
 * stuck-trigger sweep (#419): the Fabrik App has no Actions
 * permission (ADR-0002), so that is the job's own read-only GITHUB_TOKEN. A
 * scheduled tick also reads whether the fabrik-runs store is private,
 * through `store` (see gatherRetroSlice), and the store's Run records through
 * `replayStore`, only while a replay issue the Operator filed is open (see
 * gatherReplaySlice). Only src/main.ts, which the tick
 * runs, passes `replayStore`; the Kit job, which never routes a tick, doesn't.
 * agent:replay added reads every open replay issue, which a replay Ticket's
 * claim weighs, and nothing of the store.
 */
export async function gatherSnapshot(
  client: ReadClient,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  appLogin: string | null,
  actions: ReadClient | null = null,
  store: Pick<ReadClient, "rest"> | null = null,
  replayStore: ReplayStore | null = null,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Snapshot> {
  // A held line is never read as activity or a reply (#471).
  const github = leavingOutHeldLines(client);
  const [{ owner, kitIssues }, part, startingComment, reviewHasInlineComments, audit, namedPullRequests, weekCarriers] = await Promise.all([
    gatherKitIssues(github, repo, appLogin),
    gatherEventPart(github, repo, event, operator, appLogin, actions),
    gatherStartingComment(github, repo, event),
    gatherReviewInlineComments(github, repo, event),
    event.kind === "scheduled-tick" ? gatherAuditSlice(github, repo, appLogin) : null,
    gatherNamedPullRequests(github, repo, event),
    // The week's Carriers, closed ones included, so the gates note a waiting week once (#442).
    event.kind === "scheduled-tick" ? gatherWeekCarriers(github, repo, appLogin, new Date(weekStart(event.now)).toISOString()) : null,
  ]);
  // A Design turn's Map is weighed against the Map cap, which counts every open Map.
  const openMaps =
    event.kind === "agent-run-finished" && event.role === "design" ? (await gatherOpenMaps(github, repo)).map(({ number }) => number) : null;
  // A closed Ticket may be its Spec's last.
  const parent = event.kind === "issue-closed" ? (part?.issue?.parent ?? null) : null;
  const spec = parent === null ? null : await gatherSpec(github, repo, parent);
  // The tick resumes held runs once a Subscription is free, and so does whatever may free one (#439).
  const freesASubscription =
    event.kind === "scheduled-tick" ||
    event.kind === "kit-config-changed" ||
    (event.kind === "issue-closed" && makesUnusable(part?.issue?.labels ?? []));
  // A carrier closed by hand has left kitIssues, yet the runs held on it resume as it frees a Subscription (#440, #470).
  const closedKitIssue =
    event.kind === "issue-closed" && makesUnusable(part?.issue?.labels ?? [])
      ? await gatherKitIssue(github, repo, event.issue, appLogin)
      : null;
  // The Carriers closed this past week, so the runs an issue-closed event failed to deal with aren't lost (#533).
  const closedCarriers = event.kind === "scheduled-tick" ? await gatherClosedCarriers(github, repo, appLogin, event.now) : null;
  const held = freesASubscription
    ? await gatherHeld(github, repo, [...kitIssues, ...(closedKitIssue === null ? [] : [closedKitIssue]), ...(closedCarriers ?? [])], appLogin)
    : null;
  const triggers = event.kind === "scheduled-tick" ? await gatherTriggerSweep(github, actions, repo, appLogin) : null;
  // The tick closes each ready-for-agent Ticket GitHub left open after a PR of it merged (#543).
  const readyTickets = event.kind === "scheduled-tick" ? (await gatherDispatchTickets(github, repo, appLogin)).tickets : null;
  // A Flaky check found again comments on its check's open issue (#462): the Kit finds them at a Review's landing and the tick.
  const flakyCheckIssues = FLAKY_CHECK_EVENTS.includes(event.kind) ? (await gatherKitIssues(github, repo, appLogin, [FLAKY_CHECK_LABEL])).kitIssues : [];
  // A weekly run's failure may give up on the week, which its gate's issues say (#443).
  const weeklyLabel = WEEKLY_RUN_EVENTS.includes(event.kind) ? weeklyLabelOf(part?.issue?.labels ?? []) : null;
  const weeklyIssues = weeklyLabel === null ? null : weeklyIssuesOf(await queryWeeklyIssues(github, repo, weeklyLabel), appLogin);
  // A push to the default branch may leave an agent PR conflicting with it; the tick catches any the push missed (#304).
  const conflicts =
    event.kind === "main-pushed" || event.kind === "kit-config-changed"
      ? await gatherConflicts(github, actions, repo, new Date().toISOString(), appLogin, operator ?? owner, wait)
      : event.kind === "scheduled-tick"
        ? await gatherConflicts(github, actions, repo, event.now, appLogin, operator ?? owner, wait)
        : null;
  // The tick counts back an Execution flaw whose checks have since passed on its head (#462).
  const flakySweep = event.kind === "scheduled-tick" && conflicts !== null ? await gatherFlakySweep(github, repo, conflicts.pullRequests) : null;
  // A Reviewer's pass on a PR that conflicts with main brings it up to date instead of opening the Merge gate (#480).
  const mergeable = event.kind === "review-run-finished" ? await gatherMergeable(github, repo, event.pullRequest, wait) : null;
  // By default the Operator owns the Product repos they run Fabrik in.
  const theOperator = part?.operator ?? operator ?? owner;
  // An agent pull request that merges or closes with a Roll-in unsent has that Roll-in's issue reopened for Triage (#663).
  const rollIns =
    event.kind === "pull-request-closed" && part?.pullRequest?.isAgent === true
      ? await gatherRollIns(github, repo, event.pullRequest, theOperator, appLogin)
      : null;
  const retro = event.kind === "scheduled-tick" ? await gatherRetroSlice(github, repo, event.now, theOperator, appLogin, store) : null;
  const replay =
    event.kind === "scheduled-tick" && replayStore !== null
      ? await gatherReplaySlice(github, repo, event.now, kitIssues, theOperator, appLogin, replayStore)
      : // A replay Ticket's claim weighs every open replay issue, since one replay Ticket runs at a time across them all.
        event.kind === "label-added" && event.label === REPLAY_TRIGGER_LABEL
        ? { issues: await gatherReplayIssues(github, repo, appLogin), capacity: null, acceptance: null }
        : null;
  return part === null
    ? { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec, operator: theOperator, kitIssues, startingComment, reviewHasInlineComments, audit, retro, weeklyIssues, replay, namedPullRequests, rollIns, held, closedKitIssue, closedCarriers, weekCarriers, openMaps, conflicts, mergeable, triggers, readyTickets, flakyCheckIssues, flakySweep }
    : { ...part, spec, kitIssues, startingComment, reviewHasInlineComments, audit, retro, weeklyIssues, replay, namedPullRequests, rollIns, held, closedKitIssue, closedCarriers, weekCarriers, openMaps, conflicts, mergeable, triggers, readyTickets, flakyCheckIssues, flakySweep };
}

/** A check run in GitHub's REST listing, as the Flaky check sweep reads it. */
interface RawHeadCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly html_url: string | null;
}

/**
 * For the tick's Flaky check sweep (#462): each open agent PR's ci-sourced
 * Execution flaws not yet counted back, with every check run on the head each
 * was given on, every attempt included. The Fabrik App reads them with
 * Checks: read; without it the sweep is "no-permission", and does nothing.
 */
async function gatherFlakySweep(
  github: Pick<ReadClient, "rest">,
  repo: Repo,
  candidates: readonly ConflictCandidate[],
): Promise<FlawHeadChecks[] | "no-permission"> {
  const heads: FlawHeadChecks[] = [];
  try {
    for (const { pullRequest } of candidates) {
      for (const { headSha, checks = [] } of uncountedFlaws(pullRequest)) {
        const path = `/repos/${repo.owner}/${repo.name}/commits/${headSha}/check-runs?filter=all`;
        const runs = await allPages<RawHeadCheckRun>(github, path, (page) => (page as { check_runs: RawHeadCheckRun[] }).check_runs);
        heads.push({
          pullRequest: pullRequest.number,
          ticket: pullRequest.ticket,
          headSha,
          checks,
          checkRuns: runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, startedAt: run.started_at, url: run.html_url ?? "" })),
        });
      }
    }
  } catch (error) {
    if (error instanceof GitHubError && refusalOf(error) === "missing-permission") return "no-permission";
    throw error;
  }
  return heads;
}

/** The events whose plan may find a Flaky check (#462). */
const FLAKY_CHECK_EVENTS: readonly LoopEvent["kind"][] = ["required-checks-finished", "review-run-finished", "scheduled-tick"];

/** The events that may fail an Auditor or Retro run on its pending issue: its opening, while every Subscription is used up, and its run's ending. */
const WEEKLY_RUN_EVENTS: readonly LoopEvent["kind"][] = ["issue-opened", "agent-run-failed", "audit-run-finished", "retro-run-finished"];

/** The weekly gate's label among an issue's labels, `fabrik:audit` or `fabrik:retro`, or null when it has neither. */
function weeklyLabelOf(labels: readonly string[]): string | null {
  return [AUDIT_LABEL, RETRO_LABEL].find((label) => labels.includes(label)) ?? null;
}

/**
 * The newest issues with a weekly gate's label (src/loop/weeklyGate.ts),
 * Audits or Retros, open and closed: enough to hold this week's, any open
 * one, the last one and the last closed ones an Auditor or Retro run reads,
 * since a week opens at most three. `fields` are read on each issue beside a
 * WeeklyIssueSnapshot's own (weeklyIssueOf), as a Retro's history reads its
 * comments (src/github/facts.ts), so the tick, an Auditor run's inputs and a
 * Retro's evidence read the same issues.
 */
export function weeklyIssuesQuery(fields = ""): string {
  return `
  query ($owner: String!, $name: String!, $label: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { target { oid } }
      issues(labels: [$label], states: [OPEN, CLOSED], first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { number title state stateReason createdAt body author { login __typename } ${fields} }
      }
    }
  }
`;
}

const WEEKLY_ISSUES_QUERY = weeklyIssuesQuery();

/** A weekly gate's issue as weeklyIssuesQuery reads it, before any `fields` of its own. */
export interface RawWeeklyIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  createdAt: string;
  body: string;
  author: { login: string; __typename: string } | null;
}

/** What weeklyIssuesQuery reads, with each issue as `Issue`, which its `fields` add to. */
export interface WeeklyIssuesQueryResult<Issue extends RawWeeklyIssue = RawWeeklyIssue> {
  repository: {
    defaultBranchRef: { target: { oid: string } } | null;
    issues: { nodes: Issue[] };
  };
}

/**
 * The default branch's head, and the newest `fabrik:audit` issues with
 * whether the Fabrik App, whose bot login is `appLogin`, opened each (see
 * byAppOf): what the audit gate weighs on a scheduled tick.
 */
async function gatherAuditSlice(github: Pick<ReadClient, "graphql">, repo: Repo, appLogin: string | null): Promise<AuditSnapshot> {
  return auditSliceOf(await queryWeeklyIssues(github, repo, AUDIT_LABEL), appLogin);
}

/**
 * The audit slice an Auditor run's inputs read the Audits from
 * (src/agent/inputs.ts), for its pending Audit, numbered `pending`. The run
 * holds no Fabrik App token, so it doesn't know the App's login: it takes the
 * bot that opened the pending Audit for the App. The push job lands the run's
 * result only when that bot is the App (src/loop/auditLanding.ts), so in
 * every run whose result counts, the Auditor reads the Audits the audit gate
 * weighs, and never another bot's. A pending Audit a person opened is no
 * Audit here.
 */
export async function gatherAuditSliceFor(github: Pick<ReadClient, "graphql">, repo: Repo, pending: number): Promise<AuditSnapshot> {
  const data = await queryWeeklyIssues(github, repo, AUDIT_LABEL);
  const opener = data.repository.issues.nodes.find((issue) => issue.number === pending)?.author ?? null;
  return auditSliceOf(data, opener?.__typename === "Bot" ? loginOf(opener) : null);
}

function queryWeeklyIssues(github: Pick<ReadClient, "graphql">, repo: Repo, label: string): Promise<WeeklyIssuesQueryResult> {
  return github.graphql<WeeklyIssuesQueryResult>(WEEKLY_ISSUES_QUERY, { owner: repo.owner, name: repo.name, label });
}

function auditSliceOf(data: WeeklyIssuesQueryResult, appLogin: string | null): AuditSnapshot {
  return { head: data.repository.defaultBranchRef?.target.oid ?? null, issues: weeklyIssuesOf(data, appLogin) };
}

/** Each issue the query read, with whether the Fabrik App, whose bot login is `appLogin`, opened it (see byAppOf). */
function weeklyIssuesOf(data: WeeklyIssuesQueryResult, appLogin: string | null): WeeklyIssueSnapshot[] {
  return data.repository.issues.nodes.map((issue) => weeklyIssueOf(issue, appLogin));
}

/** One issue weeklyIssuesQuery read, with whether the Fabrik App, whose bot login is `appLogin`, opened it (see byAppOf). */
export function weeklyIssueOf(issue: RawWeeklyIssue, appLogin: string | null): WeeklyIssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    open: issue.state === "OPEN",
    stateReason: issue.stateReason === null ? null : (issue.stateReason.toLowerCase() as WeeklyIssueSnapshot["stateReason"]),
    createdAt: issue.createdAt,
    byApp: byAppOf(issue.author, appLogin),
    body: issue.body,
  };
}

/**
 * What the retro gate weighs on the scheduled tick at `now`: whether the
 * fabrik-runs store is ready, the newest `fabrik:retro` issues with whether
 * the Fabrik App, whose bot login is `appLogin`, opened each (see byAppOf),
 * and whether anything is new since the window a Retro opened now would
 * start (src/loop/retro.ts): an agent PR merged or closed, or an issue the
 * Operator opened with an escape marker. `store` is a token that reads only
 * the store's metadata, which the tick mints once it has found the Fabrik App
 * on fabrik-runs (src/kit/find-store-main.ts, the record action's store
 * finder); null when it found none, so the store isn't ready.
 */
async function gatherRetroSlice(
  github: Pick<ReadClient, "graphql">,
  repo: Repo,
  now: string,
  operator: string,
  appLogin: string | null,
  store: Pick<ReadClient, "rest"> | null,
): Promise<RetroSnapshot> {
  const [storeReady, data] = await Promise.all([
    store === null ? false : storeIsPrivate(store),
    queryWeeklyIssues(github, repo, RETRO_LABEL),
  ]);
  const issues = weeklyIssuesOf(data, appLogin);
  const since = Date.parse(retroWindowStart(now, issues));
  const [agentPullRequestClosed, escapeFiled] = await Promise.all([
    agentPullRequestClosedSince(github, repo, since),
    escapeFiledSince(github, repo, operator, since),
  ]);
  return { storeReady, issues, agentPullRequestClosed, escapeFiled };
}

// Merged and closed PRs, newest-updated first, so paging stops at the first
// page that reaches back past the window start: a PR that closed in the
// window was updated in it.
const CLOSED_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: [MERGED, CLOSED], first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { headRefName closedAt updatedAt author { __typename } }
      }
    }
  }
`;

interface ClosedPullRequestNode {
  headRefName: string;
  closedAt: string | null;
  updatedAt: string;
  author: { __typename: string } | null;
}

/** Whether an agent PR (src/loop/agentPullRequest.ts) merged, or closed unmerged, at or after `since`. */
async function agentPullRequestClosedSince(github: Pick<ReadClient, "graphql">, repo: Repo, since: number): Promise<boolean> {
  const closedAgentPullRequest = (pr: ClosedPullRequestNode) =>
    pr.closedAt !== null &&
    Date.parse(pr.closedAt) >= since &&
    isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" });
  const pullRequests = await pagesOf<ClosedPullRequestNode>(
    github,
    CLOSED_PULL_REQUESTS_QUERY,
    repo,
    {},
    (data) => data.repository.pullRequests,
    (page) => page.some((pr) => closedAgentPullRequest(pr) || Date.parse(pr.updatedAt) < since),
  );
  return pullRequests.some(closedAgentPullRequest);
}

// The issues one person opened, newest first, so paging stops at the first page older than the window.
const ISSUES_OPENED_BY_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $operator: String!) {
    repository(owner: $owner, name: $name) {
      issues(first: 25, after: $after, filterBy: { createdBy: $operator }, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { createdAt body }
      }
    }
  }
`;

/**
 * Whether the Operator opened an issue whose body has an escape marker at or
 * after `since`, such as a filed Audit candidate: an Architectural escape,
 * which only the Operator's issues count as.
 */
async function escapeFiledSince(github: Pick<ReadClient, "graphql">, repo: Repo, operator: string, since: number): Promise<boolean> {
  const filed = (issue: { createdAt: string; body: string }) => Date.parse(issue.createdAt) >= since && escapeMarkerIn(issue.body) !== null;
  const issues = await pagesOf<{ createdAt: string; body: string }>(
    github,
    ISSUES_OPENED_BY_QUERY,
    repo,
    { operator },
    (data) => data.repository.issues,
    (page) => page.some((issue) => filed(issue) || Date.parse(issue.createdAt) < since),
  );
  return issues.some(filed);
}

/** A PR as the REST API returns it: the fields an Auditor's named PRs are read from. */
interface RestPullRequest {
  number: number;
  state: string;
  merged: boolean;
  head: { ref: string };
  user: { type: string } | null;
}

/**
 * The PRs a finished run's reply names, as GitHub has them, or null for an
 * event whose reply names none the core reads. For an Audit run finishing:
 * each PR its reply names under "Introduced by", once; a reply that breaks
 * its contract names none, since the core fails its Audit. For a
 * Design-session turn finishing in a Roll-in: the one pull request it is to
 * be settled onto; a turn that ends any other way, or whose reply breaks its
 * contract, reads none. A number GitHub has no PR for is left out.
 */
async function gatherNamedPullRequests(github: ReadClient, repo: Repo, event: LoopEvent): Promise<NamedPullRequestSnapshot[] | null> {
  if (event.kind === "audit-run-finished") {
    const parsed = parseAuditOutput(event.output);
    return readPullRequests(github, repo, parsed.ok ? [...new Set(parsed.output.candidates.flatMap((candidate) => candidate.introducedBy))] : []);
  }
  if (event.kind === "agent-run-finished" && event.role === "design") {
    const parsed = parseDesignTurnOutput(event.output, event.issue);
    return parsed.ok && parsed.output.kind === "roll-in" ? readPullRequests(github, repo, [parsed.output.pullRequest]) : null;
  }
  return null;
}

/** Each of these pull requests that GitHub has, by number, in the order given. */
async function readPullRequests(github: ReadClient, repo: Repo, named: readonly number[]): Promise<NamedPullRequestSnapshot[]> {
  const pulls = await Promise.all(
    named.map(
      (number) =>
        github.rest("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, { allowNotFound: true }) as Promise<RestPullRequest | null>,
    ),
  );
  return pulls.flatMap((pull) =>
    pull === null
      ? []
      : [
          {
            number: pull.number,
            open: pull.state === "open",
            merged: pull.merged,
            headRef: pull.head.ref,
            isAgent: isAgentPullRequest({ headRef: pull.head.ref, authorIsBot: pull.user?.type === "Bot" }),
          },
        ],
  );
}

/**
 * Every issue or pull request GitHub cross-references to a pull request, a
 * page at a time, an issue's with where it is and how it stands. A query of
 * its own, made only as an agent pull request closes: PULL_REQUEST_FIELDS is
 * read of every open pull request by the conflict check too.
 */
const ROLL_IN_CROSS_REFERENCES_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        crossReferences: timelineItems(first: 100, after: $after, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CrossReferencedEvent { source { __typename ... on Issue { number state stateReason repository { nameWithOwner } } } }
          }
        }
      }
    }
  }
`;

/** A cross-reference as ROLL_IN_CROSS_REFERENCES_QUERY reads it: an issue's source, or a pull request's, of which only the kind is read. */
interface RawRollInCrossReference {
  __typename: string;
  source?: { __typename: string; number?: number; state?: "OPEN" | "CLOSED"; stateReason?: RawStateReason; repository?: { nameWithOwner: string } };
}

/** Why an issue is in its state, as GitHub's GraphQL names it. */
type RawStateReason = "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;

/** How many of an issue's latest comments are read for its Roll-in's closing comment and the Kit's reopening note. */
const ROLL_IN_ISSUE_COMMENTS = 100;

/**
 * These issues by number, each as it stands now, with its latest comments
 * and who wrote them. One query however many they are, each issue under an
 * alias of its own.
 */
function rollInIssuesQuery(numbers: readonly number[]): string {
  const issue = (number: number): string =>
    `issue${number}: issue(number: ${number}) { number title state stateReason comments(last: ${ROLL_IN_ISSUE_COMMENTS}) { nodes { body createdAt url author { login __typename } } } }`;
  return `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${numbers.map(issue).join("\n      ")}
    }
  }
`;
}

/** An issue as rollInIssuesQuery reads it. */
interface RawRollInIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: RawStateReason;
  comments: { nodes: { body: string; createdAt: string; url: string; author: { login: string; __typename: string } | null }[] };
}

/**
 * For an agent pull request closing, merged or not (#663): what tells which
 * Roll-ins were left unsent on it (src/loop/owedRollIn.ts). The Roll-in's
 * closing comment names the pull request, so GitHub cross-references its
 * issue to it: every cross-reference is read, and of those only the issues
 * of this repo closed as not planned are read further, each with its latest
 * comments, the Fabrik App's (see byAppOf) told from anyone else's. With
 * them, the Operator's Request changes on the pull request, each review's
 * own text, by the one rule for which reviews those are
 * (operatorsRequestChangesIn): no line comment is read. A pull request no
 * such issue names costs the one query and nothing more.
 */
async function gatherRollIns(github: ReadClient, repo: Repo, pullRequest: number, operator: string, appLogin: string | null): Promise<RollInsSnapshot> {
  const here = `${repo.owner}/${repo.name}`;
  const references = await pagesOf<RawRollInCrossReference>(
    github,
    ROLL_IN_CROSS_REFERENCES_QUERY,
    repo,
    { number: pullRequest },
    (data) => data.repository.pullRequest?.crossReferences ?? null,
  );
  const numbers = [
    ...new Set(
      references.flatMap(({ source }) =>
        source?.__typename === "Issue" &&
        source.number !== undefined &&
        source.state === "CLOSED" &&
        source.stateReason === "NOT_PLANNED" &&
        // GitHub tells repos apart whatever the case of their names.
        source.repository?.nameWithOwner.toLowerCase() === here.toLowerCase()
          ? [source.number]
          : [],
      ),
    ),
  ].sort((a, b) => a - b);
  if (numbers.length === 0) return { repo: here, requestChanges: [], issues: [] };
  const [data, reviews] = await Promise.all([
    github.graphql<{ repository: Record<string, RawRollInIssue | null> }>(rollInIssuesQuery(numbers), { owner: repo.owner, name: repo.name }),
    allPages<WrittenReview>(github, `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}/reviews`),
  ]);
  return {
    repo: here,
    requestChanges: operatorsRequestChangesIn({ lineComments: [], reviews }, operator).map(({ review, dismissed }) => ({ body: review.body ?? "", dismissed })),
    issues: numbers.flatMap((number) => {
      const issue = data.repository[`issue${number}`];
      if (issue === null || issue === undefined) return [];
      return [
        {
          number: issue.number,
          title: issue.title,
          repo: here,
          // Read again with its comments, so one reopened or closed another way since the cross-reference was read is told as it stands.
          closedAs: issue.state === "CLOSED" && issue.stateReason !== null && issue.stateReason !== "REOPENED" ? CLOSED_AS[issue.stateReason] : null,
          comments: issue.comments.nodes.map(({ body, createdAt, url, author }) => ({ body, byApp: byAppOf(author, appLogin), at: createdAt, url })),
        },
      ];
    }),
  };
}

/** How the Kit names each reason GitHub closes an issue with. */
const CLOSED_AS = { COMPLETED: "completed", NOT_PLANNED: "not_planned", DUPLICATE: "duplicate" } as const;

/**
 * The open `wayfinder:map` issues, oldest first, whoever opened them. One
 * page is enough: the Map cap is never above its default of 1, so the first
 * 50 hold every Map that fills it.
 */
const OPEN_MAPS_QUERY = `
  query ($owner: String!, $name: String!, $map: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$map], first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes { number title }
      }
    }
  }
`;

/** An open Map, as the Map cap counts it and a Design turn's inputs name it. */
export interface OpenMap {
  readonly number: number;
  readonly title: string;
}

/**
 * The open Maps in the repo, oldest first, made by the Kit or by the Operator
 * by hand: what the Map cap counts (src/loop/mapCap.ts). Read for a
 * Design-session turn landing, and for the turn's inputs (src/agent/inputs.ts).
 */
export async function gatherOpenMaps(github: Pick<ReadClient, "graphql">, repo: Repo): Promise<OpenMap[]> {
  const data = await github.graphql<{ repository: { issues: { nodes: OpenMap[] } } }>(OPEN_MAPS_QUERY, {
    owner: repo.owner,
    name: repo.name,
    map: MAP_LABEL,
  });
  return data.repository.issues.nodes.map(({ number, title }) => ({ number, title }));
}

/**
 * For a Design-session turn the Operator's reply started, or a prototype turn
 * whose request their reply approved (#155): whether that reply is still on
 * the issue. Only a 404 means it was deleted; any other failed read fails the
 * run, as every failed read does, and never counts as deleted.
 */
async function gatherStartingComment(github: ReadClient, repo: Repo, event: LoopEvent): Promise<StartingComment | null> {
  const id = event.kind === "agent-run-finished" ? event.startedBy : event.kind === "prototype-run-finished" ? event.request.reply : null;
  if (id === undefined || id === null) return null;
  const comment = await github.rest("GET", `/repos/${repo.owner}/${repo.name}/issues/comments/${id}`, undefined, {
    allowNotFound: true,
  });
  return { id, exists: comment !== null };
}

/**
 * For a review with no body on a PR, whether it holds any inline comment: one
 * is enough to say so. A review with a body is acknowledged either way, so
 * nothing is read for it.
 */
async function gatherReviewInlineComments(github: ReadClient, repo: Repo, event: LoopEvent): Promise<boolean | null> {
  if (event.kind !== "pull-request-commented" || event.on.kind !== "review" || event.on.hasBody) return null;
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${event.pullRequest}/reviews/${event.on.review}/comments?per_page=1`;
  const comments = (await github.rest("GET", path)) as unknown[];
  return comments.length > 0;
}

// A Spec's Tickets and the merged PRs that closed each. A Spec with more than 100 Tickets is far past v1.
const SPEC_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        state
        labels(first: 100) { nodes { name } }
        subIssues(first: 100) {
          nodes {
            number
            state
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state } }
          }
        }
      }
    }
  }
`;

interface SpecQueryResult {
  repository: {
    issue: {
      number: number;
      state: "OPEN" | "CLOSED";
      labels: { nodes: { name: string }[] };
      subIssues: {
        nodes: {
          number: number;
          state: "OPEN" | "CLOSED";
          closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
        }[];
      };
    } | null;
  };
}

async function gatherSpec(github: ReadClient, repo: Repo, number: number): Promise<SpecSnapshot | null> {
  const data = await github.graphql<SpecQueryResult>(SPEC_QUERY, { owner: repo.owner, name: repo.name, number });
  const spec = data.repository.issue;
  if (spec === null) return null;
  return {
    number: spec.number,
    open: spec.state === "OPEN",
    labels: spec.labels.nodes.map((label) => label.name),
    tickets: spec.subIssues.nodes.map((ticket) => ({
      number: ticket.number,
      open: ticket.state === "OPEN",
      pullRequests: ticket.closedByPullRequestsReferences.nodes
        .filter((pr) => pr.state === "MERGED")
        .map((pr) => pr.number)
        .sort((a, b) => a - b),
    })),
  };
}

/** The part of the snapshot the event is about, or null for an event about the repo as a whole. */
async function gatherEventPart(
  github: ReadClient,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  appLogin: string | null,
  actions: ReadClient | null,
): Promise<EventPart | null> {
  switch (event.kind) {
    case "pull-request-pushed":
    case "pull-request-labeled":
    case "required-checks-finished":
    case "review-run-finished":
    case "digest-run-finished":
    case "pull-request-left-draft":
    case "pull-request-closed":
    case "pull-request-changes-requested":
    case "pull-request-commented":
      return gatherPullRequest(github, repo, event.pullRequest, operator, appLogin);
    case "dispatch-check":
      if (actions === null) throw new Error("A Dispatch check needs a token that can read workflow runs");
      return gatherDispatch(github, actions, repo, operator, appLogin);
    case "design-queue-check":
      return gatherDesignQueue(github, actions, repo, operator, appLogin);
    case "main-pushed":
    case "kit-config-changed":
    case "scheduled-tick":
      return null;
    case "implement-run-finished": {
      const ticket = await gatherIssue(github, repo, event.issue, operator, appLogin);
      if (event.fixes === undefined) return ticket;
      // A retry's push job weighs the Ticket and the PR it fixes.
      const { pullRequest } = await gatherPullRequest(github, repo, event.fixes.pullRequest, operator, appLogin);
      return { ...ticket, pullRequest };
    }
    case "agent-run-failed": {
      // A failed Implement run on a Ticket with an open PR may be a Broken Retry, which posts a Verdict there (#434).
      const ticket = await gatherIssue(github, repo, event.issue, operator, appLogin);
      // A failed Digest run's no-Digest line goes on the PR the Kit job named, closed by now or not.
      const open = event.digest?.pullRequest ?? (event.role === "implement" && event.prototype !== true ? ticket.issue?.openPullRequests[0] : undefined);
      if (open === undefined) return ticket;
      const { pullRequest } = await gatherPullRequest(github, repo, open, operator, appLogin);
      return { ...ticket, pullRequest };
    }
    case "label-added": {
      // agent:implement on a Ticket with an open PR resumes that PR's run, so the core weighs the PR too.
      const ticket = await gatherIssue(github, repo, event.issue, operator, appLogin);
      const open = ticket.issue?.openPullRequests[0];
      if (open === undefined) return ticket;
      const { pullRequest } = await gatherPullRequest(github, repo, open, operator, appLogin);
      return { ...ticket, pullRequest };
    }
    default:
      return gatherIssue(github, repo, event.issue, operator, appLogin);
  }
}

type EventPart = Omit<
  Snapshot,
  | "kitIssues"
  | "spec"
  | "startingComment"
  | "reviewHasInlineComments"
  | "audit"
  | "retro"
  | "weeklyIssues"
  | "replay"
  | "namedPullRequests"
  | "rollIns"
  | "held"
  | "closedKitIssue"
  | "closedCarriers"
  | "weekCarriers"
  | "openMaps"
  | "conflicts"
  | "mergeable"
  | "triggers"
  | "readyTickets"
  | "flakyCheckIssues"
  | "flakySweep"
>;

const KIT_ISSUE_COMMENTS = "pageInfo { hasPreviousPage startCursor } nodes { body createdAt author { login __typename } }";

/** How many open Kit-owned issues each page of them holds, oldest first. */
const KIT_ISSUES_PAGE = 20;

/**
 * How many pages of open Kit-owned issues a snapshot reads at most: with more
 * open than they hold, the snapshot fails rather than act without them all (#441).
 */
const KIT_ISSUES_PAGES = 10;

const KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!, $after: String) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: $labels, first: ${KIT_ISSUES_PAGE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          createdAt
          body
          author { login __typename }
          labels(first: 100) { nodes { name } }
          comments(last: 100) { ${KIT_ISSUE_COMMENTS} }
        }
      }
    }
  }
`;

/** A Kit-owned issue's comments before the ones already read, a page at a time, newest page first. */
const KIT_ISSUE_EARLIER_COMMENTS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $before: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        comments(last: 100, before: $before) { ${KIT_ISSUE_COMMENTS} }
      }
    }
  }
`;

type Actor = { login: string; __typename: string } | null;

interface KitIssueComments {
  pageInfo?: { hasPreviousPage: boolean; startCursor: string | null };
  /** createdAt is always asked for; a fixture may leave it out. */
  nodes: { body: string; createdAt?: string; author: Actor }[];
}

interface KitIssueNode {
  number: number;
  createdAt?: string;
  body: string;
  author: Actor;
  labels: { nodes: { name: string }[] };
  comments: KitIssueComments;
}

interface KitIssuesQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      totalCount?: number;
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: KitIssueNode[];
    };
  };
}

/**
 * The open issues carrying a Kit-owned label (src/loop/kitIssues.ts), which
 * every event's snapshot holds, every one of them, a page at a time (#441).
 * Their markers steer agent runs (a held marker
 * resumes one), so only the App's own text is read (ADR-0007): the body of an
 * issue the App opened, and the App's comments, every one of them, however
 * many pages they take. Anyone else's comment is left out. With more open than
 * KIT_ISSUES_PAGES pages hold, it fails, naming how many are open, since a
 * weekly-limit issue it couldn't see would start runs on a used-up Subscription.
 * The Weekly summary reads them too (src/github/facts.ts), so its Held runs are
 * the Loop's.
 */
export async function gatherKitIssues(
  github: Pick<ReadClient, "graphql">,
  repo: Repo,
  appLogin: string | null,
  labels: readonly string[] = KIT_ISSUE_LABELS,
): Promise<{ owner: string; kitIssues: KitIssueSnapshot[] }> {
  const nodes: KitIssueNode[] = [];
  let owner = "";
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    const data: KitIssuesQueryResult = await github.graphql<KitIssuesQueryResult>(KIT_ISSUES_QUERY, {
      owner: repo.owner,
      name: repo.name,
      labels,
      after,
    });
    const { totalCount, pageInfo, nodes: onPage } = data.repository.issues;
    owner = data.repository.owner.login;
    nodes.push(...onPage);
    if (pageInfo?.hasNextPage !== true || pageInfo.endCursor === null) break;
    if (page + 1 >= KIT_ISSUES_PAGES) {
      throw new Error(
        `${totalCount ?? `More than ${nodes.length}`} open issues carry a Kit-owned label, more than the ${KIT_ISSUES_PAGE * KIT_ISSUES_PAGES} the Kit reads, ` +
          "so it stops rather than act without seeing them all. Close the ones no longer needed.",
      );
    }
    after = pageInfo.endCursor;
  }
  const kitIssues = await Promise.all(nodes.map((issue) => kitIssueOf(github, repo, issue, appLogin)));
  return { owner, kitIssues };
}

const WEEK_CARRIERS_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!, $since: DateTime!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: [OPEN, CLOSED], labels: $labels, filterBy: { since: $since }, first: ${KIT_ISSUES_PAGE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          createdAt
          body
          author { login __typename }
          labels(first: 100) { nodes { name } }
          comments(last: 100) { ${KIT_ISSUE_COMMENTS} }
        }
      }
    }
  }
`;

/**
 * The weekly-limit, usage-credits and token-rotation issues updated since
 * `since`, open or closed, as kitIssues holds them: only the text of the
 * Fabrik App, whose bot login is `appLogin`, or of any bot when null (see
 * byAppOf). The gates and the Weekly summary read the waiting markers the
 * tick noted on them, on a Carrier closed since included (#442).
 */
export async function gatherWeekCarriers(github: Pick<ReadClient, "graphql">, repo: Repo, appLogin: string | null, since: string): Promise<KitIssueSnapshot[]> {
  const nodes: KitIssueNode[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null } | null; nodes: KitIssueNode[] } } } = await github.graphql(
      WEEK_CARRIERS_QUERY,
      { owner: repo.owner, name: repo.name, labels: CARRIER_LABELS, since, after },
    );
    const { pageInfo, nodes: onPage } = data.repository.issues;
    nodes.push(...onPage);
    if (pageInfo?.hasNextPage !== true || pageInfo.endCursor === null) break;
    after = pageInfo.endCursor;
  }
  return Promise.all(nodes.map((issue) => kitIssueOf(github, repo, issue, appLogin)));
}

/** How far back the tick reads closed Carriers, and how many it reads at most: one page. */
const CLOSED_CARRIERS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_CARRIERS_PAGE = 50;

const CLOSED_CARRIERS_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!, $since: DateTime!) {
    repository(owner: $owner, name: $name) {
      issues(states: CLOSED, labels: $labels, filterBy: { since: $since }, first: ${CLOSED_CARRIERS_PAGE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage }
        nodes {
          number
          createdAt
          closedAt
          body
          author { login __typename }
          labels(first: 100) { nodes { name } }
          comments(last: 100) { ${KIT_ISSUE_COMMENTS} }
        }
      }
    }
  }
`;

/**
 * The weekly-limit, usage-credits and token-rotation issues closed in the 7
 * days before `now`, newest close first, as kitIssues holds an open one: only
 * the App's own text. The tick deals with the Held runs still waiting on
 * them, should the issue-closed event have failed to (#533). GitHub can't
 * filter by close, so it reads those updated in the window, which every one
 * closed in it is, a page at most: with more, it fails, as gatherKitIssues
 * does, rather than act without seeing them all.
 */
async function gatherClosedCarriers(github: Pick<ReadClient, "graphql">, repo: Repo, appLogin: string | null, now: string): Promise<KitIssueSnapshot[]> {
  const since = new Date(Date.parse(now) - CLOSED_CARRIERS_WINDOW_MS).toISOString();
  const data: { repository: { issues: { pageInfo: { hasNextPage: boolean } | null; nodes: (KitIssueNode & { closedAt?: string | null })[] } } } =
    await github.graphql(CLOSED_CARRIERS_QUERY, { owner: repo.owner, name: repo.name, labels: CARRIER_LABELS, since });
  const { pageInfo, nodes } = data.repository.issues;
  if (pageInfo?.hasNextPage === true) {
    throw new Error(
      `More than ${CLOSED_CARRIERS_PAGE} weekly-limit, usage-credits or token-rotation issues were closed in the last 7 days, or updated since, ` +
        "more than the Kit reads, so it stops rather than act without seeing them all.",
    );
  }
  const closed = nodes
    .flatMap((node) => (typeof node.closedAt === "string" && Date.parse(node.closedAt) >= Date.parse(since) ? [{ node, closedAt: Date.parse(node.closedAt) }] : []))
    .sort((a, b) => b.closedAt - a.closedAt);
  return Promise.all(closed.map(({ node }) => kitIssueOf(github, repo, node, appLogin)));
}

/** The labels of the issues that make a Subscription unusable, which Carriers are. */
const CARRIER_LABELS = [WEEKLY_LIMIT_LABEL, USAGE_CREDITS_LABEL, TOKEN_ROTATION_LABEL];

/** A Kit-owned issue as kitIssues holds it: only the App's own text, every comment of it. */
async function kitIssueOf(github: Pick<ReadClient, "graphql">, repo: Repo, issue: KitIssueNode, appLogin: string | null): Promise<KitIssueSnapshot> {
  const comments = [...(await earlierComments(github, repo, issue.number, issue.comments)), ...issue.comments.nodes];
  const apps = comments.filter((comment) => byAppOf(comment.author, appLogin));
  // When its held markers were posted, so a resume that landed after them isn't given again (#438).
  const commentedAt = apps.flatMap((comment) => (comment.createdAt === undefined ? [] : [comment.createdAt]));
  return {
    number: issue.number,
    labels: issue.labels.nodes.map((label) => label.name),
    body: byAppOf(issue.author, appLogin) ? issue.body : "",
    comments: apps.map((comment) => comment.body),
    ...(issue.createdAt === undefined ? {} : { createdAt: issue.createdAt }),
    ...(apps.length === 0 || commentedAt.length !== apps.length ? {} : { commentedAt }),
  };
}

const KIT_ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      closedKitIssue: issue(number: $number) {
        number
        createdAt
        body
        author { login __typename }
        labels(first: 100) { nodes { name } }
        comments(last: 100) { ${KIT_ISSUE_COMMENTS} }
      }
    }
  }
`;

/**
 * One Kit-owned issue by number, open or closed, as kitIssues holds an open
 * one: for a weekly-limit, usage-credits or token-rotation issue closed by
 * hand, whose held markers kitIssues no longer reads (#440, #470).
 */
async function gatherKitIssue(github: ReadClient, repo: Repo, number: number, appLogin: string | null): Promise<KitIssueSnapshot | null> {
  const data = await github.graphql<{ repository: { closedKitIssue: KitIssueNode | null } }>(KIT_ISSUE_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number,
  });
  const issue = data.repository.closedKitIssue;
  return issue === null ? null : kitIssueOf(github, repo, issue, appLogin);
}

/** The comments before this page, oldest first. */
async function earlierComments(
  github: Pick<ReadClient, "graphql">,
  repo: Repo,
  number: number,
  page: KitIssueComments,
): Promise<KitIssueComments["nodes"]> {
  const earlier: KitIssueComments["nodes"][] = [];
  let pageInfo = page.pageInfo;
  while (pageInfo?.hasPreviousPage === true && pageInfo.startCursor !== null) {
    const data = await github.graphql<{ repository: { issue: { comments: KitIssueComments } | null } }>(
      KIT_ISSUE_EARLIER_COMMENTS_QUERY,
      { owner: repo.owner, name: repo.name, number, before: pageInfo.startCursor },
    );
    const comments = data.repository.issue?.comments;
    if (comments === undefined) break;
    earlier.unshift(comments.nodes);
    pageInfo = comments.pageInfo;
  }
  return earlier.flat();
}

/** A label event or a comment, as an issue's or PR's timeline lists them. */
type TriggerTimelineItem =
  | { __typename: "LabeledEvent" | "UnlabeledEvent"; createdAt: string; label: { name: string } | null }
  | { __typename: "IssueComment"; body: string; author: Actor };

/** The latest timeline items the sweep reads an issue or PR by: enough to hold a label's last add, and the Kit's re-add after it. */
const TRIGGER_TIMELINE = `
  timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT], last: 100) {
    nodes {
      __typename
      ... on LabeledEvent { createdAt label { name } }
      ... on UnlabeledEvent { createdAt label { name } }
      ... on IssueComment { body author { login __typename } }
    }
  }
`;

// Every open replay issue, oldest first, with its body whole and the comments
// the App's are read from, as the Kit-owned issues' are.
const REPLAY_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $replay: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$replay], first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes {
          number
          createdAt
          body
          author { login __typename }
          labels(first: 100) { nodes { name } }
          comments(last: 100) { ${KIT_ISSUE_COMMENTS} }
          ${TRIGGER_TIMELINE}
        }
      }
    }
  }
`;

/**
 * What the replay step weighs on the scheduled tick at `now` (#156). With
 * no replay issue among the open Kit-owned
 * issues, it reads nothing new. Else it reads every open replay issue: its body whole, though the
 * Operator files it, since the request is the Operator's own text, which the
 * Kit-owned issues leave out (ADR-0007), and the App's comments alone. Only
 * while one is the Operator's does it read what the spare-capacity gate
 * weighs, the Tickets and research Decisions Dispatch weighs and the store's
 * newest weekly-limit reading on each Subscription, and, while a valid
 * request waits, what accepting it weighs (src/github/replaySlice.ts).
 */
async function gatherReplaySlice(
  github: ReadClient,
  repo: Repo,
  now: string,
  kitIssues: readonly KitIssueSnapshot[],
  operator: string,
  appLogin: string | null,
  store: ReplayStore,
): Promise<ReplaySnapshot> {
  if (!kitIssues.some((issue) => issue.labels.includes(REPLAY_LABEL))) return { issues: [], capacity: null, acceptance: null };
  const issues = await gatherReplayIssues(github, repo, appLogin);
  if (!issues.some((issue) => isOperatorsReplay(issue, operator))) return { issues, capacity: null, acceptance: null };
  const [dispatch, records] = await Promise.all([gatherDispatchCandidates(github, repo, appLogin), store.records()]);
  const acceptance = await gatherReplayAcceptance(github, repo, now, { operator, issues }, records);
  return { issues, capacity: { ...dispatch, weeklyLimits: records === null ? null : newestWeeklyLimits(records, now) }, acceptance };
}

interface ReplayIssuesQueryResult {
  repository: {
    issues: {
      nodes: {
        number: number;
        body: string;
        author: Actor;
        labels: { nodes: { name: string }[] };
        comments: KitIssueComments;
        timelineItems: { nodes: TriggerTimelineItem[] };
      }[];
    };
  };
}

/** Every open replay issue, with who filed it, its body whole, its labels and the App's comments, every one. */
async function gatherReplayIssues(github: ReadClient, repo: Repo, appLogin: string | null): Promise<ReplayIssueSnapshot[]> {
  const data = await github.graphql<ReplayIssuesQueryResult>(REPLAY_ISSUES_QUERY, { owner: repo.owner, name: repo.name, replay: REPLAY_LABEL });
  return Promise.all(
    data.repository.issues.nodes.map(async (issue): Promise<ReplayIssueSnapshot> => {
      const comments = [...(await earlierComments(github, repo, issue.number, issue.comments)), ...issue.comments.nodes];
      return {
        number: issue.number,
        open: true,
        author: loginOf(issue.author),
        body: issue.body,
        comments: comments.filter((comment) => byAppOf(comment.author, appLogin)).map((comment) => comment.body),
        labels: issue.labels.nodes.map((label) => label.name),
        // Its run never started twice, so the Kit took agent:replay off (#419): the replay step leaves it be.
        gaveUp: stuckTriggerGaveUpIn(triggerHistoryOf(issue.timelineItems.nodes, appLogin), REPLAY_TRIGGER_LABEL),
      };
    }),
  );
}

interface HeldTargetNode {
  __typename: "Issue" | "PullRequest";
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  body: string;
  author: { login: string; __typename: string } | null;
  labels: { nodes: { name: string }[] };
  /** Always asked for; a fixture may leave it out. */
  timelineItems?: { nodes: LabeledEventNode[] };
}

/** A LabeledEvent as a held target's timeline lists it: empty for any other item. */
type LabeledEventNode = { createdAt: string; label: { name: string } | null; actor: Actor } | Record<string, never>;

const HELD_TARGET_FIELDS =
  "__typename number state body author { login __typename } labels(first: 100) { nodes { name } } " +
  "timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { createdAt label { name } actor { login __typename } } } }";

/**
 * Each issue or PR a held marker on these carriers names, once,
 * to tell a held run still in the state it was held in from one that has
 * moved on as it resumes (src/loop/resume.ts): the open ones, one closed
 * by hand (#440), and those closed in the last 7 days (#533). A number naming
 * nothing GitHub has is left out.
 */
async function gatherHeld(
  github: ReadClient,
  repo: Repo,
  kitIssues: readonly KitIssueSnapshot[],
  appLogin: string | null,
): Promise<HeldTargetSnapshot[]> {
  const numbers = [
    ...new Set(
      kitIssues
        .filter(isCarrier)
        .flatMap((issue) => [issue.body, ...issue.comments])
        .flatMap((text) => heldRunsIn(text).map((run) => run.issue)),
    ),
  ];
  if (numbers.length === 0) return [];
  const query = [
    `query ($owner: String!, $name: String!, ${numbers.map((_, at) => `$n${at}: Int!`).join(", ")}) {`,
    "  repository(owner: $owner, name: $name) {",
    ...numbers.map(
      (_, at) =>
        `    t${at}: issueOrPullRequest(number: $n${at}) { ... on Issue { ${HELD_TARGET_FIELDS} } ... on PullRequest { ${HELD_TARGET_FIELDS} isDraft } }`,
    ),
    "  }",
    "}",
  ].join("\n");
  const variables: Record<string, unknown> = { owner: repo.owner, name: repo.name };
  numbers.forEach((number, at) => {
    variables[`n${at}`] = number;
  });
  const data = await github.graphql<{ repository: Record<string, HeldTargetNode | null> }>(query, variables);
  return numbers.flatMap((_, at): HeldTargetSnapshot[] => {
    const node = data.repository[`t${at}`];
    if (node === null || node === undefined) return [];
    return [
      {
        number: node.number,
        open: node.state === "OPEN",
        labels: node.labels.nodes.map((label) => label.name),
        draft: node.__typename === "PullRequest" ? node.isDraft === true : null,
        byApp: byAppOf(node.author, appLogin),
        body: node.body,
        ...(node.timelineItems === undefined ? {} : { labeledAt: labeledByAppAt(node.timelineItems.nodes, appLogin) }),
      },
    ];
  });
}

/** When the App last added each label, from these label events, oldest first: what tells a resume that landed (#438). */
function labeledByAppAt(events: readonly LabeledEventNode[], appLogin: string | null): Record<string, string> {
  const at: Record<string, string> = {};
  // With the App's login unknown, any bot's add would pass for the App's, and a run never resumed would be taken as resumed.
  if (appLogin === null) return at;
  for (const event of events) {
    if (!("createdAt" in event) || event.label === null || !byAppOf(event.actor, appLogin)) continue;
    at[event.label.name] = event.createdAt;
  }
  return at;
}

/**
 * A GraphQL actor's login as REST and label events give it: a bot's with
 * `[bot]`, which GraphQL leaves off, and a deleted account's as `ghost`.
 */
export function loginOf(actor: { readonly login: string; readonly __typename: string } | null): string {
  if (actor === null) return "ghost";
  return actor.__typename === "Bot" && !actor.login.endsWith("[bot]") ? `${actor.login}[bot]` : actor.login;
}

/**
 * Whether this author is the Fabrik App, whose bot login is `appLogin`: its
 * slug with `[bot]`. A run that doesn't know the login (null), as the Kit
 * job, which only routes, doesn't, takes any bot for the App, which is how
 * the App's pending Audit routes to its Auditor run, and its pending Retro
 * to its Retro run. Every run that writes knows the login, so there only the
 * App's own issues count as its. So another bot's look-alike pending Audit
 * or Retro still costs one run, whose result the push job drops as stale
 * (src/loop/auditLanding.ts, src/loop/retroLanding.ts), or whose failure
 * changes nothing. Telling the Kit job the App's slug would take a
 * setup step, which #150 rules out. An Auditor run's inputs, which don't know
 * the login either, take the bot that opened their pending Audit for the App
 * (gatherAuditSliceFor).
 */
export function byAppOf(author: { readonly login: string; readonly __typename: string } | null, appLogin: string | null): boolean {
  if (author === null) return false;
  return appLogin === null ? author.__typename === "Bot" : loginOf(author) === appLogin;
}

/** A Ticket's agent branch and the PRs whose head it is, newest first (#536). */
const KEPT_BRANCH_QUERY = `
  query ($owner: String!, $name: String!, $ref: String!) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $ref) {
        target { oid }
        associatedPullRequests(states: [CLOSED, MERGED], first: 20, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { number merged }
        }
      }
    }
  }
`;

interface KeptBranchQueryResult {
  readonly repository: {
    readonly ref: {
      readonly target: { readonly oid: string };
      readonly associatedPullRequests: { readonly nodes: readonly { readonly number: number; readonly merged: boolean }[] };
    } | null;
  };
}

/**
 * A Ticket's Kept branch (#536): its agent branch on the remote now, with the
 * latest PR from it that closed unmerged, or null when the branch is gone.
 */
async function keptBranchOf(github: Pick<ReadClient, "graphql">, repo: Repo, ticket: number): Promise<KeptBranch | null> {
  const data = await github.graphql<KeptBranchQueryResult>(KEPT_BRANCH_QUERY, {
    owner: repo.owner,
    name: repo.name,
    ref: `refs/heads/${agentBranchFor(ticket)}`,
  });
  const ref = data.repository.ref;
  if (ref === null) return null;
  const closed = ref.associatedPullRequests.nodes.filter((pr) => !pr.merged).map((pr) => pr.number);
  return { head: ref.target.oid, pullRequest: closed.length === 0 ? null : Math.max(...closed) };
}

/** The Ticket's Kept branch while it's marked for a Kept-branch start; null, unread, when it isn't. */
async function keptBranchIfMarked(github: Pick<ReadClient, "graphql">, repo: Repo, ticket: number, labels: readonly string[]): Promise<KeptBranch | null> {
  return labels.includes(KEPT_BRANCH_LABEL) ? keptBranchOf(github, repo, ticket) : null;
}

/** The numbers of an issue's closing PRs in this state, lowest first. */
function pullRequestsIn(closedBy: { nodes: readonly { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] }, state: "OPEN" | "MERGED"): number[] {
  return closedBy.nodes.filter((pr) => pr.state === state).map((pr) => pr.number).sort((a, b) => a - b);
}

async function gatherIssue(github: ReadClient, repo: Repo, number: number, operator: string | null, appLogin: string | null): Promise<EventPart> {
  const data = await github.graphql<IssueQueryResult>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number });
  const issue = data.repository.issue;
  if (issue === null) {
    throw new Error(`Issue #${number} not found in ${repo.owner}/${repo.name}`);
  }
  const comments = issue.comments.nodes.map((comment) => ({
    id: Number(comment.fullDatabaseId),
    body: comment.body,
    createdAt: comment.createdAt,
    byApp: byAppOf(comment.author, appLogin),
  }));
  const timeline = issue.timelineItems.nodes;
  const thisSession = commentsSince(lastNeededDesignAt(timeline), comments);
  const labels = issue.labels.nodes.map((label) => label.name);
  const keptBranch = await keptBranchIfMarked(github, repo, issue.number, labels);
  return {
    issue: {
      number: issue.number,
      title: issue.title,
      open: issue.state === "OPEN",
      author: issue.author?.login ?? "ghost",
      byApp: byAppOf(issue.author, appLogin),
      body: issue.body,
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
      parentIssue: parentIssueOf(issue.parent),
      // A merged PR GitHub left its Ticket open after isn't open, so nothing resumes or declines it (#543).
      openPullRequests: pullRequestsIn(issue.closedByPullRequestsReferences, "OPEN"),
      mergedPullRequests: pullRequestsIn(issue.closedByPullRequestsReferences, "MERGED"),
      openAgentDrafts: issue.closedByPullRequestsReferences.nodes
        .filter(
          (pr) =>
            pr.isDraft &&
            isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" }) &&
            ticketOfAgentBranch(pr.headRefName) === issue.number,
        )
        .map((pr) => pr.number)
        .sort((a, b) => a - b),
      designRounds: designSessionOf(thisSession).designRounds,
      sentBack: designSessionOf(comments).sentBack,
      turnFailed: designTurnFailedIn(thisSession),
      firstTurnClaimed: firstTurnClaimed(timeline),
      // Every comment read counts for whether the reply that approved the request is still there, not only this session's.
      pendingPrototype: pendingPrototypeIn(thisSession, new Set(comments.map(({ id }) => id))),
      unansweredPrototypes: unansweredPrototypesIn(thisSession),
      landedNothing: countLandedNothing(comments),
      keptBranch,
      openBlockers: openIssueNumbersIn(repo, issue.blockedBy),
      openBlocking: openIssueNumbersIn(repo, issue.blocking),
    },
    pullRequest: null,
    dispatch: null,
    designQueue: null,
    // By default the Operator owns the Product repos they run Fabrik in.
    operator: operator ?? data.repository.owner.login,
  };
}

/**
 * The Operator's Request changes on a PR deferred while a Retry was in flight
 * (#427), as the Loop's snapshot reads them, for a Review's or a Retry's
 * inputs to leave out.
 */
export async function deferredChangesRequestsOn(github: ReadClient, repo: Repo, number: number, operator: string): Promise<readonly number[]> {
  return (await gatherPullRequest(github, repo, number, operator, null)).pullRequest?.deferredChangesRequests ?? [];
}

/**
 * What the push job takes from the Loop's snapshot of a PR to land its
 * Digest (src/github/digestGiven.ts), in the one read: the Operator's Request
 * changes deferred while a Retry was in flight, as deferredChangesRequestsOn
 * gives them, and its evidence marker, read only from a body a bot wrote
 * (byAppOf), so nobody else can name a route as captured.
 */
export async function digestSnapshotOn(
  github: ReadClient,
  repo: Repo,
  number: number,
  operator: string,
): Promise<Pick<PullRequestSnapshot, "deferredChangesRequests" | "uiEvidenceMarker">> {
  const { pullRequest } = await gatherPullRequest(github, repo, number, operator, null);
  return { deferredChangesRequests: pullRequest?.deferredChangesRequests ?? [], uiEvidenceMarker: pullRequest?.uiEvidenceMarker ?? null };
}

async function gatherPullRequest(
  github: ReadClient,
  repo: Repo,
  number: number,
  operator: string | null,
  appLogin: string | null,
): Promise<EventPart> {
  const data = await github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number,
  });
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) {
    throw new Error(`Pull request #${number} not found in ${repo.owner}/${repo.name}`);
  }
  return {
    issue: null,
    pullRequest: pullRequestSnapshotOf(await withEarlierComments(github, repo, pullRequest), appLogin, operator ?? data.repository.owner.login),
    dispatch: null,
    designQueue: null,
    operator: operator ?? data.repository.owner.login,
  };
}

/** What the PR query reads of one PR, which the conflict check's query reads of each open one too. */
type PullRequestNode = NonNullable<PullRequestQueryResult["repository"]["pullRequest"]>;

/** A PR as the core sees it, from what PULL_REQUEST_FIELDS read of it. */
function pullRequestSnapshotOf(pullRequest: PullRequestNode, appLogin: string | null, operator: string | null = null): PullRequestSnapshot {
  // A run's push note whose push never landed reads as no push at all, so the run stays in flight (#420).
  const fromBots = landedPushNotes(
    pullRequest.comments.nodes.filter((comment) => comment.author?.__typename === "Bot"),
    onBranchOf(pullRequest),
  );
  const botComments = fromBots.map((comment) => comment.body);
  // Every review still requesting changes, however old: GitHub lists a dismissed one no longer.
  const notDismissed = new Set(pullRequest.changesRequests.nodes.map(({ databaseId }) => databaseId));
  const history = historyOf(pullRequest, fromBots);
  const ticket = ticketOfAgentBranch(pullRequest.headRefName);
  const isAgent = isAgentPullRequest({ headRef: pullRequest.headRefName, authorIsBot: pullRequest.author?.__typename === "Bot" });
  return {
    number: pullRequest.number,
    isAgent,
    ticket,
    ticketLabels: ticketLabelsOf(pullRequest, ticket),
    ticketOpen: closedTicketOf(pullRequest, ticket)?.state === "OPEN",
    ticketLandedNothing: ticketLandedNothingOf(pullRequest, ticket, appLogin),
    open: pullRequest.state === "OPEN",
    draft: pullRequest.isDraft,
    headSha: pullRequest.headRefOid,
    labels: pullRequest.labels.nodes.map((label) => label.name),
    // Only a bot's markers count, so nobody can fake a Verdict or a Request-changes run by quoting one.
    verdicts: verdictsIn(botComments),
    requestChangesRun: requestChangesRunIn(botComments),
    conflictRun: conflictRunIn(botComments),
    conflictAttempts: conflictAttemptsIn(botComments),
    conflictRunInFlight: conflictRunInFlightIn(botComments),
    conflictRunOnUnreviewedDraft: conflictRunOnUnreviewedDraftIn(botComments),
    pushedSinceVerdict: pushedSinceVerdictIn(botComments),
    retryNoteSinceVerdict: retryNoteSinceVerdictIn(botComments),
    verdictPostedAt: verdictPostedAtIn(history),
    headPushedAt: headPushedAtOf(pullRequest, fromBots, isAgent),
    // Its head tells a passed draft whose gate has yet to open, where the Operator's Request changes counts (ADR-0022).
    ...requestChangesSinceRunIn(history, notDismissed, operator, pullRequest.headRefOid),
    leftDraftSinceVerdict: leftDraftSinceVerdictIn(history),
    url: pullRequest.url,
    // Only a body the App wrote counts, as for an issue's markers, so nobody else can mark a PR as UI.
    uiEvidenceMarker: byAppOf(pullRequest.author, appLogin) ? evidenceMarkerIn(pullRequest.body) : null,
    // Likewise, so nobody else can plant or hide the existing tests its runs changed (#463).
    changedTests: byAppOf(pullRequest.author, appLogin) ? changedTestsIn(pullRequest.body) : [],
    // Only a bot's comment whose first line is the Digest's marker, as for a Verdict: never a no-Digest line, and
    // never a person's quoting one. A collapsed Digest is read whole, as GitHub still returns it.
    digests: fromBots
      .filter((comment) => digestMarkIn(comment.body) !== null)
      .map(({ id, isMinimized, body, createdAt }) => ({ node: id, minimized: isMinimized, body, postedAt: createdAt })),
  };
}

/**
 * What tells whether an agent PR's Request changes have been built (#341):
 * the Kit's comments, the reviews, and its draft changes. The comments are the
 * latest thousand (withEarlierComments) and the draft changes the latest 100,
 * so a review from before the oldest one read of either, when there were
 * more, is left out: whatever
 * settled it, or found it out of draft, may be among those not read, and a
 * review taken for unbuilt would start a run for work long since built.
 */
function historyOf(pullRequest: PullRequestNode, fromBots: PullRequestNode["comments"]["nodes"]): PullRequestHistoryItem[] {
  const comments = fromBots.map(({ body, createdAt }): PullRequestHistoryItem => ({ kind: "bot-comment", at: createdAt, body }));
  const oldest = (connection: { pageInfo: { hasPreviousPage: boolean }; nodes: { createdAt?: string }[] }): string[] =>
    connection.pageInfo.hasPreviousPage ? connection.nodes.flatMap(({ createdAt }) => (createdAt === undefined ? [] : [createdAt])).slice(0, 1) : [];
  const window = [...oldest(pullRequest.comments), ...oldest(pullRequest.draftEvents)].sort().at(-1);
  const reviews = pullRequest.changesRequests.nodes.flatMap(({ databaseId, submittedAt, author }): PullRequestHistoryItem[] =>
    submittedAt === null || author === null || (window !== undefined && submittedAt < window)
      ? []
      : [{ kind: "changes-requested", at: submittedAt, review: databaseId, reviewer: author.login, reviewerIsBot: author.__typename === "Bot" }],
  );
  const drafts = pullRequest.draftEvents.nodes.flatMap(({ __typename, createdAt }): PullRequestHistoryItem[] =>
    createdAt === undefined ? [] : [{ kind: __typename === "ConvertToDraftEvent" ? "draft" : "ready", at: createdAt }],
  );
  return [...comments, ...reviews, ...drafts];
}

/** Whether a commit is on a PR's branch (OnBranch), from the latest commits the snapshot read of it. */
function onBranchOf(pullRequest: PullRequestNode): OnBranch {
  const read = new Set(pullRequest.commits.nodes.map(({ commit }) => commit.oid));
  return (sha) => (read.has(sha) || sha === pullRequest.headRefOid ? true : pullRequest.commits.pageInfo.hasPreviousPage ? null : false);
}

/**
 * When a PR's current head was pushed, as best its history tells (#389): the
 * latest of its last force push, the Kit's last note of a push of its own, its
 * opening by the Fabrik App, and its head commit's commit time. Each is no
 * later than that push, and GitHub's timeline records no event for a push that
 * isn't forced, so the latest of them is the nearest the snapshot can tell.
 * Null when none of them is known.
 */
function headPushedAtOf(pullRequest: PullRequestNode, fromBots: PullRequestNode["comments"]["nodes"], isAgent: boolean): string | null {
  const head = pullRequest.commits.nodes.at(-1)?.commit;
  const times = [
    ...pullRequest.forcePushes.nodes.map(({ createdAt }) => createdAt),
    ...fromBots.filter(({ body }) => isKitPushNote(body)).map(({ createdAt }) => createdAt),
    ...(isAgent ? [pullRequest.createdAt] : []),
    ...(head?.oid === pullRequest.headRefOid ? [head.committedDate] : []),
  ];
  return times.reduce<string | null>((latest, time) => (latest === null || Date.parse(time) > Date.parse(latest) ? time : latest), null);
}

/**
 * The labels of the Ticket a PR's agent branch names, read from the issues
 * its `Closes #n` links, or none when it links no such issue. The Ticket's
 * number stays the branch's: a closing link to another issue doesn't count.
 */
function ticketLabelsOf(pullRequest: PullRequestNode, ticket: number | null): string[] {
  return closedTicketOf(pullRequest, ticket)?.labels.nodes.map((label) => label.name) ?? [];
}

/**
 * How many empty diffs and Broken runs the Kit has recorded on that Ticket, read from its
 * comments as the Ticket's own snapshot reads them, so a Verdict on its PR
 * counts on from the Retries they used (#415). None when the PR doesn't link it.
 */
function ticketLandedNothingOf(pullRequest: PullRequestNode, ticket: number | null, appLogin: string | null): number {
  const comments = closedTicketOf(pullRequest, ticket)?.comments.nodes ?? [];
  return countLandedNothing(comments.map((comment) => ({ body: comment.body, byApp: byAppOf(comment.author, appLogin) })));
}

/** The issue among those a PR closes that is the Ticket its agent branch names, or undefined. */
function closedTicketOf(pullRequest: PullRequestNode, ticket: number | null): PullRequestNode["closingIssuesReferences"]["nodes"][number] | undefined {
  return pullRequest.closingIssuesReferences.nodes.find((issue) => issue.number === ticket);
}

/** How many times the conflict check reads open agent PRs while GitHub still works out whether one merges cleanly (#304). */
export const MERGEABLE_READS = 5;

/** How long it waits between those reads, in milliseconds: 12 seconds at most in all. */
export const MERGEABLE_WAIT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHub's word for whether a PR merges cleanly into the default branch. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Whether a PR merges cleanly, or null while GitHub is still working it out. */
export function mergeableOf(state: MergeableState): boolean | null {
  return state === "UNKNOWN" ? null : state === "MERGEABLE";
}

/**
 * Reads until what it reads is known, MERGEABLE_READS times at most, waiting
 * MERGEABLE_WAIT_MS between reads: GitHub works `mergeable` out in the
 * background once asked. The last read is returned either way.
 */
async function readUntilKnown<T>(read: () => Promise<T>, known: (value: T) => boolean, wait: (ms: number) => Promise<void>): Promise<T> {
  let value = await read();
  for (let attempt = 2; attempt <= MERGEABLE_READS && !known(value); attempt += 1) {
    await wait(MERGEABLE_WAIT_MS);
    value = await read();
  }
  return value;
}

// Pages through every open PR: agent PRs are often the newest, behind others' and bots' PRs.
const CONFLICTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { target { oid } }
      pullRequests(states: OPEN, first: 50, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PULL_REQUEST_FIELDS} mergeable }
      }
    }
  }
`;

interface ConflictsQueryResult {
  repository: {
    defaultBranchRef: { target: { oid: string } } | null;
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: (PullRequestNode & { mergeable: MergeableState })[];
    };
  };
}

/**
 * What the conflict check weighs (#304): the default branch's head and every
 * open agent PR with whether it merges cleanly into it, both as GitHub reads
 * them now. A push's own head isn't used: a check waits its turn behind the
 * tick and other pushes' checks (#341), so by the time it runs main may have
 * moved on, and `mergeable` is GitHub's against main as it is. GitHub works `mergeable` out in the background once asked,
 * so while any agent PR's is unknown, it reads again, MERGEABLE_READS times
 * at most; one still unknown after that is left for the scheduled tick.
 * With a token that can read workflow runs, through `actions`, it also reads
 * whether an Implement job is under way (#387); without one, that's unknown.
 */
async function gatherConflicts(
  github: Pick<ReadClient, "graphql">,
  actions: Pick<ReadClient, "rest"> | null,
  repo: Repo,
  now: string,
  appLogin: string | null,
  operator: string,
  wait: (ms: number) => Promise<void>,
): Promise<ConflictSnapshot> {
  type AgentNode = ConflictsQueryResult["repository"]["pullRequests"]["nodes"][number];
  const readAll = async () => {
    const agents: { node: AgentNode; mergeable: boolean | null }[] = [];
    let head: string | null = null;
    let after: string | null = null;
    do {
      const data: ConflictsQueryResult = await github.graphql<ConflictsQueryResult>(CONFLICTS_QUERY, { owner: repo.owner, name: repo.name, after });
      // Read with the page's mergeable states, so both are of the same main.
      if (after === null) head = data.repository.defaultBranchRef?.target.oid ?? null;
      const { pageInfo, nodes } = data.repository.pullRequests;
      agents.push(
        ...nodes.flatMap((node) =>
          pullRequestSnapshotOf(node, appLogin).isAgent ? [{ node, mergeable: mergeableOf(node.mergeable) }] : [],
        ),
      );
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after !== null);
    return { agents, head };
  };
  const { agents, head } = await readUntilKnown(readAll, (read) => read.agents.every(({ mergeable }) => mergeable !== null), wait);
  // Each agent PR's earlier comments are read once, after the last read.
  const pullRequests: ConflictCandidate[] = [];
  for (const { node, mergeable } of agents) {
    pullRequests.push({ pullRequest: pullRequestSnapshotOf(await withEarlierComments(github, repo, node), appLogin, operator), mergeable });
  }
  const implementJobUnderWay = actions === null ? null : await readImplementJobUnderWay(actions, repo);
  return { main: head, now, implementJobUnderWay, pullRequests };
}

const MERGEABLE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { target { oid } }
      pullRequest(number: $number) { mergeable }
    }
  }
`;

interface MergeableQueryResult {
  repository: {
    defaultBranchRef: { target: { oid: string } } | null;
    pullRequest: { mergeable: MergeableState } | null;
  };
}

/**
 * Whether one PR merges cleanly into the default branch, and that branch's
 * head, read together so both are of the same main (#480). While GitHub is
 * still working it out, it reads again, as the conflict check does,
 * MERGEABLE_READS times at most; one still unknown after that is unknown.
 */
async function gatherMergeable(github: Pick<ReadClient, "graphql">, repo: Repo, number: number, wait: (ms: number) => Promise<void>): Promise<MergeableSnapshot> {
  const read = async (): Promise<MergeableSnapshot> => {
    const data = await github.graphql<MergeableQueryResult>(MERGEABLE_QUERY, { owner: repo.owner, name: repo.name, number });
    return { main: data.repository.defaultBranchRef?.target.oid ?? null, mergeable: mergeableOf(data.repository.pullRequest?.mergeable ?? "UNKNOWN") };
  };
  return readUntilKnown(read, ({ mergeable }) => mergeable !== null, wait);
}

async function gatherDispatch(
  github: ReadClient,
  actions: ReadClient,
  repo: Repo,
  operator: string | null,
  appLogin: string | null,
): Promise<EventPart> {
  const [{ tickets, page }, runsInFlight, researchDecisions] = await Promise.all([
    gatherDispatchTickets(github, repo, appLogin),
    readRunsInFlight(actions, repo),
    gatherResearchDecisions(github, repo, appLogin),
  ]);
  const agentPullRequests = page.repository.pullRequests.nodes
    .filter((pr) => isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" }))
    .map((pr) => ({ number: pr.number, draft: pr.isDraft, ticket: ticketOfAgentBranch(pr.headRefName) }));
  const runs = dispatchedRunsOf(runsInFlight);
  return {
    issue: null,
    pullRequest: null,
    dispatch: {
      tickets,
      ...agentPullRequestsByGate(agentPullRequests),
      implementRunsInProgress: runs.implement,
      implementRunTickets: runs.implementTickets,
      implementRunsWithoutPullRequest: implementRunsWithoutPullRequestOf(runsInFlight, agentPullRequests).count,
      researchDecisions,
      researchRunsInProgress: runs.research,
    },
    designQueue: null,
    operator: operator ?? page.repository.owner.login,
  };
}

/**
 * What a Dispatch check weighs releasing, slots aside: every open
 * `ready-for-agent` issue and every open `wayfinder:research` issue. The
 * replay step lets them go first (src/loop/replayGate.ts).
 */
export async function gatherDispatchCandidates(
  github: ReadClient,
  repo: Repo,
  appLogin: string | null,
): Promise<Pick<DispatchSnapshot, "tickets" | "researchDecisions">> {
  const [{ tickets }, researchDecisions] = await Promise.all([gatherDispatchTickets(github, repo, appLogin), gatherResearchDecisions(github, repo, appLogin)]);
  return { tickets, researchDecisions };
}

/**
 * Every open `ready-for-agent` issue, its last Implement run's word read from
 * the Fabrik App's comments on it, and the query's last page, which also holds
 * the repo's open PRs and its owner.
 */
async function gatherDispatchTickets(github: ReadClient, repo: Repo, appLogin: string | null): Promise<{ tickets: TicketSnapshot[]; page: DispatchQueryResult }> {
  const tickets: TicketSnapshot[] = [];
  let after: string | null = null;
  let page: DispatchQueryResult;
  do {
    page = await github.graphql<DispatchQueryResult>(DISPATCH_QUERY, {
      owner: repo.owner,
      name: repo.name,
      after,
      ready: READY_FOR_AGENT,
    });
    for (const issue of page.repository.issues.nodes) {
      const labels = issue.labels.nodes.map((label) => label.name);
      // Read only for a marked Ticket, so Dispatch never releases one whose Kept branch is gone (#536).
      const kept = labels.includes(KEPT_BRANCH_LABEL) ? { keptBranch: await keptBranchOf(github, repo, issue.number) } : {};
      tickets.push({
        number: issue.number,
        open: issue.state === "OPEN",
        labels,
        openBlockers: issue.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.number),
        notPlannedBlockers: issue.blockedBy.nodes
          .filter((b) => b.state === "CLOSED" && b.stateReason === "NOT_PLANNED")
          .map((b) => b.number),
        subIssues: issue.subIssues.totalCount,
        openLinkedPullRequests: pullRequestsIn(issue.closedByPullRequestsReferences, "OPEN"),
        mergedLinkedPullRequests: pullRequestsIn(issue.closedByPullRequestsReferences, "MERGED"),
        lastRunFailed: implementRunFailedIn(
          issue.comments.nodes.map((comment) => ({ body: comment.body, byApp: byAppOf(comment.author, appLogin) })),
        ),
        ...kept,
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);
  return { tickets, page };
}

/**
 * Every open wayfinder:research issue, with what says whether the Researcher
 * may run on it (#154), its last run's word read from the comments of the
 * Fabrik App, whose bot login is `appLogin` (see byAppOf).
 */
async function gatherResearchDecisions(github: ReadClient, repo: Repo, appLogin: string | null): Promise<ResearchDecisionSnapshot[]> {
  const decisions: ResearchDecisionSnapshot[] = [];
  let after: string | null = null;
  do {
    const page: ResearchDecisionsQueryResult = await github.graphql<ResearchDecisionsQueryResult>(RESEARCH_DECISIONS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      after,
      research: RESEARCH_DECISION_LABEL,
    });
    for (const issue of page.repository.issues.nodes) {
      decisions.push({
        number: issue.number,
        open: issue.state === "OPEN",
        labels: issue.labels.nodes.map((label) => label.name),
        assignees: issue.assignees.nodes.map((assignee) => assignee.login),
        openBlockers: issue.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.number),
        parentIssue: parentIssueOf(issue.parent),
        // Only the App's own notice counts, so nobody, another bot included, can fake a failure or clear one.
        lastRunFailed: researchRunFailedIn(
          issue.comments.nodes.map((comment) => ({ body: comment.body, byApp: byAppOf(comment.author, appLogin) })),
        ),
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);
  return decisions;
}

/** A Design queue check's slice, and the repo's owner, the Operator unless one is named. */
async function gatherDesignQueue(
  github: ReadClient,
  actions: ReadClient | null,
  repo: Repo,
  operator: string | null,
  appLogin: string | null,
): Promise<EventPart> {
  const { designQueue, owner } = await gatherDesignQueueSlice(github, actions, repo, appLogin);
  return { issue: null, pullRequest: null, dispatch: null, designQueue, operator: operator ?? owner };
}

/**
 * The open needs-design issues with their slot-holding signals, and the
 * Design turns in progress: what the Design queue check decides on, and what
 * the Weekly summary's Held section counts. With a token that can read
 * workflow runs (the Design queue job's), the turns in progress are read from
 * their jobs. Without one, as on the scheduled tick's Design queue job (it
 * asks for no Actions permission) and the Weekly summary (its Product-repo
 * token can't read Actions), they are read from the issues instead, erring
 * toward holding a slot: see firstTurnClaimed. Its markers are read from the
 * comments of the Fabrik App, whose bot login is `appLogin` (see byAppOf).
 */
export async function gatherDesignQueueSlice(
  github: Pick<ReadClient, "graphql">,
  actions: Pick<ReadClient, "rest"> | null,
  repo: Repo,
  appLogin: string | null,
): Promise<{ readonly designQueue: DesignQueueSnapshot; readonly owner: string }> {
  const issues: DesignQueueIssue[] = [];
  const claimed: number[] = [];
  let after: string | null = null;
  let page: DesignQueueQueryResult;
  do {
    page = await github.graphql<DesignQueueQueryResult>(DESIGN_QUEUE_QUERY, {
      owner: repo.owner,
      name: repo.name,
      after,
      needsDesign: NEEDS_DESIGN,
    });
    for (const issue of page.repository.issues.nodes) {
      const comments = issue.comments.nodes.map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        byApp: byAppOf(comment.author, appLogin),
      }));
      const timeline = issue.timelineItems.nodes;
      const neededDesignAt = lastNeededDesignAt(timeline);
      const thisSession = commentsSince(neededDesignAt, comments);
      const session = designSessionOf(comments);
      if (firstTurnClaimed(timeline)) claimed.push(issue.number);
      issues.push({
        number: issue.number,
        labels: issue.labels.nodes.map((label) => label.name),
        designRounds: designSessionOf(thisSession).designRounds,
        turnFailed: designTurnFailedIn(thisSession),
        // A third empty diff or Broken run is the one that sent the Ticket back to design.
        redesign: session.sentBack !== null || countLandedNothing(comments) > MAX_RETRIES,
        // The latest time it got needs-design; an issue whose timeline doesn't show it waits from when it opened.
        neededDesignAt: neededDesignAt ?? issue.createdAt,
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);

  return {
    designQueue: {
      issues,
      designTurnsInProgress: actions === null ? claimed.sort((a, b) => a - b) : await designTurnsInProgress(actions, repo),
    },
    owner: page.repository.owner.login,
  };
}

/** The latest time an issue got needs-design, from its label timeline; null if it doesn't show it. */
function lastNeededDesignAt(timeline: readonly LabelTimelineItem[]): string | null {
  return timeline.filter((event) => isLabeled(event, NEEDS_DESIGN)).at(-1)?.createdAt ?? null;
}

/**
 * The comments posted since an issue last got needs-design: its current
 * Design session's. Adding needs-design starts a new session, so a round or
 * failure notice from one the Operator abandoned by taking the label off
 * doesn't count toward it.
 */
function commentsSince<C extends { readonly createdAt: string }>(neededDesignAt: string | null, comments: readonly C[]): readonly C[] {
  if (neededDesignAt === null) return comments;
  const start = Date.parse(neededDesignAt);
  return comments.filter((comment) => Date.parse(comment.createdAt) >= start);
}

function isLabeled(event: LabelTimelineItem, name: string): boolean {
  return event.__typename === "LabeledEvent" && event.label?.name === name;
}

/**
 * Whether the Kit took agent:design off since the issue last got
 * needs-design: the claim job does that as the session's first turn starts.
 * Read without the Actions API, it takes a first turn as still in progress
 * until its round or failure notice shows in the thread, so a check never
 * starts a second session in that gap. Only a bot taking it off counts.
 */
function firstTurnClaimed(timeline: readonly LabelTimelineItem[]): boolean {
  let claimed = false;
  for (const event of timeline) {
    if (isLabeled(event, NEEDS_DESIGN)) claimed = false;
    else if (event.__typename === "UnlabeledEvent" && event.label?.name === DESIGN_LABEL && event.actor?.__typename === "Bot") {
      claimed = true;
    }
  }
  return claimed;
}

/** Workflow-run statuses, short of completed, whose Implement job may still hold a slot. */
const UNFINISHED_RUNS = ["in_progress", "queued", "waiting", "pending", "requested"] as const;

/** A job of a workflow run not yet completed, as Actions lists it, with what it says of its run. */
export interface ActionsJob {
  /** The workflow run the job is in. */
  readonly run: number;
  /** That workflow run's attempt. */
  readonly attempt: number;
  /** When Actions created that workflow run, ISO 8601. */
  readonly createdAt: string;
  /** That workflow run's page. */
  readonly runUrl: string;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** When the job got a runner, ISO 8601; null while it has none. */
  readonly startedAt: string | null;
  /** The job's page, where its live log is. */
  readonly url: string;
  readonly steps: readonly ActionsStep[];
}

type Job = ActionsJob;

/**
 * The Implement and Research jobs under way, across every workflow run in the
 * repo. Each counts running, and also queued or waiting (behind its
 * concurrency group, say) after its claim took the trigger label off, so no
 * slot goes uncounted between the label coming off and the run starting. Each
 * counts on, once done, until its run's push job has landed it
 * (agentJobsUnderWay).
 * `implementTickets` names the Tickets their jobs' names name (#477), lowest
 * first, for the Weekly summary's Held (#476): a run of an earlier Kit
 * release names none.
 */
export async function countDispatchedRuns(github: Pick<ReadClient, "rest">, repo: Repo): Promise<DispatchedRuns> {
  return dispatchedRunsOf(await readRunsInFlight(github, repo));
}

/** The Implement and Research runs Dispatch counts in flight, from the runs in flight: each until its run's push job lands it, which the runs read has already reckoned (agentJobsUnderWay). */
export function dispatchedRunsOf(runs: readonly RunInFlightFact[]): DispatchedRuns {
  const implement = runs.filter(({ role }) => role === "implement");
  const research = runs.filter(({ role }) => role === "research").length;
  const named = implement.flatMap(({ issue }) => (issue === null ? [] : [issue]));
  return { implement: implement.length, research, implementTickets: [...new Set(named)].sort((a, b) => a - b) };
}

/**
 * The Implement runs in flight on their way to the Merge gate (#459): those
 * whose Ticket has no open agent PR, and those naming no Ticket, counted as
 * such since nothing shows they aren't. A run for a Ticket with an open agent
 * PR, a Retry, a Request-changes or a conflict run, is that PR's work, which
 * the PR already counts. `tickets` names those that name one, lowest first.
 */
export function implementRunsWithoutPullRequestOf(
  runs: readonly RunInFlightFact[],
  pullRequests: readonly { readonly ticket: number | null }[],
): { readonly count: number; readonly tickets: readonly number[] } {
  const withPullRequest = new Set(pullRequests.flatMap(({ ticket }) => (ticket === null ? [] : [ticket])));
  const onItsWay = runs.filter(({ role, issue }) => role === "implement" && (issue === null || !withPullRequest.has(issue)));
  const tickets = onItsWay.flatMap(({ issue }) => (issue === null ? [] : [issue]));
  return { count: onItsWay.length, tickets: [...new Set(tickets)].sort((a, b) => a - b) };
}

/** The kind of run a job's name says it is, where it says: a Retry, or a Design session's prototype turn. */
export type RunKind = "first" | "retry" | "request-changes" | "conflict-only" | "prototype";

/**
 * Where a run in flight is: behind its concurrency group (`blocked`), queued
 * for a runner, a Review waiting on the Required checks or re-running red
 * ones, running, or its agent job done while the run is still landing it.
 */
export type RunJob = "blocked" | "waiting-for-runner" | "waiting-on-checks" | "running" | "landing";

/**
 * A run in flight, as its job's name tells it (#606): its role, the issue or
 * pull request the name carries, a Digest job's always its pull request
 * (#655), or null where it carries none (a Triage,
 * Research, Audit or Retro job, a Review's wait for checks, and an Implement or
 * Review job an earlier release named for nothing), a Retry's number, and when
 * Actions created its workflow run.
 */
export interface RunInFlightFact {
  readonly role: AgentRole | "replay";
  readonly issue: number | null;
  readonly pullRequest: number | null;
  readonly retry: number | null;
  readonly kind: RunKind | null;
  readonly job: RunJob;
  /** When Actions created its workflow run, ISO 8601. */
  readonly createdAt: string;
  /** Whether it was read from the Kit job's closing line (#617), which names all the work it counts for, rather than from a job's name. */
  readonly exact: boolean;
  /** Its Actions run, and that run's attempt. */
  readonly run: number;
  readonly attempt: number;
  /** When its agent job got a runner, ISO 8601; null until it has. */
  readonly startedAt: string | null;
}

/** A run in flight as a job's name tells it, and the job that tells it. */
export interface RunByJobName {
  readonly fact: RunInFlightFact;
  readonly job: ActionsJob;
}

/**
 * The runs in flight across every workflow run in the repo not yet finished,
 * one per job the Loop names (#606): the one read Dispatch's count and the
 * stuck-trigger sweep share (runsByJobNamesOf). Throws when the Actions API
 * can't be read.
 */
export async function readRunsInFlight(github: Pick<ReadClient, "rest">, repo: Repo): Promise<RunInFlightFact[]> {
  return runsByJobNamesOf(await jobsOfUnfinishedRuns(github, repo)).map(({ fact }) => fact);
}

/**
 * The runs in flight these jobs' names tell, none of them exact, one per job
 * the Loop names (#606). A job its run skipped is no run, since its name is
 * never worked out. An Implement or Research job counts until its run's push
 * job has landed it, as Dispatch counts it (agentJobsUnderWay); a Review's wait
 * for checks only while it is under way, with no start, since its Review job
 * isn't listed yet; any other job while its run is unfinished, as the
 * stuck-trigger sweep counts it.
 */
export function runsByJobNamesOf(jobs: readonly ActionsJob[]): RunByJobName[] {
  const implement = new Set(implementJobsUnderWay(jobs));
  const research = new Set(researchJobsUnderWay(jobs));
  return jobs.flatMap((job): RunByJobName[] => {
    if (job.conclusion === "skipped") return [];
    const ran = {
      issue: null,
      pullRequest: null,
      retry: null,
      kind: null,
      job: jobOf(job),
      createdAt: job.createdAt,
      exact: false,
      run: job.run,
      attempt: job.attempt,
      startedAt: job.startedAt,
    } as const;
    const fact = (fact: RunInFlightFact): RunByJobName[] => [{ fact, job }];
    const implementName = IMPLEMENT_JOB.exec(job.name);
    if (implementName !== null) {
      if (!implement.has(job)) return [];
      const retry = implementName[2] === undefined ? null : Number(implementName[2]);
      return fact({ ...ran, role: "implement", issue: numberOrNull(implementName[1]), retry, kind: retry === null ? null : "retry" });
    }
    const reviewName = REVIEW_JOB.exec(job.name);
    if (reviewName !== null) return fact({ ...ran, role: "review", pullRequest: numberOrNull(reviewName[1]) });
    if ([REVIEW_CHECKS_JOB_NAME, RERUN_CHECKS_JOB_NAME, RERUN_WAIT_JOB_NAME].some((name) => isJobNamed(job.name, name))) {
      return job.status === "completed" ? [] : fact({ ...ran, role: "review", job: "waiting-on-checks", startedAt: null });
    }
    // A Digest job's name always carries its pull request's number, and never its Ticket's (#655).
    const digestName = DIGEST_JOB.exec(job.name);
    if (digestName !== null) return fact({ ...ran, role: "digest", pullRequest: numberOrNull(digestName[1]) });
    const designName = DESIGN_JOB.exec(job.name);
    if (designName !== null) {
      const prototype = isJobNamed(job.name.replace(/ #[0-9]+$/, ""), PROTOTYPE_JOB_NAME);
      return fact({ ...ran, role: "design", issue: numberOrNull(designName[1]), kind: prototype ? "prototype" : null });
    }
    const unnumbered = UNNUMBERED_JOBS.find(([name]) => isJobNamed(job.name, name));
    if (unnumbered === undefined) return [];
    if (unnumbered[1] === "research" && !research.has(job)) return [];
    return fact({ ...ran, role: unnumbered[1] });
  });
}

/** The jobs whose names carry no number, by role. */
const UNNUMBERED_JOBS: readonly (readonly [string, AgentRole])[] = [
  [TRIAGE_JOB_NAME, "triage"],
  [RESEARCH_JOB_NAME, "research"],
  [AUDIT_JOB_NAME, "audit"],
  [RETRO_JOB_NAME, "retro"],
];

/** Where a job is, from its status: done is landing. The runs read (src/read/runs.ts) tells an agent job's by it too. */
export function jobOf({ status }: Job): RunJob {
  if (status === "completed") return "landing";
  if (status === "in_progress") return "running";
  return status === "queued" ? "waiting-for-runner" : "blocked";
}

function numberOrNull(digits: string | undefined): number | null {
  return digits === undefined ? null : Number(digits);
}

/** The Implement and Research runs a Dispatch check counts in flight, and the Tickets the Implement runs name. */
export interface DispatchedRuns {
  readonly implement: number;
  readonly research: number;
  readonly implementTickets: readonly number[];
}

/**
 * The one reading of an Implement or Research job under way, which Dispatch,
 * the runs read, the stall check and the stuck-trigger sweep share (#432,
 * #500): one in a workflow run not yet finished that its run didn't skip,
 * until that run's push job has landed it, whatever its conclusion. That
 * takes in one waiting, queued or running, and also one that's done while
 * its push job is still to land its work or post its failure notice: between
 * the claim taking the label off and the push job landing, the run is all
 * that shows the work taken. Once the push job is done, what it landed shows
 * it, or nothing will, and the same run's Dispatch job, which follows the
 * push job, doesn't count it twice. GitHub doesn't list a job still waiting
 * on its `needs` until those jobs finish, but an Implement or Research job
 * needs only the Kit job, which its run's claim needs too.
 */
function agentJobsUnderWay(jobs: readonly Job[], isAgentJob: (name: string) => boolean): Job[] {
  const landed = new Set(jobs.filter(({ name, status }) => status === "completed" && isJobNamed(name, PUSH_JOB_NAME)).map(({ run }) => run));
  return jobs.filter(({ run, name, conclusion }) => conclusion !== "skipped" && isAgentJob(name) && !landed.has(run));
}

/** The Implement jobs under way (agentJobsUnderWay). */
function implementJobsUnderWay(jobs: readonly Job[]): Job[] {
  return agentJobsUnderWay(jobs, (name) => IMPLEMENT_JOB.test(name));
}

/** The Research jobs under way, as an Implement job is (agentJobsUnderWay). */
function researchJobsUnderWay(jobs: readonly Job[]): Job[] {
  return agentJobsUnderWay(jobs, (name) => isJobNamed(name, RESEARCH_JOB_NAME));
}

/** Whether a job's name is `jobName`, or `<caller job> / <jobName>` when a Product repo's caller workflow ran it. */
export function isJobNamed(name: string, jobName: string): boolean {
  return name === jobName || name.endsWith(` / ${jobName}`);
}

/**
 * Whether a job's name is that of the agent job a route to `role` starts: an
 * Implement or Review job, named for its work or not, a Digest job, a
 * Design-session or prototype turn, or a Triage, Audit, Retro or Research job. Never asked of a
 * skipped job, whose name is never worked out.
 */
export function isAgentJobNamed(role: AgentRole, name: string): boolean {
  switch (role) {
    case "implement":
      return IMPLEMENT_JOB.test(name);
    case "review":
      return REVIEW_JOB.test(name);
    case "digest":
      return DIGEST_JOB.test(name);
    case "design":
      return DESIGN_JOB.test(name);
    default:
      return UNNUMBERED_JOBS.some(([jobName, jobRole]) => jobRole === role && isJobNamed(name, jobName));
  }
}

/**
 * An Implement job's name, and a Review job's, as a caller workflow shows it or
 * not: named for what it runs on (#477), or for nothing, as a run of an earlier
 * Kit release still in flight names it.
 */
const IMPLEMENT_JOB = new RegExp(`^(?:.+ / )?${IMPLEMENT_JOB_NAME}(?: #([1-9][0-9]*)(?: \\(Retry ([1-9][0-9]*)\\))?)?$`);
const REVIEW_JOB = new RegExp(`^(?:.+ / )?${REVIEW_JOB_NAME}(?: PR #([1-9][0-9]*))?$`);

/** A Digest job's name, as a caller workflow shows it or not: always named for its pull request, since no release ran one unnamed. */
const DIGEST_JOB = new RegExp(`^(?:.+ / )?${DIGEST_JOB_NAME} PR #([1-9][0-9]*)$`);

/**
 * Whether an Implement job is under way anywhere in the repo (#387), as
 * Dispatch reads it (implementJobsUnderWay). Null when the Actions API
 * couldn't be read, so a failed read only leaves a stalled run alone, never
 * the rest of the conflict check.
 */
async function readImplementJobUnderWay(github: Pick<ReadClient, "rest">, repo: Repo): Promise<boolean | null> {
  try {
    return implementJobsUnderWay(await jobsOfUnfinishedRuns(github, repo)).length > 0;
  } catch {
    return null;
  }
}

const DESIGN_JOB = new RegExp(`^(?:.+ / )?(?:${DESIGN_JOB_NAME}|${PROTOTYPE_JOB_NAME}) #([1-9][0-9]*)$`);

/**
 * The issue of each Design-session turn not yet finished, across every
 * workflow run in the repo, read from its job's name, lowest number first. A
 * turn is in progress until its whole run finishes: running, queued or
 * waiting behind its issue's concurrency group, and also after its job is
 * done while the push job is still posting its round or failure notice, so no
 * slot goes uncounted before the thread shows it. A prototype turn counts as
 * its session's turn, so a session whose first turn only asked for a
 * Prototype, and so has no round yet, keeps its slot while it builds. A
 * Design or prototype job skipped because the run went another way is no turn.
 */
export async function designTurnsInProgress(github: Pick<ReadClient, "rest">, repo: Repo): Promise<number[]> {
  const jobs = await jobsOfUnfinishedRuns(github, repo);
  const issues = new Set(
    jobs
      .filter((job) => job.conclusion !== "skipped")
      .flatMap((job) => DESIGN_JOB.exec(job.name)?.[1] ?? [])
      .map(Number),
  );
  return [...issues].sort((a, b) => a - b);
}

/**
 * What the stuck-trigger sweep weighs on the scheduled tick (#419): which
 * roles have a job under way, and then each trigger label on an open issue or
 * PR. Without a token that can read workflow runs, or when the Actions API
 * fails, neither: the sweep then leaves every label alone.
 */
async function gatherTriggerSweep(
  github: Pick<ReadClient, "graphql">,
  actions: Pick<ReadClient, "rest"> | null,
  repo: Repo,
  appLogin: string | null,
): Promise<TriggerSweepSnapshot> {
  const underWay = actions === null ? null : await readRolesUnderWay(actions, repo);
  if (underWay === null) return { underWay: null, labelled: [] };
  const [issues, pullRequests] = await Promise.all([
    gatherLabelledTriggers(github, repo, "issues", appLogin),
    gatherLabelledTriggers(github, repo, "pullRequests", appLogin),
  ]);
  return { underWay, labelled: [...issues, ...pullRequests] };
}

/**
 * Which roles have a job under way, across every workflow run in the repo
 * not yet finished, a job its run skipped aside, and an Implement or Research
 * job as Dispatch reads it (agentJobsUnderWay); null when the Actions API
 * couldn't be read.
 */
async function readRolesUnderWay(github: Pick<ReadClient, "rest">, repo: Repo): Promise<RolesUnderWay | null> {
  let jobs: Job[];
  try {
    jobs = (await jobsOfUnfinishedRuns(github, repo)).filter(({ conclusion }) => conclusion !== "skipped");
  } catch {
    return null;
  }
  const anyJobNamed = (...names: string[]) => jobs.some(({ name }) => names.some((jobName) => isJobNamed(name, jobName)));
  const anyReviewJob = jobs.some(({ name }) => REVIEW_JOB.test(name));
  const designTurns = new Set(jobs.flatMap((job) => DESIGN_JOB.exec(job.name)?.[1] ?? []).map(Number));
  // A Digest job's name always carries its pull request's number, so the sweep reads exactly whether one is under way there.
  const digests = new Set(jobs.flatMap((job) => DIGEST_JOB.exec(job.name)?.[1] ?? []).map(Number));
  return {
    implement: implementJobsUnderWay(jobs).length > 0,
    research: researchJobsUnderWay(jobs).length > 0,
    review: anyReviewJob || anyJobNamed(REVIEW_CHECKS_JOB_NAME),
    claim: anyJobNamed(CLAIM_JOB_NAME),
    designTurns: [...designTurns].sort((a, b) => a - b),
    digests: [...digests].sort((a, b) => a - b),
  };
}

function labelledTriggersQuery(kind: "issues" | "pullRequests"): string {
  return `
    query ($owner: String!, $name: String!, $triggers: [String!]!, $after: String) {
      repository(owner: $owner, name: $name) {
        ${kind}(states: OPEN, labels: $triggers, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { number labels(first: 100) { nodes { name } } ${TRIGGER_TIMELINE} }
        }
      }
    }
  `;
}

type LabelledTriggersQueryResult = {
  repository: Record<
    "issues" | "pullRequests",
    {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { number: number; labels: { nodes: { name: string }[] }; timelineItems: { nodes: TriggerTimelineItem[] } }[];
    }
  >;
};

/**
 * Each trigger label on an open issue, or an open PR, one entry per label,
 * with when it was last added and whether the Kit's re-add came after it last
 * came off. Only the Fabrik App's comments count as the Kit's word.
 */
async function gatherLabelledTriggers(
  github: Pick<ReadClient, "graphql">,
  repo: Repo,
  kind: "issues" | "pullRequests",
  appLogin: string | null,
): Promise<LabelledTrigger[]> {
  const labelled: LabelledTrigger[] = [];
  let after: string | null = null;
  do {
    const page: LabelledTriggersQueryResult = await github.graphql<LabelledTriggersQueryResult>(labelledTriggersQuery(kind), {
      owner: repo.owner,
      name: repo.name,
      triggers: [...TRIGGER_LABELS],
      after,
    });
    const items = page.repository[kind];
    for (const node of items.nodes) {
      const history = triggerHistoryOf(node.timelineItems.nodes, appLogin);
      const on = node.labels.nodes.map(({ name }) => name);
      for (const label of TRIGGER_LABELS.filter((trigger) => on.includes(trigger))) {
        labelled.push({ number: node.number, label, lastAddedAt: lastAddedAtIn(history, label), readded: stuckTriggerReaddedIn(history, label) });
      }
    }
    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (after !== null);
  return labelled;
}

/** A timeline, oldest first, as the stuck-trigger readers take it: label events, and the Fabrik App's comments alone. */
function triggerHistoryOf(items: readonly TriggerTimelineItem[], appLogin: string | null): TriggerHistoryEntry[] {
  return items.flatMap((item): TriggerHistoryEntry[] => {
    if (item.__typename === "IssueComment") return byAppOf(item.author, appLogin) ? [{ kind: "kit-comment", body: item.body }] : [];
    if (item.label === null) return [];
    return [{ kind: item.__typename === "LabeledEvent" ? "labeled" : "unlabeled", label: item.label.name, at: item.createdAt }];
  });
}

interface ListedWorkflowRun {
  readonly id: number;
  readonly created_at: string;
  readonly run_attempt?: number;
  readonly html_url?: string;
}

interface ListedJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly started_at?: string | null;
  readonly html_url?: string | null;
  readonly steps?: readonly { readonly name: string; readonly status: string; readonly conclusion?: string | null }[];
}

/**
 * Every job, finished or not, of every workflow run not yet completed, each
 * with its steps: one listing per unfinished status, then one of each run's
 * jobs. A job has a start only once it is in progress or done, since Actions
 * gives a queued job one too. Throws when the Actions API can't be read.
 */
export async function jobsOfUnfinishedRuns(github: Pick<ReadClient, "rest">, repo: Repo): Promise<ActionsJob[]> {
  const base = `/repos/${repo.owner}/${repo.name}/actions`;
  const runs = new Map<number, ListedWorkflowRun>();
  for (const status of UNFINISHED_RUNS) {
    const page = (await github.rest("GET", `${base}/runs?status=${status}&per_page=100`)) as { workflow_runs: ListedWorkflowRun[] };
    for (const run of page.workflow_runs) runs.set(run.id, run);
  }
  const jobs: ActionsJob[] = [];
  for (const [id, run] of runs) {
    const page = (await github.rest("GET", `${base}/runs/${id}/jobs?filter=latest&per_page=100`)) as { jobs: ListedJob[] };
    const runUrl = run.html_url ?? `https://github.com/${repo.owner}/${repo.name}/actions/runs/${id}`;
    jobs.push(
      ...page.jobs.map((job) => ({
        run: id,
        attempt: run.run_attempt ?? 1,
        createdAt: run.created_at,
        runUrl,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion ?? null,
        startedAt: job.status === "in_progress" || job.status === "completed" ? (job.started_at ?? null) : null,
        url: job.html_url ?? runUrl,
        steps: (job.steps ?? []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion ?? null })),
      })),
    );
  }
  return jobs;
}

/** Reads the Kit config folder's files from the Product repo at `ref`, through the API. */
export async function readKitConfigSources(
  github: Pick<ReadClient, "fileText">,
  repo: Repo,
  ref: string,
): Promise<KitConfigSources> {
  const [config, skillsLock, ...instructions] = await Promise.all([
    github.fileText(repo, KIT_CONFIG_PATH, ref),
    github.fileText(repo, SKILLS_SOURCES_LOCK_PATH, ref),
    ...INSTRUCTED_ROLES.map((role) => github.fileText(repo, instructionsPath(role), ref)),
  ]);
  return {
    config: config ?? null,
    skillsLock: skillsLock ?? null,
    instructions: Object.fromEntries(INSTRUCTED_ROLES.map((role, i) => [role, instructions[i] ?? null])),
  };
}
