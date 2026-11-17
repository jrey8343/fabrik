// The Verdict contract: the Reviewer's reply starts with exactly one Verdict
// line, then its findings, each top-level item of which may open with a tag
// (#749), then on a pass any Follow-ups, and may end with a
// line naming the Operator comments it weighed. Each Verdict the Fabrik App
// posts carries a marker (src/loop/markers.ts), so a PR's review history can
// be read back from its comments alone. Pure.
import type { Verdict, VerdictTags } from "./types.ts";

export const VERDICTS: readonly Verdict[] = ["pass", "execution-flaw", "design-flaw"];

/** Work that deserves its own issue but lies outside the Ticket's scope (GLOSSARY.md). */
export interface FollowUp {
  readonly title: string;
  /** Markdown. */
  readonly body: string;
}

/**
 * The tag a Reviewer's finding may open with (#749), as `[small: body]`,
 * `[small: comment]` or `[missed earlier]`. The Kit reads the tags and checks
 * nothing in code.
 */
export type FindingTag = "small-body" | "small-comment" | "missed-earlier";

/** How each tag is spelled at the start of a finding. */
export const FINDING_TAG_TEXT: Readonly<Record<FindingTag, string>> = {
  "small-body": "[small: body]",
  "small-comment": "[small: comment]",
  "missed-earlier": "[missed earlier]",
};

export type ParsedVerdict =
  | {
      readonly ok: true;
      readonly verdict: Verdict;
      readonly findings: string;
      /**
       * The tag of each top-level `- ` item in the findings, in order, null for
       * one with none (#749). Prose outside the items has none, and is left
       * out. Read whatever the Verdict; only a Reviewer's Execution flaw's count.
       */
      readonly findingTags: readonly (FindingTag | null)[];
      /** The work a pass names for issues of its own, outside the Ticket's scope. Always empty unless the Verdict is a pass. */
      readonly followUps: readonly FollowUp[];
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
  const { findings: rest, considered } = consideredLine(newline === -1 ? "" : text.slice(newline + 1).trim());
  const { findings, followUps } = followUpsBlock(rest, verdict);
  return { ok: true, verdict, findings, findingTags: findingTagsIn(findings), followUps, considered };
}

/**
 * The tag each top-level item in these findings opens with, null for none.
 * An item is a line starting `- ` at the margin; its indented lines and any
 * prose around it aren't items, nor is a line inside a code block, such as a
 * quoted diff's removed line.
 */
function findingTagsIn(findings: string): (FindingTag | null)[] {
  const tags: (FindingTag | null)[] = [];
  let fenced = false;
  for (const line of findings.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith("- ")) tags.push(tagOf(line.slice(2).trimStart()));
  }
  return tags;
}

function tagOf(item: string): FindingTag | null {
  return (Object.keys(FINDING_TAG_TEXT) as FindingTag[]).find((tag) => item.startsWith(FINDING_TAG_TEXT[tag])) ?? null;
}

/**
 * A Reviewer's Verdict's findings counted by tag (#749): null unless it is an
 * Execution flaw, as a pass and a Design flaw carry no tags whatever their
 * text says. On a Full Review, which has no settled code for a finding to
 * have been missed in, `[missed earlier]` counts as untagged.
 */
export function verdictTagsOf(
  { verdict, findingTags }: { readonly verdict: Verdict; readonly findingTags: readonly (FindingTag | null)[] },
  fullReview: boolean,
): VerdictTags | null {
  if (verdict !== "execution-flaw") return null;
  const count = (tag: FindingTag) => findingTags.filter((each) => each === tag).length;
  const smallBody = count("small-body");
  const small = smallBody + count("small-comment");
  const missedEarlier = fullReview ? 0 : count("missed-earlier");
  return { small, missedEarlier, counted: findingTags.length - small - missedEarlier, smallBody };
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

/** How the Reviewer's reply opens its Follow-ups: a line of its own, after the findings. */
export const FOLLOW_UPS_PREFIX = "follow-ups:";

/**
 * Splits a Follow-ups block off the findings: a `follow-ups:` line, then one
 * `- <title>` item per Follow-up with its body indented beneath it. The block
 * ends at the first line that is neither. A Verdict that isn't a pass drops
 * the block and keeps the rest. On a pass, a malformed block, or findings
 * after it, stays in the findings as plain text, and the Verdict still lands.
 */
function followUpsBlock(rest: string, verdict: Verdict): { findings: string; followUps: FollowUp[] } {
  const lines = rest.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines.findLastIndex((line) => line.trimEnd() === FOLLOW_UPS_PREFIX);
  if (start === -1) return { findings: rest, followUps: [] };
  const after = lines.slice(start + 1);
  const length = after.findIndex((line) => !/^(- |\s|$)/.test(line));
  const block = length === -1 ? after : after.slice(0, length);
  const findings = [lines.slice(0, start), length === -1 ? [] : after.slice(length)]
    .map((part) => part.join("\n").trim())
    .filter((part) => part !== "")
    .join("\n\n");
  if (verdict !== "pass") return { findings, followUps: [] };
  const followUps = length === -1 ? followUpItems(block) : null;
  return followUps === null ? { findings: rest, followUps: [] } : { findings, followUps };
}

/** The items under a `follow-ups:` line, each line an item's title, part of its body, or blank; null if they don't make one. */
function followUpItems(lines: readonly string[]): FollowUp[] | null {
  const items: { title: string; body: string[] }[] = [];
  for (const line of lines) {
    const title = /^- (.*)$/.exec(line)?.[1]?.trim();
    if (title === "") return null;
    if (title !== undefined) items.push({ title, body: [] });
    else if (items.length > 0) items.at(-1)?.body.push(line);
    else if (line.trim() !== "") return null;
  }
  if (items.length === 0) return null;
  return items.map(({ title, body }) => ({ title, body: dedent(body) }));
}

/** Body lines with their common indent taken off and blank lines trimmed from both ends. */
function dedent(lines: readonly string[]): string {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const indent = Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(indent, line.length)).trimEnd()).join("\n").trim();
}
