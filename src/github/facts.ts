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
  DraftEvent,
  EscapeMarkerIssueFacts,
  GitHubFacts,
  LabelEvent,
  MonitorIssueFacts,
  OpenAuditFacts,
  OpenIssueFacts,
  OpenPullRequestFacts,
  OpenRetroFacts,
  PlainPullRequestFacts,
  RequiredCheckFact,
  RequiredChecksFact,
  ReviewFacts,
  SpecFacts,
  TicketFacts,
  UnreadRepo,
  WeeklyRunIssueFacts,
} from "../kit/weeklySummary.ts";
import { IMPLEMENTER_AUTHOR, isAgentPullRequest } from "../loop/agentPullRequest.ts";
import { AUDIT_LABEL, MONITOR_LABEL, REPLAY_LABEL, RETRO_LABEL } from "../loop/labels.ts";
import { escapeMarkerIn, fromPullRequestIn } from "../loop/markers.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import { type CheckState, requiredChecksOutcome } from "../review/checks.ts";
import { allPages, GitHubError, pagesOf, type ReadClient, type Repo } from "./client.ts";
import { leavingOutHeldLines } from "./heldLines.ts";
import {
  gatherDesignQueueSlice,
  gatherKitIssues,
  gatherWeekCarriers,
  gatherOpenMaps,
  loginOf,
  type MergeableState,
  mergeableOf,
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
/** How far back the Carriers are read: the summary's week, ending at the last Monday in any time zone, and the days before it. */
const CARRIERS_REACH_MS = 14 * DAY_MS;

/**
 * How far back the PRs, the default branch's commits and the issues the
 * Operator opened reach: 90 days, plus the week before, so last week's 90-day
 * escape window is as whole as this week's, and a Retro's 90-day streak table
 * sees every revert in it. Revert rate reads its own 30 days of them.
 */
const ESCAPE_WINDOWS_REACH_MS = 97 * DAY_MS;

/** The GitHub facts the Weekly summary reads of one Product repo, as of `now`, with the Operator's login. */
export function gatherGitHubFacts(github: Pick<ReadClient, "graphql">, repo: Repo, now: number, operator: string): Promise<GitHubFacts> {
  return gatherFacts(github, repo, now, operator, now - ESCAPE_WINDOWS_REACH_MS);
}

/**
 * The GitHub facts the Weekly summary reads of each Product repo, as of `now`.
 * A repo whose facts it couldn't read, on a GitHub error or a repo gone since
 * the listing, is named in `unread`, with why, and the rest are read as
 * usual, so one repo's failure costs the summary only that repo's facts.
 */
export async function gatherEveryRepoFacts(
  github: Pick<ReadClient, "graphql">,
  repos: readonly Repo[],
  now: number,
  operator: string,
): Promise<{ facts: GitHubFacts[]; unread: UnreadRepo[] }> {
  const gathered = await Promise.all(
    repos.map(async (repo) => {
      try {
        return { facts: await gatherGitHubFacts(github, repo, now, operator), unread: null };
      } catch (error) {
        return { facts: null, unread: { repo: `${repo.owner}/${repo.name}`, why: error instanceof Error ? error.message : String(error) } };
      }
    }),
  );
  return {
    facts: gathered.flatMap(({ facts }) => (facts === null ? [] : [facts])),
    unread: gathered.flatMap(({ unread }) => (unread === null ? [] : [unread])),
  };
}

/**
 * The Required checks on each of these heads, its open Plain pull requests',
 * by sha: each check the Kit config lists (`listedChecks`, its
 * `sandbox.checks`), in its order, judged from the check runs on the head as
 * the Review's wait judges them (requiredChecksOutcome). Read with a token
 * holding Checks read. With no checks listed it reads nothing, every head left
 * unread: it cannot tell which checks the branch requires, and it never counts
 * every check on the head, since `loop / Kit` reports there and is no Required
 * check. A head whose read GitHub refuses is left unread too.
 */
export async function gatherHeadChecks(
  github: Pick<ReadClient, "rest">,
  repo: Repo,
  heads: readonly string[],
  listedChecks: readonly string[],
): Promise<Record<string, RequiredChecksFact>> {
  if (listedChecks.length === 0) return {};
  const read = await Promise.all(
    [...new Set(heads)].map(async (head) => {
      try {
        const runs = await allPages<RawCheckRun>(github, `/repos/${repo.owner}/${repo.name}/commits/${head}/check-runs`, (page) => (page as { check_runs: RawCheckRun[] }).check_runs);
        return [[head, requiredChecksOn(runs.map(checkStateOf), listedChecks)] as const];
      } catch (error) {
        if (error instanceof GitHubError) return [];
        throw error;
      }
    }),
  );
  return Object.fromEntries(read.flat());
}

/** A check run on a head, as the Checks API lists it. */
interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** A check run's bucket, as `gh pr checks` buckets it for the Review's wait. */
function checkStateOf({ name, status, conclusion }: RawCheckRun): CheckState {
  if (status !== "completed") return { name, bucket: "pending" };
  switch (conclusion) {
    case "success":
      return { name, bucket: "pass" };
    case "skipped":
    case "neutral":
      return { name, bucket: "skipping" };
    case "cancelled":
      return { name, bucket: "cancel" };
    default:
      return { name, bucket: "fail" };
  }
}

/** Each listed check on a head, each judged by the Review's rule alone. */
function requiredChecksOn(checks: readonly CheckState[], listedChecks: readonly string[]): RequiredCheckFact[] {
  return listedChecks.map((name) => {
    const outcome = requiredChecksOutcome(
      checks.filter((check) => check.name === name),
      [name],
    );
    switch (outcome.kind) {
      case "green":
        return { name, is: "passed" };
      case "red":
        return { name, is: "failing" };
      case "pending":
        return { name, is: outcome.running.length > 0 ? "running" : "never-reported" };
    }
  });
}

/** The GitHub facts of one Product repo, as of `now`, with its PRs, default-branch commits and the Operator's issues from `reach` on. */
async function gatherFacts(client: Pick<ReadClient, "graphql">, repo: Repo, now: number, operator: string, reach: number): Promise<GitHubFacts> {
  // A held line is never activity, nor an issue's last comment (#471).
  const github = leavingOutHeldLines(client);
  const since = new Date(now - WINDOW_MS).toISOString();
  const escapeSince = new Date(reach).toISOString();
  const [closed, open, updatedIssues, openIssues, defaultBranchCommits, { designQueue }, monitorIssues, operatorIssues, openAudits, openRetros, audits, retros, openMaps, openReplays, { kitIssues }, weekCarriers] = await Promise.all([
    gatherClosedPullRequests(github, repo, escapeSince),
    pagesOf<RawOpenPullRequest>(github, OPEN_PULL_REQUESTS_QUERY, repo, {}, (data) => data.repository.pullRequests),
    pagesOf<RawIssue>(github, UPDATED_ISSUES_QUERY, repo, { since }, (data) => data.repository.issues),
    pagesOf<RawIssue>(github, OPEN_ISSUES_QUERY, repo, {}, (data) => data.repository.issues),
    pagesOf<RawDefaultBranchCommit>(github, DEFAULT_BRANCH_QUERY, repo, { since: escapeSince }, (data) => data.repository.defaultBranchRef?.target.history ?? null),
    // The Design queue check's own slice, so Held and the check can't disagree. Its token can't read
    // workflow runs, so it reads Design turns in progress from the issues, as the scheduled tick does.
    // It doesn't know the App's login, so it takes any bot's markers for the App's (byAppOf).
    gatherDesignQueueSlice(github, null, repo, null),
    pagesOf<RawMonitorIssue>(github, MONITOR_ISSUES_QUERY, repo, { monitor: MONITOR_LABEL }, (data) => data.repository.issues),
    gatherOperatorIssues(github, repo, operator, escapeSince),
    pagesOf<RawOpenKitIssue>(github, OPEN_KIT_ISSUES_QUERY, repo, { label: AUDIT_LABEL }, (data) => data.repository.issues),
    pagesOf<RawOpenKitIssue>(github, OPEN_KIT_ISSUES_QUERY, repo, { label: RETRO_LABEL }, (data) => data.repository.issues),
    // The weekly gates' own read, so Stuck and the gates count the same failed runs.
    gatherWeeklyRunIssues(github, repo, AUDIT_LABEL),
    gatherWeeklyRunIssues(github, repo, RETRO_LABEL),
    // The Map cap's own read, so Held and the cap can't disagree.
    gatherOpenMaps(github, repo),
    pagesOf<RawOpenReplay>(github, OPEN_REPLAYS_QUERY, repo, { replay: REPLAY_LABEL }, (data) => data.repository.issues),
    // The Loop's own read, so Held and the scheduled tick's resume can't disagree. It doesn't know
    // the App's login, so it takes any bot's text for the App's, as the Design queue slice does.
    gatherKitIssues(github, repo, null),
    // The Carriers, closed ones included, whose waiting markers name an Audit or Retro week skipped for want of a free Subscription (#442).
    // It doesn't know the App's login either, so it takes any bot's text for the App's, as gatherKitIssues does here.
    gatherWeekCarriers(github, repo, null, new Date(now - CARRIERS_REACH_MS).toISOString()),
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
    plainPullRequests: open.filter((pr) => !isAgent(pr)).map(plainPullRequestOf),
    designQueue,
    monitorIssues: monitorIssues.map(monitorIssueOf),
    escapeMarkerIssues: operatorIssues.filter((issue) => escapeMarkerIn(issue.body) !== null).map(escapeMarkerIssueOf),
    followUpIssues: operatorIssues
      .filter((issue) => fromPullRequestIn(issue.body) !== null)
      .map(({ number, title, author, body }) => ({ number, title, author: loginOf(author), body })),
    openAudits: openAudits.map(openKitIssueOf),
    openRetros: openRetros.map(openKitIssueOf),
    audits,
    retros,
    openReplays: openReplays.map(({ number, title, createdAt, lastEditedAt, body, author }) => ({ number, title, author: loginOf(author), createdAt, lastEditedAt, body })),
    openMaps: openMaps.map((map) => map.number),
    kitIssues,
    weekCarriers,
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
  github: Pick<ReadClient, "graphql" | "rest">,
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

/** The newest issues with a weekly gate's label, `fabrik:audit` or `fabrik:retro`, open and closed, read as the gate reads them (weeklyIssuesQuery). */
export async function gatherWeeklyRunIssues(github: Pick<ReadClient, "graphql">, repo: Repo, label: string): Promise<WeeklyRunIssueFacts[]> {
  const data = await github.graphql<WeeklyIssuesQueryResult>(weeklyIssuesQuery(), { owner: repo.owner, name: repo.name, label });
  return data.repository.issues.nodes.map(({ number, title, author, createdAt, body }) => ({ number, title, author: loginOf(author), createdAt, body }));
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
export async function gatherRetroHistory(github: Pick<ReadClient, "graphql">, repo: Repo, appLogin: string): Promise<RetroHistoryFacts> {
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
 * Every open issue, with its body, on each of these repos, owner/name, each
 * by the repo it's on: what a Retro reads of the proposals its Product repo's
 * Retros filed on the Kit's repo or a Skills source (the Retro evidence module
 * keeps those whose `From retro` line names the Product repo). A repo it can't
 * read, private to the token say, is named in `unread`, with why, and the rest
 * are read as usual, so one unreadable repo costs the Retro only its issues.
 */
export async function gatherOpenIssuesOn(
  github: Pick<ReadClient, "graphql">,
  repos: readonly string[],
): Promise<{ issues: FromRetroIssueFacts[]; unread: { repo: string; why: string }[] }> {
  const read = await Promise.all(
    repos.map(async (repo) => {
      const [owner = "", name = ""] = repo.split("/");
      try {
        const issues = await pagesOf<FromRetroIssueFacts>(github, OPEN_ISSUE_BODIES_QUERY, { owner, name }, {}, (data) => data.repository.issues);
        return { repo, issues: issues.map(({ number, title, body }) => ({ repo, number, title, body })), why: null };
      } catch (error) {
        return { repo, issues: [], why: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return {
    issues: read.flatMap(({ issues }) => issues),
    unread: read.flatMap(({ repo, why }) => (why === null ? [] : [{ repo, why }])),
  };
}

/**
 * The title and body of each of these Tickets, as GitHub has them now, one
 * call per Ticket, as the judge reads the Ticket it scores against
 * (src/kit/judge-ticket-main.ts): what a Retro's evidence carries for each
 * escaped and sampled PR (evidenceTicketsOf, src/kit/retroEvidence.ts). One
 * GitHub no longer has, deleted or gone, is left out; any other failure fails.
 */
export async function gatherTickets(github: Pick<ReadClient, "rest">, repo: Repo, numbers: readonly number[]): Promise<TicketTextFacts[]> {
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
async function patchOf(github: Pick<ReadClient, "rest">, repo: Repo, sha: string): Promise<string> {
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

export const ACTOR = "{ login __typename }";
export const LABEL_EVENTS = `
  timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
    nodes {
      __typename
      ... on LabeledEvent { createdAt actor ${ACTOR} label { name } }
      ... on UnlabeledEvent { createdAt actor ${ACTOR} label { name } }
    }
  }
`;
// Aliased, as the label events read the same connection with other arguments.
export const DRAFT_EVENTS = `
  draftEvents: timelineItems(last: 100, itemTypes: [CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT]) {
    nodes {
      __typename
      ... on ConvertToDraftEvent { createdAt actor ${ACTOR} }
      ... on ReadyForReviewEvent { createdAt actor ${ACTOR} }
    }
  }
`;
export const COMMENTS = `comments(last: 100) { nodes { url body createdAt author ${ACTOR} } }`;
export const COMMIT = "commit { oid message committedDate author { email user { login } } }";
const REVIEWS = `reviews(first: 100) { nodes { databaseId url author ${ACTOR} state submittedAt body comments(first: 50) { nodes { path line body } } } }`;
export const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

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
          number title isDraft headRefOid headRefName createdAt mergeable
          author ${ACTOR}
          closingIssuesReferences(first: 10) { nodes { number } }
          commits(last: 100) { nodes { ${COMMIT} } }
          ${REVIEWS}
          ${COMMENTS}
          ${LABEL_EVENTS}
          ${DRAFT_EVENTS}
        }
      }
    }
  }
`;

const ISSUE_FIELDS = `
  number title state createdAt closedAt
  author ${ACTOR}
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

// Each open replay issue's body, whose markers say whether its results are in.
const OPEN_REPLAYS_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $replay: String!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, labels: [$replay], first: 25, after: $after) {
        ${PAGE_INFO}
        nodes { number title createdAt lastEditedAt body author ${ACTOR} }
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

export interface RawActor {
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
  url: string;
  body: string;
  createdAt: string;
  author: RawActor | null;
}

interface RawCommit {
  commit: { oid: string; message: string; committedDate: string; author: { email: string | null; user: { login: string } | null } | null };
}

export interface RawReview {
  databaseId: number;
  url: string;
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

export interface RawOpenPullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  createdAt: string;
  mergeable: MergeableState;
  author: RawActor | null;
  closingIssuesReferences: { nodes: { number: number }[] };
  commits: { nodes: RawCommit[] };
  reviews: { nodes: RawReview[] };
  comments: { nodes: RawComment[] };
  timelineItems: { nodes: RawLabelEvent[] };
  draftEvents: { nodes: RawDraftEvent[] };
}

/** A pull request going into draft or out of it, by whom. */
interface RawDraftEvent {
  __typename: string;
  createdAt: string;
  actor: RawActor | null;
}

export interface RawIssue {
  number: number;
  title: string;
  author: RawActor | null;
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

export interface RawOpenKitIssue {
  number: number;
  title: string;
  createdAt: string;
  author: RawActor | null;
}

interface RawOpenReplay extends RawOpenKitIssue {
  lastEditedAt: string | null;
  body: string;
}

interface RawDefaultBranchCommit {
  message: string;
  committedDate: string;
}

/** The PRs merged or closed in the window, agent or not. */
async function gatherClosedPullRequests(github: Pick<ReadClient, "graphql">, repo: Repo, since: string): Promise<RawClosedPullRequest[]> {
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
async function gatherOperatorIssues(github: Pick<ReadClient, "graphql">, repo: Repo, operator: string, since: string): Promise<RawOpenedIssue[]> {
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

export function isAgent(pullRequest: { headRefName: string; author: RawActor | null }): boolean {
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
      id: review.databaseId,
      url: review.url,
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

export function openPullRequestOf(pr: RawOpenPullRequest): OpenPullRequestFacts {
  return {
    number: pr.number,
    ticket: pr.closingIssuesReferences.nodes[0]?.number ?? null,
    title: pr.title,
    draft: pr.isDraft,
    headSha: pr.headRefOid,
    createdAt: pr.createdAt,
    commits: pr.commits.nodes.map(commitOf),
    reviews: pr.reviews.nodes.flatMap(reviewOf),
    comments: pr.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(pr.timelineItems.nodes),
    mergeable: mergeableOf(pr.mergeable),
    draftEvents: draftEventsOf(pr.draftEvents.nodes),
  };
}

/** When a pull request went into draft and out of it, and who did it, oldest first. */
function draftEventsOf(nodes: readonly RawDraftEvent[]): DraftEvent[] {
  return nodes
    .map(({ __typename, createdAt, actor }): DraftEvent => ({ kind: __typename === "ConvertToDraftEvent" ? "draft" : "ready", actor: loginOf(actor), at: createdAt }))
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** An open Plain pull request: who opened it, its branch and head, whether it is a draft and merges cleanly, and when its draft state last changed. Its reviews, labels and comments, which the Kit never acts on, are left out. */
export function plainPullRequestOf(pr: RawOpenPullRequest): PlainPullRequestFacts {
  return {
    number: pr.number,
    title: pr.title,
    author: loginOf(pr.author),
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    headCommittedAt: pr.commits.nodes.find(({ commit }) => commit.oid === pr.headRefOid)?.commit.committedDate ?? null,
    draft: pr.isDraft,
    mergeable: mergeableOf(pr.mergeable),
    closes: pr.closingIssuesReferences.nodes.map(({ number }) => number),
    draftChangedAt: draftEventsOf(pr.draftEvents.nodes).at(-1)?.at ?? null,
    createdAt: pr.createdAt,
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

export function openIssueOf(issue: RawIssue): OpenIssueFacts {
  return {
    number: issue.number,
    title: issue.title,
    author: loginOf(issue.author),
    labels: issue.labels.nodes.map((label) => label.name),
    createdAt: issue.createdAt,
    comments: issue.comments.nodes.map(commentOf),
    labelEvents: labelEventsOf(issue.timelineItems.nodes),
    subIssues: issue.subIssues.nodes.map((subIssue) => subIssue.number),
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

export function openKitIssueOf(issue: RawOpenKitIssue): OpenAuditFacts & OpenRetroFacts {
  return { number: issue.number, title: issue.title, author: loginOf(issue.author), createdAt: issue.createdAt };
}

function commentOf(comment: RawComment): CommentFacts {
  return { url: comment.url, author: loginOf(comment.author), byBot: comment.author?.__typename === "Bot", body: comment.body, at: comment.createdAt };
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
export async function productReposOf(github: Pick<ReadClient, "rest" | "fileText">): Promise<Repo[]> {
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
