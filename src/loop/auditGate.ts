// The audit gate (#150): on the hourly scheduled tick, whether to open this
// week's pending Audit, whose opening starts the Auditor's run.
import { AUDIT_DAYS } from "../kit/config.ts";
import { shortSha } from "../skills/lock.ts";
import { auditsIn, lastAudit } from "./audit.ts";
import { scheduledTick } from "./kitIssues.ts";
import { AUDIT_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { AUDIT_PENDING_MARKER, auditMarker } from "./markers.ts";
import type { Action, KitConfig, Plan, Snapshot } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;

/** How many failed Audits a week the tick retries before waiting for the next week. */
const FAILED_AUDITS_A_WEEK = 2;

/**
 * The scheduled tick with the audit gate: closes each weekly-limit issue
 * after its reset, as scheduledTick does, alongside opening a pending Audit
 * when one is due. The scheduled-tick rule calls it on every tick.
 */
export function scheduledTickWithAuditGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  const tick = scheduledTick(now, snapshot, config);
  // A weekly-limit issue this tick closes after its reset no longer holds the Audit back.
  const closing = actionsOf(tick).flatMap((action) => (action.kind === "close" ? [action.issue] : []));
  const kitIssues = snapshot.kitIssues.filter((issue) => !closing.includes(issue.number));
  return alongside(tick, auditGate(now, { ...snapshot, kitIssues }, config));
}

/** Both plans' actions, or why neither acts. */
function alongside(first: Plan, second: Plan): Plan {
  if (first.kind === "fail") return first;
  if (second.kind === "fail") return second;
  if (first.kind === "nothing" && second.kind === "nothing") {
    return { kind: "nothing", reason: `${first.reason}; ${second.reason}` };
  }
  return { kind: "act", actions: [...actionsOf(first), ...actionsOf(second)] };
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/** The audit gate on its own: a pending Audit to open, or why there's none this tick. */
function auditGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  const { day } = config.audit;
  if (day === null) return { kind: "nothing", reason: "The Audit is off: audit.day is null" };
  const slice = snapshot.audit;
  if (slice === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the audit slice the audit gate weighs" };
  }
  const week = weekStart(now);
  const due = week + AUDIT_DAYS.indexOf(day) * DAY;
  if (Date.parse(now) < due) return { kind: "nothing", reason: `The Audit is due from ${readable(due)}` };

  const audits = auditsIn(slice.issues);
  const thisWeek = audits.filter(({ createdAt }) => Date.parse(createdAt) >= week && Date.parse(createdAt) < week + 7 * DAY);
  const done = thisWeek.find((audit) => !audit.failed);
  if (done !== undefined) return { kind: "nothing", reason: `#${done.number} already audited this week` };
  const open = audits.find((audit) => audit.open);
  if (open !== undefined) return { kind: "nothing", reason: `Audit #${open.number} is still open` };
  const limit = snapshot.kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  if (limit !== undefined) return { kind: "nothing", reason: `The weekly usage limit is reached, as #${limit.number} says` };
  const failed = thisWeek.filter((audit) => audit.failed).reverse();
  if (failed.length >= FAILED_AUDITS_A_WEEK) {
    const which = failed.map((audit) => `#${audit.number}`).join(" and ");
    return { kind: "nothing", reason: `${which} failed this week, so the next Audit waits for next week` };
  }

  const { head } = slice;
  if (head === null) return { kind: "nothing", reason: "The default branch has no commits to audit" };
  const last = lastAudit(slice.issues);
  if (last !== null && last.commit === head) {
    return { kind: "nothing", reason: `The default branch hasn't moved since #${last.number} audited it at ${shortSha(head)}` };
  }
  return { kind: "act", actions: [pendingAudit(week, head)] };
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

/** Monday 00:00 UTC of the ISO week `now` falls in, in milliseconds. */
function weekStart(now: string): number {
  const at = new Date(now);
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - sinceMonday * DAY;
}

/** Such as "2026-11-08 00:00 UTC". */
function readable(time: number): string {
  const at = new Date(time).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** Such as "2026-11-02". */
function dateOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
