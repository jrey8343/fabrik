// A GitHub API client, authenticated as whichever token the job holds (the
// Fabrik App's in a push job). It knows nothing of the Loop.

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** A failed GitHub REST call, with the status it failed with. */
export class GitHubError extends Error {
  readonly status: number;
  /** The body GitHub answered with, such as its JSON `message`. */
  readonly body: string;
  /** GitHub's `x-ratelimit-remaining` header, or null when it gave none. */
  readonly rateLimitRemaining: string | null;

  constructor(message: string, status: number, answer: { readonly body?: string; readonly rateLimitRemaining?: string | null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = answer.body ?? "";
    this.rateLimitRemaining = answer.rateLimitRemaining ?? null;
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
      const text = await response.text();
      throw new GitHubError(`GitHub ${method} ${path} failed: ${response.status} ${text}`, response.status, {
        body: text,
        rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
      });
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
