// The step summary every agent job writes: role, model, effort, duration,
// turns and tokens, read from the `claude -p` stream-json lines (the init
// message and the final result message). Pure, no I/O.

export interface RunSummaryInput {
  readonly role: string;
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

export function runSummary({ role, lines, pinnedSkills }: RunSummaryInput): string {
  const init = initMessageOf(lines);
  const result = resultMessageOf(lines);
  const usage = (result?.["usage"] ?? {}) as Message;

  const effort = init === null ? UNKNOWN : typeof init["effort"] === "string" ? init["effort"] : "CLI default";
  const skills = Array.isArray(init?.["skills"]) && init["skills"].length > 0 ? init["skills"].join(", ") : "none reported";

  const row = [
    role,
    text(init?.["model"]),
    effort,
    duration(result?.["duration_ms"]),
    count(result?.["num_turns"]),
    count(usage["input_tokens"]),
    count(usage["output_tokens"]),
    count(usage["cache_creation_input_tokens"]),
    count(usage["cache_read_input_tokens"]),
  ];
  return [
    `### Fabrik agent run: ${role}`,
    "",
    "| Role | Model | Effort | Duration | Turns | Input tokens | Output tokens | Cache write | Cache read |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${row.join(" | ")} |`,
    "",
    `Skills loaded: ${skills}`,
    "",
    ...(pinnedSkills === undefined ? [] : [pinnedSkillsLine(lines, pinnedSkills), ""]),
  ].join("\n");
}
