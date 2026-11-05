// The Run record (ADR-0009): from what the push job knows when an AFK agent
// run ends, the one schema 1 record of that run, and the paths it and its
// transcript take in the store, or no record when no agent run ended. The
// stream is read through the one stream-json reader (src/agent/stream.ts).
// Pure, no I/O.
import { readFailureReport } from "../agent/failure.ts";
import { readAgentRunResult } from "../agent/result.ts";
import { readStream, type StreamMessage } from "../agent/stream.ts";
import { infrastructureFailureOf } from "../loop/failures.ts";
import type { AgentRole, InfrastructureFailure, KitConfig, Verdict } from "../loop/types.ts";
import { parseVerdict } from "../loop/verdict.ts";
import { type NeededJob, type Needs, pushJobInput } from "./pushJob.ts";

/** The central private repo every Product repo's records and transcripts go to (ADR-0009). */
export const RUN_STORE = "jrey8343/fabrik-runs";

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

/** The last weekly-limit reading the stream reported, raw. */
export interface RateLimitReading {
  readonly status: string | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly resetsAt: number | null;
}

/** One AFK agent run, schema 1. */
export interface RunRecord {
  readonly schema: 1;
  readonly kitSha: string;
  readonly repo: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly role: AgentRole;
  /** The run's subject: the Ticket for Implement and Review, the event's issue for Triage and Design. */
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

/** Which agent run ended, or null when none did: red checks, routing to push, or nothing to do. */
function endedRun(end: RunEnd): EndedRun | null {
  const input = pushJobInput(end.needs, end.eventIssue);
  switch (input.kind) {
    case "agent-result":
      return { role: input.role, issue: input.issue, pullRequest: input.pullRequest, job: end.needs[input.role], failure: null };
    case "review": {
      if (!input.withResult) return null;
      const ticket = countOf(end.needs["kit"]?.outputs["ticket"]) ?? input.pullRequest;
      return { role: "review", issue: ticket, pullRequest: input.pullRequest, job: end.needs["review"], failure: null };
    }
    case "agent-failure": {
      const { role, issue, jobResult, secretsStep } = input;
      const job = failedJob(end.needs, role);
      const failure = infrastructureFailureOf({
        jobResult: jobResult === "cancelled" ? "cancelled" : "failure",
        secretsStep: secretsStep === "failure" ? "failure" : null,
        report: end.failureReport === null ? null : readFailureReport(end.failureReport),
      });
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
  const stream = end.transcript === null ? null : readStream(end.transcript);
  const last = stream?.result ?? null;
  const { recordPath, transcriptPath } = pathsFor(end, role);
  const implement = role === "implement";
  const record: RunRecord = {
    schema: 1,
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
    subtype: stringOr(last?.["subtype"]),
    isError: typeof last?.["is_error"] === "boolean" ? last["is_error"] : null,
    terminalReason: stringOr(last?.["terminal_reason"]),
    infrastructureFailure: ran.failure,
    verdict: role === "review" ? verdictOf(end.agentResult) : null,
    durationMs: numberOr(last?.["duration_ms"]),
    apiDurationMs: numberOr(last?.["duration_api_ms"]),
    turns: numberOr(last?.["num_turns"]),
    permissionDenials: Array.isArray(last?.["permission_denials"]) ? last["permission_denials"].length : null,
    apiRetries: stream?.apiRetryCount ?? null,
    totalCostUsd: numberOr(last?.["total_cost_usd"]),
    modelUsage: Object.fromEntries(Object.entries(stream?.modelUsage ?? {}).map(([model, usage]) => [model, costOf(usage)])),
    rateLimit: null,
    transcript: transcriptPath,
  };
  return { record, recordPath, transcriptPath };
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
    costUsd: numberOr(usage["costUSD"]),
    costBasis,
  };
}

function pathsFor(end: RunEnd, role: AgentRole): { recordPath: string; transcriptPath: string | null } {
  const month = new Date(end.endedAt).toISOString().slice(0, 7);
  const name = `${end.repo}/${month}/${end.runId}-${end.runAttempt}-${role}`;
  return {
    recordPath: `runs/${name}.json`,
    transcriptPath: end.transcript === null ? null : `transcripts/${name}.jsonl.gz`,
  };
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
