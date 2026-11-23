import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { readFiles } from "./files.ts";

const HEAD = "c".repeat(40);
const OTHER = "e".repeat(40);

/** What a path holds in the canned repo: a file, or something that is no file's text in a query. */
type Entry =
  | { readonly text: string }
  /** A binary file: a query gives no text of it, and the single read its bytes as text. */
  | { readonly binary: string }
  /** A file a query gives only the start of. */
  | { readonly truncated: string }
  /** A symbolic link: a query gives the path it points at, and the single read the text of the file there. */
  | { readonly symlink: string; readonly reads: string }
  | "directory"
  | "submodule";

/** The modes GitHub gives a tree's entries. */
const MODE = { file: 33188, directory: 16384, symlink: 40960, submodule: 57344 } as const;

/** `owner/product` at HEAD: a path not here holds nothing, and a directory is any path another is under. */
const AT_HEAD: Readonly<Record<string, Entry>> = {
  "README.md": { text: "# Product\n" },
  ".fabrik/config.json": { text: '{ "max_in_flight": 3 }\n' },
  ".fabrik/implement.md": { text: "Run the tests before you push.\n" },
  "docs/guide.md": { text: "The guide.\n" },
  "vendor/lib": "submodule",
  "logo.png": { binary: "\u0089PNG\r\n" },
  "big.json": { truncated: `[${"1,".repeat(50)}1]` },
  "AGENTS.md": { symlink: "docs/guide.md", reads: "The guide.\n" },
};

/** `owner/product` at another commit, where README.md says something else. */
const AT_OTHER: Readonly<Record<string, Entry>> = { "README.md": { text: "# Another product\n" } };

/** What a canned GitHub was asked: each query, each ref a query read a path at, and each file read singly. */
interface Asked {
  readonly queries: number;
  readonly refs: readonly string[];
  readonly singly: readonly string[];
}

/**
 * A client over `owner/product` at two commits, answering each object a
 * query asks for by its `ref:path` expression as GitHub does, and each file
 * read singly as the Kit's REST read does, counting what it was asked. It
 * makes no REST call.
 */
function productRepo(options: { readonly refuseQuery?: GitHubError; readonly refuseSingly?: GitHubError } = {}): { client: ReadClient; asked: () => Asked } {
  let queries = 0;
  const refs: string[] = [];
  const singly: string[] = [];
  const treeAt = (ref: string) => (ref === HEAD ? AT_HEAD : ref === OTHER ? AT_OTHER : null);
  const entryAt = (tree: Readonly<Record<string, Entry>>, path: string): Entry | null =>
    tree[path] ?? (path === "" || Object.keys(tree).some((held) => held.startsWith(`${path}/`)) ? "directory" : null);
  const modeOf = (entry: Entry) =>
    entry === "directory" ? MODE.directory : entry === "submodule" ? MODE.submodule : "symlink" in entry ? MODE.symlink : MODE.file;
  /** The object GitHub gives for `ref:path`. */
  const objectAt = (expression: string) => {
    const [ref = "", path = ""] = expression.split(/:(.*)/s);
    refs.push(ref);
    const tree = treeAt(ref);
    const entry = tree === null ? null : entryAt(tree, path);
    if (tree === null || entry === null || entry === "submodule") return null;
    if (entry === "directory") {
      const under = Object.keys(tree).flatMap((held) => (path === "" || held.startsWith(`${path}/`) ? [held.slice(path === "" ? 0 : path.length + 1).split("/")[0] ?? ""] : []));
      return { __typename: "Tree", entries: [...new Set(under)].map((name) => ({ name, mode: modeOf(entryAt(tree, path === "" ? name : `${path}/${name}`)!) })) };
    }
    if ("binary" in entry) return { __typename: "Blob", text: null, isBinary: true, isTruncated: false };
    if ("truncated" in entry) return { __typename: "Blob", text: entry.truncated.slice(0, 10), isBinary: false, isTruncated: true };
    return { __typename: "Blob", text: "symlink" in entry ? entry.symlink : entry.text, isBinary: false, isTruncated: false };
  };
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The files read makes no REST call")),
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      queries += 1;
      expect(variables).toMatchObject({ owner: "owner", name: "product" });
      if (options.refuseQuery !== undefined) throw options.refuseQuery;
      const objects = [...query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)];
      expect(objects.length).toBeGreaterThan(0);
      return { repository: Object.fromEntries(objects.map(([, alias = "", variable = ""]) => [alias, objectAt(String(variables[variable]))])) } as T;
    },
    async fileText(repo: Repo, path: string, ref: string) {
      expect(repo).toEqual({ owner: "owner", name: "product" });
      singly.push(`${path}@${ref}`);
      if (options.refuseSingly !== undefined) throw options.refuseSingly;
      const entry = treeAt(ref)?.[path];
      if (entry === undefined || entry === "directory" || entry === "submodule") return null;
      return "text" in entry ? entry.text : "binary" in entry ? entry.binary : "truncated" in entry ? entry.truncated : entry.reads;
    },
  };
  return { client, asked: () => ({ queries, refs: [...new Set(refs)], singly }) };
}

