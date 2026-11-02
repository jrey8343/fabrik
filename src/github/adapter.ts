// The GitHub adapter: turns an Actions event into a Loop event, gathers the
// snapshot the core needs, and applies the plan the core returns. It holds no
// Loop rules; those all live in src/loop/rules.ts.
import type { Action, LoopEvent, Plan, Snapshot } from "../loop/types.ts";

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** Maps an Actions event to the Loop event it stands for, or null if the Loop ignores it. */
export function loopEventFrom(eventName: string, payload: Record<string, unknown>): LoopEvent | null {
  if (eventName === "issues" && payload["action"] === "opened") {
    const issue = payload["issue"] as { number: number };
    return { kind: "issue-opened", issue: issue.number };
  }
  return null;
}

/** A GitHub API client authenticated as the Fabrik App. */
export class GitHub {
  readonly #token: string;
  readonly #apiUrl: string;

  constructor(token: string, apiUrl = "https://api.github.com") {
    this.#token = token;
    this.#apiUrl = apiUrl;
  }

  async rest(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: this.#headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`);
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

  #headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }
}

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        author { login }
        labels(first: 100) { nodes { name } }
        parent { number }
      }
    }
  }
`;

interface IssueQueryResult {
  repository: {
    issue: {
      number: number;
      author: { login: string } | null;
      labels: { nodes: { name: string }[] };
      parent: { number: number } | null;
    } | null;
  };
}

/** Reads the current GitHub state the event needs, fresh rather than from the event payload. */
export async function gatherSnapshot(github: GitHub, repo: Repo, event: LoopEvent): Promise<Snapshot> {
  const data = await github.graphql<IssueQueryResult>(ISSUE_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number: event.issue,
  });
  const issue = data.repository.issue;
  if (issue === null) {
    throw new Error(`Issue #${event.issue} not found in ${repo.owner}/${repo.name}`);
  }
  return {
    issue: {
      number: issue.number,
      author: issue.author?.login ?? "ghost",
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
    },
  };
}

/** Applies each action in the plan, in order. */
export async function applyPlan(github: GitHub, repo: Repo, plan: Plan): Promise<void> {
  if (plan.kind === "nothing") return;
  for (const action of plan.actions) {
    await apply(github, repo, action);
  }
}

async function apply(github: GitHub, repo: Repo, action: Action): Promise<void> {
  switch (action.kind) {
    case "add-labels":
      await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${action.issue}/labels`, {
        labels: action.labels,
      });
      return;
  }
}
