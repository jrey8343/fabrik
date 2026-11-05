// The Design-session turn output contract: what a Design-session agent job
// emits and its push job applies. Both sides check it, so a malformed output
// never half-applies. A turn ends in either the next round or a final outcome:
// an agent brief or an Operator brief (small), a Spec and its Tickets
// (large), or, for a Ticket already under a Spec, sibling Tickets under that
// Spec. Any Ticket in an outcome may instead be an Operator step. Or the
// session ends as not planned: the Operator decided the issue won't be built.
import { isCommentIdList } from "./considered.ts";
import type { AgentBrief } from "./triageOutput.ts";

export interface RoundQuestion {
  readonly question: string;
  /** The answer the agent recommends, so the Operator can reply in a word. */
  readonly recommendation: string;
}

export type DesignTurnOutput = DesignTurnOutcome & {
  /**
   * For a turn on a Ticket sent back from an agent PR: the ids of the Operator
   * comments on that PR it weighed, which the comment it posts links when the
   * run was given them (src/loop/considered.ts). Left out when the turn gave
   * anything but a list of ids: as in the Implementer output, a bad list never
   * fails the turn.
   */
  readonly operatorCommentsConsidered?: readonly string[];
};

/** What a turn ends in: the next round, or one of the session's outcomes. */
type DesignTurnOutcome =
  | {
      /** The next round of questions for the Operator. */
      readonly kind: "round";
      /** A short lead-in: where the session stands and what this round settles. */
      readonly intro: string;
      readonly questions: readonly RoundQuestion[];
    }
  | {
      /** The small outcome: the issue is rewritten in place as an agent brief, or as an Operator brief. */
      readonly kind: "brief";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      readonly brief: AgentBrief | OperatorBrief;
    }
  | {
      /** The large outcome: a Spec and its Tickets, which supersede the issue. */
      readonly kind: "spec";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      readonly spec: { readonly title: string; readonly body: string };
      /** Each Ticket, with the keys of the Tickets that block it. Any order. */
      readonly tickets: readonly SpecTicket[];
    }
  | {
      /** A Ticket under a Spec, split into sibling Tickets under that same Spec, which supersede it. */
      readonly kind: "split";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      /** Each sibling Ticket, with the keys of the Tickets that block it. Any order. */
      readonly tickets: readonly SpecTicket[];
    }
  | {
      /** Nothing to build: the Operator decided the issue won't be built, so it closes as not planned. */
      readonly kind: "not-planned";
      /** What the Operator decided and why, for the closing comment. */
      readonly comment: string;
    };

/**
 * The small outcome when the whole issue is Operator work that fits one
 * sitting: ready for a Pairing session rather than an Implementer.
 */
export interface OperatorBrief {
  readonly operator: true;
  readonly summary: string;
  /** Each one action the Operator takes; the Kit writes them as a task list. */
  readonly steps: readonly string[];
}

/**
 * A Ticket as a Design session writes it, before it is an issue; or, marked
 * `operator`, an Operator step, which the Kit gives to the Operator instead.
 * Either can wait on the other.
 */
export type SpecTicket =
  | (TicketFields & { readonly operator?: undefined })
  | (TicketFields & {
      readonly operator: true;
      /** Each one action the Operator takes; the Kit writes them as a task list. */
      readonly steps: readonly string[];
    });

interface TicketFields {
  /** Names the Ticket for other Tickets' `blockedBy`; unique within the outcome. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly blockedBy: readonly string[];
}

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

/** At least one step, and no empty one. */
function isSteps(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isText);
}

