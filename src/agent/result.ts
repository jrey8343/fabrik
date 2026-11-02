// What an agent job passes to its push job (ADR-0002): the role, the issue it
// ran for, and the structured output it emitted. The push job applies it
// through the Loop rules core, which checks the output against its contract.
import type { AgentRole } from "../loop/types.ts";

export interface AgentRunResult {
  readonly role: AgentRole;
  readonly issue: number;
  /** The agent's structured output, as text, unchecked. */
  readonly output: string;
}

/** The artifact's file name, the same in both jobs. */
export const AGENT_RESULT_FILE = "agent-result.json";

const ROLES: readonly AgentRole[] = ["triage"];

/** Reads the artifact's text, refusing anything that isn't a result for a known role. */
export function readAgentRunResult(text: string): AgentRunResult {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error(`${AGENT_RESULT_FILE} is not a JSON object`);
  const { role, issue, output } = value as Record<string, unknown>;
  if (typeof role !== "string" || !ROLES.includes(role as AgentRole)) {
    throw new Error(`${AGENT_RESULT_FILE} names an unknown role: ${JSON.stringify(role)}`);
  }
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue < 1) {
    throw new Error(`${AGENT_RESULT_FILE} names no issue`);
  }
  if (typeof output !== "string") throw new Error(`${AGENT_RESULT_FILE} has no output text`);
  return { role: role as AgentRole, issue, output };
}
