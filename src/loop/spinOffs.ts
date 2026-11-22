// What every Spin-off shares, whichever of the Operator's words asked for it
// (ADR-0039): the issue the Kit opens it as, and the item that names it in
// the comment that says so. A Design session's finish opens its own
// (src/loop/design.ts, #883), and so does the plan that lands a
// Request-changes run (src/loop/implement.ts, #884). Pure, no I/O.
import type { Linked } from "./linked.ts";
import { type SpinOffSource, spinOffMarker } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import { type OpenedAtTriage, openAtTriage } from "./openedAtTriage.ts";
import type { Action, CreatedIssue, FollowedSpec, OpenTicketRef } from "./types.ts";

/** The issue a plan creates for its Spin-off at this place in the list, counted from 0. */
export function spinOffIssue(index: number): CreatedIssue {
  return { created: `spin-off:${index + 1}` };
}

/**
 * Opens one Spin-off as an issue of its own, as the Kit opens every issue of
 * its own (openAtTriage): with `needs-triage` alone, its body opening with
 * the Spin-off marker, which says where it came from. It waits, by native
 * blocked-by edges, on `blockedBy`, and `follows`, when given, is the Spec
 * whose `Follows` line the adapter ends the body with.
 */
export function openSpinOff(
  issue: CreatedIssue,
  source: SpinOffSource,
  holding: OpenedAtTriage,
  blockedBy: readonly (CreatedIssue | OpenTicketRef)[],
  follows: FollowedSpec | null = null,
): Action {
  return openAtTriage(issue, spinOffMarker(source), holding, blockedBy, follows);
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
