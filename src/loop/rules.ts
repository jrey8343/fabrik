import { answerRound, applyTurn, startSession } from "./design.ts";
import { failureNotice } from "./failures.ts";
import { applyImplementation, startImplementer } from "./implement.ts";
import { KIT_ISSUE_LABELS, scheduledTick } from "./kitIssues.ts";
import {
  CATEGORY_LABELS,
  DISPATCH_LABEL,
  isWayfinderLabel,
  NEEDS_DESIGN,
  NEEDS_TRIAGE,
  STATE_LABELS,
} from "./labels.ts";
import { startAgentRun } from "./runs.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import { dispatch } from "./dispatch.ts";
import type { Action, IssueContext, IssueSnapshot, KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

/** The Loop rules core: decides what the Kit does about one Loop event. Pure, no I/O. */
export function planFor(event: LoopEvent, snapshot: Snapshot, config: KitConfig): Plan {
  switch (event.kind) {
    case "issue-opened":
      return withIssue(snapshot, ({ issue }) => intake(event.issue, issue));
    case "label-added":
      return withIssue(snapshot, (context) => labelAdded(event.issue, event.label, context, config));
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
        default:
          return { kind: "nothing", reason: `The Kit doesn't apply ${event.role} output yet` };
      }
    case "implement-run-finished":
      return withIssue(snapshot, (context) => applyImplementation(event, context));
    case "agent-run-failed":
      return withIssue(snapshot, (context) => failureNotice(event, context, config));
    // A closed issue may free a slot or unblock a Ticket.
    case "issue-closed":
      return { kind: "act", actions: [CHECK_DISPATCH] };
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

/** The adapter gathered the wrong snapshot for the event: fail rather than guess. */
function missingFromSnapshot(what: string): Plan {
  return { kind: "fail", failure: "infrastructure", reason: `The snapshot is missing ${what}` };
}

/** Adding needs-triage starts Triage, and adding needs-design starts a Design session. */
function labelAdded(issueNumber: number, label: string, context: IssueContext, config: KitConfig): Plan {
  if (label === NEEDS_DESIGN) return startSession(issueNumber, context, config);
  if (label === DISPATCH_LABEL) return startImplementer(issueNumber, context, config);
  if (label !== NEEDS_TRIAGE) {
    return { kind: "nothing", reason: `The Loop doesn't act on ${label} being added to #${issueNumber}` };
  }
  if (!context.issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  return startAgentRun("triage", issueNumber, config);
}

/** A new issue gets needs-triage unless something has already given it a place. */
function intake(issueNumber: number, issue: IssueSnapshot): Plan {
  const state = issue.labels.find((label) => STATE_LABELS.includes(label));
  if (state !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} already has the state label ${state}` };
  }
  const kitOwned = issue.labels.find((label) => KIT_ISSUE_LABELS.includes(label));
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
    actions: [{ kind: "add-labels", issue: issueNumber, labels: ["needs-triage"] }],
  };
}

/** A person's reply on a needs-info issue sends it back to Triage; a bot's never does. */
function replyOnNeedsInfo(
  { issue: issueNumber, commenter, commenterIsBot }: Extract<LoopEvent, { kind: "issue-comment-created" }>,
  issue: IssueSnapshot,
): Plan {
  if (!issue.labels.includes("needs-info")) {
    return { kind: "nothing", reason: `#${issueNumber} isn't in needs-info` };
  }
  if (commenterIsBot) {
    return { kind: "nothing", reason: `${commenter} is a bot, so its comment on #${issueNumber} doesn't restart Triage` };
  }
  return {
    kind: "act",
    actions: [
      { kind: "remove-label", issue: issueNumber, label: "needs-info" },
      { kind: "add-labels", issue: issueNumber, labels: ["needs-triage"] },
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
  if (!issue.labels.includes("needs-triage")) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has needs-triage, so Triage's output is stale` };
  }
  const staleCategories = issue.labels.filter(
    (label) => CATEGORY_LABELS.includes(label) && label !== output.category,
  );
  const added = [output.category, output.state].filter((label) => !issue.labels.includes(label));
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: issueNumber, body: triageComment(output, issue.author) },
      { kind: "remove-label", issue: issueNumber, label: "needs-triage" },
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
    case "ready-for-agent":
      return [CHECK_DISPATCH];
    // The assignment is ready-for-human's one notification.
    case "ready-for-human":
      return [{ kind: "assign", issue: issueNumber, assignee: operator }];
    case "wontfix":
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
  if (state === "needs-info") return `@${author}\n\n${comment}`;
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
