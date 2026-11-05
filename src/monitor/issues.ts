// Monitor issues (#148), as both parts of the Monitor core read and change
// them: production errors' (./core.ts) and red main's (./redMain.ts). What the
// core reads of each issue, the plan it makes for them, which of the Fabrik
// App's issues is the newest for a marker, the block of lines the Monitor keeps
// current in a body (an error issue's stats, red main's details), and how a
// body quotes untrusted text. Pure, no I/O.
import type { Label } from "../loop/labels.ts";
import { monitorMarkerIn } from "../loop/markers.ts";

/** An issue carrying fabrik:monitor, as the Monitor reads it. */
export interface MonitorIssue {
  readonly number: number;
  readonly open: boolean;
  /** GitHub's state reason: `completed`, `not_planned`, `duplicate` or `reopened`; null when it gives none. */
  readonly stateReason: string | null;
  /** ISO 8601, or null while it's open. */
  readonly closedAt: string | null;
  readonly labels: readonly string[];
  /** Whether the Fabrik App opened it. */
  readonly byApp: boolean;
  readonly body: string;
  /**
   * Whether its last close was the Monitor's own, right after its green-at
   * note, rather than the Operator's or the Loop's; false while it's open. The
   * program reads it for the newest red-main issue alone, so it's false on any other.
   */
  readonly closedByMonitor: boolean;
}

/** What the Monitor does this tick. */
export interface MonitorPlan {
  /** Issues to file in the Product repo, in this order, so the last is the newest. */
  readonly open: readonly IssueToOpen[];
  /** Monitor issues whose body is rewritten in place. */
  readonly rewrite: readonly BodyRewrite[];
  /** Issues to close as completed, each with its note: only ever red main's. */
  readonly close: readonly IssueToClose[];
  /** The step summary's lines, the quiet setup notes among them. */
  readonly summary: readonly string[];
}

export interface IssueToOpen {
  /** The Sentry group it's filed for, whose latest event the body shows once read; null for red main's. */
  readonly sentryGroup: string | null;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly Label[];
}

/** A Monitor issue's body rewritten in place, with the step summary's line saying what changed. */
export type BodyRewrite =
  /**
   * The stats in the block of a qualifying group's open issue refreshed, any
   * held line going in or out with them: the release is the one the group's
   * latest event names once read.
   */
  | (RewriteOf<"stats"> & { readonly sentryGroup: string })
  /** Only the held line put in or taken out of an open error issue's stats block, refreshing no group's stats. */
  | RewriteOf<"held-line">
  /** The details of the open red-main issue brought up to date with the default branch's red commit. */
  | RewriteOf<"red-main">;

interface RewriteOf<Kind extends string> {
  readonly kind: Kind;
  readonly issue: number;
  readonly body: string;
  /** The step summary's line for it, once it's applied. */
  readonly summary: string;
}

export interface IssueToClose {
  readonly issue: number;
  readonly comment: string;
}

/**
 * For each marker line, the newest issue the Fabrik App opened carrying it:
 * the one with the highest number, as GitHub numbers issues in the order
 * they're opened. A marker in anyone else's issue counts for nothing, so
 * quoting one can't silence an error.
 */
export function newestByMarker(issues: readonly MonitorIssue[]): Map<string, MonitorIssue> {
  const newest = new Map<string, MonitorIssue>();
  for (const issue of issues) {
    const marker = issue.byApp ? monitorMarkerIn(issue.body) : null;
    if (marker === null) continue;
    const seen = newest.get(marker);
    if (seen === undefined || issue.number > seen.number) newest.set(marker, issue);
  }
  return newest;
}

// The Monitor block: hidden opening and closing markers, each on a line of its
// own, around the lines the Monitor keeps current in its issue's body, an error
// issue's stats or red main's details. The Monitor only ever rewrites the lines
// between them, so whatever else the Operator or Triage writes in the body
// stays theirs. Its markers say "stats" for the block error issues had first.

const BLOCK_OPEN = "<!-- fabrik:monitor-stats -->";
const BLOCK_CLOSE = "<!-- /fabrik:monitor-stats -->";

/**
 * A body's Monitor block: its opening marker line and line break, the lines
 * inside, then its closing marker line. No line inside is an opening marker,
 * so an error title Sentry gave that reads as one, quoted above the block,
 * can't stretch the block over the body.
 */
const BLOCK = /^(<!-- fabrik:monitor-stats -->(\r?\n))((?:(?!<!-- fabrik:monitor-stats -->$).*\r?\n)*?)<!-- \/fabrik:monitor-stats -->$/m;

/** These lines inside a Monitor block, for a new issue's body. */
export function monitorBlock(lines: readonly string[]): string[] {
  return [BLOCK_OPEN, ...lines, BLOCK_CLOSE];
}

/** The lines inside the body's Monitor block, or null when it has none. */
export function monitorBlockIn(body: string): string[] | null {
  const inside = BLOCK.exec(body)?.[3];
  return inside === undefined ? null : inside.split(/\r?\n/).slice(0, -1);
}

/**
 * The issue's body with these lines in its Monitor block in place of the ones
 * there, every other character as it was, line endings included; or null when
 * they're there already, or its body has no block (someone edited it out),
 * which leaves it alone.
 */
export function withMonitorBlock(issue: MonitorIssue, lines: readonly string[]): string | null {
  const block = BLOCK.exec(issue.body);
  if (block === null) return null;
  const [, opening = "", newline = "\n", inside = ""] = block;
  const start = block.index + opening.length;
  const body = `${issue.body.slice(0, start)}${lines.map((line) => `${line}${newline}`).join("")}${issue.body.slice(start + inside.length)}`;
  return body === issue.body ? null : body;
}

// Quoting untrusted text in a body, so it can't render as Markdown, mention
// anyone, or pass for a marker.

/** Text quoted in a body as a code span: one line, truncated, fenced by more backticks than it holds. */
export function bodyCode(text: string, max: number): string {
  const quoted = truncated(oneLine(text), max);
  const fence = "`".repeat(longestBacktickRun(quoted) + 1);
  const pad = quoted.startsWith("`") || quoted.endsWith("`") ? " " : "";
  return `${fence}${pad}${quoted}${pad}${fence}`;
}

/** A fenced code block whose fence is longer than any backtick run in `content`, so it can't close it. */
export function fenced(content: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}\n${content}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** The text with every run of whitespace, line breaks included, as one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncated(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Orders numbers or strings from lowest to highest. */
export function ascending<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
