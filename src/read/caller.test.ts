import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import type { ReadClient, Repo } from "../github/client.ts";
import { readCaller } from "./caller.ts";

const PATH = ".github/workflows/fabrik.yml";
const SCHEDULE = (release: string) => `jrey8343/fabrik/.github/workflows/schedule.yml@${release}`;

/** A caller whose `tick` job grants `grants` to the Kit's scheduled workflow at `release`. */
function callerAt(release: string, grants: readonly string[] = ["id-token: write"]): string {
  return [
    "name: Fabrik",
    "on:",
    "  schedule:",
    '    - cron: "17 * * * *"',
    "permissions: {}",
    "jobs:",
    "  tick:",
    "    if: github.event_name == 'schedule'",
    `    uses: ${SCHEDULE(release)}`,
    "    permissions:",
    ...grants.map((grant) => `      ${grant}`),
    "",
  ].join("\n");
}

/** The Kit's scheduled workflow, whose jobs each ask for the permissions given. */
function scheduleAsking(jobs: Readonly<Record<string, readonly string[]>>): string {
  return [
    "name: Fabrik scheduled tick",
    "on:",
    "  workflow_call:",
    "permissions: {}",
    "jobs:",
    ...Object.entries(jobs).flatMap(([job, asks]) => [`  ${job}:`, "    runs-on: ubuntu-latest", "    permissions:", ...asks.map((ask) => `      ${ask}`)]),
    "",
  ].join("\n");
}

/** acme/shop's pull request 42, from head `abc123` onto `main`. */
const PULL_REQUEST = { number: 42, head: { sha: "abc123" }, base: { ref: "main" } };

/**
 * A client that answers acme/shop's pull request 42 and the files given,
 * keyed `owner/name:path@ref`, and notes every file it reads.
 */
function clientWith(files: Readonly<Record<string, string>>): ReadClient & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    rest: (method, path) =>
      method === "GET" && path === "/repos/acme/shop/pulls/42"
        ? Promise.resolve(PULL_REQUEST)
        : Promise.reject(new GitHubError(`GitHub ${method} ${path} failed: 404`, 404)),
    graphql: () => Promise.reject(new Error("the caller read makes no GraphQL query")),
    fileText: (repo: Repo, path: string, ref: string) => {
      const key = `${repo.owner}/${repo.name}:${path}@${ref}`;
      reads.push(key);
      return Promise.resolve(files[key] ?? null);
    },
  };
}

describe("the caller read", () => {
  it("gives a Kit bump whose caller grants what the new release asks as a change from one release to the next, with nothing wrong", async () => {
    const client = clientWith({
      [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"),
      [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0"),
      "jrey8343/fabrik:.github/workflows/schedule.yml@v1.1.0": scheduleAsking({ tick: ["id-token: write"] }),
    });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({ changes: true, from: "v1.0.0", to: "v1.1.0", errors: [] });
    expect(client.reads.toSorted()).toEqual([
      `acme/shop:${PATH}@abc123`,
      `acme/shop:${PATH}@main`,
      "jrey8343/fabrik:.github/workflows/schedule.yml@v1.1.0",
    ]);
  });
});
