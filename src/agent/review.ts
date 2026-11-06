// The Review agent job's own context around the Reviewer: the PR it judges,
// checked out at the head its required checks passed on, and the Operator's
// comments on it (never earlier Verdicts or fix comments), with the Ticket's
// Spec, the repo's glossary and ADRs, its Coding standards, and on a UI PR its
// UI evidence. The Reviewer holds no GitHub credential and runs none of the
// PR's code.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_RESULT_FILE } from "../evidence/capture.ts";
import {
  type Capture,
  type CaptureFailure,
  type CaptureResult,
  parseCaptureResult,
  REVIEWER_IMAGES_DIR,
  type ReviewerEvidence,
  reviewerEvidenceBlock,
  reviewerImages,
} from "../evidence/uiEvidence.ts";
import { CODING_STANDARDS_FILE } from "../guard/trust-root.ts";
import { readIfPresent } from "../kit/checkout.ts";
import { ticketContext, type PullRequestRunContext } from "./implement.ts";
import { givenOperatorComments, operatorCommentsSection } from "./operatorComments.ts";

/**
 * What the Reviewer's prompt carries beyond the Ticket, the PR its result is
 * for, and the Operator comments it was given, which its result passes out.
 * A UI PR's Review is given the folder its Review job downloaded the UI
 * evidence into (src/agent/run.ts), and why its capture failed when its
 * marker records that; any other PR's is given none, and its prompt says
 * nothing of UI evidence.
 */
export async function reviewContext(
  productDir: string,
  pullRequestFile: string,
  specFile: string,
  evidenceDir: string | null = null,
  recordedFailure: CaptureFailure | null = null,
): Promise<PullRequestRunContext> {
  const { operatorComments, ...pullRequest } = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    headRefOid?: unknown;
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
      ...(evidenceDir === null
        ? []
        : await uiEvidenceContext(productDir, evidenceDir, { head: headOf(pullRequest.headRefOid), recorded: recordedFailure })),
    ],
    operatorComments: givenOperatorComments(operatorComments),
  };
}

/**
 * A UI PR's evidence for its Reviewer, from the folder its Review job
 * downloaded the evidence artifact into, which holds the capture result
 * beside the screenshots as the capture step wrote them
 * (src/evidence/capture.ts): the screenshots reviewerImages picks, copied
 * into REVIEWER_IMAGES_DIR, and the prompt's block naming them
 * (reviewerEvidenceBlock), which compares the commit captured with the PR's
 * head. It never fails the Review: a folder that's missing, or holds no
 * capture result that reads, is capture having left no result, for the
 * reason the marker `recorded`, if it recorded one.
 */
async function uiEvidenceContext(
  productDir: string,
  evidenceDir: string,
  pullRequest: Pick<ReviewerEvidence, "head" | "recorded">,
): Promise<string[]> {
  const result = await downloadedResult(evidenceDir);
  if (result === null) return reviewerEvidenceBlock({ result: null, given: [], ...pullRequest });
  const given = await copied(reviewerImages(result.captures), evidenceDir, join(productDir, REVIEWER_IMAGES_DIR));
  return reviewerEvidenceBlock({ result, given, ...pullRequest });
}

/** The PR's head, as the Review job's PR input names it (src/agent/inputs.ts), or null when it names none. */
function headOf(headRefOid: unknown): string | null {
  return typeof headRefOid === "string" && headRefOid !== "" ? headRefOid : null;
}

async function downloadedResult(dir: string): Promise<CaptureResult | null> {
  let text: string;
  try {
    text = await readFile(join(dir, CAPTURE_RESULT_FILE), "utf8");
  } catch {
    return null;
  }
  const read = parseCaptureResult(text);
  return read.ok ? read.result : null;
}

/** The captures whose screenshots are now in the Reviewer's folder, leaving out any the download lacks. */
async function copied(captures: readonly Capture[], from: string, to: string): Promise<Capture[]> {
  const given: Capture[] = [];
  try {
    await mkdir(to, { recursive: true });
    for (const capture of captures) {
      // The capture result's reader allows only plain file names, so none reaches outside either folder.
      await copyFile(join(from, capture.image), join(to, capture.image)).then(
        () => given.push(capture),
        () => undefined,
      );
    }
  } catch {
    // A folder it can't make gives the Reviewer no screenshots, never a failed Review.
  }
  return given;
}
