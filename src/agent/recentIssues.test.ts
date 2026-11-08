import { describe, expect, it } from "vitest";
import { readRecentIssues, type Reader, type RecentIssueNode as Node } from "./inputs.ts";

const repo = { owner: "acme", name: "shop" };
const NOW = Date.parse("2026-11-08T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const anOpen = (number: number, createdDaysAgo: number, body = `Body of #${number}`): Node => ({
  number,
  title: `Issue ${number}`,
  body,
  createdAt: daysAgo(createdDaysAgo),
  updatedAt: daysAgo(createdDaysAgo),
  closedAt: null,
});
const aClosed = (number: number, createdDaysAgo: number, closedDaysAgo: number): Node => ({
  ...anOpen(number, createdDaysAgo),
  updatedAt: daysAgo(closedDaysAgo),
  closedAt: daysAgo(closedDaysAgo),
});

/**
 * A GitHub whose issues connection serves the open issues newest created
 * first and the closed ones latest updated first, as the queries order them,
 * `perPage` to a page. It records how many pages of each it served.
 */
function fakeGitHub(open: Node[], closed: Node[], perPage = 100) {
  const served = { OPEN: 0, CLOSED: 0 };
  const github: Reader = {
    graphql: async <T>(query: string, variables: Record<string, unknown>) => {
      const state = query.includes("states: CLOSED") ? "CLOSED" : "OPEN";
      const all = state === "OPEN" ? [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [...closed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = variables["after"] === null || variables["after"] === undefined ? 0 : Number(variables["after"]);
      const nodes = all.slice(start, start + perPage);
      served[state]++;
      const next = start + perPage;
      return { repository: { issues: { pageInfo: { hasNextPage: next < all.length, endCursor: String(next) }, nodes } } } as T;
    },
    rest: async () => {
      throw new Error("unexpected REST call");
    },
  };
  return { github, served };
}

describe("Triage's Recent issues", () => {
  it("holds the open issues and those closed in the last 30 days, newest created first, without the triaged issue", async () => {
    const { github } = fakeGitHub([anOpen(7, 0), anOpen(3, 20), anOpen(1, 400)], [aClosed(5, 10, 2), aClosed(2, 300, 29), aClosed(4, 60, 31)]);

    const recent = await readRecentIssues(github, repo, 7, NOW);

    expect(recent).toEqual([
      { number: 5, title: "Issue 5", state: "closed", body: "Body of #5" },
      { number: 3, title: "Issue 3", state: "open", body: "Body of #3" },
      { number: 2, title: "Issue 2", state: "closed", body: "Body of #2" },
      { number: 1, title: "Issue 1", state: "open", body: "Body of #1" },
    ]);
  });

  it("keeps the 50 most recently created", async () => {
    const open = Array.from({ length: 60 }, (_, i) => anOpen(i + 1, 60 - i));
    const { github, served } = fakeGitHub(open, [aClosed(100, 30.5, 1)], 20);

    const recent = await readRecentIssues(github, repo, 999, NOW);

    expect(recent.map(({ number }) => number)).toEqual([...Array.from({ length: 30 }, (_, i) => 60 - i), 100, ...Array.from({ length: 19 }, (_, i) => 30 - i)]);
    // 51 open issues are enough, whichever one is the triaged issue: the rest are older than 50 kept.
    expect(served.OPEN).toBe(3);
  });

  it("keeps an issue closed exactly 30 days ago, and stops reading closed issues once they were last updated before that", async () => {
    const closed = Array.from({ length: 10 }, (_, i) => aClosed(i + 1, 100, 26 + i));
    const { github, served } = fakeGitHub([], closed, 2);

    const recent = await readRecentIssues(github, repo, 999, NOW);

    expect(recent.map(({ number }) => number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(served.CLOSED).toBe(3);
  });

  it("cuts each body to 500 characters, marking the cut", async () => {
    const { github } = fakeGitHub([anOpen(1, 1, "é".repeat(501)), anOpen(2, 2, "a".repeat(500))], []);

    const [cut, whole] = await readRecentIssues(github, repo, 999, NOW);

    expect(cut?.body).toBe(`${"é".repeat(500)}…`);
    expect(whole?.body).toBe("a".repeat(500));
  });

  it("keeps the issues the Monitor filed, the likeliest originals of a person's report", async () => {
    const { github } = fakeGitHub([anOpen(4, 1, "TypeError in checkout\n\n<!-- fabrik:monitor {\"group\":\"4503\"} -->")], []);

    expect(await readRecentIssues(github, repo, 7, NOW)).toEqual([
      expect.objectContaining({ number: 4, body: expect.stringContaining("fabrik:monitor") }),
    ]);
  });
});
