import { describe, expect, it } from "vitest";
import { GitHubError, refusalOf } from "./client.ts";

/** GitHub's JSON body for a refused call, with this message. */
const refused = (message: string) => JSON.stringify({ message, documentation_url: "https://docs.github.com/rest", status: "403" });

describe("Telling why GitHub refused a call", () => {
  it("tells a missing permission from GitHub's refusal of what the App's token isn't granted", () => {
    const error = new GitHubError("GET check-runs failed: 403", 403, { body: refused("Resource not accessible by integration") });

    expect(refusalOf(error)).toBe("missing-permission");
  });

  it("tells a rate limit by the requests left being 0, whatever the message says", () => {
    const error = new GitHubError("GET check-runs failed: 403", 403, {
      body: refused("Resource not accessible by integration"),
      rateLimitRemaining: "0",
    });

    expect(refusalOf(error)).toBe("rate-limited");
  });

  it.each([
    "API rate limit exceeded for installation ID 12345.",
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
  ])("tells a rate limit by a message naming one: %s", (message) => {
    const error = new GitHubError("GET check-runs failed: 403", 403, { body: refused(message), rateLimitRemaining: "4000" });

    expect(refusalOf(error)).toBe("rate-limited");
  });

  it("tells a 429 a rate limit", () => {
    expect(refusalOf(new GitHubError("GET check-runs failed: 429", 429))).toBe("rate-limited");
  });

  it.each([
    ["a 403 for anything else", new GitHubError("GET check-runs failed: 403", 403, { body: refused("Repository access blocked") })],
    ["a 404", new GitHubError("GET check-runs failed: 404", 404, { body: refused("Not Found") })],
    ["a 500", new GitHubError("GET check-runs failed: 500", 500)],
  ])("tells nothing from %s", (_case, error) => {
    expect(refusalOf(error)).toBeNull();
  });
});
