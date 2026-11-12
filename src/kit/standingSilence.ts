// Every other silence while the next move is the Kit's (src/kit/standing.ts):
// `waiting-on-kit`, from when the next move became the Kit's, turning Stuck at
// the repo's bar with no sign from the Kit (src/kit/standingClock.ts), or never
// where the facts can't date it. With them, the one look-alike that is the
// Operator's: a passed draft they put back in draft, `parked`.
import { notDismissedIn, type PullRequestHistoryItem, requestChangesSinceRunIn } from "../github/threads.ts";
import { waitingForDispatch } from "../loop/dispatch.ts";
import { heldOf } from "../loop/heldRun.ts";
import { NEEDS_DESIGN, NEEDS_INFO, NEEDS_TRIAGE, READY_FOR_AGENT } from "../loop/labels.ts";
import { DESIGN_ROUND_MARKER } from "../loop/markers.ts";
import type { AgentRole } from "../loop/types.ts";
import { isOperatorsReplay, replayResultsIn } from "./replay.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { barOf, clockOf, stuckAtOf } from "./standingClock.ts";
import { designSessionsStartingOf, hasVerdictOnHead, isSpec, maxInFlightHoldOf, readySince } from "./standingInFlight.ts";
import { answerOf, lastAdded, passAtHeadOf } from "./standingOperator.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** Which silence a `waiting-on-kit` Standing is. */
export type WaitingOnKitSilence =
  | "request-changes"
  | "conflicting-draft"
  | "needs-info-answered"
  | "needs-triage"
  | "round-answered"
  | "passed-draft"
  | "quiet-draft"
  | "releasable"
  | "design-slot-free"
  | "replay-between-steps"
  | "left-over";

/** Every `waiting-on-kit` and `parked` Standing in the repo: each pull request's first, so a Ticket's own leftover gives way to its draft's. */
export function silenceStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const bar = barOf(facts);
  return [
    ...facts.github.openPullRequests.flatMap((pullRequest) => [...requestChangesSilencesOn(pullRequest, facts, bar), ...draftSilencesOn(pullRequest, facts, bar)]),
    ...facts.github.openIssues.flatMap((issue) => issueSilencesOn(issue, facts, bar)),
    ...releasableSilencesOf(facts),
    ...designSlotFreeSilencesOf(facts),
    ...replaySilencesOf(facts),
    // Last, so each gives way to any silence above on the same work.
    ...facts.github.openPullRequests.flatMap((pullRequest) => leftOverOnPullRequest(pullRequest, facts)),
    ...facts.github.openIssues.flatMap((issue) => leftOverOnIssue(issue, facts)),
  ];
}

/** The state labels an open issue on the Loop carries, in the order a left-over one is read by: its work and place on the Loop. */
const LEFT_OVER_LABELS: readonly { readonly label: string; readonly work: StandingWork; readonly place: StandingPlace }[] = [
  { label: NEEDS_TRIAGE, work: "issue", place: "triage" },
  { label: NEEDS_INFO, work: "issue", place: "triage" },
  { label: NEEDS_DESIGN, work: "design-session", place: "design" },
  { label: READY_FOR_AGENT, work: "ticket", place: "implement" },
];

/**
 * An open issue labelled `needs-triage`, `needs-info`, `needs-design` or
 * `ready-for-agent` that no rule names: waiting on the Kit, never Stuck, as
 * the rule can't date it, since its label was last added, or it was opened. A
 * Spec has none of its own.
 */
function leftOverOnIssue(issue: OpenIssueFacts, facts: StandingFacts): StandingNamed<"waiting-on-kit">[] {
  const on = LEFT_OVER_LABELS.find(({ label }) => issue.labels.includes(label));
  if (on === undefined || isSpec(issue)) return [];
  return [waitingOnKit(facts, issue.number, null, on.work, on.place, lastAdded(issue.labelEvents, on.label) ?? issue.createdAt, null, null, { silence: "left-over", round: null })];
}

