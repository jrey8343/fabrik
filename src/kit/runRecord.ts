// The Run record (ADR-0009): from what the push job knows when an AFK agent
// run ends, the one schema 5 record of that run, and the paths it and its
// transcript take in the store, or no record when no agent run ended. A judge
// run, scoring a finished run, gets a record too, in role `score`, from what
// the score-record job knows when it ends, and so does a Replay arm's
// Implement or Review run (#156), from what the replay-record job knows, at
// paths that name its arm, as its patch's path does. The stream is read
// through the one stream-json reader (src/agent/stream.ts). The paths are
// inside the store, RUN_STORE (src/kit/runStore.ts). A record read back from
// the store is read at the current schema: a schema 1 record, written before
// runs were given a Subscription, as being on the first listed one, a schema
// 1 or 2 record, written before prototype turns, as no prototype turn, and a
// schema 1, 2 or 3 record, written before Replays, as no replay's, and a
// schema 1 to 4 record, written before Step-ups had reasons, with a null
// reason, or `retry` if it Stepped up. Pure, no I/O.
import { readFailureReport } from "../agent/failure.ts";
import { readAgentRunResult } from "../agent/result.ts";
import { readStream, type StreamMessage } from "../agent/stream.ts";
import { infrastructureFailureOf } from "../loop/failures.ts";
import { firstSubscription } from "../loop/subscriptions.ts";
import { type AgentRole, type InfrastructureFailure, isStepUpReason, type KitConfig, type StepUpReason, type Verdict } from "../loop/types.ts";
import { parseVerdict } from "../loop/verdict.ts";
import { isPrototypeTurn, type NeededJob, type Needs, pushJobInput, RETRO_EVIDENCE_JOB, routedJob } from "./pushJob.ts";

/** What the push job knows when the run ends. */
export interface RunEnd {
  /** The jobs' `needs`, as `toJSON(needs)` gives it, the Kit job's outputs included. */
  readonly needs: Needs;
  /** The Actions event's issue number, the subject of a Triage, Design, Auditor or Retro run. */
  readonly eventIssue: number | null;
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  /** The Actions run id and its attempt. */
  readonly runId: number;
  readonly runAttempt: number;
  /** The Kit commit writing the record. */
  readonly kitSha: string;
  /** When the push job ran, as an ISO 8601 time. */
  readonly endedAt: string;
  /** The role defaults from the Product's Kit config. */
  readonly roles: KitConfig["roles"];
  /** The Subscriptions the Product's Kit config lists, the first of which a run the Kit job gave none is on. */
  readonly subscriptions: KitConfig["subscriptions"];
  /** The agent result artifact's text, or null if there was none. */
  readonly agentResult: string | null;
  /** The failure report artifact's text, or null if there was none. */
  readonly failureReport: string | null;
  /** The transcript's stream-json lines, or null if no transcript survived the run. */
  readonly transcript: readonly string[] | null;
}

/** One model's share of the run, as its result's `modelUsage` reports it. */
export interface ModelCost {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly cacheReadTokens: number | null;
  /** null when its `costBasis` is `unknown`: no figure rather than a guess. */
  readonly costUsd: number | null;
  readonly costBasis: string | null;
}

/** The `rateLimitType` of the Subscription's weekly limit; the stream reports its five-hour one too. */
export const WEEKLY_LIMIT = "seven_day";

/** The last weekly-limit reading the stream reported, raw. */
export interface RateLimitReading {
  readonly status: string | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly resetsAt: number | null;
}

/** A record's role: the agent role that ran, or `score` for a judge run scoring a finished run. */
export type RunRecordRole = AgentRole | "score";

/** The schema a Run record is written at: 2 added `subscription`, 3 added `prototype`, 4 added `replay`, 5 added `stepUpReason`. */
export const RUN_RECORD_SCHEMA = 5;

/** A Replay's two arms (#156): the baseline, run as the Ticket was built, and the variant, with the one variable changed. */
export type ReplayArm = "baseline" | "variant";

