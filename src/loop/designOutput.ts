// The Design-session turn output contract: what a Design-session agent job
// emits and its push job applies. Both sides check it, so a malformed output
// never half-applies. A turn ends in either the next round or a final outcome:
// an agent brief or an Operator brief (small), a Spec and its Tickets
// (large), or, for a Ticket already under a Spec, sibling Tickets under that
// Spec. Any Ticket in an outcome may instead be an Operator step. Or the
// session ends as not planned: the Operator decided the issue won't be built.
// Or it ends by settling a Roll-in: the Operator decided the issue's work is
// to be built on an open agent pull request, and the output carries what to
// build there, which may neither name the session's own issue nor mention
// anyone, so both sides read the contract against the issue's number.
// Or, when the destination is too foggy to design in one session, the issue
// becomes a Map with its first Decisions. Two kinds carry a Prototype (#155)
// and end nothing: an ordinary turn's `prototype`, the request the Operator
// approved, and a prototype turn's `prototype-round`, the variants it built.
import { isRoute } from "../kit/config.ts";
import { isCommentIdList } from "./considered.ts";
import { DECISION_TYPES, type DecisionType } from "./labels.ts";
import { mentionsSomeone } from "./mentions.ts";
import type { AgentBrief } from "./triageOutput.ts";

/**
 * The fewest variants a Prototype builds: with one, there is nothing to
 * choose between. A Kit constant, not Kit config, like the two below.
 */
export const PROTOTYPE_MIN_VARIANTS = 2;

/** How many variants a Prototype builds when the Operator didn't ask for another count, as the `prototype` skill does. */
export const PROTOTYPE_DEFAULT_VARIANTS = 3;

