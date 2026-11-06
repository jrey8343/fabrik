// The Design-session turn output contract: what a Design-session agent job
// emits and its push job applies. Both sides check it, so a malformed output
// never half-applies. A turn ends in either the next round or a final outcome:
// an agent brief or an Operator brief (small), a Spec and its Tickets
// (large), or, for a Ticket already under a Spec, sibling Tickets under that
// Spec. Any Ticket in an outcome may instead be an Operator step. Or the
// session ends as not planned: the Operator decided the issue won't be built.
// Or, when the destination is too foggy to design in one session, the issue
// becomes a Map with its first Decisions. Two kinds carry a Prototype (#155)
// and end nothing: an ordinary turn's `prototype`, the request the Operator
// approved, and a prototype turn's `prototype-round`, the variants it built.
import { isRoute } from "../kit/config.ts";
import { isCommentIdList } from "./considered.ts";
import { DECISION_TYPES, type DecisionType } from "./labels.ts";
import type { AgentBrief } from "./triageOutput.ts";

/**
 * The fewest variants a Prototype builds: with one, there is nothing to
 * choose between. A Kit constant, not Kit config, like the two below.
 */
export const PROTOTYPE_MIN_VARIANTS = 2;

/** How many variants a Prototype builds when the Operator didn't ask for another count, as the `prototype` skill does. */
export const PROTOTYPE_DEFAULT_VARIANTS = 3;

/** The most variants a Prototype builds: past five they stop being different and the gallery stops being quick to look through. */
export const PROTOTYPE_VARIANT_CAP = 5;

/**
 * Whether the Kit runs UI prototypes at all. Off until UI prototypes are
 * switched on (#282): until then no Design prompt offers a Prototype and the
 * Loop rules core refuses every `prototype` output. Only tests pass `switchedOn`.
 */
export const PROTOTYPES_SWITCHED_ON = false;

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
    }
  | {
      /** The foggy outcome: the issue is rewritten in place as a Map, with its first Decisions as its sub-issues. */
      readonly kind: "map";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      /** What reaching the end of the Map looks like. The Kit writes the Map body from these sections. */
      readonly destination: string;
      /** The domain, skills and standing preferences every session on the Map consults; may be empty. */
      readonly notes: string;
      /** In-scope fog that can't be a Decision yet; may be empty. */
      readonly notYetSpecified: string;
      /** Work ruled beyond the destination; may be empty. */
      readonly outOfScope: string;
      /** Each Decision, with the keys of the Decisions that block it. Any order. */
      readonly decisions: readonly MapDecision[];
    }
  | ({
      /**
       * Not an outcome: the Operator approved a Prototype, so the Kit posts a
       * prototype request and starts a prototype turn of the same session.
       */
      readonly kind: "prototype";
      /** A one-line lead-in for the prototype request comment. */
      readonly comment: string;
    } & PrototypeRequest)
  | {
      /**
       * Not an outcome: a prototype turn built the variants, so the Kit posts a
       * prototype round. The agent writes no question: the Kit asks "Which variant?".
       */
      readonly kind: "prototype-round";
      /** Markdown: the round's lead-in. */
      readonly intro: string;
      /** One per variant, in letter order. */
      readonly variants: readonly PrototypeVariant[];
      /** The variant the agent recommends, with any tweak it suggests, so the Operator can reply in a word. */
      readonly recommendation: string;
    };

/** What the Operator approved a prototype turn to build. */
export interface PrototypeRequest {
  /** The one route every variant renders on, starting with `/`. */
  readonly route: string;
  /** How many variants to build, from PROTOTYPE_MIN_VARIANTS to PROTOTYPE_VARIANT_CAP. */
  readonly variants: number;
  /** Markdown: what each variant explores, and anything the Operator asked for. */
  readonly brief: string;
}

/** One variant a prototype turn built, as its prototype round describes it. */
export interface PrototypeVariant {
  /** Its letter, from its place in the round (variantLetter): what `?variant=` names it by. */
  readonly letter: string;
  /** One line on what it is. */
  readonly summary: string;
  /** The repo path, from the root, of the component that renders it. */
  readonly component: string;
}

/**
 * The issue's prototype branch, which every prototype turn of its Design
 * sessions builds on and nothing in the Kit merges or deletes.
 */
export function prototypeBranchFor(issue: number): string {
  return `prototype/${issue}`;
}

