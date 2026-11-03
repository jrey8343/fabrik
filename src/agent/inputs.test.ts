import { describe, expect, it } from "vitest";
import { readIssue, readPullRequest, type Reader } from "./inputs.ts";

const repo = { owner: "acme", name: "shop" };

function graphqlReturning(...pages: unknown[]): Reader {
  let call = 0;
  return {
    graphql: async <T>() => pages[call++] as T,
    rest: async () => {
      throw new Error("unexpected REST call");
    },
  };
}

const issuePage = (comments: string[], next: string | null) => ({
  repository: {
    issue: {
      number: 7,
      title: "Add a waitlist",
      body: "As a patient…",
      author: { login: "someone" },
      labels: { nodes: [{ name: "ready-for-agent" }] },
      parent: { number: 3, title: "Bookings", body: "The Spec" },
      comments: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        nodes: comments.map((body) => ({ author: { login: "operator" }, body, createdAt: "2026-11-01T00:00:00Z" })),
      },
    },
  },
});

describe("An agent job's inputs", () => {
  it("reads the issue as gh issue view shapes it, every comment across pages, and its parent Spec", async () => {
    const github = graphqlReturning(issuePage(["first"], "cursor"), issuePage(["second"], null));

    const { issue, spec } = await readIssue(github, repo, 7);

    expect(issue).toEqual({
      number: 7,
      title: "Add a waitlist",
      body: "As a patient…",
      author: { login: "someone" },
      labels: [{ name: "ready-for-agent" }],
      comments: [
        { author: { login: "operator" }, body: "first", createdAt: "2026-11-01T00:00:00Z" },
        { author: { login: "operator" }, body: "second", createdAt: "2026-11-01T00:00:00Z" },
      ],
    });
    expect(spec).toEqual({ number: 3, title: "Bookings", body: "The Spec" });
  });

  const pullRequest = {
    repository: {
      pullRequest: {
        number: 50,
        title: "Add a waitlist",
        body: "Closes #7",
        baseRefName: "main",
        headRefName: "fabrik/ticket-7",
        headRefOid: "a".repeat(40),
        comments: { nodes: [{ body: "<!-- fabrik:verdict … -->", author: { __typename: "Bot" } }] },
      },
    },
  };

  it("gives the Reviewer the PR without its comments, so earlier Verdicts don't steer it", async () => {
    expect(await readPullRequest(graphqlReturning(pullRequest), repo, 50, false)).toEqual({
      number: 50,
      title: "Add a waitlist",
      body: "Closes #7",
      baseRefName: "main",
      headRefName: "fabrik/ticket-7",
      headRefOid: "a".repeat(40),
    });
  });

  it("gives a retry the PR's body, to refresh, and its comments with their authors' kind, so only the Fabrik App's Verdicts count", async () => {
    expect(await readPullRequest(graphqlReturning(pullRequest), repo, 50, true)).toEqual({
      number: 50,
      title: "Add a waitlist",
      body: "Closes #7",
      comments: [{ body: "<!-- fabrik:verdict … -->", author: { __typename: "Bot" } }],
    });
  });
});
