// Failure notices: an agent run that fails for a reason outside the work is an
// Infrastructure failure. It's never retried and never counts against a
// Ticket's retries; the Operator gets one comment saying how to resume it.
// The exception is a Broken run (#434): an Implement run whose work the Kit
// can't land because of what the agent did. On a Ticket's first run or a
// Retry it's an Execution flaw the Kit gives, counted like an empty diff, and
// the Kit re-runs it itself; on a Request-changes or conflict-only run it uses
// no retry, and its notice, naming it a Broken run, waits for the Operator. A
// failed Auditor or Retro run fails its Audit or Retro instead, with no
// trigger to re-add, since the scheduled tick opens the next one
// (src/loop/weeklyRuns.ts). With rotation on, a
// run refused on its Subscription's weekly limit is re-run once, quietly,
// through its trigger label while another Subscription is free, so the
// Operator hears nothing. Once none is free it is held instead, with no
// failure comment (src/loop/heldRun.ts): only one quiet held line on its own
// issue or PR, edited when it resumes or is dropped (src/loop/heldLine.ts).
// A run killed for spending usage credits, or refused on a dead token, is
// re-run or held the same way, while
// its Subscription's usage-credits or token-rotation issue keeps the Kit off
// that Subscription (#433), held even with no weekly-limit issue open, its
// marker on a usage-credits or token-rotation issue (#470). An Auditor or Retro
// run is never re-run or held: the tick can't start one at a reset, so its
// Audit or Retro fails, for the tick to try again. A failed Digest run gets
// no failure notice at all: the no-Digest line says so on its PR, mentioning
// nobody (src/loop/digest.ts). It is never re-run or held either, though one
// refused on a weekly limit, killed for spending usage credits or refused a
// dead token still opens or updates that Kit-owned issue.
import { keptBranchOff } from "./backToDesign.ts";
import { conflictRunEnded } from "./conflicts.ts";
import { prototypeRole } from "./design.ts";
import { noDigestAfter } from "./digest.ts";
import { heldLineOn, heldRunName } from "./heldLine.ts";
import { heldInOrder, type HoldableRun, holding, RESUME_LABELS, runNamed } from "./heldRun.ts";
import { heldAfterKill, heldOn, heldUntilThen, startsWhen } from "./hold.ts";
import { anotherSubscriptionFree, refusedToken, repoWideNotice } from "./kitIssues.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import { BROKEN_RUN_MARKER, DESIGN_TURN_FAILED_MARKER, type HandBackMark, handBackMarker, IMPLEMENT_RUN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "./markers.ts";
import { readable } from "./readable.ts";
import { withoutMentions } from "./mentions.ts";
import { MAX_RETRIES, runInFlight, stepUpReasonFor } from "./retry.ts";
import { verdictActions } from "./review.ts";
import { type RanOn, ranOnOf, rotationIsOn, subscriptionOfRun } from "./subscriptions.ts";
import {
  type Action,
  type AgentRole,
  type BrokenRun,
  type FailedRunCommits,
  type InfrastructureFailure,
  isBrokenRun,
  type IssueContext,
  type KitConfig,
  type LoopEvent,
  type Plan,
  type PullRequestSnapshot,
} from "./types.ts";
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

/**
 * The Broken run an Implement run's failure was (#434), or null: a prototype
 * turn, a Review's missing Verdict and every other role's run stay
 * Infrastructure failures, as do a timeout, a crash and anything from the
 * provider, a credential or 1Password.
 */
export function brokenRunOf(run: Pick<FailedRun, "role" | "prototype">, failure: InfrastructureFailure): BrokenRun | null {
  return run.role === "implement" && run.prototype !== true && isBrokenRun(failure) ? failure : null;
}

