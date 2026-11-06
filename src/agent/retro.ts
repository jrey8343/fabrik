// A Retro run's own context (#151): the evidence bundle the Retro evidence job
// gathered (src/kit/retroEvidence.ts), and the Kit's role prompts and rubrics,
// set out after the pending Retro's issue under the headings prompts/retro.md
// names. The Retro works in a read-only checkout of the default branch, holds
// no GitHub credential and runs none of the code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { kitPromptPath } from "../guard/trust-root.ts";
import { readEvidenceBundle } from "../kit/retroEvidence.ts";
import { RUBRICS_DIR, SCORERS } from "../kit/rubrics.ts";
import { AGENT_ROLES } from "../loop/types.ts";

/** The heading over the pending Retro's own issue in the Retro's prompt. */
export const RETRO_ISSUE_HEADING = "The pending Retro";

/** The heading each of the Retro's inputs is set out under, in the order the prompt reads them. */
export const RETRO_SECTIONS = {
  window: "The window",
  escapes: "Architectural escapes",
  feedback: "Operator feedback",
  followUps: "Follow-ups on passing Verdicts",
  lowScores: "Low-scoring runs",
  sample: "The sample",
  streaks: "The streak table",
  closedRetros: "The last closed Retros",
  filedProposals: "Open issues filed from Retros",
  kit: "The Kit's role prompts and rubrics",
} as const;

/**
 * A list as JSON, one compact item to a line: readable item by item, and
 * about the size the bundle was held to (EVIDENCE_BUDGET), which it wouldn't
 * be indented.
 */
function listed(items: readonly unknown[]): string[] {
  return ["```json", items.length === 0 ? "[]" : `[\n${items.map((item) => JSON.stringify(item)).join(",\n")}\n]`, "```"];
}

/** A Kit file's text, quoted whole: in a fence longer than any run of backticks in it. */
function quoted(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}markdown`, text.trimEnd(), fence];
}

/**
 * What the Retro's prompt carries after the pending Retro's issue: each part
 * of the evidence bundle in `evidenceFile` under its heading, then the Kit's
 * prompt for each role and each Scorer's rubric, read from the Kit checkout at
 * `kitDir`, each under its path in the Kit, so a proposal to change one can
 * quote its text. Throws on evidence that isn't a bundle, or a Kit file it
 * can't read, so the run fails rather than proposes blind.
 */
export async function retroContext(evidenceFile: string, kitDir: string): Promise<string[]> {
  const bundle = readEvidenceBundle(await readFile(evidenceFile, "utf8"));
  const kitPaths = [...AGENT_ROLES.map(kitPromptPath), ...SCORERS.map((name) => `${RUBRICS_DIR}/${name}.md`)];
  const kitFiles = await Promise.all(kitPaths.map(async (path) => [path, await readFile(join(kitDir, path), "utf8")] as const));
  return [
    `## ${RETRO_SECTIONS.window}`,
    "```json",
    JSON.stringify(bundle.window),
    "```",
    ...(["escapes", "feedback", "followUps", "lowScores", "sample"] as const).flatMap((part) => [`## ${RETRO_SECTIONS[part]}`, ...listed(bundle[part])]),
    `## ${RETRO_SECTIONS.streaks}`,
    ...listed(bundle.streakTable),
    `## ${RETRO_SECTIONS.closedRetros}`,
    ...listed(bundle.history.retros),
    `## ${RETRO_SECTIONS.filedProposals}`,
    ...listed(bundle.history.filed),
    `## ${RETRO_SECTIONS.kit}`,
    ...kitFiles.flatMap(([path, text]) => [`### ${path}`, ...quoted(text)]),
  ];
}