/** A refusal for want of a permission, as GitHub answers an App that lacks one. */
const REFUSAL = new GitHubError("GitHub POST /graphql failed: 403", 403, {
  request: "POST /graphql",
  body: JSON.stringify({ message: "Resource not accessible by integration" }),
});

describe("the files read", () => {
  it("gives each of several files its text, in one query at the one commit, and reads none singly", async () => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", HEAD, ["README.md", ".fabrik/config.json", ".fabrik/implement.md", "docs/guide.md"])).toEqual({
      "README.md": "# Product\n",
      ".fabrik/config.json": '{ "max_in_flight": 3 }\n',
      ".fabrik/implement.md": "Run the tests before you push.\n",
      "docs/guide.md": "The guide.\n",
    });
    expect(asked()).toEqual({ queries: 1, refs: [HEAD], singly: [] });
  });

  it("reads each path at the commit it is given, not at another", async () => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", OTHER, ["README.md", ".fabrik/config.json"])).toEqual({ "README.md": "# Another product\n", ".fabrik/config.json": null });
    expect(asked()).toEqual({ queries: 1, refs: [OTHER], singly: [] });
  });

  it.each([
    ["a path with nothing at it", ".fabrik/review.md"],
    ["a directory", "docs"],
    ["a submodule", "vendor/lib"],
  ])("gives %s as no file, and reads it not singly", async (_what, path) => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", HEAD, [path, "README.md"])).toEqual({ [path]: null, "README.md": "# Product\n" });
    expect(asked()).toMatchObject({ queries: 1, singly: [] });
  });

  it.each([
    ["a binary file", "logo.png", "\u0089PNG\r\n"],
    ["a file the query truncates", "big.json", `[${"1,".repeat(50)}1]`],
    ["a symbolic link, whose text in a query is the path it points at", "AGENTS.md", "The guide.\n"],
  ])("reads %s singly, at the same commit, and gives the text the single read gives", async (_what, path, text) => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", HEAD, [path, "README.md"])).toEqual({ [path]: text, "README.md": "# Product\n" });
    expect(asked()).toEqual({ queries: 1, refs: [HEAD], singly: [`${path}@${HEAD}`] });
  });

  it("reads a path asked twice once", async () => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", HEAD, ["README.md", "README.md"])).toEqual({ "README.md": "# Product\n" });
    expect(asked()).toEqual({ queries: 1, refs: [HEAD], singly: [] });
  });

  it("asks GitHub nothing when asked for no path", async () => {
    const { client, asked } = productRepo();

    expect(await readFiles(client, "owner/product", HEAD, [])).toEqual({});
    expect(asked()).toEqual({ queries: 0, refs: [], singly: [] });
  });

  it("throws the refusal when GitHub refuses the query, and reads nothing singly", async () => {
    const { client, asked } = productRepo({ refuseQuery: REFUSAL });

    await expect(readFiles(client, "owner/product", HEAD, ["README.md"])).rejects.toBe(REFUSAL);
    expect(asked()).toEqual({ queries: 1, refs: [], singly: [] });
  });

  it("throws the refusal when GitHub refuses a single read", async () => {
    const refused = new GitHubError("GitHub GET big.json failed: 403", 403, { request: "GET big.json" });
    const { client } = productRepo({ refuseSingly: refused });

    await expect(readFiles(client, "owner/product", HEAD, ["big.json", "README.md"])).rejects.toBe(refused);
  });
});
