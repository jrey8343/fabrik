// The Weekly summary (ADR-0009): from the store's Run records and score files,
// a GitHub facts snapshot per Product repo, the Operator and now, the one issue
// filed for the week that just ended, or skip in a quiet week. Pure, no I/O, no
// model call.
import { AGENT_BRANCH_PREFIX } from "../loop/agentPullRequest.ts";
import { NEEDS_DESIGN, NEEDS_INFO, READY_FOR_AGENT, READY_FOR_HUMAN } from "../loop/labels.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_ROUND_MARKER } from "../loop/markers.ts";
import { type DesignQueueSnapshot, type InfrastructureFailure, STRENGTH_LABELS, STRENGTHS, type Strength } from "../loop/types.ts";
import { heldCountHolder, heldCountIn } from "../monitor/core.ts";
import {
  type ArchitecturalEscape,
  type CommentFacts,
  dispatchOf,
  ESCAPE_WINDOW_MS,
  escapesIn,
  type LabelEvent,
  type MergedAgentPullRequest,
  mergedAgentPullRequestsIn,
  type MetricFacts,
  type OpenPullRequestFacts,
  verdictsOn,
  type Window,
  within,
} from "./retroEvidence.ts";
import { rubricId, SCORERS } from "./rubrics.ts";
import { type RateLimitReading, type RunRecord, runKey, UNKNOWN_COST_BASIS, WEEKLY_LIMIT } from "./runRecord.ts";
import type { ScoreEntry, ScoreFile, ScoreSkip } from "./scorer.ts";

// The GitHub facts the metrics read are the Retro evidence module's (src/kit/retroEvidence.ts).
export type {
  AgentPullRequestFacts,
  BlockerFacts,
  CommentFacts,
  CommitFacts,
  DefaultBranchCommitFacts,
  EscapeMarkerIssueFacts,
  FollowUpIssueFacts,
  LabelEvent,
  MergedTitleFacts,
  OpenPullRequestFacts,
  ReviewFacts,
  TicketFacts,
} from "./retroEvidence.ts";

