import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { wordStanding } from "../kit/standingWording.ts";
import { endedHeldLine } from "../loop/heldLine.ts";
import { followUpsSection, type NamedFollowUp } from "../loop/followUps.ts";
import { FOLLOW_UPS_OPENED_MARKER, trialProblemLine, verdictMarker } from "../loop/markers.ts";
import { aDigestComment, aRollInComment } from "./builders.ts";
import { type Facts, gatherRepo } from "./gather.ts";
import { closedIssueCommentsQuery, MERGED_PULL_REQUESTS_QUERY, mergedCommentsQuery } from "./homeQueries.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";
import { promoteListOf } from "./promoteList.ts";
import { rowsOf } from "./rows.ts";

const NOW = "2026-11-09T12:00:00Z";
const APP = { __typename: "Bot", login: "fabrik-app" };
const OPERATOR = { __typename: "User", login: "jrey8343" };
const HEAD = "a".repeat(40);
const CALLER_PATH = ".github/workflows/fabrik.yml";
const CALLER = "jobs:\n  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v3.1.0\n";
const CONFIG_PATH = ".fabrik/config.json";

/** What one repo holds on GitHub, as the gather's queries read it, with nothing unless a test says so. */
interface RawRepo {
  /** Its files at the default branch's head. */
  files?: Record<string, string>;
  /** Null for a repo with no default branch yet. */
  branch?: { name: string; head: string } | null;
  /** Every issue, open and closed: a query asking for `states: OPEN` gets the open ones, as from GitHub. */
  issues?: Record<string, unknown>[];
  openPullRequests?: Record<string, unknown>[];
  /** The merged pull requests, newest-updated first. */
  mergedPullRequests?: Record<string, unknown>[];
  /** Its Deployments by environment, in any order: a query gets them by creation, in the direction it asks for. */
  deployments?: Record<string, Record<string, unknown>[]>;
  /** The closed issues labelled as a Check's issue, updated in the last week. */
  closedCheckIssues?: Record<string, unknown>[];
  /** Fail every query whose text holds this. */
  failing?: string;
  /**
   * The files of `files` a query will not give whole, read singly instead: a
   * binary one or one it truncates; and the paths that are a submodule, which
   * a query finds nothing at.
   */
  kinds?: Record<string, "binary" | "truncated" | "submodule">;
  /** Refuse the single read of this file, as GitHub refuses one for want of a permission. */
  failingFile?: string;
}

/** Every call a gather made of the client: each query's text, each ref a query read a path at, and each file read singly, a REST request with the Kit's own client. */
interface Calls {
  readonly queries: string[];
  readonly refs: string[];
  readonly files: string[];
}

/**
 * A read-only client over `jrey8343/shop`, answering each query the gather
 * makes with one page, and recording what it was asked. A query that reads a
 * connection of Deployments or merged pull requests from a cursor gets as
 * many as it asks for at a time.
 */
