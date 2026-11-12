// The Standings whose move is the Operator's (src/kit/standing.ts): an agent
// pull request at the Merge gate, work handed to them with `ready-for-human`,
// a Design session's Round waiting on their answer, and Triage's question,
// with its neighbour, the question that waits on someone else.
import { NEEDS_INFO, READY_FOR_HUMAN } from "../loop/labels.ts";
import { DESIGN_ROUND_MARKER, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";
import { type LabelEvent, verdictsOn } from "./retroEvidence.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** Every Standing of the repo's whose move is the Operator's, issues first, then pull requests. */
export function operatorStandingsOf({ github, operator, appLogin }: StandingFacts, now: string): Standing[] {
  const { repo, openIssues, openPullRequests } = github;
  return [
    ...openIssues.flatMap((issue) => designRoundStandingsOf(issue, repo, appLogin)),
    ...openIssues.flatMap((issue) => questionStandingsOf(issue, repo, operator, appLogin)),
    ...openIssues.flatMap((issue) => (issue.labels.includes(READY_FOR_HUMAN) ? [readyForHumanStandingOf(issue, repo, now)] : [])),
    ...openPullRequests.flatMap((pullRequest) => pullRequestStandingsOf(pullRequest, repo, operator)),
  ];
}

/**
 * A Design session whose last comment is the Fabrik App's Round, a prototype
 * round and a prototype's failure round included: the Operator's answer is
 * the next move, since the Round. Only the App's own comment counts, so
 * quoting a Round's marker fakes nothing.
 */
function designRoundStandingsOf(issue: OpenIssueFacts, repo: string, appLogin: string): StandingNamed<"design-round">[] {
  const last = issue.comments.at(-1);
  if (last === undefined || !last.byBot || last.author !== appLogin) return [];
  const [first = "", second = ""] = last.body.split("\n", 2);
  const round = DESIGN_ROUND_MARKER.exec(first)?.[1];
  if (round === undefined) return [];
  const prototype = second.trim() === PROTOTYPE_ROUND_MARKER ? "ready" : second.trim() === PROTOTYPE_FAILURE_ROUND_MARKER ? "failed" : null;
  return [{ ...theOperators(repo, issue.number, null, last.at), work: "design-session", place: "design", name: "design-round", detail: { round: Number(round), prototype } }];
}

/**
 * An open `needs-info` issue no person has answered since Triage asked: the
 * Operator's answer, stopping work, when they filed it or the Fabrik App did
 * as the Monitor, which can't answer itself (#425); anyone else's waits on
 * its author, nobody's move. At Triage, since the question.
 */
function questionStandingsOf(issue: OpenIssueFacts, repo: string, operator: string, appLogin: string): StandingNamed<"needs-your-answer" | "waiting-on-author">[] {
  const asked = unansweredQuestionOf(issue);
  if (asked === null) return [];
  const base = { ...theOperators(repo, issue.number, null, asked), work: "issue", place: "triage", detail: { author: issue.author } } as const;
  if (issue.author === operator || issue.author === appLogin) return [{ ...base, name: "needs-your-answer" }];
  return [{ ...base, move: "nobody", yours: false, stopsWork: false, name: "waiting-on-author" }];
}

/** When Triage asked about a `needs-info` issue, or null if it isn't one or a person has answered since. */
function unansweredQuestionOf(issue: OpenIssueFacts): string | null {
  if (!issue.labels.includes(NEEDS_INFO) || answerOf(issue) !== null) return null;
  return lastAdded(issue.labelEvents, NEEDS_INFO) ?? issue.createdAt;
}

/**
 * When a person first answered a `needs-info` issue's question, or null if
 * nobody has. The question is when it last got `needs-info`: a later state
 * change would have taken the label off, and asking again adds it anew. A
 * bot's comment is no answer, as it never sends the issue back to Triage.
 */
export function answerOf(issue: OpenIssueFacts): string | null {
  const asked = Date.parse(lastAdded(issue.labelEvents, NEEDS_INFO) ?? issue.createdAt);
  return issue.comments.find((comment) => !comment.byBot && Date.parse(comment.at) > asked)?.at ?? null;
}

/** An open issue labelled `ready-for-human`: the Operator's to do, with no place on the Loop, since it got the label, or was opened with it. */
export function readyForHumanStandingOf(issue: OpenIssueFacts, repo: string, _now: string): StandingNamed<"yours-to-do"> {
  return {
    ...theOperators(repo, issue.number, null, lastAdded(issue.labelEvents, READY_FOR_HUMAN) ?? issue.createdAt),
    work: "ready-for-human",
    place: null,
    name: "yours-to-do",
    detail: { handBack: null, role: null, failure: null, label: null },
  };
}

/** An agent PR at the Merge gate, or handed back there, as one Standing with the Ticket it closes. */
function pullRequestStandingsOf(pullRequest: OpenPullRequestFacts, repo: string, operator: string): Standing[] {
  const move = passedMoveOf(pullRequest, operator);
  const base = { ...theOperators(repo, pullRequest.ticket, pullRequest.number, move?.since ?? pullRequest.createdAt), work: "ticket", place: "merge-gate" } as const;
  switch (move?.kind) {
    case "merge-gate":
      return [{ ...base, name: "yours-to-merge", detail: { plain: null } }];
    case "handed-back":
      return [{ ...base, name: "yours-to-do", detail: { handBack: null, role: null, failure: null, label: null } }];
    default:
      return [];
  }
}

/** The fields of a Standing whose move is the Operator's and stops work. */
function theOperators(repo: string, issue: number | null, pullRequest: number | null, since: string) {
  return {
    schema: STANDING_SCHEMA,
    repo,
    issue,
    pullRequest,
    move: "operator",
    yours: true,
    stopsWork: true,
    since,
    stuckAt: null,
    awaits: null,
    subscription: null,
  } as const;
}

/**
 * Who moves next on an agent PR out of draft with a passing Verdict at its
 * head, and since when. After the pass, the Kit's `ready-for-human`, still on
 * it, hands it to the Operator (`handed-back`); else the Operator's Request
 * changes since the pass, not dismissed, leaves the next move to the Kit
 * (`changes-requested`); else it is at the Merge gate, waiting on the Operator
 * since the pass (`merge-gate`). A comment or an approving review is an
 * Operator comment (ADR-0007): the Kit never acts on one, so it moves nothing.
 * A dismissed review's state is `dismissed`, so it is no Request changes.
 */
export interface PassedPullRequestMove {
  readonly kind: "merge-gate" | "handed-back" | "changes-requested";
  readonly since: string;
}

/** Who moves next on an agent PR with a passing Verdict at its head, or null for a draft or one without. */
export function passedMoveOf(pullRequest: OpenPullRequestFacts, operator: string): PassedPullRequestMove | null {
  const passed = passAtHeadOf(pullRequest);
  if (pullRequest.draft || passed === null) return null;
  const requested = pullRequest.reviews
    .filter((review) => review.author === operator && review.state === "changes-requested" && Date.parse(review.at) > Date.parse(passed))
    .map(({ at }) => at)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
  const handedBack = addedAndStillOn(pullRequest.labelEvents, READY_FOR_HUMAN);
  if (handedBack !== null && Date.parse(handedBack) > Date.parse(requested ?? passed)) return { kind: "handed-back", since: handedBack };
  if (requested !== undefined) return { kind: "changes-requested", since: requested };
  return { kind: "merge-gate", since: passed };
}

/** When a PR's latest Verdict on its head was posted, if that Verdict is a pass; otherwise null. */
export function passAtHeadOf(pullRequest: OpenPullRequestFacts): string | null {
  const latest = verdictsOn(pullRequest.comments).filter(({ record }) => record.headSha === pullRequest.headSha).at(-1);
  return latest?.record.verdict === "pass" ? latest.at : null;
}

/** When `label` was last added, if it's still on: the latest event for it added it. Otherwise null. */
export function addedAndStillOn(events: readonly LabelEvent[], label: string): string | null {
  const latest = events.filter((event) => event.label === label).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  return latest?.action === "labeled" ? latest.at : null;
}

/** When `label` was last added, or null. */
export function lastAdded(events: readonly LabelEvent[], label: string): string | null {
  const added = events.filter((event) => event.label === label && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)?.at ?? null;
}
