// The adapter's apply side: carries out the plan the core returns, one action
// at a time, as the token the job holds. It holds no Loop rules.
import { prototypePreviewUrl, previewUrl } from "../kit/config.ts";
import { replayResultsIn, withTicketFinished, withTicketStarted } from "../kit/replay.ts";
import { withDecisionLine } from "../loop/decisionsSoFar.ts";
import { prototypeBranchFor } from "../loop/designOutput.ts";
import { withPrototypeStarted } from "../loop/markers.ts";
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


/** The replay Ticket's two arms a plan starts, which the workflow carries out by routing to `replay`. */
export function replayRunIn(plan: Plan): Extract<Action, { kind: "start-replay" }> | null {
  if (plan.kind !== "act") return null;
  return plan.actions.find((action): action is Extract<Action, { kind: "start-replay" }> => action.kind === "start-replay") ?? null;
}

/** The calls applying a plan makes, which a test can fake. */
type GitHubApi = Pick<GitHub, "rest" | "graphql">;

/** Pushes an agent branch the push job holds (src/github/branch.ts). */
export interface BranchPusher {
  /** The commit its push leaves the branch at, or null when it has nothing to push. */
  readonly head: string | null;
  push(branch: string): Promise<void>;
}

/**
 * Rebases an agent PR's branch onto the default branch's head, with no agent
 * (src/github/branch.ts, #304): whether that was clean, conflicted, or found
 * the branch already holding that head, and, when clean, its push.
 */
export interface MainRebaser {
  rebase(branch: string, onto: string): Promise<{ readonly outcome: "rebased" | "conflicted" | "up-to-date"; push(): Promise<void> }>;
}

/** A UI PR's preview deployment, which the push job's preview step polls and links (src/kit/previewLink.ts). */
export interface PreviewToLink {
  readonly pullRequest: number;
  /** Kit config's `preview.url`, filled in for the PR as the plan's push left it. */
  readonly url: string;
}

/** A prototype round's preview, which the push job's prototype preview step polls and links beside each variant (src/kit/previewLink.ts). */
export interface PrototypePreviewToLink {
  /** The round's comment id. */
  readonly round: number;
  /** Kit config's `preview.url`, filled in for the prototype branch as the plan's push left it, at the route its variants render on. */
  readonly url: string;
}

/** What the push job hands on from applying a plan: the preview deployment to link, a UI PR's or a prototype round's, when the plan asked for one. */
export interface AppliedPlan {
  readonly preview: PreviewToLink | PrototypePreviewToLink | null;
}

/** The Actions run applying a plan, by its id, and when it applies it, as an ISO 8601 time. */
export interface ApplyingRun {
  readonly id: number;
  readonly at: string;
}

/**
 * Applies each action in the plan, in order, and returns what the push job
 * hands on from it. Only the push job of an Implement run, a Researcher run or
 * a prototype turn has a branch to push. `run` is the Actions run applying
 * it, which a replay Ticket's claim marks it in progress in, from then.
 * `rebaser` carries out a rebase onto main, which a push to main's or the
 * tick's plan may ask for.
 */
export async function applyPlan(
  github: GitHubApi,
  repo: Repo,
  plan: Plan,
  branches: BranchPusher | null = null,
  run: ApplyingRun | null = null,
  rebaser: MainRebaser | null = null,
): Promise<AppliedPlan> {
  if (plan.kind !== "act") return { preview: null };
  const made: Made = { created: new Map(), posted: new Map(), opened: null, preview: null, run };
  const applyEach = async (actions: readonly Action[]): Promise<void> => {
    for (const action of actions) {
      if (action.kind !== "rebase-onto-main") {
        await apply(github, repo, action, made, branches);
        continue;
      }
      if (rebaser === null) throw new Error(`This job can't rebase ${action.branch} onto main`);
      const rebased = await rebaser.rebase(action.branch, action.onto);
      if (rebased.outcome === "up-to-date") continue;
      // The clean actions land first: the PR is in draft before the push starts its Review.
      await applyEach(rebased.outcome === "rebased" ? action.clean : action.conflicted);
      if (rebased.outcome === "rebased") await rebased.push();
    }
  };
  await applyEach(plan.actions);
  return { preview: made.preview };
}

