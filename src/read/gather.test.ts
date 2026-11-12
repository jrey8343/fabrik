import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { endedHeldLine } from "../loop/heldLine.ts";
import { aDigestComment, aRollInComment } from "./builders.ts";
import { type Facts, gatherRepo } from "./gather.ts";
import { closedIssueCommentsQuery } from "./homeQueries.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";
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
  /** Fail every query whose text holds this. */
  failing?: string;
  /** Refuse the read of this file, as GitHub refuses one for want of a permission. */
  failingFile?: string;
}

/** Every call a gather made of the client: each query's text, and each file read. */
interface Calls {
  readonly queries: string[];
  readonly files: string[];
}

/** A read-only client over `jrey8343/shop`, answering each query the gather makes with one page, and recording what it was asked. */
function repoWith(raw: RawRepo): { client: ReadClient; calls: Calls } {
  const calls: Calls = { queries: [], files: [] };
  const page = (nodes: unknown[] = []) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const branch = raw.branch === undefined ? { name: "main", head: HEAD } : raw.branch;
  const issues = raw.issues ?? [];
  const client: ReadClient = {
    rest: () => Promise.reject(new Error("The gather reads no REST")),
    async fileText(repo: Repo, path: string, ref: string) {
      expect(repo).toEqual({ owner: "jrey8343", name: "shop" });
      expect(ref).toBe(branch?.head);
      calls.files.push(path);
      if (path === raw.failingFile) throw new GitHubError(`GitHub GET ${path} failed: 403`, 403, { request: `GET ${path}`, body: JSON.stringify({ message: "Resource not accessible by integration" }) });
      return raw.files?.[path] ?? null;
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
      if (query.includes("pullRequests(states: MERGED")) return answer({ repository: { pullRequests: page(raw.mergedPullRequests) } });
      if (query.includes("pullRequests(states: OPEN, first: 25")) return answer({ repository: { pullRequests: page(raw.openPullRequests) } });
      if (query.includes("labels: [$needsDesign]")) return answer({ repository: { owner: { login: "jrey8343" }, issues: page(labelled(variables["needsDesign"])) } });
      // Dispatch's own reads ask more of each issue, which an issue here has none of.
      const candidate = (issue: Record<string, unknown>) => ({ ...issue, blockedBy: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, subIssues: { totalCount: 0 }, assignees: { nodes: [] }, parent: null });
      if (query.includes("labels: [$ready]")) return answer({ repository: { owner: { login: "jrey8343" }, issues: page(labelled(variables["ready"]).map(candidate)), pullRequests: { nodes: [] } } });
      if (query.includes("labels: [$research]")) return answer({ repository: { issues: page(labelled(variables["research"]).map(candidate)) } });
      if (query.includes("labels: $labels")) return answer({ repository: { owner: { login: "jrey8343" }, issues: { nodes: [] } } });
      if (query.includes("issues(labels: [$label], states: [OPEN, CLOSED]")) return answer({ repository: { defaultBranchRef: null, issues: { nodes: labelled(variables["label"]) } } });
      if (query.includes("issues(states: OPEN")) return answer({ repository: { issues: page(asked(issues)) } });
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
    ] as const)("with %s is no Product repo, and nothing but its caller workflow is read", async (_what, raw) => {
      const { client, calls } = repoWith(raw);

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false, store: false });
      expect(calls.files).toEqual([CALLER_PATH]);
      expect(calls.queries).toHaveLength(1);
    });

    it("with no default branch yet is no Product repo, and reads no file", async () => {
      const { client, calls } = repoWith({ branch: null, files: { [CALLER_PATH]: CALLER } });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false, store: false });
      expect(calls.files).toEqual([]);
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
      const { client } = repoWith({ files: { [CALLER_PATH]: CALLER }, failingFile: CONFIG_PATH });

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
        expect(query).not.toContain("filterBy: { since: $since }");
        expect(query).not.toContain("history(");
        expect(query).not.toContain("filterBy: { createdBy: $operator }");
      }
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
    });

    it("hold each comment's id on an open issue and an open agent pull request (#639)", async () => {
      const comment = (databaseId: number, at: string) => ({ databaseId, url: `https://github.com/jrey8343/shop/issues/7#issuecomment-${databaseId}`, body: `Said at ${at}.`, createdAt: at, author: APP });
      const held = { databaseId: 3, url: "https://github.com/jrey8343/shop/issues/7#issuecomment-3", body: endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-09T09:30:00Z"), createdAt: "2026-11-09T09:30:00Z", author: APP };
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
      const held = { url: "https://github.com/jrey8343/shop/issues/7#issuecomment-2", body: endedHeldLine("implement", 7, { kind: "resumed" }, "2026-11-09T11:00:00Z"), createdAt: "2026-11-09T11:00:00Z", author: APP };
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

/** Agent pull request 50, the Fabrik App's from Ticket 7's branch, closing #7, merged on 2026-11-09 at 10:00 as `c…c`, its body empty. */
function aRawMergedPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 50,
    title: "Build the thing",
    body: "",
    mergedAt: "2026-11-09T10:00:00Z",
    headRefName: "fabrik/ticket-7",
    author: APP,
    mergeCommit: { oid: "c".repeat(40) },
    closingIssuesReferences: { nodes: [{ number: 7 }] },
    ...overrides,
  };
}
