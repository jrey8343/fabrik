// An Auditor run's own context (#150): what the agent-inputs step gathered
// into audit.json (src/agent/inputs.ts), the pending Audit's number and marked
// commit under its issue, then the rest in sections prompts/audit.md names. The Auditor works in a read-only checkout
// of the marked commit, holds no GitHub credential and runs none of the code.
import { readFile } from "node:fs/promises";
import type { AuditWindow } from "../loop/types.ts";
import { AUDIT_INPUTS_FILE, type AuditInputs } from "./inputs.ts";
import { jsonBlock } from "./prompt.ts";

/** The heading over the pending Audit's own issue in the Auditor's prompt. */
export const AUDIT_ISSUE_HEADING = "The pending Audit";

/** The heading each of the Auditor's inputs is set out under, in the order the prompt reads them. */
export const AUDIT_SECTIONS = {
  window: "The hot-spot window",
  drift: "Comprehension drift",
  pullRequests: "Agent PRs merged in the window",
  closedAudits: "The last closed Audits",
  filedCandidates: "Open issues filed from Audits",
} as const;

/**
 * What the Auditor's prompt carries after the pending Audit's issue, still
 * under its heading, and the hot-spot window it was given, which its result
 * records for the Audit to name.
 */
export async function auditContext(auditFile: string): Promise<{ window: AuditWindow; parts: string[] }> {
  const inputs = JSON.parse(await readFile(auditFile, "utf8")) as Partial<AuditInputs> | null;
  const audit = inputs?.audit;
  if (typeof audit?.number !== "number" || typeof audit.commit !== "string") {
    throw new Error(`${AUDIT_INPUTS_FILE} has no pending Audit with its marked commit`);
  }
  const window = inputs?.window;
  if (window?.kind !== "since-audit" && window?.kind !== "last-days") throw new Error(`${AUDIT_INPUTS_FILE} has no hot-spot window`);
  const lists = ["drift", "pullRequests", "closedAudits", "filedCandidates"] as const;
  for (const list of lists) {
    if (!Array.isArray(inputs?.[list])) throw new Error(`${AUDIT_INPUTS_FILE} has no ${list} list`);
  }
  return {
    window,
    parts: [
      `This is Audit #${audit.number}. Its marked commit, which you're checked out at, is \`${audit.commit}\`.`,
      `## ${AUDIT_SECTIONS.window}`,
      ...jsonBlock(window),
      ...lists.flatMap((list) => [`## ${AUDIT_SECTIONS[list]}`, ...jsonBlock(inputs?.[list])]),
    ],
  };
}
