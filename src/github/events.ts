// The adapter's event side: turns an Actions event, or what an agent job
// passed out to its push job, into the Loop event it stands for.
// It holds no Loop rules; those all live in src/loop/rules.ts.
import type { AgentRunResult, BuiltBranch } from "../agent/result.ts";
import { splitWorkflowRef } from "../kit/caller.ts";
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import { FULL_SHA } from "../skills/lock.ts";
import type { CaptureOutputs, PlannedKeptBranchStart } from "../kit/pushJob.ts";
import { type EvidenceBundle, retroEvidenceOf } from "../kit/retroEvidence.ts";
import type { DigestGiven } from "../loop/digestContract.ts";
import type { PrototypeRequestMarker } from "../loop/markers.ts";
import type {
  AgentRole,
  BranchChanges,
  FailureReport,
  GivenOperatorComment,
  ImplementEvidence,
  LoopEvent,
  RerunReport,
  PullRequestCommentPlace,
} from "../loop/types.ts";

/**
 * Maps an Actions event to the Loop event it stands for, or null if the Loop
 * ignores it. `kitRef` is the Kit workflow ref the run was called at, such as
 * `jrey8343/fabrik/.github/workflows/schedule.yml@v1.1.0`, when the job passes it.
 */
export function loopEventFrom(
  eventName: string,
  payload: Record<string, unknown>,
  now: Date = new Date(),
  kitRef = "",
): LoopEvent | null {
  // The scheduled Kit workflow (schedule.yml), for the Loop's time-based rules.
  if (eventName === "schedule") {
    const release = splitWorkflowRef(kitRef)?.ref ?? "";
    return { kind: "scheduled-tick", now: now.toISOString(), ...(release === "" ? {} : { release }) };
  }
  // The caller workflow's push trigger: only a push to the default branch counts.
  if (eventName === "push") return defaultBranchPushed(payload);
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
    const comment = payload["comment"] as { id: number; user: { login: string; type: string }; body?: string | null };
    // A comment on a PR is not a reply on an issue.
    if (issue.pull_request !== undefined) {
      return pullRequestCommented(issue.number, comment.user, { kind: "conversation", comment: comment.id });
    }
    return {
      kind: "issue-comment-created",
      issue: issue.number,
      commenter: comment.user.login,
      commenterIsBot: comment.user.type === "Bot",
      body: comment.body ?? "",
      comment: comment.id,
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
    // Whether it merged, and who closed it, say whether an agent PR was closed by hand (#428).
    if (payload["action"] === "closed") {
      const merged = (payload["pull_request"] as { merged?: boolean }).merged === true;
      const sender = payload["sender"] as { type: string } | undefined;
      return { kind: "pull-request-closed", pullRequest, merged, closedByBot: sender?.type === "Bot" };
    }
  }
  // There is no _target form of this event, so the run uses the PR's merge
  // commit's caller workflow and Kit config. An agent PR can't change either:
  // both are trust roots its push job refuses (ADR-0005).
  if (eventName === "pull_request_review" && payload["action"] === "submitted") {
    const review = payload["review"] as {
      id: number;
      node_id: string;
      state: string;
      body: string | null;
      user: { login: string; type: string };
    };
    const pullRequest = (payload["pull_request"] as { number: number }).number;
    const state = review.state.toLowerCase();
    // A Comment or Approve review, which a lone inline comment or a thread reply also submits.
    if (state === "commented" || state === "approved") {
      const hasBody = (review.body ?? "").trim() !== "";
      return pullRequestCommented(pullRequest, review.user, { kind: "review", review: review.id, node: review.node_id, hasBody });
    }
    if (state !== "changes_requested") return null;
    return {
      kind: "pull-request-changes-requested",
      pullRequest,
      review: review.id,
      reviewer: review.user.login,
      reviewerIsBot: review.user.type === "Bot",
    };
  }
  return null;
}

