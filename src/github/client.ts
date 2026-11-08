// A GitHub API client, authenticated as whichever token the job holds (the
// Fabrik App's in a push job). It knows nothing of the Loop.

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/**
 * A failed GitHub call, with the status it failed with: a REST call's HTTP
 * status, a GraphQL query's error type as the status GitHub's REST API gives
 * for it (see GRAPHQL_STATUS), or 0 when GitHub never answered.
 */
export class GitHubError extends Error {
  readonly status: number;
  /** The body GitHub answered with, such as its JSON `message`. */
  readonly body: string;
  /** GitHub's `x-ratelimit-remaining` header, or null when it gave none. */
  readonly rateLimitRemaining: string | null;
  /** The request that failed, such as `GET /repos/acme/shop/pulls/84`, or "" when the thrower didn't say. */
  readonly request: string;

  constructor(
    message: string,
    status: number,
    answer: { readonly body?: string; readonly rateLimitRemaining?: string | null; readonly request?: string } = {},
  ) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = answer.body ?? "";
    this.rateLimitRemaining = answer.rateLimitRemaining ?? null;
    this.request = answer.request ?? "";
  }
}

/**
 * What GitHub said of a failed call: the `message` of its JSON body, or for
 * a GraphQL query its errors' messages, or else the body itself; for a call
 * GitHub never answered, why.
 */
export function gitHubMessageOf(error: GitHubError): string {
  try {
    const body: unknown = JSON.parse(error.body);
    if (typeof body === "object" && body !== null) {
      const { message, errors } = body as { message?: unknown; errors?: unknown };
      if (typeof message === "string") return message;
      if (Array.isArray(errors)) {
        const messages = errors.map((e) => (typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined));
        if (messages.every((m) => typeof m === "string") && messages.length > 0) return messages.join("; ");
      }
    }
  } catch {
    // Not JSON: the body as GitHub sent it.
  }
  return error.body.trim() === "" ? error.message : error.body.trim();
}

/**
 * The REST status matching a GraphQL error's `type`, for those GitHub names.
 * An error with no type, or one not listed, is read as GitHub's own failure.
 */
const GRAPHQL_STATUS: Readonly<Record<string, number>> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
};

function graphqlStatusOf(errors: unknown): number {
  const [first] = Array.isArray(errors) ? errors : [];
  const type = typeof first === "object" && first !== null ? (first as { type?: unknown }).type : undefined;
  return (typeof type === "string" ? GRAPHQL_STATUS[type] : undefined) ?? 502;
}

/** The GitHubError for a response GitHub answered with a failing status. */
async function failedResponse(request: string, response: Response): Promise<GitHubError> {
  const text = await response.text();
  return new GitHubError(`GitHub ${request} failed: ${response.status} ${text}`, response.status, {
    body: text,
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    request,
  });
}

/** A fetch GitHub never answered, such as a network error, as a GitHubError with status 0. */
async function fetched(request: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new GitHubError(`GitHub ${request} failed: ${why}`, 0, { body: why, request });
  }
}

/**
 * Why GitHub refused a call, when it's one of the refusals a caller can act
 * on: a rate limit (a 429, or a 403 with no requests left or a message naming
 * a rate limit), or a permission the token lacks (a 403 GitHub answers with
 * "Resource not accessible by integration"). Null for any other failure.
 */
export function refusalOf(error: GitHubError): "rate-limited" | "missing-permission" | null {
  if (error.status === 429) return "rate-limited";
  if (error.status !== 403) return null;
  if (error.rateLimitRemaining === "0" || /rate limit/i.test(error.body)) return "rate-limited";
  return error.body.includes("Resource not accessible by integration") ? "missing-permission" : null;
}

/**
 * Every item of a paginated REST list, 100 to a page, whatever query `path`
 * already has. `itemsOf` picks the list out of a page that wraps it, as
 * GitHub's check runs do; a page that is the list needs none.
 */
