// The Weekly summary (ADR-0009): from the store's Run records, a GitHub facts
// snapshot per Product repo, the Operator and now, the one issue filed for the
// week that just ended, or skip in a quiet week. Pure, no I/O, no model call.
import { verdictsIn } from "../github/threads.ts";
import { DISPATCH_LABEL, NEEDS_INFO, READY_FOR_HUMAN } from "../loop/labels.ts";
import { DESIGN_ROUND_MARKER } from "../loop/markers.ts";
import type { InfrastructureFailure } from "../loop/types.ts";
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

/** A comment on an issue or a PR. */
export interface CommentFacts {
  readonly author: string;
  /** Whether a bot wrote it: only a bot's markers count, so quoting one fakes nothing. */
  readonly byBot: boolean;
  readonly body: string;
  /** ISO 8601. */
  readonly at: string;
}

/** An open issue, as Waiting on you and Stuck read it. */
export interface OpenIssueFacts {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  /** ISO 8601. */
  readonly createdAt: string;
  /** Oldest first. */
  readonly comments: readonly CommentFacts[];
  readonly labelEvents: readonly LabelEvent[];
}

/** An open agent PR, as Waiting on you and Stuck read it. */
export interface OpenPullRequestFacts {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly headSha: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** When each of its commits was made. */
  readonly commits: readonly { readonly at: string }[];
  /** Oldest first. */
  readonly comments: readonly CommentFacts[];
  readonly labelEvents: readonly LabelEvent[];
}

/** What the summary reads of one Product repo on GitHub. */
export interface GitHubFacts {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  readonly pullRequests: readonly AgentPullRequestFacts[];
  readonly tickets: readonly TicketFacts[];
  /** The repo's open issues. */
  readonly openIssues: readonly OpenIssueFacts[];
  /** The repo's open agent PRs. */
  readonly openPullRequests: readonly OpenPullRequestFacts[];
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

/** The week's headline figures. */
export interface WeeklySummary {
  /** The Monday the week began on, in the Operator's time zone, as `yyyy-mm-dd`. */
  readonly week: string;
  /** The API-equivalent cost of every record that ended in the week, in USD. */
  readonly cost: WeekOverWeek<number>;
  /** How many of the week's records the cost leaves out, their cost basis being unknown. */
  readonly unknownCost: WeekOverWeek<number>;
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
  /** One section per Product repo, in the order the facts came. */
  readonly repos: readonly RepoSection[];
}

/** What one Product repo has waiting on the Operator, as of the filing. */
export interface RepoSection {
  /** `owner/name`. */
  readonly repo: string;
  /** Oldest first. */
  readonly waitingOnYou: readonly WaitingItem[];
  /** Loop work that hasn't moved in more than 24 hours, longest-stuck first. */
  readonly stuck: readonly StuckItem[];
}

interface ItemBase {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** When it started waiting, ISO 8601. */
  readonly since: string;
  /** How long it has waited at the filing, in milliseconds. */
  readonly age: number;
}

/** Something whose next move is the Operator's. */
export type WaitingItem =
  /** An open Design session whose last comment is the App's round. */
  | (ItemBase & { readonly kind: "design-round" })
  /** An open `ready-for-human` issue, waiting since it got the label. */
  | (ItemBase & { readonly kind: "ready-for-human" })
  /** An agent PR out of draft with a passing Verdict at its head, waiting since that Verdict. */
  | (ItemBase & {
      readonly kind: "merge-gate";
      /** The Operator wait so far: from the passing Verdict to the filing, in milliseconds. */
      readonly operatorWait: number;
    });

/** Loop work that hasn't moved in more than 24 hours, since `since`. */
export type StuckItem =
  /** A `needs-info` issue a person answered after the question, with no state change since the answer. */
  | (ItemBase & { readonly kind: "needs-info-answered" })
  /** A draft agent PR with no commit, comment or label event since `since`. */
  | (ItemBase & { readonly kind: "idle-draft" })
  /** An open Ticket whose latest record, ended at `since`, was an Infrastructure failure or timeout. */
  | (ItemBase & { readonly kind: "infrastructure-failure"; readonly failure: InfrastructureFailure });

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
  const repos = input.facts.map((facts) => repoSectionOf(facts, input.records, Date.parse(input.now)));
  const quiet = repos.every((repo) => repo.waitingOnYou.length === 0 && repo.stuck.length === 0);
  if (thisWeek.records === 0 && quiet) return { kind: "skip" };
  const change = <K extends keyof WeekMetrics>(metric: K): WeekOverWeek<WeekMetrics[K]> => ({
    thisWeek: thisWeek[metric],
    lastWeek: lastWeek[metric],
  });
  const summary: WeeklySummary = {
    week: weeks.thisWeek.monday,
    cost: change("cost"),
    unknownCost: change("unknownCost"),
    weeklyLimit: change("weeklyLimit"),
    counts: {
      mergedPullRequests: change("mergedPullRequests"),
      ticketsDispatched: change("ticketsDispatched"),
      retries: change("retries"),
      stepUps: change("stepUps"),
    },
    repos,
  };
  return { kind: "summary", summary, title: `Weekly summary: week of ${summary.week}`, body: bodyOf(summary, input) };
}