/**
 * A comment on a PR, or null when a bot wrote it: the Fabrik App's own
 * Verdicts and fix comments would otherwise each start a Kit job that plans
 * nothing (only the Operator's comments are acknowledged, ADR-0007).
 */
function pullRequestCommented(
  pullRequest: number,
  user: { readonly login: string; readonly type: string },
  on: PullRequestCommentPlace,
): LoopEvent | null {
  if (user.type === "Bot") return null;
  return { kind: "pull-request-commented", pullRequest, commenter: user.login, commenterIsBot: false, on };
}

/**
 * A push to the default branch, or null for any other push. Whatever it
 * touches, main moved, so an agent PR may now conflict with it (#304). One
 * that added, changed or removed .fabrik/config.json, whose Kit config the
 * Loop reads (removing it restores the defaults), is a Kit config change,
 * which the core treats as main moving too. So is one whose `commits` can't
 * show it left the Kit config alone (#307): the file lists aren't always there,
 * and an extra Dispatch and Design queue check costs less than a skipped one.
 * A push deleting the branch leaves no head to bring a PR up to date with.
 */
function defaultBranchPushed(payload: Record<string, unknown>): LoopEvent | null {
  const defaultBranch = (payload["repository"] as { default_branch: string }).default_branch;
  if (payload["ref"] !== `refs/heads/${defaultBranch}` || payload["deleted"] === true) return null;
  const head = payload["after"];
  if (typeof head !== "string" || !FULL_SHA.test(head)) return null;
  const commits = payload["commits"];
  const mayHaveChanged = !Array.isArray(commits) || commits.length === 0 || commits.some(mayChangeKitConfig);
  return { kind: mayHaveChanged ? "kit-config-changed" : "main-pushed", head };
}

/** Whether a push's commit changed the Kit config, or lacks the file lists that would show it didn't. */
function mayChangeKitConfig(commit: { added?: unknown; modified?: unknown; removed?: unknown } | null): boolean {
  const lists = [commit?.added, commit?.modified, commit?.removed];
  return !lists.every(Array.isArray) || lists.flat().includes(KIT_CONFIG_PATH);
}

/**
 * What an Implement run's push job knows of its UI evidence: what the
 * Implement job passed out, and the push job's own Actions run, which the
 * Implement job shared, in the Product repo at `repoUrl`.
 */
export interface PushJobEvidence extends CaptureOutputs {
  readonly run: number;
  readonly repoUrl: string;
}

/**
 * Turns the result an agent job passed out as an artifact (src/agent/result.ts)
 * into the Loop event its push job applies. `startedBy` is the Operator's
 * reply that started a Design-session turn, which the push job reads from its
 * own Actions event, never from the agent's result; `evidence` is an
 * Implement run's UI evidence, which the push job always passes.
 */
