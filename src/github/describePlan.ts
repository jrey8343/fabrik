// How the push job, the claim job and the rest of src/main.ts's jobs say what
// a plan does: in the step summary, and in a landing failure's comment, which
// names the actions that landed and those that didn't (#421). Pure, no I/O.
import { prototypeBranchFor } from "../loop/designOutput.ts";
import type { Action, Plan } from "../loop/types.ts";
import type { RefusedCollapse } from "./apply.ts";

/** What a plan does, one line to each action, for the step summary. */
export function describePlan(plan: Plan): string {
  switch (plan.kind) {
    case "nothing":
      return `Nothing to do: ${plan.reason}`;
    case "fail":
      return `The run failed (${plan.failure} failure): ${plan.reason}`;
    case "act":
      // Notes, such as what a Retro's landing dropped, change nothing on GitHub, so they follow the actions, set apart.
      return [...plan.actions.map(describeAction), ...(plan.notes === undefined ? [] : ["", ...plan.notes.map((note) => `- ${note}`)])].join("\n");
  }
}

/** One action of a plan, as a Markdown list item. */
export function describeAction(action: Action): string {
  return `- ${actionPhrase(action)}`;
}

/** One action of a plan, as the phrase its list item gives, such as "close #50 as completed". */
export function actionPhrase(action: Action): string {
  switch (action.kind) {
    case "add-labels":
      return `add labels on #${action.issue}: ${action.labels.join(", ") || "(none new)"}`;
    case "remove-label":
      return `remove label on #${action.issue}: ${action.label}`;
    case "comment":
    case "comment-linking":
      return `comment on #${action.issue}`;
    case "close-pull-request":
      return `close #${action.pullRequest} unmerged, keeping its branch`;
    case "assign":
      return `assign #${action.issue} to ${action.assignee}`;
    case "close":
      return `close #${action.issue} as ${action.reason.replace("_", " ")}`;
    case "open-issue":
      return `open the issue "${action.title}"${action.assignees.length > 0 ? `, assigned to ${action.assignees.join(", ")}` : ""}`;
    case "edit-issue-body":
      return `rewrite the body of #${action.issue}`;
    case "append-to-decisions-so-far":
      return `append a line to the Decisions so far of Map #${action.issue}`;
    case "create-issue":
      return [
        `create "${action.title}" (${action.labels.join(", ")})`,
        action.assignees === undefined || action.assignees.length === 0 ? "" : `, assigned to ${action.assignees.join(", ")}`,
        action.parent === null
          ? ""
          : `, a sub-issue of ${typeof action.parent === "number" ? `#${action.parent}` : action.parent.created}`,
        action.blockedBy.length === 0
          ? ""
          : `, blocked by ${action.blockedBy.map((b) => (typeof b === "number" ? `#${b}` : b.created)).join(", ")}`,
      ].join("");
    case "add-blocked-by":
      return `make #${action.issue} blocked by ${action.blocker.created}`;
    case "close-as-superseded":
      return `close #${action.issue} as superseded`;
    case "start-agent-run":
      return `a ${action.role} run on #${action.issue}${action.pullRequest === undefined ? "" : `, ${action.conflict !== undefined ? "resolving its conflict with main on" : action.requestChanges === undefined ? "retrying" : "with the Operator's requested changes on"} #${action.pullRequest}`} (${action.model}), which the Kit job routes to its agent job`;
    case "start-replay":
      return `replay #${action.ticket.ticket} of replay #${action.issue}, both arms, which the Kit job routes to its replay jobs`;
    case "mark-replay-started":
      return `mark #${action.ticket} in progress on replay #${action.issue} in this run`;
    case "release-replay-ticket":
      return `end run ${action.run} of #${action.ticket} on replay #${action.issue}, which never landed, as an Infrastructure failure`;
    case "hold-agent-run":
      return `hold the ${action.role} run on #${action.issue}${action.until === null ? "" : ` until ${action.until}`}, starting no agent job`;
    case "drop-held-run":
      return `drop the held ${action.role} run on #${action.issue} rather than resume it: ${action.reason}`;
    case "end-held-line":
      return `edit the held line for the ${action.role} run on #${action.issue} to say it was ${action.ended.kind === "resumed" ? "resumed" : `dropped: ${action.ended.reason}`}`;
    case "check-dispatch":
      return "run a Dispatch check";
    case "check-design-queue":
      return "run a Design queue check";
    case "link-preview":
      return `link the preview deployment of ${action.pullRequest === null ? "the PR it opens" : `#${action.pullRequest}`} once it answers, or say it never answered`;
    case "link-prototype-preview":
      return `link each variant's preview in #${action.issue}'s prototype round once it answers, or say it never answered`;
    case "push-branch":
      return `push ${action.branch}`;
    case "rebase-onto-main":
      return `rebase ${action.branch} of #${action.pullRequest} onto main at ${action.onto.slice(0, 7)}, with no agent: pushed with a lease if clean, else a conflict-only run starts`;
    case "push-prototype-branch":
      return `push ${prototypeBranchFor(action.issue)}, only as a fast-forward`;
    case "mark-prototype-request":
      return `mark #${action.issue}'s prototype request ${action.started ? "as its prototype turn started" : "as waiting for its prototype turn again"}`;
    case "open-pull-request":
      return `open a draft PR from ${action.head} to ${action.base} that closes #${action.issue}`;
    case "convert-to-draft":
      return `put #${action.pullRequest} back in draft`;
    case "mark-ready-for-review":
      return `take #${action.pullRequest} out of draft`;
    case "request-review":
      return `request ${action.reviewer}'s review on #${action.pullRequest}`;
    case "react":
      return action.on.kind === "conversation"
        ? `react ${action.content} to comment ${action.on.comment} on #${action.pullRequest}`
        : action.on.hasBody
          ? `react ${action.content} to review ${action.on.review} and each of its inline comments on #${action.pullRequest}`
          : `react ${action.content} to each inline comment of review ${action.on.review} on #${action.pullRequest}`;
    case "minimize-comment":
      return `collapse an older Digest on #${action.pullRequest} (comment ${action.node}) as outdated`;
    case "carry-digest":
      return `carry the last Digest of #${action.pullRequest} forward to ${action.headSha.slice(0, 7)}, with no Digest run, then collapse the older Digests and open the Merge gate; or, if the files its places name can't be read there, go on as with no Digest to carry`;
    case "reopen":
      return `reopen #${action.issue}`;
  }
}

/**
 * Each older Digest GitHub refused to collapse while the plan was applied
 * (ADR-0022), one line to each, for the step summary: the refusal held
 * nothing up, so this is the only place it is said.
 */
export function describeRefusedCollapses(refused: readonly RefusedCollapse[]): string[] {
  return refused.map(
    ({ pullRequest, node, why }) =>
      `- GitHub refused to collapse an older Digest on #${pullRequest} (comment ${node}) as outdated: ${why.replace(/[.\s]+$/, "")}. Nothing else was held up: the current Digest is found by its head either way`,
  );
}
