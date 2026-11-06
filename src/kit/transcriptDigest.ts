// The transcript digest (#149, #151): a finished run's transcript, read
// through the stream reader, as compact lines held to a character budget.
// The judge reads one in its prompt (src/kit/scorerPrompt.ts) and the Retro
// one per run in its evidence (src/kit/retroEvidence.ts), each at its own
// budget. Its cuts, and the cut marker they leave in place, are the ones the
// Retro's evidence budget makes too. Pure, no I/O.
import { readStream, type StreamMessage, type StreamStep } from "../agent/stream.ts";

/** A transcript's digest, and whether it had to be trimmed to fit its budget. */
export interface TranscriptDigest {
  readonly digest: string;
  readonly trimmed: boolean;
}

/**
 * The transcript, read once through the stream reader, as the digest held to
 * whatever budget it's asked for: whole if it fits, else trimmed, its tool
 * results first, then its long assistant text, never its tool calls. Even a
 * budget of 0 keeps every tool call, so a digest can come out longer than
 * its budget.
 */
export function digestOf(transcript: readonly string[]): (budget: number) => TranscriptDigest {
  const stream = readStream(transcript);
  const fixed = (lines: readonly string[]): DigestLine[] => lines.map((head) => ({ head }));
  const lines = [
    ...fixed(headerLines(stream.init, stream.steps)),
    { head: "" },
    ...stepLines(stream.steps),
    { head: "" },
    ...fixed([retryLine(stream.apiRetries), ...denialLines(stream.result), resultLine(stream.result)]),
  ];
  return (budget) => fitted(lines, budget);
}

/** The marker a cut leaves in place of the characters it took. */
export const cutMarker = (characters: number): string => `[… ${characters} characters cut …]`;

/** How long a text of `length` characters is once cut to `cap`, its marker included; a cut that saves nothing isn't made. */
function cutLength(length: number, cap: number): number {
  return length <= cap ? length : Math.min(length, cap + cutMarker(length - cap).length);
}

/** The text cut to `cap` characters, keeping its start and its end around the marker. */
export function cutTo(text: string, cap: number): string {
  if (cutLength(text.length, cap) === text.length) return text;
  const start = Math.ceil(cap / 2);
  return `${text.slice(0, start)}${cutMarker(text.length - cap)}${text.slice(text.length - (cap - start))}`;
}

