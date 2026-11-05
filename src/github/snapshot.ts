// The adapter's snapshot side: reads the current GitHub state a Loop event
// needs, fresh rather than from the event payload, into the snapshot the core
// decides on. It holds no Loop rules; those all live in src/loop/rules.ts.
import { instructionsPath, KIT_CONFIG_PATH, type KitConfigSources, PHASES } from "../kit/config.ts";
import { isAgentPullRequest, ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { KIT_ISSUE_LABELS, NEEDS_DESIGN, READY_FOR_AGENT } from "../loop/labels.ts";
import { MAX_RETRIES } from "../loop/retry.ts";
import type {
  DesignQueueIssue,
  KitIssueSnapshot,
  LoopEvent,
  PullRequestSnapshot,
  Snapshot,
  SpecSnapshot,
  StartingComment,
  TicketSnapshot,
} from "../loop/types.ts";
import type { GitHub, Repo } from "./client.ts";
import { countEmptyDiffs, designSessionOf, designTurnFailedIn, pushedSinceVerdictIn, requestChangesRunIn, verdictsIn } from "./threads.ts";

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issue(number: $number) {
        number
        state
        author { login }
        labels(first: 100) { nodes { name } }
        parent { number }
        comments(last: 100) { nodes { body author { __typename } } }
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
      author: { login: string } | null;
      labels: { nodes: { name: string }[] };
      parent: { number: number } | null;
      comments: { nodes: { body: string; author: { __typename: string } | null }[] };
      closedByPullRequestsReferences: { nodes: { number: number }[] };
      blockedBy: DependencyEdges;
      blocking: DependencyEdges;
    } | null;
  };
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
        author { __typename }
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
      author: { __typename: string } | null;
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
          comments(last: 100) { nodes { body author { __typename } } }
          timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
            nodes { ... on LabeledEvent { createdAt label { name } } }
          }
        }
      }
    }
  }
`;

interface DesignQueueQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        createdAt: string;
        labels: { nodes: { name: string }[] };
        comments: { nodes: { body: string; author: { __typename: string } | null }[] };
        // Only LabeledEvents are asked for, but the union's other members come back empty.
        timelineItems: { nodes: { createdAt?: string; label?: { name: string } }[] };
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
 * repo's owner. A Dispatch check also reads workflow runs, through `actions`:
 * the Fabrik App has no Actions permission (ADR-0002), so that is the Dispatch
 * job's own read-only GITHUB_TOKEN.
 */
export async function gatherSnapshot(
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  actions: GitHub | null = null,
): Promise<Snapshot> {
  const [{ owner, kitIssues }, part, startingComment] = await Promise.all([
    gatherKitIssues(github, repo),
    gatherEventPart(github, repo, event, operator, actions),
    gatherStartingComment(github, repo, event),
  ]);
  // A closed Ticket may be its Spec's last.
  const parent = event.kind === "issue-closed" ? (part?.issue?.parent ?? null) : null;
  const spec = parent === null ? null : await gatherSpec(github, repo, parent);
  // By default the Operator owns the Product repos they run Fabrik in.
  return part === null
    ? { issue: null, pullRequest: null, dispatch: null, designQueue: null, spec, operator: operator ?? owner, kitIssues, startingComment }
    : { ...part, spec, kitIssues, startingComment };
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
      return gatherPullRequest(github, repo, event.pullRequest, operator);
    case "dispatch-check":
      if (actions === null) throw new Error("A Dispatch check needs a token that can read workflow runs");
      return gatherDispatch(github, actions, repo, operator);
    case "design-queue-check":
      if (actions === null) throw new Error("A Design queue check needs a token that can read workflow runs");
      return gatherDesignQueue(github, actions, repo, operator);
    case "kit-config-changed":
    case "scheduled-tick":
      return null;
    case "implement-run-finished": {
      const ticket = await gatherIssue(github, repo, event.issue, operator);
      if (event.fixes === undefined) return ticket;
      // A retry's push job weighs the Ticket and the PR it fixes.
      const { pullRequest } = await gatherPullRequest(github, repo, event.fixes.pullRequest, operator);
      return { ...ticket, pullRequest };
    }
    case "label-added": {
      // agent:implement on a Ticket with an open PR resumes that PR's run, so the core weighs the PR too.
      const ticket = await gatherIssue(github, repo, event.issue, operator);
      const open = ticket.issue?.openPullRequests[0];
      if (open === undefined) return ticket;
      const { pullRequest } = await gatherPullRequest(github, repo, open, operator);
      return { ...ticket, pullRequest };
    }
    default:
      return gatherIssue(github, repo, event.issue, operator);
  }
}

type EventPart = Omit<Snapshot, "kitIssues" | "spec" | "startingComment">;

const KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: $labels, first: 20, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes {
          number
          body
          labels(first: 100) { nodes { name } }
          comments(last: 100) { nodes { body } }
        }
      }
    }
  }
`;

interface KitIssuesQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      nodes: { number: number; body: string; labels: { nodes: { name: string }[] }; comments: { nodes: { body: string }[] } }[];
    };
  };
}

/** The open issues carrying a Kit-owned label (src/loop/kitIssues.ts), which every event's snapshot holds. */
async function gatherKitIssues(github: GitHub, repo: Repo): Promise<{ owner: string; kitIssues: KitIssueSnapshot[] }> {
  const data = await github.graphql<KitIssuesQueryResult>(KIT_ISSUES_QUERY, {
    owner: repo.owner,
    name: repo.name,
    labels: KIT_ISSUE_LABELS,
  });
  return {
    owner: data.repository.owner.login,
    kitIssues: data.repository.issues.nodes.map((issue) => ({
      number: issue.number,
      labels: issue.labels.nodes.map((label) => label.name),
      body: issue.body,
      comments: issue.comments.nodes.map((comment) => comment.body),
    })),
  };
}

