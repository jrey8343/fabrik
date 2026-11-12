// The Standings of work that goes on without the Operator (src/kit/standing.ts):
// a run in flight for it (`running`), an agent draft whose Review waits for its
// Required checks (`waiting-on-checks`), a Held run (`held`), work a slot holds
// (`waiting-for-slot`), and a Ticket or research Decision its blockers hold
// (`blocked`). Each is read by the Loop's own rule for it, so the Standing and
// the Loop can't disagree, and none can turn Stuck.
import { dispatchedRunsOf, type RunInFlightFact, type RunKind } from "../github/snapshot.ts";
import { conflictRunInFlightIn } from "../github/threads.ts";
import { checkDesignQueue, waitingIssues } from "../loop/designQueue.ts";
import { inFlightOf, waitingForDispatch } from "../loop/dispatch.ts";
import { heldOf, waitingHeldRuns } from "../loop/heldRun.ts";
import {
  DIGEST_LABEL,
  DISPATCH_LABEL,
  MAP_LABEL,
  NEEDS_INFO,
  NEEDS_TRIAGE,
  READY_FOR_AGENT,
  RESEARCH_DECISION_LABEL,
  RESEARCH_LABEL,
  REVIEW_LABEL,
} from "../loop/labels.ts";
import { auditMarksIn, retroMarksIn } from "../loop/markers.ts";
import { whyNotResearchable } from "../loop/research.ts";
import { type AgentRole, isOfPullRequest } from "../loop/types.ts";
import { DAY, FAILED_RUNS_A_WEEK, failedInWeek, weekStart } from "../loop/weeklyGate.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type CommentFacts, type LabelEvent, verdictsOn } from "./retroEvidence.ts";
import { type AwaitedRole, type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { addedAndStillOn, answerOf, lastAdded, passAtHeadOf } from "./standingOperator.ts";
import type { GitHubFacts, OpenIssueFacts, OpenPullRequestFacts, WeeklyRunIssueFacts } from "./weeklySummary.ts";

/** What a `running` Standing's `detail.run` names: the kind of run, as far as the facts tell it. */
export type RunningRun = "implement" | "retry" | "request-changes" | "conflict-only" | "review" | "digest" | "triage" | "research" | "design" | "prototype";

/**
 * Every Standing of the repo's work that goes on without the Operator, or that
 * nothing moves while its blockers are open, an Audit or Retro week given up
 * among them. A Spec has none.
 */
export function inFlightStandingsOf(facts: StandingFacts, now: string): Standing[] {
  const runs = facts.kit === null || facts.kit.runsInFlight === "unread" ? null : facts.kit.runsInFlight;
  const held = heldStandingsOf(facts);
  const heldWork = new Set(held.map(({ issue, pullRequest, detail }) => (detail.role === "review" ? `pr#${pullRequest}` : `#${issue}`)));
  const specs = new Set(facts.github.openIssues.filter(isSpec).map(({ number }) => number));
  return [
    ...(runs === null ? [] : [...runningStandingsOf(facts, runs, heldWork), ...waitingOnChecksStandingsOf(facts, runs, heldWork)]),
    ...held,
    ...givenUpStandingsOf(facts, now),
    ...slotStandingsOf(facts),
    ...blockedStandingsOf(facts),
  ].filter(({ issue }) => issue === null || !specs.has(issue));
}

/**
 * The Tickets and research Decisions Dispatch would release while
 * max_in_flight holds them, by Dispatch's own rules (waitingForDispatch,
 * inFlightOf), so the Standing, Held and Dispatch can't disagree: paused at
 * 0, or every slot taken, counting what's in flight. Null when none waits or a
 * slot is free, as the next Tick's Dispatch check releases it (#418), and
 * when Dispatch's candidates weren't read. With the runs in flight unread,
 * what was read can't show a slot free, so it counts as full, marked.
 */
export type MaxInFlightHold =
  | { readonly kind: "paused"; readonly maxInFlight: 0; readonly waiting: readonly number[] }
  | {
      readonly kind: "full";
      readonly maxInFlight: number;
      /** The slots taken, as Dispatch counts them, or as much of it as could be read. */
      readonly inFlight: number;
      /** The Tickets and Decisions in flight the facts name, lowest first: a draft PR's Ticket, a running one, a dispatched one, a held one. */
      readonly inFlightIssues: readonly number[];
      readonly runsUnread: boolean;
      readonly waiting: readonly number[];
    };

export function maxInFlightHoldOf({ github, kit }: Pick<StandingFacts, "github" | "kit">): MaxInFlightHold | null {
  if (kit === null || kit.dispatch === null) return null;
  const { candidates } = kit.dispatch;
  const { maxInFlight } = kit.config.ok ? kit.config.config : DEFAULT_KIT_CONFIG;
  const heldRuns = { implement: heldOf("implement", github.kitIssues), research: heldOf("research", github.kitIssues) };
  const waiting = waitingForDispatch(candidates, heldRuns);
  if (waiting.length === 0) return null;
  if (maxInFlight === 0) return { kind: "paused", maxInFlight, waiting };
  const runs = kit.runsInFlight === "unread" ? null : dispatchedRunsOf(kit.runsInFlight);
  // The Weekly summary's facts hold only agent PRs, so their open drafts are Dispatch's open agent draft PRs.
  const drafts = github.openPullRequests.filter(({ draft }) => draft);
  const inFlight = inFlightOf(
    { ...candidates, openAgentDraftPullRequests: drafts.length, implementRunsInProgress: runs?.implement ?? 0, researchRunsInProgress: runs?.research ?? 0 },
    heldRuns,
  );
  if (runs !== null && inFlight.total < maxInFlight) return null;
  const named = [...drafts.flatMap(({ ticket }) => (ticket === null ? [] : [ticket])), ...(runs?.implementTickets ?? []), ...inFlight.waiting, ...inFlight.held];
  return { kind: "full", maxInFlight, inFlight: inFlight.total, inFlightIssues: [...new Set(named)].sort((a, b) => a - b), runsUnread: runs === null, waiting };
}

/**
 * The `needs-design` issues the Design queue check would start a session on
 * now, a slot being free, by its own rule (checkDesignQueue), on the repo's
 * Kit config, or the Kit's defaults when it wasn't read or is invalid. None
 * of them waits for a slot: each waits on the Kit (src/kit/standingSilence.ts).
 */
export function designSessionsStartingOf({ github, kit }: Pick<StandingFacts, "github" | "kit">): number[] {
  const plan = checkDesignQueue(github.designQueue, kit?.config.ok === true ? kit.config.config : DEFAULT_KIT_CONFIG, heldOf("design", github.kitIssues));
  return plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "add-labels" ? [action.issue] : [])) : [];
}

