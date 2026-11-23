// The notes for the minor in which the read library asks GitHub for less
// (#894) are drafted ahead, beside the others (#899). While they are a draft
// they must say what the code does: each cost they give now is the one the
// read makes over a client that counts what it was asked, and every name
// they give is one the code holds under that name. Once the release ships
// they are a record, listed in RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import type { ReadClient } from "../github/client.ts";
import { KIT_CONFIG_SOURCE_PATHS } from "../github/snapshot.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import { aRunRecord, readDeployments, readFiles, readNamedRuns, readRuns, readSpend } from "../read/index.ts";
import { CALLER_PATH } from "../setup/shims.ts";

const NOTES = "docs/release-notes/cheaper-reads.md";
const NOW = "2026-11-23T09:05:30Z";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The notes' section under `## heading`, up to the next one. */
const section = (notes: string, heading: string): string => notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

/** The bullet of `text` that opens with `lead` in bold. */
const bullet = (text: string, lead: string): string => text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";

/** The exports the four Tickets added to the read library's entry, and no others. */
const NEW_EXPORTS = ["readNamedRuns", "foldNamedRuns", "NamedRunsRead", "NamedRun", "readFiles", "FilesRead"];

/** What the notes write as code that is no export, and the file that holds it under that name. */
const HELD_IN: Readonly<Record<string, string>> = {
  graphql: "src/github/client.ts",
  fileText: "src/github/client.ts",
  created: "src/github/snapshot.ts",
  held: "src/read/spend.ts",
  readAt: "src/read/runs.ts",
  '"unread"': "src/read/runs.ts",
  HEAD: "src/read/files.ts",
};

/** The modes GitHub's query gives a tree's entries. */
const MODE = { file: 33188, directory: 16384 } as const;

/**
 * GitHub's answer to a query of objects by `ref:path` expressions, as the
 * files read asks, over `files` at any ref: each a file, a directory any of
 * them is in, with its entries, or nothing.
 */
function objectsAnswer(files: Readonly<Record<string, string>>, query: string, variables: Record<string, unknown>): unknown {
  const objectAt = (expression: string) => {
    const path = expression.split(/:(.*)/s)[1] ?? "";
    const text = files[path];
    if (text !== undefined) return { __typename: "Blob", text, isBinary: false, isTruncated: false };
    const under = Object.keys(files).flatMap((held) => (path === "" || held.startsWith(`${path}/`) ? [held.slice(path === "" ? 0 : path.length + 1)] : []));
    const names = [...new Set(under.map((rest) => rest.split("/")[0] ?? ""))];
    return names.length === 0 ? null : { __typename: "Tree", entries: names.map((name) => ({ name, mode: under.includes(name) ? MODE.file : MODE.directory })) };
  };
  const objects = [...query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)];
  return { repository: Object.fromEntries(objects.map(([, alias = "", variable = ""]) => [alias, objectAt(String(variables[variable]))])) };
}

/** A client answering from canned GitHub, that counts each call it was asked: each REST path, each query, and each file read singly. */
function counting(answers: { rest?: (path: string) => unknown; graphql?: (query: string, variables: Record<string, unknown>) => unknown; files?: Readonly<Record<string, string>> }) {
  const asked = { rest: [] as string[], queries: [] as Record<string, unknown>[], files: [] as string[] };
  const client: ReadClient = {
    rest: (_method, path) => {
      asked.rest.push(path);
      return answers.rest === undefined ? Promise.reject(new Error(`Unexpected REST: ${path}`)) : Promise.resolve(answers.rest(path));
    },
    graphql: <T,>(query: string, variables: Record<string, unknown>) => {
      asked.queries.push(variables);
      return answers.graphql === undefined ? Promise.reject(new Error("Unexpected query")) : Promise.resolve(answers.graphql(query, variables) as T);
    },
    fileText: (_repo, path) => {
      asked.files.push(path);
      return Promise.resolve(answers.files?.[path] ?? null);
    },
  };
  return { client, asked };
}

