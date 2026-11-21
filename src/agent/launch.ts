// What every AFK agent run launches through, whichever program runs it: the
// agent runner (src/agent/run.ts) and the judge (src/kit/judge-main.ts). The
// launch itself, with Sandcastle, which starts the agent without the tools
// that schedule a later turn and ends its run on the reply that holds its
// output block (#860), the `claude` arguments the metered-billing preflight
// checks and the onSandboxReady hook that runs it, the Standard Schema a
// structured output is checked with, the stream watch that keeps the
// transcript and stops a run whose init message fails the backstop check, or,
// with rotation on or on a Fable run, whose stream shows it spending usage
// credits, and the failure report a failed run leaves. The step summary and
// outputs it writes are src/kit/stepFiles.ts's; stopping what a settled run
// left running is src/agent/stop.ts's.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type AgentProvider, type AgentStreamEvent, type ClaudeCodeOptions, claudeCode, type OutputDefinition, run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isFableRun, type KitConfig } from "../kit/config.ts";
import { KIT_DIR } from "../kit/kitFiles.ts";
import type { FailedRunCommits, FailureReport } from "../loop/types.ts";
import { CLAUDE_ARGS_ENV } from "../preflight/main.ts";
import { checkInitMessage } from "../preflight/meteredBilling.ts";
import { failureReportFor } from "./failure.ts";
import { isObject, parsedJson, readStream, type StreamMessage, streamMessageOf } from "./stream.ts";
import { transcriptWriter } from "./transcript.ts";

export type Checked<T> = { readonly ok: true; readonly output: T } | { readonly ok: false; readonly errors: readonly string[] };

/**
 * A Standard Schema over an output contract, so Sandcastle can ask the agent
 * to fix a malformed output, which hands back the contract's parsed output. An
 * agent run whose output a push job checks again uses replySchemaOf instead.
 */
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
 * A role's output contract: a JSON object in the tag, checked by `read`, or
 * for the Reviewer plain text, checked by `text`, which throws when it breaks the contract.
 */
export type OutputContract<T> = { readonly read: (value: unknown) => Checked<T> } | { readonly text: (reply: string) => T };

/**
 * The Standard Schema Sandcastle checks a run's JSON reply with: it asks the
 * agent to fix a reply that breaks the contract, and hands back one that keeps
 * it as the agent wrote it, never the contract's parsed shape, which the push
 * job's check would read as a different output (#469).
 */
export function replySchemaOf<T>(read: (value: unknown) => Checked<T>): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "fabrik",
      validate(value) {
        const result = read(value);
        return result.ok ? { value } : { issues: result.errors.map((message) => ({ message })) };
      },
    },
  };
}

/**
 * A run's reply, as Sandcastle hands it back, checked against its contract:
 * the parsed output, and the output its agent result saves, which the push job
 * checks against the same contract. A JSON reply is saved as the agent wrote
 * it, so the push job's check is the only place it's converted (#469).
 */
export function settleReply<T>(contract: OutputContract<T>, reply: unknown): { readonly output: T; readonly saved: string } {
  if ("text" in contract) {
    const text = String(reply);
    return { output: contract.text(text), saved: text.trim() };
  }
  // Sandcastle has passed the reply already; reading it again gives the parsed output.
  const checked = contract.read(reply);
  if (!checked.ok) throw new Error(`The reply breaks its output contract: ${checked.errors.join("; ")}`);
  return { output: checked.output, saved: JSON.stringify(reply) };
}

/**
 * The tools that give a `claude -p` session a later turn, which no agent the
 * Kit launches starts with (#860): a pending wakeup keeps the agent's process
 * open after the reply that ends its run. Background commands stay.
 */
export const SCHEDULING_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"] as const;

/**
 * What every launch adds to take them away. The pinned Claude Code's init
 * message lists none of them with this flag; CLAUDE_CODE_DISABLE_CRON alone
 * leaves `ScheduleWakeup`.
 */
const NO_SCHEDULED_TURNS = ["--disallowedTools", SCHEDULING_TOOLS.join(",")] as const;

