// Every other silence while the next move is the Kit's (src/kit/standing.ts):
// `waiting-on-kit`, from when the next move became the Kit's, turning Stuck at
// the repo's bar with no sign from the Kit (src/kit/standingClock.ts), or never
// where the facts can't date it. With them, the one look-alike that is the
// Operator's: a passed draft they put back in draft, `parked`.
import type { AgentRole } from "../loop/types.ts";
import { verdictsOn } from "./retroEvidence.ts";
import { type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { barOf, clockOf, stuckAtOf } from "./standingClock.ts";
import type { OpenPullRequestFacts } from "./weeklySummary.ts";

/** Which silence a `waiting-on-kit` Standing is. */
export type WaitingOnKitSilence = "conflicting-draft" | "quiet-draft";

/** Every `waiting-on-kit` and `parked` Standing in the repo: each pull request's first, so a Ticket's own leftover gives way to its draft's. */
export function silenceStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const bar = barOf(facts);
  return facts.github.openPullRequests.flatMap((pullRequest) => draftSilencesOn(pullRequest, facts, bar));
}

/**
 * An agent draft's silence, from its last push: one that conflicts with
 * `main` with no Verdict on its head, so GitHub started no Review of it; else
 * one with nothing above to explain it.
 */
function draftSilencesOn(pullRequest: OpenPullRequestFacts, facts: StandingFacts, bar: number): Standing[] {
  if (!pullRequest.draft) return [];
  const since = lastPushOf(pullRequest);
  const silence = (silence: WaitingOnKitSilence, role: AgentRole) =>
    waitingOnKit(facts, pullRequest.ticket, pullRequest, "ticket", "review", since, bar, { role, on: "pullRequest" }, { silence, round: null });
  // GitHub starts no Review of a push while the PR conflicts: the Kit's conflict-only run brings it up to date. Not yet known reads as merging cleanly.
  if (pullRequest.mergeable === false && !hasVerdictOnHead(pullRequest)) return [silence("conflicting-draft", "implement")];
  return [silence("quiet-draft", "review")];
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
