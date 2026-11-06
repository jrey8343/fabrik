// A failed Auditor run (#150) leaves its Audit closed as not planned, with one
// line on how it failed. The scheduled tick tries the Audit again, so unlike
// a Ticket's failure there's no trigger label to re-add and nobody to tell,
// unless the failure stalls the whole repo.
import { isPendingAudit } from "./audit.ts";
import { repoWideNotice, type StalledRun } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn } from "./markers.ts";
import type { InfrastructureFailure, IssueContext, Plan } from "./types.ts";

/** How an Auditor run failed. */
export interface AuditRunFailure {
  readonly failure: InfrastructureFailure;
  /** How it failed, as the Audit's one line says it, such as "it crashed". */
  readonly how: string;
  readonly runUrl: string;
  /** For the weekly limit, when it resets, if known. */
  readonly resetsAt: string | null;
  /**
   * The Subscription it ran on, and whether rotation is on, for the repo-wide
   * notice; absent when the Auditor's own reply failed it, which stalls no
   * other run.
   */
  readonly ranOn?: Pick<StalledRun, "subscription" | "rotation" | "subscriptions">;
}

/**
 * The plan for a failed Auditor run on the Audit in `context`: its body
 * becomes one line on how the run failed, keeping its audit marker, with the
 * failed marker in place of the pending one, and it closes as not planned,
 * mentioning nobody. A dead token or the weekly limit also gets the Kit's
 * repo-wide notice, as for any run. An Audit that's no longer pending (the
 * Operator closed it, say) changes nothing.
 */
export function failAudit(
  context: IssueContext,
  { failure, how, runUrl, resetsAt, ranOn }: AuditRunFailure,
): Plan {
  const { issue } = context;
  if (!isPendingAudit(issue)) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending Audit, so its failed run changes nothing` };
  }
  const { commit } = auditMarksIn(issue.body);
  const repoWide =
    ranOn === undefined
      ? null
      : repoWideNotice(failure, context, { run: `The Audit run on #${issue.number}`, runUrl, resetsAt, ...ranOn });
  return {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: issue.number,
        body: [
          `The Auditor's run failed: ${how}. [The run](${runUrl})`,
          "",
          ...(commit === null ? [] : [auditMarker(commit)]),
          AUDIT_FAILED_MARKER,
        ].join("\n"),
      },
      { kind: "close", issue: issue.number, reason: "not_planned" },
      ...(repoWide?.actions ?? []),
    ],
  };
}