/** A Replay's two arms, in the order a Replay runs, writes and shows them. */
export const REPLAY_ARMS: readonly ReplayArm[] = ["baseline", "variant"];

export function isReplayArm(value: unknown): value is ReplayArm {
  return (REPLAY_ARMS as readonly unknown[]).includes(value);
}

/**
 * The roles a Replay arm runs, one Implement run and then one Review of its
 * diff: the only roles whose model or effort a Replay can change.
 */
export type ReplayRole = Extract<AgentRole, "implement" | "review">;

/** A Replay arm's roles, in the order it runs them. */
export const REPLAY_ROLES: readonly ReplayRole[] = ["implement", "review"];

/** Which Replay a run was an arm of, and of which Ticket. */
export interface ReplayRun {
  /** The replay issue, the `fabrik:replay` issue the Operator filed. */
  readonly issue: number;
  readonly arm: ReplayArm;
  /** The replayed Ticket, the run's subject. */
  readonly ticket: number;
  /**
   * For a `kit` variant only, the candidate Kit sha whose prompts and Base
   * skills the arm loaded over the pinned release, which the record's own
   * `kitSha` still names. null for a baseline and a model or effort variant.
   */
  readonly candidateSha: string | null;
}

/**
 * Whether a Run record or score file is a live run's, not a Replay arm's.
 * Every metric the Weekly summary and the Retro read leaves Replays out, so
 * an experiment never counts as the factory's own work.
 */
export function isLive({ replay }: { readonly replay: ReplayRun | null }): boolean {
  return replay === null;
}

/**
 * A Ticket's first Implement run, the one that cut the branch it merged: the
 * last of its runs that wasn't a Retry, Request-changes or conflict-only run,
 * since a first run that failed for its Subscription is run again as a first
 * run. It is taken by its place in the chain, so a marked Ticket's first run,
 * a Stepped-up start, counts (ADR-0014). Any other Step-up isn't one: a record
 * from before Step-ups had reasons reads as a Retry's.
 */
export function firstRunOf(implementRuns: readonly RunRecord[]): RunRecord | undefined {
  const first = implementRuns.filter(
    (record) => record.retry === 0 && !record.requestChanges && (record.stepUpReason === null || record.stepUpReason === "marked"),
  );
  return first.toSorted((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt)).at(-1);
}

/** One AFK agent run, schema 5. */
export interface RunRecord {
  readonly schema: typeof RUN_RECORD_SCHEMA;
  readonly kitSha: string;
  readonly repo: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly role: RunRecordRole;
  /**
   * The run's subject: the Ticket for Implement and Review, the event's issue
   * for Triage and Design, the pending Audit for the Auditor, the pending Retro
   * for the Retro, the scored run's for a judge run.
   */
  readonly issue: number;
  readonly pullRequest: number | null;
  readonly endedAt: string;
  readonly model: string;
  readonly effort: string | null;
  /**
   * The Subscription the run used: the `Fabrik` vault item name its Claude
   * token came from, never the secret. A judge run's is the scored run's.
   */
  readonly subscription: string;
  /** 0 for a first Implement run (and every other role), else its Retry number. */
  readonly retry: number;
  /** Whether the run used the Step-up model. */
  readonly stepUp: boolean;
  /**
   * Why it Stepped up, exactly when it did (ADR-0014). A schema 1 to 4
   * record, written before Step-ups had reasons, reads as `retry` if it
   * Stepped up, else null.
   */
  readonly stepUpReason: StepUpReason | null;
  readonly requestChanges: boolean;
  /** Whether the run was a Design session's prototype turn (#155), whose role stays `design`. */
  readonly prototype: boolean;
  /** null for a live run, else the Replay arm the run was. */
  readonly replay: ReplayRun | null;
  /**
   * The commit the run started from: an Implement branch's base, a Review's PR
   * head, the event's commit for Triage and Design, the Audit's marked commit
   * for the Auditor, the default branch commit it checked out for the Retro.
   */
  readonly baseSha: string | null;
  readonly jobResult: string;
  readonly subtype: string | null;
  readonly isError: boolean | null;
  readonly terminalReason: string | null;
  /** null, or the Infrastructure failure, classified as the failure notice classifies it. */
  readonly infrastructureFailure: InfrastructureFailure | null;
  /** A Review's Verdict, or null when it gave none (and for every other role). */
  readonly verdict: Verdict | null;
  readonly durationMs: number | null;
  readonly apiDurationMs: number | null;
  readonly turns: number | null;
  readonly permissionDenials: number | null;
  readonly apiRetries: number | null;
  readonly totalCostUsd: number | null;
  readonly modelUsage: Readonly<Record<string, ModelCost>>;
  readonly rateLimit: RateLimitReading | null;
  /** The transcript's store path, or null if no transcript survived the run. */
  readonly transcript: string | null;
}