/** A Spec, its label timeline and the Tickets that build it (its sub-issues). */
export interface SpecFacts {
  readonly number: number;
  readonly labelEvents: readonly LabelEvent[];
  readonly tickets: readonly number[];
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

/** An open `fabrik:monitor` issue, as Held reads the Monitor's held count from it. */
export interface MonitorIssueFacts {
  readonly number: number;
  /** Who opened it: only the Fabrik App's issues count, so quoting a held line fakes nothing. */
  readonly author: string;
  readonly body: string;
}

/** An open `fabrik:audit` issue, as Waiting on you reads it. */
export interface OpenAuditFacts {
  readonly number: number;
  readonly title: string;
  /** Who opened it: only the Fabrik App's Audits count. */
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** An open `fabrik:retro` issue, as Waiting on you reads it. */
export interface OpenRetroFacts {
  readonly number: number;
  readonly title: string;
  /** Who opened it: only the Fabrik App's Retros count. */
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** What the summary reads of one Product repo on GitHub: what the metrics read, and the rest. */
export interface GitHubFacts extends MetricFacts {
  readonly specs: readonly SpecFacts[];
  /** The repo's open issues. */
  readonly openIssues: readonly OpenIssueFacts[];
  /**
   * The repo's open `needs-design` issues with their slot-holding signals, as
   * the Design queue check reads them: Held counts the ones waiting for a slot.
   */
  readonly designQueue: DesignQueueSnapshot;
  /**
   * The repo's open `fabrik:monitor` issues: Held counts the error groups the
   * Monitor holds from the newest error issue among them that has a stats block.
   */
  readonly monitorIssues: readonly MonitorIssueFacts[];
  /** The repo's open `fabrik:audit` issues, whoever opened them. */
  readonly openAudits: readonly OpenAuditFacts[];
  /** The repo's open `fabrik:retro` issues, whoever opened them. */
  readonly openRetros: readonly OpenRetroFacts[];
}

export interface WeeklySummaryInput {
  readonly records: readonly RunRecord[];
  /** The store's score files: a picked run's scores, or why it has none (src/kit/scorer.ts). */
  readonly scoreFiles: readonly ScoreFile[];
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
  /** The API-equivalent cost of every record that ended in the week, in USD, judge runs' included. */
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
  /** Of the agent PRs merged in the 90 days to the week's end, how many at least one Architectural escape names. */
  readonly escapeRate: WeekOverWeek<EscapeRate>;
  /** The Architectural escapes opened in the 90 days to the week's end, by Strength. */
  readonly escapesByStrength: WeekOverWeek<EscapesByStrength>;
  /** The Architectural escapes opened in the week, with the evidence against each PR: what the Retro reads. */
  readonly escapesThisWeek: readonly EscapeThisWeek[];
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
  /** What the score files of the week's runs say. */
  readonly scores: WeekOverWeek<WeekScores>;
  /** What scoring cost: the week's judge runs (role `score`), which the cost includes. */
  readonly scoringCost: WeekOverWeek<ScoringCost>;
  /** One section per Product repo, in the order the facts came. */
  readonly repos: readonly RepoSection[];
}

/** The summed cost of a week's judge runs, in USD, and its share of the week's cost. */
export interface ScoringCost {
  readonly usd: number;
  /** From 0 to 1, or null in a week that cost nothing. */
  readonly share: number | null;
  /** How many judge runs it leaves out, their cost basis being unknown. */
  readonly unknownCost: number;
}

/** What the score files of the runs that ended in a week say. */
export interface WeekScores {
  /** How many score files the week's runs have, scores and skips alike. */
  readonly scoreFiles: number;
  /** Each rubric version the week's runs were scored under, in the Kit's order of Scorers. */
  readonly rubrics: readonly RubricScores[];
  /** How many of the week's runs picked for scoring were skipped, by reason. */
  readonly skips: Readonly<Record<ScoreSkip["reason"], number>>;
}

/** How the week's runs scored under one rubric version. */
export interface RubricScores {
  readonly scorer: string;
  readonly version: number;
  readonly runsScored: number;
  readonly medianScore: number;
  /** The share of the runs scored that passed, from 0 to 1. */
  readonly passing: number;
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
  /** The Sentry error groups waiting for a slot under the Monitor's cap of open error issues (caps.monitor_issues). */
  readonly monitor: HeldMonitor | null;
}

export interface HeldDesignSessions {
  /** How many open `needs-design` issues hold no slot. */
  readonly waiting: number;
  /** When the oldest waiting issue got `needs-design`, ISO 8601. */
  readonly oldestSince: string;
  /** How long the oldest has waited at the filing, in milliseconds. */
  readonly oldestAge: number;
}

export interface HeldMonitor {
  /** How many error groups the Monitor holds. */
  readonly groups: number;
  /** The open error issue whose stats block shows that count: the newest with a stats block. */
  readonly issue: number;
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
  /** The Fabrik App's open Audit, filled or still pending, waiting since it was opened. */
  | (ItemBase & { readonly kind: "audit" })
  /** The Fabrik App's open Retro, filled or still pending, waiting since it was opened. */
  | (ItemBase & { readonly kind: "retro" })
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

export interface EscapeRate {
  /** The agent PRs merged in the window that at least one escape names, each counted once. */
  readonly escaped: number;
  /** Every agent PR merged in the window. */
  readonly merged: number;
}

/** A count of escapes per Strength, with `none` for a marker whose Strength isn't one the Auditor gives, or is missing. */
export type EscapesByStrength = Readonly<Record<Strength | "none", number>>;

/** An Architectural escape opened in the week, and the PRs it counts against. */
export interface EscapeThisWeek {
  /** `owner/name`. */
  readonly repo: string;
  /** The escape's issue. */
  readonly number: number;
  readonly url: string;
  /** The issue's title and body as they stand: the candidate the Operator filed, or what a Design session rewrote it into. */
  readonly title: string;
  readonly body: string;
  /** Its marker's Strength, or null when it isn't one the Auditor gives. */
  readonly strength: Strength | null;
  /** The agent PRs merged in the 90 days to the week's end that its marker names. */
  readonly pullRequests: readonly EscapedPullRequest[];
}

/** An agent PR an escape counts against, and the evidence of how it got through. */
export interface EscapedPullRequest {
  readonly number: number;
  readonly url: string;
  /** The Ticket its `Closes #n` names, or null. */
  readonly ticket: number | null;
  /** Every Run record on its Ticket, whatever week it ran in, oldest first. */
  readonly records: readonly RunRecord[];
  /** The last Review record on the PR with a pass Verdict, the gate that missed the escape, or null when the store holds none. */
  readonly lastPassingReview: PassingReview | null;
  /** Whether anyone but the Fabrik App pushed to it, read from the commits Human touches count. */
  readonly operatorPushes: boolean;
}

export interface PassingReview {
  readonly record: RunRecord;
  /** Its transcript's store path, or null when no transcript survived the run. */
  readonly transcript: string | null;
  /** The Review's Actions run attempt. */
  readonly url: string;
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
  const repos = input.facts.map((facts) => repoSectionOf(facts, input));
  // Held work counts too, so a queue never sits unseen through a week nothing ran.
  const quiet = repos.every((repo) => repo.waitingOnYou.length === 0 && repo.stuck.length === 0 && repo.held === null);
  if (thisWeek.records === 0 && thisWeek.scores.scoreFiles === 0 && quiet) return { kind: "skip" };
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
    escapeRate: change("escapeRate"),
    escapesByStrength: change("escapesByStrength"),
    escapesThisWeek: escapesThisWeekOf(weeks.thisWeek, input),
    counts: {
      mergedPullRequests: change("mergedPullRequests"),
      ticketsDispatched: change("ticketsDispatched"),
      retries: change("retries"),
      stepUps: change("stepUps"),
    },
    scores: change("scores"),
    scoringCost: change("scoringCost"),
    repos,
  };
  return { kind: "summary", summary, title: `Weekly summary: week of ${summary.week}`, body: bodyOf(summary, input) };
}

// The metrics: one week's figures, computed the same way for any week. Which
// agent PRs merged, their Human touches, Verdicts and reverts, and the escapes
// are read through the Retro evidence module, by the rules the Retro reads.

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
  readonly escapeRate: EscapeRate;
  readonly escapesByStrength: EscapesByStrength;
  readonly mergedPullRequests: number;
  readonly ticketsDispatched: number;
  readonly retries: number;
  readonly stepUps: number;
  readonly scores: WeekScores;
  readonly scoringCost: ScoringCost;
}

function metricsOf(week: Week, input: WeeklySummaryInput): WeekMetrics {
  const records = input.records
    .filter((record) => within(week, record.endedAt))
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const tickets = input.facts.flatMap((facts) => facts.tickets);
  const merged = mergedAgentPullRequestsIn(week, input);
  const { usd: cost, unknownCost } = costOf(records);
  const scoring = costOf(records.filter((record) => record.role === "score"));
  const escapeWindow = escapeWindowOf(week);
  const escapes = escapesIn(escapeWindow, input);
  return {
    records: records.length,
    cost,
    unknownCost,
    costPerMergedPullRequest: costPerMergedPullRequestOf(week, input.records, merged),
    costPerSpec: costPerSpecOf(week, input),
    spendNeverMerged: spendNeverMergedOf(week, input),
    weeklyLimit: records.findLast((record) => record.rateLimit?.rateLimitType === WEEKLY_LIMIT)?.rateLimit ?? null,
    humanTouches: mean(merged.map((pullRequest) => pullRequest.humanTouches)),
    cycleTimeMs: median(merged.flatMap(({ dispatch, mergedAt }) => (dispatch === null ? [] : [Date.parse(mergedAt) - Date.parse(dispatch)]))),
    operatorWaitMs: median(merged.flatMap(({ mergedAt, lastPass }) => (lastPass === null ? [] : [Date.parse(mergedAt) - Date.parse(lastPass)]))),
    revertRate: revertRateOf(week, input),
    escapeRate: escapeRateOf(escapeWindow, escapes, input),
    escapesByStrength: escapesByStrengthOf(escapes),
    mergedPullRequests: merged.length,
    ticketsDispatched: tickets.filter((ticket) => {
      const dispatch = dispatchOf(ticket);
      return dispatch !== null && within(week, dispatch);
    }).length,
    retries: records.filter((record) => record.role === "implement" && record.retry > 0).length,
    stepUps: records.filter((record) => record.stepUp).length,
    scores: scoresOf(week, input),
    scoringCost: { usd: scoring.usd, share: cost === 0 ? null : scoring.usd / cost, unknownCost: scoring.unknownCost },
  };
}

/** What the score files of the week's runs say: per rubric version, how the runs scored. */
function scoresOf(week: Week, input: WeeklySummaryInput): WeekScores {
  const endedAt = new Map(input.records.map((record) => [runKey(record), record.endedAt]));
  // A score file whose record isn't in the store goes by when it was scored: minutes after its run ended.
  const files = input.scoreFiles.filter((file) => within(week, endedAt.get(runKey(file)) ?? file.scoredAt));
  const byRubric = new Map<string, { readonly scorer: string; readonly version: number; readonly entries: ScoreEntry[] }>();
  for (const entry of files.flatMap((file) => file.entries ?? [])) {
    const id = rubricId({ name: entry.scorer, version: entry.version });
    const rubric = byRubric.get(id) ?? { scorer: entry.scorer, version: entry.version, entries: [] };
    rubric.entries.push(entry);
    byRubric.set(id, rubric);
  }
  const rubrics = [...byRubric.values()].map(
    ({ scorer, version, entries }): RubricScores => ({
      scorer,
      version,
      runsScored: entries.length,
      medianScore: median(entries.map((entry) => entry.score)) ?? 0,
      passing: entries.filter((entry) => entry.pass).length / entries.length,
    }),
  );
  // The scoring plan's reasons, then the judge's: the order the section lists them in.
  const skips: Record<ScoreSkip["reason"], number> = {
    "weekly-limit": 0,
    "no-transcript": 0,
    "infrastructure-failure": 0,
    "judge-failed": 0,
    "judge-output-invalid": 0,
  };
  for (const { skip } of files) if (skip !== null) skips[skip.reason] += 1;
  return { scoreFiles: files.length, rubrics: rubrics.toSorted(inKitOrder), skips };
}

/** The Kit's order of Scorers (a Scorer it no longer has goes after them, by name), each Scorer's versions oldest first. */
function inKitOrder(a: RubricScores, b: RubricScores): number {
  const rank = (scorer: string) => {
    const index = (SCORERS as readonly string[]).indexOf(scorer);
    return index === -1 ? SCORERS.length : index;
  };
  return rank(a.scorer) - rank(b.scorer) || a.scorer.localeCompare(b.scorer) || a.version - b.version;
}

/** The agent PRs merged in the 30 days to the week's end, and how many of them a revert in that window reverted. */
function revertRateOf(week: Week, input: WeeklySummaryInput): RevertRate {
  const merged = mergedAgentPullRequestsIn({ start: week.end - REVERT_WINDOW_MS, end: week.end }, input);
  return { reverted: merged.filter((pullRequest) => pullRequest.reverted).length, merged: merged.length };
}

/** The 90 days to the week's end: slow decay needs longer than revert rate's 30 to show. */
function escapeWindowOf(week: Week): Window {
  return { start: week.end - ESCAPE_WINDOW_MS, end: week.end };
}

/** Of the agent PRs merged in the window, how many at least one escape names, each counted once however many do. */
function escapeRateOf(window: Window, escapes: readonly ArchitecturalEscape[], input: WeeklySummaryInput): EscapeRate {
  const escaped = new Set(escapes.flatMap(({ repo, pullRequests }) => pullRequests.map(({ pullRequest }) => `${repo}#${pullRequest.number}`)));
  return { escaped: escaped.size, merged: mergedAgentPullRequestsIn(window, input).length };
}

function escapesByStrengthOf(escapes: readonly ArchitecturalEscape[]): EscapesByStrength {
  const count = (strength: Strength | null) => escapes.filter((escape) => escape.strength === strength).length;
  return { strong: count("strong"), "worth-exploring": count("worth-exploring"), speculative: count("speculative"), none: count(null) };
}

/**
 * The escapes opened in the week, counted against the PRs the escape rate
 * counts them against, each with its Ticket's records, the Review that passed
 * it last and whether anyone but the App pushed to it.
 */
function escapesThisWeekOf(week: Week, input: WeeklySummaryInput): EscapeThisWeek[] {
  return escapesIn(escapeWindowOf(week), input)
    .filter(({ issue }) => within(week, issue.createdAt))
    .map(({ repo, issue, strength, pullRequests }) => ({
      repo,
      number: issue.number,
      url: `https://github.com/${repo}/issues/${issue.number}`,
      title: issue.title,
      body: issue.body,
      strength,
      pullRequests: pullRequests.map(({ pullRequest, records, lastPassingReview, operatorPushes }) => ({
        number: pullRequest.number,
        url: `https://github.com/${repo}/pull/${pullRequest.number}`,
        ticket: pullRequest.ticket,
        records,
        lastPassingReview:
          lastPassingReview === null ? null : { record: lastPassingReview, transcript: lastPassingReview.transcript, url: runUrlOf(lastPassingReview) },
        operatorPushes,
      })),
    }));
}

/** The Actions run attempt a record came from, in its Product repo. */
function runUrlOf({ repo, runId, runAttempt }: RunRecord): string {
  return `https://github.com/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;
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

function costPerMergedPullRequestOf(week: Week, records: readonly RunRecord[], merged: readonly MergedAgentPullRequest[]): CostFigure {
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

// Per repo: what waits on the Operator and what is stuck, as of the filing.

/** How long Loop work may sit without moving before it's Stuck: a fixed threshold. */
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

function repoSectionOf(facts: GitHubFacts, { records, appLogin, now: filedAt }: WeeklySummaryInput): RepoSection {
  const now = Date.parse(filedAt);
  const items = itemsIn(facts.repo, now);
  return {
    repo: facts.repo,
    // An open Audit or Retro waits on the Operator, so it also keeps a quiet week from being skipped.
    waitingOnYou: oldestFirst([...waitingOnYou(facts, items), ...openAuditsOf(facts, appLogin, items), ...openRetrosOf(facts, appLogin, items)]),
    stuck: stuck(facts, records, items, now),
    held: heldIn(facts, appLogin, now),
  };
}

/** The Fabrik App's open Audits, aged from when each was opened: a person's `fabrik:audit` issue is no Audit. */
function openAuditsOf({ openAudits }: GitHubFacts, appLogin: string, items: Items): WaitingItem[] {
  return openAudits.filter((audit) => audit.author === appLogin).map((audit) => ({ kind: "audit", ...items.issue(audit, audit.createdAt) }));
}

/** The Fabrik App's open Retros, filled or still pending, aged from when each was opened: a person's `fabrik:retro` issue is no Retro. */
function openRetrosOf({ openRetros }: GitHubFacts, appLogin: string, items: Items): WaitingItem[] {
  return openRetros.filter((retro) => retro.author === appLogin).map((retro) => ({ kind: "retro", ...items.issue(retro, retro.createdAt) }));
}

/** What a cap holds in the repo, or null when nothing is held. */
function heldIn({ designQueue, monitorIssues }: GitHubFacts, appLogin: string, now: number): Held | null {
  const designSessions = heldDesignSessionsOf(designQueue, now);
  const monitor = heldMonitorOf(monitorIssues, appLogin);
  return designSessions === null && monitor === null ? null : { designSessions, monitor };
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

/**
 * The error groups the Monitor holds, from the held line in the stats block
 * of the open error issue the Monitor shows it in, found and read by the
 * Monitor's own rule (heldCountHolder) and parser (heldCountIn), so the
 * summary and the Monitor can't disagree. Null when that block has no held line.
 */
function heldMonitorOf(issues: readonly MonitorIssueFacts[], appLogin: string): HeldMonitor | null {
  const holder = heldCountHolder(
    issues.map((issue) => ({ number: issue.number, open: true, byApp: issue.author === appLogin, body: issue.body })),
  );
  const groups = holder === null ? 0 : (heldCountIn(holder.body) ?? 0);
  return holder === null || groups === 0 ? null : { groups, issue: holder.number };
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
  const latest = verdictsOn(pullRequest.comments).filter(({ record }) => record.headSha === pullRequest.headSha).at(-1);
  return latest?.record.verdict === "pass" ? latest.at : null;
}

/** When `label` was last added, or null. */
function lastAdded(events: readonly LabelEvent[], label: string): string | null {
  const added = events.filter((event) => event.label === label && event.action === "labeled");
  return added.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)?.at ?? null;
}

// The week: Monday 00:00 to Monday 00:00 in the Operator's time zone.

/** A week as the instants it starts at (inclusive) and ends at (exclusive), and its Monday's date. */
interface Week extends Window {
  readonly monday: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REVERT_WINDOW_MS = 30 * DAY_MS;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

// Rendering. Only shipped features get a section: the Map and Monitor issues
// add theirs when their Specs ship. The open Retro gets no section, only its
// line in Waiting on you. Scores shows
// only in a week with score files, and never a run's own scores. Held shows
// what the Design-session and Monitor caps hold, until the Ideas and Maps
// caps add their lines.

function bodyOf(summary: WeeklySummary, { operator, timeZone }: WeeklySummaryInput): string {
  const { cost, unknownCost, costPerMergedPullRequest, costPerSpec, spendNeverMerged, weeklyLimit, humanTouches, cycleTimeMs, operatorWaitMs, revertRate, escapeRate, counts } = summary;
  const share = ({ reverted, merged }: RevertRate) => (merged === 0 ? null : reverted / merged);
  const revertCell = (rate: RevertRate) => orNone(share(rate), (value) => `${percent(value)} (${rate.reverted} of ${rate.merged})`);
  const revertChange = pointsChange({ thisWeek: share(revertRate.thisWeek), lastWeek: share(revertRate.lastWeek) });
  const escapeShare = ({ escaped, merged }: EscapeRate) => (merged === 0 ? null : escaped / merged);
  const escapeCell = (rate: EscapeRate) => {
    const value = escapeShare(rate);
    return value === null ? "no merged agent PRs" : `${rate.escaped} of ${rate.merged} (${percent(value)})`;
  };
  const escapeChange = pointsChange({ thisWeek: escapeShare(escapeRate.thisWeek), lastWeek: escapeShare(escapeRate.lastWeek) });
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
    `| Architectural escape rate (90 days) | ${escapeCell(escapeRate.thisWeek)} | ${escapeCell(escapeRate.lastWeek)} | ${escapeChange} |`,
    "",
    escapesByStrengthLine(summary.escapesByStrength.thisWeek),
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
  lines.push(...scoresLines(summary.scores, summary.scoringCost));
  lines.push(...heldLines(summary.repos));
  for (const repo of summary.repos) {
    lines.push(...repoLines(repo, summary.escapesThisWeek.filter((escape) => escape.repo === repo.repo)));
  }
  // The Operator's one mention, last: the week's only scheduled push.
  lines.push(`@${operator}`);
  return `${lines.join("\n")}\n`;
}

/** The escapes opened in the 90 days by Strength, naming those with no known Strength only when there are some. */
function escapesByStrengthLine(counts: EscapesByStrength): string {
  const known = STRENGTHS.map((strength) => `${counts[strength]} ${STRENGTH_LABELS[strength]}`);
  const all = counts.none === 0 ? known : [...known, `${counts.none} with no known Strength`];
  return `Architectural escapes by Strength (90 days): ${all.join(", ")}.`;
}

/**
 * The Scores section: each rubric version the week's runs were scored under,
 * against the same version last week, and what scoring cost, or nothing at
 * all in a week with no score files.
 */
function scoresLines({ thisWeek, lastWeek }: WeekOverWeek<WeekScores>, scoringCost: WeekOverWeek<ScoringCost>): string[] {
  if (thisWeek.scoreFiles === 0) return [];
  const rows = thisWeek.rubrics.flatMap((rubric) => {
    const before = lastWeek.rubrics.find(({ scorer, version }) => scorer === rubric.scorer && version === rubric.version);
    const name = `${scorerName(rubric.scorer)} v${rubric.version}`;
    return [
      row(`${name}: runs scored`, { thisWeek: rubric.runsScored, lastWeek: before?.runsScored ?? 0 }, count),
      row(`${name}: median score`, { thisWeek: rubric.medianScore, lastWeek: before?.medianScore ?? null }, (score) => score.toFixed(2)),
      shareRow(`${name}: passing`, { thisWeek: rubric.passing, lastWeek: before?.passing ?? null }),
    ];
  });
  const lines = [
    "## Scores",
    "",
    "| | This week | Last week | Change |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    row("Scoring cost", { thisWeek: scoringCost.thisWeek.usd, lastWeek: scoringCost.lastWeek.usd }, dollars),
    shareRow("Scoring's share of the cost", { thisWeek: scoringCost.thisWeek.share, lastWeek: scoringCost.lastWeek.share }),
    "",
  ];
  const skips = Object.entries(thisWeek.skips).filter(([, runs]) => runs > 0);
  const skipped = skips.reduce((sum, [, runs]) => sum + runs, 0);
  if (skipped > 0) {
    const picked = skipped === 1 ? "1 run picked for scoring was" : `${skipped} runs picked for scoring were`;
    lines.push(`${picked} skipped: ${skips.map(([reason, runs]) => `${runs} ${reason}`).join(", ")}.`, "");
  }
  const leftOut = scoringCost.thisWeek.unknownCost;
  if (leftOut > 0) lines.push(`${runsWithUnknownCost(leftOut)} left out of the scoring cost.`, "");
  return lines;
}

/** A Scorer as the summary names it: `ticket-compliance` is Ticket compliance. */
function scorerName(scorer: string): string {
  return `${scorer.charAt(0).toUpperCase()}${scorer.slice(1).replaceAll("-", " ")}`;
}

/** The Held section: a line per repo and source with work held, or nothing at all when no repo has any. */
function heldLines(repos: readonly RepoSection[]): string[] {
  const lines = repos.flatMap(({ repo, held }) => {
    const shown: string[] = [];
    const design = held?.designSessions ?? null;
    if (design !== null) {
      const issues = design.waiting === 1 ? "1 needs-design issue" : `${design.waiting} needs-design issues`;
      const oldest = design.waiting === 1 ? `for ${duration(design.oldestAge)}` : `the oldest for ${duration(design.oldestAge)}`;
      shown.push(`- ${repo}: ${issues} waiting for a Design session slot, ${oldest}`);
    }
    const monitor = held?.monitor ?? null;
    if (monitor !== null) {
      const groups = monitor.groups === 1 ? "1 error group" : `${monitor.groups} error groups`;
      shown.push(`- ${repo}: ${groups} waiting for a Monitor issue slot, counted in [#${monitor.issue}](https://github.com/${repo}/issues/${monitor.issue})`);
    }
    return shown;
  });
  return lines.length === 0 ? [] : ["## Held", "", ...lines, ""];
}

