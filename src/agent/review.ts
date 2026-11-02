// The Review agent job's own context around the Reviewer: the PR it judges,
// checked out at the head its required checks passed on, with the Ticket's
// Spec and the repo's glossary and ADRs. The Reviewer holds no GitHub
// credential and runs none of the PR's code.
import { readFile } from "node:fs/promises";
import { ticketContext } from "./implement.ts";

/** What the Reviewer's prompt carries beyond the Ticket, and the PR its result is for. */
export async function reviewContext(
  productDir: string,
  pullRequestFile: string,
  specFile: string,
): Promise<{ pullRequest: number; parts: string[] }> {
  const pullRequest: unknown = JSON.parse(await readFile(pullRequestFile, "utf8"));
  const number = (pullRequest as { number?: unknown } | null)?.number;
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  return {
    pullRequest: number,
    parts: [
      "## The pull request",
      "```json",
      JSON.stringify(pullRequest, null, 2),
      "```",
      ...(await ticketContext(productDir, specFile)),
    ],
  };
}
