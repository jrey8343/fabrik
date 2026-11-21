import { describe, expect, it } from "vitest";
import { readStream } from "./stream.ts";

const lines = (...messages: unknown[]) => messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m)));

const init = { type: "system", subtype: "init", model: "claude-opus-5-5", skills: ["tdd"] };

describe("reading an agent's stream-json", () => {
  it("finds the init message and the last result, skipping malformed lines", () => {
    const stream = readStream(
      lines(
        "not json",
        "[1, 2]",
        "null",
        init,
        { type: "result", subtype: "error_during_execution", is_error: true },
        "{ truncated",
        { type: "result", subtype: "success", is_error: false, num_turns: 3 },
      ),
    );

    expect(stream.init).toEqual(init);
    expect(stream.result).toEqual({ type: "result", subtype: "success", is_error: false, num_turns: 3 });
  });

  it("has no result, and no per-model usage, when the run never reached one", () => {
    const stream = readStream(lines(init, { type: "assistant", message: {} }));

    expect(stream.result).toBeNull();
    expect(stream.modelUsage).toEqual({});
  });

  it("gives the last result's usage per model, subagents included", () => {
    const opus = { inputTokens: 1200, outputTokens: 3400, costUSD: 1.1 };
    const haiku = { inputTokens: 300, outputTokens: 50, costUSD: 0.01 };
    const stream = readStream(
      lines(
        { type: "result", modelUsage: { "claude-opus-5-5": { inputTokens: 1 } } },
        { type: "result", modelUsage: { "claude-opus-5-5": opus, "claude-haiku-4-5": haiku } },
      ),
    );

    expect(stream.modelUsage).toEqual({ "claude-opus-5-5": opus, "claude-haiku-4-5": haiku });
  });

  it("keeps every rate-limit event's info in order, and the last one apart", () => {
    const allowed = { status: "allowed", rateLimitType: "five_hour", resetsAt: 1_800_000_000 };
    const warning = { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 };
    const rejected = { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_100_000 };
    const stream = readStream(
      lines(
        init,
        { type: "rate_limit_event", rate_limit_info: allowed },
        { type: "rate_limit_event" },
        { type: "rate_limit_event", rate_limit_info: warning },
        { type: "rate_limit_event", rate_limit_info: rejected },
      ),
    );

    expect(stream.rateLimits).toEqual([allowed, warning, rejected]);
    expect(stream.lastRateLimit).toEqual(rejected);
  });

  it("has no rate-limit info when the stream reported none", () => {
    const stream = readStream(lines(init));

    expect(stream.rateLimits).toEqual([]);
    expect(stream.lastRateLimit).toBeNull();
  });

  it("counts the CLI's API retries", () => {
    const stream = readStream(
      lines(
        init,
        { type: "system", subtype: "api_retry", error: "overloaded", error_status: 529 },
        { type: "system", subtype: "status" },
        { type: "system", subtype: "api_retry", error: "authentication_failed", error_status: 401 },
      ),
    );

    expect(stream.apiRetryCount).toBe(2);
    expect(stream.apiRetries.map((retry) => retry["error"])).toEqual(["overloaded", "authentication_failed"]);
  });

  it("gives each assistant turn's text and tool calls in order, each call with its result", () => {
    const stream = readStream(
      lines(
        init,
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Loading tdd." }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "tdd" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Launching skill: tdd" }] } },
        { type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: …" }] } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
              { type: "tool_use", id: "t3", name: "Read", input: { file_path: "src/a.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "line 1" }, { type: "image" }, { type: "text", text: "line 2" }] },
              { type: "tool_result", tool_use_id: "t2", content: "1 failed", is_error: true },
            ],
          },
        },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "sleep 999" } }] } },
      ),
    );

    expect(stream.steps).toEqual([
      { kind: "text", text: "Loading tdd.", parentToolUseId: null },
      { kind: "tool-call", id: "t1", name: "Skill", input: { skill: "tdd" }, result: "Launching skill: tdd", isError: false, parentToolUseId: null },
      { kind: "tool-call", id: "t2", name: "Bash", input: { command: "npm test" }, result: "1 failed", isError: true, parentToolUseId: null },
      { kind: "tool-call", id: "t3", name: "Read", input: { file_path: "src/a.ts" }, result: "line 1\n[image]\nline 2", isError: false, parentToolUseId: null },
      { kind: "tool-call", id: "t4", name: "Bash", input: { command: "sleep 999" }, result: null, isError: false, parentToolUseId: null },
    ]);
  });

  it("marks the text and tool calls a subagent gave with the call that started it", () => {
    const stream = readStream(
      lines(
        { type: "assistant", message: { content: [{ type: "tool_use", id: "task", name: "Task", input: { prompt: "explore" } }] } },
        { type: "assistant", parent_tool_use_id: "task", message: { content: [{ type: "text", text: "Exploring." }] } },
        { type: "assistant", parent_tool_use_id: "task", message: { content: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "x" } }] } },
        { type: "user", parent_tool_use_id: "task", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "a.ts" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "task", content: "Found a.ts" }] } },
      ),
    );

    expect(stream.steps).toEqual([
      { kind: "tool-call", id: "task", name: "Task", input: { prompt: "explore" }, result: "Found a.ts", isError: false, parentToolUseId: null },
      { kind: "text", text: "Exploring.", parentToolUseId: "task" },
      { kind: "tool-call", id: "g1", name: "Grep", input: { pattern: "x" }, result: "a.ts", isError: false, parentToolUseId: "task" },
    ]);
  });

  it("has no steps when the stream held no assistant turns", () => {
    expect(readStream(lines(init, { type: "assistant" }, { type: "assistant", message: { content: "text" } })).steps).toEqual([]);
  });
});

