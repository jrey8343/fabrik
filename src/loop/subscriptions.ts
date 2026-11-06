// Choosing the Subscription: every agent run starts on the first Subscription
// Kit config lists that has no open weekly-limit issue and no open
// usage-credits issue. A V1 weekly-limit issue names no Subscription, so it
// is read as the first listed one's. With one Subscription listed, rotation
// is off and every run starts on it. Pure, no I/O.
import { USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/** A Subscription: the name of the `Fabrik` vault item that holds its Claude token. */
export type Subscription = string;

/**
 * The Subscription a run ran on, with every listed one, in the listed order,
 * and whether rotation is on, which the list decides.
 */
export interface RanOn {
  readonly subscription: Subscription;
  readonly subscriptions: readonly Subscription[];
  readonly rotation: boolean;
}

/** Where a weekly-limit issue names the Subscription whose limit it is about. */
export const SUBSCRIPTION_MARKER = "<!-- fabrik:subscription";

/** The marker naming a Subscription, for a Kit-owned issue's body. */
export function subscriptionMarker(subscription: Subscription): string {
  return `${SUBSCRIPTION_MARKER} ${subscription} -->`;
}

/** Whether two or more Subscriptions are listed, which is what turns rotation on. */
export function rotationIsOn(config: Pick<KitConfig, "subscriptions">): boolean {
  return config.subscriptions.length >= 2;
}

/** The first listed Subscription: Kit config always lists one. */
export function firstSubscription({ subscriptions }: Pick<KitConfig, "subscriptions">): Subscription {
  const first = subscriptions[0];
  if (first === undefined) throw new Error("Kit config lists no Subscription");
  return first;
}

/**
 * The Subscription a failed run used: the one its event names, else the first
 * listed one, as for a run started before runs were given a Subscription.
 */
export function subscriptionOfRun(
  run: { readonly subscription?: Subscription },
  config: Pick<KitConfig, "subscriptions">,
): Subscription {
  return run.subscription ?? firstSubscription(config);
}

/** What a failed run ran on: its Subscription, every listed one, and whether rotation is on. */
export function ranOnOf(run: { readonly subscription?: Subscription }, config: Pick<KitConfig, "subscriptions">): RanOn {
  return { subscription: subscriptionOfRun(run, config), subscriptions: config.subscriptions, rotation: rotationIsOn(config) };
}

/** The Subscription a Kit-owned issue names, or null when it names none, as a V1 issue doesn't. */
export function subscriptionNamedBy(issue: KitIssueSnapshot): Subscription | null {
  const start = issue.body.indexOf(SUBSCRIPTION_MARKER);
  if (start === -1) return null;
  const end = issue.body.indexOf("-->", start);
  const name = issue.body.slice(start + SUBSCRIPTION_MARKER.length, end === -1 ? undefined : end).trim();
  return name === "" ? null : name;
}

/**
 * The Subscription an open weekly-limit issue is about: the one it names, or
 * the first listed one for a V1 issue, which names none.
 */
export function weeklyLimitSubscriptionOf(issue: KitIssueSnapshot, config: Pick<KitConfig, "subscriptions">): Subscription {
  return subscriptionNamedBy(issue) ?? firstSubscription(config);
}

/** Why a Subscription is unusable: an open weekly-limit issue, or an open usage-credits issue. */
export type Unusable = "weekly-limit" | "usage-credits";

/**
 * Each Subscription an open Kit-owned issue makes unusable, and why: its
 * weekly-limit issue first, when it has both.
 */
export function unusableSubscriptions(
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): ReadonlyMap<Subscription, Unusable> {
  const unusable = new Map<Subscription, Unusable>();
  for (const issue of kitIssues) {
    if (issue.labels.includes(WEEKLY_LIMIT_LABEL)) unusable.set(weeklyLimitSubscriptionOf(issue, config), "weekly-limit");
  }
  for (const issue of kitIssues) {
    const named = issue.labels.includes(USAGE_CREDITS_LABEL) ? subscriptionNamedBy(issue) : null;
    if (named !== null && !unusable.has(named)) unusable.set(named, "usage-credits");
  }
  return unusable;
}

/**
 * The listed Subscriptions with no open weekly-limit issue and no open
 * usage-credits issue, in the listed order.
 */
export function freeSubscriptions(
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): readonly Subscription[] {
  const unusable = unusableSubscriptions(kitIssues, config);
  return config.subscriptions.filter((subscription) => !unusable.has(subscription));
}

/**
 * The Subscription a run starting now is given: the first listed one with no
 * open weekly-limit or usage-credits issue. While every listed one has one,
 * the first listed is given, as V1 does with its one Subscription.
 */
export function chosenSubscription(
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Subscription {
  return freeSubscriptions(kitIssues, config)[0] ?? firstSubscription(config);
}

/** The Plan with every run it starts, a Replay Ticket's two arms included, given the chosen Subscription. */
export function onChosenSubscription(
  plan: Plan,
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Plan {
  const starts = (action: Action) => action.kind === "start-agent-run" || action.kind === "start-replay";
  if (plan.kind !== "act" || !plan.actions.some(starts)) return plan;
  const subscription = chosenSubscription(kitIssues, config);
  return {
    kind: "act",
    actions: plan.actions.map((action): Action => (starts(action) ? { ...action, subscription } : action)),
  };
}
