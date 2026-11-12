// Every other silence while the next move is the Kit's (src/kit/standing.ts):
// `waiting-on-kit`, from when the next move became the Kit's, turning Stuck at
// the repo's bar with no sign from the Kit (src/kit/standingClock.ts), or never
// where the facts can't date it. With them, the one look-alike that is the
// Operator's: a passed draft they put back in draft, `parked`.
import { notDismissedIn, type PullRequestHistoryItem, requestChangesSinceRunIn } from "../github/threads.ts";
import type { AgentRole } from "../loop/types.ts";
import { verdictsOn } from "./retroEvidence.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { barOf, clockOf, stuckAtOf } from "./standingClock.ts";
import { passAtHeadOf } from "./standingOperator.ts";
import type { OpenPullRequestFacts } from "./weeklySummary.ts";

/** Which silence a `waiting-on-kit` Standing is. */
export type WaitingOnKitSilence = "request-changes" | "conflicting-draft" | "passed-draft" | "quiet-draft";

/** Every `waiting-on-kit` and `parked` Standing in the repo: each pull request's first, so a Ticket's own leftover gives way to its draft's. */
export function silenceStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const bar = barOf(facts);
  return facts.github.openPullRequests.flatMap((pullRequest) => [...requestChangesSilencesOn(pullRequest, facts, bar), ...draftSilencesOn(pullRequest, facts, bar)]);
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

/** Whether a pull request's head has a Verdict. */
function hasVerdictOnHead(pullRequest: OpenPullRequestFacts): boolean {
  return verdictsOn(pullRequest.comments).some(({ record }) => record.headSha === pullRequest.headSha);
}
