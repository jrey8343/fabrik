import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import type { Week } from "../kit/weeklySummary.ts";
import { readOutcomes } from "./outcomes.ts";

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
 * A client over `owner/product` holding these issues and pull requests. It
 * answers a query for issues by number as GitHub's GraphQL does, a missing
 * one failing the whole answer as the Kit's client does, and a search for
 * merged pull requests with every merged one it holds, whatever its dates.
 */
function gitHubWith({ issues = [], pullRequests = [], failing }: { issues?: RawIssue[]; pullRequests?: RawPullRequest[]; failing?: GitHubError }): {
  client: ReadClient;
  calls: Calls;
} {
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
        expect(q).toContain("repo:owner/product");
        expect(q).toContain("is:pr");
        expect(q).toContain("is:merged");
        const nodes = pullRequests.filter((pullRequest) => pullRequest.mergedAt !== null);
        return { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
      }
      expect(variables).toMatchObject({ owner: "owner", name: "product" });
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
});