/**
 * Work a slot holds: each Ticket or research Decision max_in_flight holds
 * (maxInFlightHoldOf), since it got its trigger state label, and each
 * `needs-design` issue waiting for a Design session slot, by the Design queue
 * check's own rule (waitingIssues), since it got `needs-design`, but those it
 * would start a session on now.
 */
function slotStandingsOf({ github, kit }: StandingFacts): StandingNamed<"waiting-for-slot">[] {
  const hold = maxInFlightHoldOf({ github, kit });
  const decisions = new Set(kit?.dispatch?.candidates.researchDecisions.map(({ number }) => number) ?? []);
  const dispatch = (hold?.waiting ?? []).flatMap((number): StandingNamed<"waiting-for-slot">[] => {
    const decision = decisions.has(number);
    const since = readySince(github.openIssues, number, decision);
    if (since === null || hold === null) return [];
    return [
      {
        ...inFlight(github.repo, number, null, since, decision ? "research-decision" : "ticket", decision ? null : "implement", { role: decision ? "research" : "implement", on: "issue" }),
        name: "waiting-for-slot",
        detail: { slot: "max-in-flight", maxInFlight: hold.maxInFlight },
      },
    ];
  });
  const starting = new Set(designSessionsStartingOf({ github, kit }));
  const design = waitingIssues(github.designQueue).filter(({ number }) => !starting.has(number)).map(
    (issue): StandingNamed<"waiting-for-slot"> => ({
      ...inFlight(github.repo, issue.number, null, issue.neededDesignAt, "design-session", "design", { role: "design", on: "issue" }),
      name: "waiting-for-slot",
      detail: { slot: "design-session", maxInFlight: null },
    }),
  );
  return [...dispatch, ...design];
}

