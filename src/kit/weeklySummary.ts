// The Weekly summary (ADR-0009): from the store's Run records, a GitHub facts
// snapshot per Product repo, the Operator and now, the one issue filed for the
// week that just ended, or skip in a quiet week. Pure, no I/O, no model call.
import { DISPATCH_LABEL, READY_FOR_AGENT, READY_FOR_HUMAN } from "../loop/labels.ts";
import type { RateLimitReading, RunRecord } from "./runRecord.ts";

/** A label added to or removed from an issue, by whom and when. */
export interface LabelEvent {
  readonly label: string;
  readonly action: "labeled" | "unlabeled";
  readonly actor: string;
  /** ISO 8601. */
  readonly at: string;
}

/** A Ticket and its label timeline. */
export interface TicketFacts {
  readonly number: number;
  readonly labelEvents: readonly LabelEvent[];
  /** ISO 8601, or null while it's open. */
  readonly closedAt: string | null;
}

/** A Spec, its label timeline and the Tickets that build it (its sub-issues). */
export interface SpecFacts {
  readonly number: number;
  readonly labelEvents: readonly LabelEvent[];
  readonly tickets: readonly number[];
}

/** An agent PR merged or closed in the last 30 days. */
export interface AgentPullRequestFacts {
  readonly number: number;
  /** The Ticket its `Closes #n` names, or null. */
  readonly ticket: number | null;
  readonly title: string;
  /** ISO 8601, or null for a PR closed without merging. */
  readonly mergedAt: string | null;
  readonly mergeSha: string | null;
}

/** What the summary reads of one Product repo on GitHub. */
export interface GitHubFacts {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  readonly pullRequests: readonly AgentPullRequestFacts[];
  readonly tickets: readonly TicketFacts[];
  readonly specs: readonly SpecFacts[];
}

export interface WeeklySummaryInput {
  readonly records: readonly RunRecord[];
  readonly facts: readonly GitHubFacts[];
  /** The Operator's GitHub login, the owner of the store. */
  readonly operator: string;
  /** The Operator's IANA time zone, such as `Australia/Sydney`. */
  readonly timeZone: string;
  /** The filing time, ISO 8601. */
  readonly now: string;
}

/** A metric this week and last week, computed the same way from the same inputs. */
export interface WeekOverWeek<T> {
  readonly thisWeek: T;
  readonly lastWeek: T;
}

/** A cost figure, in USD, and how many runs it leaves out, their cost basis being unknown. */
export interface CostFigure {
  /** Null when there's nothing to average over. */
  readonly usd: number | null;
  readonly unknownCost: number;
}

/** The week's headline figures. */
export interface WeeklySummary {
  /** The Monday the week began on, in the Operator's time zone, as `yyyy-mm-dd`. */
  readonly week: string;
  /** The API-equivalent cost of every record that ended in the week, in USD. */
  readonly cost: WeekOverWeek<number>;
  /** How many of the week's records the cost leaves out, their cost basis being unknown. */
  readonly unknownCost: WeekOverWeek<number>;
  /**
   * For each agent PR merged in the week, the cost of every Implement, Retry,
   * Step-up and Review record on its Ticket, whatever week the run was in,
   * averaged over the week's merged PRs.
   */
  readonly costPerMergedPullRequest: WeekOverWeek<CostFigure>;
  /**
   * For each Spec that left design in the week (the App gave it its ready
   * label), the Triage and Design records on its issue plus the Design turns
   * on its Tickets sent back to design, whatever week they ran in, averaged
   * over those Specs.
   */
  readonly costPerSpec: WeekOverWeek<CostFigure>;
  /**
   * The cost of every Implement, Retry, Step-up and Review record on the
   * Tickets that closed in the week without a merged PR, whatever week they
   * ran in. Never null.
   */
  readonly spendNeverMerged: WeekOverWeek<CostFigure>;
  /** The latest weekly-limit reading across the week's records, or null if none read one. */
  readonly weeklyLimit: WeekOverWeek<RateLimitReading | null>;
  readonly counts: {
    /** Agent PRs merged in the week, across every Product repo. */
    readonly mergedPullRequests: WeekOverWeek<number>;
    /** Tickets whose Dispatch, their first `agent:implement`, came in the week. */
    readonly ticketsDispatched: WeekOverWeek<number>;
    /** Implement records with `retry > 0`. */
    readonly retries: WeekOverWeek<number>;
    /** Records of a Step-up. */
    readonly stepUps: WeekOverWeek<number>;
  };
}

