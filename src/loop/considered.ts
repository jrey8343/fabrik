// The Operator comments a run weighed (ADR-0007): the Reviewer and the
// Implementer name them by id, and the Kit links only those it gave the run,
// so an agent can't claim a comment it never read. Pure.
import type { GivenOperatorComment } from "./types.ts";

/** Whether a value is an Operator comment's id and link, the shape a run is given them in. */
export function isGivenOperatorComment(value: unknown): value is GivenOperatorComment {
  if (typeof value !== "object" || value === null) return false;
  const { id, url } = value as Record<string, unknown>;
  return typeof id === "string" && typeof url === "string";
}

export const CONSIDERED_HEADING = "Operator comments considered";

/**
 * The section a Verdict or fix comment ends with: one link per comment the run
 * named that it was given, in the order it was given them. Ids it wasn't given
 * are dropped, never linked. Nothing when none is left.
 */
export function consideredSection(named: readonly string[], given: readonly GivenOperatorComment[] = []): string[] {
  const weighed = given.filter((comment) => named.includes(comment.id));
  if (weighed.length === 0) return [];
  return ["", `### ${CONSIDERED_HEADING}`, "", ...weighed.map((comment) => `- [\`${comment.id}\`](${comment.url})`)];
}
