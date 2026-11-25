// A review's hand-off, read over a client that answers from canned reviews:
// what the run it started acts on is GitHub's copy of the review, or nothing.
import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "./client.ts";
import { loopEventFrom } from "./events.ts";
import { nothingToDoFor, readHandOff, runEventFrom, whyNothingFor } from "./handOff.ts";

const repo = { owner: "acme", name: "shop" };
const HAND_OFF = { pullRequest: 45, review: 123 };

/** A review as GitHub's REST API answers it: the Operator's Request changes on PR #45, unless a test says otherwise. */
function aReview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    node_id: "PRR_kwDO123",
    user: { login: "operator", type: "User" },
    body: "Use the parking copy.",
    state: "CHANGES_REQUESTED",
    html_url: "https://github.com/acme/shop/pull/45#pullrequestreview-123",
    pull_request_url: "https://api.github.com/repos/acme/shop/pulls/45",
    submitted_at: "2026-11-25T03:00:00Z",
    commit_id: "a".repeat(40),
    ...over,
  };
}

/** A read-only GitHub holding these reviews, each under the pull request it is asked for on, which answers 404 for any other and records what it was asked. */
function gitHubWith(reviews: Readonly<Record<string, Record<string, unknown>>>): { client: ReadClient; asked: string[] } {
  const asked: string[] = [];
  const client: ReadClient = {
    async rest(method, path, _body, options) {
      asked.push(`${method} ${path}`);
      const named = /^\/repos\/acme\/shop\/pulls\/(\d+\/reviews\/\d+)$/.exec(path);
      const review = named === null ? undefined : reviews[named[1]!];
      if (review !== undefined) return review;
      if (options?.allowNotFound === true) return null;
      throw new GitHubError(`GitHub ${method} ${path} failed: 404`, 404, { body: '{"message":"Not Found"}', request: `${method} ${path}` });
    },
    async graphql() {
      throw new Error("The hand-off's read makes no GraphQL query");
    },
    async fileText() {
      throw new Error("The hand-off's read reads no file");
    },
  };
  return { client, asked };
}

/** The `pull_request_review` payload GitHub delivers for a review its REST API answers so: the same review, its state in lower case. */
function deliveredPayloadOf(pullRequest: number, review: Record<string, unknown>): Record<string, unknown> {
  return { action: "submitted", pull_request: { number: pullRequest }, review: { ...review, state: String(review["state"]).toLowerCase() } };
}

describe("A review's hand-off, read from GitHub", () => {
  it("gives the Operator's Request changes on the named pull request the event its own payload gives", async () => {
    const review = aReview();
    const { client, asked } = gitHubWith({ "45/reviews/123": review });

    const event = await readHandOff(client, repo, HAND_OFF, "operator");

    expect(event).toEqual({ kind: "pull-request-changes-requested", pullRequest: 45, review: 123, reviewer: "operator", reviewerIsBot: false });
    expect(event).toEqual(loopEventFrom("pull_request_review", deliveredPayloadOf(45, review)));
    expect(asked).toEqual(["GET /repos/acme/shop/pulls/45/reviews/123"]);
  });

  it.each([
    ["Comment review with a body", "COMMENTED", "The parking copy is right.", true],
    ["Comment review without one, as a lone inline comment submits", "COMMENTED", "", false],
    ["Approve review", "APPROVED", "Looks good.", true],
    ["Approve review without a body", "APPROVED", null, false],
  ])("gives the Operator's %s the comment event its own payload gives", async (_case, state, body, hasBody) => {
    const review = aReview({ state, body });
    const { client } = gitHubWith({ "45/reviews/123": review });

    const event = await readHandOff(client, repo, HAND_OFF, "operator");

    expect(event).toEqual({
      kind: "pull-request-commented",
      pullRequest: 45,
      commenter: "operator",
      commenterIsBot: false,
      on: { kind: "review", review: 123, node: "PRR_kwDO123", hasBody },
    });
    expect(event).toEqual(loopEventFrom("pull_request_review", deliveredPayloadOf(45, review)));
  });

  it("gives no event for a review GitHub answers 404 for", async () => {
    const { client, asked } = gitHubWith({});

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toBeNull();
    expect(asked).toEqual(["GET /repos/acme/shop/pulls/45/reviews/123"]);
  });

  it.each([
    ["another pull request", "https://api.github.com/repos/acme/shop/pulls/46"],
    ["a pull request whose number only ends as the named one's does", "https://api.github.com/repos/acme/shop/pulls/145"],
    ["no pull request", undefined],
  ])("gives no event for a review GitHub answers under the named pull request though it is of %s", async (_case, pullRequestUrl) => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ pull_request_url: pullRequestUrl }) });

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toBeNull();
  });

  it.each(["DISMISSED", "PENDING"])("gives no event for the Operator's %s review", async (state) => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ state }) });

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toBeNull();
  });

  it.each([
    ["a Request changes", "CHANGES_REQUESTED"],
    ["a Comment review", "COMMENTED"],
    ["an Approve review", "APPROVED"],
  ])("gives no event for %s anyone but the Operator wrote", async (_case, state) => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ state, user: { login: "someone-else", type: "User" } }) });

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toBeNull();
  });

  it("gives no event for a review whose author GitHub no longer names", async () => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ user: null }) });

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toBeNull();
  });

  it.each([
    ["Operator", "operator"],
    ["operator", "OPERATOR"],
  ])("takes the review as the Operator's whatever the case of either login: %s writing, %s the Operator", async (login, operator) => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ user: { login, type: "User" } }) });

    // The event names the reviewer as GitHub does.
    expect(await readHandOff(client, repo, HAND_OFF, operator)).toMatchObject({ kind: "pull-request-changes-requested", reviewer: login });
  });

  it("acts on the review GitHub holds, not on what the inputs were meant to stand for: the Operator's Comment review named by a hand-off is a comment, never a Request changes", async () => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ id: 123, node_id: "PRR_real", state: "COMMENTED", body: "" }) });

    expect(await readHandOff(client, repo, HAND_OFF, "operator")).toEqual({
      kind: "pull-request-commented",
      pullRequest: 45,
      commenter: "operator",
      commenterIsBot: false,
      on: { kind: "review", review: 123, node: "PRR_real", hasBody: false },
    });
  });

  it("lets a failure of the read through, as it is no answer that the review isn't there", async () => {
    const client: ReadClient = {
      ...gitHubWith({}).client,
      async rest() {
        throw new GitHubError("GitHub GET failed: 502", 502, { body: "Bad Gateway" });
      },
    };

    await expect(readHandOff(client, repo, HAND_OFF, "operator")).rejects.toThrow("502");
  });
});