export function agentRunEventFrom(
  result: AgentRunResult,
  changes: BranchChanges | null = null,
  retry: {
    readonly pullRequest: number;
    readonly runUrl: string;
    readonly review?: number;
    readonly retry?: number;
    readonly retryFlaw?: string;
    readonly conflict?: string;
  } | null = null,
  startedBy: number | null = null,
  evidence: PushJobEvidence | null = null,
  runUrl: string | null = null,
  keptBranch: PlannedKeptBranchStart | null = null,
): LoopEvent {
  if (result.role === "review") throw new Error("A Reviewer's result is applied through reviewEventFrom");
  if (result.role === "audit") throw new Error("An Auditor's result is applied through auditEventFrom");
  if (result.role === "retro") throw new Error("A Retro's result is applied through retroEventFrom");
  if (result.role === "research") throw new Error("A Researcher's result is applied through researchEventFrom");
  if (result.role === "digest") throw new Error("A Digest writer's result is applied through digestEventFrom");
  if (result.role !== "implement") {
    const finished = {
      kind: "agent-run-finished",
      role: result.role,
      issue: result.issue,
      output: result.output,
      ...givenTo(result),
    } as const;
    return result.role === "design" && startedBy !== null ? { ...finished, startedBy } : finished;
  }
  if (result.branch === undefined || changes === null) {
    throw new Error("An Implement run's result needs the branch it built and the paths that branch changes");
  }
  if (runUrl === null) throw new Error("An Implement run's event needs its push job's run, which an empty diff's comment links to");
  return {
    kind: "implement-run-finished",
    issue: result.issue,
    output: result.output,
    branch: result.branch.name,
    // A Kept-branch start built on its own branch, but opens its PR against the default branch the Kit job named (#536).
    base: keptBranch?.base ?? result.branch.base.ref,
    changes,
    runUrl,
    ...(keptBranch === null ? {} : { keptBranch: { pullRequest: keptBranch.pullRequest } }),
    // A branch with no commits has no head of its own, but changes nothing, so its evidence reaches no PR.
    ...(evidence === null ? {} : { evidence: implementEvidence(evidence, result.branch.head ?? result.branch.base.sha) }),
    // A retry's branch starts at the PR head it built on, which the core checks is still the PR's.
    ...(retry === null
      ? {}
      : {
          fixes: {
            ...retry,
            headSha: result.branch.base.sha,
            ...givenTo(result),
          },
        }),
  };
}

/**
 * Refuses an Implement run whose branch isn't built where the Kit job's plan
 * started it: a retry, or a Kept-branch start (#536), carries on the Ticket's
 * agent branch, and any other first run cuts it from the default branch. The
 * agent job writes the branch it built, so a first run that claims its own
 * branch as its base without that plan is never landed as one that carried on.
 */
export function checkBuiltAsPlanned(
  ticket: number,
  built: BuiltBranch,
  retry: { readonly pullRequest: number } | null,
  keptBranch: PlannedKeptBranchStart | null,
): void {
  const onItsOwn = built.base.ref === built.name;
  if (retry !== null) {
    if (!onItsOwn) throw new Error(`The retry on #${retry.pullRequest} didn't build on ${built.name}`);
    return;
  }
  if (keptBranch !== null) {
    if (!onItsOwn) throw new Error(`The Kept-branch start on #${ticket} didn't carry on ${built.name}`);
    return;
  }
  if (onItsOwn) throw new Error(`The Implement run on #${ticket} built on ${built.name} itself, but it isn't a retry or a Kept-branch start`);
}

/**
 * An Implement run's UI evidence, at `headSha`, the head the run built. Its
 * Evidence page is linked from the push job's own run, never from an address the
 * agent's runner passed out: an unzipped artifact opens in the browser. A
 * capture step its own timeout stopped recorded no result, so the result is
 * that it ran out of time.
 */
function implementEvidence({ result, timedOut, artifact, evidencePageArtifact, run, repoUrl }: PushJobEvidence, headSha: string): ImplementEvidence {
  const recorded = result ?? (timedOut ? ({ outcome: "failed", reason: "timeout", headSha, captures: [] } as const) : null);
  return {
    ...(recorded === null ? {} : { result: recorded }),
    headSha,
    run,
    artifact,
    evidencePage: evidencePageOf({ evidencePageArtifact, run, repoUrl }),
  };
}

/** The Evidence page artifact's web address in the push job's own run, which opens in the browser since it's unzipped; null when the job kept none. */
function evidencePageOf({ evidencePageArtifact, run, repoUrl }: Pick<PushJobEvidence, "evidencePageArtifact" | "run" | "repoUrl">): string | null {
  return evidencePageArtifact === null ? null : `${repoUrl}/actions/runs/${run}/artifacts/${evidencePageArtifact}`;
}

/**
 * Turns a Design session's prototype turn's result (#155) into the Loop event
 * its push job applies. `request` is the prototype request the Kit job's plan
 * built the turn on, from its outputs, never from the agent's result; `branch`
 * is what the push job read rebuilding the result's prototype branch from its
 * bundle, and the head its push leaves; `evidence` is what the prototype job
 * passed out about capture, with the push job's own run, which the Evidence page is
 * linked from; and `runUrl` is that run's attempt.
 */