export type WeeklySummaryResult =
  | { readonly kind: "skip" }
  | {
      readonly kind: "summary";
      readonly summary: WeeklySummary;
      /** The issue's title and body. */
      readonly title: string;
      readonly body: string;
    };

/** The summary to file for the week that just ended, or skip. */
export function weeklySummary(input: WeeklySummaryInput): WeeklySummaryResult {
  const weeks = weeksEndingAt(Date.parse(input.now), input.timeZone);
  const thisWeek = metricsOf(weeks.thisWeek, input);
  const lastWeek = metricsOf(weeks.lastWeek, input);
  if (thisWeek.records === 0) return { kind: "skip" };
  const change = <K extends keyof WeekMetrics>(metric: K): WeekOverWeek<WeekMetrics[K]> => ({
    thisWeek: thisWeek[metric],
    lastWeek: lastWeek[metric],
  });
  const summary: WeeklySummary = {
    week: weeks.thisWeek.monday,
    cost: change("cost"),
    unknownCost: change("unknownCost"),
    costPerMergedPullRequest: change("costPerMergedPullRequest"),
    costPerSpec: change("costPerSpec"),
    spendNeverMerged: change("spendNeverMerged"),
    weeklyLimit: change("weeklyLimit"),
    counts: {
      mergedPullRequests: change("mergedPullRequests"),
      ticketsDispatched: change("ticketsDispatched"),
      retries: change("retries"),
      stepUps: change("stepUps"),
    },
  };
  return { kind: "summary", summary, title: `Weekly summary: week of ${summary.week}`, body: bodyOf(summary, input) };
}

// The metrics: one week's figures, computed the same way for any week.

interface WeekMetrics {
  readonly records: number;
  readonly cost: number;
  readonly unknownCost: number;
  readonly costPerMergedPullRequest: CostFigure;
  readonly costPerSpec: CostFigure;
  readonly spendNeverMerged: CostFigure;
  readonly weeklyLimit: RateLimitReading | null;
  readonly mergedPullRequests: number;
  readonly ticketsDispatched: number;
  readonly retries: number;
  readonly stepUps: number;
}

function metricsOf(week: Week, input: WeeklySummaryInput): WeekMetrics {
  const records = input.records
    .filter((record) => within(week, record.endedAt))
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const pullRequests = input.facts.flatMap((facts) => facts.pullRequests);
  const tickets = input.facts.flatMap((facts) => facts.tickets);
  return {
    records: records.length,
    cost: records.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    unknownCost: records.filter((record) => record.totalCostUsd === null).length,
    costPerMergedPullRequest: costPerMergedPullRequestOf(week, input),
    costPerSpec: costPerSpecOf(week, input),
    spendNeverMerged: spendNeverMergedOf(week, input),
    weeklyLimit: records.findLast((record) => record.rateLimit !== null)?.rateLimit ?? null,
    mergedPullRequests: pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null && within(week, pullRequest.mergedAt)).length,
    ticketsDispatched: tickets.filter((ticket) => {
      const dispatch = dispatchOf(ticket);
      return dispatch !== null && within(week, dispatch);
    }).length,
    retries: records.filter((record) => record.role === "implement" && record.retry > 0).length,
    stepUps: records.filter((record) => record.stepUp).length,
  };
}

/** The roles whose runs build a Ticket: Implement (Retries and Step-ups among them) and Review. */
const BUILD_ROLES: readonly RunRecord["role"][] = ["implement", "review"];

function costPerMergedPullRequestOf(week: Week, input: WeeklySummaryInput): CostFigure {
  const ended = endedBy(week, input.records);
  const perPullRequest = input.facts.flatMap((facts) =>
    facts.pullRequests
      .filter((pullRequest) => pullRequest.mergedAt !== null && within(week, pullRequest.mergedAt))
      .map((pullRequest) =>
        ended.filter(
          (record) =>
            record.repo === facts.repo &&
            pullRequest.ticket !== null &&
            record.issue === pullRequest.ticket &&
            BUILD_ROLES.includes(record.role),
        ),
      ),
  );
  return averageCostOf(perPullRequest);
}

function costPerSpecOf(week: Week, input: WeeklySummaryInput): CostFigure {
  const ended = endedBy(week, input.records);
  const perSpec = input.facts.flatMap((facts) =>
    facts.specs
      .filter((spec) => leftDesignIn(week, spec))
      .map((spec) =>
        ended.filter(
          (record) =>
            record.repo === facts.repo &&
            ((record.issue === spec.number && (record.role === "triage" || record.role === "design")) ||
              (spec.tickets.includes(record.issue) && record.role === "design")),
        ),
      ),
  );
  return averageCostOf(perSpec);
}

