// The lines a Design session's rewrite carries forward from the issue's old
// body. Each one marks the issue for something that reads it later, so a
// rewrite that dropped it would lose what it records. A line quoted as code,
// such as a Monitor issue's Sentry error title, is data and never carried.
import { ESCAPE_MARKER_LINE, FROM_AUDIT_LINE, FROM_RETRO_LINE, linesOutsideCode } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";

/** Every line carried forward, matched against the line with its outer whitespace trimmed. */
const CARRIED_LINES: readonly RegExp[] = [
  // The Audit the candidate was filed from, so the next Audit skips it (#150).
  FROM_AUDIT_LINE,
  // The Architectural escape it records, so it still counts (#150).
  ESCAPE_MARKER_LINE,
  // The Retro the proposal was filed from, so the next Retro skips it (#151).
  FROM_RETRO_LINE,
];

/**
 * `rewritten`, ended with the lines of `old` that are carried forward, in
 * the order `old` has them, leaving out any inside a fenced code block
 * (src/loop/markers.ts's linesOutsideCode); exactly `rewritten` when `old`
 * has none.
 */
export function withCarriedLines(rewritten: string, old: string): string {
  const carried = linesOutsideCode(old)
    .map((line) => line.trim())
    .filter((line) => CARRIED_LINES.some((pattern) => pattern.test(line)));
  return carried.length === 0 ? rewritten : [rewritten, "", ...carried.map(withoutMentions)].join("\n");
}