/** How many of a repo's Waiting on you items show before the rest collapse into `<details>`. */
const SHOWN_ITEMS = 10;

function repoLines({ repo, waitingOnYou, stuck }: RepoSection, escapes: readonly EscapeThisWeek[]): string[] {
  const lines = [`## ${repo}`, "", "### Waiting on you", ""];
  if (waitingOnYou.length === 0) lines.push("Nothing waiting on you.", "");
  else {
    lines.push(...waitingOnYou.slice(0, SHOWN_ITEMS).map(waitingLine), "");
    const rest = waitingOnYou.slice(SHOWN_ITEMS);
    if (rest.length > 0) lines.push(`<details><summary>${rest.length} more</summary>`, "", ...rest.map(waitingLine), "", "</details>", "");
  }
  if (stuck.length > 0) lines.push("### Stuck", "", ...stuck.map(stuckLine), "");
  if (escapes.length > 0) lines.push("### Architectural escapes this week", "", ...escapes.flatMap(escapeLines), "");
  lines.push(liveLinks(repo), "");
  return lines;
}

/** An escape's issue, then a line per PR it counts against: the Review run that missed it, and any Operator pushes. */
function escapeLines({ number, url, pullRequests }: EscapeThisWeek): string[] {
  return [
    `- [#${number}](${url})`,
    ...pullRequests.map(({ number, url, lastPassingReview, operatorPushes }) => {
      const review = lastPassingReview === null ? "no passing Review run on record" : `missed by [Review run](${lastPassingReview.url})`;
      return `  - [#${number}](${url}): ${review}${operatorPushes ? ", with Operator pushes" : ""}`;
    }),
  ];
}

