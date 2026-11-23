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

/** The modes GitHub's query gives a tree's entries. */
const MODE = { file: 33188, directory: 16384 } as const;

/**
 * A canned fabrik-runs store over the API: its files by path, which its git
 * trees list, a file read returns and a query of objects by `ref:path`
 * expressions gives at its default branch, as the files read asks (#895).
 * Every request is logged in `requests`, as `GET <API path>`,
 * `file <path>@<ref>` or `query` and each expression it asked, and each
 * query's paths that end in `.json` in `queried`.
 */
function storeOf(files: Readonly<Record<string, string>>, options: { readonly refuseQuery?: (at: number) => GitHubError | undefined } = {}) {
  const requests: string[] = [];
  const queried: string[][] = [];
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
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const objects = [...query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)].map(([, alias = "", variable = ""]) => [alias, String(variables[variable])] as const);
      if (objects.length === 0 || variables["owner"] !== "jrey8343" || variables["name"] !== "fabrik-runs") throw new Error(`Unexpected GraphQL query: ${query}`);
      requests.push(`query ${objects.map(([, expression]) => expression).join(" ")}`);
      queried.push(objects.flatMap(([, expression]) => (expression.endsWith(".json") ? [expression.replace(/^HEAD:/, "")] : [])));
      const refusal = options.refuseQuery?.(queried.length);
      if (refusal !== undefined) throw refusal;
      /** What GitHub gives for `ref:path` at the default branch: a file, a directory with its entries' modes, or null for nothing there. */
      const objectAt = (expression: string) => {
        const [ref = "", path = ""] = expression.split(/:(.*)/s);
        if (ref !== "HEAD") return null;
        const text = files[path];
        if (text !== undefined) return { __typename: "Blob", text, isBinary: false, isTruncated: false };
        const entries = entriesIn(path);
        return entries.length === 0 ? null : { __typename: "Tree", entries: entries.map(({ path: name, type }) => ({ name, mode: type === "tree" ? MODE.directory : MODE.file })) };
      };
      return { repository: Object.fromEntries(objects.map(([alias, expression]) => [alias, objectAt(expression)])) } as T;
    },
    fileText(repo, path, ref) {
      requests.push(`file ${path}@${ref}`);
      if (repo.owner !== "jrey8343" || repo.name !== "fabrik-runs") return Promise.reject(new Error(`Unexpected repo: ${repo.owner}/${repo.name}`));
      return Promise.resolve(files[path] ?? null);
    },
  };
  return { client, requests, queried };
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
    const { brokenRun: _left, landing: _landing, pushed: _pushed, fullReview: _fullReview, ...schema7 } = aRunRecord({ runId: 1001 });
    const { client } = storeOf({
      [`${SHOP}/1001-1-implement.json`]: JSON.stringify({ ...schema7, schema: 7 }),
      [`${SHOP}/1002-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 1002 }), schema: 14 }),
      [`${SHOP}/1003-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 1003 }), schema: 13 }),
      [`${SHOP}/1004-1-implement.json`]: "not JSON",
    });

    const read = await readSpend(client, ["2026-11"], () => false, NOW);

    expect(read).toMatchObject({
      kind: "read",
      records: { [`${SHOP}/1001-1-implement.json`]: aRunRecord({ runId: 1001, brokenRun: null }) },
      unreadable: { count: 3, newestSchema: 14 },
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

  it("returns a failure part way, the records' query GitHub never answered, as unread with why", async () => {
    const { client } = storeOf(
      { [`${SHOP}/1001-1-implement.json`]: JSON.stringify(aRunRecord({ runId: 1001 })) },
      { refuseQuery: () => new GitHubError("fetch failed", 0, { request: "POST /graphql" }) },
    );

    expect(await readSpend(client, ["2026-11"], () => false, NOW)).toEqual({
      kind: "unread",
      why: "POST /graphql got no answer from GitHub: fetch failed",
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
  it("makes ten requests for a first read of two months on two Product repos, plus one query for its twelve new records, and the same ten for a read with nothing new (#896)", async () => {
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
    expect(first.requests).toHaveLength(10 + 1);
    expect(first.queried).toEqual([[...paths]]);
    expect(again).toMatchObject({ kind: "read", records: {}, unreadable: { count: 0, newestSchema: null } });
    expect(later.requests).toHaveLength(10);
  });

  describe("fetches the records a reader doesn't hold a batch to a query (#896)", () => {
    /** `count` records of the shop's November, from run 5000, each a Run record of its own. */
    const recordsOf = (count: number, from = 5000) =>
      Object.fromEntries(Array.from({ length: count }, (_, at) => [`${SHOP}/${from + at}-1-implement.json`, JSON.stringify(aRunRecord({ runId: from + at }))]));

    it("asks one query for each fifty new records, each record in one of them, and no REST request for any record", async () => {
      const files = { [CALLER]: callerIn("Europe/London"), ...recordsOf(120) };
      const { client, requests, queried } = storeOf(files);

      const read = await readSpend(client, ["2026-11"], () => false, NOW);

      expect(read.kind === "read" ? Object.keys(read.records) : read).toEqual(Object.keys(recordsOf(120)));
      expect(queried.map((paths) => paths.length)).toEqual([50, 50, 20]);
      expect(queried.flat()).toEqual(Object.keys(recordsOf(120)));
      expect(requests.filter((request) => request.startsWith("file "))).toEqual([`file ${CALLER}@HEAD`]);
      expect(requests.filter((request) => request.startsWith("GET ")).every((request) => request.includes("/git/trees/"))).toBe(true);
    });

    it("puts no path the reader holds in any query", async () => {
      const files = recordsOf(60);
      const held = new Set(Object.keys(files).filter((_, at) => at % 3 === 0));
      const { client, requests, queried } = storeOf(files);

      const read = await readSpend(client, ["2026-11"], (path) => held.has(path), NOW);

      expect(read.kind === "read" ? Object.keys(read.records) : read).toEqual(Object.keys(files).filter((path) => !held.has(path)));
      expect(queried.flat().filter((path) => held.has(path))).toEqual([]);
      expect(requests.filter((request) => [...held].some((path) => request.includes(path)))).toEqual([]);
    });

    it("gives a reader that stops the read at a number of new records no more than that, and asks for no other", async () => {
      const files = recordsOf(80);
      const fetched: string[] = [];
      const { client, queried } = storeOf(files);

      const read = await readSpend(
        client,
        ["2026-11"],
        (path) => {
          if (fetched.length >= 3) return true;
          fetched.push(path);
          return false;
        },
        NOW,
      );

      expect(fetched).toEqual(Object.keys(files).slice(0, 3));
      expect(read.kind === "read" ? Object.keys(read.records) : read).toEqual(fetched);
      expect(queried).toEqual([fetched]);
    });

    it("gives the same records, count of those it couldn't read and newest schema among them as it did a file read to a record, across batches", async () => {
      const files = {
        ...recordsOf(70),
        [`${SHOP}/5010-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 5010 }), schema: 14 }),
        [`${SHOP}/5020-1-implement.json`]: "not JSON",
        [`${SHOP}/5065-1-implement.json`]: JSON.stringify({ ...aRunRecord({ runId: 5065 }), schema: 15 }),
      };
      const { client, queried } = storeOf(files);

      const read = await readSpend(client, ["2026-11"], () => false, NOW);

      expect(queried.map((paths) => paths.length)).toEqual([50, 20]);
      expect(read).toEqual({
        kind: "read",
        records: Object.fromEntries(
          Array.from({ length: 70 }, (_, at) => 5000 + at)
            .filter((run) => ![5010, 5020, 5065].includes(run))
            .map((run) => [`${SHOP}/${run}-1-implement.json`, aRunRecord({ runId: run })]),
        ),
        unreadable: { count: 3, newestSchema: 15 },
        timeZone: "UTC",
      });
    });

    it("returns a batch GitHub refuses as unread, with why, giving no record of the batches before it, and never throws", async () => {
      const refusal = new GitHubError("GitHub GraphQL query failed: Resource not accessible by integration", 403, {
        body: JSON.stringify({ message: "Resource not accessible by integration" }),
        request: "POST /graphql",
      });
      const { client, queried } = storeOf(recordsOf(120), { refuseQuery: (at) => (at === 2 ? refusal : undefined) });

      expect(await readSpend(client, ["2026-11"], () => false, NOW)).toEqual({
        kind: "unread",
        why: "POST /graphql failed with 403: Resource not accessible by integration",
      });
      expect(queried).toHaveLength(2);
    });

    it.each<[string, Readonly<Record<string, string>>, (path: string) => boolean]>([
      ["every record of it held", recordsOf(12), () => true],
      ["no record in it", { "runs/acme/shop/2026-10/900-1-implement.json": JSON.stringify(aRunRecord({ runId: 900 })) }, () => false],
    ])("asks for no record at all of a month with %s", async (_what, files, held) => {
      const { client, requests } = storeOf(files);

      expect(await readSpend(client, ["2026-11"], held, NOW)).toMatchObject({ kind: "read", records: {}, unreadable: { count: 0, newestSchema: null } });
      expect(requests.filter((request) => request.startsWith("query ") || (request.startsWith("file ") && request.includes(".json")))).toEqual([]);
    });
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
