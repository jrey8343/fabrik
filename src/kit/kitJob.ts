// What the Kit job's step summary says about the run it routes: which
// Subscription the run was given, or, with rotation on and every Subscription
// used up, that it was held, until when and why; with one Subscription
// listed, a quiet note that rotation is off until a second is listed; and on
// an Implement run without a ui block, a quiet note that Visual evidence is
// off (#153). Pure, no I/O.
import { agentRunIn } from "../github/apply.ts";
import { RUN_NAMES } from "../loop/heldRun.ts";
import { readable } from "../loop/readable.ts";
import { rotationIsOn, type Subscription, type Unusable, unusableSubscriptions } from "../loop/subscriptions.ts";
import type { Action, KitConfig, KitIssueSnapshot, Plan } from "../loop/types.ts";

/**
 * The Kit job's step summary for this Plan, or null when it starts or holds
 * no run. The open Kit-owned issues say why a held run's Subscriptions are used up.
 */
export function kitJobSummary(
  plan: Plan,
  config: Pick<KitConfig, "subscriptions" | "ui">,
  kitIssues: readonly KitIssueSnapshot[],
): string | null {
  const run = agentRunIn(plan);
  const held = heldIn(plan);
  const lines: string[] = [];
  if (run !== null) {
    lines.push(`The ${RUN_NAMES[run.role]} run on #${run.issue} was given the Subscription **${subscriptionOf(run)}**.`);
  }
  const why = usedUp(kitIssues, config);
  for (const hold of held) lines.push(heldSummaryLine(hold, why));
  if (lines.length === 0) return null;
  if (!rotationIsOn(config)) {
    lines.push("Subscription rotation is off until a second Subscription is listed in Kit config's `subscriptions`.");
  }
  // Said here, from the Kit config this job checked, so it's said whether or not the Implement job captures.
  if (run?.role === "implement" && config.ui === null) {
    lines.push("Visual evidence is off until Kit config has a `ui` block: `/fabrik-setup` turns it on.");
  }
  return `### Fabrik Kit job\n\n${lines.join("\n\n")}\n`;
}

type Hold = Extract<Action, { kind: "hold-agent-run" }>;

function heldIn(plan: Plan): Hold[] {
  return plan.kind === "act" ? plan.actions.filter((action): action is Hold => action.kind === "hold-agent-run") : [];
}

/** The step summary's line for a held run: until when, and why. */
function heldSummaryLine(hold: Hold, why: string): string {
  const until =
    hold.until === null ? "a Subscription's weekly limit resets, which isn't known" : readable(hold.until);
  return `The ${RUN_NAMES[hold.role]} run on #${hold.issue} was held until ${until}: ${why} Its \`${hold.label}\` label came off.`;
}

const UNUSABLE: Readonly<Record<Unusable, string>> = {
  "weekly-limit": "has hit its weekly limit",
  "usage-credits": "has an open usage-credits issue",
};

/** Why every listed Subscription is used up, from the open Kit-owned issues that make each unusable. */
function usedUp(kitIssues: readonly KitIssueSnapshot[], config: Pick<KitConfig, "subscriptions">): string {
  const unusable = unusableSubscriptions(kitIssues, config);
  const reasons = config.subscriptions.flatMap((subscription): [Subscription, Unusable][] => {
    const why = unusable.get(subscription);
    return why === undefined ? [] : [[subscription, why]];
  });
  if (reasons.every(([, why]) => why === "weekly-limit")) return "every listed Subscription has hit its weekly limit.";
  const each = reasons.map(([subscription, why]) => `\`${subscription}\` ${UNUSABLE[why]}`);
  const listed = each.length < 2 ? each.join("") : `${each.slice(0, -1).join(", ")}, and ${each.at(-1)}`;
  return `every listed Subscription is used up. ${listed}.`;
}

/** The Subscription the Loop rules core gave a run it starts, which `planFor` always does. */
export function subscriptionOf(run: NonNullable<ReturnType<typeof agentRunIn>>): string {
  if (run.subscription === undefined) throw new Error(`The ${run.role} run on #${run.issue} was given no Subscription`);
  return run.subscription;
}
