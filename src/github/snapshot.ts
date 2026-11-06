// The adapter's snapshot side: reads the current GitHub state a Loop event
// needs, fresh rather than from the event payload, into the snapshot the core
// decides on. It holds no Loop rules; those all live in src/loop/rules.ts.
import { evidenceMarkerIn } from "../evidence/uiEvidence.ts";
import {
  INSTRUCTED_ROLES,
  instructionsPath,
  KIT_CONFIG_PATH,
  type KitConfigSources,
  SKILLS_SOURCES_LOCK_PATH,
} from "../kit/config.ts";
import { storeIsPrivate } from "../kit/runStore.ts";
import { isAgentPullRequest, ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { parseAuditOutput } from "../loop/auditOutput.ts";
import { heldRunsIn } from "../loop/heldRun.ts";
import {
  AUDIT_LABEL,
  DESIGN_LABEL,
  KIT_ISSUE_LABELS,
  MAP_LABEL,
  NEEDS_DESIGN,
  READY_FOR_AGENT,
  RESEARCH_DECISION_LABEL,
  RETRO_LABEL,
  WEEKLY_LIMIT_LABEL,
} from "../loop/labels.ts";
import { escapeMarkerIn } from "../loop/markers.ts";
import { retroWindowStart } from "../loop/retro.ts";
import { MAX_RETRIES } from "../loop/retry.ts";
import type {
  AuditSnapshot,
  DesignQueueIssue,
  DesignQueueSnapshot,
  HeldTargetSnapshot,
  KitIssueSnapshot,
  LoopEvent,
  NamedPullRequestSnapshot,
  ParentIssueSnapshot,
  PullRequestSnapshot,
  ResearchDecisionSnapshot,
  RetroSnapshot,
  Snapshot,
  SpecSnapshot,
  StartingComment,
  TicketSnapshot,
  WeeklyIssueSnapshot,
} from "../loop/types.ts";
import { type GitHub, pagesOf, type Repo } from "./client.ts";
import {
  countEmptyDiffs,
  designSessionOf,
  designTurnFailedIn,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  researchRunFailedIn,
  verdictsIn,
} from "./threads.ts";

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issue(number: $number) {
        number
        state
        author { login __typename }
        body
        labels(first: 100) { nodes { name } }
        parent { number state labels(first: 100) { nodes { name } } }
        comments(last: 100) { nodes { body createdAt author { __typename } } }
        timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], last: 100) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } }
            ... on UnlabeledEvent { createdAt label { name } actor { __typename } }
          }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number } }
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
      state: "OPEN" | "CLOSED";
      author: { login: string; __typename: string } | null;
      body: string;
      labels: { nodes: { name: string }[] };
      parent: ParentNode | null;
      comments: { nodes: { body: string; createdAt: string; author: { __typename: string } | null }[] };
      // Only Labeled and UnlabeledEvents are asked for, but the union's other members come back empty.
      timelineItems: { nodes: LabelTimelineItem[] };
      closedByPullRequestsReferences: { nodes: { number: number }[] };
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

const PULL_REQUEST_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      pullRequest(number: $number) {
        number
        state
        isDraft
        headRefName
        headRefOid
        author { login __typename }
        body
        labels(first: 100) { nodes { name } }
        comments(last: 100) { nodes { body author { __typename } } }
        reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { databaseId author { login __typename } commit { oid } } }
      }
    }
  }
`;

interface PullRequestQueryResult {
  repository: {
    owner: { login: string };
    pullRequest: {
      number: number;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft: boolean;
      headRefName: string;
      headRefOid: string;
      author: { login: string; __typename: string } | null;
      body: string;
      labels: { nodes: { name: string }[] };
      comments: { nodes: { body: string; author: { __typename: string } | null }[] };
      reviews: {
        nodes: { databaseId: number; author: { login: string; __typename: string } | null; commit: { oid: string } | null }[];
      };
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
          comments(last: 100) { nodes { body author { __typename } } }
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
        comments: { nodes: { body: string; author: { __typename: string } | null }[] };
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
          comments(last: 100) { nodes { body createdAt author { __typename } } }
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
        comments: { nodes: { body: string; createdAt: string; author: { __typename: string } | null }[] };
        // Only Labeled and UnlabeledEvents are asked for, but the union's other members come back empty.
        timelineItems: { nodes: LabelTimelineItem[] };
      }[];
    };
  };
}

/**
 * The name of the Implement job in .github/workflows/loop.yml (a test holds
 * the two together). Called from a Product repo's caller workflow, it shows
 * up as `<caller job> / Implement`.
 */
export const IMPLEMENT_JOB_NAME = "Implement";

/**
 * The name of the Design job in .github/workflows/loop.yml, which follows it
 * with ` #<issue>` (a test holds the two together). Called from a Product
 * repo's caller workflow, it shows up as `<caller job> / Design-session turn #7`.
 */
