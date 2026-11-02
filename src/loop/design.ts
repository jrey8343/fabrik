// Design-session rules: when a turn starts, and how its output lands on the issue.
// Each turn rebuilds its context from the issue thread, so nothing is held here
// between turns beyond what the thread itself shows.
import { parseDesignTurnOutput, type DesignTurnOutput } from "./designOutput.ts";
import { NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import { startAgentRun } from "./runs.ts";
import type { KitConfig, Plan, Snapshot } from "./types.ts";

/** Adding needs-design starts the session's first round. */
export function startSession(issueNumber: number, { issue }: Snapshot, config: KitConfig): Plan {
  return whileInSession(issueNumber, issue) ?? startAgentRun("design", issueNumber, config);
}

/** The Operator's reply to a round starts the next turn; nobody else's comment does. */
export function answerRound(issueNumber: number, author: string, snapshot: Snapshot, config: KitConfig): Plan {
  if (author !== snapshot.operator) {
    return {
      kind: "nothing",
      reason: `@${author} isn't the Operator, so their comment on #${issueNumber} doesn't drive the Design session`,
    };
  }
  return whileInSession(issueNumber, snapshot.issue) ?? startAgentRun("design", issueNumber, config);
}

/** A finished turn posts the next round, or ends the session with its outcome. */
export function applyTurn(issueNumber: number, text: string, snapshot: Snapshot): Plan {
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
  return {
    kind: "act",
    actions: [
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
    ],
  };
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
function whileInSession(issueNumber: number, issue: Snapshot["issue"]): Plan | null {
  if (!issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  if (!issue.labels.includes(NEEDS_DESIGN)) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has ${NEEDS_DESIGN}` };
  }
  return null;
}
