// A failed Auditor run (#150) or Retro run (#151) leaves its issue, the
// pending Audit or pending Retro the scheduled tick opened, closed as not
// planned, with one line on how it failed. The tick tries it again, so unlike
// a Ticket's failure there's no trigger label to re-add and nobody to tell,
// unless the failure stalls the whole repo. A Retro run is never held, since
// the tick can't start one at a reset: one due while every Subscription is
// used up leaves its Retro the same way.
import { isPendingAudit } from "./audit.ts";
import { RUN_NAMES } from "./heldRun.ts";
import { runsDueAreHeld } from "./hold.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn, RETRO_FAILED_MARKER, retroMarker, retroMarksIn } from "./markers.ts";
import { isPendingRetro } from "./retro.ts";
import { startAgentRun } from "./runs.ts";
import type { RanOn } from "./subscriptions.ts";
import type { AgentRole, InfrastructureFailure, IssueContext, KitConfig, Plan } from "./types.ts";

/** How an Auditor run or a Retro run failed. */
export interface WeeklyRunFailure {
  readonly failure: InfrastructureFailure;
  /** How it failed, as the issue's one line says it, such as "it crashed". */
  readonly how: string;
  /** The Actions run the issue's line links to, or null for a run that never started. */
  readonly runUrl: string | null;
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
 * The plan for the App's pending Retro, once it's opened: a Retro run on
 * roles.retro's model, effort and timeout. With rotation on, while every
 * listed Subscription is used up, a run of any other role would be held
 * (src/loop/hold.ts), but the scheduled tick can't start a Retro run at the
 * reset, so the Retro fails instead, as a failed run leaves it, and a later
 * tick opens the next one. Its weekly-limit issues already say so, so it gives
 * no repo-wide notice.
 */
export function startRetroRun(context: IssueContext, config: KitConfig): Plan {
  if (!runsDueAreHeld(context.kitIssues, config)) return startAgentRun("retro", context.issue.number, config);
  return failRetro(context, {
    failure: "weekly-limit",
    how: "it was due to start while every listed Subscription was used up",
    runUrl: null,
    resetsAt: null,
  });
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
    ranOn === undefined || runUrl === null
      ? null
      : repoWideNotice(failure, context, { run: `${pending.stalled} on #${issue.number}`, runUrl, resetsAt, ...ranOn });
  return {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: issue.number,
        body: [`${pending.run} failed: ${how}.${runUrl === null ? "" : ` [The run](${runUrl})`}`, "", ...pending.markers].join("\n"),
      },
      { kind: "close", issue: issue.number, reason: "not_planned" },
      ...(repoWide?.actions ?? []),
    ],
  };
}
