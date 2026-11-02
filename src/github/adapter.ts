// The GitHub adapter: turns an Actions event into a Loop event, gathers the
// snapshot the core needs, and applies the plan the core returns. It holds no
// Loop rules; those all live in src/loop/rules.ts.
import { instructionsPath, KIT_CONFIG_PATH, type KitConfigSources, PHASES } from "../kit/config.ts";
import type { AgentRunResult } from "../agent/result.ts";
import { isAgentPullRequest, ticketOfAgentBranch } from "../loop/agentPullRequest.ts";
import { designSessionOf } from "../loop/design.ts";
import { countEmptyDiffs } from "../loop/implement.ts";
import { requestChangesRunIn } from "../loop/mergeGate.ts";
import { verdictsIn } from "../loop/verdict.ts";
import { KIT_ISSUE_LABELS, READY_FOR_AGENT } from "../loop/labels.ts";
import type {
  Action,
  AgentRole,
  BranchChanges,
  CreatedIssue,
  FailureReport,
  KitIssueSnapshot,
  LoopEvent,
  Plan,
  PostedComment,
  PullRequestSnapshot,
  Snapshot,
  SpecSnapshot,
  TicketSnapshot,
} from "../loop/types.ts";

export interface Repo {
  readonly owner: string;
  readonly name: string;
}

