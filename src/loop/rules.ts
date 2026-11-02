import { failureNotice } from "./failures.ts";
import { KIT_ISSUE_LABELS, scheduledTick } from "./kitIssues.ts";
import { CATEGORY_LABELS, isWayfinderLabel, STATE_LABELS } from "./labels.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import type { Action, IssueEvent, IssueEventSnapshot, KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

/** The Loop rules core: decides what the Kit does about one Loop event. Pure, no I/O. */
export function planFor(event: LoopEvent, snapshot: Snapshot, config: KitConfig): Plan {
  if (event.kind === "scheduled-tick") return scheduledTick(event.now, snapshot);
  const { issue } = snapshot;
  if (issue === null) {
    return { kind: "fail", failure: "infrastructure", reason: `The snapshot for #${event.issue} holds no issue` };
  }
  return planForIssue(event, { ...snapshot, issue }, config);
}

function planForIssue(event: IssueEvent, snapshot: IssueEventSnapshot, config: KitConfig): Plan {
  switch (event.kind) {
    case "issue-opened":
      return intake(event.issue, snapshot);
    case "issue-comment-created":
      return replyOnNeedsInfo(event, snapshot);
    case "agent-run-finished":
      if (event.role !== "triage") {
        return { kind: "nothing", reason: `The Kit doesn't apply ${event.role} output yet` };
      }
      return applyTriage(event.issue, event.output, snapshot);
    case "agent-run-failed":
      return failureNotice(event, snapshot, config);
  }
}

/** A new issue gets needs-triage unless something has already given it a place. */
function intake(issueNumber: number, { issue }: IssueEventSnapshot): Plan {
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
  { issue }: IssueEventSnapshot,
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
function applyTriage(issueNumber: number, text: string, { issue, operator }: IssueEventSnapshot): Plan {
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
 * clear next step. The Fast path, needs-design and needs-info need nothing more.
 */
function outcome(issueNumber: number, { state }: TriageOutput, operator: string): Action[] {
  switch (state) {
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
