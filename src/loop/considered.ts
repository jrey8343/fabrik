// The Operator comments a run weighed (ADR-0007): the Reviewer, the
// Implementer and a Design session on a Ticket sent back from a PR name them
// by id, and the Kit links only those it gave the run, so an agent can't claim
// a comment it never read. Pure.
import type { GivenOperatorComment } from "./types.ts";

/** Whether a value is an Operator comment's id and link, the shape a run is given them in. */
export function isGivenOperatorComment(value: unknown): value is GivenOperatorComment {
  if (typeof value !== "object" || value === null) return false;
  const { id, url } = value as Record<string, unknown>;
  return typeof id === "string" && typeof url === "string";
}

/** Whether a run's list of weighed comments is a list of ids; anything else reads as none weighed. */
export function isCommentIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

export const CONSIDERED_HEADING = "Operator comments considered";

/**
 * The section a Verdict, fix comment or sent-back Design session's comment ends with: one link per comment the run
 * named that it was given, in the order it was given them. Ids it wasn't given
 * are dropped, never linked. Nothing when none is left.
 */
export function consideredSection(named: readonly string[], given: readonly GivenOperatorComment[] = []): string[] {
  const weighed = given.filter((comment) => named.includes(comment.id));
  if (weighed.length === 0) return [];
  return ["", `### ${CONSIDERED_HEADING}`, "", ...weighed.map((comment) => `- [\`${comment.id}\`](${comment.url})`)];
}
