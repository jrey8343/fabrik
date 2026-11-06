// Design-session rules: when a turn starts, and how its output lands on the issue.
// Each turn rebuilds its context from the issue thread, so nothing is held here
// between turns beyond what the thread itself shows.
import type { SentBack } from "./backToDesign.ts";
import { withCarriedLines } from "./carriedLines.ts";
import { consideredSection } from "./considered.ts";
import {
  dependencyOrder,
  parseDesignTurnOutput,
  type DesignTurnOutput,
  type OperatorBrief,
  type SpecTicket,
} from "./designOutput.ts";
import {
  DESIGN_LABEL,
  decisionLabel,
  isCategoryLabel,
  type Label,
  MAP_LABEL,
  MONITOR_LABEL,
  NEEDS_DESIGN,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  WONTFIX,
} from "./labels.ts";
import {
  DECISIONS_SO_FAR_HEADING,
  DESIGN_TURN_FAILED_MARKER,
  designRoundMarker,
  LIVE_OUTCOME_MARKER,
  type MonitorMarker,
  monitorMarkerIn,
  monitorMarkerLine,
  prototypeRequestMarker,
  SESSION_FINISHED,
} from "./markers.ts";
import { spelled } from "./readable.ts";
import type { MapCap } from "./mapCap.ts";
import { withoutMentions } from "./mentions.ts";
import type { AgentBrief } from "./triageOutput.ts";
import { startAgentRun } from "./runs.ts";
import type {
  Action,
  CreatedIssue,
  GivenOperatorComment,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  LoopEvent,
  Plan,
  StartingComment,
} from "./types.ts";

/**
 * Adding needs-design, by any route, asks the Design queue check for the
 * session's first round (#147): a first turn only starts through the queue
 * check, which holds the issue silently while the cap is full.
 */
export function startSession(issueNumber: number, { issue }: IssueContext): Plan {
  return whileInSession(issueNumber, issue) ?? { kind: "act", actions: [CHECK_DESIGN_QUEUE] };
}

/** Run a Design queue check once the plan has landed, so a waiting issue can take a slot. */
const CHECK_DESIGN_QUEUE: Action = { kind: "check-design-queue" };

/**
 * agent:design, which the Design queue check adds when a slot frees up, starts
 * the session's first turn. The Kit also re-adds it to start a turn refused on
 * its Subscription's weekly limit again, on the next free one, whichever round
 * it was (src/loop/failures.ts). The label comes off as the turn starts, so
 * the running turn and then its round hold the slot, not the label. It always
 * comes off, so it never holds a slot for a session that can't start.
 */
export function startQueuedSession(issueNumber: number, { issue }: IssueContext, config: KitConfig): Plan {
  const removeLabel: Action = { kind: "remove-label", issue: issueNumber, label: DESIGN_LABEL };
  if (whileInSession(issueNumber, issue) !== null) return { kind: "act", actions: [removeLabel] };
  return { kind: "act", actions: [removeLabel, ...startAgentRun("design", issueNumber, config).actions] };
}

/**
 * The Operator's reply to a round starts the next turn; nobody else's comment,
 * and no bot's, does. The Operator's comment that opens with a live outcome
 * marker instead lands what a live session decided, even on a waiting issue.
 * Only an issue that holds a Design session slot, by its first turn having
 * started, a posted round or a failed turn, starts a turn: on any other, the
 * queue check starts round 1, which reads the whole thread, so the comment is
 * context (#147, in the spirit of ADR-0007). A turn started while round 1's is
 * still running waits behind it, so it reads round 1 and the comment.
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
  if (live?.[1] !== undefined) return landLiveOutcome(issueNumber, live[1], snapshot.operator);
  const { designRounds, turnFailed, firstTurnClaimed } = snapshot.issue;
  if (designRounds === 0 && !turnFailed && !firstTurnClaimed) {
    return {
      kind: "nothing",
      reason: `#${issueNumber} holds no Design session slot yet, so the Operator's comment is context for its round 1, not a turn of its own`,
    };
  }
  return startAgentRun("design", issueNumber, config);
}


/**
 * The live session's outcome is already on GitHub, so the Kit only moves the
 * issue on, as an async finish would. Each outcome ends the session and frees
 * its slot, so it asks for a Design queue check.
 */
