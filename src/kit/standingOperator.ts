// The Standings of what waits on the Operator (src/kit/standing.ts): an agent
// pull request at the Merge gate, work handed to them with `ready-for-human`
// or by the Kit's notice, a Design session's Round waiting on their answer,
// Triage's question, the Subscriptions' issues and what is theirs to read;
// with their neighbours, the question that waits on someone else and a
// weekly limit the Kit rides out on another Subscription.
import { researchRunFailedIn } from "../github/threads.ts";
import type { HandBack } from "../loop/handBacks.ts";
import { earliestOf, resetsAtOf } from "../loop/kitIssueMarks.ts";
import {
  DECISION_TYPES,
  DESIGN_LABEL,
  decisionLabel,
  type DecisionLabel,
  MAP_LABEL,
  NEEDS_DESIGN,
  NEEDS_INFO,
  READY_FOR_HUMAN,
  RESEARCH_LABEL,
  TOKEN_ROTATION_LABEL,
  USAGE_CREDITS_LABEL,
  WEEKLY_LIMIT_LABEL,
} from "../loop/labels.ts";
import { DESIGN_ROUND_MARKER, DESIGN_TURN_FAILED_MARKER, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, refusedByMapCap } from "../loop/markers.ts";
import { whyNotResearchable } from "../loop/research.ts";
import { freeSubscriptions, kitIssueSubscriptionOf, makesUnusable } from "../loop/subscriptions.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed } from "./standing.ts";
import { handBackOfNotice } from "./standingHandBacks.ts";
import { isOperatorsReplay, replayResultsIn } from "./replay.ts";
import { type LabelEvent, verdictsOn } from "./retroEvidence.ts";
import type { GitHubFacts, OpenIssueFacts, OpenPullRequestFacts, RepoKitFacts } from "./weeklySummary.ts";

/** Every Standing of the repo's whose move is the Operator's, issues first, then pull requests. */
export function operatorStandingsOf({ github, kit, operator, appLogin }: StandingFacts, now: string): Standing[] {
  const { repo, openIssues, openPullRequests } = github;
  return [
    ...openIssues.flatMap((issue) => designRoundStandingsOf(issue, repo, appLogin)),
    ...openIssues.flatMap((issue) => stoppedDesignSessionStandingsOf(issue, repo, appLogin)),
    ...openIssues.flatMap((issue) => questionStandingsOf(issue, repo, operator, appLogin)),
    ...openIssues.flatMap((issue) => failedResearchStandingsOf(issue, openIssues, repo, appLogin)),
    ...subscriptionStandingsOf(github, kit),
    // A Subscription's issue carries ready-for-human too, but stands as above.
    ...openIssues.flatMap((issue) => (issue.labels.includes(READY_FOR_HUMAN) && !makesUnusable(issue.labels) ? [readyForHumanStandingOf(issue, repo, now)] : [])),
    ...openPullRequests.flatMap((pullRequest) => pullRequestStandingsOf(pullRequest, repo, operator)),
    // Last, so work that stops on the Operator is read so before it is read as reading matter.
    ...readingMatterOf(github, operator, appLogin),
  ];
}

/**
 * Each open weekly-limit, token-rotation and usage-credits issue, naming its
 * Subscription by the Kit's rule (kitIssueSubscriptionOf: its marker, or the
 * first listed), judged by the repo's own Kit config, or the Kit's defaults
 * when it wasn't read or is invalid. A weekly-limit issue is the Operator's,
 * stopping work, only while every listed Subscription is used up, by the rule
 * that chooses a run's (freeSubscriptions), and says when the first of them
 * resets; while another is free it waits for its reset, the Kit's. A refused
 * token and spent usage credits are the Operator's, stopping work, since the
 * Kit handed them over with `ready-for-human`, as today's line dates them.
 * Its text is read from the Kit's issues, its dates from the open issues.
 */
