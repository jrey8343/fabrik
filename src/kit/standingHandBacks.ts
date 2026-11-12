// The Standings of work the Kit handed back (src/kit/standing.ts): the
// Operator's at once, from the moment the Kit says so, read from the Kit's own
// notice on GitHub, with no clock and no Run record. A notice says which
// hand-back it is on its hidden last line (src/loop/markers.ts); one from an
// earlier release, with no such line, is recognised by a sentence or marker it
// has carried in every release (src/__fixtures__/handBackWordings.ts).
import type { HandBack } from "../loop/handBacks.ts";
import { RESUME_LABELS, waitingHeldRuns } from "../loop/heldRun.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, NEEDS_INFO, NEEDS_TRIAGE, READY_FOR_AGENT, READY_FOR_HUMAN, TRIGGER_LABELS } from "../loop/labels.ts";
import {
  CONFLICT_RUN_ENDED_MARKER,
  DESIGN_TURN_FAILED_MARKER,
  type HandBackMark,
  handBackMarkIn,
  refusedByMapCap,
  REQUEST_CHANGES_RUN_EMPTY_MARKER,
  requestChangesRunEndedIn,
  RESEARCH_RUN_FAILED_MARKER,
  RETRY_ENDED_MARKER,
  stuckTriggerGaveUpMarker,
} from "../loop/markers.ts";
import { TRIGGER_ROLES } from "../loop/triggerSweep.ts";
import type { AgentRole } from "../loop/types.ts";
import type { CommentFacts } from "./retroEvidence.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace } from "./standing.ts";
import { workOf } from "./standingInFlight.ts";
import { addedAndStillOn, lastAdded } from "./standingOperator.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** How a failure notice has named each role's run, in every release: "The Implement run on #7 failed:". */
const FAILED_RUN = /(?:^|\s)The (Triage|Implement|Review|Audit|Retro|Research) run on #\d+ failed:/m;
const FAILED_TURN = /(?:^|\s)The (?:Design-session turn(?: run)?|prototype turn) on #\d+ failed:/m;