/** A record and where it and its transcript go in the store. */
export interface RunRecordFiles {
  readonly record: RunRecord;
  readonly recordPath: string;
  /** null when no transcript survived the run. */
  readonly transcriptPath: string | null;
}

/** The agent run that ended: its role and subject, and the job whose end it was. */
interface EndedRun {
  readonly role: AgentRole;
  readonly issue: number;
  readonly pullRequest: number | null;
  readonly job: NeededJob | undefined;
  /** For a failed or cancelled run, its Infrastructure failure. */
  readonly failure: InfrastructureFailure | null;
}

/** Whether an agent run ended, so there's a record to write: known from the jobs alone, before anything else is read. */
export function agentRunEnded(needs: Needs, eventIssue: number | null): boolean {
  return endedRun({ needs, eventIssue, failureReport: null }) !== null;
}

/** Which agent run ended, or null when none did: red checks, routing to push, or nothing to do. */
function endedRun(end: Pick<RunEnd, "needs" | "eventIssue" | "failureReport">): EndedRun | null {
  const input = pushJobInput(end.needs, end.eventIssue);
  switch (input.kind) {
    case "agent-result":
      return { role: input.role, issue: input.issue, pullRequest: input.pullRequest, job: routedJob(end.needs, input.role), failure: null };
    case "review": {
      if (!input.withResult) return null;
      return { role: "review", issue: input.ticket, pullRequest: input.pullRequest, job: end.needs["review"], failure: null };
    }
    case "agent-failure": {
      const { role, issue, jobResult, secretsStep } = input;
      const job = failedJob(end.needs, role);
      const failure = failureOf(jobResult, secretsStep, end.failureReport);
      const kit = end.needs["kit"]?.outputs ?? {};
      const pullRequest = role === "review" || role === "implement" ? countOf(kit["pull-request"]) : null;
      return { role, issue, pullRequest, job, failure };
    }
    default:
      return null;
  }
}

/** The record of the agent run that just ended, or null when none did. */
export function runRecordFor(end: RunEnd): RunRecordFiles | null {
  const ran = endedRun(end);
  if (ran === null) return null;
  const { role, issue, pullRequest, job } = ran;
  const kit = end.needs["kit"]?.outputs ?? {};
  const agent = job?.outputs ?? {};
  const { recordPath, transcriptPath } = pathsFor({ ...end, role, replay: null }, end.transcript !== null);
  const implement = role === "implement";
  const facts: RunFacts = {
    kitSha: end.kitSha,
    repo: end.repo,
    runId: end.runId,
    runAttempt: end.runAttempt,
    role,
    issue,
    pullRequest,
    endedAt: end.endedAt,
    ...whatRan(agent, kit, end.roles[role]),
    subscription: nonEmpty(kit["subscription"]) ?? firstSubscription({ subscriptions: end.subscriptions }),
    retry: implement ? (countOf(kit["retry"]) ?? 0) : 0,
    ...stepUpOf(implement ? kit : {}),
    requestChanges: implement && kit["request-changes"] === "true",
    prototype: isPrototypeTurn(end.needs, role),
    replay: null,
    baseSha: nonEmpty(agent["base-sha"]),
    jobResult: job?.result ?? "unknown",
    infrastructureFailure: ran.failure,
    verdict: role === "review" ? verdictOf(end.agentResult) : null,
  };
  return { record: recordOf(facts, end.transcript, transcriptPath), recordPath, transcriptPath };
}

