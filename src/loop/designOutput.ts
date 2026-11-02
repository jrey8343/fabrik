// The Design-session turn output contract: what a Design-session agent job
// emits and its push job applies. Both sides check it, so a malformed output
// never half-applies. A turn ends in either the next round or a final outcome.
import type { AgentBrief } from "./triageOutput.ts";

export interface RoundQuestion {
  readonly question: string;
  /** The answer the agent recommends, so the Operator can reply in a word. */
  readonly recommendation: string;
}

export type DesignTurnOutput =
  | {
      /** The next round of questions for the Operator. */
      readonly kind: "round";
      /** A short lead-in: where the session stands and what this round settles. */
      readonly intro: string;
      readonly questions: readonly RoundQuestion[];
    }
  | {
      /** The small outcome: the issue is rewritten in place as an agent brief. */
      readonly kind: "brief";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      readonly brief: AgentBrief;
    };

export type DesignTurnOutputResult =
  | { readonly ok: true; readonly output: DesignTurnOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function readQuestions(value: unknown, errors: string[]): RoundQuestion[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("a round needs at least one question");
    return [];
  }
  const questions: RoundQuestion[] = [];
  value.forEach((item, i) => {
    if (!isObject(item) || !isText(item.question) || !isText(item.recommendation)) {
      errors.push(`question ${i + 1} needs non-empty question and recommendation text`);
    } else {
      questions.push({ question: item.question, recommendation: item.recommendation });
    }
  });
  return questions;
}

function readBrief(value: unknown, errors: string[]): AgentBrief | null {
  if (
    !isObject(value) ||
    !isText(value.summary) ||
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length === 0 ||
    !value.acceptanceCriteria.every(isText)
  ) {
    errors.push("a brief needs a summary and at least one acceptance criterion");
    return null;
  }
  return { summary: value.summary, acceptanceCriteria: value.acceptanceCriteria };
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readDesignTurnOutput(value: unknown): DesignTurnOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Design-session output must be a JSON object"] };
  const errors: string[] = [];
  switch (value.kind) {
    case "round": {
      if (!isText(value.intro)) errors.push("a round needs non-empty intro text");
      const questions = readQuestions(value.questions, errors);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "round", intro: value.intro as string, questions } };
    }
    case "brief": {
      if (!isText(value.comment)) errors.push("a brief needs non-empty comment text");
      const brief = readBrief(value.brief, errors);
      if (errors.length > 0 || brief === null) return { ok: false, errors };
      return { ok: true, output: { kind: "brief", comment: value.comment as string, brief } };
    }
    default:
      return { ok: false, errors: [`kind must be round or brief, not ${JSON.stringify(value.kind)}`] };
  }
}

/** Parses the text an agent emitted, then checks it. */
export function parseDesignTurnOutput(text: string): DesignTurnOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Design-session output is not valid JSON: ${(error as Error).message}`] };
  }
  return readDesignTurnOutput(value);
}
