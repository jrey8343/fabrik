import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import { failureReportFor, inputsFailureReportFor, MissingVerdictError, readFailureReport } from "./failure.ts";

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

  it("the push job reads back when the weekly limit resets", () => {
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

describe("Reading the failure report in the push job", () => {
  it("reads back what the agent job wrote", () => {
    expect(readFailureReport(JSON.stringify({ failure: "dead-token", detail: "authentication_failed (401)" }))).toEqual({
      failure: "dead-token",
      detail: "authentication_failed (401)",
    });
  });

  it("reads back a usage-credits report, an Infrastructure failure the push job knows", () => {
    const report = { failure: "usage-credits", detail: "stopped for spending usage credits: overageInUse was true" };

    expect(readFailureReport(JSON.stringify(report))).toEqual(report);
  });

  it("reads back an unread-inputs report, refused or not", () => {
    const refused = { failure: "unread-inputs", detail: "GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration", refused: true };
    const failed = { failure: "unread-inputs", detail: "POST /graphql: 502 Bad Gateway" };

    expect(readFailureReport(JSON.stringify(refused))).toEqual(refused);
    expect(readFailureReport(JSON.stringify(failed))).toEqual(failed);
    expect(readFailureReport(JSON.stringify({ ...failed, refused: "yes" }))).toEqual(failed);
  });

  it("reads back what a run had committed on its branch, kept or not (#431)", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const kept = { failure: "missing-output", detail: "Structured output failed validation", commits: { base, continued: true, head, kept: true } };
    const none = { failure: "missing-output", detail: "", commits: { base, continued: false, head: null, kept: false } };

    expect(readFailureReport(JSON.stringify(kept))).toEqual(kept);
    expect(readFailureReport(JSON.stringify(none))).toEqual(none);
  });

  it.each([
    ["a base that isn't a commit sha", { base: "main", continued: true, head: "b".repeat(40), kept: true }],
    ["a head that isn't a commit sha", { base: "a".repeat(40), continued: true, head: "HEAD", kept: true }],
    ["no word on whether they were kept", { base: "a".repeat(40), continued: true, head: "b".repeat(40) }],
    ["no word on whether the branch was continued", { base: "a".repeat(40), head: "b".repeat(40), kept: true }],
    ["commits kept with no head", { base: "a".repeat(40), continued: true, head: null, kept: true }],
  ])("drops commits with %s, so the notice claims nothing it can't back", (_, commits) => {
    expect(readFailureReport(JSON.stringify({ failure: "missing-output", detail: "", commits }))).toEqual({ failure: "missing-output", detail: "" });
  });

  it.each(["", "not json", JSON.stringify({ failure: "timeout" })])(
    "treats an unreadable report (%j) as a crash, so a notice still goes out",
    (text) => {
      expect(readFailureReport(text).failure).toBe("crash");
    },
  );
});

describe("How the input step reports a failed GitHub call (#328)", () => {
  const github = (status: number, body: string, request = "GET /repos/acme/shop/pulls/84", rateLimitRemaining: string | null = "4000") =>
    new GitHubError(`GitHub ${request} failed: ${status} ${body}`, status, { body, request, rateLimitRemaining });
  const message = (text: string) => JSON.stringify({ message: text, documentation_url: "https://docs.github.com/rest" });

  it("a 4xx GitHub refuses again every time the run goes again: refused, naming the request, the status and GitHub's message", () => {
    expect(inputsFailureReportFor(github(403, message("Resource not accessible by integration")))).toEqual({
      failure: "unread-inputs",
      detail: "GET /repos/acme/shop/pulls/84: 403 Resource not accessible by integration",
      refused: true,
    });
  });

  it.each([
    ["a 5xx", github(502, "Bad Gateway"), "GET /repos/acme/shop/pulls/84: 502 Bad Gateway"],
    ["a rate limit", github(403, message("API rate limit exceeded"), "GET /repos/acme/shop/pulls/84", "0"), "GET /repos/acme/shop/pulls/84: 403 API rate limit exceeded"],
    ["a 429", github(429, message("Too many requests")), "GET /repos/acme/shop/pulls/84: 429 Too many requests"],
    ["a call GitHub never answered", new GitHubError("GitHub POST /graphql failed: fetch failed", 0, { body: "fetch failed", request: "POST /graphql" }), "POST /graphql: fetch failed"],
  ])("%s isn't refused: running it again may get through", (_case, error, detail) => {
    expect(inputsFailureReportFor(error)).toEqual({ failure: "unread-inputs", detail });
  });

  it("names a GraphQL query's errors by their messages", () => {
    const error = new GitHubError("GitHub GraphQL query failed", 403, {
      body: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }),
      request: "POST /graphql",
    });

    expect(inputsFailureReportFor(error)).toEqual({
      failure: "unread-inputs",
      detail: "POST /graphql: 403 Resource not accessible by integration",
      refused: true,
    });
  });

  it("reports nothing for an error that isn't a GitHub call's, which the push job reads as a crash", () => {
    expect(inputsFailureReportFor(new Error("FABRIK_ISSUE is not set"))).toBeNull();
  });
});