function howItFailed(failure: InfrastructureFailure, run: FailedRun, config: KitConfig): string {
  switch (failure) {
    case "timeout": {
      const timeout = `${(run.prototype === true ? prototypeRole(config.roles) : config.roles[run.role]).timeoutMinutes}-minute timeout`;
      // The Review checks job gives up short of its timeout itself, naming what still ran.
      const running = run.report?.checks ?? [];
      if (running.length > 0) return `it stopped waiting for its required checks short of its ${timeout}, with ${checkNames(running)} still running`;
      // A cancelled job's own result doesn't say who cancelled it (#436).
      return `it was cancelled, by its ${timeout} or by hand`;
    }
    case "unreachable-1password":
      return "its secrets couldn't be loaded from 1Password";
    case "crash":
      return "it crashed";
    case "missing-output":
      return run.role === "review" ? "the Reviewer gave no valid Verdict" : `${run.role === "implement" ? "the Implementer" : "the agent"} gave no valid output`;
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
    case "unread-checks":
      return "it was still waiting for its required checks when a GitHub request failed";
    case "unlandable-branch":
      return `${run.role === "implement" ? "the Implementer" : "the agent"} built on commits its branch didn't start from, so the push job couldn't rebuild it`;
    case "left-branch":
      return `${run.role === "implement" ? "the Implementer" : "the agent"} left its branch, so its work couldn't be read off it`;
    case "unreported-checks": {
      const unreported = run.report?.checks ?? [];
      // A report that lost its check names still says what to look for, without naming one.
      if (unreported.length === 0) return "a Required check never reported on this PR; check the workflow names and `paths:` filters of the Required checks, those the default branch requires and those `sandbox.checks` lists";
      // Setup never takes a check off the branch, so dropping one from `sandbox.checks` alone won't stop the Review waiting on it (#565).
      const [checks, its, workflows, names, filters, it, itIs] =
        unreported.length === 1
          ? (["check", "its", "workflow's", "name", "filter", "it", "it's"] as const)
          : (["checks", "their", "workflows'", "names", "filters", "them", "they're"] as const);
      return `the Required ${checks} ${checkNames(unreported)} never reported on this PR; fix ${its} ${workflows} ${names} or \`paths:\` ${filters}, or take ${it} off the default branch's required list on github.com, and out of \`sandbox.checks\` too if ${itIs} listed there`;
    }
  }
}

/** Check names as a notice lists them: each in code, joined with commas and a last "and". */
function checkNames(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name.replace(/`/g, "'")}\``);
  const last = quoted.pop();
  return quoted.length === 0 ? (last ?? "") : `${quoted.join(", ")} and ${last}`;
}

/**
 * How the notice says to go on. GitHub refuses a refused input read again
 * each time the run goes again, so for that the Kit needs fixing first, and a
 * Required check that never reported needs its workflow or the Required
 * checks fixing; a run that hit the weekly limit waits for its reset, as the
 * weekly-limit issue's Steps say (#436); after any other failure, including an
 * input read GitHub failed or never answered, `resume` runs it again.
 */
function resumeAfter(failure: InfrastructureFailure, run: FailedRun, resume: string, timeZone: string | null): string {
  const resumeMidSentence = `${resume.charAt(0).toLowerCase()}${resume.slice(1)}`;
  if (failure === "weekly-limit") {
    const resetsAt = run.report?.resetsAt;
    return `Once the weekly limit resets${resetsAt === undefined ? "" : ` at ${readable(resetsAt, timeZone)}`}, ${resumeMidSentence}`;
  }
  // A check that never reported won't on a re-run either, until its workflow or the Required checks change (#454, #565).
  if (failure === "unreported-checks") return `Re-adding the \`${RESUME_LABELS[run.role]}\` label won't change this. After fixing the workflow or the Required checks, ${resumeMidSentence}`;
  if (failure !== "unread-inputs" || run.report?.refused !== true) return resume;
  return `GitHub refuses this request every time, so running it again won't help: the Kit needs fixing first. Once that fix is in, ${resumeMidSentence}`;
}

/**
 * With rotation on, the run a weekly-limit refusal, a kill for spending usage
 * credits or a dead token holds rather than fails, or null: a run of any role
 * but the Auditor's or the Retro's, which are never held, while no other
 * Subscription is free.
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
  if (anotherSubscriptionFree(kitIssues, ranOn)) return null;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? (issue.openPullRequests[0] ?? run.issue) : run.issue;
  // An Implement run on an agent PR, a Retry, Request-changes or conflict-only run, says it's held there (#471).
  const onPullRequest = run.role === "implement" ? (run.conflict?.pullRequest ?? issue.openPullRequests[0]) : undefined;
  return { role: run.role, issue: labelled, label: RESUME_LABELS[run.role], ...(onPullRequest === undefined ? {} : { lineOn: onPullRequest }) };
}

/**
 * One comment on the Ticket's PR if it has one, else the issue. It carries the
 * Operator's only @-mention, unless the failure stalls the whole repo: then a
 * Kit-owned issue does the notifying, once, and the comment points there.
 */
