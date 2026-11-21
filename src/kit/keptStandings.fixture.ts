// Kept Standings (#793): for every schema a Standing has had, Standings as a
// reader of the read library kept them at it, which ./keptStanding.test.ts
// reads back at the current one. A release that moves STANDING_SCHEMA leaves
// each schema's Standings here as they were, freezing any the move changed as
// that schema held them, and adds the new schema's: the test fails until every
// schema from 1 to STANDING_SCHEMA has some.
import type { Standing, StandingName, StandingNamed } from "./standing.ts";

const SINCE = "2026-11-08T12:00:00Z";
const HEAD = "h".repeat(40);

/** A Standing at schema 2 of acme/shop's Ticket 12, with no pull request, the Kit's move, unless `fields` says otherwise. */
function aStanding<N extends StandingName>(name: N, detail: StandingNamed<N>["detail"], fields: Partial<Omit<StandingNamed<N>, "schema" | "name" | "detail">> = {}): Standing {
  const base = { repo: "acme/shop", issue: 12, pullRequest: null, work: "ticket", place: null, move: "kit", yours: false, stopsWork: false, since: SINCE, stuckAt: null, awaits: null, subscription: null };
  return { schema: 2, ...base, ...fields, name, detail } as Standing;
}

/** What every Standing of a merged agent pull request at Production carries. */
const AT_PRODUCTION = { pullRequest: 50, place: "production", move: "nobody" } as const;
const A_MERGE = { mergeCommit: "m".repeat(40), mergedAt: SINCE, environment: "production", noDeployAt: null, deployment: null, log: null, deploysUnread: false } as const;
const THE_OPERATORS = { move: "operator", yours: true, stopsWork: true } as const;

/** Every name a Standing could have at v3.4.1, the last release of schema 1. */
export const SCHEMA_1_NAMES: readonly StandingName[] = [
  "running",
  "waiting-on-checks",
  "held",
  "waiting-for-slot",
  "waiting-for-reset",
  "not-started",
  "waiting-on-kit",
  "stuck",
  "yours-to-merge",
  "design-round",
  "needs-your-answer",
  "yours-to-do",
  "weekly-limit-reached",
  "token-refused",
  "yours-to-read",
  "parked",
  "check-failing",
  "conflicts",
  "draft",
  "blocked",
  "waiting-on-author",
  "deploying",
  "live",
  "deploy-failed",
  "no-deploy-seen",
  "merged",
];

/** Ticket 12 of acme/shop, blocked by its own repo's #9 and #7, as v3.4.1 kept it: schema 1, its Blockers by number alone, with no count of hidden ones. */
export const A_SCHEMA_1_BLOCKED = {
  schema: 1,
  repo: "acme/shop",
  issue: 12,
  pullRequest: null,
  work: "ticket",
  place: "implement",
  name: "blocked",
  move: "nobody",
  yours: false,
  stopsWork: false,
  since: SINCE,
  stuckAt: null,
  awaits: { role: "implement", on: "issue" },
  subscription: null,
  detail: { blockers: [9, 7] },
} as const;

/** That Standing as schema 2 holds it: each Blocker by the Standing's own repo, by number, with none hidden. */
export const THAT_BLOCKED_AT_SCHEMA_2 = aStanding(
  "blocked",
  {
    blockers: [
      { repo: "acme/shop", number: 7 },
      { repo: "acme/shop", number: 9 },
    ],
    hiddenBlockers: 0,
  },
  { place: "implement", move: "nobody", awaits: { role: "implement", on: "issue" } },
);

