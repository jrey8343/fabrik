// Leaves the Digest out of what an agent is given (ADR-0022). A Digest is
// words for the Operator only: no agent run is ever given one to read, the
// Digest writer's own included, so an account written for the Operator
// steers no run. A Digest comment and a no-Digest line are told by their
// hidden first line (src/loop/digestContract.ts) on a comment of the Fabrik
// App's. The agents' inputs read a pull request's comments through GraphQL,
// so every such comment node is dropped from what a query returns, as a held
// line is (src/github/heldLines.ts). Their REST reads of comments keep only
// Verdicts and the Operator's words, so neither reaches them that way.
//
// Only the agents' inputs read through this. The Loop's snapshot and the read
// library read the Digest itself, so their clients are never wrapped in it.
import { isDigestComment } from "../loop/digestContract.ts";
import type { ReadClient } from "./client.ts";
import { answeringThrough, withoutNodes } from "./heldLines.ts";

/** `github`, whose GraphQL answers carry no Digest and no no-Digest line. Every other call is its own. */
export function leavingOutDigests<Reader extends Pick<ReadClient, "graphql">>(github: Reader): Reader {
  return answeringThrough(github, withoutDigests);
}

/** The value with every array element that is a Digest comment or a no-Digest line dropped, at any depth. */
export function withoutDigests<T>(value: T): T {
  return withoutNodes(value, isDigestNode);
}

/**
 * Whether a node is a comment that is a Digest or a no-Digest line. The
 * Fabrik App's comment is told as the snapshot tells it, by a bot's
 * authorship. Only a comment whose author is named as someone other than a
 * bot is kept: that is a person's own words, quoting one. A node read
 * without its author's kind is dropped, since a Digest must never be in
 * what is handed over.
 */
function isDigestNode(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const { body, author } = item as { body?: unknown; author?: unknown };
  if (typeof body !== "string" || !isDigestComment(body)) return false;
  const kind = typeof author === "object" && author !== null ? (author as { __typename?: unknown }).__typename : undefined;
  return typeof kind !== "string" || kind === "Bot";
}
