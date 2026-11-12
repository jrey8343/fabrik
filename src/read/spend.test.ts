import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { aRunRecord } from "./builders.ts";
import { readSpend, runnerTimeOf } from "./spend.ts";

const NOW = "2026-11-12T09:00:00Z";
const CALLER = ".github/workflows/weekly-summary.yml";

/** The store's caller, its two schedules in `timeZone`, as Setup writes it. */
function callerIn(timeZone: string): string {
  return [
    "on:",
    "  schedule:",
    '    - cron: "0 8 * * 1"',
    `      timezone: "${timeZone}"`,
    "jobs:",
    "  weekly:",
    "    uses: jrey8343/fabrik/.github/workflows/weekly-summary.yml@v1.2.3",
    "",
  ].join("\n");
}

/**
 * A canned fabrik-runs store over the API: its files by path, which its git
 * trees list and a file read returns at its default branch. Every request is
 * logged in `requests`, as `GET <API path>` or `file <path>@<ref>`.
 */
function storeOf(files: Readonly<Record<string, string>>) {
  const requests: string[] = [];
  /** Each entry directly under `dir` ("" for the root). */
  const entriesIn = (dir: string) => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Map<string, "blob" | "tree">();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const [name = "", ...rest] = path.slice(prefix.length).split("/");
      names.set(name, rest.length === 0 ? "blob" : "tree");
    }
    return [...names].map(([name, type]) => ({ path: name, mode: type === "tree" ? "040000" : "100644", type, sha: `${type}:${prefix}${name}` }));
  };
  const client: ReadClient = {
    rest(method, path) {
      requests.push(`${method} ${path}`);
      const tree = /^\/repos\/jrey8343\/fabrik-runs\/git\/trees\/(.+)$/.exec(path)?.[1];
      if (method !== "GET" || tree === undefined) return Promise.reject(new Error(`Unexpected call: ${method} ${path}`));
      const dir = tree === "HEAD" ? "" : decodeURIComponent(tree).replace(/^tree:/, "");
      return Promise.resolve({ sha: tree, tree: entriesIn(dir), truncated: false });
    },
    graphql: () => Promise.reject(new Error("Unexpected GraphQL query")),
    fileText(repo, path, ref) {
      requests.push(`file ${path}@${ref}`);
      if (repo.owner !== "jrey8343" || repo.name !== "fabrik-runs") return Promise.reject(new Error(`Unexpected repo: ${repo.owner}/${repo.name}`));
      return Promise.resolve(files[path] ?? null);
    },
  };
  return { client, requests };
}

const SHOP = "runs/acme/shop/2026-11";

