// What the Kit job's step summary says about the run it routes: which
// Subscription the run was given, and, with one Subscription listed, a quiet
// note that rotation is off until a second is listed. Pure, no I/O.
import { agentRunIn } from "../github/apply.ts";
import { rotationIsOn } from "../loop/subscriptions.ts";
import type { AgentRole, KitConfig, Plan } from "../loop/types.ts";

const ROLE_NAMES: Readonly<Record<AgentRole, string>> = {
  triage: "Triage",
  design: "Design-session turn",
  implement: "Implement",
  review: "Review",
  audit: "Auditor",
};

/** The Kit job's step summary for this Plan, or null when it starts no run. */
export function kitJobSummary(plan: Plan, config: Pick<KitConfig, "subscriptions">): string | null {
  const run = agentRunIn(plan);
  if (run === null) return null;
  const lines = [`The ${ROLE_NAMES[run.role]} run on #${run.issue} was given the Subscription **${subscriptionOf(run)}**.`];
  if (!rotationIsOn(config)) {
    lines.push("Subscription rotation is off until a second Subscription is listed in Kit config's `subscriptions`.");
  }
  return `### Fabrik Kit job\n\n${lines.join("\n\n")}\n`;
}

/** The Subscription the Loop rules core gave a run it starts, which `planFor` always does. */
export function subscriptionOf(run: NonNullable<ReturnType<typeof agentRunIn>>): string {
  if (run.subscription === undefined) throw new Error(`The ${run.role} run on #${run.issue} was given no Subscription`);
  return run.subscription;
}