function repoWith(raw: RawRepo): { client: ReadClient; calls: Calls } {
  const calls: Calls = { queries: [], refs: [], files: [] };
  const page = (nodes: unknown[] = []) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const branch = raw.branch === undefined ? { name: "main", head: HEAD } : raw.branch;
  const issues = raw.issues ?? [];
  const files = raw.files ?? {};
  const kinds = raw.kinds ?? {};
  /** What GitHub's query gives of `ref:path`: a file, a directory with its entries' modes, or null for nothing there or a submodule. */
  const objectAt = (expression: string) => {
    const [ref = "", path = ""] = expression.split(/:(.*)/s);
    calls.refs.push(ref);
    if (ref !== branch?.head || kinds[path] === "submodule") return null;
    const text = files[path];
    if (text !== undefined) {
      const kind = kinds[path];
      return { __typename: "Blob", text: kind === "binary" ? null : kind === "truncated" ? text.slice(0, 5) : text, isBinary: kind === "binary", isTruncated: kind === "truncated" };
    }
    const held = [...Object.keys(files), ...Object.keys(kinds)];
    const under = [...new Set(held.flatMap((at) => (path === "" || at.startsWith(`${path}/`) ? [at.slice(path === "" ? 0 : path.length + 1).split("/")[0] ?? ""] : [])))];
    if (under.length === 0) return null;
    const modeOf = (name: string) => {
      const at = path === "" ? name : `${path}/${name}`;
      return kinds[at] === "submodule" ? 57344 : files[at] === undefined ? 16384 : 33188;
    };
    return { __typename: "Tree", entries: under.map((name) => ({ name, mode: modeOf(name) })) };
  };
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The gather reads no REST")),
    async fileText(repo: Repo, path: string, ref: string) {
      expect(repo).toEqual({ owner: "jrey8343", name: "shop" });
      expect(ref).toBe(branch?.head);
      calls.files.push(path);
      if (path === raw.failingFile) throw new GitHubError(`GitHub GET ${path} failed: 403`, 403, { request: `GET ${path}`, body: JSON.stringify({ message: "Resource not accessible by integration" }) });
      return kinds[path] === "submodule" ? null : (files[path] ?? null);
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.queries.push(query);
      expect(variables).toMatchObject({ owner: "jrey8343", name: "shop" });
      if (raw.failing !== undefined && query.includes(raw.failing)) throw new GitHubError("GitHub GraphQL failed: 502", 502, { request: "POST /graphql", body: "Bad Gateway" });
      const answer = (data: unknown) => data as T;
      const asked = (nodes: Record<string, unknown>[]) => (/states: OPEN/.test(query) ? nodes.filter(({ state }) => state === undefined || state === "OPEN") : nodes);
      const labelled = (label: unknown) => asked(issues).filter((issue) => ((issue["labels"] as { nodes: { name: string }[] } | undefined)?.nodes ?? []).some(({ name }) => name === label));
      if (query.includes("defaultBranchRef { name target { oid } }") && !query.includes("issues(")) {
        return answer({ repository: { owner: { login: "jrey8343" }, defaultBranchRef: branch === null ? null : { name: branch.name, target: { oid: branch.head } } } });
      }
      // The objects a query asks for by a `ref:path` expression, each under an alias of its own, as GitHub gives them at the default branch's head.
      const objects = [...query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)];
      if (objects.length > 0) return answer({ repository: Object.fromEntries(objects.map(([, alias = "", variable = ""]) => [alias, objectAt(String(variables[variable]))])) });
      // A page of as many as the query asks for first, from its cursor, which here is how many came before.
      const paged = (nodes: Record<string, unknown>[]) => {
        const from = Number(variables["after"] ?? 0);
        const to = from + Number(/first: (\d+), after: \$after/.exec(query)?.[1]);
        return { pageInfo: { hasNextPage: to < nodes.length, endCursor: to < nodes.length ? String(to) : null }, nodes: nodes.slice(from, to) };
      };
      const newestFirst = (nodes: Record<string, unknown>[], by: string) => nodes.toSorted((a, b) => Date.parse(String(b[by])) - Date.parse(String(a[by])));
      if (query.includes("deployments(environments: [$environment]")) {
        const created = newestFirst(raw.deployments?.[String(variables["environment"])] ?? [], "createdAt");
        return answer({ repository: { deployments: paged(query.includes("direction: DESC") ? created : created.toReversed()) } });
      }
      if (query.includes("pullRequests(states: MERGED") && query.includes("$after")) return answer({ repository: { pullRequests: paged(newestFirst(raw.mergedPullRequests ?? [], "updatedAt")) } });
      if (query.includes("pullRequests(states: MERGED")) return answer({ repository: { pullRequests: page(raw.mergedPullRequests) } });
      if (query.includes("pullRequests(states: OPEN, first: 25")) return answer({ repository: { pullRequests: page(raw.openPullRequests) } });
      if (query.includes("labels: [$needsDesign]")) return answer({ repository: { owner: { login: "jrey8343" }, issues: page(labelled(variables["needsDesign"])) } });
      // Dispatch's own reads ask more of each issue, which an issue here has none of.
      const candidate = (issue: Record<string, unknown>) => ({ ...issue, blockedBy: { nodes: [] }, issueDependenciesSummary: { blockedBy: 0 }, closedByPullRequestsReferences: { nodes: [] }, subIssues: { totalCount: 0 }, assignees: { nodes: [] }, parent: null });
      if (query.includes("labels: [$ready]")) return answer({ repository: { owner: { login: "jrey8343" }, issues: page(labelled(variables["ready"]).map(candidate)), pullRequests: { nodes: [] } } });
      if (query.includes("labels: [$research]")) return answer({ repository: { issues: page(labelled(variables["research"]).map(candidate)) } });
      if (query.includes("issues(states: CLOSED, labels: $labels")) {
        // The week before NOW.
        expect(variables).toMatchObject({ labels: ["fabrik:flaky-check"], since: "2026-11-02T12:00:00.000Z" });
        return answer({ repository: { issues: { nodes: raw.closedCheckIssues ?? [] } } });
      }
      if (query.includes("labels: $labels")) return answer({ repository: { owner: { login: "jrey8343" }, issues: { nodes: [] } } });
      if (query.includes("issues(labels: [$label], states: [OPEN, CLOSED]")) return answer({ repository: { defaultBranchRef: null, issues: { nodes: labelled(variables["label"]) } } });
      if (query.includes("issues(states: OPEN")) return answer({ repository: { issues: page(asked(issues)) } });
      // Merged pull requests by number, each under an alias of its own, for their comments: what the repo holds of each, with none unless a test gives some.
      const mergedByNumber = [...query.matchAll(/(\w+): pullRequest\(number: (\d+)\)/g)];
      if (mergedByNumber.length > 0) {
        const held = ([, alias = "", number]: RegExpMatchArray) => {
          const merged = (raw.mergedPullRequests ?? []).find((pullRequest) => pullRequest["number"] === Number(number));
          return [alias, merged === undefined ? null : { number: Number(number), comments: merged["comments"] ?? { nodes: [] } }];
        };
        return answer({ repository: Object.fromEntries(mergedByNumber.map(held)) });
      }
      // Issues by number, each under an alias of its own: what the repo holds of it, or null for one it has none of.
      const byNumber = [...query.matchAll(/(\w+): issue\(number: (\d+)\)/g)];
      if (byNumber.length > 0) {
        const held = ([, alias = "", number]: RegExpMatchArray) => [alias, issues.find((issue) => issue["number"] === Number(number)) ?? null];
        return answer({ repository: Object.fromEntries(byNumber.map(held)) });
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { client, calls };
}

describe("a gather shaped for Home", () => {
  describe("a repo that doesn't run the Kit", () => {
    it.each([
      ["no caller workflow", {}],
      ["a caller workflow that pins no Fabrik release", { files: { [CALLER_PATH]: "jobs:\n  build:\n    runs-on: ubuntu-latest\n" } }],
      ["a caller workflow path that is a directory", { files: { [`${CALLER_PATH}/fabrik.yml`]: CALLER } }],
      ["a caller workflow path that is a submodule", { kinds: { [CALLER_PATH]: "submodule" } }],
    ] as const)("with %s is no Product repo, and nothing is read past the one query of its caller workflow and Kit files (#895)", async (_what, raw) => {
      const { client, calls } = repoWith(raw);

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false, store: false });
      expect(calls.files).toEqual([]);
      expect(calls.queries).toHaveLength(2);
    });

    it("with no default branch yet is no Product repo, and reads no file", async () => {
      const { client, calls } = repoWith({ branch: null, files: { [CALLER_PATH]: CALLER } });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false, store: false });
      expect(calls.files).toEqual([]);
      expect(calls.queries).toHaveLength(1);
    });
  });

  describe("its caller workflow and Kit files (#895)", () => {
    const SKILLS_LOCK_PATH = ".fabrik/skills.lock.json";
    const IMPLEMENT_PATH = ".fabrik/implement.md";
    /** A Product repo whose caller workflow and Kit files are all text. */
    const TEXT_FILES = {
      [CALLER_PATH]: CALLER,
      [CONFIG_PATH]: '{ "operator": "kate", "max_in_flight": 3 }',
      [SKILLS_LOCK_PATH]: "[]",
      [IMPLEMENT_PATH]: "Run the tests before you push.",
    };

    it("are read in one query at the default branch's head the repo query gave, with no REST request, and give the read a file read of each gave", async () => {
      const { client, calls } = repoWith({ files: TEXT_FILES });
      // The same repo, whose query gives no file whole, so each is read singly, as every gather read them before. No path is read singly from the first, so every one the Kit config is resolved from was in the query.
      const singly = repoWith({ files: TEXT_FILES, kinds: Object.fromEntries(Object.keys(TEXT_FILES).map((path) => [path, "truncated"])) });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read).toEqual(await gatherRepo(singly.client, "jrey8343/shop", NOW));
      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "kate", kitConfig: { ok: true, config: { maxInFlight: 3, instructions: { implement: "Run the tests before you push." } } }, unread: null });
      expect(singly.calls.files.toSorted()).toEqual(Object.keys(TEXT_FILES).toSorted());
      expect(calls.files).toEqual([]);
      expect(calls.queries.filter((query) => query.includes("object(expression:"))).toHaveLength(1);
      expect(new Set(calls.refs)).toEqual(new Set([HEAD]));
    });

    it.each([
      ["a path with nothing at it", {}, {}],
      ["a directory", { [`${IMPLEMENT_PATH}/notes.md`]: "Not an instruction." }, {}],
      ["a submodule", {}, { [IMPLEMENT_PATH]: "submodule" }],
    ] as const)("read a Kit file at %s as no file, and read it not singly", async (_what, files, kinds) => {
      const { [IMPLEMENT_PATH]: _implement, ...others } = TEXT_FILES;
      const { client, calls } = repoWith({ files: { ...others, ...files }, kinds });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read.product && read.kitConfig).toEqual({ ok: true, config: expect.objectContaining({ operator: "kate", instructions: expect.objectContaining({ implement: null }) }) });
      expect(calls.files).toEqual([]);
    });

    it.each([
      ["a binary", "binary"],
      ["a truncated", "truncated"],
    ] as const)("read %s caller workflow or Kit file singly, at the same head, and give the text the single read gives", async (_what, kind) => {
      const { client, calls } = repoWith({ files: TEXT_FILES, kinds: { [CALLER_PATH]: kind, [CONFIG_PATH]: kind } });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "kate", kitConfig: { ok: true, config: { maxInFlight: 3 } }, unread: null });
      expect(calls.files.toSorted()).toEqual([CALLER_PATH, CONFIG_PATH].toSorted());
    });

    it.each([
      ["their query", { failing: "object(expression:" }, { status: 502, request: "POST /graphql" }, []],
      // As every gather failed when GitHub refused its read of the caller workflow.
      ["the single read of a caller workflow it gives whole in no query", { kinds: { [CALLER_PATH]: "truncated" }, failingFile: CALLER_PATH }, { status: 403, request: `GET ${CALLER_PATH}` }, [CALLER_PATH]],
    ] as const)("fail the gather with GitHub's refusal when it refuses %s, and nothing more is read", async (_what, raw, refusal, singly) => {
      const { client, calls } = repoWith({ files: TEXT_FILES, ...raw });

      await expect(gatherRepo(client, "jrey8343/shop", NOW)).rejects.toMatchObject({ name: "GitHubError", ...refusal });
      expect(calls.files).toEqual(singly);
      expect(calls.queries).toHaveLength(2);
    });
  });

  describe("a Product repo", () => {
    it("gives the release its caller pins, the Operator its Kit config names and that Kit config as the Kit resolves it", async () => {
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: '{ "operator": "kate", "max_in_flight": 3 }' } });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read).toMatchObject({ repo: "jrey8343/shop", product: true, release: "v3.1.0", operator: "kate", unread: null });
      expect(read.product && read.kitConfig).toEqual({ ok: true, config: expect.objectContaining({ operator: "kate", maxInFlight: 3 }) });
      expect(read.product && read.facts).toMatchObject({ kind: "product", operator: "kate", appLogin: null });
    });

    it("takes the repo's owner for the Operator when the Kit config names none, and gives no release for a caller that pins none exactly", async () => {
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER.replace("@v3.1.0", "@main") } });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toMatchObject({ product: true, release: null, operator: "jrey8343", kitConfig: { ok: true } });
    });

    it("gives an invalid Kit config's errors, reads the repo with the Kit's defaults and Dispatch's candidates not at all, and still gives its facts", async () => {
      const { client, calls } = repoWith({ files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: '{ "maxInFlight": 3 }' } });

      const read = await gatherRepo(client, "jrey8343/shop", NOW, "fabrik-app[bot]");

      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "jrey8343", kitConfig: { ok: false, errors: [expect.stringContaining("maxInFlight")] }, unread: null });
      expect(read.product && read.facts).toMatchObject({ kit: { config: { ok: false }, dispatch: null }, appLogin: "fabrik-app[bot]" });
      expect(calls.queries.some((query) => query.includes("labels: [$ready]") || query.includes("labels: [$research]"))).toBe(false);
    });

    it("still gives the release, the Operator and the Kit config when a query of the facts fails, with no facts and why", async () => {
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: '{ "operator": "kate" }' }, failing: "pullRequests(states: OPEN" });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "kate", kitConfig: { ok: true }, facts: null, unread: "POST /graphql failed with 502: Bad Gateway" });
    });
  });

  describe("whether a Product repo has a ui block", () => {
    const UI = '{ "ui": { "paths": ["src/**/*.tsx"], "serve": "npm run preview", "url": "http://localhost:4173" } }';

    it.each([
      ["yes for a Kit config with a ui block", UI, "yes"],
      ["no for a Kit config with ui: null", '{ "ui": null }', "no"],
      ["no for a Kit config with no ui block", '{ "operator": "kate" }', "no"],
      ["no for a repo with no Kit config", undefined, "no"],
      ["unknown for an invalid Kit config", '{ "ui": { "paths": [] } }', "unknown"],
    ] as const)("is %s", async (_what, config, uiBlock) => {
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER, ...(config === undefined ? {} : { [CONFIG_PATH]: config }) } });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toMatchObject({ product: true, uiBlock });
    });

    it("is unknown when the Kit config could not be read, with no facts and why, and the read does not throw", async () => {
      // GitHub gives the Kit config whole in no query, and refuses the single read of it.
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: '{ "operator": "kate" }' }, kinds: { [CONFIG_PATH]: "truncated" }, failingFile: CONFIG_PATH });

      const read = await gatherRepo(client, "jrey8343/shop", NOW);

      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "jrey8343", uiBlock: "unknown", kitConfig: { ok: false }, facts: null, unread: "GET .fabrik/config.json failed with 403: Resource not accessible by integration" });
    });

    it("is still said when a query of the facts fails", async () => {
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: UI }, failing: "pullRequests(states: OPEN" });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toMatchObject({ uiBlock: "yes", facts: null });
    });
  });

  describe("what it asks GitHub", () => {
    /**
     * Every query a gather of a Product repo with a valid Kit config makes,
     * with something on each page, and an issue closed as not planned that
     * is cross-referenced to its open agent pull request, so the query for
     * such issues' comments is among them.
     */
    async function everyQuery(): Promise<string[]> {
      const { client, calls } = repoWith({
        files: { [CALLER_PATH]: CALLER },
        issues: [
          aRawIssue({ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] } }),
          aRawIssue({ number: 8, labels: { nodes: [{ name: "needs-design" }] } }),
          aRawIssue({ number: 30, state: "CLOSED" }),
        ],
        openPullRequests: [aRawOpenPullRequest({ crossReferences: { nodes: [aRawCrossReference(30, "CLOSED", "NOT_PLANNED")] } })],
        mergedPullRequests: [aRawMergedPullRequest()],
      });
      const read = await gatherRepo(client, "jrey8343/shop", NOW);
      expect(read).toMatchObject({ product: true, unread: null });
      return calls.queries;
    }

    it("makes none of the Weekly summary's four history queries", async () => {
      const queries = await everyQuery();

      expect(queries.length).toBeGreaterThan(5);
      for (const query of queries) {
        expect(query).not.toContain("pullRequests(states: [MERGED, CLOSED]");
        // Every issue that moved in the window, and the Carriers closed in it: the one read by a time it does make is of the Check's issues, below.
        expect(query).not.toMatch(/issues\((?!states: CLOSED, labels: \$labels)[^)]*filterBy: \{ since: \$since \}/);
        expect(query).not.toContain("history(");
        expect(query).not.toContain("filterBy: { createdBy: $operator }");
      }
    });

    it("asks for the Check's issues closed in the last week in one page, by their label, with no comments (#795)", async () => {
      expect((await everyQuery()).filter((query) => query.includes("filterBy: { since: $since }"))).toEqual([
        expect.stringMatching(/issues\(states: CLOSED, labels: \$labels, filterBy: \{ since: \$since \}, first: 50, [^)]*\) \{\s+nodes \{ number body closedAt stateReason author \{ login __typename \} \}/),
      ]);
    });

    it("asks for the state of each open pull request's Ticket with the pull request", async () => {
      expect((await everyQuery()).filter((query) => query.includes("pullRequests(states: OPEN, first: 25"))).toEqual([
        expect.stringMatching(/closingIssuesReferences\(first: 10\) \{ nodes \{ number state \} \}/),
      ]);
    });

    it("asks for no review line comments and no blockers' labels", async () => {
      for (const query of await everyQuery()) {
        expect(query).not.toMatch(/reviews\([^)]*\)\s*\{\s*nodes\s*\{[^}]*comments\(/);
        expect(query).not.toMatch(/blockedBy\([^)]*\)\s*\{\s*nodes\s*\{[^}]*labels\(/);
      }
    });

    it("asks for no connection inside a connection inside a connection, the shape GitHub charges for", async () => {
      for (const query of await everyQuery()) expect(threeDeepConnectionsIn(query)).toEqual([]);
    });

    it("asks for up to 50 of each open issue's blockers with their state, why they are in it and their repo, and how many open blockers GitHub counts (#770, #771)", async () => {
      expect((await everyQuery()).filter((query) => query.includes("issues(states: OPEN, first: 25"))).toEqual([
        expect.stringMatching(/blockedBy\(first: 50\) \{ nodes \{ number state stateReason repository \{ nameWithOwner \} \} \}\s+issueDependenciesSummary \{ blockedBy \}/),
      ]);
    });

    it("asks for the comments of an issue closed as not planned by its number, a connection inside no other, among the queries held to that shape (#664)", async () => {
      const byNumber = (await everyQuery()).filter((query) => query.includes("issue(number:"));

      expect(byNumber).toEqual([closedIssueCommentsQuery([30])]);
      expect(byNumber[0]).toMatch(/issue30: issue\(number: 30\) \{ number comments\(last: 100\) \{ nodes \{ url body createdAt author \{ login __typename \} \} \} \}/);
    });

    it("asks why each issue cross-referenced to an open pull request is in its state, with the cross-reference", async () => {
      expect((await everyQuery()).filter((query) => query.includes("pullRequests(states: OPEN, first: 25"))).toEqual([
        expect.stringMatching(/\.\.\. on Issue \{ number title state stateReason repository \{ nameWithOwner \} \}/),
      ]);
    });

    it("asks the store, known by the Kit's own constant for it, nothing it asks a Product repo, and reads it as the store", async () => {
      const asked: string[] = [];
      const store: ReadClient = {
        rest: () => Promise.reject(new Error("The gather reads no REST")),
        fileText: async () => "jobs:\n  summary:\n    uses: jrey8343/fabrik/.github/workflows/weekly-summary.yml@v3.1.0\n",
        async graphql<T>(query: string): Promise<T> {
          asked.push(query);
          return { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } as T;
        },
      };

      const read = await gatherRepo(store, "jrey8343/fabrik-runs", NOW);
      const productQueries = await everyQuery();

      expect(read).toMatchObject({ repo: "jrey8343/fabrik-runs", product: false, store: true, release: "v3.1.0", unread: null });
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((query) => productQueries.includes(query))).toEqual([]);
    });
  });

  describe("its facts", () => {
    async function factsOf(raw: RawRepo, appLogin: string | null = null): Promise<Facts> {
      const read = await gatherRepo(repoWith({ files: { [CALLER_PATH]: CALLER }, ...raw }).client, "jrey8343/shop", NOW, appLogin);
      if (!read.product || read.facts === null) throw new Error(`no facts: ${JSON.stringify(read)}`);
      return read.facts;
    }

    it("hold the body of each open issue the Operator opened, and no one else's", async () => {
      const facts = await factsOf({
        issues: [
          aRawIssue({ number: 31, body: "From PR #50\n\nThe cart total rounds wrong." }),
          aRawIssue({ number: 32, author: { __typename: "User", login: "kate" }, body: "Mine." }),
          aRawIssue({ number: 33, state: "CLOSED", body: "Done." }),
        ],
      });

      expect(facts.issueBodies).toEqual([{ issue: 31, body: "From PR #50\n\nThe cart total rounds wrong." }]);
      expect(facts.github.openIssues.map(({ number }) => number)).toEqual([31, 32]);
    });

    it("hold what the rule reads of a check's fix (#795): each open issue's body, whose marker names a Check's issue's check, and the Check's issues the Fabrik App filed that closed in the last week", async () => {
      const bot = { __typename: "Bot", login: "fabrik-app" };
      const marker = (check: string) => `<!-- fabrik:flaky-check-issue {"check":"${check}"} -->\nIts red runs.`;
      const facts = await factsOf(
        {
          issues: [aRawIssue({ number: 91, author: bot, body: marker("test"), labels: { nodes: [{ name: "fabrik:flaky-check" }] } })],
          closedCheckIssues: [
            { number: 88, body: marker("lint"), closedAt: "2026-11-08T09:00:00Z", stateReason: "COMPLETED", author: bot },
            { number: 87, body: marker("e2e"), closedAt: "2026-11-08T08:00:00Z", stateReason: "COMPLETED", author: { __typename: "User", login: "kate" } },
            // Updated in the week, but closed before it.
            { number: 86, body: marker("build"), closedAt: "2026-10-20T08:00:00Z", stateReason: "NOT_PLANNED", author: bot },
          ],
        },
        "fabrik-app[bot]",
      );

      expect(facts.github.openIssues.map(({ number, body }) => ({ number, body }))).toEqual([{ number: 91, body: marker("test") }]);
      expect(facts.github.closedCheckIssues).toEqual([{ number: 88, check: "lint", closedAt: "2026-11-08T09:00:00Z", stateReason: "completed" }]);
    });

    describe("the blockers of each open issue (#770, #771)", () => {
      /** These issues of this repo, as a blocked Standing names them. */
      const shop = (...numbers: number[]) => numbers.map((number) => ({ repo: "jrey8343/shop", number }));
      /** A blocked-by edge to open issue `number` of this repo, as GitHub answers it. */
      const openBlocker = (number: number) => ({ number, state: "OPEN", stateReason: null, repository: { nameWithOwner: "jrey8343/shop" } });
      const labelled = (number: number, label: string, blockers: readonly number[]) =>
        aRawIssue({
          number,
          labels: { nodes: [{ name: label }] },
          timelineItems: { nodes: [{ __typename: "LabeledEvent", createdAt: "2026-10-20T00:00:00Z", actor: OPERATOR, label: { name: label } }] },
          blockedBy: { nodes: blockers.map(openBlocker) },
        });

      it("hold the ones in any repo, open or closed as not planned, and the hidden ones", async () => {
        const facts = await factsOf({
          issues: [
            labelled(10, "ready-for-human", []),
            {
              ...labelled(11, "ready-for-human", []),
              blockedBy: {
                nodes: [
                  openBlocker(9),
                  { number: 4, state: "CLOSED", stateReason: "NOT_PLANNED", repository: { nameWithOwner: "jrey8343/shop" } },
                  { number: 5, state: "CLOSED", stateReason: "COMPLETED", repository: { nameWithOwner: "jrey8343/shop" } },
                  { number: 3, state: "OPEN", stateReason: null, repository: { nameWithOwner: "jrey8343/elsewhere" } },
                ],
              },
              issueDependenciesSummary: { blockedBy: 3 },
            },
          ],
        });

        expect(facts.github.openIssues.map(({ number, blockers, hiddenBlockers }) => [number, blockers, hiddenBlockers])).toEqual([
          [10, [], 0],
          [
            11,
            [
              { repo: "jrey8343/elsewhere", number: 3 },
              { repo: "jrey8343/shop", number: 4 },
              { repo: "jrey8343/shop", number: 9 },
            ],
            1,
          ],
        ]);
      });

      it("make a ready-for-human issue, a Map and a grilling Decision, each with an open blocker in another repo, blocked rows naming it by repo (#771)", async () => {
        const elsewhere = { number: 3, state: "OPEN", stateReason: null, repository: { nameWithOwner: "a/b" } };
        const facts = await factsOf({
          issues: [
            { ...labelled(10, "ready-for-human", []), blockedBy: { nodes: [elsewhere] } },
            { ...labelled(9, "wayfinder:map", []), subIssues: { nodes: [{ number: 11 }] }, blockedBy: { nodes: [elsewhere] } },
            { ...labelled(11, "wayfinder:grilling", []), blockedBy: { nodes: [elsewhere] } },
          ],
        });

        const rows = rowsOf(facts, null, null, null, NOW);
        expect(rows.map(({ standing: { issue, work, name, yours, detail } }) => ({ issue, work, name, yours, detail })).filter(({ issue }) => [9, 10, 11].includes(issue ?? 0))).toEqual([
          { issue: 9, work: "map", name: "blocked", yours: false, detail: { blockers: [{ repo: "a/b", number: 3 }], hiddenBlockers: 0 } },
          { issue: 10, work: "ready-for-human", name: "blocked", yours: false, detail: { blockers: [{ repo: "a/b", number: 3 }], hiddenBlockers: 0 } },
          { issue: 11, work: "operator-decision", name: "blocked", yours: false, detail: { blockers: [{ repo: "a/b", number: 3 }], hiddenBlockers: 0 } },
        ]);
        expect(rows.map(({ standing }) => wordStanding(standing, NOW, "UTC").sentence).filter((sentence) => sentence.startsWith("Blocked"))).toEqual(["Blocked by a/b#3.", "Blocked by a/b#3.", "Blocked by a/b#3."]);
      });

      // Shaped like jrey8343/gradually-core's #457, #459, #10 and #9, which stood yours while blocked.
      it("make three ready-for-human issues and a Map, each blocked by open issues of the repo, four blocked rows and none yours", async () => {
        const facts = await factsOf({
          issues: [
            labelled(457, "ready-for-human", [453]),
            labelled(459, "ready-for-human", [451, 455, 456]),
            labelled(9, "wayfinder:map", [1, 7, 8]),
            labelled(10, "ready-for-human", [9]),
            ...[1, 7, 8, 451, 453, 455, 456].map((number) => aRawIssue({ number })),
          ],
        });

        const standings = rowsOf(facts, null, null, null, NOW).map(({ standing }) => standing);
        expect(standings.filter(({ issue }) => [457, 459, 9, 10].includes(issue ?? 0)).map(({ issue, work, name, yours, move, detail }) => ({ issue, work, name, yours, move, detail }))).toEqual([
          { issue: 9, work: "map", name: "blocked", yours: false, move: "nobody", detail: { blockers: shop(1, 7, 8), hiddenBlockers: 0 } },
          { issue: 10, work: "ready-for-human", name: "blocked", yours: false, move: "nobody", detail: { blockers: shop(9), hiddenBlockers: 0 } },
          { issue: 457, work: "ready-for-human", name: "blocked", yours: false, move: "nobody", detail: { blockers: shop(453), hiddenBlockers: 0 } },
          { issue: 459, work: "ready-for-human", name: "blocked", yours: false, move: "nobody", detail: { blockers: shop(451, 455, 456), hiddenBlockers: 0 } },
        ]);
        expect(standings.filter(({ name }) => name === "yours-to-do" || name === "yours-to-read")).toEqual([]);
      });
    });

    it("hold the agent pull requests merged in the last 24 hours, with their Ticket, merge commit and when they merged", async () => {
      const facts = await factsOf({
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 50, mergedAt: "2026-11-09T10:00:00Z" }),
          aRawMergedPullRequest({ number: 51, mergedAt: "2026-11-08T11:00:00Z" }),
          aRawMergedPullRequest({ number: 52, mergedAt: "2026-11-09T11:00:00Z", headRefName: "fix-typo", author: OPERATOR }),
          aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-09T11:30:00Z", closingIssuesReferences: { nodes: [] }, mergeCommit: null }),
        ],
      });

      expect(facts.mergedLastDay).toEqual([
        { number: 50, title: "Build the thing", ticket: 7, mergeCommit: "c".repeat(40), mergedAt: "2026-11-09T10:00:00Z" },
        { number: 53, title: "Build the thing", ticket: null, mergeCommit: null, mergedAt: "2026-11-09T11:30:00Z" },
      ]);
    });

    describe("what the comments of each agent pull request merged in the last 24 hours say of its Follow-ups (#885)", () => {
      const BADGE = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." } as const;
      const MONEY = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;
      /** A comment on a merged pull request, as mergedCommentsQuery reads it: the Fabrik App's unless a test says who wrote it. */
      const said = (body: string, author: Record<string, unknown> = APP) => ({ body, author });
      const aPass = (...followUps: NamedFollowUp[]) =>
        said([verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD }), "Verdict: pass", ...followUpsSection(followUps, "https://github.com/jrey8343/shop", 50)].join("\n"));
      const seenTo = said([FOLLOW_UPS_OPENED_MARKER, '<!-- fabrik:follow-up-opened #101 {"title":"The badge miscounts"} -->', "This pull request merged, so the Kit opened…"].join("\n"));

      it("are held for each whose last pass named one: the Follow-ups it named, each with its kind, and each fault the Kit opened as an issue", async () => {
        const facts = await factsOf({
          mergedPullRequests: [
            aRawMergedPullRequest({ number: 50, mergedAt: "2026-11-09T10:00:00Z", comments: { nodes: [aPass(BADGE, MONEY), seenTo] } }),
            aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-09T11:30:00Z", comments: { nodes: [aPass()] } }),
            aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-09T11:40:00Z" }),
          ],
        });

        expect(facts.mergedFollowUps).toEqual([{ pullRequest: 50, named: [MONEY, BADGE], opened: [{ issue: 101, title: "The badge miscounts" }] }]);
      });

      it("are read from a bot's comments alone, so nobody names a Follow-up or an opened issue by quoting one", async () => {
        const facts = await factsOf({
          mergedPullRequests: [aRawMergedPullRequest({ comments: { nodes: [aPass(BADGE), said(seenTo.body, OPERATOR)] } }), aRawMergedPullRequest({ number: 53, comments: { nodes: [said(aPass(MONEY).body, OPERATOR)] } })],
        });

        expect(facts.mergedFollowUps).toEqual([{ pullRequest: 50, named: [BADGE], opened: [] }]);
      });

      it("are asked for in one query, by number, the latest 50 comments of each, only of the agent pull requests merged in the last 24 hours", async () => {
        const { client, calls } = repoWith({
          files: { [CALLER_PATH]: CALLER },
          mergedPullRequests: [
            aRawMergedPullRequest({ number: 50, mergedAt: "2026-11-09T10:00:00Z" }),
            aRawMergedPullRequest({ number: 51, mergedAt: "2026-11-08T11:00:00Z" }),
            aRawMergedPullRequest({ number: 52, mergedAt: "2026-11-09T11:00:00Z", headRefName: "fix-typo", author: OPERATOR }),
            aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-09T11:30:00Z" }),
          ],
        });

        await gatherRepo(client, "jrey8343/shop", NOW);

        const byNumber = calls.queries.filter((query) => /pullRequest\(number: \d+\)/.test(query));
        expect(byNumber).toEqual([mergedCommentsQuery([50, 53])]);
        expect(byNumber[0]).toMatch(/pullRequest50: pullRequest\(number: 50\) \{ number comments\(last: 50\) \{ nodes \{ body author \{ login __typename \} \} \} \}/);
        expect(threeDeepConnectionsIn(byNumber[0] ?? "")).toEqual([]);
      });

      it("are none, and no query is made for them, in a repo where no agent pull request merged in the last 24 hours", async () => {
        const { client, calls } = repoWith({ files: { [CALLER_PATH]: CALLER }, mergedPullRequests: [aRawMergedPullRequest({ number: 51, mergedAt: "2026-11-08T11:00:00Z" })] });

        const read = await gatherRepo(client, "jrey8343/shop", NOW);

        expect(read.product && read.facts?.mergedFollowUps).toEqual([]);
        expect(calls.queries.filter((query) => /pullRequest\(number: \d+\)/.test(query))).toEqual([]);
      });

      it("give the merged pull request's row its Follow-ups, the fault's filedAs naming the issue the Kit opened", async () => {
        const facts = await factsOf({
          files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: { url: "https://shop.example", environment: "production" } }) },
          mergedPullRequests: [aRawMergedPullRequest({ number: 50, mergedAt: "2026-11-09T10:00:00Z", comments: { nodes: [aPass(BADGE, MONEY), seenTo] } })],
        });

        expect(rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50)?.followUps).toEqual([
          { ...MONEY, filedAs: null },
          { ...BADGE, filedAs: 101 },
        ]);
      });
    });

    it("give a row at Production to an agent pull request merged in the last 24 hours, in a repo declaring production, and none to a merged Plain pull request (#634)", async () => {
      const facts = await factsOf({
        files: { [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: { url: "https://shop.example", environment: "production" } }) },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 50, mergedAt: "2026-11-09T10:00:00Z" }),
          aRawMergedPullRequest({ number: 52, mergedAt: "2026-11-09T11:00:00Z", headRefName: "fix-typo", author: OPERATOR }),
          aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-09T11:10:00Z", headRefName: "dependabot/github_actions/fabrik-1.2.0", author: { __typename: "Bot", login: "dependabot" } }),
        ],
      });

      expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => [standing.pullRequest, standing.name, standing.place])).toEqual([[50, "merged", "production"]]);
    });

    it("hold the issues GitHub cross-references to each open agent pull request, with where each is, whether it is open and how it was closed", async () => {
      const issue = aRawCrossReference;
      const facts = await factsOf({
        openPullRequests: [
          aRawOpenPullRequest({
            crossReferences: {
              nodes: [
                issue(31, "OPEN"),
                issue(32, "CLOSED", "COMPLETED"),
                issue(33, "OPEN", "REOPENED", "jrey8343/blog"),
                { __typename: "CrossReferencedEvent", source: { __typename: "PullRequest" } },
                issue(35, "CLOSED", "DUPLICATE"),
                issue(36, "CLOSED", null),
              ],
            },
          }),
          aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, crossReferences: { nodes: [issue(34, "OPEN")] } }),
        ],
      });

      expect(facts.crossReferences).toEqual([
        { pullRequest: 50, issue: 31, title: "Issue 31", open: true, closedAs: null, repo: "jrey8343/shop" },
        { pullRequest: 50, issue: 32, title: "Issue 32", open: false, closedAs: "completed", repo: "jrey8343/shop" },
        { pullRequest: 50, issue: 33, title: "Issue 33", open: true, closedAs: null, repo: "jrey8343/blog" },
        { pullRequest: 50, issue: 35, title: "Issue 35", open: false, closedAs: "duplicate", repo: "jrey8343/shop" },
        { pullRequest: 50, issue: 36, title: "Issue 36", open: false, closedAs: null, repo: "jrey8343/shop" },
      ]);
      expect(facts.github.openPullRequests.map(({ number }) => number)).toEqual([50]);
      expect(facts.github.plainPullRequests.map(({ number }) => number)).toEqual([70]);
    });

    describe("the comments of each issue closed as not planned that GitHub cross-references to an open agent pull request (#664)", () => {
      const closed = (number: number, comments: Record<string, unknown>[]) => aRawIssue({ number, state: "CLOSED", comments: { nodes: comments } });
      const said = (issue: number, id: number, body: string, at: string, author: Record<string, unknown> | null = APP) => ({
        url: `https://github.com/jrey8343/shop/issues/${issue}#issuecomment-${id}`,
        body,
        createdAt: at,
        author,
      });
      /** The repo's one query for issues by number, among those a gather made. */
      const byNumber = (queries: readonly string[]) => queries.filter((query) => /issue\(number: \d+\)/.test(query));

      it("are held with who wrote each, whether a bot did, its time and its address, oldest first", async () => {
        const facts = await factsOf({
          issues: [closed(30, [said(30, 1, "Could this go on the open PR?", "2026-11-09T09:00:00Z", OPERATOR), said(30, 2, aRollInComment(50, "2026-11-09T10:00:00Z").body, "2026-11-09T10:00:00Z")])],
          openPullRequests: [aRawOpenPullRequest({ crossReferences: { nodes: [aRawCrossReference(30, "CLOSED", "NOT_PLANNED")] } })],
        });

        expect(facts.closedIssueComments).toEqual([
          {
            issue: 30,
            comments: [
              { url: "https://github.com/jrey8343/shop/issues/30#issuecomment-1", author: "jrey8343", byBot: false, body: "Could this go on the open PR?", at: "2026-11-09T09:00:00Z" },
              { url: "https://github.com/jrey8343/shop/issues/30#issuecomment-2", author: "fabrik-app[bot]", byBot: true, body: aRollInComment(50, "2026-11-09T10:00:00Z").body, at: "2026-11-09T10:00:00Z" },
            ],
          },
        ]);
      });

      it("are asked for in exactly one more query, by number, however many such issues and pull requests there are", async () => {
        const { client, calls } = repoWith({
          files: { [CALLER_PATH]: CALLER },
          issues: [closed(30, []), closed(33, []), closed(34, [])],
          openPullRequests: [
            aRawOpenPullRequest({ crossReferences: { nodes: [aRawCrossReference(33, "CLOSED", "NOT_PLANNED"), aRawCrossReference(30, "CLOSED", "NOT_PLANNED"), aRawCrossReference(33, "CLOSED", "NOT_PLANNED")] } }),
            aRawOpenPullRequest({ number: 51, headRefName: "fabrik/ticket-8", crossReferences: { nodes: [aRawCrossReference(34, "CLOSED", "NOT_PLANNED"), aRawCrossReference(30, "CLOSED", "NOT_PLANNED")] } }),
          ],
        });

        const read = await gatherRepo(client, "jrey8343/shop", NOW);

        expect(byNumber(calls.queries)).toHaveLength(1);
        expect([...(byNumber(calls.queries)[0] ?? "").matchAll(/issue\(number: (\d+)\)/g)].map(([, number]) => Number(number))).toEqual([30, 33, 34]);
        expect(read.product && read.facts?.closedIssueComments.map(({ issue }) => issue)).toEqual([30, 33, 34]);
      });

      it("are asked for in no query when no open agent pull request has such a cross-reference: an open issue's, one closed another way, another repo's and a Plain pull request's make none", async () => {
        const { client: without, calls: asked } = repoWith({ files: { [CALLER_PATH]: CALLER }, issues: [aRawIssue({ number: 7 })], openPullRequests: [aRawOpenPullRequest()] });
        const { client, calls } = repoWith({
          files: { [CALLER_PATH]: CALLER },
          issues: [aRawIssue({ number: 7 }), closed(32, []), closed(34, [])],
          openPullRequests: [
            aRawOpenPullRequest({
              crossReferences: {
                nodes: [
                  aRawCrossReference(31, "OPEN", "REOPENED"),
                  aRawCrossReference(32, "CLOSED", "COMPLETED"),
                  aRawCrossReference(33, "CLOSED", "NOT_PLANNED", "jrey8343/blog"),
                  aRawCrossReference(35, "CLOSED", "DUPLICATE"),
                  aRawCrossReference(36, "CLOSED", null),
                ],
              },
            }),
            aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, crossReferences: { nodes: [aRawCrossReference(34, "CLOSED", "NOT_PLANNED")] } }),
          ],
        });

        const read = await gatherRepo(client, "jrey8343/shop", NOW);
        await gatherRepo(without, "jrey8343/shop", NOW);

        expect(read.product && read.facts?.closedIssueComments).toEqual([]);
        expect(byNumber(calls.queries)).toEqual([]);
        expect(calls.queries).toHaveLength(asked.queries.length);
      });

      it("find an issue whatever the case GitHub gives the repo's name in, and hold none for an issue GitHub no longer has", async () => {
        const facts = await factsOf({
          issues: [closed(30, [])],
          openPullRequests: [aRawOpenPullRequest({ crossReferences: { nodes: [aRawCrossReference(30, "CLOSED", "NOT_PLANNED", "Jrey8343/Shop"), aRawCrossReference(39, "CLOSED", "NOT_PLANNED")] } })],
        });

        expect(facts.closedIssueComments).toEqual([{ issue: 30, comments: [] }]);
      });

      it("give the row of the pull request an owed Roll-in, with the closing comment's time, address and text", async () => {
        const settled = aRollInComment(50, "2026-11-09T10:00:00Z");
        const facts = await factsOf(
          {
            issues: [aRawIssue({ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] } }), closed(30, [said(30, 2, settled.body, "2026-11-09T10:00:00Z")])],
            openPullRequests: [aRawOpenPullRequest({ crossReferences: { nodes: [{ ...aRawCrossReference(30, "CLOSED", "NOT_PLANNED"), source: { ...(aRawCrossReference(30, "CLOSED", "NOT_PLANNED")["source"] as object), title: "Cache the prices" } }] } })],
          },
          "fabrik-app[bot]",
        );

        expect(rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50)?.related).toEqual([
          {
            issue: 30,
            title: "Cache the prices",
            kind: "owed",
            at: "2026-11-09T10:00:00Z",
            url: "https://github.com/jrey8343/shop/issues/30#issuecomment-2",
            text: { summary: "Read the prices once per page, so a page of forty products asks for them once.", acceptanceCriteria: ["A page that shows forty products reads the prices once."] },
          },
        ]);
      });
    });

    it("hold whether each open agent pull request's Ticket is closed, and no state of a Ticket GitHub gave none of or a Plain pull request's", async () => {
      const closing = (number: number, state?: string) => ({ closingIssuesReferences: { nodes: [state === undefined ? { number } : { number, state }] } });
      const facts = await factsOf({
        openPullRequests: [
          aRawOpenPullRequest({ number: 50, ...closing(7, "CLOSED") }),
          aRawOpenPullRequest({ number: 51, headRefName: "fabrik/ticket-8", isDraft: false, ...closing(8, "OPEN") }),
          aRawOpenPullRequest({ number: 52, headRefName: "fabrik/ticket-9", ...closing(9) }),
          aRawOpenPullRequest({ number: 53, headRefName: "fabrik/ticket-10", closingIssuesReferences: { nodes: [] } }),
          aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, ...closing(11, "CLOSED") }),
        ],
      });

      expect(facts.ticketStates).toEqual([
        { ticket: 7, closed: true },
        { ticket: 8, closed: false },
      ]);
    });

    it("count an issue closed in the middle of its Design session, which keeps needs-design, in no session", async () => {
      const facts = await factsOf({
        issues: [
          aRawIssue({ number: 40, state: "CLOSED", labels: { nodes: [{ name: "needs-design" }] } }),
          aRawIssue({ number: 41, labels: { nodes: [{ name: "needs-design" }] } }),
        ],
      });

      expect(facts.github.designQueue.issues.map(({ number }) => number)).toEqual([41]);
      expect(facts.github.openIssues.map(({ number }) => number)).toEqual([41]);
    });

    describe("the evidence marker of each agent pull request, open or merged in the last 24 hours (#639)", () => {
      const marker = (value: Record<string, unknown>) => `<!-- fabrik:ui-evidence ${JSON.stringify(value)} -->`;
      const body = (value: Record<string, unknown>) => ["The Implementer built the booking page.", "", "<!-- fabrik:ui-evidence-start -->", "## UI evidence", marker(value)].join("\n");
      const OPEN = { run: 4410, artifact: 901, failure: null, routes: ["/book", "/cart?step=2"], preview: { is: "linked", url: "https://fabrik-ticket-7.shop.example.dev/" } };
      const MERGED = { run: 4400, artifact: 900, failure: null, routes: ["/"], preview: { is: "never-answered", url: "https://fabrik-ticket-8.shop.example.dev/" } };

      it("are held for the Fabrik App's open and merged agent pull requests, keyed by pull request", async () => {
        const facts = await factsOf(
          {
            openPullRequests: [aRawOpenPullRequest({ number: 50, body: body(OPEN) }), aRawOpenPullRequest({ number: 51, headRefName: "fabrik/ticket-9", body: "No UI here." })],
            mergedPullRequests: [aRawMergedPullRequest({ number: 49, headRefName: "fabrik/ticket-8", mergedAt: "2026-11-09T10:00:00Z", body: body(MERGED) })],
          },
          "fabrik-app[bot]",
        );

        expect(facts.evidenceMarkers).toEqual([
          { pullRequest: 50, marker: OPEN },
          { pullRequest: 49, marker: MERGED },
        ]);
      });

      it("are read only from a pull request the Fabrik App opened, never another bot's or a Plain one's, nor one merged more than 24 hours ago", async () => {
        const OTHER_BOT = { __typename: "Bot", login: "helper" };
        const facts = await factsOf(
          {
            openPullRequests: [
              aRawOpenPullRequest({ number: 50, author: OTHER_BOT, body: body(OPEN) }),
              aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, body: body(OPEN) }),
            ],
            mergedPullRequests: [
              aRawMergedPullRequest({ number: 49, author: OTHER_BOT, body: body(MERGED) }),
              aRawMergedPullRequest({ number: 48, mergedAt: "2026-11-08T11:00:00Z", body: body(MERGED) }),
            ],
          },
          "fabrik-app[bot]",
        );

        expect(facts.evidenceMarkers).toEqual([]);
      });

      it("take any bot's pull request for the Fabrik App's when the gather was given no App login, as the Kit job does", async () => {
        const facts = await factsOf({ openPullRequests: [aRawOpenPullRequest({ number: 50, author: { __typename: "Bot", login: "helper" }, body: body(OPEN) })] });

        expect(facts.evidenceMarkers).toEqual([{ pullRequest: 50, marker: OPEN }]);
      });

      it("are asked for with each open and each merged pull request's body", async () => {
        const { client, calls } = repoWith({ files: { [CALLER_PATH]: CALLER } });
        await gatherRepo(client, "jrey8343/shop", NOW);

        for (const asked of ["pullRequests(states: OPEN, first: 25", "pullRequests(states: MERGED"]) {
          expect(calls.queries.filter((query) => query.includes(asked))).toEqual([expect.stringMatching(/\bnumber title\b[^{}]*\bbody\b/)]);
        }
      });

      describe("and its shots marker, where its evidence is Evidence shots (#822)", () => {
        const SHOTS = { source: "shots", head: "c".repeat(40), run: 9300, artifact: 9301, failure: null, routes: [], named: [{ name: "inbox: empty", path: "/inbox" }], missed: [], preview: { is: "none" } };

        it("is held for the Fabrik App's open and merged agent pull requests, keyed by pull request, beside the evidence markers of the others", async () => {
          const facts = await factsOf(
            {
              openPullRequests: [aRawOpenPullRequest({ number: 50, body: body(SHOTS) }), aRawOpenPullRequest({ number: 51, headRefName: "fabrik/ticket-9", body: body(OPEN) })],
              mergedPullRequests: [aRawMergedPullRequest({ number: 49, headRefName: "fabrik/ticket-8", mergedAt: "2026-11-09T10:00:00Z", body: body({ ...SHOTS, named: [], nothingVisible: "Only the API changed." }) })],
            },
            "fabrik-app[bot]",
          );

          expect(facts.shotsMarkers).toEqual([
            { pullRequest: 50, marker: SHOTS },
            { pullRequest: 49, marker: { ...SHOTS, named: [], nothingVisible: "Only the API changed." } },
          ]);
          expect(facts.evidenceMarkers).toEqual([{ pullRequest: 51, marker: OPEN }]);
        });

        it("is read only from a pull request the Fabrik App opened, never another bot's or a Plain one's", async () => {
          const facts = await factsOf(
            {
              openPullRequests: [
                aRawOpenPullRequest({ number: 50, author: { __typename: "Bot", login: "helper" }, body: body(SHOTS) }),
                aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, body: body(SHOTS) }),
              ],
            },
            "fabrik-app[bot]",
          );

          expect(facts.shotsMarkers).toEqual([]);
        });
      });
    });

    it("hold each comment's id on an open issue and an open agent pull request (#639)", async () => {
      const comment = (databaseId: number, at: string) => ({ databaseId, url: `https://github.com/jrey8343/shop/issues/7#issuecomment-${databaseId}`, body: `Said at ${at}.`, createdAt: at, author: APP });
      const held = { databaseId: 3, url: "https://github.com/jrey8343/shop/issues/7#issuecomment-3", body: endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-09T09:30:00Z", null), createdAt: "2026-11-09T09:30:00Z", author: APP };
      const facts = await factsOf({
        issues: [aRawIssue({ number: 7, comments: { nodes: [comment(1, "2026-11-09T09:00:00Z"), held, comment(2, "2026-11-09T10:00:00Z")] } })],
        openPullRequests: [aRawOpenPullRequest({ comments: { nodes: [comment(5, "2026-11-09T11:00:00Z")] } })],
      });

      expect(facts.github.openIssues[0]?.comments.map(({ id, at }) => ({ id, at }))).toEqual([
        { id: 1, at: "2026-11-09T09:00:00Z" },
        { id: 2, at: "2026-11-09T10:00:00Z" },
      ]);
      expect(facts.github.openPullRequests[0]?.comments.map(({ id }) => id)).toEqual([5]);
    });

    describe("GitHub's record of an edit to a comment's body, by which a Digest a person edited is told (#655)", () => {
      const PULL_REQUEST_HEAD = "b".repeat(40);
      /** The Fabrik App's Digest of pull request 50's head, as a query reads its comment, with what GitHub says of its edits and its updates. */
      const aRawDigest = (said: Record<string, unknown>) => ({
        databaseId: 9,
        url: "https://github.com/jrey8343/shop/pull/50#issuecomment-9",
        body: aDigestComment(PULL_REQUEST_HEAD, "2026-06-22T22:15:06Z").body,
        createdAt: "2026-06-22T22:15:06Z",
        author: APP,
        ...said,
      });
      /** The Digest on pull request 50's row, from a gather of the repo with these comments on it. */
      const digestOn = async (...nodes: Record<string, unknown>[]) => {
        const facts = await factsOf({ openPullRequests: [aRawOpenPullRequest({ comments: { nodes } })] }, "fabrik-app[bot]");
        return { comments: facts.github.openPullRequests[0]?.comments ?? [], digest: rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50)?.digest };
      };

      it("is asked for with each comment of an open pull request, in the one query that reads them, and when a comment was last updated never is", async () => {
        const { client, calls } = repoWith({ files: { [CALLER_PATH]: CALLER }, issues: [aRawIssue()], openPullRequests: [aRawOpenPullRequest()] });
        await gatherRepo(client, "jrey8343/shop", NOW);

        expect(calls.queries.filter((query) => query.includes("pullRequests(states: OPEN, first: 25"))).toEqual([
          expect.stringMatching(/comments\(last: 100\) \{ nodes \{[^{}]*\blastEditedAt\b/),
        ]);
        for (const query of calls.queries) expect(query).not.toContain("updatedAt");
      });

      it("is held on a comment GitHub records an edit of, and on no other", async () => {
        const { comments } = await digestOn(aRawDigest({ databaseId: 8, lastEditedAt: null }), aRawDigest({ databaseId: 9, lastEditedAt: "2026-06-23T08:00:00Z" }));

        expect(comments.map(({ id, bodyEditedAt }) => ({ id, bodyEditedAt }))).toEqual([
          { id: 8, bodyEditedAt: undefined },
          { id: 9, bodyEditedAt: "2026-06-23T08:00:00Z" },
        ]);
        expect(JSON.parse(JSON.stringify(comments))).toStrictEqual(comments);
      });

      it("reads a collapsed Digest that nobody edited as readable: its later update time alone never makes it edited", async () => {
        // As GitHub answered for a real comment collapsed as outdated seventeen days after it was posted: updated the second it was hidden, with no edit recorded.
        const collapsed = aRawDigest({ lastEditedAt: null, updatedAt: "2026-07-09T00:04:19Z", isMinimized: true, minimizedReason: "outdated", includesCreatedEdit: false });

        expect((await digestOn(collapsed)).digest).toMatchObject({ is: "readable", head: PULL_REQUEST_HEAD, at: "2026-06-22T22:15:06Z" });
      });

      it("reads a Digest GitHub records an edit of as edited, collapsed or not", async () => {
        const edited = aRawDigest({ lastEditedAt: "2026-06-23T08:00:00Z", updatedAt: "2026-07-09T00:04:19Z", isMinimized: true, minimizedReason: "outdated", includesCreatedEdit: true });

        expect((await digestOn(edited)).digest).toMatchObject({ is: "unreadable", why: "edited" });
      });
    });

    it("hold no line of the Weekly summary's history", async () => {
      const facts = await factsOf({ issues: [aRawIssue()], openPullRequests: [aRawOpenPullRequest()], mergedPullRequests: [aRawMergedPullRequest()] });

      expect(facts.github).toMatchObject({ pullRequests: [], tickets: [], specs: [], defaultBranchCommits: [], mergedPullRequestTitles: [], escapeMarkerIssues: [], followUpIssues: [], monitorIssues: [] });
    });

    it("leave out a held line, so it is never the last word", async () => {
      const held = { url: "https://github.com/jrey8343/shop/issues/7#issuecomment-2", body: endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-09T11:00:00Z", null), createdAt: "2026-11-09T11:00:00Z", author: APP };
      const said = { url: "https://github.com/jrey8343/shop/issues/7#issuecomment-1", body: "The Implement run opened #50.", createdAt: "2026-11-09T10:00:00Z", author: APP };
      const facts = await factsOf({ issues: [aRawIssue({ number: 7, comments: { nodes: [said, held] } })] });

      expect(facts.github.openIssues[0]?.comments.map(({ body }) => body)).toEqual(["The Implement run opened #50."]);
    });

    it("survive a JSON round trip", async () => {
      const facts = await factsOf(
        {
          issues: [
            aRawIssue({ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] } }),
            aRawIssue({ number: 41, labels: { nodes: [{ name: "needs-design" }] } }),
            aRawIssue({ number: 30, state: "CLOSED", comments: { nodes: [{ url: "https://github.com/jrey8343/shop/issues/30#issuecomment-2", body: aRollInComment(50, "2026-11-09T10:00:00Z").body, createdAt: "2026-11-09T10:00:00Z", author: APP }] } }),
          ],
          openPullRequests: [aRawOpenPullRequest({ crossReferences: { nodes: [aRawCrossReference(30, "CLOSED", "NOT_PLANNED")] } })],
          mergedPullRequests: [aRawMergedPullRequest()],
        },
        "fabrik-app[bot]",
      );

      expect(facts.closedIssueComments).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
    });
  });

  describe("a repo that declares staging (#856)", () => {
    const PRODUCTION = { url: "https://shop.example", environment: "production" };
    const STAGING = { url: "https://staging.shop.example", environment: "staging" };
    const declaring = (config: Record<string, unknown> = {}) => ({ [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: PRODUCTION, staging: STAGING, ...config }) });
    /** The commit production runs: the newest successful production Deployment's, committed on 2026-11-02 at 09:00. */
    const PROMOTED = "e".repeat(40);
    const PROMOTION = aRawDeployment({ databaseId: 800, createdAt: "2026-11-02T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-11-02T09:00:00Z" } });
    const statuses = (...states: string[]) => ({ nodes: states.map((state) => ({ state, createdAt: "2026-11-08T09:20:00Z" })) });
    const labelled = (label: string, at: string, actor: Record<string, unknown> | null = OPERATOR, kind = "LabeledEvent") => ({ __typename: kind, createdAt: at, actor, label: { name: label } });
    const marker = (value: Record<string, unknown>) => ["It builds the cart.", "", "<!-- fabrik:ui-evidence-start -->", "## UI evidence", `<!-- fabrik:ui-evidence ${JSON.stringify(value)} -->`].join("\n");
    const UI = { run: 4400, artifact: 900, failure: null, routes: ["/cart"] };

    async function gathered(raw: RawRepo, appLogin: string | null = null): Promise<{ facts: Facts; calls: Calls }> {
      const { client, calls } = repoWith({ files: declaring(), ...raw });
      const read = await gatherRepo(client, "jrey8343/shop", NOW, appLogin);
      if (!read.product || read.facts === null) throw new Error(`no facts: ${JSON.stringify(read)}`);
      return { facts: read.facts, calls };
    }
    const factsOf = async (raw: RawRepo, appLogin: string | null = null) => (await gathered(raw, appLogin)).facts;

    it("asks a repo that declares none what it asked before, and gives it no staging facts: the one page of merged pull requests, with no label event of one, and no Deployment", async () => {
      const asked: string[][] = [];
      for (const files of [{ [CALLER_PATH]: CALLER }, { [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: PRODUCTION }) }, declaring({ staging: null })]) {
        const { client, calls } = repoWith({ files, mergedPullRequests: [aRawMergedPullRequest()], deployments: { production: [PROMOTION], staging: [aRawDeployment()] } });

        const read = await gatherRepo(client, "jrey8343/shop", NOW);

        expect(read).toMatchObject({ product: true, unread: null });
        expect(read.product && read.facts).not.toHaveProperty("staging");
        expect(calls.queries.filter((query) => query.includes("pullRequests(states: MERGED"))).toEqual([MERGED_PULL_REQUESTS_QUERY]);
        expect(calls.queries.filter((query) => query.includes("deployments("))).toEqual([]);
        asked.push(calls.queries);
      }
      expect(MERGED_PULL_REQUESTS_QUERY).toContain("pullRequests(states: MERGED, first: 25, orderBy: { field: UPDATED_AT, direction: DESC })");
      expect(MERGED_PULL_REQUESTS_QUERY).not.toMatch(/timelineItems|\$after|updatedAt|pageInfo/);
      // But for its merged pull requests and its Deployments, a repo that declares staging is asked the same, in the same order.
      const { calls } = await gathered({ mergedPullRequests: [aRawMergedPullRequest()], deployments: { production: [PROMOTION] } });
      const others = (queries: readonly string[]) => queries.filter((query) => !query.includes("pullRequests(states: MERGED") && !query.includes("deployments("));
      expect(others(calls.queries)).toEqual(others(asked[0] ?? []));
      expect(asked[1]).toEqual(asked[0]);
      expect(asked[2]).toEqual(asked[0]);
    });

    it("keeps the agent pull requests merged since the newest successful production Deployment, newest first, however long ago, and none that Deployment's commit holds", async () => {
      const { facts, calls } = await gathered({
        deployments: {
          production: [
            aRawDeployment({ databaseId: 700, createdAt: "2026-10-20T09:10:00Z", commitOid: "a".repeat(40), commit: { committedDate: "2026-10-20T09:00:00Z" } }),
            PROMOTION,
            aRawDeployment({ databaseId: 810, createdAt: "2026-11-08T09:10:00Z", commitOid: "f".repeat(40), commit: { committedDate: "2026-11-08T09:00:00Z" }, statuses: statuses("FAILURE", "IN_PROGRESS") }),
            aRawDeployment({ databaseId: 820, createdAt: "2026-11-09T11:50:00Z", commitOid: "9".repeat(40), commit: { committedDate: "2026-11-09T11:40:00Z" }, statuses: statuses("IN_PROGRESS", "QUEUED") }),
          ],
        },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-09T10:00:00Z", headRefName: "fabrik/ticket-12", closingIssuesReferences: { nodes: [{ number: 12 }] }, mergeCommit: { oid: "5".repeat(40) } }),
          aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-05T10:00:00Z", headRefName: "fabrik/ticket-11", closingIssuesReferences: { nodes: [{ number: 11 }] }, mergeCommit: { oid: "4".repeat(40) }, title: "Show the cart total" }),
          aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-03T10:00:00Z", headRefName: "fix-typo", author: OPERATOR }),
          // The pull request whose merge the promotion deployed, which GitHub dates a second after its commit.
          aRawMergedPullRequest({ number: 52, mergedAt: "2026-11-02T09:00:01Z", mergeCommit: { oid: PROMOTED } }),
          aRawMergedPullRequest({ number: 51, mergedAt: "2026-11-01T10:00:00Z", mergeCommit: { oid: "1".repeat(40) } }),
        ],
      });

      expect(facts.staging?.since).toEqual({ from: "production", deployment: 800, commit: PROMOTED, cutAt: "2026-11-02T09:00:00Z", deployedAt: "2026-11-08T09:15:00Z" });
      expect(facts.staging?.unpromoted).toEqual([
        { number: 55, title: "Build the thing", ticket: 12, mergeCommit: "5".repeat(40), mergedAt: "2026-11-09T10:00:00Z" },
        { number: 54, title: "Show the cart total", ticket: 11, mergeCommit: "4".repeat(40), mergedAt: "2026-11-05T10:00:00Z" },
      ]);
      // The last day's are what they were, one production holds among them.
      expect(facts.mergedLastDay.map(({ number }) => number)).toEqual([55]);
      expect(calls.queries.filter((query) => query.includes("deployments("))).toEqual([expect.stringMatching(/deployments\(environments: \[\$environment\], first: \d+, after: \$after, orderBy: \{ field: CREATED_AT, direction: DESC \}\)/)]);
    });

    it("never gathers a pull request the newest successful production Deployment holds as waiting at Staging: it is Live for a day from that Deployment, then has no row (#857)", async () => {
      const promotedToday = aRawDeployment({ databaseId: 830, createdAt: "2026-11-09T11:00:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-11-09T10:30:00Z" }, statuses: { nodes: [{ state: "SUCCESS", createdAt: "2026-11-09T11:05:00Z" }] } });
      const merged = [
        aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-09T10:00:00Z", body: marker(UI) }),
        aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-05T10:00:00Z", headRefName: "fabrik/ticket-11", closingIssuesReferences: { nodes: [{ number: 11 }] }, mergeCommit: { oid: "4".repeat(40) }, body: marker(UI) }),
      ];

      const taken = await factsOf({ deployments: { production: [PROMOTION, promotedToday] }, mergedPullRequests: merged });
      const waiting = await factsOf({ deployments: { production: [PROMOTION] }, mergedPullRequests: merged });

      expect(taken.staging).toMatchObject({ since: { deployment: 830 }, unpromoted: [] });
      expect(taken.mergedLastDay.map(({ number }) => number)).toEqual([55]);
      expect(rowsOf(taken, null, null, null, NOW).map(({ standing }) => [standing.pullRequest, standing.place, standing.name, standing.since]).toSorted(([a], [b]) => Number(a) - Number(b))).toEqual([
        [54, "production", "live", "2026-11-09T11:05:00Z"],
        [55, "production", "live", "2026-11-09T11:05:00Z"],
      ]);
      expect(rowsOf(taken, null, null, null, "2026-11-10T11:05:00Z")).toHaveLength(2);
      expect(rowsOf(taken, null, null, null, "2026-11-10T11:06:00Z")).toEqual([]);
      // Until production takes them, both wait on the Operator, the one merged four days ago too.
      expect(rowsOf(waiting, null, null, null, "2026-11-10T10:01:00Z").map(({ standing }) => [standing.pullRequest, standing.place, standing.detail])).toMatchObject([
        [54, "staging", { staging: { trial: { needed: true }, standsUntil: null } }],
        [55, "staging", { staging: { trial: { needed: true }, standsUntil: null } }],
      ]);
    });

    it.each([
      ["no production Deployment has ever succeeded", { production: PRODUCTION }, [aRawDeployment({ databaseId: 810, statuses: statuses("FAILURE") }), aRawDeployment({ databaseId: 811, createdAt: "2026-11-08T10:00:00Z", statuses: statuses("INACTIVE") })]],
      ["production declares no environment", { production: { url: "https://shop.example", environment: null } }, [PROMOTION]],
      ["Kit config declares no production", { production: null }, [PROMOTION]],
    ] as const)("starts at the first successful staging Deployment where %s, and gathers nothing merged before it", async (_where, config, production) => {
      const { facts, calls } = await gathered({
        files: declaring(config),
        deployments: {
          production: [...production],
          staging: [
            aRawDeployment({ databaseId: 601, createdAt: "2026-11-04T08:00:00Z", commitOid: "6".repeat(40), commit: { committedDate: "2026-11-04T07:50:00Z" }, statuses: statuses("FAILURE") }),
            // A success GitHub has since made inactive, when the next one succeeded.
            aRawDeployment({ databaseId: 602, createdAt: "2026-11-04T09:10:00Z", commitOid: "7".repeat(40), commit: { committedDate: "2026-11-04T09:00:00Z" }, statuses: { nodes: [{ state: "INACTIVE", createdAt: "2026-11-06T09:15:00Z" }, { state: "SUCCESS", createdAt: "2026-11-04T09:14:00Z" }] } }),
            aRawDeployment({ databaseId: 603, createdAt: "2026-11-06T09:10:00Z", commitOid: "8".repeat(40), commit: { committedDate: "2026-11-06T09:00:00Z" } }),
          ],
        },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-05T10:00:00Z", mergeCommit: { oid: "5".repeat(40) } }),
          aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-04T09:00:00Z", mergeCommit: { oid: "7".repeat(40) } }),
          aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-04T08:30:00Z", mergeCommit: { oid: "3".repeat(40) } }),
          aRawMergedPullRequest({ number: 52, mergedAt: "2026-11-03T10:00:00Z", mergeCommit: { oid: "2".repeat(40) } }),
        ],
      });

      expect(facts.staging?.since).toEqual({ from: "staging", deployment: 602, commit: "7".repeat(40), cutAt: "2026-11-04T09:00:00Z", deployedAt: "2026-11-04T09:14:00Z" });
      expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([55]);
      const environments = calls.queries.filter((query) => query.includes("deployments(")).map((query) => /direction: (ASC|DESC)/.exec(query)?.[1]);
      expect(environments).toEqual(config.production?.environment ? ["DESC", "ASC"] : ["ASC"]);
    });

    it.each([
      // GitHub deletes a Deployment's statuses after 90 days, all but its current one: NOW is 2026-11-09 at 12:00.
      ["created 91 days ago is taken for a success whose status GitHub deleted, and the start", "2026-08-10T09:10:00Z", 601],
      ["created 89 days ago would still show its success, so it is passed over for the first that does", "2026-08-12T09:10:00Z", 603],
      ["created five days ago is passed over too", "2026-11-04T09:10:00Z", 603],
    ])("reads a staging Deployment that shows inactive alone by its age: one %s", async (_what, createdAt, start) => {
      const facts = await factsOf({
        files: declaring({ production: null }),
        deployments: {
          staging: [
            aRawDeployment({ databaseId: 601, createdAt, commitOid: "6".repeat(40), commit: { committedDate: createdAt }, statuses: statuses("INACTIVE") }),
            aRawDeployment({ databaseId: 603, createdAt: "2026-11-06T09:10:00Z", commitOid: "8".repeat(40), commit: { committedDate: "2026-11-06T09:00:00Z" } }),
          ],
        },
      });

      expect(facts.staging?.since).toMatchObject({ from: "staging", deployment: start });
    });

    it("keeps nothing past the last day where no staging Deployment has succeeded either, and still reads the last day's label events", async () => {
      const facts = await factsOf({
        deployments: { production: [aRawDeployment({ statuses: statuses("FAILURE") })], staging: [aRawDeployment({ statuses: statuses("IN_PROGRESS") }), aRawDeployment({ statuses: statuses() })] },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-09T10:00:00Z", timelineItems: { nodes: [labelled("fabrik:trial-accepted", "2026-11-09T11:00:00Z")] } }),
          aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-05T10:00:00Z" }),
        ],
      });

      expect(facts.staging).toMatchObject({ since: null, unpromoted: [] });
      expect(facts.mergedLastDay.map(({ number }) => number)).toEqual([55]);
      expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => [standing.pullRequest, standing.name])).toEqual([[55, "trial-accepted"]]);
    });

    it("reads a Deployment with no commit GitHub still has as of its creation, and pages on to the first that succeeded", async () => {
      const failed = Array.from({ length: 45 }, (_, at) => aRawDeployment({ databaseId: 900 + at, createdAt: `2026-11-08T10:${String(at).padStart(2, "0")}:00Z`, statuses: statuses("FAILURE") }));
      const { facts, calls } = await gathered({ deployments: { production: [aRawDeployment({ databaseId: 800, createdAt: "2026-11-02T09:10:00Z", commit: null }), ...failed] } });

      expect(facts.staging?.since).toEqual({ from: "production", deployment: 800, commit: "d".repeat(40), cutAt: "2026-11-02T09:10:00Z", deployedAt: "2026-11-08T09:15:00Z" });
      expect(calls.queries.filter((query) => query.includes("deployments(")).length).toBeGreaterThan(1);
    });

    it("starts no later than the Deployment's creation, whatever date its commit carries: a commit can't be deployed before it exists", async () => {
      const postdated = aRawDeployment({ databaseId: 800, createdAt: "2026-11-02T09:10:00Z", commit: { committedDate: "2026-11-06T09:00:00Z" } });
      const facts = await factsOf({ deployments: { production: [postdated] }, mergedPullRequests: [aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-05T10:00:00Z" })] });

      expect(facts.staging?.since).toMatchObject({ deployment: 800, cutAt: "2026-11-02T09:10:00Z" });
      expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([55]);
    });

    it("keeps the 100 most recent past 100 merges, agent and Plain together, and reads no page older than they need", async () => {
      // 130 agent pull requests since the promotion, an hour apart, newest first, with a Plain one after every tenth.
      const hours = (back: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - back * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
      const merged = Array.from({ length: 130 }, (_, at) => [
        aRawMergedPullRequest({ number: 1000 - at, mergedAt: hours(at), mergeCommit: { oid: String(1000 - at).padStart(40, "0") } }),
        ...(at % 10 === 9 ? [aRawMergedPullRequest({ number: 2000 - at, mergedAt: hours(at + 0.5), headRefName: "fix-typo", author: OPERATOR })] : []),
      ]).flat();
      const early = aRawDeployment({ databaseId: 790, createdAt: "2026-10-01T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-10-01T09:00:00Z" } });

      const { facts, calls } = await gathered({ deployments: { production: [early] }, mergedPullRequests: merged });

      // The 100 most recent merges of either kind: 91 agent pull requests and the 9 Plain ones among them.
      expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual(Array.from({ length: 91 }, (_, at) => 1000 - at));
      expect(facts.staging?.plain.map(({ number }) => number)).toEqual(Array.from({ length: 9 }, (_, at) => 1991 - at * 10));
      // They are the first four pages of 25, and the fifth shows nothing newer is left.
      expect(calls.queries.filter((query) => query.includes("pullRequests(states: MERGED") && query.includes("timelineItems"))).toHaveLength(5);
      expect(facts.mergedLastDay).toHaveLength(24);
    });

    it("keeps a pull request merged long ago and touched since out of the 100, however near the top GitHub lists it", async () => {
      const hours = (back: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - back * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
      const merged = [
        aRawMergedPullRequest({ number: 7, mergedAt: "2026-10-05T10:00:00Z", updatedAt: "2026-11-09T11:59:00Z", mergeCommit: { oid: "7".repeat(40) } }),
        ...Array.from({ length: 100 }, (_, at) => aRawMergedPullRequest({ number: 1000 - at, mergedAt: hours(at), mergeCommit: { oid: String(1000 - at).padStart(40, "0") } })),
      ];
      const early = aRawDeployment({ databaseId: 790, createdAt: "2026-10-01T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-10-01T09:00:00Z" } });

      const facts = await factsOf({ deployments: { production: [early] }, mergedPullRequests: merged });

      expect(facts.staging?.unpromoted).toHaveLength(100);
      expect(facts.staging?.unpromoted.map(({ number }) => number)).not.toContain(7);
    });

    it("holds, with each, its label events on the two trial labels in GitHub's order, the issues it closes, and its evidence or shots marker", async () => {
      const shots = ["It reworks the composer.", "", `<!-- fabrik:ui-evidence ${JSON.stringify({ source: "shots", head: "c".repeat(40), run: 9300, artifact: 9301, failure: null, routes: [], named: [{ name: "composer: draft ready" }], missed: [] })} -->`].join("\n");
      const facts = await factsOf(
        {
          deployments: { production: [PROMOTION] },
          mergedPullRequests: [
            aRawMergedPullRequest({
              number: 55,
              mergedAt: "2026-11-05T10:00:00Z",
              mergeCommit: { oid: "5".repeat(40) },
              body: marker(UI),
              timelineItems: {
                nodes: [
                  labelled("agent:review", "2026-11-05T09:00:00Z", APP),
                  labelled("fabrik:trial-problem", "2026-11-06T09:00:00Z"),
                  labelled("fabrik:trial-accepted", "2026-11-06T09:00:00Z", APP),
                  labelled("fabrik:trial-problem", "2026-11-07T09:00:00Z", OPERATOR, "UnlabeledEvent"),
                  labelled("fabrik:trial-accepted", "2026-11-07T10:00:00Z", null),
                ],
              },
            }),
            aRawMergedPullRequest({ number: 54, mergedAt: "2026-11-04T10:00:00Z", headRefName: "fabrik/ticket-11", mergeCommit: { oid: "4".repeat(40) }, closingIssuesReferences: { nodes: [{ number: 11 }, { number: 3, repository: { nameWithOwner: "jrey8343/other" } }] }, body: shots }),
            aRawMergedPullRequest({ number: 53, mergedAt: "2026-11-03T10:00:00Z", headRefName: "fix-typo", author: OPERATOR, closingIssuesReferences: { nodes: [] }, body: marker(UI), timelineItems: { nodes: [labelled("fabrik:trial-accepted", "2026-11-03T11:00:00Z")] } }),
            aRawMergedPullRequest({ number: 56, mergedAt: "2026-11-03T09:00:00Z", headRefName: "fix-copy", author: OPERATOR, closingIssuesReferences: { nodes: [] } }),
          ],
        },
        "fabrik-app[bot]",
      );

      expect(facts.staging?.trials.pullRequests).toEqual([
        {
          pullRequest: 55,
          labelEvents: [
            { label: "fabrik:trial-problem", action: "labeled", actor: "jrey8343", at: "2026-11-06T09:00:00Z" },
            { label: "fabrik:trial-accepted", action: "labeled", actor: "fabrik-app[bot]", at: "2026-11-06T09:00:00Z" },
            { label: "fabrik:trial-problem", action: "unlabeled", actor: "jrey8343", at: "2026-11-07T09:00:00Z" },
            { label: "fabrik:trial-accepted", action: "labeled", actor: "ghost", at: "2026-11-07T10:00:00Z" },
          ],
          closes: [7],
        },
        { pullRequest: 54, labelEvents: [], closes: [11] },
        // A Plain pull request's too: the Operator can label any, and one can be a Trial problem's fix. One with no such label that closes nothing says nothing.
        { pullRequest: 53, labelEvents: [{ label: "fabrik:trial-accepted", action: "labeled", actor: "jrey8343", at: "2026-11-03T11:00:00Z" }], closes: [] },
      ]);
      expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([55, 54]);
      expect(facts.staging?.evidenceMarkers).toEqual([{ pullRequest: 55, marker: UI }]);
      expect(facts.staging?.shotsMarkers).toMatchObject([{ pullRequest: 54, marker: { run: 9300, named: [{ name: "composer: draft ready" }] } }]);
      // What the last day's facts held is what they hold: neither merged in it.
      expect(facts.evidenceMarkers).toEqual([]);
      expect(facts.shotsMarkers).toEqual([]);
    });

    it("holds the Trial problems that name each, from the issues GitHub cross-references to it: one whose body's line names it, and none that only mentions it, names another, or is in another repo", async () => {
      const facts = await factsOf({
        deployments: { production: [PROMOTION] },
        mergedPullRequests: [
          aRawMergedPullRequest({
            number: 55,
            mergedAt: "2026-11-05T10:00:00Z",
            crossReferences: {
              nodes: [
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(71, 55, { state: "OPEN", stateReason: null, title: "The total reads 0" }) },
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(70, 55, { stateReason: "NOT_PLANNED" }) },
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(72, 55, { body: "It broke after #55." }) },
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(73, 54) },
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(74, 55, { repository: { nameWithOwner: "jrey8343/other" } }) },
                { __typename: "CrossReferencedEvent", source: { __typename: "PullRequest" } },
                { __typename: "CrossReferencedEvent", source: aRawTrialProblem(75, 55, { state: "OPEN", stateReason: "REOPENED" }) },
              ],
            },
          }),
        ],
      });

      expect(facts.staging?.trials.problems).toEqual([
        { issue: 70, pullRequest: 55, title: "A Trial problem", open: false, closedAs: "not_planned" },
        { issue: 71, pullRequest: 55, title: "The total reads 0", open: true, closedAs: null },
        { issue: 75, pullRequest: 55, title: "A Trial problem", open: true, closedAs: null },
      ]);
    });

    it("holds the Trial problem a merged pull request closes, whichever pull request it was found on, so its fix always needs a Staging trial", async () => {
      const facts = await factsOf({
        deployments: { production: [PROMOTION] },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 61, mergedAt: "2026-11-08T10:00:00Z", headRefName: "fabrik/ticket-70", mergeCommit: { oid: "6".repeat(40) }, closingIssuesReferences: { nodes: [aRawTrialProblem(70, 40), { number: 9, body: "No line here.", state: "CLOSED", stateReason: "COMPLETED" }] } }),
        ],
      });

      expect(facts.staging?.trials).toEqual({
        pullRequests: [{ pullRequest: 61, labelEvents: [], closes: [70, 9] }],
        problems: [{ issue: 70, pullRequest: 40, title: "A Trial problem", open: false, closedAs: "completed" }],
      });
      expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => standing)).toMatchObject([{ pullRequest: 61, place: "staging", move: "nobody", detail: { staging: { trial: { needed: true, why: "closes-trial-problem" }, standsUntil: null } } }]);
    });

    it("gives the pull request a problem was found on trial problem, naming its Trial problem, then trial accepted through its fix once the Operator accepts the merged pull request that closed it", async () => {
      const found = (fixLabels: Record<string, unknown>[]) =>
        factsOf({
          deployments: { production: [PROMOTION] },
          mergedPullRequests: [
            aRawMergedPullRequest({ number: 61, mergedAt: "2026-11-09T09:00:00Z", headRefName: "fabrik/ticket-70", mergeCommit: { oid: "6".repeat(40) }, closingIssuesReferences: { nodes: [aRawTrialProblem(70, 55)] }, timelineItems: { nodes: fixLabels } }),
            aRawMergedPullRequest({
              number: 55,
              mergedAt: "2026-11-05T10:00:00Z",
              body: marker(UI),
              timelineItems: { nodes: [labelled("fabrik:trial-problem", "2026-11-09T08:00:00Z")] },
              crossReferences: { nodes: [{ __typename: "CrossReferencedEvent", source: aRawTrialProblem(70, 55) }] },
            }),
          ],
        });
      const named = (facts: Facts) => rowsOf(facts, null, null, null, NOW).map(({ standing }) => [standing.pullRequest, standing.name, standing.move, "staging" in standing.detail ? (standing.detail.staging?.result ?? null) : null]);

      expect(named(await found([]))).toEqual([
        [55, "trial-problem", "nobody", { is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 70, open: false }] }],
        [61, "merged", "nobody", null],
      ]);
      expect(named(await found([labelled("fabrik:trial-accepted", "2026-11-09T11:30:00Z")]))).toEqual([
        [55, "trial-accepted", "nobody", { is: "accepted", at: "2026-11-09T11:30:00Z", problems: [{ issue: 70, open: false }], fix: [61] }],
        [61, "trial-accepted", "nobody", { is: "accepted", at: "2026-11-09T11:30:00Z", problems: [], fix: null }],
      ]);
    });

    it("counts the labels of the repo's owner where Kit config names no Operator, and only the named Operator's where it names one", async () => {
      const merged = [aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-05T10:00:00Z", body: marker(UI), timelineItems: { nodes: [labelled("fabrik:trial-accepted", "2026-11-09T11:00:00Z")] } })];
      const names = async (config: Record<string, unknown>) => rowsOf(await factsOf({ files: declaring(config), deployments: { production: [PROMOTION] }, mergedPullRequests: merged }), null, null, null, NOW).map(({ standing }) => standing.name);

      expect(await names({})).toEqual(["trial-accepted"]);
      expect(await names({ operator: "jrey8343" })).toEqual(["trial-accepted"]);
      expect(await names({ operator: "kate" })).toEqual(["merged"]);
    });

    it("asks for no connection inside a connection inside a connection, reads no REST, and gives facts that survive a JSON round trip", async () => {
      const { facts, calls } = await gathered({
        deployments: { production: [aRawDeployment({ statuses: statuses("FAILURE") })], staging: [PROMOTION] },
        mergedPullRequests: [
          aRawMergedPullRequest({ number: 55, mergedAt: "2026-11-05T10:00:00Z", body: marker(UI), timelineItems: { nodes: [labelled("fabrik:trial-problem", "2026-11-09T08:00:00Z")] }, crossReferences: { nodes: [{ __typename: "CrossReferencedEvent", source: aRawTrialProblem(70, 55) }] } }),
        ],
      });

      expect(calls.queries.filter((query) => query.includes("deployments(") || query.includes("pullRequests(states: MERGED"))).toHaveLength(3);
      for (const query of calls.queries) expect(threeDeepConnectionsIn(query)).toEqual([]);
      expect(facts.staging?.trials.problems).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
    });

    it("gives no facts, saying why, when the read of its Deployments fails, as when any query of the facts does", async () => {
      const { client } = repoWith({ files: declaring(), failing: "deployments(" });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toMatchObject({ product: true, operator: "jrey8343", facts: null, unread: expect.stringContaining("502") });
    });

    describe("what a production Deployment took in the last 24 hours, and every merge since the start (#857)", () => {
      /** A Deployment's statuses, newest first as GitHub gives them: it succeeded at `at`, and `later` are what it has been since. */
      const succeededAt = (at: string, ...later: string[]) => ({ nodes: [...later.map((state) => ({ state, createdAt: "2026-11-09T11:00:00Z" })), { state: "SUCCESS", createdAt: at }, { state: "IN_PROGRESS", createdAt: at }] });
      /** The promotion before today's: Deployment 800 of commit `e…`, which succeeded a week before NOW and has been superseded since. */
      const BEFORE = aRawDeployment({ databaseId: 800, createdAt: "2026-11-02T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-11-02T09:00:00Z" }, statuses: succeededAt("2026-11-02T09:15:00Z", "INACTIVE") });
      /** Today's promotion: Deployment 830 of commit `f…`, committed at 10:30, which succeeded at 11:00, an hour before NOW. */
      const TODAYS = "f".repeat(40);
      const TODAY = aRawDeployment({ databaseId: 830, createdAt: "2026-11-09T10:40:00Z", commitOid: TODAYS, commit: { committedDate: "2026-11-09T10:30:00Z" }, statuses: succeededAt("2026-11-09T11:00:00Z") });
      const agent = (number: number, mergedAt: string, more: Record<string, unknown> = {}) =>
        aRawMergedPullRequest({ number, mergedAt, headRefName: `fabrik/ticket-${number - 40}`, closingIssuesReferences: { nodes: [{ number: number - 40 }] }, mergeCommit: { oid: String(number).padStart(40, "0") }, ...more });
      const plain = (number: number, mergedAt: string, more: Record<string, unknown> = {}) =>
        aRawMergedPullRequest({ number, mergedAt, title: "Fix a typo", headRefName: "fix-typo", author: OPERATOR, closingIssuesReferences: { nodes: [] }, mergeCommit: { oid: String(number).padStart(40, "0") }, ...more });
      const standing = (facts: Facts, now: string) =>
        rowsOf(facts, null, null, null, now)
          .map(({ standing: { pullRequest, place, name, since } }) => [pullRequest, place, name, since])
          .toSorted(([a], [b]) => Number(a) - Number(b));

      it("says when the Deployment it starts at succeeded: production's newest success by its success, and a staging one GitHub has since made inactive by its creation", async () => {
        const production = await factsOf({ deployments: { production: [BEFORE] } });
        const staging = await factsOf({
          files: declaring({ production: null }),
          deployments: { staging: [aRawDeployment({ databaseId: 602, createdAt: "2026-07-04T09:10:00Z", commitOid: "7".repeat(40), commit: { committedDate: "2026-07-04T09:00:00Z" }, statuses: statuses("INACTIVE") })] },
        });

        expect(production.staging?.since).toEqual({ from: "production", deployment: 800, commit: PROMOTED, cutAt: "2026-11-02T09:00:00Z", deployedAt: "2026-11-02T09:15:00Z" });
        expect(staging.staging?.since).toEqual({ from: "staging", deployment: 602, commit: "7".repeat(40), cutAt: "2026-07-04T09:00:00Z", deployedAt: "2026-07-04T09:10:00Z" });
      });

      it("keeps the agent pull requests a production Deployment took in the last 24 hours, each with that Deployment, back to the newest that succeeded before them; so one merged five days before it is Live for a day from it", async () => {
        const { facts, calls } = await gathered({
          deployments: { production: [BEFORE, TODAY] },
          mergedPullRequests: [
            agent(56, "2026-11-09T11:30:00Z"),
            agent(55, "2026-11-09T10:00:00Z"),
            agent(54, "2026-11-04T11:00:00Z", { title: "Show the cart total", body: marker(UI) }),
            plain(53, "2026-11-03T10:00:00Z"),
            // The pull request whose merge the promotion before deployed, and one that promotion already held.
            agent(52, "2026-11-02T09:00:01Z", { mergeCommit: { oid: PROMOTED } }),
            agent(51, "2026-11-01T10:00:00Z"),
          ],
        });
        const by = { deployment: 830, commit: TODAYS, at: "2026-11-09T11:00:00Z" };

        expect(facts.staging?.since).toEqual({ from: "production", deployment: 830, commit: TODAYS, cutAt: "2026-11-09T10:30:00Z", deployedAt: "2026-11-09T11:00:00Z" });
        expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([56]);
        expect(facts.staging?.promoted).toEqual([
          { number: 55, title: "Build the thing", ticket: 15, mergeCommit: "55".padStart(40, "0"), mergedAt: "2026-11-09T10:00:00Z", by },
          { number: 54, title: "Show the cart total", ticket: 14, mergeCommit: "54".padStart(40, "0"), mergedAt: "2026-11-04T11:00:00Z", by },
        ]);
        expect(facts.staging?.evidenceMarkers).toEqual([{ pullRequest: 54, marker: UI }]);
        // An hour after the Deployment both are Live, since it succeeded, with no Deployments read; 25 hours after it, neither has a row.
        expect(standing(facts, NOW)).toEqual([
          [54, "production", "live", "2026-11-09T11:00:00Z"],
          [55, "production", "live", "2026-11-09T11:00:00Z"],
          [56, "staging", "merged", "2026-11-09T11:30:00Z"],
        ]);
        expect(rowsOf(facts, null, null, null, NOW).find(({ standing: { pullRequest } }) => pullRequest === 54)).toMatchObject({ title: "Show the cart total", evidence: { run: 4400 }, production: { site: "https://shop.example" } });
        expect(standing(facts, "2026-11-10T12:00:00Z")).toEqual([]);
        // Production's Deployments are read newest first, no further than the one that succeeded before the last 24 hours.
        expect(calls.queries.filter((query) => query.includes("deployments(")).map((query) => /direction: (ASC|DESC)/.exec(query)?.[1])).toEqual(["DESC"]);
      });

      it("gives each the first of the last day's production Deployments to hold it, where more than one succeeded", async () => {
        const morning = aRawDeployment({ databaseId: 820, createdAt: "2026-11-09T08:10:00Z", commitOid: "a".repeat(40), commit: { committedDate: "2026-11-09T08:00:00Z" }, statuses: succeededAt("2026-11-09T08:30:00Z", "INACTIVE") });
        const failed = aRawDeployment({ databaseId: 825, createdAt: "2026-11-09T09:00:00Z", commitOid: "b".repeat(40), commit: { committedDate: "2026-11-09T08:50:00Z" }, statuses: statuses("FAILURE", "IN_PROGRESS") });

        const facts = await factsOf({ deployments: { production: [BEFORE, morning, failed, TODAY] }, mergedPullRequests: [agent(55, "2026-11-09T10:00:00Z"), agent(54, "2026-11-04T11:00:00Z")] });

        expect(facts.staging?.since).toMatchObject({ deployment: 830 });
        expect(facts.staging?.promoted.map(({ number, by }) => [number, by])).toEqual([
          [55, { deployment: 830, commit: TODAYS, at: "2026-11-09T11:00:00Z" }],
          [54, { deployment: 820, commit: "a".repeat(40), at: "2026-11-09T08:30:00Z" }],
        ]);
      });

      it("takes a production Deployment GitHub shows as inactive alone for one that succeeded long before, so nothing it took is given to today's", async () => {
        const longAgo = aRawDeployment({ databaseId: 700, createdAt: "2026-07-02T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-07-02T09:00:00Z" }, statuses: statuses("INACTIVE") });

        const facts = await factsOf({ deployments: { production: [longAgo, TODAY] }, mergedPullRequests: [agent(55, "2026-11-09T10:00:00Z"), agent(51, "2026-07-01T10:00:00Z")] });

        expect(facts.staging?.promoted.map(({ number }) => number)).toEqual([55]);
      });

      it("passes over a production Deployment that went inactive without succeeding, too young for GitHub to have deleted a success of it: what merged before it is still today's to have taken, and Live", async () => {
        // Production succeeded five days ago; a Deployment two days ago was made inactive with no success; and today's succeeded an hour ago.
        const fiveDaysAgo = aRawDeployment({ databaseId: 810, createdAt: "2026-11-04T09:10:00Z", commitOid: "a".repeat(40), commit: { committedDate: "2026-11-04T09:00:00Z" }, statuses: succeededAt("2026-11-04T09:15:00Z", "INACTIVE") });
        const passedOver = aRawDeployment({ databaseId: 820, createdAt: "2026-11-07T09:10:00Z", commitOid: "b".repeat(40), commit: { committedDate: "2026-11-07T09:00:00Z" }, statuses: statuses("INACTIVE") });

        const facts = await factsOf({ deployments: { production: [fiveDaysAgo, passedOver, TODAY] }, mergedPullRequests: [agent(56, "2026-11-08T10:00:00Z"), agent(54, "2026-11-05T10:00:00Z"), agent(51, "2026-11-03T10:00:00Z")] });

        const by = { deployment: 830, commit: TODAYS, at: "2026-11-09T11:00:00Z" };
        expect(facts.staging?.promoted.map(({ number, by }) => [number, by])).toEqual([[56, by], [54, by]]);
        expect(standing(facts, NOW)).toEqual([
          [54, "production", "live", "2026-11-09T11:00:00Z"],
          [56, "production", "live", "2026-11-09T11:00:00Z"],
        ]);
      });

      it("reaches back to the first successful staging Deployment where production first succeeded in the last 24 hours, and keeps none as taken where nothing says how far back that is", async () => {
        const merged = [agent(55, "2026-11-09T10:00:00Z"), agent(54, "2026-11-05T10:00:00Z"), agent(53, "2026-11-03T10:00:00Z")];
        const firstOnStaging = aRawDeployment({ databaseId: 603, createdAt: "2026-11-04T09:10:00Z", commitOid: "8".repeat(40), commit: { committedDate: "2026-11-04T09:00:00Z" }, statuses: succeededAt("2026-11-04T09:15:00Z", "INACTIVE") });

        const { facts, calls } = await gathered({ deployments: { production: [TODAY], staging: [firstOnStaging] }, mergedPullRequests: merged });
        const unknown = await factsOf({ deployments: { production: [TODAY] }, mergedPullRequests: merged });

        expect(facts.staging?.since).toMatchObject({ from: "production", deployment: 830 });
        expect(facts.staging?.promoted.map(({ number }) => number)).toEqual([55, 54]);
        expect(calls.queries.filter((query) => query.includes("deployments(")).map((query) => /direction: (ASC|DESC)/.exec(query)?.[1])).toEqual(["DESC", "ASC"]);
        expect(unknown.staging).toMatchObject({ since: { deployment: 830 }, promoted: [], unpromoted: [] });
        expect(unknown.mergedLastDay.map(({ number }) => number)).toEqual([55]);
      });

      it("keeps as taken only as many, the most recent, as the merges since the start leave of the 100", async () => {
        // 95 merges since the commit today's promotion deployed, a second apart, every fifth a Plain one; and six that promotion took, a day apart before it.
        const seconds = (after: number) => new Date(Date.parse("2026-11-09T10:31:00Z") + after * 1000).toISOString().replace(".000Z", "Z");
        const since = Array.from({ length: 95 }, (_, at) => (at % 5 === 4 ? plain(2000 + at, seconds(at)) : agent(2000 + at, seconds(at))));
        const taken = Array.from({ length: 6 }, (_, at) => agent(1000 - at, `2026-11-0${8 - at}T10:00:00Z`));

        const facts = await factsOf({ deployments: { production: [BEFORE, TODAY] }, mergedPullRequests: [...since, ...taken] });

        expect((facts.staging?.unpromoted.length ?? 0) + (facts.staging?.plain.length ?? 0)).toBe(95);
        expect(facts.staging?.promoted.map(({ number }) => number)).toEqual([1000, 999, 998, 997, 996]);
      });

      it("keeps none as taken where production's newest success is more than 24 hours old, and makes no more requests than before", async () => {
        const { facts, calls } = await gathered({ deployments: { production: [BEFORE] }, mergedPullRequests: [agent(55, "2026-11-05T10:00:00Z"), agent(51, "2026-11-01T10:00:00Z")] });

        expect(facts.staging).toMatchObject({ since: { deployment: 800 }, promoted: [] });
        expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([55]);
        expect(calls.queries.filter((query) => query.includes("deployments(") || query.includes("pullRequests(states: MERGED"))).toHaveLength(2);
      });

      it("keeps the Plain pull requests merged to the default branch since the start, newest first, each with who opened it, its branch and the issues it closes; and counts every merge since the start", async () => {
        const facts = await factsOf({
          deployments: { production: [BEFORE] },
          mergedPullRequests: [
            plain(60, "2026-11-08T10:00:00Z", { title: "Bump the Kit to v3.2.0", headRefName: "dependabot/github_actions/fabrik-3.2.0", author: { __typename: "Bot", login: "dependabot" } }),
            agent(55, "2026-11-07T10:00:00Z"),
            plain(59, "2026-11-06T10:00:00Z", { title: "Pair on the cart", headRefName: "fabrik/pair-12", closingIssuesReferences: { nodes: [{ number: 12 }, { number: 4, repository: { nameWithOwner: "jrey8343/other" } }] } }),
            plain(58, "2026-11-05T10:00:00Z"),
            // Merged into another pull request's branch, which production takes only through that pull request.
            plain(57, "2026-11-04T10:00:00Z", { baseRefName: "fabrik/ticket-9" }),
            // Merged before the start, and the pull request whose merge the start deployed.
            plain(52, "2026-11-02T09:00:01Z", { mergeCommit: { oid: PROMOTED } }),
            plain(51, "2026-11-01T10:00:00Z"),
          ],
        });

        expect(facts.staging?.plain).toEqual([
          { number: 60, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-08T10:00:00Z", author: "dependabot[bot]", headRef: "dependabot/github_actions/fabrik-3.2.0", closes: [] },
          { number: 59, title: "Pair on the cart", mergedAt: "2026-11-06T10:00:00Z", author: "jrey8343", headRef: "fabrik/pair-12", closes: [12] },
          { number: 58, title: "Fix a typo", mergedAt: "2026-11-05T10:00:00Z", author: "jrey8343", headRef: "fix-typo", closes: [] },
        ]);
        expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual([55]);
        expect(facts.staging?.mergedSince).toBe(4);
      });

      it("gives no Plain pull request a Standing at Staging, whatever label the Operator put on it: only agent pull requests have a row", async () => {
        const facts = await factsOf({
          deployments: { production: [BEFORE], staging: [aRawDeployment({ databaseId: 603, createdAt: "2026-11-03T09:10:00Z" })] },
          mergedPullRequests: [
            plain(60, "2026-11-09T11:00:00Z", { title: "Bump the Kit to v3.2.0", headRefName: "dependabot/github_actions/fabrik-3.2.0", author: { __typename: "Bot", login: "dependabot" } }),
            plain(59, "2026-11-09T10:30:00Z", { headRefName: "fabrik/pair-12", closingIssuesReferences: { nodes: [{ number: 12 }] }, body: marker(UI) }),
            plain(58, "2026-11-05T10:00:00Z", { timelineItems: { nodes: [labelled("fabrik:trial-problem", "2026-11-06T09:00:00Z")] } }),
            agent(55, "2026-11-04T10:00:00Z", { body: marker(UI) }),
          ],
        });

        expect(facts.staging?.plain.map(({ number }) => number)).toEqual([60, 59, 58]);
        for (const now of [NOW, "2026-11-09T11:30:00Z", "2026-11-12T12:00:00Z"]) {
          const standings = rowsOf(facts, null, null, null, now).map(({ standing }) => standing);
          expect(standings.filter(({ pullRequest }) => pullRequest !== 55)).toEqual([]);
        }
        expect(rowsOf(facts, null, null, null, NOW).map(({ standing }) => [standing.pullRequest, standing.place])).toEqual([[55, "staging"]]);
      });

      it("counts every merge since the start past the 100 it keeps, with a query that asks only what the count needs, and makes it only then", async () => {
        // 150 merges since the promotion, an hour apart, newest first: every sixth a Plain one, so 125 agent and 25 Plain, and two older than it.
        const hours = (back: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - back * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
        const since = Array.from({ length: 150 }, (_, at) => (at % 6 === 5 ? plain(1000 - at, hours(at)) : agent(1000 - at, hours(at))));
        const early = aRawDeployment({ databaseId: 790, createdAt: "2026-10-01T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-10-01T09:00:00Z" } });
        const heavy = (queries: readonly string[]) => queries.filter((query) => query.includes("pullRequests(states: MERGED") && query.includes("timelineItems"));
        const counting = (queries: readonly string[]) => queries.filter((query) => query.includes("pullRequests(states: MERGED") && !query.includes("timelineItems"));

        const { facts, calls } = await gathered({ deployments: { production: [early] }, mergedPullRequests: [...since, agent(7, "2026-09-20T10:00:00Z"), plain(6, "2026-09-19T10:00:00Z")] });
        const few = await gathered({ deployments: { production: [early] }, mergedPullRequests: since.slice(0, 30) });

        expect(facts.staging?.mergedSince).toBe(150);
        // The 100 most recent merges of either kind hold 84 agent pull requests and these 16 Plain ones.
        expect(facts.staging?.unpromoted).toHaveLength(84);
        expect(facts.staging?.unpromoted.at(-1)).toMatchObject({ number: 901 });
        expect(facts.staging?.plain.map(({ number }) => number)).toEqual(Array.from({ length: 16 }, (_, at) => 1000 - (at * 6 + 5)));
        expect(counting(calls.queries)).toHaveLength(2);
        for (const query of counting(calls.queries)) {
          expect(query).toMatch(/pullRequests\(states: MERGED, first: 100, after: \$after, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
          expect(query).not.toMatch(/body|title|closingIssuesReferences|crossReferences/);
          expect(threeDeepConnectionsIn(query)).toEqual([]);
        }
        expect(few.facts.staging?.mergedSince).toBe(30);
        expect(heavy(few.calls.queries)).toHaveLength(2);
        expect(counting(few.calls.queries)).toEqual([]);
      });

      describe("and the Promote list of what it read", () => {
        /** Production as it runs: Deployment 800 of commit `e…`, committed on 2026-11-02 at 09:00, which succeeded at 09:15 and nothing has superseded. */
        const LIVE = aRawDeployment({ databaseId: 800, createdAt: "2026-11-02T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-11-02T09:00:00Z" }, statuses: succeededAt("2026-11-02T09:15:00Z") });
        const numbers = (list: ReturnType<typeof promoteListOf>) => list?.entries.map(({ pullRequest }) => pullRequest);

        it("is null for a repo with no staging block, whatever it has merged and deployed", async () => {
          for (const files of [{ [CALLER_PATH]: CALLER }, { [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: { ...PRODUCTION, workflow: "deploy-production.yml" } }) }, declaring({ staging: null })]) {
            const { client } = repoWith({ files, mergedPullRequests: [agent(55, "2026-11-09T10:00:00Z"), plain(54, "2026-11-08T10:00:00Z")], deployments: { production: [LIVE] } });
            const read = await gatherRepo(client, "jrey8343/shop", NOW);
            if (!read.product || read.facts === null) throw new Error(`no facts: ${JSON.stringify(read)}`);

            expect(promoteListOf(read.facts, null, NOW)).toBeNull();
          }
        });

        it("holds, with one successful production Deployment, exactly the pull requests merged that it does not contain, agent or Plain, newest first, and names that Deployment as its start", async () => {
          const facts = await factsOf({
            deployments: {
              production: [
                aRawDeployment({ databaseId: 700, createdAt: "2026-10-20T09:10:00Z", commitOid: "a".repeat(40), commit: { committedDate: "2026-10-20T09:00:00Z" }, statuses: succeededAt("2026-10-20T09:15:00Z", "INACTIVE") }),
                LIVE,
                aRawDeployment({ databaseId: 810, createdAt: "2026-11-08T09:10:00Z", commitOid: "f".repeat(40), commit: { committedDate: "2026-11-08T09:00:00Z" }, statuses: statuses("FAILURE", "IN_PROGRESS") }),
              ],
            },
            mergedPullRequests: [
              agent(56, "2026-11-09T11:30:00Z"),
              plain(59, "2026-11-08T10:00:00Z"),
              agent(55, "2026-11-05T10:00:00Z", { title: "Show the cart total" }),
              // The pull request whose merge that Deployment deployed, which GitHub dates a second after its commit, and what merged before it.
              agent(52, "2026-11-02T09:00:01Z", { mergeCommit: { oid: PROMOTED } }),
              plain(49, "2026-11-02T08:00:00Z"),
              agent(51, "2026-11-01T10:00:00Z"),
            ],
          });

          const list = promoteListOf(facts, null, NOW);

          expect(list?.start).toEqual({ from: "production", deployment: 800, commit: PROMOTED, deployedAt: "2026-11-02T09:15:00Z" });
          expect(numbers(list)).toEqual([56, 59, 55]);
          expect(list?.entries[2]).toMatchObject({ is: "agent", pullRequest: 55, title: "Show the cart total", ticket: 15, mergedAt: "2026-11-05T10:00:00Z" });
          expect(list).toMatchObject({ repo: "jrey8343/shop", leftOut: 0 });
        });

        it.each([
          ["no production Deployment has ever succeeded", { production: PRODUCTION }, [aRawDeployment({ databaseId: 810, statuses: statuses("FAILURE") })]],
          ["production declares no environment", { production: { url: "https://shop.example", environment: null } }, [LIVE]],
          ["Kit config declares no production", { production: null }, [LIVE]],
        ] as const)("starts at the first successful staging Deployment where %s, and says so; and is empty where no staging Deployment has succeeded either", async (_where, config, production) => {
          const merged = [plain(58, "2026-11-06T10:00:00Z"), agent(55, "2026-11-05T10:00:00Z"), agent(54, "2026-11-04T09:00:00Z", { mergeCommit: { oid: "7".repeat(40) } }), agent(53, "2026-11-04T08:30:00Z")];
          const staging = [
            aRawDeployment({ databaseId: 601, createdAt: "2026-11-04T08:00:00Z", commitOid: "6".repeat(40), commit: { committedDate: "2026-11-04T07:50:00Z" }, statuses: statuses("FAILURE") }),
            aRawDeployment({ databaseId: 602, createdAt: "2026-11-04T09:10:00Z", commitOid: "7".repeat(40), commit: { committedDate: "2026-11-04T09:00:00Z" }, statuses: succeededAt("2026-11-04T09:14:00Z", "INACTIVE") }),
            aRawDeployment({ databaseId: 603, createdAt: "2026-11-06T09:10:00Z", commitOid: "8".repeat(40), commit: { committedDate: "2026-11-06T09:00:00Z" } }),
          ];

          const started = promoteListOf(await factsOf({ files: declaring(config), deployments: { production: [...production], staging }, mergedPullRequests: merged }), null, NOW);
          const never = promoteListOf(await factsOf({ files: declaring(config), deployments: { production: [...production], staging: [staging[0]!] }, mergedPullRequests: merged }), null, NOW);

          expect(started?.start).toEqual({ from: "staging", deployment: 602, commit: "7".repeat(40), deployedAt: "2026-11-04T09:14:00Z" });
          expect(numbers(started)).toEqual([58, 55]);
          expect(never).toMatchObject({ start: null, entries: [], notAccepted: 0, leftOut: 0 });
        });

        it("gives each agent pull request the result its row's Standing at Staging has, and each Plain one, a Kit bump, a Pairing session's and the Operator's own, its kind and nothing more, counting only the agent ones not yet accepted", async () => {
          const oid = (number: number) => String(number).padStart(40, "0");
          const facts = await factsOf(
            {
              deployments: { production: [LIVE] },
              mergedPullRequests: [
                plain(64, "2026-11-09T11:00:00Z", { title: "Bump the Kit to v3.2.0", headRefName: "dependabot/github_actions/fabrik-3.2.0", author: { __typename: "Bot", login: "dependabot" } }),
                agent(60, "2026-11-08T16:00:00Z", { body: marker(UI) }),
                plain(63, "2026-11-08T15:30:00Z", { title: "Pair on the cart", headRefName: "fabrik/pair-12", closingIssuesReferences: { nodes: [{ number: 12 }] }, body: marker(UI) }),
                agent(59, "2026-11-08T15:00:00Z", { body: marker(UI), timelineItems: { nodes: [labelled("fabrik:trial-accepted", "2026-11-09T09:00:00Z")] } }),
                agent(57, "2026-11-08T14:00:00Z", { closingIssuesReferences: { nodes: [aRawTrialProblem(70, 58, { title: "The cart total reads 0" })] }, timelineItems: { nodes: [labelled("fabrik:trial-accepted", "2026-11-09T10:00:00Z")] } }),
                agent(58, "2026-11-06T10:00:00Z", {
                  body: marker(UI),
                  timelineItems: { nodes: [labelled("fabrik:trial-problem", "2026-11-07T09:00:00Z")] },
                  crossReferences: { nodes: [{ __typename: "CrossReferencedEvent", source: aRawTrialProblem(70, 58, { title: "The cart total reads 0" }) }] },
                }),
                plain(62, "2026-11-05T12:00:00Z", { timelineItems: { nodes: [labelled("fabrik:trial-problem", "2026-11-06T09:00:00Z")] } }),
                agent(55, "2026-11-05T10:00:00Z", { body: marker(UI) }),
                agent(54, "2026-11-04T10:00:00Z"),
              ],
            },
            "fabrik-app[bot]",
          );
          const succeeded = (number: number, at: string) => ({ is: "succeeded", deployment: 600 + number, commit: oid(number), at, log: null }) as const;
          const read = {
            deployments: {
              repo: "jrey8343/shop",
              environment: "staging",
              readAt: NOW,
              merges: {
                [oid(60)]: succeeded(60, "2026-11-08T16:06:00Z"),
                [oid(59)]: succeeded(59, "2026-11-08T15:06:00Z"),
                [oid(58)]: succeeded(58, "2026-11-06T10:06:00Z"),
                [oid(57)]: succeeded(57, "2026-11-08T14:06:00Z"),
                [oid(55)]: { is: "failed", deployment: 655, commit: oid(55), at: "2026-11-05T10:08:00Z", log: null },
                [oid(54)]: succeeded(54, "2026-11-04T10:06:00Z"),
              },
            },
            mainChecks: null,
          } as const;

          const list = promoteListOf(facts, read, NOW);
          const rows = rowsOf(facts, null, null, null, NOW, read);

          expect(list?.entries.map((entry) => [entry.is, entry.pullRequest, entry.is === "plain" ? entry.kind : entry.result.is])).toEqual([
            ["plain", 64, "kit-bump"],
            ["agent", 60, "untried"],
            ["plain", 63, "pairing"],
            ["agent", 59, "accepted"],
            ["agent", 57, "accepted"],
            ["agent", 58, "accepted"],
            ["plain", 62, "other"],
            ["agent", 55, "not-on-staging"],
            ["agent", 54, "no-screen"],
          ]);
          // What its row's Standing at Staging says, for each that still has a row: the one that changes no screen stood for its merge's day alone.
          expect(rows.map(({ standing }) => [standing.pullRequest, standing.place, standing.name]).toSorted(([a], [b]) => Number(b) - Number(a))).toEqual([
            [60, "staging", "on-staging"],
            [59, "staging", "trial-accepted"],
            [58, "staging", "trial-accepted"],
            [57, "staging", "trial-accepted"],
            [55, "staging", "deploy-failed"],
          ]);
          expect(list?.entries.find(({ pullRequest }) => pullRequest === 58)).toMatchObject({ result: { is: "accepted", at: "2026-11-09T10:00:00Z", fix: [57], problems: [{ issue: 70, title: "The cart total reads 0", open: false }] } });
          expect(list?.entries.find(({ pullRequest }) => pullRequest === 55)).toMatchObject({ result: { is: "not-on-staging", name: "deploy-failed", unread: false }, evidence: { run: 4400 }, staging: { site: "https://staging.shop.example", toTry: ["/cart"] } });
          // A Plain entry has its kind, and no evidence, no staging pages and no result, whatever its body or its labels say.
          expect(list?.entries.filter((entry) => entry.is === "plain")).toEqual([
            { is: "plain", pullRequest: 64, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-09T11:00:00Z", kind: "kit-bump" },
            { is: "plain", pullRequest: 63, title: "Pair on the cart", mergedAt: "2026-11-08T15:30:00Z", kind: "pairing" },
            { is: "plain", pullRequest: 62, title: "Fix a typo", mergedAt: "2026-11-05T12:00:00Z", kind: "other" },
          ]);
          // Untried 60 and 55, which never reached staging: the count is the entries that need a Staging trial and are not accepted.
          expect(list?.notAccepted).toBe(2);
        });

        it("carries GitHub's Actions page for production.workflow in that repo as its dispatch page, and none where Kit config names no workflow", async () => {
          const dispatched = await factsOf({ files: declaring({ production: { ...PRODUCTION, workflow: "deploy-production.yml" } }), deployments: { production: [LIVE] } });
          const undeclared = await factsOf({ deployments: { production: [LIVE] } });

          expect(promoteListOf(dispatched, null, NOW)?.dispatchPage).toBe("https://github.com/jrey8343/shop/actions/workflows/deploy-production.yml");
          expect(promoteListOf(undeclared, null, NOW)?.dispatchPage).toBeNull();
        });

        it.each([
          [120, 20],
          [150, 50],
          [100, 0],
        ])("holds the newest 100 of %i merges since the start, and says %i were left out", async (merges, leftOut) => {
          // An hour apart, newest first, every sixth a Plain one; and two that merged before the start.
          const hours = (back: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - back * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
          const since = Array.from({ length: merges }, (_, at) => (at % 6 === 5 ? plain(1000 - at, hours(at)) : agent(1000 - at, hours(at))));
          const early = aRawDeployment({ databaseId: 790, createdAt: "2026-10-01T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-10-01T09:00:00Z" } });

          const list = promoteListOf(await factsOf({ deployments: { production: [early] }, mergedPullRequests: [...since, agent(7, "2026-09-20T10:00:00Z"), plain(6, "2026-09-19T10:00:00Z")] }), null, NOW);

          expect(numbers(list)).toEqual(Array.from({ length: 100 }, (_, at) => 1000 - at));
          expect(list?.leftOut).toBe(leftOut);
        });

        it("keeps one set past the cap, the 100 most recent merges of either kind: its agent pull requests are the ones with a Standing, the list's entries are that set, and its counts are of it", async () => {
          // 100 untried UI agent pull requests, an hour apart, then 20 newer Plain ones, a minute apart.
          const back = (minutes: number) => new Date(Date.parse("2026-11-09T11:00:00Z") - minutes * 60 * 1000).toISOString().replace(".000Z", "Z");
          const plains = Array.from({ length: 20 }, (_, at) => plain(2000 - at, back(at)));
          const agents = Array.from({ length: 100 }, (_, at) => agent(1000 - at, back((at + 1) * 60), { body: marker(UI) }));
          const early = aRawDeployment({ databaseId: 790, createdAt: "2026-10-01T09:10:00Z", commitOid: PROMOTED, commit: { committedDate: "2026-10-01T09:00:00Z" } });

          const facts = await factsOf({ deployments: { production: [early] }, mergedPullRequests: [...plains, ...agents] });
          const list = promoteListOf(facts, null, NOW);
          const waiting = rowsOf(facts, null, null, null, NOW).filter(({ standing }) => standing.place === "staging");

          // The 20 Plain ones and the 80 agent ones that merged most recently.
          const kept = Array.from({ length: 80 }, (_, at) => 1000 - at);
          expect(facts.staging?.plain.map(({ number }) => number)).toEqual(Array.from({ length: 20 }, (_, at) => 2000 - at));
          expect(facts.staging?.unpromoted.map(({ number }) => number)).toEqual(kept);
          expect(facts.staging?.evidenceMarkers.map(({ pullRequest }) => pullRequest)).toEqual(kept);
          expect(waiting.map(({ standing }) => standing.pullRequest).toSorted((a, b) => Number(b) - Number(a))).toEqual(kept);
          expect(numbers(list)).toEqual([...Array.from({ length: 20 }, (_, at) => 2000 - at), ...kept]);
          expect(list).toMatchObject({ notAccepted: 80, leftOut: 20 });
        });
      });
    });
  });
});