async function gatherIssue(github: GitHub, repo: Repo, number: number, operator: string | null): Promise<EventPart> {
  const data = await github.graphql<IssueQueryResult>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number });
  const issue = data.repository.issue;
  if (issue === null) {
    throw new Error(`Issue #${number} not found in ${repo.owner}/${repo.name}`);
  }
  return {
    issue: {
      number: issue.number,
      open: issue.state === "OPEN",
      author: issue.author?.login ?? "ghost",
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
      openPullRequests: issue.closedByPullRequestsReferences.nodes.map((pr) => pr.number).sort((a, b) => a - b),
      ...designSessionOf(
        issue.comments.nodes.map((comment) => ({ body: comment.body, byBot: comment.author?.__typename === "Bot" })),
      ),
      emptyDiffs: countEmptyDiffs(issue.comments.nodes.map((comment) => comment.body)),
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

  return {
    issue: null,
    pullRequest: null,
    dispatch: {
      tickets,
      openAgentDraftPullRequests,
      implementRunsInProgress: await countImplementRuns(actions, repo),
    },
    designQueue: null,
    operator: operator ?? page.repository.owner.login,
  };
}

async function gatherDesignQueue(
  github: GitHub,
  actions: GitHub,
  repo: Repo,
  operator: string | null,
): Promise<EventPart> {
  const issues: DesignQueueIssue[] = [];
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
        byBot: comment.author?.__typename === "Bot",
      }));
      const added = issue.timelineItems.nodes
        .filter((event) => event.label?.name === NEEDS_DESIGN && event.createdAt !== undefined)
        .map((event) => event.createdAt as string);
      const session = designSessionOf(comments);
      issues.push({
        number: issue.number,
        labels: issue.labels.nodes.map((label) => label.name),
        designRounds: session.designRounds,
        turnFailed: designTurnFailedIn(comments),
        // A third empty diff is the one that sent the Ticket back to design.
        redesign: session.sentBack !== null || countEmptyDiffs(comments.map((comment) => comment.body)) > MAX_RETRIES,
        // The latest time it got needs-design; an issue whose timeline doesn't show it waits from when it opened.
        neededDesignAt: added.at(-1) ?? issue.createdAt,
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);

  return {
    issue: null,
    pullRequest: null,
    dispatch: null,
    designQueue: { issues, designTurnsInProgress: await designTurnsInProgress(actions, repo) },
    operator: operator ?? page.repository.owner.login,
  };
}

/** Workflow-run statuses, short of completed, whose Implement job may still hold a slot. */
const UNFINISHED_RUNS = ["in_progress", "queued", "waiting", "pending", "requested"] as const;

/**
 * Implement jobs not yet finished, across every workflow run in the repo:
 * running, and also queued or waiting (behind its concurrency group, say)
 * after its claim took agent:implement off the Ticket, so no slot goes
 * uncounted between the label coming off and the run starting.
 */
export async function countImplementRuns(github: Pick<GitHub, "rest">, repo: Repo): Promise<number> {
  const jobs = await unfinishedJobs(github, repo);
  return jobs.filter((name) => name === IMPLEMENT_JOB_NAME || name.endsWith(` / ${IMPLEMENT_JOB_NAME}`)).length;
}

const DESIGN_JOB = new RegExp(`^(?:.+ / )?${DESIGN_JOB_NAME} #([1-9][0-9]*)$`);

/**
 * The issue of each Design-session turn not yet finished, across every
 * workflow run in the repo, read from its job's name: running, and also
 * queued or waiting behind its issue's concurrency group, lowest number first.
 */
export async function designTurnsInProgress(github: Pick<GitHub, "rest">, repo: Repo): Promise<number[]> {
  const jobs = await unfinishedJobs(github, repo);
  const issues = new Set(jobs.flatMap((name) => DESIGN_JOB.exec(name)?.[1] ?? []).map(Number));
  return [...issues].sort((a, b) => a - b);
}

/** The names of the jobs not yet completed in every workflow run not yet completed. */
async function unfinishedJobs(github: Pick<GitHub, "rest">, repo: Repo): Promise<string[]> {
  const base = `/repos/${repo.owner}/${repo.name}/actions`;
  const runIds = new Set<number>();
  for (const status of UNFINISHED_RUNS) {
    const runs = (await github.rest("GET", `${base}/runs?status=${status}&per_page=100`)) as {
      workflow_runs: { id: number }[];
    };
    for (const run of runs.workflow_runs) runIds.add(run.id);
  }
  const names: string[] = [];
  for (const id of runIds) {
    const jobs = (await github.rest("GET", `${base}/runs/${id}/jobs?filter=latest&per_page=100`)) as {
      jobs: { name: string; status: string }[];
    };
    names.push(...jobs.jobs.filter((job) => job.status !== "completed").map((job) => job.name));
  }
  return names;
}

/** Reads the Kit config folder's files from the Product repo at `ref`, through the API. */
export async function readKitConfigSources(github: GitHub, repo: Repo, ref: string): Promise<KitConfigSources> {
  const [config, ...instructions] = await Promise.all([
    github.fileText(repo, KIT_CONFIG_PATH, ref),
    ...PHASES.map((phase) => github.fileText(repo, instructionsPath(phase), ref)),
  ]);
  return {
    config: config ?? null,
    instructions: Object.fromEntries(PHASES.map((phase, i) => [phase, instructions[i] ?? null])),
  };
}
