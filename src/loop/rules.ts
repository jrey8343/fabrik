import { auditGate } from "./auditGate.ts";
import { landAudit } from "./auditLanding.ts";
import { answerRound, applyTurn, startQueuedSession, startSession, turnStartFrom, whyNoPrototype } from "./design.ts";
import { digestLabelOnIssue, issueLabelOnPullRequest, reviewLabelOnIssue } from "./declineTrigger.ts";
import { landDigest, startDigestOnLabel } from "./digest.ts";
import { failureNotice } from "./failures.ts";
import { checkConflicts } from "./conflicts.ts";
import { flakyCheckGate } from "./flakyChecks.ts";
import { applyImplementation, applyRetryImplementation, startImplementer } from "./implement.ts";
import {
  DESIGN_LABEL,
  DIGEST_LABEL,
  DISPATCH_LABEL,
  isCategoryLabel,
  isKitIssueLabel,
  isStateLabel,
  isWayfinderLabel,
  type Label,
  NEEDS_DESIGN,
  NEEDS_INFO,
  NEEDS_TRIAGE,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REPLAY_TRIGGER_LABEL,
  RESEARCH_LABEL,
  REVIEW_LABEL,
  WONTFIX,
} from "./labels.ts";
import { requestChanges, sendBackToDesign } from "./mergeGate.ts";
import { acknowledgeComment } from "./acknowledge.ts";
import { closeSpecAfter } from "./specClosing.ts";
import { closeAgentDraftsOf, stopTicketOf } from "./handClosing.ts";
import { heldOf } from "./heldRun.ts";
import { deadTickClosed, scheduledTick } from "./kitIssues.ts";
import { closeMergedTickets } from "./mergedTickets.ts";
import { resumingHeldRuns } from "./resume.ts";
import { heldOn, heldWhileUsedUp } from "./hold.ts";
import { mapCapOf } from "./mapCap.ts";
import { startResearcher } from "./research.ts";
import { landResearch } from "./researchLanding.ts";
import { applyPrototypeTurn } from "./prototypeLanding.ts";
import { startAgentRun } from "./runs.ts";
import { makesUnusable, onChosenSubscription } from "./subscriptions.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import { checkDesignQueue } from "./designQueue.ts";
import { recoveryWaits } from "./recoveryWaits.ts";
import { replayGate } from "./replayGate.ts";
import { landReplayRun, startReplay } from "./replayRun.ts";
import { retroGate } from "./retroGate.ts";
import { landRetro } from "./retroLanding.ts";
import { startWeekly, weeklyRoleOf } from "./weeklyRuns.ts";
import { dispatch } from "./dispatch.ts";
import { sweepStuckTriggers } from "./triggerSweep.ts";
import { applyRedChecks, applyReview, startReview, startReviewOnLabel } from "./review.ts";
import type {
  Action,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  LoopEvent,
  Plan,
  PullRequestSnapshot,
  Snapshot,
} from "./types.ts";

/** The Loop rules core: decides what the Kit does about one Loop event. Pure, no I/O. */
export function planFor(event: LoopEvent, snapshot: Snapshot, config: KitConfig): Plan {
  // Every run the Plan starts is given its Subscription here, whichever role it is,
  // or held, with rotation on, while every Subscription is used up.
  const planned = planOnAnySubscription(event, snapshot, config);
  // A Kit-owned issue the Plan closes, as the scheduled tick closes a weekly-limit
  // issue at its reset, no longer stands in the way of the runs it starts.
  const kitIssues = snapshot.kitIssues.filter((issue) => !closes(planned, issue.number));
  return onChosenSubscription(heldWhileUsedUp(planned, kitIssues, config), kitIssues, config);
}

function closes(plan: Plan, issue: number): boolean {
  return plan.kind === "act" && plan.actions.some((action) => action.kind === "close" && action.issue === issue);
}