export async function allPages<T>(
  github: Pick<GitHub, "rest">,
  path: string,
  itemsOf: (page: unknown) => readonly T[] = (page) => page as T[],
): Promise<T[]> {
  const query = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = itemsOf(await github.rest("GET", `${path}${query}per_page=100&page=${page}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/**
 * Whether a second try of a call that failed with `error` could succeed
 * without doubling a change (#421). A read (`write` false) retries after any
 * 5xx, a call GitHub never answered, or a secondary rate limit; a write only
 * after a 502, 503 or 504, which GitHub answers when the call never reached
 * it, or a secondary rate limit, which refuses it unmade. A primary rate
 * limit, with no requests left until it resets, retries neither.
 */
function worthRetrying(error: GitHubError, write: boolean): boolean {
  const secondaryLimit = refusalOf(error) === "rate-limited" && error.rateLimitRemaining !== "0";
  if (secondaryLimit) return true;
  if (write) return error.status === 502 || error.status === 503 || error.status === 504;
  return error.status === 0 || error.status >= 500;
}

/** The longest a retry waits on GitHub's `retry-after`, so a job's timeout never runs out waiting. */
const LONGEST_RETRY_WAIT_MS = 60_000;

/** A GitHub API client authenticated as the Fabrik App. */
export class GitHub {
  readonly #token: string;
  readonly #apiUrl: string;
  readonly #retryDelaysMs: readonly number[];

  /**
   * `retryDelaysMs` is how long to wait before each retry of a call worth
   * retrying, one retry to each: by default twice, after 1 and 4 seconds,
   * unless GitHub's `retry-after` asks for longer.
   */
  constructor(token: string, apiUrl = "https://api.github.com", options: { readonly retryDelaysMs?: readonly number[] } = {}) {
    this.#token = token;
    this.#apiUrl = apiUrl;
    this.#retryDelaysMs = options.retryDelaysMs ?? [1_000, 4_000];
  }

  /** A REST call; with `allowNotFound`, a 404 (say, removing a label already gone) returns null. */
  async rest(method: string, path: string, body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
    // A GraphQL query is a read, though it's POSTed; only a mutation changes anything.
    const write = path === "/graphql" ? isMutation(body) : !["GET", "HEAD"].includes(method.toUpperCase());
    const response = await this.#answered(`${method} ${path}`, `${this.#apiUrl}${path}`, {
      write,
      notFoundIsNull: options.allowNotFound === true,
      init: { method, headers: this.#headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    });
    if (response === null) return null;
    return response.status === 204 ? null : response.json();
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = (await this.rest("POST", "/graphql", { query, variables })) as {
      data?: T;
      errors?: unknown[];
    };
    if (result.errors !== undefined || result.data === undefined) {
      const errors = JSON.stringify(result.errors);
      throw new GitHubError(`GitHub GraphQL query failed: ${errors}`, graphqlStatusOf(result.errors), {
        body: JSON.stringify({ errors: result.errors ?? [] }),
        request: "POST /graphql",
      });
    }
    return result.data;
  }

  /** A file's text from the repo at `ref`, or null if it doesn't exist there. Reads only; never runs it. */
  async fileText(repo: Repo, path: string, ref: string): Promise<string | null> {
    const url = `${this.#apiUrl}/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const response = await this.#answered(`GET ${path}@${ref}`, url, {
      write: false,
      notFoundIsNull: true,
      init: { headers: { ...this.#headers(), accept: "application/vnd.github.raw+json" } },
    });
    return response === null ? null : response.text();
  }

  /**
   * GitHub's answer to a call, once it answers with success, trying a
   * failure worth it again; null for a 404 when `notFoundIsNull`. `write`
   * says whether the call changes anything (see worthRetrying).
   */
  async #answered(
    request: string,
    url: string,
    call: { readonly write: boolean; readonly notFoundIsNull: boolean; readonly init: RequestInit },
  ): Promise<Response | null> {
    const { write, notFoundIsNull, init } = call;
    for (let tries = 0; ; tries++) {
      // A call GitHub never answered comes back as a GitHubError with status 0.
      const response = await fetched(request, url, init).catch((error: unknown) => error);
      if (response instanceof Response) {
        if (response.status === 404 && notFoundIsNull) return null;
        if (response.ok) return response;
      }
      const error = response instanceof Response ? await failedResponse(request, response) : response;
      const delay = this.#retryDelaysMs[tries];
      if (!(error instanceof GitHubError) || delay === undefined || !worthRetrying(error, write)) throw error;
      await sleep(Math.max(delay, response instanceof Response ? retryAfterMs(response) : 0));
    }
  }

  #headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }
}

/** Whether a GraphQL call's body is a mutation, which changes something, rather than a query. */
function isMutation(body: unknown): boolean {
  const query = typeof body === "object" && body !== null ? (body as { query?: unknown }).query : undefined;
  return typeof query === "string" && /^\s*mutation\b/.test(query);
}

/** How long GitHub's `retry-after` header asks a retry to wait, at most a minute; 0 when it gives none. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, LONGEST_RETRY_WAIT_MS) : 0;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** One page of a GraphQL connection, as a query selecting its `pageInfo { hasNextPage endCursor }` and `nodes` gets it. */
export interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/**
 * Every node of a paged GraphQL connection, which `query` reads a page of
 * from the cursor `$after` in the repo `$owner/$name`, with `variables`; or
 * only until `enough` says the rest are too old. A null connection has none.
 */
export async function pagesOf<T>(
  github: Pick<GitHub, "graphql">,
  query: string,
  repo: Repo,
  variables: Record<string, unknown>,
  connection: (data: any) => Page<T> | null,
  enough: (page: readonly T[]) => boolean = () => false,
): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  do {
    const page = connection(await github.graphql(query, { owner: repo.owner, name: repo.name, after, ...variables }));
    if (page === null) break;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage && !enough(page.nodes) ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return nodes;
}