/** What the score-record job knows when a judge run, scoring a finished run, ends. */
export interface JudgeRunEnd {
  /** The scored run's record: the judge run is for its subject, in the same workflow run and attempt. */
  readonly scored: RunRecord;
  /** The judge job's `needs.<job>`: how it ended, and the outputs it passed out as an agent job does (`secrets-step`, `model`, `effort`). */
  readonly judge: NeededJob;
  /** The Kit's fixed judge model, which the record names when the judge job passed out none. */
  readonly judgeModel: string;
  /** The Kit commit writing the record. */
  readonly kitSha: string;
  /** When the score-record job ran, as an ISO 8601 time. */
  readonly endedAt: string;
  /** The judge's failure report artifact's text, or null if there was none. */
  readonly failureReport: string | null;
  /** The judge's transcript's stream-json lines, or null if no transcript survived its run. */
  readonly transcript: readonly string[] | null;
}

/**
 * The judge run's record, in role `score`, and its paths beside the scored
 * run's. Its subject and Replay are the scored run's; what ran, how it ended,
 * the effort it spent, its cost and its weekly-limit reading are its own.
 */
export function judgeRunRecordFor(end: JudgeRunEnd): RunRecordFiles {
  const { scored, judge } = end;
  // In the scored run's month, so the two sit side by side even when the judge ends in the next one.
  const { recordPath, transcriptPath } = pathsFor({ ...scored, role: "score" }, end.transcript !== null);
  const facts: RunFacts = {
    kitSha: end.kitSha,
    repo: scored.repo,
    runId: scored.runId,
    runAttempt: scored.runAttempt,
    role: "score",
    issue: scored.issue,
    pullRequest: scored.pullRequest,
    endedAt: end.endedAt,
    ...whatRan(judge.outputs, {}, { model: end.judgeModel, effort: null }),
    // The Kit job gives the judge the Subscription it gave the run the judge scores.
    subscription: scored.subscription,
    retry: 0,
    stepUp: false,
    stepUpReason: null,
    requestChanges: false,
    prototype: false,
    // A Replay arm's judge run is the arm's too, so its cost counts as the Replay's.
    replay: scored.replay,
    baseSha: null,
    jobResult: judge.result,
    infrastructureFailure: failureOf(judge.result, judge.outputs["secrets-step"], end.failureReport),
    verdict: null,
  };
  return { record: recordOf(facts, end.transcript, transcriptPath), recordPath, transcriptPath };
}

/** What the replay-record job knows when one arm's Implement or Review run, replaying a merged Ticket, ends. */
export interface ReplayRunEnd {
  /** Which Replay, arm and Ticket the run was. */
  readonly replay: ReplayRun;
  readonly role: ReplayRole;
  /** The replayed Ticket's merged PR. */
  readonly pullRequest: number;
  /** The Ticket's `baseSha`, its first Implement run's base, which both arms start from. */
  readonly baseSha: string;
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  /** The Actions run id and its attempt, which both arms share. */
  readonly runId: number;
  readonly runAttempt: number;
  /** The pinned Kit release writing the record, whatever prompts and Base skills the arm loaded. */
  readonly kitSha: string;
  /** When the replay-record job ran, as an ISO 8601 time. */
  readonly endedAt: string;
  /** The arm's job for the role: how it ended, and the outputs it passed out as an agent job does (`secrets-step`, `model`, `effort`). */
  readonly job: NeededJob;
  /** The arm's model and effort for the role, which the record names when the job passed out none. */
  readonly settings: { readonly model: string; readonly effort: string | null };
  /** The Subscription the Kit job gave the Replay. */
  readonly subscription: string;
  /** The agent result artifact's text, or null if there was none. */
  readonly agentResult: string | null;
  /** The failure report artifact's text, or null if there was none. */
  readonly failureReport: string | null;
  /** The transcript's stream-json lines, or null if no transcript survived the run. */
  readonly transcript: readonly string[] | null;
}

