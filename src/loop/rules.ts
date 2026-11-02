import { answerRound, applyTurn, startSession } from "./design.ts";
import { CATEGORY_LABELS, isWayfinderLabel, NEEDS_DESIGN, NEEDS_TRIAGE, STATE_LABELS } from "./labels.ts";
import { startAgentRun } from "./runs.ts";
import { parseTriageOutput, type TriageOutput } from "./triageOutput.ts";
import type { KitConfig, LoopEvent, Plan, Snapshot } from "./types.ts";

/** The Loop rules core: decides what the Kit does about one Loop event. Pure, no I/O. */
export function planFor(event: LoopEvent, snapshot: Snapshot, config: KitConfig): Plan {
  switch (event.kind) {
    case "issue-opened":
      return intake(event.issue, snapshot);
    case "label-added":
      return labelAdded(event.issue, event.label, snapshot, config);
    case "issue-comment-created":
      return commentCreated(event, snapshot, config);
    case "agent-run-finished":
      switch (event.role) {
        case "triage":
          return applyTriage(event.issue, event.output, snapshot);
        case "design":
          return applyTurn(event.issue, event.output, snapshot);
      }
  }
}

/** Adding needs-triage starts Triage, and adding needs-design starts a Design session. */
function labelAdded(issueNumber: number, label: string, snapshot: Snapshot, config: KitConfig): Plan {
  if (label === NEEDS_DESIGN) return startSession(issueNumber, snapshot, config);
  if (label !== NEEDS_TRIAGE) {
    return { kind: "nothing", reason: `The Loop doesn't act on ${label} being added to #${issueNumber}` };
  }
  if (!snapshot.issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  return startAgentRun("triage", issueNumber, config);
}

/** A comment from a bot never drives the Loop; an Operator comment on a needs-design issue takes a turn. */
function commentCreated(
  event: Extract<LoopEvent, { kind: "issue-comment-created" }>,
  snapshot: Snapshot,
  config: KitConfig,
): Plan {
  const { issue: issueNumber, author } = event;
  if (event.authorIsBot) {
    return { kind: "nothing", reason: `@${author} is a bot, so its comment on #${issueNumber} doesn't drive the Loop` };
  }
  if (snapshot.issue.labels.includes(NEEDS_DESIGN)) return answerRound(issueNumber, author, snapshot, config);
  const state = snapshot.issue.labels.find((label) => STATE_LABELS.includes(label));
  const where = state === undefined ? "has no state label" : `is ${state}`;
  return { kind: "nothing", reason: `The Loop doesn't act on a comment on #${issueNumber} while it ${where}` };
}

/** A new issue gets needs-triage unless something has already given it a place. */
function intake(issueNumber: number, { issue }: Snapshot): Plan {
  const state = issue.labels.find((label) => STATE_LABELS.includes(label));
  if (state !== undefined) {
    return { kind: "nothing", reason: `#${issueNumber} already has the state label ${state}` };
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

/** Triage's sorting lands as its comment, then needs-triage swapped for a category and a state. */
function applyTriage(issueNumber: number, text: string, { issue }: Snapshot): Plan {
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
      { kind: "comment", issue: issueNumber, body: triageComment(output) },
      { kind: "remove-label", issue: issueNumber, label: "needs-triage" },
      ...staleCategories.map((label) => ({ kind: "remove-label" as const, issue: issueNumber, label })),
      { kind: "add-labels", issue: issueNumber, labels: added },
    ],
  };
}

/** Triage's comment, followed on the Fast path by the agent brief the Implementer works to. */
function triageComment({ comment, brief }: TriageOutput): string {
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
