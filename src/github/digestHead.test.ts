import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "./client.ts";
import { readDigestHead } from "./digestHead.ts";

const HEAD = "a".repeat(40);
const repo = { owner: "acme", name: "shop" };

/** A file of the pull request, as GitHub's REST API lists it. */
interface RestFile {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
}

/**
 * acme/shop as GitHub answers for it: each file's text at `HEAD`, or the
 * error GitHub refuses it with, and #50's files. Every call the read made is
 * recorded, in order.
 */
function gitHub(texts: Readonly<Record<string, string | Error>>, files: readonly RestFile[] = []): { client: ReadClient; calls: string[] } {
  const calls: string[] = [];
  const client: ReadClient = {
    graphql: () => Promise.reject(new Error("The head's read asks no GraphQL")),
    rest: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const [route, query] = path.split("?");
      if (route !== "/repos/acme/shop/pulls/50/files") throw new Error(`unexpected REST call ${path}`);
      const page = Number(/(?:^|&)page=(\d+)/.exec(query ?? "")?.[1] ?? "1");
      return files.slice((page - 1) * 100, page * 100);
    },
    fileText: async (of, path, ref) => {
      calls.push(`text ${of.owner}/${of.name} ${path}@${ref}`);
      const text = texts[path];
      if (text instanceof Error) throw text;
      return text ?? null;
    },
  };
  return { client, calls };
}

describe("The read of what the head holds, for a Digest's places", () => {
  it("is the text at the head of each file named, read once each, and the pull request's files with their patches", async () => {
    const { client, calls } = gitHub({ "src/basket/save.ts": "export const day = 24;\n", "src/basket/copy.ts": "export const copy = {};\n" }, [
      { filename: "src/basket/save.ts", status: "modified", patch: "@@ -1 +1 @@\n-export const day = 12;\n+export const day = 24;" },
      { filename: "public/basket.png", status: "added" },
    ]);

    const head = await readDigestHead(client, repo, 50, HEAD, ["src/basket/save.ts", "src/basket/copy.ts", "src/basket/save.ts"]);

    expect(head).toEqual({
      files: [
        { path: "src/basket/save.ts", text: "export const day = 24;\n" },
        { path: "src/basket/copy.ts", text: "export const copy = {};\n" },
      ],
      changed: [
        { path: "src/basket/save.ts", patch: "@@ -1 +1 @@\n-export const day = 12;\n+export const day = 24;" },
        { path: "public/basket.png", patch: null },
      ],
    });
    expect(calls.toSorted()).toEqual([
      "GET /repos/acme/shop/pulls/50/files?per_page=100&page=1",
      `text acme/shop src/basket/copy.ts@${HEAD}`,
      `text acme/shop src/basket/save.ts@${HEAD}`,
    ]);
  });

  it("asks GitHub nothing when no place is named", async () => {
    const { client, calls } = gitHub({});

    expect(await readDigestHead(client, repo, 50, HEAD, [])).toEqual({ files: [], changed: [] });
    expect(calls).toEqual([]);
  });

  it("reads a file the head lacks as not there", async () => {
    const { client } = gitHub({});

    expect((await readDigestHead(client, repo, 50, HEAD, ["src/basket/gone.ts"])).files).toEqual([{ path: "src/basket/gone.ts", text: null }]);
  });

  it("never asks for a path that is no file's path in the repo: one that climbs out of it, starts at a root or names no file", async () => {
    const { client, calls } = gitHub({});
    const paths = ["../../other/repo/contents/secret.txt", "src/../../../other/secret.txt", "/etc/passwd", "src//save.ts", "./src/save.ts", "src/basket/"];

    const head = await readDigestHead(client, repo, 50, HEAD, paths);

    expect(head.files).toEqual(paths.map((path) => ({ path, text: null })));
    expect(calls.filter((call) => call.startsWith("text "))).toEqual([]);
  });

  it("reads a file GitHub refuses to give, such as one too large to read, as not there", async () => {
    const tooLarge = new GitHubError("GitHub GET data/prices.csv failed: 403", 403, { body: '{"message":"This API returns blobs up to 100 MB in size."}', rateLimitRemaining: "4900" });
    const { client } = gitHub({ "data/prices.csv": tooLarge, "src/basket/save.ts": "export const day = 24;\n" });

    expect((await readDigestHead(client, repo, 50, HEAD, ["data/prices.csv", "src/basket/save.ts"])).files).toEqual([
      { path: "data/prices.csv", text: null },
      { path: "src/basket/save.ts", text: "export const day = 24;\n" },
    ]);
  });

  it.each([
    ["GitHub's own failure", new GitHubError("GitHub GET src/basket/save.ts failed: 502", 502)],
    ["a rate limit", new GitHubError("GitHub GET src/basket/save.ts failed: 403", 403, { body: "API rate limit exceeded", rateLimitRemaining: "0" })],
    ["no answer at all", new GitHubError("GitHub GET src/basket/save.ts failed: fetch failed", 0)],
  ])("fails on %s, which says nothing of whether the head has the file", async (_what, error) => {
    const { client } = gitHub({ "src/basket/save.ts": error });

    await expect(readDigestHead(client, repo, 50, HEAD, ["src/basket/save.ts"])).rejects.toBe(error);
  });

  it("reads every page of the pull request's files", async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({ filename: `src/file${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }));
    const { client, calls } = gitHub({ "src/file100.ts": "b\n" }, files);

    const head = await readDigestHead(client, repo, 50, HEAD, ["src/file100.ts"]);

    expect(head.changed).toHaveLength(101);
    expect(head.changed.at(-1)).toEqual({ path: "src/file100.ts", patch: "@@ -1 +1 @@\n-a\n+b" });
    expect(calls.filter((call) => call.startsWith("GET "))).toEqual([
      "GET /repos/acme/shop/pulls/50/files?per_page=100&page=1",
      "GET /repos/acme/shop/pulls/50/files?per_page=100&page=2",
    ]);
  });
});
