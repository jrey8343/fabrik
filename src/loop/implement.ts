// Implementation rules: when an Implementer starts on a Ticket, and how the
// branch it built lands as one draft PR, or doesn't.
import { checkTrustRoot } from "../guard/trust-root.ts";
import { isDesignSessionComment } from "./design.ts";
import { parseImplementOutput } from "./implementOutput.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import { whyNotReviewable } from "./agentPullRequest.ts";
import { withoutMentions } from "./mentions.ts";
import { MAX_RETRIES } from "./retry.ts";
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
 * so the open draft PR, not the label, shows the Ticket is in progress.
 */
export function startImplementer(issueNumber: number, { issue }: IssueContext, config: KitConfig): Plan {
  const removeLabel: Action = { kind: "remove-label", issue: issueNumber, label: DISPATCH_LABEL };
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
  const parsed = parseImplementOutput(event.output);
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

  const guard = checkTrustRoot([...changes.net, ...changes.commits]);
  if (guard.kind === "refuse") return refuse(issueNumber, guard.paths, operator);
  if (changes.net.length === 0) {
    return {
      kind: "act",
      actions: verdictActions(
        fixes,
        pullRequest,
        "execution-flaw",
        "empty-diff",
        `The Implementer's retry on \`${branch}\` committed no change, so there was nothing to review.`,
      ),
    };
  }
  return {
    kind: "act",
    actions: [
      { kind: "push-branch", branch },
      {
        kind: "comment",
        issue: pullRequest.number,
        body: [
          `The Implementer pushed a fix for the Execution flaw to \`${branch}\`; Review runs again on it.`,
          "",
          withoutMentions(parsed.output.summary),
        ].join("\n"),
      },
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
  if (pullRequest.headSha !== fixes.headSha) {
    return `#${pullRequest.number} has moved on from ${fixes.headSha.slice(0, 7)}`;
  }
  if (!issue.open) return `#${issueNumber} is closed`;
  if (!issue.labels.includes(READY_FOR_AGENT)) return `#${issueNumber} isn't ${READY_FOR_AGENT}`;
  return null;
}

/**
 * A refusal isn't the Implementer's mistake to fix: the work itself needs a
 * trust-root change, which only the Operator may make. So it uses no retry.
 */
function refuse(issueNumber: number, paths: readonly string[], operator: string): Plan {
  const body = [
    `The Implementer's branch for #${issueNumber} changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):`,
    "",
    ...paths.map((path) => `- \`${path}\``),
    "",
    "Only the Operator changes these. Make the change yourself, or rewrite the Ticket so it doesn't need it and mark it `ready-for-agent` again.",
  ].join("\n");
  return {
    kind: "act",
    actions: [
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

const EMPTY_DIFF_MARKER = "<!-- fabrik:empty-diff -->";

/**
 * How many empty diffs the Kit has recorded on a Ticket, from its comments
 * oldest first. A Design session starts the count again, because a redesigned
 * Ticket starts again on its retries.
 */
export function countEmptyDiffs(commentBodies: readonly string[]): number {
  let count = 0;
  for (const body of commentBodies) {
    if (isDesignSessionComment(body)) count = 0;
    else if (body.startsWith(EMPTY_DIFF_MARKER)) count += 1;
  }
  return count;
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
