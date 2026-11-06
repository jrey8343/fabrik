// The Weekly summary's GitHub side, beside the Loop's snapshot gatherer: which
// Product repos the summary covers, and the GitHub facts it reads of each
// (src/kit/weeklySummary.ts), the metrics' among them (src/kit/retroEvidence.ts);
// and the same facts for a Retro's evidence, with the patches its Operator
// feedback reads, and its history: the repo's Retros with their comments and
// the open issues with their bodies. Read-only. It holds no summary, metric or evidence rules;
// those all live in those two modules.
import { fabrikRefsIn } from "../kit/caller.ts";
import type { FromRetroIssueFacts, RetroIssueFacts, TicketTextFacts } from "../kit/retroEvidence.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import type {
  AgentPullRequestFacts,
  CommentFacts,
  CommitFacts,
  EscapeMarkerIssueFacts,
  GitHubFacts,
  LabelEvent,
  MonitorIssueFacts,
  OpenAuditFacts,
  OpenIssueFacts,
  OpenPullRequestFacts,
  OpenRetroFacts,
  ReviewFacts,
  SpecFacts,
  TicketFacts,
} from "../kit/weeklySummary.ts";
import { IMPLEMENTER_AUTHOR, isAgentPullRequest } from "../loop/agentPullRequest.ts";
import { AUDIT_LABEL, MONITOR_LABEL, RETRO_LABEL } from "../loop/labels.ts";
import { escapeMarkerIn, fromPullRequestIn } from "../loop/markers.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { type GitHub, GitHubError, pagesOf, type Repo } from "./client.ts";
import {
  gatherDesignQueueSlice,
  loginOf,
  type RawWeeklyIssue,
  weeklyIssueOf,
  weeklyIssuesQuery,
  type WeeklyIssuesQueryResult,
} from "./snapshot.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the issue facts reach: 30 days, plus the week before, so last
 * week's 30-day revert window is as whole as this week's.
 */
const WINDOW_MS = 37 * DAY_MS;

/**
 * How far back the PRs, the default branch's commits and the issues the
 * Operator opened reach: 90 days, plus the week before, so last week's 90-day
 * escape window is as whole as this week's, and a Retro's 90-day streak table
 * sees every revert in it. Revert rate reads its own 30 days of them.
 */
const ESCAPE_WINDOWS_REACH_MS = 97 * DAY_MS;

/** The GitHub facts the Weekly summary reads of one Product repo, as of `now`, with the Operator's login. */
export function gatherGitHubFacts(github: Pick<GitHub, "graphql">, repo: Repo, now: number, operator: string): Promise<GitHubFacts> {
  return gatherFacts(github, repo, now, operator, now - ESCAPE_WINDOWS_REACH_MS);
}