/**
 * The arguments every agent's `claude` is launched with, for the preflight:
 * the ones Sandcastle's claudeCode() passes (its buildPrintCommand), then the
 * flag that takes away the scheduling tools, then any `flags` the run adds,
 * all before the prompt.
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
    ...NO_SCHEDULED_TURNS,
    ...flags,
    "-p",
    "-",
  ];
}

/** The end of every launch command Sandcastle's claudeCode() builds: the prompt on stdin. */
const PROMPT_ON_STDIN = " -p -";

/** A flag or its value as one word of a shell command. */
const shellWord = (word: string): string => (/^[\w,.=:/-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * How long a run whose reply held its output block waits, with no further
 * line from its agent, before it is over (#860): Sandcastle's own grace for a
 * finished agent whose process hangs, far under its 600-second idle limit.
 */
export const OUTPUT_BLOCK_GRACE_SECONDS = 60;

/** What the last whole `<tag>` block of a reply holds, as Sandcastle finds it (its findLastTagContent), or null if the reply has none. */
function lastBlockIn(reply: string, tag: string): string | null {
  const [open, close] = [`<${tag}>`, `</${tag}>`];
  let last: string | null = null;
  for (let from = 0; ; ) {
    const start = reply.indexOf(open, from);
    const end = start === -1 ? -1 : reply.indexOf(close, start + open.length);
    if (end === -1) return last;
    last = reply.slice(start + open.length, end);
    from = end + close.length;
  }
}

/**
 * Whether a reply holds the whole output block: the tag's two ends, and for a
 * JSON output, JSON between them, in a code fence or not, as Sandcastle reads
 * it. So a reply that only names the tag in prose holds none. Whether the
 * JSON keeps the role's contract is Sandcastle's to check, which asks once
 * for a block that breaks it again.
 */
function holdsBlock(reply: string, output: OutputDefinition): boolean {
  const block = lastBlockIn(reply, output.tag)?.trim();
  if (block === undefined || output._tag === "string") return block !== undefined;
  const fenced = /^```(?:json)?\s*\n(?<body>[\s\S]*?)\n\s*```\s*$/u.exec(block)?.groups?.["body"];
  return parsedJson(fenced ?? block) !== undefined;
}

/** An agent's launch: what it is started with, what the preflight is told of it, and what ends its run. */
export interface AgentLaunch {
  /** The `claude` arguments the provider launches with, for the metered-billing preflight. */
  readonly args: readonly string[];
  /** The structured output the agent's reply must end in, as Sandcastle reads it. */
  readonly output: OutputDefinition;
  /** The Sandcastle provider that launches the agent. */
  readonly provider: AgentProvider;
  /**
   * Sandcastle's completion signal for the run: text the provider puts after
   * a result that holds the output block, and nowhere else.
   */
  readonly endSignal: string;
}

/**
 * The launch of an agent on `model` at `effort`, whose reply ends in the
 * block `output` names, with any `flags` the run adds. Sandcastle's
 * claudeCode() takes no extra flags, so the provider adds them to the command
 * it builds, a resumed session's too.
 *
 * The provider also marks the end of the run (#860). An agent's process can
 * stay open after the reply that holds its output block, and each turn of a
 * `claude -p` session ends in a `result` of its own, so the last line is no
 * sign of the end. Sandcastle ends a run once its completion signal has
 * appeared and its grace period has passed with no further line, but it looks
 * for the signal in everything the agent writes, where a role's tag can be
 * named or quoted mid-run. So the signal is one the agent can't write, made
 * afresh for each launch, and the provider puts it after a `result` that
 * holds the block, where Sandcastle's reading of the tag never sees it. A
 * later `result` that holds a block takes the earlier one's place. One that
 * holds none, or reports an error, is left out, so the reply Sandcastle reads
 * stays the block's whether the process then exits or stays open: a turn the
 * agent is woken into after its reply can't undo a run that had finished.
 */
export function agentLaunch(model: string, effort: string | null, output: OutputDefinition, flags: readonly string[] = []): AgentLaunch {
  const claude = claudeCode(model, effort === null ? {} : { effort: effort as NonNullable<ClaudeCodeOptions["effort"]> });
  const added = [...NO_SCHEDULED_TURNS, ...flags].map(shellWord).join(" ");
  const endSignal = `<fabrik-run-end-${randomUUID()}>`;
  // Whether this process's stream has given a result that holds the block yet.
  let blockSeen = false;
  return {
    args: claudeArgs(model, effort, flags),
    output,
    endSignal,
    provider: {
      ...claude,
      buildPrintCommand(options) {
        const built = claude.buildPrintCommand(options);
        if (!built.command.endsWith(PROMPT_ON_STDIN)) throw new Error(`Can't add the launch flags to an unexpected launch command: ${built.command}`);
        // A new process, whose stream starts with no block: Sandcastle's one retry of a malformed block is one.
        blockSeen = false;
        return { ...built, command: `${built.command.slice(0, -PROMPT_ON_STDIN.length)} ${added}${PROMPT_ON_STDIN}` };
      },
      parseStreamLine(line) {
        return claude.parseStreamLine(line).flatMap((event): ReturnType<AgentProvider["parseStreamLine"]> => {
          // Sandcastle's claudeCode() gives a result that reports an error as an `error`, and no other line as one.
          if (event.type === "error") return blockSeen ? [] : [event];
          if (event.type !== "result") return [event];
          if (!holdsBlock(event.result, output)) return blockSeen ? [] : [event];
          blockSeen = true;
          return [{ ...event, result: `${event.result}\n${endSignal}` }];
        });
      },
    },
  };
}

/**
 * Which of the Product's Sandbox commands a run's ready hook runs before the
 * agent starts: none for a role that only reads the code, `sandbox.setup` for
 * one that runs it, and `sandbox.setup` then `sandbox.build` for one that
 * builds a branch, so its agent starts with the Product's dependencies
 * installed (#703).
 */
export type SandboxReadying = "none" | "setup" | "setup-and-build";

/**
 * One onSandboxReady hook: the Product's commands the run readies, then the
 * preflight last (Sandcastle runs hooks in parallel), each step only if the one
 * before it passed. A null command is skipped.
 */
export function readyHook(readies: SandboxReadying, sandbox: Pick<KitConfig["sandbox"], "setup" | "build">): string {
  const preflight = `node ${JSON.stringify(join(KIT_DIR, "src", "preflight", "main.ts"))}`;
  const commands = readies === "none" ? [] : readies === "setup" ? [sandbox.setup] : [sandbox.setup, sandbox.build];
  return [...commands.flatMap((command) => (command === null ? [] : [`(${command})`])), preflight].join(" && ");
}

/** The folder holding the Kit's pinned `claude`. */
const KIT_BIN_DIR = join(KIT_DIR, "node_modules", ".bin");

/**
 * Sets what the agent needs in this process's env, which it inherits
 * (noSandbox): the `claude` in `binDir` first on PATH, no auto-update, and
 * its launch arguments for the preflight.
 */
function setAgentEnv(args: readonly string[], binDir: string): void {
  process.env["PATH"] = [binDir, process.env["PATH"] ?? ""].join(delimiter);
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env[CLAUDE_ARGS_ENV] = JSON.stringify(args);
}

/** One agent run: what Sandcastle is given to launch it, watch it and read its reply. */
export interface AgentRun {
  /** The run's name in Sandcastle's log. */
  readonly name: string;
  readonly launch: AgentLaunch;
  /** The git checkout the agent works in. */
  readonly cwd: string;
  readonly prompt: string;
  /** The onSandboxReady hook (readyHook), which ends in the preflight. */
  readonly ready: { readonly command: string; readonly timeoutMs: number };
  /** Stops the run: the one `watch` was made with. */
  readonly abort: AbortController;
  readonly watch: StreamWatch;
  /** Where Sandcastle writes the agent log. */
  readonly logPath: string;
  /** The grace period after a result that holds the output block, in seconds: OUTPUT_BLOCK_GRACE_SECONDS unless a test gives its own. */
  readonly graceSeconds?: number;
  /** The folder holding the `claude` to launch: the Kit's pinned one unless a test gives its own. */
  readonly binDir?: string;
}

/**
 * Runs one agent with Sandcastle on the runner VM (noSandbox), behind the
 * metered-billing preflight and the init check, and gives what its output tag
 * held. The agent inherits this process's env, so what it needs is set here.
 *
 * The run ends when the agent's process exits, or, with the process still
 * open, once a result has held the output block and the grace period has
 * passed with no further line (#860). Either way Sandcastle reads the block
 * from the reply, and asks once for a malformed one again. A run that ends
 * the second way leaves its agent's process running, as a failed one may:
 * the caller ends through endAgentProgram (src/agent/stop.ts), which stops
 * it, once the caller has written what it writes.
 */
export async function runAgent({
  name,
  launch,
  cwd,
  prompt,
  ready,
  abort,
  watch,
  logPath,
  graceSeconds = OUTPUT_BLOCK_GRACE_SECONDS,
  binDir = KIT_BIN_DIR,
}: AgentRun): Promise<unknown> {
  setAgentEnv(launch.args, binDir);
  const result = await run({
    name,
    agent: launch.provider,
    sandbox: noSandbox(),
    cwd,
    prompt,
    maxIterations: 1,
    output: launch.output,
    hooks: { sandbox: { onSandboxReady: [ready] } },
    completionSignal: launch.endSignal,
    completionTimeoutSeconds: graceSeconds,
    signal: abort.signal,
    logging: { type: "file", path: logPath, onAgentStreamEvent: watch.onAgentStreamEvent },
  });
  watch.checkInit();
  return (result as { output?: unknown }).output;
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
  /** The model the run was started on, as the watch was told it, which tells a Fable cap from the weekly limit. */
  readonly model?: string;
  /** Sandcastle's stream handler. */
  onAgentStreamEvent(event: AgentStreamEvent): void;
}

/** How a run watches its stream. */
export interface StreamWatchOptions {
  /** Whether rotation is on, so that a run whose stream shows overage is stopped. Off unless told. */
  readonly rotation: boolean;
  /** The model the run was started on: a run whose model names Fable is stopped on overage, rotation or not (ADR-0034). */
  readonly model?: string;
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

/** The scheduling tools an init message's `tools` still lists, in its order. */
function schedulingToolsAt(init: StreamMessage): string[] {
  const tools = init["tools"];
  return Array.isArray(tools) ? tools.filter((tool): tool is string => (SCHEDULING_TOOLS as readonly unknown[]).includes(tool)) : [];
}

/**
 * Watches the agent's stream: keeps every line, checks the init message
 * against metered billing and stops the run through `abort` if it refuses,
 * warns when it still lists a tool that schedules a later turn, and, with
 * rotation on or on a Fable run, stops the run on the first message showing
 * overage, so a Subscription with usage credits on spends no more. Then it
 * appends the line to the transcript at `transcriptPath`.
 */
export function streamWatch(
  transcriptPath: string,
  abort: AbortController,
  { rotation, model }: StreamWatchOptions = { rotation: false },
): StreamWatch {
  const lines: string[] = [];
  const transcript = transcriptWriter(transcriptPath);
  // null until the init message arrives, then the routes it refused (empty when it passed).
  let refused: readonly string[] | null = null;
  // Every Fable run stops on overage, so credits left on by mistake spend nothing (ADR-0034).
  const stopsOnOverage = rotation || isFableRun(model);
  // null until a message shows overage, on a run that stops on it.
  let overage: string | null = null;
  return {
    lines,
    initRefused: () => refused,
    overage: () => overage,
    ...(model === undefined ? {} : { model }),
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
        // The launch takes these tools away (claudeArgs); a `claude` that kept one is said, never stopped for it (#860).
        const kept = schedulingToolsAt(initMessage);
        if (kept.length > 0) console.log(`::warning title=Scheduling tools at init::${kept.join(", ")}`);
      }
      const message = stopsOnOverage && overage === null ? streamMessageOf(event.line) : null;
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
 * report, read from the error and the stream, with what the run had committed
 * on its branch when it cut one (#431), and one error annotation naming the
 * failure.
 */
export async function leaveFailureReport(
  error: unknown,
  watch: StreamWatch,
  file: FailureFile,
  commits: FailedRunCommits | null = null,
): Promise<void> {
  for (const route of watch.initRefused() ?? []) console.log(`::error title=Metered-billing route::${route}`);
  const report: FailureReport = {
    ...failureReportFor({
      error,
      lines: watch.lines,
      initRefused: watch.initRefused(),
      overage: watch.overage(),
      ...(watch.model === undefined ? {} : { model: watch.model }),
    }),
    ...(commits === null ? {} : { commits }),
  };
  await writeFile(file.path, file.text?.(report) ?? `${JSON.stringify(report, null, 2)}\n`);
  console.log(`::error title=${file.title} (${report.failure})::${report.detail}`);
}
