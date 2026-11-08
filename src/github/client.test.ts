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
const caught = (call: Promise<unknown>) => call.then(() => null, (error: unknown) => error);

describe("What a failed call throws", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const answering = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
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

    const error = await caught(new GitHub("token", undefined, { retryDelaysMs: [] }).rest("GET", "/repos/acme/shop/pulls/84"));

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 0, request: "GET /repos/acme/shop/pulls/84", body: "fetch failed" });
  });
});

// #421: a GitHub hiccup tries a call again once or twice before the job gives up, and only where a second try can't double a change.
describe("Trying a call GitHub failed again", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  /** Answers each fetch with the next of `answers` (a status, or "network" for a fetch that never answers), recording each request. */
  const answeringInTurn = (...answers: (number | "network" | { status: number; body: string; headers?: Record<string, string> })[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      if (answer === "network") throw new TypeError("fetch failed");
      const { status, body, headers } = typeof answer === "number" ? { status: answer, body: JSON.stringify({ ok: answer }), headers: {} } : answer;
      return new Response(status === 204 ? null : body, { status, headers });
    });
    return calls;
  };
  const secondaryLimit = {
    status: 403,
    body: JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }),
  };
  const github = () => new GitHub("token", "https://api.github.com", { retryDelaysMs: [0, 0] });

  it.each([
    ["a 502", 502],
    ["a 500", 500],
    ["a network error", "network" as const],
    ["a secondary rate limit", secondaryLimit],
  ])("tries a read again after %s, and returns what the next try got", async (_case, failure) => {
    const calls = answeringInTurn(failure, 200);

    await expect(github().rest("GET", "/repos/acme/shop/pulls/84")).resolves.toEqual({ ok: 200 });
    expect(calls).toHaveLength(2);
  });

  it("gives up after two more tries, throwing the last failure", async () => {
    const calls = answeringInTurn(503, 503, 502, 200);

    const error = await caught(github().rest("GET", "/repos/acme/shop/pulls/84"));

    expect(error).toMatchObject({ status: 502 });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["a 403 for a missing permission", { status: 403, body: JSON.stringify({ message: "Resource not accessible by integration" }) }],
    ["a 404", 404],
    ["a 422", 422],
    ["a primary rate limit", { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }), headers: { "x-ratelimit-remaining": "0" } }],
  ])("never tries %s again", async (_case, failure) => {
    const calls = answeringInTurn(failure, 200);

    await caught(github().rest("GET", "/repos/acme/shop/pulls/84"));

    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a 502", 502],
    ["a 503", 503],
    ["a secondary rate limit", secondaryLimit],
  ])("tries a write again after %s", async (_case, failure) => {
    const calls = answeringInTurn(failure, 201);

    await expect(github().rest("POST", "/repos/acme/shop/issues/12/comments", { body: "Hi" })).resolves.toEqual({ ok: 201 });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a 500, which may have made the change", 500],
    ["a network error, which may have made the change", "network" as const],
  ])("never tries a write again after %s", async (_case, failure) => {
    const calls = answeringInTurn(failure, 201);

    await caught(github().rest("POST", "/repos/acme/shop/issues/12/comments", { body: "Hi" }));

    expect(calls).toHaveLength(1);
  });

  it("tries a GraphQL query again as a read, and a mutation as a write", async () => {
    const data = { status: 200, body: JSON.stringify({ data: { viewer: { login: "fabrik" } } }) };
    const queryCalls = answeringInTurn(500, data);
    await expect(github().graphql("query { viewer { login } }", {})).resolves.toEqual({ viewer: { login: "fabrik" } });
    expect(queryCalls).toHaveLength(2);

    const mutationCalls = answeringInTurn(500, data);
    await caught(github().graphql("mutation Ready($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }", { id: "PR_1" }));
    expect(mutationCalls).toHaveLength(1);
  });

  it("tries a file read again", async () => {
    const calls = answeringInTurn(502, { status: 200, body: "{}" });

    await expect(github().fileText({ owner: "acme", name: "shop" }, ".fabrik/config.json", "main")).resolves.toBe("{}");
    expect(calls).toHaveLength(2);
  });
});
