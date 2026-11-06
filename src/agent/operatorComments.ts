// The Operator's comments on an agent PR (GLOSSARY.md, ADR-0007), as
// src/agent/inputs.ts reads them into a run's input files: under the PR's
// `operatorComments` for a Review, a retry or a Request-changes run, and under
// the issue's `sentBack.operatorComments` for the Design session that follows a
// return. Each is context for the run, never a request for work. Beside them,
// for a Review or a retry, are the Operator's Request changes reviews, under
// the PR's `requestedChanges`: those amend the Ticket (ADR-0010).
import { isGivenOperatorComment } from "../loop/considered.ts";
import type { GivenOperatorComment } from "../loop/types.ts";

/** The three places on a PR an Operator comment can be. */
export type OperatorCommentKind = "conversation" | "review" | "inline";

/**
 * The id a run names an Operator comment by, from where it is and GitHub's own
 * id for it: `conversation-<id>`, `review-<id>` or `inline-<id>`. Every such id
 * is made here.
 */
export function operatorCommentId(kind: OperatorCommentKind, githubId: number): string {
  return `${kind}-${githubId}`;
}

/** Where on the PR the Operator wrote the comment. */
export type OperatorCommentPlace =
  | { readonly kind: "conversation" }
  | { readonly kind: "review"; readonly state: string }
  | { readonly kind: "inline"; readonly path: string; readonly line: number | null };

/** One Operator comment, as fed to a run. Its `id` is what a run names when it reports weighing it. */
export interface OperatorComment {
  /** From operatorCommentId. */
  readonly id: string;
  readonly url: string;
  readonly where: OperatorCommentPlace;
  readonly createdAt: string;
  /** The body as it stood when the run read its inputs. */
  readonly body: string;
}

/** One inline comment of a Request changes review, as fed to a run. */
export interface RequestedChangeComment {
  /** From operatorCommentId, as `inline-<id>`: the same id the comment has among the Operator's comments. */
  readonly id: string;
  readonly url: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
}

/**
 * One of the Operator's Request changes reviews on a PR, with its inline
 * comments, as fed to a Review or a retry: an amendment to the Ticket for
 * that PR (ADR-0010), never a plain comment.
 */
export interface RequestedChange {
  /** From operatorCommentId, as `review-<id>`, so a run can name it as weighed. */
  readonly id: string;
  readonly url: string;
  readonly submittedAt: string;
  readonly body: string;
  readonly comments: readonly RequestedChangeComment[];
}

/**
 * The id and link of each Operator comment in a run's input file: what the
 * agent job passes out beside the run's output, so its Verdict or fix comment
 * links only comments the run was given (src/loop/considered.ts).
 */
export function givenOperatorComments(comments: unknown): GivenOperatorComment[] {
  if (!Array.isArray(comments)) return [];
  return comments.filter(isGivenOperatorComment).map(({ id, url }) => ({ id, url }));
}

/** The heading every run's prompt sets the Operator's comments out under. */
export const OPERATOR_COMMENTS_HEADING = "The Operator's comments on the pull request";

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

/** An inline comment's place: its file, and its line when it has one. */
function inlinePlace(path: unknown, line: unknown): string {
  return `\`${text(path)}\`${typeof line === "number" ? ` line ${line}` : ""}`;
}

function placeOf(where: unknown): string {
  const place = (where ?? {}) as { kind?: unknown; state?: unknown; path?: unknown; line?: unknown };
  switch (place.kind) {
    case "conversation":
      return "in the conversation";
    case "review":
      return `in a review (${text(place.state)})`;
    case "inline":
      return `inline on ${inlinePlace(place.path, place.line)}`;
    default:
      return "on the pull request";
  }
}

/**
 * The Operator's comments from a run's input file, set out for its prompt
 * under OPERATOR_COMMENTS_HEADING at heading `level`, oldest first, each
 * headed by its id, so the run can name the ones it weighed.
 */
