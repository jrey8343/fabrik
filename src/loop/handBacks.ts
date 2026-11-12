// The ways the Kit hands work back to the Operator, by name: what a
// `yours-to-do` Standing (src/kit/standing.ts) says it was, and what the
// hidden line on each hand-back notice will name. Here, on the Loop's side,
// so the Loop's markers can name them without reading the Standing.

/** Every hand-back, in the order the Standing's wording lists them. */
export const HAND_BACKS = [
  "infrastructure-failure",
  "broken-run-no-retry",
  "trigger-swept",
  "retry-never-started",
  "landing-failed",
  "request-changes-empty",
  "conflict-run-unlanded",
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
