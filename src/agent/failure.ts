// What a failed agent job leaves for the push job: which kind of
// Infrastructure failure it saw, read from the error and the `claude -p`
// stream, or for its input step, from the GitHub call that failed. A job cancelled by its timeout leaves nothing, and the push job
// works that out itself (src/loop/failures.ts). The Review checks job leaves
// one too (src/review/wait.ts). Pure, no I/O.
import { GitHubError, gitHubMessageOf, refusalOf } from "../github/client.ts";
import type { FailedRunCommits, FailureReport, ReportedFailure } from "../loop/types.ts";
import { FULL_SHA } from "../skills/lock.ts";
import { readStream, streamMessageOf, type AgentStream } from "./stream.ts";

/** The artifact's file name, the same in the agent job and the push job. */
export const AGENT_FAILURE_FILE = "agent-failure.json";

export interface FailureEvidence {
  /** What the agent runner caught. */
  readonly error: unknown;
  /** Every stdout line of the agent's stream, in order. */
  readonly lines: readonly string[];
  /** The routes the init check refused (empty when it passed), or null if no init message arrived. */
  readonly initRefused: readonly string[] | null;
  /**
   * What showed the run spending usage credits, when the stream watch stopped
   * it for that (only with rotation on); null or absent otherwise.
   */
  readonly overage?: string | null;
}

/** The Reviewer replied without a valid Verdict line, which is never a pass. */
export class MissingVerdictError extends Error {
  override name = "MissingVerdictError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/** The preflight's own words (src/preflight/main.ts), which Sandcastle passes on in the hook's error. */
const PREFLIGHT_REFUSAL = /Metered-billing preflight (refused the run|could not run)/;
const ROUTE_LINE = /::error title=Metered-billing route::(.*)/g;

/** A provider error the stream reported, if the run never recovered from it. */
function providerError({
  result: last,
  rateLimits,
  apiRetries: retries,
}: AgentStream): { error: string; detail: string; resetsAt?: string } | null {
  // A run that ended in a clean result recovered from any retries along the way.
  if (last !== null && last["is_error"] !== true) return null;

  const rejected = rateLimits.filter((info) => info["status"] === "rejected");
  const weekly = rejected.find((info) => String(info["rateLimitType"] ?? "").startsWith("seven_day"));
  if (weekly !== undefined) {
    const resetsAt = weekly["resetsAt"];
    if (typeof resetsAt !== "number") return { error: "weekly_limit", detail: "" };
    const at = new Date(resetsAt * 1000).toISOString();
    return { error: "weekly_limit", detail: `resets at ${at}`, resetsAt: at };
  }

  const auth = retries.find((m) => m["error"] === "authentication_failed");
  const retry = auth ?? retries.at(-1);
  if (retry !== undefined) {
    const error = String(retry["error"] ?? "unknown");
    const status = retry["error_status"];
    return { error, detail: typeof status === "number" ? `${error} (${status})` : error };
  }

  const limit = rejected.at(-1);
  if (limit !== undefined) {
    return { error: "rate_limit", detail: `rate limit (${String(limit["rateLimitType"] ?? "unknown")})` };
  }

  if (last !== null) {
    return { error: "result", detail: typeof last["result"] === "string" ? last["result"] : "the CLI returned an error" };
  }
  return null;
}

/** Classifies a failed agent run. Anything it can't place is a crash. */
export function failureReportFor({ error, lines, initRefused, overage = null }: FailureEvidence): FailureReport {
  if (initRefused !== null && initRefused.length > 0) {
    return { failure: "metered-billing", detail: initRefused.join("; ") };
  }
  // The stream watch stopped it, so whatever the stream said after is the stop's doing.
  if (overage !== null) {
    return { failure: "usage-credits", detail: `stopped for spending usage credits: ${overage}` };
  }
  const message = messageOf(error);
  if (PREFLIGHT_REFUSAL.test(message)) {
    const routes = [...message.matchAll(ROUTE_LINE)].map((match) => match[1]?.trim() ?? "");
    return { failure: "metered-billing", detail: routes.join("; ") };
  }

  const provider = providerError(readStream(lines));
  if (provider !== null) {
    const failure: ReportedFailure =
      provider.error === "authentication_failed"
        ? "dead-token"
        : provider.error === "weekly_limit"
          ? "weekly-limit"
          : "provider-error";
    return {
      failure,
      detail: provider.detail,
      ...(provider.resetsAt === undefined ? {} : { resetsAt: provider.resetsAt }),
    };
  }

  if (nameOf(error) === "StructuredOutputError" || error instanceof MissingVerdictError) {
    return { failure: "missing-output", detail: message };
  }
  return { failure: "crash", detail: message };
}

/**
 * What the Kit's input step (src/agent/inputs.ts) leaves when a GitHub call
 * failed: the request, GitHub's status and its message, and whether GitHub
 * refused it outright, so the notice doesn't offer to run it again into the
 * same refusal. Null for any other error, which the push job reads as a crash.
 */
export function inputsFailureReportFor(error: unknown): FailureReport | null {
  if (!(error instanceof GitHubError)) return null;
  const request = error.request === "" ? "a GitHub request" : error.request;
  const answer = error.status === 0 ? gitHubMessageOf(error) : `${error.status} ${gitHubMessageOf(error)}`;
  const refused = error.status >= 400 && error.status < 500 && refusalOf(error) !== "rate-limited";
  return { failure: "unread-inputs", detail: `${request}: ${answer}`, ...(refused ? { refused: true } : {}) };
}

const REPORTED: readonly ReportedFailure[] = [
  "crash",
  "missing-output",
  "provider-error",
  "dead-token",
  "weekly-limit",
  "metered-billing",
  "usage-credits",
  "unread-inputs",
  "unread-checks",
  "unreported-checks",
  "timeout",
];

/** Reads the artifact's text; anything unreadable counts as a crash, so a notice still goes out. */
export function readFailureReport(text: string): FailureReport {
  const value = streamMessageOf(text);
  const failure = value?.["failure"];
  if (typeof failure !== "string" || !REPORTED.includes(failure as ReportedFailure)) {
    return { failure: "crash", detail: `${AGENT_FAILURE_FILE} was unreadable` };
  }
  const detail = value?.["detail"];
  const resetsAt = value?.["resetsAt"];
  return {
    failure: failure as ReportedFailure,
    detail: typeof detail === "string" ? detail : "",
    ...(typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? { resetsAt } : {}),
    ...(value?.["refused"] === true ? { refused: true as const } : {}),
    ...withChecks(value?.["checks"]),
    ...withCommits(value?.["commits"]),
  };
}

/** The checks a Review gave up waiting on, as the report names them; nothing if they aren't a list of names. */
function withChecks(value: unknown): { checks?: readonly string[] } {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return {};
  return { checks: value };
}

/** What a run had committed, as the report gives it; nothing if any of it doesn't read. */
function withCommits(value: unknown): { commits?: FailedRunCommits } {
  if (typeof value !== "object" || value === null) return {};
  const { base, continued, head, kept } = value as Record<string, unknown>;
  if (typeof base !== "string" || !FULL_SHA.test(base) || typeof continued !== "boolean" || typeof kept !== "boolean") return {};
  if (head === null) return kept ? {} : { commits: { base, continued, head, kept } };
  if (typeof head !== "string" || !FULL_SHA.test(head)) return {};
  return { commits: { base, continued, head, kept } };
}
