// The queries of the gather shaped for Home (./gather.ts): what it asks GitHub
// beyond the reads it shares with the Loop. They are built from the Weekly
// summary's own parts (src/github/facts.ts), less what no Standing reads, so
// an answer maps into the same facts. None asks for a connection inside a
// connection inside a connection, the shape GitHub charges for
// (./queryShape.ts): the Weekly summary's open pull requests ask for review
// line comments, and its open issues for blockers' labels; these ask for
// neither. Beyond the Weekly summary's, they ask for each comment's id and the
// body of each pull request, open or merged, for its evidence marker (#639),
// for GitHub's record of an edit to each of a pull request's comments (#655),
// and for why each issue cross-referenced to a pull request is in its state,
// with one query more, by number, for the comments of those closed as not
// planned (#664). In a repo whose Kit config declares `staging`, and in no
// other, they ask for the merged pull requests a page at a time with their
// label events and the issues that name them, and for an environment's
// Deployments (#856).
import { BLOCKED_BY, type RawBlockedBy } from "../github/blockers.ts";
import { ACTOR, COMMENTS, COMMIT, DRAFT_EVENTS, LABEL_EVENTS, PAGE_INFO, type RawIssue, type RawLabelEvent, type RawOpenPullRequest, type RawReview } from "../github/facts.ts";

/** An issue's last 100 comments, as the Weekly summary reads them, with each one's id: a Prototype's round is known by its comment. */
export const COMMENTS_WITH_IDS = `comments(last: 100) { nodes { databaseId url body createdAt author ${ACTOR} } }`;

/**
 * A pull request's last 100 comments, as COMMENTS_WITH_IDS reads an issue's,
 * with when GitHub records the last edit of each one's body, by which a
 * Digest a person edited is told (#655). That is `lastEditedAt`, a field of
 * the comment's own, and never `updatedAt`, which collapsing a comment
 * moves: a real comment collapsed as outdated was seen to read updated the
 * second it was hidden, with no edit recorded.
 */
export const COMMENTS_WITH_EDITS = `comments(last: 100) { nodes { databaseId url body createdAt lastEditedAt author ${ACTOR} } }`;

/** A comment as COMMENTS_WITH_IDS reads it, or COMMENTS_WITH_EDITS. */
export interface RawHomeComment {
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  /** Where COMMENTS_WITH_EDITS asked: when its body was last edited, or null when GitHub records no edit of it. */
  lastEditedAt?: string | null;
  author: { login: string; __typename: string } | null;
}

/** The repo's owner, its default branch and that branch's head. */
export const REPO_QUERY = `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      defaultBranchRef { name target { oid } }
    }
  }
`;

/** What REPO_QUERY reads. */
export interface RepoQueryResult {
  repository: { owner: { login: string }; defaultBranchRef: { name: string; target: { oid: string } } | null };
}

/** A pull request's reviews, as the Weekly summary reads them, but for their line comments, which no Standing reads. */
const REVIEWS = `reviews(first: 100) { nodes { databaseId url author ${ACTOR} state submittedAt body } }`;

/** The issues GitHub cross-references to a pull request: the latest 50 references, an issue's with where it is, whether it is open and why it is in that state. */
const CROSS_REFERENCES = `
  crossReferences: timelineItems(last: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
    nodes {
      __typename
      ... on CrossReferencedEvent { source { __typename ... on Issue { number title state stateReason repository { nameWithOwner } } } }
    }
  }
`;

/**
 * These issues by number, each with its latest hundred comments as the
 * Weekly summary reads an issue's, under an alias of its own, `issue` and
 * its number: one query however many they are. Made only for the issues of
 * the repo, closed as not planned, that GitHub cross-references to an open
 * agent pull request, where a Roll-in's closing comment is (#664): a repo
 * with none makes no such query.
 */
export function closedIssueCommentsQuery(numbers: readonly number[]): string {
  return `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${numbers.map((number) => `issue${number}: issue(number: ${number}) { number ${COMMENTS} }`).join("\n      ")}
    }
  }
`;
}

/** What closedIssueCommentsQuery reads: each issue by its alias, null for a number GitHub has no issue of. */
export interface ClosedIssueCommentsQueryResult {
  repository: Record<string, { number: number; comments: { nodes: { url: string; body: string; createdAt: string; author: { login: string; __typename: string } | null }[] } } | null>;
}