/** One Standing of every name v3.4.1 could write but `blocked`, with the detail v3.4.1 gave it: schema 2 holds each as schema 1 did. */
export const THE_SAME_AT_SCHEMAS_1_AND_2: readonly Standing[] = [
  aStanding("running", { run: "implement", retry: null, actionsRun: 4410 }, { place: "implement", awaits: { role: "implement", on: "issue" } }),
  aStanding("waiting-on-checks", { plain: null, check: null, checksUnread: false, head: HEAD }, { pullRequest: 50, place: "review", awaits: { role: "review", on: "pullRequest" } }),
  aStanding("held", { carrier: 12, role: "implement" }, { place: "implement", awaits: { role: "implement", on: "issue" } }),
  aStanding("waiting-for-slot", { slot: "max-in-flight", maxInFlight: 2 }, { place: "implement", move: "nobody" }),
  aStanding("waiting-for-reset", { resetsAt: "2026-11-10T00:00:00Z" }, { work: "weekly-limit", move: "nobody", subscription: "Claude token" }),
  aStanding("not-started", { silence: "trigger-label", label: "agent:implement" }, { place: "implement", stuckAt: "2026-11-08T15:30:00.000Z", awaits: { role: "implement", on: "issue" } }),
  aStanding("waiting-on-kit", { silence: "needs-triage", round: null }, { work: "issue", place: "triage", stuckAt: "2026-11-08T15:30:00.000Z", awaits: { role: "triage", on: "issue" } }),
  aStanding("stuck", { was: "not-started", silence: "retry", label: null }, { place: "implement", yours: true, stopsWork: true, stuckAt: "2026-11-08T15:30:00.000Z", awaits: { role: "implement", on: "issue" } }),
  aStanding("yours-to-merge", { plain: null, passedHead: HEAD, head: HEAD }, { ...THE_OPERATORS, pullRequest: 50, place: "merge-gate" }),
  aStanding("design-round", { round: 2, prototype: null }, { ...THE_OPERATORS, work: "design-session", place: "design" }),
  aStanding("needs-your-answer", { author: "operator" }, { ...THE_OPERATORS, work: "issue", place: "triage" }),
  aStanding("yours-to-do", { handBack: "landing-failed", role: "implement", failure: null, label: null }, { ...THE_OPERATORS, work: "ready-for-human" }),
  aStanding("weekly-limit-reached", { resetsAt: null }, { ...THE_OPERATORS, work: "weekly-limit" }),
  aStanding("token-refused", { anotherFree: true }, { ...THE_OPERATORS, work: "token-rotation", subscription: "Claude token" }),
  aStanding("yours-to-read", { map: null, decisions: [] }, { ...THE_OPERATORS, work: "audit", stopsWork: false }),
  aStanding("parked", { head: HEAD }, { ...THE_OPERATORS, pullRequest: 50, place: "review", stopsWork: false }),
  aStanding("check-failing", { plain: "other", check: "ci", checkIs: "failing", head: HEAD }, { ...THE_OPERATORS, issue: null, pullRequest: 60, work: "plain" }),
  aStanding("conflicts", { plain: "kit-bump", head: HEAD }, { ...THE_OPERATORS, issue: null, pullRequest: 60, work: "plain" }),
  aStanding("draft", { plain: "pairing", head: HEAD }, { issue: null, pullRequest: 60, work: "plain", move: "nobody" }),
  aStanding("waiting-on-author", { author: "a-user" }, { work: "issue", place: "triage", move: "nobody" }),
  aStanding("deploying", { ...A_MERGE, deployment: 77 }, AT_PRODUCTION),
  aStanding("live", { ...A_MERGE, deployment: 77 }, AT_PRODUCTION),
  aStanding("deploy-failed", { ...A_MERGE, deployment: 77, log: "https://github.com/acme/shop/actions/runs/9" }, AT_PRODUCTION),
  aStanding("no-deploy-seen", { ...A_MERGE, noDeployAt: "2026-11-08T12:30:00.000Z" }, AT_PRODUCTION),
  aStanding("merged", { ...A_MERGE, noDeployAt: "2026-11-08T12:30:00.000Z" }, AT_PRODUCTION),
];

/** An Unrelated failure the Kit is healing at the Merge gate (#795), a name schema 2 gained after v3.4.1. */
const A_CHECK_HEALING = aStanding(
  "check-healing",
  { plain: null, check: "test", rerun: "asked", issue: 91, passedAt: SINCE, passedHead: HEAD, healing: [{ check: "test", rerun: "asked", issue: 91, stuckAt: null }], head: HEAD },
  { pullRequest: 50, place: "merge-gate" },
);

/** What every Standing of a merged agent pull request at Staging carries (#855), in a repo that declares `staging` beside production and names no Main check. */
const AT_STAGING = { pullRequest: 50, place: "staging", move: "nobody" } as const;
const A_MERGE_ON_STAGING = { ...A_MERGE, environment: "staging", deployment: 77 } as const;
const ITS_STAGING = { environment: "staging", productionEnvironment: "production", mainChecks: [], check: null, checksUnread: false } as const;
const ITS_TRIAL = { needed: true, why: "ui-evidence" } as const;

/**
 * A merged UI pull request on staging, waiting on its Staging trial (#855),
 * and one of each name a trial's result gives (#856), a problem found and
 * one accepted through its fix: the place `staging` and three names schema 2
 * gained after v3.4.1, with no move of the schema.
 */
export const ON_STAGING_AT_SCHEMA_2 = aStanding(
  "on-staging",
  { ...A_MERGE_ON_STAGING, staging: { ...ITS_STAGING, trial: ITS_TRIAL, result: null, standsUntil: null } },
  { ...AT_STAGING, move: "operator", yours: true },
);
const A_TRIAL_PROBLEM = aStanding(
  "trial-problem",
  {
    ...A_MERGE_ON_STAGING,
    deployment: null,
    staging: { ...ITS_STAGING, trial: ITS_TRIAL, result: { is: "problem", at: "2026-11-08T14:00:00Z", problems: [{ issue: 70, open: true }] }, standsUntil: "2026-11-09T14:00:00.000Z" },
  },
  { ...AT_STAGING, since: "2026-11-08T14:00:00Z" },
);
const A_TRIAL_ACCEPTED = aStanding(
  "trial-accepted",
  {
    ...A_MERGE_ON_STAGING,
    deployment: null,
    staging: {
      ...ITS_STAGING,
      trial: ITS_TRIAL,
      result: { is: "accepted", at: "2026-11-08T16:00:00Z", problems: [{ issue: 70, open: false }], fix: [61] },
      standsUntil: "2026-11-09T16:00:00.000Z",
    },
  },
  { ...AT_STAGING, since: "2026-11-08T16:00:00Z" },
);

/** For each schema a Standing has had, Standings as a reader kept them at it. */
export const KEPT_STANDINGS: Readonly<Record<number, readonly unknown[]>> = {
  1: [A_SCHEMA_1_BLOCKED, ...THE_SAME_AT_SCHEMAS_1_AND_2.map((standing) => ({ ...standing, schema: 1 }))],
  2: [THAT_BLOCKED_AT_SCHEMA_2, ...THE_SAME_AT_SCHEMAS_1_AND_2, A_CHECK_HEALING, ON_STAGING_AT_SCHEMA_2, A_TRIAL_PROBLEM, A_TRIAL_ACCEPTED],
};
