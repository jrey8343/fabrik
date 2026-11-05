// Design-session rules: when a turn starts, and how its output lands on the issue.
// Each turn rebuilds its context from the issue thread, so nothing is held here
// between turns beyond what the thread itself shows.
import type { SentBack } from "./backToDesign.ts";
import {
  dependencyOrder,
  parseDesignTurnOutput,
  type DesignTurnOutput,
  type OperatorBrief,
  type SpecTicket,
} from "./designOutput.ts";
import { isCategoryLabel, type Label, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN, WONTFIX } from "./labels.ts";
import { designRoundMarker, LIVE_OUTCOME_MARKER, SESSION_FINISHED } from "./markers.ts";
import { withoutMentions } from "./mentions.ts";
import type { AgentBrief } from "./triageOutput.ts";
import { startAgentRun } from "./runs.ts";
import type {
  Action,
  CreatedIssue,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  LoopEvent,
  Plan,
  StartingComment,
} from "./types.ts";

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
  return live?.[1] === undefined ? startAgentRun("design", issueNumber, config) : landLiveOutcome(issueNumber, live[1], snapshot.operator);
}


/** The live session's outcome is already on GitHub, so the Kit only moves the issue on, as an async finish would. */
function landLiveOutcome(issueNumber: number, outcome: string, operator: string): Plan {
  const leaveSession: Action = { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN };
  // A brief or a Spec leaves new ready work, so see whether it can start.
  switch (outcome) {
    case "brief":
      return {
        kind: "act",
        actions: [leaveSession, { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_AGENT] }, { kind: "check-dispatch" }],
      };
    case "operator-brief":
      // Only the Operator can do this work, so it waits for them, not Dispatch.
      return {
        kind: "act",
        actions: [
          leaveSession,
          { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_HUMAN] },
          { kind: "assign", issue: issueNumber, assignee: operator },
        ],
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

/**
 * What a turn knows of what started it: adding needs-design (the first round),
 * the Operator's reply as the snapshot found it, or a reply the snapshot
 * didn't check.
 */
export type TurnStart =
  | { readonly kind: "label" }
  | { readonly kind: "reply"; readonly comment: StartingComment }
  | { readonly kind: "unchecked-reply"; readonly comment: number };

/** Pairs the reply a turn's event names with what the snapshot found of it. */
export function turnStartFrom(comment: number | undefined, found: StartingComment | null): TurnStart {
  if (comment === undefined) return { kind: "label" };
  return found?.id === comment ? { kind: "reply", comment: found } : { kind: "unchecked-reply", comment };
}

/**
 * A finished turn posts the next round, or ends the session with its outcome.
 * A turn whose starting reply the Operator deleted posts nothing: it answered
 * a reply that is no longer there.
 */
export function applyTurn(issueNumber: number, text: string, snapshot: IssueContext, start: TurnStart): Plan {
  if (start.kind === "unchecked-reply") {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Design-session turn on #${issueNumber} was started by a reply (comment ${start.comment}) the push job didn't check is still there`,
    };
  }
  if (start.kind === "reply" && !start.comment.exists) {
    return {
      kind: "nothing",
      reason: `The Operator's reply that started this Design-session turn on #${issueNumber} (comment ${start.comment.id}) was deleted, so the turn posts nothing`,
    };
  }
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
  if (output.kind === "not-planned") {
    // Nothing new is ready, so there is nothing for Dispatch to check.
    return { kind: "act", actions: closeAsNotPlanned(issueNumber, output.comment, snapshot.issue.openBlocking) };
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
  // Every outcome but an Operator brief leaves new ready work, so see whether it can start.
  const checkDispatch: Action = { kind: "check-dispatch" };
  if (output.kind === "brief") {
    // Only the Operator can do an Operator brief's work, so it waits for them, not Dispatch.
    return "operator" in output.brief
      ? { kind: "act", actions: rewriteAsOperatorBrief(issueNumber, output.comment, output.brief, snapshot.operator) }
      : { kind: "act", actions: [...rewriteAsBrief(issueNumber, output.comment, output.brief), checkDispatch] };
  }
  const landed =
    output.kind === "spec"
      ? supersedeBySpec(issueNumber, output, snapshot.issue, snapshot.operator)
      : splitIntoSiblings(issueNumber, output, snapshot.issue, parent ?? 0, snapshot.operator);
  return { kind: "act", actions: [...landed, checkDispatch] };
}

/**
 * Nothing to build: the issue closes as not planned, with the session's
 * reasoning as its closing comment. Its work never lands, so the issues it
 * blocks stay blocked by it (src/loop/dispatch.ts); the comment says which.
 */
function closeAsNotPlanned(issueNumber: number, comment: string, blocking: readonly number[]): Action[] {
  const stillBlocked = blocking.map((issue) => `#${issue}`).join(", ");
  return [
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        `${SESSION_FINISHED} This issue won't be built, so the Kit closes it as not planned.`,
        "",
        closingNote(comment),
        ...(blocking.length === 0
          ? []
          : [
              "",
              `${stillBlocked} stay${blocking.length === 1 ? "s" : ""} blocked by it: an issue closed as not planned never lands its work, so Dispatch won't start ${blocking.length === 1 ? "it" : "them"} until the Operator removes the blocked-by edge.`,
            ]),
      ].join("\n"),
    },
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    { kind: "add-labels", issue: issueNumber, labels: [WONTFIX] },
    { kind: "close", issue: issueNumber, reason: "not_planned" },
  ];
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
  operator: string,
): Action[] {
  const { actions, created, moved } = ticketActions(output.tickets, issue, spec, operator);
  const allTickets = output.tickets.every((ticket) => !ticket.operator);
  return [
    ...actions,
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    {
      kind: "close-as-superseded",
      issue: issueNumber,
      comment: [
        `${SESSION_FINISHED} This Ticket is split into `,
        ...commaList(created),
        allTickets
          ? `, sibling Tickets under the Spec #${spec}.\n\n${closingNote(output.comment)}`
          : `: ${itemCount(output.tickets)}, siblings under the Spec #${spec}.\n\n${closingNote(output.comment)}`,
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

/**
 * The labels a new Ticket gets: the issue's category, and ready-for-agent, so
 * Intake never sends it to Triage. An Operator step gets ready-for-human instead.
 */
function readyLabels(issue: IssueSnapshot, state: typeof READY_FOR_AGENT | typeof READY_FOR_HUMAN = READY_FOR_AGENT): Label[] {
  return [...issue.labels.filter(isCategoryLabel), state];
}

/** `2 Tickets`, `1 Operator step`, or `2 Tickets and 1 Operator step`. */
function itemCount(tickets: readonly SpecTicket[]): string {
  const operatorSteps = tickets.filter((ticket) => ticket.operator).length;
  const counts = [
    count(tickets.length - operatorSteps, "Ticket", "Tickets"),
    count(operatorSteps, "Operator step", "Operator steps"),
  ].filter((part) => !part.startsWith("0 "));
  return counts.join(" and ");
}

/** `1 Ticket`, `2 Tickets`. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Steps as a GitHub task list, one unchecked box each. */
function taskList(steps: readonly string[]): string[] {
  return steps.map((step) => `- [ ] ${withoutMentions(step)}`);
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
  superseded: IssueSnapshot,
  parent: CreatedIssue | number,
  operator: string,
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
          // An Operator step is the Operator's, so it waits for them, assigned, never for an Implementer.
          ...(ticket.operator
            ? {
                body: [withoutMentions(ticket.body), "", "## Steps", "", ...taskList(ticket.steps)].join("\n"),
                labels: readyLabels(superseded, READY_FOR_HUMAN),
                assignees: [operator],
              }
            : { body: withoutMentions(ticket.body), labels: readyLabels(superseded) }),
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
function rewriteAsBrief(issueNumber: number, comment: string, brief: AgentBrief): Action[] {
  return [
    { kind: "edit-issue-body", issue: issueNumber, body: briefBody(brief) },
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        `${SESSION_FINISHED} This issue is now its agent brief, ready for an Implementer.`,
        "",
        closingNote(comment),
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
  operator: string,
): Action[] {
  const tickets = ticketActions(output.tickets, issue, SPEC, operator);
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
      labels: readyLabels(issue),
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
        ` and its ${itemCount(output.tickets)}.\n\n${closingNote(output.comment)}`,
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

/**
 * The small outcome for Operator work: the issue becomes its Operator brief,
 * assigned to the Operator, ready for a Pairing session. The assignment is
 * its one notification, so the comment mentions nobody.
 */
function rewriteAsOperatorBrief(issueNumber: number, comment: string, brief: OperatorBrief, operator: string): Action[] {
  return [
    {
      kind: "edit-issue-body",
      issue: issueNumber,
      body: [
        "## Operator brief",
        "",
        withoutMentions(brief.summary),
        "",
        "## Steps",
        "",
        ...taskList(brief.steps),
        "",
        "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
      ].join("\n"),
    },
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        `${SESSION_FINISHED} This issue is now an Operator brief, ready for a Pairing session.`,
        "",
        closingNote(comment),
      ].join("\n"),
    },
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_HUMAN] },
    { kind: "assign", issue: issueNumber, assignee: operator },
  ];
}

function briefBody(brief: AgentBrief): string {
  return [
    "## Agent brief",
    "",
    withoutMentions(brief.summary),
    "",
    "## Acceptance criteria",
    "",
    ...taskList(brief.acceptanceCriteria),
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
