// The weekly runs: an Auditor run (#150) on a pending Audit and a Retro run
// (#151) on a pending Retro, each the scheduled tick opened. Neither has a
// trigger label: the App's opening its pending issue starts the run, and a
// failed run leaves the issue closed as not planned, with one line on how it
// failed. The tick tries it again, so unlike a Ticket's failure there's no
// trigger label to re-add and nobody to tell, unless the failure stalls the
// whole repo. A Retro run is never held, since the tick can't start one at a
// reset: one due while every Subscription is used up leaves its Retro the
// same way. Pure, no I/O.
import { isPendingAudit, startAuditorRun } from "./audit.ts";
import { RUN_NAMES } from "./heldRun.ts";
import { runsDueAreHeld } from "./hold.ts";
import { repoWideNotice } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn, RETRO_FAILED_MARKER, retroMarker, retroMarksIn } from "./markers.ts";
import { isPendingRetro } from "./retro.ts";
import { startAgentRun } from "./runs.ts";
import type { RanOn } from "./subscriptions.ts";
import type { AgentRole, InfrastructureFailure, IssueContext, IssueSnapshot, KitConfig, Plan } from "./types.ts";

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
    // While every Subscription is used up, planFor holds it, and the tick starts it on its pending Audit at the reset.
    start: ({ issue }, config) => startAuditorRun(issue, config),
    failedMarkers: (body) => {
      const { commit } = auditMarksIn(body);
      return [...(commit === null ? [] : [auditMarker(commit)]), AUDIT_FAILED_MARKER];
    },
  },
  retro: {
    issueName: "Retro",
    runName: "The Retro's run",
    isPending: isPendingRetro,
    start: startRetroRun,
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
  const link = runUrl === null ? "" : ` [The run](${runUrl})`;
  return {
    kind: "act",
    actions: [
      {
        kind: "edit-issue-body",
        issue: issue.number,
        body: [`${run.runName} failed: ${how}.${link}`, "", ...run.failedMarkers(issue.body)].join("\n"),
      },
      { kind: "close", issue: issue.number, reason: "not_planned" },
      ...(repoWide?.actions ?? []),
    ],
  };
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
function startRetroRun(context: IssueContext, config: KitConfig): Plan {
  if (!runsDueAreHeld(context.kitIssues, config)) return startAgentRun("retro", context.issue.number, config);
  return failWeekly("retro", context, {
    failure: "weekly-limit",
    how: "it was due to start while every listed Subscription was used up",
    runUrl: null,
    resetsAt: null,
  });
}
