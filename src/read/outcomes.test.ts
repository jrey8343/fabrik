import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { costPerMergedPullRequestOf } from "../kit/mergedCost.ts";
import { type Week, weeklySummary, weeksEndingAt } from "../kit/weeklySummary.ts";
import { aMergedPullRequest, aReplayRunRecord, aRunRecord, factsOf } from "./builders.ts";
import { readOutcomes } from "./outcomes.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";

const NOW = "2026-11-12T09:00:00Z";
/** The week of Monday 2 November 2026, in UTC. */
const WEEK: Week = { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-09T00:00:00Z"), monday: "2026-11-02" };
const APP = { __typename: "Bot", login: "fabrik-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };

/** A pull request as GitHub has it. */
interface RawPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  author: { __typename: string; login: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
}

/** An issue as GitHub has it, with the pull requests that name it. */
interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  author: { __typename: string; login: string } | null;
  labels: { nodes: { name: string }[] };
  subIssues: { nodes: { number: number }[] };
  timelineItems: { nodes: { __typename: string; createdAt: string; actor: unknown; label: { name: string } }[] };
}

/** Agent pull request `number` for Ticket `ticket`, opened by the Fabrik App from the Ticket's agent branch, open unless a test says so. */
function aPullRequest(number: number, ticket: number | null, overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number,
    url: `https://github.com/owner/product/pull/${number}`,
    state: "OPEN",
    createdAt: "2026-10-30T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    headRefName: `fabrik/ticket-${ticket ?? number}`,
    author: APP,
    closingIssuesReferences: { nodes: ticket === null ? [] : [{ number: ticket }] },
    ...overrides,
  };
}

/** `pullRequest`, merged at `at`. */
function merged(pullRequest: RawPullRequest, at: string): RawPullRequest {
  return { ...pullRequest, state: "MERGED", mergedAt: at, closedAt: at };
}

/** `pullRequest`, closed unmerged at `at`. */
function closed(pullRequest: RawPullRequest, at: string): RawPullRequest {
  return { ...pullRequest, state: "CLOSED", closedAt: at };
}

/** A label event on an issue's timeline. */
function labelled(label: string, at: string, typename = "LabeledEvent") {
  return { __typename: typename, createdAt: at, actor: OPERATOR, label: { name: label } };
}