/** Open issue 31, the Operator's, opened on 2026-11-01, with no labels, comments or label events unless a test says so. */
function aRawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 31,
    title: "An open issue",
    state: "OPEN",
    createdAt: "2026-11-01T00:00:00Z",
    closedAt: null,
    lastEditedAt: null,
    body: "",
    author: OPERATOR,
    labels: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    blockedBy: { nodes: [] }, issueDependenciesSummary: { blockedBy: 0 },
    subIssues: { nodes: [] },
    ...overrides,
  };
}

/** Open agent pull request 50, the Fabrik App's from Ticket 7's branch, a draft at head `b…b` with an empty body, with nothing on it unless a test says so. */
function aRawOpenPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 50,
    title: "Build the thing",
    body: "",
    isDraft: true,
    headRefOid: "b".repeat(40),
    headRefName: "fabrik/ticket-7",
    createdAt: "2026-11-08T00:00:00Z",
    mergeable: "MERGEABLE",
    author: APP,
    closingIssuesReferences: { nodes: [{ number: 7 }] },
    commits: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    draftEvents: { nodes: [] },
    crossReferences: { nodes: [] },
    ...overrides,
  };
}

/** GitHub's cross-reference to a pull request from issue `number` of `jrey8343/shop`, titled "Issue" and its number, in this state for this reason, as the gather's query reads one. */
function aRawCrossReference(number: number, state: "OPEN" | "CLOSED", stateReason: string | null = null, repo = "jrey8343/shop"): Record<string, unknown> {
  return {
    __typename: "CrossReferencedEvent",
    source: { __typename: "Issue", number, title: `Issue ${number}`, state, stateReason, repository: { nameWithOwner: repo } },
  };
}