/**
 * Each `ready-for-agent` Ticket with open blockers, or one closed as not
 * planned, and each research Decision on a live Map with open blockers, as
 * Dispatch reads them: nothing moves it, so the move is nobody's.
 */
function blockedStandingsOf({ github, kit }: StandingFacts): StandingNamed<"blocked">[] {
  const candidates = kit?.dispatch?.candidates ?? { tickets: [], researchDecisions: [] };
  const blocked = (number: number, blockers: readonly number[], decision: boolean): StandingNamed<"blocked">[] => {
    const since = readySince(github.openIssues, number, decision);
    if (since === null) return [];
    return [
      {
        ...inFlight(github.repo, number, null, since, decision ? "research-decision" : "ticket", decision ? null : "implement", { role: decision ? "research" : "implement", on: "issue" }, "nobody"),
        name: "blocked",
        detail: { blockers: [...new Set(blockers)].sort((a, b) => a - b) },
      },
    ];
  };
  return [
    ...candidates.tickets
      .filter((ticket) => ticket.open && ticket.labels.includes(READY_FOR_AGENT) && ticket.subIssues === 0)
      .flatMap((ticket) => blocked(ticket.number, [...ticket.openBlockers, ...ticket.notPlannedBlockers], false)),
    ...candidates.researchDecisions.filter((decision) => decision.open && whyNotResearchable(decision) === null).flatMap((decision) => blocked(decision.number, decision.openBlockers, true)),
  ].filter(({ detail }) => detail.blockers.length > 0);
}

/** When an open issue got `ready-for-agent`, or `wayfinder:research` for a research Decision, or was opened with it; null when it isn't among the open issues. */
export function readySince(openIssues: readonly OpenIssueFacts[], number: number, decision: boolean): string | null {
  const issue = openIssues.find((open) => open.number === number);
  return issue === undefined ? null : (lastAdded(issue.labelEvents, decision ? RESEARCH_DECISION_LABEL : READY_FOR_AGENT) ?? issue.createdAt);
}

/**
 * Each agent draft whose Review is waiting for the Required checks on its
 * head: one with no Verdict on its head and no Review job naming it, while a
 * Review's wait for checks, or its re-run of red checks, is in flight for it,
 * since the oldest such wait began, though never for a Held run, which the
 * Kit hasn't started. An exact wait names its pull request (#617); one told by
 * its job's name carries no number, so it counts for every such draft.
 */
function waitingOnChecksStandingsOf({ github }: StandingFacts, runs: readonly RunInFlightFact[], heldWork: ReadonlySet<string>): StandingNamed<"waiting-on-checks">[] {
  const waits = runs.filter(({ role, job }) => role === "review" && job === "waiting-on-checks").toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (waits.length === 0) return [];
  const reviewed = new Set(runs.flatMap(({ role, job, pullRequest }) => (role === "review" && job !== "waiting-on-checks" && pullRequest !== null ? [pullRequest] : [])));
  return github.openPullRequests
    .filter((pullRequest) => pullRequest.draft && !hasVerdictOnHead(pullRequest) && !reviewed.has(pullRequest.number) && !heldWork.has(`pr#${pullRequest.number}`))
    .flatMap((pullRequest): StandingNamed<"waiting-on-checks">[] => {
      const oldest = waits.find((wait) => (wait.exact ? wait.pullRequest === pullRequest.number : wait.pullRequest === null));
      if (oldest === undefined) return [];
      return [
        {
          ...inFlight(github.repo, pullRequest.ticket, pullRequest.number, oldest.createdAt, "ticket", "review", { role: "review", on: "pullRequest" }),
          name: "waiting-on-checks",
          detail: { plain: null, check: null, checksUnread: false },
        },
      ];
    });
}

