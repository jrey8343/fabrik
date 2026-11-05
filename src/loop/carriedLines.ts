// The lines a Design session's rewrite carries forward from the issue's old
// body. Each one marks the issue for something that reads it later, so a
// rewrite that dropped it would lose what it records.
import { withoutMentions } from "./mentions.ts";

/** Every line carried forward, matched against the line with its outer whitespace trimmed. */
const CARRIED_LINES: readonly RegExp[] = [
  // The Audit the candidate was filed from, so the next Audit skips it (#150).
  /^From audit #[1-9][0-9]*$/,
  // The Architectural escape it records, so it still counts (#150).
  /^<!-- fabrik:escape\s.*-->$/,
];

/**
 * `rewritten`, ended with the lines of `old` that are carried forward, in
 * the order `old` has them; exactly `rewritten` when `old` has none.
 */
export function withCarriedLines(rewritten: string, old: string): string {
  const carried = old
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CARRIED_LINES.some((pattern) => pattern.test(line)));
  return carried.length === 0 ? rewritten : [rewritten, "", ...carried.map(withoutMentions)].join("\n");
}