function landLiveOutcome(issueNumber: number, outcome: string, operator: string): Plan {
  const leaveSession: Action = { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN };
  // A brief, a Spec or a Map leaves new ready work, so see whether it can start.
  switch (outcome) {
    case "brief":
      return {
        kind: "act",
        actions: [
          leaveSession,
          { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_AGENT] },
          { kind: "check-dispatch" },
          CHECK_DESIGN_QUEUE,
        ],
      };
    case "operator-brief":
      // Only the Operator can do this work, so it waits for them, not Dispatch.
      return {
        kind: "act",
        actions: [
          leaveSession,
          { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_HUMAN] },
          { kind: "assign", issue: issueNumber, assignee: operator },
          CHECK_DESIGN_QUEUE,
        ],
      };
    case "spec":
      // The Operator's comment already names the Spec that supersedes this issue.
      return {
        kind: "act",
        actions: [leaveSession, { kind: "close", issue: issueNumber, reason: "completed" }, { kind: "check-dispatch" }, CHECK_DESIGN_QUEUE],
      };
    case "map":
      // The live session rewrote the body as the Map and filed its first
      // Decisions before posting the marker, so only the labels move here.
      return {
        kind: "act",
        actions: [
          leaveSession,
          { kind: "add-labels", issue: issueNumber, labels: [MAP_LABEL] },
          { kind: "check-dispatch" },
          CHECK_DESIGN_QUEUE,
        ],
      };
    default:
      return {
        kind: "nothing",
        reason: `The live Design session on #${issueNumber} posted the outcome ${outcome}, which isn't brief, operator-brief, spec or map, so the Kit left the issue as it is`,
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
 * Why a turn can't ask for a Prototype in this Kit, or null when it can:
 * UI prototypes are dormant until switched on (#282).
 */
export function whyNoPrototype(_config: Pick<KitConfig, "ui">, switchedOn: boolean): string | null {
  if (!switchedOn) return "Prototypes are off in this Kit, so a turn can't ask for one";
  return null;
}

/**
 * A finished turn posts the next round, or ends the session with its outcome.
 * A turn whose starting reply the Operator deleted posts nothing: it answered
 * a reply that is no longer there. A Map is weighed against `mapCap`, the
 * Map cap over the open Maps the snapshot holds, and a Prototype is refused
 * for `noPrototype`, why this Kit can't take one, when that isn't null.
 * Whichever comment it posts ends with the Operator comments it weighed,
 * among those on the PR it came back from that it was `given` (ADR-0007).
 */
export function applyTurn(
  issueNumber: number,
  text: string,
  snapshot: IssueContext,
  start: TurnStart,
  mapCap: MapCap | null,
  noPrototype: string | null,
  given: readonly GivenOperatorComment[] = [],
): Plan {
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
  const plan = landTurn(issueNumber, parsed.output, snapshot, mapCap, noPrototype);
  if (plan.kind !== "act") return plan;
  const considered = consideredSection(parsed.output.operatorCommentsConsidered ?? [], given);
  return considered.length === 0 ? plan : { ...plan, actions: plan.actions.map((action) => endedWith(action, considered)) };
}

/** The turn's one comment on the issue (a round or a closing comment), ended with `lines`; any other action as it is. */
function endedWith(action: Action, lines: readonly string[]): Action {
  const tail = lines.join("\n");
  if (action.kind === "comment") return { ...action, body: `${action.body}\n${tail}` };
  if (action.kind === "comment-linking") return { ...action, body: [...action.body, `\n${tail}`] };
  if (action.kind === "close-as-superseded") return { ...action, comment: [...action.comment, `\n${tail}`] };
  return action;
}

function landTurn(
  issueNumber: number,
  output: DesignTurnOutput,
  snapshot: IssueContext,
  mapCap: MapCap | null,
  noPrototype: string | null,
): Plan {
  const notNow = whileInSession(issueNumber, snapshot.issue);
  if (notNow !== null) return notNow;

  if (output.kind === "round") {
    const round = snapshot.issue.designRounds + 1;
    // A session that follows a Ticket's return opens by saying why it came back.
    const sentBack = round === 1 ? snapshot.issue.sentBack : null;
    return {
      kind: "act",
      actions: [{ kind: "comment", issue: issueNumber, body: roundComment(round, output, snapshot.operator, sentBack) }],
    };
  }
  if (output.kind === "prototype") {
    return noPrototype === null ? { kind: "act", actions: requestPrototype(issueNumber, output) } : wrongOutcome(issueNumber, noPrototype);
  }
  if (output.kind === "prototype-round") {
    return wrongOutcome(issueNumber, "only a prototype turn ends in a prototype-round, and this was an ordinary turn");
  }
  // Every outcome but a round ends the session and frees its slot, so the next waiting issue can start.
  if (output.kind === "not-planned") {
    // Nothing new is ready, so there is nothing for Dispatch to check.
    return { kind: "act", actions: [...closeAsNotPlanned(issueNumber, output.comment, snapshot.issue.openBlocking), CHECK_DESIGN_QUEUE] };
  }
  // The Spec stays the single parent of its work: a Ticket under one splits into
  // siblings, and only an issue with no Spec above it gets a Spec, or a Map, of its own.
  const { parent } = snapshot.issue;
  if ((output.kind === "spec" || output.kind === "map") && parent !== null) {
    const own = output.kind === "spec" ? "a Spec" : "a Map";
    return wrongOutcome(issueNumber, `#${issueNumber} is a Ticket under the Spec #${parent}, so it splits into sibling Tickets, never ${own} of its own`);
  }
  if (output.kind === "split" && parent === null) {
    return wrongOutcome(issueNumber, `#${issueNumber} has no Spec above it, so it can't split into sibling Tickets; finish with a Spec instead`);
  }
  // Every outcome but an Operator brief leaves new ready work, so see whether it can start.
  const checkDispatch: Action = { kind: "check-dispatch" };
  if (output.kind === "map") {
    if (mapCap === null) return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the open Maps" };
    // The cap holds even when the turn ignored what its inputs said of it.
    if (mapCap.kind === "full") return heldByMapCap(issueNumber, mapCap);
    // A Map's research Decisions are work the Researcher can start on its own.
    return { kind: "act", actions: [...chartAsMap(issueNumber, output, snapshot.issue), checkDispatch, CHECK_DESIGN_QUEUE] };
  }
  if (output.kind === "brief") {
    // Only the Operator can do an Operator brief's work, so it waits for them, not Dispatch.
    return "operator" in output.brief
      ? {
          kind: "act",
          actions: [...rewriteAsOperatorBrief(issueNumber, output.comment, output.brief, snapshot.issue, snapshot.operator), CHECK_DESIGN_QUEUE],
        }
      : { kind: "act", actions: [...rewriteAsBrief(issueNumber, output.comment, output.brief, snapshot.issue), checkDispatch, CHECK_DESIGN_QUEUE] };
  }
  const landed =
    output.kind === "spec"
      ? supersedeBySpec(issueNumber, output, snapshot.issue, snapshot.operator)
      : splitIntoSiblings(issueNumber, output, snapshot.issue, parent ?? 0, snapshot.operator);
  return { kind: "act", actions: [...landed, checkDispatch, CHECK_DESIGN_QUEUE] };
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
 * A Map the Map cap holds: a wrong outcome that, unlike the others, the Kit
 * says so of on the issue, naming the open Map, and the Design session
 * carries on. Nothing else changes. Its comment opens like a failed turn's
 * notice, so the session keeps its slot while the Operator's reply is the
 * next move (src/github/threads.ts), and mentions nobody: the cap holds
 * silently (src/loop/mapCap.ts).
 */
function heldByMapCap(issueNumber: number, { openMaps, cap }: Extract<MapCap, { kind: "full" }>): Plan {
  const maps = openMaps.map((map) => `#${map}`);
  const said =
    cap === 0
      ? `This turn ended in a Map, but \`caps.maps\` is 0, so the Kit charts no new Map in this repo. The Kit left #${issueNumber} as it is, and the Design session carries on: reply to finish it another way.`
      : `This turn ended in a Map, but the Map cap is full: ${spelled(maps, "and")} ${maps.length === 1 ? "is the open Map" : "are the open Maps"}, and \`caps.maps\` is ${cap}. The Kit left #${issueNumber} as it is, and the Design session carries on: reply to finish it another way, or close ${maps.length === 1 ? maps[0] : "an open Map"} first and ask for the Map again.`;
  return { kind: "act", actions: [{ kind: "comment", issue: issueNumber, body: [DESIGN_TURN_FAILED_MARKER, said].join("\n") }] };
}

/**
 * The Operator approved a Prototype, so the Kit posts its prototype request,
 * whose marker holds what the prototype turn builds, then adds agent:design,
 * on the App token, as it does to restart a turn refused on its weekly limit,
 * to start that turn. The request is no round, so it carries no round marker
 * and the round count stays where it was, and it mentions nobody: only the
 * prototype round that follows notifies.
 */
function requestPrototype(issueNumber: number, output: Extract<DesignTurnOutput, { kind: "prototype" }>): Action[] {
  const { route, variants, brief } = output;
  return [
    {
      kind: "comment",
      issue: issueNumber,
      body: [
        prototypeRequestMarker({ route, variants, brief }),
        `**Prototype requested.** ${withoutMentions(output.comment)}`,
        "",
        `The Kit is building ${variants} variants of \`${withoutMentions(route)}\`. The prototype round follows when they're ready.`,
      ].join("\n"),
    },
    { kind: "add-labels", issue: issueNumber, labels: [DESIGN_LABEL] },
  ];
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
function rewriteAsBrief(issueNumber: number, comment: string, brief: AgentBrief, issue: IssueSnapshot): Action[] {
  return [
    { kind: "edit-issue-body", issue: issueNumber, body: rewrittenBody(briefBody(brief), issue) },
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

/**
 * The foggy outcome: the issue becomes a Map, rewritten in place, and its
 * first Decisions its sub-issues, blockers first so each blocked-by edge
 * points at an issue that exists. A Decision carries only its
 * `wayfinder:<type>` label, never a state or category label: it is a skill's
 * work, so Intake leaves it alone. The Map keeps its category label and its
 * own edges, and its closing comment lists the Decisions filed.
 */
function chartAsMap(issueNumber: number, output: Extract<DesignTurnOutput, { kind: "map" }>, issue: IssueSnapshot): Action[] {
  const decisionIssue = (key: string): CreatedIssue => ({ created: `decision:${key}` });
  // The contract has already refused blockers that loop, so there is always an order.
  const decisions = dependencyOrder(output.decisions) ?? [];
  return [
    { kind: "edit-issue-body", issue: issueNumber, body: rewrittenBody(mapBody(output), issue) },
    ...decisions.map(
      (decision): Action => ({
        kind: "create-issue",
        key: decisionIssue(decision.key).created,
        title: withoutMentions(decision.title),
        body: withoutMentions(decision.body),
        labels: [decisionLabel(decision.type)],
        parent: issueNumber,
        blockedBy: decision.blockedBy.map(decisionIssue),
      }),
    ),
    {
      kind: "comment-linking",
      issue: issueNumber,
      body: [
        `${SESSION_FINISHED} This issue is now a Map, with ${count(decisions.length, "Decision", "Decisions")} filed under it:\n`,
        ...decisions.flatMap((decision) => ["\n- ", decisionIssue(decision.key), ` ${withoutMentions(decision.title)} (${decision.type})`]),
        `\n\n${closingNote(output.comment)}`,
      ],
    },
    { kind: "remove-label", issue: issueNumber, label: NEEDS_DESIGN },
    { kind: "add-labels", issue: issueNumber, labels: [MAP_LABEL] },
  ];
}

/**
 * A Map body in the shape the wayfinder skill works with. Decisions so far
 * starts empty: each resolved Decision adds its line there. Any other section
 * the session left empty is its heading alone.
 */
function mapBody(output: Extract<DesignTurnOutput, { kind: "map" }>): string {
  const section = (heading: string, text: string) => (text.trim() === "" ? heading : `${heading}\n\n${withoutMentions(text)}`);
  return [
    section("## Destination", output.destination),
    section("## Notes", output.notes),
    DECISIONS_SO_FAR_HEADING,
    section("## Not yet specified", output.notYetSpecified),
    section("## Out of scope", output.outOfScope),
    "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
  ].join("\n\n");
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
  const marker = keptMarker(issue);
  // The Monitor finds its issues by their label, so a Spec that keeps a Sentry group's marker is the
  // group's open issue to it. One that keeps red main's goes without, so the Monitor never closes it once main is green.
  const monitorLabel: Label[] = marker?.kind === "sentry" ? [MONITOR_LABEL] : [];
  return [
    {
      kind: "create-issue",
      key: SPEC.created,
      title: withoutMentions(output.spec.title),
      // The Spec takes the issue's place, so it carries the issue's marker lines.
      body: rewrittenBody(
        [
          withoutMentions(output.spec.body),
          "",
          `<sub>Written by the Fabrik Design session on #${issueNumber}, which this Spec supersedes.</sub>`,
        ].join("\n"),
        issue,
        marker,
      ),
      labels: [...readyLabels(issue), ...monitorLabel],
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
function rewriteAsOperatorBrief(
  issueNumber: number,
  comment: string,
  brief: OperatorBrief,
  issue: IssueSnapshot,
  operator: string,
): Action[] {
  return [
    {
      kind: "edit-issue-body",
      issue: issueNumber,
      body: rewrittenBody(
        [
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
        issue,
      ),
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

/**
 * The Monitor marker of the issue a session rewrites, whose line opens the
 * body it becomes, so the Monitor still finds the issue's group and never
 * files it a second time (#148). Only the line is kept, never the Monitor
 * block. The Monitor reads only the Fabrik App's markers, and a Spec is the
 * App's, so a marker in an issue anyone else opened is never kept.
 */
function keptMarker(issue: IssueSnapshot): MonitorMarker | null {
  return issue.byApp ? monitorMarkerIn(issue.body) : null;
}

/**
 * The body a session's rewrite leaves: `rewritten`, opened by the kept
 * Monitor marker's line (#148) and ended with the From audit and escape lines
 * of the issue's old body (src/loop/carriedLines.ts, #150), so whatever reads
 * those lines still finds them. A line the old body quotes as code, as a
 * Monitor issue quotes its Sentry error, is never carried.
 */
function rewrittenBody(rewritten: string, issue: IssueSnapshot, marker: MonitorMarker | null = keptMarker(issue)): string {
  return withCarriedLines(marker === null ? rewritten : [monitorMarkerLine(marker), rewritten].join("\n"), issue.body);
}

/** Why a session on this issue can't take a turn now, or null when it can. */
function whileInSession(issueNumber: number, issue: IssueSnapshot): Plan | null {
  if (!issue.open) return { kind: "nothing", reason: `#${issueNumber} is closed` };
  if (!issue.labels.includes(NEEDS_DESIGN)) {
    return { kind: "nothing", reason: `#${issueNumber} no longer has ${NEEDS_DESIGN}` };
  }
  return null;
}
