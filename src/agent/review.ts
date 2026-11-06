// The Review agent job's own context around the Reviewer: the PR it judges,
// checked out at the head its required checks passed on, and the Operator's
// comments on it (never earlier Verdicts or fix comments), with the Ticket's
// Spec and the repo's glossary and ADRs, and on a UI PR its UI evidence. The
// Reviewer holds no GitHub credential and runs none of the PR's code.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_RESULT_FILE } from "../evidence/capture.ts";
import {
  type Capture,
  type CaptureFailure,
  type CaptureResult,
  code,
  FAILURE_WORDS,
  isServerError,
  parseCaptureResult,
  reviewerImages,
  SIDE_WORDS,
} from "../evidence/uiEvidence.ts";
import { UI_VIEWPORTS } from "../kit/config.ts";
import { ticketContext, type PullRequestRunContext } from "./implement.ts";
import { givenOperatorComments, operatorCommentsSection } from "./operatorComments.ts";

/**
 * What the Reviewer's prompt carries beyond the Ticket, the PR its result is
 * for, and the Operator comments it was given, which its result passes out.
 * A UI PR's Review is given the folder its Review job downloaded the UI
 * evidence into (src/agent/run.ts); any other PR's is given none, and its
 * prompt says nothing of UI evidence.
 */
export async function reviewContext(
  productDir: string,
  pullRequestFile: string,
  specFile: string,
  evidenceDir: string | null = null,
): Promise<PullRequestRunContext> {
  const { operatorComments, ...pullRequest } = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    operatorComments?: unknown;
  };
  const number = pullRequest.number;
  if (typeof number !== "number") throw new Error("FABRIK_PULL_REQUEST_FILE has no PR number");
  return {
    pullRequest: number,
    parts: [
      "## The pull request",
      "```json",
      JSON.stringify(pullRequest, null, 2),
      "```",
      ...operatorCommentsSection(operatorComments),
      ...(await ticketContext(productDir, specFile)),
      ...(evidenceDir === null ? [] : await uiEvidenceContext(productDir, evidenceDir)),
    ],
    operatorComments: givenOperatorComments(operatorComments),
  };
}

/** Where in its working directory a UI PR's Reviewer finds the screenshots it's given. */
export const REVIEWER_IMAGES_DIR = "fabrik-ui-evidence";

/**
 * A UI PR's evidence for its Reviewer, from the folder its Review job
 * downloaded the evidence artifact into, which holds the capture result
 * beside the screenshots as the capture step wrote them
 * (src/evidence/capture.ts): the screenshots reviewerImages picks, copied
 * into REVIEWER_IMAGES_DIR, and the prompt's block naming them. It never
 * fails the Review: a folder that's missing, or holds no capture result
 * that reads, is capture having left no result.
 */
async function uiEvidenceContext(productDir: string, evidenceDir: string): Promise<string[]> {
  const result = await downloadedResult(evidenceDir);
  if (result === null) return uiEvidenceBlock(null, []);
  const given = await copied(reviewerImages(result.captures), evidenceDir, join(productDir, REVIEWER_IMAGES_DIR));
  return uiEvidenceBlock(result, given);
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

const UI_PR = "This pull request changes the Product repo's UI";

/**
 * The UI evidence block of a UI PR's review prompt: the screenshots it was
 * given, each by route, viewport and side, and what to judge in them; or,
 * when capture failed or left no result, why, and to review the code as usual.
 */
function uiEvidenceBlock(result: CaptureResult | null, given: readonly Capture[]): string[] {
  if (result === null || given.length === 0) {
    const failure = result?.outcome === "failed" ? result.reason : "no-result";
    return ["## UI evidence", `${UI_PR}, but ${failureWords(failure)}. There are no screenshots, so review the code as usual.`];
  }
  const at = `this branch at \`${result.headSha.slice(0, 7)}\``;
  const opening =
    result.outcome === "captured"
      ? `${UI_PR}, so the Kit captured screenshots of ${at} once the Implementer's run had ended.`
      : `${UI_PR}, but ${failureWords(result.reason)}. Review the code as usual, and judge the ${screenshots(given.length)} it took first, of ${at}, as below.`;
  const where = given.length === 1 ? "It's" : `These ${given.length} are`;
  const of = given.length < result.captures.length ? ` They're the ${given.length} that matter most of the ${result.captures.length} it took.` : "";
  return [
    "## UI evidence",
    [
      opening,
      "After is this branch, served in the Implement run's Sandbox; Before, where there is one, is the production site.",
      "Each shows one screen of the page from its top, not the whole page, so content below its bottom edge is out of view rather than cut off.",
      `${where} in \`${REVIEWER_IMAGES_DIR}/\` in your working directory: open each with your Read tool to see it.${of}`,
    ].join(" "),
    given.map(imageLine).join("\n"),
    "Judge them as part of the PR:",
    [
      "- Do they show what the Ticket asked for?",
      "- Is there plain breakage: a blank or error page, content spilling over at mobile width, or overlapping or cut-off content?",
      "- Against Before, where there is one, has any part of the page the Ticket didn't touch regressed?",
    ].join("\n"),
    "Taste is the Operator's: don't fail the PR over a design choice the Ticket didn't settle. A visual failure is an `execution-flaw` like any other: name the route and the screenshot in the finding, so the Implementer knows what to fix.",
  ];
}

/** Why there is no full set of screenshots: capture failed, or left none this Review could read. */
function failureWords(reason: CaptureFailure): string {
  return reason === "no-result"
    ? "capture left no result this Review could read: the Implement run kept none, or they have expired"
    : `capture failed because ${FAILURE_WORDS[reason]}`;
}

function screenshots(count: number): string {
  return `${count} screenshot${count === 1 ? "" : "s"}`;
}

/** One screenshot the Reviewer is given: its file, then its route (agent text, so as code on one line), viewport and side. */
function imageLine({ image, route, viewport, side, status }: Capture): string {
  const size = UI_VIEWPORTS.find(({ name }) => name === viewport);
  const width = size === undefined ? "" : ` (${size.width}×${size.height})`;
  const error = isServerError(status) ? `. It answered ${status}, so it shows a server's error page, not the design` : "";
  return `- \`${REVIEWER_IMAGES_DIR}/${image}\`: ${code(route)} at ${viewport} width${width}, ${SIDE_WORDS[side]}${error}`;
}
