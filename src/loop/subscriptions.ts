// Choosing the Subscription: every agent run starts on the first Subscription
// Kit config lists that has no open weekly-limit issue and no open
// usage-credits issue. A V1 weekly-limit issue names no Subscription, so it
// is read as the first listed one's. With one Subscription listed, rotation
// is off and every run starts on it. Pure, no I/O.
import { USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan } from "./types.ts";

/** Where a weekly-limit issue names the Subscription whose limit it is about. */
export const SUBSCRIPTION_MARKER = "<!-- fabrik:subscription";

/** The marker naming a Subscription, for a Kit-owned issue's body. */
export function subscriptionMarker(subscription: string): string {
  return `${SUBSCRIPTION_MARKER} ${subscription} -->`;
}

/** Whether two or more Subscriptions are listed, which is what turns rotation on. */
export function rotationIsOn(config: Pick<KitConfig, "subscriptions">): boolean {
  return config.subscriptions.length >= 2;
}

/**
 * The Subscription a failed run used: the one its event names, else the first
 * listed one, as for a run started before runs were given a Subscription.
 */
export function subscriptionOfRun(
  run: { readonly subscription?: string },
  config: Pick<KitConfig, "subscriptions">,
): string {
  const first = config.subscriptions[0];
  if (first === undefined) throw new Error("Kit config lists no Subscription");
  return run.subscription ?? first;
}

/** The Subscription a Kit-owned issue names, or null when it names none, as a V1 issue doesn't. */
export function subscriptionNamedBy(issue: KitIssueSnapshot): string | null {
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
export function weeklyLimitSubscriptionOf(issue: KitIssueSnapshot, config: Pick<KitConfig, "subscriptions">): string {
  const first = config.subscriptions[0];
  if (first === undefined) throw new Error("Kit config lists no Subscription");
  return subscriptionNamedBy(issue) ?? first;
}

/**
 * The listed Subscriptions with no open weekly-limit issue and no open
 * usage-credits issue, in the listed order.
 */
export function freeSubscriptions(
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): readonly string[] {
  const unusable = new Set(
    kitIssues.flatMap((issue) => {
      if (issue.labels.includes(WEEKLY_LIMIT_LABEL)) return [weeklyLimitSubscriptionOf(issue, config)];
      const named = issue.labels.includes(USAGE_CREDITS_LABEL) ? subscriptionNamedBy(issue) : null;
      return named === null ? [] : [named];
    }),
  );
  return config.subscriptions.filter((subscription) => !unusable.has(subscription));
}

/**
 * The Subscription a run starting now is given: the first listed one with no
 * open weekly-limit or usage-credits issue. While every listed one has one,
 * the first listed is given, as V1 does with its one Subscription.
 */
export function chosenSubscription(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): string {
  const first = config.subscriptions[0];
  if (first === undefined) throw new Error("Kit config lists no Subscription");
  return freeSubscriptions(kitIssues, config)[0] ?? first;
}

/** The Plan with every run it starts given the chosen Subscription. */
export function onChosenSubscription(
  plan: Plan,
  kitIssues: readonly KitIssueSnapshot[],
  config: Pick<KitConfig, "subscriptions">,
): Plan {
  if (plan.kind !== "act" || !plan.actions.some((action) => action.kind === "start-agent-run")) return plan;
  const subscription = chosenSubscription(kitIssues, config);
  return {
    kind: "act",
    actions: plan.actions.map(
      (action): Action => (action.kind === "start-agent-run" ? { ...action, subscription } : action),
    ),
  };
}
