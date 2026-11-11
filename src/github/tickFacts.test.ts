import { describe, expect, it } from "vitest";
import { tickIsDead } from "../kit/deadTick.ts";
import { GitHubError, type Repo } from "./client.ts";
import { readProductTicks } from "./tickFacts.ts";

const REPO = { owner: "acme", name: "shop" };
const APP = "fabrik-app[bot]";
const NOW = "2026-11-11T07:00:00Z";
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

const callerAt = (release: string) => `jobs:\n  tick:\n    uses: jrey8343/fabrik/.github/workflows/schedule.yml@${release}\n`;

interface Commit {
  readonly sha: string;
  readonly at: string;
  /** Its check runs' names and start times. */
  readonly checks?: readonly { readonly name: string; readonly at: string }[];
  /** fabrik.yml as it stood at this commit. */
  readonly caller?: string;
}

/** A Product repo's main, newest commit first, with the commits that touched fabrik.yml and its open Dead-tick issues. */
function repoWith(main: readonly Commit[], options: { readonly callerCommits?: readonly string[]; readonly issues?: readonly unknown[] } = {}) {
  const calls: string[] = [];
  const commitOf = (sha: string) => main.find((commit) => commit.sha === sha);
  const asListed = (commit: Commit) => ({ sha: commit.sha, commit: { committer: { date: commit.at } } });
  const github = {
    calls,
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      calls.push(path);
      if (path === "/repos/acme/shop") return { default_branch: "main" };
      if (path.startsWith("/repos/acme/shop/commits?sha=main&path=")) return (options.callerCommits ?? [main.at(-1)!.sha]).map((sha) => asListed(commitOf(sha)!));
      if (path.startsWith("/repos/acme/shop/commits?sha=main&")) return main.map(asListed);
      const checks = /^\/repos\/acme\/shop\/commits\/(\w+)\/check-runs\?/.exec(path);
      if (checks !== null) {
        const runs = (commitOf(checks[1]!)?.checks ?? []).map((check, i) => ({ name: check.name, started_at: check.at, details_url: `https://github.com/acme/shop/actions/runs/7/job/${i}` }));
        return { total_count: runs.length, check_runs: runs };
      }
      if (path.startsWith("/repos/acme/shop/issues?")) return options.issues ?? [];
      throw new Error(`Unexpected call: ${path}`);
    },
    async fileText(_repo: Repo, path: string, ref: string): Promise<string | null> {
      expect(path).toBe(".github/workflows/fabrik.yml");
      const at = ref === "main" ? main[0] : commitOf(ref);
      return at?.caller ?? null;
    },
  };
  return github;
}

describe("Reading a Product repo's last started Tick", () => {
  it("walks back through main's newer commits to a Tick that started 2 hours ago on a commit 3 days old, so the Tick is alive", async () => {
    const github = repoWith([
      { sha: "c3", at: hoursAgo(1), caller: callerAt("v1.1.0") },
      { sha: "c2", at: hoursAgo(1.5) },
      { sha: "c1", at: hoursAgo(72), checks: [{ name: "tick / Kit", at: hoursAgo(26) }, { name: "tick / Tick", at: hoursAgo(2) }, { name: "loop / Kit", at: hoursAgo(1) }], caller: callerAt("v1.0.0") },
      { sha: "c0", at: hoursAgo(24 * 10) },
    ]);

    const read = await readProductTicks(github, REPO, APP);

    expect(read).toEqual({
      repo: "acme/shop",
      kind: "read",
      facts: {
        callerSince: hoursAgo(24 * 10),
        lastTick: { at: hoursAgo(2), url: "https://github.com/acme/shop/actions/runs/7/job/1", release: "v1.0.0" },
        release: "v1.1.0",
        issues: [],
      },
    });
    expect(read.kind === "read" && tickIsDead(read.facts, NOW)).toBe(false);
    // It stops at the first commit with a Tick on it.
    expect(github.calls.some((path) => path.includes("/commits/c0/"))).toBe(false);
  });

  it("finds no started Tick when no commit on main has a tick check run, as when every Tick start-failed", async () => {
    const github = repoWith([
      { sha: "c1", at: hoursAgo(30), checks: [{ name: "loop / Kit", at: hoursAgo(29) }], caller: callerAt("v1.0.0") },
      { sha: "c0", at: hoursAgo(40) },
    ]);

    const read = await readProductTicks(github, REPO, APP);

    expect(read).toMatchObject({ kind: "read", facts: { lastTick: null, callerSince: hoursAgo(40), release: "v1.0.0" } });
  });

  it("takes fabrik.yml's arrival on main from the oldest commit that touched it", async () => {
    const github = repoWith(
      [
        { sha: "c2", at: hoursAgo(3), caller: callerAt("v1.0.0") },
        { sha: "c1", at: hoursAgo(10) },
        { sha: "c0", at: hoursAgo(50) },
      ],
      { callerCommits: ["c2", "c1"] },
    );

    const read = await readProductTicks(github, REPO, APP);

    expect(read).toMatchObject({ kind: "read", facts: { callerSince: hoursAgo(10) } });
  });

  it("reads the open Dead-tick issues, marking those the Fabrik App opened and leaving out pull requests", async () => {
    const github = repoWith([{ sha: "c0", at: hoursAgo(50), caller: callerAt("v1.0.0") }], {
      issues: [
        { number: 12, body: "<!-- fabrik:dead-tick -->", user: { login: APP } },
        { number: 13, body: null, user: { login: "someone" } },
        { number: 14, body: "", user: { login: APP }, pull_request: {} },
      ],
    });

    const read = await readProductTicks(github, REPO, APP);

    expect(read).toMatchObject({
      kind: "read",
      facts: {
        issues: [
          { number: 12, body: "<!-- fabrik:dead-tick -->", byApp: true },
          { number: 13, body: "", byApp: false },
        ],
      },
    });
    expect(github.calls).toContain("/repos/acme/shop/issues?labels=fabrik%3Adead-tick&state=open&per_page=100");
  });

  it.each([
    [403, "Resource not accessible by integration"],
    [404, "Not Found"],
  ])("says the App can't reach the repo when GitHub refuses it with a %i", async (status, message) => {
    const github = {
      async rest(_method: string, path: string): Promise<unknown> {
        throw new GitHubError(`GitHub GET ${path} failed: ${status} ${message}`, status, { body: JSON.stringify({ message }) });
      },
      fileText: async () => null,
    };

    expect(await readProductTicks(github, REPO, APP)).toEqual({ repo: "acme/shop", kind: "refused", error: message });
  });

  it("says the read failed, not that the App can't reach it, on a rate limit or GitHub's own error", async () => {
    const github = {
      async rest(): Promise<unknown> {
        throw new GitHubError("GitHub GET /repos/acme/shop failed: 502 Bad Gateway", 502, { body: "Bad Gateway" });
      },
      fileText: async () => null,
    };

    expect(await readProductTicks(github, REPO, APP)).toEqual({ repo: "acme/shop", kind: "failed", error: "Bad Gateway" });
  });
});
