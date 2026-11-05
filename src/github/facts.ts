// The Weekly summary's GitHub side, beside the Loop's snapshot gatherer: which
// Product repos the summary covers, and the GitHub facts it reads of each
// (src/kit/weeklySummary.ts). Read-only. It holds no summary rules; those all
// live in the Weekly summary module.
import { fabrikRefsIn } from "../kit/caller.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import type {
  AgentPullRequestFacts,
  CommentFacts,
  EscapeMarkerIssueFacts,
  GitHubFacts,
  LabelEvent,
  OpenAuditFacts,
  OpenIssueFacts,
  OpenPullRequestFacts,
  ReviewFacts,
  SpecFacts,
  TicketFacts,
} from "../kit/weeklySummary.ts";
import { IMPLEMENTER_AUTHOR, isAgentPullRequest } from "../loop/agentPullRequest.ts";
import { AUDIT_LABEL } from "../loop/labels.ts";
import { escapeMarkerIn } from "../loop/markers.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { type GitHub, pagesOf, type Repo } from "./client.ts";
import { gatherDesignQueueSlice } from "./snapshot.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the issue and default-branch facts reach: 30 days, plus the
 * week before, so last week's 30-day revert window is as whole as this week's.
 */
const WINDOW_MS = 37 * DAY_MS;

/**
 * How far back the PRs and the escape-marked issues reach: 90 days, plus the
 * week before, so last week's 90-day escape window is as whole as this week's.
 * Revert rate reads its own 30 days of them.
 */
const ESCAPE_WINDOWS_REACH_MS = 97 * DAY_MS;

/** The GitHub facts the Weekly summary reads of one Product repo, as of `now`, with the Operator's login. */
export async function gatherGitHubFacts(github: Pick<GitHub, "graphql">, repo: Repo, now: number, operator: string): Promise<GitHubFacts> {
  const since = new Date(now - WINDOW_MS).toISOString();
  const escapeSince = new Date(now - ESCAPE_WINDOWS_REACH_MS).toISOString();
  const [closed, open, updatedIssues, openIssues, defaultBranchCommits, { designQueue }, escapeMarkerIssues, openAudits] = await Promise.all([
    gatherClosedPullRequests(github, repo, escapeSince),
    pagesOf<RawOpenPullRequest>(github, OPEN_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests),
    pagesOf<RawIssue>(github, UPDATED_ISSUES_QUERY, repo, { since }, (data) => data.repository.issues),
    pagesOf<RawIssue>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues),
    pagesOf<RawCommit>(github, DEFAULT_BRANCH_QUERY, repo, { since }, (data) => data.repository.defaultBranchRef?.target.history ?? null),
    // The Design queue check's own slice, so Held and the check can't disagree. Its token can't read
    // workflow runs, so it reads Design turns in progress from the issues, as the scheduled tick does.
    gatherDesignQueueSlice(github, null, repo),
    gatherEscapeMarkerIssues(github, repo, operator, escapeSince),
    pagesOf<RawAudit>(github, OPEN_AUDITS_QUERY, repo, { audit: AUDIT_LABEL }, (data) => data.repository.issues),
  ]);
  const issues = [...new Map([...updatedIssues, ...openIssues].map((issue) => [issue.number, issue])).values()];
  return {
    repo: `${repo.owner}/${repo.name}`,
    pullRequests: closed.filter(isAgent).map(agentPullRequestOf),
    tickets: issues.map(ticketOf),
    specs: issues.filter((issue) => issue.subIssues.nodes.length > 0).map(specOf),
    defaultBranchCommits: defaultBranchCommits.map((commit) => ({ message: commit.message, at: commit.committedDate })),
    mergedPullRequestTitles: closed.flatMap((pr) => (pr.mergedAt === null ? [] : [{ title: pr.title, mergedAt: pr.mergedAt }])),
    openIssues: openIssues.map(openIssueOf),
    openPullRequests: open.filter(isAgent).map(openPullRequestOf),
    designQueue,
    escapeMarkerIssues,
    openAudits: openAudits.map(openAuditOf),
  };
}

// --- The queries --------------------------------------------------------------

const ACTOR = "{ login __typename }";
const LABEL_EVENTS = `
  timelineItems(first: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
    nodes {
      __typename
      ... on LabeledEvent { createdAt actor ${ACTOR} label { name } }
      ... on UnlabeledEvent { createdAt actor ${ACTOR} label { name } }
    }
  }
`;
const COMMENTS = `comments(last: 100) { nodes { body createdAt author ${ACTOR} } }`;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

// Newest-updated first, so paging stops at the first page older than the window.
const CLOSED_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: [MERGED, CLOSED], first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes {
          number title state mergedAt closedAt updatedAt headRefName
          author ${ACTOR}
          mergeCommit { oid }
          closingIssuesReferences(first: 10) { nodes { number } }
          commits(first: 100) { nodes { commit { committedDate author { email } } } }
          reviews(first: 100) { nodes { author ${ACTOR} state submittedAt } }
          ${COMMENTS}
          ${LABEL_EVENTS}
        }
      }
    }
  }
