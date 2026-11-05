// The Design queue check (#147): the Kit, not the label alone, decides when a
// Design session starts, so at most caps.design_sessions sessions wait on the
// Operator in a Product repo at once. Modelled on Dispatch (src/loop/dispatch.ts).
import { DESIGN_LABEL } from "./labels.ts";
import type { DesignQueueIssue, DesignQueueSnapshot, KitConfig, Plan } from "./types.ts";

/**
 * Starts a Design turn on as many waiting `needs-design` issues as there are
 * free slots: re-designs first, then oldest `needs-design` first. A held issue is left exactly as it
 * is: no comment, no label, no mention.
 */
export function checkDesignQueue(snapshot: DesignQueueSnapshot, config: KitConfig): Plan {
  const cap = config.caps.designSessions;
  const holding = holders(snapshot).sort((a, b) => a - b);
  const queue = waiting(snapshot).map((issue) => issue.number);
  if (queue.length === 0) {
    return { kind: "nothing", reason: "No needs-design issue is waiting for a Design session slot" };
  }
  if (cap === 0) {
    const carryOn = holding.length === 0 ? "" : `; ${holdingSlots(holding)} and carr${holding.length === 1 ? "ies" : "y"} on`;
    return {
      kind: "nothing",
      reason: `New Design sessions are paused because caps.design_sessions is 0, so ${waits(queue)}${carryOn}`,
    };
  }
  const free = Math.max(0, cap - holding.length);
  if (free === 0) {
    return { kind: "nothing", reason: `caps.design_sessions is ${cap} and ${holdingSlots(holding)}, so ${waits(queue)}` };
  }
  return {
    kind: "act",
    actions: queue.slice(0, free).map((issue) => ({ kind: "add-labels", issue, labels: [DESIGN_LABEL] })),
  };
}

/** `#3 holds a slot`, or `#3 and #4 hold slots`. */
function holdingSlots(numbers: readonly number[]): string {
  return numbers.length === 1 ? `${list(numbers)} holds a slot` : `${list(numbers)} hold slots`;
}

/** `#5 waits`, or `#5 and #6 wait`. */
function waits(numbers: readonly number[]): string {
  return `${list(numbers)} ${numbers.length === 1 ? "waits" : "wait"}`;
}

/** `#1`, `#1 and #2`, or `#1, #2 and #3`. */
function list(numbers: readonly number[]): string {
  const names = numbers.map((n) => `#${n}`);
  return names.length < 2 ? names.join(", ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The issues holding a Design session slot, by number. */
function holders(snapshot: DesignQueueSnapshot): number[] {
  return snapshot.issues.filter((issue) => holdsSlot(issue, snapshot)).map((issue) => issue.number);
}

/**
 * The issues waiting for a slot, in the order they start: re-designs first,
 * then oldest `needs-design` first, then by number.
 */
function waiting(snapshot: DesignQueueSnapshot): DesignQueueIssue[] {
  return snapshot.issues
    .filter((issue) => !holdsSlot(issue, snapshot))
    .sort(
      (a, b) =>
        Number(b.redesign) - Number(a.redesign) ||
        Date.parse(a.neededDesignAt) - Date.parse(b.neededDesignAt) ||
        a.number - b.number,
    );
}

/**
 * Whether an open `needs-design` issue holds a Design session slot; one that
 * doesn't is waiting. A session holds its slot from its first turn until it
 * ends: once the queue check gives it agent:design, while a turn is in
 * progress, once the Kit has posted a round in it, and after a turn fails,
 * whose failure notice is the Operator's move.
 */
export function holdsSlot(issue: DesignQueueIssue, snapshot: DesignQueueSnapshot): boolean {
  return (
    issue.designRounds > 0 ||
    issue.turnFailed ||
    issue.labels.includes(DESIGN_LABEL) ||
    snapshot.designTurnsInProgress.includes(issue.number)
  );
}
