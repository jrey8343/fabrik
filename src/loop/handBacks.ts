// The ways the Kit hands work back to the Operator, by name: what a
// `yours-to-do` Standing (src/kit/standing.ts) says it was, and what the
// hidden line on each hand-back notice will name. Here, on the Loop's side,
// so the Loop's markers can name them without reading the Standing.
import { READY_FOR_HUMAN } from "./labels.ts";

/** Every hand-back, in the order the Standing's wording lists them. */
export const HAND_BACKS = [
  "infrastructure-failure",
  "broken-run-no-retry",
  "trigger-swept",
  "retry-never-started",
  "landing-failed",
  "request-changes-empty",
  "conflict-run-unlanded",
  "conflicted-review",
  "request-changes-unlanded",
  "closed-by-hand",
  "kept-branch-gone",
  "research-failed",
  "research-branch-refused",
  "design-turn-failed",
  "map-cap-refused",
  "weekly-summary-failed",
] as const;

/** One way the Kit hands work back. */
export type HandBack = (typeof HAND_BACKS)[number];

/**
 * What a notice that puts ready-for-human on a pull request says of its
 * Hand-back (#841, ADR-0036): the PR is the Operator's while the label is on,
 * the Kit leaves its branch alone until then, and taking it off gives the PR
 * back. It promises nothing by a main sha, which may have moved before the
 * notice is read.
 */
export function handBackStandsLine(pullRequest: number): string {
  return `#${pullRequest} is yours while it carries \`${READY_FOR_HUMAN}\`: the Kit leaves its branch alone until then, and taking the label off gives it back.`;
}
