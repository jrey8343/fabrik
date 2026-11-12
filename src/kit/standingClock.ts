// The clock, the Stuck bar and the silences of a run that was asked for and
// never began (src/kit/standing.ts): `not-started`, the Kit's, from when the
// next move became the Kit's, turning Stuck once the repo's bar
// (stuckBarMinutes, src/loop/recoveryWaits.ts) has passed with no sign from
// the Kit. Only the Kit's own signs restart the clock (ADR-0007): a person's
// comment, label or review never does.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { countLandedNothing, pushedSinceVerdictIn, retryNoteSinceVerdictIn } from "../github/threads.ts";
import { DESIGN_LABEL, DIGEST_LABEL, DISPATCH_LABEL, READY_FOR_AGENT, REPLAY_TRIGGER_LABEL, RESEARCH_LABEL, REVIEW_LABEL, TRIGGER_LABELS, type TriggerLabel } from "../loop/labels.ts";
import { stuckTriggerReaddedMarker } from "../loop/markers.ts";
import { stuckBarMinutes } from "../loop/recoveryWaits.ts";
import { MAX_RETRIES, retryNumber } from "../loop/retry.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type CommentFacts, type LabelEvent, verdictsOn } from "./retroEvidence.ts";
import { type AwaitedRole, type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { addedAndStillOn, lastAdded } from "./standingOperator.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** Which silence a `not-started` Standing is: a trigger label with no run behind it, the same after the sweep's re-add, or a Retry a Verdict announced. */
export type NotStartedSilence = "trigger-label" | "trigger-readded" | "retry";

/** What each trigger label asks for, on an issue: the work it is, its place on the Loop and the run it awaits. agent:review asks on a pull request. */
const ASKED_ON_ISSUES: Partial<Record<TriggerLabel, { readonly work: StandingWork; readonly place: StandingPlace | null; readonly role: AwaitedRole }>> = {
  [DISPATCH_LABEL]: { work: "ticket", place: "implement", role: "implement" },
  [DESIGN_LABEL]: { work: "design-session", place: "design", role: "design" },
  [RESEARCH_LABEL]: { work: "research-decision", place: null, role: "research" },
  [REPLAY_TRIGGER_LABEL]: { work: "replay", place: null, role: "replay" },
};

/** The roles whose runs a trigger label waits on: a Replay's steps are Implement and Review runs, as the stuck-trigger sweep counts them. */
const ROLES_BEHIND: Readonly<Record<TriggerLabel, readonly AwaitedRole[]>> = {
  [DISPATCH_LABEL]: ["implement"],
  [DESIGN_LABEL]: ["design"],
  [REVIEW_LABEL]: ["review"],
  [RESEARCH_LABEL]: ["research"],
  [REPLAY_TRIGGER_LABEL]: ["replay", "implement", "review"],
  [DIGEST_LABEL]: ["digest"],
};

/**
 * Every `not-started` Standing in the repo: each run asked for that none has
 * begun, read on the repo's own bar, or the Kit's default timeouts' when its
 * Kit config wasn't read or is invalid. With the runs unread, no run is known.
 */
export function notStartedStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const bar = barOf(facts);
  const runs = facts.kit === null || facts.kit.runsInFlight === "unread" ? [] : facts.kit.runsInFlight;
  return [
    // First, so a Retry is read as one, not as the agent:implement on its Ticket the Verdict added for it.
    ...facts.github.openPullRequests.flatMap((pullRequest) => retrySilencesOn(pullRequest, facts, runs, bar)),
    ...facts.github.openIssues.flatMap((issue) => triggerSilencesOn(issue, facts, runs, bar)),
    ...facts.github.openPullRequests.flatMap((pullRequest) => reviewSilencesOn(pullRequest, facts, runs, bar)),
  ];
}

/**
 * When the work's clock last started: `since`, when the next move became the
 * Kit's, or the latest sign from the Kit on the issue or its pull requests
 * after it. A sign is a comment the Fabrik App posts, a label it adds or
 * removes, a commit it pushes to the branch, it taking the pull request into
 * or out of draft, or a run on the work ending, where the facts say when one
 * ended. A person's comment, label or review is no sign (ADR-0007); held
 * lines never reach the facts as comments.
 */
