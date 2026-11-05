// The Weekly summary (ADR-0009): from the store's Run records, a GitHub facts
// snapshot per Product repo, the Operator and now, the one issue filed for the
// week that just ended, or skip in a quiet week. Pure, no I/O, no model call.
import { verdictsIn } from "../github/threads.ts";
import { AGENT_BRANCH_PREFIX } from "../loop/agentPullRequest.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, NEEDS_INFO, READY_FOR_AGENT, READY_FOR_HUMAN, REVIEW_LABEL } from "../loop/labels.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_ROUND_MARKER } from "../loop/markers.ts";
import type { DesignQueueSnapshot, InfrastructureFailure } from "../loop/types.ts";
import { type RateLimitReading, type RunRecord, UNKNOWN_COST_BASIS, WEEKLY_LIMIT } from "./runRecord.ts";

/** A label added to or removed from an issue, by whom and when. */
export interface LabelEvent {
  readonly label: string;
  readonly action: "labeled" | "unlabeled";
  readonly actor: string;
  /** ISO 8601. */
  readonly at: string;
}

/** An issue a Ticket is blocked by. */
export interface BlockerFacts {
  readonly number: number;
  /** Its labels: an Operator step's include `ready-for-human`. */
  readonly labels: readonly string[];
}

/** A Ticket, its label timeline and what it's blocked by. */
export interface TicketFacts {
  readonly number: number;
  readonly labelEvents: readonly LabelEvent[];
  readonly blockedBy: readonly BlockerFacts[];
  /** ISO 8601, or null while it's open. */
  readonly closedAt: string | null;
}

/** A commit on an agent PR's branch. */
export interface CommitFacts {
  /** Whether the Fabrik App made it, as an agent run's push does. */
  readonly byApp: boolean;
  /** ISO 8601. */
  readonly at: string;
}

/** A review left on an agent PR. */
export interface ReviewFacts {
  readonly author: string;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed";
  /** ISO 8601. */
  readonly at: string;
}

/** A comment on an issue or a PR. */
export interface CommentFacts {
  readonly author: string;
  /** Whether a bot, such as the Fabrik App, wrote it: only a bot's markers count, so quoting one fakes nothing. */
  readonly byBot: boolean;
  readonly body: string;
  /** ISO 8601. */
  readonly at: string;
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
  /** Its commits, oldest first. */
  readonly commits: readonly CommitFacts[];
  readonly reviews: readonly ReviewFacts[];
  /** Its comments, oldest first. */
  readonly comments: readonly CommentFacts[];
  readonly labelEvents: readonly LabelEvent[];
}

/** A commit on the default branch. */
export interface DefaultBranchCommitFacts {
  readonly message: string;
  /** ISO 8601. */
  readonly at: string;
}

/** Any PR merged in the last 30 days, agent or not, by its title. */
export interface MergedTitleFacts {
  readonly title: string;
  /** ISO 8601. */
  readonly mergedAt: string;
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
  /** The default branch's commits in the last 30 days. */
  readonly defaultBranchCommits: readonly DefaultBranchCommitFacts[];
  readonly mergedPullRequestTitles: readonly MergedTitleFacts[];
  readonly specs: readonly SpecFacts[];
  /** The repo's open issues. */
  readonly openIssues: readonly OpenIssueFacts[];
  /** The repo's open agent PRs. */
  readonly openPullRequests: readonly OpenPullRequestFacts[];
  /**
   * The repo's open `needs-design` issues with their slot-holding signals, as
   * the Design queue check reads them: Held counts the ones waiting for a slot.
   */
  readonly designQueue: DesignQueueSnapshot;
}

export interface WeeklySummaryInput {
  readonly records: readonly RunRecord[];
  readonly facts: readonly GitHubFacts[];
  /** The Operator's GitHub login, the owner of the store. */
  readonly operator: string;
  /** The Fabrik App's bot login, its slug with `[bot]`, as label events name it. */
  readonly appLogin: string;
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
  /** Human touches per agent PR merged in the week, or null in a week with none merged. */
  readonly humanTouches: WeekOverWeek<number | null>;
  /** The median time from Dispatch to merge of the week's merged agent PRs, in ms, or null with none. */
  readonly cycleTimeMs: WeekOverWeek<number | null>;
  /** The median time from the last passing Verdict to merge of the week's merged agent PRs, in ms, or null with none. */
  readonly operatorWaitMs: WeekOverWeek<number | null>;
  /** Of the agent PRs merged in the 30 days to the week's end, how many were reverted in that window. */
  readonly revertRate: WeekOverWeek<RevertRate>;
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
  /** The work a cap holds in the repo, or null when it holds nothing. */
  readonly held: Held | null;
}

