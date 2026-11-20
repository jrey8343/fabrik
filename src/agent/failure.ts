// What a failed agent job leaves for the push job: which kind of
// Infrastructure failure it saw, read from the error and the `claude -p`
// stream, or for its input step, from the GitHub call that failed. A job cancelled by its timeout leaves nothing, and the push job
// works that out itself (src/loop/failures.ts). The Review checks job leaves
// one too (src/review/wait.ts). Pure, no I/O.
import { GitHubError, gitHubMessageOf, refusalOf } from "../github/client.ts";
import { namesFable } from "../kit/config.ts";
import type { FailedRunCommits, FailureReport, RateLimitRefusal, ReportedFailure } from "../loop/types.ts";
import { FULL_SHA } from "../skills/lock.ts";
import type { BuiltBranch } from "./result.ts";
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
  /**
   * The model the run was started on, which tells a Fable cap from the weekly
   * limit (ADR-0034); absent, the run is read as not a Fable run.
   */
  readonly model?: string;
}

/** The Reviewer replied without a valid Verdict line, which is never a pass. */
export class MissingVerdictError extends Error {
  override name = "MissingVerdictError";
}

/**
 * A run's cut branch builds on commits it didn't start from, as one that reset
 * onto, or merged in, a commit its base doesn't hold (#535). The push job
 * rebuilds a cut branch from its base alone, so it could never land it.
 */
export class UnlandableBranchError extends Error {
  override name = "UnlandableBranchError";
  /** `commits` are those it builds on beside its base, which the push job never has. */
  constructor({ name, base }: Pick<BuiltBranch, "name" | "base">, commits: readonly string[]) {
    super(
      `${name} builds on ${commits.length === 1 ? "a commit" : "commits"} it didn't start from (${commits.map((sha) => `\`${sha}\``).join(", ")}): ` +
        `it started from ${base.ref} at \`${base.sha}\`, and the push job rebuilds it from that commit alone`,
    );
  }
}

/**
 * The agent ended the run on another branch than the one it was given (#434),
 * so its work can't be read off its branch: a Broken run, not a crash.
 */
