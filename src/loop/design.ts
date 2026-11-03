// Design-session rules: when a turn starts, and how its output lands on the issue.
// Each turn rebuilds its context from the issue thread, so nothing is held here
// between turns beyond what the thread itself shows.
import type { SentBack } from "./backToDesign.ts";
import { dependencyOrder, parseDesignTurnOutput, type DesignTurnOutput, type SpecTicket } from "./designOutput.ts";
import { isCategoryLabel, type Label, NEEDS_DESIGN, READY_FOR_AGENT } from "./labels.ts";
import { designRoundMarker, LIVE_OUTCOME_MARKER, SESSION_FINISHED } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
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
    // A session that follows a Ticket's return opens by saying why it came back.
    const sentBack = round === 1 ? snapshot.issue.sentBack : null;
    return {
      kind: "act",
      actions: [{ kind: "comment", issue: issueNumber, body: roundComment(round, output, snapshot.operator, sentBack) }],
    };
  }
  // The Spec stays the single parent of its work: a Ticket under one splits into
  // siblings, and only an issue with no Spec above it gets a Spec of its own.
  const { parent } = snapshot.issue;
  if (output.kind === "spec" && parent !== null) {
    return wrongOutcome(issueNumber, `#${issueNumber} is a Ticket under the Spec #${parent}, so it splits into sibling Tickets, never a Spec of its own`);
  }
  if (output.kind === "split" && parent === null) {
    return wrongOutcome(issueNumber, `#${issueNumber} has no Spec above it, so it can't split into sibling Tickets; finish with a Spec instead`);
  }
  const landed =
    output.kind === "brief"
      ? rewriteAsBrief(issueNumber, output)
      : output.kind === "spec"
        ? supersedeBySpec(issueNumber, output, snapshot.issue)
        : splitIntoSiblings(issueNumber, output, snapshot.issue, parent ?? 0);
  // Every outcome leaves new ready work, so see whether it can start.
  return { kind: "act", actions: [...landed, { kind: "check-dispatch" }] };
}

/** An outcome the contract allows but this issue can't take: nothing changes, and the run fails. */
function wrongOutcome(issueNumber: number, why: string): Plan {
  return {
    kind: "fail",
    failure: "infrastructure",
    reason: `The Design-session turn on #${issueNumber} emitted output that breaks its contract: ${why}`,
  };
}

/**
 * A Ticket's split: its sibling Tickets as sub-issues of its own Spec,
 * blockers first, then the Ticket closes, superseded by them. A new Ticket
 * has no PR, so it starts on the Implementer's default model.
 */
function splitIntoSiblings(
  issueNumber: number,
  output: Extract<DesignTurnOutput, { kind: "split" }>,
  issue: IssueSnapshot,
  spec: number,
): Action[] {
  const { actions, created, moved } = ticketActions(output.tickets, readyLabels(issue), spec, issue);
  return [
    ...actions,
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    {
      kind: "close-as-superseded",
      issue: issueNumber,
      comment: [
        `${SESSION_FINISHED} This Ticket is split into `,
        ...commaList(created),
        `, sibling Tickets under the Spec #${spec}.\n\n${closingNote(output.comment)}`,
        ...moved,
      ],
    },
  ];
}

/**
 * The agent's closing comment, under the Kit's own "Design session finished."
 * line: without mentions, and without that line again if the agent wrote it.
 */
function closingNote(comment: string): string {
  return withoutMentions(comment.replace(/^\s*\*\*Design session finished\.\*\*\s*/, ""));
}

/** The labels a new Ticket gets: the issue's category, and ready-for-agent, so Intake never sends it to Triage. */
function readyLabels(issue: IssueSnapshot): Label[] {
  return [...issue.labels.filter(isCategoryLabel), READY_FOR_AGENT];
}

/**
 * Creates these Tickets under `parent`, blockers first so each blocked-by edge
 * points at an issue that exists. They take the superseded issue's place among
 * its blockers: a Ticket nothing else in the outcome blocks takes on the
 * issue's open blockers, and each open issue it blocked then waits on every
 * Ticket no other Ticket waits on, the ones that finish last. The issue's own
 * edges stay, recording what happened once it closes.
 */
