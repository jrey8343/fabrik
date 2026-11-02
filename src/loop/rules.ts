import { isWayfinderLabel, STATE_LABELS } from "./labels.ts";
import type { KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

/** The Loop rules core: decides what the Kit does about one Loop event. Pure, no I/O. */
export function planFor(event: LoopEvent, snapshot: Snapshot, _config: KitConfig): Plan {
  switch (event.kind) {
    case "issue-opened":
      return intake(event.issue, snapshot);
  }
}

/** A new issue gets needs-triage unless something has already given it a place. */
function intake(issueNumber: number, { issue }: Snapshot): Plan {
  const state = issue.labels.find((label) => STATE_LABELS.includes(label));
  if (state !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} already has the state label ${state}` };
  }
  const wayfinder = issue.labels.find(isWayfinderLabel);
  if (wayfinder !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} has the label ${wayfinder}, so a skill made it` };
  }
  if (issue.parent !== null) {
    return { kind: "nothing", reason: `#${issueNumber} is a sub-issue of #${issue.parent}, so a skill made it` };
  }
  return {
    kind: "act",
    actions: [{ kind: "add-labels", issue: issueNumber, labels: ["needs-triage"] }],
  };
}
