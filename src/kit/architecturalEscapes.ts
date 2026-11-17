// Architectural escapes (#737): the escapes filed over each Product repo's
// escape window to a week's end, each counted once however many merged agent
// PRs it names, with the landed Audits and merged agent PRs behind the count
// and the candidates still undecided on open Audits. Pure, no I/O.
import { auditsIn, introducedByIn } from "../loop/audit.ts";
import { fromAuditIn } from "../loop/markers.ts";
import { type ArchitecturalEscape, ESCAPE_WINDOW_MS, escapesIn, mergedAgentPullRequestsIn, type Window, within } from "./retroEvidence.ts";
import type { GitHubFacts, WeeklySummaryInput } from "./weeklySummary.ts";

/**
 * The Architectural escapes over each Product repo's escape window (the 90
 * days to the week's end, starting no earlier than 30 days before the repo's
 * first Audit), summed across repos, with what stands behind the count.
 */
export interface ArchitecturalEscapes {
  /** The escapes filed in the windows, each counted once however many merged agent PRs it names. */
  readonly escapes: number;
  /** The Audits opened in the windows that landed, filled or clean: never a pending or failed one. */
  readonly audits: number;
  /** The agent PRs merged in the windows. */
  readonly merged: number;
  /**
   * On those Audits still open, the candidates whose card traces to a merged
   * agent PR, less the escapes filed from each: never in `escapes`. A closed
   * Audit's unfiled candidates were set aside, and count for nothing. Null for
   * an earlier week than the latest: an Audit's facts say whether it's open
   * now, not when it closed, so they can't say which were open at that week's end.
   */
  readonly undecided: number | null;
}

/** What the escape windows read of the Weekly summary's input. */
type EscapeInput = Pick<WeeklySummaryInput, "records" | "facts" | "operator" | "appLogin">;

/** How long before a repo's first Audit its escape window may start: the work that Audit read. */
const BEFORE_FIRST_AUDIT_MS = 30 * 24 * 60 * 60 * 1000;

/** One Product repo's escape window to a week's end, and what it holds. */
export interface RepoEscapeWindow {
  readonly facts: GitHubFacts;
  readonly escapes: readonly ArchitecturalEscape[];
  /** The Audits the Fabrik App opened in the window that landed, filled or clean. */
  readonly audits: readonly { readonly number: number; readonly open: boolean; readonly body: string }[];
  readonly merged: number;
}

/**
 * Each Product repo's escape window to the week's end: the 90 days slow decay
 * needs to show, starting no earlier than 30 days before the repo's first
 * Audit, so a new repo's count grows into them instead of counting work no
 * Audit read. A repo with no Audit opened by the week's end has an empty one.
 * The first Audit is the oldest the Fabrik App opened whose run didn't fail.
 */
export function escapeWindowsOf(week: Window, input: EscapeInput): RepoEscapeWindow[] {
  return input.facts.map((facts) => {
    const open = new Set(facts.openAudits.map(({ number }) => number));
    const issues = [...new Map([...facts.firstAudits, ...facts.audits].map((issue) => [issue.number, issue])).values()];
    const audits = auditsIn(
      issues.map(({ number, title, author, createdAt, body }) => ({ number, title, open: open.has(number), stateReason: null, createdAt, byApp: author === input.appLogin, body })),
    );
    const first = audits.findLast((audit) => !audit.failed && Date.parse(audit.createdAt) < week.end) ?? null;
    const start = first === null ? week.end : Math.max(week.end - ESCAPE_WINDOW_MS, Date.parse(first.createdAt) - BEFORE_FIRST_AUDIT_MS);
    const window: Window = { start, end: week.end };
    const onRepo = { ...input, facts: [facts] };
    return {
      facts,
      escapes: escapesIn(window, onRepo),
      audits: audits.flatMap((audit) => {
        const landed = audit.commit !== null && !audit.pending && !audit.failed;
        const body = issues.find(({ number }) => number === audit.number)?.body ?? "";
        return landed && within(window, audit.createdAt) ? [{ number: audit.number, open: audit.open, body }] : [];
      }),
      merged: mergedAgentPullRequestsIn(window, onRepo).length,
    };
  });
}

/**
 * The escapes, Audits and merged agent PRs in each repo's escape window,
 * summed, with, for the latest week alone, the candidates still undecided on
 * its open Audits: those whose card traces to a merged agent PR, less the
 * issues the Operator filed from that Audit with an escape marker. One
 * rejected by comment stays undecided until the Audit closes.
 */
export function architecturalEscapesOf(windows: readonly RepoEscapeWindow[], operator: string, { latest }: { readonly latest: boolean }): ArchitecturalEscapes {
  const undecided = windows.flatMap(({ facts, audits }) =>
    audits
      .filter(({ open }) => open)
      .map(({ number, body }) => {
        const traced = introducedByIn(body).filter((pullRequests) => pullRequests.length > 0).length;
        const filed = facts.escapeMarkerIssues.filter((issue) => issue.author === operator && fromAuditIn(issue.body) === number).length;
        return Math.max(0, traced - filed);
      }),
  );
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  return {
    escapes: sum(windows.map(({ escapes }) => escapes.length)),
    audits: sum(windows.map(({ audits }) => audits.length)),
    merged: sum(windows.map(({ merged }) => merged)),
    undecided: latest ? sum(undecided) : null,
  };
}

/**
 * The escapes and what stands behind them, such as `3, from 4 Audits over 68
 * merged agent PRs, 2 candidates undecided`, naming the undecided only when
 * there are some; `no Audits yet` when no repo had an Audit in its window.
 */
export function escapesCell({ escapes, audits, merged, undecided }: ArchitecturalEscapes): string {
  if (audits === 0) return "no Audits yet";
  const behind = `${escapes}, from ${counted(audits, "Audit")} over ${counted(merged, "merged agent PR")}`;
  return undecided === null || undecided === 0 ? behind : `${behind}, ${counted(undecided, "candidate")} undecided`;
}

/** `1 Audit`, or `2 Audits`. */
function counted(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