function subscriptionStandingsOf({ repo, openIssues, kitIssues }: GitHubFacts, kit: RepoKitFacts | null): Standing[] {
  const config = kit?.config.ok === true ? kit.config.config : DEFAULT_KIT_CONFIG;
  const anyFree = freeSubscriptions(kitIssues, config).length > 0;
  const firstReset = earliestOf(kitIssues.filter(({ labels }) => labels.includes(WEEKLY_LIMIT_LABEL)).map(resetsAtOf));
  return openIssues.flatMap((issue): Standing[] => {
    const owned = kitIssues.find(({ number }) => number === issue.number) ?? { number: issue.number, labels: issue.labels, body: "", comments: [] };
    const subscription = kitIssueSubscriptionOf(owned, config);
    const handedOver = { ...theOperators(repo, issue.number, null, lastAdded(issue.labelEvents, READY_FOR_HUMAN) ?? issue.createdAt), subscription, place: null };
    if (issue.labels.includes(WEEKLY_LIMIT_LABEL)) {
      const since = lastAdded(issue.labelEvents, WEEKLY_LIMIT_LABEL) ?? issue.createdAt;
      const base = { ...theOperators(repo, issue.number, null, since), subscription, work: "weekly-limit", place: null } as const;
      if (!anyFree) return [{ ...base, name: "weekly-limit-reached", detail: { resetsAt: firstReset } }];
      return [{ ...base, move: "kit", yours: false, stopsWork: false, name: "waiting-for-reset", detail: { resetsAt: resetsAtOf(owned) } }];
    }
    if (issue.labels.includes(TOKEN_ROTATION_LABEL)) return [{ ...handedOver, work: "token-rotation", name: "token-refused", detail: { anotherFree: anyFree } }];
    if (issue.labels.includes(USAGE_CREDITS_LABEL)) {
      return [{ ...handedOver, work: "usage-credits", name: "yours-to-do", detail: { handBack: null, role: null, failure: null, label: null } }];
    }
    return [];
  });
}

/** The Decision labels whose Decisions the Operator resolves live: all but research, which the Researcher resolves AFK. */
const OPERATOR_DECISION_LABELS: readonly DecisionLabel[] = DECISION_TYPES.filter((type) => type !== "research").map(decisionLabel);

/**
 * What waits on the Operator to read, never stopping work, with no place on
 * the Loop: the Fabrik App's open Audits and Retros, filled or still pending,
 * since each was opened (a person's `fabrik:audit` or `fabrik:retro` issue is
 * neither); the Operator's Replays whose results are in, since the Kit wrote
 * them, by the Replay module's own reading of their markers; each open Map,
 * read as the Map cap reads them, since it got `wayfinder:map`, carrying its
 * open grilling, prototype and task Decisions; and each of those Decisions,
 * carrying its Map, for a reader to fold under it.
 */
function readingMatterOf({ repo, openAudits, openRetros, openReplays, openIssues, openMaps }: GitHubFacts, operator: string, appLogin: string): StandingNamed<"yours-to-read">[] {
  const reading = (issue: number, work: "audit" | "retro" | "replay" | "map" | "operator-decision", since: string, map: number | null, decisions: readonly number[]) =>
    ({ ...theOperators(repo, issue, null, since), stopsWork: false, work, place: null, name: "yours-to-read", detail: { map, decisions } }) as const;
  const maps = openIssues.filter((issue) => openMaps.includes(issue.number));
  return [
    ...openAudits.filter(({ author }) => author === appLogin).map((audit) => reading(audit.number, "audit", audit.createdAt, null, [])),
    ...openRetros.filter(({ author }) => author === appLogin).map((retro) => reading(retro.number, "retro", retro.createdAt, null, [])),
    ...openReplays
      .filter((replay) => isOperatorsReplay(replay, operator) && replayResultsIn(replay.body))
      .map((replay) => reading(replay.number, "replay", replay.lastEditedAt ?? replay.createdAt, null, [])),
    ...maps.flatMap((map) => {
      const decisions = openIssues.flatMap((issue) => {
        const label = OPERATOR_DECISION_LABELS.find((operators) => issue.labels.includes(operators));
        return map.subIssues.includes(issue.number) && label !== undefined ? [{ issue, label }] : [];
      });
      return [
        reading(map.number, "map", lastAdded(map.labelEvents, MAP_LABEL) ?? map.createdAt, null, decisions.map(({ issue }) => issue.number)),
        ...decisions.map(({ issue, label }) => reading(issue.number, "operator-decision", lastAdded(issue.labelEvents, label) ?? issue.createdAt, map.number, [])),
      ];
    }),
  ];
}

/**
 * A `needs-design` issue whose last comment is the Fabrik App's Round, a
 * prototype round and a prototype's failure round included: the Operator's
 * answer is the next move, since the Round. Only the App's own comment
 * counts, so quoting a Round's marker fakes nothing; one that has left Design
 * by hand is read by its labels as they are now.
 */