/** What the Kit does about one Loop event, before the runs it starts are given a Subscription. */
function planOnAnySubscription(event: LoopEvent, snapshot: Snapshot, config: KitConfig): Plan {
  switch (event.kind) {
    case "issue-opened":
      // The App opens a pending Audit for the Auditor to fill in, and a pending
      // Retro for the Retro run, on roles.retro; Intake never sorts either.
      return withIssue(snapshot, (context) => {
        const weekly = weeklyRoleOf(context.issue);
        return weekly === null ? intake(event.issue, context.issue) : startWeekly(weekly, context, config);
      });
    case "label-added":
      return withIssue(snapshot, (context) => labelAdded(event.issue, event.label, context, snapshot, config));
    case "issue-comment-created":
      // A needs-design issue is in a Design session; a needs-info one waits on its author.
      return withIssue(snapshot, (context) =>
        context.issue.labels.includes(NEEDS_DESIGN)
          ? answerRound(event, context, config)
          : replyOnNeedsInfo(event, context.issue),
      );
    case "agent-run-finished":
      switch (event.role) {
        case "triage":
          return withIssue(snapshot, ({ issue, operator }) => applyTriage(event.issue, event.output, issue, operator));
        case "design":
          return withIssue(snapshot, (context) =>
            applyTurn(
              event.issue,
              event.output,
              context,
              turnStartFrom(event.startedBy, snapshot.startingComment),
              snapshot.openMaps === null ? null : mapCapOf(snapshot.openMaps, config),
              whyNoPrototype(config),
              event.operatorComments,
            ),
          );
      }
    case "implement-run-finished":
      // A retry lands on the PR it fixes; a first run opens one.
      return event.fixes === undefined
        ? withIssue(snapshot, (context) => applyImplementation(event, context, config))
        : applyRetryImplementation(event, snapshot, config);
    case "agent-run-failed":
      return withIssue(snapshot, (context) => failureNotice(event, context, config, snapshot.pullRequest));
    // A closed issue may finish its Spec, free a slot or unblock a Ticket, or end a
    // Design session by hand. Merging an agent PR closes its Ticket through
    // `Closes #n`, so it lands here. A closed Ticket's agent draft PR closes
    // too, and the Dispatch check then sees its slot free (#428). A closed
    // usage-credits, token-rotation or weekly-limit issue may free a
    // Subscription, so the held runs resume first, ahead of any newer Ticket
    // the Dispatch check would start (#439).
    case "issue-closed":
      return withIssue(snapshot, ({ issue }) => {
        const plan: Plan = {
          kind: "act",
          actions: [...closeAgentDraftsOf(issue), ...closeSpecAfter(issue, snapshot.spec), CHECK_DISPATCH, CHECK_DESIGN_QUEUE],
        };
        return makesUnusable(issue.labels) ? resumingHeldRuns(plan, snapshot, config, issue.number) : plan;
      });
    // A push to an agent draft PR, or agent:review added to resume after a failure, starts a Review.
    case "pull-request-pushed":
      return withPullRequest(snapshot, (pullRequest) => startReview(pullRequest, config));
    // A label that only starts something on an issue comes off a PR, saying where it goes (#479).
    case "pull-request-labeled":
      return withPullRequest(snapshot, (pullRequest) => {
        if (event.label === REVIEW_LABEL) return startReviewOnLabel(pullRequest, config);
        if (event.label === DIGEST_LABEL) return startDigestOnLabel(pullRequest, config);
        if (event.label === NEEDS_DESIGN) return sendBackToDesign(pullRequest);
        const misplaced = issueLabelOnPullRequest(event.label, pullRequest);
        return misplaced === null
          ? { kind: "nothing", reason: `The Loop doesn't act on ${event.label} being added to #${pullRequest.number}` }
          : { kind: "act", actions: misplaced };
      });
    case "required-checks-finished":
      return applyRedChecks(event, snapshot, config);
    case "review-run-finished":
      return applyReview(event, snapshot, config);
    case "digest-run-finished":
      return landDigest(event, snapshot);
    case "audit-run-finished":
      return withIssue(snapshot, (context) => landAudit(event, context, snapshot.namedPullRequests));
    case "retro-run-finished":
      return withIssue(snapshot, (context) => landRetro(event, context, config));
    case "research-run-finished":
      return withIssue(snapshot, (context) => landResearch(event, context));
    case "replay-run-finished":
      return withIssue(snapshot, (context) => landReplayRun(event, context, config));
    case "prototype-run-finished":
      return withIssue(snapshot, (context) => applyPrototypeTurn(event, context, snapshot.startingComment, config.preview));
    case "pull-request-changes-requested":
      return requestChanges(event, snapshot, config);
    // Context for the next run that reads the PR, never a trigger (ADR-0007).
    case "pull-request-commented":
      return withPullRequest(snapshot, (pullRequest) => acknowledgeComment(event, pullRequest, snapshot.operator, snapshot.reviewHasInlineComments));
    // An agent PR that leaves draft or closes no longer holds a slot.
    case "pull-request-left-draft":
      return withAgentPullRequest(snapshot, () => ({ kind: "act", actions: [CHECK_DISPATCH] }));
    // One closed unmerged by hand stops its Ticket first, so the Dispatch check
    // doesn't start it again (#428).
    case "pull-request-closed":
      return withAgentPullRequest(snapshot, (pullRequest) => ({
        kind: "act",
        actions: [...stopTicketOf(event, pullRequest, snapshot.operator), CHECK_DISPATCH],
      }));
    case "dispatch-check":
      return snapshot.dispatch === null
        ? missingFromSnapshot("the Tickets a Dispatch check weighs")
        : dispatch(snapshot.dispatch, config, {
            implement: heldOf("implement", snapshot.kitIssues),
            research: heldOf("research", snapshot.kitIssues),
          }, snapshot.operator);
    case "design-queue-check":
      return snapshot.designQueue === null
        ? missingFromSnapshot("the needs-design issues a Design queue check weighs")
        : checkDesignQueue(snapshot.designQueue, config, heldOf("design", snapshot.kitIssues));
    // Main moved, so an agent PR at the Merge gate may now conflict with it (#304).
    case "main-pushed":
      return conflictCheck(snapshot, config);
    case "kit-config-changed":
      // max_in_flight or caps.design_sessions may have gone up, or from 0 back
      // above it, so see what can start now. It's a push to main too. A
      // Subscription newly listed frees one, so the held runs resume first (#439).
      return resumingHeldRuns(
        alongside({ kind: "act", actions: [CHECK_DISPATCH, CHECK_DESIGN_QUEUE] }, conflictCheck(snapshot, config)),
        snapshot,
        config,
      );
    case "scheduled-tick":
      // The tick closes each weekly-limit issue after its reset, and resumes
      // the held runs whenever a Subscription is free (#439), and opens the week's pending Audit and pending
      // Retro when each is due. It also catches a Design session slot freed by
      // an event the Loop doesn't watch, such as needs-design coming off by hand.
      // It also takes the Replays' next step, and catches an agent PR left
      // conflicting with main that a push to main missed (#304), and counts back an
      // Execution flaw whose checks have since passed on its head (#462). And it runs a
      // Dispatch check, so a Ticket left waiting while every slot was full, or
      // marked ready by an event the Loop missed, starts within the hour (#418),
      // after it closes each Ticket GitHub left open once a PR of it merged (#543).
      // First of all it sweeps trigger labels with no run behind them (#419),
      // so a slot it frees can be filled by this tick's queue checks. Why each
      // part does nothing is a note, so the step summary says it whatever the
      // rest of the tick does.
      // Before all that, a Tick that runs at all closes its repo's Dead-tick issue (#461).
      return thenCheckQueues(
        alongside(
          withDeadTickClosed(event, snapshot, withReasonNoted(stuckTriggers(event.now, snapshot, config))),
          scheduledTickWith([mergedTicketsGate, auditGate, retroGate, replayGate, conflictGate, flakyCheckGate], event.now, snapshot, config),
        ),
      );
  }
}