// The metrics: one week's figures, computed the same way for any week.

interface WeekMetrics {
  readonly records: number;
  readonly cost: number;
  readonly unknownCost: number;
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

/** When the Ticket was dispatched: its first `agent:implement` (a Retry adds it again), or null. */
function dispatchOf(ticket: TicketFacts): string | null {
  const added = ticket.labelEvents.filter((event) => event.label === DISPATCH_LABEL && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at ?? null;
}

// Per repo: what waits on the Operator and what is stuck, as of the filing.

/** How long Loop work may sit without moving before it's Stuck: a fixed threshold. */
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

function repoSectionOf(facts: GitHubFacts, records: readonly RunRecord[], now: number): RepoSection {
  const items = itemsIn(facts.repo, now);
  return { repo: facts.repo, waitingOnYou: waitingOnYou(facts, items), stuck: stuck(facts, records, items, now) };
}

/** Builds a repo's items, aged as of the filing. */
function itemsIn(repo: string, now: number) {
  const item = (number: number, title: string, url: string, since: string): ItemBase => ({
    number,
    title,
    url,
    since,
    age: now - Date.parse(since),
  });
  return {
    issue: (issue: { readonly number: number; readonly title: string }, since: string) =>
      item(issue.number, issue.title, `https://github.com/${repo}/issues/${issue.number}`, since),
    pullRequest: (pullRequest: OpenPullRequestFacts, since: string) =>
      item(pullRequest.number, pullRequest.title, `https://github.com/${repo}/pull/${pullRequest.number}`, since),
  };
}

type Items = ReturnType<typeof itemsIn>;

function oldestFirst<T extends ItemBase>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

function waitingOnYou({ openIssues, openPullRequests }: GitHubFacts, items: Items): WaitingItem[] {
  const waiting: WaitingItem[] = [];
  for (const issue of openIssues) {
    const round = unansweredRoundOf(issue);
    if (round !== null) waiting.push({ kind: "design-round", ...items.issue(issue, round) });
    if (issue.labels.includes(READY_FOR_HUMAN)) {
      const since = lastAdded(issue.labelEvents, READY_FOR_HUMAN) ?? issue.createdAt;
      waiting.push({ kind: "ready-for-human", ...items.issue(issue, since) });
    }
  }
  for (const pullRequest of openPullRequests) {
    const passed = passAtHeadOf(pullRequest);
    if (pullRequest.draft || passed === null) continue;
    const item = items.pullRequest(pullRequest, passed);
    waiting.push({ kind: "merge-gate", ...item, operatorWait: item.age });
  }
  return oldestFirst(waiting);
}

function stuck({ repo, openIssues, openPullRequests }: GitHubFacts, records: readonly RunRecord[], items: Items, now: number): StuckItem[] {
  const found: StuckItem[] = [];
  for (const issue of openIssues) {
    const answered = issue.labels.includes(NEEDS_INFO) ? answerOf(issue) : null;
    if (answered !== null) found.push({ kind: "needs-info-answered", ...items.issue(issue, answered) });
    const failed = failedLastRunOf(issue, repo, records);
    if (failed !== null) found.push({ kind: "infrastructure-failure", ...items.issue(issue, failed.endedAt), failure: failed.failure });
  }
  for (const pullRequest of openPullRequests) {
    if (pullRequest.draft) found.push({ kind: "idle-draft", ...items.pullRequest(pullRequest, lastActivityOf(pullRequest)) });
  }
  return oldestFirst(found.filter((item) => now - Date.parse(item.since) > STUCK_AFTER_MS));
}

/**
 * When a person first answered a `needs-info` issue's question, or null if
 * nobody has. The question is when it last got `needs-info`: a later state
 * change would have taken the label off, and asking again adds it anew. A
 * bot's comment is no answer, as it never sends the issue back to Triage.
 */
function answerOf(issue: OpenIssueFacts): string | null {
  const asked = Date.parse(lastAdded(issue.labelEvents, NEEDS_INFO) ?? issue.createdAt);
  return issue.comments.find((comment) => !comment.byBot && Date.parse(comment.at) > asked)?.at ?? null;
}

/** An open Ticket's latest record, if it ended in an Infrastructure failure: the run nothing has picked up again. */
function failedLastRunOf(
  issue: OpenIssueFacts,
  repo: string,
  records: readonly RunRecord[],
): { readonly endedAt: string; readonly failure: InfrastructureFailure } | null {
  const latest = records
    .filter((record) => record.repo === repo && record.issue === issue.number)
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .at(-1);
  if (latest === undefined || latest.infrastructureFailure === null) return null;
  if (latest.role !== "implement" && latest.role !== "review") return null;
  return { endedAt: latest.endedAt, failure: latest.infrastructureFailure };
}

/** A PR's latest commit, comment or label event, or when it was opened. */
function lastActivityOf(pullRequest: OpenPullRequestFacts): string {
  const times = [pullRequest.createdAt, ...[...pullRequest.commits, ...pullRequest.comments, ...pullRequest.labelEvents].map(({ at }) => at)];
  return times.toSorted((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? pullRequest.createdAt;
}

/** When the App posted the Design round an issue's thread ends on, or null if its last comment is anything else. */
function unansweredRoundOf(issue: OpenIssueFacts): string | null {
  const last = issue.comments.at(-1);
  return last !== undefined && last.byBot && DESIGN_ROUND_MARKER.test(last.body) ? last.at : null;
}

/** When a PR's latest Verdict on its head was posted, if that Verdict is a pass; otherwise null. */
function passAtHeadOf(pullRequest: OpenPullRequestFacts): string | null {
  // Only a bot's markers count, so nobody can fake a pass by quoting one.
  const verdicts = pullRequest.comments.flatMap((comment) =>
    comment.byBot ? verdictsIn([comment.body]).map((record) => ({ record, at: comment.at })) : [],
  );
  const latest = verdicts.filter(({ record }) => record.headSha === pullRequest.headSha).at(-1);
  return latest?.record.verdict === "pass" ? latest.at : null;
}

/** When `label` was last added, or null. */
function lastAdded(events: readonly LabelEvent[], label: string): string | null {
  const added = events.filter((event) => event.label === label && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)?.at ?? null;
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
  const { cost, unknownCost, weeklyLimit, counts } = summary;
  const row = (name: string, { thisWeek, lastWeek }: WeekOverWeek<number>, format: (value: number) => string) =>
    `| ${name} | ${format(thisWeek)} | ${format(lastWeek)} | ${signed(thisWeek - lastWeek, format)} |`;
  const count = (value: number) => String(value);
  const lines = [
    "## Metrics",
    "",
    "| | This week | Last week | Change |",
    "| --- | ---: | ---: | ---: |",
    row("API-equivalent cost", cost, dollars),
    row("Merged agent PRs", counts.mergedPullRequests, count),
    row("Tickets dispatched", counts.ticketsDispatched, count),
    row("Retries", counts.retries, count),
    row("Step-ups", counts.stepUps, count),
    "",
  ];
  if (unknownCost.thisWeek > 0) {
    lines.push(
      unknownCost.thisWeek === 1
        ? "1 run with an unknown cost basis is left out of the cost."
        : `${unknownCost.thisWeek} runs with an unknown cost basis are left out of the cost.`,
      "",
    );
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

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A change with its sign: `+1`, `-$0.75`, or plain `0`. */
function signed(change: number, format: (value: number) => string): string {
  const rounded = Math.round(change * 100) / 100;
  if (rounded === 0) return format(0);
  return `${rounded > 0 ? "+" : "-"}${format(Math.abs(rounded))}`;
}