/** An open issue labelled `ready-for-agent` with sub-issues, not a Map: a Spec, which has no Standing of its own; its Tickets do. */
export function isSpec(issue: OpenIssueFacts): boolean {
  return issue.labels.includes(READY_FOR_AGENT) && !issue.labels.includes(MAP_LABEL) && issue.subIssues.length > 0;
}

/**
 * Each piece of work with a run in flight for it: one that names it, or one
 * told by its job's name that carries no number, which counts for every piece
 * of work waiting on its role, as the stuck-trigger sweep counts it, though
 * never for a Held run, which the Kit hasn't started. An exact run, read from
 * the Kit job's closing line, counts only for the work it names (#617). A
 * named run comes first, then the oldest.
 */
function runningStandingsOf(facts: StandingFacts, runs: readonly RunInFlightFact[], heldWork: ReadonlySet<string>): Standing[] {
  const { github, appLogin, operator } = facts;
  const counted = runs.filter(({ job }) => job !== "waiting-on-checks");
  const issues = github.openIssues.flatMap((issue): Standing[] => {
    // A Review's run and a Digest's name the Ticket too, but each is on its pull request, where it is read below.
    const named = counted.filter((run) => run.issue === issue.number && (run.role === "implement" || run.role === "design" || (run.exact && !isOfPullRequest(run.role))));
    const waiting = heldWork.has(`#${issue.number}`) ? [] : counted.filter((run) => !run.exact && run.issue === null && run.pullRequest === null && waitsOnRole(issue, run.role, appLogin));
    const run = firstOf(named, waiting);
    const standing = run === undefined ? null : runningOnIssue(issue, run, github.repo, github.openPullRequests, operator, appLogin);
    return standing === null ? [] : [standing];
  });
  const pullRequests = github.openPullRequests.flatMap((pullRequest): Standing[] => {
    const named = counted.filter((run) => run.role === "review" && run.pullRequest === pullRequest.number);
    const waits = !heldWork.has(`pr#${pullRequest.number}`) && waitsOnReview(pullRequest, appLogin);
    const waiting = waits ? counted.filter((run) => !run.exact && run.role === "review" && run.pullRequest === null) : [];
    const run = firstOf(named, waiting);
    if (run === undefined) return [];
    return [
      {
        ...inFlight(github.repo, pullRequest.ticket, pullRequest.number, runningSince(run), "ticket", "review", { role: "review", on: "pullRequest" }),
        name: "running",
        detail: { run: "review", retry: null, actionsRun: run.run },
      },
    ];
  });
  // After a run on its Ticket and a Review of it: either overtakes the Digest, which is then dropped.
  const digests = github.openPullRequests.flatMap((pullRequest): Standing[] => {
    const run = digestAskedOn(pullRequest) === null ? undefined : digestRunOn(counted, pullRequest.number);
    if (run === undefined) return [];
    return [
      {
        ...inFlight(github.repo, pullRequest.ticket, pullRequest.number, runningSince(run), "ticket", "review", { role: "digest", on: "pullRequest" }),
        name: "running",
        detail: { run: "digest", retry: null, actionsRun: run.run, passed: true },
      },
    ];
  });
  return [...issues, ...pullRequests, ...digests];
}

/**
 * When the Kit asked for a passed draft's Digest (#654): when `agent:digest`
 * was last added, whoever added it, to an agent draft whose latest Verdict on
 * its head is a pass, while the label is still on. Null for any other pull
 * request. The pass is given and the next move is the Kit's: the Merge gate
 * opens when the Digest's attempt ends, with a Digest or without.
 */
