import { auditGate } from "./auditGate.ts";
import { landAudit } from "./auditLanding.ts";
import { answerRound, applyTurn, startQueuedSession, startSession, turnStartFrom, whyNoPrototype } from "./design.ts";
import { failureNotice } from "./failures.ts";
import { implementJobTimeoutMinutes } from "../evidence/capture.ts";
import { checkConflicts, reviewGraceMinutes } from "./conflicts.ts";
import { applyImplementation, applyRetryImplementation, startImplementer } from "./implement.ts";
import {
  DESIGN_LABEL,
  DISPATCH_LABEL,
  isCategoryLabel,
  isKitIssueLabel,
  isStateLabel,
  isWayfinderLabel,
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
import { heldOf } from "./heldRun.ts";
import { scheduledTick } from "./kitIssues.ts";
import { resumingHeldRuns } from "./resume.ts";
import { heldOn, heldWhileUsedUp } from "./hold.ts";
import { mapCapOf } from "./mapCap.ts";
import { startResearcher } from "./research.ts";
import { landResearch } from "./researchLanding.ts";
import { applyPrototypeTurn } from "./prototypeLanding.ts";
import { startAgentRun } from "./runs.ts";
import { onChosenSubscription } from "./subscriptions.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import { checkDesignQueue } from "./designQueue.ts";
import { replayGate } from "./replayGate.ts";
import { landReplayRun, startReplay } from "./replayRun.ts";
import { retroGate } from "./retroGate.ts";
import { landRetro } from "./retroLanding.ts";
import { startWeekly, weeklyRoleOf } from "./weeklyRuns.ts";
import { dispatch } from "./dispatch.ts";
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
      return withIssue(snapshot, (context) => failureNotice(event, context, config));
    // A closed issue may finish its Spec, free a slot or unblock a Ticket, or end a
    // Design session by hand. Merging an agent PR closes its Ticket through
    // `Closes #n`, so it lands here.
    case "issue-closed":
      return withIssue(snapshot, ({ issue }) => ({
        kind: "act",
        actions: [...closeSpecAfter(issue, snapshot.spec), CHECK_DISPATCH, CHECK_DESIGN_QUEUE],
      }));
    // A push to an agent draft PR, or agent:review added to resume after a failure, starts a Review.
    case "pull-request-pushed":
      return withPullRequest(snapshot, (pullRequest) => startReview(pullRequest, config));
    case "pull-request-labeled":
      return withPullRequest(snapshot, (pullRequest) =>
        event.label === REVIEW_LABEL
          ? startReviewOnLabel(pullRequest, config)
          : event.label === NEEDS_DESIGN
            ? sendBackToDesign(pullRequest)
            : { kind: "nothing", reason: `The Loop doesn't act on ${event.label} being added to #${pullRequest.number}` },
      );
    case "required-checks-finished":
      return applyRedChecks(event, snapshot);
    case "review-run-finished":
      return applyReview(event, snapshot);
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
      return withPullRequest(snapshot, (pullRequest) => acknowledgeComment(event, pullRequest, snapshot.operator));
    // An agent PR that leaves draft or closes no longer holds a slot.
    case "pull-request-left-draft":
    case "pull-request-closed": {
      const { pullRequest } = snapshot;
      if (pullRequest === null) return missingFromSnapshot("the pull request");
      if (!pullRequest.isAgent) return { kind: "nothing", reason: `#${pullRequest.number} isn't an agent PR` };
      return { kind: "act", actions: [CHECK_DISPATCH] };
    }
    case "dispatch-check":
      return snapshot.dispatch === null
        ? missingFromSnapshot("the Tickets a Dispatch check weighs")
        : dispatch(snapshot.dispatch, config, {
            implement: heldOf("implement", snapshot.kitIssues),
            research: heldOf("research", snapshot.kitIssues),
          });
    case "design-queue-check":
      return snapshot.designQueue === null
        ? missingFromSnapshot("the needs-design issues a Design queue check weighs")
        : checkDesignQueue(snapshot.designQueue, config, heldOf("design", snapshot.kitIssues));
    // Main moved, so an agent PR at the Merge gate may now conflict with it (#304).
    case "main-pushed":
      return conflictCheck(snapshot, config);
    case "kit-config-changed":
      // max_in_flight or caps.design_sessions may have gone up, or from 0 back
      // above it, so see what can start now. It's a push to main too.
      return alongside({ kind: "act", actions: [CHECK_DISPATCH, CHECK_DESIGN_QUEUE] }, conflictCheck(snapshot, config));
    case "scheduled-tick":
      // The tick closes each weekly-limit issue after its reset, resuming the
      // runs held until then, and opens the week's pending Audit and pending
      // Retro when each is due. It also catches a Design session slot freed by
      // an event the Loop doesn't watch, such as needs-design coming off by hand.
      // It also takes the Replays' next step, and catches an agent PR left
      // conflicting with main that a push to main missed (#304).
      return thenCheckDesignQueue(scheduledTickWith([auditGate, retroGate, replayGate, conflictGate], event.now, snapshot, config));
  }
}

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };
const CHECK_DESIGN_QUEUE: Action = { kind: "check-design-queue" };

