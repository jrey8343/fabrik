// The weekly runs: an Auditor run (#150) on a pending Audit and a Retro run
// (#151) on a pending Retro, each the scheduled tick opened. Neither has a
// trigger label: the App's opening its pending issue starts the run, and a
// failed run leaves the issue closed as not planned, with one line on how it
// failed. The tick tries it again, so unlike a Ticket's failure there's no
// trigger label to re-add and nobody to tell, unless the failure stalls the
// whole repo, or it's the week's second failure, after which the next one
// waits for next week (src/loop/weeklyGate.ts). Neither run is ever held,
// since the tick can't start one at a reset: one due while every Subscription
// is used up leaves its issue the same way. Pure, no I/O.
import { auditsIn, isPendingAudit, startAuditorRun } from "./audit.ts";
import { runNamed } from "./heldRun.ts";
import { runsDueAreHeld } from "./hold.ts";
import { repoWideNotice, type StalledRun } from "./kitIssues.ts";
import { AUDIT_FAILED_MARKER, auditMarker, auditMarksIn, RETRO_FAILED_MARKER, retroMarker, retroMarksIn } from "./markers.ts";
import { isPendingRetro, retrosIn } from "./retro.ts";
import { startAgentRun } from "./runs.ts";
import type { RanOn } from "./subscriptions.ts";
import type {
  Action,
  AgentRole,
  HeldTargetSnapshot,
  InfrastructureFailure,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  Plan,
  WeeklyIssueSnapshot,
} from "./types.ts";
import { FAILED_RUNS_A_WEEK, failedInWeek, type WeeklyIssue, weekStart } from "./weeklyGate.ts";

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
  /** The plan that starts its run. */
  readonly start: (context: IssueContext, config: KitConfig) => Plan;
  /** The marker lines its failed body ends with: its own marker, kept when the body has one, then its failed marker. */
  readonly failedMarkers: (body: string) => readonly string[];
  /** Its gate's issues as the gate weighs them: the App's alone, with whether each one's run failed. */
  readonly gateIssues: (issues: readonly WeeklyIssueSnapshot[]) => readonly WeeklyIssue[];
}

const WEEKLY_RUNS: Readonly<Record<WeeklyRole, WeeklyRun>> = {
  audit: {
    issueName: "Audit",
    runName: "The Auditor's run",
    isPending: isPendingAudit,
    start: ({ issue }, config) => startAuditorRun(issue, config),
    failedMarkers: (body) => {
      const { commit } = auditMarksIn(body);
      return [...(commit === null ? [] : [auditMarker(commit)]), AUDIT_FAILED_MARKER];
    },
    gateIssues: auditsIn,
  },
  retro: {
    issueName: "Retro",
    runName: "The Retro's run",
    isPending: isPendingRetro,
    start: ({ issue }, config) => startAgentRun("retro", issue.number, config),
    failedMarkers: (body) => {
      const { windowEnd } = retroMarksIn(body);
      return [...(windowEnd === null ? [] : [retroMarker(windowEnd)]), RETRO_FAILED_MARKER];
    },
    gateIssues: retrosIn,
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
   * The Subscription it ran on, whether rotation is on, and the Operator's
   * time zone, for the repo-wide notice; absent when the run's own reply
   * failed it, which stalls no other run, or when it never started.
   */
  readonly ranOn?: RanOn & Pick<StalledRun, "timeZone">;
}

/**
 * The plan for a failed weekly run on its pending issue in `context`, whether
 * an Auditor run failed, or a Retro run's evidence job or agent job did, or
 * its reply broke its output contract: the issue's body becomes one line on
 * how the run failed, keeping its own marker, with the failed marker in place
 * of the pending one, and it closes as not planned, mentioning nobody, unless
 * it's the week's second failed run: then the Operator is told why the next
 * one waits for next week (#443). A dead token or the weekly limit also gets
 * the Kit's repo-wide notice, as for any run. An issue that's no longer
 * pending (the Operator closed it, say) changes nothing.
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
      : repoWideNotice(failure, context, { run: `The ${runNamed(role)} on #${issue.number}`, runUrl, resetsAt, ...ranOn });
  const [edit, close] = failedIssue(role, issue, how, runUrl);
  return { kind: "act", actions: [edit, ...givingUpOnTheWeek(role, context, how, runUrl), close, ...(repoWide?.actions ?? [])] };
}

/**
 * When this failed run is the one that gives up on its pending issue's week,
 * as FAILED_RUNS_A_WEEK failed runs in a week hold its gate back until the
 * next (src/loop/weeklyGate.ts): a comment on it @-mentioning the Operator,
 * with each of the week's failed runs, how it failed and its link, read from
 * the line each earlier one's body was left with. Otherwise nothing.
 */
function givingUpOnTheWeek(role: WeeklyRole, { issue, operator, weeklyIssues }: IssueContext, how: string, runUrl: string | null): Action[] {
  const run = WEEKLY_RUNS[role];
  const own = weeklyIssues?.find((weekly) => weekly.number === issue.number);
  if (weeklyIssues === null || own === undefined) return [];
  const others = weeklyIssues.filter((weekly) => weekly.number !== issue.number);
  const earlier = failedInWeek(run.gateIssues(others), weekStart(own.createdAt));
  if (earlier.length + 1 < FAILED_RUNS_A_WEEK) return [];
  const failedLine = (number: number) => {
    const line = others.find((weekly) => weekly.number === number)?.body.split("\n")[0] ?? "";
    const prefix = `${run.runName} failed: `;
    return line.startsWith(prefix) ? `: ${line.slice(prefix.length)}` : "";
  };
  return [
    {
      kind: "comment",
      issue: issue.number,
      body: [
        `@${operator} ${run.runName} failed ${earlier.length === 1 ? "twice" : `${earlier.length + 1} times`} this week, so the next ${run.issueName} waits for next week:`,
        "",
        ...earlier.map(({ number }) => `- #${number}${failedLine(number)}`),
        `- #${issue.number}: ${how}.${runLink(runUrl)}`,
      ].join("\n"),
    },
  ];
}

/** ` [The run](url)`, or nothing for a run that never started. */
function runLink(runUrl: string | null): string {
  return runUrl === null ? "" : ` [The run](${runUrl})`;
}

/** A failed weekly run's pending issue rewritten to its one line, keeping its own marker, and closed as not planned. */
function failedIssue(
  role: WeeklyRole,
  { number, body }: Pick<IssueSnapshot, "number" | "body">,
  how: string,
  runUrl: string | null,
): [Action, Action] {
  const run = WEEKLY_RUNS[role];
  return [
    {
      kind: "edit-issue-body",
      issue: number,
      body: [`${run.runName} failed: ${how}.${runLink(runUrl)}`, "", ...run.failedMarkers(body)].join("\n"),
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
 * The plan for the App's pending Audit or Retro, once it's opened: its run.
 * With rotation on, while every listed Subscription is used up, a run of any
 * other role would be held (src/loop/hold.ts), but the scheduled
 * tick can't start a weekly run at the reset, so its issue fails instead, as a
 * failed run leaves it, and a later tick opens the next one. The weekly-limit,
 * usage-credits or token-rotation issues using every Subscription up already
 * say so, so it gives no repo-wide notice.
 */
export function startWeekly(role: WeeklyRole, context: IssueContext, config: KitConfig): Plan {
  if (!runsDueAreHeld(context.kitIssues, config)) return WEEKLY_RUNS[role].start(context, config);
  return failWeekly(role, context, {
    failure: "weekly-limit",
    how: "it was due to start while every listed Subscription was used up",
    runUrl: null,
    resetsAt: null,
  });
}