export function failureNotice(run: FailedRun, context: IssueContext, config: KitConfig, pullRequest: PullRequestSnapshot | null = null): Plan {
  const { issue, operator } = context;
  const failure = infrastructureFailureOf(run);
  const ranOn = ranOnOf(run, config);
  const failedRun = run.prototype === true ? `The prototype turn on #${run.issue}` : `The ${runNamed(run.role)} on #${run.issue}`;
  if (run.role === "digest") {
    // A Digest run's failure is said by the no-Digest line alone: no notice, no mention, nothing held or run again on another Subscription. The gate opens all the same.
    const landed = noDigestAfter(run, failure, pullRequest, operator);
    // One that stalls the whole repo still opens or updates its Kit-owned issue, as any run's does: that is how the Kit learns a Subscription is used up.
    const repoWide = repoWideNotice(failure, context, { run: failedRun, runUrl: run.runUrl, resetsAt: run.report?.resetsAt ?? null, ...ranOn, timeZone: config.timeZone });
    return landed.kind !== "act" || repoWide === null ? landed : { ...landed, actions: [...landed.actions, ...repoWide.actions] };
  }
  const refused = heldOnRefusal(run, failure, context, ranOn);
  if (refused !== null) {
    // Its place in the order: a run held before, resumed and refused again, keeps the one it had.
    const [held = refused] = heldInOrder([refused], context.kitIssues);
    // A kill or a dead token says nothing of when a limit resets: the held run waits on its carrier (src/loop/hold.ts).
    const noResetOfItsOwn = failure !== "weekly-limit";
    const repoWide = repoWideNotice(failure, context, {
      run: failedRun,
      runUrl: run.runUrl,
      resetsAt: noResetOfItsOwn ? null : (run.report?.resetsAt ?? null),
      ...ranOn,
      ...(noResetOfItsOwn ? {} : { held }),
      timeZone: config.timeZone,
    });
    const notice = [...waitingAgain(run, issue), ...(repoWide?.actions ?? [])];
    // The run's own issue or PR names it too, in one quiet line (#471).
    const name = heldRunName(run.role, run);
    if (noResetOfItsOwn) return { kind: "act", actions: heldAfterKill(held, context.kitIssues, notice, name, config.timeZone) };
    const firstReset = repoWide?.firstReset ?? null;
    // After the weekly-limit issue's own actions, since it may link the one they open.
    const line = repoWide?.heldOn === undefined ? [] : [heldLineOn(held, name, repoWide.heldOn, { until: firstReset, reset: true, timeZone: config.timeZone })];
    return { kind: "act", actions: [...holding(held, firstReset), ...notice, ...line] };
  }
  // The scheduled tick tries a failed Audit or Retro again, so there's no trigger label to re-add.
  if (isWeeklyRole(run.role)) {
    const how = howItFailed(failure, run, config);
    return failWeekly(run.role, context, {
      failure,
      how,
      runUrl: run.runUrl,
      resetsAt: run.report?.resetsAt ?? null,
      ranOn: { ...ranOn, timeZone: config.timeZone },
    });
  }
  const broken = brokenRunOf(run, failure);
  if (broken !== null && run.conflict === undefined) {
    const counted = brokenBeforePullRequest(run, failure, context, config) ?? brokenRetry(run, failure, context, config, pullRequest);
    if (counted !== null) return counted;
  }
  // A failed conflict-only run (#304) isn't resumed: its PR goes to the Operator until main moves.
  if (run.conflict !== undefined && !(RERUN_FAILURES.includes(failure) && anotherSubscriptionFree(context.kitIssues, ranOn))) {
    const { pullRequest: conflicted, main } = run.conflict;
    const detail = quotedDetail(run, failure);
    return {
      kind: "act",
      actions: [
        { kind: "remove-label", issue: run.issue, label: RESUME_LABELS.implement },
        ...conflictRunEnded(
          conflicted,
          main,
          operator,
          `${broken === null ? "it failed, as an Infrastructure failure" : "it was a Broken run"}: ${howItFailed(failure, run, config)}${detail === "" ? "" : ` (${detail})`}`,
          run.runUrl,
          true,
          failure,
        ),
      ],
    };
  }
  const open = issue.openPullRequests[0];
  const target = open ?? run.issue;
  // The review trigger lives on the PR; every other role's on the issue.
  const labelled = run.role === "review" ? target : run.issue;
  // The object the label goes on, by name, so it never lands on the wrong one (#479).
  const home = labelled === open ? "PR" : (LABEL_HOMES[run.role] ?? "issue");
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
    timeZone: config.timeZone,
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
    detail: quotedDetail(run, failure),
    commits: run.report?.commits === undefined ? null : commitsLeft(run.report.commits),
    failureKind: broken === null ? `This is an Infrastructure failure, so ${notRetried(run.role)}.` : freeBrokenRun(pullRequest),
    resume: resumeAfter(failure, run, resume, config.timeZone),
    pointer: repoWide?.pointer ?? null,
    runUrl: run.runUrl,
    handBack: { kind: handBackOfFailed(run.role, broken), role: run.role, failure, ...(run.role === "design" ? namedRun(run.runUrl) : {}) },
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
 * A Broken run (#434) on a Ticket with no PR yet, its first run or the Retry
 * after an empty diff or another Broken run: an Execution flaw the Kit gives
 * itself, from the same pool of Retries as empty diffs, so it re-runs it
 * quietly, the second Retry Stepped up, and once both are used the Ticket goes
 * back to design. Its comment mentions nobody and carries no failure marker,
 * so Dispatch doesn't hold the Ticket back (#535). The Retry starts where the
 * Broken run did, never from its commits. Null when the Ticket can't be built
 * now, so the run's notice waits for the Operator as before.
 */
function brokenBeforePullRequest(run: FailedRun, failure: InfrastructureFailure, { issue, kitIssues }: IssueContext, config: KitConfig): Plan | null {
  if (!issue.open || !issue.labels.includes(READY_FOR_AGENT) || issue.openPullRequests.length > 0) return null;
  const flaw = issue.landedNothing + 1;
  const held = heldOn(kitIssues, config);
  const opening = `The Implement run on #${run.issue} was a Broken run, and the Kit opened no PR: ${howItFailed(failure, run, config)}.`;
  const comment = (said: string): Action => ({
    kind: "comment",
    issue: run.issue,
    body: [BROKEN_RUN_MARKER, `${opening} ${said}`, ...brokenRunLines(run)].join("\n"),
  });
  // Off now, so the Retry's label is a fresh event.
  const staleOff: Action[] = issue.labels.includes(DISPATCH_LABEL) ? [{ kind: "remove-label", issue: run.issue, label: DISPATCH_LABEL }] : [];
  if (flaw > MAX_RETRIES) {
    return {
      kind: "act",
      actions: [
        ...staleOff,
        comment(`Both of the Ticket's Retries are used, so this Execution flaw counts as a Design flaw, and the Ticket goes back to design.`),
        { kind: "remove-label", issue: run.issue, label: READY_FOR_AGENT },
        // Back to design, so the Design session starts with the Kept-branch start mark off (#536).
        keptBranchOff(run.issue),
        // Starts a Design session, whose round 1 is this event's one notification.
        { kind: "add-labels", issue: run.issue, labels: [NEEDS_DESIGN] },
        { kind: "check-dispatch" },
      ],
    };
  }
  const steppedUp = stepUpReasonFor(flaw, issue.labels) === null ? "" : ", stepped up";
  return {
    kind: "act",
    actions: [
      ...staleOff,
      comment(`A Broken run is an Execution flaw: retry ${flaw} of ${MAX_RETRIES} ${startsWhen(held)}${steppedUp}.${heldUntilThen(held)}`),
      // A fresh label event, as Dispatch would add, starts the Retry in this run's own slot, where the Broken run started.
      { kind: "add-labels", issue: run.issue, labels: [DISPATCH_LABEL] },
    ],
  };
}

/**
 * A Broken run (#434) on a Retry: an Execution flaw Verdict on the PR, from
 * the Broken run, which counts toward the Ticket's two Retries like any other,
 * so it starts the next Retry, on the PR's head as it is, or sends the Ticket
 * back to design. Null for any run on the PR but a Retry.
 */
function brokenRetry(
  run: FailedRun,
  failure: InfrastructureFailure,
  { issue, operator, kitIssues }: IssueContext,
  config: KitConfig,
  pullRequest: PullRequestSnapshot | null,
): Plan | null {
  if (pullRequest === null || pullRequest.ticket !== run.issue || issue.openPullRequests[0] !== pullRequest.number) return null;
  if (runInFlight(pullRequest)?.kind !== "retry") return null;
  // Off now, so the next Retry's label is a fresh event.
  const staleOff: Action[] = issue.labels.includes(DISPATCH_LABEL) ? [{ kind: "remove-label", issue: run.issue, label: DISPATCH_LABEL }] : [];
  return {
    kind: "act",
    actions: [
      ...staleOff,
      ...verdictActions(
        { headSha: pullRequest.headSha, runUrl: run.runUrl },
        pullRequest,
        {
          verdict: "execution-flaw",
          source: "broken-run",
          findings: [`The Implementer's retry on #${pullRequest.number} was a Broken run: ${howItFailed(failure, run, config)}.`, ...brokenRunDetail(run)].join("\n"),
        },
        operator,
        heldOn(kitIssues, config),
      ),
    ],
  };
}

/**
 * What a Broken run's notice says when it uses no retry: on a Request-changes
 * run or a conflict-only run, or on a Ticket the Kit can't build now. It waits
 * for the Operator.
 */
function freeBrokenRun(pullRequest: PullRequestSnapshot | null): string {
  const on = pullRequest !== null && runInFlight(pullRequest)?.kind === "request-changes" ? " on a Request-changes run, which uses no retry," : " that uses no retry,";
  return `This is a Broken run${on} so the Loop won't run it again.`;
}

/** What a Broken run's comment or Verdict says after its opening: the agent job's detail, quoted, what it had committed, and the run. */
function brokenRunLines(run: FailedRun): string[] {
  return [...brokenRunDetail(run), "", `[The run](${run.runUrl})`];
}

/**
 * The agent job's detail on a failed run, as a notice quotes it: none for a
 * weekly limit whose reset is known, which the notice says itself in the
 * Operator's time zone, so a comment never shows the reset in two clocks.
 */
function quotedDetail(run: FailedRun, failure: InfrastructureFailure): string {
  return failure === "weekly-limit" && run.report?.resetsAt !== undefined ? "" : (run.report?.detail.trim() ?? "");
}

/**
 * The agent job's detail on a Broken run, quoted, and what it had committed,
 * which the next run doesn't start from. The detail can carry agent text, and
 * a counted Broken run mentions nobody, so no handle in it is a mention.
 */
function brokenRunDetail(run: FailedRun): string[] {
  const detail = withoutMentions(run.report?.detail.trim() ?? "");
  return [...(detail === "" ? [] : ["", `> ${detail}`]), ...(run.report?.commits === undefined ? [] : ["", commitsLeft(run.report.commits)])];
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
    failureKind: `This is an Infrastructure failure, so ${NOT_RETRIED}.`,
    resume: CARRY_ON_AFTER_PROTOTYPE,
    pointer: null,
    runUrl,
    handBack: { kind: "design-turn-failed", role: "design", ...namedRun(runUrl) },
  });
  return { kind: "act", actions: [{ kind: "comment", issue: issueNumber, body }] };
}

