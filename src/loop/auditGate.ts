// The audit gate (#150): on the hourly scheduled tick, whether to open this
// week's pending Audit, whose opening starts the Auditor's run.
import { shortSha } from "../skills/lock.ts";
import { auditsIn, lastAudit } from "./audit.ts";
import { AUDIT_LABEL } from "./labels.ts";
import { AUDIT_PENDING_MARKER, auditMarker } from "./markers.ts";
import type { Action, KitConfig, Plan, Snapshot } from "./types.ts";
import { dateOf, heldBack, scheduledTickWith, weekStart } from "./weeklyGate.ts";

/**
 * The scheduled tick with the audit gate: closes the weekly-limit issue after
 * its reset, as scheduledTick does, alongside opening a pending Audit when
 * one is due. The scheduled-tick rule calls it on every tick.
 */
export function scheduledTickWithAuditGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  return scheduledTickWith([auditGate], now, snapshot, config);
}

/** The audit gate on its own: a pending Audit to open, or why there's none this tick. */
export function auditGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  const { day } = config.audit;
  if (day === null) return { kind: "nothing", reason: "The Audit is off: audit.day is null" };
  const slice = snapshot.audit;
  if (slice === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the audit slice the audit gate weighs" };
  }
  const held = heldBack("Audit", day, auditsIn(slice.issues), now, snapshot.kitIssues);
  if (held !== null) return { kind: "nothing", reason: held };

  const { head } = slice;
  if (head === null) return { kind: "nothing", reason: "The default branch has no commits to audit" };
  const last = lastAudit(slice.issues);
  if (last !== null && last.commit === head) {
    return { kind: "nothing", reason: `The default branch hasn't moved since #${last.number} audited it at ${shortSha(head)}` };
  }
  return { kind: "act", actions: [pendingAudit(weekStart(now), head)] };
}

/** This week's pending Audit of `head`: no state label, assignee or mention, so opening it buzzes nobody. */
function pendingAudit(week: number, head: string): Action {
  return {
    kind: "open-issue",
    title: `Audit: week of ${dateOf(week)}`,
    body: [
      `The Auditor is reading the default branch up to \`${shortSha(head)}\`, and this issue fills in when it's done.`,
      "",
      auditMarker(head),
      AUDIT_PENDING_MARKER,
    ].join("\n"),
    labels: [AUDIT_LABEL],
    assignees: [],
  };
}
