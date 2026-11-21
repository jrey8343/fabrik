// Main checks (#744, ADR-0025): from the same default-branch commits and
// check runs red main reads, whether each check `monitor.main_checks` names
// is red or green, and what the Monitor files, rewrites or closes for it, one
// issue per check. The Monitor core (./core.ts) composes it beside red main's
// part of the plan (./redMain.ts). Pure, no I/O: the program
// (src/monitor/main.ts) reads the runs and who closed each issue.
import { MONITOR_LABEL } from "../loop/labels.ts";
import { monitorMarkerLine, RED_MAIN_GREEN_MARKER } from "../loop/markers.ts";
import {
  bodyCode,
  type BodyRewrite,
  type IssueToClose,
  type IssueToOpen,
  monitorBlock,
  monitorBlockIn,
  type MonitorIssue,
  type MonitorPlan,
  newestByMarker,
  oneLine,
  truncated,
} from "./issues.ts";
import {
  blockLinesOf,
  CHECK_NAME_MAX,
  type CheckRun,
  detailsRewriteOf,
  failedRunsOf,
  type MainCommit,
  type RedMainInput,
  seenGreenSince,
  shortSha,
} from "./redMain.ts";
import type { FailureExcerpt } from "../review/failureExcerpt.ts";
import { mainCheckOn } from "./mainCheckState.ts";

/**
 * Each Main check's part of the plan, in the order `monitor.main_checks`
 * names them. A check's state is the newest commit read that decides it,
 * whatever any other check did there: red with no open issue for it files
 * one, unless a close of its newest issue holds; red with one open rewrites
 * its details; green with one open closes it with the Monitor's note. With
 * `monitor.red_main` off, or the runs unread, it does nothing: red main's
 * notes cover a refused or rate-limited read. Its issues never count toward
 * the cap on error issues.
 */
export function mainChecksPlan({ monitor, mainChecks, issues, excerpts }: RedMainInput): MonitorPlan {
  const plan = { open: [] as IssueToOpen[], rewrite: [] as BodyRewrite[], close: [] as IssueToClose[], summary: [] as string[] };
  if (!monitor.redMain || mainChecks?.kind !== "read") return plan;
  const newest = newestByMarker(issues).byMainCheck;
  for (const check of monitor.mainChecks) {
    const decided = mainChecks.commits.flatMap((commit, index) => decisionOf(check, commit, index) ?? []);
    const state = decided[0];
    const name = bodyCode(check, CHECK_NAME_MAX);
    if (state === undefined) {
      plan.summary.push(
        `Main check ${name} is undecided: none of the default branch's ${mainChecks.commits.length} newest commits has finished it with a pass or a failure.`,
      );
      continue;
    }
    const issue = newest.get(check) ?? null;
    if (state.kind === "green") {
      if (issue?.open === true) {
        plan.close.push({ issue: issue.number, comment: greenNoteFor(check, state.commit), because: `the Main check ${name} passed again.` });
      } else {
        plan.summary.push(`Main check ${name} is green at ${shortSha(state.commit)}.`);
      }
      continue;
    }
    if (issue?.open === true) {
      const body = detailsRewriteOf(issue, state.commit, [state.run], excerpts);
      if (body === null) plan.summary.push(`Main check ${name} is still red at ${shortSha(state.commit)}, as #${issue.number} says.`);
      else {
        plan.rewrite.push({
          kind: "main-check",
          issue: issue.number,
          body,
          failedRuns: failedRunsOf(state.commit, [state.run]),
          summary: `Refreshed the Main check ${name}'s details on #${issue.number}.`,
        });
      }
      continue;
    }
    const hold: Hold = issue === null ? { held: false, after: null } : holdOf(issue, decided, mainChecks.commits);
    if (hold.held) {
      plan.summary.push(`Main check ${name} is red at ${shortSha(state.commit)}, but #${issue?.number} stays closed: ${hold.why}.`);
      continue;
    }
    plan.open.push({
      sentryGroup: null,
      title: titleOf(check),
      body: bodyOf(check, state.commit, state.run, hold.after, excerpts),
      labels: [MONITOR_LABEL],
      failedRuns: failedRunsOf(state.commit, [state.run]),
    });
  }
  return plan;
}

/**
 * A commit that decides a Main check: its newest run of the check there
 * completed and failed or timed out (red) or succeeded (green). `index` is the
 * commit's place in the branch read, 0 for the newest. It was decided when
 * that run completed, which can be after a newer commit landed, or after a close.
 */
