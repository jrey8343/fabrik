// The Audits in a Product repo (#150), read from the `fabrik:audit` issues the
// Fabrik App opened through their marker lines (src/loop/markers.ts). The
// tick opens each one pending; the Auditor's run fills it in or fails it.
import { AUDIT_LABEL } from "./labels.ts";
import { auditMarksIn } from "./markers.ts";
import type { AuditIssueSnapshot, IssueSnapshot } from "./types.ts";

/** An Audit as the Kit reads it from its issue. */
export interface Audit {
  readonly number: number;
  readonly open: boolean;
  /** When the tick opened it, as an ISO 8601 time. */
  readonly createdAt: string;
  /** The commit it reads, from its audit marker, or null when its body has none. */
  readonly commit: string | null;
  /** Whether it's still waiting on its run. */
  readonly pending: boolean;
  /** Whether its run failed, which leaves it closed and never the last Audit. */
  readonly failed: boolean;
}

/**
 * The Audits among these `fabrik:audit` issues, newest first. Only an issue
 * the Fabrik App opened is one: a person's issue with the label or a quoted
 * marker counts for nothing.
 */
export function auditsIn(issues: readonly AuditIssueSnapshot[]): Audit[] {
  return issues
    .filter((issue) => issue.byApp)
    .map(({ number, open, createdAt, body }) => ({ number, open, createdAt, ...auditMarksIn(body) }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
}

/**
 * The last Audit: the newest one the Fabrik App opened whose run didn't fail,
 * whatever its state, or null before the first.
 */
export function lastAudit(issues: readonly AuditIssueSnapshot[]): Audit | null {
  return auditsIn(issues).find((audit) => !audit.failed) ?? null;
}

/**
 * Whether this issue is the Fabrik App's open Audit still waiting on its run:
 * the only issue an Auditor run starts for, or fails. A person's issue with
 * the label or a quoted marker never is.
 */
export function isPendingAudit(issue: IssueSnapshot): boolean {
  return issue.open && issue.byApp && issue.labels.includes(AUDIT_LABEL) && auditMarksIn(issue.body).pending;
}
