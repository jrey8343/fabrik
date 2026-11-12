// The queries of the gather shaped for Home (./gather.ts): what it asks GitHub
// beyond the reads it shares with the Loop. They are built from the Weekly
// summary's own parts (src/github/facts.ts), less what no Standing reads, so
// an answer maps into the same facts. None asks for a connection inside a
// connection inside a connection, the shape GitHub charges for
// (./queryShape.ts): the Weekly summary's open pull requests ask for review
// line comments, and its open issues for blockers' labels; these ask for
// neither. Beyond the Weekly summary's, they ask for each comment's id and the
// body of each pull request, open or merged, for its evidence marker (#639),
// and for GitHub's record of an edit to each of a pull request's comments (#655).
import { ACTOR, COMMIT, DRAFT_EVENTS, LABEL_EVENTS, PAGE_INFO, type RawIssue, type RawOpenPullRequest, type RawReview } from "../github/facts.ts";

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

/** Every open issue, as the Weekly summary reads them, but for its blockers, with its body and when that was last edited. */
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
          subIssues(first: 100) { nodes { number } }
        }
      }
    }
  }
`;

/** An open issue as OPEN_ISSUES_QUERY reads it. */
export type RawHomeIssue = Omit<RawIssue, "blockedBy" | "comments"> & { body: string; lastEditedAt: string | null; comments: { nodes: RawHomeComment[] } };

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