/**
 * Agent pull request 50, the Fabrik App's from Ticket 7's branch, closing #7,
 * merged on 2026-11-09 at 10:00 as `c…c`, its body empty; and, as a repo that
 * declares staging is asked for them, merged into `main`, last updated when
 * it merged, with no label event and no cross-reference.
 */
function aRawMergedPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const mergedAt = overrides["mergedAt"] ?? "2026-11-09T10:00:00Z";
  return {
    number: 50,
    title: "Build the thing",
    body: "",
    mergedAt,
    updatedAt: mergedAt,
    baseRefName: "main",
    headRefName: "fabrik/ticket-7",
    author: APP,
    mergeCommit: { oid: "c".repeat(40) },
    closingIssuesReferences: { nodes: [{ number: 7 }] },
    timelineItems: { nodes: [] },
    crossReferences: { nodes: [] },
    ...overrides,
  };
}

/** Deployment 900 of commit `d…d`, committed on 2026-11-08 at 09:00 and deployed ten minutes later, which succeeded, its statuses newest first as GitHub gives them. */
function aRawDeployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 900,
    createdAt: "2026-11-08T09:10:00Z",
    commitOid: "d".repeat(40),
    commit: { committedDate: "2026-11-08T09:00:00Z" },
    statuses: { nodes: [{ state: "SUCCESS", createdAt: "2026-11-08T09:15:00Z" }, { state: "IN_PROGRESS", createdAt: "2026-11-08T09:11:00Z" }] },
    ...overrides,
  };
}

/** Issue `number` of `jrey8343/shop`, a Trial problem found on pull request `pullRequest`, closed as completed, as a cross-reference's source or an issue a pull request closes reads. */
function aRawTrialProblem(number: number, pullRequest: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "Issue",
    number,
    title: "A Trial problem",
    state: "CLOSED",
    stateReason: "COMPLETED",
    body: ["The total reads 0 on the cart page.", "", trialProblemLine(pullRequest)].join("\n"),
    repository: { nameWithOwner: "jrey8343/shop" },
    ...overrides,
  };
}
