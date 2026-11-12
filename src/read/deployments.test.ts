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
});
