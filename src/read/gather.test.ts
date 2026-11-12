import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient, type Repo } from "../github/client.ts";
import { gatherRepo } from "./gather.ts";

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
      if (query.includes("labels: [$ready]")) return answer({ repository: { owner: { login: "jrey8343" }, issues: page(labelled(variables["ready"])), pullRequests: { nodes: [] } } });
      if (query.includes("labels: [$research]")) return answer({ repository: { issues: page(labelled(variables["research"])) } });
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
});
