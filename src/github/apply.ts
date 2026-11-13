// The adapter's apply side: carries out the plan the core returns, one action
// at a time, as the token the job holds. It holds no Loop rules, only how
// GitHub carries them out: a trigger label left on is cycled so adding it
// fires its event (#417), since GitHub fires none for a label already on.
import { prototypePreviewUrl, previewUrl } from "../kit/config.ts";
import { replayResultsIn, withTicketFinished, withTicketStarted } from "../kit/replay.ts";
import { withDecisionLine } from "../loop/decisionsSoFar.ts";
import { carriedDigest, placedFilesIn } from "../loop/digestCarry.ts";
import type { DigestHead } from "../loop/digestPlaces.ts";
import { isTriggerLabel, type TriggerLabel } from "../loop/labels.ts";
import { prototypeBranchFor } from "../loop/designOutput.ts";
import { endedHeldLine, waitingHeldLineRole } from "../loop/heldLine.ts";
import { isEmptyDiffComment, withPrototypeStarted } from "../loop/markers.ts";
import type { Action, CreatedIssue, Plan, PostedComment } from "../loop/types.ts";
import type { MainRebase } from "./branch.ts";
import { allPages, type GitHub, GitHubError, gitHubMessageOf, type Repo } from "./client.ts";

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
 * (src/github/branch.ts, #304): whether that was clean, conflicted, found the
 * branch already holding that head or gone, and, when clean, its push.
 */
export interface MainRebaser {
  rebase(branch: string, onto: string): Promise<MainRebase>;
}

/**
 * Reads what a pull request's head holds of the files a Digest's places
 * name, and the pull request's files there (src/github/digestHead.ts), for a
 * Digest carried forward to that head. It rejects when they cannot be read.
 */
export interface DigestHeadReader {
  read(pullRequest: number, headSha: string, paths: readonly string[]): Promise<DigestHead>;
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

/** A trigger label left on the issue, which the adapter took off and put back on so GitHub fired its labeled event (#417). */
export interface ReaddedLabel {
  readonly issue: number;
  readonly label: TriggerLabel;
}

/**
 * An older Digest GitHub refused to collapse as outdated (ADR-0022), which
 * stopped nothing: the comment, and what GitHub said.
 */
export interface RefusedCollapse {
  readonly pullRequest: number;
  /** The comment's node id. */
  readonly node: string;
  readonly why: string;
}

/**
 * What the push job hands on from applying a plan: the preview deployment to
 * link, a UI PR's or a prototype round's, when the plan asked for one; and,
 * for the step summary, each trigger label it re-added and each older Digest
 * GitHub refused to collapse.
 */
export interface AppliedPlan {
  readonly preview: PreviewToLink | PrototypePreviewToLink | null;
  readonly readded: readonly ReaddedLabel[];
  readonly refusedCollapses: readonly RefusedCollapse[];
}

/** The Actions run applying a plan, by its id, and when it applies it, as an ISO 8601 time. */
export interface ApplyingRun {
  readonly id: number;
  readonly at: string;
}

/**
 * A replay claim another run won first: the Ticket isn't waiting to run any
 * more, so this run doesn't claim it. Under the claim job's concurrency queue
 * that's expected, and needs nothing of the Operator.
 */
export class ReplayTicketTaken extends Error {
  /** The replay Ticket, and the replay issue it's on. */
  readonly ticket: number;
  readonly issue: number;

  constructor(ticket: number, issue: number, run: number) {
    super(`#${ticket} isn't waiting to run on replay #${issue}, so run ${run} doesn't claim it`);
    this.name = "ReplayTicketTaken";
    this.ticket = ticket;
    this.issue = issue;
  }
}

/**
 * A plan applied only in part (#421): `failed` threw `cause`, after the
 * actions `applied` had landed, so those in `unapplied` never did. Each is
 * one of the plan's own actions: a failure inside a rebase onto main names
 * the rebase, and one inside a Digest carried forward names the carry.
 */
export class PlanNotApplied extends Error {
  readonly failed: Action;
  readonly applied: readonly Action[];
  readonly unapplied: readonly Action[];

  constructor(failed: Action, applied: readonly Action[], unapplied: readonly Action[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PlanNotApplied";
    this.failed = failed;
    this.applied = applied;
    this.unapplied = unapplied;
  }
}

/**
 * Applies each action in the plan, in order, and returns what the push job
 * hands on from it; throws a PlanNotApplied when an action fails. Only the
 * push job of an Implement run, a Researcher run or a prototype turn has a
 * branch to push. `run` is the Actions run applying it, which a replay
 * Ticket's claim marks it in progress in, from then. `rebaser` carries out a
 * rebase onto main, which a push to main's or the tick's plan may ask for.
 * `heads` reads what a head holds, which a pass's plan that carries the last
 * Digest forward asks for (ADR-0022).
 */
export async function applyPlan(
  github: GitHubApi,
  repo: Repo,
  plan: Plan,
  branches: BranchPusher | null = null,
  run: ApplyingRun | null = null,
  rebaser: MainRebaser | null = null,
  heads: DigestHeadReader | null = null,
): Promise<AppliedPlan> {
  if (plan.kind !== "act") return { preview: null, readded: [], refusedCollapses: [] };
  const made: Made = { created: new Map(), posted: new Map(), opened: null, preview: null, run, readded: [], refusedCollapses: [] };
  const applyEach = async (actions: readonly Action[]): Promise<void> => {
    for (const action of actions) {
      if (action.kind === "carry-digest") {
        if (heads === null) throw new Error(`This job can't read #${action.pullRequest}'s head to carry its Digest forward`);
        const { pullRequest, headSha, repoUrl } = action;
        // With the files unread at the new head no place could be re-pointed, so nothing is carried.
        const body = await heads.read(pullRequest, headSha, placedFilesIn(action.digest)).then(
          (head) => carriedDigest(action.digest, { repoUrl, pullRequest, headSha }, head),
          (error: unknown) => {
            console.log(`::warning title=Digest not carried::#${pullRequest} at ${headSha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          },
        );
        if (body === null) {
          await applyEach(action.otherwise);
          continue;
        }
        // The carried Digest first, then what follows any Digest's posting: the older ones collapsed and the gate opened.
        await apply(github, repo, { kind: "comment", issue: pullRequest, body }, made, branches);
        await applyEach(action.carried);
        continue;
      }
      if (action.kind !== "rebase-onto-main") {
        await apply(github, repo, action, made, branches);
        continue;
      }
      if (rebaser === null) throw new Error(`This job can't rebase ${action.branch} onto main`);
      const rebased = await rebaser.rebase(action.branch, action.onto);
      // Neither is the core's to act on: there's nothing to bring up to date.
      if (rebased.outcome === "up-to-date" || rebased.outcome === "gone") continue;
      if (rebased.outcome === "conflicted") {
        await applyEach(action.conflicted);
        continue;
      }
      // The clean actions land first: the PR is in draft before the push starts its Review.
      await applyEach(action.clean);
      const pushed = await rebased.push().then(
        () => true,
        (error: unknown) => {
          console.log(`::warning title=Rebase not pushed::${action.branch}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        },
      );
      await applyEach(pushed ? action.pushed : action.refused);
    }
  };
  for (const [i, action] of plan.actions.entries()) {
    try {
      await applyEach([action]);
    } catch (error) {
      throw new PlanNotApplied(action, plan.actions.slice(0, i), plan.actions.slice(i + 1), error);
    }
  }
  return { preview: made.preview, readded: made.readded, refusedCollapses: made.refusedCollapses };
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
  /** Each trigger label the plan re-added, having found it already on. */
  readonly readded: ReaddedLabel[];
  /** Each older Digest GitHub refused to collapse. */
  readonly refusedCollapses: RefusedCollapse[];
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

/**
 * Whether the plan lands an Implement run whose branch changed nothing, an
 * empty diff, which the push job's Run record then says: the plan's comment
 * marked as one, as later runs count it.
 */
export function emptyDiffIn(plan: Plan): boolean {
  return plan.kind === "act" && plan.actions.some((action) => action.kind === "comment" && isEmptyDiffComment(action.body));
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
    case "open-issue": {
      // Labels go on with the issue, so the issues.opened run it starts already sees them.
      const opened = (await github.rest("POST", issues, {
        title: action.title,
        body: action.body,
        labels: action.labels,
        assignees: action.assignees,
      })) as CreatedRecord;
      if (action.key !== undefined) made.created.set(action.key, { number: opened.number, id: opened.id });
      return;
    }
    // applyPlan carries it out, since what follows it depends on how the rebase went.
    case "rebase-onto-main":
      throw new Error("A rebase onto main is applied by applyPlan");
    case "carry-digest":
      throw new Error("A Digest is carried forward by applyPlan");
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
      return requestReview(github, repo, action);
    case "react":
      return react(github, repo, action);
    case "end-held-line":
      return endHeldLine(github, repo, action, made.run?.at ?? new Date().toISOString());
    case "minimize-comment": {
      // Only GraphQL can collapse a comment, by its node id. A refusal is the step summary's to say and stops
      // nothing: the calls after it are still made and the gate still opens, since the current Digest is found by its head.
      const refused = await github
        .graphql("mutation ($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $classifier }) { clientMutationId } }", {
          id: action.node,
          classifier: action.classifier,
        })
        .then(
          () => null,
          (error: unknown) => (error instanceof GitHubError ? gitHubMessageOf(error) : error instanceof Error ? error.message : String(error)),
        );
      if (refused !== null) made.refusedCollapses.push({ pullRequest: action.pullRequest, node: action.node, why: refused });
      return;
    }
    default:
      return applyToIssue(github, `${issues}/${action.issue}`, action, made);
  }
}

/**
 * Requests the reviewer's review on the PR. GitHub can record a request it
 * answers with a 422 (#551), so on a 422 the PR is read fresh: with the
 * reviewer among its requested reviewers, or with their review already on
 * it, the request counts as applied.
 * Otherwise, or when that read fails, the 422 is what fails.
 */
async function requestReview(github: GitHubApi, repo: Repo, action: Extract<Action, { kind: "request-review" }>): Promise<void> {
  const pulls = `/repos/${repo.owner}/${repo.name}/pulls/${action.pullRequest}`;
  try {
    await github.rest("POST", `${pulls}/requested_reviewers`, { reviewers: [action.reviewer] });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    const recorded = await hasReviewer(github, pulls, action.reviewer).catch(() => false);
    if (!recorded) throw error;
  }
}

/**
 * Whether the PR at `pulls` has `reviewer` among its requested reviewers, or
 * has a review they already submitted, which takes them off that list.
 */
async function hasReviewer(github: GitHubApi, pulls: string, reviewer: string): Promise<boolean> {
  const pullRequest = (await github.rest("GET", pulls)) as { requested_reviewers: readonly { login: string }[] };
  if (pullRequest.requested_reviewers.some(({ login }) => login === reviewer)) return true;
  const reviews = await allPages<{ user: { login: string } | null }>(github, `${pulls}/reviews`);
  return reviews.some(({ user }) => user?.login === reviewer);
}

/**
 * Edits each held line of the action's role still waiting on its issue or PR
 * to say its hold ended (#471). Read fresh, and only a bot's, as this job
 * doesn't know the App's login: one the Operator deleted leaves nothing to
 * edit, which fails nothing.
 */
async function endHeldLine(
  github: GitHubApi,
  repo: Repo,
  action: Extract<Action, { kind: "end-held-line" }>,
  at: string,
): Promise<void> {
  const base = `/repos/${repo.owner}/${repo.name}/issues`;
  const comments = await allPages<{ id: number; body: string | null; user: { type: string } | null }>(github, `${base}/${action.issue}/comments`);
  const body = endedHeldLine(action.role, action.on, action.ended, at, action.timeZone);
  for (const comment of comments) {
    if (comment.user?.type !== "Bot" || waitingHeldLineRole(comment.body ?? "") !== action.role) continue;
    await github.rest("PATCH", `${base}/comments/${comment.id}`, { body });
  }
}

/**
 * Reacts to a conversation comment, or to a review: to the review itself when
 * it has a body, which only GraphQL can do, by its node id, and to each of its
 * inline comments on every page.
 */
async function react(github: GitHubApi, repo: Repo, action: Extract<Action, { kind: "react" }>): Promise<void> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const body = { content: action.content };
  if (action.on.kind === "conversation") {
    await github.rest("POST", `${base}/issues/comments/${action.on.comment}/reactions`, body);
    return;
  }
  if (action.on.hasBody) {
    await github.graphql(
      "mutation ($id: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $id, content: $content }) { clientMutationId } }",
      { id: action.on.node, content: action.content.toUpperCase() },
    );
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

/**
 * How long a trigger label stays on before it counts as left behind: well past
 * the time a run's start takes to take it off (the claim job, or the role's
 * own job), so one this old started nothing and won't (#417).
 */
const STALE_TRIGGER_MS = 10 * 60 * 1000;

/** When `label` was last added to the issue, as a time in ms, or null when GitHub lists no such event. */
async function lastAdded(github: GitHubApi, issue: string, label: TriggerLabel): Promise<number | null> {
  let last: number | null = null;
  // Oldest first, so the last match on the last page is the latest.
  for (let page = 1; ; page++) {
    const events = (await github.rest("GET", `${issue}/events?per_page=100&page=${page}`)) as {
      event: string;
      label?: { name: string };
      created_at: string;
    }[];
    for (const event of events) {
      if (event.event === "labeled" && event.label?.name === label) last = Date.parse(event.created_at);
    }
    if (events.length < 100) return last;
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
        | "react"
        | "end-held-line"
        | "minimize-comment";
    }
  >,
  made: Made,
): Promise<void> {
  const { created, posted } = made;
  switch (action.kind) {
    case "add-labels": {
      if (action.labels.length === 0) return;
      // GitHub fires `labeled` only for a label newly added, so a trigger label
      // left on (a failed claim left it) is taken off first, or adding it would
      // start nothing (#417). Read fresh: another job may have taken it off
      // since the plan was made.
      const triggers = action.labels.filter(isTriggerLabel);
      if (triggers.length > 0) {
        const on = (await github.rest("GET", `${issue}/labels?per_page=100`)) as { name: string }[];
        const now = Date.parse(made.run?.at ?? new Date().toISOString());
        for (const label of triggers.filter((trigger) => on.some(({ name }) => name === trigger))) {
          // One added lately is its run still starting, which takes it off: a second event would start a second run.
          const added = await lastAdded(github, issue, label);
          if (added !== null && now - added < STALE_TRIGGER_MS) continue;
          await github.rest("DELETE", `${issue}/labels/${encodeURIComponent(label)}`, undefined, { allowNotFound: true });
          made.readded.push({ issue: action.issue, label });
        }
      }
      await github.rest("POST", `${issue}/labels`, { labels: action.labels });
      return;
    }
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
    case "reopen":
      // The issue's own endpoint, which a close writes too: Issues: write, and nothing the Fabrik App doesn't hold.
      await github.rest("PATCH", issue, { state: "open" });
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
      if (marked === null) throw new ReplayTicketTaken(action.ticket, action.issue, made.run.id);
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
