// The Verdict contract: the Reviewer's reply starts with exactly one Verdict
// line, then its findings. Each Verdict the Fabrik App posts carries a marker,
// so a PR's review history can be read back from its comments alone. Pure.
import type { Verdict, VerdictRecord } from "./types.ts";

export const VERDICTS: readonly Verdict[] = ["pass", "execution-flaw", "design-flaw"];

export type ParsedVerdict =
  | { readonly ok: true; readonly verdict: Verdict; readonly findings: string }
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
  return { ok: true, verdict, findings: newline === -1 ? "" : text.slice(newline + 1).trim() };
}

const MARKER = /^<!-- fabrik:verdict (\{.*?\}) -->/;

/** The machine-readable first line of a Verdict comment. */
export function verdictMarker(record: VerdictRecord): string {
  const { verdict, source, requestChanges, headSha } = record;
  return `<!-- fabrik:verdict ${JSON.stringify({ verdict, source, requestChanges, headSha })} -->`;
}

/** The Verdicts recorded in these comments, oldest first. Comments without a valid marker are skipped. */
export function verdictsIn(commentBodies: readonly string[]): VerdictRecord[] {
  return commentBodies.flatMap((body) => {
    const record = readMarker(body);
    return record === null ? [] : [record];
  });
}

function readMarker(body: string): VerdictRecord | null {
  const json = MARKER.exec(body)?.[1];
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { verdict, source, requestChanges, headSha } = value as Record<string, unknown>;
  if (!VERDICTS.includes(verdict as Verdict)) return null;
  if (source !== "reviewer" && source !== "ci" && source !== "empty-diff") return null;
  if (typeof requestChanges !== "boolean" || typeof headSha !== "string") return null;
  return { verdict: verdict as Verdict, source, requestChanges, headSha };
}
