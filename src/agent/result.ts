// What an agent job passes to its push job (ADR-0002): the role, the issue it
// ran for, and the structured output it emitted. The push job applies it
// through the Loop rules core, which checks the output against its contract.
// An Implement run also passes the branch it built, as a git bundle beside it.
import type { AgentRole } from "../loop/types.ts";

/** The branch an Implement run built, which the push job reads back from the bundle. */
export interface BuiltBranch {
  /** The agent branch's name. */
  readonly name: string;
  /** The branch it was cut from, and the commit it started at. */
  readonly base: { readonly ref: string; readonly sha: string };
  /** The branch's last commit, or null if the Implementer made none (and there's no bundle). */
  readonly head: string | null;
}

export interface AgentRunResult {
  readonly role: AgentRole;
  readonly issue: number;
  /** The agent's structured output, as text, unchecked. */
  readonly output: string;
  /** For an Implement run only. */
  readonly branch?: BuiltBranch;
}

/** The artifact's file name, the same in both jobs. */
export const AGENT_RESULT_FILE = "agent-result.json";

/** The Implementer's commits, beside the result, when it made any. */
export const AGENT_BUNDLE_FILE = "agent-branch.bundle";

const ROLES: readonly AgentRole[] = ["triage", "design", "implement", "review"];

const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9._/-]+$/;

/** Reads the artifact's text, refusing anything that isn't a result for a known role. */
export function readAgentRunResult(text: string): AgentRunResult {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error(`${AGENT_RESULT_FILE} is not a JSON object`);
  const { role, issue, output, branch } = value as Record<string, unknown>;
  if (typeof role !== "string" || !ROLES.includes(role as AgentRole)) {
    throw new Error(`${AGENT_RESULT_FILE} names an unknown role: ${JSON.stringify(role)}`);
  }
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue < 1) {
    throw new Error(`${AGENT_RESULT_FILE} names no issue`);
  }
  if (typeof output !== "string") throw new Error(`${AGENT_RESULT_FILE} has no output text`);
  if (role !== "implement") return { role: role as AgentRole, issue, output };
  return { role, issue, output, branch: readBranch(branch) };
}

function readBranch(value: unknown): BuiltBranch {
  const fail = (): never => {
    throw new Error(`${AGENT_RESULT_FILE} has no valid branch for the Implement run`);
  };
  if (typeof value !== "object" || value === null) return fail();
  const { name, base, head } = value as Record<string, unknown>;
  if (typeof name !== "string" || !REF.test(name)) return fail();
  if (typeof base !== "object" || base === null) return fail();
  const { ref, sha } = base as Record<string, unknown>;
  if (typeof ref !== "string" || !REF.test(ref) || typeof sha !== "string" || !SHA.test(sha)) return fail();
  if (head !== null && (typeof head !== "string" || !SHA.test(head))) return fail();
  return { name, base: { ref, sha }, head: head as string | null };
}
