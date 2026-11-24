// A canned GitHub for the untried queue command's tests: `jrey8343/shop` as a
// Product repo that declares staging, behind the canned repo the gather's own
// tests read (src/__fixtures__/cannedRepo.ts), which here also answers the
// staging reads' REST requests and keeps a log of every request made of it.
import { aRawMergedPullRequest, CALLER, CALLER_PATH, CONFIG_PATH, OPERATOR, type RawRepo, repoWith } from "../__fixtures__/cannedRepo.ts";
import type { ReadClient } from "../github/client.ts";
import { trialStepsMarker } from "../loop/markers.ts";

export const PRODUCTION = { url: "https://shop.example", environment: "production" };
export const STAGING = { url: "https://staging.shop.example", environment: "staging" };

/** The repo's files: its caller workflow, and a Kit config declaring production and staging, with `config` over them. */
export function declaring(config: Record<string, unknown> = {}): Record<string, string> {
  return { [CALLER_PATH]: CALLER, [CONFIG_PATH]: JSON.stringify({ production: PRODUCTION, staging: STAGING, ...config }) };
}

/** The commit pull request `number` merged as: its number, so a later pull request's commit contains an earlier one's. */
export const commitOf = (number: number): string => String(number).padStart(40, "0");

/** The Trial steps the fixture's pull requests keep unless a test gives others. */
export const TRIAL = { summary: "A shopper now sees the cart's total.", steps: [{ route: "/cart", do: "Add any product.", expect: "The total under the list, with tax." }] };

/** A body the Fabrik App wrote for a UI pull request that captured `/cart`, keeping `trial` as its Trial steps, or none for null. */
export function aUiBody(trial: typeof TRIAL | null = TRIAL): string {
  const evidence = ["It builds the cart.", "", "<!-- fabrik:ui-evidence-start -->", "## UI evidence", `<!-- fabrik:ui-evidence ${JSON.stringify({ run: 4400, artifact: 900, failure: null, routes: ["/cart"] })} -->`];
  return [...evidence, ...(trial === null ? [] : ["", trialStepsMarker(trial)])].join("\n");
}

/** Merged agent pull request `number`, a UI one keeping the fixture's Trial steps, merged at `mergedAt` as its own commit (commitOf), closing the Ticket forty below it. */
export function anAgentMerge(number: number, mergedAt: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return aRawMergedPullRequest({
    number,
    mergedAt,
    headRefName: `fabrik/ticket-${number - 40}`,
    closingIssuesReferences: { nodes: [{ number: number - 40 }] },
    mergeCommit: { oid: commitOf(number) },
    body: aUiBody(),
    ...more,
  });
}

/** The Operator's own label event on a pull request, as the gather's query reads it. */
export const labelledByOperator = (label: string, at: string) => ({ __typename: "LabeledEvent", createdAt: at, actor: OPERATOR, label: { name: label } });

/** One page of a Deployment's reports, newest first, each made at `at`. */
const reports = (at: string, ...states: string[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: states.map((state) => ({ state, createdAt: at, logUrl: null })) });

/**
 * Deployment `databaseId` of pull request `of`'s merge commit to
 * `environment`, created at `createdAt`, whose reports, newest first, are
 * `states` (a success unless a test says otherwise), as both the gather's
 * query and the Deployments read's read one.
 */
export function aDeployment(environment: string, databaseId: number, of: number, createdAt: string, states: readonly string[] = ["SUCCESS", "IN_PROGRESS"]): Record<string, unknown> {
  return { id: `DE_${databaseId}`, databaseId, environment, createdAt, commitOid: commitOf(of), commit: { committedDate: createdAt }, statuses: reports(createdAt, ...states) };
}

/** Production as it runs: Deployment 800 of pull request 52's merge, which succeeded on 2026-11-02 and nothing has superseded. */
export const LIVE = aDeployment("production", 800, 52, "2026-11-02T09:10:00Z");

/** One request made of the canned GitHub: a REST request, or a GraphQL one with whether it is a query or a mutation. */
export interface Request {
  readonly method: string;
  readonly path: string;
  /** A GraphQL request's operation; null for a REST request. */
  readonly operation: "query" | "mutation" | null;
}

/**
 * `jrey8343/shop` holding `raw`, with a log of every request made of it. Past
 * what the gather asks, it answers the Deployments read's comparison of two
 * commits, where a later pull request's commit contains an earlier one's
 * (commitOf), and the Main checks read's check runs on a commit, which are
 * `checkRuns` for that commit and check name, or none.
 */
export function stagingRepo(raw: RawRepo, checkRuns: Readonly<Record<string, Readonly<Record<string, readonly Record<string, unknown>[]>>>> = {}): { client: ReadClient; log: Request[] } {
  const { client: gathered } = repoWith(raw);
  const log: Request[] = [];
  const client: ReadClient = {
    async rest(method, path) {
      log.push({ method, path, operation: null });
      const compared = /^\/repos\/jrey8343\/shop\/compare\/(\d{40})\.\.\.(\d{40})\?/.exec(path);
      if (method === "GET" && compared !== null) return { status: Number(compared[2]) > Number(compared[1]) ? "ahead" : Number(compared[2]) === Number(compared[1]) ? "identical" : "behind" };
      const checked = /^\/repos\/jrey8343\/shop\/commits\/(\d{40})\/check-runs\?check_name=([^&]+)&/.exec(path);
      if (method === "GET" && checked !== null) return { check_runs: checkRuns[checked[1] ?? ""]?.[decodeURIComponent(checked[2] ?? "")] ?? [] };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    graphql(query, variables) {
      log.push({ method: "POST", path: "/graphql", operation: /^\s*mutation\b/.test(query) ? "mutation" : "query" });
      return gathered.graphql(query, variables);
    },
    fileText(repo, path, ref) {
      log.push({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${ref}`, operation: null });
      return gathered.fileText(repo, path, ref);
    },
  };
  return { client, log };
}