/** The GitHub facts of one Product repo, as of `now`, with its PRs, default-branch commits and the Operator's issues from `reach` on. */
async function gatherFacts(github: Pick<GitHub, "graphql">, repo: Repo, now: number, operator: string, reach: number): Promise<GitHubFacts> {
  const since = new Date(now - WINDOW_MS).toISOString();
  const escapeSince = new Date(reach).toISOString();
  const [closed, open, updatedIssues, openIssues, defaultBranchCommits, { designQueue }, monitorIssues, operatorIssues, openAudits, openRetros] = await Promise.all([
    gatherClosedPullRequests(github, repo, escapeSince),
    pagesOf<RawOpenPullRequest>(github, OPEN_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests),
    pagesOf<RawIssue>(github, UPDATED_ISSUES_QUERY, repo, { since }, (data) => data.repository.issues),
    pagesOf<RawIssue>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues),
    pagesOf<RawDefaultBranchCommit>(github, DEFAULT_BRANCH_QUERY, repo, { since: escapeSince }, (data) => data.repository.defaultBranchRef?.target.history ?? null),
    // The Design queue check's own slice, so Held and the check can't disagree. Its token can't read
    // workflow runs, so it reads Design turns in progress from the issues, as the scheduled tick does.
    gatherDesignQueueSlice(github, null, repo),
    pagesOf<RawMonitorIssue>(github, MONITOR_ISSUES_QUERY, repo, { monitor: MONITOR_LABEL }, (data) => data.repository.issues),
    gatherOperatorIssues(github, repo, operator, escapeSince),
    pagesOf<RawOpenKitIssue>(github, OPEN_KIT_ISSUES_QUERY, repo, { label: AUDIT_LABEL }, (data) => data.repository.issues),
    pagesOf<RawOpenKitIssue>(github, OPEN_KIT_ISSUES_QUERY, repo, { label: RETRO_LABEL }, (data) => data.repository.issues),
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
    monitorIssues: monitorIssues.map(monitorIssueOf),
    escapeMarkerIssues: operatorIssues.filter((issue) => escapeMarkerIn(issue.body) !== null).map(escapeMarkerIssueOf),
    followUpIssues: operatorIssues
      .filter((issue) => fromPullRequestIn(issue.body) !== null)
      .map(({ number, title, author, body }) => ({ number, title, author: loginOf(author), body })),
    openAudits: openAudits.map(openKitIssueOf),
    openRetros: openRetros.map(openKitIssueOf),
  };
}

/**
 * The GitHub facts a Retro reads of one Product repo, as of `now`: the
 * Weekly summary's, with the patch of each commit on an agent PR that the
 * Fabrik App didn't make, read one commit at a time. Its PRs, default-branch
 * commits and the Operator's issues reach back the summary's 97 days, or to
 * `from`, the earliest time its evidence reads (evidenceReachOf,
 * src/kit/retroEvidence.ts), when that's earlier, as for a Retro held back
 * for weeks, so its window is read whole.
 */
export async function gatherRetroFacts(
  github: Pick<GitHub, "graphql" | "rest">,
  repo: Repo,
  now: number,
  operator: string,
  from: number,
): Promise<GitHubFacts> {
  const facts = await gatherFacts(github, repo, now, operator, Math.min(now - ESCAPE_WINDOWS_REACH_MS, from));
  const patches = new Map<string, Promise<string>>();
  const withPatch = async (commit: CommitFacts): Promise<CommitFacts> => {
    if (commit.byApp) return commit;
    const patch = patches.get(commit.sha) ?? patchOf(github, repo, commit.sha);
    patches.set(commit.sha, patch);
    return { ...commit, patch: await patch };
  };
  const [pullRequests, openPullRequests] = await Promise.all([
    Promise.all(facts.pullRequests.map(async (pullRequest) => ({ ...pullRequest, commits: await Promise.all(pullRequest.commits.map(withPatch)) }))),
    Promise.all(facts.openPullRequests.map(async (pullRequest) => ({ ...pullRequest, commits: await Promise.all(pullRequest.commits.map(withPatch)) }))),
  ]);
  return { ...facts, pullRequests, openPullRequests };
}

/** What a Retro reads of the Retros before it, and of the issues filed from them. */
export interface RetroHistoryFacts {
  /** The newest `fabrik:retro` issues, open and closed, the one being filled among them, each with its comments. */
  readonly retros: readonly RetroIssueFacts[];
  /** Every open issue, with its body: the Retro evidence module keeps those filed from a Retro, by their `From retro #n` line. */
  readonly openIssues: readonly FromRetroIssueFacts[];
}

/**
 * A Retro's history in one Product repo: the newest `fabrik:retro` issues,
 * read as the tick's retro slice reads them (weeklyIssuesQuery), with whether
 * the Fabrik App, whose bot login is `appLogin`, opened each (byAppOf) and,
 * on top, their last 100 comments; and every open issue with its body.
 */
