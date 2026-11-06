// Builders for the Loop's Replay tests (#156): a replay issue the tick has
// accepted, and the replay slice a scheduled tick weighs.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { type ReplayPlan, type ReplayVariable, replayArms, replayBody, type TicketProgress } from "../kit/replay.ts";
import type { RateLimitReading } from "../kit/runRecord.ts";
import type { ReplayIssueSnapshot, ReplaySnapshot } from "../loop/types.ts";

/** The commit Ticket `ticket`'s first Implement run started from, whose short sha is the Ticket's number in hex, such as 000000c for 12. */
export const baseOf = (ticket: number): string => `${ticket.toString(16).padStart(7, "0")}${"0".repeat(33)}`;

/** The variable every accepted replay here changes. */
export const REVIEW_HIGH: ReplayVariable = { kind: "effort", role: "review", effort: "high" };

/** A replay issue's body as the Operator files it: a line of their own, then the request block. */
export function requestBody(variable = "review.effort: high", tickets = "12, 7"): string {
  return ["Does Review hold up at a higher effort?", "", "```replay", variable, `tickets: ${tickets}`, "```", ""].join("\n");
}

/**
 * A replay issue's body once the tick accepted its request: review.effort:
 * high on these Tickets, each merged in PR `ticket + 100` from baseOf(ticket),
 * with the v1 default roles at its base, and each one's progress as given,
 * pending by default.
 */
export function acceptedBody(tickets: readonly number[] = [12, 7], progress: readonly TicketProgress[] = []): string {
  const plan: ReplayPlan = {
    variable: REVIEW_HIGH,
    tickets: tickets.map((ticket) => ({
      ticket,
      pullRequest: ticket + 100,
      baseSha: baseOf(ticket),
      flags: [],
      arms: replayArms(DEFAULT_KIT_CONFIG, REVIEW_HIGH),
    })),
    leftOut: [],
  };
  const each = tickets.map((ticket): TicketProgress => progress.find((one) => one.ticket === ticket) ?? { ticket, state: "pending" });
  return replayBody(requestBody("review.effort: high", tickets.join(", ")), { plan, progress: each });
}

/** Replay issue #140, open, filed by the Operator (`operator`) and accepted, with both its Tickets pending. */
export function aReplayIssue(overrides: Partial<ReplayIssueSnapshot> = {}): ReplayIssueSnapshot {
  return { number: 140, open: true, author: "operator", body: acceptedBody(), comments: [], labels: ["fabrik:replay"], ...overrides };
}

/** A weekly-limit reading of this utilization and status, resetting on Monday 2026-11-16 04:00 UTC. */
export function aReading(utilization: number | null, status = "allowed"): RateLimitReading {
  return { status, rateLimitType: "seven_day", utilization, resetsAt: Date.parse("2026-11-16T04:00:00Z") / 1000 };
}

/**
 * A scheduled tick's replay slice: these replay issues, by default the
 * accepted #140, with spare capacity: no Ticket for Dispatch, and the store
 * read with no weekly-limit reading on any Subscription. Nothing to accept.
 */
export function replaySlice(
  issues: readonly ReplayIssueSnapshot[] = [aReplayIssue()],
  capacity: Partial<NonNullable<ReplaySnapshot["capacity"]>> = {},
  acceptance: ReplaySnapshot["acceptance"] = null,
): ReplaySnapshot {
  return { issues, capacity: { tickets: [], researchDecisions: [], weeklyLimits: {}, ...capacity }, acceptance };
}