/** An open agent PR out of draft that no rule names: waiting on the Kit at the Merge gate, never Stuck, since it last left draft, or was last pushed. */
function leftOverOnPullRequest(pullRequest: OpenPullRequestFacts, facts: StandingFacts): StandingNamed<"waiting-on-kit">[] {
  if (pullRequest.draft) return [];
  const since = pullRequest.draftEvents.findLast(({ kind }) => kind === "ready")?.at ?? lastPushOf(pullRequest);
  return [waitingOnKit(facts, pullRequest.ticket, pullRequest, "ticket", "merge-gate", since, null, null, { silence: "left-over", round: null })];
}

/**
 * Each of the Operator's open Replays with its results not yet in and nothing
 * of its own running: between its steps, which the Kit takes at its hourly
 * check. Never Stuck, as the facts don't say when its last step ended; the
 * `agent:replay` the Kit adds starts a clock. Since its body was last written.
 */
function replaySilencesOf(facts: StandingFacts): StandingNamed<"waiting-on-kit">[] {
  return facts.github.openReplays
    .filter((replay) => isOperatorsReplay(replay, facts.operator) && !replayResultsIn(replay.body))
    .map((replay) =>
      waitingOnKit(facts, replay.number, null, "replay", null, replay.lastEditedAt ?? replay.createdAt, null, { role: "replay", on: "issue" }, { silence: "replay-between-steps", round: null }),
    );
}

/**
 * Each `needs-design` issue the Design queue check would start a session on
 * now, a slot being free (designSessionsStartingOf), since it got
 * `needs-design`: never Stuck, as the facts don't say when the slot came free;
 * the `agent:design` the check adds starts a clock.
 */
function designSlotFreeSilencesOf(facts: StandingFacts): StandingNamed<"waiting-on-kit">[] {
  const starting = new Set(designSessionsStartingOf(facts));
  return facts.github.designQueue.issues
    .filter(({ number }) => starting.has(number))
    .map((issue) =>
      waitingOnKit(facts, issue.number, null, "design-session", "design", issue.neededDesignAt, null, { role: "design", on: "issue" }, { silence: "design-slot-free", round: null }),
    );
}

/**
 * Each Ticket and research Decision Dispatch would release, by its own rule
 * (waitingForDispatch), while max_in_flight leaves a slot free
 * (maxInFlightHoldOf): the next Dispatch check releases it. The facts don't
 * say when it became releasable, so it never turns Stuck; the trigger label
 * Dispatch adds starts a clock. Since it got its state label.
 */
function releasableSilencesOf(facts: StandingFacts): StandingNamed<"waiting-on-kit">[] {
  const { github, kit } = facts;
  if (kit === null || kit.dispatch === null || maxInFlightHoldOf(facts) !== null) return [];
  const { candidates } = kit.dispatch;
  const decisions = new Set(candidates.researchDecisions.map(({ number }) => number));
  const held = { implement: heldOf("implement", github.kitIssues), research: heldOf("research", github.kitIssues) };
  return waitingForDispatch(candidates, held).flatMap((number) => {
    const decision = decisions.has(number);
    const since = readySince(github.openIssues, number, decision);
    if (since === null) return [];
    const awaits = { role: decision ? "research" : "implement", on: "issue" } as const;
    return [waitingOnKit(facts, number, null, decision ? "research-decision" : "ticket", decision ? null : "implement", since, null, awaits, { silence: "releasable", round: null })];
  });
}

/**
 * An open issue's silence, by the first that holds: its `needs-info` question
 * answered, from the first answer; `needs-triage`, from when it was last
 * added, whoever added it; a Design session's Round the Operator answered,
 * from their reply. Each waits on the role's next run on the issue.
 */
