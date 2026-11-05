// The Run record (ADR-0009): from what the push job knows when an AFK agent
// run ends, the one schema 1 record of that run, and the paths it and its
// transcript take in the store, or no record when no agent run ended. A judge
// run, scoring a finished run, gets a record too, in role `score`, from what
// the score-record job knows when it ends. The stream is read through the one
// stream-json reader (src/agent/stream.ts). The paths are inside the store,
// RUN_STORE (src/kit/runStore.ts). Pure, no I/O.
import { readFailureReport } from "../agent/failure.ts";
import { readAgentRunResult } from "../agent/result.ts";
import { readStream, type StreamMessage } from "../agent/stream.ts";
import { infrastructureFailureOf } from "../loop/failures.ts";
import type { AgentRole, InfrastructureFailure, KitConfig, Verdict } from "../loop/types.ts";
import { parseVerdict } from "../loop/verdict.ts";
import { type NeededJob, type Needs, pushJobInput } from "./pushJob.ts";

/** What the push job knows when the run ends. */
export interface RunEnd {
  /** The jobs' `needs`, as `toJSON(needs)` gives it, the Kit job's outputs included. */
  readonly needs: Needs;
  /** The Actions event's issue number, the subject of a Triage or Design run. */
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

/** One AFK agent run, schema 1. */
export interface RunRecord {
  readonly schema: 1;
  readonly kitSha: string;
  readonly repo: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly role: RunRecordRole;
  /** The run's subject: the Ticket for Implement and Review, the event's issue for Triage and Design, the scored run's for a judge run. */
  readonly issue: number;
  readonly pullRequest: number | null;
  readonly endedAt: string;
  readonly model: string;
  readonly effort: string | null;
  /** 0 for a first Implement run (and every other role), else its Retry number. */
  readonly retry: number;
  readonly stepUp: boolean;
  readonly requestChanges: boolean;
  /** The commit the run started from: an Implement branch's base, a Review's PR head, the event's commit for Triage and Design. */
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
      return { role: input.role, issue: input.issue, pullRequest: input.pullRequest, job: end.needs[input.role], failure: null };
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
  const { recordPath, transcriptPath } = pathsFor({ ...end, role }, end.transcript !== null);
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
    retry: implement ? (countOf(kit["retry"]) ?? 0) : 0,
    stepUp: implement && kit["step-up"] === "true",
    requestChanges: implement && kit["request-changes"] === "true",
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
 * run's. Its subject is the scored run's; what ran, how it ended, the effort
 * it spent, its cost and its weekly-limit reading are its own.
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
    retry: 0,
    stepUp: false,
    requestChanges: false,
    baseSha: null,
    jobResult: judge.result,
    infrastructureFailure: failureOf(judge.result, judge.outputs["secrets-step"], end.failureReport),
    verdict: null,
  };
  return { record: recordOf(facts, end.transcript, transcriptPath), recordPath, transcriptPath };
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
    schema: 1,
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
 * The job whose failure the push job saw: for a Review, the Reviewer, unless
 * its checks job failed first and the Reviewer never ran.
 */
function failedJob(needs: Needs, role: AgentRole): NeededJob | undefined {
  if (role !== "review") return needs[role];
  const checks = needs["review-checks"];
  return checks !== undefined && FAILED.includes(checks.result) ? checks : needs["review"];
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
  const name = runStoreName(run);
  return {
    recordPath: `runs/${name}.json`,
    transcriptPath: withTranscript ? `transcripts/${name}.jsonl.gz` : null,
  };
}

/**
 * A run in one role, as the store tells it from every other: its repo, its
 * workflow run and attempt, and the role. Its record, transcript and score
 * files, and the commits that write them, all name it.
 */
export type RunIdentity = Pick<RunRecord, "repo" | "runId" | "runAttempt" | "role">;

/** A run as the store files it: who it is, and when it ended, whose month its files sit in. */
export type StoredRun = RunIdentity & Pick<RunRecord, "endedAt">;

/**
 * A run's name in the store, which its record, its transcript and its score
 * files share: the run's repo, the month (UTC) it ended, its workflow run and
 * attempt, and the role.
 */
export function runStoreName(run: StoredRun): string {
  const month = new Date(run.endedAt).toISOString().slice(0, 7);
  return `${run.repo}/${month}/${runName(run)}`;
}

/** A run's key whatever month it ended: its name in the store without the month, which a score file's run shares with its record. */
export function runKey(run: RunIdentity): string {
  return `${run.repo}/${runName(run)}`;
}

/** A run's name within its repo and month: its workflow run, attempt and role. */
function runName({ runId, runAttempt, role }: RunIdentity): string {
  return `${runId}-${runAttempt}-${role}`;
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