describe("a run's figures, from every result of its stream (#860)", () => {
  const at = (timestamp: string) => ({ type: "assistant", timestamp, message: { content: [{ type: "text", text: "Working" }] } });
  // The three results of an Implement run that twice ended a turn with a background command running, each of which woke it into another.
  const threeResults = lines(
    init,
    at("2026-11-21T01:23:16.000Z"),
    { type: "result", subtype: "success", num_turns: 99, duration_ms: 1_080_647, duration_api_ms: 700_000, total_cost_usd: 6.9 },
    at("2026-11-21T01:30:22.000Z"),
    at("2026-11-21T01:30:25.000Z"),
    { type: "result", subtype: "success", num_turns: 4, duration_ms: 6_403, duration_api_ms: 5_000, total_cost_usd: 7.1 },
    at("2026-11-21T01:34:04.000Z"),
    at("2026-11-21T01:34:41.000Z"),
    { type: "result", subtype: "success", num_turns: 3, duration_ms: 37_555, duration_api_ms: 30_000, total_cost_usd: 7.54 },
  );

  it("sums the turns and the API time, and takes the duration from the agent's start to its last result, waits included", () => {
    const stream = readStream(threeResults);

    expect(stream.turns).toBe(106);
    expect(stream.apiDurationMs).toBe(735_000);
    // The first result's 18m 0.647s, then the 11m 25s from it to the last: about 29 minutes, where the three sum to 18m 45s.
    expect(stream.durationMs).toBe(1_080_647 + 685_000);
    expect(stream.result?.["total_cost_usd"]).toBe(7.54);
  });

  it("are the one result's own for a stream with one result", () => {
    const stream = readStream(lines(init, at("2026-11-21T01:23:16.000Z"), { type: "result", num_turns: 14, duration_ms: 125_400, duration_api_ms: 80_000 }));

    expect(stream).toMatchObject({ turns: 14, durationMs: 125_400, apiDurationMs: 80_000 });
  });

  it("are null for a run that never reached a result, or whose results gave no figure", () => {
    expect(readStream(lines(init, at("2026-11-21T01:23:16.000Z")))).toMatchObject({ turns: null, durationMs: null, apiDurationMs: null });
    expect(readStream(lines(init, { type: "result", subtype: "success" }))).toMatchObject({ turns: null, durationMs: null, apiDurationMs: null });
  });

  it("sums each result's duration when the messages between them carry no time", () => {
    const stream = readStream(lines(init, { type: "result", num_turns: 2, duration_ms: 60_000 }, { type: "result", num_turns: 1, duration_ms: 5_000 }));

    expect(stream.durationMs).toBe(65_000);
  });

  it("is never less than its turns took together, as when only the messages before the first result carry a time", () => {
    const stream = readStream(
      lines(init, at("2026-11-21T01:23:16.000Z"), { type: "result", duration_ms: 1_000_000 }, { type: "assistant", message: {} }, { type: "result", duration_ms: 43_000 }),
    );

    expect(stream.durationMs).toBe(1_043_000);
  });
});
