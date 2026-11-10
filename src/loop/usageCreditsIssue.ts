// The usage-credits issue: with rotation on, a run killed for spending usage
// credits gets a "Turn off usage credits" issue for its Subscription, assigned
// to the Operator, and the Kit skips that Subscription until the issue is
// closed (src/loop/subscriptions.ts). While every Subscription is used up, the
// runs due are held, and this issue may carry their held markers
// (src/loop/hold.ts). Pure, no I/O.
import type { RepoContext, RepoWideNotice, StalledRun } from "./kitIssues.ts";
import { NOTIFIED } from "./kitIssueMarks.ts";
import { READY_FOR_HUMAN, USAGE_CREDITS_LABEL } from "./labels.ts";
import { subscriptionMarker, subscriptionNamedBy } from "./subscriptions.ts";

/**
 * The killed run's Subscription's usage-credits issue, opened assigned to the
 * Operator, its one notification, or commented on quietly when it's already open.
 */
export function usageCreditsNotice({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const { subscription } = stalled;
  const open = kitIssues.find(
    (issue) => issue.labels.includes(USAGE_CREDITS_LABEL) && subscriptionNamedBy(issue) === subscription,
  );
  if (open !== undefined) {
    return {
      actions: [
        {
          kind: "comment",
          issue: open.number,
          body: `${stalled.run} was killed for spending usage credits too. [The run](${stalled.runUrl})`,
        },
      ],
      pointer: `The Kit is tracking this in #${open.number}.`,
    };
  }
  const title = `Turn off usage credits on the \`${subscription}\` Subscription`;
  return {
    actions: [
      {
        kind: "open-issue",
        title,
        body: [
          `${stalled.run} showed usage credits being spent on the \`${subscription}\` Subscription, so the Kit killed it. Until this issue is closed the Kit runs no agent on that Subscription, and comments here about each other run killed on it. While no other Subscription is free, each run due is held until one is, not started, and the Kit names it here or on another issue blocking a Subscription.`,
          "",
          "## Steps",
          "",
          `- [ ] Turn usage credits off on the Claude account whose token is the \`${subscription}\` item in the Fabrik 1Password vault.`,
          "- [ ] Close this issue, so that the Kit runs agents on that Subscription again.",
          "",
          "Run `/fabrik-pair` on this issue to work through these steps with an agent.",
          "",
          `[The killed run](${stalled.runUrl})`,
          "",
          NOTIFIED,
          subscriptionMarker(subscription),
        ].join("\n"),
        labels: [READY_FOR_HUMAN, USAGE_CREDITS_LABEL],
        // The assignment is this issue's one notification.
        assignees: [operator],
      },
    ],
    pointer: `The Kit has opened a ${title} issue for the Operator.`,
  };
}