/** The letter of the variant at `index`: A for the first, then B, C… */
export function variantLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/** A Decision as a Design session writes it, before it is a sub-issue of its Map. */
export interface MapDecision {
  /** Names the Decision for other Decisions' `blockedBy`; unique within the outcome. */
  readonly key: string;
  readonly title: string;
  /** The question it resolves. */
  readonly body: string;
  /** How it gets resolved, which its `wayfinder:<type>` label says. */
  readonly type: DecisionType;
  readonly blockedBy: readonly string[];
}

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

/** Non-empty text on one line. */
function isLine(value: unknown): value is string {
  return isText(value) && !/[\r\n]/.test(value);
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

function readDecisions(value: unknown, errors: string[]): MapDecision[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("a map needs at least one decision");
    return [];
  }
  const decisions: MapDecision[] = [];
  value.forEach((item, i) => {
    if (
      !isObject(item) ||
      !isText(item.key) ||
      !isText(item.title) ||
      !isText(item.body) ||
      !Array.isArray(item.blockedBy) ||
      !item.blockedBy.every(isText)
    ) {
      errors.push(`decision ${i + 1} needs non-empty key, title and body text, and a blockedBy list of keys`);
    } else if (!isDecisionType(item.type)) {
      errors.push(
        `decision ${JSON.stringify(item.key)} has the type ${JSON.stringify(item.type)}, which must be one of ${DECISION_TYPES.join(", ")}`,
      );
    } else {
      decisions.push({ key: item.key, title: item.title, body: item.body, type: item.type, blockedBy: item.blockedBy });
    }
  });
  return decisions;
}

function isDecisionType(value: unknown): value is DecisionType {
  return (DECISION_TYPES as readonly unknown[]).includes(value);
}

/** A prototype round's variants, each lettered from its place in the list. */
function readVariants(value: unknown, errors: string[]): PrototypeVariant[] {
  if (!Array.isArray(value) || !isVariantCount(value.length)) {
    errors.push(`a prototype-round needs from ${PROTOTYPE_MIN_VARIANTS} to ${PROTOTYPE_VARIANT_CAP} variants`);
    if (!Array.isArray(value)) return [];
  }
  const variants: PrototypeVariant[] = [];
  value.forEach((item: unknown, i: number) => {
    const letter = variantLetter(i);
    const { summary, component } = isObject(item) ? item : {};
    if (!isLine(summary)) errors.push(`variant ${letter} needs a summary, one non-empty line`);
    if (!isRepoPath(component)) errors.push(`variant ${letter} needs the repo path of its component`);
    if (isLine(summary) && isRepoPath(component)) variants.push({ letter, summary, component });
  });
  return variants;
}

/** A path from the repo root, on one line: never an absolute path on the runner. */
function isRepoPath(value: unknown): value is string {
  return isLine(value) && !value.startsWith("/");
}

/** A whole number of variants within the Kit's minimum and cap. */
export function isVariantCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= PROTOTYPE_MIN_VARIANTS && (value as number) <= PROTOTYPE_VARIANT_CAP;
}

/** What the blocked-by edges within an outcome link: its Tickets, or its Decisions. */
interface Blocked {
  readonly key: string;
  readonly blockedBy: readonly string[];
}

/** Each item's blockers must be other items in the outcome, and no chain of them may loop. */
function checkBlockers(items: readonly Blocked[], errors: string[], noun: "ticket" | "decision"): void {
  const keys = new Set<string>();
  for (const { key } of items) {
    if (keys.has(key)) errors.push(`${noun} key ${JSON.stringify(key)} is used more than once`);
    keys.add(key);
  }
  for (const { key, blockedBy } of items) {
    for (const blocker of blockedBy) {
      if (blocker === key) errors.push(`${noun} ${JSON.stringify(key)} blocks itself`);
      else if (!keys.has(blocker)) {
        errors.push(`${noun} ${JSON.stringify(key)} is blocked by ${JSON.stringify(blocker)}, which isn't a ${noun} here`);
      }
    }
  }
  if (errors.length === 0 && dependencyOrder(items) === null) errors.push(`the ${noun}s' blockers form a cycle`);
}

/**
 * The Tickets or Decisions with every blocker before the ones it blocks,
 * otherwise in the order given; null if the blockers form a cycle.
 */