export function prototypeEventFrom(
  result: AgentRunResult,
  request: PrototypeRequestMarker,
  branch: { readonly changes: BranchChanges; readonly head: string | null },
  evidence: PushJobEvidence,
  runUrl: string,
): LoopEvent {
  if (result.role !== "design") throw new Error(`A prototype turn's push job was handed a ${result.role} result`);
  if (result.branch === undefined) throw new Error(`The prototype turn's result for #${result.issue} names no branch it built`);
  return {
    kind: "prototype-run-finished",
    issue: result.issue,
    output: result.output,
    request,
    branch: result.branch.name,
    changes: branch.changes,
    headSha: branch.head,
    ...(evidence.result === null ? {} : { capture: evidence.result }),
    // The zipped captures, which the job uploads to its own run, the push job's too.
    captures: evidence.artifact === null ? null : { run: evidence.run, artifact: evidence.artifact },
    evidencePage: evidencePageOf(evidence),
    runUrl,
    repoUrl: evidence.repoUrl,
  };
}

/** What a Review's push job knows: from its checks job, and the Reviewer's result when it ran. */
export interface FinishedReview {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly runUrl: string;
  /** The Product repo's web address, which a pass's Follow-ups open issues on. */
  readonly repoUrl: string;
  /** The required checks that didn't pass, from the checks job. */
  readonly failedChecks: readonly string[];
  /** On green checks, the ones that passed by being skipped or reporting neutral, so ran nothing on the head. */
  readonly ranNothing: readonly string[];
  /** The Reviewer's result, null when red checks kept it from running. */
  readonly result: AgentRunResult | null;
  /** What the Kit's re-run of the red checks came to (#462), or null when it didn't try. */
  readonly rerun: RerunReport | null;
}

/** Turns a finished Review into the Loop event its push job applies. */
export function reviewEventFrom(review: FinishedReview): LoopEvent {
  const { pullRequest, headSha, runUrl, result } = review;
  if (result === null) {
    const rerun = review.rerun === null ? {} : { rerun: review.rerun };
    return { kind: "required-checks-finished", pullRequest, headSha, failed: review.failedChecks, ...rerun, runUrl };
  }
  if (result.role !== "review") throw new Error(`A Review's push job was handed a ${result.role} result`);
  if (result.issue !== pullRequest) throw new Error(`The Reviewer's result is for #${result.issue}, not #${pullRequest}`);
  return {
    kind: "review-run-finished",
    pullRequest,
    headSha,
    output: result.output,
    ...(review.rerun === null || review.rerun.flaky.length === 0 ? {} : { flaky: review.rerun.flaky }),
    ...(review.ranNothing.length === 0 ? {} : { ranNothing: review.ranNothing }),
    runUrl,
    repoUrl: review.repoUrl,
    ...givenTo(result),
  };
}

/**
 * Turns the Digest writer's result into the Loop event its push job applies,
 * which lands its Digest. `run` is the pull request and the head the Kit
 * job's plan started the run at, never the agent's word for either; `given`
 * is what Kit code hands the contract beside the reply
 * (src/github/digestGiven.ts); and `runUrl` is that push job's run.
 */
export function digestEventFrom(
  result: AgentRunResult,
  run: { readonly pullRequest: number; readonly headSha: string },
  given: DigestGiven,
  runUrl: string,
): LoopEvent {
  if (result.role !== "digest") throw new Error(`A Digest's push job was handed a ${result.role} result`);
  if (result.issue !== run.pullRequest) throw new Error(`The Digest writer's result is for #${result.issue}, not #${run.pullRequest}`);
  return { kind: "digest-run-finished", pullRequest: run.pullRequest, headSha: run.headSha, output: result.output, given, runUrl };
}