/** The work a cap holds in one Product repo, by source: null for a source holding nothing. */
export interface Held {
  /** The `needs-design` issues waiting for a Design session slot (caps.design_sessions). */
  readonly designSessions: HeldDesignSessions | null;
}

export interface HeldDesignSessions {
  /** How many open `needs-design` issues hold no slot. */
  readonly waiting: number;
  /** When the oldest waiting issue got `needs-design`, ISO 8601. */
  readonly oldestSince: string;
  /** How long the oldest has waited at the filing, in milliseconds. */
  readonly oldestAge: number;
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

export interface RevertRate {
  readonly reverted: number;
  readonly merged: number;
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
  const repos = input.facts.map((facts) => repoSectionOf(facts, input.records, Date.parse(input.now)));
  // Held work counts too, so a queue never sits unseen through a week nothing ran.
  const quiet = repos.every((repo) => repo.waitingOnYou.length === 0 && repo.stuck.length === 0 && repo.held === null);
  if (thisWeek.records === 0 && quiet) return { kind: "skip" };
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
    humanTouches: change("humanTouches"),
    cycleTimeMs: change("cycleTimeMs"),
    operatorWaitMs: change("operatorWaitMs"),
    revertRate: change("revertRate"),
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
  readonly costPerMergedPullRequest: CostFigure;
  readonly costPerSpec: CostFigure;
  readonly spendNeverMerged: CostFigure;
  readonly weeklyLimit: RateLimitReading | null;
  readonly humanTouches: number | null;
  readonly cycleTimeMs: number | null;
  readonly operatorWaitMs: number | null;
  readonly revertRate: RevertRate;
  readonly mergedPullRequests: number;
  readonly ticketsDispatched: number;
  readonly retries: number;
  readonly stepUps: number;
}

function metricsOf(week: Week, input: WeeklySummaryInput): WeekMetrics {
  const records = input.records
    .filter((record) => within(week, record.endedAt))
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const tickets = input.facts.flatMap((facts) => facts.tickets);
  const merged = input.facts.flatMap((facts) =>
    facts.pullRequests.flatMap((pullRequest) =>
      pullRequest.mergedAt !== null && within(week, pullRequest.mergedAt) ? [mergedPullRequestOf(facts, pullRequest, pullRequest.mergedAt)] : [],
    ),
  );
  const { usd: cost, unknownCost } = costOf(records);
  return {
    records: records.length,
    cost,
    unknownCost,
    costPerMergedPullRequest: costPerMergedPullRequestOf(week, input.records, merged),
    costPerSpec: costPerSpecOf(week, input),
    spendNeverMerged: spendNeverMergedOf(week, input),
    weeklyLimit: records.findLast((record) => record.rateLimit?.rateLimitType === WEEKLY_LIMIT)?.rateLimit ?? null,
    humanTouches: mean(merged.map((pullRequest) => humanTouchesOf(pullRequest, input.operator))),
    cycleTimeMs: median(merged.flatMap(({ dispatch, mergedAt }) => (dispatch === null ? [] : [Date.parse(mergedAt) - Date.parse(dispatch)]))),
    operatorWaitMs: median(
      merged.flatMap(({ pullRequest, mergedAt }) => {
        const passed = lastPassOf(pullRequest, mergedAt);
        return passed === null ? [] : [Date.parse(mergedAt) - Date.parse(passed)];
      }),
    ),
    revertRate: revertRateOf(week, input.facts),
    mergedPullRequests: merged.length,
    ticketsDispatched: tickets.filter((ticket) => {
      const dispatch = dispatchOf(ticket);
      return dispatch !== null && within(week, dispatch);
    }).length,
    retries: records.filter((record) => record.role === "implement" && record.retry > 0).length,
    stepUps: records.filter((record) => record.stepUp).length,
  };
}

/** An agent PR merged in the week, with its repo, its Ticket and when that was dispatched. */
interface MergedPullRequest {
  readonly repo: string;
  readonly pullRequest: AgentPullRequestFacts;
  readonly mergedAt: string;
  readonly ticket: TicketFacts | null;
  readonly dispatch: string | null;
}

function mergedPullRequestOf(facts: GitHubFacts, pullRequest: AgentPullRequestFacts, mergedAt: string): MergedPullRequest {
  const ticket = facts.tickets.find((candidate) => candidate.number === pullRequest.ticket) ?? null;
  return { repo: facts.repo, pullRequest, mergedAt, ticket, dispatch: ticket === null ? null : dispatchOf(ticket) };
}

/**
 * The Operator's steps into a Ticket's path between Dispatch and merge (the
 * glossary's Human touch). The merge, Design-session answers and Operator
 * comments are never touches.
 */
function humanTouchesOf({ pullRequest, mergedAt, ticket, dispatch }: MergedPullRequest, operator: string): number {
  const before = (at: string) => Date.parse(at) <= Date.parse(mergedAt);
  const between = (at: string) => (dispatch === null || Date.parse(at) >= Date.parse(dispatch)) && before(at);
  // Dispatch itself adds the first agent:implement, so a label counts only after it.
  const after = (at: string) => (dispatch === null || Date.parse(at) > Date.parse(dispatch)) && before(at);
  // A push: a run of consecutive commits the App didn't make.
  const commits = pullRequest.commits.filter((commit) => between(commit.at));
  const pushes = commits.filter((commit, i) => !commit.byApp && (i === 0 || commits[i - 1]?.byApp === true)).length;
  const requestChanges = pullRequest.reviews.filter(
    (review) => review.author === operator && review.state === "changes-requested" && between(review.at),
  ).length;
  const added = [...(ticket?.labelEvents ?? []), ...pullRequest.labelEvents].filter((event) => event.action === "labeled" && after(event.at));
  // A Retry or Step-up the Operator asked for.
  const retriesAsked = added.filter((event) => event.actor === operator && (event.label === DISPATCH_LABEL || event.label === REVIEW_LABEL)).length;
  // A Pairing session on the Ticket.
  const pairing = ticket?.labelEvents.some((event) => event.label === READY_FOR_HUMAN && event.action === "labeled" && after(event.at)) ? 1 : 0;
  const operatorSteps = ticket?.blockedBy.filter((blocker) => blocker.labels.includes(READY_FOR_HUMAN)).length ?? 0;
  return pushes + requestChanges + retriesAsked + pairing + operatorSteps;
}

/**
 * The agent PRs merged in the 30 days to the week's end, and how many of them
 * a default-branch commit's `This reverts commit <merge sha>` trailer, or a
 * merged `Revert "<title>"` PR, reverted in the same window.
 */
function revertRateOf(week: Week, facts: readonly GitHubFacts[]): RevertRate {
  const window = { start: week.end - REVERT_WINDOW_MS, end: week.end };
  const counts = facts.map((repo) => {
    const merged = repo.pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null && within(window, pullRequest.mergedAt));
    const commits = repo.defaultBranchCommits.filter((commit) => within(window, commit.at));
    const titles = repo.mergedPullRequestTitles.filter((pullRequest) => within(window, pullRequest.mergedAt));
    const reverted = merged.filter(
      ({ mergeSha, title }) =>
        (mergeSha !== null && commits.some((commit) => commit.message.includes(`This reverts commit ${mergeSha}`))) ||
        titles.some((pullRequest) => pullRequest.title === `Revert "${title}"`),
    );
    return { reverted: reverted.length, merged: merged.length };
  });
  return {
    reverted: counts.reduce((sum, count) => sum + count.reverted, 0),
    merged: counts.reduce((sum, count) => sum + count.merged, 0),
  };
}

