// The clock, the Stuck bar and the silences of a run that was asked for and
// never began (src/kit/standing.ts): `not-started`, the Kit's, from when the
// next move became the Kit's, turning Stuck once the repo's bar
// (stuckBarMinutes, src/loop/recoveryWaits.ts) has passed with no sign from
// the Kit. Only the Kit's own signs restart the clock (ADR-0007): a person's
// comment, label or review never does.
import { stuckBarMinutes } from "../loop/recoveryWaits.ts";
import { DISPATCH_LABEL, TRIGGER_LABELS, type TriggerLabel } from "../loop/labels.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type AwaitedRole, type Standing, STANDING_SCHEMA, type StandingFacts, type StandingNamed, type StandingPlace, type StandingWork } from "./standing.ts";
import { lastAdded } from "./standingOperator.ts";
import type { OpenIssueFacts, OpenPullRequestFacts } from "./weeklySummary.ts";

/** Which silence a `not-started` Standing is: a trigger label with no run behind it, the same after the sweep's re-add, or a Retry a Verdict announced. */
export type NotStartedSilence = "trigger-label";

/** What each trigger label asks for, on an issue: the work it is, its place on the Loop and the run it awaits. */
const ASKED_ON_ISSUES: Partial<Record<TriggerLabel, { readonly work: StandingWork; readonly place: StandingPlace | null; readonly role: AwaitedRole }>> = {
  [DISPATCH_LABEL]: { work: "ticket", place: "implement", role: "implement" },
};

/** Every `not-started` Standing in the repo: each run asked for that none has begun. */
export function notStartedStandingsOf(facts: StandingFacts, _now: string): Standing[] {
  const bar = stuckBarMinutes(facts.kit?.config.ok === true ? facts.kit.config.config : DEFAULT_KIT_CONFIG);
  return facts.github.openIssues.flatMap((issue) => triggerSilencesOn(issue, facts, bar));
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
    ...pullRequests.flatMap(({ commits, draftEvents = [] }) => [
      ...commits.filter(({ byApp }) => byApp).map(({ at }) => at),
      ...draftEvents.filter(({ actor }) => actor === appLogin).map(({ at }) => at),
    ]),
    ...runsEnded.filter((ended) => (ended.issue !== null && ended.issue === issue) || (ended.pullRequest !== null && numbers.has(ended.pullRequest))).map(({ at }) => at),
  ];
  return signs.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest), since);
}

/** When a silence on the clock turns Stuck: the clock plus the repo's bar, in minutes. */
function stuckAtOf(clock: string, bar: number): string {
  return new Date(Date.parse(clock) + bar * 60_000).toISOString();
}

/** The open agent pull requests that close this Ticket. */
function pullRequestsOf(issue: number, { github }: StandingFacts): OpenPullRequestFacts[] {
  return github.openPullRequests.filter(({ ticket }) => ticket === issue);
}

/** Each trigger label on an open issue, from when it was last added. */
function triggerSilencesOn(issue: OpenIssueFacts, facts: StandingFacts, bar: number): StandingNamed<"not-started">[] {
  const { github } = facts;
  return TRIGGER_LABELS.flatMap((label): StandingNamed<"not-started">[] => {
    const asked = ASKED_ON_ISSUES[label];
    const since = lastAdded(issue.labelEvents, label);
    if (asked === undefined || !issue.labels.includes(label) || since === null) return [];
    return [
      {
        schema: STANDING_SCHEMA,
        repo: github.repo,
        issue: issue.number,
        pullRequest: null,
        work: asked.work,
        place: asked.place,
        name: "not-started",
        move: "kit",
        yours: false,
        stopsWork: false,
        since,
        stuckAt: stuckAtOf(clockOf(since, issue.number, pullRequestsOf(issue.number, facts), facts), bar),
        awaits: { role: asked.role, on: "issue" },
        subscription: null,
        detail: { silence: "trigger-label", label },
      },
    ];
  });
}