/** Issue `number`, open, the Operator's, with these labels now and this label timeline. */
function anIssue(number: number, labels: string[] = [], overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/product/issues/${number}`,
    state: "OPEN",
    closedAt: null,
    author: OPERATOR,
    labels: { nodes: labels.map((name) => ({ name })) },
    subIssues: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

/** A Ticket: an issue that carried `ready-for-agent` from 2026-10-29. */
function aTicket(number: number, overrides: Partial<RawIssue> = {}): RawIssue {
  return anIssue(number, ["ready-for-agent"], { timelineItems: { nodes: [labelled("ready-for-agent", "2026-10-29T09:00:00Z")] }, ...overrides });
}

/** Every call a read made of the client. */
interface Calls {
  readonly queries: { query: string; variables: Record<string, unknown> }[];
}

/**
 * A client over `repo`, `owner/product` unless a test says so, holding these
 * issues and pull requests. It answers a query for issues by number as
 * GitHub's GraphQL does, a missing one failing the whole answer as the Kit's
 * client does, and a search for merged pull requests with every merged one it
 * holds, whatever its dates.
 */
function gitHubWith({
  repo = "owner/product",
  issues = [],
  pullRequests = [],
  failing,
}: {
  repo?: string;
  issues?: RawIssue[];
  pullRequests?: RawPullRequest[];
  failing?: GitHubError;
}): {
  client: ReadClient;
  calls: Calls;
} {
  const [owner, name] = repo.split("/");
  const calls: Calls = { queries: [] };
  const naming = (issue: number) => pullRequests.filter((pullRequest) => pullRequest.closingIssuesReferences.nodes.some((named) => named.number === issue));
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The outcomes read reads no REST")),
    fileText: () => Promise.reject(new Error("The outcomes read reads no file")),
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.queries.push({ query, variables });
      if (failing !== undefined) throw failing;
      if (query.includes("search(")) {
        const q = String(variables["q"]);
        expect(q).toContain(`repo:${repo} `);
        expect(q).toContain("is:pr");
        expect(q).toContain("is:merged");
        const nodes = pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null);
        return { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
      }
      expect(variables).toMatchObject({ owner, name });
      const asked = [...query.matchAll(/(\w+): issue\(number: (\d+)\)/g)].map(([, alias = "", number = ""]) => ({ alias, number: Number(number) }));
      const missing = asked.filter(({ number }) => !issues.some((issue) => issue.number === number));
      if (missing.length > 0) {
        const errors = missing.map(({ alias, number }) => ({
          type: "NOT_FOUND",
          path: ["repository", alias],
          message: `Could not resolve to an Issue with the number of ${number}.`,
        }));
        throw new GitHubError(`GitHub GraphQL query failed: ${JSON.stringify(errors)}`, 404, { body: JSON.stringify({ errors }), request: "POST /graphql" });
      }
      const repository = Object.fromEntries(
        asked.map(({ alias, number }) => {
          const issue = issues.find((held) => held.number === number);
          return [alias, { ...issue, closedByPullRequestsReferences: { nodes: naming(number) } }];
        }),
      );
      return { repository } as T;
    },
  };
  return { client, calls };
}

describe("the outcomes read", () => {
  it("reads a Ticket whose agent pull request merged as merged, with the pull request, when it merged and its page", async () => {
    const { client } = gitHubWith({ issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-04T10:00:00Z" })], pullRequests: [merged(aPullRequest(50, 7), "2026-11-04T10:00:00Z")] });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([
      { issue: 7, title: "Issue 7", is: "merged", pullRequest: 50, at: "2026-11-04T10:00:00Z", url: "https://github.com/owner/product/pull/50" },
    ]);
    expect(read).toMatchObject({ repo: "owner/product", readAt: NOW, unread: null });
  });

  it("reads an open Ticket as open, with its open pull request, or with none yet", async () => {
    const { client } = gitHubWith({ issues: [aTicket(7), aTicket(8)], pullRequests: [aPullRequest(50, 7)] });

    const read = await readOutcomes(client, "owner/product", WEEK, [7, 8], NOW);

    expect(read.work).toEqual([
      { issue: 7, title: "Issue 7", is: "open", pullRequest: 50, at: null, url: "https://github.com/owner/product/pull/50" },
      { issue: 8, title: "Issue 8", is: "open", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/8" },
    ]);
  });

  it("reads a Ticket closed with no merged agent pull request as never merged, with its newest closed pull request and when the Ticket closed", async () => {
    const { client } = gitHubWith({
      issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-06T10:00:00Z" })],
      pullRequests: [closed(aPullRequest(50, 7), "2026-11-01T10:00:00Z"), closed(aPullRequest(51, 7), "2026-11-05T10:00:00Z"), closed(aPullRequest(49, 7), "2026-10-31T10:00:00Z")],
    });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([
      { issue: 7, title: "Issue 7", is: "never-merged", pullRequest: 51, at: "2026-11-06T10:00:00Z", url: "https://github.com/owner/product/pull/51" },
    ]);
  });

  it.each([
    ["a Replay's issue", anIssue(30, ["fabrik:replay", "agent:replay"], { timelineItems: { nodes: [labelled("ready-for-agent", "2026-10-29T09:00:00Z")] } })],
    ["a Map", anIssue(30, ["wayfinder:map", "ready-for-agent"])],
    ["a Decision", anIssue(30, ["wayfinder:research", "ready-for-agent"])],
    ["a Spec", anIssue(30, ["ready-for-agent"], { subIssues: { nodes: [{ number: 31 }] } })],
    ["an issue in a Design session", anIssue(30, ["needs-design", "agent:design"])],
    ["a closed issue Triage never made a Ticket", anIssue(30, ["wontfix"], { state: "CLOSED", closedAt: "2026-11-03T10:00:00Z" })],
    ["a Retro", anIssue(30, ["fabrik:retro", "ready-for-agent"], { author: APP })],
    ["an issue the Fabrik App filed to be read", anIssue(30, ["fabrik:weekly-limit", "ready-for-agent"], { author: APP })],
    ["an Operator brief", anIssue(30, ["ready-for-human"])],
  ])("reads %s as no Ticket, with the issue's page", async (_, issue) => {
    const { client } = gitHubWith({ issues: [issue] });

    const read = await readOutcomes(client, "owner/product", WEEK, [30], NOW);

    expect(read.work).toEqual([{ issue: 30, title: "Issue 30", is: "not-a-ticket", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/30" }]);
  });

  it.each([
    [
      "a Ticket sent back to design",
      anIssue(7, ["needs-design"], {
        timelineItems: { nodes: [labelled("ready-for-agent", "2026-10-29T09:00:00Z"), labelled("ready-for-agent", "2026-11-03T09:00:00Z", "UnlabeledEvent"), labelled("needs-design", "2026-11-03T09:00:00Z")] },
      }),
    ],
    [
      "a Ticket now ready-for-human",
      anIssue(7, ["ready-for-human"], {
        timelineItems: { nodes: [labelled("ready-for-agent", "2026-10-29T09:00:00Z"), labelled("ready-for-agent", "2026-11-03T09:00:00Z", "UnlabeledEvent"), labelled("ready-for-human", "2026-11-03T09:00:00Z")] },
      }),
    ],
    ["a Ticket labelled as it was opened", anIssue(7, ["ready-for-agent"])],
    ["a Monitor issue that carried ready-for-agent", anIssue(7, ["fabrik:monitor", "bug", "ready-for-agent"], { author: APP })],
  ])("reads %s as a Ticket", async (_, issue) => {
    const { client } = gitHubWith({ issues: [issue] });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "open", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/7" }]);
  });

  it("reads an issue an agent pull request names as a Ticket, whatever its labels", async () => {
    const { client } = gitHubWith({ issues: [anIssue(7, ["needs-triage"])], pullRequests: [aPullRequest(50, 7)] });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "open", pullRequest: 50, at: null, url: "https://github.com/owner/product/pull/50" }]);
  });

  it("reads an issue only a Plain pull request names, or one that names it second, as no Ticket", async () => {
    const plain = aPullRequest(60, 30, { author: OPERATOR, headRefName: "fix-it" });
    const second = aPullRequest(61, 31, { closingIssuesReferences: { nodes: [{ number: 31 }, { number: 30 }] } });
    const { client } = gitHubWith({ issues: [anIssue(30)], pullRequests: [plain, second] });

    const read = await readOutcomes(client, "owner/product", WEEK, [30], NOW);

    expect(read.work).toEqual([{ issue: 30, title: "Issue 30", is: "not-a-ticket", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/30" }]);
  });

  it("reads a Ticket closed unmerged and reopened as open", async () => {
    const { client } = gitHubWith({ issues: [aTicket(7)], pullRequests: [closed(aPullRequest(50, 7), "2026-11-03T10:00:00Z")] });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "open", pullRequest: 50, at: null, url: "https://github.com/owner/product/pull/50" }]);
  });

  it("reads a Ticket with one agent pull request closed and another merged as merged, by the merged one", async () => {
    const { client } = gitHubWith({
      issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-05T10:00:00Z" })],
      pullRequests: [closed(aPullRequest(50, 7), "2026-11-03T10:00:00Z"), merged(aPullRequest(51, 7), "2026-11-05T10:00:00Z")],
    });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "merged", pullRequest: 51, at: "2026-11-05T10:00:00Z", url: "https://github.com/owner/product/pull/51" }]);
  });

  it("reads a Ticket merged after the week as merged, its time showing the merge fell outside the week", async () => {
    const { client } = gitHubWith({
      issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-10T10:00:00Z" })],
      pullRequests: [merged(aPullRequest(50, 7), "2026-11-10T10:00:00Z")],
    });

    const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

    expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "merged", pullRequest: 50, at: "2026-11-10T10:00:00Z", url: "https://github.com/owner/product/pull/50" }]);
    expect(read.merged).toEqual([]);
  });

  describe("the week's merged agent pull requests", () => {
    it("bring in a Ticket whose agent pull request merged in the week though it wasn't asked for, and not one merged outside the week", async () => {
      const { client } = gitHubWith({
        issues: [aTicket(7), aTicket(8, { state: "CLOSED", closedAt: "2026-11-04T10:00:00Z" }), aTicket(9, { state: "CLOSED", closedAt: "2026-11-10T10:00:00Z" })],
        pullRequests: [merged(aPullRequest(50, 8), "2026-11-04T10:00:00Z"), merged(aPullRequest(51, 9), "2026-11-10T10:00:00Z")],
      });

      const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

      expect(read.work).toEqual([
        { issue: 7, title: "Issue 7", is: "open", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/7" },
        { issue: 8, title: "Issue 8", is: "merged", pullRequest: 50, at: "2026-11-04T10:00:00Z", url: "https://github.com/owner/product/pull/50" },
      ]);
    });

    it("are every agent pull request merged in the week as the Weekly summary reads it, oldest first, one naming no Ticket and one naming an issue GitHub no longer has among them", async () => {
      const { client } = gitHubWith({
        issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-06T10:00:00Z" })],
        pullRequests: [
          merged(aPullRequest(52, 7), "2026-11-06T10:00:00Z"),
          merged(aPullRequest(50, null, { headRefName: "fabrik/ticket-5" }), "2026-11-02T00:00:00Z"),
          merged(aPullRequest(51, 404), "2026-11-03T10:00:00Z"),
          merged(aPullRequest(53, 8), "2026-11-09T00:00:00Z"),
          merged(aPullRequest(54, 8), "2026-11-01T23:59:59Z"),
          merged(aPullRequest(55, 30, { author: OPERATOR, headRefName: "fix-it" }), "2026-11-04T10:00:00Z"),
        ],
      });

      const read = await readOutcomes(client, "owner/product", WEEK, [], NOW);

      expect(read.merged).toEqual([
        { pullRequest: 50, ticket: null, mergedAt: "2026-11-02T00:00:00Z" },
        { pullRequest: 51, ticket: 404, mergedAt: "2026-11-03T10:00:00Z" },
        { pullRequest: 52, ticket: 7, mergedAt: "2026-11-06T10:00:00Z" },
      ]);
      expect(read.work).toEqual([{ issue: 7, title: "Issue 7", is: "merged", pullRequest: 52, at: "2026-11-06T10:00:00Z", url: "https://github.com/owner/product/pull/52" }]);
    });

    it("are searched for by the days around the week, a day wider each side", async () => {
      const { client, calls } = gitHubWith({});

      await readOutcomes(client, "owner/product", WEEK, [], NOW);

      expect(calls.queries.map(({ variables }) => variables["q"])).toEqual(["repo:owner/product is:pr is:merged merged:2026-11-01..2026-11-10"]);
    });
  });

  describe("an issue GitHub no longer has", () => {
    it("is left out of the work, the rest given, after the query is asked again without it", async () => {
      const { client, calls } = gitHubWith({ issues: [aTicket(7), aTicket(9)] });

      const read = await readOutcomes(client, "owner/product", WEEK, [7, 404, 9], NOW);

      expect(read.work).toEqual([
        { issue: 7, title: "Issue 7", is: "open", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/7" },
        { issue: 9, title: "Issue 9", is: "open", pullRequest: null, at: null, url: "https://github.com/owner/product/issues/9" },
      ]);
      expect(read.unread).toBeNull();
      const byNumber = calls.queries.filter(({ query }) => query.includes("issue(number:"));
      expect(byNumber).toHaveLength(2);
      expect(byNumber[1]?.query).not.toContain("issue(number: 404)");
    });

    it("leaves a read of nothing but missing issues with no work", async () => {
      const { client } = gitHubWith({});

      const read = await readOutcomes(client, "owner/product", WEEK, [404, 410], NOW);

      expect(read).toEqual({ repo: "owner/product", readAt: NOW, work: [], merged: [], unread: null });
    });
  });

  describe("what it asks GitHub", () => {
    it("asks for the numbers given and the Tickets of the week's merged agent pull requests, and nothing more", async () => {
      const { client, calls } = gitHubWith({
        issues: [aTicket(7), aTicket(8), aTicket(12)],
        pullRequests: [merged(aPullRequest(50, 8), "2026-11-04T10:00:00Z"), aPullRequest(51, 12)],
      });

      await readOutcomes(client, "owner/product", WEEK, [7, 7], NOW);

      const asked = calls.queries.flatMap(({ query }) => [...query.matchAll(/issue\(number: (\d+)\)/g)].map(([, number]) => Number(number)));
      expect(asked.toSorted((a, b) => a - b)).toEqual([7, 8]);
      expect(calls.queries.every(({ query }) => query.includes("search(") || query.includes("issue(number:"))).toBe(true);
    });

    it("asks for many issues 25 to a query", async () => {
      const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
      const { client, calls } = gitHubWith({ issues: numbers.map((number) => aTicket(number)) });

      const read = await readOutcomes(client, "owner/product", WEEK, numbers, NOW);

      expect(read.work).toHaveLength(30);
      expect(calls.queries.filter(({ query }) => query.includes("issue(number:")).map(({ query }) => query.match(/issue\(number:/g)?.length)).toEqual([25, 5]);
    });

    it("has no connection inside a connection inside a connection in any query", async () => {
      const { client, calls } = gitHubWith({ issues: [aTicket(7)], pullRequests: [merged(aPullRequest(50, 7), "2026-11-04T10:00:00Z")] });

      await readOutcomes(client, "owner/product", WEEK, [7], NOW);

      expect(calls.queries.length).toBeGreaterThanOrEqual(2);
      for (const { query } of calls.queries) expect(threeDeepConnectionsIn(query)).toEqual([]);
    });
  });

  describe("a read GitHub refuses or fails", () => {
    it("returns the work and the merged pull requests unread, with why", async () => {
      const refusal = new GitHubError("GitHub POST /graphql failed: 403", 403, {
        body: JSON.stringify({ message: "Resource not accessible by integration" }),
        request: "POST /graphql",
      });
      const { client } = gitHubWith({ issues: [aTicket(7)], failing: refusal });

      const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

      expect(read).toEqual({
        repo: "owner/product",
        readAt: NOW,
        work: "unread",
        merged: "unread",
        unread: "POST /graphql failed with 403: Resource not accessible by integration",
      });
    });

    it("returns a failure GitHub never answered unread, with why", async () => {
      const { client } = gitHubWith({ failing: new GitHubError("GitHub POST /graphql failed: socket hang up", 0, { body: "socket hang up", request: "POST /graphql" }) });

      const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

      expect(read).toMatchObject({ work: "unread", merged: "unread", unread: "POST /graphql got no answer from GitHub: GitHub POST /graphql failed: socket hang up" });
    });

    it("returns unread a query GitHub answers NOT_FOUND for the repo, not an issue", async () => {
      const notFound = new GitHubError("GitHub GraphQL query failed", 404, { body: JSON.stringify({ errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] }) });
      const { client } = gitHubWith({ failing: notFound });

      const read = await readOutcomes(client, "owner/product", WEEK, [7], NOW);

      expect(read).toMatchObject({ work: "unread", merged: "unread", unread: "A read of the outcomes failed with 404: Could not resolve to a Repository." });
    });
  });
});

describe("what a merged pull request cost, from the outcomes reads", () => {
  it("is the Weekly summary's figure for the same week and Run records across two repos, a pull request naming no Ticket among them", async () => {
    // Filed Monday 9 November 2026, 07:00 in Sydney: the week is 2026-11-01T13:00Z to 2026-11-08T13:00Z.
    const filedAt = "2026-11-08T20:00:00Z";
    const timeZone = "Australia/Sydney";
    const { thisWeek } = weeksEndingAt(Date.parse(filedAt), timeZone);
    const records = [
      aRunRecord({ runId: 1, repo: "owner/product", issue: 7, endedAt: "2026-10-28T00:00:00Z", totalCostUsd: 2 }),
      aRunRecord({ runId: 2, repo: "owner/product", issue: 7, role: "review", endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 0.5 }),
      aRunRecord({ runId: 3, repo: "owner/product", issue: 7, endedAt: "2026-11-09T00:00:00Z", totalCostUsd: 50 }),
      aReplayRunRecord({ runId: 4, repo: "owner/product", issue: 7, endedAt: "2026-11-03T00:00:00Z", totalCostUsd: 40 }),
      aRunRecord({ runId: 5, repo: "owner/other", issue: 7, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 3 }),
      aRunRecord({ runId: 6, repo: "owner/other", issue: 8, role: "triage", endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 9 }),
      aRunRecord({ runId: 7, repo: "owner/other", issue: 9, endedAt: "2026-11-04T00:00:00Z", totalCostUsd: 9 }),
    ];
    const github = {
      "owner/product": {
        issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-05T00:00:00Z" })],
        pullRequests: [merged(aPullRequest(50, 7), "2026-11-05T00:00:00Z"), merged(aPullRequest(51, null, { headRefName: "fabrik/ticket-51" }), "2026-11-06T00:00:00Z")],
      },
      "owner/other": {
        issues: [aTicket(7, { state: "CLOSED", closedAt: "2026-11-04T06:00:00Z" }), aTicket(8, { state: "CLOSED", closedAt: "2026-11-04T07:00:00Z" }), aTicket(9)],
        pullRequests: [merged(aPullRequest(60, 7), "2026-11-04T06:00:00Z"), merged(aPullRequest(61, 8), "2026-11-04T07:00:00Z"), merged(aPullRequest(62, 9), "2026-11-08T14:00:00Z")],
      },
    };
    const summary = weeklySummary({
      records,
      unreadableRecords: { count: 0, newestSchema: null },
      scoreFiles: [],
      facts: Object.entries(github).map(([repo, { pullRequests }]) =>
        factsOf({
          repo,
          pullRequests: pullRequests.map(({ number, mergedAt, closingIssuesReferences }) =>
            aMergedPullRequest(mergedAt ?? "", { number, ticket: closingIssuesReferences.nodes[0]?.number ?? null }),
          ),
        }),
      ),
      unread: [],
      health: [],
      kits: [],
      operator: "jrey8343",
      appLogin: "fabrik-app[bot]",
      timeZone,
      now: filedAt,
    });

    const reads = await Promise.all(
      Object.entries(github).map(([repo, held]) => {
        const named = [...new Set(records.filter((record) => record.repo === repo).map(({ issue }) => issue))];
        return readOutcomes(gitHubWith({ repo, ...held }).client, repo, thisWeek, named, filedAt);
      }),
    );
    const pullRequests = reads.flatMap(({ repo, merged: read }) => (read === "unread" ? [] : read.map(({ ticket }) => ({ repo, ticket }))));
    const figure = costPerMergedPullRequestOf(thisWeek, records, pullRequests);

    expect(summary.kind).toBe("summary");
    const weekly = summary.kind === "summary" ? summary.summary.costPerMergedPullRequest.thisWeek : null;
    // owner/product: Ticket 7 $2.50, PR 51 nothing; owner/other: Ticket 7 $3, Ticket 8 nothing (only Triage).
    expect(figure).toEqual({ usd: 5.5 / 4, unknownCost: 0, merged: 4 });
    expect({ usd: figure.usd, unknownCost: figure.unknownCost }).toEqual(weekly);
  });
});
