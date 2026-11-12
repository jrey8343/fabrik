// The push job's read of what Kit code hands the Digest's contract beside the
// Digest writer's reply (DigestGiven, src/loop/digestContract.ts): what no
// agent wrote. src/main.ts reads it once the Digest job has succeeded, and
// the event that lands the Digest carries it, so the rules core renders the
// comment with no I/O of its own. The read of the pull request's thread is
// here too (readDigestThread): the agent job's inputs step calls it for the
// facts it hands the writer (src/agent/inputs.ts), and the Digest's rounds
// table is rendered from the push job's own call, never from what the agent
// job passed out.
import { capturedRoutesOf } from "../evidence/uiEvidence.ts";
import { ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { type DigestGiven, parseDigestReply } from "../loop/digestContract.ts";
import { type DigestThread, digestFactsOf } from "../loop/digestFacts.ts";
import type { ReadClient, Repo } from "./client.ts";
import { readDigestHead } from "./digestHead.ts";
import { digestSnapshotOn } from "./snapshot.ts";
import { countLandedNothing } from "./threads.ts";
import { lineOf, operatorsRequestChangesIn, readWrittenOn, type WrittenOn } from "./writtenOn.ts";

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
  /** The Digest writer's reply, as its run gave it, unchecked. It is read here only for the files its places name. */
  readonly output: string;
}

/**
 * What Kit code hands the contract for the Digest of `written.pullRequest`
 * at `written.headSha`: what the push job knows already, Kit code's facts,
 * worked out from the pull request's thread as `github` reads it now, what
 * that head holds of the files the reply's places name (readDigestHead),
 * and the routes its UI evidence captured (capturedRoutesOf). Among the
 * facts are the asks the writer's reply is checked against, so the
 * Operator's Request changes deferred during a Retry are read here as the
 * agent job's inputs step read them, from the Loop's snapshot of the pull
 * request. The captured routes come from that same read of it: its evidence
 * marker, as the snapshot reads it, only from a body a bot wrote. Each
 * item's picture is checked against them, never against the reply.
 *
 * The reply says only which files to read: each place is checked against
 * what the read found, never against the reply. One that breaks its shape
 * is refused whatever the head holds, so nothing of the head is read for it.
 */
export async function readDigestGiven(github: ReadClient, repo: Repo, written: DigestWritten): Promise<DigestGiven> {
  const { repoUrl, pullRequest, headSha, runUrl } = written;
  const operator = written.operator ?? repo.owner;
  const reply = parseDigestReply(written.output);
  const named = reply.ok ? reply.output.items.flatMap(({ places }) => places.map(({ path }) => path)) : [];
  const [{ facts, capturedRoutes }, head] = await Promise.all([
    digestSnapshotOn(github, repo, pullRequest, operator).then(async ({ deferredChangesRequests, uiEvidenceMarker }) => ({
      facts: digestFactsOf(await readDigestThread(github, repo, pullRequest, operator, deferredChangesRequests)),
      capturedRoutes: capturedRoutesOf(uiEvidenceMarker),
    })),
    readDigestHead(github, repo, pullRequest, headSha, named),
  ]);
  return { repoUrl, pullRequest, headSha, runUrl, facts, head, capturedRoutes };
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

/**
 * A pull request's thread, as much of it as Kit code's facts are worked out
 * from (digestFactsOf): when it opened; every comment a bot wrote on it,
 * oldest first, since only a bot's markers count, as in the Loop's snapshot;
 * the Operator's reviews that requested changes, each with its own text, its
 * place and the Operator's line comments in it, oldest first, by the rule a
 * Review's input reads them by (operatorsRequestChangesIn,
 * src/github/writtenOn.ts), one since
 * dismissed marked so, since GitHub no longer says what a dismissed review
 * asked, and one among `deferred` marked so; and how many runs the Ticket
 * its branch names landed nothing on before it opened, counted from the
 * Ticket's comments as the snapshot counts them, only while the pull request
 * links that Ticket.
 *
 * `deferred` is the Operator's Request changes deferred while a Retry was in
 * flight (#427), as the Loop's snapshot reads them
 * (deferredChangesRequestsOn): no Review was given one, so it is no ask.
 *
 * `written` is everything written on the pull request, when the caller has
 * read it already, as the agent job's inputs step has: what it hands the
 * writer and these facts are then of one read.
 */
export async function readDigestThread(
  github: Pick<ReadClient, "rest" | "graphql">,
  repo: Repo,
  pullRequest: number,
  operator: string,
  deferred: readonly number[],
  written?: WrittenOn,
): Promise<DigestThread> {
  const [opening, all] = await Promise.all([
    github.graphql<OpeningQueryResult>(OPENING_QUERY, { owner: repo.owner, name: repo.name, number: pullRequest }),
    written ?? readWrittenOn(github, repo, pullRequest),
  ]);
  const opened = opening.repository.pullRequest;
  if (opened === null) throw new Error(`Pull request #${pullRequest} not found in ${repo.owner}/${repo.name}`);
  const ticket = ticketOfAgentBranch(opened.headRefName);
  const onTicket = opened.closingIssuesReferences.nodes.find((issue) => issue.number === ticket)?.comments.nodes ?? [];
  return {
    openedAt: opened.createdAt,
    kitComments: all.conversation.filter(({ user }) => user?.type === "Bot").map(({ body, created_at }) => ({ at: created_at, body: body ?? "" })),
    requestChanges: operatorsRequestChangesIn(all, operator).flatMap(({ review, dismissed, lineComments }) =>
      typeof review.submitted_at === "string"
        ? [
            {
              review: review.id,
              at: review.submitted_at,
              dismissed,
              deferred: deferred.includes(review.id),
              body: review.body ?? "",
              url: review.html_url,
              lineComments: lineComments.map((comment) => ({ comment: comment.id, url: comment.html_url, path: comment.path, line: lineOf(comment) })),
            },
          ]
        : [],
    ),
    landedNothing: countLandedNothing(onTicket.map(({ body, author }) => ({ body, byApp: author?.__typename === "Bot" }))),
  };
}
