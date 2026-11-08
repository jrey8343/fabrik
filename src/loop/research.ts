// The Researcher (#154): which Decisions it may run on, and its run starting
// on one.
import { declineTrigger } from "./declineTrigger.ts";
import { MAP_LABEL, RESEARCH_DECISION_LABEL, RESEARCH_LABEL } from "./labels.ts";
import { startAgentRun } from "./runs.ts";
import type { Action, IssueContext, IssueSnapshot, KitConfig, Plan } from "./types.ts";

/**
 * agent:research starts the Researcher on a research Decision. The label
 * comes off as the run starts, as agent:implement does, so re-adding it runs
 * the Decision again. On any other subject nothing starts: the label comes
 * off, so a later re-add fires its event, and one comment says why (#417).
 */
export function startResearcher(issueNumber: number, { issue }: IssueContext, config: KitConfig): Plan {
  const why = whyNotResearchable(issue);
  if (why !== null) return { kind: "act", actions: declineTrigger(issueNumber, RESEARCH_LABEL, why) };
  const removeLabel: Action = { kind: "remove-label", issue: issueNumber, label: RESEARCH_LABEL };
  return { kind: "act", actions: [removeLabel, ...startAgentRun("research", issueNumber, config).actions] };
}

/**
 * Why the Researcher can't run on this issue, or null when it can: only an
 * open `wayfinder:research` sub-issue of an open `wayfinder:map` issue is a
 * research Decision on a live Map.
 */
export function whyNotResearchable({
  number,
  open,
  labels,
  parentIssue,
}: Pick<IssueSnapshot, "number" | "open" | "labels" | "parentIssue">): string | null {
  if (!open) return `#${number} is closed`;
  if (!labels.includes(RESEARCH_DECISION_LABEL)) {
    return `#${number} has no ${RESEARCH_DECISION_LABEL} label, so it isn't a research Decision`;
  }
  if (parentIssue === null) return `#${number} isn't a sub-issue of a Map`;
  if (!parentIssue.labels.includes(MAP_LABEL)) {
    return `#${number}'s parent #${parentIssue.number} has no ${MAP_LABEL} label, so it isn't a Map`;
  }
  if (!parentIssue.open) return `#${number}'s Map #${parentIssue.number} is closed`;
  return null;
}