/** When the PR's last passing Verdict before its merge was given, read through the Verdict marker on the App's comments, or null. */
function lastPassOf(pullRequest: AgentPullRequestFacts, mergedAt: string): string | null {
  return (
    pullRequest.comments.findLast(
      (comment) =>
        comment.byBot && Date.parse(comment.at) <= Date.parse(mergedAt) && verdictsIn([comment.body]).some((record) => record.verdict === "pass"),
    )?.at ?? null
  );
}

function median(values: readonly number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The roles whose runs build a Ticket: Implement (Retries and Step-ups among them) and Review. */
const BUILD_ROLES: readonly RunRecord["role"][] = ["implement", "review"];

function costPerMergedPullRequestOf(week: Week, records: readonly RunRecord[], merged: readonly MergedPullRequest[]): CostFigure {
  const ended = endedBy(week, records);
  const perPullRequest = merged.map(({ repo, pullRequest }) =>
    ended.filter(
      (record) =>
        record.repo === repo && pullRequest.ticket !== null && record.issue === pullRequest.ticket && BUILD_ROLES.includes(record.role),
    ),
  );
  return averageCostOf(perPullRequest);
}

function costPerSpecOf(week: Week, input: WeeklySummaryInput): CostFigure {
  const ended = endedBy(week, input.records);
  const perSpec = input.facts.flatMap((facts) =>
    facts.specs
      .filter((spec) => leftDesignIn(week, spec, input.appLogin))
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

/** Whether the Fabrik App gave the Spec its ready label, ending its Design session, in the week. */
function leftDesignIn(week: Week, spec: SpecFacts, appLogin: string): boolean {
  return spec.labelEvents.some(
    (event) =>
      (event.label === READY_FOR_AGENT || event.label === READY_FOR_HUMAN) &&
      event.action === "labeled" &&
      event.actor === appLogin &&
      within(week, event.at),
  );
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

/**
 * The summed cost of these records, leaving out (and counting) those whose
 * cost basis is unknown. A run with no cost figure at all, one that ended
 * without a result, such as a timeout, adds nothing and isn't counted.
 */
function costOf(records: readonly RunRecord[]): CostFigure & { readonly usd: number } {
  return {
    usd: records.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    unknownCost: records.filter(hasUnknownCostBasis).length,
  };
}

/** Whether any of the run's models has an unknown cost basis, which leaves the run with no total (src/kit/runRecord.ts). */
function hasUnknownCostBasis(record: RunRecord): boolean {
  return Object.values(record.modelUsage).some((usage) => usage.costBasis === UNKNOWN_COST_BASIS);
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
  return { repo: facts.repo, waitingOnYou: waitingOnYou(facts, items), stuck: stuck(facts, records, items, now), held: heldIn(facts, now) };
}

/** What a cap holds in the repo, or null when nothing is held. */
function heldIn({ designQueue }: GitHubFacts, now: number): Held | null {
  const designSessions = heldDesignSessionsOf(designQueue, now);
  return designSessions === null ? null : { designSessions };
}

/**
 * The `needs-design` issues waiting for a Design session slot: by the Design
 * queue check's own rule (holdsSlot), so the summary and the check can't disagree.
 */
function heldDesignSessionsOf(queue: DesignQueueSnapshot, now: number): HeldDesignSessions | null {
  const waiting = queue.issues.filter((issue) => !holdsSlot(issue, queue));
  const oldestSince = waiting.map((issue) => issue.neededDesignAt).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (oldestSince === undefined) return null;
  return { waiting: waiting.length, oldestSince, oldestAge: now - Date.parse(oldestSince) };
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

/**
 * An open Ticket's latest record, if it ended in an Infrastructure failure:
 * the run nothing has picked up again. A judge run's record (role `score`) is
 * left out: scoring a run never picks its Ticket up, and a judge's own failure
 * never leaves the Ticket stuck.
 */
function failedLastRunOf(
  issue: OpenIssueFacts,
  repo: string,
  records: readonly RunRecord[],
): { readonly endedAt: string; readonly failure: InfrastructureFailure } | null {
  const latest = records
    .filter((record) => record.repo === repo && record.issue === issue.number && record.role !== "score")
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
const REVERT_WINDOW_MS = 30 * DAY_MS;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function within({ start, end }: Pick<Week, "start" | "end">, at: string): boolean {
  const time = Date.parse(at);
  return time >= start && time < end;
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

// Rendering. Only shipped features get a section: the Retro, Audit, Map and
// Monitor issues, the architectural escape rate and scores add theirs when
// their Specs ship. Held shows only what the Design-session cap holds, until
// the Monitor and Ideas and Maps caps add their lines.

function bodyOf(summary: WeeklySummary, { operator, timeZone }: WeeklySummaryInput): string {
  const { cost, unknownCost, costPerMergedPullRequest, costPerSpec, spendNeverMerged, weeklyLimit, humanTouches, cycleTimeMs, operatorWaitMs, revertRate, counts } = summary;
  const row = (name: string, { thisWeek, lastWeek }: WeekOverWeek<number | null>, format: (value: number) => string) =>
    `| ${name} | ${orNone(thisWeek, format)} | ${orNone(lastWeek, format)} | ${
      thisWeek === null || lastWeek === null ? NONE : signed(thisWeek - lastWeek, format)
    } |`;
  const count = (value: number) => String(value);
  const share = ({ reverted, merged }: RevertRate) => (merged === 0 ? null : reverted / merged);
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const reverts = { thisWeek: share(revertRate.thisWeek), lastWeek: share(revertRate.lastWeek) };
  const revertCell = (rate: RevertRate) => orNone(share(rate), (value) => `${percent(value)} (${rate.reverted} of ${rate.merged})`);
  const revertChange =
    reverts.thisWeek === null || reverts.lastWeek === null
      ? NONE
      : signed(Math.round(reverts.thisWeek * 100) - Math.round(reverts.lastWeek * 100), (points) => `${points} pts`);
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
    row("Human touches per merged PR", humanTouches, (value) => value.toFixed(1)),
    row("Cycle time (median)", cycleTimeMs, hours),
    row("Operator wait (median)", operatorWaitMs, hours),
    `| Revert rate (30 days) | ${revertCell(revertRate.thisWeek)} | ${revertCell(revertRate.lastWeek)} | ${revertChange} |`,
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
  lines.push(subscriptionUsage(weeklyLimit, timeZone), "");
  lines.push(...heldLines(summary.repos));
  for (const repo of summary.repos) lines.push(...repoLines(repo));
  // The Operator's one mention, last: the week's only scheduled push.
  lines.push(`@${operator}`);
  return `${lines.join("\n")}\n`;
}

/** The Held section: a line per repo and source with work held, or nothing at all when no repo has any. */
function heldLines(repos: readonly RepoSection[]): string[] {
  const lines = repos.flatMap(({ repo, held }) => {
    const design = held?.designSessions ?? null;
    if (design === null) return [];
    const issues = design.waiting === 1 ? "1 needs-design issue" : `${design.waiting} needs-design issues`;
    const oldest = design.waiting === 1 ? `for ${duration(design.oldestAge)}` : `the oldest for ${duration(design.oldestAge)}`;
    return [`- ${repo}: ${issues} waiting for a Design session slot, ${oldest}`];
  });
  return lines.length === 0 ? [] : ["## Held", "", ...lines, ""];
}

/** How many of a repo's Waiting on you items show before the rest collapse into `<details>`. */
const SHOWN_ITEMS = 10;

function repoLines({ repo, waitingOnYou, stuck }: RepoSection): string[] {
  const lines = [`## ${repo}`, "", "### Waiting on you", ""];
  if (waitingOnYou.length === 0) lines.push("Nothing waiting on you.", "");
  else {
    lines.push(...waitingOnYou.slice(0, SHOWN_ITEMS).map(waitingLine), "");
    const rest = waitingOnYou.slice(SHOWN_ITEMS);
    if (rest.length > 0) lines.push(`<details><summary>${rest.length} more</summary>`, "", ...rest.map(waitingLine), "", "</details>", "");
  }
  if (stuck.length > 0) lines.push("### Stuck", "", ...stuck.map(stuckLine), "");
  lines.push(liveLinks(repo), "");
  return lines;
}

function waitingLine(item: WaitingItem): string {
  switch (item.kind) {
    case "design-round":
      return itemLine(item, `Design round unanswered for ${duration(item.age)}`);
    case "ready-for-human":
      return itemLine(item, `ready-for-human for ${duration(item.age)}`);
    case "merge-gate":
      return itemLine(item, `at the Merge gate, Operator wait ${duration(item.operatorWait)}`);
  }
}

function stuckLine(item: StuckItem): string {
  switch (item.kind) {
    case "needs-info-answered":
      return itemLine(item, `needs-info answered ${duration(item.age)} ago, not picked up`);
    case "idle-draft":
      return itemLine(item, `a draft with no activity for ${duration(item.age)}`);
    case "infrastructure-failure":
      return itemLine(item, `last run ended in an Infrastructure failure (${item.failure}) ${duration(item.age)} ago`);
  }
}

function itemLine({ number, url, title }: ItemBase, state: string): string {
  return `- [#${number}](${url}) ${escapedTitle(title)}: ${state}`;
}

/**
 * A title as plain text in the body: an `@` gets a zero-width space after it,
 * so it mentions nobody (the Operator's is the body's one mention), and
 * brackets and angle brackets are backslash-escaped, so they open no link or tag.
 */
function escapedTitle(title: string): string {
  return title.replaceAll("@", "@&#8203;").replace(/[[\]<>]/g, (character) => `\\${character}`);
}

/** GitHub searches to look between summaries. */
function liveLinks(repo: string): string {
  const search = (list: "issues" | "pulls", query: string) => `https://github.com/${repo}/${list}?q=${encodeURIComponent(query)}`;
  return [
    `Live: [ready-for-human](${search("issues", `is:issue is:open label:${READY_FOR_HUMAN}`)})`,
    `[open agent PRs](${search("pulls", `is:pr is:open head:${AGENT_BRANCH_PREFIX}`)})`,
    `[needs-design](${search("issues", `is:issue is:open label:${NEEDS_DESIGN}`)})`,
  ].join(" · ");
}

/** An age in whole hours under two days, else whole days. */
function duration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "under an hour";
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
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

function orNone(value: number | null, format: (value: number) => string): string {
  return value === null ? NONE : format(value);
}

function hours(ms: number): string {
  return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
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
