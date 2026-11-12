import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { endedHeldLine } from "../loop/heldLine.ts";
import { type Facts, gatherRepo } from "./gather.ts";
import { threeDeepConnectionsIn } from "./queryShape.ts";

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
      return raw.files?.[path] ?? null;
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.queries.push(query);
      expect(variables).toMatchObject({ owner: "jrey8343", name: "shop" });
      if (raw.failing !== undefined && query.includes(raw.failing)) throw new GitHubError("GitHub GraphQL failed: 502", 502);
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

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false });
      expect(calls.files).toEqual([CALLER_PATH]);
      expect(calls.queries).toHaveLength(1);
    });

    it("with no default branch yet is no Product repo, and reads no file", async () => {
      const { client, calls } = repoWith({ branch: null, files: { [CALLER_PATH]: CALLER } });

      expect(await gatherRepo(client, "jrey8343/shop", NOW)).toEqual({ repo: "jrey8343/shop", product: false });
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

      expect(read).toMatchObject({ product: true, release: "v3.1.0", operator: "kate", kitConfig: { ok: true }, facts: null, unread: "GitHub GraphQL failed: 502" });
    });
  });

  describe("what it asks GitHub", () => {
    /** Every query a gather of a Product repo with a valid Kit config makes, with something on each page. */
    async function everyQuery(): Promise<string[]> {
      const { client, calls } = repoWith({
        files: { [CALLER_PATH]: CALLER },
        issues: [aRawIssue({ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] } }), aRawIssue({ number: 8, labels: { nodes: [{ name: "needs-design" }] } })],
        openPullRequests: [aRawOpenPullRequest()],
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

    it("asks for no review line comments and no blockers' labels", async () => {
      for (const query of await everyQuery()) {
        expect(query).not.toMatch(/reviews\([^)]*\)\s*\{\s*nodes\s*\{[^}]*comments\(/);
        expect(query).not.toMatch(/blockedBy\([^)]*\)\s*\{\s*nodes\s*\{[^}]*labels\(/);
      }
    });

    it("asks for no connection inside a connection inside a connection, the shape GitHub charges for", async () => {
      for (const query of await everyQuery()) expect(threeDeepConnectionsIn(query)).toEqual([]);
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

    it("hold the issues GitHub cross-references to each open agent pull request, with where each is and whether it is open", async () => {
      const issue = (number: number, state: string, repo = "jrey8343/shop") => ({
        __typename: "CrossReferencedEvent",
        source: { __typename: "Issue", number, title: `Issue ${number}`, state, repository: { nameWithOwner: repo } },
      });
      const facts = await factsOf({
        openPullRequests: [
          aRawOpenPullRequest({ crossReferences: { nodes: [issue(31, "OPEN"), issue(32, "CLOSED"), issue(33, "OPEN", "jrey8343/blog"), { __typename: "CrossReferencedEvent", source: { __typename: "PullRequest" } }] } }),
          aRawOpenPullRequest({ number: 70, headRefName: "fix-typo", author: OPERATOR, crossReferences: { nodes: [issue(34, "OPEN")] } }),
        ],
      });

      expect(facts.crossReferences).toEqual([
        { pullRequest: 50, issue: 31, title: "Issue 31", open: true, repo: "jrey8343/shop" },
        { pullRequest: 50, issue: 32, title: "Issue 32", open: false, repo: "jrey8343/shop" },
        { pullRequest: 50, issue: 33, title: "Issue 33", open: true, repo: "jrey8343/blog" },
      ]);
      expect(facts.github.openPullRequests.map(({ number }) => number)).toEqual([50]);
      expect(facts.github.plainPullRequests.map(({ number }) => number)).toEqual([70]);
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
          issues: [aRawIssue({ number: 7, labels: { nodes: [{ name: "ready-for-agent" }] } }), aRawIssue({ number: 41, labels: { nodes: [{ name: "needs-design" }] } })],
          openPullRequests: [aRawOpenPullRequest()],
          mergedPullRequests: [aRawMergedPullRequest()],
        },
        "fabrik-app[bot]",
      );

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

/** Open agent pull request 50, the Fabrik App's from Ticket 7's branch, a draft at head `b…b`, with nothing on it unless a test says so. */
function aRawOpenPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 50,
    title: "Build the thing",
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

/** Agent pull request 50, the Fabrik App's from Ticket 7's branch, closing #7, merged on 2026-11-09 at 10:00 as `c…c`. */
function aRawMergedPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 50,
    title: "Build the thing",
    mergedAt: "2026-11-09T10:00:00Z",
    headRefName: "fabrik/ticket-7",
    author: APP,
    mergeCommit: { oid: "c".repeat(40) },
    closingIssuesReferences: { nodes: [{ number: 7 }] },
    ...overrides,
  };
}
