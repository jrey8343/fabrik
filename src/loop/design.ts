// Design-session rules: when a turn starts, and how its output lands on the issue.
// Each turn rebuilds its context from the issue thread, so nothing is held here
// between turns beyond what the thread itself shows.
import { dependencyOrder, parseDesignTurnOutput, type DesignTurnOutput } from "./designOutput.ts";
import { CATEGORY_LABELS, NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import { startAgentRun } from "./runs.ts";
import type { Action, CreatedIssue, IssueContext, IssueSnapshot, KitConfig, LoopEvent, Plan } from "./types.ts";

/** Adding needs-design starts the session's first round. */
export function startSession(issueNumber: number, { issue }: IssueContext, config: KitConfig): Plan {
  return whileInSession(issueNumber, issue) ?? startAgentRun("design", issueNumber, config);
}

/**
 * The Operator's reply to a round starts the next turn; nobody else's comment,
 * and no bot's, does. The Operator's comment that opens with a live outcome
 * marker instead lands what a live session decided.
 */
export function answerRound(
  { issue: issueNumber, commenter, commenterIsBot, body }: Extract<LoopEvent, { kind: "issue-comment-created" }>,
  snapshot: IssueContext,
  config: KitConfig,
): Plan {
  if (commenterIsBot) {
    return { kind: "nothing", reason: `@${commenter} is a bot, so its comment on #${issueNumber} doesn't drive the Loop` };
  }
  if (commenter !== snapshot.operator) {
    return {
      kind: "nothing",
      reason: `@${commenter} isn't the Operator, so their comment on #${issueNumber} doesn't drive the Design session`,
    };
  }
  const notNow = whileInSession(issueNumber, snapshot.issue);
  if (notNow !== null) return notNow;
  const live = LIVE_OUTCOME_MARKER.exec(body);
  return live?.[1] === undefined ? startAgentRun("design", issueNumber, config) : landLiveOutcome(issueNumber, live[1]);
}

/**
 * Opens the comment a live Design session ends with. A live session runs with
 * the Operator's own credentials in a cloud or local session, and has already
 * published its outcome: the issue rewritten as its agent brief, or the Spec and
 * its Tickets created. Only the start of a comment counts, so quoting it doesn't.
 */
const LIVE_OUTCOME_MARKER = /^<!-- fabrik:live-outcome (\S+) -->/;

/** The live session's outcome is already on GitHub, so the Kit only moves the issue on, as an async finish would. */
function landLiveOutcome(issueNumber: number, outcome: string): Plan {
  const leaveSession: Action = { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN };
  // Either outcome leaves new ready work, so see whether it can start.
  switch (outcome) {
    case "brief":
      return {
        kind: "act",
        actions: [leaveSession, { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_AGENT] }, { kind: "check-dispatch" }],
      };
    case "spec":
      // The Operator's comment already names the Spec that supersedes this issue.
      return {
        kind: "act",
        actions: [leaveSession, { kind: "close", issue: issueNumber, reason: "completed" }, { kind: "check-dispatch" }],
      };
    default:
      return {
        kind: "nothing",
        reason: `The live Design session on #${issueNumber} posted the outcome ${outcome}, which isn't brief or spec, so the Kit left the issue as it is`,
      };
  }
}

/** A finished turn posts the next round, or ends the session with its outcome. */
export function applyTurn(issueNumber: number, text: string, snapshot: IssueContext): Plan {
  const parsed = parseDesignTurnOutput(text);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Design-session turn on #${issueNumber} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const notNow = whileInSession(issueNumber, snapshot.issue);
  if (notNow !== null) return notNow;

  const { output } = parsed;
  if (output.kind === "round") {
    const round = snapshot.issue.designRounds + 1;
    return { kind: "act", actions: [{ kind: "comment", issue: issueNumber, body: roundComment(round, output, snapshot.operator) }] };
  }
  const landed =
    output.kind === "brief"
      ? rewriteAsBrief(issueNumber, output)
      : supersedeBySpec(issueNumber, output, snapshot.issue);
  // Either outcome leaves new ready work, so see whether it can start.
  return { kind: "act", actions: [...landed, { kind: "check-dispatch" }] };
}

