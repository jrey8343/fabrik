// The GitHub adapter: turns an Actions event into a Loop event, gathers the
// snapshot the core needs, and applies the plan the core returns. It holds no
// Loop rules; those all live in src/loop/rules.ts.
import { instructionsPath, KIT_CONFIG_PATH, type KitConfig, type KitConfigSources, PHASES } from "../kit/config.ts";
import type { AgentRunResult } from "../agent/result.ts";
import { isDesignRoundComment } from "../loop/design.ts";
import type { Action, LoopEvent, Plan, Snapshot } from "../loop/types.ts";

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** Maps an Actions event to the Loop event it stands for, or null if the Loop ignores it. */
export function loopEventFrom(eventName: string, payload: Record<string, unknown>): LoopEvent | null {
  const issue = payload["issue"] as { number: number; pull_request?: unknown } | undefined;
  if (issue === undefined) return null;
  if (eventName === "issues" && payload["action"] === "opened") {
    return { kind: "issue-opened", issue: issue.number };
  }
  if (eventName === "issues" && payload["action"] === "labeled") {
    const label = payload["label"] as { name: string };
    return { kind: "label-added", issue: issue.number, label: label.name };
  }
  // issue_comment also fires for comments on pull requests, which aren't issue comments to the Loop.
  if (eventName === "issue_comment" && payload["action"] === "created" && issue.pull_request === undefined) {
    const user = (payload["comment"] as { user: { login: string; type: string } }).user;
    return { kind: "issue-comment-created", issue: issue.number, author: user.login, authorIsBot: user.type === "Bot" };
  }
  return null;
}

/**
 * The Operator's login: the Kit config's `operator`, or else the Product
 * repo's owner, which must then be a user rather than an organization.
 */
export function operatorFor(config: KitConfig, payload: Record<string, unknown>): string {
  if (config.operator !== null) return config.operator;
  const owner = (payload["repository"] as { owner?: { login?: string; type?: string } } | undefined)?.owner;
  if (owner?.type === "User" && typeof owner.login === "string") return owner.login;
  throw new Error(
    `The repo's owner ${owner?.login ?? "(unknown)"} isn't a user, so set "operator" to the Operator's login in ${KIT_CONFIG_PATH}`,
  );
}

/** The agent run a plan starts, which the workflow carries out by routing to that role's agent job. */
export function agentRunIn(plan: Plan): Extract<Action, { kind: "start-agent-run" }> | null {
  if (plan.kind !== "act") return null;
  return (
    plan.actions.find(
      (action): action is Extract<Action, { kind: "start-agent-run" }> => action.kind === "start-agent-run",
    ) ?? null
  );
}

/**
 * Turns the result an agent job passed out as an artifact (src/agent/result.ts)
 * into the Loop event its push job applies.
 */
export function agentRunEventFrom(result: AgentRunResult): LoopEvent {
  return { kind: "agent-run-finished", role: result.role, issue: result.issue, output: result.output };
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

const ISSUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        state
        author { login }
        labels(first: 100) { nodes { name } }
        parent { number }
        comments(last: 100) { nodes { body } }
      }
    }
  }
`;

interface IssueQueryResult {
  repository: {
    issue: {
      number: number;
      state: "OPEN" | "CLOSED";
      author: { login: string } | null;
      labels: { nodes: { name: string }[] };
      parent: { number: number } | null;
      comments: { nodes: { body: string }[] };
    } | null;
  };
}

/** Reads the current GitHub state the event needs, fresh rather than from the event payload. */
export async function gatherSnapshot(github: GitHub, repo: Repo, event: LoopEvent, operator: string): Promise<Snapshot> {
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
      open: issue.state === "OPEN",
      author: issue.author?.login ?? "ghost",
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
      designRounds: issue.comments.nodes.filter((comment) => isDesignRoundComment(comment.body)).length,
    },
    operator,
  };
}

/** Reads the Kit config folder's files from the Product repo at `ref`, through the API. */
export async function readKitConfigSources(github: GitHub, repo: Repo, ref: string): Promise<KitConfigSources> {
  const [config, ...instructions] = await Promise.all([
    github.fileText(repo, KIT_CONFIG_PATH, ref),
    ...PHASES.map((phase) => github.fileText(repo, instructionsPath(phase), ref)),
  ]);
  return {
    config: config ?? null,
    instructions: Object.fromEntries(PHASES.map((phase, i) => [phase, instructions[i] ?? null])),
  };
}

/** Applies each action in the plan, in order. */
export async function applyPlan(github: GitHub, repo: Repo, plan: Plan): Promise<void> {
  if (plan.kind !== "act") return;
  for (const action of plan.actions) {
    await apply(github, repo, action);
  }
}

async function apply(github: GitHub, repo: Repo, action: Action): Promise<void> {
  const issue = `/repos/${repo.owner}/${repo.name}/issues/${action.issue}`;
  switch (action.kind) {
    case "add-labels":
      if (action.labels.length > 0) await github.rest("POST", `${issue}/labels`, { labels: action.labels });
      return;
    case "remove-label":
      await github.rest("DELETE", `${issue}/labels/${encodeURIComponent(action.label)}`, undefined, {
        allowNotFound: true,
      });
      return;
    case "comment":
      await github.rest("POST", `${issue}/comments`, { body: action.body });
      return;
    case "edit-issue-body":
      await github.rest("PATCH", issue, { body: action.body });
      return;
    case "start-agent-run":
      // The workflow starts agent runs by routing to the role's agent job (src/kit/jobs.ts).
      return;
  }
}