function issueSilencesOn(issue: OpenIssueFacts, facts: StandingFacts, bar: number): StandingNamed<"waiting-on-kit">[] {
  const silence = (work: StandingWork, place: StandingPlace, role: AgentRole, since: string, silence: WaitingOnKitSilence, round: number | null = null) =>
    waitingOnKit(facts, issue.number, null, work, place, since, bar, { role, on: "issue" }, { silence, round });
  const answered = issue.labels.includes(NEEDS_INFO) ? answerOf(issue) : null;
  if (answered !== null) return [silence("issue", "triage", "triage", answered, "needs-info-answered")];
  if (issue.labels.includes(NEEDS_TRIAGE)) return [silence("issue", "triage", "triage", lastAdded(issue.labelEvents, NEEDS_TRIAGE) ?? issue.createdAt, "needs-triage")];
  const reply = issue.labels.includes(NEEDS_DESIGN) ? answeredRoundOf(issue, facts) : null;
  if (reply !== null) return [silence("design-session", "design", "design", reply.at, "round-answered", reply.round)];
  return [];
}

/** The Fabrik App's latest Round on an issue and the Operator's first reply after it, or null while none has replied. */
function answeredRoundOf({ comments }: OpenIssueFacts, { appLogin, operator }: StandingFacts): { readonly round: number; readonly at: string } | null {
  const at = comments.findLastIndex(({ author, body }) => author === appLogin && DESIGN_ROUND_MARKER.test(body));
  const round = comments[at]?.body.match(DESIGN_ROUND_MARKER)?.[1];
  const reply = comments.slice(at + 1).find(({ author, byBot }) => !byBot && author === operator);
  return at === -1 || round === undefined || reply === undefined ? null : { round: Number(round), at: reply.at };
}

/**
 * The Operator's Request changes on an agent PR for a Ticket that no
 * Request-changes run was started for, by the Loop's own reading of its
 * history (requestChangesSinceRunIn), as the undelivered-Request-changes
 * check reads it: not dismissed, not built, and not noted by the Kit. At
 * Implement, from when the oldest of them was submitted.
 */
function requestChangesSilencesOn(pullRequest: OpenPullRequestFacts, facts: StandingFacts, bar: number): StandingNamed<"waiting-on-kit">[] {
  if (pullRequest.ticket === null) return [];
  const history = historyOf(pullRequest, facts.appLogin);
  const { unbuiltChangesRequests, notedChangesRequests } = requestChangesSinceRunIn(history, notDismissedIn(history), facts.operator);
  const unnoted = unbuiltChangesRequests.filter(({ review, reviewer, reviewerIsBot }) => !reviewerIsBot && reviewer === facts.operator && !notedChangesRequests.includes(review));
  const oldest = unnoted.map(({ submittedAt }) => submittedAt).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (oldest === undefined) return [];
  return [waitingOnKit(facts, pullRequest.ticket, pullRequest, "ticket", "implement", oldest, bar, { role: "implement", on: "pullRequest" }, { silence: "request-changes", round: null })];
}

/**
 * What tells whether an agent PR's Request changes were built, as the Loop's
 * snapshot reads it: the Fabrik App's comments, the reviews requesting changes
 * (a dismissed one's state is no longer that) and its draft changes. An agent
 * PR opens as a draft; one whose draft changes weren't read has been as it is
 * all along, so it starts so.
 */
function historyOf(pullRequest: OpenPullRequestFacts, appLogin: string): PullRequestHistoryItem[] {
  const first = pullRequest.draftEvents[0];
  const opened = first === undefined ? (pullRequest.draft ? "draft" : "ready") : first.kind === "draft" ? "ready" : "draft";
  return [
    { kind: opened, at: pullRequest.createdAt },
    ...pullRequest.comments.filter(({ author }) => author === appLogin).map(({ body, at }): PullRequestHistoryItem => ({ kind: "bot-comment", at, body })),
    ...pullRequest.reviews
      .filter(({ state }) => state === "changes-requested")
      .map(({ id, author, at }): PullRequestHistoryItem => ({ kind: "changes-requested", at, review: id, reviewer: author, reviewerIsBot: author.endsWith("[bot]") })),
    ...pullRequest.draftEvents.map(({ kind, at }): PullRequestHistoryItem => ({ kind, at })),
  ];
}

