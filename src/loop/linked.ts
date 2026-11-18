// Markdown that links an issue the plan files before it is posted (#781), as
// a `comment-linking` body holds it: text, and each created issue where its
// `#number` goes. A Verdict that links its Unrelated failures' new issues is
// built this way, and posted as a plain comment when it links none. Pure.
import type { Action, CreatedIssue } from "./types.ts";

/** Text, and each issue the plan files where its `#number` goes. */
export type Linked = readonly (string | CreatedIssue)[];

/** The room a created issue's `#number` is given when linked text is measured: `#` and up to nine digits. */
const ISSUE_NUMBER_ROOM = 10;

/** How long linked text is once posted, at most. */
export function linkedLength(text: Linked): number {
  return text.reduce((length, part) => length + (typeof part === "string" ? part.length : ISSUE_NUMBER_ROOM), 0);
}

/** `texts` joined by `separator`, as String.join does. */
export function joinLinked(texts: readonly Linked[], separator: string): Linked {
  return texts.flatMap((text, at) => (at === 0 ? text : [separator, ...text]));
}

/** The text with no issue in it, or null when it links one. */
function plainOf(text: Linked): string | null {
  return text.every((part) => typeof part === "string") ? text.join("") : null;
}

/** A comment on `issue` posting `body`: a plain one when it links no issue the plan files, else one that links them. */
export function linkedComment(issue: number, body: Linked, key?: string): Action {
  const plain = plainOf(body);
  const keyed = key === undefined ? {} : { key };
  if (plain !== null) return { kind: "comment", issue, body: plain, ...keyed };
  // Adjacent text joined, so the adapter writes each part once.
  const parts = body.reduce<(string | CreatedIssue)[]>((merged, part) => {
    const last = merged.at(-1);
    if (typeof part === "string" && typeof last === "string") merged[merged.length - 1] = last + part;
    else merged.push(part);
    return merged;
  }, []);
  return { kind: "comment-linking", issue, body: parts, ...keyed };
}