/** The plan, then a Design queue check once it has landed. */
function thenCheckDesignQueue(plan: Plan): Plan {
  switch (plan.kind) {
    case "act":
      return { kind: "act", actions: [...plan.actions, CHECK_DESIGN_QUEUE] };
    case "nothing":
      return { kind: "act", actions: [CHECK_DESIGN_QUEUE] };
    case "fail":
      return plan;
  }
}

/** The conflict check (src/loop/conflicts.ts) on the snapshot's conflict slice, which a push to main and the tick gather. */
function conflictCheck(snapshot: Snapshot, config: KitConfig): Plan {
  return snapshot.conflicts === null
    ? missingFromSnapshot("the open agent PRs a conflict check weighs")
    : checkConflicts(
        snapshot.conflicts,
        snapshot.operator,
        heldOn(snapshot.kitIssues, config),
        implementJobTimeoutMinutes(config.roles.implement.timeoutMinutes),
        reviewGraceMinutes(config.roles.review.timeoutMinutes),
      );
}

/** The conflict check as one of the tick's gates. */
function conflictGate(_now: string, snapshot: Snapshot, config: KitConfig): Plan {
  return conflictCheck(snapshot, config);
}

/** A gate the scheduled tick runs, the audit gate or the retro gate: what it opens this tick, or why it opens nothing. */
type TickGate = (now: string, snapshot: Snapshot, config: KitConfig) => Plan;

/**
 * The scheduled tick with these gates: closes each weekly-limit issue after
 * its reset, as scheduledTick does, and resumes held runs then, alongside
 * each gate's plan.
 */
function scheduledTickWith(gates: readonly TickGate[], now: string, snapshot: Snapshot, config: KitConfig): Plan {
  // With rotation on, a weekly-limit issue it closes resumes the held runs.
  const tick = resumingHeldRuns(scheduledTick(now, snapshot, config), snapshot, config);
  // A weekly-limit issue this tick closes after its reset no longer holds a gate back.
  const closing = actionsOf(tick).flatMap((action) => (action.kind === "close" ? [action.issue] : []));
  const kitIssues = snapshot.kitIssues.filter((issue) => !closing.includes(issue.number));
  return gates.reduce((plan, gate) => alongside(plan, gate(now, { ...snapshot, kitIssues }, config)), tick);
}

/** Both plans' actions, or why neither acts. */
function alongside(first: Plan, second: Plan): Plan {
  if (first.kind === "fail") return first;
  if (second.kind === "fail") return second;
  if (first.kind === "nothing" && second.kind === "nothing") {
    return { kind: "nothing", reason: `${first.reason}; ${second.reason}` };
  }
  return { kind: "act", actions: [...actionsOf(first), ...actionsOf(second)] };
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/** Decides an issue event, which needs the issue in the snapshot. */
function withIssue(snapshot: Snapshot, decide: (context: IssueContext) => Plan): Plan {
  const { issue, operator, kitIssues } = snapshot;
  return issue === null ? missingFromSnapshot("the issue") : decide({ issue, operator, kitIssues });
}

/** Decides a pull-request event, which needs the pull request in the snapshot. */
function withPullRequest(snapshot: Snapshot, decide: (pullRequest: PullRequestSnapshot) => Plan): Plan {
  return snapshot.pullRequest === null ? missingFromSnapshot("the pull request") : decide(snapshot.pullRequest);
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
 * it by hand.
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
  if (label !== NEEDS_TRIAGE) {
    return { kind: "nothing", reason: `The Loop doesn't act on ${label} being added to #${issueNumber}` };
  }
  if (!context.issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  return startAgentRun("triage", issueNumber, config);
}

/** Intake: a new issue gets needs-triage unless something has already given it a place. */
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
  if (issue.parent !== null) {
    return { kind: "nothing", reason: `#${issueNumber} is a sub-issue of #${issue.parent}, so a skill made it` };
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
  const staleCategories = issue.labels.filter(isCategoryLabel).filter((label) => label !== output.category);
  const added = [output.category, output.state].filter((label) => !issue.labels.includes(label));
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: issueNumber, body: triageComment(output, issue.author) },
      { kind: "remove-label", issue: issueNumber, label: NEEDS_TRIAGE },
      ...staleCategories.map((label) => ({ kind: "remove-label" as const, issue: issueNumber, label })),
      { kind: "add-labels", issue: issueNumber, labels: added },
      ...outcome(issueNumber, output, operator),
    ],
  };
}

/**
 * What each Triage state does beyond its labels and comment, so the issue has a
 * clear next step. needs-design and needs-info need nothing more.
 */
function outcome(issueNumber: number, { state, duplicateOf }: TriageOutput, operator: string): Action[] {
  switch (state) {
    // The Fast path made a Ticket ready, so see whether it can start.
    case READY_FOR_AGENT:
      return [CHECK_DISPATCH];
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
 * Triage's comment: addressed to the author on needs-info, and followed on the
 * Fast path by the agent brief the Implementer works to.
 */
function triageComment({ state, comment, brief, duplicateOf }: TriageOutput, author: string): string {
  // needs-info's one notification: the question reaches its author by @-mention.
  if (state === NEEDS_INFO) return `@${author}\n\n${comment}`;
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
