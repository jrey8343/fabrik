// The outcomes read (#668): what became of each piece of work a week's Run
// records name, and every agent pull request merged in the week, for one
// Product repo. A reader makes it on demand, for Spend, never in a gather. It
// asks GitHub for the issues by number and for the week's merged agent pull
// requests, never for the history the Weekly summary reads, and pairs a pull
// request with the Ticket it names as the Weekly summary does. Which issues
// are Tickets is said here, so a reader holds no rule of its own. What a
// merged pull request cost is worked out from its `merged` by
// costPerMergedPullRequestOf (src/kit/mergedCost.ts). Read only.
import { GitHubError, gitHubMessageOf, type ReadClient } from "../github/client.ts";
import { isAgent, LABEL_EVENTS, PAGE_INFO, type RawActor } from "../github/facts.ts";
import { loginOf } from "../github/snapshot.ts";
import { type Window, within } from "../kit/retroEvidence.ts";
import { READY_FOR_AGENT } from "../loop/labels.ts";
import { neverRelatedKindOf } from "./related.ts";

/** What became of the work a week's Run records name in one repo, and the agent pull requests merged in the week. */
export interface OutcomesRead {
  /** `owner/name`. */
  readonly repo: string;
  /** When it was read, ISO 8601. */
  readonly readAt: string;
  /** One entry for each issue asked for that GitHub still has, then one for each other Ticket whose agent pull request merged in the week. */
  readonly work: WorkOutcome[] | "unread";
  /** Every agent pull request merged in the week, oldest merge first. */
  readonly merged: MergedInWeek[] | "unread";
  /** Why, when both are "unread". */
  readonly unread: string | null;
}

/** What became of one issue, as it stands when read. */
export interface WorkOutcome {
  readonly issue: number;
  readonly title: string;
  /**
   * `merged`: a Ticket with a merged agent pull request. `never-merged`: a
   * Ticket closed with none merged. `open`: any other Ticket, with or without
   * a pull request yet. `not-a-ticket`: an issue that is no Ticket.
   */
  readonly is: "merged" | "open" | "never-merged" | "not-a-ticket";
  /** The Ticket's agent pull request: the merged one, else the open one, else the newest closed one. */
  readonly pullRequest: number | null;
  /** When it merged, or when the Ticket closed with none merged, ISO 8601. */
  readonly at: string | null;
  /** The pull request's page, else the issue's. */
  readonly url: string;
}

/** An agent pull request merged in the week. */
export interface MergedInWeek {
  readonly pullRequest: number;
  /** The Ticket it names, or null. */
  readonly ticket: number | null;
  /** ISO 8601. */
  readonly mergedAt: string;
}

/** A pull request as these queries ask for it. */
interface RawPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly headRefName: string;
  readonly author: RawActor | null;
  readonly closingIssuesReferences: { readonly nodes: readonly { readonly number: number }[] };
}

/** An issue as the query by number asks for it. */
interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
  readonly closedAt: string | null;
  readonly author: RawActor | null;
  readonly labels: { readonly nodes: readonly { readonly name: string }[] };
  readonly subIssues: { readonly nodes: readonly { readonly number: number }[] };
  readonly timelineItems: { readonly nodes: readonly { readonly __typename: string; readonly label?: { readonly name: string } }[] };
  readonly closedByPullRequestsReferences: { readonly nodes: readonly RawPullRequest[] };
}

const PULL_REQUEST_FIELDS = `
  number url state mergedAt closedAt headRefName
  author { login __typename }
  closingIssuesReferences(first: 1) { nodes { number } }
`;

const ISSUE_FIELDS = `
  number title url state closedAt
  author { login __typename }
  labels(first: 50) { nodes { name } }
  subIssues(first: 1) { nodes { number } }
  ${LABEL_EVENTS}
  closedByPullRequestsReferences(first: 25, includeClosedPrs: true) { nodes { ${PULL_REQUEST_FIELDS} } }
`;

/** The query for these issues by number, each under its own alias. */
export function issuesQuery(numbers: readonly number[]): string {
  const issues = numbers.map((number) => `i${number}: issue(number: ${number}) { ${ISSUE_FIELDS} }`).join("\n");
  return `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${issues}
    }
  }
`;
}

/** The query for the pull requests a search finds: the week's merged ones. */
export const MERGED_SEARCH_QUERY = `
  query ($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      ${PAGE_INFO}
      nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
    }
  }
`;