export class LeftBranchError extends Error {
  override name = "LeftBranchError";
  constructor(branch: string, current: string) {
    super(`The agent left ${branch} for ${current}`);
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

/** The `rateLimitType` of the Subscription's weekly limit across every model. */
const WEEKLY_LIMIT_TYPE = "seven_day";

/** A provider error the stream reported, if the run never recovered from it. */
function providerError(
  { result: last, rateLimits, apiRetries: retries }: AgentStream,
  fable: boolean,
): { error: string; detail: string; resetsAt?: string; refusal?: RateLimitRefusal; weeklyResetsAt?: string } | null {
  // A run that ended in a clean result recovered from any retries along the way.
  if (last !== null && last["is_error"] !== true) return null;

  const rejected = rateLimits.filter((info) => info["status"] === "rejected");
  // The weekly limit across every model wins over any seven_day_* beside it, whatever their order: it holds every run.
  const weekly =
    rejected.find((info) => info["rateLimitType"] === WEEKLY_LIMIT_TYPE) ??
    rejected.find((info) => String(info["rateLimitType"] ?? "").startsWith(WEEKLY_LIMIT_TYPE));
  if (weekly !== undefined) {
    const refusal = refusalIn(weekly);
    // Only a Fable run's seven_day_* is its Fable cap. Plain seven_day, and any on a run that isn't Fable, is the weekly
    // limit, so a cap that reads as plain seven_day holds its Subscription: it costs time, never money (ADR-0034).
    const capped = fable && refusal.rateLimitType !== WEEKLY_LIMIT_TYPE;
    const at = refusal.resetsAt === null ? null : new Date(refusal.resetsAt * 1000).toISOString();
    const resets = at === null ? "" : `resets at ${at}`;
    // A Fable cap with no reset of its own counts until the weekly limit's (src/loop/fableCap.ts), when the stream read one.
    const weeklyResetsAt = capped ? lastWeeklyReset(rateLimits) : null;
    return {
      error: capped ? "fable_cap" : "weekly_limit",
      detail: capped ? [refusal.rateLimitType ?? "", resets].filter((part) => part !== "").join(", ") : resets,
      ...(at === null ? {} : { resetsAt: at }),
      refusal,
      ...(weeklyResetsAt === null ? {} : { weeklyResetsAt }),
    };
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
    return { error: "rate_limit", detail: `rate limit (${String(limit["rateLimitType"] ?? "unknown")})`, refusal: refusalIn(limit) };
  }

  if (last !== null) {
    return { error: "result", detail: typeof last["result"] === "string" ? last["result"] : "the CLI returned an error" };
  }
  return null;
}

/** When the stream's last weekly-limit reading said the weekly limit resets, ISO 8601, or null when none gave a reset. */
function lastWeeklyReset(rateLimits: AgentStream["rateLimits"]): string | null {
  const resetsAt = rateLimits.findLast((info) => info["rateLimitType"] === WEEKLY_LIMIT_TYPE && refusalIn(info).resetsAt !== null)?.["resetsAt"];
  return typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : null;
}

/** A refused rate limit, raw, as the stream or a report gave it, each part that doesn't read as null. */
function refusalIn(info: Readonly<Record<string, unknown>>): RateLimitRefusal {
  const { rateLimitType, resetsAt } = info;
  return {
    rateLimitType: typeof rateLimitType === "string" ? rateLimitType : null,
    resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/** Classifies a failed agent run. Anything it can't place is a crash. */
export function failureReportFor({ error, lines, initRefused, overage = null, model }: FailureEvidence): FailureReport {
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

  const provider = providerError(readStream(lines), model !== undefined && namesFable(model));
  if (provider !== null) {
    const failure: ReportedFailure =
      provider.error === "authentication_failed"
        ? "dead-token"
        : provider.error === "weekly_limit"
          ? "weekly-limit"
          : provider.error === "fable_cap"
            ? "fable-cap"
            : "provider-error";
    return {
      failure,
      detail: provider.detail,
      ...(provider.resetsAt === undefined ? {} : { resetsAt: provider.resetsAt }),
      ...(provider.refusal === undefined ? {} : { refusal: provider.refusal }),
      ...(provider.weeklyResetsAt === undefined ? {} : { weeklyResetsAt: provider.weeklyResetsAt }),
    };
  }

  if (error instanceof UnlandableBranchError) return { failure: "unlandable-branch", detail: message };
  if (error instanceof LeftBranchError) return { failure: "left-branch", detail: message };
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
  "fable-cap",
  "metered-billing",
  "usage-credits",
  "unread-inputs",
  "unread-checks",
  "unreported-checks",
  "merge-conflict",
  "unlandable-branch",
  "left-branch",
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
  const weeklyResetsAt = value?.["weeklyResetsAt"];
  return {
    failure: failure as ReportedFailure,
    detail: typeof detail === "string" ? detail : "",
    ...(typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? { resetsAt } : {}),
    ...(value?.["refused"] === true ? { refused: true as const } : {}),
    ...withRefusal(value?.["refusal"]),
    ...(typeof weeklyResetsAt === "string" && !Number.isNaN(Date.parse(weeklyResetsAt)) ? { weeklyResetsAt } : {}),
    ...withChecks(value?.["checks"]),
    ...withWait(value),
    ...withCommits(value?.["commits"]),
  };
}

/** A refusal's raw rate limit, as the report gives it; nothing if it isn't one. */
function withRefusal(value: unknown): { refusal?: RateLimitRefusal } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { refusal: refusalIn(value as Record<string, unknown>) };
}

/** The checks a Review gave up waiting on, as the report names them; nothing if they aren't a list of names. */
function withChecks(value: unknown): { checks?: readonly string[] } {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return {};
  return { checks: value };
}

/**
 * What a Review's wait recorded of how it waited (#704): the head, whole
 * minutes, and the PR's last mergeable state, null when unknown. Each that
 * doesn't read is left out, as for a report that predates them.
 */
function withWait(value: Record<string, unknown> | null | undefined): Pick<FailureReport, "headSha" | "waitedMinutes" | "mergeable"> {
  const headSha = value?.["headSha"];
  const waitedMinutes = value?.["waitedMinutes"];
  const mergeable = value?.["mergeable"];
  return {
    ...(typeof headSha === "string" && FULL_SHA.test(headSha) ? { headSha } : {}),
    ...(Number.isInteger(waitedMinutes) && (waitedMinutes as number) >= 0 ? { waitedMinutes: waitedMinutes as number } : {}),
    ...(typeof mergeable === "boolean" || mergeable === null ? { mergeable } : {}),
  };
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
