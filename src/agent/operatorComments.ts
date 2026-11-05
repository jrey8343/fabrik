// The Operator's comments on an agent PR (GLOSSARY.md, ADR-0007), as
// src/agent/inputs.ts reads them into a run's input files: under the PR's
// `operatorComments` for a Review, a retry or a Request-changes run, and under
// the issue's `sentBack.operatorComments` for the Design session that follows a
// return. Each is context for the run, never a request for work.

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