export function digestAskedOn(pullRequest: OpenPullRequestFacts): string | null {
  return pullRequest.draft && passAtHeadOf(pullRequest) !== null ? addedAndStillOn(pullRequest.labelEvents, DIGEST_LABEL) : null;
}

/**
 * The Digest run in flight on this pull request, the oldest of them: a Digest
 * job always names its pull request, so one on another pull request never
 * counts, though both close one Ticket.
 */
export function digestRunOn(runs: readonly RunInFlightFact[], pullRequest: number): RunInFlightFact | undefined {
  return firstOf(runs.filter((run) => run.role === "digest" && run.pullRequest === pullRequest), []);
}

/**
 * When a `running` Standing came to stand so: when its run's agent job got a
 * runner, or when Actions created the run while it has none (#621). The join
 * with runs (src/read/joinRuns.ts) takes the same time, so the two agree.
 */
export function runningSince(run: Pick<RunInFlightFact, "startedAt" | "createdAt">): string {
  return run.startedAt ?? run.createdAt;
}

/**
 * What a `running` Standing's `detail.run` names for a run of this role, as
 * the run's own kind tells it (#621): an exact run, read from the Kit job's
 * closing line, always carries one. Null when the run carries no kind, or for
 * a role no `running` Standing awaits.
 */
