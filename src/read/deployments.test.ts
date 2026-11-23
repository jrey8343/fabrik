import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { type DeployOf, readDeployments } from "./deployments.ts";

const NOW = "2026-11-12T10:00:00Z";
const sha = (digit: string) => digit.repeat(40);

/** One report on a Deployment, by the state GitHub's REST API names it with, which its GraphQL API names in capitals. */
interface CannedReport {
  readonly state: string;
  readonly at: string;
  readonly log?: string;
}

/**
 * A Deployment as the repo holds it, its reports oldest first; or a
 * GitHubError for reports that could not be read: more of them than a page
 * holds, and the query for the rest refused.
 */
interface CannedDeployment {
  readonly id: number;
  readonly sha: string;
  readonly environment?: string;
  readonly createdAt: string;
  readonly reports?: readonly CannedReport[] | GitHubError;
}

/** What the repo holds: its Deployments, or a GitHubError failing the query that lists them, and how GitHub compares a merge commit with a deployed one. */
interface CannedRepo {
  readonly deployments: readonly CannedDeployment[] | GitHubError;
  /** By `merge...deployed`; a pair left out is `diverged`. */
  readonly compare?: Readonly<Record<string, string | GitHubError>>;
}

/** A GraphQL query a read made: what it read, a page of the environment's Deployments or of one Deployment's reports, and its variables. */
interface Query {
  readonly of: "deployments" | "reports";
  readonly variables: Record<string, unknown>;
}

/** What a query reads, by its shape: a Deployment's reports, asked by its node id, or else a page of the environment's Deployments. */
const queried = (query: string): Query["of"] => (/\bnode\(id: \$id\)/.test(query) ? "reports" : "deployments");

/** What a read asked: each REST path, and each GraphQL query. */
type Asking = Pick<ReadClient, "rest" | "graphql"> & { readonly calls: string[]; readonly queries: Query[] };

const refusal = (request: string) =>
  new GitHubError(`GitHub ${request} failed: 403`, 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request });

/** The refusal of a GraphQL query. */
const QUERY_REFUSED = refusal("POST /graphql");

/**
 * A made-up `owner/product` holding `repo`, answering as GitHub does: by
 * GraphQL, a connection of the environment's Deployments, newest first, each
 * with a connection of its reports, newest first, and a Deployment's reports
 * by its node id, each connection giving as many at a time as the query asks
 * for first, from its cursor, which here is how many came before; by REST,
 * the comparison of two commits. Every REST path and every query asked is
 * kept.
 */
function repoWith(repo: CannedRepo): Asking {
  const calls: string[] = [];
  const queries: Query[] = [];
  const held = () => repo.deployments as readonly CannedDeployment[];
  /** A Deployment's reports newest first, as GraphQL gives them; one whose reports can't be read has more than a page, of which only the first is given. */
  const reportsOf = (deployment: CannedDeployment) =>
    (deployment.reports instanceof GitHubError ? Array.from({ length: 101 }, (): CannedReport => ({ state: "in_progress", at: deployment.createdAt })) : (deployment.reports ?? []))
      .map((report) => ({ state: report.state.toUpperCase(), createdAt: report.at, logUrl: report.log ?? null }))
      .toReversed();
  return {
    calls,
    queries,
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      calls.push(path);
      const url = new URL(path, "https://api.github.com");
      const compare = /^\/repos\/owner\/product\/compare\/([0-9a-f]{40}\.\.\.[0-9a-f]{40})$/.exec(url.pathname);
      if (compare !== null) {
        const status = repo.compare?.[compare[1]!] ?? "diverged";
        if (status instanceof GitHubError) throw status;
        return { status, ahead_by: status === "ahead" ? 1 : 0, behind_by: 0, total_commits: 0, commits: [], files: [] };
      }
      throw new Error(`unexpected ${path}`);
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const answer = (data: unknown) => data as T;
      const first = (connection: string) => Number(new RegExp(`\\b${connection}\\([^)]*first: (\\d+)`).exec(query)?.[1]);
      const paged = <N>(nodes: readonly N[], size: number, after: unknown) => {
        const from = Number(after ?? 0);
        const to = from + size;
        return { pageInfo: { hasNextPage: to < nodes.length, endCursor: to < nodes.length ? String(to) : null }, nodes: nodes.slice(from, to) };
      };
      if (/\bdeployments\(/.test(query)) {
        queries.push({ of: queried(query), variables });
        expect(variables).toMatchObject({ owner: "owner", name: "product" });
        expect(query).toMatch(/orderBy: \{ field: CREATED_AT, direction: DESC \}/);
        // GitHub lists only the environment the query names, so a query that names none would list every environment's.
        expect(query).toContain("environments: [$environment]");
        if (repo.deployments instanceof GitHubError) throw repo.deployments;
        const listed = held()
          .filter((deployment) => (deployment.environment ?? "production") === variables["environment"])
          .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)
          .map((deployment) => ({
            id: `DE_${deployment.id}`,
            databaseId: deployment.id,
            commitOid: deployment.sha,
            ref: { name: "main" },
            environment: deployment.environment ?? "production",
            createdAt: deployment.createdAt,
            statuses: paged(reportsOf(deployment), first("statuses"), null),
          }));
        return answer({ repository: { deployments: paged(listed, first("deployments"), variables["after"]) } });
      }
      if (queried(query) === "reports") {
        queries.push({ of: queried(query), variables });
        const deployment = held().find(({ id }) => `DE_${id}` === variables["id"]);
        if (deployment === undefined) return answer({ node: null });
        if (deployment.reports instanceof GitHubError) throw deployment.reports;
        return answer({ node: { statuses: paged(reportsOf(deployment), first("statuses"), variables["after"]) } });
      }
      throw new Error(`unexpected query ${query}`);
    },
  };
}

