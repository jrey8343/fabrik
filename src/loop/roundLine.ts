// A Round's fields as data (#635): one hidden, versioned line of JSON that
// Kit code writes beside the Round's comment, from the same fields it renders
// the comment from, so a reader never parses the Markdown. It sits directly
// under the Round's marker lines: the second line of an ordinary Round, and
// the third of a prototype round or its failure round (#636), under the
// prototype marker. The first lines are read by position (the round count,
// the prototype markers), the preview step finds its lines counting back from
// the end, and a turn may end its Round with the Operator comments it weighed,
// so the line is neither among the first nor last.
//
// This module imports no package and nothing that runs an agent or a job: the
// read library hands its reader and its type to readers outside the Kit.
import { DESIGN_ROUND_MARKER, markerJson, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "./markers.ts";

/** The version of the line this release writes and the only one its reader knows. */
export const ROUND_LINE_VERSION = 1 as const;

/** GitHub's limit for a comment, in characters: a Round that would pass it with its line is posted without one. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** A prototype round's variant, as its line holds it. */
export type RoundLineVariant = {
  /** Its letter, A for the first: what `?variant=` names it by. */
  readonly letter: string;
  /** Its one-line summary, as the round shows it. */
  readonly summary: string;
  /** The address of its component on the prototype branch at the head the push left: the link the round shows. */
  readonly component: string;
  /** The address its preview link in the round opens, once the preview step has linked it; null until then, and for good when there's none. */
  readonly preview: string | null;
};

/** A Round's fields, as its hidden line holds them. */
export type RoundLine = {
  readonly v: typeof ROUND_LINE_VERSION;
  /** Its number in the session. */
  readonly round: number;
  /** The lead-in, as Markdown; on a prototype failure round, what stopped the prototype. */
  readonly intro: string;
  /** In order: a question's number is its place. */
  readonly questions: readonly { readonly question: string; readonly recommendation: string }[];
} & (
  | {
      readonly kind: "round";
      /**
       * On round 1 of a Ticket sent back: the pull request it came back from, and
       * its Verdict's address when a Verdict sent it back, null when the Operator did.
       */
      readonly sentBack?: { readonly pullRequest: number; readonly verdict: string | null };
      /** Set when the Round asks "Chart this as a Map instead?"; the line carries the key only then. */
      readonly asksMap?: true;
    }
  | {
      /** A prototype round: the variants a prototype turn built, and the Kit's one question, "Which variant?". */
      readonly kind: "prototype";
      /** The route the Operator said yes to, from the prototype request. */
      readonly route: string;
      /** The letter of the variant the recommendation builds on, when the turn named one of its variants. */
      readonly recommended?: string;
      /** In letter order. */
      readonly variants: readonly RoundLineVariant[];
      /** The run and the artifact of the prototype's zipped captures, or null when the job kept none. */
      readonly captures: { readonly run: number; readonly artifact: number } | null;
    }
  | {
      /** A prototype failure round: what stopped the prototype, and the Kit's question whether to carry on without one. */
      readonly kind: "prototype-failed";
      /** The answers the Kit offers beside its recommendation. */
      readonly otherAnswers: readonly string[];
    }
);

/** The hidden line, its JSON captured; a comment whose lines come back ending in CRLF still reads, as JSON holds no bare `\r`. */
const ROUND_LINE = /^<!-- fabrik:round-line (.*) -->\r?$/;

/**
 * The hidden line that holds a Round's fields, as the Kit's markers that
 * carry text are written: one line whose JSON spells `<`, `>` and `@` as
 * escapes, so no field can end the HTML comment early or mention anyone.
 */
export function roundLineOf(line: RoundLine): string {
  const { v, kind, round, intro, questions } = line;
  const common = {
    v,
    kind,
    round,
    intro,
    questions: questions.map(({ question, recommendation }) => ({ question, recommendation })),
  };
  return `<!-- fabrik:round-line ${markerJson({ ...common, ...fieldsOf(line) })} -->`;
}

/** The fields of the line's kind, in the order the line writes them. */
function fieldsOf(line: RoundLine): Record<string, unknown> {
  switch (line.kind) {
    case "round": {
      const { sentBack, asksMap } = line;
      return {
        ...(sentBack === undefined ? {} : { sentBack: { pullRequest: sentBack.pullRequest, verdict: sentBack.verdict } }),
        ...(asksMap === true ? { asksMap } : {}),
      };
    }
    case "prototype": {
      const { route, recommended, variants, captures } = line;
      return {
        route,
        ...(recommended === undefined ? {} : { recommended }),
        variants: variants.map(({ letter, summary, component, preview }) => ({ letter, summary, component, preview })),
        captures: captures === null ? null : { run: captures.run, artifact: captures.artifact },
      };
    }
    case "prototype-failed":
      return { otherAnswers: [...line.otherAnswers] };
  }
}

/**
 * The fields a Round's comment carries in its hidden line, or null when it
 * carries none this reader can take. Pass it only the Fabrik App's comments.
 */
export function roundLineIn(body: string): RoundLine | null {
  const lines = body.split("\n");
  const at = roundLineAt(lines);
  if (at === null) return null;
  const json = ROUND_LINE.exec(lines[at.index] ?? "")?.[1];
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const line = roundLineFrom(value);
  // A line of another kind than the Round's markers say isn't this Round's.
  return line?.kind === at.kind ? line : null;
}

/** The fields a parsed line holds, keys this reader doesn't know left out, or null when its version or its shape isn't one this reader takes. */
function roundLineFrom(value: unknown): RoundLine | null {
  if (!isObject(value) || value.v !== ROUND_LINE_VERSION) return null;
  const { round, intro, questions } = value;
  if (!isWholeAboveZero(round) || typeof intro !== "string" || !Array.isArray(questions)) return null;
  const read = questions.map((question: unknown) =>
    isObject(question) && typeof question.question === "string" && typeof question.recommendation === "string"
      ? { question: question.question, recommendation: question.recommendation }
      : null,
  );
  if (read.some((question) => question === null)) return null;
  const common = { v: ROUND_LINE_VERSION, round, intro, questions: read.filter((question) => question !== null) };
  switch (value.kind) {
    case "round": {
      const { sentBack, asksMap } = value;
      if (sentBack !== undefined && !(isObject(sentBack) && isWholeAboveZero(sentBack.pullRequest) && (typeof sentBack.verdict === "string" || sentBack.verdict === null))) return null;
      if (asksMap !== undefined && asksMap !== true) return null;
      return {
        ...common,
        kind: "round",
        ...(isObject(sentBack) ? { sentBack: { pullRequest: sentBack.pullRequest as number, verdict: sentBack.verdict as string | null } } : {}),
        ...(asksMap === true ? { asksMap } : {}),
      };
    }
    case "prototype": {
      const { route, recommended, variants, captures } = value;
      if (typeof route !== "string" || !Array.isArray(variants) || variants.length === 0) return null;
      const readVariants = variants.map(variantFrom);
      if (readVariants.some((variant) => variant === null)) return null;
      const kept = readVariants.filter((variant) => variant !== null);
      if (recommended !== undefined && !(typeof recommended === "string" && kept.some(({ letter }) => letter === recommended))) return null;
      if (captures !== null && !(isObject(captures) && isWholeAboveZero(captures.run) && isWholeAboveZero(captures.artifact))) return null;
      return {
        ...common,
        kind: "prototype",
        route,
        ...(recommended === undefined ? {} : { recommended }),
        variants: kept,
        captures: captures === null ? null : { run: captures.run as number, artifact: captures.artifact as number },
      };
    }
    case "prototype-failed": {
      const { otherAnswers } = value;
      if (!Array.isArray(otherAnswers) || !otherAnswers.every((answer: unknown) => typeof answer === "string")) return null;
      return { ...common, kind: "prototype-failed", otherAnswers: otherAnswers as string[] };
    }
    default:
      return null;
  }
}

function variantFrom(value: unknown): RoundLineVariant | null {
  if (!isObject(value)) return null;
  const { letter, summary, component, preview } = value;
  if (typeof letter !== "string" || typeof summary !== "string" || typeof component !== "string") return null;
  if (typeof preview !== "string" && preview !== null) return null;
  return { letter, summary, component, preview };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeAboveZero(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/**
 * A comment's text with its Round's hidden line taken out, as the Kit hands
 * an issue's thread to an agent: every other text, and a Round from an
 * earlier release, as it is.
 */
export function withoutRoundLines(text: string): string {
  const lines = text.split("\n");
  const at = roundLineAt(lines);
  if (at === null || !ROUND_LINE.test(lines[at.index] ?? "")) return text;
  return [...lines.slice(0, at.index), ...lines.slice(at.index + 1)].join("\n");
}

/**
 * Where a comment's lines would hold its Round's hidden line, and the kind of
 * Round its markers say it is: directly under the Round's marker, or under
 * the prototype marker beneath it. Null when the comment isn't a Round.
 */
function roundLineAt(lines: readonly string[]): { readonly index: number; readonly kind: RoundLine["kind"] } | null {
  if (!DESIGN_ROUND_MARKER.test(lines[0] ?? "")) return null;
  const second = (lines[1] ?? "").replace(/\r$/, "");
  if (second === PROTOTYPE_ROUND_MARKER) return { index: 2, kind: "prototype" };
  if (second === PROTOTYPE_FAILURE_ROUND_MARKER) return { index: 2, kind: "prototype-failed" };
  return { index: 1, kind: "round" };
}
