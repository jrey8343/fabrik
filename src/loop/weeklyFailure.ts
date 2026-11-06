// A failed Auditor run (#150) or Retro run (#151) leaves its issue, the
// pending Audit or pending Retro the scheduled tick opened, closed as not
// planned, with one line on how it failed. The tick tries it again, so unlike
// a Ticket's failure there's no trigger label to re-add and nobody to tell,
// unless the failure stalls the whole repo. A held run the tick can't start at
// the reset, with no weekly-limit issue left open to hold it again, leaves its
// issue the same way (src/loop/resume.ts).
import { isPendingAudit } from "./audit.ts";
import { RUN_NAMES } from "./heldRun.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn, RETRO_FAILED_MARKER, retroMarker, retroMarksIn } from "./markers.ts";
import { isPendingRetro } from "./retro.ts";
import type { RanOn } from "./subscriptions.ts";
import type { Action, AgentRole, InfrastructureFailure, IssueContext, IssueSnapshot, Plan } from "./types.ts";

/** How an Auditor run or a Retro run failed. */
export interface WeeklyRunFailure {
  readonly failure: InfrastructureFailure;
  /** How it failed, as the issue's one line says it, such as "it crashed". */
  readonly how: string;
  readonly runUrl: string;
  /** For the weekly limit, when it resets, if known. */
  readonly resetsAt: string | null;
  /**
   * The Subscription it ran on, and whether rotation is on, for the repo-wide
   * notice; absent when the run's own reply failed it, which stalls no other
   * run.
   */
  readonly ranOn?: RanOn;
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
  return failPending(context, run, {
    pending: isPendingAudit(context.issue),
    name: "Audit",
    run: RUNS.audit,
    stalled: `The ${RUN_NAMES.audit} run`,
    markers: failedMarkers("audit", context.issue.body),
  });
}

/**
 * The plan for a failed Retro run on the Retro in `context`, whether its
 * evidence job or its agent job failed, or its reply broke the Retro output
 * contract: its body becomes one line on how the run failed, keeping its
 * retro marker, with the failed marker in place of the pending one, and it
 * closes as not planned, mentioning nobody. A dead token or the weekly limit
 * also gets the Kit's repo-wide notice, as for any run. A Retro that's no
 * longer pending (the Operator closed it, say) changes nothing.
 */
export function failRetro(context: IssueContext, run: WeeklyRunFailure): Plan {
  return failPending(context, run, {
    pending: isPendingRetro(context.issue),
    name: "Retro",
    run: RUNS.retro,
    stalled: `The ${RUN_NAMES.retro} run`,
    markers: failedMarkers("retro", context.issue.body),
  });
}

/**
 * The actions failing a pending Audit or Retro whose held run the scheduled
 * tick couldn't start at the reset, nor hold again, because it started the
 * other held run with no trigger label and no weekly-limit issue stays open
 * (src/loop/resume.ts): its body becomes one line on why, keeping its marker,
 * with the failed marker in place of the pending one, and it closes as not
 * planned, mentioning nobody, as a failed run leaves it, so the tick opens
 * the next one.
 */
export function failUnstarted(role: WeeklyRole, pending: Pick<IssueSnapshot, "number" | "body">, why: string): Action[] {
  return [
    {
      kind: "edit-issue-body",
      issue: pending.number,
      body: [`${RUNS[role]} failed: ${why}.`, "", ...failedMarkers(role, pending.body)].join("\n"),
    },
    { kind: "close", issue: pending.number, reason: "not_planned" },
  ];
}

/** The roles whose run is for a pending issue the scheduled tick opened, and which have no trigger label. */
type WeeklyRole = Extract<AgentRole, "audit" | "retro">;

/** Each weekly run as its issue's failed line names it. */
const RUNS: Readonly<Record<WeeklyRole, string>> = { audit: "The Auditor's run", retro: "The Retro's run" };

/** The marker lines a failed Audit's or Retro's body ends with: its own marker, kept when it has one, then its failed marker. */
function failedMarkers(role: WeeklyRole, body: string): string[] {
  if (role === "audit") {
    const { commit } = auditMarksIn(body);
    return [...(commit === null ? [] : [auditMarker(commit)]), AUDIT_FAILED_MARKER];
  }
  const { windowEnd } = retroMarksIn(body);
  return [...(windowEnd === null ? [] : [retroMarker(windowEnd)]), RETRO_FAILED_MARKER];
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

function failPending(
  context: IssueContext,
  { failure, how, runUrl, resetsAt, ranOn }: WeeklyRunFailure,
  pending: PendingIssue,
): Plan {
  const { issue } = context;
  if (!pending.pending) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending ${pending.name}, so its failed run changes nothing` };
  }
  const repoWide =
    ranOn === undefined
      ? null
      : repoWideNotice(failure, context, { run: `${pending.stalled} on #${issue.number}`, runUrl, resetsAt, ...ranOn });
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
