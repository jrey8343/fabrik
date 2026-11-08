// A trigger label a role declines: it comes off, so adding it again fires a
// fresh labeled event, and one comment says why nothing started, so the
// Operator doesn't watch the label vanish with no word (#417).
import type { Label } from "./labels.ts";
import type { Action } from "./types.ts";

/** Takes `label` off `issue` and says in one line why nothing started. `why` reads as a clause, with no full stop. */
export function declineTrigger(issue: number, label: Label, why: string): Action[] {
  return [
    { kind: "remove-label", issue, label },
    { kind: "comment", issue, body: `${label} came off and nothing started: ${why}.` },
  ];
}
