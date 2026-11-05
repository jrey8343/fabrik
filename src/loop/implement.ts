// Implementation rules: when an Implementer starts on a Ticket, and how the
// branch it built lands as one draft PR, or doesn't.
import { checkTrustRoot } from "../guard/trust-root.ts";
import { consideredSection } from "./considered.ts";
import { parseImplementOutput } from "./implementOutput.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import { whyNotReviewable } from "./agentPullRequest.ts";
import { withoutMentions } from "./mentions.ts";
import { EMPTY_DIFF_MARKER, REQUEST_CHANGES_RUN_MARKER, RETRY_PUSH_MARKER, UNMARKED_RETRY_PUSH } from "./markers.ts";
import { owedRequestChangesRun } from "./mergeGate.ts";
import { MAX_RETRIES, owedRetry, runInFlight, runName } from "./retry.ts";
import { verdictActions } from "./review.ts";
import type {
  Action,
  IssueContext,
  IssueSnapshot,
  KitConfig,
  LoopEvent,
  Plan,
  PullRequestSnapshot,
  Snapshot,
} from "./types.ts";

type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };

/**
 * agent:implement starts the Implementer. The label comes off as the run starts,
 * so the open draft PR, not the label, shows the Ticket is in progress. On a
 * Ticket whose agent PR is open, it resumes that PR's Implement run instead:
 * the retry an Execution flaw is owed, or the Operator's Request-changes run,
 * so re-adding it recovers either after an Infrastructure failure. It never
 * starts a second branch beside an open PR. The label always comes off, so it
 * never claims work that isn't running.
 */
export function startImplementer(
  issueNumber: number,
  { issue, operator }: IssueContext,
  pullRequest: PullRequestSnapshot | null,
  config: KitConfig,
): Plan {
  const removeLabel: Action = { kind: "remove-label", issue: issueNumber, label: DISPATCH_LABEL };
  const open = issue.openPullRequests[0];
  if (open !== undefined && issue.open && issue.labels.includes(READY_FOR_AGENT)) {
    const resumed =
      pullRequest === null || pullRequest.number !== open || pullRequest.ticket !== issueNumber
        ? null
        : (owedRetry(pullRequest, operator, config) ?? owedRequestChangesRun(pullRequest, operator, config));
    return { kind: "act", actions: resumed === null ? [removeLabel] : [removeLabel, resumed] };
  }
  if (whyNotBuildable(issueNumber, issue) !== null) return { kind: "act", actions: [removeLabel] };
  const { implement, stepUp } = config.roles;
  // The second retry Steps up; the first run and the first retry use the Implementer's model.
  const { model, effort } = issue.emptyDiffs >= MAX_RETRIES ? stepUp : implement;
  return {
    kind: "act",
    actions: [
      removeLabel,
      {
        kind: "start-agent-run",
        role: "implement",
        issue: issueNumber,
        model,
        effort,
        timeoutMinutes: implement.timeoutMinutes,
      },
    ],
  };
}

/**
 * The push job's decision on the branch an Implementer built (ADR-0005): a
 * branch that touches a trust root goes to the Operator unpushed, one that
 * changes nothing is an Execution flaw, and any other opens one draft PR.
 */
export function applyImplementation(event: ImplementRunFinished, { issue, operator }: IssueContext): Plan {
  const { issue: issueNumber, changes, branch, base } = event;
  const parsed = parseImplementOutput(event.output);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Implementer on #${issueNumber} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  const stale = whyNotBuildable(issueNumber, issue);
  if (stale !== null) return { kind: "nothing", reason: `${stale}, so the Implementer's branch isn't pushed` };

  // Every commit counts, so a trust-root change can't hide behind a later revert.
  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") return refuse(issueNumber, guard.paths, operator);
  // "Did nothing" never passes, however the commits got there.
  if (changes.net.length === 0) return emptyDiff(issueNumber, issue);

  const { title, summary } = parsed.output;
  return {
    kind: "act",
    actions: [
      { kind: "push-branch", branch },
      {
        kind: "open-pull-request",
        issue: issueNumber,
        head: branch,
        base,
        title: withoutMentions(title),
        // Closes, so merging the PR closes the Ticket and starts the next Dispatch check.
        body: `${withoutMentions(summary)}\n\nCloses #${issueNumber}`,
        draft: true,
      },
    ],
  };
}

/**
 * The push job's decision on a retry's branch: built on the agent PR's head,
 * it lands as more commits on that same branch, never a new PR, and the push
 * starts Review again. The guard checks the retry's own commits, the earlier
 * ones having passed it already. One that changes nothing is an Execution flaw
 * on the PR, which starts the next retry if one is left. All of it is silent.
 */