/** The small outcome: the issue becomes its own agent brief, ready for an Implementer. */
function rewriteAsBrief(issueNumber: number, output: Extract<DesignTurnOutput, { kind: "brief" }>): Action[] {
  return [
    { kind: "edit-issue-body", issue: issueNumber, body: briefBody(output) },
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        "**Design session finished.** This issue is now its agent brief, ready for an Implementer.",
        "",
        withoutMentions(output.comment),
      ].join("\n"),
    },
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_AGENT] },
  ];
}

const SPEC: CreatedIssue = { created: "spec" };

/**
 * The large outcome: the Spec, then its Tickets as its sub-issues, blockers
 * first so each blocked-by edge points at an issue that exists. Both carry a
 * state label (and the Tickets a parent), so Intake never sends them to Triage.
 * The issue they came from closes, superseded by the Spec.
 */
function supersedeBySpec(
  issueNumber: number,
  output: Extract<DesignTurnOutput, { kind: "spec" }>,
  issue: IssueSnapshot,
): Action[] {
  const labels = [...issue.labels.filter((label) => CATEGORY_LABELS.includes(label)), READY_FOR_AGENT];
  const ticketIssue = (key: string): CreatedIssue => ({ created: `ticket:${key}` });
  // The contract has already refused blockers that loop, so there is always an order.
  const tickets = dependencyOrder(output.tickets) ?? [];
  return [
    {
      kind: "create-issue",
      key: SPEC.created,
      title: withoutMentions(output.spec.title),
      body: [
        withoutMentions(output.spec.body),
        "",
        `<sub>Written by the Fabrik Design session on #${issueNumber}, which this Spec supersedes.</sub>`,
      ].join("\n"),
      labels,
      parent: null,
      blockedBy: [],
    },
    ...tickets.map(
      (ticket): Action => ({
        kind: "create-issue",
        key: ticketIssue(ticket.key).created,
        title: withoutMentions(ticket.title),
        body: withoutMentions(ticket.body),
        labels,
        parent: SPEC,
        blockedBy: ticket.blockedBy.map(ticketIssue),
      }),
    ),
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    {
      kind: "close-as-superseded",
      issue: issueNumber,
      comment: [
        "**Design session finished.** This issue is superseded by the Spec ",
        SPEC,
        ` and its ${tickets.length} ${tickets.length === 1 ? "Ticket" : "Tickets"}.\n\n${withoutMentions(output.comment)}`,
      ],
    },
  ];
}

const ROUND_MARKER = /^<!-- fabrik:design-round (\d+) -->/;

/** Whether a comment is a round the Kit posted, so the next round can be numbered after it. */
export function isDesignRoundComment(body: string): boolean {
  return ROUND_MARKER.test(body);
}

/** A round: the only Design-session text that notifies, through one @-mention of the Operator. */
function roundComment(round: number, output: Extract<DesignTurnOutput, { kind: "round" }>, operator: string): string {
  return [
    `<!-- fabrik:design-round ${round} -->`,
    `@${operator} **Design session, round ${round}.** Reply with the numbers you'd answer differently, or \`yes\` to take every recommendation.`,
    "",
    withoutMentions(output.intro),
    ...output.questions.flatMap(({ question, recommendation }, i) => [
      "",
      `**${i + 1}. ${withoutMentions(question)}**`,
      `➡️ Recommended: ${withoutMentions(recommendation)}`,
    ]),
  ].join("\n");
}

function briefBody(output: Extract<DesignTurnOutput, { kind: "brief" }>): string {
  return [
    "## Agent brief",
    "",
    withoutMentions(output.brief.summary),
    "",
    "## Acceptance criteria",
    "",
    ...output.brief.acceptanceCriteria.map((criterion) => `- [ ] ${withoutMentions(criterion)}`),
    "",
    "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
  ].join("\n");
}

/**
 * Agent-written text never notifies anyone: a zero-width space after each `@`
 * that would start a mention keeps the text readable but unlinked.
 */
function withoutMentions(text: string): string {
  return text.replace(/(?<![\w`])@(?=[A-Za-z0-9])/g, "@​");
}

/** Why a session on this issue can't take a turn now, or null when it can. */
function whileInSession(issueNumber: number, issue: IssueSnapshot): Plan | null {
  if (!issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  if (!issue.labels.includes(NEEDS_DESIGN)) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has ${NEEDS_DESIGN}` };
  }
  return null;
}