export function dependencyOrder<T extends Blocked>(items: readonly T[]): T[] | null {
  const ordered: T[] = [];
  const placed = new Set<string>();
  while (ordered.length < items.length) {
    const next = items.find(
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
      if (errors.length === 0) checkBlockers(tickets, errors, "ticket");
      if (errors.length > 0 || spec === null) return { ok: false, errors };
      return { ok: true, output: { kind: "spec", comment: value.comment as string, spec, tickets } };
    }
    case "split": {
      if (!isText(value.comment)) errors.push("a split needs non-empty comment text");
      const tickets = readTickets(value.tickets, errors, "split");
      if (errors.length === 0) checkBlockers(tickets, errors, "ticket");
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "split", comment: value.comment as string, tickets } };
    }
    case "not-planned": {
      if (!isText(value.comment)) return { ok: false, errors: ["not-planned needs non-empty comment text"] };
      return { ok: true, output: { kind: "not-planned", comment: value.comment } };
    }
    case "map": {
      if (!isText(value.comment)) errors.push("a map needs non-empty comment text");
      if (!isText(value.destination)) errors.push("a map needs non-empty destination text");
      for (const section of ["notes", "notYetSpecified", "outOfScope"] as const) {
        if (typeof value[section] !== "string") errors.push(`a map needs ${section} text, which may be empty`);
      }
      const decisions = readDecisions(value.decisions, errors);
      if (errors.length === 0) checkBlockers(decisions, errors, "decision");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        output: {
          kind: "map",
          comment: value.comment as string,
          destination: value.destination as string,
          notes: value.notes as string,
          notYetSpecified: value.notYetSpecified as string,
          outOfScope: value.outOfScope as string,
          decisions,
        },
      };
    }
    case "prototype": {
      if (!isRoute(value.route)) errors.push("a prototype needs a route, a path starting with /");
      if (!isVariantCount(value.variants)) {
        errors.push(`a prototype needs variants, a whole number from ${PROTOTYPE_MIN_VARIANTS} to ${PROTOTYPE_VARIANT_CAP}`);
      }
      if (!isText(value.brief)) errors.push("a prototype needs non-empty brief text");
      if (!isLine(value.comment)) errors.push("a prototype needs a comment, one non-empty line");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        output: {
          kind: "prototype",
          route: value.route as string,
          variants: value.variants as number,
          brief: value.brief as string,
          comment: value.comment as string,
        },
      };
    }
    case "prototype-round": {
      if (!isText(value.intro)) errors.push("a prototype-round needs non-empty intro text");
      const variants = readVariants(value.variants, errors);
      if (!isText(value.recommendation)) errors.push("a prototype-round needs non-empty recommendation text");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        output: { kind: "prototype-round", intro: value.intro as string, variants, recommendation: value.recommendation as string },
      };
    }
    default:
      return {
        ok: false,
        errors: [
          `kind must be round, brief, spec, split, not-planned, map, prototype or prototype-round, not ${JSON.stringify(value.kind)}`,
        ],
      };
  }
}

/** Parses the text an agent emitted, then checks it. */
export function parseDesignTurnOutput(text: string): DesignTurnOutputResult {
  const json = jsonOf(text);
  return json.ok ? readDesignTurnOutput(json.value) : json;
}

/** What a prototype turn ends in: its prototype round's variants. */
export type PrototypeRoundOutput = Extract<DesignTurnOutput, { kind: "prototype-round" }>;

export type PrototypeTurnOutputResult =
  | { readonly ok: true; readonly output: PrototypeRoundOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Checks a prototype turn's already-parsed output (#155) against the
 * contract: the turn was started to build the variants, so it ends only in
 * a prototype-round, and any other kind breaks its contract however well
 * formed. Its kind is named before anything else is checked.
 */
export function readPrototypeTurnOutput(value: unknown): PrototypeTurnOutputResult {
  if (isObject(value) && value.kind !== "prototype-round") return notPrototypeRound(value.kind);
  const result = readDesignTurnOutput(value);
  if (!result.ok) return result;
  return result.output.kind === "prototype-round" ? { ok: true, output: result.output } : notPrototypeRound(result.output.kind);
}

/** Parses the text a prototype turn's agent emitted, then checks it. */
export function parsePrototypeTurnOutput(text: string): PrototypeTurnOutputResult {
  const json = jsonOf(text);
  return json.ok ? readPrototypeTurnOutput(json.value) : json;
}

function notPrototypeRound(kind: unknown): PrototypeTurnOutputResult {
  return { ok: false, errors: [`a prototype turn ends only in a prototype-round, not ${JSON.stringify(kind)}`] };
}

function jsonOf(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly errors: readonly string[] } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, errors: [`Design-session output is not valid JSON: ${(error as Error).message}`] };
  }
}
