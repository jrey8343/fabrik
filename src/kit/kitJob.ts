// What the Kit job's step summary says about the run it routes: which
// Subscription the run was given, or, with rotation on and every Subscription
// used up, that it was held and until when; and, with one Subscription
// listed, a quiet note that rotation is off until a second is listed. Pure,
// no I/O.
import { agentRunIn } from "../github/apply.ts";
import { RUN_NAMES } from "../loop/heldRun.ts";
import { rotationIsOn } from "../loop/subscriptions.ts";
import type { Action, KitConfig, Plan } from "../loop/types.ts";

/** The Kit job's step summary for this Plan, or null when it starts or holds no run. */
export function kitJobSummary(plan: Plan, config: Pick<KitConfig, "subscriptions">): string | null {
  const run = agentRunIn(plan);
  const held = heldIn(plan);
  const lines: string[] = [];
  if (run !== null) {
    lines.push(`The ${RUN_NAMES[run.role]} run on #${run.issue} was given the Subscription **${subscriptionOf(run)}**.`);
  }
  for (const hold of held) lines.push(heldLine(hold));
  if (lines.length === 0) return null;
  if (!rotationIsOn(config)) {
    lines.push("Subscription rotation is off until a second Subscription is listed in Kit config's `subscriptions`.");
  }
  return `### Fabrik Kit job\n\n${lines.join("\n\n")}\n`;
}

type Hold = Extract<Action, { kind: "hold-agent-run" }>;

function heldIn(plan: Plan): Hold[] {
  return plan.kind === "act" ? plan.actions.filter((action): action is Hold => action.kind === "hold-agent-run") : [];
}

function heldLine(hold: Hold): string {
  const until =
    hold.until === null ? "a Subscription's weekly limit resets, which isn't known" : readable(hold.until);
  const where = hold.label === null ? "Its Audit stays pending." : `Its \`${hold.label}\` label came off.`;
  return `The ${RUN_NAMES[hold.role]} run on #${hold.issue} was held until ${until}: every listed Subscription has hit its weekly limit. ${where}`;
}

/** Such as "2026-11-09 04:00 UTC". */
function readable(iso: string): string {
  const at = new Date(iso).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** The Subscription the Loop rules core gave a run it starts, which `planFor` always does. */
export function subscriptionOf(run: NonNullable<ReturnType<typeof agentRunIn>>): string {
  if (run.subscription === undefined) throw new Error(`The ${run.role} run on #${run.issue} was given no Subscription`);
  return run.subscription;
}
