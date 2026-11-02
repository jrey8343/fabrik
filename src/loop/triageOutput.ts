// The Triage output contract: what a Triage agent job emits and its push job
// applies. Both sides check it, so a malformed output never half-applies.
import { CATEGORY_LABELS, type CategoryLabel, isCategoryLabel, NEEDS_TRIAGE, READY_FOR_AGENT, STATE_LABELS, type StateLabel } from "./labels.ts";

/** The brief a Fast-path issue carries to its Implementer. */
export interface AgentBrief {
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface TriageOutput {
  /** `bug` or `enhancement`. */
  readonly category: CategoryLabel;
  /** Any state label but `needs-triage`. */
  readonly state: TriageState;
  /** The comment Triage leaves on the issue, explaining its sorting. */
  readonly comment: string;
  /** Present exactly when the state is `ready-for-agent` (the Fast path). */
  readonly brief: AgentBrief | null;
}

/** The states Triage may sort an issue into. */
export type TriageState = Exclude<StateLabel, typeof NEEDS_TRIAGE>;
export const TRIAGE_STATES = STATE_LABELS.filter((label): label is TriageState => label !== NEEDS_TRIAGE);

function isTriageState(label: string): label is TriageState {
  return (TRIAGE_STATES as readonly string[]).includes(label);
}

export type TriageOutputResult =
  | { readonly ok: true; readonly output: TriageOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readTriageOutput(value: unknown): TriageOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Triage output must be a JSON object"] };
  const errors: string[] = [];
  const { category, state, comment, brief } = value;
  if (typeof category !== "string" || !isCategoryLabel(category)) {
    errors.push(`category must be one of ${CATEGORY_LABELS.join(", ")}, not ${JSON.stringify(category)}`);
  }
  if (typeof state !== "string" || !isTriageState(state)) {
    errors.push(`state must be one of ${TRIAGE_STATES.join(", ")}, not ${JSON.stringify(state)}`);
  }
  if (!isText(comment)) errors.push("comment must be non-empty text");

  let agentBrief: AgentBrief | null = null;
  if (state === READY_FOR_AGENT) {
    if (
      !isObject(brief) ||
      !isText(brief.summary) ||
      !Array.isArray(brief.acceptanceCriteria) ||
      brief.acceptanceCriteria.length === 0 ||
      !brief.acceptanceCriteria.every(isText)
    ) {
      errors.push("the Fast path needs a brief with a summary and at least one acceptance criterion");
    } else {
      agentBrief = { summary: brief.summary, acceptanceCriteria: brief.acceptanceCriteria };
    }
  } else if (brief !== undefined && brief !== null) {
    errors.push("only the Fast path (ready-for-agent) carries a brief");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: { category: category as CategoryLabel, state: state as TriageState, comment: comment as string, brief: agentBrief },
  };
}

/** Parses the text an agent emitted, then checks it. */
export function parseTriageOutput(text: string): TriageOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Triage output is not valid JSON: ${(error as Error).message}`] };
  }
  return readTriageOutput(value);
}
