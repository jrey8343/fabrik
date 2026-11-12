import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { type DeployOf, readDeployments } from "./deployments.ts";

const NOW = "2026-11-12T10:00:00Z";
const sha = (digit: string) => digit.repeat(40);

/** One report on a Deployment, as GitHub's deployment statuses list it. */
interface CannedReport {
  readonly state: string;
  readonly at: string;
  readonly log?: string;
}

/** A Deployment as the repo holds it, its reports oldest first, or a GitHubError failing their read. */
interface CannedDeployment {
  readonly id: number;
  readonly sha: string;
  readonly environment?: string;
  readonly createdAt: string;
  readonly reports?: readonly CannedReport[] | GitHubError;
}

/** What the repo holds: its Deployments, or a GitHubError failing their list, and how GitHub compares a merge commit with a deployed one. */
interface CannedRepo {
  readonly deployments: readonly CannedDeployment[] | GitHubError;
  /** By `merge...deployed`; a pair left out is `diverged`. */
  readonly compare?: Readonly<Record<string, string | GitHubError>>;
}

const refusal = (path: string) =>
  new GitHubError(`GitHub GET ${path} failed: 403`, 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: `GET ${path}` });

/**
 * A made-up `owner/product` holding `repo`, answering as GitHub does: the
 * environment's Deployments newest first, by pages; each one's reports newest
 * first; and the comparison of two commits. Every path asked is kept.
 */
function repoWith(repo: CannedRepo): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      calls.push(path);
      const url = new URL(path, "https://api.github.com");
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      if (url.pathname === "/repos/owner/product/deployments") {
        if (repo.deployments instanceof GitHubError) throw repo.deployments;
        const environment = url.searchParams.get("environment");
        const listed = repo.deployments
          .filter((deployment) => environment === null || (deployment.environment ?? "production") === environment)
          .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
        return listed.slice((page - 1) * perPage, page * perPage).map((deployment) => ({
          id: deployment.id,
          sha: deployment.sha,
          ref: "main",
          environment: deployment.environment ?? "production",
          created_at: deployment.createdAt,
          updated_at: deployment.createdAt,
        }));
      }
      const statuses = /^\/repos\/owner\/product\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
      if (statuses !== null) {
        const deployment = (repo.deployments as readonly CannedDeployment[]).find(({ id }) => id === Number(statuses[1]));
        if (deployment === undefined) throw new GitHubError(`GitHub GET ${path} failed: 404`, 404, { body: "{}", request: `GET ${path}` });
        if (deployment.reports instanceof GitHubError) throw deployment.reports;
        const reports = (deployment.reports ?? []).map((report, index) => ({
          id: deployment.id * 1000 + index + 1,
          state: report.state,
          created_at: report.at,
          updated_at: report.at,
          log_url: report.log ?? "",
          target_url: report.log ?? "",
          environment: deployment.environment ?? "production",
        }));
        return reports.toReversed().slice((page - 1) * perPage, page * perPage);
      }
      const compare = /^\/repos\/owner\/product\/compare\/([0-9a-f]{40}\.\.\.[0-9a-f]{40})$/.exec(url.pathname);
      if (compare !== null) {
        const status = repo.compare?.[compare[1]!] ?? "diverged";
        if (status instanceof GitHubError) throw status;
        return { status, ahead_by: status === "ahead" ? 1 : 0, behind_by: 0, total_commits: 0, commits: [], files: [] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

/** A client that fails the test if anything is asked of it; every path it was asked is kept. */
function askingNothing(): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest(_method: string, path: string): Promise<unknown> {
      calls.push(path);
      return Promise.reject(new Error(`asked ${path}`));
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
const readOne = (client: Pick<ReadClient, "rest">) => readDeployments(client, "owner/product", "production", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW);

describe("The Deployments read", () => {
  it("makes no request when asked about no merges, and answers for none", async () => {
    const client = askingNothing();
    const read = await readDeployments(client, "owner/product", "production", [], NOW);
    expect(client.calls).toEqual([]);
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
      expect(client.calls[0]).toBe("/repos/owner/product/deployments?environment=production&per_page=100&page=1");
    });

    it("drops a Deployment of another environment that GitHub's list holds all the same", async () => {
      const listing: Pick<ReadClient, "rest"> = {
        rest: (_method, path) =>
          Promise.resolve(
            path.startsWith("/repos/owner/product/deployments?")
              ? [{ id: 9, sha: sha("a"), environment: "staging", created_at: "2026-11-12T08:02:00Z" }]
              : [{ id: 9001, state: "success", created_at: "2026-11-12T08:05:00Z", log_url: "", target_url: "" }],
          ),
      };
      expect(deployOf(await readOne(listing), sha("a"))).toEqual(NONE);
    });

    it("names the environment as a query value, whatever its name", async () => {
      const client = repoWith({ deployments: [] });
      await readDeployments(client, "owner/product", "prod & eu", [{ mergeCommit: sha("a"), mergedAt: MERGED_AT }], NOW);
      expect(client.calls[0]).toBe("/repos/owner/product/deployments?environment=prod%20%26%20eu&per_page=100&page=1");
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
          { id: 6, sha: sha("b"), createdAt: "2026-11-12T08:01:00Z", reports: refusal("/repos/owner/product/deployments/6/statuses") },
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

    it.each(["queued", "in_progress", "pending"])("is running when its latest report is %s", async (state) => {
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

    it("is running again when a failed one is retried and its latest report is in progress", async () => {
      const read = await readWith([
        { state: "failure", at: "2026-11-12T08:09:00Z" },
        { state: "in_progress", at: "2026-11-12T08:15:00Z" },
      ]);
      expect(deployOf(read, sha("a")).is).toBe("running");
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

    it("stops listing once the Deployments are older than the earliest merge asked about", async () => {
      // 250 a minute apart: the first page reaches back to 08:20, the second to 06:40, the third to 05:51.
      const client = repoWith({ deployments: deploymentsBack(250), compare: { [`${sha("a")}...${sha("b")}`]: "ahead" } });
      await readDeployments(client, "owner/product", "production", [{ mergeCommit: sha("a"), mergedAt: "2026-11-12T08:00:00Z" }], NOW);
      expect(client.calls.filter((path) => path.startsWith("/repos/owner/product/deployments?"))).toEqual([
        "/repos/owner/product/deployments?environment=production&per_page=100&page=1",
        "/repos/owner/product/deployments?environment=production&per_page=100&page=2",
      ]);
      // The reports of only those since the merge, 08:00 to 09:59, are read.
      expect(client.calls.filter((path) => path.endsWith("/statuses?per_page=100&page=1"))).toHaveLength(120);
    });

    it("reads no second page when the first is not full", async () => {
      const client = repoWith({ deployments: deploymentsBack(99), compare: { [`${sha("a")}...${sha("b")}`]: "ahead" } });
      await readDeployments(client, "owner/product", "production", [{ mergeCommit: sha("a"), mergedAt: "2026-11-12T06:00:00Z" }], NOW);
      expect(client.calls.filter((path) => path.startsWith("/repos/owner/product/deployments?"))).toHaveLength(1);
    });
  });

  describe("refused or failing", () => {
    it("gives every merge asked about unread when GitHub refuses the list", async () => {
      const client = repoWith({ deployments: refusal("/repos/owner/product/deployments") });
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
          { id: 60, sha: sha("b"), createdAt: "2026-11-12T09:02:00Z", reports: refusal("/repos/owner/product/deployments/60/statuses") },
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
