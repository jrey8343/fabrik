// The one reader of an agent's `claude -p` stream-json. The step summary, the
// failure report, the Run record and the judge prompt's transcript digest all
// read the stream through it, so none parses lines of its own. Lines that
// aren't JSON objects are skipped. Pure, no I/O.

/** One stream-json message, as the CLI wrote it. */
export type StreamMessage = Readonly<Record<string, unknown>>;

/** What an agent's stream said, read once. */
export interface AgentStream {
  /** The `system/init` message, or null if none arrived. */
  readonly init: StreamMessage | null;
  /** The last `result` message, or null if the run never reached one. */
  readonly result: StreamMessage | null;
  /** The last result's `modelUsage`, by model name: every model the run used, subagents included. Empty without one. */
  readonly modelUsage: Readonly<Record<string, StreamMessage>>;
  /** Every `rate_limit_event`'s `rate_limit_info`, in order. */
  readonly rateLimits: readonly StreamMessage[];
  /** The last rate-limit event's info, or null if the stream reported none. */
  readonly lastRateLimit: StreamMessage | null;
  /** Every `system/api_retry` message, in order. */
  readonly apiRetries: readonly StreamMessage[];
  /** How many times the CLI retried an API call. */
  readonly apiRetryCount: number;
  /** Every assistant turn's text and tool calls, in order, each call with the result the CLI gave back for it. */
  readonly steps: readonly StreamStep[];
}

/** Text an assistant turn wrote. */
export interface StreamText {
  readonly kind: "text";
  readonly text: string;
  /** The id of the tool call whose subagent wrote it, or null for the run's own agent. */
  readonly parentToolUseId: string | null;
}

/** A tool call an assistant turn made, with the result the CLI gave back for it. */
export interface StreamToolCall {
  readonly kind: "tool-call";
  /** The call's `tool_use` id, or null if it had none. */
  readonly id: string | null;
  /** The tool's name: `Skill` for a skill load. */
  readonly name: string;
  /** The call's arguments, as the agent gave them. */
  readonly input: unknown;
  /** The result's text, a non-text part as `[<type>]`, or null if no result came back. */
  readonly result: string | null;
  /** Whether the result was an error. */
  readonly isError: boolean;
  /** The id of the tool call whose subagent made it, or null for the run's own agent. */
  readonly parentToolUseId: string | null;
}

/** One step of an agent's work: text it wrote or a tool call it made. */
export type StreamStep = StreamText | StreamToolCall;

/** Whether a parsed JSON value is an object: not null, and not an array. */
export function isObject(value: unknown): value is StreamMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON text's value, or undefined when it doesn't parse, for a reader that checks what it holds. */
export function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A line as a JSON object, or null if it is anything else. */
export function streamMessageOf(line: string): StreamMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isInit(message: StreamMessage): boolean {
  return message["type"] === "system" && message["subtype"] === "init";
}

function modelUsageOf(result: StreamMessage | null): Readonly<Record<string, StreamMessage>> {
  const perModel = result?.["modelUsage"];
  if (!isObject(perModel)) return {};
  return Object.fromEntries(
    Object.entries(perModel).filter((entry): entry is [string, StreamMessage] => isObject(entry[1])),
  );
}

function contentOf(message: StreamMessage): readonly StreamMessage[] {
  const inner = message["message"];
  const content = isObject(inner) ? inner["content"] : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function stringOr<T>(value: unknown, otherwise: T): string | T {
  return typeof value === "string" ? value : otherwise;
}

/** A tool result's content, a string or a list of parts, as text. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return stringOr(content, "");
  return content
    .filter(isObject)
    .map((part) => (part["type"] === "text" ? stringOr(part["text"], "") : `[${stringOr(part["type"], "part")}]`))
    .join("\n");
}

function stepsOf(messages: readonly StreamMessage[]): readonly StreamStep[] {
  const results = new Map<string, StreamMessage>();
  for (const message of messages.filter((m) => m["type"] === "user")) {
    for (const part of contentOf(message)) {
      if (part["type"] === "tool_result" && typeof part["tool_use_id"] === "string") results.set(part["tool_use_id"], part);
    }
  }
  return messages
    .filter((m) => m["type"] === "assistant")
    .flatMap((message) => {
      const parentToolUseId = stringOr(message["parent_tool_use_id"], null);
      return contentOf(message).flatMap((part): StreamStep[] => {
        if (part["type"] === "text") return [{ kind: "text", text: stringOr(part["text"], ""), parentToolUseId }];
        if (part["type"] !== "tool_use") return [];
        const id = stringOr(part["id"], null);
        const result = id === null ? undefined : results.get(id);
        return [
          {
            kind: "tool-call",
            id,
            name: stringOr(part["name"], ""),
            input: part["input"],
            result: result === undefined ? null : resultText(result["content"]),
            isError: result?.["is_error"] === true,
            parentToolUseId,
          },
        ];
      });
    });
}

/** Reads every stdout line of the agent's stream, in order. */
export function readStream(lines: readonly string[]): AgentStream {
  const messages = lines.map(streamMessageOf).filter((m): m is StreamMessage => m !== null);
  const result = messages.findLast((m) => m["type"] === "result") ?? null;
  const rateLimits = messages
    .filter((m) => m["type"] === "rate_limit_event")
    .map((m) => m["rate_limit_info"])
    .filter(isObject);
  const apiRetries = messages.filter((m) => m["type"] === "system" && m["subtype"] === "api_retry");
  return {
    init: messages.find(isInit) ?? null,
    result,
    modelUsage: modelUsageOf(result),
    rateLimits,
    lastRateLimit: rateLimits.at(-1) ?? null,
    apiRetries,
    apiRetryCount: apiRetries.length,
    steps: stepsOf(messages),
  };
}
