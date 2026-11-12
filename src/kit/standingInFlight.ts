// The Standings of work that goes on without the Operator (src/kit/standing.ts):
// a run in flight for it (`running`), an agent draft whose Review waits for its
// Required checks (`waiting-on-checks`), a Held run (`held`), work a slot holds
// (`waiting-for-slot`), and a Ticket or research Decision its blockers hold
// (`blocked`). Each is read by the Loop's own rule for it, so the Standing and
// the Loop can't disagree, and none can turn Stuck.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { conflictRunInFlightIn } from "../github/threads.ts";
import { waitingIssues } from "../loop/designQueue.ts";
import { inFlightOf, waitingForDispatch } from "../loop/dispatch.ts";
import { heldOf, waitingHeldRuns } from "../loop/heldRun.ts";
import {
  DISPATCH_LABEL,
  MAP_LABEL,
  NEEDS_INFO,
  NEEDS_TRIAGE,
  READY_FOR_AGENT,
  RESEARCH_DECISION_LABEL,
  RESEARCH_LABEL,
  REVIEW_LABEL,
} from "../loop/labels.ts";
import { whyNotResearchable } from "../loop/research.ts";
import type { AgentRole, KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type CommentFacts, type LabelEvent, verdictsOn } from "./retroEvidence.ts";
import { type AwaitedRole, type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { addedAndStillOn, lastAdded } from "./standingOperator.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** What a `running` Standing's `detail.run` names: the kind of run, as far as the facts tell it. */
export type RunningRun = "implement" | "retry" | "request-changes" | "conflict-only" | "review" | "triage" | "research" | "design" | "prototype" | "audit" | "retro";

/** Every Standing of the repo's work that goes on without the Operator, or that nothing moves while its blockers are open. A Spec has none. */
export function inFlightStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const runs = facts.kit === null || facts.kit.runsInFlight === "unread" ? null : facts.kit.runsInFlight;
  const held = heldStandingsOf(facts);
  const heldWork = new Set(held.map(({ issue, pullRequest, detail }) => (detail.role === "review" ? `pr#${pullRequest}` : `#${issue}`)));
  const specs = new Set(facts.github.openIssues.filter(isSpec).map(({ number }) => number));
  return [...(runs === null ? [] : [...runningStandingsOf(facts, runs, heldWork), ...waitingOnChecksStandingsOf(facts, runs)]), ...held].filter(
    ({ issue }) => issue === null || !specs.has(issue),
  );
}

/**
 * Each agent draft whose Review is waiting for the Required checks on its
 * head: one with no Verdict on its head and no Review job naming it, while a
 * Review's wait for checks, or its re-run of red checks, is in flight. Those
 * jobs carry no number, so one in flight counts for every such draft, since
 * the oldest of them began.
 */
function waitingOnChecksStandingsOf({ github }: StandingFacts, runs: readonly RunInFlightFact[]): StandingNamed<"waiting-on-checks">[] {
  const waits = runs.filter(({ role, job }) => role === "review" && job === "waiting-on-checks").toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const oldest = waits[0];
  if (oldest === undefined) return [];
  const reviewed = new Set(runs.flatMap(({ role, pullRequest }) => (role === "review" && pullRequest !== null ? [pullRequest] : [])));
  return github.openPullRequests
    .filter((pullRequest) => pullRequest.draft && !hasVerdictOnHead(pullRequest) && !reviewed.has(pullRequest.number))
    .map((pullRequest) => ({
      ...inFlight(github.repo, pullRequest.ticket, pullRequest.number, oldest.createdAt, "ticket", "review", { role: "review", on: "pullRequest" }),
      name: "waiting-on-checks",
      detail: { plain: null, check: null, checksUnread: false },
    }));
}

/** An open issue labelled `ready-for-agent` with sub-issues, not a Map: a Spec, which has no Standing of its own; its Tickets do. */
function isSpec(issue: OpenIssueFacts): boolean {
  return issue.labels.includes(READY_FOR_AGENT) && !issue.labels.includes(MAP_LABEL) && issue.subIssues.length > 0;
}

/**
 * Each piece of work with a run in flight for it: one its job names, or one
 * whose name carries no number, which counts for every piece of work waiting
 * on its role, as the stuck-trigger sweep counts it, though never for a Held
 * run, which the Kit hasn't started. A named run comes first, then the oldest.
 */
