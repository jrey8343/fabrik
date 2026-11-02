import { describe, expect, it } from "vitest";
import { checkInitMessage } from "./meteredBilling.ts";

/** A `system/init` stream-json message, trimmed to the fields that matter here. */
function initMessage(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    model: "claude-sonnet-5-5",
    session_id: "session-fixture",
    ...fields,
  };
}

describe("the stream's init check", () => {
  it("passes an init message whose API key source is none", () => {
    expect(checkInitMessage(initMessage())).toEqual({ kind: "pass" });
  });

  it.each(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key", "user", "oauth"])(
    "refuses an API key source of %s, naming it",
    (source) => {
      expect(checkInitMessage(initMessage({ apiKeySource: source }))).toEqual({
        kind: "refuse",
        failure: "infrastructure",
        routes: [`the stream's init message reports API key source "${source}", not "none"`],
      });
    },
  );

  it("refuses an init message with no API key source", () => {
    const { apiKeySource: _omitted, ...message } = initMessage();

    expect(checkInitMessage(message)).toEqual({
      kind: "refuse",
      failure: "infrastructure",
      routes: [`the stream's init message reports API key source undefined, not "none"`],
    });
  });

  it("refuses an API key source that is not a string", () => {
    expect(checkInitMessage(initMessage({ apiKeySource: null }))).toEqual({
      kind: "refuse",
      failure: "infrastructure",
      routes: [`the stream's init message reports API key source null, not "none"`],
    });
  });

  it.each([
    ["another stream message", { type: "system", subtype: "api_retry", apiKeySource: "none" }],
    ["a non-object", "none"],
    ["nothing", undefined],
  ])("refuses %s in place of the init message", (_what, message) => {
    expect(checkInitMessage(message)).toEqual({
      kind: "refuse",
      failure: "infrastructure",
      routes: ["the stream's init message is missing or malformed, so it can't be checked"],
    });
  });
});