export function operatorCommentsSection(comments: unknown, level: 2 | 3 = 2, none = "(The Operator hasn't commented on it.)"): string[] {
  const list = Array.isArray(comments) ? (comments as { id?: unknown; where?: unknown; createdAt?: unknown; body?: unknown }[]) : [];
  const hashes = "#".repeat(level);
  const parts = [`${hashes} ${OPERATOR_COMMENTS_HEADING}`];
  if (list.length === 0) return [...parts, none];
  parts.push(
    "The Operator's own words on this pull request, oldest first, as they stood when this run started. Weigh them as this prompt says. Each is headed by its id.",
  );
  for (const comment of list) {
    parts.push(`${hashes}# \`${text(comment.id)}\`: ${placeOf(comment.where)}, ${text(comment.createdAt)}`, text(comment.body).trimEnd());
  }
  return parts;
}

/** The heading a Review's and a retry's prompt sets the Operator's Request changes reviews out under (ADR-0010). */
export const REQUESTED_CHANGES_HEADING = "The Operator's Request changes, which amend the Ticket";

interface RequestedChangesInput {
  readonly operatorComments: unknown;
  readonly requestedChanges: unknown;
}

/** A PR input's Request changes reviews, or none when it carries none. */
function requestedChangesOf(requestedChanges: unknown): { id?: unknown; submittedAt?: unknown; body?: unknown; comments?: unknown }[] {
  return Array.isArray(requestedChanges) ? requestedChanges : [];
}

/**
 * The Operator's Request changes reviews from a Review's or a retry's PR
 * input, set out for its prompt under REQUESTED_CHANGES_HEADING at heading
 * level 2, oldest first, each headed by its id with its inline comments under
 * it, as amendments to the Ticket. Nothing when there are none, so the prompt
 * of a PR the Operator never requested changes on is as it always was.
 */
export function requestedChangesSection(requestedChanges: unknown): string[] {
  const list = requestedChangesOf(requestedChanges);
  if (list.length === 0) return [];
  const parts = [
    `## ${REQUESTED_CHANGES_HEADING}`,
    "The Operator's Request changes reviews on this pull request, oldest first, each headed by its id. Each amends the Ticket for this pull request: a later one wins over an earlier one, and either wins over the Ticket. Weigh them as this prompt says.",
  ];
  for (const review of list) {
    const body = text(review.body).trim();
    parts.push(
      `### \`${text(review.id)}\`: Request changes, ${text(review.submittedAt)}`,
      body === "" ? "(The review has no summary; see its comments below.)" : body,
    );
    const comments = Array.isArray(review.comments) ? (review.comments as { id?: unknown; path?: unknown; line?: unknown; body?: unknown }[]) : [];
    for (const comment of comments) {
      parts.push(
        `#### \`${text(comment.id)}\`: inline on ${inlinePlace(comment.path, comment.line)}`,
        text(comment.body).trimEnd(),
      );
    }
  }
  return parts;
}

/**
 * A Review's or a retry's Operator input, set out for its prompt: the
 * Request changes reviews as amendments (requestedChangesSection), then the
 * Operator's other comments (operatorCommentsSection), leaving out the
 * inline comments the amendments already show. Its `given` is every comment
 * and review the run may name as weighed: the comments, then the reviews.
 */
export function operatorInputSections({ operatorComments, requestedChanges }: RequestedChangesInput): {
  parts: string[];
  given: GivenOperatorComment[];
} {
  const reviews = requestedChangesOf(requestedChanges);
  const shown = new Set(
    reviews.flatMap((review) => (Array.isArray(review.comments) ? (review.comments as { id?: unknown }[]).map(({ id }) => id) : [])),
  );
  const others = Array.isArray(operatorComments)
    ? (operatorComments as { id?: unknown }[]).filter(({ id }) => !shown.has(id))
    : operatorComments;
  return {
    parts: [
      ...requestedChangesSection(reviews),
      ...(reviews.length === 0
        ? operatorCommentsSection(others)
        : operatorCommentsSection(others, 2, "(The Operator hasn't commented on it beyond the Request changes above.)")),
    ],
    given: [...givenOperatorComments(operatorComments), ...givenOperatorComments(reviews)],
  };
}
