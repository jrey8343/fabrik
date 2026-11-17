// The Review agent job's own context around the Reviewer: the PR it judges,
// checked out at the head its required checks passed on, the Operator's
// Request changes reviews on it, which amend the Ticket (ADR-0010), and its
// comments on it, with the Ticket's Spec, the repo's glossary and ADRs, its
// Coding standards, the existing tests its Implement runs changed (#463), and
// on a UI PR its UI evidence. Only a later Review is given the Reviewer's
// earlier Verdicts, the fix comments and the change since the last judged
// head (src/agent/laterReview.ts, #748); a Full Review is given none of them.
// The Reviewer holds no GitHub credential and runs none of the PR's code.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPTURE_RESULT_FILE,
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
import { changedTestsIn, reviewerChangedTestsBlock } from "../loop/changedTests.ts";
import { checkCode } from "../loop/flakyChecks.ts";
import { ticketContext, type PullRequestRunContext } from "./implement.ts";
import { type LaterReviewGiven, laterReviewParts, type PushingRun } from "./laterReview.ts";
import { operatorInputSections } from "./operatorComments.ts";

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
  ranNothing: readonly string[] = [],
  later: LaterReviewGiven | null = null,
): Promise<PullRequestRunContext> {
  const { operatorComments, requestedChanges, ...pullRequest } = (JSON.parse(await readFile(pullRequestFile, "utf8")) ?? {}) as {
    number?: unknown;
    body?: unknown;
    headRefOid?: unknown;
    operatorComments?: unknown;
    requestedChanges?: unknown;
  };
  const fromOperator = operatorInputSections({ operatorComments, requestedChanges });
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
      // The Kit's own list in the body (#463), which no agent can forge: the Kit strips any from the Implementer's summary.
      ...reviewerChangedTestsBlock(typeof pullRequest.body === "string" ? changedTestsIn(pullRequest.body) : []),
      ...fromOperator.parts,
      // Only a later Review is given what it judges against: its earlier Verdicts, the fix comments and the change since (#748).
      ...(later === null ? [] : laterReviewParts(later)),
      ...(await ticketContext(productDir, specFile)),
      ...(standards === null ? [] : [`## ${CODING_STANDARDS_FILE}`, standards.trimEnd()]),
      ...ranNothingBlock(ranNothing),
      ...(evidenceDir === null
        ? []
        : await uiEvidenceContext(productDir, evidenceDir, { head: headOf(pullRequest.headRefOid), recorded: recordedFailure })),
    ],
    operatorComments: fromOperator.given,
  };
}

/** The heading of prompts/review.md's section that only a Full Review is given (#747). */
const FULL_REVIEW_HEADING = "## Full Review";

/** The heading of prompts/review.md's section that only a later Review is given (#748). */
const LATER_REVIEW_HEADING = "## Later Review";

/** The heading of the later-Review section's part that only the Review of a conflict-only run's push is given (#748). */
const CONFLICT_ONLY_HEADING = "### A conflict-only run's push";

/**
 * The Reviewer's prompt from prompts/review.md for a Full Review, when
 * `later` is null, or for a later Review. A Full Review's carries the Full
 * Review section, whose Verdict settles the code (#747); a later Review's
 * carries the later-Review section instead, with its conflict-only part only
 * when a conflict-only run pushed the head (#748). Each kind sees only its own
 * section, and the prompt is otherwise the same.
 */
export function reviewPromptFor(template: string, later: { readonly pushedBy: PushingRun | null } | null): string {
  if (later === null) return withoutSection(template, LATER_REVIEW_HEADING);
  const prompt = withoutSection(template, FULL_REVIEW_HEADING);
  return later.pushedBy === "conflict-only-run" ? prompt : withoutSection(prompt, CONFLICT_ONLY_HEADING);
}

/**
 * A prompt without its section of this heading, up to the next heading of
 * its level or higher, or its end.
 */
function withoutSection(template: string, heading: string): string {
  const lines = template.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return template;
  const level = heading.indexOf(" ");
  const next = lines.findIndex((line, at) => at > start && /^#+ /.test(line) && line.indexOf(" ") <= level);
  return [...lines.slice(0, start), ...(next === -1 ? [] : lines.slice(next))].join("\n");
}

/** Whether the Review is a Full Review, as the Kit job passed it out (src/kit/jobs.ts): "true" or "false", never left to guess, so anything else throws. */
export function isFullReview(text: string | undefined): boolean {
  if (text === "true" || text === "false") return text === "true";
  throw new Error(`FABRIK_FULL_REVIEW is ${JSON.stringify(text ?? null)}, not "true" or "false"`);
}

/** The Required checks that ran nothing, as the Review's checks job passed them out: a JSON list of names, none when it passed out nothing. */
export function ranNothingOf(text: string | undefined): string[] {
  const value: unknown = JSON.parse(text === undefined || text === "" ? "[]" : text);
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) throw new Error("FABRIK_RAN_NOTHING is not a list of check names");
  return value;
}

/**
 * The Required checks that passed on this head only by being skipped or
 * reporting neutral (#456), which the Review's checks job read from GitHub:
 * nothing when every one ran. A pass may not lean on them.
 */
function ranNothingBlock(ranNothing: readonly string[]): string[] {
  if (ranNothing.length === 0) return [];
  return [
    "## Required checks that ran nothing",
    "Kit code read these from GitHub: these Required checks were skipped or reported neutral on this head, so they passed as GitHub's merge passes them but ran nothing. They vouch for nothing here.",
    ranNothing.map((name) => `- ${checkCode(name)}`).join("\n"),
  ];
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
