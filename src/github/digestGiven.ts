// The push job's read of what Kit code hands the Digest's contract beside the
// Digest writer's reply (DigestGiven, src/loop/digestContract.ts): what no
// agent wrote. src/main.ts reads it once the Digest job has succeeded, and
// the event that lands the Digest carries it, so the rules core renders the
// comment with no I/O of its own. The read of the pull request's thread is
// here too (readDigestThread): the agent job's inputs step makes the same
// read for the facts it hands the writer (src/agent/inputs.ts), and the
// Digest's rounds table is rendered from the push job's own, never from what
// the agent job passed out.
import { ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import type { DigestGiven } from "../loop/digestContract.ts";
import { type DigestThread, digestFactsOf } from "../loop/digestFacts.ts";
import { allPages, type ReadClient, type Repo } from "./client.ts";
import { deferredChangesRequestsOn } from "./snapshot.ts";
import { countLandedNothing } from "./threads.ts";

/** What the push job already knows of a Digest when its run ends: where it goes, the head it is written as of, its run, and who the Operator is. */
export interface DigestWritten {
  /** The Product repo's web address. */
  readonly repoUrl: string;
  readonly pullRequest: number;
  /** The head the Kit job's plan started the run at. */
  readonly headSha: string;
  /** The push job's own Actions run attempt. */
  readonly runUrl: string;
  /** The Kit config's `operator`, or null when it names none: the repo's owner then, as the Loop's snapshot has it. */
  readonly operator: string | null;
}

/**
 * What Kit code hands the contract for the Digest of `written.pullRequest`
 * at `written.headSha`: what the push job knows already, and Kit code's
 * facts, worked out from the pull request's thread as `github` reads it now.
 * Among the facts are the asks the writer's reply is checked against, so
 * the Operator's Request changes deferred during a Retry are read here as
 * the agent job's inputs step read them, from the Loop's snapshot of the
 * pull request.
 */
export async function readDigestGiven(github: ReadClient, repo: Repo, written: DigestWritten): Promise<DigestGiven> {
  const { repoUrl, pullRequest, headSha, runUrl } = written;
  const operator = written.operator ?? repo.owner;
  const deferred = await deferredChangesRequestsOn(github, repo, pullRequest, operator);
  const thread = await readDigestThread(github, repo, pullRequest, operator, deferred);
  return { repoUrl, pullRequest, headSha, runUrl, facts: digestFactsOf(thread) };
}

/** When the pull request opened, its branch, and the comments on each issue it closes, as the Loop's snapshot reads a Ticket's (src/github/snapshot.ts). */
const OPENING_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        createdAt
        headRefName
        closingIssuesReferences(first: 10) { nodes { number comments(last: 100) { nodes { body author { login __typename } } } } }
      }
    }
  }
`;

interface OpeningQueryResult {
  repository: {
    pullRequest: {
      createdAt: string;
      headRefName: string;
      closingIssuesReferences: { nodes: { number: number; comments: { nodes: { body: string; author: { login: string; __typename: string } | null }[] } }[] };
    } | null;
  };
}

/** A user as GitHub's REST API names one. */
interface RestUser {
  readonly login: string;
  readonly type: string;
}

/** A line comment on the pull request's diff, as GitHub's REST API gives it. */
interface RestLineComment {
  readonly id: number;
  readonly user: RestUser | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly path: string;
  readonly line: number | null;
  readonly original_line?: number | null;
  readonly pull_request_review_id?: number | null;
}

/** A review of the pull request, as GitHub's REST API gives it. */
interface RestReview {
  readonly id: number;
  readonly user: RestUser | null;
  readonly state: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly submitted_at?: string | null;
}

/**
 * A pull request's thread, as much of it as Kit code's facts are worked out
 * from (digestFactsOf): when it opened; every comment a bot wrote on it,
 * oldest first, since only a bot's markers count, as in the Loop's snapshot;
 * the Operator's reviews that requested changes, each with its own text, its
 * place and the Operator's line comments in it, oldest first, as a Review's
 * input reads them (readOperatorFeedback, src/agent/inputs.ts), one since
 * dismissed marked so, since GitHub no longer says what a dismissed review
 * asked, and one among `deferred` marked so; and how many runs the Ticket
 * its branch names landed nothing on before it opened, counted from the
 * Ticket's comments as the snapshot counts them, only while the pull request
 * links that Ticket.
 *
 * `deferred` is the Operator's Request changes deferred while a Retry was in
 * flight (#427), as the Loop's snapshot reads them
 * (deferredChangesRequestsOn): no Review was given one, so it is no ask.
 */
export async function readDigestThread(
  github: Pick<ReadClient, "rest" | "graphql">,
  repo: Repo,
  pullRequest: number,
  operator: string,
  deferred: readonly number[],
): Promise<DigestThread> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const [opening, comments, lineComments, reviews] = await Promise.all([
    github.graphql<OpeningQueryResult>(OPENING_QUERY, { owner: repo.owner, name: repo.name, number: pullRequest }),
    allPages<{ body: string | null; created_at: string; user: RestUser | null }>(github, `${base}/issues/${pullRequest}/comments`),
    allPages<RestLineComment>(github, `${base}/pulls/${pullRequest}/comments`),
    allPages<RestReview>(github, `${base}/pulls/${pullRequest}/reviews`),
  ]);
  const opened = opening.repository.pullRequest;
  if (opened === null) throw new Error(`Pull request #${pullRequest} not found in ${repo.owner}/${repo.name}`);
  const ticket = ticketOfAgentBranch(opened.headRefName);
  const onTicket = opened.closingIssuesReferences.nodes.find((issue) => issue.number === ticket)?.comments.nodes ?? [];
  const theirs = (user: RestUser | null): boolean => user?.login === operator && user.type !== "Bot";
  return {
    openedAt: opened.createdAt,
    kitComments: comments.filter(({ user }) => user?.type === "Bot").map(({ body, created_at }) => ({ at: created_at, body: body ?? "" })),
    requestChanges: reviews.flatMap(({ id, state, submitted_at, user, body, html_url }) =>
      theirs(user) && (state === "CHANGES_REQUESTED" || state === "DISMISSED") && typeof submitted_at === "string"
        ? [
            {
              review: id,
              at: submitted_at,
              dismissed: state === "DISMISSED",
              deferred: deferred.includes(id),
              body: body ?? "",
              url: html_url,
              lineComments: lineComments
                .filter((comment) => theirs(comment.user) && comment.pull_request_review_id === id)
                .toSorted((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
                .map((comment) => ({ comment: comment.id, url: comment.html_url, path: comment.path, line: comment.line ?? comment.original_line ?? null })),
            },
          ]
        : [],
    ),
    landedNothing: countLandedNothing(onTicket.map(({ body, author }) => ({ body, byApp: author?.__typename === "Bot" }))),
  };
}
