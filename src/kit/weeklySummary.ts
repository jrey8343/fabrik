// The Weekly summary (ADR-0009): from the store's Run records and score files,
// a GitHub facts snapshot per Product repo, the Operator and now, the one issue
// filed for the week that just ended, or skip in a quiet week. Pure, no I/O, no
// model call.
import { researchRunFailedIn } from "../github/threads.ts";
import { AGENT_BRANCH_PREFIX } from "../loop/agentPullRequest.ts";
import {
  DECISION_TYPES,
  decisionLabel,
  type DecisionLabel,
  MAP_LABEL,
  NEEDS_DESIGN,
  NEEDS_INFO,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  RESEARCH_LABEL,
  WEEKLY_LIMIT_LABEL,
} from "../loop/labels.ts";
import { waitingIssues } from "../loop/designQueue.ts";
import { runNamed, waitingHeldRuns } from "../loop/heldRun.ts";
import { resetsAtOf } from "../loop/kitIssueMarks.ts";
import { mapCapFull } from "../loop/mapCap.ts";
import { auditMarksIn, DESIGN_ROUND_MARKER, flakyCheckMarksIn, DESIGN_TURN_FAILED_MARKER, refusedByMapCap, retroMarksIn } from "../loop/markers.ts";
import { readable, spelled, wallClock } from "../loop/readable.ts";
import { whyNotResearchable } from "../loop/research.ts";
import { type AgentRole, type BrokenRun, type DesignQueueSnapshot, type InfrastructureFailure, type KitIssueSnapshot, STEP_UP_REASONS, type StepUpReason, STRENGTH_LABELS, STRENGTHS, type Strength } from "../loop/types.ts";
import { FAILED_RUNS_A_WEEK, failedInWeek, weekStart } from "../loop/weeklyGate.ts";
import { heldCountHolder, heldCountIn } from "../monitor/core.ts";
import { STORE_CALLER_PATH } from "../setup/shims.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
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
  requestChangesIn,
  type RequestChangesReview,
  type ReviewFacts,
  verdictsOn,
  type Window,
  within,
} from "./retroEvidence.ts";
import { type LoopHealth, loopHealthLines, loopHealthOf, loopNeedsLook, type RepoHealthFacts } from "./loopHealth.ts";
import { isOperatorsReplay, replayResultsIn } from "./replay.ts";
import { rubricId, SCORERS } from "./rubrics.ts";
import {
  firstRunOf,
  isLive,
  type RateLimitReading,
  RUN_RECORD_SCHEMA,
  type RunRecord,
  runKey,
  UNKNOWN_COST_BASIS,
  type UnreadableRunRecords,
  WEEKLY_LIMIT,
} from "./runRecord.ts";
import type { ScoreEntry, ScoreFile, ScoreSkip } from "./scorer.ts";

// The GitHub facts the metrics read are the Retro evidence module's (src/kit/retroEvidence.ts).
export type { RepoHealthFacts } from "./loopHealth.ts";
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
  /** Who opened it: a `needs-info` issue the Fabrik App filed as the Monitor, or the Operator filed, waits on the Operator. */
  readonly author: string;
  readonly labels: readonly string[];
  /** ISO 8601. */
  readonly createdAt: string;
  /** Oldest first. */
  readonly comments: readonly CommentFacts[];
  readonly labelEvents: readonly LabelEvent[];
  /** Its sub-issues, open or closed, by number: a Map's Decisions, or a Spec's Tickets. */
  readonly subIssues: readonly number[];
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

/** A `fabrik:audit` or `fabrik:retro` issue, open or closed, as Stuck reads a week's failed runs from it. */
export interface WeeklyRunIssueFacts {
  readonly number: number;
  readonly title: string;
  /** Who opened it: only the Fabrik App's Audits and Retros count. */
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Its body, whose markers say whether its run failed. */
  readonly body: string;
}

/** An open `fabrik:replay` issue, as Waiting on you reads it. */
export interface OpenReplayFacts {
  readonly number: number;
  readonly title: string;
  /** Who filed it: only the Operator's replay issues count, as only they run. */
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** When its body was last edited, ISO 8601: the Kit writing its results, once they're in. Null for a body never edited. */
  readonly lastEditedAt: string | null;
  /** Its body as it stands, whose markers say whether its results are in. */
  readonly body: string;
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
  /** The repo's newest `fabrik:audit` issues, open and closed, whoever opened them, as the audit gate reads them. */
  readonly audits: readonly WeeklyRunIssueFacts[];
  /** The repo's newest `fabrik:retro` issues, open and closed, whoever opened them, as the retro gate reads them. */
  readonly retros: readonly WeeklyRunIssueFacts[];
  /** The repo's open `fabrik:replay` issues, whoever filed them. */
  readonly openReplays: readonly OpenReplayFacts[];
  /** The repo's open Maps, by number, oldest first, read as the Map cap reads them: whoever charted them. */
  readonly openMaps: readonly number[];
  /**
   * The repo's open Kit-owned issues, read as the Loop's snapshot reads them:
   * Held names the held runs their weekly-limit issues' held markers name,
   * and Stuck leaves those runs out, as the Kit resumes them itself.
   */
  readonly kitIssues: readonly KitIssueSnapshot[];
}

/** A Product repo whose GitHub facts couldn't be read this run, and why. */
export interface UnreadRepo {
  /** `owner/name`. */
  readonly repo: string;
  readonly why: string;
}

