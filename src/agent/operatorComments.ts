// The Operator's comments on an agent PR (GLOSSARY.md, ADR-0007), as
// src/agent/inputs.ts reads them into a run's input files: under the PR's
// `operatorComments` for a Review, a retry or a Request-changes run, and under
// the issue's `sentBack.operatorComments` for the Design session that follows a
// return. Each is context for the run, never a request for work.
import type { GivenOperatorComment } from "../loop/types.ts";

/** Where on the PR the Operator wrote the comment. */
export type OperatorCommentPlace =
  | { readonly kind: "conversation" }
  | { readonly kind: "review"; readonly state: string }
  | { readonly kind: "inline"; readonly path: string; readonly line: number | null };

/** One Operator comment, as fed to a run. Its `id` is what a run names when it reports weighing it. */
export interface OperatorComment {
  /** `conversation-<id>`, `review-<id>` or `inline-<id>`, from GitHub's own id for it. */
  readonly id: string;
  readonly url: string;
  readonly where: OperatorCommentPlace;
  readonly createdAt: string;
  /** The body as it stood when the run read its inputs. */
  readonly body: string;
}

/**
 * The id and link of each Operator comment in a run's input file: what the
 * agent job passes out beside the run's output, so its Verdict or fix comment
 * links only comments the run was given (src/loop/considered.ts).
 */
export function givenOperatorComments(comments: unknown): GivenOperatorComment[] {
  if (!Array.isArray(comments)) return [];
  return (comments as { id?: unknown; url?: unknown }[]).flatMap(({ id, url }) =>
    typeof id === "string" && typeof url === "string" ? [{ id, url }] : [],
  );
}

/** The heading every run's prompt sets the Operator's comments out under. */
export const OPERATOR_COMMENTS_HEADING = "The Operator's comments on the pull request";

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

function placeOf(where: unknown): string {
  const place = (where ?? {}) as { kind?: unknown; state?: unknown; path?: unknown; line?: unknown };
  switch (place.kind) {
    case "conversation":
      return "in the conversation";
    case "review":
      return `in a review (${text(place.state)})`;
    case "inline":
      return `inline on \`${text(place.path)}\`${typeof place.line === "number" ? ` line ${place.line}` : ""}`;
    default:
      return "on the pull request";
  }
}

/**
 * The Operator's comments from a run's input file, set out for its prompt
 * under OPERATOR_COMMENTS_HEADING at heading `level`, oldest first, each
 * headed by its id, so the run can name the ones it weighed.
 */
export function operatorCommentsSection(comments: unknown, level: 2 | 3 = 2): string[] {
  const list = Array.isArray(comments) ? (comments as { id?: unknown; where?: unknown; createdAt?: unknown; body?: unknown }[]) : [];
  const hashes = "#".repeat(level);
  const parts = [`${hashes} ${OPERATOR_COMMENTS_HEADING}`];
  if (list.length === 0) return [...parts, "(The Operator hasn't commented on it.)"];
  parts.push(
    "The Operator's own words on this pull request, oldest first, as they stood when this run started. Weigh them as this prompt says. Each is headed by its id.",
  );
  for (const comment of list) {
    parts.push(`${hashes}# \`${text(comment.id)}\`: ${placeOf(comment.where)}, ${text(comment.createdAt)}`, text(comment.body).trimEnd());
  }
  return parts;
}
