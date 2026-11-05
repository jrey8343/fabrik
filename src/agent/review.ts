// The Review agent job's own context around the Reviewer: the PR it judges,
// checked out at the head its required checks passed on, and the Operator's
// comments on it (never earlier Verdicts or fix comments), with the Ticket's
// Spec, the repo's glossary and ADRs, and its Coding standards. The Reviewer
// holds no GitHub credential and runs none of the PR's code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CODING_STANDARDS_FILE } from "../guard/trust-root.ts";
import { readIfPresent } from "../kit/checkout.ts";
import { ticketContext, type PullRequestRunContext } from "./implement.ts";
import { givenOperatorComments, operatorCommentsSection } from "./operatorComments.ts";

/**
 * What the Reviewer's prompt carries beyond the Ticket, the PR its result is
 * for, and the Operator comments it was given, which its result passes out.
 */
export async function reviewContext(
  productDir: string,
  pullRequestFile: string,
  specFile: string,
): Promise<PullRequestRunContext> {
  const { operatorComments, ...pullRequest } = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    operatorComments?: unknown;
  };
  const number = pullRequest.number;
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  const standards = await readIfPresent(join(productDir, CODING_STANDARDS_FILE));
  return {
    pullRequest: number,
    parts: [
      "## The pull request",
      "```json",
      JSON.stringify(pullRequest, null, 2),
      "```",
      ...operatorCommentsSection(operatorComments),
      ...(await ticketContext(productDir, specFile)),
      ...(standards === null ? [] : [`## ${CODING_STANDARDS_FILE}`, standards.trimEnd()]),
    ],
    operatorComments: givenOperatorComments(operatorComments),
  };
}
