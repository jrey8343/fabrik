// A Researcher run's own context (#154): after the research Decision's issue,
// its Map, as the agent-inputs step read the issue's parent into spec.json
// (src/agent/inputs.ts), then the one findings file the Kit names from the
// Decision's number and title (src/loop/researchPaths.ts), in sections
// prompts/research.md names. The Researcher holds no GitHub credential and
// runs none of the code.
import { readFile } from "node:fs/promises";
import { findingsPathFor } from "../loop/researchPaths.ts";

/** The heading over the research Decision's own issue in the Researcher's prompt. */
export const RESEARCH_ISSUE_HEADING = "The research Decision";

/** The heading each of the Researcher's other inputs is set out under, in the order the prompt reads them. */
export const RESEARCH_SECTIONS = {
  map: "The Map",
  findingsFile: "The findings file",
} as const;

const json = (value: unknown): string[] => ["```json", JSON.stringify(value, null, 2), "```"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What the Researcher's prompt carries after the research Decision's issue,
 * and the findings file it names, the one file the run may write. `mapFile`
 * holds the Decision's parent, its Map; `decision` is the issue as
 * FABRIK_ISSUE_FILE holds it.
 */
export async function researchContext(mapFile: string, decision: unknown): Promise<{ findingsPath: string; parts: string[] }> {
  if (!isObject(decision) || typeof decision["number"] !== "number" || typeof decision["title"] !== "string") {
    throw new Error("The research Decision has no number and title to name its findings file from");
  }
  const map: unknown = JSON.parse(await readFile(mapFile, "utf8"));
  if (!isObject(map) || typeof map["number"] !== "number" || typeof map["title"] !== "string" || typeof map["body"] !== "string") {
    throw new Error(`${mapFile} holds no Map with its number, title and body: a research Decision is a sub-issue of one`);
  }
  const findingsPath = findingsPathFor({ number: decision["number"], title: decision["title"] });
  return {
    findingsPath,
    parts: [
      `## ${RESEARCH_SECTIONS.map}`,
      ...json(map),
      `## ${RESEARCH_SECTIONS.findingsFile}`,
      `Write your findings to \`${findingsPath}\`, from the repo root, and change no other file.`,
    ],
  };
}