function runningStandingsOf(facts: StandingFacts, runs: readonly RunInFlightFact[], heldWork: ReadonlySet<string>): Standing[] {
  const { github, appLogin, operator } = facts;
  const counted = runs.filter(({ job }) => job !== "waiting-on-checks");
  const issues = github.openIssues.flatMap((issue): Standing[] => {
    const named = counted.filter((run) => run.issue === issue.number && (run.role === "implement" || run.role === "design"));
    const waiting = heldWork.has(`#${issue.number}`) ? [] : counted.filter((run) => run.issue === null && run.pullRequest === null && waitsOnRole(issue, run.role, appLogin));
    const run = firstOf(named, waiting);
    const standing = run === undefined ? null : runningOnIssue(issue, run, github.repo, github.openPullRequests, operator, appLogin);
    return standing === null ? [] : [standing];
  });
  const pullRequests = github.openPullRequests.flatMap((pullRequest): Standing[] => {
    const named = counted.filter((run) => run.role === "review" && run.pullRequest === pullRequest.number);
    const waits = !heldWork.has(`pr#${pullRequest.number}`) && waitsOnReview(pullRequest, appLogin);
    const waiting = waits ? counted.filter((run) => run.role === "review" && run.pullRequest === null) : [];
    const run = firstOf(named, waiting);
    if (run === undefined) return [];
    return [{ ...inFlight(github.repo, pullRequest.ticket, pullRequest.number, run.createdAt, "ticket", "review", { role: "review", on: "pullRequest" }), name: "running", detail: { run: "review", retry: null } }];
  });
  return [...issues, ...pullRequests];
}

/** The run that counts: the oldest one the job names, else the oldest that counts for all waiting on its role. */
function firstOf(named: readonly RunInFlightFact[], waiting: readonly RunInFlightFact[]): RunInFlightFact | undefined {
  const oldest = (runs: readonly RunInFlightFact[]) => runs.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  return oldest(named) ?? oldest(waiting);
}

/** The `running` Standing of an issue with this run in flight for it; null for a run of a role no issue waits on, which never gets here. */
function runningOnIssue(
  issue: OpenIssueFacts,
  run: RunInFlightFact,
  repo: string,
  openPullRequests: readonly OpenPullRequestFacts[],
  operator: string,
  appLogin: string,
): StandingNamed<"running"> | null {
  const running = (work: StandingWork, place: StandingPlace | null, role: AwaitedRole, kind: RunningRun, retry: number | null = null, pullRequest: number | null = null) => ({
    ...inFlight(repo, issue.number, pullRequest, run.createdAt, work, place, { role, on: pullRequest === null ? "issue" : "pullRequest" }),
    name: "running" as const,
    detail: { run: kind, retry },
  });
  switch (run.role) {
    case "implement": {
      const pullRequest = openPullRequests.filter(({ ticket }) => ticket === issue.number).toSorted((a, b) => a.number - b.number)[0];
      const kind = run.retry !== null ? "retry" : pullRequest === undefined ? "implement" : implementRunOn(pullRequest, operator, appLogin);
      return running("ticket", "implement", "implement", kind, run.retry, kind === "implement" ? null : (pullRequest?.number ?? null));
    }
    case "design":
      return running("design-session", "design", "design", run.kind === "prototype" ? "prototype" : "design");
    case "triage":
      return running("issue", "triage", "triage", "triage");
    case "research":
      return running("research-decision", null, "research", "research");
    default:
      return null;
  }
}

/**
 * Which Implement run is in flight on a Ticket's agent PR, where the facts
 * tell it: a conflict-only run the Kit's note started and nothing has ended
 * yet, or a Request-changes run for the Operator's Request changes since the
 * PR's latest Verdict; else a plain Implement run.
 */
function implementRunOn(pullRequest: OpenPullRequestFacts, operator: string, appLogin: string): RunningRun {
  if (conflictRunInFlightIn(byApp(pullRequest.comments, appLogin).map(({ body }) => body)) !== null) return "conflict-only";
  const verdict = verdictsOn(pullRequest.comments).at(-1)?.at ?? null;
  const latest = pullRequest.reviews.filter(({ author }) => author === operator).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  const requested = latest?.state === "changes-requested" && (verdict === null || Date.parse(latest.at) > Date.parse(verdict));
  return requested ? "request-changes" : "implement";
}