/** Maps an Actions event to the Loop event it stands for, or null if the Loop ignores it. */
export function loopEventFrom(
  eventName: string,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): LoopEvent | null {
  // The scheduled Kit workflow (schedule.yml), for the Loop's time-based rules.
  if (eventName === "schedule") return { kind: "scheduled-tick", now: now.toISOString() };
  if (eventName === "issues" && payload["action"] === "opened") {
    const issue = payload["issue"] as { number: number };
    return { kind: "issue-opened", issue: issue.number };
  }
  if (eventName === "issues" && payload["action"] === "labeled") {
    const issue = payload["issue"] as { number: number };
    const label = payload["label"] as { name: string };
    return { kind: "label-added", issue: issue.number, label: label.name };
  }
  if (eventName === "issue_comment" && payload["action"] === "created") {
    const issue = payload["issue"] as { number: number; pull_request?: unknown };
    // A comment on a PR is not a reply on an issue.
    if (issue.pull_request !== undefined) return null;
    const comment = payload["comment"] as { user: { login: string; type: string }; body?: string | null };
    return {
      kind: "issue-comment-created",
      issue: issue.number,
      commenter: comment.user.login,
      commenterIsBot: comment.user.type === "Bot",
      body: comment.body ?? "",
    };
  }
  if (eventName === "issues" && payload["action"] === "closed") {
    return { kind: "issue-closed", issue: (payload["issue"] as { number: number }).number };
  }
  // pull_request_target, so the run uses the base branch's caller workflow and
  // Kit config, never the PR's. The Loop never checks out PR code.
  if (eventName === "pull_request_target") {
    const pullRequest = (payload["pull_request"] as { number: number }).number;
    // Opened or pushed to: its required checks start, and a Review waits for them.
    if (payload["action"] === "opened" || payload["action"] === "synchronize" || payload["action"] === "reopened") {
      return { kind: "pull-request-pushed", pullRequest };
    }
    if (payload["action"] === "labeled") {
      const label = payload["label"] as { name: string };
      return { kind: "pull-request-labeled", pullRequest, label: label.name };
    }
    if (payload["action"] === "ready_for_review") return { kind: "pull-request-left-draft", pullRequest };
    if (payload["action"] === "closed") return { kind: "pull-request-closed", pullRequest };
  }
  // There is no _target form of this event, so the run uses the PR's merge
  // commit's caller workflow and Kit config. An agent PR can't change either:
  // both are trust roots its push job refuses (ADR-0005).
  if (eventName === "pull_request_review" && payload["action"] === "submitted") {
    const review = payload["review"] as { id: number; state: string; user: { login: string; type: string } };
    if (review.state.toLowerCase() !== "changes_requested") return null;
    return {
      kind: "pull-request-changes-requested",
      pullRequest: (payload["pull_request"] as { number: number }).number,
      review: review.id,
      reviewer: review.user.login,
      reviewerIsBot: review.user.type === "Bot",
    };
  }
  return null;
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
export function agentRunEventFrom(
  result: AgentRunResult,
  changes: BranchChanges | null = null,
  retry: { readonly pullRequest: number; readonly runUrl: string; readonly requestChanges?: boolean } | null = null,
): LoopEvent {
  if (result.role === "review") throw new Error("A Reviewer's result is applied through reviewEventFrom");
  if (result.role !== "implement") {
    return { kind: "agent-run-finished", role: result.role, issue: result.issue, output: result.output };
  }
  if (result.branch === undefined || changes === null) {
    throw new Error("An Implement run's result needs the branch it built and the paths that branch changes");
  }
  return {
    kind: "implement-run-finished",
    issue: result.issue,
    output: result.output,
    branch: result.branch.name,
    base: result.branch.base.ref,
    changes,
    // A retry's branch starts at the PR head it built on, which the core checks is still the PR's.
    ...(retry === null ? {} : { fixes: { ...retry, headSha: result.branch.base.sha } }),
  };
}

/** What a Review's push job knows: from its checks job, and the Reviewer's result when it ran. */
export interface FinishedReview {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly runUrl: string;
  /** The required checks that didn't pass, from the checks job. */
  readonly failedChecks: readonly string[];
  /** The Reviewer's result, null when red checks kept it from running. */
  readonly result: AgentRunResult | null;
}

/** Turns a finished Review into the Loop event its push job applies. */
export function reviewEventFrom(review: FinishedReview): LoopEvent {
  const { pullRequest, headSha, runUrl, result } = review;
  if (result === null) {
    return { kind: "required-checks-finished", pullRequest, headSha, failed: review.failedChecks, runUrl };
  }
  if (result.role !== "review") throw new Error(`A Review's push job was handed a ${result.role} result`);
  if (result.issue !== pullRequest) throw new Error(`The Reviewer's result is for #${result.issue}, not #${pullRequest}`);
  return { kind: "review-run-finished", pullRequest, headSha, output: result.output, runUrl };
}

/** What the failure job knows about the agent job it follows (see the failure job in loop.yml). */
export interface FailedJob {
  readonly role: AgentRole;
  readonly issue: number;
  readonly runUrl: string;
  /** `needs.<job>.result`. */
  readonly jobResult: string;
  /** The agent job's 1Password step outcome, passed out as a job output; empty if it never got that far. */
  readonly secretsStep: string;
  readonly report: FailureReport | null;
}

const SECRETS_OUTCOMES = ["success", "failure", "cancelled", "skipped"] as const;

/** Turns what the failure job gathered into the Loop event it reports. */
export function agentFailureEventFrom(job: FailedJob): LoopEvent {
  const secretsStep = SECRETS_OUTCOMES.find((outcome) => outcome === job.secretsStep) ?? null;
  return {
    kind: "agent-run-failed",
    role: job.role,
    issue: job.issue,
    runUrl: job.runUrl,
    jobResult: job.jobResult === "cancelled" ? "cancelled" : "failure",
    secretsStep,
    report: job.report,
  };
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
      owner { login }
      issue(number: $number) {
        number
        state
        author { login }
        labels(first: 100) { nodes { name } }
        parent { number }
        comments(last: 100) { nodes { body author { __typename } } }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number } }
      }
    }
  }
`;

interface IssueQueryResult {
  repository: {
    owner: { login: string };
    issue: {
      number: number;
      state: "OPEN" | "CLOSED";
      author: { login: string } | null;
      labels: { nodes: { name: string }[] };
      parent: { number: number } | null;
      comments: { nodes: { body: string; author: { __typename: string } | null }[] };
      closedByPullRequestsReferences: { nodes: { number: number }[] };
    } | null;
  };
}

const PULL_REQUEST_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      pullRequest(number: $number) {
        number
        state
        isDraft
        headRefName
        headRefOid
        author { __typename }
        labels(first: 100) { nodes { name } }
        comments(last: 100) { nodes { body author { __typename } } }
        reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { databaseId author { login __typename } commit { oid } } }
      }
    }
  }
`;