/** How a failed landing has named the run it was landing, in every release. */
const LANDING_RUNS: readonly (readonly [RegExp, AgentRole])[] = [
  [/couldn't land (?:the failure notice of )?the Implement run on #/, "implement"],
  [/couldn't land (?:the failure notice of )?the Research run on #/, "research"],
  [/couldn't land (?:the failure notice of )?the Triage run on #/, "triage"],
  [/couldn't land (?:the failure notice of )?the (?:Design session's turn|prototype turn) on #/, "design"],
  [/couldn't land (?:the failure notice of )?the Review(?: run)? (?:of|on) #|couldn't land the red required checks on #/, "review"],
];

const LANDING_FAILED = "**The Kit couldn't land ";

/**
 * Which hand-back the Fabrik App's notice is, or null for one that hands
 * nothing back: its hidden line, or, for a notice from an earlier release,
 * what it has always said. An old notice names no failure. Read only from the
 * Fabrik App's own comments, so a person quoting one changes nothing.
 */
export function handBackOfNotice(body: string): HandBackMark | null {
  const marked = handBackMarkIn(body);
  if (marked !== null) return marked;
  const lines = body.split("\n");
  if (body.includes(LANDING_FAILED)) {
    const role = LANDING_RUNS.find(([named]) => named.test(body))?.[1];
    return { kind: "landing-failed", ...(role === undefined ? {} : { role }) };
  }
  const swept = TRIGGER_LABELS.find((label) => lines.includes(stuckTriggerGaveUpMarker(label)));
  if (swept !== undefined) {
    const role = TRIGGER_ROLES[swept];
    return { kind: "trigger-swept", ...(role === null ? {} : { role }) };
  }
  if (body.startsWith(DESIGN_TURN_FAILED_MARKER)) return { kind: refusedByMapCap(body) ? "map-cap-refused" : "design-turn-failed", role: "design" };
  if (body.startsWith(RESEARCH_RUN_FAILED_MARKER)) return { kind: "research-failed", role: "research" };
  if (body.startsWith(CONFLICT_RUN_ENDED_MARKER)) return { kind: "conflict-run-unlanded", role: "implement" };
  if (requestChangesRunEndedIn(body) !== null) return { kind: "request-changes-unlanded", role: "implement" };
  // The note on a head that moved hands nothing back: Review runs on it.
  if (body.startsWith(REQUEST_CHANGES_RUN_EMPTY_MARKER) && body.includes("so your requested changes aren't built")) return { kind: "request-changes-empty", role: "implement" };
  if (body.startsWith(RETRY_ENDED_MARKER)) return { kind: "retry-never-started", role: "implement" };
  if (body.includes("This is a Broken run") && body.includes("so the Loop won't run it again")) return { kind: "broken-run-no-retry", role: "implement" };
  if (body.includes("This is an Infrastructure failure, so ")) return infrastructureFailureOf(body);
  if (body.includes("was closed unmerged by hand, so the Kit won't start another Implement run")) return { kind: "closed-by-hand", role: "implement" };
  if (/but its Kept branch `[^`]+` is gone, so the Kit started no Implement run/.test(body)) return { kind: "kept-branch-gone", role: "implement" };
  return null;
}

/** The hand-backs that put `ready-for-human` on the work: each stands while that label is on, whatever the Kit says after. */
export const READY_FOR_HUMAN_HAND_BACKS: ReadonlySet<HandBack> = new Set(["request-changes-empty", "conflict-run-unlanded", "request-changes-unlanded", "closed-by-hand", "kept-branch-gone"]);

/** One piece of work, its issue and its open agent PR, as the Kit's notices on either speak of it. */
interface HandedWork {
  readonly issue: OpenIssueFacts | null;
  readonly pullRequest: OpenPullRequestFacts | null;
  /** The Fabrik App's comments on the issue and the PR, oldest first. */
  readonly said: readonly CommentFacts[];
}

/**
 * Every piece of work the Kit's latest notice hands back, the Operator's at
 * once and stopping work, since the notice, naming which hand-back. It stands
 * while that notice is the Fabrik App's latest word on the issue or its agent
 * PR and the label that resumes the work has not been added since; or, for a
 * hand-back that put `ready-for-human` on the work, while that label is on.
 * A failed Design-session turn, a Map the Map cap refused and a failed or
 * refused Research run are read where their own markers are read
 * (src/kit/standingOperator.ts). Work a held marker names hands nothing back:
 * it is held, as the Kit resumes it itself.
 */
export function handBackStandingsOf({ github, appLogin }: StandingFacts, _now: string): Standing[] {
  const { repo, openIssues, openPullRequests, kitIssues } = github;
  const held = new Set(waitingHeldRuns(kitIssues).flatMap(({ run }) => [run.issue, ...(run.lineOn === undefined ? [] : [run.lineOn])]));
  const byApp = (comments: readonly CommentFacts[]) => comments.filter(({ author }) => author === appLogin);
  const ticketsOpen = new Set(openIssues.map(({ number }) => number));
  const works: HandedWork[] = [
    ...openIssues.map((issue) => {
      const pullRequest = openPullRequests.filter(({ ticket }) => ticket === issue.number).toSorted((a, b) => a.number - b.number)[0] ?? null;
      return { issue, pullRequest, said: oldestFirst([...byApp(issue.comments), ...byApp(pullRequest?.comments ?? [])]) };
    }),
    ...openPullRequests
      .filter(({ ticket }) => ticket === null || !ticketsOpen.has(ticket))
      .map((pullRequest) => ({ issue: null, pullRequest, said: oldestFirst(byApp(pullRequest.comments)) })),
  ];
  return works.flatMap((work) => {
    const numbers = [work.issue?.number, work.pullRequest?.number].filter((number) => number !== undefined);
    if (numbers.some((number) => held.has(number))) return [];
    const standing = handedBackIn(work, repo);
    return standing === null ? [] : [standing];
  });
}

/** The `yours-to-do` Standing of work whose latest hand-back notice still stands, or null. */
function handedBackIn({ issue, pullRequest, said }: HandedWork, repo: string): StandingNamed<"yours-to-do"> | null {
  const found = said.flatMap((comment) => {
    const mark = handBackOfNotice(comment.body);
    return mark === null ? [] : [{ comment, mark }];
  }).at(-1);
  // A failed Design-session turn's and Research run's notices are read with their own markers.
  if (found === undefined || ownMarked(found.comment.body)) return null;
  const { comment: notice, mark } = found;
  const resume = resumingLabelOf(mark, notice.body);
  const resumedSince = resume !== null && [issue?.labelEvents ?? [], pullRequest?.labelEvents ?? []].some((events) => isAfter(lastAdded(events, resume), notice.at));
  if (resumedSince) return null;
  if (READY_FOR_HUMAN_HAND_BACKS.has(mark.kind)) {
    const onPullRequest = pullRequest?.comments.includes(notice) === true;
    const stillOn = onPullRequest ? addedAndStillOn(pullRequest.labelEvents, READY_FOR_HUMAN) !== null : issue?.labels.includes(READY_FOR_HUMAN) === true;
    if (!stillOn) return null;
  } else if (said.at(-1) !== notice) {
    return null;
  }
  return {
    schema: STANDING_SCHEMA,
    repo,
    issue: issue?.number ?? pullRequest?.ticket ?? null,
    pullRequest: pullRequest?.number ?? null,
    work: mark.role !== undefined ? workOf(mark.role) : resume === "agent:replay" ? "replay" : "ticket",
    place: placeOf(issue, pullRequest),
    name: "yours-to-do",
    move: "operator",
    yours: true,
    stopsWork: true,
    since: notice.at,
    stuckAt: null,
    awaits: null,
    subscription: null,
    detail: { handBack: mark.kind, role: mark.role ?? null, failure: mark.failure ?? null, label: resume },
  };
}

/** Whether a notice opens with a failed Design-session turn's or Research run's own marker. */
function ownMarked(body: string): boolean {
  return body.startsWith(DESIGN_TURN_FAILED_MARKER) || body.startsWith(RESEARCH_RUN_FAILED_MARKER);
}

/**
 * The label whose adding resumes the work a hand-back stopped, or null where
 * none does: the failed run's trigger label, the label the sweep took off, or
 * `ready-for-agent` on a Ticket the Kit stopped.
 */
function resumingLabelOf(mark: HandBackMark, body: string): string | null {
  switch (mark.kind) {
    case "infrastructure-failure":
    case "landing-failed":
      return mark.role === undefined ? null : RESUME_LABELS[mark.role];
    case "broken-run-no-retry":
      return DISPATCH_LABEL;
    case "trigger-swept":
      return TRIGGER_LABELS.find((label) => body.split("\n").includes(stuckTriggerGaveUpMarker(label))) ?? null;
    case "retry-never-started":
    case "closed-by-hand":
    case "kept-branch-gone":
      return READY_FOR_AGENT;
    default:
      return null;
  }
}

/**
 * Where the work is on the Loop, from its labels and PR as they are now:
 * none while it carries `ready-for-human`; an agent draft at Review and one
 * out of draft at the Merge gate; else by its issue's state label.
 */
function placeOf(issue: OpenIssueFacts | null, pullRequest: OpenPullRequestFacts | null): StandingPlace | null {
  if (issue?.labels.includes(READY_FOR_HUMAN) === true) return null;
  if (pullRequest !== null) return pullRequest.draft ? "review" : "merge-gate";
  const labels = issue?.labels ?? [];
  if (labels.includes(NEEDS_TRIAGE) || labels.includes(NEEDS_INFO)) return "triage";
  if (labels.includes(NEEDS_DESIGN)) return "design";
  if (labels.includes(READY_FOR_AGENT)) return "implement";
  return null;
}

function isAfter(at: string | null, than: string): boolean {
  return at !== null && Date.parse(at) > Date.parse(than);
}

function oldestFirst(comments: readonly CommentFacts[]): CommentFacts[] {
  return comments.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * An old failure notice, by the run it names: a Design-session turn's and a
 * Research run's are their own hand-backs, and an Audit's or Retro's hands
 * nothing back, as the scheduled tick opens the next.
 */
function infrastructureFailureOf(body: string): HandBackMark | null {
  if (FAILED_TURN.test(body)) return { kind: "design-turn-failed", role: "design" };
  const named = FAILED_RUN.exec(body)?.[1];
  switch (named) {
    case undefined:
      return { kind: "infrastructure-failure" };
    case "Audit":
    case "Retro":
      return null;
    case "Research":
      return { kind: "research-failed", role: "research" };
    default:
      return { kind: "infrastructure-failure", role: named.toLowerCase() as AgentRole };
  }
}
