// The step summary every agent job writes: role, model, effort, duration,
// turns, tokens and cost. Model and skills come from the `claude -p` init
// message; duration, turns, tokens and cost from the final result message.
// Effort is what the runner passed to the CLI, since the init message never
// carries it. Pure, no I/O.
import type { InstallRecord, InstalledSource } from "../skills/installRecord.ts";
import { readStream, type AgentStream, type StreamMessage } from "./stream.ts";

export interface RunSummaryInput {
  readonly role: string;
  /** The effort the runner passed to the CLI (modelFor() in run.ts); null when it passed none. */
  readonly effort: string | null;
  /** Every stdout line of the agent's stream, in order. */
  readonly lines: readonly string[];
  /** The skills fetch's install record, to confirm against the init message. */
  readonly installed?: InstallRecord;
}

const UNKNOWN = "unknown";

function count(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : UNKNOWN;
}

function dollars(value: unknown): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : UNKNOWN;
}

interface Tokens {
  readonly input: unknown;
  readonly output: unknown;
  readonly cacheWrite: unknown;
  readonly cacheRead: unknown;
}

/**
 * The run's tokens: summed over the result's modelUsage, which counts every
 * model the run used (subagents included), else its usage, which counts the
 * main loop only.
 */
function tokensOf({ result, modelUsage }: AgentStream): Tokens {
  const models = Object.values(modelUsage);
  if (models.length === 0) {
    const usage = (result?.["usage"] ?? {}) as StreamMessage;
    return {
      input: usage["input_tokens"],
      output: usage["output_tokens"],
      cacheWrite: usage["cache_creation_input_tokens"],
      cacheRead: usage["cache_read_input_tokens"],
    };
  }
  const sum = (key: string): number | undefined => {
    const values = models.map((model) => model[key]);
    return values.every((value) => typeof value === "number") ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  return {
    input: sum("inputTokens"),
    output: sum("outputTokens"),
    cacheWrite: sum("cacheCreationInputTokens"),
    cacheRead: sum("cacheReadInputTokens"),
  };
}

function duration(ms: unknown): string {
  if (typeof ms !== "number") return UNKNOWN;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : UNKNOWN;
}

/** The installed skills, from every source, that the stream's init message didn't report as loaded (all of them if it never arrived). */
export function missingSkills(lines: readonly string[], installed: InstallRecord): readonly string[] {
  return missingFrom(readStream(lines).init, installed);
}

function missingFrom(init: StreamMessage | null, installed: InstallRecord): readonly string[] {
  const loaded = init?.["skills"];
  const reported = new Set(Array.isArray(loaded) ? loaded : []);
  return installed.flatMap((source) => source.skills).filter((name) => !reported.has(name));
}

function installedSourceLine(init: StreamMessage | null, source: InstalledSource): string {
  const missing = missingFrom(init, [source]);
  const total = source.skills.length;
  const loaded =
    missing.length === 0 ? `all ${total} loaded` : `${total - missing.length} of ${total} loaded; missing: ${missing.join(", ")}`;
  return `Installed from ${source.repository} at ${source.sha.slice(0, 7)}: ${source.skills.join(", ")} (${loaded})`;
}

export function runSummary({ role, effort, lines, installed }: RunSummaryInput): string {
  const stream = readStream(lines);
  const { init, result } = stream;
  const tokens = tokensOf(stream);

  const skills = Array.isArray(init?.["skills"]) && init["skills"].length > 0 ? init["skills"].join(", ") : "none reported";

  const row = [
    role,
    text(init?.["model"]),
    effort ?? "CLI default",
    duration(result?.["duration_ms"]),
    count(result?.["num_turns"]),
    count(tokens.input),
    count(tokens.output),
    count(tokens.cacheWrite),
    count(tokens.cacheRead),
    dollars(result?.["total_cost_usd"]),
  ];
  return [
    `### Fabrik agent run: ${role}`,
    "",
    "| Role | Model | Effort | Duration | Turns | Input tokens | Output tokens | Cache write | Cache read | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${row.join(" | ")} |`,
    "",
    `Skills loaded: ${skills}`,
    "",
    ...(installed ?? []).flatMap((source) => [installedSourceLine(init, source), ""]),
  ].join("\n");
}
