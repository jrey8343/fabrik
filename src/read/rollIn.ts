// The issues that can be rolled in by hand (#666): for one open agent pull
// request, made on demand when a reader asks and never in a gather, the
// repo's open issues it could take in. Read only, with the reader's
// credential.
import { pagesOf, type ReadClient } from "../github/client.ts";
import { ACTOR, isAgent, PAGE_INFO } from "../github/facts.ts";
import { loginOf } from "../github/snapshot.ts";
import { neverRelatedKindOf } from "./related.ts";
import type { Row } from "./rows.ts";

/** One issue that can be rolled in by hand. */
export interface IssueToRollIn {
  readonly issue: number;
  readonly title: string;
  /** Whether it mentions the pull request. */
  readonly mentions: boolean;
}

/** One page of the issues that can be rolled in to a pull request. */
export interface IssuesToRollIn {
  /** The open agent pull request they could be rolled in to. */
  readonly pullRequest: number;
  /** Which page this is, from 1. */
  readonly page: number;
  readonly issues: readonly IssueToRollIn[];
  /** Whether a later page holds more. */
  readonly more: boolean;
}

/** The open issues, newest first, with what tells a kind never related to a pull request. */
const OPEN_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        ${PAGE_INFO}
        nodes {
          number title createdAt
          author ${ACTOR}
          labels(first: 50) { nodes { name } }
          subIssues(first: 1) { nodes { number } }
        }
      }
    }
  }
`;

/** An open issue as OPEN_ISSUES_QUERY reads it. */
interface RawIssue {
  number: number;
  title: string;
  createdAt: string;
  author: { login: string; __typename: string } | null;
  labels: { nodes: { name: string }[] };
  subIssues: { nodes: { number: number }[] };
}

/** Every open pull request, with who opened it from which branch and the issues it closes. */
const OPEN_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 100, after: $after) {
        ${PAGE_INFO}
        nodes {
          number headRefName
          author ${ACTOR}
          closingIssuesReferences(first: 10) { nodes { number } }
        }
      }
    }
  }
`;

/** An open pull request as OPEN_PULL_REQUESTS_QUERY reads it. */
interface RawPullRequest {
  number: number;
  headRefName: string;
  author: { login: string; __typename: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
}

/** How many issues a page holds. */
const PAGE_SIZE = 20;

/**
 * Page `page`, from 1, of the open issues in `repo`, `owner/name`, that could
 * be rolled in by hand to the open agent pull request on `row`. Left out are
 * the kinds never related to a pull request, by the rows' own code: anything
 * the Kit files, the Fabrik App's issues (any bot's when its login `appLogin`
 * is not given), a Map, a Decision and a Spec; and the pull request's own
 * Ticket, an issue with an open pull request of its own, and an issue already
 * under `related` on the row, which has a card of its own. A Ticket still
 * waiting for Dispatch is listed. "unread" when GitHub refuses or fails any
 * query.
 */
export async function readIssuesToRollIn(
  client: Pick<ReadClient, "graphql">,
  repo: string,
  row: Pick<Row, "standing" | "related" | "mentions">,
  page = 1,
  appLogin: string | null = null,
): Promise<IssuesToRollIn | "unread"> {
  const pullRequest = row.standing.pullRequest ?? 0;
  const [owner = "", name = ""] = repo.split("/");
  const [issues, pullRequests] = await Promise.all([
    pagesOf<RawIssue>(client, OPEN_ISSUES_QUERY, { owner, name }, {}, (data) => data.repository.issues),
    pagesOf<RawPullRequest>(client, OPEN_PULL_REQUESTS_QUERY, { owner, name }, {}, (data) => data.repository.pullRequests),
  ]);
  const leftOut = new Set([...row.related.map(({ issue }) => issue), ...withPullRequestsOf(pullRequests)]);
  const listed = issues
    .filter((issue) => !leftOut.has(issue.number) && neverRelatedKindOf(issueFactsOf(issue), appLogin) === null)
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number)
    .map(({ number, title }) => ({ issue: number, title, mentions: false }));
  const start = (page - 1) * PAGE_SIZE;
  return { pullRequest, page, issues: listed.slice(start, start + PAGE_SIZE), more: listed.length > start + PAGE_SIZE };
}

/**
 * The issues with an open pull request of their own, as the rows tell them:
 * an open agent pull request's Ticket, the first issue it closes (this pull
 * request's own Ticket among them), and every issue an open Plain pull
 * request closes.
 */
function withPullRequestsOf(pullRequests: readonly RawPullRequest[]): number[] {
  return pullRequests.flatMap((pullRequest) => {
    const closes = pullRequest.closingIssuesReferences.nodes.map(({ number }) => number);
    return isAgent(pullRequest) ? closes.slice(0, 1) : closes;
  });
}

/** What the rows' test of a kind never related reads of an issue. */
function issueFactsOf({ author, labels, subIssues }: RawIssue): Parameters<typeof neverRelatedKindOf>[0] {
  return { author: loginOf(author), labels: labels.nodes.map(({ name }) => name), subIssues: subIssues.nodes.map(({ number }) => number) };
}