interface PullRequestQueryResult {
  repository: {
    owner: { login: string };
    pullRequest: {
      number: number;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft: boolean;
      headRefName: string;
      headRefOid: string;
      author: { __typename: string } | null;
      labels: { nodes: { name: string }[] };
      comments: { nodes: { body: string; author: { __typename: string } | null }[] };
      reviews: {
        nodes: { databaseId: number; author: { login: string; __typename: string } | null; commit: { oid: string } | null }[];
      };
    } | null;
  };
}

// Pages through every open ready-for-agent issue. Open PRs are read once: a
// Product repo with more than 100 open PRs is far past max_in_flight anyway.
const DISPATCH_QUERY = `
  query ($owner: String!, $name: String!, $after: String, $ready: String!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: [$ready], first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          state
          labels(first: 100) { nodes { name } }
          subIssues { totalCount }
          blockedBy(first: 50) { nodes { number state } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: false) { nodes { number state } }
        }
      }
      pullRequests(states: OPEN, first: 100) {
        nodes { isDraft headRefName author { __typename } }
      }
    }
  }
`;

interface DispatchQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        state: "OPEN" | "CLOSED";
        labels: { nodes: { name: string }[] };
        subIssues: { totalCount: number };
        blockedBy: { nodes: { number: number; state: "OPEN" | "CLOSED" }[] };
        closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
      }[];
    };
    pullRequests: { nodes: { isDraft: boolean; headRefName: string; author: { __typename: string } | null }[] };
  };
}

/**
 * The name of the Implement job in .github/workflows/loop.yml. Called from a
 * Product repo's caller workflow, it shows up as `<caller job> / Implement`.
 */
const IMPLEMENT_JOB_NAME = "Implement";

/**
 * Reads the current GitHub state the event needs, fresh rather than from the
 * event payload. The Operator is the Kit config's `operator`, or else the
 * repo's owner. A Dispatch check also reads workflow runs, through `actions`:
 * the Fabrik App has no Actions permission (ADR-0002), so that is the Dispatch
 * job's own read-only GITHUB_TOKEN.
 */
export async function gatherSnapshot(
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  actions: GitHub | null = null,
): Promise<Snapshot> {
  const [{ owner, kitIssues }, part] = await Promise.all([
    gatherKitIssues(github, repo),
    gatherEventPart(github, repo, event, operator, actions),
  ]);
  // A closed Ticket may be its Spec's last.
  const parent = event.kind === "issue-closed" ? (part?.issue?.parent ?? null) : null;
  const spec = parent === null ? null : await gatherSpec(github, repo, parent);
  // By default the Operator owns the Product repos they run Fabrik in.
  return part === null
    ? { issue: null, pullRequest: null, dispatch: null, spec, operator: operator ?? owner, kitIssues }
    : { ...part, spec, kitIssues };
}

// A Spec's Tickets and the merged PRs that closed each. A Spec with more than 100 Tickets is far past v1.
const SPEC_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        state
        subIssues(first: 100) {
          nodes {
            number
            state
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state } }
          }
        }
      }
    }
  }
