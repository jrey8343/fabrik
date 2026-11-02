// What a failed agent job leaves for its failure job: which kind of
// Infrastructure failure it saw, read from the error and the `claude -p`
// stream. A job cancelled by its timeout leaves nothing, and the failure job
// works that out itself (src/loop/failures.ts). Pure, no I/O.
import type { FailureReport, ReportedFailure } from "../loop/types.ts";

/** The artifact's file name, the same in the agent job and its failure job. */
export const AGENT_FAILURE_FILE = "agent-failure.json";

export interface FailureEvidence {
  /** What the agent runner caught. */
  readonly error: unknown;
  /** Every stdout line of the agent's stream, in order. */
  readonly lines: readonly string[];
  /** The routes the init check refused (empty when it passed), or null if no init message arrived. */
  readonly initRefused: readonly string[] | null;
}

type Message = Record<string, unknown>;

function parse(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
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
function providerError(messages: readonly Message[]): { error: string; detail: string; resetsAt?: string } | null {
  const results = messages.filter((m) => m["type"] === "result");
  const last = results.at(-1);
  // A run that ended in a clean result recovered from any retries along the way.
  if (last !== undefined && last["is_error"] !== true) return null;

  const rejected = messages
    .map((m) => (m["type"] === "rate_limit_event" ? (m["rate_limit_info"] as Message | undefined) : undefined))
    .filter((info): info is Message => info?.["status"] === "rejected");
  const weekly = rejected.find((info) => String(info["rateLimitType"] ?? "").startsWith("seven_day"));
  if (weekly !== undefined) {
    const resetsAt = weekly["resetsAt"];
    if (typeof resetsAt !== "number") return { error: "weekly_limit", detail: "" };
    const at = new Date(resetsAt * 1000).toISOString();
    return { error: "weekly_limit", detail: `resets at ${at}`, resetsAt: at };
  }

  const retries = messages.filter((m) => m["type"] === "system" && m["subtype"] === "api_retry");
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

  if (last !== undefined) {
    return { error: "result", detail: typeof last["result"] === "string" ? last["result"] : "the CLI returned an error" };
  }
  return null;
}

/** Classifies a failed agent run. Anything it can't place is a crash. */
export function failureReportFor({ error, lines, initRefused }: FailureEvidence): FailureReport {
  if (initRefused !== null && initRefused.length > 0) {
    return { failure: "metered-billing", detail: initRefused.join("; ") };
  }
  const message = messageOf(error);
  if (PREFLIGHT_REFUSAL.test(message)) {
    const routes = [...message.matchAll(ROUTE_LINE)].map((match) => match[1]?.trim() ?? "");
    return { failure: "metered-billing", detail: routes.join("; ") };
  }

  const provider = providerError(lines.map(parse).filter((m): m is Message => m !== null));
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

  if (nameOf(error) === "StructuredOutputError") return { failure: "missing-output", detail: message };
  return { failure: "crash", detail: message };
}

const REPORTED: readonly ReportedFailure[] = [
  "crash",
  "missing-output",
  "provider-error",
  "dead-token",
  "weekly-limit",
  "metered-billing",
];

/** Reads the artifact's text; anything unreadable counts as a crash, so a notice still goes out. */
export function readFailureReport(text: string): FailureReport {
  const value = parse(text);
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
  };
}