function spendNeverMergedOf(week: Week, input: WeeklySummaryInput): CostFigure {
  const ended = endedBy(week, input.records);
  return costOf(
    input.facts.flatMap((facts) => {
      const merged = new Set(facts.pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null).map((pullRequest) => pullRequest.ticket));
      const unmerged = facts.tickets.filter(
        (ticket) => ticket.closedAt !== null && within(week, ticket.closedAt) && !merged.has(ticket.number),
      );
      return ended.filter(
        (record) =>
          record.repo === facts.repo && unmerged.some((ticket) => ticket.number === record.issue) && BUILD_ROLES.includes(record.role),
      );
    }),
  );
}

/** Whether the App gave the Spec its ready label, ending its Design session, in the week. */
function leftDesignIn(week: Week, spec: SpecFacts): boolean {
  return spec.labelEvents.some(
    (event) =>
      (event.label === READY_FOR_AGENT || event.label === READY_FOR_HUMAN) &&
      event.action === "labeled" &&
      byTheApp(event) &&
      within(week, event.at),
  );
}

/** Whether a GitHub App made the label event: its login is the App's slug with `[bot]`. */
function byTheApp(event: LabelEvent): boolean {
  return event.actor.endsWith("[bot]");
}

/** Each group's summed cost, averaged over the groups, or null for no groups. */
function averageCostOf(groups: readonly (readonly RunRecord[])[]): CostFigure {
  const total = costOf(groups.flat());
  return { usd: groups.length === 0 ? null : total.usd / groups.length, unknownCost: total.unknownCost };
}

/** The records that ended before the week did, whatever week they ended in. */
function endedBy(week: Week, records: readonly RunRecord[]): RunRecord[] {
  return records.filter((record) => Date.parse(record.endedAt) < week.end);
}

/** The summed cost of these records, leaving out (and counting) those whose cost basis is unknown. */
function costOf(records: readonly RunRecord[]): CostFigure & { readonly usd: number } {
  return {
    usd: records.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    unknownCost: records.filter((record) => record.totalCostUsd === null).length,
  };
}

/** When the Ticket was dispatched: its first `agent:implement` (a Retry adds it again), or null. */
function dispatchOf(ticket: TicketFacts): string | null {
  const added = ticket.labelEvents.filter((event) => event.label === DISPATCH_LABEL && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at ?? null;
}

// The week: Monday 00:00 to Monday 00:00 in the Operator's time zone.

/** A week as the instants it starts at (inclusive) and ends at (exclusive), and its Monday's date. */
interface Week {
  readonly start: number;
  readonly end: number;
  readonly monday: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function within(week: Week, at: string): boolean {
  const time = Date.parse(at);
  return time >= week.start && time < week.end;
}

/** The week ending at the last Monday 00:00 at or before `now`, and the week before it. */
function weeksEndingAt(now: number, timeZone: string): { thisWeek: Week; lastWeek: Week } {
  const today = wallClock(now, timeZone);
  // A calendar date as midnight UTC, so date arithmetic never meets a DST change.
  const thisMonday = Date.UTC(today.year, today.month - 1, today.day) - WEEKDAYS.indexOf(today.weekday) * DAY_MS;
  const week = (monday: number): Week => ({
    start: midnight(monday, timeZone),
    end: midnight(monday + 7 * DAY_MS, timeZone),
    monday: new Date(monday).toISOString().slice(0, 10),
  });
  return { thisWeek: week(thisMonday - 7 * DAY_MS), lastWeek: week(thisMonday - 14 * DAY_MS) };
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: string;
  /** The wall-clock time read as if it were UTC. */
  readonly asUtc: number;
}

function wallClock(time: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  }).formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const [year, month, day, hour, minute, second] = (["year", "month", "day", "hour", "minute", "second"] as const).map((type) =>
    Number(part(type)),
  ) as [number, number, number, number, number, number];
  return { year, month, day, weekday: part("weekday"), asUtc: Date.UTC(year, month - 1, day, hour, minute, second) };
}

/** The instant a calendar date (as midnight UTC) begins in the time zone. */
function midnight(date: number, timeZone: string): number {
  const offsetAt = (time: number) => wallClock(time, timeZone).asUtc - time;
  const guess = date - offsetAt(date);
  return date - offsetAt(guess);
}