/** The plan, after closing the repo's open Dead-tick issue, if one is open. */
function withDeadTickClosed(event: Extract<LoopEvent, { kind: "scheduled-tick" }>, snapshot: Snapshot, plan: Plan): Plan {
  const closing = deadTickClosed(event.now, event.release ?? null, snapshot);
  return closing.length === 0 ? plan : alongside({ kind: "act", actions: closing }, plan);
}

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };
const CHECK_DESIGN_QUEUE: Action = { kind: "check-design-queue" };

/** The plan, then a Dispatch check and a Design queue check once it has landed. */
function thenCheckQueues(plan: Plan): Plan {
  switch (plan.kind) {
    case "act":
      return { ...plan, actions: [...plan.actions, CHECK_DISPATCH, CHECK_DESIGN_QUEUE] };
    case "nothing":
      return { kind: "act", actions: [CHECK_DISPATCH, CHECK_DESIGN_QUEUE] };
    case "fail":
      return plan;
  }
}

/** The stuck-trigger sweep (src/loop/triggerSweep.ts) on the snapshot's trigger-sweep slice, which only the tick gathers. */
function stuckTriggers(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  return snapshot.triggers === null
    ? missingFromSnapshot("the trigger labels the stuck-trigger sweep weighs")
    : sweepStuckTriggers(now, snapshot.triggers, snapshot.operator, recoveryWaits(config).stuckTrigger);
}

