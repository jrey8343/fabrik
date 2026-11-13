import { describe, expect, it } from "vitest";
import { GitHubError, type Repo } from "./client.ts";
import { confirmReleaseRunning } from "./releaseRunning.ts";

const REPO = { owner: "acme", name: "shop" };
const APP = "fabrik-app[bot]";
const callerAt = (release: string, cron = "17 * * * *") =>
  `on:\n  schedule:\n    - cron: "${cron}"\njobs:\n  tick:\n    uses: jrey8343/fabrik/.github/workflows/schedule.yml@${release}\n`;

interface CallerCommit {
  readonly sha: string;
  /** fabrik.yml as this commit left it. */
  readonly caller: string;
  /** The pull requests GitHub associates with it. */
  readonly pulls?: readonly { readonly number: number; readonly merged_at: string | null; readonly merge_commit_sha?: string }[];
}

/** A Product repo whose main has these commits touching fabrik.yml, newest first, and these comments on its pull requests. */
function repoWith(callerCommits: readonly CallerCommit[], options: { comments?: Record<number, readonly unknown[]>; fail?: (method: string, path: string) => boolean } = {}) {
  const posted: { path: string; body: unknown }[] = [];
  const commitOf = (sha: string) => callerCommits.find((commit) => commit.sha === sha);
  const github = {
    posted,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      if (options.fail?.(method, path)) throw new GitHubError(`${method} ${path} failed`, 403, { body: '{"message":"Resource not accessible by integration"}', request: `${method} ${path}` });
      if (method === "POST") {
        posted.push({ path, body });
        return {};
      }
      if (path.startsWith("/repos/acme/shop/commits?sha=head0&path=.github%2Fworkflows%2Ffabrik.yml")) return callerCommits.map(({ sha }) => ({ sha }));
      const pulls = /^\/repos\/acme\/shop\/commits\/(\w+)\/pulls/.exec(path);
      if (pulls !== null) return commitOf(pulls[1]!)?.pulls ?? [];
      const comments = /^\/repos\/acme\/shop\/issues\/(\d+)\/comments\?/.exec(path);
      if (comments !== null) return options.comments?.[Number(comments[1])] ?? [];
      throw new Error(`Unexpected call: ${method} ${path}`);
    },
    async fileText(_repo: Repo, path: string, ref: string): Promise<string | null> {
      expect(path).toBe(".github/workflows/fabrik.yml");
      return commitOf(ref)?.caller ?? null;
    },
  };
  return github;
}

const run = (running: string) => ({
  repo: REPO,
  headSha: "head0",
  kitRef: `jrey8343/fabrik/.github/workflows/schedule.yml@${running}`,
  appLogin: APP,
  runUrl: "https://github.com/acme/shop/actions/runs/42",
  startedAt: "2026-11-13T04:17:09Z",
  timeZone: null,
});

describe("Confirming on the pin move's pull request that its release is running", () => {
  it("comments only on the newest pin move's pull request when two moves came before one Tick, past a later edit that kept the pin", async () => {
    const github = repoWith([
      { sha: "c4", caller: callerAt("v1.4.0", "47 * * * *") },
      { sha: "c3", caller: callerAt("v1.4.0"), pulls: [{ number: 30, merged_at: null }, { number: 32, merged_at: "2026-11-13T03:00:00Z", merge_commit_sha: "c3" }] },
      { sha: "c2", caller: callerAt("v1.3.1"), pulls: [{ number: 31, merged_at: "2026-11-13T02:00:00Z", merge_commit_sha: "c2" }] },
      { sha: "c1", caller: callerAt("v1.3.0") },
    ]);

    const line = await confirmReleaseRunning(github, run("v1.4.0"));

    expect(github.posted).toHaveLength(1);
    expect(github.posted[0]!.path).toBe("/repos/acme/shop/issues/32/comments");
    expect((github.posted[0]!.body as { body: string }).body).toContain("<!-- fabrik:release-running v1.4.0 -->");
    expect(line).toBe("Fabrik v1.4.0 is running here, so #32, which moved the pin to it, is told.");
  });

  it("reads only the Fabrik App's comments as saying so already", async () => {
    const marker = "<!-- fabrik:release-running v1.4.0 -->";
    const github = repoWith([{ sha: "c1", caller: callerAt("v1.4.0"), pulls: [{ number: 32, merged_at: "2026-11-13T03:00:00Z" }] }], {
      comments: { 32: [{ body: marker, user: { login: "someone" } }, { body: marker, user: { login: APP } }] },
    });

    const line = await confirmReleaseRunning(github, run("v1.4.0"));

    expect(github.posted).toEqual([]);
    expect(line).toBe("Fabrik v1.4.0 is running here, and #32, which moved the pin to it, says so already.");
  });

  it("posts nothing for a pin moved by a direct push, with no merged pull request behind it", async () => {
    const github = repoWith([{ sha: "c1", caller: callerAt("v1.4.0"), pulls: [{ number: 30, merged_at: null }] }]);

    const line = await confirmReleaseRunning(github, run("v1.4.0"));

    expect(github.posted).toEqual([]);
    expect(line).toBe("Fabrik v1.4.0 is running here, but commit c1, which moved the pin to it, came from no pull request, so nothing is posted.");
  });

  it.each([
    ["read", (method: string) => method === "GET"],
    ["write", (method: string) => method === "POST"],
  ])("never throws when GitHub refuses a %s: it gives one line saying why, for the next Tick to try again", async (_, fail) => {
    const github = repoWith([{ sha: "c1", caller: callerAt("v1.4.0"), pulls: [{ number: 32, merged_at: "2026-11-13T03:00:00Z" }] }], { fail });

    const line = await confirmReleaseRunning(github, run("v1.4.0"));

    expect(line).toMatch(/^Couldn't say on the pin move's pull request that Fabrik v1\.4\.0 is running here: .*Resource not accessible by integration.*\. The next Tick tries again\.$/);
  });
});