/**
 * An agent draft's silence. With a pass on its head: parked, when someone
 * other than the Fabrik App put it back in draft since; waiting on the Kit to
 * open the Merge gate, from the pass, when it has not left draft since. Else,
 * from its last push: one that conflicts with `main` with no Verdict on its
 * head, so GitHub started no Review of it; or one with nothing above to
 * explain it.
 */
function draftSilencesOn(pullRequest: OpenPullRequestFacts, facts: StandingFacts, bar: number): Standing[] {
  if (!pullRequest.draft) return [];
  const silence = (silence: WaitingOnKitSilence, role: AgentRole, since = lastPushOf(pullRequest)) =>
    waitingOnKit(facts, pullRequest.ticket, pullRequest, "ticket", "review", since, bar, { role, on: "pullRequest" }, { silence, round: null });
  const passed = passAtHeadOf(pullRequest);
  if (passed !== null) {
    const after = pullRequest.draftEvents.filter(({ at }) => Date.parse(at) > Date.parse(passed));
    const parkedAt = after.findLast(({ kind }) => kind === "draft");
    if (parkedAt !== undefined && parkedAt.actor !== facts.appLogin) return [parked(facts.github.repo, pullRequest, parkedAt.at)];
    // Once it left draft since the pass, the Merge gate opened; a draft again is read as any other.
    if (after.length === 0) return [silence("passed-draft", "review", passed)];
  }
  // GitHub starts no Review of a push while the PR conflicts: the Kit's conflict-only run brings it up to date. Not yet known reads as merging cleanly.
  if (pullRequest.mergeable === false && !hasVerdictOnHead(pullRequest)) return [silence("conflicting-draft", "implement")];
  return [silence("quiet-draft", "review")];
}

/**
 * A draft with a pass on its head that someone other than the Fabrik App put
 * back in draft after that pass: the Operator's, parked, since they did it. It
 * stops no work and never turns Stuck.
 */
function parked(repo: string, pullRequest: OpenPullRequestFacts, since: string): StandingNamed<"parked"> {
  return {
    schema: STANDING_SCHEMA,
    repo,
    issue: pullRequest.ticket,
    pullRequest: pullRequest.number,
    work: "ticket",
    place: "review",
    name: "parked",
    move: "operator",
    yours: true,
    stopsWork: false,
    since,
    stuckAt: null,
    awaits: null,
    subscription: null,
    detail: {},
  };
}

/** When a pull request was last pushed, as near as its commits tell: its latest commit's time, or its opening when none was read. */
function lastPushOf({ commits, createdAt }: OpenPullRequestFacts): string {
  return commits.at(-1)?.at ?? createdAt;
}

/**
 * A `waiting-on-kit` Standing, turning Stuck at the bar from the clock, which
 * starts at `since` and restarts on each later sign from the Kit; or, with
 * `bar` null, a silence the rule can't date, which never turns Stuck.
 */
function waitingOnKit(
  facts: StandingFacts,
  issue: number | null,
  pullRequest: OpenPullRequestFacts | null,
  work: StandingWork,
  place: StandingPlace | null,
  since: string,
  bar: number | null,
  awaits: Standing["awaits"],
  detail: StandingNamed<"waiting-on-kit">["detail"],
): StandingNamed<"waiting-on-kit"> {
  const pullRequests = pullRequest === null ? facts.github.openPullRequests.filter(({ ticket }) => issue !== null && ticket === issue) : [pullRequest];
  const stuckAt = bar === null ? null : stuckAtOf(clockOf(since, issue, pullRequests, facts), bar);
  return {
    schema: STANDING_SCHEMA,
    repo: facts.github.repo,
    issue,
    pullRequest: pullRequest?.number ?? null,
    work,
    place,
    name: "waiting-on-kit",
    move: "kit",
    yours: false,
    stopsWork: false,
    since,
    stuckAt,
    awaits,
    subscription: null,
    detail,
  };
}