export function clockOf(since: string, issue: number | null, pullRequests: readonly OpenPullRequestFacts[], { github, appLogin, runsEnded }: StandingFacts): string {
  const open = github.openIssues.find(({ number }) => number === issue);
  const numbers = new Set(pullRequests.map(({ number }) => number));
  const signs = [
    ...[open, ...pullRequests].flatMap((work) => [
      ...(work?.comments ?? []).filter(({ author }) => author === appLogin).map(({ at }) => at),
      ...(work?.labelEvents ?? []).filter(({ actor }) => actor === appLogin).map(({ at }) => at),
    ]),
    ...pullRequests.flatMap(({ commits, draftEvents }) => [
      ...commits.filter(({ byApp }) => byApp).map(({ at }) => at),
      ...draftEvents.filter(({ actor }) => actor === appLogin).map(({ at }) => at),
    ]),
    ...runsEnded.filter((ended) => (ended.issue !== null && ended.issue === issue) || (ended.pullRequest !== null && numbers.has(ended.pullRequest))).map(({ at }) => at),
  ];
  return signs.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest), since);
}

/** The repo's Stuck bar in minutes, from its own Kit config, or the Kit's default timeouts' when it wasn't read or is invalid. */
export function barOf({ kit }: Pick<StandingFacts, "kit">): number {
  return stuckBarMinutes(kit?.config.ok === true ? kit.config.config : DEFAULT_KIT_CONFIG);
}

/** When a silence on the clock turns Stuck: the clock plus the repo's bar, in minutes. */
export function stuckAtOf(clock: string, bar: number): string {
  return new Date(Date.parse(clock) + bar * 60_000).toISOString();
}

/** The open agent pull requests that close this Ticket. */
function pullRequestsOf(issue: number, { github }: StandingFacts): OpenPullRequestFacts[] {
  return github.openPullRequests.filter(({ ticket }) => ticket === issue);
}

/** Each trigger label on an open issue with no run of its role behind it, since it was last added. */
function triggerSilencesOn(issue: OpenIssueFacts, facts: StandingFacts, runs: readonly RunInFlightFact[], bar: number): StandingNamed<"not-started">[] {
  return TRIGGER_LABELS.flatMap((label): StandingNamed<"not-started">[] => {
    const asked = ASKED_ON_ISSUES[label];
    const since = lastAdded(issue.labelEvents, label);
    if (asked === undefined || !issue.labels.includes(label) || since === null || hasRunBehind(label, runs, issue.number, null)) return [];
    const silence = readdedSinceOff(label, issue.labelEvents, issue.comments, facts.appLogin) ? "trigger-readded" : "trigger-label";
    const clock = clockOf(since, issue.number, pullRequestsOf(issue.number, facts), facts);
    return [notStarted(facts.github.repo, issue.number, null, asked.work, asked.place, since, stuckAtOf(clock, bar), { role: asked.role, on: "issue" }, { silence, label })];
  });
}

/** `agent:review` on an open agent pull request with no Review behind it, since it was last added. */
function reviewSilencesOn(pullRequest: OpenPullRequestFacts, facts: StandingFacts, runs: readonly RunInFlightFact[], bar: number): StandingNamed<"not-started">[] {
  const since = addedAndStillOn(pullRequest.labelEvents, REVIEW_LABEL);
  if (since === null || hasRunBehind(REVIEW_LABEL, runs, pullRequest.ticket, pullRequest.number)) return [];
  const silence = readdedSinceOff(REVIEW_LABEL, pullRequest.labelEvents, pullRequest.comments, facts.appLogin) ? "trigger-readded" : "trigger-label";
  const clock = clockOf(since, pullRequest.ticket, [pullRequest], facts);
  return [
    notStarted(facts.github.repo, pullRequest.ticket, pullRequest.number, "ticket", "review", since, stuckAtOf(clock, bar), { role: "review", on: "pullRequest" }, { silence, label: REVIEW_LABEL }),
  ];
}

/**
 * A Retry an agent draft's latest Verdict, an Execution flaw, announced, with
 * no Implement run started for it since, from the Verdict: read from the
 * Fabrik App's comments as the Loop reads whether one is in flight
 * (runInFlight, src/loop/retry.ts). None was announced on a flaw that found
 * its Ticket no longer `ready-for-agent`, or gave way to the Operator's
 * Request changes, or once the Ticket's Retries are used up, counting its
 * runs that landed nothing; none is owed once a Retry pushed or the Kit ended
 * it, or once the pull request left draft. The Kit's note that it added
 * `agent:implement` again for it is a sign, so the clock restarts there.
 */