/**
 * Turns an Auditor's result into the Loop event its push job applies, which
 * fills its Audit; `runUrl` is that push job's run, and `repoUrl` the Product
 * repo its candidates open issues on.
 */
export function auditEventFrom(result: AgentRunResult, runUrl: string, repoUrl: string): LoopEvent {
  if (result.role !== "audit") throw new Error(`An Audit's push job was handed a ${result.role} result`);
  if (result.window === undefined) throw new Error(`The Auditor's result for #${result.issue} names no window it was given`);
  return { kind: "audit-run-finished", issue: result.issue, output: result.output, window: result.window, runUrl, repoUrl };
}

/**
 * Turns a Retro's result into the Loop event its push job applies, which
 * fills its Retro. `bundle` is the evidence the Retro was given, which the
 * push job reads from the evidence job's artifact, never from the agent's
 * result; `runUrl` is that push job's run, and `repoUrl` the Product repo
 * the Retro's evidence links to.
 */
export function retroEventFrom(result: AgentRunResult, bundle: EvidenceBundle, runUrl: string, repoUrl: string): LoopEvent {
  if (result.role !== "retro") throw new Error(`A Retro's push job was handed a ${result.role} result`);
  return { kind: "retro-run-finished", issue: result.issue, output: result.output, evidence: retroEvidenceOf(bundle), runUrl, repoUrl };
}

/**
 * Turns a Researcher's result into the Loop event its push job applies, which
 * lands its findings on the research Decision and its Map. `changes` is what
 * the push job read rebuilding the result's branch from its bundle; `runUrl`
 * is that push job's run, and `repoUrl` the Product repo the resolution links
 * the findings file in. The core checks the branch is the Decision's and
 * changes only its findings file.
 */
export function researchEventFrom(result: AgentRunResult, changes: BranchChanges, runUrl: string, repoUrl: string): LoopEvent {
  if (result.role !== "research") throw new Error(`A research run's push job was handed a ${result.role} result`);
  if (result.branch === undefined) throw new Error(`The Researcher's result for #${result.issue} names no branch it built`);
  return { kind: "research-run-finished", issue: result.issue, output: result.output, branch: result.branch.name, changes, runUrl, repoUrl };
}

/** The Operator comments a run was given, for its event to carry; nothing when its result has none. */
function givenTo(result: AgentRunResult): { operatorComments?: readonly GivenOperatorComment[] } {
  return result.operatorComments === undefined ? {} : { operatorComments: result.operatorComments };
}

/** What the push job knows about the agent job it follows (src/kit/pushJob.ts). */
export interface FailedJob {
  readonly role: AgentRole;
  readonly issue: number;
  readonly runUrl: string;
  /** `needs.<job>.result`. */
  readonly jobResult: string;
  /** The agent job's 1Password step outcome, passed out as a job output; empty if it never got that far. */
  readonly secretsStep: string;
  readonly report: FailureReport | null;
  /** The Subscription the run used, from the Kit job's `subscription` output; absent when it passed none. */
  readonly subscription?: string;
  /** For a Design-session turn: true when it was the session's prototype turn (#155). */
  readonly prototype?: true;
  /** For a conflict-only run (#304): its PR and the main head it was started for, from the Kit job's outputs. */
  readonly conflict?: { readonly pullRequest: number; readonly main: string };
  /** For a Digest run: its PR and the head it was started at, from the Kit job's outputs. */
  readonly digest?: { readonly pullRequest: number; readonly headSha: string };
}

const SECRETS_OUTCOMES = ["success", "failure", "cancelled", "skipped"] as const;

/** Turns what the push job gathered into the Loop event it reports. */
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
    ...(job.subscription === undefined ? {} : { subscription: job.subscription }),
    ...(job.prototype === true ? { prototype: true } : {}),
    ...(job.conflict === undefined ? {} : { conflict: job.conflict }),
    ...(job.digest === undefined ? {} : { digest: job.digest }),
  };
}