describe("The Spend read", () => {
  it("gives a reader holding one of three records the other two, parsed, and never fetches the one it holds", async () => {
    const held = `${SHOP}/1001-1-implement.json`;
    const { client, requests } = storeOf({
      [CALLER]: callerIn("Europe/London"),
      [held]: JSON.stringify(aRunRecord({ runId: 1001 })),
      [`${SHOP}/1002-1-review.json`]: JSON.stringify(aRunRecord({ runId: 1002, role: "review" })),
      [`runs/acme/clinic/2026-11/2001-1-implement.json`]: JSON.stringify(aRunRecord({ repo: "acme/clinic", runId: 2001 })),
    });

    const read = await readSpend(client, ["2026-11"], (path) => path === held, NOW);

    expect(read).toEqual({
      kind: "read",
      records: {
        [`${SHOP}/1002-1-review.json`]: aRunRecord({ runId: 1002, role: "review" }),
        "runs/acme/clinic/2026-11/2001-1-implement.json": aRunRecord({ repo: "acme/clinic", runId: 2001 }),
      },
      unreadable: { count: 0, newestSchema: null },
      timeZone: "Europe/London",
    });
    expect(requests.filter((request) => request.includes(held))).toEqual([]);
  });

  it("reads a record of an earlier schema as the Weekly summary does, and counts one of a schema the Kit doesn't know unread, with its schema", async () => {
    const { brokenRun: _left, ...schema7 } = aRunRecord({ runId: 1001 });
    const { client } = storeOf({
      [`${SHOP}/1001-1-implement.json`]: JSON.stringify({ ...schema7, schema: 7 }),
      [`${SHOP}/1002-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 1002 }), schema: 12 }),
      [`${SHOP}/1003-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 1003 }), schema: 10 }),
      [`${SHOP}/1004-1-implement.json`]: "not JSON",
    });

    const read = await readSpend(client, ["2026-11"], () => false, NOW);

    expect(read).toMatchObject({
      kind: "read",
      records: { [`${SHOP}/1001-1-implement.json`]: aRunRecord({ runId: 1001, brokenRun: null }) },
      unreadable: { count: 3, newestSchema: 12 },
    });
    expect(Object.keys(read.kind === "read" ? read.records : {})).toEqual([`${SHOP}/1001-1-implement.json`]);
  });

  it("reads only the months asked for, and never names a transcript's, a score file's or a Replay patch's path", async () => {
    const { client, requests } = storeOf({
      [`${SHOP}/1001-1-implement.json`]: JSON.stringify(aRunRecord({ runId: 1001 })),
      "runs/acme/shop/2026-09/900-1-implement.json": JSON.stringify(aRunRecord({ runId: 900, endedAt: "2026-09-30T10:00:00Z" })),
      "transcripts/acme/shop/2026-11/1001-1-implement.jsonl.gz": "transcript",
      "scores/acme/shop/2026-11/1001-1-implement.json": "{}",
      "replays/acme/shop/140/7-baseline-3000.patch": "diff",
      "replays/acme/shop/140/7-baseline-3000.gates.json": "{}",
    });

    const read = await readSpend(client, ["2026-11", "2026-10"], () => false, NOW);

    expect(read.kind === "read" ? Object.keys(read.records) : read).toEqual([`${SHOP}/1001-1-implement.json`]);
    expect(requests.filter((request) => /transcripts|scores|replays|\.patch|jsonl/.test(request))).toEqual([]);
  });

  it("lists a month of more than a thousand records whole", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 1_203 }, (_, at) => [`${SHOP}/${5000 + at}-1-implement.json`, JSON.stringify(aRunRecord({ runId: 5000 + at }))]),
    );
    const { client } = storeOf(files);

    const read = await readSpend(client, ["2026-11"], () => false, NOW);

    expect(read.kind === "read" ? Object.keys(read.records).length : read).toBe(1_203);
  });

  it("gives the time zone the store's caller gives the Weekly summary, and UTC when it gives none or there is no caller", async () => {
    const zone = async (files: Record<string, string>) => {
      const read = await readSpend(storeOf(files).client, ["2026-11"], () => false, NOW);
      return read.kind === "read" ? read.timeZone : read;
    };

    expect(await zone({ [CALLER]: callerIn("Australia/Sydney") })).toBe("Australia/Sydney");
    expect(await zone({ [CALLER]: "on:\n  schedule:\n    - cron: \"0 8 * * 1\"\n" })).toBe("UTC");
    expect(await zone({})).toBe("UTC");
  });

  it("returns a refused read as unread, with why, and never throws", async () => {
    const refusal = new GitHubError("GitHub GET /repos/jrey8343/fabrik-runs/git/trees/HEAD failed: 403", 403, {
      body: JSON.stringify({ message: "Resource not accessible by integration" }),
      request: "GET /repos/jrey8343/fabrik-runs/git/trees/HEAD",
    });
    const refusing: ReadClient = { rest: () => Promise.reject(refusal), graphql: () => Promise.reject(refusal), fileText: () => Promise.reject(refusal) };

    expect(await readSpend(refusing, ["2026-11"], () => false, NOW)).toEqual({
      kind: "unread",
      why: "GET /repos/jrey8343/fabrik-runs/git/trees/HEAD failed with 403: Resource not accessible by integration",
    });
  });

  it("returns a failure part way, a record's read GitHub never answered, as unread with why", async () => {
    const { client } = storeOf({ [`${SHOP}/1001-1-implement.json`]: JSON.stringify(aRunRecord({ runId: 1001 })) });
    const failing: ReadClient = {
      ...client,
      fileText: (repo, path, ref) =>
        path.startsWith("runs/") ? Promise.reject(new GitHubError("fetch failed", 0, { request: `GET ${path}@${ref}` })) : client.fileText(repo, path, ref),
    };

    expect(await readSpend(failing, ["2026-11"], () => false, NOW)).toEqual({
      kind: "unread",
      why: `GET ${SHOP}/1001-1-implement.json@HEAD got no answer from GitHub: fetch failed`,
    });
  });

  it("returns a listing GitHub cut short as unread, rather than as a month with fewer records", async () => {
    const { client } = storeOf({ [`${SHOP}/1001-1-implement.json`]: JSON.stringify(aRunRecord({ runId: 1001 })) });
    const cutting: ReadClient = {
      ...client,
      rest: async (method, path) => ({ ...((await client.rest(method, path)) as object), truncated: path.endsWith(encodeURIComponent(`tree:${SHOP}`)) }),
    };

    expect(await readSpend(cutting, ["2026-11"], () => false, NOW)).toEqual({
      kind: "unread",
      why: `GitHub cut short its listing of ${SHOP} in the store`,
    });
  });

  // The count the Ticket asks for: a store of two Product repos, one owner, with two months asked for.
  it("makes ten requests for a first read of two months on two Product repos, plus one per new record, and the same ten for a read with nothing new", async () => {
    const files = {
      [CALLER]: callerIn("Europe/London"),
      ...Object.fromEntries(
        ["shop", "clinic"].flatMap((repo) =>
          ["2026-10", "2026-11"].flatMap((month) =>
            [1, 2, 3].map((run) => [`runs/acme/${repo}/${month}/${run}-1-implement.json`, JSON.stringify(aRunRecord({ repo: `acme/${repo}`, runId: run }))]),
          ),
        ),
      ),
    };
    const first = storeOf(files);
    const read = await readSpend(first.client, ["2026-11", "2026-10"], () => false, NOW);
    const paths = new Set(read.kind === "read" ? Object.keys(read.records) : []);
    const later = storeOf(files);
    const again = await readSpend(later.client, ["2026-11", "2026-10"], (path) => paths.has(path), NOW);

    expect(paths.size).toBe(12);
    expect(first.requests).toHaveLength(10 + 12);
    expect(again).toMatchObject({ kind: "read", records: {}, unreadable: { count: 0, newestSchema: null } });
    expect(later.requests).toHaveLength(10);
  });
});

describe("Runner time over a week's Run records", () => {
  it("sums each run's duration rounded up to a whole minute, and counts the records with no duration, which add nothing", () => {
    const records = [aRunRecord({ runId: 1, durationMs: 61_000 }), aRunRecord({ runId: 2, durationMs: 59_000 }), aRunRecord({ runId: 3, durationMs: null })];

    expect(runnerTimeOf(records)).toEqual({ minutes: 3, uncounted: 1 });
  });

  it("is nothing for a week with no records", () => {
    expect(runnerTimeOf([])).toEqual({ minutes: 0, uncounted: 0 });
  });
});