/** The most variants a Prototype builds: past five they stop being different and the Evidence page stops being quick to look through. */
export const PROTOTYPE_VARIANT_CAP = 5;

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
      /**
       * True when the round asks "Chart this as a Map instead?", so a reader of
       * its hidden line doesn't offer the Map twice (#635). Anything but true
       * is no mark, and never fails the turn.
       */
      readonly asksMap?: true;
    }
  | {
      /** The small outcome: the issue is rewritten in place as an agent brief, or as an Operator brief. */
      readonly kind: "brief";
      /** What the session decided, for the closing comment. */
      readonly comment: string;
      readonly brief: DesignAgentBrief | OperatorBrief;
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
      /**
       * The Operator settled a Roll-in: the issue's work is to be built on an
       * open agent pull request, so the issue closes as not planned with what to
       * build there in its closing comment, which Kit code renders from these
       * fields. Only the Operator sends it (ADR-0010).
       */
      readonly kind: "roll-in";
      /** The open agent pull request the work is to be built on. */
      readonly pullRequest: number;
      /** Markdown: what to build, standing alone. It neither names this issue nor mentions anyone. */
      readonly summary: string;
      /** Each one check a test could make; at least one, and under the summary's two refusals. */
      readonly acceptanceCriteria: readonly string[];
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
      /**
       * The letter of the variant the recommendation builds on (#636), kept only
       * when it is one of the variants' letters. Optional: an output with none
       * is read as it always was.
       */
      readonly recommended?: string;
      /**
       * What the agent gave as `recommended`, as JSON, when it isn't one of the
       * variants' letters: refused, which never fails the turn, and left for the
       * landing to note in the run's step summary.
       */
      readonly refusedRecommended?: string;
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

/** What every issue's prototype branch is named under (prototypeBranchFor). loop.yml spells it out too. */
export const PROTOTYPE_BRANCH_PREFIX = "prototype/";

/**
 * The issue's prototype branch, which every prototype turn of its Design
 * sessions builds on and nothing in the Kit merges or deletes.
 */
export function prototypeBranchFor(issue: number): string {
  return `${PROTOTYPE_BRANCH_PREFIX}${issue}`;
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
 * The small outcome's agent brief: Triage's, plus the Stepped-up start a
 * Design session may set or clear as it rewrites the Ticket (ADR-0014). Only
 * a Design session's brief has it: the Fast path never marks a Ticket.
 */
export interface DesignAgentBrief extends AgentBrief {
  /** True adds the mark, false takes it off; absent leaves it as it stands, so a mark the Operator added by hand stays. */
  readonly stepUp?: boolean;
  /**
   * Marks the Ticket for a Kept-branch start (#536): its next Implement run
   * carries on the Kept branch of the PR it came back from. True adds the
   * mark; false or absent takes it off if it's on, the session's decision
   * standing over a mark added by hand while it ran. Only a brief that
   * rewrites the Ticket in place has it: a split's Tickets are new and start
   * from main.
   */
  readonly keptBranch?: boolean;
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
  | (TicketFields & {
      readonly operator?: undefined;
      /** Marks it for a Stepped-up start (ADR-0014): its Implement runs are Step-ups while the mark stays. Absent means false. */
      readonly stepUp?: boolean;
    })
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

/** A number GitHub could give an issue or a pull request: whole, and above zero. */
function isIssueNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function readBrief(value: unknown, errors: string[]): DesignAgentBrief | OperatorBrief | null {
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
  const brief = { summary: value.summary, acceptanceCriteria: value.acceptanceCriteria };
  const marks: { stepUp?: boolean; keptBranch?: boolean } = {};
  for (const mark of ["stepUp", "keptBranch"] as const) {
    if (value[mark] === undefined) continue;
    if (typeof value[mark] !== "boolean") {
      errors.push(`a brief needs ${mark} to be true or false, if it has one`);
      return null;
    }
    marks[mark] = value[mark];
  }
  return { ...brief, ...marks };
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
      if (item.keptBranch !== undefined) {
        // A new Ticket has no Kept branch of its own (#536): only a brief that rewrites a Ticket in place carries one on.
        errors.push(`ticket ${JSON.stringify(item.key)} has keptBranch, but only a brief that rewrites the Ticket in place carries on a Kept branch`);
      } else if (item.stepUp !== undefined && typeof item.stepUp !== "boolean") {
        errors.push(`ticket ${JSON.stringify(item.key)} needs stepUp to be true or false, if it has one`);
      } else if (item.steps === undefined) tickets.push(item.stepUp === true ? { ...fields, stepUp: true } : fields);
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

/**
 * A prototype-round's advised variant: its letter when `recommended` is one
 * of the variants', exactly; what the agent gave, as JSON, when it is
 * anything else, so the landing can say what it refused; nothing when the
 * output names none.
 */
function advisedOf(
  { recommended }: Record<string, unknown>,
  variants: readonly PrototypeVariant[],
): { recommended: string } | { refusedRecommended: string } | Record<string, never> {
  if (recommended === undefined) return {};
  if (typeof recommended === "string" && variants.some(({ letter }) => letter === recommended)) return { recommended };
  return { refusedRecommended: JSON.stringify(recommended) };
}

/** A path from the repo root, on one line: never an absolute path on the runner. */
function isRepoPath(value: unknown): value is string {
  return isLine(value) && !value.startsWith("/");
}

/**
 * What a `prototype` output asks the prototype turn to build: its route, its
 * variant count and its brief, as the contract checks them, or null with what
 * breaks it pushed onto `errors`. The prototype request's marker, and the Kit
 * job's output that carries it to the prototype job, are read back with the
 * same checks (src/loop/markers.ts).
 */
function readRequest(value: Readonly<Record<string, unknown>>, errors: string[]): PrototypeRequest | null {
  const { route, variants, brief } = value;
  const before = errors.length;
  if (!isRoute(route)) errors.push("a prototype needs a route, a path starting with /");
  if (!isVariantCount(variants)) errors.push(`a prototype needs variants, a whole number from ${PROTOTYPE_MIN_VARIANTS} to ${PROTOTYPE_VARIANT_CAP}`);
  if (!isText(brief)) errors.push("a prototype needs non-empty brief text");
  return errors.length > before ? null : { route: route as string, variants: variants as number, brief: brief as string };
}

/** A prototype request, from JSON already parsed, as a `prototype` output's contract would take it; null when it breaks it. */
export function prototypeRequestOf(value: unknown): PrototypeRequest | null {
  return typeof value === "object" && value !== null ? readRequest(value as Record<string, unknown>, []) : null;
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
export function readDesignTurnOutput(value: unknown, issue: number): DesignTurnOutputResult {
  return withConsidered(readTurn(value, issue), value);
}

/** A read output with the Operator comments it weighed, when it gave a list of ids. */
function withConsidered(result: DesignTurnOutputResult, value: unknown): DesignTurnOutputResult {
  if (!result.ok || !isObject(value) || !isCommentIdList(value.operatorCommentsConsidered)) return result;
  return { ok: true, output: { ...result.output, operatorCommentsConsidered: value.operatorCommentsConsidered } };
}

function readTurn(value: unknown, issue: number | null): DesignTurnOutputResult {
  if (!isObject(value)) return { ok: false, errors: ["Design-session output must be a JSON object"] };
  const errors: string[] = [];
  switch (value.kind) {
    case "round": {
      if (!isText(value.intro)) errors.push("a round needs non-empty intro text");
      const questions = readQuestions(value.questions, errors);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "round", intro: value.intro as string, questions, ...(value.asksMap === true ? { asksMap: true } : {}) } };
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
    case "roll-in": {
      const { pullRequest, summary, acceptanceCriteria } = value;
      if (!isIssueNumber(pullRequest)) errors.push("a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero");
      // As an agent brief's, with the fields beside `kind`.
      if (!isText(summary) || !isSteps(acceptanceCriteria)) {
        errors.push("a roll-in needs a summary and at least one acceptance criterion, with no empty criterion");
      }
      if (errors.length > 0) return { ok: false, errors };
      const text = { summary: summary as string, acceptanceCriteria: acceptanceCriteria as string[] };
      refuseRollInText(text, issue, errors);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "roll-in", pullRequest: pullRequest as number, ...text } };
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
      const request = readRequest(value, errors);
      if (!isLine(value.comment)) errors.push("a prototype needs a comment, one non-empty line");
      if (request === null || errors.length > 0) return { ok: false, errors };
      return { ok: true, output: { kind: "prototype", ...request, comment: value.comment as string } };
    }
    case "prototype-round": {
      if (!isText(value.intro)) errors.push("a prototype-round needs non-empty intro text");
      const variants = readVariants(value.variants, errors);
      if (!isText(value.recommendation)) errors.push("a prototype-round needs non-empty recommendation text");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        output: {
          kind: "prototype-round",
          intro: value.intro as string,
          variants,
          recommendation: value.recommendation as string,
          ...advisedOf(value, variants),
        },
      };
    }
    default:
      return {
        ok: false,
        errors: [
          `kind must be round, brief, spec, split, not-planned, roll-in, map, prototype or prototype-round, not ${JSON.stringify(value.kind)}`,
        ],
      };
  }
}

/**
 * The two refusals of a Roll-in's text, each pushed onto `errors` with where
 * it is: the summary or a criterion that names the session's own issue, which
 * the Implementer and the Reviewer it is written for are never given, or that
 * mentions someone, by the Kit's one test for a mention (mentionsSomeone),
 * since the Operator sends the text as their own. Nothing is stripped, and
 * nothing checks the text's length.
 */
function refuseRollInText(
  { summary, acceptanceCriteria }: { readonly summary: string; readonly acceptanceCriteria: readonly string[] },
  issue: number | null,
  errors: string[],
): void {
  const parts = [["summary", summary] as const, ...acceptanceCriteria.map((criterion, i) => [`acceptance criterion ${i + 1}`, criterion] as const)];
  for (const [where, text] of parts) {
    if (issue !== null && namesOwnIssue(text, issue)) {
      errors.push(
        `a roll-in's ${where} names this issue, #${issue}, by its number or its link: the Implementer and the Reviewer are never given the issue, so the text has to stand alone`,
      );
    }
    if (mentionsSomeone(text)) {
      errors.push(
        `a roll-in's ${where} mentions someone, which would notify them when the Operator sends it: write a name that begins with @ as inline code of its own`,
      );
    }
  }
}

/**
 * Whether the text names the issue: its number after a `#`, and not as part
 * of a longer number, or a link to it. The contract isn't told which repo the
 * turn is in, so a link to an issue of that number in any repo on GitHub
 * names it.
 */
function namesOwnIssue(text: string, issue: number): boolean {
  const byNumber = new RegExp(`(?<![\\w/])#${issue}(?!\\d)`);
  const byLink = new RegExp(`https://github\\.com/[^/\\s]+/[^/\\s]+/issues/${issue}(?!\\d)`, "i");
  return byNumber.test(text) || byLink.test(text);
}

/** Parses the text an agent emitted, then checks it. */
export function parseDesignTurnOutput(text: string, issue: number): DesignTurnOutputResult {
  const json = jsonOf(text);
  return json.ok ? readDesignTurnOutput(json.value, issue) : json;
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
  // Only a prototype-round is read from here on, and no rule of its asks which issue the turn is on.
  const result = withConsidered(readTurn(value, null), value);
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