export function runningRunOf(role: AwaitedRole, kind: RunKind | null): RunningRun | null {
  if (kind === null) return null;
  switch (role) {
    case "implement":
      return kind === "first" || kind === "prototype" ? "implement" : kind;
    case "design":
      return kind === "prototype" ? "prototype" : "design";
    case "review":
    case "digest":
    case "triage":
    case "research":
      return role;
    default:
      return null;
  }
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
    ...inFlight(repo, issue.number, pullRequest, runningSince(run), work, place, { role, on: pullRequest === null ? "issue" : "pullRequest" }),
    name: "running" as const,
    detail: { run: kind, retry, actionsRun: run.run },
  });
  switch (run.role) {
    case "implement": {
      const pullRequest = openPullRequests.filter(({ ticket }) => ticket === issue.number).toSorted((a, b) => a.number - b.number)[0];
      const kind = runningRunOf("implement", run.kind) ?? (run.retry !== null ? "retry" : pullRequest === undefined ? "implement" : implementRunOn(pullRequest, operator, appLogin));
      return running("ticket", "implement", "implement", kind, run.retry, kind === "implement" ? null : (pullRequest?.number ?? null));
    }
    case "design":
      return running("design-session", "design", "design", runningRunOf("design", run.kind) ?? "design");
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

/** Whether a pull request's head has a Verdict. */
export function hasVerdictOnHead(pullRequest: OpenPullRequestFacts): boolean {
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

/** The kind of work a role's run is for: a Review's is its Ticket's. */
export function workOf(role: AgentRole): StandingWork {
  const works: Readonly<Record<AgentRole, StandingWork>> = {
    triage: "issue",
    design: "design-session",
    implement: "ticket",
    review: "ticket",
    audit: "audit",
    retro: "retro",
    research: "research-decision",
    digest: "ticket",
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
    digest: "review",
  };
  return places[role];
}

/**
 * Each piece of work whose run is a Held run, read by the scheduled tick's own
 * rule (waitingHeldRuns), so the Standing and the resume can't disagree,
 * carrying the Carrier its newest held marker is on. A Review's run is on its
 * PR, with the Ticket the PR closes; an Implement run whose held line is on
 * the Ticket's PR, as a Retry's is, awaits a run there.
 */
function heldStandingsOf({ github }: StandingFacts): StandingNamed<"held">[] {
  return waitingHeldRuns(github.kitIssues).map(({ run, heldAt, newest }) => {
    const pullRequest = run.role === "review" ? github.openPullRequests.find(({ number }) => number === run.issue) : undefined;
    const issue = run.role === "review" ? (pullRequest?.ticket ?? null) : run.issue;
    const onPullRequest = run.role === "review" || (run.lineOn !== undefined && run.lineOn !== run.issue);
    const carrier = github.kitIssues.find(({ number }) => number === newest.on);
    const since = heldAt ?? carrier?.createdAt ?? openSince(github, issue, run.role === "review" ? run.issue : null);
    return {
      ...inFlight(github.repo, issue, run.role === "review" ? run.issue : null, since, workOf(run.role), placeOf(run.role), { role: run.role, on: onPullRequest ? "pullRequest" : "issue" }),
      name: "held",
      detail: { carrier: newest.on, role: run.role },
    };
  });
}

/**
 * An Audit or Retro week the weekly gate gave up on: enough of the Fabrik
 * App's runs of it failed in one gate week, UTC Monday to Monday, that the next
 * waits for the next week, counted by the gate's own rule (failedInWeek).
 */
export interface GivenUpWeek {
  readonly role: "audit" | "retro";
  /** When the gate's next week begins, Monday 00:00 UTC, ISO 8601: the next run is held until then. */
  readonly until: string;
  /** The week's failed runs that gave it up, oldest first: the last of them gave it up. */
  readonly failed: readonly WeeklyRunIssueFacts[];
}

/**
 * Every Audit and Retro week the weekly gate gave up on, among the repo's
 * newest Audits and Retros, whenever it was: the one count the Standing and
 * the Weekly summary both read, so the two can't disagree.
 */
export function givenUpWeeksOf({ audits, retros }: Pick<GitHubFacts, "audits" | "retros">, appLogin: string): GivenUpWeek[] {
  const weeksOf = (role: GivenUpWeek["role"], issues: readonly WeeklyRunIssueFacts[], failed: (body: string) => boolean): GivenUpWeek[] => {
    const runs = issues.filter(({ author }) => author === appLogin).map((issue) => ({ issue, number: issue.number, createdAt: issue.createdAt, failed: failed(issue.body) }));
    const weeks = new Set(runs.map(({ createdAt }) => weekStart(createdAt)));
    return [...weeks].flatMap((start) => {
      const givenUp = failedInWeek(runs, start).slice(0, FAILED_RUNS_A_WEEK);
      return givenUp.length < FAILED_RUNS_A_WEEK ? [] : [{ role, until: new Date(start + 7 * DAY).toISOString(), failed: givenUp.map(({ issue }) => issue) }];
    });
  };
  return [...weeksOf("audit", audits, (body) => auditMarksIn(body).failed), ...weeksOf("retro", retros, (body) => retroMarksIn(body).failed)];
}

/**
 * Each Audit or Retro week given up on (givenUpWeeksOf), held, the Kit's, from
 * the last of its failed runs until the gate's next week begins, when the Kit
 * opens the next by itself. It names that last run's issue, though closed.
 */
function givenUpStandingsOf({ github, appLogin }: StandingFacts, now: string): StandingNamed<"held">[] {
  return givenUpWeeksOf(github, appLogin).flatMap(({ role, until, failed }): StandingNamed<"held">[] => {
    const last = failed.at(-1);
    if (last === undefined || Date.parse(now) < Date.parse(last.createdAt) || Date.parse(now) >= Date.parse(until)) return [];
    return [
      {
        ...inFlight(github.repo, last.number, null, last.createdAt, role, null, null),
        name: "held",
        detail: { carrier: null, role, failed: failed.map(({ number }) => number), until },
      },
    ];
  });
}

/**
 * When the work was opened, for a held run whose held markers' times weren't
 * read: its issue's, else its PR's, else the start of time, which says only
 * that it is not known.
 */
function openSince({ openIssues, openPullRequests }: StandingFacts["github"], issue: number | null, pullRequest: number | null): string {
  const opened = openIssues.find(({ number }) => number === issue)?.createdAt ?? openPullRequests.find(({ number }) => number === pullRequest)?.createdAt;
  return opened ?? new Date(0).toISOString();
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

