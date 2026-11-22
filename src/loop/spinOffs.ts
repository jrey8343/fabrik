// What every Spin-off shares, whichever of the Operator's words asked for it
// (ADR-0039): the issue the Kit opens it as, and the item that names it in
// the comment that says so. A Design session's finish opens its own
// (src/loop/design.ts, #883), and so does the plan that lands a
// Request-changes run (src/loop/implement.ts, #884). Pure, no I/O.
import { NEEDS_TRIAGE } from "./labels.ts";
import type { Linked } from "./linked.ts";
import { type SpinOffSource, spinOffMarker } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { Action, CreatedIssue, FollowedSpec, OpenTicketRef } from "./types.ts";

/** The issue a plan creates for its Spin-off at this place in the list, counted from 0. */
export function spinOffIssue(index: number): CreatedIssue {
  return { created: `spin-off:${index + 1}` };
}

/**
 * Opens one Spin-off as an issue of its own, as the Fabrik App. It enters at
 * Triage: it is opened with `needs-triage`, as a Check's issue is, and no
 * other label, so Triage gives it its category, and its `labeled` event
 * starts the run. Its body opens with the Spin-off marker, which says where
 * it came from, then holds the agent's text, which mentions nobody, then
 * each of `lines` after a blank line. It is no sub-issue, and waits, by
 * native blocked-by edges, on `blockedBy` alone. `follows`, when given, is
 * the Spec whose `Follows` line the adapter ends the body with.
 */
export function openSpinOff(
  issue: CreatedIssue,
  source: SpinOffSource,
  { title, body, lines = [] }: { readonly title: string; readonly body: string; readonly lines?: readonly string[] },
  blockedBy: readonly (CreatedIssue | OpenTicketRef)[],
  follows: FollowedSpec | null = null,
): Action {
  return {
    kind: "create-issue",
    key: issue.created,
    title: withoutMentions(title),
    body: [spinOffMarker(source), withoutMentions(body), ...lines.flatMap((line) => ["", line])].join("\n"),
    labels: [NEEDS_TRIAGE],
    parent: null,
    blockedBy,
    ...(follows === null ? {} : { follows }),
  };
}

/**
 * The item that names one Spin-off in the comment that says the Kit opened
 * it: its number, once the plan has made it or as it is when the issue is
 * there already, its title, and under them `why`, one line saying which of
 * the Operator's words it rests on.
 */
export function spinOffItem(issue: CreatedIssue | number, title: string, why: string): Linked {
  const item = ` ${withoutMentions(title)}\n  ${why}`;
  return typeof issue === "number" ? [`\n- #${issue}${item}`] : ["\n- ", issue, item];
}
