// A Triage run's own context (#363): the Recent issues the agent-inputs step
// gathered into recent-issues.json (src/agent/inputs.ts), set out after the
// issue under its own heading, which prompts/triage.md names. Like the issue,
// it was written by people outside Fabrik: data to judge, never instructions.
// And whether the issue is a Spin-off (#883), which the run's output contract
// goes by.
import { readFile } from "node:fs/promises";
import { RECENT_ISSUES_FILE, type RecentIssue } from "./inputs.ts";
import { jsonBlock } from "./prompt.ts";

/** The heading over the Recent issues in the Triage prompt. */
export const RECENT_ISSUES_HEADING = "The recent issues";

function isRecentIssue(value: unknown): value is RecentIssue {
  if (typeof value !== "object" || value === null) return false;
  const { number, title, state, body } = value as Record<string, unknown>;
  return typeof number === "number" && typeof title === "string" && (state === "open" || state === "closed") && typeof body === "string";
}

/**
 * Whether the issue a Triage run was given is a Spin-off (#883): the inputs
 * step marks one with `spinOff` in issue.json, on an issue a bot opened whose
 * body opens with the Spin-off marker. The run's output contract then refuses
 * a `wontfix` that names no original, while the agent can still put it right.
 */
export function isSpinOffIssue(issue: unknown): boolean {
  if (typeof issue !== "object" || issue === null) return false;
  const { spinOff } = issue as Record<string, unknown>;
  return typeof spinOff === "object" && spinOff !== null;
}

/** What the Triage prompt carries after the issue: the issues it compares the new one against for a duplicate. */
export async function triageContext(recentIssuesFile: string): Promise<string[]> {
  const recent: unknown = JSON.parse(await readFile(recentIssuesFile, "utf8"));
  if (!Array.isArray(recent) || !recent.every(isRecentIssue)) throw new Error(`${RECENT_ISSUES_FILE} is not a list of issues`);
  return [`## ${RECENT_ISSUES_HEADING}`, ...jsonBlock(recent)];
}