function readBrief(value: unknown, errors: string[]): AgentBrief | OperatorBrief | null {
  if (isObject(value) && value.operator !== undefined) {
    if (value.operator !== true || !isText(value.summary) || !isSteps(value.steps)) {
      errors.push("an Operator brief needs operator: true, a summary and at least one step, with no empty step");
      return null;
    }
    return { operator: true, summary: value.summary, steps: value.steps };
  }
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

function readSpec(value: unknown, errors: string[]): { title: string; body: string } | null {
  if (!isObject(value) || !isText(value.title) || !isText(value.body)) {
    errors.push("a spec needs non-empty title and body text");
    return null;
  }
  return { title: value.title, body: value.body };
}

function readTickets(value: unknown, errors: string[], outcome: "spec" | "split"): SpecTicket[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`a ${outcome} needs at least one ticket`);
    return [];
  }
  const tickets: SpecTicket[] = [];
  value.forEach((item, i) => {
    if (
      !isObject(item) ||
      !isText(item.key) ||
      !isText(item.title) ||
      !isText(item.body) ||
      !Array.isArray(item.blockedBy) ||
      !item.blockedBy.every(isText)
    ) {
      errors.push(`ticket ${i + 1} needs non-empty key, title and body text, and a blockedBy list of keys`);
    } else if (item.operator === undefined) {
      const fields = { key: item.key, title: item.title, body: item.body, blockedBy: item.blockedBy };
      if (item.steps === undefined) tickets.push(fields);
      else errors.push(`ticket ${JSON.stringify(item.key)} has steps, so mark it "operator": true as an Operator step`);
    } else if (item.operator !== true || !isSteps(item.steps)) {
      errors.push(
        `operator step ${JSON.stringify(item.key)} needs "operator": true and at least one step, with no empty step`,
      );
    } else {
      tickets.push({
        key: item.key,
        title: item.title,
        body: item.body,
        blockedBy: item.blockedBy,
        operator: true,
        steps: item.steps,
      });
    }
  });
  return tickets;
}

/** Each Ticket's blockers must be other Tickets in the outcome, and no chain of them may loop. */
function checkBlockers(tickets: readonly SpecTicket[], errors: string[]): void {
  const keys = new Set<string>();
  for (const { key } of tickets) {
    if (keys.has(key)) errors.push(`ticket key ${JSON.stringify(key)} is used more than once`);
    keys.add(key);
  }
  for (const { key, blockedBy } of tickets) {
    for (const blocker of blockedBy) {
      if (blocker === key) errors.push(`ticket ${JSON.stringify(key)} blocks itself`);
      else if (!keys.has(blocker)) {
        errors.push(`ticket ${JSON.stringify(key)} is blocked by ${JSON.stringify(blocker)}, which isn't a ticket here`);
      }
    }
  }
  if (errors.length === 0 && dependencyOrder(tickets) === null) errors.push("the tickets' blockers form a cycle");
}

/**
 * The Tickets with every blocker before the Tickets it blocks, otherwise in
 * the order given; null if the blockers form a cycle.
 */
export function dependencyOrder(tickets: readonly SpecTicket[]): SpecTicket[] | null {
  const ordered: SpecTicket[] = [];
  const placed = new Set<string>();
  while (ordered.length < tickets.length) {
    const next = tickets.find(
      ({ key, blockedBy }) => !placed.has(key) && blockedBy.every((blocker) => placed.has(blocker)),
    );
    if (next === undefined) return null;
    ordered.push(next);
    placed.add(next.key);
  }
  return ordered;
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readDesignTurnOutput(value: unknown): DesignTurnOutputResult {
  const result = readTurn(value);
  if (!result.ok || !isObject(value) || !isCommentIdList(value.operatorCommentsConsidered)) return result;
  return { ok: true, output: { ...result.output, operatorCommentsConsidered: value.operatorCommentsConsidered } };
}

function readTurn(value: unknown): DesignTurnOutputResult {
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
    case "spec": {
      if (!isText(value.comment)) errors.push("a spec needs non-empty comment text");
      const spec = readSpec(value.spec, errors);
      const tickets = readTickets(value.tickets, errors, "spec");
      if (errors.length === 0) checkBlockers(tickets, errors);
      if (errors.length > 0 || spec === null) return { ok: false, errors };
      return { ok: true, output: { kind: "spec", comment: value.comment as string, spec, tickets } };
    }
    case "split": {
      if (!isText(value.comment)) errors.push("a split needs non-empty comment text");
      const tickets = readTickets(value.tickets, errors, "split");
      if (errors.length === 0) checkBlockers(tickets, errors);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "split", comment: value.comment as string, tickets } };
    }
    case "not-planned": {
      if (!isText(value.comment)) return { ok: false, errors: ["not-planned needs non-empty comment text"] };
      return { ok: true, output: { kind: "not-planned", comment: value.comment } };
    }
    default:
      return { ok: false, errors: [`kind must be round, brief, spec, split or not-planned, not ${JSON.stringify(value.kind)}`] };
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