export async function gatherRetroHistory(github: Pick<GitHub, "graphql">, repo: Repo, appLogin: string): Promise<RetroHistoryFacts> {
  const [retros, openIssues] = await Promise.all([
    github.graphql<WeeklyIssuesQueryResult<RawRetroIssue>>(weeklyIssuesQuery(COMMENTS), {
      owner: repo.owner,
      name: repo.name,
      label: RETRO_LABEL,
    }),
    pagesOf<FromRetroIssueFacts>(github, OPEN_ISSUE_BODIES_QUERY, repo, {}, (data) => data.repository.issues),
  ]);
  return {
    retros: retros.repository.issues.nodes.map((issue) => ({
      ...weeklyIssueOf(issue, appLogin),
      comments: issue.comments.nodes.map(commentOf),
    })),
    openIssues: openIssues.map(({ number, title, body }) => ({ number, title, body })),
  };
}

/**
 * The title and body of each of these Tickets, as GitHub has them now, one
 * call per Ticket, as the judge reads the Ticket it scores against
 * (src/kit/judge-ticket-main.ts): what a Retro's evidence carries for each
 * escaped and sampled PR (evidenceTicketsOf, src/kit/retroEvidence.ts). One
 * GitHub no longer has, deleted or gone, is left out; any other failure fails.
 */
export async function gatherTickets(github: Pick<GitHub, "rest">, repo: Repo, numbers: readonly number[]): Promise<TicketTextFacts[]> {
  const tickets = await Promise.all(
    [...new Set(numbers)].map(async (number): Promise<TicketTextFacts | null> => {
      try {
        const issue = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/issues/${number}`)) as { title?: unknown; body?: unknown };
        return { number, title: typeof issue.title === "string" ? issue.title : "", body: typeof issue.body === "string" ? issue.body : "" };
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      }
    }),
  );
  return tickets.filter((ticket) => ticket !== null);
}

/** What a commit changed, as a diff file by file; a file GitHub shows no patch for is named with a note. */
async function patchOf(github: Pick<GitHub, "rest">, repo: Repo, sha: string): Promise<string> {
  const { files } = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}`)) as {
    files: { filename: string; previous_filename?: string; patch?: string }[];
  };
  return files
    .map((file) =>
      [
        `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`,
        file.patch ?? "(No textual diff: a binary file, or too large for GitHub to show.)",
      ].join("\n"),
    )
    .join("\n");
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
const COMMIT = "commit { oid message committedDate author { email user { login } } }";
const REVIEWS = `reviews(first: 100) { nodes { author ${ACTOR} state submittedAt body comments(first: 50) { nodes { path line body } } } }`;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

const OPEN_ISSUE_BODIES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after) {
        ${PAGE_INFO}
        nodes { number title body }
      }
    }
  }
`;

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
          commits(first: 100) { nodes { ${COMMIT} } }
          ${REVIEWS}
          ${COMMENTS}
          ${LABEL_EVENTS}
          files(first: 100) { nodes { path } }
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
          commits(last: 100) { nodes { ${COMMIT} } }
          ${REVIEWS}
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

// The open Monitor issues, with their bodies: Held reads the Monitor's held count from their stats blocks.
const MONITOR_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $monitor: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$monitor], first: 25, after: $after) {
        ${PAGE_INFO}
        nodes { number body author ${ACTOR} }
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
        nodes { number title createdAt state body author ${ACTOR} }
      }
    }
  }
`;