export function applyRetryImplementation(event: ImplementRunFinished, snapshot: Snapshot): Plan {
  const { issue: issueNumber, changes, branch, fixes } = event;
  const { issue, pullRequest, operator } = snapshot;
  if (fixes === undefined) throw new Error("A first Implement run lands through applyImplementation");
  const parsed = parseImplementOutput(event.output, true);
  if (!parsed.ok) {
    return {
      kind: "fail",
      failure: "infrastructure",
      reason: `The Implementer's retry on #${fixes.pullRequest} emitted output that breaks its contract: ${parsed.errors.join("; ")}`,
    };
  }
  if (issue === null || pullRequest === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the Ticket or the PR its retry fixes" };
  }
  const stale = whyNotRetriedOnto(issueNumber, issue, fixes, pullRequest);
  if (stale !== null) return { kind: "nothing", reason: `${stale}, so the retry's branch isn't pushed` };
  // The push job rebased the run's own commits if the branch moved (ADR-0006). If the branch moves again,
  // the push's lease refuses it, and the run stays in flight as after an Infrastructure failure.
  if (changes.rebase?.conflicted === true) return startAgain(event, fixes, pullRequest, operator, changes.rebase.onto);

  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") return refuse(issueNumber, guard.paths, operator, pullRequest.number);
  const requestChanges = fixes.requestChanges === true;
  // Merging main in or rebasing onto it, to fix a conflict, is a change even with none of the run's own.
  if (changes.net.length === 0 && changes.updatedFromMain !== true) {
    return {
      kind: "act",
      actions: verdictActions(
        fixes,
        // Its Verdict is the Request-changes run's, so it uses no retry.
        requestChanges ? { ...pullRequest, requestChangesRun: true } : pullRequest,
        "execution-flaw",
        "empty-diff",
        `The Implementer's ${requestChanges ? "Request-changes run" : "retry"} on \`${branch}\` committed no change, so there was nothing to review.`,
      ),
    };
  }
  // The body and the note go first: the push starts a Review, which must see the run's outcome (or it posts no
  // Verdict) and the body as it now stands.
  return {
    kind: "act",
    actions: [
      // The body says what the PR as a whole now does, so the next Review, which reads the body, never judges a stale one.
      {
        kind: "edit-issue-body",
        issue: pullRequest.number,
        body: `${withoutMentions(parsed.output.summary)}\n\nCloses #${issueNumber}`,
      },
      {
        kind: "comment",
        issue: pullRequest.number,
        body: [
          // Marks the push as the run's outcome, so Reviews give Verdicts again, and the next one is marked as from a Request-changes run if it was one.
          requestChanges ? REQUEST_CHANGES_RUN_MARKER : RETRY_PUSH_MARKER,
          requestChanges
            ? `The Implementer pushed the Operator's requested changes to \`${branch}\`; Review runs again on it.`
            : `${UNMARKED_RETRY_PUSH}\`${branch}\`; Review runs again on it.`,
          "",
          // Present: the on-a-PR contract above requires it.
          withoutMentions(parsed.output.fix ?? ""),
          ...consideredSection(parsed.output.operatorCommentsConsidered ?? [], fixes.operatorComments),
        ].join("\n"),
      },
      { kind: "push-branch", branch },
    ],
  };
}

/** Why a retry's branch can't land on this PR now, or null when it can. */
function whyNotRetriedOnto(
  issueNumber: number,
  issue: IssueSnapshot,
  fixes: NonNullable<ImplementRunFinished["fixes"]>,
  pullRequest: PullRequestSnapshot,
): string | null {
  if (pullRequest.number !== fixes.pullRequest) return `The snapshot is of #${pullRequest.number}, not #${fixes.pullRequest}`;
  const why = whyNotReviewable(pullRequest);
  if (why !== null) return why;
  if (pullRequest.ticket !== issueNumber) return `#${pullRequest.number} isn't #${issueNumber}'s PR`;
  if (!issue.open) return `#${issueNumber} is closed`;
  if (!issue.labels.includes(READY_FOR_AGENT)) return `#${issueNumber} isn't ${READY_FOR_AGENT}`;
  return null;
}

/**
 * A run whose commits couldn't be rebased onto the head its branch moved to:
 * they conflict with it, or the run rewrote the history it built on. The Kit
 * discards them, says so, and starts the same run again on the new head. It
 * posts no Retry outcome, so the run stays in flight and uses no retry;
 * re-adding agent:implement resumes it as after an Infrastructure failure.
 * Restarts aren't capped. Like the rest of a retry, it's silent.
 */