/** What earlier actions in the plan made, for later ones to refer to. */
interface Made {
  readonly created: Map<string, CreatedRecord>;
  /** Each comment the plan has posted under a key, for later comments that link it and a prototype round's preview. */
  readonly posted: Map<string, PostedRecord>;
  /** The number of the PR the plan opened, for a preview to link on it. */
  opened: number | null;
  preview: PreviewToLink | PrototypePreviewToLink | null;
  /** The Actions run applying the plan, or null when the job names none. */
  readonly run: ApplyingRun | null;
}

/** A comment a plan posted: its URL for links in text, its id for an edit. */
interface PostedRecord {
  readonly url: string;
  readonly id: number;
}

function postedIn(posted: ReadonlyMap<string, PostedRecord>, { posted: key }: PostedComment): PostedRecord {
  const comment = posted.get(key);
  if (comment === undefined) throw new Error(`The plan refers to a comment it hasn't posted: ${key}`);
  return comment;
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

/** An issue's database id, which a blocked-by edge takes: made earlier in the plan, or read from GitHub. */
async function databaseId(
  github: GitHubApi,
  repo: Repo,
  issue: CreatedIssue | number,
  created: ReadonlyMap<string, CreatedRecord>,
): Promise<number> {
  if (typeof issue !== "number") return createdIn(created, issue).id;
  const existing = (await github.rest("GET", `/repos/${repo.owner}/${repo.name}/issues/${issue}`)) as CreatedRecord;
  return existing.id;
}

/** Creates the issue, then links it under its parent and to each blocker, each made earlier in the plan or existing. */
async function createIssue(
  github: GitHubApi,
  repo: Repo,
  action: Extract<Action, { kind: "create-issue" }>,
  created: Map<string, CreatedRecord>,
): Promise<void> {
  const issues = `/repos/${repo.owner}/${repo.name}/issues`;
  const issue = (await github.rest("POST", issues, {
    title: action.title,
    body: action.body,
    labels: action.labels,
    // Assigned as it's created, so the assignment is its one notification.
    ...(action.assignees === undefined ? {} : { assignees: action.assignees }),
  })) as CreatedRecord;
  created.set(action.key, { number: issue.number, id: issue.id });
  if (action.parent !== null) {
    const parent = typeof action.parent === "number" ? action.parent : createdIn(created, action.parent).number;
    await github.rest("POST", `${issues}/${parent}/sub_issues`, { sub_issue_id: issue.id });
  }
  for (const blocker of action.blockedBy) {
    await addBlockedBy(github, repo, issue.number, blocker, created);
  }
}

/** Makes `issue` wait on `blocker` by a native blocked-by edge. */
async function addBlockedBy(
  github: GitHubApi,
  repo: Repo,
  issue: number,
  blocker: CreatedIssue | number,
  created: ReadonlyMap<string, CreatedRecord>,
): Promise<void> {
  await github.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${issue}/dependencies/blocked_by`, {
    issue_id: await databaseId(github, repo, blocker, created),
  });
}

/** Whether the plan asks for a Dispatch check, which the Dispatch job then runs. */
export function wantsDispatchCheck(plan: Plan): boolean {
  return plan.kind === "act" && plan.actions.some((action) => action.kind === "check-dispatch");
}

/** The replay Ticket the plan's claim marks in progress, which the replay jobs then run, or null when it claims none. */
export function replayClaimIn(plan: Plan): number | null {
  const mark = plan.kind === "act" ? plan.actions.find((action) => action.kind === "mark-replay-started") : undefined;
  return mark?.kind === "mark-replay-started" ? mark.ticket : null;
}

/** Whether the plan asks for a Design queue check, which the Design queue job then runs. */
export function wantsDesignQueueCheck(plan: Plan): boolean {
  return plan.kind === "act" && plan.actions.some((action) => action.kind === "check-design-queue");
}

async function apply(
  github: GitHubApi,
  repo: Repo,
  action: Action,
  made: Made,
  branches: BranchPusher | null,
): Promise<void> {
  const issues = `/repos/${repo.owner}/${repo.name}/issues`;
  switch (action.kind) {
    // Not a GitHub change: the push job hands it on to the Dispatch job.
    case "check-dispatch":
    // Nor this: the push job hands it on to the Design queue job.
    case "check-design-queue":
      return;
    // Nor this: the push job hands it on to its preview step, filled in for the PR as the push left it.
    case "link-preview": {
      const pullRequest = action.pullRequest ?? made.opened;
      if (pullRequest === null) throw new Error("The plan links the preview of a PR it hasn't opened");
      const headSha = branches?.head ?? null;
      if (headSha === null) throw new Error(`This job pushed no ${action.branch}, so it has no head to link a preview of`);
      made.preview = { pullRequest, url: previewUrl(action.template, { number: pullRequest, branch: action.branch, headSha }) };
      return;
    }
    // Nor this: the push job hands it on to its prototype preview step, filled in for the branch as the push left it.
    case "link-prototype-preview": {
      const round = postedIn(made.posted, action.round).id;
      const branch = prototypeBranchFor(action.issue);
      const headSha = branches?.head ?? null;
      if (headSha === null) throw new Error(`This job pushed no ${branch}, so it has no head to link a preview of`);
      made.preview = { round, url: prototypePreviewUrl(action.template, { branch, headSha, route: action.route }) };
      return;
    }
    case "create-issue":
      return createIssue(github, repo, action, made.created);
    case "add-blocked-by":
      return addBlockedBy(github, repo, action.issue, action.blocker, made.created);
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
    // applyPlan carries it out, since what follows it depends on how the rebase went.
    case "rebase-onto-main":
      throw new Error("A rebase onto main is applied by applyPlan");
    case "push-branch":
      if (branches === null) throw new Error(`This job holds no branch to push (${action.branch})`);
      await branches.push(action.branch);
      return;
    case "mark-prototype-request": {
      // Read fresh, so the edit changes only the one line the mark is.
      const path = `/repos/${repo.owner}/${repo.name}/issues/comments/${action.comment}`;
      const { body } = (await github.rest("GET", path)) as { body: string };
      const marked = withPrototypeStarted(body, action.started);
      if (marked !== body) await github.rest("PATCH", path, { body: marked });
      return;
    }
    case "push-prototype-branch": {
      // Only ever the issue's own prototype branch, which the branch the push job holds fast-forwards (src/github/branch.ts).
      const branch = prototypeBranchFor(action.issue);
      if (branches === null) throw new Error(`This job holds no branch to push (${branch})`);
      await branches.push(branch);
      return;
    }
    case "open-pull-request": {
      const opened = (await github.rest("POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
        title: action.title,
        head: action.head,
        base: action.base,
        body: action.body,
        draft: action.draft,
      })) as { number: number };
      made.opened = opened.number;
      return;
    }
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
    case "react":
      return react(github, repo, action);
    default:
      return applyToIssue(github, `${issues}/${action.issue}`, action, made);
  }
}

/**
 * Reacts to a conversation comment, or to each inline comment of a review on
 * every page: GitHub takes no reaction on the review itself.
 */
async function react(github: GitHubApi, repo: Repo, action: Extract<Action, { kind: "react" }>): Promise<void> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const body = { content: action.content };
  if (action.on.kind === "conversation") {
    await github.rest("POST", `${base}/issues/comments/${action.on.comment}/reactions`, body);
    return;
  }
  const reviewComments = `${base}/pulls/${action.pullRequest}/reviews/${action.on.review}/comments`;
  for (let page = 1; ; page++) {
    const comments = (await github.rest("GET", `${reviewComments}?per_page=100&page=${page}`)) as { id: number }[];
    for (const comment of comments) {
      await github.rest("POST", `${base}/pulls/comments/${comment.id}/reactions`, body);
    }
    if (comments.length < 100) return;
  }
}

async function applyToIssue(
  github: GitHubApi,
  issue: string,
  action: Exclude<
    Action,
    {
      kind:
        | "check-dispatch"
        | "check-design-queue"
        | "link-preview"
        | "link-prototype-preview"
        | "create-issue"
        | "add-blocked-by"
        | "open-issue"
        | "push-branch"
        | "push-prototype-branch"
        | "open-pull-request"
        | "close-pull-request"
        | "convert-to-draft"
        | "mark-ready-for-review"
        | "request-review"
        | "react";
    }
  >,
  made: Made,
): Promise<void> {
  const { created, posted } = made;
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
      const comment = (await github.rest("POST", `${issue}/comments`, { body: action.body })) as { html_url: string; id: number };
      if (action.key !== undefined) posted.set(action.key, { url: comment.html_url, id: comment.id });
      return;
    }
    case "comment-linking": {
      const body = action.body
        .map((part) => {
          if (typeof part === "string") return part;
          return "posted" in part ? postedIn(posted, part).url : `#${createdIn(created, part).number}`;
        })
        .join("");
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
    case "append-to-decisions-so-far": {
      // Read right before the write, so what the Operator edited after the plan was made stays.
      const line = action.line.map((part) => (typeof part === "string" ? part : postedIn(posted, part).url)).join("");
      const map = (await github.rest("GET", issue)) as { body: string | null };
      await github.rest("PATCH", issue, { body: withDecisionLine(map.body ?? "", line) });
      return;
    }
    case "close-as-superseded": {
      const body = action.comment
        .map((part) => (typeof part === "string" ? part : `#${createdIn(created, part).number}`))
        .join("");
      await github.rest("POST", `${issue}/comments`, { body });
      await github.rest("PATCH", issue, { state: "closed", state_reason: "completed" });
      return;
    }
    case "start-agent-run":
    case "start-replay":
      // The workflow starts agent runs, and a Replay Ticket's arms, by routing to their jobs (src/kit/jobs.ts).
      return;
    case "mark-replay-started": {
      if (made.run === null) throw new Error(`This job names no Actions run to mark #${action.ticket} in progress in`);
      // Read fresh, so a run that claimed the Ticket since the plan was made keeps it.
      const { body } = (await github.rest("GET", issue)) as { body: string | null };
      const marked = withTicketStarted(body ?? "", action.ticket, made.run.id, made.run.at);
      if (marked === null) {
        throw new Error(`#${action.ticket} isn't waiting to run on replay #${action.issue}, so run ${made.run.id} doesn't claim it`);
      }
      await github.rest("PATCH", issue, { body: marked });
      return;
    }
    case "release-replay-ticket": {
      // Read fresh, so a run that landed since the tick read the body keeps what it landed.
      const { body } = (await github.rest("GET", issue)) as { body: string | null };
      const before = body ?? "";
      const released = withTicketFinished(before, action.ticket, action.run, { kind: "infrastructure", reason: action.reason });
      if (released === null) return;
      await github.rest("PATCH", issue, { body: released });
      if (replayResultsIn(released) && !replayResultsIn(before)) await github.rest("POST", `${issue}/comments`, { body: action.resultsReady });
      return;
    }
    case "hold-agent-run":
      // Nor is a hold a GitHub change: the Plan's label and comment actions carry it out.
      return;
    case "drop-held-run":
      // Nor is dropping a held run: the step summary names it.
      return;
  }
}
