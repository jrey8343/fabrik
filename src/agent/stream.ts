// The one reader of an agent's `claude -p` stream-json. The step summary, the
// failure report and the Run record all read the stream through it, so none
// parses lines of its own. Lines that aren't JSON objects are skipped. Pure,
// no I/O.

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
}

function isObject(value: unknown): value is StreamMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  };
}
