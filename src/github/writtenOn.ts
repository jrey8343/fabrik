// What was written on a pull request, as GitHub's REST API lists it: its
// conversation, its line comments and its reviews, each list read whole
// (readWrittenOn). Here too is the one rule for which of them are the
// Operator's Request changes, each with its line comments
// (operatorsRequestChangesIn): an agent's input reads them through it
// (src/agent/inputs.ts) and so does the read for a Digest's asks
// (src/github/digestGiven.ts), so the ids the Digest writer answers under are
// the ids its reply is checked against.
import { allPages, type ReadClient, type Repo } from "./client.ts";

/** A user as GitHub's REST API names one. */
export interface RestUser {
  readonly login: string;
  readonly type: string;
}

/** Anything written on a pull request, as GitHub's REST API gives it. */
export interface Written {
  readonly id: number;
  readonly user: RestUser | null;
  readonly body: string | null;
  readonly html_url: string;
}

/** A comment in the pull request's conversation. */
export interface WrittenComment extends Written {
  readonly created_at: string;
}

/** A line comment on the pull request's diff. */
export interface WrittenLineComment extends WrittenComment {
  readonly path: string;
  readonly line: number | null;
  readonly original_line?: number | null;
  readonly pull_request_review_id?: number | null;
}

/** A review of the pull request. */
export interface WrittenReview extends Written {
  readonly state: string;
  readonly submitted_at?: string | null;
}

/** Everything written on a pull request, each list in GitHub's order. */
export interface WrittenOn {
  readonly conversation: readonly WrittenComment[];
  readonly lineComments: readonly WrittenLineComment[];
  readonly reviews: readonly WrittenReview[];
}

/** Everything written on `pullRequest`: every page of its conversation, its line comments and its reviews. */
export async function readWrittenOn(github: Pick<ReadClient, "rest">, repo: Repo, pullRequest: number): Promise<WrittenOn> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const [conversation, lineComments, reviews] = await Promise.all([
    allPages<WrittenComment>(github, `${base}/issues/${pullRequest}/comments`),
    allPages<WrittenLineComment>(github, `${base}/pulls/${pullRequest}/comments`),
    allPages<WrittenReview>(github, `${base}/pulls/${pullRequest}/reviews`),
  ]);
  return { conversation, lineComments, reviews };
}

/** Whether the Operator wrote it: by their login, and never a bot under that name. */
export function writtenBy(operator: string): (written: Pick<Written, "user">) => boolean {
  return ({ user }) => user?.login === operator && user.type !== "Bot";
}

/** Oldest first, by the time `at` reads off each item. */
export function byTime<T>(at: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0);
}

/** The line a line comment is on, or null when GitHub no longer places it on one. */
export function lineOf({ line, original_line }: Pick<WrittenLineComment, "line" | "original_line">): number | null {
  return line ?? original_line ?? null;
}

/** One of the Operator's reviews that requested changes, with the Operator's line comments in it, oldest first. */
export interface OperatorsRequestChanges {
  readonly review: WrittenReview;
  /** Whether it has been dismissed since, which GitHub tells by its state: it no longer says what it asked. */
  readonly dismissed: boolean;
  readonly lineComments: readonly WrittenLineComment[];
}

/**
 * The Operator's reviews that requested changes, oldest first, one dismissed
 * since among them and marked so, each with the Operator's own line comments
 * in it, oldest first. Nobody else's review is one, nor one still pending.
 */
export function operatorsRequestChangesIn({ lineComments, reviews }: Pick<WrittenOn, "lineComments" | "reviews">, operator: string): OperatorsRequestChanges[] {
  const theirs = writtenBy(operator);
  return reviews
    .filter((review) => theirs(review) && (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED"))
    .map((review) => ({
      review,
      dismissed: review.state === "DISMISSED",
      lineComments: lineComments.filter((comment) => theirs(comment) && comment.pull_request_review_id === review.id).sort(byTime((comment) => comment.created_at)),
    }))
    .sort(byTime(({ review }) => review.submitted_at ?? ""));
}