export const DESIGN_JOB_NAME = "Design-session turn";

/**
 * Reads the current GitHub state the event needs, fresh rather than from the
 * event payload. The Operator is the Kit config's `operator`, or else the
 * repo's owner. `appLogin` is the Fabrik App's bot login, its slug with
 * `[bot]`, which tells the App's issues apart from any other bot's; null when
 * the run doesn't know it, as the Kit job, which only routes, doesn't, so any
 * bot's issue is taken for the App's (see byAppOf). A
 * Dispatch check also reads workflow runs, through `actions`: the Fabrik App
 * has no Actions permission (ADR-0002), so that is the Dispatch job's own
 * read-only GITHUB_TOKEN. A scheduled tick also reads whether the fabrik-runs
 * store is private, through `store` (see gatherRetroSlice).
 */
export async function gatherSnapshot(
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  appLogin: string | null,
  actions: GitHub | null = null,
  store: Pick<GitHub, "rest"> | null = null,
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
  const held = event.kind === "scheduled-tick" ? await gatherHeld(github, repo, kitIssues, appLogin) : null;
  // By default the Operator owns the Product repos they run Fabrik in.
  const theOperator = part?.operator ?? operator ?? owner;
  const retro = event.kind === "scheduled-tick" ? await gatherRetroSlice(github, repo, event.now, theOperator, appLogin, store) : null;
  return part === null
    ? { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec, operator: theOperator, kitIssues, startingComment, audit, retro, namedPullRequests, held, openMaps }
    : { ...part, spec, kitIssues, startingComment, audit, retro, namedPullRequests, held, openMaps };
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
 * For a Design-session turn the Operator's reply started: whether that reply
 * is still on the issue. Only a 404 means it was deleted; any other failed
 * read fails the run, as every failed read does, and never counts as deleted.
 */
async function gatherStartingComment(github: GitHub, repo: Repo, event: LoopEvent): Promise<StartingComment | null> {
  if (event.kind !== "agent-run-finished" || event.startedBy === undefined) return null;
  const id = event.startedBy;
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
      return gatherDispatch(github, actions, repo, operator);
    case "design-queue-check":
      return gatherDesignQueue(github, actions, repo, operator);
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

type EventPart = Omit<Snapshot, "kitIssues" | "spec" | "startingComment" | "audit" | "retro" | "namedPullRequests" | "held" | "openMaps">;

const KIT_ISSUE_COMMENTS = "pageInfo { hasPreviousPage startCursor } nodes { body author { login __typename } }";

const KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: $labels, first: 20, orderBy: { field: CREATED_AT, direction: ASC }) {
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
 * many pages they take. Anyone else's comment is left out.
 */
async function gatherKitIssues(
  github: GitHub,
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
  github: GitHub,
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
 * for the scheduled tick to tell a held run still in the state it was held in
 * from one that has moved on (src/loop/resume.ts). A number naming nothing
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
    body: comment.body,
    createdAt: comment.createdAt,
    byBot: comment.author?.__typename === "Bot",
  }));
  const timeline = issue.timelineItems.nodes;
  const thisSession = commentsSince(lastNeededDesignAt(timeline), comments);
  return {
    issue: {
      number: issue.number,
      open: issue.state === "OPEN",
      author: issue.author?.login ?? "ghost",
      byApp: byAppOf(issue.author, appLogin),
      body: issue.body,
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
      parentIssue: parentIssueOf(issue.parent),
      openPullRequests: issue.closedByPullRequestsReferences.nodes.map((pr) => pr.number).sort((a, b) => a - b),
      designRounds: designSessionOf(thisSession).designRounds,
      sentBack: designSessionOf(comments).sentBack,
      turnFailed: designTurnFailedIn(thisSession),
      firstTurnClaimed: firstTurnClaimed(timeline),
      emptyDiffs: countEmptyDiffs(comments.map((comment) => comment.body)),
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
  const botComments = pullRequest.comments.nodes
    .filter((comment) => comment.author?.__typename === "Bot")
    .map((comment) => comment.body);
  return {
    issue: null,
    pullRequest: {
      number: pullRequest.number,
      isAgent: isAgentPullRequest({
        headRef: pullRequest.headRefName,
        authorIsBot: pullRequest.author?.__typename === "Bot",
      }),
      ticket: ticketOfAgentBranch(pullRequest.headRefName),
      open: pullRequest.state === "OPEN",
      draft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      labels: pullRequest.labels.nodes.map((label) => label.name),
      // Only a bot's markers count, so nobody can fake a Verdict or a Request-changes run by quoting one.
      verdicts: verdictsIn(botComments),
      requestChangesRun: requestChangesRunIn(botComments),
      pushedSinceVerdict: pushedSinceVerdictIn(botComments),
      changesRequested: changesRequestedOf(pullRequest.reviews.nodes[0]),
      // Only a body the App wrote counts, as for an issue's markers, so nobody else can mark a PR as UI.
      uiEvidenceMarker: byAppOf(pullRequest.author, appLogin) ? evidenceMarkerIn(pullRequest.body) : null,
    },
    dispatch: null,
    designQueue: null,
    operator: operator ?? data.repository.owner.login,
  };
}

function changesRequestedOf(
  review: NonNullable<PullRequestQueryResult["repository"]["pullRequest"]>["reviews"]["nodes"][number] | undefined,
): PullRequestSnapshot["changesRequested"] {
  if (review === undefined || review.author === null || review.commit === null) return null;
  return {
    review: review.databaseId,
    reviewer: review.author.login,
    reviewerIsBot: review.author.__typename === "Bot",
    commitSha: review.commit.oid,
  };
}

async function gatherDispatch(
  github: GitHub,
  actions: GitHub,
  repo: Repo,
  operator: string | null,
): Promise<EventPart> {
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
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);

  const openAgentDraftPullRequests = page.repository.pullRequests.nodes.filter(
    (pr) => pr.isDraft && isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" }),
  ).length;

  const [implementRunsInProgress, researchDecisions] = await Promise.all([
    countImplementRuns(actions, repo),
    gatherResearchDecisions(github, repo),
  ]);
  return {
    issue: null,
    pullRequest: null,
    dispatch: { tickets, openAgentDraftPullRequests, implementRunsInProgress, researchDecisions },
    designQueue: null,
    operator: operator ?? page.repository.owner.login,
  };
}

