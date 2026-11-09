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
import { isOperatorsReplay } from "../kit/replay.ts";
import { newestWeeklyLimits } from "../kit/replayFacts.ts";
import { storeIsPrivate } from "../kit/runStore.ts";
import { isAgentPullRequest, ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { parseAuditOutput } from "../loop/auditOutput.ts";
import { heldRunsIn } from "../loop/heldRun.ts";
import { makesUnusable } from "../loop/subscriptions.ts";
import {
  AUDIT_LABEL,
  DESIGN_LABEL,
  KIT_ISSUE_LABELS,
  MAP_LABEL,
  NEEDS_DESIGN,
  READY_FOR_AGENT,
  REPLAY_LABEL,
  REPLAY_TRIGGER_LABEL,
  RESEARCH_DECISION_LABEL,
  RETRO_LABEL,
  TRIGGER_LABELS,
  WEEKLY_LIMIT_LABEL,
} from "../loop/labels.ts";
import { escapeMarkerIn } from "../loop/markers.ts";
import { retroWindowStart } from "../loop/retro.ts";
import { MAX_RETRIES } from "../loop/retry.ts";
import type {
  AuditSnapshot,
  ConflictCandidate,
  ConflictSnapshot,
  DesignQueueIssue,
  DesignQueueSnapshot,
  DispatchSnapshot,
  HeldTargetSnapshot,
  KitIssueSnapshot,
  LabelledTrigger,
  LoopEvent,
  NamedPullRequestSnapshot,
  ParentIssueSnapshot,
  PullRequestSnapshot,
  ReplayIssueSnapshot,
  ReplaySnapshot,
  ResearchDecisionSnapshot,
  RetroSnapshot,
  RolesUnderWay,
  Snapshot,
  SpecSnapshot,
  StartingComment,
  TicketSnapshot,
  TriggerSweepSnapshot,
  WeeklyIssueSnapshot,
} from "../loop/types.ts";
import { type GitHub, pagesOf, type Repo } from "./client.ts";
import { gatherReplayAcceptance, type ReplayStore } from "./replaySlice.ts";
import {
  countEmptyDiffs,
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
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number isDraft headRefName author { __typename } } }
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
      closedByPullRequestsReferences: { nodes: { number: number; isDraft: boolean; headRefName: string; author: { __typename: string } | null }[] };
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

const PULL_REQUEST_COMMENTS = "pageInfo { hasPreviousPage startCursor } nodes { body createdAt author { __typename } }";

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
  nodes: { body: string; createdAt: string; author: { __typename: string } | null }[];
}

const DEFAULT_BRANCH_HEAD_QUERY = `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { target { oid } }
    }
  }
`;

