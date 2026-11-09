// Choosing the Subscription: every agent run starts on the first Subscription
// Kit config lists that has no open weekly-limit, usage-credits or
// token-rotation issue. A V1 weekly-limit issue, or a rotation issue opened
// before rotation issues named one (#433), names no Subscription, so it is
// read as the first listed one's. With one Subscription listed, rotation
// is off and every run starts on it. Pure, no I/O.
import { TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
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

/** Where a weekly-limit, usage-credits or token-rotation issue names the Subscription it is about. */
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
 * The Subscription an open weekly-limit or token-rotation issue is about: the
 * one it names, or the first listed one for an issue that names none, as a V1
 * weekly-limit issue, or a rotation issue opened before #433, doesn't.
 */
export function kitIssueSubscriptionOf(issue: KitIssueSnapshot, config: Pick<KitConfig, "subscriptions">): Subscription {
  return subscriptionNamedBy(issue) ?? firstSubscription(config);
}

/**
 * Why a Subscription is unusable: an open weekly-limit issue, an open
 * usage-credits issue, or an open token-rotation issue for its dead token.
 */
export type Unusable = "weekly-limit" | "usage-credits" | "dead-token";

/**
 * Each Subscription an open Kit-owned issue makes unusable, and why: its
 * weekly-limit issue first, then its usage-credits issue, then its
 * token-rotation issue, when it has several.
 */
export function unusableSubscriptions(
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): ReadonlyMap<Subscription, Unusable> {
  const unusable = new Map<Subscription, Unusable>();
  for (const issue of kitIssues) {
    if (issue.labels.includes(WEEKLY_LIMIT_LABEL)) unusable.set(kitIssueSubscriptionOf(issue, config), "weekly-limit");
  }
  for (const issue of kitIssues) {
    const named = issue.labels.includes(USAGE_CREDITS_LABEL) ? subscriptionNamedBy(issue) : null;
    if (named !== null && !unusable.has(named)) unusable.set(named, "usage-credits");
  }
  for (const issue of kitIssues) {
    const dead = issue.labels.includes(TOKEN_ROTATION_LABEL) ? kitIssueSubscriptionOf(issue, config) : null;
    if (dead !== null && !unusable.has(dead)) unusable.set(dead, "dead-token");
  }
  return unusable;
}

/**
 * The listed Subscriptions with no open weekly-limit, usage-credits or
 * token-rotation issue, in the listed order.
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
 * open weekly-limit, usage-credits or token-rotation issue. While every listed one has one,
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