`;

interface SpecQueryResult {
  repository: {
    issue: {
      number: number;
      state: "OPEN" | "CLOSED";
      subIssues: {
        nodes: {
          number: number;
          state: "OPEN" | "CLOSED";
          closedByPullRequestsReferences: { nodes: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] };
        }[];
      };
    } | null;
  };
}

async function gatherSpec(github: GitHub, repo: Repo, number: number): Promise<SpecSnapshot | null> {
  const data = await github.graphql<SpecQueryResult>(SPEC_QUERY, { owner: repo.owner, name: repo.name, number });
  const spec = data.repository.issue;
  if (spec === null) return null;
  return {
    number: spec.number,
    open: spec.state === "OPEN",
    tickets: spec.subIssues.nodes.map((ticket) => ({
      number: ticket.number,
      open: ticket.state === "OPEN",
      pullRequests: ticket.closedByPullRequestsReferences.nodes
        .filter((pr) => pr.state === "MERGED")
        .map((pr) => pr.number)
        .sort((a, b) => a - b),
    })),
  };
}

/** The part of the snapshot the event is about, or null for an event about the repo as a whole. */
async function gatherEventPart(
  github: GitHub,
  repo: Repo,
  event: LoopEvent,
  operator: string | null,
  actions: GitHub | null,
): Promise<EventPart | null> {
  switch (event.kind) {
    case "pull-request-pushed":
    case "pull-request-labeled":
    case "required-checks-finished":
    case "review-run-finished":
    case "pull-request-left-draft":
    case "pull-request-closed":
    case "pull-request-changes-requested":
      return gatherPullRequest(github, repo, event.pullRequest, operator);
    case "dispatch-check":
      if (actions === null) throw new Error("A Dispatch check needs a token that can read workflow runs");
      return gatherDispatch(github, actions, repo, operator);
    case "scheduled-tick":
      return null;
    case "implement-run-finished": {
      const ticket = await gatherIssue(github, repo, event.issue, operator);
      if (event.fixes === undefined) return ticket;
      // A retry's push job weighs the Ticket and the PR it fixes.
      const { pullRequest } = await gatherPullRequest(github, repo, event.fixes.pullRequest, operator);
      return { ...ticket, pullRequest };
    }
    case "label-added": {
      // agent:implement on a Ticket with an open PR resumes that PR's run, so the core weighs the PR too.
      const ticket = await gatherIssue(github, repo, event.issue, operator);
      const open = ticket.issue?.openPullRequests[0];
      if (open === undefined) return ticket;
      const { pullRequest } = await gatherPullRequest(github, repo, open, operator);
      return { ...ticket, pullRequest };
    }
    default:
      return gatherIssue(github, repo, event.issue, operator);
  }
}

type EventPart = Omit<Snapshot, "kitIssues" | "spec">;

const KIT_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $labels: [String!]!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      issues(states: OPEN, labels: $labels, first: 20, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes {
          number
          body
          labels(first: 100) { nodes { name } }
          comments(last: 100) { nodes { body } }
        }
      }
    }
  }
`;

interface KitIssuesQueryResult {
  repository: {
    owner: { login: string };
    issues: {
      nodes: { number: number; body: string; labels: { nodes: { name: string }[] }; comments: { nodes: { body: string }[] } }[];
    };
  };
}

/** The open issues carrying a Kit-owned label (src/loop/kitIssues.ts), which every event's snapshot holds. */
async function gatherKitIssues(github: GitHub, repo: Repo): Promise<{ owner: string; kitIssues: KitIssueSnapshot[] }> {
  const data = await github.graphql<KitIssuesQueryResult>(KIT_ISSUES_QUERY, {
    owner: repo.owner,
    name: repo.name,
    labels: KIT_ISSUE_LABELS,
  });
  return {
    owner: data.repository.owner.login,
    kitIssues: data.repository.issues.nodes.map((issue) => ({
      number: issue.number,
      labels: issue.labels.nodes.map((label) => label.name),
      body: issue.body,
      comments: issue.comments.nodes.map((comment) => comment.body),
    })),
  };
}

