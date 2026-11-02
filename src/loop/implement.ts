// Implementation rules: when an Implementer starts on a Ticket, and how the
// branch it built lands as one draft PR, or doesn't.
import { checkTrustRoot } from "../guard/trust-root.ts";
import { isDesignSessionComment } from "./design.ts";
import { parseImplementOutput } from "./implementOutput.ts";
import { DISPATCH_LABEL, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN } from "./labels.ts";
import { withoutMentions } from "./mentions.ts";
import type { Action, IssueContext, IssueSnapshot, KitConfig, LoopEvent, Plan } from "./types.ts";

type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;

const CHECK_DISPATCH: Action = { kind: "check-dispatch" };

/** Execution-flaw retries a Ticket gets before the next flaw counts as a Design flaw. */
const MAX_RETRIES = 2;

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