/** The largest cap from 0 to `max` that `fits`, or null when not even 0 does. Longer caps never make what's cut shorter. */
export function largestCap(fits: (cap: number) => boolean, max: number): number | null {
  if (!fits(0)) return null;
  let low = 0;
  let high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What the budget may cut, in the order it cuts them: tool results, then assistant text. */
type Cuttable = "result" | "text";

/** One line of the digest: a head kept whole, then a body the budget may cut. */
interface DigestLine {
  readonly head: string;
  readonly body?: { readonly kind: Cuttable; readonly text: string };
}

/** How long each kind of body may be; Infinity leaves that kind whole. */
type Caps = Readonly<Record<Cuttable, number>>;

const WHOLE: Caps = { result: Infinity, text: Infinity };

const bodyCap = (line: DigestLine, caps: Caps): number => (line.body === undefined ? Infinity : caps[line.body.kind]);

/**
 * The digest's lines held to `budget` characters: whole if they fit, else
 * with the longest tool results cut to one shared cap, and only when even
 * cutting every result can't make them fit, every result cut and the longest
 * assistant text cut too. Heads, and so every tool call, are never cut.
 */
function fitted(lines: readonly DigestLine[], budget: number): TranscriptDigest {
  const length = (caps: Caps) =>
    lines.reduce((sum, line) => sum + line.head.length + (line.body === undefined ? 0 : cutLength(line.body.text.length, bodyCap(line, caps))), lines.length - 1);
  const longest = (kind: Cuttable) => lines.reduce((max, line) => (line.body?.kind === kind ? Math.max(max, line.body.text.length) : max), 0);
  const fits = (caps: Caps) => length(caps) <= budget;

  let caps = WHOLE;
  if (!fits(caps)) {
    const result = largestCap((cap) => fits({ ...WHOLE, result: cap }), longest("result"));
    caps =
      result !== null
        ? { ...WHOLE, result }
        : { result: 0, text: largestCap((cap) => fits({ result: 0, text: cap }), longest("text")) ?? 0 };
  }
  const trimmed = lines.some((line) => line.body !== undefined && cutLength(line.body.text.length, bodyCap(line, caps)) < line.body.text.length);
  const digest = lines.map((line) => line.head + (line.body === undefined ? "" : cutTo(line.body.text, bodyCap(line, caps)))).join("\n");
  return { digest, trimmed };
}

const quoted = (names: readonly string[]): string => names.map((name) => `\`${name}\``).join(", ");

/** Each step as digest lines: tool calls numbered `#n` in order, each followed by its result, and a subagent's steps marked with the call that started it. */
function stepLines(steps: readonly StreamStep[]): DigestLine[] {
  const numbers = new Map<string, number>();
  let calls = 0;
  return steps.flatMap((step): DigestLine[] => {
    const parent = step.parentToolUseId === null ? undefined : numbers.get(step.parentToolUseId);
    const by = step.parentToolUseId === null ? "" : `[subagent${parent === undefined ? "" : ` of #${parent}`}] `;
    if (step.kind === "text") return [{ head: `${by}Assistant: `, body: { kind: "text", text: step.text } }];
    const n = ++calls;
    if (step.id !== null) numbers.set(step.id, n);
    const call = { head: `${by}#${n} ${step.name} ${JSON.stringify(step.input ?? {})}` };
    if (step.result === null) return [call, { head: `${by}#${n}: no result came back` }];
    return [call, { head: `${by}#${n} ${step.isError ? "error" : "result"}: `, body: { kind: "result", text: step.result } }];
  });
}

/** The skills a Skill call loaded, in order. */
function skillLoads(steps: readonly StreamStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind !== "tool-call" || step.name !== "Skill") return [];
    const input = step.input;
    const skill = typeof input === "object" && input !== null && "skill" in input ? input.skill : undefined;
    return typeof skill === "string" ? [skill] : [];
  });
}

function headerLines(init: StreamMessage | null, steps: readonly StreamStep[]): string[] {
  const model = init?.["model"];
  const had = init?.["skills"];
  const skills = Array.isArray(had) ? had.filter((skill): skill is string => typeof skill === "string") : [];
  const loaded = skillLoads(steps);
  return [
    `Model: ${typeof model === "string" ? model : init === null ? "unknown (no init message)" : "unknown"}`,
    `Skills it had: ${skills.length === 0 ? "none reported" : quoted(skills)}`,
    `Skills it loaded, in order: ${loaded.length === 0 ? "none" : quoted(loaded)}`,
  ];
}

function retryLine(retries: readonly StreamMessage[]): string {
  if (retries.length === 0) return "API retries: none";
  const each = retries.map((retry) => `${String(retry["error"] ?? "unknown error")}, status ${String(retry["error_status"] ?? "unknown")}`);
  return `API retries: ${retries.length} (${each.join("; ")})`;
}

function denialLines(result: StreamMessage | null): string[] {
  const reported = result?.["permission_denials"];
  const denials = Array.isArray(reported) ? reported.filter((denial): denial is StreamMessage => typeof denial === "object" && denial !== null) : [];
  if (denials.length === 0) return ["Permission denials: none"];
  return [
    `Permission denials: ${denials.length}`,
    ...denials.map((denial) => `- ${String(denial["tool_name"] ?? "unknown tool")} ${JSON.stringify(denial["tool_input"] ?? {})}`),
  ];
}

function resultLine(result: StreamMessage | null): string {
  if (result === null) return "Result: none; the run never reached its result message";
  const { subtype, is_error: isError, num_turns: turns, duration_ms: ms, terminal_reason: reason } = result;
  return `Result: ${[
    String(subtype ?? "unknown"),
    isError === true ? "an error" : "not an error",
    ...(typeof turns === "number" ? [`${turns} turns`] : []),
    ...(typeof ms === "number" ? [`${Math.round(ms / 1000)}s`] : []),
    ...(typeof reason === "string" ? [`terminal reason ${reason}`] : []),
  ].join(", ")}`;
}