/** The conflict check (src/loop/conflicts.ts) on the snapshot's conflict slice, which a push to main and the tick gather. */
function conflictCheck(snapshot: Snapshot, config: KitConfig): Plan {
  return snapshot.conflicts === null
    ? missingFromSnapshot("the open agent PRs a conflict check weighs")
    : checkConflicts(
        snapshot.conflicts,
        snapshot.operator,
        heldOn(snapshot.kitIssues, config),
        recoveryWaits(config),
        heldOf("implement", snapshot.kitIssues),
      );
}

/** The conflict check as one of the tick's gates. */
function conflictGate(_now: string, snapshot: Snapshot, config: KitConfig): Plan {
  return conflictCheck(snapshot, config);
}

/** Closing each Ticket GitHub left open after a PR of it merged (src/loop/mergedTickets.ts, #543), as one of the tick's gates. */
function mergedTicketsGate(_now: string, snapshot: Snapshot): Plan {
  return closeMergedTickets(snapshot);
}

/** A gate the scheduled tick runs, the audit gate or the retro gate: what it opens this tick, or why it opens nothing. */
type TickGate = (now: string, snapshot: Snapshot, config: KitConfig) => Plan;

/**
 * The scheduled tick with these gates: closes each weekly-limit issue after
 * its reset, as scheduledTick does, and resumes held runs whenever a
 * Subscription is free, alongside each gate's plan.
 */
function scheduledTickWith(gates: readonly TickGate[], now: string, snapshot: Snapshot, config: KitConfig): Plan {
  // With rotation on, a weekly-limit issue it closes, or a Subscription free already, resumes the held runs.
  const tick = resumingHeldRuns(scheduledTick(now, snapshot, config), snapshot, config);
  // A weekly-limit issue this tick closes after its reset no longer holds a gate back.
  const closing = actionsOf(tick).flatMap((action) => (action.kind === "close" ? [action.issue] : []));
  const kitIssues = snapshot.kitIssues.filter((issue) => !closing.includes(issue.number));
  return gates.reduce((plan, gate) => alongside(plan, withReasonNoted(gate(now, { ...snapshot, kitIssues }, config))), withReasonNoted(tick));
}

/** A part of the tick's plan, its reason for doing nothing kept as a note, which alongside would drop once another part acts. */
function withReasonNoted(plan: Plan): Plan {
  return plan.kind === "nothing" ? { kind: "act", actions: [], notes: [plan.reason] } : plan;
}

/**
 * Both plans' actions and notes, or why neither acts. A label the first
 * already adds to an issue the second doesn't add again: two adds would each
 * be a label event, and each start a run, as when the reset tick resumes a
 * held Request-changes run that its conflict gate, no longer seeing it held,
 * restarts too (#424).
 */
function alongside(first: Plan, second: Plan): Plan {
  if (first.kind === "fail") return first;
  if (second.kind === "fail") return second;
  if (first.kind === "nothing" && second.kind === "nothing") {
    return { kind: "nothing", reason: `${first.reason}; ${second.reason}` };
  }
  const earlier = actionsOf(first);
  const added = (issue: number, label: Label): boolean =>
    earlier.some((action) => action.kind === "add-labels" && action.issue === issue && action.labels.includes(label));
  const later = actionsOf(second).flatMap((action): Action[] => {
    if (action.kind !== "add-labels") return [action];
    const labels = action.labels.filter((label) => !added(action.issue, label));
    return labels.length === 0 ? [] : [{ ...action, labels }];
  });
  const notes = [...notesOf(first), ...notesOf(second)];
  return { kind: "act", actions: [...earlier, ...later], ...(notes.length === 0 ? {} : { notes }) };
}

