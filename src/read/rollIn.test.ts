import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { anOpenIssue, anOpenPullRequest, factsOf, homeFactsOf } from "./builders.ts";
import { modulesImporting } from "./importWalk.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";
import { type Row, rowsOf } from "./rows.ts";
import { readIssuesToRollIn } from "./rollIn.ts";

const APP = { __typename: "Bot", login: "fabrik-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };

/** What `jrey8343/shop` holds open on GitHub, as the read's queries read it. */
interface RawRepo {
  readonly issues?: readonly Record<string, unknown>[];
  readonly pullRequests?: readonly Record<string, unknown>[];
  /** How many nodes GitHub gives to a page. */
  readonly pageSize?: number;
}

/** A read-only client over `jrey8343/shop`'s open issues and open pull requests, a page at a time, recording each query it was asked. */
function repoWith(raw: RawRepo): { client: ReadClient; queries: string[] } {
  const queries: string[] = [];
  const size = raw.pageSize ?? 100;
  const paged = (nodes: readonly Record<string, unknown>[], after: unknown) => {
    const start = typeof after === "string" ? Number(after) : 0;
    const end = start + size;
    return { pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) }, nodes: nodes.slice(start, end) };
  };
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The read asks no REST")),
    fileText: () => Promise.reject(new Error("The read reads no file")),
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      queries.push(query);
      expect(variables).toMatchObject({ owner: "jrey8343", name: "shop" });
      if (query.includes("issues(states: OPEN")) return { repository: { issues: paged(raw.issues ?? [], variables["after"]) } } as T;
      if (query.includes("pullRequests(states: OPEN")) return { repository: { pullRequests: paged(raw.pullRequests ?? [], variables["after"]) } } as T;
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { client, queries };
}

/** Open issue `number`, the Operator's, titled for its number, opened `number` hours after 2026-11-01, with no labels or sub-issues unless a test says so. */
function aRawIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    createdAt: new Date(Date.parse("2026-11-01T00:00:00Z") + number * 3_600_000).toISOString(),
    author: OPERATOR,
    labels: { nodes: [] },
    subIssues: { nodes: [] },
    ...overrides,
  };
}

/** Agent pull request 50, the Fabrik App's from Ticket 7's branch, closing #7. */
function aRawPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 50, headRefName: "fabrik/ticket-7", author: APP, closingIssuesReferences: { nodes: [{ number: 7 }] }, ...overrides };
}

/** Agent pull request 50's row, its Ticket 7 open, as the rows give it, with these issues related and mentioning it. */
function aRow(overrides: Partial<Pick<Row, "related" | "mentions">> = {}): Row {
  const facts = homeFactsOf({ github: factsOf({ openIssues: [anOpenIssue({ number: 7 })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7 })] }) });
  const row = rowsOf(facts, null, null, null, "2026-11-09T12:00:00Z").find(({ standing }) => standing.pullRequest === 50);
  if (row === undefined) throw new Error("no row for #50");
  return { ...row, ...overrides };
}

const numbersOf = (read: Awaited<ReturnType<typeof readIssuesToRollIn>>) => (read === "unread" ? read : read.issues.map(({ issue }) => issue));