function startAgain(
  { issue: ticket, branch }: ImplementRunFinished,
  fixes: NonNullable<ImplementRunFinished["fixes"]>,
  pullRequest: PullRequestSnapshot,
  operator: string,
  onto: string,
): Plan {
  const run = runInFlight(pullRequest, operator);
  if (run === null) {
    return { kind: "nothing", reason: `#${pullRequest.number} has no run in flight to start again, so the run's branch isn't pushed` };
  }
  const head = onto.slice(0, 7);
  const body = [
    `\`${branch}\` moved from ${fixes.headSha.slice(0, 7)} to ${head} while the Implementer worked, and its commits couldn't be rebased onto the new head without a conflict, so the Kit discarded them.`,
    "",
    `${runName(run)} starts again on ${head}, using no retry.`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      { kind: "comment", issue: pullRequest.number, body },
      // As after an Infrastructure failure, agent:implement resumes the run in flight (startImplementer).
      { kind: "add-labels", issue: ticket, labels: [DISPATCH_LABEL] },
    ],
  };
}

/**
 * A refusal isn't the Implementer's mistake to fix: the work itself needs a
 * trust-root change, which only the Operator may make. So it uses no retry.
 */
function refuse(issueNumber: number, paths: readonly string[], operator: string, pullRequest: number | null = null): Plan {
  const body = [
    `The Implementer's branch for #${issueNumber} changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):`,
    "",
    ...paths.map((path) => `- \`${path}\``),
    "",
    pullRequest === null
      ? "Only the Operator changes these. Make the change yourself, or rewrite the Ticket so it doesn't need it and mark it `ready-for-agent` again."
      : `Only the Operator changes these, so the Kit closed #${pullRequest} unmerged, keeping its branch. Make the change yourself, or rewrite the Ticket so it doesn't need it and mark it \`ready-for-agent\` again.`,
  ].join("\n");
  return {
    kind: "act",
    actions: [
      // A retry's PR closes too (its branch stays), or it would hold a max_in_flight slot for good.
      ...(pullRequest === null ? [] : [{ kind: "close-pull-request" as const, pullRequest }]),
      { kind: "comment", issue: issueNumber, body },
      { kind: "remove-label", issue: issueNumber, label: READY_FOR_AGENT },
      { kind: "add-labels", issue: issueNumber, labels: [READY_FOR_HUMAN] },
      // The assignment is ready-for-human's one notification; the comment mentions nobody.
      { kind: "assign", issue: issueNumber, assignee: operator },
      // The run no longer holds a slot.
      CHECK_DISPATCH,
    ],
  };
}


/**
 * An empty diff is an Execution flaw. With no PR to retry on, the retry is a
 * fresh Implement run, kept silent; the third flaw is a Design flaw.
 */
function emptyDiff(issueNumber: number, issue: IssueSnapshot): Plan {
  const flaw = issue.emptyDiffs + 1;
  if (flaw > MAX_RETRIES) {
    return {
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: issueNumber,
          body: [
            EMPTY_DIFF_MARKER,
            `The Implementer's branch for #${issueNumber} changed nothing, for the ${ordinal(flaw)} time. A third Execution flaw counts as a Design flaw, so this Ticket goes back to design.`,
          ].join("\n"),
        },
        { kind: "remove-label", issue: issueNumber, label: READY_FOR_AGENT },
        // Starts a Design session, whose round 1 is this event's one notification.
        { kind: "add-labels", issue: issueNumber, labels: [NEEDS_DESIGN] },
        CHECK_DISPATCH,
      ],
    };
  }
  return {
    kind: "act",
    actions: [
      {
        kind: "comment",
        issue: issueNumber,
        body: [
          EMPTY_DIFF_MARKER,
          `The Implementer's branch for #${issueNumber} changed nothing, so the Kit opened no PR. An empty diff is an Execution flaw: retry ${flaw} of ${MAX_RETRIES} starts now${flaw === MAX_RETRIES ? ", stepped up" : ""}.`,
        ].join("\n"),
      },
      // A fresh label event, as Dispatch would add, starts the retry in this run's own slot.
      { kind: "add-labels", issue: issueNumber, labels: [DISPATCH_LABEL] },
    ],
  };
}

function ordinal(n: number): string {
  return ["zeroth", "first", "second", "third"][n] ?? `${n}th`;
}

/** Why an Implementer can't build this Ticket now, or null when it can. */
function whyNotBuildable(issueNumber: number, issue: IssueSnapshot): string | null {
  if (!issue.open) return `#${issueNumber} is closed`;
  if (!issue.labels.includes(READY_FOR_AGENT)) return `#${issueNumber} isn't ${READY_FOR_AGENT}`;
  const pullRequest = issue.openPullRequests[0];
  if (pullRequest !== undefined) return `#${issueNumber} already has the open PR #${pullRequest}`;
  return null;
}