/** Every open pull request, agent and Plain, as the Weekly summary reads them, with each one's body, cross-references and whether the issues it closes are open. */
export const OPEN_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 25, after: $after) {
        ${PAGE_INFO}
        nodes {
          number title body isDraft headRefOid headRefName createdAt mergeable
          author ${ACTOR}
          closingIssuesReferences(first: 10) { nodes { number state } }
          commits(last: 100) { nodes { ${COMMIT} } }
          ${REVIEWS}
          ${COMMENTS_WITH_EDITS}
          ${LABEL_EVENTS}
          ${DRAFT_EVENTS}
          ${CROSS_REFERENCES}
        }
      }
    }
  }
`;

/** A review as REVIEWS reads it. */
export type RawHomeReview = Omit<RawReview, "comments">;

/** A cross-reference as CROSS_REFERENCES reads it: an issue's source, or another kind's, of which only the kind is read. */
export interface RawCrossReference {
  __typename: string;
  source?: {
    __typename: string;
    number?: number;
    title?: string;
    state?: "OPEN" | "CLOSED";
    /** Why the issue is in its state, as GitHub's GraphQL names it; null when GitHub records no reason. */
    stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
    repository?: { nameWithOwner: string };
  };
}

/** An open pull request as OPEN_PULL_REQUESTS_QUERY reads it. */
export type RawHomePullRequest = Omit<RawOpenPullRequest, "reviews" | "closingIssuesReferences" | "comments"> & {
  /** Its body, where an agent pull request's evidence marker is. */
  body: string;
  comments: { nodes: RawHomeComment[] };
  /** Each issue it closes, its Ticket first on an agent pull request, with its state when GitHub gives one. */
  closingIssuesReferences: { nodes: { number: number; state?: "OPEN" | "CLOSED" }[] };
  reviews: { nodes: RawHomeReview[] };
  crossReferences: { nodes: RawCrossReference[] };
};

/** Every open issue, as the Weekly summary reads them, but for its blockers' labels, with its body and when that was last edited. */
export const OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 25, after: $after) {
        ${PAGE_INFO}
        nodes {
          number title state createdAt closedAt lastEditedAt body
          author ${ACTOR}
          labels(first: 50) { nodes { name } }
          ${COMMENTS_WITH_IDS}
          ${LABEL_EVENTS}
          ${BLOCKED_BY}
          subIssues(first: 100) { nodes { number } }
        }
      }
    }
  }
`;

/** An open issue as OPEN_ISSUES_QUERY reads it. */
export type RawHomeIssue = Omit<RawIssue, "blockedBy" | "comments"> & {
  body: string;
  lastEditedAt: string | null;
  comments: { nodes: RawHomeComment[] };
  blockedBy: RawBlockedBy;
};

/** The newest-updated merged pull requests, one page, with each one's body: the agent ones merged in the last 24 hours are kept. */
export const MERGED_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 25, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number title body mergedAt headRefName
          author ${ACTOR}
          mergeCommit { oid }
          closingIssuesReferences(first: 10) { nodes { number } }
        }
      }
    }
  }
`;

/** A merged pull request as MERGED_PULL_REQUESTS_QUERY reads it. */
export interface RawMergedPullRequest {
  number: number;
  title: string;
  /** Where an agent pull request's evidence marker is. */
  body: string;
  mergedAt: string | null;
  headRefName: string;
  author: { login: string; __typename: string } | null;
  mergeCommit: { oid: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
}

/** What MERGED_PULL_REQUESTS_QUERY reads. */
export interface MergedPullRequestsQueryResult {
  repository: { pullRequests: { nodes: RawMergedPullRequest[] } };
}

/**
 * An issue of the repo as a merged pull request's read in a repo that
 * declares `staging` gives it (#856), cross-referenced to the pull request or
 * closed by it: its body, where a Trial problem's line is, and whether and
 * why it is closed.
 */
const TRIAL_ISSUE = "number title state stateReason body repository { nameWithOwner }";

/** The issues GitHub cross-references to a merged pull request, as CROSS_REFERENCES reads an open one's, each with its body: a Trial problem names the pull request it was found on there. */
const CROSS_REFERENCES_WITH_BODIES = `
  crossReferences: timelineItems(last: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
    nodes {
      __typename
      ... on CrossReferencedEvent { source { __typename ... on Issue { ${TRIAL_ISSUE} } } }
    }
  }
