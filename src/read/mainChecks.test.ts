import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { readMainChecks } from "./mainChecks.ts";

const NOW = "2026-11-12T10:00:00Z";
const sha = (digit: string) => digit.repeat(40);

/** A check run as the Checks API lists it: finished with its conclusion, or still `queued` or `in_progress`. */
interface CannedCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly completedAt?: string | null;
  readonly url?: string;
}

const refusal = (path: string) =>
  new GitHubError(`GitHub GET ${path} failed: 403`, 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: `GET ${path}` });

const runUrl = (id: number) => `https://github.com/owner/product/actions/runs/7/job/${id}`;

/**
 * A made-up `owner/product` whose commits hold these check runs, or a
 * GitHubError failing a commit's read, answering as GitHub does: a commit's
 * runs of the one name asked for, a hundred to a page. Every path asked is kept.
 */
function repoWith(commits: Readonly<Record<string, readonly CannedCheckRun[] | GitHubError>>): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      calls.push(path);
      const url = new URL(path, "https://api.github.com");
      const asked = /^\/repos\/owner\/product\/commits\/([0-9a-f]{40})\/check-runs$/.exec(url.pathname);
      const name = url.searchParams.get("check_name");
      if (asked === null || name === null) throw new Error(`unexpected ${path}`);
      const runs = commits[asked[1]!] ?? [];
      if (runs instanceof GitHubError) throw runs;
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const listed = runs.filter((run) => run.name === name);
      return {
        total_count: listed.length,
        check_runs: listed.slice((page - 1) * perPage, page * perPage).map((run) => ({
          id: run.id,
          name: run.name,
          status: run.status ?? "completed",
          conclusion: run.conclusion === undefined ? "success" : run.conclusion,
          completed_at: run.completedAt === undefined ? "2026-11-12T09:30:00Z" : run.completedAt,
          html_url: run.url ?? runUrl(run.id),
        })),
      };
    },
  };
}

