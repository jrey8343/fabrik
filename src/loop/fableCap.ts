// The Fable cap (ADR-0034): a Subscription's separate weekly limit on Fable.
// Reaching it holds no run. The refused run is re-run once, quietly, through
// its trigger label (src/loop/failures.ts), and the Fable cap reading goes on
// the body of the issue or PR the label goes on, in a hidden marker, as the
// re-run's Kit job reads it back (src/github/snapshot.ts): the label starts
// it before the refused run's push job has written its Run record. In a repo
// that opted in, the Kit job reads the readings in the store's Run records
// too (src/kit/fableCapFacts.ts), so any run due, not only a re-run, weighs
// every Subscription's cap. A run whose role
// names Fable then starts on the first listed Subscription with Fable left,
// or, with none left, on Opus 5.5 at the role's effort: a Fable fallback. The
// fallback is per run: it never changes Kit config, and ends on its own once
// the reading's time has passed. Pure, no I/O.
import { namesFable } from "../kit/config.ts";
import type { ReplayArms } from "../kit/replayPick.ts";
import { freeSubscriptions, type Subscription } from "./subscriptions.ts";
import type { Action, FableCapSnapshot, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/** Whether either arm of a Replay runs a role on Fable, so it starts only where Fable is left, and never falls back. */
export function armsRunFable(arms: ReplayArms): boolean {
  return Object.values(arms).some(({ implement, review }) => namesFable(implement.model) || namesFable(review.model));
}

/** The model a Fable fallback starts on, at the effort the role names. */
export const FABLE_FALLBACK_MODEL = "claude-opus-5-5";

/** Why a run started on another model than Kit config named: its role names Fable, and no Subscription has Fable left. */
export type ModelFallback = "fable-cap";

/** A Subscription's Fable cap, as a reading of it says: used up until `until`, an ISO 8601 time. */
export interface FableCapReading {
  readonly subscription: Subscription;
  readonly until: string;
}

/**
 * How long a reading with no reset counts, from when it was marked, while its
 * Subscription's weekly-limit reset isn't known either: its week, the longest
 * a weekly cap can last.
 */
export const UNTIMED_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** What a refusal on a Fable cap says of when it resets, each ISO 8601 or null when not known. */
export interface FableCapResets {
  /** The cap's own reset, from its refusal. */
  readonly resetsAt: string | null;
  /** Its Subscription's weekly-limit reset, from the newest weekly-limit reading by then. */
  readonly weeklyResetsAt: string | null;
}

/**
 * Until when a Fable cap refused at `at` counts, ISO 8601, wherever its
 * reading comes from, a hidden line or a Run record: its own reset; else its
 * Subscription's weekly-limit reset, while that is still ahead of `at`; else
 * UNTIMED_CAP_MS from `at`.
 */
export function fableCapUntil({ resetsAt, weeklyResetsAt }: FableCapResets, at: string): string {
  if (resetsAt !== null) return new Date(resetsAt).toISOString();
  if (weeklyResetsAt !== null && Date.parse(weeklyResetsAt) > Date.parse(at)) return new Date(weeklyResetsAt).toISOString();
  return new Date(Date.parse(at) + UNTIMED_CAP_MS).toISOString();
}

const MARKER_START = "<!-- fabrik:fable-cap ";
const MARKER_LINE = /^<!-- fabrik:fable-cap (.+) until (\S+) -->$/;

/** A Fable cap reading's hidden line, on the body of the issue or PR the refused run's trigger label goes on. */
export function fableCapMarker({ subscription, until }: FableCapReading): string {
  return `${MARKER_START}${subscription} until ${until} -->`;
}

/** Every Fable cap reading a body's hidden lines give, in force or not; a line that doesn't read is no reading. */
export function fableCapsIn(body: string): FableCapReading[] {
  return body.split("\n").flatMap((line): FableCapReading[] => {
    const match = MARKER_LINE.exec(line.trim());
    const [, subscription, until] = match ?? [];
    if (subscription === undefined || until === undefined || Number.isNaN(Date.parse(until))) return [];
    return [{ subscription: subscription.trim(), until }];
  });
}

/** The readings still in force at `now`: those whose time is still ahead. */
export function inForce(readings: readonly FableCapReading[], now: string): FableCapReading[] {
  return readings.filter(({ until }) => Date.parse(until) > Date.parse(now));
}

/** The readings a snapshot holds that were still in force when the adapter read them; none when it holds none. */
export function fableCapsInForce(caps: FableCapSnapshot | undefined): FableCapReading[] {
  return caps === undefined ? [] : inForce(caps.readings, caps.now);
}

/**
 * The body with the Fable cap reading for `subscription` marked at `now`,
 * until what `resets` says (fableCapUntil): in place of any earlier reading
 * for it, and with every reading no longer in force left out, so a body holds
 * one line for each Subscription whose cap is in force.
 */
export function withFableCap(body: string, subscription: Subscription, resets: FableCapResets, now: string): string {
  const until = fableCapUntil(resets, now);
  const live = new Set(inForce(fableCapsIn(body), now).filter((reading) => reading.subscription !== subscription).map(fableCapMarker));
  const kept = body.split("\n").filter((line) => !line.trim().startsWith(MARKER_START) || live.has(line.trim()));
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  return [...kept, ...(kept.length === 0 ? [] : [""]), fableCapMarker({ subscription, until })].join("\n");
}

/**
 * The listed Subscriptions with Fable left: free of any open weekly-limit,
 * usage-credits or token-rotation issue, and with no Fable cap reading, in the
 * listed order. `readings` are those in force.
 */
export function withFableLeft(
  readings: readonly FableCapReading[],
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): readonly Subscription[] {
  const capped = new Set(readings.map(({ subscription }) => subscription));
  return freeSubscriptions(kitIssues, config).filter((subscription) => !capped.has(subscription));
}

/**
 * The Plan with each agent run it starts on a model naming Fable given the
 * first listed Subscription with Fable left, or, while none has any, Opus 5.5
 * at the same effort, on the Subscription it was given, its Kit config's
 * model kept as `configuredModel`. A Replay whose arms run Fable is given
 * that Subscription too, but never falls back: with none left it is left as
 * it was. Every other run is left as it was.
 */
export function onFableLeft(
  plan: Plan,
  readings: readonly FableCapReading[],
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Plan {
  if (plan.kind !== "act" || readings.length === 0) return plan;
  const [left] = withFableLeft(readings, kitIssues, config);
  const given = (action: Action): Action => {
    // A Replay never falls back, so its arms start where Fable is left, or where they'd start, to be refused and end the run.
    if (action.kind === "start-replay") return left !== undefined && armsRunFable(action.ticket.arms) ? { ...action, subscription: left } : action;
    if (action.kind !== "start-agent-run" || !namesFable(action.model)) return action;
    if (left !== undefined) return { ...action, subscription: left };
    return { ...action, model: FABLE_FALLBACK_MODEL, configuredModel: action.model, fallback: "fable-cap" };
  };
  return { kind: "act", actions: plan.actions.map(given) };
}