function ticketActions(
  outcome: readonly SpecTicket[],
  labels: readonly Label[],
  parent: CreatedIssue | number,
  superseded: IssueSnapshot,
): { actions: Action[]; created: CreatedIssue[]; moved: (string | CreatedIssue)[] } {
  const ticketIssue = (key: string): CreatedIssue => ({ created: `ticket:${key}` });
  // The contract has already refused blockers that loop, so there is always an order.
  const tickets = dependencyOrder(outcome) ?? [];
  const waitedOn = new Set(tickets.flatMap((ticket) => ticket.blockedBy));
  const last = tickets.filter((ticket) => !waitedOn.has(ticket.key)).map((ticket) => ticketIssue(ticket.key));
  const first = tickets.filter((ticket) => ticket.blockedBy.length === 0).map((ticket) => ticketIssue(ticket.key));
  return {
    actions: [
      ...tickets.map(
        (ticket): Action => ({
          kind: "create-issue",
          key: ticketIssue(ticket.key).created,
          title: withoutMentions(ticket.title),
          body: withoutMentions(ticket.body),
          labels,
          parent,
          blockedBy: ticket.blockedBy.length === 0 ? superseded.openBlockers : ticket.blockedBy.map(ticketIssue),
        }),
      ),
      ...superseded.openBlocking.flatMap((issue) =>
        last.map((blocker): Action => ({ kind: "add-blocked-by", issue, blocker })),
      ),
    ],
    created: tickets.map((ticket) => ticketIssue(ticket.key)),
    moved: movedEdges(first, superseded.openBlockers, superseded.openBlocking, last),
  };
}

/**
 * For the closing comment: which blockers the first Tickets took on, and which
 * issues now wait on the last ones. Empty when nothing moved.
 */
function movedEdges(
  first: readonly CreatedIssue[],
  blockers: readonly number[],
  blocking: readonly number[],
  last: readonly CreatedIssue[],
): (string | CreatedIssue)[] {
  if (blockers.length === 0 && blocking.length === 0) return [];
  const issueLinks = (issues: readonly number[]) => issues.map((issue) => `#${issue}`).join(", ");
  return [
    "\n\nBlocked-by edges moved to the new Tickets:",
    ...(blockers.length === 0
      ? []
      : ["\n- ", ...commaList(first), ` ${first.length === 1 ? "is" : "are"} now blocked by ${issueLinks(blockers)}.`]),
    ...blocking.flatMap((issue) => [`\n- #${issue} is now blocked by `, ...commaList(last), "."]),
  ];
}

/** Created issues for a comment, separated by commas. */
function commaList(issues: readonly CreatedIssue[]): (string | CreatedIssue)[] {
  return issues.flatMap((issue, i) => (i === 0 ? [issue] : [", ", issue]));
}

/** The small outcome: the issue becomes its own agent brief, ready for an Implementer. */
function rewriteAsBrief(issueNumber: number, output: Extract<DesignTurnOutput, { kind: "brief" }>): Action[] {
  return [
    { kind: "edit-issue-body", issue: issueNumber, body: briefBody(output) },
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        `${SESSION_FINISHED} This issue is now its agent brief, ready for an Implementer.`,
        "",
        closingNote(output.comment),
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
  const labels = readyLabels(issue);
  const tickets = ticketActions(output.tickets, labels, SPEC, issue);
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
    ...tickets.actions,
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    {
      kind: "close-as-superseded",
      issue: issueNumber,
      comment: [
        `${SESSION_FINISHED} This issue is superseded by the Spec `,
        SPEC,
        ` and its ${tickets.created.length} ${tickets.created.length === 1 ? "Ticket" : "Tickets"}.\n\n${closingNote(output.comment)}`,
        ...tickets.moved,
      ],
    },
  ];
}


/** A round: the only Design-session text that notifies, through one @-mention of the Operator. */
function roundComment(
  round: number,
  output: Extract<DesignTurnOutput, { kind: "round" }>,
  operator: string,
  sentBack: SentBack | null,
): string {
  return [
    designRoundMarker(round),
    `@${operator} **Design session, round ${round}.** Reply with the numbers you'd answer differently, or \`yes\` to take every recommendation.`,
    ...(sentBack === null
      ? []
      : [
          "",
          sentBack.verdictUrl === null
            ? `This Ticket came back from #${sentBack.pullRequest}, which the Operator sent back to design from the Merge gate.`
            : `This Ticket came back from #${sentBack.pullRequest}, which the Kit closed unmerged after [its Verdict](${sentBack.verdictUrl}).`,
        ]),
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

/** Why a session on this issue can't take a turn now, or null when it can. */
function whileInSession(issueNumber: number, issue: IssueSnapshot): Plan | null {
  if (!issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  if (!issue.labels.includes(NEEDS_DESIGN)) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has ${NEEDS_DESIGN}` };
  }
  return null;
}
