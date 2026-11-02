// The adapter's apply side: carries out the plan the core returns, one action
// at a time, as the token the job holds. It holds no Loop rules.
import type { Action, CreatedIssue, Plan, PostedComment } from "../loop/types.ts";
import type { GitHub, Repo } from "./client.ts";

/** The agent run a plan starts, which the workflow carries out by routing to that role's agent job. */
export function agentRunIn(plan: Plan): Extract<Action, { kind: "start-agent-run" }> | null {
  if (plan.kind !== "act") return null;
  return (
    plan.actions.find(
      (action): action is Extract<Action, { kind: "start-agent-run" }> => action.kind === "start-agent-run",
    ) ?? null
  );
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