function notesOf(plan: Plan): readonly string[] {
  return plan.kind === "act" ? (plan.notes ?? []) : [];
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/** Decides an issue event, which needs the issue in the snapshot. */
function withIssue(snapshot: Snapshot, decide: (context: IssueContext) => Plan): Plan {
  const { issue, operator, kitIssues, weeklyIssues } = snapshot;
  return issue === null ? missingFromSnapshot("the issue") : decide({ issue, operator, kitIssues, weeklyIssues });
}

/** Decides a pull-request event, which needs the pull request in the snapshot. */
function withPullRequest(snapshot: Snapshot, decide: (pullRequest: PullRequestSnapshot) => Plan): Plan {
  return snapshot.pullRequest === null ? missingFromSnapshot("the pull request") : decide(snapshot.pullRequest);
}

/** Decides a pull-request event only an agent PR holds a slot for. */
function withAgentPullRequest(snapshot: Snapshot, decide: (pullRequest: PullRequestSnapshot) => Plan): Plan {
  return withPullRequest(snapshot, (pullRequest) =>
    pullRequest.isAgent ? decide(pullRequest) : { kind: "nothing", reason: `#${pullRequest.number} isn't an agent PR` },
  );
}

/** The adapter gathered the wrong snapshot for the event: fail rather than guess. */
function missingFromSnapshot(what: string): Plan {
  return { kind: "fail", failure: "infrastructure", reason: `The snapshot is missing ${what}` };
}

/**
 * Adding needs-triage starts Triage; adding needs-design asks for a Design
 * queue check, whose agent:design starts the Design session's first turn
 * (agent:design re-added starts a refused turn again, or the prototype turn
 * a prototype request asks for, which `noPrototype` may rule out: see
 * startQueuedSession); adding agent:implement starts (or resumes) an
 * Implement run; and adding agent:research starts a Researcher run, whether
 * Dispatch added it to release a research Decision or the Operator re-added
 * it by hand; and adding ready-for-agent asks for a Dispatch check.
 * agent:review and agent:digest, which go on a PR, come off with one line saying so.
 */
function labelAdded(
  issueNumber: number,
  label: string,
  context: IssueContext,
  { pullRequest, replay }: Pick<Snapshot, "pullRequest" | "replay">,
  config: KitConfig,
): Plan {
  if (label === NEEDS_DESIGN) return startSession(issueNumber, context);
  if (label === DESIGN_LABEL) return startQueuedSession(issueNumber, context, config);
  if (label === DISPATCH_LABEL) return startImplementer(issueNumber, context, pullRequest, config);
  if (label === RESEARCH_LABEL) return startResearcher(issueNumber, context, config);
  if (label === REPLAY_TRIGGER_LABEL) return startReplay(issueNumber, context, replay?.issues ?? null);
  if (label === READY_FOR_AGENT) return checkDispatchWhenReady(issueNumber, context.issue);
  // agent:review starts a Review only on a PR, so it comes off an issue, saying where it goes (#479).
  if (label === REVIEW_LABEL) return { kind: "act", actions: reviewLabelOnIssue(issueNumber, context.issue.openPullRequests) };
  // Nor does agent:digest start the Digest writer anywhere but on a PR.
  if (label === DIGEST_LABEL) return { kind: "act", actions: digestLabelOnIssue(issueNumber, context.issue.openPullRequests) };
  if (label !== NEEDS_TRIAGE) {
    return { kind: "nothing", reason: `The Loop doesn't act on ${label} being added to #${issueNumber}` };
  }
  if (!context.issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  return startAgentRun("triage", issueNumber, config);
}

/**
 * A Ticket marked ready-for-agent by hand, such as one re-marked after a
 * refusal or a sub-issue that skipped Intake, asks for a Dispatch check (#418),
 * which weighs it with the rest. Triage marking it asks for one already, so the
 * Dispatch job's concurrency group absorbs the second.
 */
function checkDispatchWhenReady(issueNumber: number, issue: IssueSnapshot): Plan {
  if (!issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  return { kind: "act", actions: [CHECK_DISPATCH] };
}

/** Intake: a new issue gets needs-triage unless something has already given it a place, or it's a sub-issue, which gets one line saying which label to add instead. */
function intake(issueNumber: number, issue: IssueSnapshot): Plan {
  const state = issue.labels.find(isStateLabel);
  if (state !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} already has the state label ${state}` };
  }
  const kitOwned = issue.labels.find(isKitIssueLabel);
  if (kitOwned !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} has the label ${kitOwned}, so the Kit owns it` };
  }
  const wayfinder = issue.labels.find(isWayfinderLabel);
  if (wayfinder !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} has the label ${wayfinder}, so a skill made it` };
  }
  // A skill files a sub-issue with its state, so one with none was likely filed
  // by hand: it stays out of Triage, but one quiet line says which label to add,
  // or the Operator sees no Kit activity on it, ever (#478).
  if (issue.parent !== null) {
    return {
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: issueNumber,
          body: "Fabrik leaves a sub-issue alone, since a skill usually files them with their state. Add `needs-triage` for Triage to look at it, or a state label yourself.",
        },
      ],
    };
  }
  return {
    kind: "act",
    actions: [{ kind: "add-labels", issue: issueNumber, labels: [NEEDS_TRIAGE] }],
  };
}

/** A person's reply on a needs-info issue sends it back to Triage; a bot's never does. */
function replyOnNeedsInfo(
  { issue: issueNumber, commenter, commenterIsBot }: Extract<LoopEvent, { kind: "issue-comment-created" }>,
  issue: IssueSnapshot,
): Plan {
  if (!issue.labels.includes(NEEDS_INFO)) {
    return { kind: "nothing", reason: `#${issueNumber} isn't in needs-info` };
  }
  if (commenterIsBot) {
    return { kind: "nothing", reason: `${commenter} is a bot, so its comment on #${issueNumber} doesn't restart Triage` };
  }
  return {
    kind: "act",
    actions: [
      { kind: "remove-label", issue: issueNumber, label: NEEDS_INFO },
      { kind: "add-labels", issue: issueNumber, labels: [NEEDS_TRIAGE] },
    ],
  };
}