// The open Audits or Retros, by their label, whoever opened them: the summary keeps the Fabrik App's.
const OPEN_KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $label: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$label], first: 25, after: $after) {
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

interface RawCommit {
  commit: { oid: string; message: string; committedDate: string; author: { email: string | null; user: { login: string } | null } | null };
}

interface RawReview {
  author: RawActor | null;
  state: string;
  submittedAt: string | null;
  body: string;
  comments: { nodes: { path: string; line: number | null; body: string }[] };
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
  commits: { nodes: RawCommit[] };
  reviews: { nodes: RawReview[] };
  comments: { nodes: RawComment[] };
  timelineItems: { nodes: RawLabelEvent[] };
  files: { nodes: { path: string }[] };
}

interface RawOpenPullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  createdAt: string;
  author: RawActor | null;
  commits: { nodes: RawCommit[] };
  reviews: { nodes: RawReview[] };
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

/** A `fabrik:retro` issue as a Retro's history reads it: as the tick does, with its comments on top. */
type RawRetroIssue = RawWeeklyIssue & { comments: { nodes: RawComment[] } };

interface RawMonitorIssue {
  number: number;
  body: string;
  author: RawActor | null;
}

interface RawOpenedIssue {
  number: number;
  title: string;
  createdAt: string;
  state: "OPEN" | "CLOSED";
  body: string;
  author: RawActor | null;
}

interface RawOpenKitIssue {
  number: number;
  title: string;
  createdAt: string;
  author: RawActor | null;
}

interface RawDefaultBranchCommit {
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

/** The issues the Operator opened in the window, newest first. */
async function gatherOperatorIssues(github: Pick<GitHub, "graphql">, repo: Repo, operator: string, since: string): Promise<RawOpenedIssue[]> {
  const sinceMs = Date.parse(since);
  const issues = await pagesOf<RawOpenedIssue>(
    github,
    ISSUES_OPENED_BY_QUERY,
    repo,
    { operator },
    (data) => data.repository.issues,
    (page) => page.some((issue) => Date.parse(issue.createdAt) < sinceMs),
  );
  return issues.filter((issue) => Date.parse(issue.createdAt) >= sinceMs);
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
    commits: pr.commits.nodes.map(commitOf),
    reviews: pr.reviews.nodes.flatMap(reviewOf),
    comments: pr.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(pr.timelineItems.nodes),
    changedPaths: pr.files.nodes.map((file) => file.path),
  };
}

const REVIEW_STATES: Readonly<Record<string, ReviewFacts["state"]>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** A submitted review; a pending one isn't one yet. */
function reviewOf(review: RawReview): ReviewFacts[] {
  const state = REVIEW_STATES[review.state];
  if (state === undefined || review.submittedAt === null) return [];
  return [
    {
      author: loginOf(review.author),
      state,
      body: review.body,
      comments: review.comments.nodes,
      at: review.submittedAt,
    },
  ];
}

/** A commit on an agent PR's branch, its patch unread: the Implementer's are the App's, as its commits carry its identity. */
function commitOf({ commit }: RawCommit): CommitFacts {
  return {
    sha: commit.oid,
    byApp: commit.author?.email === IMPLEMENTER_AUTHOR.email,
    author: commit.author?.user?.login ?? "ghost",
    message: commit.message,
    patch: null,
    at: commit.committedDate,
  };
}

function openPullRequestOf(pr: RawOpenPullRequest): OpenPullRequestFacts {
  return {
    number: pr.number,
    title: pr.title,
    draft: pr.isDraft,
    headSha: pr.headRefOid,
    createdAt: pr.createdAt,
    commits: pr.commits.nodes.map(commitOf),
    reviews: pr.reviews.nodes.flatMap(reviewOf),
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

/** An issue whose body has an escape marker, such as a filed Audit candidate. */
function escapeMarkerIssueOf(issue: RawOpenedIssue): EscapeMarkerIssueFacts {
  return {
    number: issue.number,
    title: issue.title,
    author: loginOf(issue.author),
    createdAt: issue.createdAt,
    state: issue.state === "CLOSED" ? "closed" : "open",
    body: issue.body,
  };
}

function monitorIssueOf(issue: RawMonitorIssue): MonitorIssueFacts {
  return { number: issue.number, author: loginOf(issue.author), body: issue.body };
}

function openKitIssueOf(issue: RawOpenKitIssue): OpenAuditFacts & OpenRetroFacts {
  return { number: issue.number, title: issue.title, author: loginOf(issue.author), createdAt: issue.createdAt };
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
