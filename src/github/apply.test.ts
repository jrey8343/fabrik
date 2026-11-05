import { describe, expect, it } from "vitest";
import type { Plan } from "../loop/types.ts";
import { applyPlan } from "./apply.ts";

const repo = { owner: "acme", name: "shop" };
const issues = "/repos/acme/shop/issues";

/**
 * A GitHub that records every REST call. Each existing issue's database id is
 * its number plus 1000; a created issue gets the next number from 100.
 */
function fakeGitHub() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let next = 100;
  return {
    calls,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      calls.push({ method, path, body });
      if (method === "POST" && path === issues) {
        const number = next++;
        return { number, id: number + 1000 };
      }
      const existing = new RegExp(`^${issues}/(\\d+)$`).exec(path);
      if (method === "GET" && existing !== null) return { number: Number(existing[1]), id: Number(existing[1]) + 1000 };
      if (method === "POST" && path.endsWith("/comments")) return { html_url: "https://github.com/acme/shop/issues/7#c" };
      return null;
    },
    async graphql(): Promise<never> {
      throw new Error("no GraphQL expected");
    },
  };
}

describe("Applying a plan that moves blocked-by edges onto new Tickets", () => {
  it("links a new Ticket to an existing blocker, and an existing issue to a new Ticket, by database id", async () => {
    const github = fakeGitHub();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "create-issue", key: "ticket:a", title: "A", body: "A.", labels: [], parent: null, blockedBy: [10] },
        {
          kind: "create-issue",
          key: "ticket:b",
          title: "B",
          body: "B.",
          labels: [],
          parent: null,
          blockedBy: [{ created: "ticket:a" }],
        },
        { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:b" } },
        { kind: "close-as-superseded", issue: 7, comment: ["Now ", { created: "ticket:b" }, "."] },
      ],
    };

    await applyPlan(github, repo, plan);

    const edges = github.calls
      .filter((call) => call.path.endsWith("/dependencies/blocked_by"))
      .map((call) => [call.path, call.body]);
    expect(edges).toEqual([
      [`${issues}/100/dependencies/blocked_by`, { issue_id: 1010 }],
      [`${issues}/101/dependencies/blocked_by`, { issue_id: 1100 }],
      [`${issues}/20/dependencies/blocked_by`, { issue_id: 1101 }],
    ]);
    const lastEdge = github.calls.findLastIndex((call) => call.path.endsWith("/dependencies/blocked_by"));
    const closing = github.calls.findIndex((call) => call.method === "PATCH" && call.path === `${issues}/7`);
    expect(lastEdge).toBeLessThan(closing);
  });

});

describe("Applying a plan that creates an issue", () => {
  it("assigns a created issue as it creates it, and assigns nobody when the action names no one", async () => {
    const github = fakeGitHub();
    const plan: Plan = {
      kind: "act",
      actions: [
        { kind: "create-issue", key: "ticket:a", title: "A", body: "A.", labels: [], parent: null, blockedBy: [] },
        {
          kind: "create-issue",
          key: "ticket:b",
          title: "B",
          body: "B.",
          labels: ["ready-for-human"],
          assignees: ["jrey"],
          parent: null,
          blockedBy: [],
        },
      ],
    };

    await applyPlan(github, repo, plan);

    expect(github.calls.filter((call) => call.path === issues).map((call) => call.body)).toStrictEqual([
      { title: "A", body: "A.", labels: [] },
      { title: "B", body: "B.", labels: ["ready-for-human"], assignees: ["jrey"] },
    ]);
  });
});

describe("Applying a 👀 reaction to an Operator comment", () => {
  /** A GitHub whose review 900 on PR 50 holds these inline comment ids, served 100 a page. */
  function gitHubWithReview(inlineComments: readonly number[]) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    return {
      calls,
      async rest(method: string, path: string, body?: unknown): Promise<unknown> {
        calls.push({ method, path, body });
        const page = /^\/repos\/acme\/shop\/pulls\/50\/reviews\/900\/comments\?per_page=100&page=(\d+)$/.exec(path);
        if (method === "GET" && page !== null) {
          const start = (Number(page[1]) - 1) * 100;
          return inlineComments.slice(start, start + 100).map((id) => ({ id }));
        }
        return null;
      },
      async graphql(): Promise<never> {
        throw new Error("no GraphQL expected");
      },
    };
  }

  const posts = (github: ReturnType<typeof gitHubWithReview>) =>
    github.calls.filter((call) => call.method === "POST").map(({ path, body }) => ({ path, body }));

  it("reacts to a conversation comment itself", async () => {
    const github = gitHubWithReview([]);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "conversation", comment: 7001 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual([
      { path: "/repos/acme/shop/issues/comments/7001/reactions", body: { content: "eyes" } },
    ]);
  });

  it("reacts to each inline comment of a review, on every page, and never to the review itself", async () => {
    const inline = Array.from({ length: 101 }, (_, i) => 8000 + i);
    const github = gitHubWithReview(inline);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual(
      inline.map((id) => ({ path: `/repos/acme/shop/pulls/comments/${id}/reactions`, body: { content: "eyes" } })),
    );
  });

  it("reacts to nothing for a review with no inline comments", async () => {
    const github = gitHubWithReview([]);
    const plan: Plan = {
      kind: "act",
      actions: [{ kind: "react", pullRequest: 50, on: { kind: "review", review: 900 }, content: "eyes" }],
    };

    await applyPlan(github, repo, plan);

    expect(posts(github)).toStrictEqual([]);
  });
});