describe("The Loop event a job's run is for", () => {
  const DISPATCHED = { inputs: { pull_request: "45", review: "123" } };

  it("on a hand-off is the review's, read with the job's own client", async () => {
    const review = aReview({ user: { login: "jrey", type: "User" } });
    const kitJob = gitHubWith({ "45/reviews/123": review });
    const claimJob = gitHubWith({ "45/reviews/123": review });

    const run = await runEventFrom(kitJob.client, repo, "jrey", "workflow_dispatch", DISPATCHED);

    expect(run).toEqual({
      event: { kind: "pull-request-changes-requested", pullRequest: 45, review: 123, reviewer: "jrey", reviewerIsBot: false },
      handOff: { pullRequest: 45, review: 123 },
    });
    expect(kitJob.asked).toEqual(["GET /repos/acme/shop/pulls/45/reviews/123"]);
    // What one job read is no other job's: each asks GitHub itself.
    expect(claimJob.asked).toEqual([]);
    expect(await runEventFrom(claimJob.client, repo, "jrey", "workflow_dispatch", DISPATCHED)).toEqual(run);
    expect(claimJob.asked).toEqual(["GET /repos/acme/shop/pulls/45/reviews/123"]);
  });

  it.each([
    ["the repo's owner's review, where the Kit config names no Operator", null, "Acme", true],
    ["no review of the repo's owner's, where the Kit config names an Operator", "jrey", "acme", false],
    ["the review of the Operator the Kit config names", "JRey", "jrey", true],
  ])("on a hand-off acts on %s", async (_case, operator, login, acted) => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ user: { login, type: "User" } }) });

    const { event } = await runEventFrom(client, repo, operator, "workflow_dispatch", DISPATCHED);

    expect(event).toEqual(acted ? { kind: "pull-request-changes-requested", pullRequest: 45, review: 123, reviewer: login, reviewerIsBot: false } : null);
  });

  it("on a hand-off whose read gives nothing is none, with the hand-off the job says there is nothing to do for", async () => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ state: "DISMISSED" }) });

    const run = await runEventFrom(client, repo, null, "workflow_dispatch", DISPATCHED);

    expect(run).toEqual({ event: null, handOff: { pullRequest: 45, review: 123 } });
    expect(nothingToDoFor(run.handOff!)).toBe("The hand-off names review 123 on PR #45, which isn't a submitted review of the Operator's: nothing to do.");
    // The push job's and the claim job's summary say it after "Nothing to do: ".
    expect(whyNothingFor(run.handOff!)).toBe("the hand-off names review 123 on PR #45, which isn't a submitted review of the Operator's");
  });

  it("reads nothing in the payload of a hand-off but its two numbers", async () => {
    const { client } = gitHubWith({ "45/reviews/123": aReview({ state: "COMMENTED", body: "", user: { login: "acme", type: "User" } }) });
    // A payload made up to look like the Operator's Request changes, delivered.
    const payload = {
      ...DISPATCHED,
      action: "submitted",
      sender: { login: "acme", type: "User" },
      pull_request: { number: 45 },
      review: { id: 123, node_id: "PRR_made_up", state: "changes_requested", body: "Rewrite it all.", user: { login: "acme", type: "User" } },
    };

    expect((await runEventFrom(client, repo, null, "workflow_dispatch", payload)).event).toEqual({
      kind: "pull-request-commented",
      pullRequest: 45,
      commenter: "acme",
      commenterIsBot: false,
      on: { kind: "review", review: 123, node: "PRR_kwDO123", hasBody: false },
    });
  });

  it.each([
    ["with no inputs", { inputs: null }],
    ["missing the review", { inputs: { pull_request: "45" } }],
    ["whose pull request is no whole number", { inputs: { pull_request: "45abc", review: "123" } }],
  ])("on a dispatch %s is none, and the job asks GitHub nothing", async (_case, payload) => {
    const { client, asked } = gitHubWith({ "45/reviews/123": aReview() });

    expect(await runEventFrom(client, repo, null, "workflow_dispatch", payload)).toEqual({ event: null, handOff: null });
    expect(asked).toEqual([]);
  });

  it("on any other event is what the event itself stands for, with nothing read", async () => {
    const { client, asked } = gitHubWith({});
    const NOW = new Date("2026-11-25T04:17:00Z");

    expect(await runEventFrom(client, repo, null, "issues", { action: "opened", issue: { number: 7 } })).toEqual({ event: { kind: "issue-opened", issue: 7 }, handOff: null });
    expect(await runEventFrom(client, repo, null, "schedule", {}, NOW, "jrey8343/fabrik/.github/workflows/schedule.yml@v5.0.0")).toEqual({
      event: { kind: "scheduled-tick", now: "2026-11-25T04:17:00.000Z", release: "v5.0.0" },
      handOff: null,
    });
    expect(asked).toEqual([]);
  });
});