`;

const OPEN_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 25, after: $after) {
        ${PAGE_INFO}
        nodes {
          number title isDraft headRefOid headRefName createdAt
          author ${ACTOR}
          commits(last: 100) { nodes { commit { committedDate } } }
          ${COMMENTS}
          ${LABEL_EVENTS}
        }
      }
    }
  }
`;

const ISSUE_FIELDS = `
  number title state createdAt closedAt
  labels(first: 50) { nodes { name } }
  ${COMMENTS}
  ${LABEL_EVENTS}
  blockedBy(first: 20) { nodes { number labels(first: 20) { nodes { name } } } }
  subIssues(first: 100) { nodes { number } }
`;

// Every issue that moved in the window: the Tickets and Specs the metrics read.
const UPDATED_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $since: DateTime!) {
    repository(owner: $owner, name: $name) {
      issues(first: 25, after: $after, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

// Every open issue, however long it has sat: what Waiting on you and Stuck read.
const OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 25, after: $after) {
        ${PAGE_INFO}
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

// The issues one person opened, newest first, so paging stops at the first page older than the window.
const ISSUES_OPENED_BY_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $operator: String!) {
    repository(owner: $owner, name: $name) {
      issues(first: 25, after: $after, filterBy: { createdBy: $operator }, orderBy: { field: CREATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes { number createdAt state body author ${ACTOR} }
      }
    }
  }
`;

// The open Audits, whoever opened them: the summary keeps the Fabrik App's.
const OPEN_AUDITS_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $audit: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$audit], first: 25, after: $after) {
        ${PAGE_INFO}
        nodes { number title createdAt author ${ACTOR} }
      }
    }
  }
`;

const DEFAULT_BRANCH_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $since: GitTimestamp!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, after: $after, since: $since) {
              ${PAGE_INFO}
              nodes { message committedDate }
            }
          }
        }
      }
    }
  }