/** One page of the search: a node that is no pull request comes back empty. */
interface SearchAnswer {
  readonly search: {
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    readonly nodes: readonly (RawPullRequest | Record<string, never>)[];
  };
}

/** How many issues one query asks for. */
const ISSUES_PER_QUERY = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What became of `issues` in `repo` ("owner/name"), the issue numbers a
 * reader's Run records for `week` name there, and every agent pull request
 * merged in the week, as read at `now`. A Ticket whose agent pull request
 * merged in the week is in `work` whether or not it was asked for. An issue
 * GitHub no longer has is left out of `work`. `appLogin`, the Fabrik App's
 * login, tells the Kit's own issues apart; without it, any bot's issue is
 * the Kit's. A refusal or a failure is returned as unread with why, never
 * thrown.
 */
export async function readOutcomes(
  client: Pick<ReadClient, "graphql">,
  repo: string,
  week: Window,
  issues: readonly number[],
  now: string,
  appLogin: string | null = null,
): Promise<OutcomesRead> {
  try {
    const mergedPullRequests = (await searchMerged(client, repo, week)).filter(
      (pullRequest) => isAgent(pullRequest) && pullRequest.mergedAt !== null && within(week, pullRequest.mergedAt),
    );
    const merged = mergedPullRequests
      .map((pullRequest) => ({ pullRequest: pullRequest.number, ticket: ticketOf(pullRequest), mergedAt: pullRequest.mergedAt ?? "" }))
      .toSorted((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.pullRequest - b.pullRequest);
    const numbers = [...new Set([...issues, ...merged.flatMap(({ ticket }) => (ticket === null ? [] : [ticket]))])];
    const held = await issuesByNumber(client, repo, numbers);
    const work = numbers.flatMap((number) => {
      const issue = held.get(number);
      if (issue === undefined) return [];
      const outcome = outcomeOf(issue, mergedPullRequests, appLogin);
      return issues.includes(number) || outcome.is !== "not-a-ticket" ? [outcome] : [];
    });
    return { repo, readAt: now, work, merged, unread: null };
  } catch (error) {
    return { repo, readAt: now, work: "unread", merged: "unread", unread: whyUnread(error) };
  }
}

/** The Ticket a pull request names, as the Weekly summary pairs them: the first issue it closes. */
function ticketOf(pullRequest: RawPullRequest): number | null {
  return pullRequest.closingIssuesReferences.nodes[0]?.number ?? null;
}

/**
 * The pull requests merged in `repo` that GitHub's search finds for a span of
 * days around the week, a day wider each side, so a time zone's week is
 * inside it; the caller keeps those merged in the week.
 */
async function searchMerged(client: Pick<ReadClient, "graphql">, repo: string, week: Window): Promise<RawPullRequest[]> {
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const q = `repo:${repo} is:pr is:merged merged:${day(week.start - DAY_MS)}..${day(week.end + DAY_MS)}`;
  const found: RawPullRequest[] = [];
  let after: string | null = null;
  do {
    const answer: SearchAnswer = await client.graphql<SearchAnswer>(MERGED_SEARCH_QUERY, { q, after });
    const { search } = answer;
    found.push(...search.nodes.filter((node): node is RawPullRequest => "number" in node));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after !== null);
  return found;
}

/**
 * The issues GitHub has among `numbers`, by number, a query for each 25. The
 * Kit's client drops a whole answer when GitHub can't find one issue in it,
 * so that query is asked again without the ones it couldn't find.
 */
async function issuesByNumber(client: Pick<ReadClient, "graphql">, repo: string, numbers: readonly number[]): Promise<Map<number, RawIssue>> {
  const [owner = "", name = ""] = repo.split("/");
  const held = new Map<number, RawIssue>();
  for (let from = 0; from < numbers.length; from += ISSUES_PER_QUERY) {
    let asking = numbers.slice(from, from + ISSUES_PER_QUERY);
    while (asking.length > 0) {
      try {
        const { repository } = await client.graphql<{ repository: Record<string, RawIssue | null> }>(issuesQuery(asking), { owner, name });
        for (const issue of Object.values(repository)) if (issue !== null) held.set(issue.number, issue);
        asking = [];
      } catch (error) {
        const missing = notFoundIn(error, asking);
        if (missing.length === 0) throw error;
        asking = asking.filter((number) => !missing.includes(number));
      }
    }
  }
  return held;
}

/**
 * The issues among `asked` that a failed query's answer says GitHub could not
 * find, NOT_FOUND at the alias each was asked under; none for any other
 * failure, a repo GitHub can't find among them.
 */
function notFoundIn(error: unknown, asked: readonly number[]): number[] {
  if (!(error instanceof GitHubError) || error.status !== 404) return [];
  let errors: unknown = [];
  try {
    errors = (JSON.parse(error.body) as { errors?: unknown }).errors;
  } catch {
    // Not GitHub's GraphQL answer: no alias to read.
  }
  return (Array.isArray(errors) ? errors : []).flatMap((entry) => {
    const { type, path } = (typeof entry === "object" && entry !== null ? entry : {}) as { type?: unknown; path?: unknown };
    const alias = Array.isArray(path) ? path[1] : undefined;
    const number = typeof alias === "string" && /^i\d+$/.test(alias) ? Number(alias.slice(1)) : null;
    return type === "NOT_FOUND" && number !== null && asked.includes(number) ? [number] : [];
  });
}

/** What became of `issue`, by its agent pull requests, `merged` among them as the week's search found them. */
function outcomeOf(issue: RawIssue, merged: readonly RawPullRequest[], appLogin: string | null): WorkOutcome {
  const named = (pullRequest: RawPullRequest) => isAgent(pullRequest) && ticketOf(pullRequest) === issue.number;
  const pullRequests = [...issue.closedByPullRequestsReferences.nodes.filter(named)];
  for (const pullRequest of merged.filter(named)) if (!pullRequests.some(({ number }) => number === pullRequest.number)) pullRequests.push(pullRequest);
  const { number, title, url } = issue;
  if (!isTicket(issue, pullRequests.length > 0, appLogin)) return { issue: number, title, is: "not-a-ticket", pullRequest: null, at: null, url };
  const newest = (a: string | null, b: string | null) => Date.parse(b ?? "") - Date.parse(a ?? "");
  const mergedOne = pullRequests.filter(({ mergedAt }) => mergedAt !== null).toSorted((a, b) => newest(a.mergedAt, b.mergedAt))[0];
  if (mergedOne !== undefined) return { issue: number, title, is: "merged", pullRequest: mergedOne.number, at: mergedOne.mergedAt, url: mergedOne.url };
  const its =
    pullRequests.find(({ state }) => state === "OPEN") ??
    pullRequests.filter(({ state }) => state === "CLOSED").toSorted((a, b) => newest(a.closedAt, b.closedAt))[0];
  const page = its?.url ?? url;
  if (issue.state === "CLOSED") return { issue: number, title, is: "never-merged", pullRequest: its?.number ?? null, at: issue.closedAt, url: page };
  return { issue: number, title, is: "open", pullRequest: its?.number ?? null, at: null, url: page };
}

/**
 * Whether `issue` is a Ticket: an agent pull request names it, or it has ever
 * carried `ready-for-agent` (it carries it now, or its label events show it
 * added), has no sub-issues and is no kind never related to a pull request
 * (./related.ts) but a Monitor issue, which Triage can send to an Implementer.
 * A Ticket sent back to design, or now `ready-for-human`, stays one.
 */
function isTicket(issue: RawIssue, named: boolean, appLogin: string | null): boolean {
  if (named) return true;
  const labels = issue.labels.nodes.map(({ name }) => name);
  const everReady =
    labels.includes(READY_FOR_AGENT) ||
    issue.timelineItems.nodes.some(({ __typename, label }) => __typename === "LabeledEvent" && label?.name === READY_FOR_AGENT);
  if (!everReady || issue.subIssues.nodes.length > 0) return false;
  const kind = neverRelatedKindOf({ author: loginOf(issue.author), labels, subIssues: [] }, appLogin);
  return kind === null || kind === "monitor";
}

/** Why the outcomes couldn't be read, in GitHub's words where GitHub gave them. */
function whyUnread(error: unknown): string {
  if (error instanceof GitHubError) {
    const request = error.request === "" ? "A read of the outcomes" : error.request;
    return error.status === 0 ? `${request} got no answer from GitHub: ${error.message}` : `${request} failed with ${error.status}: ${gitHubMessageOf(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