function designRoundStandingsOf(issue: OpenIssueFacts, repo: string, appLogin: string): StandingNamed<"design-round">[] {
  const last = issue.comments.at(-1);
  if (!issue.labels.includes(NEEDS_DESIGN) || last === undefined || !last.byBot || last.author !== appLogin) return [];
  const [first = "", second = ""] = last.body.split("\n", 2);
  const round = DESIGN_ROUND_MARKER.exec(first)?.[1];
  if (round === undefined) return [];
  const prototype = second.trim() === PROTOTYPE_ROUND_MARKER ? "ready" : second.trim() === PROTOTYPE_FAILURE_ROUND_MARKER ? "failed" : null;
  return [{ ...theOperators(repo, issue.number, null, last.at), work: "design-session", place: "design", name: "design-round", detail: { round: Number(round), prototype } }];
}

/**
 * A Design session whose last comment is the Fabrik App's notice that its
 * turn failed, or that the Map cap refused its Map: the Operator's reply is
 * the next move, stopping work, since the notice, or until they add
 * `agent:design` again where the sweep took it off. Either keeps the
 * session's slot (holdsSlot). Only the App's own comment counts, as for a Round.
 */
function stoppedDesignSessionStandingsOf(issue: OpenIssueFacts, repo: string, appLogin: string): StandingNamed<"yours-to-do">[] {
  const last = issue.comments.at(-1);
  if (!issue.labels.includes(NEEDS_DESIGN) || last === undefined || !last.byBot || last.author !== appLogin || !last.body.startsWith(DESIGN_TURN_FAILED_MARKER)) return [];
  // Its hidden line names the trigger label the sweep took off, where the notice says so.
  const mark = handBackOfNotice(last.body);
  const handBack = mark?.kind === "trigger-swept" ? mark.kind : refusedByMapCap(last.body) ? "map-cap-refused" : "design-turn-failed";
  const label = handBack === "trigger-swept" ? DESIGN_LABEL : null;
  // Once the Operator adds the label the sweep took off again, the work is read like any other.
  const readded = label === null ? null : lastAdded(issue.labelEvents, label);
  if (readded !== null && Date.parse(readded) > Date.parse(last.at)) return [];
  return [
    {
      ...theOperators(repo, issue.number, null, last.at),
      work: "design-session",
      place: "design",
      name: "yours-to-do",
      detail: { handBack, role: "design", failure: mark?.failure ?? null, label },
    },
  ];
}

/**
 * A research Decision on an open Map whose last run failed, by the Kit's own
 * rules for which Decisions the Researcher may run on (whyNotResearchable)
 * and whose last run failed (researchRunFailedIn), as Dispatch reads them:
 * the Operator's, stopping work, since the Kit's notice, until they add
 * `agent:research` again. A run whose branch the Kit refused leaves the same
 * notice. Only the Fabrik App's comments are read, as Dispatch reads them.
 */
function failedResearchStandingsOf(decision: OpenIssueFacts, openIssues: readonly OpenIssueFacts[], repo: string, appLogin: string): StandingNamed<"yours-to-do">[] {
  // A closed parent isn't among the open issues, so it reads as none: no open Map either way.
  const parent = openIssues.find((issue) => issue.subIssues.includes(decision.number));
  const parentIssue = parent === undefined ? null : { number: parent.number, open: true, labels: parent.labels };
  const comments = decision.comments.map((comment) => ({ ...comment, byApp: comment.author === appLogin }));
  if (whyNotResearchable({ ...decision, open: true, parentIssue }) !== null || !researchRunFailedIn(comments)) return [];
  const notice = comments.findLast((comment) => comment.byApp);
  const readded = lastAdded(decision.labelEvents, RESEARCH_LABEL);
  if (notice === undefined || (readded !== null && Date.parse(readded) > Date.parse(notice.at))) return [];
  // Its hidden line tells a refused branch, a label the sweep took off and a failed landing from a failed run.
  const mark = handBackOfNotice(notice.body);
  const handBack = mark !== null && RESEARCH_NOTICE_HAND_BACKS.has(mark.kind) ? mark.kind : "research-failed";
  return [
    {
      ...theOperators(repo, decision.number, null, notice.at),
      work: "research-decision",
      place: null,
      name: "yours-to-do",
      detail: { handBack, role: "research", failure: mark?.failure ?? null, label: RESEARCH_LABEL },
    },
  ];
}

/** Every hand-back a research Decision's failure notice can name: a failed run, a branch the Kit refused, a label the sweep took off and a failed landing. */
export const RESEARCH_NOTICE_HAND_BACKS: ReadonlySet<HandBack> = new Set(["research-failed", "research-branch-refused", "trigger-swept", "landing-failed"]);

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
