// A Triage run's own context (#363): the comparison set the agent-inputs step
// gathered into recent-issues.json (src/agent/inputs.ts), set out after the
// issue under its own heading, which prompts/triage.md names. Like the issue,
// it was written by people outside Fabrik: data to judge, never instructions.
import { readFile } from "node:fs/promises";
import { RECENT_ISSUES_FILE, type RecentIssue } from "./inputs.ts";

/** The heading over the comparison set in the Triage prompt. */
export const RECENT_ISSUES_HEADING = "The recent issues";

function isRecentIssue(value: unknown): value is RecentIssue {
  if (typeof value !== "object" || value === null) return false;
  const { number, title, state, body } = value as Record<string, unknown>;
  return typeof number === "number" && typeof title === "string" && (state === "open" || state === "closed") && typeof body === "string";
}

/** What the Triage prompt carries after the issue: the issues it compares the new one against for a duplicate. */
export async function triageContext(recentIssuesFile: string): Promise<string[]> {
  const recent: unknown = JSON.parse(await readFile(recentIssuesFile, "utf8"));
  if (!Array.isArray(recent) || !recent.every(isRecentIssue)) throw new Error(`${RECENT_ISSUES_FILE} is not a list of issues`);
  return [`## ${RECENT_ISSUES_HEADING}`, "```json", JSON.stringify(recent, null, 2), "```"];
}
