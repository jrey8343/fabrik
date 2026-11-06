// A failed Auditor run (#150) leaves its issue, the pending Audit the
// scheduled tick opened, closed as not planned, with one line on how it
// failed. The tick tries it again, so unlike a Ticket's failure there's no
// trigger label to re-add and nobody to tell, unless the failure stalls the
// whole repo.
import { isPendingAudit } from "./audit.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn } from "./markers.ts";
import type { InfrastructureFailure, IssueContext, Plan } from "./types.ts";

/** How an Auditor run failed. */
export interface WeeklyRunFailure {
  readonly failure: InfrastructureFailure;
  /** How it failed, as the issue's one line says it, such as "it crashed". */
  readonly how: string;
  readonly runUrl: string;
  /** For the weekly limit, when it resets, if known. */
  readonly resetsAt: string | null;
}

/**
 * The plan for a failed Auditor run on the Audit in `context`: its body
 * becomes one line on how the run failed, keeping its audit marker, with the
 * failed marker in place of the pending one, and it closes as not planned,
 * mentioning nobody. A dead token or the weekly limit also gets the Kit's
 * repo-wide notice, as for any run. An Audit that's no longer pending (the
 * Operator closed it, say) changes nothing.
 */
export function failAudit(context: IssueContext, run: WeeklyRunFailure): Plan {
  const { commit } = auditMarksIn(context.issue.body);
  return failPending(context, run, {
    pending: isPendingAudit(context.issue),
    name: "Audit",
    run: "The Auditor's run",
    stalled: "The Audit run",
    markers: [...(commit === null ? [] : [auditMarker(commit)]), AUDIT_FAILED_MARKER],
  });
}

/** The issue a failed weekly run was for, as its failure rewrites it. */
interface PendingIssue {
  /** Whether it's still the App's open issue waiting on the run; only then does the failure change it. */
  readonly pending: boolean;
  /** What it is, such as "Audit". */
  readonly name: string;
  /** The run, as the issue's one line names it, such as "The Auditor's run". */
  readonly run: string;
  /** The run, as the repo-wide notice names it, such as "The Audit run". */
  readonly stalled: string;
  /** The marker lines its failed body ends with: its own marker, kept when it has one, then its failed marker. */
  readonly markers: readonly string[];
}

function failPending(context: IssueContext, { failure, how, runUrl, resetsAt }: WeeklyRunFailure, pending: PendingIssue): Plan {
  const { issue } = context;
  if (!pending.pending) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending ${pending.name}, so its failed run changes nothing` };
  }
  const repoWide = repoWideNotice(failure, context, { run: `${pending.stalled} on #${issue.number}`, runUrl, resetsAt });
  return {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: issue.number,
        body: [`${pending.run} failed: ${how}. [The run](${runUrl})`, "", ...pending.markers].join("\n"),
      },
      { kind: "close", issue: issue.number, reason: "not_planned" },
      ...(repoWide?.actions ?? []),
    ],
  };
}
