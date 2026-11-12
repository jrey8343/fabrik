// A Round's fields as data (#635): one hidden, versioned line of JSON that
// Kit code writes beside the Round's comment, from the same fields it renders
// the comment from, so a reader never parses the Markdown. It sits directly
// under the Round's marker, as the comment's second line: the first line is
// read by position for the round count, and a turn may end its Round with the
// Operator comments it weighed, so the line is neither first nor last.
//
// This module imports no package and nothing that runs an agent or a job: the
// read library hands its reader and its type to readers outside the Kit.
import { DESIGN_ROUND_MARKER, markerJson } from "./markers.ts";

/** The version of the line this release writes and the only one its reader knows. */
export const ROUND_LINE_VERSION = 1;

/** GitHub's limit for a comment, in characters: a Round that would pass it with its line is posted without one. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** A Round's fields, as its hidden line holds them. */
export type RoundLine = {
  readonly v: typeof ROUND_LINE_VERSION;
  /** Its number in the session. */
  readonly round: number;
  /** The lead-in, as Markdown. */
  readonly intro: string;
  /** In order: a question's number is its place. */
  readonly questions: readonly { readonly question: string; readonly recommendation: string }[];
} & {
  readonly kind: "round";
  /**
   * On round 1 of a Ticket sent back: the pull request it came back from, and
   * its Verdict's address when a Verdict sent it back, null when the Operator did.
   */
  readonly sentBack?: { readonly pullRequest: number; readonly verdict: string | null };
};

const ROUND_LINE = /^<!-- fabrik:round-line (.*) -->$/;

/**
 * The hidden line that holds a Round's fields, as the Kit's markers that
 * carry text are written: one line whose JSON spells `<`, `>` and `@` as
 * escapes, so no field can end the HTML comment early or mention anyone.
 */
export function roundLineOf(line: RoundLine): string {
  const { v, kind, round, intro, questions, sentBack } = line;
  return `<!-- fabrik:round-line ${markerJson({
    v,
    kind,
    round,
    intro,
    questions: questions.map(({ question, recommendation }) => ({ question, recommendation })),
    ...(sentBack === undefined ? {} : { sentBack: { pullRequest: sentBack.pullRequest, verdict: sentBack.verdict } }),
  })} -->`;
}

/**
 * The fields a Round's comment carries in its hidden line, or null when it
 * carries none this reader can take. Pass it only the Fabrik App's comments.
 */
export function roundLineIn(body: string): RoundLine | null {
  const lines = body.split("\n");
  const at = roundLineAt(lines);
  if (at === null) return null;
  const json = ROUND_LINE.exec(lines[at] ?? "")?.[1];
  if (json === undefined) return null;
  const value = JSON.parse(json) as RoundLine;
  return value;
}

/**
 * A comment's text with its Round's hidden line taken out, as the Kit hands
 * an issue's thread to an agent: every other text, and a Round from an
 * earlier release, as it is.
 */
export function withoutRoundLines(text: string): string {
  const lines = text.split("\n");
  const at = roundLineAt(lines);
  return at === null ? text : [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
}

/** Where a comment's lines hold its Round's hidden line: directly under the Round's marker, or null when they hold none there. */
function roundLineAt(lines: readonly string[]): number | null {
  if (!DESIGN_ROUND_MARKER.test(lines[0] ?? "")) return null;
  return ROUND_LINE.test(lines[1] ?? "") ? 1 : null;
}