/**
 * A Replay arm's run's record, at its arm's paths. It is a first run on the
 * replayed Ticket and its merged PR, started from the Ticket's `baseSha`:
 * never a Retry, Step-up or Request-changes run.
 */
export function replayRunRecordFor(end: ReplayRunEnd): RunRecordFiles {
  const { replay, role, job } = end;
  const { recordPath, transcriptPath } = pathsFor({ ...end, role, replay }, end.transcript !== null);
  const facts: RunFacts = {
    kitSha: end.kitSha,
    repo: end.repo,
    runId: end.runId,
    runAttempt: end.runAttempt,
    role,
    issue: replay.ticket,
    pullRequest: end.pullRequest,
    endedAt: end.endedAt,
    ...whatRan(job.outputs, {}, end.settings),
    subscription: end.subscription,
    retry: 0,
    stepUp: false,
    stepUpReason: null,
    requestChanges: false,
    prototype: false,
    replay,
    baseSha: end.baseSha,
    jobResult: job.result,
    infrastructureFailure: failureOf(job.result, job.outputs["secrets-step"], end.failureReport),
    verdict: role === "review" ? verdictOf(end.agentResult) : null,
  };
  return { record: recordOf(facts, end.transcript, transcriptPath), recordPath, transcriptPath };
}

/** Whether an Implement run Stepped up, and why, from the Kit job's outputs; never a reason without a Step-up. */
function stepUpOf(kit: Readonly<Record<string, string>>): Pick<RunRecord, "stepUp" | "stepUpReason"> {
  if (kit["step-up"] !== "true") return { stepUp: false, stepUpReason: null };
  const reason = kit["step-up-reason"];
  return { stepUp: true, stepUpReason: isStepUpReason(reason) ? reason : null };
}

/** The fields a run's own stream gives its record, whatever its role. */
type StreamField =
  | "subtype"
  | "isError"
  | "terminalReason"
  | "durationMs"
  | "apiDurationMs"
  | "turns"
  | "permissionDenials"
  | "apiRetries"
  | "totalCostUsd"
  | "modelUsage"
  | "rateLimit";

/** What a record says that its run's stream doesn't: which run it was, for what, and how its job ended. */
type RunFacts = Omit<RunRecord, "schema" | "transcript" | StreamField>;

/** The record of a run from its facts and its own stream, with no stream fields when no transcript survived it. */
function recordOf(facts: RunFacts, transcript: readonly string[] | null, transcriptPath: string | null): RunRecord {
  const stream = transcript === null ? null : readStream(transcript);
  const last = stream?.result ?? null;
  const modelUsage = Object.fromEntries(Object.entries(stream?.modelUsage ?? {}).map(([model, usage]) => [model, costOf(usage)]));
  const { infrastructureFailure, verdict, ...ran } = facts;
  return {
    schema: RUN_RECORD_SCHEMA,
    ...ran,
    subtype: stringOr(last?.["subtype"]),
    isError: typeof last?.["is_error"] === "boolean" ? last["is_error"] : null,
    terminalReason: stringOr(last?.["terminal_reason"]),
    infrastructureFailure,
    verdict,
    durationMs: numberOr(last?.["duration_ms"]),
    apiDurationMs: numberOr(last?.["duration_api_ms"]),
    turns: numberOr(last?.["num_turns"]),
    permissionDenials: Array.isArray(last?.["permission_denials"]) ? last["permission_denials"].length : null,
    apiRetries: stream?.apiRetryCount ?? null,
    // A run with any model of unknown cost basis has no total either: never a guessed figure.
    totalCostUsd: Object.values(modelUsage).some((usage) => usage.costUsd === null) ? null : numberOr(last?.["total_cost_usd"]),
    modelUsage,
    rateLimit: readingOf(stream?.rateLimits.findLast((info) => info["rateLimitType"] === WEEKLY_LIMIT) ?? null),
    transcript: transcriptPath,
  };
}

