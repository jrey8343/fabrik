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
});
