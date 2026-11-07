// The weekly runs: an Auditor run (#150) on a pending Audit and a Retro run
// (#151) on a pending Retro, each the scheduled tick opened. Neither has a
// trigger label: the App's opening its pending issue starts the run, and a
// failed run leaves the issue closed as not planned, with one line on how it
// failed. The tick tries it again, so unlike a Ticket's failure there's no
// trigger label to re-add and nobody to tell, unless the failure stalls the
// whole repo. Neither run is ever held, since the tick can't start one at a
// reset: one due while every Subscription is used up leaves its issue the same
// way. Pure, no I/O.
import { isPendingAudit, startAuditorRun } from "./audit.ts";
import { RUN_NAMES } from "./heldRun.ts";
import { runsDueAreHeld } from "./hold.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn, RETRO_FAILED_MARKER, retroMarker, retroMarksIn } from "./markers.ts";
import { isPendingRetro } from "./retro.ts";
import { startAgentRun } from "./runs.ts";
import type { RanOn } from "./subscriptions.ts";
import type { Action, AgentRole, HeldTargetSnapshot, InfrastructureFailure, IssueContext, IssueSnapshot, KitConfig, Plan } from "./types.ts";

/** The roles whose run is for a pending issue the scheduled tick opened, and which have no trigger label. */
export type WeeklyRole = Extract<AgentRole, "audit" | "retro">;

/** A weekly run, as the Kit starts it on its pending issue and fails it there. */
export interface WeeklyRun {
  /** What its pending issue is, such as "Audit". */
  readonly issueName: string;
  /** The run, as its issue's failed line names it, such as "The Auditor's run". */
  readonly runName: string;
  /** Whether this is the App's open issue still waiting on the run: only then does it start, or does a failure change it. */
  readonly isPending: (issue: IssueSnapshot) => boolean;
  /** The plan once the App opens its pending issue. */
  readonly start: (context: IssueContext, config: KitConfig) => Plan;
  /** The marker lines its failed body ends with: its own marker, kept when the body has one, then its failed marker. */
  readonly failedMarkers: (body: string) => readonly string[];
}

export const WEEKLY_RUNS: Readonly<Record<WeeklyRole, WeeklyRun>> = {
  audit: {
    issueName: "Audit",
    runName: "The Auditor's run",
    isPending: isPendingAudit,
    start: (context, config) => startOrFail("audit", context, config, () => startAuditorRun(context.issue, config)),
    failedMarkers: (body) => {
      const { commit } = auditMarksIn(body);
      return [...(commit === null ? [] : [auditMarker(commit)]), AUDIT_FAILED_MARKER];
    },
  },
  retro: {
    issueName: "Retro",
    runName: "The Retro's run",
    isPending: isPendingRetro,
    start: (context, config) => startOrFail("retro", context, config, () => startAgentRun("retro", context.issue.number, config)),
    failedMarkers: (body) => {
      const { windowEnd } = retroMarksIn(body);
      return [...(windowEnd === null ? [] : [retroMarker(windowEnd)]), RETRO_FAILED_MARKER];
    },
  },
};

const WEEKLY_ROLES = Object.keys(WEEKLY_RUNS) as readonly WeeklyRole[];

/** Whether a run of this role is a weekly run. */
export function isWeeklyRole(role: AgentRole): role is WeeklyRole {
  return (WEEKLY_ROLES as readonly AgentRole[]).includes(role);
}

/** The weekly run this issue is the App's pending issue for, or null for any other issue. */
export function weeklyRoleOf(issue: IssueSnapshot): WeeklyRole | null {
  return WEEKLY_ROLES.find((role) => WEEKLY_RUNS[role].isPending(issue)) ?? null;
}

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
   * run, or when it never started.
   */
  readonly ranOn?: RanOn;
}

/**
 * The plan for a failed weekly run on its pending issue in `context`, whether
 * an Auditor run failed, or a Retro run's evidence job or agent job did, or
 * its reply broke its output contract: the issue's body becomes one line on
 * how the run failed, keeping its own marker, with the failed marker in place
 * of the pending one, and it closes as not planned, mentioning nobody. A dead
 * token or the weekly limit also gets the Kit's repo-wide notice, as for any
 * run. An issue that's no longer pending (the Operator closed it, say)
 * changes nothing.
 */
export function failWeekly(
  role: WeeklyRole,
  context: IssueContext,
  { failure, how, runUrl, resetsAt, ranOn }: WeeklyRunFailure,
): Plan {
  const { issue } = context;
  const run = WEEKLY_RUNS[role];
  if (!run.isPending(issue)) {
    return { kind: "nothing", reason: `#${issue.number} is no longer a pending ${run.issueName}, so its failed run changes nothing` };
  }
  const repoWide =
    ranOn === undefined || runUrl === null
      ? null
      : repoWideNotice(failure, context, { run: `The ${RUN_NAMES[role]} run on #${issue.number}`, runUrl, resetsAt, ...ranOn });
  return { kind: "act", actions: [...failedIssue(role, issue, how, runUrl), ...(repoWide?.actions ?? [])] };
}

/** A failed weekly run's pending issue rewritten to its one line, keeping its own marker, and closed as not planned. */
function failedIssue(role: WeeklyRole, { number, body }: Pick<IssueSnapshot, "number" | "body">, how: string, runUrl: string | null): Action[] {
  const run = WEEKLY_RUNS[role];
  const link = runUrl === null ? "" : ` [The run](${runUrl})`;
  return [
    {
      kind: "edit-issue-body",
      issue: number,
      body: [`${run.runName} failed: ${how}.${link}`, "", ...run.failedMarkers(body)].join("\n"),
    },
    { kind: "close", issue: number, reason: "not_planned" },
  ];
}

/**
 * For a held marker an Auditor run left before Auditor runs stopped being held
 * (#268), at the reset: its pending Audit failed, since the tick can't start
 * the run, so that the audit gate can open a fresh one.
 */
export function failedHeldAudit(audit: HeldTargetSnapshot): Action[] {
  return failedIssue("audit", audit, "it was held while every listed Subscription was used up", null);
}

/**
 * The plan for the App's pending Audit or Retro, once it's opened: its run,
 * from `start`. With rotation on, while every listed Subscription is used up,
 * a run of any other role would be held (src/loop/hold.ts), but the scheduled
 * tick can't start a weekly run at the reset, so its issue fails instead, as a
 * failed run leaves it, and a later tick opens the next one. Its weekly-limit
 * issues already say so, so it gives no repo-wide notice.
 */
function startOrFail(role: WeeklyRole, context: IssueContext, config: KitConfig, start: () => Plan): Plan {
  if (!runsDueAreHeld(context.kitIssues, config)) return start();
  return failWeekly(role, context, {
    failure: "weekly-limit",
    how: "it was due to start while every listed Subscription was used up",
    runUrl: null,
    resetsAt: null,
  });
}
