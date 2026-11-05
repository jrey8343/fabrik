// What every AFK agent run launches through, whichever program runs it: the
// agent runner (src/agent/run.ts) and the judge (src/kit/judge-main.ts). The
// `claude` arguments the metered-billing preflight checks and the
// onSandboxReady hook that runs it, the Standard Schema a structured output is
// checked with, the stream watch that keeps the transcript and stops a run
// whose init message fails the backstop check, and the step summary and step
// outputs every agent job writes.
import { appendFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { AgentStreamEvent } from "@ai-hero/sandcastle";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { KIT_DIR } from "../kit/kitFiles.ts";
import { CLAUDE_ARGS_ENV } from "../preflight/main.ts";
import { checkInitMessage } from "../preflight/meteredBilling.ts";
import { readStream } from "./stream.ts";
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
  /** Sandcastle's stream handler. */
  onAgentStreamEvent(event: AgentStreamEvent): void;
}

/**
 * Watches the agent's stream: keeps every line, checks the init message
 * against metered billing and stops the run through `abort` if it refuses,
 * then appends the line to the transcript at `transcriptPath`.
 */
export function streamWatch(transcriptPath: string, abort: AbortController): StreamWatch {
  const lines: string[] = [];
  const transcript = transcriptWriter(transcriptPath);
  // null until the init message arrives, then the routes it refused (empty when it passed).
  let refused: readonly string[] | null = null;
  return {
    lines,
    initRefused: () => refused,
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
      // After the init check, so a failed write can never skip its abort.
      transcript(event.line);
    },
  };
}

export async function writeSummary(text: string): Promise<void> {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path !== undefined && path !== "") await appendFile(path, text);
}

/** Appends step outputs, when the runner gives a file for them. */
export async function writeOutputs(outputs: Readonly<Record<string, string>>): Promise<void> {
  const path = process.env["GITHUB_OUTPUT"];
  if (path === undefined || path === "") return;
  await appendFile(path, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}