`;

interface RawActor {
  login: string;
  __typename: string;
}

interface RawLabelEvent {
  __typename: string;
  createdAt: string;
  actor: RawActor | null;
  label: { name: string };
}

interface RawComment {
  body: string;
  createdAt: string;
  author: RawActor | null;
}

interface RawClosedPullRequest {
  number: number;
  title: string;
  state: "MERGED" | "CLOSED";
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  headRefName: string;
  author: RawActor | null;
  mergeCommit: { oid: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
  commits: { nodes: { commit: { committedDate: string; author: { email: string | null } | null } }[] };
  reviews: { nodes: { author: RawActor | null; state: string; submittedAt: string | null }[] };
  comments: { nodes: RawComment[] };
  timelineItems: { nodes: RawLabelEvent[] };
}

interface RawOpenPullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  createdAt: string;
  author: RawActor | null;
  commits: { nodes: { commit: { committedDate: string } }[] };
  comments: { nodes: RawComment[] };
  timelineItems: { nodes: RawLabelEvent[] };
}

interface RawIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: RawComment[] };
  timelineItems: { nodes: RawLabelEvent[] };
  blockedBy: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] };
  subIssues: { nodes: { number: number }[] };
}

interface RawOpenedIssue {
  number: number;
  createdAt: string;
  state: "OPEN" | "CLOSED";
  body: string;
  author: RawActor | null;
}

interface RawAudit {
  number: number;
  title: string;
  createdAt: string;
  author: RawActor | null;
}

interface RawCommit {
  message: string;
  committedDate: string;
}

/** The PRs merged or closed in the window, agent or not. */
async function gatherClosedPullRequests(github: Pick<GitHub, "graphql">, repo: Repo, since: string): Promise<RawClosedPullRequest[]> {
  const sinceMs = Date.parse(since);
  const pullRequests = await pagesOf<RawClosedPullRequest>(
    github,
    CLOSED_PULL_REQUESTS_QUERY,
    repo,
    {},
    (data) => data.repository.pullRequests,
    (page) => page.some((pr) => Date.parse(pr.updatedAt) < sinceMs),
  );
  return pullRequests.filter((pr) => {
    const at = pr.mergedAt ?? pr.closedAt;
    return at !== null && Date.parse(at) >= sinceMs;
  });
}

/** The issues the Operator opened in the window whose body has an escape marker, such as filed Audit candidates. */
async function gatherEscapeMarkerIssues(
  github: Pick<GitHub, "graphql">,
  repo: Repo,
  operator: string,
  since: string,
): Promise<EscapeMarkerIssueFacts[]> {
  const sinceMs = Date.parse(since);
  const issues = await pagesOf<RawOpenedIssue>(
    github,
    ISSUES_OPENED_BY_QUERY,
    repo,
    { operator },
    (data) => data.repository.issues,
    (page) => page.some((issue) => Date.parse(issue.createdAt) < sinceMs),
  );
  return issues
    .filter((issue) => Date.parse(issue.createdAt) >= sinceMs && escapeMarkerIn(issue.body) !== null)
    .map((issue) => ({
      number: issue.number,
      author: loginOf(issue.author),
      createdAt: issue.createdAt,
      state: issue.state === "CLOSED" ? "closed" : "open",
      body: issue.body,
    }));
}

// --- Into the summary's facts -------------------------------------------------

function isAgent(pullRequest: { headRefName: string; author: RawActor | null }): boolean {
  return isAgentPullRequest({ headRef: pullRequest.headRefName, authorIsBot: pullRequest.author?.__typename === "Bot" });
}

function agentPullRequestOf(pr: RawClosedPullRequest): AgentPullRequestFacts {
  return {
    number: pr.number,
    ticket: pr.closingIssuesReferences.nodes[0]?.number ?? null,
    title: pr.title,
    mergedAt: pr.mergedAt,
    mergeSha: pr.mergeCommit?.oid ?? null,
    commits: pr.commits.nodes.map(({ commit }) => ({
      byApp: commit.author?.email === IMPLEMENTER_AUTHOR.email,
      at: commit.committedDate,
    })),
    reviews: pr.reviews.nodes.flatMap(reviewOf),
    comments: pr.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(pr.timelineItems.nodes),
  };
}

const REVIEW_STATES: Readonly<Record<string, ReviewFacts["state"]>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** A submitted review; a pending one isn't one yet. */
function reviewOf(review: RawClosedPullRequest["reviews"]["nodes"][number]): ReviewFacts[] {
  const state = REVIEW_STATES[review.state];
  if (state === undefined || review.submittedAt === null) return [];
  return [{ author: loginOf(review.author), state, at: review.submittedAt }];
}

function openPullRequestOf(pr: RawOpenPullRequest): OpenPullRequestFacts {
  return {
    number: pr.number,
    title: pr.title,
    draft: pr.isDraft,
    headSha: pr.headRefOid,
    createdAt: pr.createdAt,
    commits: pr.commits.nodes.map(({ commit }) => ({ at: commit.committedDate })),
    comments: pr.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(pr.timelineItems.nodes),
  };
}

function ticketOf(issue: RawIssue): TicketFacts {
  return {
    number: issue.number,
    labelEvents: labelEventsOf(issue.timelineItems.nodes),
    blockedBy: issue.blockedBy.nodes.map((blocker) => ({ number: blocker.number, labels: blocker.labels.nodes.map((l) => l.name) })),
    closedAt: issue.state === "CLOSED" ? issue.closedAt : null,
  };
}

function specOf(issue: RawIssue): SpecFacts {
  return {
    number: issue.number,
    labelEvents: labelEventsOf(issue.timelineItems.nodes),
    tickets: issue.subIssues.nodes.map((ticket) => ticket.number),
  };
}

function openIssueOf(issue: RawIssue): OpenIssueFacts {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.nodes.map((label) => label.name),
    createdAt: issue.createdAt,
    comments: issue.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(issue.timelineItems.nodes),
  };
}

function openAuditOf(audit: RawAudit): OpenAuditFacts {
  return { number: audit.number, title: audit.title, author: loginOf(audit.author), createdAt: audit.createdAt };
}

function commentOf(comment: RawComment): CommentFacts {
  return { author: loginOf(comment.author), byBot: comment.author?.__typename === "Bot", body: comment.body, at: comment.createdAt };
}

function labelEventsOf(nodes: readonly RawLabelEvent[]): LabelEvent[] {
  return nodes.map((event) => ({
    label: event.label.name,
    action: event.__typename === "UnlabeledEvent" ? "unlabeled" : "labeled",
    actor: loginOf(event.actor),
    at: event.createdAt,
  }));
}

/**
 * A login as REST and the summary spell it. GraphQL gives a GitHub App's bot
 * user without its `[bot]` suffix; a deleted account is `ghost`.
 */
function loginOf(actor: RawActor | null): string {
  if (actor === null) return "ghost";
  return actor.__typename === "Bot" && !actor.login.endsWith("[bot]") ? `${actor.login}[bot]` : actor.login;
}

interface InstallationRepositories {
  total_count: number;
  repositories: { full_name: string; name: string; owner: { login: string }; default_branch: string }[];
}

/**
 * Every repo in the Fabrik App's installation whose default branch has the
 * Kit's caller workflow, apart from the store itself. A repo shows up without
 * any configuration once setup has written its caller.
 */
export async function productReposOf(github: Pick<GitHub, "rest" | "fileText">): Promise<Repo[]> {
  const listed: InstallationRepositories["repositories"] = [];
  for (let page = 1; ; page++) {
    const result = (await github.rest("GET", `/installation/repositories?per_page=100&page=${page}`)) as InstallationRepositories;
    listed.push(...result.repositories);
    if (result.repositories.length === 0 || listed.length >= result.total_count) break;
  }
  const candidates = listed.filter((repo) => repo.full_name.toLowerCase() !== RUN_STORE_REPO.toLowerCase());
  const callers = await Promise.all(
    candidates.map((repo) => github.fileText({ owner: repo.owner.login, name: repo.name }, CALLER_PATH, repo.default_branch)),
  );
  return candidates
    .filter((_, i) => {
      const caller = callers[i];
      return caller !== null && caller !== undefined && fabrikRefsIn(caller).length > 0;
    })
    .map((repo) => ({ owner: repo.owner.login, name: repo.name }));
}
