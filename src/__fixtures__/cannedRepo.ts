// A canned GitHub for the tests of what reads a repo as the gather does
// (src/read/gather.ts): one repo, `jrey8343/shop`, behind a read-only client
// that answers each of the gather's queries from what a test says the repo
// holds, and records what it was asked.
import { expect } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";

/** When the tests read the repo. */
export const NOW = "2026-11-09T12:00:00Z";
export const APP = { __typename: "Bot", login: "fabrik-app" };
export const OPERATOR = { __typename: "User", login: "jrey8343" };
/** The default branch's head. */
export const HEAD = "a".repeat(40);
export const CALLER_PATH = ".github/workflows/fabrik.yml";
export const CALLER = "jobs:\n  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v3.1.0\n";
export const CONFIG_PATH = ".fabrik/config.json";

/** What one repo holds on GitHub, as the gather's queries read it, with nothing unless a test says so. */
export interface RawRepo {
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
  /** Fail every query whose text holds this, as GitHub fails one when it is down. */
  failing?: string;
  /** Refuse every query whose text holds this, as GitHub refuses one for want of a permission. */
  refusing?: string;
  /**
   * The files of `files` a query will not give whole, read singly instead: a
   * binary one or one it truncates; and the paths that are a submodule, which
   * a query finds nothing at.
   */
  kinds?: Record<string, "binary" | "truncated" | "submodule">;
  /** Refuse the single read of this file, as GitHub refuses one for want of a permission. */
  failingFile?: string;
  /** Read by a program at its own clock's time, not at NOW: no query is held to the time it asks from. */
  readAtAnyTime?: boolean;
}

/** Every call a gather made of the client: each query's text, each ref a query read a path at, and each file read singly, a REST request with the Kit's own client. */
export interface Calls {
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
export function repoWith(raw: RawRepo): { client: ReadClient; calls: Calls } {
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
      if (raw.refusing !== undefined && query.includes(raw.refusing)) {
        throw new GitHubError("GitHub POST /graphql failed: 403", 403, { request: "POST /graphql", body: JSON.stringify({ message: "Resource not accessible by integration" }) });
      }
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
        expect(variables).toMatchObject({ labels: ["fabrik:flaky-check"], ...(raw.readAtAnyTime === true ? {} : { since: "2026-11-02T12:00:00.000Z" }) });
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

/**
 * Agent pull request 50, the Fabrik App's from Ticket 7's branch, closing #7,
 * merged on 2026-11-09 at 10:00 as `c…c`, its body empty; and, as a repo that
 * declares staging is asked for them, merged into `main`, last updated when
 * it merged, with no label event and no cross-reference.
 */
export function aRawMergedPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
export function aRawDeployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 900,
    createdAt: "2026-11-08T09:10:00Z",
    commitOid: "d".repeat(40),
    commit: { committedDate: "2026-11-08T09:00:00Z" },
    statuses: { nodes: [{ state: "SUCCESS", createdAt: "2026-11-08T09:15:00Z" }, { state: "IN_PROGRESS", createdAt: "2026-11-08T09:11:00Z" }] },
    ...overrides,
  };
}
