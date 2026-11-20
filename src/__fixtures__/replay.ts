// Builders for the Loop's Replay tests (#156): a replay issue the tick has
// accepted, and the replay slice a scheduled tick weighs.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { type ReplayPlan, type ReplayVariable, replayArms, replayBody, type TicketProgress } from "../kit/replay.ts";
import type { RateLimitReading } from "../kit/runRecord.ts";
import type { ReplayIssueSnapshot, ReplaySnapshot } from "../loop/types.ts";

/** The commit Ticket `ticket`'s first Implement run started from, whose short sha is the Ticket's number in hex, such as 000000c for 12. */
export const baseOf = (ticket: number): string => `${ticket.toString(16).padStart(7, "0")}${"0".repeat(33)}`;

/** The variable every accepted replay here changes. */
export const REVIEW_XHIGH: ReplayVariable = { kind: "effort", role: "review", effort: "xhigh" };

/** A replay issue's body as the Operator files it: a line of their own, then the request block. */
export function requestBody(variable = "review.effort: xhigh", tickets = "12, 7"): string {
  return ["Does Review hold up at a higher effort?", "", "```replay", variable, `tickets: ${tickets}`, "```", ""].join("\n");
}

/**
 * A replay issue's body once the tick accepted its request: review.effort:
 * xhigh, above the Review's high default, on these Tickets, each merged in PR `ticket + 100` from baseOf(ticket),
 * with the v1 default roles at its base, and each one's progress as given,
 * pending by default.
 */
export function acceptedBody(
  tickets: readonly number[] = [12, 7],
  progress: readonly TicketProgress[] = [],
  { variable = REVIEW_XHIGH, line = "review.effort: xhigh" }: { readonly variable?: ReplayVariable; readonly line?: string } = {},
): string {
  const plan: ReplayPlan = {
    variable,
    tickets: tickets.map((ticket) => ({
      ticket,
      pullRequest: ticket + 100,
      baseSha: baseOf(ticket),
      flags: [],
      arms: replayArms(DEFAULT_KIT_CONFIG, variable),
    })),
    leftOut: [],
  };
  const each = tickets.map((ticket): TicketProgress => progress.find((one) => one.ticket === ticket) ?? { ticket, state: "pending" });
  return replayBody(requestBody(line, tickets.join(", ")), { plan, progress: each });
}

/** The body of a replay whose variant runs Review on Fable (ADR-0034), accepted in a repo that opted in. */
export function fableReplayBody(tickets: readonly number[] = [12, 7]): string {
  return acceptedBody(tickets, [], { variable: { kind: "model", role: "review", model: "claude-fable-5-2" }, line: "review.model: claude-fable-5-2" });
}

/** Replay issue #140, open, filed by the Operator (`operator`) and accepted, with both its Tickets pending, and never given up on. */
export function aReplayIssue(overrides: Partial<ReplayIssueSnapshot> = {}): ReplayIssueSnapshot {
  return { number: 140, open: true, author: "operator", body: acceptedBody(), comments: [], labels: ["fabrik:replay"], gaveUp: false, ...overrides };
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
  return { issues, capacity: { tickets: [], researchDecisions: [], implementRunTickets: [], weeklyLimits: {}, fableCaps: [], ...capacity }, acceptance };
}
