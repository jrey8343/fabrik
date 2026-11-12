// The Standing (GLOSSARY.md): for every piece of work the Loop knows in one
// Product repo, where it stands and whose move is next, as the Kit reads it
// from GitHub. The one place that answer is worked out: the Weekly summary
// lists its Standings, and the Console reads the same ones. Pure, no I/O, and
// nothing in the Loop's rules reads it.
//
// A Standing is plain data: written as JSON and read back it is equal, and it
// holds no relative time. Its wording ("40 minutes ago") is made when it is
// shown (src/kit/standingWording.ts).
import type { HandBack } from "../loop/handBacks.ts";
import type { AgentRole } from "../loop/types.ts";
import { notStartedStandingsOf } from "./standingClock.ts";
import { inFlightStandingsOf } from "./standingInFlight.ts";
import { operatorStandingsOf } from "./standingOperator.ts";
import { type StoreStandingFacts, storeStandingsOf } from "./standingStore.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

/** Goes up only when a field is removed or changes meaning: a new name or a new `detail` key leaves it. */
export const STANDING_SCHEMA = 1;

/** What kind of work a Standing is. */
export type StandingWork =
  | "issue"
  | "design-session"
  | "ticket"
  | "research-decision"
  | "operator-decision"
  | "map"
  | "ready-for-human"
  | "audit"
  | "retro"
  | "replay"
  | "weekly-limit"
  | "usage-credits"
  | "token-rotation"
  | "weekly-summary"
  | "plain";

/** Its place on the Loop; a Standing with none has `place: null`. */
export type StandingPlace = "triage" | "design" | "implement" | "review" | "merge-gate";

/** Whose move is next: the Operator's, the Kit's, or nobody's, when nothing is owed and nothing moves. */
export type StandingMove = "operator" | "kit" | "nobody";

/** The run a Standing waits on: an agent role's, or a Replay's. */
export type AwaitedRole = AgentRole | "replay";

/** What kind of Plain pull request a `plain` Standing is. */
export type PlainKind = "kit-bump" | "setup" | "skills-bump" | "pairing" | "other";

/** Every name a Standing can have. */
export const STANDING_NAMES = [
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
] as const;

export type StandingName = (typeof STANDING_NAMES)[number];

/** What a `not-started` Standing's wording is made of. */
interface NotStartedDetail {
  readonly silence: string;
  readonly label: string | null;
}

/** What a `waiting-on-kit` Standing's wording is made of: nothing yet, until the rule builds one. */
type WaitingOnKitDetail = Readonly<Record<never, never>>;

/** What each name's wording is made of: numbers, labels, check names and logins, never a repo's text. */
export interface StandingDetails {
  readonly running: { readonly run: string; readonly retry: number | null };
  readonly "waiting-on-checks": { readonly plain: PlainKind | null; readonly check: string | null; readonly checksUnread: boolean };
  readonly held: { readonly carrier: number | null; readonly role: AgentRole };
  readonly "waiting-for-slot": { readonly slot: "max-in-flight" | "design-session"; readonly maxInFlight: number | null };
  readonly "waiting-for-reset": { readonly resetsAt: string | null };
  readonly "not-started": NotStartedDetail;
  readonly "waiting-on-kit": WaitingOnKitDetail;
  /** The name it had before its `stuckAt` passed, with that name's detail. */
  readonly stuck: ({ readonly was: "not-started" } & NotStartedDetail) | ({ readonly was: "waiting-on-kit" } & WaitingOnKitDetail);
  /** `plain` is null for an agent pull request. */
  readonly "yours-to-merge": { readonly plain: PlainKind | null };
  /** `prototype` says whether the Round is a prototype round (`ready`) or a prototype's failure round (`failed`). */
  readonly "design-round": { readonly round: number; readonly prototype: "ready" | "failed" | null };
  /** `author` is a login, with no `@`. */
  readonly "needs-your-answer": { readonly author: string };
  /** `handBack` is null for `ready-for-human` work whose reason the rule does not recognise. */
  readonly "yours-to-do": { readonly handBack: HandBack | null; readonly role: AgentRole | null; readonly failure: string | null; readonly label: string | null };
  readonly "weekly-limit-reached": { readonly resetsAt: string | null };
  readonly "token-refused": { readonly anotherFree: boolean };
  /** `map`: a Decision's Map; `decisions`: a Map's open Decisions that wait on the Operator. */
  readonly "yours-to-read": { readonly map: number | null; readonly decisions: readonly number[] };
  /** Nothing yet, until the rule builds one. */
  readonly parked: Readonly<Record<never, never>>;
  readonly "check-failing": { readonly plain: PlainKind; readonly check: string; readonly checkIs: "failing" | "never-reported" };
  readonly conflicts: { readonly plain: PlainKind };
  readonly draft: { readonly plain: PlainKind };
  readonly blocked: { readonly blockers: readonly number[] };
  /** `author` is a login, with no `@`. */
  readonly "waiting-on-author": { readonly author: string };
}

/** The fields every Standing has, whatever its name. */
interface StandingFields {
  readonly schema: typeof STANDING_SCHEMA;
  /** `owner/name`. */
  readonly repo: string;
  /** The issue this work is, or null for a Plain pull request with no issue. */
  readonly issue: number | null;
  /** Its open pull request, or null. */
  readonly pullRequest: number | null;
  readonly work: StandingWork;
  /** Null: no place on the Loop. */
  readonly place: StandingPlace | null;
  readonly move: StandingMove;
  /** The move is the Operator's, or the name is `stuck`. */
  readonly yours: boolean;
  /** Work is stopped until the Operator moves: only ever true when `yours`. */
  readonly stopsWork: boolean;
  /** When it came to stand so, ISO 8601. */
  readonly since: string;
  /** When it turns Stuck if the Kit makes no sign first, ISO 8601, or null when it cannot. */
  readonly stuckAt: string | null;
  /** The run the Kit asked for or is running, and whether it is on the issue or the pull request. */
  readonly awaits: { readonly role: AwaitedRole; readonly on: "issue" | "pullRequest" } | null;
  /** The Subscription behind a weekly-limit, usage-credits or token-rotation issue, or null. */
  readonly subscription: string | null;
}