/** The default branch's head, a full sha, or null when it has none. */
export async function defaultBranchHead(github: Pick<GitHub, "graphql">, repo: Repo): Promise<string | null> {
  const data = await github.graphql<{ repository: { defaultBranchRef: { target: { oid: string } } | null } }>(DEFAULT_BRANCH_HEAD_QUERY, {
    owner: repo.owner,
    name: repo.name,
  });
  return data.repository.defaultBranchRef?.target.oid ?? null;
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
  github: Pick<GitHub, "graphql">,
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
        nodes { isDraft headRefName author { __typename } }
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
    pullRequests: { nodes: { isDraft: boolean; headRefName: string; author: { __typename: string } | null }[] };
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
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  appLogin: string | null,
  actions: GitHub | null = null,
  store: Pick<GitHub, "rest"> | null = null,
  replayStore: ReplayStore | null = null,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Snapshot> {
  const [{ owner, kitIssues }, part, startingComment, audit, namedPullRequests] = await Promise.all([
    gatherKitIssues(github, repo, appLogin),
    gatherEventPart(github, repo, event, operator, appLogin, actions),
    gatherStartingComment(github, repo, event),
    event.kind === "scheduled-tick" ? gatherAuditSlice(github, repo, appLogin) : null,
    event.kind === "audit-run-finished" ? gatherNamedPullRequests(github, repo, event.output) : null,
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
  const held = freesASubscription ? await gatherHeld(github, repo, kitIssues, appLogin) : null;
  const triggers = event.kind === "scheduled-tick" ? await gatherTriggerSweep(github, actions, repo, appLogin) : null;
  // A push to the default branch may leave an agent PR conflicting with it; the tick catches any the push missed (#304).
  const conflicts =
    event.kind === "main-pushed" || event.kind === "kit-config-changed"
      ? await gatherConflicts(github, actions, repo, new Date().toISOString(), appLogin, operator ?? owner, wait)
      : event.kind === "scheduled-tick"
        ? await gatherConflicts(github, actions, repo, event.now, appLogin, operator ?? owner, wait)
        : null;
  // By default the Operator owns the Product repos they run Fabrik in.
  const theOperator = part?.operator ?? operator ?? owner;
  const retro = event.kind === "scheduled-tick" ? await gatherRetroSlice(github, repo, event.now, theOperator, appLogin, store) : null;
  const replay =
    event.kind === "scheduled-tick" && replayStore !== null
      ? await gatherReplaySlice(github, repo, event.now, kitIssues, theOperator, appLogin, replayStore)
      : // A replay Ticket's claim weighs every open replay issue, since one replay Ticket runs at a time across them all.
        event.kind === "label-added" && event.label === REPLAY_TRIGGER_LABEL
        ? { issues: await gatherReplayIssues(github, repo, appLogin), capacity: null, acceptance: null }
        : null;
  return part === null
    ? { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec, operator: theOperator, kitIssues, startingComment, audit, retro, replay, namedPullRequests, held, openMaps, conflicts, triggers }
    : { ...part, spec, kitIssues, startingComment, audit, retro, replay, namedPullRequests, held, openMaps, conflicts, triggers };
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
async function gatherAuditSlice(github: Pick<GitHub, "graphql">, repo: Repo, appLogin: string | null): Promise<AuditSnapshot> {
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
export async function gatherAuditSliceFor(github: Pick<GitHub, "graphql">, repo: Repo, pending: number): Promise<AuditSnapshot> {
  const data = await queryWeeklyIssues(github, repo, AUDIT_LABEL);
  const opener = data.repository.issues.nodes.find((issue) => issue.number === pending)?.author ?? null;
  return auditSliceOf(data, opener?.__typename === "Bot" ? loginOf(opener) : null);
}

function queryWeeklyIssues(github: Pick<GitHub, "graphql">, repo: Repo, label: string): Promise<WeeklyIssuesQueryResult> {
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
  github: Pick<GitHub, "graphql">,
  repo: Repo,
  now: string,
  operator: string,
  appLogin: string | null,
  store: Pick<GitHub, "rest"> | null,
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
async function agentPullRequestClosedSince(github: Pick<GitHub, "graphql">, repo: Repo, since: number): Promise<boolean> {
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
async function escapeFiledSince(github: Pick<GitHub, "graphql">, repo: Repo, operator: string, since: number): Promise<boolean> {
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
  merged: boolean;
  head: { ref: string };
  user: { type: string } | null;
}

/**
 * For an Audit run finishing: each PR its reply names under "Introduced by",
 * once. A number GitHub has no PR for is left out, and a reply that breaks
 * its contract names none, since the core fails its Audit.
 */
async function gatherNamedPullRequests(github: GitHub, repo: Repo, output: string): Promise<NamedPullRequestSnapshot[]> {
  const parsed = parseAuditOutput(output);
  const named = parsed.ok ? [...new Set(parsed.output.candidates.flatMap((candidate) => candidate.introducedBy))] : [];
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
            merged: pull.merged,
            headRef: pull.head.ref,
            isAgent: isAgentPullRequest({ headRef: pull.head.ref, authorIsBot: pull.user?.type === "Bot" }),
          },
        ],
  );
}

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
export async function gatherOpenMaps(github: Pick<GitHub, "graphql">, repo: Repo): Promise<OpenMap[]> {
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
async function gatherStartingComment(github: GitHub, repo: Repo, event: LoopEvent): Promise<StartingComment | null> {
  const id = event.kind === "agent-run-finished" ? event.startedBy : event.kind === "prototype-run-finished" ? event.request.reply : null;
  if (id === undefined || id === null) return null;
  const comment = await github.rest("GET", `/repos/${repo.owner}/${repo.name}/issues/comments/${id}`, undefined, {
    allowNotFound: true,
  });
  return { id, exists: comment !== null };
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

async function gatherSpec(github: GitHub, repo: Repo, number: number): Promise<SpecSnapshot | null> {
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
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  appLogin: string | null,
  actions: GitHub | null,
): Promise<EventPart | null> {
  switch (event.kind) {
    case "pull-request-pushed":
    case "pull-request-labeled":
    case "required-checks-finished":
    case "review-run-finished":
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
  "kitIssues" | "spec" | "startingComment" | "audit" | "retro" | "replay" | "namedPullRequests" | "held" | "openMaps" | "conflicts" | "triggers"
>;

const KIT_ISSUE_COMMENTS = "pageInfo { hasPreviousPage startCursor } nodes { body author { login __typename } }";

/** How many open Kit-owned issues every snapshot reads, oldest first: an issue past them isn't read. */
const KIT_ISSUES_PAGE = 20;

const KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: $labels, first: ${KIT_ISSUES_PAGE}, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes {
          number
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
  nodes: { body: string; author: Actor }[];
}

interface KitIssuesQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      nodes: { number: number; body: string; author: Actor; labels: { nodes: { name: string }[] }; comments: KitIssueComments }[];
    };
  };
}

/**
 * The open issues carrying a Kit-owned label (src/loop/kitIssues.ts), which
 * every event's snapshot holds. Their markers steer agent runs (a held marker
 * resumes one), so only the App's own text is read (ADR-0007): the body of an
 * issue the App opened, and the App's comments, every one of them, however
 * many pages they take. Anyone else's comment is left out. The Weekly summary
 * reads them too (src/github/facts.ts), so its Held runs are the Loop's.
 */
export async function gatherKitIssues(
  github: Pick<GitHub, "graphql">,
  repo: Repo,
  appLogin: string | null,
): Promise<{ owner: string; kitIssues: KitIssueSnapshot[] }> {
  const data = await github.graphql<KitIssuesQueryResult>(KIT_ISSUES_QUERY, {
    owner: repo.owner,
    name: repo.name,
    labels: KIT_ISSUE_LABELS,
  });
  const kitIssues = await Promise.all(
    data.repository.issues.nodes.map(async (issue): Promise<KitIssueSnapshot> => {
      const comments = [...(await earlierComments(github, repo, issue.number, issue.comments)), ...issue.comments.nodes];
      return {
        number: issue.number,
        labels: issue.labels.nodes.map((label) => label.name),
        body: byAppOf(issue.author, appLogin) ? issue.body : "",
        comments: comments.filter((comment) => byAppOf(comment.author, appLogin)).map((comment) => comment.body),
      };
    }),
  );
  return { owner: data.repository.owner.login, kitIssues };
}

/** The comments before this page, oldest first. */
async function earlierComments(
  github: Pick<GitHub, "graphql">,
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
 * issues, it reads nothing new, unless that page is full, since one may be
 * past it. Else it reads every open replay issue: its body whole, though the
 * Operator files it, since the request is the Operator's own text, which the
 * Kit-owned issues leave out (ADR-0007), and the App's comments alone. Only
 * while one is the Operator's does it read what the spare-capacity gate
 * weighs, the Tickets and research Decisions Dispatch weighs and the store's
 * newest weekly-limit reading on each Subscription, and, while a valid
 * request waits, what accepting it weighs (src/github/replaySlice.ts).
 */
async function gatherReplaySlice(
  github: GitHub,
  repo: Repo,
  now: string,
  kitIssues: readonly KitIssueSnapshot[],
  operator: string,
  appLogin: string | null,
  store: ReplayStore,
): Promise<ReplaySnapshot> {
  const maybeOpen = kitIssues.length >= KIT_ISSUES_PAGE || kitIssues.some((issue) => issue.labels.includes(REPLAY_LABEL));
  if (!maybeOpen) return { issues: [], capacity: null, acceptance: null };
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
async function gatherReplayIssues(github: GitHub, repo: Repo, appLogin: string | null): Promise<ReplayIssueSnapshot[]> {
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
}

const HELD_TARGET_FIELDS = "__typename number state body author { login __typename } labels(first: 100) { nodes { name } }";

/**
 * Each issue or PR a held marker on an open weekly-limit issue names, once,
 * to tell a held run still in the state it was held in from one that has
 * moved on as it resumes (src/loop/resume.ts). A number naming nothing
 * GitHub has is left out.
 */
async function gatherHeld(
  github: GitHub,
  repo: Repo,
  kitIssues: readonly KitIssueSnapshot[],
  appLogin: string | null,
): Promise<HeldTargetSnapshot[]> {
  const numbers = [
    ...new Set(
      kitIssues
        .filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL))
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
      },
    ];
  });
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

async function gatherIssue(github: GitHub, repo: Repo, number: number, operator: string | null, appLogin: string | null): Promise<EventPart> {
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
      openPullRequests: issue.closedByPullRequestsReferences.nodes.map((pr) => pr.number).sort((a, b) => a - b),
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
      emptyDiffs: countEmptyDiffs(comments),
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
export async function deferredChangesRequestsOn(github: GitHub, repo: Repo, number: number, operator: string): Promise<readonly number[]> {
  return (await gatherPullRequest(github, repo, number, operator, null)).pullRequest?.deferredChangesRequests ?? [];
}

async function gatherPullRequest(
  github: GitHub,
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
  const standing = new Set(pullRequest.changesRequests.nodes.map(({ databaseId }) => databaseId));
  const history = historyOf(pullRequest, fromBots);
  const ticket = ticketOfAgentBranch(pullRequest.headRefName);
  const isAgent = isAgentPullRequest({ headRef: pullRequest.headRefName, authorIsBot: pullRequest.author?.__typename === "Bot" });
  return {
    number: pullRequest.number,
    isAgent,
    ticket,
    ticketLabels: ticketLabelsOf(pullRequest, ticket),
    ticketOpen: closedTicketOf(pullRequest, ticket)?.state === "OPEN",
    ticketEmptyDiffs: ticketEmptyDiffsOf(pullRequest, ticket, appLogin),
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
    ...requestChangesSinceRunIn(history, standing, operator),
    leftDraftSinceVerdict: leftDraftSinceVerdictIn(history),
    url: pullRequest.url,
    // Only a body the App wrote counts, as for an issue's markers, so nobody else can mark a PR as UI.
    uiEvidenceMarker: byAppOf(pullRequest.author, appLogin) ? evidenceMarkerIn(pullRequest.body) : null,
    // Likewise, so nobody else can plant or hide the existing tests its runs changed (#463).
    changedTests: byAppOf(pullRequest.author, appLogin) ? changedTestsIn(pullRequest.body) : [],
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
 * How many empty diffs the Kit has recorded on that Ticket, read from its
 * comments as the Ticket's own snapshot reads them, so a Verdict on its PR
 * counts on from the Retries they used (#415). None when the PR doesn't link it.
 */
function ticketEmptyDiffsOf(pullRequest: PullRequestNode, ticket: number | null, appLogin: string | null): number {
  const comments = closedTicketOf(pullRequest, ticket)?.comments.nodes ?? [];
  return countEmptyDiffs(comments.map((comment) => ({ body: comment.body, byApp: byAppOf(comment.author, appLogin) })));
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
      nodes: (PullRequestNode & { mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" })[];
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
  github: Pick<GitHub, "graphql">,
  actions: Pick<GitHub, "rest"> | null,
  repo: Repo,
  now: string,
  appLogin: string | null,
  operator: string,
  wait: (ms: number) => Promise<void>,
): Promise<ConflictSnapshot> {
  type AgentNode = ConflictsQueryResult["repository"]["pullRequests"]["nodes"][number];
  let agents: { node: AgentNode; mergeable: boolean | null }[] = [];
  let head: string | null = null;
  for (let read = 1; read <= MERGEABLE_READS; read += 1) {
    if (read > 1) await wait(MERGEABLE_WAIT_MS);
    agents = [];
    let after: string | null = null;
    do {
      const data: ConflictsQueryResult = await github.graphql<ConflictsQueryResult>(CONFLICTS_QUERY, { owner: repo.owner, name: repo.name, after });
      // Read with the page's mergeable states, so both are of the same main.
      if (after === null) head = data.repository.defaultBranchRef?.target.oid ?? null;
      const { pageInfo, nodes } = data.repository.pullRequests;
      agents.push(
        ...nodes.flatMap((node) =>
          pullRequestSnapshotOf(node, appLogin).isAgent ? [{ node, mergeable: node.mergeable === "UNKNOWN" ? null : node.mergeable === "MERGEABLE" }] : [],
        ),
      );
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after !== null);
    if (agents.every(({ mergeable }) => mergeable !== null)) break;
  }
  // Each agent PR's earlier comments are read once, after the last read.
  const pullRequests: ConflictCandidate[] = [];
  for (const { node, mergeable } of agents) {
    pullRequests.push({ pullRequest: pullRequestSnapshotOf(await withEarlierComments(github, repo, node), appLogin, operator), mergeable });
  }
  const implementJobUnderWay = actions === null ? null : await readImplementJobUnderWay(actions, repo);
  return { main: head, now, implementJobUnderWay, pullRequests };
}

async function gatherDispatch(
  github: GitHub,
  actions: GitHub,
  repo: Repo,
  operator: string | null,
  appLogin: string | null,
): Promise<EventPart> {
  const [{ tickets, page }, runs, researchDecisions] = await Promise.all([
    gatherDispatchTickets(github, repo, appLogin),
    countDispatchedRuns(actions, repo),
    gatherResearchDecisions(github, repo, appLogin),
  ]);
  const openAgentDraftPullRequests = page.repository.pullRequests.nodes.filter(
    (pr) => pr.isDraft && isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" }),
  ).length;
  return {
    issue: null,
    pullRequest: null,
    dispatch: {
      tickets,
      openAgentDraftPullRequests,
      implementRunsInProgress: runs.implement,
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
  github: GitHub,
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
async function gatherDispatchTickets(github: GitHub, repo: Repo, appLogin: string | null): Promise<{ tickets: TicketSnapshot[]; page: DispatchQueryResult }> {
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
      tickets.push({
        number: issue.number,
        open: issue.state === "OPEN",
        labels: issue.labels.nodes.map((label) => label.name),
        openBlockers: issue.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.number),
        notPlannedBlockers: issue.blockedBy.nodes
          .filter((b) => b.state === "CLOSED" && b.stateReason === "NOT_PLANNED")
          .map((b) => b.number),
        subIssues: issue.subIssues.totalCount,
        openLinkedPullRequests: issue.closedByPullRequestsReferences.nodes
          .filter((pr) => pr.state === "OPEN")
          .map((pr) => pr.number),
        lastRunFailed: implementRunFailedIn(
          issue.comments.nodes.map((comment) => ({ body: comment.body, byApp: byAppOf(comment.author, appLogin) })),
        ),
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
async function gatherResearchDecisions(github: GitHub, repo: Repo, appLogin: string | null): Promise<ResearchDecisionSnapshot[]> {
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
  github: GitHub,
  actions: GitHub | null,
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
  github: Pick<GitHub, "graphql">,
  actions: Pick<GitHub, "rest"> | null,
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
        // A third empty diff is the one that sent the Ticket back to design.
        redesign: session.sentBack !== null || countEmptyDiffs(comments) > MAX_RETRIES,
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

interface Job {
  /** The workflow run the job is in. */
  run: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * The Implement jobs under way and the Research jobs not yet finished, across
 * every workflow run in the repo. Each counts running, and also queued or
 * waiting (behind its concurrency group, say) after its claim took the
 * trigger label off, so no slot goes uncounted between the label coming off
 * and the run starting. An Implement job counts on, once done, until its
 * run's push job has opened the Ticket's draft PR (implementJobsUnderWay).
 */
export async function countDispatchedRuns(
  github: Pick<GitHub, "rest">,
  repo: Repo,
): Promise<{ implement: number; research: number }> {
  const jobs = await jobsOfUnfinishedRuns(github, repo);
  const research = jobs.filter(({ name, status }) => status !== "completed" && isJobNamed(name, RESEARCH_JOB_NAME)).length;
  return { implement: implementJobsUnderWay(jobs).length, research };
}

/**
 * The one reading of an Implement job under way, which Dispatch, the stall
 * check and the stuck-trigger sweep share (#432): one in a workflow run not
 * yet finished that its run didn't skip, until that run's push job has
 * landed it, whatever its conclusion. That takes in one waiting, queued or
 * running, and also one that's done while its push job is still to open the
 * Ticket's draft PR or post its failure notice: between the claim taking the
 * label off and the PR opening, the run is all that shows the Ticket taken.
 * Once the push job is done, the draft PR shows it, or nothing will, and the
 * same run's Dispatch job, which follows the push job, doesn't count it twice. GitHub doesn't list a job still
 * waiting on its `needs` until those jobs finish, but an Implement job needs
 * only the Kit job, which its run's claim needs too.
 */
function implementJobsUnderWay(jobs: readonly Job[]): Job[] {
  const landed = new Set(jobs.filter(({ name, status }) => status === "completed" && isJobNamed(name, PUSH_JOB_NAME)).map(({ run }) => run));
  return jobs.filter(({ run, name, conclusion }) => conclusion !== "skipped" && IMPLEMENT_JOB.test(name) && !landed.has(run));
}

/** Whether a job's name is `jobName`, or `<caller job> / <jobName>` when a Product repo's caller workflow ran it. */
function isJobNamed(name: string, jobName: string): boolean {
  return name === jobName || name.endsWith(` / ${jobName}`);
}

/**
 * An Implement job's name, and a Review job's, as a caller workflow shows it or
 * not: named for what it runs on (#477), or for nothing, as a run of an earlier
 * Kit release still in flight names it.
 */
const IMPLEMENT_JOB = new RegExp(`^(?:.+ / )?${IMPLEMENT_JOB_NAME}(?: #[1-9][0-9]*(?: \\(Retry [1-9][0-9]*\\))?)?$`);
const REVIEW_JOB = new RegExp(`^(?:.+ / )?${REVIEW_JOB_NAME}(?: PR #[1-9][0-9]*)?$`);

/**
 * Whether an Implement job is under way anywhere in the repo (#387), as
 * Dispatch reads it (implementJobsUnderWay). Null when the Actions API
 * couldn't be read, so a failed read only leaves a stalled run alone, never
 * the rest of the conflict check.
 */
async function readImplementJobUnderWay(github: Pick<GitHub, "rest">, repo: Repo): Promise<boolean | null> {
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
export async function designTurnsInProgress(github: Pick<GitHub, "rest">, repo: Repo): Promise<number[]> {
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
  github: Pick<GitHub, "graphql">,
  actions: Pick<GitHub, "rest"> | null,
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
 * not yet finished, a job its run skipped aside, and an Implement job as
 * Dispatch reads it (implementJobsUnderWay); null when the Actions API
 * couldn't be read.
 */
async function readRolesUnderWay(github: Pick<GitHub, "rest">, repo: Repo): Promise<RolesUnderWay | null> {
  let jobs: Job[];
  try {
    jobs = (await jobsOfUnfinishedRuns(github, repo)).filter(({ conclusion }) => conclusion !== "skipped");
  } catch {
    return null;
  }
  const anyJobNamed = (...names: string[]) => jobs.some(({ name }) => names.some((jobName) => isJobNamed(name, jobName)));
  const anyReviewJob = jobs.some(({ name }) => REVIEW_JOB.test(name));
  const designTurns = new Set(jobs.flatMap((job) => DESIGN_JOB.exec(job.name)?.[1] ?? []).map(Number));
  return {
    implement: implementJobsUnderWay(jobs).length > 0,
    research: anyJobNamed(RESEARCH_JOB_NAME),
    review: anyReviewJob || anyJobNamed(REVIEW_CHECKS_JOB_NAME),
    claim: anyJobNamed(CLAIM_JOB_NAME),
    designTurns: [...designTurns].sort((a, b) => a - b),
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
  github: Pick<GitHub, "graphql">,
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

/** Every job, finished or not, of every workflow run not yet completed. */
async function jobsOfUnfinishedRuns(github: Pick<GitHub, "rest">, repo: Repo): Promise<Job[]> {
  const base = `/repos/${repo.owner}/${repo.name}/actions`;
  const runIds = new Set<number>();
  for (const status of UNFINISHED_RUNS) {
    const runs = (await github.rest("GET", `${base}/runs?status=${status}&per_page=100`)) as {
      workflow_runs: { id: number }[];
    };
    for (const run of runs.workflow_runs) runIds.add(run.id);
  }
  const jobs: Job[] = [];
  for (const id of runIds) {
    const page = (await github.rest("GET", `${base}/runs/${id}/jobs?filter=latest&per_page=100`)) as {
      jobs: { name: string; status: string; conclusion?: string | null }[];
    };
    jobs.push(...page.jobs.map((job) => ({ run: id, name: job.name, status: job.status, conclusion: job.conclusion ?? null })));
  }
  return jobs;
}

/** Reads the Kit config folder's files from the Product repo at `ref`, through the API. */
export async function readKitConfigSources(
  github: Pick<GitHub, "fileText">,
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