/** Triage's sorting lands as its comment, then needs-triage swapped for a category and a state. */
function applyTriage(issueNumber: number, text: string, issue: IssueSnapshot, operator: string): Plan {
  const parsed = parseTriageOutput(text, issueNumber);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `Triage on #${issueNumber} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const { output } = parsed;
  if (!issue.labels.includes(NEEDS_TRIAGE)) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has needs-triage, so Triage's output is stale` };
  }
  // An issue holds at most one state label, so any the Operator added while
  // Triage ran comes off too, or Design and Dispatch could both start (#423).
  const staleStates = issue.labels.filter(isStateLabel).filter((label) => label !== NEEDS_TRIAGE && label !== output.state);
  const staleCategories = issue.labels.filter(isCategoryLabel).filter((label) => label !== output.category);
  const added = [output.category, output.state].filter((label) => !issue.labels.includes(label));
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: issueNumber, body: triageComment(output, issue, operator) },
      { kind: "remove-label", issue: issueNumber, label: NEEDS_TRIAGE },
      ...[...staleStates, ...staleCategories].map((label) => ({ kind: "remove-label" as const, issue: issueNumber, label })),
      { kind: "add-labels", issue: issueNumber, labels: added },
      ...outcome(issueNumber, output, operator),
    ],
  };
}

/**
 * What each Triage state does beyond its labels and comment, so the issue has a
 * clear next step. needs-info needs nothing more.
 */
function outcome(issueNumber: number, { state, duplicateOf }: TriageOutput, operator: string): Action[] {
  switch (state) {
    // The Fast path made a Ticket ready, so see whether it can start.
    case READY_FOR_AGENT:
      return [CHECK_DISPATCH];
    // The Design queue passes over an issue Triage hasn't landed, so ask it
    // again now: needs-design added while Triage ran fires no event as it lands (#485).
    case NEEDS_DESIGN:
      return [CHECK_DESIGN_QUEUE];
    // The assignment is ready-for-human's one notification.
    case READY_FOR_HUMAN:
      return [{ kind: "assign", issue: issueNumber, assignee: operator }];
    // A duplicate closes as GitHub's own duplicate, the original named in the comment (#363).
    case WONTFIX:
      return [{ kind: "close", issue: issueNumber, reason: duplicateOf === null ? "not_planned" : "duplicate" }];
    default:
      return [];
  }
}

/**
 * Triage's comment: addressed to the author on needs-info, or to the Operator
 * when the App filed the issue as the Monitor (#425), and followed on the Fast
 * path by the agent brief the Implementer works to.
 */
function triageComment({ state, comment, brief, duplicateOf }: TriageOutput, issue: IssueSnapshot, operator: string): string {
  // needs-info's one notification: the question reaches its author by @-mention.
  // The App never answers, and a bot's reply never restarts Triage, so the
  // Monitor's issue asks the Operator.
  if (state === NEEDS_INFO) {
    return issue.byApp ? `@${operator} The Monitor filed this issue, so its question is yours.\n\n${comment}` : `@${issue.author}\n\n${comment}`;
  }
  if (duplicateOf !== null) return `${comment}\n\nClosing as a duplicate of #${duplicateOf}.`;
  if (brief === null) return comment;
  return [
    comment,
    "",
    "## Agent brief",
    "",
    brief.summary,
    "",
    "### Acceptance criteria",
    "",
    ...brief.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
  ].join("\n");
}