/**
 * A Run record as read back from the store, at the current schema: a schema 1
 * record, which names no Subscription, is read as being on the first listed
 * one, a schema 1 or 2 record, written before there were prototype turns, as
 * no prototype turn, a schema 1, 2 or 3 record, written before there were
 * Replays, as no replay's, and a schema 1 to 4 record, written before Step-ups
 * had reasons, with a null reason, or `retry` if it Stepped up: until then
 * only the second Retry recorded a Step-up. Null for anything that isn't a
 * record of a schema the Kit knows.
 */
export function readRunRecord(stored: unknown, subscriptions: KitConfig["subscriptions"]): RunRecord | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { schema } = stored as { schema?: unknown };
  if (schema === RUN_RECORD_SCHEMA) return stored as RunRecord;
  type Schema4 = Omit<RunRecord, "schema" | "stepUpReason">;
  const record = (fields: Schema4): RunRecord => ({ ...fields, schema: RUN_RECORD_SCHEMA, stepUpReason: fields.stepUp ? "retry" : null });
  if (schema === 4) return record(stored as Schema4);
  if (schema === 3) return record({ ...(stored as Omit<Schema4, "replay">), replay: null });
  if (schema === 2) return record({ ...(stored as Omit<Schema4, "prototype" | "replay">), prototype: false, replay: null });
  if (schema === 1) {
    const older = stored as Omit<Schema4, "subscription" | "prototype" | "replay">;
    return record({ ...older, subscription: firstSubscription({ subscriptions }), prototype: false, replay: null });
  }
  return null;
}

/**
 * The job whose failure the push job saw: for a Review, the Reviewer, unless
 * its checks job failed first and the Reviewer never ran; for a Retro, the
 * Retro job, unless its evidence job failed first and the Retro never ran; for
 * a prototype turn, the prototype job.
 */
function failedJob(needs: Needs, role: AgentRole): NeededJob | undefined {
  const first = role === "review" ? needs["review-checks"] : role === "retro" ? needs[RETRO_EVIDENCE_JOB] : undefined;
  return first !== undefined && FAILED.includes(first.result) ? first : routedJob(needs, role);
}

const FAILED = ["failure", "cancelled"];

/** A failed or cancelled job's Infrastructure failure, classified as the failure notice classifies it, or null for a job that didn't fail. */
function failureOf(jobResult: string, secretsStep: string | undefined, failureReport: string | null): InfrastructureFailure | null {
  if (!FAILED.includes(jobResult)) return null;
  return infrastructureFailureOf({
    jobResult: jobResult === "cancelled" ? "cancelled" : "failure",
    secretsStep: secretsStep === "failure" ? "failure" : null,
    report: failureReport === null ? null : readFailureReport(failureReport),
  });
}

/** The Reviewer's Verdict, or null when it gave none. */
function verdictOf(agentResult: string | null): Verdict | null {
  if (agentResult === null) return null;
  try {
    const parsed = parseVerdict(readAgentRunResult(agentResult).output);
    return parsed.ok ? parsed.verdict : null;
  } catch {
    return null;
  }
}

/** The model and effort the runner passed: the agent job's own, else the Kit job's plan, else the role's default. */
function whatRan(
  agent: Readonly<Record<string, string>>,
  kit: Readonly<Record<string, string>>,
  defaults: { readonly model: string; readonly effort: string | null },
): { model: string; effort: string | null } {
  for (const outputs of [agent, kit]) {
    const model = nonEmpty(outputs["model"]);
    if (model !== null) return { model, effort: nonEmpty(outputs["effort"]) };
  }
  return { model: defaults.model, effort: defaults.effort };
}

