// Operator comments on an agent PR (GLOSSARY.md) are context, never a trigger
// (ADR-0007): the next run that reads the PR weighs them. When one arrives, the
// Kit's only response is a 👀 reaction, so the Operator sees it was received.
import type { LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

type Commented = Extract<LoopEvent, { kind: "pull-request-commented" }>;

/** Reacts 👀 to an Operator comment on an agent PR; anyone else's comment, or any PR else, plans nothing. */
export function acknowledgeComment(event: Commented, pullRequest: PullRequestSnapshot, operator: string): Plan {
  if (event.commenterIsBot) {
    return { kind: "nothing", reason: `${event.commenter} is a bot, so its comment on #${pullRequest.number} is not read` };
  }
  if (event.commenter !== operator) {
    return {
      kind: "nothing",
      reason: `${event.commenter} isn't the Operator, so their comment on #${pullRequest.number} is not read`,
    };
  }
  if (!pullRequest.isAgent) return { kind: "nothing", reason: `#${pullRequest.number} isn't an agent PR` };
  return {
    kind: "act",
    actions: [{ kind: "react", pullRequest: pullRequest.number, on: event.on, content: "eyes" }],
  };
}