/**
 * A failure notice's comment: the marker the snapshot reads back, if the role
 * has one; what failed and how, with the Operator's @-mention unless a
 * Kit-owned issue notifies instead; the agent's own word on it, quoted; what
 * the run had committed, if its report says; whether it was an Infrastructure
 * failure or a Broken run, what the Loop does about it and how to resume; where the Kit tracks a repo-wide stall; and the run.
 */
function noticeBody(notice: {
  readonly marker: string | undefined;
  readonly mention: string | null;
  readonly failed: string;
  readonly detail: string;
  readonly commits: string | null;
  /** What kind of failure it was and what the Loop does about it, as one sentence. */
  readonly failureKind: string;
  readonly resume: string;
  readonly pointer: string | null;
  readonly runUrl: string;
  /** Which hand-back it is, on its hidden last line. */
  readonly handBack: HandBackMark;
}): string {
  const detail = notice.detail.trim();
  return [
    ...(notice.marker === undefined ? [] : [notice.marker]),
    `${notice.mention === null ? "" : `@${notice.mention} `}${notice.failed}`,
    ...(detail === "" ? [] : ["", `> ${detail}`]),
    ...(notice.commits === null ? [] : ["", notice.commits]),
    "",
    `${notice.failureKind} ${notice.resume}`,
    ...(notice.pointer === null ? [] : ["", notice.pointer]),
    "",
    `[The run](${notice.runUrl})`,
    handBackMarker(notice.handBack),
  ].join("\n");
}

/** The Actions run's address the Kit's job builds for itself (`…/actions/runs/<id>/attempts/<n>`), whose id is GITHUB_RUN_ID. */
const ACTIONS_RUN = /\/actions\/runs\/([1-9][0-9]*)(?:\/|$)/;

/**
 * The run a failed Design-session turn's notice names in its hidden line
 * (#640), so a reader never parses the visible link: the number of the run
 * whose address the push job built for itself, or nothing where the address
 * isn't an Actions run's.
 */
function namedRun(runUrl: string): Pick<HandBackMark, "run"> {
  const id = ACTIONS_RUN.exec(runUrl)?.[1];
  return id === undefined ? {} : { run: Number(id) };
}

/**
 * Which hand-back a failed run's notice is: a failed Design-session turn's or
 * Research run's own, else an Infrastructure failure, or a Broken run that
 * used no retry.
 */
function handBackOfFailed(role: AgentRole, broken: BrokenRun | null): HandBackMark["kind"] {
  if (role === "design") return "design-turn-failed";
  if (role === "research") return "research-failed";
  return broken === null ? "infrastructure-failure" : "broken-run-no-retry";
}
