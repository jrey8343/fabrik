import { describe, expect, it } from "vitest";
import { failureReportFor, MissingVerdictError, readFailureReport } from "./failure.ts";

const line = (message: unknown) => JSON.stringify(message);
const init = line({ type: "system", subtype: "init", apiKeySource: "none" });
const retry = (error: string, status: number | null = null) =>
  line({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 3, error_status: status, error });
const errorResult = (result: string, status: number | null = null) =>
  line({ type: "result", subtype: "success", is_error: true, result, api_error_status: status });

describe("How an agent job reports its own failure", () => {
  it("a refusal at the init check is a metered-billing failure, naming the routes", () => {
    const report = failureReportFor({
      error: new Error("aborted"),
      lines: [init],
      initRefused: ["apiKeySource is ANTHROPIC_API_KEY"],
    });

    expect(report).toEqual({ failure: "metered-billing", detail: "apiKeySource is ANTHROPIC_API_KEY" });
  });

  it("a preflight that refuses before the agent starts is a metered-billing failure", () => {
    const error = new Error(
      'Sandbox command failed (exit 1): node "/kit/src/preflight/main.ts"\nMetered-billing preflight refused the run (Infrastructure failure):\n::error title=Metered-billing route::ANTHROPIC_API_KEY is set',
    );

    expect(failureReportFor({ error, lines: [], initRefused: null })).toEqual({
      failure: "metered-billing",
      detail: "ANTHROPIC_API_KEY is set",
    });
  });

  it("a Product setup command that fails before the preflight is a crash, not a billing refusal", () => {
    const error = new Error("Sandbox command failed (exit 2): (npm run stub) && node \"/kit/src/preflight/main.ts\"\nnpm ERR! missing script: stub");

    expect(failureReportFor({ error, lines: [], initRefused: null }).failure).toBe("crash");
  });

  it("authentication_failed in the stream is a dead token", () => {
    const report = failureReportFor({
      error: new Error("agent exited 1"),
      lines: [init, retry("authentication_failed", 401)],
      initRefused: [],
    });

    expect(report).toEqual({ failure: "dead-token", detail: "authentication_failed (401)" });
  });

  it("a rejected weekly rate limit in the stream is the weekly limit, with when it resets", () => {
    const report = failureReportFor({
      error: new Error("agent exited 1"),
      lines: [
        init,
        line({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_798_000_000 },
        }),
      ],
      initRefused: [],
    });

    expect(report).toEqual({
      failure: "weekly-limit",
      detail: "resets at 2026-12-23T04:26:40.000Z",
      resetsAt: "2026-12-23T04:26:40.000Z",
    });
  });

  it("the failure job reads back when the weekly limit resets", () => {
    const report = { failure: "weekly-limit", detail: "", resetsAt: "2026-12-23T04:26:40.000Z" };

    expect(readFailureReport(JSON.stringify(report))).toEqual(report);
  });

  it("a five-hour rate limit is a provider error, not the weekly limit", () => {
    const report = failureReportFor({
      error: new Error("agent exited 1"),
      lines: [init, line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } })],
      initRefused: [],
    });

    expect(report.failure).toBe("provider-error");
  });

  it.each(["overloaded", "server_error", "rate_limit", "billing_error"])(
    "%s in the stream is a provider error",
    (error) => {
      const report = failureReportFor({ error: new Error("agent exited 1"), lines: [init, retry(error, 529)], initRefused: [] });

      expect(report).toEqual({ failure: "provider-error", detail: `${error} (529)` });
    },
  );

  it("an error result from the CLI is a provider error, quoting it", () => {
    const report = failureReportFor({
      error: new Error("agent exited 1"),
      lines: [init, errorResult("API Error: 500 Internal server error", 500)],
      initRefused: [],
    });

    expect(report).toEqual({ failure: "provider-error", detail: "API Error: 500 Internal server error" });
  });

  it("output that never met its contract is missing output", () => {
    const error = Object.assign(new Error("Structured output failed validation"), { name: "StructuredOutputError" });

    const report = failureReportFor({ error, lines: [init], initRefused: [] });

    expect(report).toEqual({ failure: "missing-output", detail: "Structured output failed validation" });
  });

  it("a Reviewer reply with no valid Verdict line is missing output", () => {
    const error = new MissingVerdictError("The Reviewer's reply is empty");

    const report = failureReportFor({ error, lines: [init], initRefused: [] });

    expect(report).toEqual({ failure: "missing-output", detail: "The Reviewer's reply is empty" });
  });

  it("anything else is a crash, with the error's message", () => {
    const report = failureReportFor({ error: new Error("ENOENT: no such file"), lines: [init], initRefused: [] });

    expect(report).toEqual({ failure: "crash", detail: "ENOENT: no such file" });
  });

  it("a transient provider retry that recovered doesn't hide the real cause", () => {
    const error = Object.assign(new Error("Structured output failed validation"), { name: "StructuredOutputError" });

    const report = failureReportFor({
      error,
      lines: [init, retry("overloaded", 529), line({ type: "result", subtype: "success", is_error: false, result: "ok" })],
      initRefused: [],
    });

    expect(report.failure).toBe("missing-output");
  });
});

describe("Reading the failure report in the failure job", () => {
  it("reads back what the agent job wrote", () => {
    expect(readFailureReport(JSON.stringify({ failure: "dead-token", detail: "authentication_failed (401)" }))).toEqual({
      failure: "dead-token",
      detail: "authentication_failed (401)",
    });
  });

  it.each(["", "not json", JSON.stringify({ failure: "timeout" })])(
    "treats an unreadable report (%j) as a crash, so a notice still goes out",
    (text) => {
      expect(readFailureReport(text).failure).toBe("crash");
    },
  );
});