`;

/**
 * The merged pull requests of a repo that declares `staging` (#856,
 * ADR-0038), newest-updated first, a page at a time: what
 * MERGED_PULL_REQUESTS_QUERY reads of each, with when it was last updated,
 * by which the gather knows when to stop; its label events, a Staging
 * trial's result among them; the issues cross-referenced to it, with their
 * bodies; the body and state of each issue it closes; and the branch it
 * merged into, by which a Plain one is told to be the default branch's
 * (#857). Made in place of MERGED_PULL_REQUESTS_QUERY, and only in such a
 * repo.
 */
export const UNPROMOTED_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes {
          number title body mergedAt updatedAt headRefName baseRefName
          author ${ACTOR}
          mergeCommit { oid }
          closingIssuesReferences(first: 10) { nodes { ${TRIAL_ISSUE} } }
          ${LABEL_EVENTS}
          ${CROSS_REFERENCES_WITH_BODIES}
        }
      }
    }
  }
`;

/** An issue as TRIAL_ISSUE reads it; a cross-reference's source of another kind has only its kind. */
export interface RawTrialIssue {
  __typename?: string;
  number?: number;
  title?: string;
  state?: "OPEN" | "CLOSED";
  stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  body?: string;
  repository?: { nameWithOwner: string };
}

/** A merged pull request as UNPROMOTED_PULL_REQUESTS_QUERY reads it. */
export interface RawUnpromotedPullRequest extends Omit<RawMergedPullRequest, "closingIssuesReferences"> {
  updatedAt: string;
  /** The branch it merged into. */
  baseRefName: string;
  closingIssuesReferences: { nodes: RawTrialIssue[] };
  timelineItems: { nodes: RawLabelEvent[] };
  crossReferences: { nodes: { __typename: string; source?: RawTrialIssue | null }[] };
}

/**
 * The merged pull requests of a repo that declares `staging`, newest-updated
 * first, a hundred at a time, with only what says whether one merged since
 * the promote list's start (#857): when it merged and was last updated, the
 * branch it merged into, its merge commit, and whose it is. Made only where
 * the pages of UNPROMOTED_PULL_REQUESTS_QUERY stopped at the 100 they keep,
 * short of the start, to count the merges left out.
 */
export const MERGED_SINCE_COUNT_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes {
          mergedAt updatedAt headRefName baseRefName
          author ${ACTOR}
          mergeCommit { oid }
        }
      }
    }
  }
`;

/** A merged pull request as MERGED_SINCE_COUNT_QUERY reads it. */
export type RawCountedPullRequest = Pick<RawUnpromotedPullRequest, "mergedAt" | "updatedAt" | "headRefName" | "baseRefName" | "author" | "mergeCommit">;

/**
 * An environment's Deployments by creation, a page at a time, newest first
 * (`DESC`) or oldest first (`ASC`), each with the commit it deployed, when
 * that commit was committed, and its latest statuses: how a repo that
 * declares `staging` finds where its reach past the last day starts (#856).
 * GraphQL, since the gather reads no REST. GitHub keeps a Deployment's
 * current status whatever its age, and deletes its earlier ones after 90
 * days.
 */
export function deploymentsQuery(direction: "ASC" | "DESC"): string {
  return `
  query ($owner: String!, $name: String!, $environment: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      deployments(environments: [$environment], first: 20, after: $after, orderBy: { field: CREATED_AT, direction: ${direction} }) {
        ${PAGE_INFO}
        nodes { databaseId createdAt commitOid commit { committedDate } statuses(first: 20) { nodes { state createdAt } } }
      }
    }
  }
`;
}

/** A Deployment as deploymentsQuery reads it. */
export interface RawGatheredDeployment {
  databaseId: number | null;
  createdAt: string;
  commitOid: string;
  /** Null when GitHub no longer has the commit. */
  commit: { committedDate: string } | null;
  statuses: { nodes: { state: string; createdAt: string }[] } | null;
}