function waitingLine(item: WaitingItem): string {
  switch (item.kind) {
    case "design-round":
      return itemLine(item, `Design round unanswered for ${duration(item.age)}`);
    case "ready-for-human":
      return itemLine(item, `ready-for-human for ${duration(item.age)}`);
    case "audit":
      return itemLine(item, `Audit open for ${duration(item.age)}`);
    case "retro":
      return itemLine(item, `Retro open for ${duration(item.age)}`);
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

/** A table row: the figure this week and last week, and the change, with a dash where either has nothing to show. */
function row(name: string, { thisWeek, lastWeek }: WeekOverWeek<number | null>, format: (value: number) => string): string {
  const change = thisWeek === null || lastWeek === null ? NONE : signed(thisWeek - lastWeek, format);
  return `| ${name} | ${orNone(thisWeek, format)} | ${orNone(lastWeek, format)} | ${change} |`;
}

/** A table row for a share, from 0 to 1: as a percentage, with the change in percentage points. */
function shareRow(name: string, shares: WeekOverWeek<number | null>): string {
  return `| ${name} | ${orNone(shares.thisWeek, percent)} | ${orNone(shares.lastWeek, percent)} | ${pointsChange(shares)} |`;
}

/** The change in a share, in points between the percentages shown, or a dash where either week has none. */
function pointsChange({ thisWeek, lastWeek }: WeekOverWeek<number | null>): string {
  if (thisWeek === null || lastWeek === null) return NONE;
  return signed(Math.round(thisWeek * 100) - Math.round(lastWeek * 100), (points) => `${points} pts`);
}

function count(value: number): string {
  return String(value);
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
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
