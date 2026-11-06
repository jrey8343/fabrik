// What every AFK agent run launches through, whichever program runs it: the
// agent runner (src/agent/run.ts) and the judge (src/kit/judge-main.ts). The
// `claude` arguments the metered-billing preflight checks and the
// onSandboxReady hook that runs it, the Standard Schema a structured output is
// checked with, the stream watch that keeps the transcript and stops a run
// whose init message fails the backstop check, or, with rotation on, whose
// stream shows it spending usage credits, and the failure report a failed
// run leaves. The step summary and outputs it writes are src/kit/stepFiles.ts's.
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { AgentStreamEvent } from "@ai-hero/sandcastle";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { KIT_DIR } from "../kit/kitFiles.ts";
import type { FailureReport } from "../loop/types.ts";
import { CLAUDE_ARGS_ENV } from "../preflight/main.ts";
import { checkInitMessage } from "../preflight/meteredBilling.ts";
import { failureReportFor } from "./failure.ts";
import { isObject, readStream, type StreamMessage, streamMessageOf } from "./stream.ts";
import { transcriptWriter } from "./transcript.ts";

export type Checked<T> = { readonly ok: true; readonly output: T } | { readonly ok: false; readonly errors: readonly string[] };

/** A Standard Schema over an output contract, so Sandcastle can ask the agent to fix a malformed output. */
export function schemaOf<T>(read: (value: unknown) => Checked<T>): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "fabrik",
      validate(value) {
        const result = read(value);
        return result.ok ? { value: result.output } : { issues: result.errors.map((message) => ({ message })) };
      },
    },
  };
}

/**
 * The arguments Sandcastle's claudeCode() passes to `claude` (its
 * buildPrintCommand), for the preflight, with any `flags` the run adds before
 * the prompt.
 */
export function claudeArgs(model: string, effort: string | null, flags: readonly string[] = []): string[] {
  return [
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--model",
    model,
    ...(effort === null ? [] : ["--effort", effort]),
    ...flags,
    "-p",
    "-",
  ];
}

/** One onSandboxReady hook: the Product's setup, then the preflight last (Sandcastle runs hooks in parallel). */
export function readyHook(setup: string | null): string {
  const preflight = `node ${JSON.stringify(join(KIT_DIR, "src", "preflight", "main.ts"))}`;
  return setup === null ? preflight : `(${setup}) && ${preflight}`;
}

/**
 * Sets what the agent needs in this process's env, which it inherits
 * (noSandbox): the Kit's pinned `claude` first on PATH, no auto-update, and
 * its launch arguments for the preflight.
 */
export function setAgentEnv(args: readonly string[]): void {
  process.env["PATH"] = [join(KIT_DIR, "node_modules", ".bin"), process.env["PATH"] ?? ""].join(delimiter);
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env[CLAUDE_ARGS_ENV] = JSON.stringify(args);
}

/** The agent's stream as a run watches it. */
export interface StreamWatch {
  /** Every stdout line so far, in order. */
  readonly lines: readonly string[];
  /** The routes the init check refused (empty when it passed), or null if no init message has arrived. */
  initRefused(): readonly string[] | null;
  /** Throws unless an init message arrived and passed the check. */
  checkInit(): void;
  /** What showed the run spending usage credits, if the watch stopped it for that, or null. */
  overage(): string | null;
  /** Sandcastle's stream handler. */
  onAgentStreamEvent(event: AgentStreamEvent): void;
}

/** How a run watches its stream. */
export interface StreamWatchOptions {
  /** Whether rotation is on, so that a run whose stream shows overage is stopped. Off unless told. */
  readonly rotation: boolean;
}

/** What in one stream message shows overage, in itself or in its rate-limit info, or null. */
function overageIn(message: StreamMessage): string | null {
  const info = message["type"] === "rate_limit_event" ? message["rate_limit_info"] : undefined;
  for (const fields of [message, ...(isObject(info) ? [info] : [])]) {
    if (fields["isUsingOverage"] === true) return "isUsingOverage was true";
    if (fields["overageInUse"] === true) return "overageInUse was true";
  }
  if (isObject(info) && info["rateLimitType"] === "overage") return "a rate-limit event was of the overage type";
  return null;
}

/**
 * Watches the agent's stream: keeps every line, checks the init message
 * against metered billing and stops the run through `abort` if it refuses,
 * and, with rotation on, stops it on the first message showing overage, so a
 * Subscription with usage credits on spends no more. Then it appends the
 * line to the transcript at `transcriptPath`.
 */
export function streamWatch(
  transcriptPath: string,
  abort: AbortController,
  { rotation }: StreamWatchOptions = { rotation: false },
): StreamWatch {
  const lines: string[] = [];
  const transcript = transcriptWriter(transcriptPath);
  // null until the init message arrives, then the routes it refused (empty when it passed).
  let refused: readonly string[] | null = null;
  // null until a message shows overage, with rotation on.
  let overage: string | null = null;
  return {
    lines,
    initRefused: () => refused,
    overage: () => overage,
    checkInit() {
      if (refused === null) throw new Error("The agent's stream had no init message, so its API key source is unchecked");
      if (refused.length > 0) throw new Error(`Refused at init: ${refused.join("; ")}`);
    },
    // Errors thrown here are swallowed by Sandcastle, so stop the run through the signal.
    onAgentStreamEvent(event) {
      if (event.type !== "raw") return;
      lines.push(event.line);
      const initMessage = refused === null ? readStream([event.line]).init : null;
      if (initMessage !== null) {
        const check = checkInitMessage(initMessage);
        refused = check.kind === "refuse" ? check.routes : [];
        if (check.kind === "refuse") abort.abort(new Error(check.routes.join("; ")));
      }
      const message = rotation && overage === null ? streamMessageOf(event.line) : null;
      const shown = message === null ? null : overageIn(message);
      if (shown !== null) {
        overage = shown;
        abort.abort(new Error(`Stopped for spending usage credits: ${shown}`));
      }
      // After the checks, so a failed write can never skip an abort.
      transcript(event.line);
    },
  };
}

/** Where a failed run leaves its failure report, and how it's annotated. */
export interface FailureFile {
  readonly path: string;
  /** The error annotation's title, before the failure's kind. */
  readonly title: string;
  /** The file's text; the report as JSON when not given. */
  readonly text?: (report: FailureReport) => string;
}

/**
 * What a failed run leaves for the job after it, before its caller rethrows:
 * an error annotation for each route the init check refused, its failure
 * report, read from the error and the stream, and one error annotation naming
 * the failure.
 */
export async function leaveFailureReport(error: unknown, watch: StreamWatch, file: FailureFile): Promise<void> {
  for (const route of watch.initRefused() ?? []) console.log(`::error title=Metered-billing route::${route}`);
  const report = failureReportFor({
    error,
    lines: watch.lines,
    initRefused: watch.initRefused(),
    overage: watch.overage(),
  });
  await writeFile(file.path, file.text?.(report) ?? `${JSON.stringify(report, null, 2)}\n`);
  console.log(`::error title=${file.title} (${report.failure})::${report.detail}`);
}