describe("The Main checks read", () => {
  it("makes no request when asked about no commits, or about a commit with no checks, and answers for each", async () => {
    const client = repoWith({});

    expect(await readMainChecks(client, "owner/product", [], NOW)).toEqual({ repo: "owner/product", readAt: NOW, commits: {} });
    expect(await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: [] }], NOW)).toEqual({ repo: "owner/product", readAt: NOW, commits: { [sha("a")]: [] } });
    expect(client.calls).toEqual([]);
  });

  it("gives each Main check asked of a commit, in the order asked, as the Monitor reads one: green on success, red on a failure or a time-out, with its run's page and when it ended", async () => {
    const client = repoWith({
      [sha("a")]: [
        { id: 901, name: "e2e", conclusion: "success", completedAt: "2026-11-12T09:31:00Z" },
        { id: 902, name: "smoke", conclusion: "failure", completedAt: "2026-11-12T09:32:00Z" },
        { id: 903, name: "deploy", conclusion: "timed_out", completedAt: "2026-11-12T09:33:00Z" },
        { id: 904, name: "lint", conclusion: "failure" },
      ],
    });

    const read = await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: ["smoke", "e2e", "deploy"] }], NOW);

    expect(read).toEqual({
      repo: "owner/product",
      readAt: NOW,
      commits: {
        [sha("a")]: [
          { name: "smoke", is: "red", url: runUrl(902), at: "2026-11-12T09:32:00Z" },
          { name: "e2e", is: "green", url: runUrl(901), at: "2026-11-12T09:31:00Z" },
          { name: "deploy", is: "red", url: runUrl(903), at: "2026-11-12T09:33:00Z" },
        ],
      },
    });
    expect(client.calls).toEqual([
      `/repos/owner/product/commits/${sha("a")}/check-runs?check_name=smoke&per_page=100&page=1`,
      `/repos/owner/product/commits/${sha("a")}/check-runs?check_name=e2e&per_page=100&page=1`,
      `/repos/owner/product/commits/${sha("a")}/check-runs?check_name=deploy&per_page=100&page=1`,
    ]);
  });

  it("gives a check undecided with no run of it on the commit, with one still under way, and with one that ended skipped or cancelled, which GitHub's merge would pass or fail", async () => {
    const client = repoWith({
      [sha("a")]: [
        { id: 901, name: "e2e", status: "in_progress", conclusion: null, completedAt: null },
        { id: 902, name: "smoke", conclusion: "skipped" },
        { id: 903, name: "deploy", conclusion: "cancelled" },
      ],
    });

    const read = await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: ["e2e", "smoke", "deploy", "never run"] }], NOW);

    expect(read.commits[sha("a")]).toEqual([
      { name: "e2e", is: "undecided", url: runUrl(901), at: null },
      { name: "smoke", is: "undecided", url: runUrl(902), at: "2026-11-12T09:30:00Z" },
      { name: "deploy", is: "undecided", url: runUrl(903), at: "2026-11-12T09:30:00Z" },
      { name: "never run", is: "undecided", url: null, at: null },
    ]);
    expect(client.calls.at(-1)).toBe(`/repos/owner/product/commits/${sha("a")}/check-runs?check_name=never%20run&per_page=100&page=1`);
  });

  it("reads the newest run of a check, so a re-run that passed replaces the failure before it", async () => {
    const client = repoWith({ [sha("a")]: [{ id: 901, name: "e2e", conclusion: "failure" }, { id: 950, name: "e2e", conclusion: "success", completedAt: "2026-11-12T09:50:00Z" }] });

    expect((await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: ["e2e"] }], NOW)).commits[sha("a")]).toEqual([
      { name: "e2e", is: "green", url: runUrl(950), at: "2026-11-12T09:50:00Z" },
    ]);
  });

  it("asks each commit once for each check, whoever asked, and gives a run's page only when it is an https address", async () => {
    const client = repoWith({ [sha("a")]: [{ id: 901, name: "e2e", url: "javascript:alert(1)" }], [sha("b")]: [{ id: 911, name: "e2e" }] });

    const read = await readMainChecks(
      client,
      "owner/product",
      [
        { commit: sha("a"), checks: ["e2e"] },
        { commit: sha("b"), checks: ["e2e"] },
        { commit: sha("a"), checks: ["e2e", "smoke"] },
      ],
      NOW,
    );

    expect(read.commits).toEqual({
      [sha("a")]: [
        { name: "e2e", is: "green", url: null, at: "2026-11-12T09:30:00Z" },
        { name: "smoke", is: "undecided", url: null, at: null },
      ],
      [sha("b")]: [{ name: "e2e", is: "green", url: runUrl(911), at: "2026-11-12T09:30:00Z" }],
    });
    expect(client.calls.toSorted()).toEqual(
      [
        `/repos/owner/product/commits/${sha("a")}/check-runs?check_name=e2e&per_page=100&page=1`,
        `/repos/owner/product/commits/${sha("a")}/check-runs?check_name=smoke&per_page=100&page=1`,
        `/repos/owner/product/commits/${sha("b")}/check-runs?check_name=e2e&per_page=100&page=1`,
      ].toSorted(),
    );
  });

  it("never throws: a commit GitHub refuses is unread, and the others are still given", async () => {
    const client = repoWith({ [sha("a")]: refusal(`/repos/owner/product/commits/${sha("a")}/check-runs`), [sha("b")]: [{ id: 911, name: "e2e" }] });

    const read = await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: ["e2e"] }, { commit: sha("b"), checks: ["e2e"] }], NOW);

    expect(read.commits).toEqual({ [sha("a")]: "unread", [sha("b")]: [{ name: "e2e", is: "green", url: runUrl(911), at: "2026-11-12T09:30:00Z" }] });
  });

  it("is plain data: it survives being written as JSON and read back", async () => {
    const client = repoWith({ [sha("a")]: refusal("x"), [sha("b")]: [{ id: 911, name: "e2e", status: "queued", conclusion: null, completedAt: null }] });
    const read = await readMainChecks(client, "owner/product", [{ commit: sha("a"), checks: ["e2e"] }, { commit: sha("b"), checks: ["e2e", "smoke"] }], NOW);

    expect(JSON.parse(JSON.stringify(read))).toStrictEqual(read);
  });
});
