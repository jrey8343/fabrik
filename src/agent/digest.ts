// The Digest writer's own context (ADR-0022): what the agent-inputs step
// gathered of the pull request it writes the Digest of (readDigestPullRequest,
// src/agent/inputs.ts), set out in the sections prompts/digest.md names, with
// the Ticket's Spec and the repo's glossary and ADRs. The writer works in a
// read-only checkout of the head its pass was given on, holds no GitHub
// credential and runs none of the code. It is given no transcript and no Run
// record.
import { readFile } from "node:fs/promises";
import { ticketContext } from "./implement.ts";
import type { DigestPullRequest } from "./inputs.ts";
import { operatorInputSections } from "./operatorComments.ts";
import { jsonBlock } from "./prompt.ts";

/** The heading each of the Digest writer's own inputs is set out under, in the order the prompt reads them. */
export const DIGEST_SECTIONS = {
  pullRequest: "The pull request",
  verdicts: "Every Verdict on the pull request",
  kitNotes: "The Kit's notes on the pull request",
  uiEvidence: "UI evidence",
} as const;

/** What a section holds when the pull request has none of it. */
const NONE = "(None.)";

/**
 * What the Digest writer's prompt carries beyond the Ticket, and the pull
 * request its result is for. `headSha` is the head the Kit job's plan started
 * the run at, which the job checked out, never the pull request's head as
 * GitHub has it now: the Digest is written as of that one.
 */
export async function digestContext(
  productDir: string,
  pullRequestFile: string,
  specFile: string,
  headSha: string,
): Promise<{ pullRequest: number; parts: string[] }> {
  const given = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as Partial<DigestPullRequest>;
  const { number, title, body, baseRefName, operatorComments, requestedChanges } = given;
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  const verdicts = Array.isArray(given.verdicts) ? given.verdicts : [];
  const kitNotes = Array.isArray(given.kitNotes) ? given.kitNotes : [];
  const base = typeof baseRefName === "string" && baseRefName !== "" ? ` Its base branch is \`${baseRefName}\`.` : "";
  return {
    pullRequest: number,
    parts: [
      `## ${DIGEST_SECTIONS.pullRequest}`,
      `This is #${number}. You're checked out at \`${headSha}\`, the head its pass was given on, which your Digest is written as of.${base}`,
      ...jsonBlock({ number, title, body }),
      // The Operator's Request changes, which amend the Ticket, then the Operator's comments, as the Reviewer is given them.
      ...operatorInputSections({ operatorComments, requestedChanges }).parts,
      ...(await ticketContext(productDir, specFile)),
      `## ${DIGEST_SECTIONS.verdicts}`,
      ...(verdicts.length === 0 ? [NONE] : jsonBlock(verdicts)),
      `## ${DIGEST_SECTIONS.kitNotes}`,
      ...(kitNotes.length === 0 ? [NONE] : jsonBlock(kitNotes)),
      `## ${DIGEST_SECTIONS.uiEvidence}`,
      given.uiEvidence === true
        ? "This pull request has UI evidence: screenshots of its pages, which its body links."
        : "This pull request has no UI evidence.",
    ],
  };
}