describe.skipIf(RELEASED_NOTES.has(NOTES))("The cheaper reads release notes, while drafted", () => {
  const notes = read(NOTES);
  const changed = section(notes, "What changed");

  it("open with what they are the notes for, and the releasing guide lists them last among the drafted notes", () => {
    expect(notes.split("\n")[0]).toBe("# Release notes: The read library asks GitHub for less");
    expect(notes).toMatch(/^The notes for the minor release in which the read library asks GitHub for less \(\[#894\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/894\)\)/m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const drafted = read("docs/releasing.md").split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain(
      "(release-notes/kit-opens-issues.md), and the cheaper reads minor's ([#894](https://github.com/jrey8343/fabrik/issues/894)) are [the read library asks GitHub for less](release-notes/cheaper-reads.md).",
    );
  });

  it("hold each of the four Tickets, by its link", () => {
    for (const ticket of [895, 896, 897, 898]) expect(notes).toContain(`[#${ticket}](https://github.com/jrey8343/fabrik/issues/${ticket})`);
  });

  it("say what a gather's files cost before, from the Spec's count, and that they now cost one query and no REST request", async () => {
    const gather = bullet(changed, "The gather's files, in one query");
    // The caller workflow and each of the Kit's files, which the gather read a REST request apiece before.
    expect(1 + KIT_CONFIG_SOURCE_PATHS.length).toBe(11);
    expect(gather).toContain("Before: 11 REST requests a gather, one for the caller workflow and one for each of the Kit's ten files");
    expect(gather).toContain("beside its 20 GraphQL queries");
    expect(gather).toContain("Now: one GraphQL query for all eleven");
    expect(gather).toContain("no REST request: 21 queries and none");

    const paths = [CALLER_PATH, ...KIT_CONFIG_SOURCE_PATHS];
    const { client, asked } = counting({ graphql: (query, variables) => objectsAnswer(Object.fromEntries(paths.map((path) => [path, "text"])), query, variables) });
    await readFiles(client, "acme/shop", "d".repeat(40), paths);
    expect(asked).toEqual({ rest: [], queries: [expect.any(Object)], files: [] });
  });

  it("say the Spend read's new records cost a REST request apiece before and 50 to a query now, one query after another", async () => {
    const spend = bullet(changed, "The Spend read's Run records, a batch to a query");
    expect(spend).toContain("Before: a REST request for each Run record the reader didn't hold, ten at a time.");
    expect(spend).toContain("Now: one GraphQL query for each 50 of them, one after another, so a hundred new records cost two queries, and a read with nothing new asks for none.");

    const month = "runs/acme/shop/2026-11";
    const files = Object.fromEntries(Array.from({ length: 100 }, (_, at) => [`${month}/${1000 + at}-1-implement.json`, JSON.stringify(aRunRecord({ runId: 1000 + at }))]));
    const entriesIn = (dir: string) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Map(Object.keys(files).flatMap((path) => (path.startsWith(prefix) ? [[path.slice(prefix.length).split("/")[0] ?? "", path.slice(prefix.length).includes("/") ? "tree" : "blob"] as const] : [])));
      return [...names].map(([name, type]) => ({ path: name, type, sha: `tree:${prefix}${name}` }));
    };
    const tree = (path: string) => {
      const sha = decodeURIComponent(path.split("/git/trees/")[1] ?? "");
      return { tree: entriesIn(sha === "HEAD" ? "" : sha.replace(/^tree:/, "")), truncated: false };
    };
    const { client, asked } = counting({ rest: tree, graphql: (query, variables) => objectsAnswer(files, query, variables) });
    const spent = await readSpend(client, ["2026-11"], () => false, NOW);

    expect(spent.kind === "read" ? Object.keys(spent.records) : spent).toHaveLength(100);
    expect(asked.queries.map((variables) => Object.values(variables).filter((value) => String(value).endsWith(".json")).length)).toEqual([50, 50]);
    // Only the store's caller is read singly, and the store's trees by REST, none of them a record.
    expect(asked.files).toEqual([".github/workflows/weekly-summary.yml"]);
    expect(asked.rest.filter((path) => !path.includes("/git/trees/"))).toEqual([]);
  });

  it("say the Deployments read cost a request for each Deployment's reports before, and three queries now for 250 Deployments", async () => {
    const deployments = bullet(changed, "The Deployments read, a hundred Deployments to a query");
    expect(deployments).toContain("Before: a REST request for each page of a hundred of the environment's Deployments, and at least one more for each Deployment's reports.");
    expect(deployments).toContain("that one is an estimate");
    expect(deployments).toContain("Now: one GraphQL query for each hundred Deployments, newest first, each with its first hundred reports");
    expect(deployments).toContain("250 Deployments since the earliest merge cost three queries where they cost 253 requests.");

    // 250 Deployments an hour apart since the merge, each of the merge commit and succeeded, and 50 more before it.
    const at = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
    const listed = Array.from({ length: 300 }, (_, hour) => ({
      id: `D${hour}`,
      databaseId: 5000 - hour,
      commitOid: "m".repeat(40),
      environment: "staging",
      createdAt: at(hour),
      statuses: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ state: "SUCCESS", createdAt: at(hour), logUrl: null }] },
    }));
    const page = (_query: string, variables: Record<string, unknown>) => {
      const from = Number(variables["after"] ?? 0);
      const nodes = listed.slice(from, from + 100);
      return { repository: { deployments: { pageInfo: { hasNextPage: from + 100 < listed.length, endCursor: String(from + 100) }, nodes } } };
    };
    const { client, asked } = counting({ graphql: page });
    const deployed = await readDeployments(client, "acme/shop", "staging", [{ mergeCommit: "m".repeat(40), mergedAt: at(249.5) }], NOW);

    expect(deployed.merges["m".repeat(40)]).toMatchObject({ is: "succeeded" });
    expect(asked).toEqual({ rest: [], queries: [expect.any(Object), expect.any(Object), expect.any(Object)], files: [] });
  });

  it("say what the whole runs read cost before, from the Spec's count, and that a named run costs two requests at most", async () => {
    const named = bullet(changed, "A read of named workflow runs, and its fold");
    expect(named).toContain("15 REST requests that day, nine of them pages of the day's listing of over 800 runs, read to find the five still unfinished");
    expect(named).toContain("two requests at most for each, the run and, while it is unfinished and inside the 24 hours, its jobs, with no listing and nothing for the Tick");

    const run = (id: number, status: string) => ({ id, status, created_at: "2026-11-23T08:50:00Z", run_attempt: 1, html_url: `https://github.com/acme/shop/actions/runs/${id}` });
    const actions = (path: string) => (path.endsWith("/jobs?filter=latest&per_page=100") ? { jobs: [] } : path.endsWith("/runs/7") ? run(7, "in_progress") : run(8, "completed"));
    const { client, asked } = counting({ rest: actions });
    await readNamedRuns(client, "acme/shop", [7, 8], NOW);

    expect(asked.rest.toSorted()).toEqual(["/repos/acme/shop/actions/runs/7", "/repos/acme/shop/actions/runs/7/jobs?filter=latest&per_page=100", "/repos/acme/shop/actions/runs/8"]);
  });

  it("say the whole runs read's listing is asked at the same address all hour, and costs the requests it did", async () => {
    const whole = bullet(changed, "The whole runs read's listing, bounded at the hour");
    expect(whole).toContain("Before: its listing's `created` bound was the time to the second, so its address changed every second and no conditional ask of it could match.");
    expect(whole).toContain("so it is asked at the same address all hour");

    const listingAt = async (now: string) => {
      const { client, asked } = counting({ rest: () => ({ total_count: 0, workflow_runs: [] }) });
      await readRuns(client, "acme/shop", now);
      return asked.rest.filter((path) => path.includes("/actions/runs?created="));
    };
    const first = await listingAt(NOW);
    expect(first).toHaveLength(1);
    expect(await listingAt("2026-11-23T09:59:59Z")).toEqual(first);
    expect(await listingAt("2026-11-23T10:00:01Z")).not.toEqual(first);
  });

  it("say the release is a minor, and why, in the releasing guide's terms, with no section to turn it on", () => {
    const why = section(notes, "Why a minor");
    expect(why).toContain("by the releasing guide a new export is not a major");
    expect(why).toContain("It removes nothing the read library exports and changes what none of it means");
    expect(why).toContain("No Kit config field, label, shim, Standing or permission changes");
    expect(why).toContain("Nothing is dormant");
    expect(notes).not.toContain("## To turn it on");
  });

  it("say a Product repo only merges the bump", () => {
    expect(bullet(section(notes, "Upgrading"), "A Product repo merges the bump")).toContain("as for any minor, and does nothing else");
  });

  it("say the Console's line waits on the release's check of the Console, whose run replaces it", () => {
    const console = section(notes, "What the Console needs");
    expect(console).toContain("This line is a guess until the release is checked against the Console (step 4 of [releasing.md](../releasing.md)), and that run's answer replaces it.");
    expect(read("docs/releasing.md")).toContain("A line about the Console in a draft in `docs/release-notes/` was written when the part was built, so it is a guess until this run.");
  });

  describe("name only what the four Tickets shipped, by the name the code holds it under", () => {
    const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];
    /** Everything the notes write as code, each once. */
    const written = [...new Set([...notes.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];

    it("give as new exactly the exports the four added, each one the read library's entry exports", () => {
      const added = bullet(section(notes, "For a reader of the read library"), "New exports.");
      const named = [...added.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").filter((name) => name !== "src/read/index.ts");

      expect(named.toSorted()).toEqual(NEW_EXPORTS.toSorted());
      expect(NEW_EXPORTS.filter((name) => !exported.includes(name))).toEqual([]);
    });

    it("write as code only an export of the entry, a file that exists, or a name the read's own code holds", () => {
      const unknown = written.filter((name) => !exported.includes(name) && !(name.startsWith("src/") && existsSync(join(KIT, name))) && !(name in HELD_IN && read(HELD_IN[name] ?? "").includes(name)));

      expect(unknown).toEqual([]);
    });

    it("name no person and no private repo", () => {
      expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
    });
  });
});