function retrySilencesOn(pullRequest: OpenPullRequestFacts, facts: StandingFacts, runs: readonly RunInFlightFact[], bar: number): StandingNamed<"not-started">[] {
  const { ticket } = pullRequest;
  const verdicts = verdictsOn(pullRequest.comments);
  const latest = verdicts.at(-1);
  if (!pullRequest.draft || ticket === null || latest === undefined || latest.record.verdict !== "execution-flaw") return [];
  if (latest.record.ticketNotReady === true || latest.record.requestChangesFirst !== undefined) return [];
  const notes = pullRequest.comments.filter(({ author }) => author === facts.appLogin).map(({ body }) => body);
  if (pushedSinceVerdictIn(notes) || retryNoteSinceVerdictIn(notes) === "ended") return [];
  if (pullRequest.draftEvents.some(({ kind, at }) => kind === "ready" && Date.parse(at) > Date.parse(latest.at))) return [];
  const open = facts.github.openIssues.find(({ number }) => number === ticket);
  if (open !== undefined && open.labels.length > 0 && !open.labels.includes(READY_FOR_AGENT)) return [];
  const landedNothing = countLandedNothing((open?.comments ?? []).map(({ body, author }) => ({ body, byApp: author === facts.appLogin })));
  if (retryNumber(verdicts.slice(0, -1).map(({ record }) => record), landedNothing) > MAX_RETRIES) return [];
  if (hasRunBehind(DISPATCH_LABEL, runs, ticket, pullRequest.number)) return [];
  const clock = clockOf(latest.at, ticket, pullRequestsOf(ticket, facts), facts);
  return [
    notStarted(facts.github.repo, ticket, pullRequest.number, "ticket", "implement", latest.at, stuckAtOf(clock, bar), { role: "implement", on: "pullRequest" }, { silence: "retry", label: null }),
  ];
}

/**
 * Whether a run of the label's role is in flight for this work: one that names
 * it, or one told by its job's name that carries no number, which counts for
 * every piece of work waiting on its role, as the stuck-trigger sweep counts
 * it. An exact run counts only for the work it names (#617).
 */
function hasRunBehind(label: TriggerLabel, runs: readonly RunInFlightFact[], issue: number | null, pullRequest: number | null): boolean {
  return runs.some(
    (run) =>
      ROLES_BEHIND[label].includes(run.role) &&
      ((!run.exact && run.issue === null && run.pullRequest === null) ||
        (run.issue !== null && run.issue === issue) ||
        (run.pullRequest !== null && run.pullRequest === pullRequest)),
  );
}

/** A `not-started` Standing: the Kit's, never yet the Operator's. */
function notStarted(
  repo: string,
  issue: number | null,
  pullRequest: number | null,
  work: StandingWork,
  place: StandingPlace | null,
  since: string,
  stuckAt: string,
  awaits: NonNullable<Standing["awaits"]>,
  detail: StandingNamed<"not-started">["detail"],
): StandingNamed<"not-started"> {
  return { schema: STANDING_SCHEMA, repo, issue, pullRequest, work, place, name: "not-started", move: "kit", yours: false, stopsWork: false, since, stuckAt, awaits, subscription: null, detail };
}

/**
 * Whether the stuck-trigger sweep's re-add of `label` is the latest word on
 * it: the Fabrik App's re-add note came after the label last came off, as
 * stuckTriggerReaddedIn reads it from one timeline. The re-add takes the
 * label off and adds it in the same second as its note, so a note at that
 * second counts as after.
 */
function readdedSinceOff(label: TriggerLabel, events: readonly LabelEvent[], comments: readonly CommentFacts[], appLogin: string): boolean {
  const off = events.filter((event) => event.label === label && event.action === "unlabeled").map(({ at }) => Date.parse(at));
  const lastOff = off.length === 0 ? -Infinity : Math.max(...off);
  return comments.some(({ author, body, at }) => author === appLogin && body.startsWith(stuckTriggerReaddedMarker(label)) && Date.parse(at) >= lastOff);
}
