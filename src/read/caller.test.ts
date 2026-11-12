import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import type { ReadClient, Repo } from "../github/client.ts";
import { callerChangeErrors } from "../kit/callerPermissions.ts";
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

  it("gives the Kit job's own line, word for word, for a caller job that lacks what the new release's workflow asks", async () => {
    const client = clientWith({
      [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"),
      [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0"),
      "jrey8343/fabrik:.github/workflows/schedule.yml@v1.1.0": scheduleAsking({ tick: ["id-token: write", "actions: read"] }),
    });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({
      changes: true,
      from: "v1.0.0",
      to: "v1.1.0",
      errors: [
        ".github/workflows/fabrik.yml: the tick job's permissions: lacks `actions: read`, which the tick job of jrey8343/fabrik/.github/workflows/schedule.yml@v1.1.0 asks for. " +
          "GitHub checks every uses: job of a workflow before any job's if:, so until the line is added every run of this workflow fails at startup, whatever the event. " +
          "Add `actions: read` under the tick job's permissions: before merging.",
      ],
    });
  });

  it("gives a pull request that leaves the caller alone as no change, at the one release, reading no Kit workflow", async () => {
    const client = clientWith({ [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"), [`acme/shop:${PATH}@abc123`]: callerAt("v1.0.0") });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({ changes: false, from: "v1.0.0", to: "v1.0.0", errors: [] });
    expect(client.reads.filter((read) => read.startsWith("jrey8343/fabrik:"))).toEqual([]);
  });

  it("gives the Kit job's line for a head whose caller pins two releases", async () => {
    const twoPins = `${callerAt("v1.1.0")}  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.0.0\n`;
    const client = clientWith({ [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"), [`acme/shop:${PATH}@abc123`]: twoPins });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({
      changes: true,
      from: "v1.0.0",
      to: null,
      errors: [".github/workflows/fabrik.yml: The caller workflow pins more than one Fabrik release (v1.1.0, v1.0.0); every uses: line must pin the same one"],
    });
  });

  it("gives the Kit job's line for a head whose caller pins a branch", async () => {
    const client = clientWith({ [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"), [`acme/shop:${PATH}@abc123`]: callerAt("main") });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({
      changes: true,
      from: "v1.0.0",
      to: null,
      errors: [".github/workflows/fabrik.yml: The caller workflow pins Fabrik at main, which isn't an exact release tag such as v1.2.3"],
    });
  });

  it("gives a fork's head the repo can't serve as no change, as the Kit job checks none", async () => {
    const client = clientWith({ [`acme/shop:${PATH}@main`]: callerAt("v1.0.0") });

    expect(await readCaller(client, "acme/shop", 42)).toEqual({ changes: false, from: "v1.0.0", to: null, errors: [] });
  });

  /** The Kit's v1.1.0 scheduled workflow, asking a caller's tick job for `id-token: write` and `actions: read`. */
  const ASKS_ACTIONS = { "jrey8343/fabrik:.github/workflows/schedule.yml@v1.1.0": scheduleAsking({ tick: ["id-token: write", "actions: read"] }) };

  it.each([
    ["a bump the caller grants", { [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0", ["id-token: write", "actions: read"]), ...ASKS_ACTIONS }],
    ["a bump with a gap", { [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0"), ...ASKS_ACTIONS }],
    ["a bump to a release without the workflow", { [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0") }],
    ["a caller with no grants at all", { [`acme/shop:${PATH}@abc123`]: callerAt("v1.1.0").replace(/ {4}permissions:\n {6}id-token: write\n/, ""), ...ASKS_ACTIONS }],
    ["a branch pin", { [`acme/shop:${PATH}@abc123`]: callerAt("main") }],
    ["an unchanged caller", { [`acme/shop:${PATH}@abc123`]: callerAt("v1.0.0") }],
    ["a fork's head", {}],
  ])("gives, for %s, the errors the Kit job's check gives on the same pull request", async (_case, head: Readonly<Record<string, string>>) => {
    const files = { [`acme/shop:${PATH}@main`]: callerAt("v1.0.0"), ...head };

    const kitJob = await callerChangeErrors(clientWith(files), { owner: "acme", name: "shop" }, { path: PATH, baseText: callerAt("v1.0.0"), headSha: "abc123" });

    expect((await readCaller(clientWith(files), "acme/shop", 42)).errors).toEqual(kitJob);
  });
});