async function gatherIssue(github: GitHub, repo: Repo, number: number, operator: string | null): Promise<EventPart> {
  const data = await github.graphql<IssueQueryResult>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number });
  const issue = data.repository.issue;
  if (issue === null) {
    throw new Error(`Issue #${number} not found in ${repo.owner}/${repo.name}`);
  }
  return {
    issue: {
      number: issue.number,
      open: issue.state === "OPEN",
      author: issue.author?.login ?? "ghost",
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent?.number ?? null,
      openPullRequests: issue.closedByPullRequestsReferences.nodes.map((pr) => pr.number).sort((a, b) => a - b),
      ...designSessionOf(
        issue.comments.nodes.map((comment) => ({ body: comment.body, byBot: comment.author?.__typename === "Bot" })),
      ),
      emptyDiffs: countEmptyDiffs(issue.comments.nodes.map((comment) => comment.body)),
    },
    pullRequest: null,
    dispatch: null,
    // By default the Operator owns the Product repos they run Fabrik in.
    operator: operator ?? data.repository.owner.login,
  };
}

async function gatherPullRequest(
  github: GitHub,
  repo: Repo,
  number: number,
  operator: string | null,
): Promise<EventPart> {
  const data = await github.graphql<PullRequestQueryResult>(PULL_REQUEST_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number,
  });
  const pullRequest = data.repository.pullRequest;
  if (pullRequest === null) {
    throw new Error(`Pull request #${number} not found in ${repo.owner}/${repo.name}`);
  }
  const botComments = pullRequest.comments.nodes
    .filter((comment) => comment.author?.__typename === "Bot")
    .map((comment) => comment.body);
  return {
    issue: null,
    pullRequest: {
      number: pullRequest.number,
      isAgent: isAgentPullRequest({
        headRef: pullRequest.headRefName,
        authorIsBot: pullRequest.author?.__typename === "Bot",
      }),
      ticket: ticketOfAgentBranch(pullRequest.headRefName),
      open: pullRequest.state === "OPEN",
      draft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      labels: pullRequest.labels.nodes.map((label) => label.name),
      // Only a bot's markers count, so nobody can fake a Verdict or a Request-changes run by quoting one.
      verdicts: verdictsIn(botComments),
      requestChangesRun: requestChangesRunIn(botComments),
      changesRequested: changesRequestedOf(pullRequest.reviews.nodes[0]),
    },
    dispatch: null,
    operator: operator ?? data.repository.owner.login,
  };
}

function changesRequestedOf(
  review: NonNullable<PullRequestQueryResult["repository"]["pullRequest"]>["reviews"]["nodes"][number] | undefined,
): PullRequestSnapshot["changesRequested"] {
  if (review === undefined || review.author === null || review.commit === null) return null;
  return {
    review: review.databaseId,
    reviewer: review.author.login,
    reviewerIsBot: review.author.__typename === "Bot",
    commitSha: review.commit.oid,
  };
}

async function gatherDispatch(
  github: GitHub,
  actions: GitHub,
  repo: Repo,
  operator: string | null,
): Promise<EventPart> {
  const tickets: TicketSnapshot[] = [];
  let after: string | null = null;
  let page: DispatchQueryResult;
  do {
    page = await github.graphql<DispatchQueryResult>(DISPATCH_QUERY, {
      owner: repo.owner,
      name: repo.name,
      after,
      ready: READY_FOR_AGENT,
    });
    for (const issue of page.repository.issues.nodes) {
      tickets.push({
        number: issue.number,
        open: issue.state === "OPEN",
        labels: issue.labels.nodes.map((label) => label.name),
        openBlockers: issue.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.number),
        subIssues: issue.subIssues.totalCount,
        openLinkedPullRequests: issue.closedByPullRequestsReferences.nodes
          .filter((pr) => pr.state === "OPEN")
          .map((pr) => pr.number),
      });
    }
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null;
  } while (after !== null);

  const openAgentDraftPullRequests = page.repository.pullRequests.nodes.filter(
    (pr) => pr.isDraft && isAgentPullRequest({ headRef: pr.headRefName, authorIsBot: pr.author?.__typename === "Bot" }),
  ).length;

  return {
    issue: null,
    pullRequest: null,
    dispatch: {
      tickets,
      openAgentDraftPullRequests,
      implementRunsInProgress: await countImplementRunsInProgress(actions, repo),
    },
    operator: operator ?? page.repository.owner.login,
  };
}

