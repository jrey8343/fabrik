// The held line (#471): with rotation on, a run held while every listed
// Subscription is used up is named quietly on its own issue or PR, as well as
// on the weekly-limit issue whose held marker is the record (src/loop/heldRun.ts).
// The line mentions nobody, and is edited in place when its hold ends: resumed,
// or dropped. One line per hold, so a run resumed and held again gets a new one.
// Nothing reads it as input: the snapshot and the agents' inputs leave it out
// (src/github/heldLines.ts), and the resume and drop rules read the held markers
// alone, so deleting or editing it by hand changes nothing. Its marker is its
// own, never HELD_MARKER, so no reader of held markers takes it for one. Pure, no I/O.
import { heldLineIssue, type HoldableRun, roleOf, runNamed } from "./heldRun.ts";
import { readable } from "./readable.ts";
import { MAX_RETRIES } from "./retry.ts";
import type { Action, AgentRole, CreatedIssue } from "./types.ts";

/** How a held line opens, while its run is held and once its hold ended alike. */
export const HELD_LINE_MARKER = "<!-- fabrik:on-hold";

/** The first line of a held line still waiting on its hold. */
function openMarker(role: AgentRole): string {
  return `${HELD_LINE_MARKER} ${JSON.stringify({ role })} -->`;
}

/** The first line of a held line whose hold ended. */
function endedMarker(role: AgentRole): string {
  return `${HELD_LINE_MARKER}-ended ${JSON.stringify({ role })} -->`;
}

/** Whether a comment is a held line, waiting or ended: what every reader of an item's comments leaves out. */
export function isHeldLine(body: string): boolean {
  return body.trimStart().startsWith(HELD_LINE_MARKER);
}

/** The role a held line still waiting on its hold is for, or null for an ended one and any other comment. */
export function waitingHeldLineRole(body: string): AgentRole | null {
  const first = body.trimStart().split("\n", 1)[0] ?? "";
  const prefix = `${HELD_LINE_MARKER} `;
  if (!first.startsWith(prefix) || !first.endsWith("-->")) return null;
  try {
    const value: unknown = JSON.parse(first.slice(prefix.length, -"-->".length));
    if (typeof value !== "object" || value === null) return null;
    return roleOf((value as Record<string, unknown>)["role"]);
  } catch {
    return null;
  }
}

/** What a held run was going to be, beyond its role, so its line names it as the Kit's other notes do. */
export interface HeldRunKind {
  /** A Retry's number. */
  readonly retry?: number;
  readonly requestChanges?: unknown;
  readonly conflict?: unknown;
  readonly prototype?: unknown;
}

/** The run a held line names, as in "The Implement run (Retry 1 of 2)". */
export function heldRunName(role: AgentRole, kind: HeldRunKind = {}): string {
  if (kind.prototype !== undefined && kind.prototype !== false) return "The prototype turn";
  if (kind.conflict !== undefined) return "The conflict-only run";
  if (kind.requestChanges !== undefined) return "The Request-changes run";
  if (kind.retry !== undefined) return `The ${runNamed(role)} (Retry ${kind.retry} of ${MAX_RETRIES})`;
  return `The ${runNamed(role)}`;
}

/** When the carrier a run is held on frees it: at `until` if known, for a weekly-limit issue; `reset` false for one with none (#470). */
export interface HeldUntil {
  readonly until: string | null;
  readonly reset: boolean;
}

/**
 * The quiet line a held run puts on its own issue or PR, its agent PR for an
 * Implement run on one (heldLineIssue): the run, the carrier it's held on,
 * until when, and that the Kit restarts it by itself. A weekly-limit issue
 * with no reset known is freed by the Operator's close once runs work (#440);
 * a usage-credits or token-rotation issue by a close of any issue blocking a
 * Subscription (#470). `on` is an existing issue, or one the Plan opens.
 */
export function heldLineOn(held: HoldableRun, name: string, on: number | CreatedIssue, { until, reset }: HeldUntil): Action {
  const issue = typeof on === "number" ? `#${on}` : on;
  const opening = `${openMarker(held.role)}\n${name} is held on `;
  const restarts = "The Kit restarts the run by itself then, so there's nothing to do.";
  const body: (string | CreatedIssue)[] = !reset
    ? [
        opening,
        issue,
        ": every Subscription is used up, so it waits until one is free again. Closing ",
        issue,
        `, or another issue blocking a Subscription, once it's dealt with frees one. ${restarts}`,
      ]
    : until === null
      ? [
          opening,
          issue,
          ": every Subscription is used up, and the Kit doesn't know when the first limit resets, so it waits until a Subscription is free again. Closing ",
          issue,
          ` once agent runs work again frees one. ${restarts}`,
        ]
      : [opening, issue, `: every Subscription is used up until ${readable(until)}, when the first weekly limit resets. ${restarts}`];
  const item = heldLineIssue(held);
  if (body.every((part) => typeof part === "string")) return { kind: "comment", issue: item, body: body.join("") };
  return { kind: "comment-linking", issue: item, body };
}

/** How a hold ended. */
export type HoldEnded = { readonly kind: "resumed" } | { readonly kind: "dropped"; readonly reason: string };

/** A held line as it reads once its hold ended, at `at`: resumed, or dropped and why. */
export function endedHeldLine(role: AgentRole, on: number, ended: HoldEnded, at: string): string {
  const how = ended.kind === "resumed" ? `resumed ${readable(at)}` : `dropped: ${ended.reason}`;
  return [endedMarker(role), `Was held on #${on} · ${how}`].join("\n");
}
