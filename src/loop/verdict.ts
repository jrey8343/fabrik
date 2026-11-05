// The Verdict contract: the Reviewer's reply starts with exactly one Verdict
// line, then its findings, and may end with a line naming the Operator
// comments it weighed. Each Verdict the Fabrik App posts carries a marker
// (src/loop/markers.ts), so a PR's review history can be read back from its
// comments alone. Pure.
import type { Verdict } from "./types.ts";

export const VERDICTS: readonly Verdict[] = ["pass", "execution-flaw", "design-flaw"];

export type ParsedVerdict =
  | {
      readonly ok: true;
      readonly verdict: Verdict;
      readonly findings: string;
      /** The ids of the Operator comments the Reviewer says it weighed, unchecked (src/loop/considered.ts). */
      readonly considered: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Reads a Reviewer's reply strictly: its first line must be exactly
 * `verdict: pass`, `verdict: execution-flaw` or `verdict: design-flaw`.
 * Anything else, an empty reply included, is no Verdict, never a pass.
 */
export function parseVerdict(text: string): ParsedVerdict {
  if (text.trim() === "") return { ok: false, error: "The Reviewer's reply is empty" };
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, "");
  const match = /^verdict: (.+)$/.exec(first);
  const verdict = VERDICTS.find((candidate) => candidate === match?.[1]);
  if (verdict === undefined) {
    return {
      ok: false,
      error: `The Reviewer's reply doesn't start with a Verdict line (${VERDICTS.map((v) => `verdict: ${v}`).join(", ")}): ${JSON.stringify(first.slice(0, 80))}`,
    };
  }
  const { findings, considered } = consideredLine(newline === -1 ? "" : text.slice(newline + 1).trim());
  return { ok: true, verdict, findings, considered };
}

/** How the Reviewer's reply names the Operator comments it weighed: its last line, ids comma-separated. */
export const CONSIDERED_PREFIX = "operator comments considered:";

/** Splits a last line naming the weighed Operator comments off the findings. */
function consideredLine(rest: string): { findings: string; considered: string[] } {
  const newline = rest.lastIndexOf("\n");
  const last = rest.slice(newline + 1).trim();
  if (!last.startsWith(CONSIDERED_PREFIX)) return { findings: rest, considered: [] };
  const considered = last
    .slice(CONSIDERED_PREFIX.length)
    .split(",")
    .map((id) => id.trim().replace(/^`(.*)`$/, "$1"))
    .filter((id) => id !== "");
  return { findings: newline === -1 ? "" : rest.slice(0, newline).trim(), considered };
}