/**
 * Implement jobs running now, across every workflow run in the repo. A queued
 * one isn't counted here: its Ticket still has agent:implement, which the core
 * counts instead.
 */
async function countImplementRunsInProgress(github: GitHub, repo: Repo): Promise<number> {
  const base = `/repos/${repo.owner}/${repo.name}/actions`;
  const runs = (await github.rest("GET", `${base}/runs?status=in_progress&per_page=100`)) as {
    workflow_runs: { id: number }[];
  };
  let count = 0;
  for (const run of runs.workflow_runs) {
    const jobs = (await github.rest("GET", `${base}/runs/${run.id}/jobs?filter=latest&per_page=100`)) as {
      jobs: { name: string; status: string }[];
    };
    count += jobs.jobs.filter(
      (job) =>
        job.status === "in_progress" &&
        (job.name === IMPLEMENT_JOB_NAME || job.name.endsWith(` / ${IMPLEMENT_JOB_NAME}`)),
    ).length;
  }
  return count;
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

/** Pushes an agent branch the push job holds (src/github/branch.ts). */
export interface BranchPusher {
  push(branch: string): Promise<void>;
}

/** Applies each action in the plan, in order. Only an Implement run's push job has a branch to push. */
export async function applyPlan(
  github: GitHub,
  repo: Repo,
  plan: Plan,
  branches: BranchPusher | null = null,
): Promise<void> {
  if (plan.kind !== "act") return;
  const created = new Map<string, CreatedRecord>();
  // The URL of each comment the plan has posted under a key, for later comments that link it.
  const posted = new Map<string, string>();
  for (const action of plan.actions) {
    await apply(github, repo, action, { created, posted }, branches);
  }
}

/** What earlier actions in the plan made, for later ones to refer to. */
interface Made {
  readonly created: Map<string, CreatedRecord>;
  readonly posted: Map<string, string>;
}

function postedIn(posted: ReadonlyMap<string, string>, { posted: key }: PostedComment): string {
  const url = posted.get(key);
  if (url === undefined) throw new Error(`The plan refers to a comment it hasn't posted: ${key}`);
  return url;
}

/** An issue a plan created: its number for links in text, its database id for sub-issue and blocked-by edges. */
interface CreatedRecord {
  readonly number: number;
  readonly id: number;
}

function createdIn(created: ReadonlyMap<string, CreatedRecord>, { created: key }: CreatedIssue): CreatedRecord {
  const record = created.get(key);
  if (record === undefined) throw new Error(`The plan refers to an issue it hasn't created: ${key}`);
  return record;
}

/** Creates the issue, then links it under its parent (made earlier in the plan, or existing) and to each blocker. */
async function createIssue(
  github: GitHub,
  repo: Repo,
  action: Extract<Action, { kind: "create-issue" }>,
  created: Map<string, CreatedRecord>,
): Promise<void> {
  const issues = `/repos/${repo.owner}/${repo.name}/issues`;
  const issue = (await github.rest("POST", issues, {
    title: action.title,
    body: action.body,
    labels: action.labels,
  })) as CreatedRecord;
  created.set(action.key, { number: issue.number, id: issue.id });
  if (action.parent !== null) {
    const parent = typeof action.parent === "number" ? action.parent : createdIn(created, action.parent).number;
    await github.rest("POST", `${issues}/${parent}/sub_issues`, { sub_issue_id: issue.id });
  }
  for (const blocker of action.blockedBy) {
    await github.rest("POST", `${issues}/${issue.number}/dependencies/blocked_by`, {
      issue_id: createdIn(created, blocker).id,
    });
  }
}

/** Whether the plan asks for a Dispatch check, which the Dispatch job then runs. */
export function wantsDispatchCheck(plan: Plan): boolean {
  return plan.kind === "act" && plan.actions.some((action) => action.kind === "check-dispatch");
}

async function apply(
  github: GitHub,
  repo: Repo,
  action: Action,
  made: Made,
  branches: BranchPusher | null,
): Promise<void> {
  const issues = `/repos/${repo.owner}/${repo.name}/issues`;
  switch (action.kind) {
    // Not a GitHub change: the push job hands it on to the Dispatch job.
    case "check-dispatch":
      return;
    case "create-issue":
      return createIssue(github, repo, action, made.created);
    case "close-pull-request":
      // Closing never deletes the head branch; only a merge with auto-delete on would.
      await github.rest("PATCH", `/repos/${repo.owner}/${repo.name}/pulls/${action.pullRequest}`, { state: "closed" });
      return;
    case "open-issue":
      // Labels go on with the issue, so the issues.opened run it starts already sees them.
      await github.rest("POST", issues, {
        title: action.title,
        body: action.body,
        labels: action.labels,
        assignees: action.assignees,
      });
      return;
    case "push-branch":
      if (branches === null) throw new Error(`This job holds no branch to push (${action.branch})`);
      await branches.push(action.branch);
      return;
    case "open-pull-request":
      await github.rest("POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
        title: action.title,
        head: action.head,
        base: action.base,
        body: action.body,
        draft: action.draft,
      });
      return;
    case "convert-to-draft": {
      // As with leaving draft, only GraphQL can do this, by the PR's node id.
      const pullRequest = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/pulls/${action.pullRequest}`)) as {
        node_id: string;
      };
      await github.graphql(
        "mutation ($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
        { id: pullRequest.node_id },
      );
      return;
    }
    case "mark-ready-for-review": {
      // REST can't take a PR out of draft; GraphQL can, by its node id.
      const pullRequest = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/pulls/${action.pullRequest}`)) as {
        node_id: string;
      };
      await github.graphql(
        "mutation ($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
        { id: pullRequest.node_id },
      );
      return;
    }
    case "request-review":
      await github.rest("POST", `/repos/${repo.owner}/${repo.name}/pulls/${action.pullRequest}/requested_reviewers`, {
        reviewers: [action.reviewer],
      });
      return;
    default:
      return applyToIssue(github, `${issues}/${action.issue}`, action, made);
  }
}