/**
 * Whether an issue waits on a role's run: its trigger label is on, or the
 * Fabrik App took it off, as the claim does, and has said nothing on the
 * issue since. An issue waits on Triage while it carries `needs-triage`, or
 * `needs-info` with an answer.
 */
function waitsOnRole(issue: OpenIssueFacts, role: RunInFlightFact["role"], appLogin: string): boolean {
  switch (role) {
    case "triage":
      return issue.labels.includes(NEEDS_TRIAGE) || (issue.labels.includes(NEEDS_INFO) && answerOf(issue) !== null);
    case "implement":
      return issue.labels.includes(DISPATCH_LABEL) || claimed(issue.labelEvents, issue.comments, DISPATCH_LABEL, appLogin);
    case "research":
      return issue.labels.includes(RESEARCH_DECISION_LABEL) && (issue.labels.includes(RESEARCH_LABEL) || claimed(issue.labelEvents, issue.comments, RESEARCH_LABEL, appLogin));
    default:
      return false;
  }
}

/** Whether an agent PR waits on a Review: `agent:review` on it or just claimed, or a draft with no Verdict on its head. */
function waitsOnReview(pullRequest: OpenPullRequestFacts, appLogin: string): boolean {
  if (addedAndStillOn(pullRequest.labelEvents, REVIEW_LABEL) !== null || claimed(pullRequest.labelEvents, pullRequest.comments, REVIEW_LABEL, appLogin)) return true;
  return pullRequest.draft && !hasVerdictOnHead(pullRequest);
}

function hasVerdictOnHead(pullRequest: OpenPullRequestFacts): boolean {
  return verdictsOn(pullRequest.comments).some(({ record }) => record.headSha === pullRequest.headSha);
}

/** Whether the Fabrik App took `label` off last, and has commented nothing since. */
function claimed(events: readonly LabelEvent[], comments: readonly CommentFacts[], label: string, appLogin: string): boolean {
  const latest = events.filter((event) => event.label === label).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  if (latest === undefined || latest.action !== "unlabeled" || latest.actor !== appLogin) return false;
  return !byApp(comments, appLogin).some(({ at }) => Date.parse(at) > Date.parse(latest.at));
}

function byApp(comments: readonly CommentFacts[], appLogin: string): CommentFacts[] {
  return comments.filter(({ author }) => author === appLogin);
}

/** When someone answered a `needs-info` question, as the Weekly summary reads it: a person's first comment after the label was last added. */
function answerOf(issue: OpenIssueFacts): string | null {
  const asked = Date.parse(lastAdded(issue.labelEvents, NEEDS_INFO) ?? issue.createdAt);
  return issue.comments.find((comment) => !comment.byBot && Date.parse(comment.at) > asked)?.at ?? null;
}

/** The kind of work a role's run is for. */
function workOf(role: AgentRole): StandingWork {
  const works: Readonly<Record<AgentRole, StandingWork>> = {
    triage: "issue",
    design: "design-session",
    implement: "ticket",
    review: "ticket",
    audit: "audit",
    retro: "retro",
    research: "research-decision",
  };
  return works[role];
}

/** Where a role's run puts its work on the Loop, or null where it has no place. */
function placeOf(role: AgentRole): StandingPlace | null {
  const places: Readonly<Record<AgentRole, StandingPlace | null>> = {
    triage: "triage",
    design: "design",
    implement: "implement",
    review: "review",
    audit: null,
    retro: null,
    research: null,
  };
  return places[role];
}

/** The `held` Standings: placeholder until held runs are read. */
function heldStandingsOf(_facts: StandingFacts): StandingNamed<"held">[] {
  return [];
}

/** The fields of a Standing of work the Kit moves, or nobody does: none of these can turn Stuck. */
function inFlight(
  repo: string,
  issue: number | null,
  pullRequest: number | null,
  since: string,
  work: StandingWork,
  place: StandingPlace | null,
  awaits: Standing["awaits"],
  move: "kit" | "nobody" = "kit",
) {
  return { schema: STANDING_SCHEMA, repo, issue, pullRequest, work, place, move, yours: false, stopsWork: false, since, stuckAt: null, awaits, subscription: null } as const;
}

void DEFAULT_KIT_CONFIG;
void inFlightOf;
void waitingForDispatch;
void heldOf;
void waitingHeldRuns;
void waitingIssues;
void whyNotResearchable;
export type { KitConfig };