/** Every open wayfinder:research issue, with what says whether the Researcher may run on it (#154). */
async function gatherResearchDecisions(github: GitHub, repo: Repo): Promise<ResearchDecisionSnapshot[]> {
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
        // Only a bot's notice counts, so nobody can fake a failure by quoting one.
        lastRunFailed: researchRunFailedIn(
          issue.comments.nodes.map((comment) => ({ body: comment.body, byBot: comment.author?.__typename === "Bot" })),
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
): Promise<EventPart> {
  const { designQueue, owner } = await gatherDesignQueueSlice(github, actions, repo);
  return { issue: null, pullRequest: null, dispatch: null, designQueue, operator: operator ?? owner };
}

/**
 * The open needs-design issues with their slot-holding signals, and the
 * Design turns in progress: what the Design queue check decides on, and what
 * the Weekly summary's Held section counts. With a token that can read
 * workflow runs (the Design queue job's), the turns in progress are read from
 * their jobs. Without one, as on the scheduled tick (its caller grants no
 * Actions permission) and the Weekly summary (its Product-repo token can't
 * read Actions), they are read from the issues instead, erring toward holding
 * a slot: see firstTurnClaimed.
 */
export async function gatherDesignQueueSlice(
  github: Pick<GitHub, "graphql">,
  actions: Pick<GitHub, "rest"> | null,
  repo: Repo,
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
        byBot: comment.author?.__typename === "Bot",
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
        redesign: session.sentBack !== null || countEmptyDiffs(comments.map((comment) => comment.body)) > MAX_RETRIES,
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
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Implement jobs not yet finished, across every workflow run in the repo:
 * running, and also queued or waiting (behind its concurrency group, say)
 * after its claim took agent:implement off the Ticket, so no slot goes
 * uncounted between the label coming off and the run starting.
 */
export async function countImplementRuns(github: Pick<GitHub, "rest">, repo: Repo): Promise<number> {
  const jobs = await jobsOfUnfinishedRuns(github, repo);
  return jobs
    .filter((job) => job.status !== "completed")
    .filter(({ name }) => name === IMPLEMENT_JOB_NAME || name.endsWith(` / ${IMPLEMENT_JOB_NAME}`)).length;
}

const DESIGN_JOB = new RegExp(`^(?:.+ / )?${DESIGN_JOB_NAME} #([1-9][0-9]*)$`);

/**
 * The issue of each Design-session turn not yet finished, across every
 * workflow run in the repo, read from its job's name, lowest number first. A
 * turn is in progress until its whole run finishes: running, queued or
 * waiting behind its issue's concurrency group, and also after its job is
 * done while the push job is still posting its round or failure notice, so no
 * slot goes uncounted before the thread shows it. A Design job skipped
 * because the run went another way is no turn.
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
    jobs.push(...page.jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion ?? null })));
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