async function applyToIssue(
  github: GitHub,
  issue: string,
  action: Exclude<
    Action,
    {
      kind:
        | "check-dispatch"
        | "create-issue"
        | "open-issue"
        | "push-branch"
        | "open-pull-request"
        | "close-pull-request"
        | "convert-to-draft"
        | "mark-ready-for-review"
        | "request-review";
    }
  >,
  { created, posted }: Made,
): Promise<void> {
  switch (action.kind) {
    case "add-labels":
      if (action.labels.length > 0) await github.rest("POST", `${issue}/labels`, { labels: action.labels });
      return;
    case "remove-label":
      await github.rest("DELETE", `${issue}/labels/${encodeURIComponent(action.label)}`, undefined, {
        allowNotFound: true,
      });
      return;
    case "comment": {
      const comment = (await github.rest("POST", `${issue}/comments`, { body: action.body })) as { html_url: string };
      if (action.key !== undefined) posted.set(action.key, comment.html_url);
      return;
    }
    case "comment-linking": {
      const body = action.body.map((part) => (typeof part === "string" ? part : postedIn(posted, part))).join("");
      await github.rest("POST", `${issue}/comments`, { body });
      return;
    }
    case "assign":
      await github.rest("POST", `${issue}/assignees`, { assignees: [action.assignee] });
      return;
    case "close":
      await github.rest("PATCH", issue, { state: "closed", state_reason: action.reason });
      return;
    case "edit-issue-body":
      await github.rest("PATCH", issue, { body: action.body });
      return;
    case "close-as-superseded": {
      const body = action.comment
        .map((part) => (typeof part === "string" ? part : `#${createdIn(created, part).number}`))
        .join("");
      await github.rest("POST", `${issue}/comments`, { body });
      await github.rest("PATCH", issue, { state: "closed", state_reason: "completed" });
      return;
    }
    case "start-agent-run":
      // The workflow starts agent runs by routing to the role's agent job (src/kit/jobs.ts).
      return;
  }
}