export interface WeeklySummaryInput {
  readonly records: readonly RunRecord[];
  /** The store's Run records the Kit couldn't read, which no figure counts: the summary says how many and how to read them. */
  readonly unreadableRecords: UnreadableRunRecords;
  /** The store's score files: a picked run's scores, or why it has none (src/kit/scorer.ts). */
  readonly scoreFiles: readonly ScoreFile[];
  readonly facts: readonly GitHubFacts[];
  /** The Product repos whose facts couldn't be read: each gets its section, saying so, and no figure counts it. */
  readonly unread: readonly UnreadRepo[];
  /** Each Product repo's Loop, as read for its health line (#460): a repo with none gets no line. */
  readonly health: readonly RepoHealthFacts[];
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

/**
 * The week's headline figures. Every figure but `replaySpend` reads live runs
 * only, leaving out Replay arms' records and score files and the judge's
 * records for Replay runs.
 */
export interface WeeklySummary {
  /** The Monday the week began on, in the Operator's time zone, as `yyyy-mm-dd`. */
  readonly week: string;
  /** The API-equivalent cost of every record that ended in the week, in USD, judge runs' included. */
  readonly cost: WeekOverWeek<number>;
  /** How many of the week's records the cost leaves out, their cost basis being unknown. */
  readonly unknownCost: WeekOverWeek<number>;
  /**
   * What the week's Replays cost: every Replay arm's record that ended in the
   * week, the judge's runs scoring them included. Every other figure leaves
   * Replays out. Null in a week with no Replay record.
   */
  readonly replaySpend: WeekOverWeek<ReplaySpend | null>;
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
  /**
   * Each Subscription the week's records ran on, by vault item name, with its
   * API-equivalent cost this week and its latest weekly-limit reading this
   * week and last week. A record written before runs named their Subscription
   * reads as the first listed one's (readRunRecord).
   */
  readonly subscriptions: readonly SubscriptionUsage[];
  /** Human touches per agent PR merged in the week, or null in a week with none merged. */
  readonly humanTouches: WeekOverWeek<number | null>;
  /** The median time from Dispatch to merge of the week's merged agent PRs, in ms, or null with none. */
  readonly cycleTimeMs: WeekOverWeek<number | null>;
  /**
   * The median Operator wait of the week's merged agent PRs, in ms, or null
   * with none: from the last passing Verdict to the Operator's first review
   * after it, or to the merge if they gave none.
   */
  readonly operatorWaitMs: WeekOverWeek<number | null>;
  /** Of the agent PRs merged in the 30 days to the week's end, how many were reverted in that window. */
  readonly revertRate: WeekOverWeek<RevertRate>;
  /** Of the agent PRs merged in the 90 days to the week's end, how many at least one Architectural escape names. */
  readonly escapeRate: WeekOverWeek<EscapeRate>;
  /** The Architectural escapes opened in the 90 days to the week's end, by Strength. */
  readonly escapesByStrength: WeekOverWeek<EscapesByStrength>;
  /** The Architectural escapes opened in the week, with the evidence against each PR: what the Retro reads. */
  readonly escapesThisWeek: readonly EscapeThisWeek[];
  /** The Operator's Request changes submitted in the week, by what their runs answered about them (#369). */
  readonly requestChanges: WeekOverWeek<RequestChangesCounts>;
  /** Each Request changes submitted in the week whose run answered that it holds a Review miss. */
  readonly reviewMissesThisWeek: readonly ReviewMissThisWeek[];
  readonly counts: {
    /** Agent PRs merged in the week, across every Product repo. */
    readonly mergedPullRequests: WeekOverWeek<number>;
    /** Tickets whose Dispatch, their first `agent:implement`, came in the week. */
    readonly ticketsDispatched: WeekOverWeek<number>;
    /**
     * Implement records with `retry > 0` and no Infrastructure failure, so a
     * Retry refused on the weekly limit and then resumed counts once.
     */
    readonly retries: WeekOverWeek<number>;
    /** Implement records of a Broken run (#434), counted or not. */
    readonly brokenRuns: WeekOverWeek<number>;
    /** The Flaky checks found on agent PRs: by the Kit's re-run of red checks, and counted back later alike (#462). */
    readonly flakyChecks: WeekOverWeek<number>;
    /** Records of a Step-up. */
    readonly stepUps: WeekOverWeek<number>;
    /** Those records by why they Stepped up (ADR-0014). */
    readonly stepUpsByReason: WeekOverWeek<StepUpCounts>;
    /** The Tickets merged in the week whose first Implement run was a Stepped-up start, and how many of them needed no Retry. */
    readonly steppedUpStarts: WeekOverWeek<SteppedUpStarts>;
  };
  /** What the score files of the week's runs say. */
  readonly scores: WeekOverWeek<WeekScores>;
  /** What scoring cost: the week's judge runs (role `score`), which the cost includes. */
  readonly scoringCost: WeekOverWeek<ScoringCost>;
  /** One section per Product repo, in the order the facts came. */
  readonly repos: readonly RepoSection[];
}

/**
 * A week's Request changes: how many hold a Review miss and how many amend
 * the Ticket, two independent answers, and how many have no answer at all.
 */
export interface RequestChangesCounts {
  readonly reviewMiss: number;
  readonly amendsTicket: number;
  readonly unanswered: number;
}

/** A Request changes whose run answered it holds a Review miss, with where to read each part of it. */
export interface ReviewMissThisWeek {
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  /** The PR's. */
  readonly url: string;
  /** The Request changes review's. */
  readonly reviewUrl: string;
  /** The Kit's comment holding the answer. */
  readonly answerUrl: string;
  /** The Actions run of the Review whose pass it followed, or null when the store holds none. */
  readonly passingReviewUrl: string | null;
}

/** A week's Step-up records, by reason. */
export type StepUpCounts = Readonly<Record<StepUpReason, number>>;

/** A week's merged Stepped-up starts: how many merged, and how many of those had no Retry. */
export interface SteppedUpStarts {
  readonly merged: number;
  readonly noRetry: number;
}

/** The summed cost of a week's Replay records, in USD. */
export interface ReplaySpend {
  readonly usd: number;
  /** How many Replay records it leaves out, their cost basis being unknown. */
  readonly unknownCost: number;
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
  /** Why the repo's GitHub facts couldn't be read this run, or null when they were: an unread repo has nothing waiting, stuck or held. */
  readonly unread: string | null;
  /** Its Loop's health, or null when it wasn't read. */
  readonly health: LoopHealth | null;
}

/** The work a cap holds in one Product repo, by source: null for a source holding nothing. */
export interface Held {
  /** The `needs-design` issues waiting for a Design session slot (caps.design_sessions). */
  readonly designSessions: HeldDesignSessions | null;
  /** The Sentry error groups waiting for a slot under the Monitor's cap of open error issues (caps.monitor_issues). */
  readonly monitor: HeldMonitor | null;
  /** The open Maps filling the Map cap (caps.maps), so no Design session offers a new one. */
  readonly maps: HeldMaps | null;
  /** The Held runs waiting on the open weekly-limit, usage-credits and token-rotation issues while every Subscription is used up. */
  readonly runs: HeldRuns | null;
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

export interface HeldMaps {
  /** Every open Map, whoever charted it, lowest number first. */
  readonly open: readonly number[];
}

export interface HeldRuns {
  /** Each Held run, in the order the scheduled tick resumes them. */
  readonly runs: readonly HeldRunItem[];
  /** Every open weekly-limit issue, oldest first, with when its limit resets. */
  readonly weeklyLimitIssues: readonly WeeklyLimitIssue[];
}

export interface HeldRunItem {
  readonly role: AgentRole;
  /** The issue or PR its trigger label lives on: a Review's PR, every other role's issue. */
  readonly issue: number;
  /** The weekly-limit, usage-credits and token-rotation issues whose held markers hold it. */
  readonly heldOn: readonly number[];
}

export interface WeeklyLimitIssue {
  readonly number: number;
  /** When its limit resets, ISO 8601, or null when it doesn't say. */
  readonly resetsAt: string | null;
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
  /** An open `needs-design` issue whose last comment is the App's failure notice for a Design-session turn, waiting since that notice for the Operator's reply (#473). */
  | (ItemBase & { readonly kind: "design-turn-failed" })
  /** An open `needs-design` issue whose last comment is the App's refusal of a Map the Map cap holds, waiting since that refusal for the Operator's reply (#473). */
  | (ItemBase & { readonly kind: "design-map-cap" })
  /** An open `ready-for-human` issue, waiting since it got the label. */
  | (ItemBase & { readonly kind: "ready-for-human" })
  /** The Fabrik App's open `needs-info` issue, which Triage's question asks the Operator about, unanswered since it got the label (#425). */
  | (ItemBase & { readonly kind: "monitor-needs-info" })
  /** The Operator's own open `needs-info` issue, which Triage's question asks them about, unanswered since it got the label (#473). */
  | (ItemBase & { readonly kind: "needs-info" })
  /** The Fabrik App's open Audit, filled or still pending, waiting since it was opened. */
  | (ItemBase & { readonly kind: "audit" })
  /** The Fabrik App's open Retro, filled or still pending, waiting since it was opened. */
  | (ItemBase & { readonly kind: "retro" })
  /** The Operator's open replay issue whose results are in, waiting since the Kit wrote them for the Operator to act on and close it. */
  | (ItemBase & { readonly kind: "replay" })
  /** An open Map, whoever charted it, waiting since it got `wayfinder:map`. */
  | (ItemBase & {
      readonly kind: "map";
      /** How many of its Decisions wait on the Operator: its open grilling, prototype and task Decisions. */
      readonly decisionsWaiting: number;
    })
  /** A research Decision on an open Map whose last run failed, waiting since the Kit's failure notice for the Operator to re-add agent:research. */
  | (ItemBase & { readonly kind: "research-failed" })
  /**
   * An agent PR out of draft with a passing Verdict at its head and no
   * Operator review since, waiting since that Verdict.
   */
  | (ItemBase & {
      readonly kind: "merge-gate";
      /** The Operator wait so far: from the passing Verdict to the filing, in milliseconds. */
      readonly operatorWait: number;
    })
  /**
   * An agent PR out of draft the Kit handed back with `ready-for-human` after
   * its passing Verdict, as after an empty Request-changes run or a failed
   * conflict-only run, waiting since it got the label.
   */
  | (ItemBase & { readonly kind: "handed-back" });

/** Loop work that hasn't moved in more than 24 hours, since `since`. */
export type StuckItem =
  /** A `needs-info` issue a person answered after the question, with no state change since the answer. */
  | (ItemBase & { readonly kind: "needs-info-answered" })
  /** A draft agent PR with no commit, comment or label event since `since`. */
  | (ItemBase & { readonly kind: "idle-draft" })
  /** An agent PR out of draft the Operator reviewed at `since`, after its passing Verdict, that the Kit hasn't acted on. */
  | (ItemBase & { readonly kind: "reviewed" })
  /** An open Ticket whose latest record, ended at `since`, was an Infrastructure failure or timeout. */
  | (ItemBase & { readonly kind: "infrastructure-failure"; readonly failure: InfrastructureFailure })
  /**
   * An open Ticket whose latest record, ended at `since`, was a Broken run
   * that used no retry (#434): a Request-changes or conflict-only run's, which
   * waits for the Operator. One the Kit counted and re-runs itself isn't listed.
   */
  | (ItemBase & { readonly kind: "broken-run"; readonly brokenRun: BrokenRun })
  /**
   * The Fabrik App's Audits or Retros whose runs failed in one week, enough
   * of them that the next waits for next week (src/loop/weeklyGate.ts), the
   * last opened in the summary's week, and is this item, at `since`.
   */
  | (ItemBase & { readonly kind: "weekly-runs-failed"; readonly issueName: "Audit" | "Retro"; readonly failed: readonly ItemBase[] });

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

/** One Subscription's share of the week: what its runs cost and how close it came to its weekly limit. */
export interface SubscriptionUsage {
  /** The `Fabrik` vault item name the runs used. */
  readonly subscription: string;
  readonly cost: number;
  readonly weeklyLimit: WeekOverWeek<RateLimitReading | null>;
}

/** The summary to file for the week that just ended, or skip. */
export function weeklySummary(everything: WeeklySummaryInput): WeeklySummaryResult {
  // A Replay is an experiment: every figure leaves it out, and its spend gets a line of its own.
  const { records, scoreFiles } = everything;
  const input: WeeklySummaryInput = { ...everything, records: records.filter(isLive), scoreFiles: scoreFiles.filter(isLive) };
  const replays = records.filter((record) => !isLive(record));
  const weeks = weeksEndingAt(Date.parse(input.now), input.timeZone);
  const thisWeek = metricsOf(weeks.thisWeek, input);
  const lastWeek = metricsOf(weeks.lastWeek, input);
  const replaySpend = { thisWeek: replaySpendOf(weeks.thisWeek, replays), lastWeek: replaySpendOf(weeks.lastWeek, replays) };
  const healthOf = (repo: string): LoopHealth | null => {
    const read = input.health.find((health) => health.repo === repo);
    return read === undefined ? null : loopHealthOf(read, weeks.thisWeek, input.now);
  };
  const repos: RepoSection[] = [
    ...input.facts.map((facts) => ({ ...repoSectionOf(facts, input), health: healthOf(facts.repo) })),
    ...input.unread.map(({ repo, why }) => ({ repo, waitingOnYou: [], stuck: [], held: null, unread: why, health: healthOf(repo) })),
  ];
  // Held work counts too, so a queue never sits unseen through a week nothing ran,
  // and so does a repo that couldn't be read, so its failure is never taken for a quiet week,
  // and a Loop that's down or failing, so a dead Loop never reads as a quiet week (#460).
  const quiet = repos.every(
    (repo) =>
      repo.waitingOnYou.length === 0 &&
      repo.stuck.length === 0 &&
      repo.held === null &&
      repo.unread === null &&
      (repo.health === null || !loopNeedsLook(repo.health)),
  );
  // And a week only Replays ran in is no quiet week either, so what they cost still shows,
  // and nor is a store with Run records the Kit couldn't read, so a store on an older release is never taken for a quiet one (#474).
  const unreadable = input.unreadableRecords.count > 0;
  if (thisWeek.records === 0 && thisWeek.scores.scoreFiles === 0 && replaySpend.thisWeek === null && quiet && !unreadable) return { kind: "skip" };
  const change = <K extends keyof WeekMetrics>(metric: K): WeekOverWeek<WeekMetrics[K]> => ({
    thisWeek: thisWeek[metric],
    lastWeek: lastWeek[metric],
  });
  const summary: WeeklySummary = {
    week: weeks.thisWeek.monday,
    cost: change("cost"),
    unknownCost: change("unknownCost"),
    replaySpend,
    costPerMergedPullRequest: change("costPerMergedPullRequest"),
    costPerSpec: change("costPerSpec"),
    spendNeverMerged: change("spendNeverMerged"),
    weeklyLimit: change("weeklyLimit"),
    subscriptions: thisWeek.subscriptions.map(({ subscription, cost, weeklyLimit }) => ({
      subscription,
      cost,
      weeklyLimit: { thisWeek: weeklyLimit, lastWeek: lastWeek.subscriptions.find((other) => other.subscription === subscription)?.weeklyLimit ?? null },
    })),
    humanTouches: change("humanTouches"),
    cycleTimeMs: change("cycleTimeMs"),
    operatorWaitMs: change("operatorWaitMs"),
    revertRate: change("revertRate"),
    escapeRate: change("escapeRate"),
    escapesByStrength: change("escapesByStrength"),
    escapesThisWeek: escapesThisWeekOf(weeks.thisWeek, input),
    requestChanges: change("requestChanges"),
    reviewMissesThisWeek: thisWeek.reviewMisses,
    counts: {
      mergedPullRequests: change("mergedPullRequests"),
      ticketsDispatched: change("ticketsDispatched"),
      retries: change("retries"),
      brokenRuns: change("brokenRuns"),
      flakyChecks: change("flakyChecks"),
      stepUps: change("stepUps"),
      stepUpsByReason: change("stepUpsByReason"),
      steppedUpStarts: change("steppedUpStarts"),
    },
    scores: change("scores"),
    scoringCost: change("scoringCost"),
    repos,
  };
  return { kind: "summary", summary, title: `Weekly summary: week of ${summary.week}`, body: bodyOf(summary, input) };
}

/**
 * The Flaky checks the Fabrik App's lines named on agent PRs in the week
 * (#462), open and closed, each PR read once: one per check a line names.
 */
function flakyChecksIn(week: Week, facts: readonly MetricFacts[]): number {
  return facts.reduce((total, repo) => {
    const closed = repo.pullRequests.map(({ number }) => number);
    const pullRequests = [...repo.pullRequests, ...repo.openPullRequests.filter(({ number }) => !closed.includes(number))];
    const lines = pullRequests.flatMap(({ comments }) => comments.filter((comment) => comment.byBot && within(week, comment.at)));
    return total + flakyCheckMarksIn(lines.map(({ body }) => body)).reduce((sum, mark) => sum + mark.checks.length, 0);
  }, 0);
}

/** The summed cost of the Replay records that ended in the week, or null if none did. */
function replaySpendOf(week: Week, replays: readonly RunRecord[]): ReplaySpend | null {
  const ended = replays.filter((record) => within(week, record.endedAt));
  return ended.length === 0 ? null : costOf(ended);
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
  readonly subscriptions: readonly { readonly subscription: string; readonly cost: number; readonly weeklyLimit: RateLimitReading | null }[];
  readonly humanTouches: number | null;
  readonly cycleTimeMs: number | null;
  readonly operatorWaitMs: number | null;
  readonly revertRate: RevertRate;
  readonly escapeRate: EscapeRate;
  readonly escapesByStrength: EscapesByStrength;
  readonly requestChanges: RequestChangesCounts;
  /** The week's Request changes with a Review miss: the list only this week's summary shows. */
  readonly reviewMisses: readonly ReviewMissThisWeek[];
  readonly mergedPullRequests: number;
  readonly ticketsDispatched: number;
  readonly retries: number;
  readonly brokenRuns: number;
  readonly flakyChecks: number;
  readonly stepUps: number;
  readonly stepUpsByReason: StepUpCounts;
  readonly steppedUpStarts: SteppedUpStarts;
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
  const requestChanges = requestChangesIn(week, input);
  return {
    records: records.length,
    cost,
    unknownCost,
    costPerMergedPullRequest: costPerMergedPullRequestOf(week, input.records, merged),
    costPerSpec: costPerSpecOf(week, input),
    spendNeverMerged: spendNeverMergedOf(week, input),
    weeklyLimit: lastWeeklyLimitOf(records),
    subscriptions: subscriptionsOf(records),
    humanTouches: mean(merged.map((pullRequest) => pullRequest.humanTouches)),
    cycleTimeMs: median(merged.flatMap(({ dispatch, mergedAt }) => (dispatch === null ? [] : [Date.parse(mergedAt) - Date.parse(dispatch)]))),
    operatorWaitMs: median(merged.flatMap((pullRequest) => operatorWaitOf(pullRequest, input.operator))),
    revertRate: revertRateOf(week, input),
    escapeRate: escapeRateOf(escapeWindow, escapes, input),
    escapesByStrength: escapesByStrengthOf(escapes),
    requestChanges: requestChangesCountsOf(requestChanges),
    reviewMisses: reviewMissesOf(requestChanges),
    mergedPullRequests: merged.length,
    ticketsDispatched: tickets.filter((ticket) => {
      const dispatch = dispatchOf(ticket);
      return dispatch !== null && within(week, dispatch);
    }).length,
    retries: records.filter((record) => record.role === "implement" && record.retry > 0 && record.infrastructureFailure === null).length,
    brokenRuns: records.filter((record) => record.brokenRun !== null).length,
    flakyChecks: flakyChecksIn(week, input.facts),
    stepUps: records.filter((record) => record.stepUp).length,
    stepUpsByReason: stepUpsByReasonOf(records),
    steppedUpStarts: steppedUpStartsOf(merged, input.records),
    scores: scoresOf(week, input),
    scoringCost: { usd: scoring.usd, share: cost === 0 ? null : scoring.usd / cost, unknownCost: scoring.unknownCost },
  };
}

/**
 * A merged agent PR's Operator wait, in ms: from its last passing Verdict to
 * the Operator's first review after it, or to the merge if they gave none.
 * None without a passing Verdict.
 */
function operatorWaitOf({ pullRequest, mergedAt, lastPass }: MergedAgentPullRequest, operator: string): number[] {
  if (lastPass === null) return [];
  const reviewed = operatorReviewsAfter(pullRequest.reviews, operator, lastPass).at(0) ?? mergedAt;
  return [Math.min(Date.parse(mergedAt), Date.parse(reviewed)) - Date.parse(lastPass)];
}

/** When the Operator reviewed a PR after `since`, oldest first. */
function operatorReviewsAfter(reviews: readonly ReviewFacts[], operator: string, since: string): string[] {
  return reviews
    .filter((review) => review.author === operator && Date.parse(review.at) > Date.parse(since))
    .map(({ at }) => at)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
}

/** What the summary calls each Step-up reason. */
const STEP_UP_REASON_NAMES: Readonly<Record<StepUpReason, string>> = {
  retry: "for a Retry",
  marked: "marked",
  "request-changes": "Request changes",
  "conflict-only": "conflict-only",
};

function stepUpsByReasonOf(records: readonly RunRecord[]): StepUpCounts {
  const count = (reason: StepUpReason) => records.filter((record) => record.stepUp && record.stepUpReason === reason).length;
  return Object.fromEntries(STEP_UP_REASONS.map((reason) => [reason, count(reason)])) as Record<StepUpReason, number>;
}

/**
 * Of the week's merged agent PRs, those whose Ticket's first Implement run,
 * whatever week it ran in, was a Stepped-up start, and how many of those
 * Tickets had no Retry.
 */
function steppedUpStartsOf(merged: readonly MergedAgentPullRequest[], records: readonly RunRecord[]): SteppedUpStarts {
  // Each marked Ticket's Implement runs.
  const markedChains = merged.flatMap(({ repo, pullRequest }) => {
    const runs = records.filter((record) => record.repo === repo && record.role === "implement" && record.issue === pullRequest.ticket);
    return pullRequest.ticket === null || firstRunOf(runs)?.stepUpReason !== "marked" ? [] : [runs];
  });
  return { merged: markedChains.length, noRetry: markedChains.filter((runs) => runs.every((record) => record.retry === 0)).length };
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

/** A week's Request changes, by their answers, counted by when each review was submitted. */
function requestChangesCountsOf(reviews: readonly RequestChangesReview[]): RequestChangesCounts {
  const answers = reviews.map(({ answer }) => answer);
  return {
    reviewMiss: answers.filter((answer) => answer?.reviewMiss === true).length,
    amendsTicket: answers.filter((answer) => answer?.amendsTicket === true).length,
    unanswered: answers.filter((answer) => answer === null).length,
  };
}

/** Those of a week's Request changes whose run answered that it holds a Review miss. */
function reviewMissesOf(reviews: readonly RequestChangesReview[]): ReviewMissThisWeek[] {
  return reviews.flatMap(({ repo, pullRequest, review, answer, passingReview }) =>
    answer?.reviewMiss !== true
      ? []
      : [
          {
            repo,
            number: pullRequest,
            url: `https://github.com/${repo}/pull/${pullRequest}`,
            reviewUrl: review.url,
            answerUrl: answer.comment.url,
            passingReviewUrl: passingReview === null ? null : runUrlOf(passingReview),
          },
        ],
  );
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

/** The latest weekly-limit reading among these records, sorted by when they ended, or null if none read one. */
function lastWeeklyLimitOf(records: readonly RunRecord[]): RateLimitReading | null {
  return records.findLast((record) => record.rateLimit?.rateLimitType === WEEKLY_LIMIT)?.rateLimit ?? null;
}

/** Each Subscription these records ran on, in name order, with their cost and latest weekly-limit reading. */
function subscriptionsOf(records: readonly RunRecord[]): WeekMetrics["subscriptions"] {
  const names = [...new Set(records.map((record) => record.subscription))].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((subscription) => {
    const its = records.filter((record) => record.subscription === subscription);
    return { subscription, cost: costOf(its).usd, weeklyLimit: lastWeeklyLimitOf(its) };
  });
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

function repoSectionOf(facts: GitHubFacts, { records, operator, appLogin, now: filedAt, timeZone }: WeeklySummaryInput): Omit<RepoSection, "health"> {
  const now = Date.parse(filedAt);
  const items = itemsIn(facts.repo, now);
  const { thisWeek } = weeksEndingAt(now, timeZone);
  return {
    repo: facts.repo,
    // An open Audit, Retro, finished Replay or Map waits on the Operator, so it also keeps a quiet week from being skipped.
    waitingOnYou: oldestFirst([
      ...waitingOnYou(facts, operator, appLogin, items),
      ...openAuditsOf(facts, appLogin, items),
      ...openRetrosOf(facts, appLogin, items),
      ...finishedReplaysOf(facts, operator, items),
      ...openMapsOf(facts, items),
      ...failedResearchOf(facts, appLogin, items),
    ]),
    // A week given up on is Stuck however recently its last run failed: nothing moves it until the next week.
    stuck: oldestFirst([
      ...stuck(facts, records, operator, items, now),
      ...weekGivenUp("Audit", facts.audits, (body) => auditMarksIn(body).failed, appLogin, thisWeek, items),
      ...weekGivenUp("Retro", facts.retros, (body) => retroMarksIn(body).failed, appLogin, thisWeek, items),
    ]),
    held: heldIn(facts, appLogin, now),
    unread: null,
  };
}

/**
 * The Fabrik App's Audits or Retros, by `issueName`, whose runs failed in one
 * week, UTC Monday to Monday as the gate counts it, enough of them that the
 * next waits for next week, when the last was opened in the summary's `week`.
 */
function weekGivenUp(
  issueName: "Audit" | "Retro",
  issues: readonly WeeklyRunIssueFacts[],
  failed: (body: string) => boolean,
  appLogin: string,
  week: Week,
  items: Items,
): StuckItem[] {
  const runs = issues.filter((issue) => issue.author === appLogin).map((issue) => ({ ...issue, failed: failed(issue.body) }));
  const weeks = new Set(runs.filter(({ createdAt }) => within(week, createdAt)).map(({ createdAt }) => weekStart(createdAt)));
  return [...weeks].flatMap((start) => {
    const inWeek = failedInWeek(runs, start);
    const last = inWeek[FAILED_RUNS_A_WEEK - 1];
    if (last === undefined || !within(week, last.createdAt)) return [];
    const givenUp = inWeek.slice(0, FAILED_RUNS_A_WEEK);
    return [{ kind: "weekly-runs-failed", issueName, ...items.issue(last, last.createdAt), failed: givenUp.map((run) => items.issue(run, run.createdAt)) }];
  });
}

/** The Fabrik App's open Audits, aged from when each was opened: a person's `fabrik:audit` issue is no Audit. */
function openAuditsOf({ openAudits }: GitHubFacts, appLogin: string, items: Items): WaitingItem[] {
  return openAudits.filter((audit) => audit.author === appLogin).map((audit) => ({ kind: "audit", ...items.issue(audit, audit.createdAt) }));
}

/** The Fabrik App's open Retros, filled or still pending, aged from when each was opened: a person's `fabrik:retro` issue is no Retro. */
function openRetrosOf({ openRetros }: GitHubFacts, appLogin: string, items: Items): WaitingItem[] {
  return openRetros.filter((retro) => retro.author === appLogin).map((retro) => ({ kind: "retro", ...items.issue(retro, retro.createdAt) }));
}

/**
 * The Operator's open replay issues whose results are in, by the Replay
 * module's own reading of their markers, aged from when the Kit last wrote
 * the body, which is when it wrote the results: a replay issue someone else
 * filed never runs.
 */
function finishedReplaysOf({ openReplays }: GitHubFacts, operator: string, items: Items): WaitingItem[] {
  return openReplays
    .filter((replay) => isOperatorsReplay(replay, operator) && replayResultsIn(replay.body))
    .map((replay) => ({ kind: "replay", ...items.issue(replay, replay.lastEditedAt ?? replay.createdAt) }));
}

/** The Decision labels whose Decisions the Operator resolves live: all but research, which the Researcher resolves AFK. */
const OPERATOR_DECISION_LABELS: readonly DecisionLabel[] = DECISION_TYPES.filter((type) => type !== "research").map(decisionLabel);

/**
 * Each open Map, read as the Map cap reads them (gatherOpenMaps), aged from
 * when it got `wayfinder:map` (or was opened, for one labelled as it was
 * opened), with how many of its open Decisions wait on the Operator.
 */
function openMapsOf({ openIssues, openMaps }: GitHubFacts, items: Items): WaitingItem[] {
  return openIssues.filter((issue) => openMaps.includes(issue.number)).map((map) => ({
    kind: "map",
    ...items.issue(map, lastAdded(map.labelEvents, MAP_LABEL) ?? map.createdAt),
    decisionsWaiting: openIssues.filter(
      (issue) => map.subIssues.includes(issue.number) && OPERATOR_DECISION_LABELS.some((label) => issue.labels.includes(label)),
    ).length,
  }));
}

/**
 * Each research Decision on an open Map whose last run failed, aged from the
 * Kit's failure notice: by the Kit's own rules for which Decisions the
 * Researcher may run on (whyNotResearchable) and whose last run failed
 * (researchRunFailedIn), so the summary lists just the Decisions Dispatch
 * won't run again until the Operator re-adds agent:research. As Dispatch
 * does, it reads only the comments of the Fabrik App, whose bot login is
 * `appLogin`.
 */
function failedResearchOf({ openIssues }: GitHubFacts, appLogin: string, items: Items): WaitingItem[] {
  return openIssues.flatMap((decision): WaitingItem[] => {
    // A closed parent isn't among the open issues, so it reads as none: no open Map either way.
    const parent = openIssues.find((issue) => issue.subIssues.includes(decision.number));
    const parentIssue = parent === undefined ? null : { number: parent.number, open: true, labels: parent.labels };
    const comments = decision.comments.map((comment) => ({ ...comment, byApp: comment.author === appLogin }));
    if (whyNotResearchable({ ...decision, open: true, parentIssue }) !== null || !researchRunFailedIn(comments)) return [];
    const notice = comments.findLast((comment) => comment.byApp);
    const readded = lastAdded(decision.labelEvents, RESEARCH_LABEL);
    // Re-added since, it waits on its run again, not on the Operator.
    if (notice === undefined || (readded !== null && Date.parse(readded) > Date.parse(notice.at))) return [];
    return [{ kind: "research-failed", ...items.issue(decision, notice.at) }];
  });
}

/** What a cap holds in the repo, or null when nothing is held. */
function heldIn({ designQueue, monitorIssues, openMaps, kitIssues }: GitHubFacts, appLogin: string, now: number): Held | null {
  const designSessions = heldDesignSessionsOf(designQueue, now);
  const monitor = heldMonitorOf(monitorIssues, appLogin);
  const mapCap = heldMapsOf(openMaps);
  const runs = heldRunsOf(kitIssues);
  return designSessions === null && monitor === null && mapCap === null && runs === null ? null : { designSessions, monitor, maps: mapCap, runs };
}

/**
 * The Held runs, read by the scheduled tick's own rule (waitingHeldRuns), so
 * the summary and the resume can't disagree, with the open weekly-limit issues
 * they wait on. Null while no run is held.
 */
function heldRunsOf(kitIssues: readonly KitIssueSnapshot[]): HeldRuns | null {
  const runs = waitingHeldRuns(kitIssues).map(({ run, markers }) => ({
    role: run.role,
    issue: run.issue,
    heldOn: [...markers].flatMap(([issue, held]) => (held > 0 ? [issue] : [])),
  }));
  if (runs.length === 0) return null;
  const weeklyLimitIssues = kitIssues
    .filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL))
    .map((issue) => ({ number: issue.number, resetsAt: resetsAtOf(issue) }));
  return { runs, weeklyLimitIssues };
}

/**
 * The open Maps, when they fill the Map cap: read and counted as the cap
 * reads and counts them (gatherOpenMaps, mapCapFull), so the summary and the
 * Map landing's check can't disagree. Null while the cap has room, or with no
 * Map open to name. The summary has no Product's Kit config, so it holds the
 * open Maps to the Kit's default cap: a repo's cap only tightens it, so Maps
 * that fill the default fill every repo's cap too.
 */
function heldMapsOf(openMaps: readonly number[]): HeldMaps | null {
  const open = openMaps.toSorted((a, b) => a - b);
  return open.length > 0 && mapCapFull(open, DEFAULT_KIT_CONFIG) ? { open } : null;
}

/**
 * The `needs-design` issues waiting for a Design session slot: by the Design
 * queue check's own rule (waitingIssues), so the summary and the check can't
 * disagree.
 */
function heldDesignSessionsOf(queue: DesignQueueSnapshot, now: number): HeldDesignSessions | null {
  const waiting = waitingIssues(queue);
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

/**
 * When Triage asked about a `needs-info` issue, or null if it isn't one or
 * someone has answered: from then on Triage or Stuck has it. Only one the
 * Operator filed, or the Fabrik App filed as the Monitor, which can't answer
 * itself (#425), asks the Operator: Triage asks anyone else who filed one.
 */
function unansweredQuestionOf(issue: OpenIssueFacts): string | null {
  if (!issue.labels.includes(NEEDS_INFO) || answerOf(issue) !== null) return null;
  return lastAdded(issue.labelEvents, NEEDS_INFO) ?? issue.createdAt;
}

function waitingOnYou({ openIssues, openPullRequests }: GitHubFacts, operator: string, appLogin: string, items: Items): WaitingItem[] {
  const waiting: WaitingItem[] = [];
  for (const issue of openIssues) {
    const round = unansweredRoundOf(issue);
    if (round !== null) waiting.push({ kind: "design-round", ...items.issue(issue, round) });
    const stopped = stoppedDesignSessionOf(issue);
    if (stopped !== null) waiting.push({ kind: stopped.kind, ...items.issue(issue, stopped.at) });
    if (issue.labels.includes(READY_FOR_HUMAN)) {
      const since = lastAdded(issue.labelEvents, READY_FOR_HUMAN) ?? issue.createdAt;
      waiting.push({ kind: "ready-for-human", ...items.issue(issue, since) });
    }
    const asked = issue.author === appLogin || issue.author === operator ? unansweredQuestionOf(issue) : null;
    if (asked !== null) waiting.push({ kind: issue.author === appLogin ? "monitor-needs-info" : "needs-info", ...items.issue(issue, asked) });
  }
  for (const pullRequest of openPullRequests) {
    const standing = passedStandingOf(pullRequest, operator);
    if (standing?.kind === "handed-back") waiting.push({ kind: "handed-back", ...items.pullRequest(pullRequest, standing.since) });
    if (standing?.kind !== "merge-gate") continue;
    const item = items.pullRequest(pullRequest, standing.since);
    waiting.push({ kind: "merge-gate", ...item, operatorWait: item.age });
  }
  return oldestFirst(waiting);
}

/**
 * Loop work that hasn't moved in more than 24 hours. A Held run isn't stuck:
 * the Kit resumes it itself at the reset, and Held names it, so a Ticket or
 * PR a held marker names is left out, its failed run and its draft alike.
 */
function stuck(
  { repo, openIssues, openPullRequests, kitIssues }: GitHubFacts,
  records: readonly RunRecord[],
  operator: string,
  items: Items,
  now: number,
): StuckItem[] {
  const held = new Set(waitingHeldRuns(kitIssues).map(({ run }) => run.issue));
  const isHeld = (...numbers: readonly (number | null)[]) => numbers.some((number) => number !== null && held.has(number));
  const found: StuckItem[] = [];
  for (const issue of openIssues) {
    const answered = issue.labels.includes(NEEDS_INFO) ? answerOf(issue) : null;
    if (answered !== null) found.push({ kind: "needs-info-answered", ...items.issue(issue, answered) });
    const failed = failedLastRunOf(issue, repo, records);
    if (failed?.kind === "infrastructure-failure" && !isHeld(issue.number, failed.pullRequest)) {
      found.push({ kind: "infrastructure-failure", ...items.issue(issue, failed.endedAt), failure: failed.failure });
    }
    if (failed?.kind === "broken-run") found.push({ kind: "broken-run", ...items.issue(issue, failed.endedAt), brokenRun: failed.brokenRun });
  }
  for (const pullRequest of openPullRequests) {
    if (isHeld(pullRequest.number, pullRequest.ticket)) continue;
    if (pullRequest.draft) found.push({ kind: "idle-draft", ...items.pullRequest(pullRequest, lastActivityOf(pullRequest)) });
    const standing = passedStandingOf(pullRequest, operator);
    if (standing?.kind === "reviewed") found.push({ kind: "reviewed", ...items.pullRequest(pullRequest, standing.since) });
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
 * An open Ticket's latest record, if it ended in an Infrastructure failure,
 * or a Broken run that used no retry (#434): the run nothing has picked up
 * again. A Broken run on a first run or a Retry is an Execution flaw the Kit
 * re-runs itself, so it isn't one. A judge run's record (role `score`) is left
 * out: scoring a run never picks its Ticket up, and a judge's own failure
 * never leaves the Ticket stuck. With the run's PR, where a Review is held.
 */
function failedLastRunOf(
  issue: OpenIssueFacts,
  repo: string,
  records: readonly RunRecord[],
):
  | { readonly kind: "infrastructure-failure"; readonly endedAt: string; readonly failure: InfrastructureFailure; readonly pullRequest: number | null }
  | { readonly kind: "broken-run"; readonly endedAt: string; readonly brokenRun: BrokenRun }
  | null {
  const latest = records
    .filter((record) => record.repo === repo && record.issue === issue.number && record.role !== "score")
    .toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .at(-1);
  if (latest === undefined || (latest.role !== "implement" && latest.role !== "review")) return null;
  if (latest.brokenRun !== null) return usedNoRetry(latest) ? { kind: "broken-run", endedAt: latest.endedAt, brokenRun: latest.brokenRun } : null;
  if (latest.infrastructureFailure === null) return null;
  return { kind: "infrastructure-failure", endedAt: latest.endedAt, failure: latest.infrastructureFailure, pullRequest: latest.pullRequest };
}

/** Whether an Implement run's record is a Request-changes or conflict-only run's, which uses no retry (#393, #304). */
function usedNoRetry(record: RunRecord): boolean {
  return record.requestChanges || record.stepUpReason === "conflict-only";
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

/**
 * A Design session whose last comment is the App's failure notice for its
 * turn, or its refusal of a Map the Map cap holds, with when it was posted, or
 * null if its last comment is anything else. Either keeps the session's slot
 * (holdsSlot) with the Operator's reply as the next move.
 */
function stoppedDesignSessionOf(issue: OpenIssueFacts): { readonly kind: "design-turn-failed" | "design-map-cap"; readonly at: string } | null {
  const last = issue.comments.at(-1);
  if (!issue.labels.includes(NEEDS_DESIGN) || last === undefined || !last.byBot || !last.body.startsWith(DESIGN_TURN_FAILED_MARKER)) return null;
  return { kind: refusedByMapCap(last.body) ? "design-map-cap" : "design-turn-failed", at: last.at };
}

/**
 * Where an agent PR out of draft with a passing Verdict at its head stands,
 * and since when. After the pass, the Kit's `ready-for-human`, still on it,
 * hands it to the Operator (`handed-back`); else the Operator's latest review
 * since leaves the next move to the Kit (`reviewed`); else it's at the Merge
 * gate, waiting on the Operator since the pass (`merge-gate`).
 */
interface PassedPullRequestStanding {
  readonly kind: "merge-gate" | "handed-back" | "reviewed";
  readonly since: string;
}

/** Where an agent PR with a passing Verdict at its head stands, or null for a draft or one without. */
function passedStandingOf(pullRequest: OpenPullRequestFacts, operator: string): PassedPullRequestStanding | null {
  const passed = passAtHeadOf(pullRequest);
  if (pullRequest.draft || passed === null) return null;
  const reviewed = operatorReviewsAfter(pullRequest.reviews, operator, passed).at(-1);
  const handedBack = addedAndStillOn(pullRequest.labelEvents, READY_FOR_HUMAN);
  if (handedBack !== null && Date.parse(handedBack) > Date.parse(reviewed ?? passed)) return { kind: "handed-back", since: handedBack };
  if (reviewed !== undefined) return { kind: "reviewed", since: reviewed };
  return { kind: "merge-gate", since: passed };
}

/** When `label` was last added, if it's still on: the latest event for it added it. Otherwise null. */
function addedAndStillOn(events: readonly LabelEvent[], label: string): string | null {
  const latest = events.filter((event) => event.label === label).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  return latest?.action === "labeled" ? latest.at : null;
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

/** The instant a calendar date (as midnight UTC) begins in the time zone. */
function midnight(date: number, timeZone: string): number {
  const offsetAt = (time: number) => wallClock(time, timeZone).asUtc - time;
  const guess = date - offsetAt(date);
  return date - offsetAt(guess);
}

// Rendering. Only shipped features get a section: the Monitor issues add
// theirs when their Spec ships. The open Retro gets no section, only its line
// in Waiting on you, and so do an open Map and a failed research Decision.
// Scores shows only in a week with score files, and never a run's own scores.
// Held shows what the Design-session, Monitor and Map caps hold, and the Held
// runs waiting on a weekly-limit issue.

function bodyOf(summary: WeeklySummary, { operator, timeZone, unreadableRecords }: WeeklySummaryInput): string {
  const { cost, unknownCost, replaySpend, costPerMergedPullRequest, costPerSpec, spendNeverMerged, weeklyLimit, humanTouches, cycleTimeMs, operatorWaitMs, revertRate, escapeRate, counts } = summary;
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
  // Replay spend sits under the cost it's left out of, in a week with any.
  const replaySpendRows =
    replaySpend.thisWeek === null ? [] : [row("Replay spend", { thisWeek: replaySpend.thisWeek.usd, lastWeek: replaySpend.lastWeek?.usd ?? null }, dollars)];
  const costFigures: [string, WeekOverWeek<CostFigure>][] = [
    ["cost per merged PR", costPerMergedPullRequest],
    ["cost per Spec", costPerSpec],
    ["spend that never merged", spendNeverMerged],
  ];
  const lines = [
    // First, since every figure below leaves these records out.
    ...unreadableLines(unreadableRecords),
    "## Metrics",
    "",
    "| | This week | Last week | Change |",
    "| --- | ---: | ---: | ---: |",
    row("API-equivalent cost", cost, dollars),
    ...replaySpendRows,
    costRow("Cost per merged PR", costPerMergedPullRequest),
    costRow("Cost per Spec", costPerSpec),
    costRow("Spend that never merged", spendNeverMerged),
    row("Merged agent PRs", counts.mergedPullRequests, count),
    row("Tickets dispatched", counts.ticketsDispatched, count),
    row("Retries", counts.retries, count),
    row("Broken runs", counts.brokenRuns, count),
    row("Flaky checks", counts.flakyChecks, count),
    row("Step-ups", counts.stepUps, count),
    ...stepUpReasonRows(counts.stepUpsByReason),
    steppedUpStartsRow(counts.steppedUpStarts),
    row("Human touches per merged PR", humanTouches, (value) => value.toFixed(1)),
    ...requestChangesRows(summary.requestChanges),
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
  const replaysLeftOut = replaySpend.thisWeek?.unknownCost ?? 0;
  if (replaysLeftOut > 0) lines.push(`${runsWithUnknownCost(replaysLeftOut)} left out of replay spend.`, "");
  for (const [name, figure] of costFigures) {
    const leftOut = figure.thisWeek.unknownCost;
    if (leftOut > 0) lines.push(`${runsWithUnknownCost(leftOut)} left out of ${name}.`, "");
  }
  lines.push(...subscriptionUsageLines(weeklyLimit, summary.subscriptions, timeZone), "");
  lines.push(...scoresLines(summary.scores, summary.scoringCost));
  lines.push(...heldLines(summary.repos, timeZone));
  for (const repo of summary.repos) {
    lines.push(
      ...repoLines(
        repo,
        timeZone,
        summary.escapesThisWeek.filter((escape) => escape.repo === repo.repo),
        summary.reviewMissesThisWeek.filter((miss) => miss.repo === repo.repo),
      ),
    );
  }
  // The Operator's one mention, last: the week's only scheduled push.
  lines.push(`@${operator}`);
  return `${lines.join("\n")}\n`;
}

/** The line saying how many of the store's Run records the Kit couldn't read, and how to read them when a newer Kit wrote them, or nothing when it read them all. */
function unreadableLines({ count, newestSchema }: UnreadableRunRecords): string[] {
  if (count === 0) return [];
  const [records, them] = count === 1 ? ["1 Run record", "it"] : [`${count} Run records`, "them"];
  const line =
    newestSchema === null
      ? `${records} in the store ${count === 1 ? "isn't" : "aren't"} of a schema the Kit knows, so this summary leaves ${them} out.`
      : `${records} ${count === 1 ? "was" : "were"} written by a newer Kit than this store runs (schema ${newestSchema} > ${RUN_RECORD_SCHEMA}), so this summary leaves ${them} out: bump the Kit's pin in \`${STORE_CALLER_PATH}\` to the release the Product repos run.`;
  return [line, ""];
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
function heldLines(repos: readonly RepoSection[], timeZone: string): string[] {
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
    const maps = held?.maps ?? null;
    if (maps !== null) {
      const open = spelled(maps.open.map((map) => `[#${map}](https://github.com/${repo}/issues/${map})`), "and");
      shown.push(`- ${repo}: the Map cap is full with ${open} open, so Design sessions offer no new Map`);
    }
    const runs = held?.runs ?? null;
    if (runs !== null) shown.push(...heldRunsLines(repo, runs, timeZone));
    return shown;
  });
  return lines.length === 0 ? [] : ["## Held", "", ...lines, ""];
}

/** The Held runs, each with its role and the weekly-limit issues holding it, then each open weekly-limit issue with its reset. */
function heldRunsLines(repo: string, { runs, weeklyLimitIssues }: HeldRuns, timeZone: string): string[] {
  const link = (number: number) => `[#${number}](https://github.com/${repo}/issues/${number})`;
  return [
    `- ${repo}: ${runs.length === 1 ? "1 held run" : `${runs.length} held runs`}, which the Kit resumes itself at the reset:`,
    ...runs.map(({ role, issue, heldOn }) => `  - the ${runNamed(role)} on ${link(issue)}, held on ${spelled(heldOn.map(link), "and")}`),
    ...weeklyLimitIssues.map(({ number, resetsAt }) => {
      const reset = resetsAt === null ? "its reset not known" : `resetting ${readable(resetsAt, timeZone)}`;
      return `- ${repo}: weekly-limit issue ${link(number)} open, ${reset}`;
    }),
  ];
}

/** How many of a repo's Waiting on you items show before the rest collapse into `<details>`. */
const SHOWN_ITEMS = 10;

function repoLines(
  { repo, waitingOnYou, stuck, unread, health }: RepoSection,
  timeZone: string,
  escapes: readonly EscapeThisWeek[],
  reviewMisses: readonly ReviewMissThisWeek[],
): string[] {
  // A dead Tick leads the section, so the waits below are read knowing the Loop was down.
  const healthLines = health === null ? null : loopHealthLines(health, timeZone);
  const leading = healthLines?.lead == null ? [] : [healthLines.lead, "", healthLines.line, ""];
  const trailing = healthLines === null || healthLines.lead !== null ? [] : [healthLines.line, ""];
  if (unread !== null) {
    const line = `The Kit couldn't read this repo on GitHub this run, so what waits on you, what's stuck and what's held there, and its PRs, Tickets and Specs in the metrics, are left out of this summary: ${escapedTitle(unread)}. Re-run the Weekly summary to try it again.`;
    return [`## ${repo}`, "", ...leading, line, "", ...trailing, liveLinks(repo), ""];
  }
  const lines = [`## ${repo}`, "", ...leading, "### Waiting on you", ""];
  if (waitingOnYou.length === 0) lines.push("Nothing waiting on you.", "");
  else {
    lines.push(...waitingOnYou.slice(0, SHOWN_ITEMS).map(waitingLine), "");
    const rest = waitingOnYou.slice(SHOWN_ITEMS);
    if (rest.length > 0) lines.push(`<details><summary>${rest.length} more</summary>`, "", ...rest.map(waitingLine), "", "</details>", "");
  }
  if (stuck.length > 0) lines.push("### Stuck", "", ...stuck.map(stuckLine), "");
  if (escapes.length > 0) lines.push("### Architectural escapes this week", "", ...escapes.flatMap(escapeLines), "");
  if (reviewMisses.length > 0) lines.push("### Review misses this week", "", ...reviewMisses.map(reviewMissLine), "");
  lines.push(...trailing, liveLinks(repo), "");
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

/** A Review miss: its PR, the Request changes, the comment holding the answer, and the Review run whose pass it followed. */
function reviewMissLine({ number, url, reviewUrl, answerUrl, passingReviewUrl }: ReviewMissThisWeek): string {
  const after = passingReviewUrl === null ? "after no passing Review run on record" : `after the pass of [Review run](${passingReviewUrl})`;
  return `- [#${number}](${url}): [Request changes](${reviewUrl}), [answered here](${answerUrl}), ${after}`;
}

function waitingLine(item: WaitingItem): string {
  switch (item.kind) {
    case "design-round":
      return itemLine(item, `Design round unanswered for ${duration(item.age)}`);
    case "ready-for-human":
      return itemLine(item, `ready-for-human for ${duration(item.age)}`);
    case "monitor-needs-info":
      return itemLine(item, `Monitor issue's question unanswered for ${duration(item.age)}`);
    case "needs-info":
      return itemLine(item, `Triage's question to you unanswered for ${duration(item.age)}`);
    case "design-turn-failed":
      return itemLine(item, `Design-session turn failed ${duration(item.age)} ago; reply to run it again`);
    case "design-map-cap":
      return itemLine(item, `Design session's Map refused by the Map cap ${duration(item.age)} ago; reply to carry on`);
    case "audit":
      return itemLine(item, `Audit open for ${duration(item.age)}`);
    case "retro":
      return itemLine(item, `Retro open for ${duration(item.age)}`);
    case "replay":
      return itemLine(item, `Replay results in for ${duration(item.age)}`);
    case "map":
      return itemLine(item, `Map open for ${duration(item.age)}, ${decisions(item.decisionsWaiting)} waiting on you`);
    case "research-failed":
      return itemLine(item, `research run failed ${duration(item.age)} ago, waiting for you to re-add ${RESEARCH_LABEL}`);
    case "merge-gate":
      return itemLine(item, `at the Merge gate, Operator wait ${duration(item.operatorWait)}`);
    case "handed-back":
      return itemLine(item, `handed to you with \`${READY_FOR_HUMAN}\` ${duration(item.age)} ago`);
  }
}

function stuckLine(item: StuckItem): string {
  switch (item.kind) {
    case "needs-info-answered":
      return itemLine(item, `needs-info answered ${duration(item.age)} ago, not picked up`);
    case "idle-draft":
      return itemLine(item, `a draft with no activity for ${duration(item.age)}`);
    case "reviewed":
      return itemLine(item, `reviewed by you ${duration(item.age)} ago; the Kit hasn't acted`);
    case "infrastructure-failure":
      return itemLine(item, `last run ended in an Infrastructure failure (${item.failure}) ${duration(item.age)} ago`);
    case "broken-run":
      return itemLine(item, `last run was a Broken run (${item.brokenRun}) ${duration(item.age)} ago, which uses no retry; re-add \`agent:implement\` to run it again`);
    case "weekly-runs-failed":
      return `- ${item.issueName} failed ${item.failed.length === 2 ? "twice" : `${item.failed.length} times`} this week (${item.failed.map(({ number, url }) => `[#${number}](${url})`).join(", ")})`;
  }
}

/** `no Decisions`, `1 Decision` or `2 Decisions`. */
function decisions(count: number): string {
  return count === 0 ? "no Decisions" : count === 1 ? "1 Decision" : `${count} Decisions`;
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

/**
 * How close the Subscriptions came to their weekly limits: today's one line
 * for a week on one Subscription (or none), else a line for each, with its cost.
 */
function subscriptionUsageLines(
  weeklyLimit: WeekOverWeek<RateLimitReading | null>,
  subscriptions: readonly SubscriptionUsage[],
  timeZone: string,
): string[] {
  if (subscriptions.length < 2) return [`Subscription usage: ${limitReading(weeklyLimit, timeZone)}`];
  return [
    "Subscription usage:",
    "",
    ...subscriptions.map(
      ({ subscription, cost, weeklyLimit: reading }) => `- ${subscription}: ${dollars(cost)} API-equivalent cost, ${limitReading(reading, timeZone)}`,
    ),
  ];
}

/** A weekly-limit reading this week, when it resets, and last week's beside it. */
function limitReading({ thisWeek, lastWeek }: WeekOverWeek<RateLimitReading | null>, timeZone: string): string {
  const share = (reading: RateLimitReading | null) =>
    reading === null || reading.utilization === null ? null : `${Math.round(reading.utilization * 100)}%`;
  const now = share(thisWeek);
  const before = share(lastWeek);
  const resets =
    thisWeek === null || thisWeek.resetsAt === null ? "" : `, resetting ${readable(thisWeek.resetsAt * 1000, timeZone)}`;
  const usage = now === null ? "no weekly-limit reading this week." : `${now} of the weekly limit${resets}.`;
  return before === null ? usage : `${usage} Last week: ${before}.`;
}

/** A table row: the figure this week and last week, and the change, with a dash where either has nothing to show. */
function row(name: string, { thisWeek, lastWeek }: WeekOverWeek<number | null>, format: (value: number) => string): string {
  const change = thisWeek === null || lastWeek === null ? NONE : signed(thisWeek - lastWeek, format);
  return `| ${name} | ${orNone(thisWeek, format)} | ${orNone(lastWeek, format)} | ${change} |`;
}

/** The week's Request changes with a Review miss, amending the Ticket, and unanswered, each week over week. */
function requestChangesRows({ thisWeek, lastWeek }: WeekOverWeek<RequestChangesCounts>): string[] {
  const rows: [string, keyof RequestChangesCounts][] = [
    ["Request changes with a Review miss", "reviewMiss"],
    ["Request changes amending the Ticket", "amendsTicket"],
    ["Request changes unanswered", "unanswered"],
  ];
  return rows.map(([name, key]) => row(name, { thisWeek: thisWeek[key], lastWeek: lastWeek[key] }, count));
}

/** A row under Step-ups for each reason either week has any of. */
function stepUpReasonRows(byReason: WeekOverWeek<StepUpCounts>): string[] {
  return STEP_UP_REASONS.flatMap((reason) => {
    const counts = { thisWeek: byReason.thisWeek[reason], lastWeek: byReason.lastWeek[reason] };
    return counts.thisWeek === 0 && counts.lastWeek === 0 ? [] : [row(`· ${STEP_UP_REASON_NAMES[reason]}`, counts, count)];
  });
}

/** The merged Stepped-up starts each week, with how many needed no Retry, and the change in how many merged. */
function steppedUpStartsRow({ thisWeek, lastWeek }: WeekOverWeek<SteppedUpStarts>): string {
  const cell = ({ merged, noRetry }: SteppedUpStarts) => `${merged} (${noRetry} with no Retry)`;
  return `| Stepped-up starts merged | ${cell(thisWeek)} | ${cell(lastWeek)} | ${signed(thisWeek.merged - lastWeek.merged, count)} |`;
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
