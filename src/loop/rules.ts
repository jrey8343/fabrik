import { answerRound, applyTurn, startSession } from "./design.ts";
import { failureNotice } from "./failures.ts";
import { applyImplementation, applyRetryImplementation, startImplementer } from "./implement.ts";
import { scheduledTick } from "./kitIssues.ts";
import {
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
  REVIEW_LABEL,
  WONTFIX,
} from "./labels.ts";
import { requestChanges, sendBackToDesign } from "./mergeGate.ts";
import { closeSpecAfter } from "./specClosing.ts";
import { startAgentRun } from "./runs.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import { dispatch } from "./dispatch.ts";
import { applyRedChecks, applyReview, startReview } from "./review.ts";
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
  switch (event.kind) {
    case "issue-opened":
      return withIssue(snapshot, ({ issue }) => intake(event.issue, issue));
    case "label-added":
      return withIssue(snapshot, (context) => labelAdded(event.issue, event.label, context, snapshot.pullRequest, config));
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
          return withIssue(snapshot, (context) => applyTurn(event.issue, event.output, context));
      }
    case "implement-run-finished":
      // A retry lands on the PR it fixes; a first run opens one.
      return event.fixes === undefined
        ? withIssue(snapshot, (context) => applyImplementation(event, context))
        : applyRetryImplementation(event, snapshot);
    case "agent-run-failed":
      return withIssue(snapshot, (context) => failureNotice(event, context, config));
    // A closed issue may finish its Spec, free a slot or unblock a Ticket. Merging an
    // agent PR closes its Ticket through `Closes #n`, so it lands here.
    case "issue-closed":
      return withIssue(snapshot, ({ issue }) => ({
        kind: "act",
        actions: [...closeSpecAfter(issue, snapshot.spec), CHECK_DISPATCH],
      }));
    // A push to an agent draft PR, or agent:review added to resume after a failure, starts a Review.
    case "pull-request-pushed":
      return withPullRequest(snapshot, (pullRequest) => startReview(pullRequest, snapshot.operator, config));
    case "pull-request-labeled":
      return withPullRequest(snapshot, (pullRequest) =>
        event.label === REVIEW_LABEL
          ? startReview(pullRequest, snapshot.operator, config)
          : event.label === NEEDS_DESIGN
            ? sendBackToDesign(pullRequest)
            : { kind: "nothing", reason: `The Loop doesn't act on ${event.label} being added to #${pullRequest.number}` },
      );
    case "required-checks-finished":
      return applyRedChecks(event, snapshot);
    case "review-run-finished":
      return applyReview(event, snapshot);
    case "pull-request-changes-requested":
      return requestChanges(event, snapshot, config);
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
        : dispatch(snapshot.dispatch, config);
    case "kit-config-changed":
      // max_in_flight may have gone up, or from 0 back above it, so see what can start now.
      return { kind: "act", actions: [CHECK_DISPATCH] };
    case "scheduled-tick":
      return scheduledTick(event.now, snapshot);
  }
}

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };

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
 * Adding needs-triage starts Triage, adding needs-design starts a Design
 * session, and adding agent:implement starts (or resumes) an Implement run.
 */
function labelAdded(
  issueNumber: number,
  label: string,
  context: IssueContext,
  pullRequest: PullRequestSnapshot | null,
  config: KitConfig,
): Plan {
  if (label === NEEDS_DESIGN) return startSession(issueNumber, context, config);
  if (label === DISPATCH_LABEL) return startImplementer(issueNumber, context, pullRequest, config);
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
  const parsed = parseTriageOutput(text);
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
function outcome(issueNumber: number, { state }: TriageOutput, operator: string): Action[] {
  switch (state) {
    // The Fast path made a Ticket ready, so see whether it can start.
    case READY_FOR_AGENT:
      return [CHECK_DISPATCH];
    // The assignment is ready-for-human's one notification.
    case READY_FOR_HUMAN:
      return [{ kind: "assign", issue: issueNumber, assignee: operator }];
    case WONTFIX:
      return [{ kind: "close", issue: issueNumber, reason: "not_planned" }];
    default:
      return [];
  }
}

/**
 * Triage's comment: addressed to the author on needs-info, and followed on the
 * Fast path by the agent brief the Implementer works to.
 */
function triageComment({ state, comment, brief }: TriageOutput, author: string): string {
  // needs-info's one notification: the question reaches its author by @-mention.
  if (state === NEEDS_INFO) return `@${author}\n\n${comment}`;
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
