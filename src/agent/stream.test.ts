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