type Decided = {
  readonly kind: "red" | "green";
  readonly commit: MainCommit;
  readonly index: number;
  readonly run: CheckRun;
  readonly decidedAt: number;
};

/**
 * How the commit decides this Main check, or null when it doesn't, by the
 * rule the read library reads one by too (./mainCheckState.ts).
 */
function decisionOf(check: string, commit: MainCommit, index: number): Decided | null {
  const { is, run } = mainCheckOn(check, commit.checkRuns);
  if (is === "undecided" || run === null) return null;
  return { kind: is, commit, index, run, decidedAt: Date.parse(run.completedAt ?? "") || 0 };
}

/** Whether a red files a new issue past the check's newest issue, closed, and if so the issue it's still failing after. */
type Hold = { readonly held: false; readonly after: number | null } | { readonly held: true; readonly why: string };

/**
 * Whether the close of a Main check's newest issue holds, with the check red:
 * - The Monitor's own close, after its green note, holds nothing.
 * - Anyone else's close as completed, as when a fix merged, holds until the
 *   check is red at a commit newer in branch order than the one the issue's
 *   Monitor block last named. No pull request runs a Main check, so the fix
 *   is tested only once it merged, and a red past it is filed again, as still
 *   failing after that issue. A named commit no longer read is older than all
 *   of them; an issue whose block is gone is held as a not-planned close is.
 * - Any other close, as not planned or as a duplicate, holds until the check
 *   has been seen green since it, as red main's does.
 */
function holdOf(issue: MonitorIssue, decided: readonly Decided[], commits: readonly MainCommit[]): Hold {
  if (issue.closedByMonitor || issue.closedAt === null) return { held: false, after: null };
  const named = issue.stateReason === "completed" ? namedCommitIn(issue.body) : null;
  if (named !== null) {
    const at = commits.findIndex((commit) => commit.sha.startsWith(named));
    const state = decided[0];
    if (state !== undefined && (at === -1 || state.index < at)) return { held: false, after: issue.number };
    return { held: true, why: "it was closed as completed, and the check hasn't failed on a commit newer than the one it names" };
  }
  return seenGreenSince(Date.parse(issue.closedAt), decided) ? { held: false, after: null } : { held: true, why: "it's held until the check is seen green, as someone other than the Monitor closed it" };
}

/** The short sha of the commit the body's Monitor block says the check is red at, or null when it names none. */
function namedCommitIn(body: string): string | null {
  for (const line of monitorBlockIn(body) ?? []) {
    const sha = /^- Red at: \[`([0-9a-f]{7,40})`\]/.exec(line)?.[1];
    if (sha !== undefined) return sha;
  }
  return null;
}

/** ``Red main: `<check>` is failing on the default branch``, the name one line with no backticks to break out of its code span. */
function titleOf(check: string): string {
  return `Red main: \`${truncated(oneLine(check).replaceAll("`", ""), CHECK_NAME_MAX)}\` is failing on the default branch`;
}

/** A Main check's issue body: its marker, what it tracks, then the red commit's details in its Monitor block. */
function bodyOf(check: string, commit: MainCommit, run: CheckRun, after: number | null, excerpts: ReadonlyMap<number, FailureExcerpt>): string {
  const name = bodyCode(check, CHECK_NAME_MAX);
  const bodyWith = (block: readonly string[]) =>
    [
      monitorMarkerLine({ kind: "main-check", check }),
      ...(after === null
        ? []
        : [`Still failing after #${after}: that issue was closed as completed, and ${name} has failed again on a newer commit than the one it names.`, ""]),
      `The Main check ${name} is failing on the default branch: the newest commit on it where ${name} has finished failed it. No pull request runs a Main check, so a fix is only tested once it merges. The Monitor keeps the details below current while it stays red, and closes this issue itself once ${name} passes on the default branch again.`,
      "",
      ...monitorBlock(block),
      "",
      "`monitor.main_checks` in `.fabrik/config.json` names the Main checks the Monitor reads on the default branch, each with an issue of its own.",
    ].join("\n");
  return bodyWith(blockLinesOf(commit, [run], excerpts, bodyWith));
}

/** The Monitor's note closing a Main check's issue: its only comment, and its marker tells its close apart from anyone else's. */
function greenNoteFor(check: string, commit: MainCommit): string {
  return [
    RED_MAIN_GREEN_MARKER,
    `Green at [${shortSha(commit)}](${commit.url}): the Main check ${bodyCode(check, CHECK_NAME_MAX)} passed, so it's no longer failing on the default branch and the Monitor closes this issue as completed.`,
  ].join("\n");
}
