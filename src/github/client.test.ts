import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHub, GitHubError, refusalOf } from "./client.ts";

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

// #328: the input step tells a refusal from GitHub's own failure, whichever call it made.
describe("What a failed call throws", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const answering = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  const caught = (call: Promise<unknown>) => call.then(() => null, (error: unknown) => error);
  const repo = { owner: "acme", name: "shop" };

  it("a REST call: a GitHubError naming the request, with GitHub's status and body", async () => {
    answering(403, { message: "Resource not accessible by integration" });

    const error = await caught(new GitHub("token").rest("GET", "/repos/acme/shop/pulls/84"));

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 403, request: "GET /repos/acme/shop/pulls/84", body: expect.stringContaining("Resource not accessible") });
  });

  it.each([
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["RATE_LIMITED", 429],
    [undefined, 502],
  ])("a GraphQL query whose error is typed %s: a GitHubError with status %i", async (type, status) => {
    answering(200, { data: null, errors: [{ ...(type === undefined ? {} : { type }), message: "No." }] });

    const error = await caught(new GitHub("token").graphql("query { viewer { login } }", {}));

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status, request: "POST /graphql", message: expect.stringContaining("GitHub GraphQL query failed") });
  });

  it("a file read: a GitHubError naming the path and ref", async () => {
    answering(403, { message: "Resource not accessible by integration" });

    const error = await caught(new GitHub("token").fileText(repo, ".fabrik/config.json", "main"));

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 403, request: "GET .fabrik/config.json@main" });
  });

  it("a call GitHub never answered: a GitHubError with status 0, naming the request and why", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const error = await caught(new GitHub("token").rest("GET", "/repos/acme/shop/pulls/84"));

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 0, request: "GET /repos/acme/shop/pulls/84", body: "fetch failed" });
  });
});
