// A GitHub API client, authenticated as whichever token the job holds (the
// Fabrik App's in a push job). It knows nothing of the Loop.

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** A failed GitHub REST call, with the status it failed with. */
export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** A GitHub API client authenticated as the Fabrik App. */
export class GitHub {
  readonly #token: string;
  readonly #apiUrl: string;

  constructor(token: string, apiUrl = "https://api.github.com") {
    this.#token = token;
    this.#apiUrl = apiUrl;
  }

  /** A REST call; with `allowNotFound`, a 404 (say, removing a label already gone) returns null. */
  async rest(method: string, path: string, body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: this.#headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && options.allowNotFound === true) return null;
    if (!response.ok) {
      throw new GitHubError(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`, response.status);
    }
    return response.status === 204 ? null : response.json();
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = (await this.rest("POST", "/graphql", { query, variables })) as {
      data?: T;
      errors?: unknown[];
    };
    if (result.errors !== undefined || result.data === undefined) {
      throw new Error(`GitHub GraphQL query failed: ${JSON.stringify(result.errors)}`);
    }
    return result.data;
  }

  /** A file's text from the repo at `ref`, or null if it doesn't exist there. Reads only; never runs it. */
  async fileText(repo: Repo, path: string, ref: string): Promise<string | null> {
    const url = `${this.#apiUrl}/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const response = await fetch(url, { headers: { ...this.#headers(), accept: "application/vnd.github.raw+json" } });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub GET ${path}@${ref} failed: ${response.status} ${await response.text()}`);
    }
    return response.text();
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