function costOf(usage: StreamMessage): ModelCost {
  const costBasis = stringOr(usage["costBasis"]);
  return {
    inputTokens: numberOr(usage["inputTokens"]),
    outputTokens: numberOr(usage["outputTokens"]),
    cacheWriteTokens: numberOr(usage["cacheCreationInputTokens"]),
    cacheReadTokens: numberOr(usage["cacheReadInputTokens"]),
    costUsd: costBasis === UNKNOWN_COST_BASIS ? null : numberOr(usage["costUSD"]),
    costBasis,
  };
}

/** The `costBasis` the CLI gives a model it has no price for. */
export const UNKNOWN_COST_BASIS = "unknown";

function readingOf(info: StreamMessage | null): RateLimitReading | null {
  if (info === null) return null;
  return {
    status: stringOr(info["status"]),
    rateLimitType: stringOr(info["rateLimitType"]),
    utilization: numberOr(info["utilization"]),
    resetsAt: numberOr(info["resetsAt"]),
  };
}

/** Where a record and its transcript go, by the run's name in the store. */
function pathsFor(run: StoredRun, withTranscript: boolean): { recordPath: string; transcriptPath: string | null } {
  return {
    recordPath: recordPathOf(run),
    transcriptPath: withTranscript ? `transcripts/${runStoreName(run)}.jsonl.gz` : null,
  };
}

/** Where a run's record sits in the store. */
export function recordPathOf(run: StoredRun): string {
  return `runs/${runStoreName(run)}.json`;
}

/**
 * Where a Replay arm's patch, its diff from the Ticket's `baseSha`, sits in
 * the store: by the Product repo, the replay issue, the Ticket and the arm,
 * so each arm of each Ticket has one.
 */
export function replayPatchPath(repo: string, { issue, ticket, arm }: Pick<ReplayRun, "issue" | "ticket" | "arm">): string {
  return `replays/${repo}/${issue}/${ticket}-${arm}.patch`;
}

/**
 * Where a Replay arm's gates sit in the store, beside its patch: how the
 * Sandbox's setup, build and tests, and the merged PR's tests, went on its
 * diff, which the results read back for every Ticket done (src/kit/replay.ts).
 */
export function replayGatesPath(repo: string, at: Pick<ReplayRun, "issue" | "ticket" | "arm">): string {
  return replayPatchPath(repo, at).replace(/\.patch$/, ".gates.json");
}

/**
 * A run in one role, as the store tells it from every other: its repo, its
 * workflow run and attempt, the role, and for a Replay's run its arm, since
 * both arms run in one workflow run. Its record, transcript and score files,
 * and the commits that write them, all name it.
 */
export type RunIdentity = Pick<RunRecord, "repo" | "runId" | "runAttempt" | "role" | "replay">;

/** A run as the store files it: who it is, and when it ended, whose month its files sit in. */
export type StoredRun = RunIdentity & Pick<RunRecord, "endedAt">;

/**
 * A run's name in the store, which its record, its transcript and its score
 * files share: the run's repo, the month (UTC) it ended, its workflow run and
 * attempt, the role, and a Replay's arm.
 */
export function runStoreName(run: StoredRun): string {
  const month = new Date(run.endedAt).toISOString().slice(0, 7);
  return `${run.repo}/${month}/${runName(run)}`;
}

/** A run's key whatever month it ended: its name in the store without the month, which a score file's run shares with its record. */
export function runKey(run: RunIdentity): string {
  return `${run.repo}/${runName(run)}`;
}

/** A run's name within its repo and month: its workflow run, attempt and role, and a Replay's arm after them. */
function runName({ runId, runAttempt, role, replay }: RunIdentity): string {
  const name = `${runId}-${runAttempt}-${role}`;
  return replay === null ? name : `${name}-replay-${replay.arm}`;
}

/** A positive whole number from a job output, or null. */
function countOf(text: string | undefined): number | null {
  const n = Number(text);
  return text === undefined || text === "" || !Number.isInteger(n) || n < 1 ? null : n;
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text === "" ? null : text;
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
