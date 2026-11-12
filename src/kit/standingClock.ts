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
import type { OpenIssueFacts } from "./weeklySummary.ts";

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

/** Each trigger label on an open issue, from when it was last added. */
function triggerSilencesOn(issue: OpenIssueFacts, { github }: StandingFacts, bar: number): StandingNamed<"not-started">[] {
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
        stuckAt: new Date(Date.parse(since) + bar * 60_000).toISOString(),
        awaits: { role: asked.role, on: "issue" },
        subscription: null,
        detail: { silence: "trigger-label", label },
      },
    ];
  });
}