/** A client that fails the test if anything is asked of it; every REST path and query it was asked is kept. */
function askingNothing(): Asking {
  const calls: string[] = [];
  const queries: Query[] = [];
  return {
    calls,
    queries,
    rest(_method: string, path: string): Promise<unknown> {
      calls.push(path);
      return Promise.reject(new Error(`asked ${path}`));
    },
    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      queries.push({ of: queried(query), variables });
      return Promise.reject(new Error("asked a query"));
    },
  };
}

/** How `merge` stands in `read`, failing the test when it is unread or missing. */
function deployOf(read: { readonly merges: Readonly<Record<string, DeployOf | "unread">> }, merge: string): DeployOf {
  const answer = read.merges[merge];
  if (answer === undefined || answer === "unread") throw new Error(`merge ${merge} was ${answer ?? "not asked about"}`);
  return answer;
}

const MERGED_AT = "2026-11-12T08:00:00Z";
const NONE: DeployOf = { is: "none", deployment: null, commit: null, at: null, log: null };

/** The read of one merge of `sha("a")` at MERGED_AT. */
const readOne = (client: Pick<ReadClient, "rest" | "graphql">) => readDeployments(client, "owner/product", "production", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW);

describe("The Deployments read", () => {
  it("makes no request when asked about no merges, and answers for none", async () => {
    const client = askingNothing();
    const read = await readDeployments(client, "owner/product", "production", [], NOW);
    expect(client.calls).toEqual([]);
    expect(client.queries).toEqual([]);
    expect(read).toEqual({ repo: "owner/product", environment: "production", readAt: NOW, merges: {} });
  });

  it("gives a successful Deployment of the merge commit itself as succeeded, with the Deployment, its commit and the time of the success", async () => {
    const client = repoWith({
      deployments: [
        { id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "in_progress", at: "2026-11-12T08:02:10Z" }, { state: "success", at: "2026-11-12T08:05:00Z" }] },
      ],
    });
    const read = await readOne(client);
    expect(read).toEqual({
      repo: "owner/product",
      environment: "production",
      readAt: NOW,
      merges: { [sha("a")]: { is: "succeeded", deployment: 7, commit: sha("a"), at: "2026-11-12T08:05:00Z", log: null } },
    });
    expect(client.calls.some((path) => path.includes("/compare/"))).toBe(false);
  });

  describe("which deploys count for a merge", () => {
    it("counts a successful Deployment of a later commit that contains the merge commit, GitHub's comparison saying ahead", async () => {
      const client = repoWith({
        deployments: [{ id: 8, sha: sha("b"), createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:34:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 8, commit: sha("b"), at: "2026-11-12T08:34:00Z", log: null });
      expect(client.calls).toContain(`/repos/owner/product/compare/${sha("a")}...${sha("b")}?per_page=1`);
    });

    it("counts one GitHub calls identical", async () => {
      const client = repoWith({
        deployments: [{ id: 8, sha: sha("b"), createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:34:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "identical" },
      });
      expect(deployOf(await readOne(client), sha("a")).is).toBe("succeeded");
    });

    it.each(["behind", "diverged"])("does not count a Deployment of a commit that does not contain the merge commit, the comparison saying %s", async (status) => {
      const client = repoWith({
        deployments: [{ id: 8, sha: sha("b"), createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:34:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: status },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual(NONE);
    });

    it("never counts a Deployment created before the merge, and asks no comparison for it", async () => {
      const client = repoWith({
        deployments: [
          { id: 6, sha: sha("c"), createdAt: "2026-11-12T08:00:00Z", reports: [{ state: "success", at: "2026-11-12T08:03:00Z" }] },
          { id: 5, sha: sha("b"), createdAt: "2026-11-12T07:59:59Z", reports: [{ state: "success", at: "2026-11-12T08:03:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "diverged" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual(NONE);
      expect(client.calls.filter((path) => path.includes("/compare/"))).toEqual([`/repos/owner/product/compare/${sha("a")}...${sha("c")}?per_page=1`]);
    });

    it("counts one created at the very moment of the merge", async () => {
      const client = repoWith({ deployments: [{ id: 6, sha: sha("a"), createdAt: MERGED_AT, reports: [{ state: "success", at: "2026-11-12T08:03:00Z" }] }] });
      expect(deployOf(await readOne(client), sha("a")).is).toBe("succeeded");
    });

    it("is none with no Deployment in the environment since the merge", async () => {
      const client = repoWith({ deployments: [] });
      expect(await readOne(client)).toEqual({ repo: "owner/product", environment: "production", readAt: NOW, merges: { [sha("a")]: NONE } });
    });

    it("never reads Deployments in another environment as this one's, and asks GitHub for this one's only", async () => {
      const client = repoWith({
        deployments: [{ id: 9, sha: sha("a"), environment: "staging", createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:05:00Z" }] }],
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual(NONE);
      expect(client.queries).toEqual([{ of: "deployments", variables: expect.objectContaining({ environment: "production" }) }]);
    });

    it("drops a Deployment of another environment that GitHub's list holds all the same", async () => {
      const none = { hasNextPage: false, endCursor: null };
      const staging = { id: "DE_9", databaseId: 9, commitOid: sha("a"), environment: "staging", createdAt: "2026-11-12T08:02:00Z", statuses: { pageInfo: none, nodes: [{ state: "SUCCESS", createdAt: "2026-11-12T08:05:00Z", logUrl: null }] } };
      const listing: Pick<ReadClient, "rest" | "graphql"> = {
        rest: (_method, path) => Promise.reject(new Error(`asked ${path}`)),
        graphql: <T>() => Promise.resolve({ repository: { deployments: { pageInfo: none, nodes: [staging] } } } as T),
      };
      expect(deployOf(await readOne(listing), sha("a"))).toEqual(NONE);
    });

    it("names the environment as a query value, whatever its name", async () => {
      const client = repoWith({
        deployments: [{ id: 9, sha: sha("a"), environment: "prod & eu", createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:05:00Z" }] }],
      });
      const read = await readDeployments(client, "owner/product", "prod & eu", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW);
      expect(deployOf(read, sha("a")).is).toBe("succeeded");
      expect(client.queries).toEqual([{ of: "deployments", variables: expect.objectContaining({ environment: "prod & eu" }) }]);
    });

    it("asks each pair of merge and deployed commit once in a read, and none for the same commit", async () => {
      const report = [{ state: "success", at: "2026-11-12T09:10:00Z" }];
      const client = repoWith({
        deployments: [
          { id: 10, sha: sha("b"), createdAt: "2026-11-12T09:00:00Z", reports: report },
          { id: 11, sha: sha("b"), createdAt: "2026-11-12T09:05:00Z", reports: report },
          { id: 12, sha: sha("a"), createdAt: "2026-11-12T08:30:00Z", reports: report },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      await readOne(client);
      expect(client.calls.filter((path) => path.includes("/compare/"))).toEqual([`/repos/owner/product/compare/${sha("a")}...${sha("b")}?per_page=1`]);
    });

    it("asks no comparison once the merge commit's own deploy has decided it, for no later deploy could succeed sooner", async () => {
      const client = repoWith({
        deployments: [
          { id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:05:00Z" }, { state: "inactive", at: "2026-11-12T08:34:00Z" }] },
          { id: 8, sha: sha("b"), createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:34:00Z" }] },
          { id: 9, sha: sha("c"), createdAt: "2026-11-12T09:30:00Z", reports: [{ state: "in_progress", at: "2026-11-12T09:31:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 7, commit: sha("a"), at: "2026-11-12T08:05:00Z", log: null });
      expect(client.calls.filter((path) => path.includes("/compare/"))).toEqual([]);
    });

    it("still asks about a Deployment whose reports could not be read when it was created before the deciding success", async () => {
      const client = repoWith({
        deployments: [
          { id: 6, sha: sha("b"), createdAt: "2026-11-12T08:01:00Z", reports: QUERY_REFUSED },
          { id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:05:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "behind" },
      });
      expect(deployOf(await readOne(client), sha("a")).deployment).toBe(7);
      expect(client.calls.filter((path) => path.includes("/compare/"))).toEqual([`/repos/owner/product/compare/${sha("a")}...${sha("b")}?per_page=1`]);
    });
  });

  describe("what a Deployment is, from its reports", () => {
    /** The read of one Deployment of the merge commit, created two minutes after the merge, with these reports. */
    const readWith = (reports: readonly CannedReport[]) =>
      readOne(repoWith({ deployments: [{ id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports }] }));

    it("is succeeded when a success has since gone inactive, as GitHub turns it when a later deploy succeeds", async () => {
      const read = await readWith([
        { state: "success", at: "2026-11-12T08:05:00Z" },
        { state: "inactive", at: "2026-11-12T09:00:00Z" },
      ]);
      expect(deployOf(read, sha("a"))).toEqual({ is: "succeeded", deployment: 7, commit: sha("a"), at: "2026-11-12T08:05:00Z", log: null });
    });

    it("is passed over when it went inactive without ever succeeding", async () => {
      const read = await readWith([
        { state: "in_progress", at: "2026-11-12T08:03:00Z" },
        { state: "inactive", at: "2026-11-12T09:00:00Z" },
      ]);
      expect(deployOf(read, sha("a"))).toEqual(NONE);
    });

    it("is running with no report yet, at the Deployment's creation", async () => {
      expect(deployOf(await readWith([]), sha("a"))).toEqual({ is: "running", deployment: 7, commit: sha("a"), at: "2026-11-12T08:02:00Z", log: null });
    });

    // `waiting` is the first report GitHub makes on a deploy from an Actions job while the environment's protection rules are weighed.
    it.each(["queued", "in_progress", "pending", "waiting"])("is running when its latest report is %s", async (state) => {
      const read = await readWith([{ state, at: "2026-11-12T08:03:00Z" }]);
      expect(deployOf(read, sha("a"))).toEqual({ is: "running", deployment: 7, commit: sha("a"), at: "2026-11-12T08:02:00Z", log: null });
    });

    it.each(["failure", "error"])("is failed when its latest report is %s, with its time and its log's address", async (state) => {
      const read = await readWith([
        { state: "in_progress", at: "2026-11-12T08:03:00Z" },
        { state, at: "2026-11-12T08:09:00Z", log: "https://github.com/owner/product/actions/runs/40/job/41" },
      ]);
      expect(deployOf(read, sha("a"))).toEqual({ is: "failed", deployment: 7, commit: sha("a"), at: "2026-11-12T08:09:00Z", log: "https://github.com/owner/product/actions/runs/40/job/41" });
    });

    it.each(["http://deploys.example.com/40", "javascript:alert(1)", "not an address", ""])("gives a log address that is not https, %j, as null", async (log) => {
      const read = await readWith([{ state: "failure", at: "2026-11-12T08:09:00Z", log }]);
      expect(deployOf(read, sha("a")).log).toBeNull();
    });

    // GitHub gives a Deployment's reports newest first, so of two made in the same second the later is given first, and is the latest.
    it.each([
      ["failure", "inactive", "none"],
      ["inactive", "failure", "failed"],
    ])("is read by the later of two reports made in the same second, %s then %s, as %s", async (earlier, later, is) => {
      const read = await readWith([
        { state: earlier, at: "2026-11-12T08:09:00Z" },
        { state: later, at: "2026-11-12T08:09:00Z" },
      ]);
      expect(deployOf(read, sha("a")).is).toBe(is);
    });

    it("is running again when a failed one is retried and its latest report is in progress", async () => {
      const read = await readWith([
        { state: "failure", at: "2026-11-12T08:09:00Z" },
        { state: "in_progress", at: "2026-11-12T08:15:00Z" },
      ]);
      expect(deployOf(read, sha("a")).is).toBe("running");
    });

    // Every state GitHub's GraphQL API gives a report (its DeploymentStatusState), each read as the REST name the rule is written in.
    it.each([
      ["PENDING", "running"],
      ["QUEUED", "running"],
      ["IN_PROGRESS", "running"],
      ["WAITING", "running"],
      ["SUCCESS", "succeeded"],
      ["FAILURE", "failed"],
      ["ERROR", "failed"],
      ["INACTIVE", "none"],
    ])("reads GraphQL's %s as the rule reads it, %s", async (state, is) => {
      const log = "https://github.com/owner/product/actions/runs/40/job/41";
      const read = await readWith([{ state, at: "2026-11-12T08:09:00Z", log }]);
      expect(deployOf(read, sha("a"))).toMatchObject({ is, log: is === "failed" ? log : null });
    });
  });

  describe("a Deployment with more reports than a page holds", () => {
    /** A success at 08:05, then `count` reports after it, a second apart, each `state`. */
    const successThen = (count: number, state: string): CannedReport[] => [
      { state: "success", at: "2026-11-12T08:05:00Z" },
      ...Array.from({ length: count }, (_, index) => ({ state, at: new Date(Date.parse("2026-11-12T08:06:00Z") + index * 1000).toISOString() })),
    ];

    it("has the rest of its reports asked for, page after page, and is succeeded at a success beyond its first page", async () => {
      const client = repoWith({ deployments: [{ id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: successThen(249, "inactive") }] });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 7, commit: sha("a"), at: "2026-11-12T08:05:00Z", log: null });
      expect(client.queries).toEqual([
        { of: "deployments", variables: expect.objectContaining({ environment: "production" }) },
        { of: "reports", variables: { id: "DE_7", after: "100" } },
        { of: "reports", variables: { id: "DE_7", after: "200" } },
      ]);
      expect(client.calls).toEqual([]);
    });

    it("is read by the rule over all its reports: succeeded at a success beyond its first page though it failed before, failed by its latest", async () => {
      const client = repoWith({
        deployments: [{ id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "failure", at: "2026-11-12T08:04:00Z" }, ...successThen(120, "in_progress")] }],
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 7, commit: sha("a"), at: "2026-11-12T08:05:00Z", log: null });
      const failing = repoWith({ deployments: [{ id: 8, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [...Array.from({ length: 120 }, () => ({ state: "in_progress", at: "2026-11-12T08:03:00Z" })), { state: "error", at: "2026-11-12T08:09:00Z", log: "https://ci.example.com/8" }] }] });
      expect(deployOf(await readOne(failing), sha("a"))).toEqual({ is: "failed", deployment: 8, commit: sha("a"), at: "2026-11-12T08:09:00Z", log: "https://ci.example.com/8" });
    });

    it("leaves the merge unread when the rest of its reports can't be read, refused or the Deployment gone", async () => {
      const client = repoWith({ deployments: [{ id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: QUERY_REFUSED }] });
      expect((await readOne(client)).merges).toEqual({ [sha("a")]: "unread" });
      const canned = repoWith({ deployments: [{ id: 7, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: successThen(120, "inactive") }] });
      const gone = { ...canned, graphql: <T>(query: string, variables: Record<string, unknown>) => ("id" in variables ? Promise.resolve({ node: null } as T) : canned.graphql<T>(query, variables)) };
      expect((await readOne(gone)).merges).toEqual({ [sha("a")]: "unread" });
    });
  });

  describe("the answer for one merge", () => {
    const failed = { id: 20, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "failure", at: "2026-11-12T08:09:00Z", log: "https://ci.example.com/20" }] };

    it("is failed by a failed Deployment alone", async () => {
      const read = await readOne(repoWith({ deployments: [failed] }));
      expect(deployOf(read, sha("a"))).toEqual({ is: "failed", deployment: 20, commit: sha("a"), at: "2026-11-12T08:09:00Z", log: "https://ci.example.com/20" });
    });

    it("is running when a later Deployment that counts is running after a failed one", async () => {
      const client = repoWith({
        deployments: [failed, { id: 21, sha: sha("b"), createdAt: "2026-11-12T08:20:00Z", reports: [{ state: "in_progress", at: "2026-11-12T08:21:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "running", deployment: 21, commit: sha("b"), at: "2026-11-12T08:20:00Z", log: null });
    });

    it("is succeeded when a later Deployment that counts succeeded after a failed one", async () => {
      const client = repoWith({
        deployments: [failed, { id: 21, sha: sha("b"), createdAt: "2026-11-12T08:20:00Z", reports: [{ state: "success", at: "2026-11-12T08:26:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 21, commit: sha("b"), at: "2026-11-12T08:26:00Z", log: null });
    });

    it("is succeeded at the earliest success that counts, with a later deploy running", async () => {
      const client = repoWith({
        deployments: [
          { id: 30, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:06:00Z" }, { state: "inactive", at: "2026-11-12T08:40:00Z" }] },
          { id: 31, sha: sha("b"), createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:40:00Z" }] },
          { id: 32, sha: sha("c"), createdAt: "2026-11-12T09:30:00Z", reports: [{ state: "in_progress", at: "2026-11-12T09:31:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "succeeded", deployment: 30, commit: sha("a"), at: "2026-11-12T08:06:00Z", log: null });
    });

    it("is failed by the newest that counts when two failed", async () => {
      const client = repoWith({
        deployments: [failed, { id: 22, sha: sha("b"), createdAt: "2026-11-12T08:20:00Z", reports: [{ state: "error", at: "2026-11-12T08:22:00Z", log: "https://ci.example.com/22" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      expect(deployOf(await readOne(client), sha("a"))).toEqual({ is: "failed", deployment: 22, commit: sha("b"), at: "2026-11-12T08:22:00Z", log: "https://ci.example.com/22" });
    });

    it("counts a deploy of a later commit on the default branch for an earlier merge, and answers each merge for itself", async () => {
      const client = repoWith({
        deployments: [{ id: 40, sha: sha("b"), createdAt: "2026-11-12T09:02:00Z", reports: [{ state: "success", at: "2026-11-12T09:06:00Z" }] }],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead" },
      });
      const read = await readDeployments(
        client,
        "owner/product",
        "production",
        [
          { mergeCommit: sha("a"), mergedAt: MERGED_AT },
          { mergeCommit: sha("b"), mergedAt: "2026-11-12T09:00:00Z" },
          { mergeCommit: sha("c"), mergedAt: "2026-11-12T09:30:00Z" },
        ],
        NOW,
      );
      expect(read.merges).toEqual({
        [sha("a")]: { is: "succeeded", deployment: 40, commit: sha("b"), at: "2026-11-12T09:06:00Z", log: null },
        [sha("b")]: { is: "succeeded", deployment: 40, commit: sha("b"), at: "2026-11-12T09:06:00Z", log: null },
        [sha("c")]: NONE,
      });
    });
  });

  describe("how far back it reads", () => {
    /** `count` Deployments of `sha("b")`, one a minute back from 09:59, each succeeded. */
    const deploymentsBack = (count: number): CannedDeployment[] =>
      Array.from({ length: count }, (_, index) => {
        const createdAt = new Date(Date.parse("2026-11-12T09:59:00Z") - index * 60_000).toISOString();
        return { id: 1000 - index, sha: sha("b"), createdAt, reports: [{ state: "success", at: createdAt }] };
      });

    /** The read of one merge of `sha("a")` at `mergedAt`. */
    const readSince = (client: Pick<ReadClient, "rest" | "graphql">, mergedAt: string) => readDeployments(client, "owner/product", "production", [{ mergeCommit: sha("a"), mergedAt }], NOW);
    const AHEAD = { [`${sha("a")}...${sha("b")}`]: "ahead" };
    /** The cursor of each page of Deployments a read asked for. */
    const pagesAsked = (client: { readonly queries: readonly Query[] }) => client.queries.filter(({ of }) => of === "deployments").map(({ variables }) => variables["after"]);

    it("makes one query for fewer Deployments than a page, with their reports, and no request for any one Deployment's reports", async () => {
      const client = repoWith({ deployments: deploymentsBack(99), compare: AHEAD });
      // The earliest of the 99, at 08:21, is the earliest success.
      expect(deployOf(await readSince(client, "2026-11-12T06:00:00Z"), sha("a"))).toEqual({ is: "succeeded", deployment: 902, commit: sha("b"), at: "2026-11-12T08:21:00.000Z", log: null });
      expect(client.queries).toEqual([{ of: "deployments", variables: { owner: "owner", name: "product", environment: "production", after: null } }]);
      expect(client.calls).toEqual([`/repos/owner/product/compare/${sha("a")}...${sha("b")}?per_page=1`]);
    });

    it("reads no second page when the first is not full", async () => {
      const client = repoWith({ deployments: deploymentsBack(99), compare: AHEAD });
      await readSince(client, "2026-11-12T06:00:00Z");
      expect(pagesAsked(client)).toEqual([null]);
    });

    it("reads no second page when GitHub has none, though the first is full", async () => {
      const client = repoWith({ deployments: deploymentsBack(100), compare: AHEAD });
      await readSince(client, "2026-11-12T06:00:00Z");
      expect(pagesAsked(client)).toEqual([null]);
    });

    it("stops listing once the Deployments are older than the earliest merge asked about", async () => {
      // 250 a minute apart: the first page reaches back to 08:20, the second to 06:40, the third to 05:51.
      const client = repoWith({ deployments: deploymentsBack(250), compare: AHEAD });
      // The earliest since the merge, at 08:00, is the earliest success.
      expect(deployOf(await readSince(client, "2026-11-12T08:00:00Z"), sha("a"))).toMatchObject({ is: "succeeded", deployment: 881, at: "2026-11-12T08:00:00.000Z" });
      expect(pagesAsked(client)).toEqual([null, "100"]);
      expect(client.queries.filter(({ of }) => of === "reports")).toEqual([]);
    });

    it.each([
      ["2026-11-12T08:21:00Z", [null]],
      ["2026-11-12T08:20:00Z", [null, "100"]],
      ["2026-11-12T05:00:00Z", [null, "100", "200"]],
    ])("asks page after page for a merge at %s, and none past the first that reaches before it", async (mergedAt, pages) => {
      const client = repoWith({ deployments: deploymentsBack(250), compare: AHEAD });
      await readSince(client, mergedAt);
      expect(pagesAsked(client)).toEqual(pages);
    });

    it("gives every merge unread when GitHub refuses a later page of the list, and throws nothing", async () => {
      const canned = repoWith({ deployments: deploymentsBack(250), compare: AHEAD });
      const client = { ...canned, graphql: <T>(query: string, variables: Record<string, unknown>) => (variables["after"] === "100" ? Promise.reject(QUERY_REFUSED) : canned.graphql<T>(query, variables)) };
      expect((await readSince(client, "2026-11-12T05:00:00Z")).merges).toEqual({ [sha("a")]: "unread" });
      expect(client.calls).toEqual([]);
    });
  });

  describe("refused or failing", () => {
    it("gives every merge asked about unread when GitHub refuses the list", async () => {
      const client = repoWith({ deployments: QUERY_REFUSED });
      const read = await readDeployments(
        client,
        "owner/product",
        "production",
        [
          { mergeCommit: sha("a"), mergedAt: MERGED_AT },
          { mergeCommit: sha("b"), mergedAt: "2026-11-12T09:00:00Z" },
        ],
        NOW,
      );
      expect(read).toEqual({ repo: "owner/product", environment: "production", readAt: NOW, merges: { [sha("a")]: "unread", [sha("b")]: "unread" } });
    });

    it("gives every merge unread when the list fails without an answer", async () => {
      const client = repoWith({ deployments: new GitHubError("GitHub GET /repos/owner/product/deployments failed: socket hang up", 0, { body: "socket hang up" }) });
      expect((await readOne(client)).merges).toEqual({ [sha("a")]: "unread" });
    });

    it("leaves the other merges answered when one comparison fails", async () => {
      const client = repoWith({
        deployments: [{ id: 50, sha: sha("c"), createdAt: "2026-11-12T09:10:00Z", reports: [{ state: "success", at: "2026-11-12T09:12:00Z" }] }],
        compare: { [`${sha("a")}...${sha("c")}`]: new GitHubError("GitHub GET compare failed: 502", 502, { body: "" }), [`${sha("b")}...${sha("c")}`]: "ahead" },
      });
      const read = await readDeployments(
        client,
        "owner/product",
        "production",
        [
          { mergeCommit: sha("a"), mergedAt: MERGED_AT },
          { mergeCommit: sha("b"), mergedAt: "2026-11-12T09:00:00Z" },
        ],
        NOW,
      );
      expect(read.merges).toEqual({ [sha("a")]: "unread", [sha("b")]: { is: "succeeded", deployment: 50, commit: sha("c"), at: "2026-11-12T09:12:00Z", log: null } });
    });

    it("leaves unread only the merges a Deployment whose reports failed could count for", async () => {
      const client = repoWith({
        deployments: [
          { id: 60, sha: sha("b"), createdAt: "2026-11-12T09:02:00Z", reports: QUERY_REFUSED },
          { id: 61, sha: sha("c"), createdAt: "2026-11-12T09:40:00Z", reports: [{ state: "success", at: "2026-11-12T09:45:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "ahead", [`${sha("d")}...${sha("b")}`]: "diverged", [`${sha("d")}...${sha("c")}`]: "ahead" },
      });
      const read = await readDeployments(
        client,
        "owner/product",
        "production",
        [
          { mergeCommit: sha("a"), mergedAt: MERGED_AT },
          { mergeCommit: sha("c"), mergedAt: "2026-11-12T09:30:00Z" },
          { mergeCommit: sha("d"), mergedAt: "2026-11-12T08:30:00Z" },
        ],
        NOW,
      );
      expect(read.merges).toEqual({
        [sha("a")]: "unread",
        [sha("c")]: { is: "succeeded", deployment: 61, commit: sha("c"), at: "2026-11-12T09:45:00Z", log: null },
        [sha("d")]: { is: "succeeded", deployment: 61, commit: sha("c"), at: "2026-11-12T09:45:00Z", log: null },
      });
    });
  });

  describe("asked for the newest success, as a read of staging is (#855)", () => {
    /** The read of the one merge in the `staging` environment, asked for the newest success. */
    const readNewest = (client: Pick<ReadClient, "rest" | "graphql">) => readDeployments(client, "owner/product", "staging", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW, { newest: true });
    const first = { id: 30, sha: sha("a"), environment: "staging", createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "success", at: "2026-11-12T08:06:00Z" }, { state: "inactive", at: "2026-11-12T08:40:00Z" }] };
    const later = { id: 31, sha: sha("b"), environment: "staging", createdAt: "2026-11-12T08:30:00Z", reports: [{ state: "success", at: "2026-11-12T08:40:00Z" }] };

    it("gives a success the newest successful Deployment whose commit contains the merge, by creation, beside the earliest, which still decides it", async () => {
      const client = repoWith({
        deployments: [
          first,
          later,
          { id: 32, sha: sha("c"), environment: "staging", createdAt: "2026-11-12T09:00:00Z", reports: [{ state: "in_progress", at: "2026-11-12T09:01:00Z" }] },
          { id: 33, sha: sha("d"), environment: "staging", createdAt: "2026-11-12T09:10:00Z", reports: [{ state: "success", at: "2026-11-12T09:15:00Z" }] },
          { id: 34, sha: sha("e"), environment: "staging", createdAt: "2026-11-12T09:20:00Z", reports: [{ state: "failure", at: "2026-11-12T09:25:00Z" }] },
        ],
        compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "ahead", [`${sha("a")}...${sha("d")}`]: "diverged", [`${sha("a")}...${sha("e")}`]: "ahead" },
      });
      expect(await readNewest(client)).toEqual({
        repo: "owner/product",
        environment: "staging",
        readAt: NOW,
        merges: {
          [sha("a")]: { is: "succeeded", deployment: 30, commit: sha("a"), at: "2026-11-12T08:06:00Z", log: null, newest: { deployment: 31, commit: sha("b"), at: "2026-11-12T08:40:00Z" } },
        },
      });
    });

    it("gives the deciding Deployment itself where no later one succeeded, asking no comparison for it", async () => {
      const client = repoWith({ deployments: [first] });
      expect(deployOf(await readNewest(client), sha("a"))).toEqual({
        is: "succeeded",
        deployment: 30,
        commit: sha("a"),
        at: "2026-11-12T08:06:00Z",
        log: null,
        newest: { deployment: 30, commit: sha("a"), at: "2026-11-12T08:06:00Z" },
      });
      expect(client.calls.some((path) => path.includes("/compare/"))).toBe(false);
    });

    it("gives none on a merge with no success, and none on any merge when it was not asked for", async () => {
      const running = { id: 32, sha: sha("a"), environment: "staging", createdAt: "2026-11-12T09:00:00Z", reports: [{ state: "in_progress", at: "2026-11-12T09:01:00Z" }] };
      expect(deployOf(await readNewest(repoWith({ deployments: [running] })), sha("a"))).not.toHaveProperty("newest");
      expect(deployOf(await readNewest(repoWith({ deployments: [] })), sha("a"))).not.toHaveProperty("newest");
      const client = repoWith({ deployments: [first, later], compare: { [`${sha("a")}...${sha("b")}`]: "ahead" } });
      const unasked = await readDeployments(client, "owner/product", "staging", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW);
      expect(deployOf(unasked, sha("a"))).not.toHaveProperty("newest");
      expect(client.calls.some((path) => path.includes("/compare/"))).toBe(false);
    });

    it("leaves the merge unread when a later success's comparison fails, or a later Deployment's reports could not be read and it contains the merge", async () => {
      const refused = repoWith({ deployments: [first, later], compare: { [`${sha("a")}...${sha("b")}`]: refusal(`GET /repos/owner/product/compare/${sha("a")}...${sha("b")}`) } });
      expect((await readNewest(refused)).merges).toEqual({ [sha("a")]: "unread" });
      const unreadable = { id: 35, sha: sha("c"), environment: "staging", createdAt: "2026-11-12T09:30:00Z", reports: QUERY_REFUSED };
      const within = repoWith({ deployments: [first, later, unreadable], compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "ahead" } });
      expect((await readNewest(within)).merges).toEqual({ [sha("a")]: "unread" });
      const without = repoWith({ deployments: [first, later, unreadable], compare: { [`${sha("a")}...${sha("b")}`]: "ahead", [`${sha("a")}...${sha("c")}`]: "diverged" } });
      expect(deployOf(await readNewest(without), sha("a"))).toMatchObject({ is: "succeeded", newest: { deployment: 31 } });
    });
  });

  it("is plain data: it survives being written as JSON and read back", async () => {
    const client = repoWith({
      deployments: [{ id: 20, sha: sha("a"), createdAt: "2026-11-12T08:02:00Z", reports: [{ state: "failure", at: "2026-11-12T08:09:00Z", log: "https://ci.example.com/20" }] }],
    });
    const read = await readDeployments(
      client,
      "owner/product",
      "production",
      [
        { mergeCommit: sha("a"), mergedAt: MERGED_AT },
        { mergeCommit: sha("b"), mergedAt: "2026-11-12T09:00:00Z" },
      ],
      NOW,
    );
    expect(JSON.parse(JSON.stringify(read))).toEqual(read);
  });
});
