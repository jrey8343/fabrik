// The step summary every agent job writes: role, model, effort, duration,
// turns, tokens and cost. Model and skills come from the `claude -p` init
// message; duration, turns, tokens and cost from the final result message.
// Effort is what the runner passed to the CLI, since the init message never
// carries it. Pure, no I/O.

export interface RunSummaryInput {
  readonly role: string;
  /** The effort the runner passed to the CLI (modelFor() in run.ts); null when it passed none. */
  readonly effort: string | null;
  /** Every stdout line of the agent's stream, in order. */
  readonly lines: readonly string[];
  /** The skills the Kit installed from its lockfile, to confirm against the init message. */
  readonly pinnedSkills?: { readonly sha: string; readonly names: readonly string[] };
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

/** The stream's `system/init` message, or null if none arrived. */
export function initMessageOf(lines: readonly string[]): Message | null {
  for (const line of lines) {
    const message = parse(line);
    if (message?.["type"] === "system" && message["subtype"] === "init") return message;
  }
  return null;
}

function resultMessageOf(lines: readonly string[]): Message | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const message = parse(lines[i] ?? "");
    if (message?.["type"] === "result") return message;
  }
  return null;
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
function tokensOf(result: Message | null): Tokens {
  const perModel = result?.["modelUsage"];
  const models =
    typeof perModel === "object" && perModel !== null ? (Object.values(perModel) as Message[]) : [];
  if (models.length === 0) {
    const usage = (result?.["usage"] ?? {}) as Message;
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

/** The pinned skills the stream's init message didn't report as loaded (all of them if it never arrived). */
export function missingSkills(lines: readonly string[], names: readonly string[]): readonly string[] {
  const loaded = initMessageOf(lines)?.["skills"];
  const reported = new Set(Array.isArray(loaded) ? loaded : []);
  return names.filter((name) => !reported.has(name));
}

function pinnedSkillsLine(lines: readonly string[], pinned: NonNullable<RunSummaryInput["pinnedSkills"]>): string {
  const missing = missingSkills(lines, pinned.names);
  const at = `Pinned skills at ${pinned.sha.slice(0, 7)}`;
  if (missing.length === 0) return `${at}: all ${pinned.names.length} loaded`;
  return `${at}: ${pinned.names.length - missing.length} of ${pinned.names.length} loaded; missing: ${missing.join(", ")}`;
}

export function runSummary({ role, effort, lines, pinnedSkills }: RunSummaryInput): string {
  const init = initMessageOf(lines);
  const result = resultMessageOf(lines);
  const tokens = tokensOf(result);

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
    ...(pinnedSkills === undefined ? [] : [pinnedSkillsLine(lines, pinnedSkills), ""]),
  ].join("\n");
}
