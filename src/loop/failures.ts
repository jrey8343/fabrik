// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it. A
// failed Auditor or Retro run fails its Audit or Retro instead, with no
// trigger to re-add, since the scheduled tick opens the next one
// (src/loop/weeklyRuns.ts). With rotation on, a
// run refused on its Subscription's weekly limit is re-run once, quietly,
// through its trigger label while another Subscription is free, so the
// Operator hears nothing. Once none is free it is held instead, with no
// failure comment (src/loop/heldRun.ts). A run killed for spending usage
// credits, or refused on a dead token, is re-run or held the same way, while
// its Subscription's usage-credits or token-rotation issue keeps the Kit off
// that Subscription (#433). An Auditor or Retro
// run is never re-run or held: the tick can't start one at a reset, so its
// Audit or Retro fails, for the tick to try again.
import { conflictRunEnded } from "./conflicts.ts";
import { prototypeRole } from "./design.ts";
import { heldInOrder, type HoldableRun, holding, RESUME_LABELS, runNamed } from "./heldRun.ts";
import { canHold, heldAfterKill } from "./hold.ts";
import { anotherSubscriptionFree, refusedToken, repoWideNotice } from "./kitIssues.ts";
import { DESIGN_TURN_FAILED_MARKER, IMPLEMENT_RUN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "./markers.ts";
import { readable } from "./readable.ts";
import { type RanOn, ranOnOf, rotationIsOn, subscriptionOfRun } from "./subscriptions.ts";
import type { Action, AgentRole, FailedRunCommits, InfrastructureFailure, IssueContext, KitConfig, LoopEvent, Plan } from "./types.ts";
import { failWeekly, isWeeklyRole } from "./weeklyRuns.ts";

type FailedRun = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/**
 * With rotation on, the failures that leave the run's Subscription unusable,
 * so the Kit re-runs the run on the next free one, or holds it while none is:
 * the weekly limit, a kill for spending usage credits, and a dead token. A run is re-run,
 * or resumed, through the label RESUME_LABELS names for its role
 * (src/loop/heldRun.ts): its trigger label, and agent:design for a
 * Design-session turn, which starts the turn again (src/loop/design.ts).
 */
const RERUN_FAILURES: readonly InfrastructureFailure[] = ["weekly-limit", "usage-credits", "dead-token"];

/**
 * The first line of a failure notice the snapshot reads back: a failed
 * Design-session turn keeps its session's slot (#147), a failed Researcher
 * run keeps Dispatch off its Decision until the Operator re-adds
 * agent:research (#154), and a failed Implement run on a Ticket with no open
 * PR keeps Dispatch off it until the Operator re-adds agent:implement (#418).
 * An Implement notice on the Ticket's PR carries it too, so the conflict
 * check leaves a failed Request-changes run for that re-add rather than
 * restart it every hour (#424); the open PR already holds its Ticket off
 * Dispatch. Any other notice on a PR needs none.
 */
const FAILURE_MARKERS: Partial<Record<AgentRole, string>> = {
  design: DESIGN_TURN_FAILED_MARKER,
  research: RESEARCH_RUN_FAILED_MARKER,
  implement: IMPLEMENT_RUN_FAILED_MARKER,
};

/**
 * What a failure notice calls the issue a role's trigger label goes on, when
 * that isn't a PR (#479): an "issue" for any role not named here.
 */
const LABEL_HOMES: Partial<Record<AgentRole, string>> = {
  implement: "Ticket",
  research: "Decision",
};

/**
 * Which Infrastructure failure this was, from what the agent job left and how
 * it ended. The Run record classifies with it too, so the two never disagree.
 */
export function infrastructureFailureOf(run: Pick<FailedRun, "secretsStep" | "report" | "jobResult">): InfrastructureFailure {
  if (run.secretsStep === "failure") return "unreachable-1password";
  if (run.report !== null) return run.report.failure;
  return run.jobResult === "cancelled" ? "timeout" : "crash";
}

function howItFailed(failure: InfrastructureFailure, run: FailedRun, config: KitConfig): string {
  switch (failure) {
    case "timeout":
      // A cancelled job's own result doesn't say who cancelled it (#436).
      return `it was cancelled, by its ${(run.prototype === true ? prototypeRole(config.roles) : config.roles[run.role]).timeoutMinutes}-minute timeout or by hand`;
    case "unreachable-1password":
      return "its secrets couldn't be loaded from 1Password";
    case "crash":
      return "it crashed";
    case "missing-output":
      return run.role === "review" ? "the Reviewer gave no valid Verdict" : "the agent gave no valid output";
    case "provider-error":
      return "the model provider returned an error";
    case "dead-token": {
      // With rotation on, it names the Subscription whose vault item needs rotating.
      const subscription = subscriptionOfRun(run, config);
      const rotation = rotationIsOn(config);
      const token = refusedToken({ subscription, rotation });
      return `${token} was refused (\`authentication_failed\`), so ${rotation ? `its \`${subscription}\` vault item` : "it"} may need rotating`;
    }
    case "weekly-limit":
      return "it hit the weekly usage limit";
    case "metered-billing":
      return "the preflight found a route that would bill metered API usage, so it refused to start the agent";
    case "usage-credits":
      return `its stream showed usage credits being spent on the \`${subscriptionOfRun(run, config)}\` Subscription, so the Kit killed it`;
    case "unread-inputs":
      return run.report?.refused === true
        ? "GitHub refused a request in the Kit's input step, so the agent never started"
        : "a GitHub request failed in the Kit's input step, so the agent never started";
  }
}

/**
 * How the notice says to go on. GitHub refuses a refused input read again
 * each time the run goes again, so for that the Kit needs fixing first; a run
 * that hit the weekly limit waits for its reset, as the weekly-limit issue's
 * Steps say (#436); after any other failure, including an input read GitHub
 * failed or never answered, `resume` runs it again.
 */
function resumeAfter(failure: InfrastructureFailure, run: FailedRun, resume: string): string {
  const resumeMidSentence = `${resume.charAt(0).toLowerCase()}${resume.slice(1)}`;
  if (failure === "weekly-limit") {
    const resetsAt = run.report?.resetsAt;
    return `Once the weekly limit resets${resetsAt === undefined ? "" : ` at ${readable(resetsAt)}`}, ${resumeMidSentence}`;
  }
  if (failure !== "unread-inputs" || run.report?.refused !== true) return resume;
  return `GitHub refuses this request every time, so running it again won't help: the Kit needs fixing first. Once that fix is in, ${resumeMidSentence}`;
}

/**
 * With rotation on, the run a weekly-limit refusal holds rather than fails, or
 * null: a run of any role but the Auditor's or the Retro's, which are never
 * held, while no other Subscription is free.
 */
function heldOnRefusal(
  run: FailedRun,
  failure: InfrastructureFailure,
  { issue, kitIssues }: IssueContext,
  ranOn: RanOn,
): HoldableRun | null {
  if (!ranOn.rotation || !RERUN_FAILURES.includes(failure)) return null;
  // The tick can't start an Auditor or Retro run at the reset, so its issue fails, and the tick opens the next one.
  if (isWeeklyRole(run.role)) return null;
  // A kill or a dead token opens no weekly-limit issue, and only one can hold the run: with none open it fails as usual.
  if (failure !== "weekly-limit" && !canHold(kitIssues)) return null;
  if (anotherSubscriptionFree(kitIssues, ranOn)) return null;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? (issue.openPullRequests[0] ?? run.issue) : run.issue;
  return { role: run.role, issue: labelled, label: RESUME_LABELS[run.role] };
}

/**
 * One comment on the Ticket's PR if it has one, else the issue. It carries the
 * Operator's only @-mention, unless the failure stalls the whole repo: then a
 * Kit-owned issue does the notifying, once, and the comment points there.
 */
export function failureNotice(run: FailedRun, context: IssueContext, config: KitConfig): Plan {
  const { issue, operator } = context;
  const failure = infrastructureFailureOf(run);
  const ranOn = ranOnOf(run, config);
  const failedRun = run.prototype === true ? `The prototype turn on #${run.issue}` : `The ${runNamed(run.role)} on #${run.issue}`;
  const refused = heldOnRefusal(run, failure, context, ranOn);
  if (refused !== null) {
    // Its place in the order: a run held before, resumed and refused again, keeps the one it had.
    const [held = refused] = heldInOrder([refused], context.kitIssues);
    // A kill or a dead token says nothing of when a limit resets: the held run waits for the first weekly-limit issue's.
    const noResetOfItsOwn = failure !== "weekly-limit";
    const repoWide = repoWideNotice(failure, context, {
      run: failedRun,
      runUrl: run.runUrl,
      resetsAt: noResetOfItsOwn ? null : (run.report?.resetsAt ?? null),
      ...ranOn,
      ...(noResetOfItsOwn ? {} : { held }),
    });
    const holds = noResetOfItsOwn ? heldAfterKill(held, context.kitIssues) : holding(held, repoWide?.firstReset ?? null);
    return { kind: "act", actions: [...holds, ...waitingAgain(run, issue), ...(repoWide?.actions ?? [])] };
  }
  // The scheduled tick tries a failed Audit or Retro again, so there's no trigger label to re-add.
  if (isWeeklyRole(run.role)) {
    const how = howItFailed(failure, run, config);
    return failWeekly(run.role, context, {
      failure,
      how,
      runUrl: run.runUrl,
      resetsAt: run.report?.resetsAt ?? null,
      ranOn,
    });
  }
  // A failed conflict-only run (#304) isn't resumed: its PR goes to the Operator until main moves.
  if (run.conflict !== undefined && !(RERUN_FAILURES.includes(failure) && anotherSubscriptionFree(context.kitIssues, ranOn))) {
    const { pullRequest: conflicted, main } = run.conflict;
    const detail = run.report?.detail.trim() ?? "";
    return {
      kind: "act",
      actions: [
        { kind: "remove-label", issue: run.issue, label: RESUME_LABELS.implement },
        ...conflictRunEnded(conflicted, main, operator, `it failed, as an Infrastructure failure: ${howItFailed(failure, run, config)}${detail === "" ? "" : ` (${detail})`}`, run.runUrl),
      ],
    };
  }
  const pullRequest = issue.openPullRequests[0];
  const target = pullRequest ?? run.issue;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? target : run.issue;
  // The object the label goes on, by name, so it never lands on the wrong one (#479).
  const home = labelled === pullRequest ? "PR" : (LABEL_HOMES[run.role] ?? "issue");
  const where = labelled === target ? `this ${home}` : `the ${home} (#${labelled})`;
  // A Design-session turn has none to re-add: its issue keeps needs-design, and the Operator's reply starts it again.
  const label = run.role === "design" ? null : RESUME_LABELS[run.role];
  const resume =
    label !== null
      ? `Re-add \`${label}\` on ${where} to run it again.`
      : run.prototype === true
        ? CARRY_ON_AFTER_PROTOTYPE
        : "Reply on this issue to run the turn again.";
  const repoWide = repoWideNotice(failure, context, {
    run: failedRun,
    runUrl: run.runUrl,
    resetsAt: run.report?.resetsAt ?? null,
    ...ranOn,
  });
  // Another Subscription is free: the new Loop run's Kit job starts the run on it,
  // as an Infrastructure failure's resumption that never counts against retries.
  if (RERUN_FAILURES.includes(failure) && anotherSubscriptionFree(context.kitIssues, ranOn)) {
    const rerun = RESUME_LABELS[run.role];
    return {
      kind: "act",
      actions: [
        { kind: "remove-label", issue: labelled, label: rerun },
        // Before the label, whose Loop run reads it.
        ...waitingAgain(run, issue),
        { kind: "add-labels", issue: labelled, labels: [rerun] },
        ...(repoWide?.actions ?? []),
      ],
    };
  }
  const body = noticeBody({
    marker: target === run.issue || run.role === "implement" ? FAILURE_MARKERS[run.role] : undefined,
    mention: repoWide === null ? operator : null,
    failed: `${failedRun} failed: ${howItFailed(failure, run, config)}.`,
    detail: run.report?.detail ?? "",
    commits: run.report?.commits === undefined ? null : commitsLeft(run.report.commits),
    notRetried: notRetried(run.role),
    resume: resumeAfter(failure, run, resume),
    pointer: repoWide?.pointer ?? null,
    runUrl: run.runUrl,
  });
  return {
    kind: "act",
    actions: [
      // Off now, so that adding it back is a fresh label event that restarts the role.
      ...(label === null ? [] : [{ kind: "remove-label" as const, issue: labelled, label }]),
      { kind: "comment", issue: target, body },
      ...(repoWide?.actions ?? []),
    ],
  };
}

/**
 * For a prototype turn refused on its Subscription, which the Kit holds or
 * re-runs through agent:design (#155): its request marked waiting for its
 * prototype turn again, so agent:design starts that turn and not an ordinary
 * one (src/loop/design.ts). Nothing for any other run, nor once the request
 * is no longer pending.
 */
function waitingAgain(run: FailedRun, { pendingPrototype }: IssueContext["issue"]): Action[] {
  if (run.prototype !== true || pendingPrototype?.started !== true) return [];
  return [{ kind: "mark-prototype-request", issue: run.issue, comment: pendingPrototype.comment, started: false }];
}

/**
 * What a failure notice says of the commits a run had made on its branch
 * (#431). The push job never pushes them, so a re-run starts where this one
 * did: from the same commit on a branch it continued, or from the default
 * branch on one it cut, whose head may have moved since. The bundle the agent
 * job uploaded with its failure report keeps them for the Operator to fetch,
 * for that artifact's 7 days (loop.yml).
 */
function commitsLeft({ base, continued, head, kept }: FailedRunCommits): string {
  const from = continued ? `from \`${base.slice(0, 7)}\`` : "from the default branch";
  if (head === null) return `It made no commits, so running it again starts ${from}, as this run did.`;
  if (!kept) return `It had made commits before it failed, and they weren't kept, so running it again starts ${from} without them.`;
  return `It had made commits before it failed. They weren't pushed, so running it again starts ${from} without them; they're kept for 7 days as \`agent-branch.bundle\` in the run's \`fabrik-agent-failure\` artifact.`;
}

/**
 * What a failure notice says of retrying a run of this role. Only an
 * Implement run or a Review works on a Ticket, so only theirs names its
 * retries (#436). A research Decision has none to count against, and Dispatch
 * leaves it alone once its run failed.
 */
function notRetried(role: AgentRole): string {
  if (role === "implement" || role === "review") return "the Loop won't retry it and it doesn't count against the Ticket's retries";
  return role === "research" ? "neither the Loop nor Dispatch runs it again by itself" : NOT_RETRIED;
}

/** What a failure notice says of retrying a run on an issue that isn't a Ticket. */
const NOT_RETRIED = "the Loop won't retry it";

/** How a failed prototype turn's notice says to go on: it ends the session's pending request (src/github/threads.ts), so a reply starts an ordinary turn. */
const CARRY_ON_AFTER_PROTOTYPE = "Reply on this issue to carry the session on: the turn your reply starts can ask for the prototype again.";

/**
 * A prototype turn whose agent job passed but whose push job can't land what
 * it passed out (#155): its output breaks the contract, or its branch can't be
 * pushed. It is an Infrastructure failure all the same, so the Operator gets
 * the Design-session turn's failure notice, as when its agent job fails. The
 * notice ends the session's pending request, keeps the session's slot, and the
 * Operator's reply starts an ordinary turn. `how` says what went wrong.
 */
export function prototypeTurnRefused(issueNumber: number, operator: string, how: string, runUrl: string): Plan {
  const body = noticeBody({
    marker: DESIGN_TURN_FAILED_MARKER,
    mention: operator,
    failed: `The prototype turn on #${issueNumber} failed: ${how}.`,
    detail: "",
    commits: null,
    notRetried: NOT_RETRIED,
    resume: CARRY_ON_AFTER_PROTOTYPE,
    pointer: null,
    runUrl,
  });
  return { kind: "act", actions: [{ kind: "comment", issue: issueNumber, body }] };
}

/**
 * A failure notice's comment: the marker the snapshot reads back, if the role
 * has one; what failed and how, with the Operator's @-mention unless a
 * Kit-owned issue notifies instead; the agent's own word on it, quoted; what
 * the run had committed, if its report says; what the Loop does about it and
 * how to resume; where the Kit tracks a repo-wide stall; and the run.
 */
function noticeBody(notice: {
  readonly marker: string | undefined;
  readonly mention: string | null;
  readonly failed: string;
  readonly detail: string;
  readonly commits: string | null;
  readonly notRetried: string;
  readonly resume: string;
  readonly pointer: string | null;
  readonly runUrl: string;
}): string {
  const detail = notice.detail.trim();
  return [
    ...(notice.marker === undefined ? [] : [notice.marker]),
    `${notice.mention === null ? "" : `@${notice.mention} `}${notice.failed}`,
    ...(detail === "" ? [] : ["", `> ${detail}`]),
    ...(notice.commits === null ? [] : ["", notice.commits]),
    "",
    `This is an Infrastructure failure, so ${notice.notRetried}. ${notice.resume}`,
    ...(notice.pointer === null ? [] : ["", notice.pointer]),
    "",
    `[The run](${notice.runUrl})`,
  ].join("\n");
}