/** A joined Pairing session's pull request: the name it would have had by itself. */
interface PairingDetail {
  readonly pullRequest?: StandingName;
}

/** Where one piece of work stands and whose move is next: `name` and `detail` are one union, so each name fixes what its wording may read. */
export type Standing = {
  readonly [N in StandingName]: StandingFields & { readonly name: N; readonly detail: StandingDetails[N] & PairingDetail };
}[StandingName];

/** The Standing of one name. */
export type StandingNamed<N extends StandingName> = Extract<Standing, { readonly name: N }>;

/** What the rule reads of one Product repo. */
export interface StandingFacts {
  readonly kind: "product";
  readonly github: GitHubFacts;
  /** Its Kit config and what Dispatch weighs there, or null when they weren't read. */
  readonly kit: RepoKitFacts | null;
  /** The Operator's GitHub login. */
  readonly operator: string;
  /** The Fabrik App's bot login. */
  readonly appLogin: string;
}

/** Which piece of work a Standing is: its issue, or its pull request when it has no issue. */
export function workKeyOf({ issue, pullRequest }: Pick<Standing, "issue" | "pullRequest">): string {
  return issue !== null ? `#${issue}` : `pr#${pullRequest}`;
}

/** The order of reading, for one piece of work: the first that holds wins. */
const READING_ORDER = { operator: 0, running: 1, held: 2, slot: 3, silence: 4 } as const;

/** Where each name falls in the order of reading: a move of nobody's ranks with silence. */
const READING_OF: Readonly<Record<StandingName, keyof typeof READING_ORDER>> = {
  running: "running",
  "waiting-on-checks": "running",
  held: "held",
  "waiting-for-slot": "slot",
  "waiting-for-reset": "held",
  "not-started": "silence",
  "waiting-on-kit": "silence",
  stuck: "silence",
  "yours-to-merge": "operator",
  "design-round": "operator",
  "needs-your-answer": "operator",
  "yours-to-do": "operator",
  "weekly-limit-reached": "operator",
  "token-refused": "operator",
  "yours-to-read": "operator",
  parked: "operator",
  "check-failing": "operator",
  conflicts: "operator",
  draft: "silence",
  blocked: "silence",
  "waiting-on-author": "silence",
};

/**
 * One Product repo's Standings at `now`, oldest first: one per piece of work,
 * an agent pull request and the Ticket it closes being one. Given the store's
 * facts, the store's own Standings (src/kit/standingStore.ts).
 */
export function standingsOf(facts: StandingFacts | StoreStandingFacts, now: string): Standing[] {
  if (facts.kind === "store") return storeStandingsOf(facts, now);
  const candidates: Standing[] = [...operatorStandingsOf(facts, now), ...inFlightStandingsOf(facts, now), ...notStartedStandingsOf(facts, now)];
  return oneForEachWork(candidates.map((standing) => withItsPullRequest(standing, facts.github)))
    .map((standing) => standingAt(standing, now))
    .toSorted(
    (a, b) => Date.parse(a.since) - Date.parse(b.since) || (a.issue ?? 0) - (b.issue ?? 0) || (a.pullRequest ?? 0) - (b.pullRequest ?? 0),
  );
}

/**
 * A kept Standing as it reads at `now`, ISO 8601, with no facts: a silence
 * whose `stuckAt` has passed is `stuck`, the Kit's move still but the
 * Operator's to act on and stopping work, carrying the name it had in
 * `detail.was`, its `since` kept. Everything else is returned as it is. The
 * rule reads each Standing through this, so a reader that kept one gets the
 * answer the rule would give.
 */
export function standingAt(standing: Standing, now: string): Standing {
  if ((standing.name !== "not-started" && standing.name !== "waiting-on-kit") || standing.stuckAt === null) return standing;
  if (Date.parse(now) < Date.parse(standing.stuckAt)) return standing;
  const detail = standing.name === "not-started" ? { was: standing.name, ...standing.detail } : { was: standing.name, ...standing.detail };
  return { ...standing, name: "stuck", yours: true, stopsWork: true, detail };
}

/**
 * The first Standing in the order of reading for each piece of work; of two
 * that rank alike, the first found. Two open agent pull requests that close
 * one Ticket are kept apart, as neither hides the other.
 */
function oneForEachWork(candidates: readonly Standing[]): Standing[] {
  const kept = new Map<string, Standing>();
  for (const candidate of candidates) {
    const key = `${workKeyOf(candidate)} ${candidate.pullRequest ?? ""}`;
    const held = kept.get(key);
    if (held === undefined || READING_ORDER[READING_OF[candidate.name]] < READING_ORDER[READING_OF[held.name]]) kept.set(key, candidate);
  }
  return [...kept.values()];
}

/** A Standing on an issue, carrying the number of the open agent pull request that closes it, if it lacks one. */
function withItsPullRequest(standing: Standing, { openPullRequests }: GitHubFacts): Standing {
  if (standing.issue === null || standing.pullRequest !== null) return standing;
  const closing = openPullRequests.filter(({ ticket }) => ticket === standing.issue).map(({ number }) => number).toSorted((a, b) => a - b)[0];
  return closing === undefined ? standing : { ...standing, pullRequest: closing };
}