describe("the issues that can be rolled in by hand", () => {
  it("are the repo's open issues, newest first, each with its number and title", async () => {
    const { client } = repoWith({ issues: [aRawIssue(31), aRawIssue(33), aRawIssue(32)], pullRequests: [aRawPullRequest()] });

    const read = await readIssuesToRollIn(client, "jrey8343/shop", aRow());

    expect(read).toEqual({
      page: 1,
      issues: [
        { issue: 33, title: "Issue 33", mentions: false },
        { issue: 32, title: "Issue 32", mentions: false },
        { issue: 31, title: "Issue 31", mentions: false },
      ],
      more: false,
    });
  });

  describe("leave out", () => {
    it.each([
      ["an Audit", ["fabrik:audit"]],
      ["a Retro", ["fabrik:retro"]],
      ["a Monitor issue", ["fabrik:monitor"]],
      ["a Replay", ["fabrik:replay"]],
      ["a Kit-owned issue", ["fabrik:weekly-limit"]],
      ["a Flaky check issue", ["fabrik:flaky-check"]],
      ["a Map", ["wayfinder:map"]],
      ["a Decision", ["wayfinder:research"]],
    ])("%s", async (_kind, labels) => {
      const { client } = repoWith({ issues: [aRawIssue(31), aRawIssue(32, { labels: { nodes: labels.map((name) => ({ name })) } })], pullRequests: [aRawPullRequest()] });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([31]);
    });

    it("anything the Fabrik App filed, any bot when its login is not given, and only the App's when it is", async () => {
      const issues = [aRawIssue(31), aRawIssue(32, { author: APP }), aRawIssue(33, { author: { __typename: "Bot", login: "renovate" } })];
      const { client } = repoWith({ issues, pullRequests: [aRawPullRequest()] });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([31]);
      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow(), 1, "fabrik-app[bot]"))).toEqual([33, 31]);
    });

    it("a Spec", async () => {
      const spec = aRawIssue(32, { labels: { nodes: [{ name: "ready-for-agent" }] }, subIssues: { nodes: [{ number: 33 }] } });
      const { client } = repoWith({ issues: [aRawIssue(31), spec], pullRequests: [aRawPullRequest()] });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([31]);
    });

    it("the pull request's own Ticket", async () => {
      const { client } = repoWith({ issues: [aRawIssue(7, { labels: { nodes: [{ name: "ready-for-agent" }] } }), aRawIssue(31)], pullRequests: [aRawPullRequest()] });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([31]);
    });

    it("an issue with an open agent pull request of its own, and one an open Plain pull request closes", async () => {
      const { client } = repoWith({
        issues: [aRawIssue(31), aRawIssue(32), aRawIssue(33)],
        pullRequests: [
          aRawPullRequest(),
          aRawPullRequest({ number: 51, headRefName: "fabrik/ticket-32", closingIssuesReferences: { nodes: [{ number: 32 }] } }),
          aRawPullRequest({ number: 70, headRefName: "fix-prices", author: OPERATOR, closingIssuesReferences: { nodes: [{ number: 33 }] } }),
        ],
      });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([31]);
    });

    it("an issue already under related on the row, which has a card of its own", async () => {
      const { client } = repoWith({ issues: [aRawIssue(31), aRawIssue(32)], pullRequests: [aRawPullRequest()] });

      expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow({ related: [{ issue: 32, title: "Issue 32", kind: "candidate" }] })))).toEqual([31]);
    });
  });

  it("put the issues that mention the pull request first, marked, newest first, then the rest newest first", async () => {
    const { client } = repoWith({ issues: [31, 32, 33, 34, 35].map((number) => aRawIssue(number)), pullRequests: [aRawPullRequest()] });
    const row = aRow({ mentions: [{ issue: 31, title: "Issue 31" }, { issue: 33, title: "Issue 33" }] });

    const read = await readIssuesToRollIn(client, "jrey8343/shop", row);

    expect(read !== "unread" && read.issues).toEqual([
      { issue: 33, title: "Issue 33", mentions: true },
      { issue: 31, title: "Issue 31", mentions: true },
      { issue: 35, title: "Issue 35", mentions: false },
      { issue: 34, title: "Issue 34", mentions: false },
      { issue: 32, title: "Issue 32", mentions: false },
    ]);
  });

  it("leave out an issue that mentions the pull request but is of a kind never related", async () => {
    const { client } = repoWith({ issues: [aRawIssue(31), aRawIssue(32, { labels: { nodes: [{ name: "wayfinder:map" }] } })], pullRequests: [aRawPullRequest()] });

    const read = await readIssuesToRollIn(client, "jrey8343/shop", aRow({ mentions: [{ issue: 32, title: "Issue 32" }] }));

    expect(numbersOf(read)).toEqual([31]);
  });

  describe("come a page of 20 at a time", () => {
    // 45 issues, three of them mentioning the pull request, over GitHub pages of 10.
    const { client } = repoWith({ issues: Array.from({ length: 45 }, (_, i) => aRawIssue(101 + i)), pullRequests: [aRawPullRequest()], pageSize: 10 });
    const row = aRow({ mentions: [{ issue: 101, title: "Issue 101" }, { issue: 102, title: "Issue 102" }, { issue: 103, title: "Issue 103" }] });
    const newestFirst = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

    it("the first with the mentions, then the newest of the rest, saying there are more", async () => {
      const read = await readIssuesToRollIn(client, "jrey8343/shop", row);

      expect(read).toMatchObject({ page: 1, more: true });
      expect(numbersOf(read)).toEqual([103, 102, 101, ...newestFirst(145, 129)]);
    });

    it("the second continuing where the first stopped", async () => {
      const read = await readIssuesToRollIn(client, "jrey8343/shop", row, 2);

      expect(read).toMatchObject({ page: 2, more: true });
      expect(numbersOf(read)).toEqual(newestFirst(128, 109));
    });

    it("the last holding what is left, saying there are no more", async () => {
      const read = await readIssuesToRollIn(client, "jrey8343/shop", row, 3);

      expect(read).toMatchObject({ page: 3, more: false });
      expect(numbersOf(read)).toEqual(newestFirst(108, 104));
    });
  });

  describe("are unread, and the read does not throw", () => {
    it.each([
      ["refused for want of a permission", new GitHubError("GitHub GraphQL failed: 403", 403)],
      ["failed by GitHub", new GitHubError("GitHub GraphQL failed: 502", 502)],
      ["never answered", new GitHubError("GitHub GraphQL failed: fetch failed", 0)],
    ])("when a query is %s", async (_what, error) => {
      const { client } = repoWith({ issues: [aRawIssue(31)], pullRequests: [aRawPullRequest()] });
      const refusing: ReadClient = { ...client, graphql: (query, variables) => (query.includes("pullRequests(") ? Promise.reject(error) : client.graphql(query, variables)) };

      expect(await readIssuesToRollIn(refusing, "jrey8343/shop", aRow())).toBe("unread");
    });

    it("when a later page of the issues fails", async () => {
      const { client } = repoWith({ issues: Array.from({ length: 25 }, (_, i) => aRawIssue(101 + i)), pullRequests: [aRawPullRequest()], pageSize: 10 });
      const failing: ReadClient = { ...client, graphql: (query, variables) => (variables["after"] === "20" ? Promise.reject(new GitHubError("GitHub GraphQL failed: 502", 502)) : client.graphql(query, variables)) };

      expect(await readIssuesToRollIn(failing, "jrey8343/shop", aRow())).toBe("unread");
    });
  });

  it("ask only the pull request's own repo, for no connection inside a connection inside a connection, and no body or comments", async () => {
    const { client, queries } = repoWith({ issues: [aRawIssue(31)], pullRequests: [aRawPullRequest()] });

    await readIssuesToRollIn(client, "jrey8343/shop", aRow());

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.flatMap(threeDeepConnectionsIn)).toEqual([]);
    expect(queries.filter((query) => /\bbody\b|\bcomments\b/.test(query))).toEqual([]);
  });

  it("are none, and nothing is asked, for a row with no pull request", async () => {
    const { client, queries } = repoWith({ issues: [aRawIssue(31)] });
    const issueRow = { ...aRow(), standing: { ...aRow().standing, pullRequest: null } };

    expect(await readIssuesToRollIn(client, "jrey8343/shop", issueRow)).toEqual({ page: 1, issues: [], more: false });
    expect(queries).toEqual([]);
  });

  it("are read by no gather", () => {
    const gather = fileURLToPath(new URL("./gather.ts", import.meta.url));

    expect(modulesImporting("readIssuesToRollIn", gather, (path) => readFileSync(path, "utf8"))).toEqual([]);
  });

  it("list a Ticket still waiting for Dispatch, and an issue someone else opened", async () => {
    const waiting = aRawIssue(31, { labels: { nodes: [{ name: "ready-for-agent" }] } });
    const { client } = repoWith({ issues: [waiting, aRawIssue(32, { author: { __typename: "User", login: "kate" } })], pullRequests: [aRawPullRequest()] });

    expect(numbersOf(await readIssuesToRollIn(client, "jrey8343/shop", aRow()))).toEqual([32, 31]);
  });
});