/** `yyyy-mm-dd hh:mm` on the wall clock in the time zone. */
function localTime(time: number, timeZone: string): string {
  return new Date(wallClock(time, timeZone).asUtc).toISOString().slice(0, 16).replace("T", " ");
}

// Rendering. Only shipped features get a section: Held, the Retro, Audit, Map
// and Monitor issues, the architectural escape rate and scores add theirs when
// their Specs ship.

function bodyOf(summary: WeeklySummary, { operator, timeZone }: WeeklySummaryInput): string {
  const { cost, unknownCost, costPerMergedPullRequest, costPerSpec, spendNeverMerged, weeklyLimit, counts } = summary;
  const row = (name: string, { thisWeek, lastWeek }: WeekOverWeek<number>, format: (value: number) => string) =>
    `| ${name} | ${format(thisWeek)} | ${format(lastWeek)} | ${signed(thisWeek - lastWeek, format)} |`;
  const count = (value: number) => String(value);
  const costRow = (name: string, figure: WeekOverWeek<CostFigure>) => {
    const thisWeek = figure.thisWeek.usd;
    const lastWeek = figure.lastWeek.usd;
    const shown = (value: number | null) => (value === null ? NONE : dollars(value));
    const change = thisWeek === null || lastWeek === null ? NONE : signed(thisWeek - lastWeek, dollars);
    return `| ${name} | ${shown(thisWeek)} | ${shown(lastWeek)} | ${change} |`;
  };
  const costFigures: [string, WeekOverWeek<CostFigure>][] = [
    ["cost per merged PR", costPerMergedPullRequest],
    ["cost per Spec", costPerSpec],
    ["spend that never merged", spendNeverMerged],
  ];
  const lines = [
    "## Metrics",
    "",
    "| | This week | Last week | Change |",
    "| --- | ---: | ---: | ---: |",
    row("API-equivalent cost", cost, dollars),
    costRow("Cost per merged PR", costPerMergedPullRequest),
    costRow("Cost per Spec", costPerSpec),
    costRow("Spend that never merged", spendNeverMerged),
    row("Merged agent PRs", counts.mergedPullRequests, count),
    row("Tickets dispatched", counts.ticketsDispatched, count),
    row("Retries", counts.retries, count),
    row("Step-ups", counts.stepUps, count),
    "",
  ];
  if (unknownCost.thisWeek > 0) {
    lines.push(
`${runsWithUnknownCost(unknownCost.thisWeek)} left out of the cost.`,
      "",
    );
  }
  for (const [name, figure] of costFigures) {
    const leftOut = figure.thisWeek.unknownCost;
    if (leftOut > 0) lines.push(`${runsWithUnknownCost(leftOut)} left out of ${name}.`, "");
  }
  // The Operator's one mention, last: the week's only scheduled push.
  lines.push(subscriptionUsage(weeklyLimit, timeZone), "", `@${operator}`);
  return `${lines.join("\n")}\n`;
}

function subscriptionUsage({ thisWeek, lastWeek }: WeekOverWeek<RateLimitReading | null>, timeZone: string): string {
  const share = (reading: RateLimitReading | null) =>
    reading === null || reading.utilization === null ? null : `${Math.round(reading.utilization * 100)}%`;
  const now = share(thisWeek);
  const before = share(lastWeek);
  const resets =
    thisWeek === null || thisWeek.resetsAt === null ? "" : `, resetting ${localTime(thisWeek.resetsAt * 1000, timeZone)} (${timeZone})`;
  const usage =
    now === null ? "Subscription usage: no weekly-limit reading this week." : `Subscription usage: ${now} of the weekly limit${resets}.`;
  return before === null ? usage : `${usage} Last week: ${before}.`;
}

/** What the table shows for a figure with nothing to average over. */
const NONE = "–";

/** `1 run with an unknown cost basis is`, or `2 runs … are`. */
function runsWithUnknownCost(count: number): string {
  return count === 1 ? "1 run with an unknown cost basis is" : `${count} runs with an unknown cost basis are`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A change with its sign: `+1`, `-$0.75`, or plain `0`. */
function signed(change: number, format: (value: number) => string): string {
  const rounded = Math.round(change * 100) / 100;
  if (rounded === 0) return format(0);
  return `${rounded > 0 ? "+" : "-"}${format(Math.abs(rounded))}`;
}
